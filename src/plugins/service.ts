import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { builtinModules } from "node:module";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { dataDir } from "../config.js";
import { PAGE_PERMISSIONS } from "../pagePermissions.js";
import { parseManifest, pluginId, declarePlugins, declaredPlugins, validateComponentProps, type PluginManifest } from "./manifest.js";
import { PluginDatabase, type PluginRecord } from "./database.js";
import { packageHash, packagePath, readPackage, writePackage, zip, type PackageFiles } from "./package.js";
import { PluginRuntime } from "./runtime.js";
import { PluginSecrets } from "./secrets.js";
import { build } from "esbuild";
import { unifiedDiff } from "../agent/textDiff.js";
import { normalizeTemplateInput } from "../templates.js";
const execute=promisify(execFile);

export type PluginCaller = { kind: "page" | "agent" | "system"; page?: string; thread?: string };
export type ExportParts = { source?: boolean; settings?: boolean; state?: boolean; data?: boolean };
export class PluginService {
  private componentCache = new Map<string, { definition: PluginManifest["components"][string]; html: string; name: string; hash: string }>();
  private listeners = new Set<(id: string, name: string, data: unknown, registry?: boolean) => void>();
  subscribe(listener: (id: string, name: string, data: unknown, registry?: boolean) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  readonly database: PluginDatabase;
  private secrets: PluginSecrets;
  private runtimes = new Map<string, PluginRuntime>();
  private stopping = new Map<string,Promise<void>>();
  private contexts = new Map<string, Record<string, (...args: unknown[]) => unknown>>();
  private callers=new Map<string,PluginCaller>();
  private closing?: Promise<void>;
  private pastLogs=new Map<string,string[]>();
  constructor(readonly root = path.join(dataDir(), "plugins"), private event: (id: string, name: string, data: unknown, registry?:boolean) => void = () => {}, private asset?: (page: string, name: string, mimeType: string, bytes: Buffer) => unknown) {
    const emit = this.event;
    this.event = (id, name, data, registry) => { emit(id, name, data, registry); for (const fn of this.listeners) fn(id, name, data, registry); };
    fs.mkdirSync(root, { recursive: true });
    this.database = new PluginDatabase(path.join(root, "plugins.sqlite")); this.secrets = new PluginSecrets(path.join(root, "secrets"));
    for (const record of this.database.list()) this.permission(record.manifest);
  }
  private permission(manifest: PluginManifest): void {
    const id = `plugin.${manifest.id}`;
    const def = { id, label: `Use ${manifest.name}`, detail: manifest.summary, default: "ask" as const, risky: manifest.risky };
    const index = PAGE_PERMISSIONS.findIndex(p => p.id === id);
    if (index < 0) PAGE_PERMISSIONS.push(def); else PAGE_PERMISSIONS[index] = def;
  }
  directory(id: string): string { pluginId.parse(id); return path.join(this.root, id); }
  draft(id: string): string { return path.join(this.directory(id), "source"); }
  get(id: string): PluginRecord { pluginId.parse(id); const record = this.database.list().find(p => p.manifest.id === id); if (!record) throw new Error(`Plugin not found: ${id}`); return record; }
  list() {
    return this.database.list().map(p => ({ id: p.manifest.id, name: p.manifest.name, version: p.manifest.version, summary: p.manifest.summary, enabled: p.enabled && this.database.enabled(), configuredEnabled: p.enabled, keepAlive: p.keepAlive, status: this.runtimes.get(p.manifest.id)?.status() ?? "idle", edited: fs.existsSync(this.draft(p.manifest.id)) && packageHash(readPackage(this.draft(p.manifest.id))) !== p.hash }));
  }
  inspect(id: string) {
    const p = this.get(id);
    return { ...this.list().find(p => p.id === id), manifest: p.manifest, settings: p.settings, secrets: Object.fromEntries(Object.entries(p.manifest.settings).filter(([,v]) => v.type === "secret").map(([k]) => [k, this.secrets.has(id,k)])), readme: this.text(id,p.manifest.readme), methods: p.manifest.methods, logs: this.logs(id) };
  }
  private text(id: string, file?: string): string { return file ? fs.readFileSync(packagePath(this.snapshot(this.get(id)),file),"utf8") : ""; }
  guide(id: string) { const p = this.get(id); return { id, summary: p.manifest.summary, guide: this.text(id,p.manifest.guide), methods: p.manifest.methods, components: p.manifest.components ?? {} }; }
  component(id: string, name: string, props: unknown) {
    if (!this.enabled(id)) throw new Error("Plugin is disabled or removed.");
    const record = this.get(id), definition = record.manifest.components?.[name];
    if (!definition) throw new Error("Plugin component is unavailable.");
    const key = `${record.hash}:${name}:${JSON.stringify(props)}`;
    const cached = this.componentCache.get(key);
    if (cached) return cached;
    validateComponentProps(definition.props, props);
    const result = { definition, html: this.text(id, definition.html), name: record.manifest.name, hash: record.hash };
    this.componentCache.set(key, result);
    if (this.componentCache.size > 64) this.componentCache.delete(this.componentCache.keys().next().value!);
    return result;
  }
  private snapshot(p: PluginRecord): string { return path.join(this.directory(p.manifest.id), "versions", p.hash); }
  validate(files: PackageFiles): PluginManifest {
    for(const name of Object.keys(files))if(name.split("/").some(part=>[".git","node_modules",".scribe-merge"].includes(part)))throw new Error("Reserved package directory");
    if (!files["plugin.json"]) throw new Error("Package needs plugin.json");
    const manifest = parseManifest(JSON.parse(files["plugin.json"].toString("utf8")));
    for (const file of [manifest.backend, manifest.source, manifest.guide, manifest.readme, ...Object.values(manifest.components).map(c => c.html), ...manifest.templates.flatMap(t => [t.metadata,t.html,t.guide])]) if (file && !files[file]) throw new Error(`Missing package file: ${file}`);
    for (const component of Object.values(manifest.components)) {
      if (files[component.html].length > 256 * 1024) throw new Error("Component HTML exceeds 256 KiB");
      for (const method of component.methods) if (!Object.hasOwn(manifest.methods, method) || !manifest.methods[method].agent) throw new Error(`Unknown or non-agent component method: ${method}`);
    }
    for(const template of manifest.templates)normalizeTemplateInput({...JSON.parse(files[template.metadata].toString("utf8")),html:files[template.html].toString("utf8")});
    if (!manifest.backend && (manifest.source || Object.keys(manifest.methods).length || manifest.templates.some(t => t.actions || t.hooks?.length))) throw new Error("Methods and hooks require a backend");
    for(const [key,field]of Object.entries(manifest.settings))if(field.type!=="secret"&&field.default!==undefined)this.settingValue(field.type,field.default,key);
    this.payload(files,manifest);
    return manifest;
  }
  private settingValue(type:string,value:unknown,key:string):void {
    if((type==="string"&&typeof value!=="string")||(type==="number"&&(typeof value!=="number"||!Number.isFinite(value)))||(type==="boolean"&&typeof value!=="boolean")||(type==="paths"&&(!Array.isArray(value)||value.some(path=>typeof path!=="string"))))throw new Error(`Invalid value for ${key}`);
  }
  private payload(files:PackageFiles,manifest:PluginManifest){
    const object=(name:string):Record<string,unknown>|undefined=>{if(!files[name])return;const value=JSON.parse(files[name].toString("utf8"));if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(`Invalid ${name}`);return value;};
    const settings=object("scribe/settings.json"),state=object("scribe/state.json"),parts=object("scribe/parts.json");
    for(const [key,value]of Object.entries(settings??{})){const field=manifest.settings[key];if(!field||field.type==="secret")throw new Error(`Setting ${key} cannot be imported`);this.settingValue(field.type,value,key);}
    for(const [key,value]of Object.entries(state??{}))if(!key||key.length>200||Buffer.byteLength(JSON.stringify(value))>4*1024**2)throw new Error("Imported plugin state exceeds its limits");
    const data=Object.fromEntries(Object.entries(files).filter(([name])=>name.startsWith("scribe/data/")).map(([name,data])=>[name.slice(12),data]));
    for(const name of Object.keys(data))packagePath(this.root,name);
    return {settings,state,data,hasData:parts?.data===true||Object.keys(data).length>0};
  }
  preview(files: PackageFiles, detailed = false) {
    const manifest = this.validate(files), hash = packageHash(files), codeHash=packageHash(this.codeFiles(files)), previous = this.database.list().find(p => p.manifest.id === manifest.id);
    const payload=this.payload(files,manifest),paths=Object.entries(payload.settings??{}).filter(([key])=>manifest.settings[key].type==="paths").map(([key,value])=>({key,label:manifest.settings[key].label,paths:(value as string[]).filter(folder=>!Array.isArray(previous?.settings[key])||!previous.settings[key].includes(folder))})).filter(item=>item.paths.length);
    const changed=(before:Record<string,unknown>,after:Record<string,unknown>)=>[...new Set([...Object.keys(before),...Object.keys(after)])].filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key]));
    let diff="";
    if(detailed&&previous){const old=readPackage(this.snapshot(previous));for(const name of [...new Set([...Object.keys(old),...Object.keys(this.codeFiles(files))])].sort()){if(diff.length>250_000){diff+="\n…Diff preview limited. Inspect the archive for all remaining files.\n";break;}if(old[name]?.equals(files[name]))continue;diff+=unifiedDiff(old[name]?.toString("utf8")??null,files[name]?.toString("utf8")??null,name).patch+"\n";}}
    let sourceBytes=0;const source=detailed?Object.fromEntries(Object.entries(this.codeFiles(files)).filter(([,data])=>{sourceBytes+=data.length;return sourceBytes<250_000;}).map(([name,data])=>[name,data.toString("utf8")])):undefined;
    let versionStatus="new";if(previous){versionStatus="same";const current=manifest.version.split(".").map(Number),old=previous.manifest.version.split(".").map(Number);for(let i=0;i<3;i++)if(current[i]!==old[i]){versionStatus=current[i]>old[i]?"newer":"older";break;}}
    return { manifest, hash, codeHash,versionStatus,same:previous?.hash===codeHash, parts:{settings:payload.settings,state:payload.state!==undefined,stateKeys:Object.keys(payload.state??{}),data:payload.hasData,dataFiles:Object.keys(payload.data),paths}, ...(detailed?{diff,source,sourceTruncated:sourceBytes>=250_000}:{}), previous: previous ? { version: previous.manifest.version, author: previous.manifest.author, edited: this.list().find(p => p.id === manifest.id)?.edited } : null, changes: previous ? { components:changed(previous.manifest.components??{},manifest.components),methods:changed(previous.manifest.methods,manifest.methods),settings:changed(previous.manifest.settings,manifest.settings),templates:changed(Object.fromEntries(previous.manifest.templates.map(t=>[t.key,t])),Object.fromEntries(manifest.templates.map(t=>[t.key,t]))),risky:previous.manifest.risky!==manifest.risky,backend:previous.manifest.backend!==manifest.backend,access:JSON.stringify(previous.manifest.access)!==JSON.stringify(manifest.access) } : null };
  }
  /** Caller must collect consent for precisely this hash before invoking install. */
  async install(files: PackageFiles, expectedHash: string, replace = false,approvePaths=false): Promise<PluginRecord> {
    const manifest = this.validate(files), hash = packageHash(files);
    if (hash !== expectedHash) throw new Error("Package changed after consent; review it again");
    if(this.preview(files).parts.paths.length&&!approvePaths)throw new Error("Imported folders require explicit approval");
    const previous = this.database.list().find(p => p.manifest.id === manifest.id);
    if (previous && previous.hash !== packageHash(this.codeFiles(files)) && !replace) throw new Error("Plugin already exists; review changes and choose replace or keep mine");
    const settings = Object.fromEntries(Object.entries(manifest.settings).filter(([,v]) => v.type !== "secret").map(([k,v]) => [k, previous?.settings[k] ?? v.default ?? (v.type === "paths" ? [] : v.type === "boolean" ? false : "")]));
    const code=this.codeFiles(files),codeHash=packageHash(code);
    const record: PluginRecord = { manifest, hash:codeHash, ...(previous&&previous.hash!==codeHash?{baseHash:previous.hash}:{}), enabled: true, keepAlive: previous?.keepAlive ?? false, settings, installedAt: Date.now() };
    writePackage(this.snapshot(record), code);
    await this.stop(manifest.id);
    const payload=this.payload(files,manifest);Object.assign(record.settings,payload.settings??{});
    if(payload.state)this.database.replaceState(manifest.id,payload.state);
    if(payload.hasData){
      const folder=path.join(this.directory(manifest.id),"data"),staging=path.join(this.directory(manifest.id),`data-import-${randomUUID()}`),backup=path.join(this.directory(manifest.id),`data-previous-${randomUUID()}`);
      fs.mkdirSync(staging,{recursive:true});writePackage(staging,payload.data);const existed=fs.existsSync(folder);if(existed)fs.renameSync(folder,backup);
      try{fs.renameSync(staging,folder);}catch(error){if(existed)fs.renameSync(backup,folder);throw error;}
      if(existed)fs.rmSync(backup,{recursive:true,force:true});
    }
    this.database.save(record); this.permission(manifest);
    this.database.markRemoved(manifest.id,false);
    const source=this.draft(manifest.id);
    if(fs.existsSync(source)){
      await this.history(manifest.id,"Before plugin update");
      for(const name of Object.keys(readPackage(source)))fs.unlinkSync(packagePath(source,name));
    }
    writePackage(source,code);await this.history(manifest.id,`Install ${manifest.version}`);
    this.event(manifest.id,"changed",null,true);
    return record;
  }
  private codeFiles(files:PackageFiles):PackageFiles {return Object.fromEntries(Object.entries(files).filter(([name])=>!name.startsWith("scribe/")));}
  async create(manifestInput: unknown): Promise<{ id: string; files: string[] }> {
    const manifest = parseManifest(manifestInput), folder = this.draft(manifest.id);
    if (fs.existsSync(folder)) throw new Error("Plugin source already exists");
    writePackage(folder, { "plugin.json": Buffer.from(JSON.stringify(manifest,null,2)+"\n"), ...(manifest.backend ? { [manifest.backend]: Buffer.from("export default { methods: {}, templates: {} };\n") } : {}), ...(manifest.guide ? { [manifest.guide]: Buffer.from(`# ${manifest.name}\n\n${manifest.summary}\n`) } : {}) });
    await this.history(manifest.id,"Create plugin"); return { id: manifest.id, files: Object.keys(readPackage(folder)) };
  }
  read(id: string, name?: string): unknown {
    const folder = fs.existsSync(this.draft(id)) ? this.draft(id) : this.snapshot(this.get(id));
    const files = readPackage(folder);
    if (!name) return Object.keys(files);
    packagePath(folder,name); if (!Object.hasOwn(files,name)) throw new Error("Plugin file not found");
    if (files[name].length > 100_000) throw new Error("File too large for plugin_read");
    return files[name].toString("utf8");
  }
  async patch(id: string, name: string, content: string): Promise<void> {
    const folder = this.draft(id);
    if (!fs.existsSync(folder)) writePackage(folder,readPackage(this.snapshot(this.get(id))));
    const target = packagePath(folder,name);
    if (name.split("/").some(p => [".git","node_modules",".scribe-merge","scribe"].includes(p))) throw new Error("Reserved source path");
    // Check all existing parents for junctions/symlinks before writing.
    let parent = path.dirname(target);
    while (parent !== folder) { if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error("Linked paths are refused"); parent = path.dirname(parent); }
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("Linked paths are refused");
    if (Buffer.byteLength(content) > 1_000_000) throw new Error("Plugin source file too large");
    fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,content);
    await this.history(id,`Edit ${name}`);
  }
  async reload(id: string) {
    const files = readPackage(this.draft(id)), manifest = this.validate(files);
    if(Object.keys(files).some(name=>name.startsWith("scribe/")))throw new Error("Draft source cannot carry imported settings, state or data parts");
    if(manifest.source&&manifest.backend){
      const root=fs.realpathSync(this.draft(id));
      const result=await build({absWorkingDir:root,entryPoints:[packagePath(root,manifest.source)],bundle:true,platform:"node",format:"esm",target:"node22",write:false,logLevel:"silent",plugins:[{name:"scribe-plugin-files",setup(builder){
        builder.onResolve({filter:/.*/},async args=>{
          if(args.pluginData?.confined)return;
          if(builtinModules.includes(args.path)||args.path.startsWith("node:"))return {path:args.path,external:true};
          if(args.kind!=="entry-point"&&(path.isAbsolute(args.path)||!args.path.startsWith(".")))return {errors:[{text:"Plugin imports must be relative files inside the source folder or Node built-ins"}]};
          const resolved=await builder.resolve(args.path,{resolveDir:args.resolveDir||root,kind:args.kind,pluginData:{confined:true}});
          if(resolved.errors.length)return {errors:resolved.errors};
          const actual=fs.realpathSync(resolved.path),relative=path.relative(root,actual);
          if(relative.startsWith("..")||path.isAbsolute(relative))return {errors:[{text:"Plugin import leaves its source folder"}]};
          return {path:actual};
        });
      }}]});
      files[manifest.backend]=Buffer.from(result.outputFiles[0].contents);fs.mkdirSync(path.dirname(packagePath(this.draft(id),manifest.backend)),{recursive:true});fs.writeFileSync(packagePath(this.draft(id),manifest.backend),files[manifest.backend]);
    }
    const previous = this.database.list().find(p => p.manifest.id === id);
    if (manifest.id !== id) throw new Error("Changing a plugin id requires a new plugin");
    if (previous && packageHash(files) !== previous.hash && manifest.version === previous.manifest.version) {
      const [major,minor,patch] = manifest.version.split(".").map(Number); manifest.version = `${major}.${minor}.${patch+1}`;
      files["plugin.json"] = Buffer.from(JSON.stringify(manifest,null,2)+"\n"); fs.writeFileSync(path.join(this.draft(id),"plugin.json"),files["plugin.json"]); await this.history(id,"Bump plugin version");
    }
    return this.preview(files);
  }
  private async history(id: string, message: string): Promise<void> {
    const cwd=this.draft(id),opts={cwd,windowsHide:true,timeout:10_000};
    try{
      if(!fs.existsSync(path.join(cwd,".git")))await execute("git",["init","--template="],opts);
      const exclude=path.join(cwd,".git","info","exclude");fs.mkdirSync(path.dirname(exclude),{recursive:true});if(!fs.existsSync(exclude)||!fs.readFileSync(exclude,"utf8").includes(".scribe-merge/"))fs.appendFileSync(exclude,"\n.scribe-merge/\n");
      await execute("git",["add","--all"],opts);
      await execute("git",["-c","user.name=Scribe","-c","user.email=scribe@localhost","-c","commit.gpgsign=false","-c","core.hooksPath=.git/no-hooks","commit","--allow-empty","-m",message],opts);
    }catch{/* Source remains editable when Git is unavailable. */}
  }
  enabled(id: string): boolean { try { return this.database.enabled() && this.get(id).enabled; } catch { return false; } }
  enableAll(enabled: boolean): void { this.database.enable(enabled); if (!enabled) for (const id of this.runtimes.keys()) this.stop(id);else this.startKeptAlive(); this.event("*","changed",null,true); }
  startKeptAlive():void {if(!this.database.enabled())return;for(const p of this.database.list())if(p.enabled&&p.keepAlive&&p.manifest.backend)void (async()=>{await this.stopping.get(p.manifest.id);if(this.enabled(p.manifest.id))await this.runtime(p.manifest.id).start();})().catch(()=>{});}
  async enable(id: string, enabled: boolean, keepAlive?: boolean): Promise<void> {
    const p=this.get(id);if(keepAlive&&!p.manifest.backend)throw new Error("This plugin has no backend to keep running");
    p.enabled=enabled;if(keepAlive!==undefined)p.keepAlive=keepAlive;this.database.save(p);await this.stop(id);const latest=this.get(id);
    if(latest.enabled&&latest.keepAlive&&this.database.enabled())void this.runtime(id).start().catch(()=>{});this.event(id,"changed",null,true);
  }
  async configure(id: string, settings: Record<string, unknown>): Promise<void> {
    const p = this.get(id);
    for (const [key,value] of Object.entries(settings)) {
      const field = p.manifest.settings[key]; if (!field) throw new Error(`Unknown setting: ${key}`);
      if (field.type === "secret") { if (typeof value !== "string") throw new Error("Secret must be text"); await this.secrets.set(id,key,value); continue; }
      this.settingValue(field.type,value,key);
      p.settings[key] = value;
    }
    await this.stop(id); this.database.save(p);
  }
  private runtime(id: string): PluginRuntime {
    if (!this.enabled(id)) throw new Error("Plugin is disabled");
    let runtime = this.runtimes.get(id); if (runtime) return runtime;
    const p = this.get(id); if (!p.manifest.backend) throw new Error("Plugin has no backend");
    const secretCache=new Map<string,Promise<string|null>>();
    const folder = path.join(this.directory(id),"data"); fs.mkdirSync(folder,{recursive:true});
    runtime = new PluginRuntime({entry:packagePath(this.snapshot(p),p.manifest.backend),dataDir:folder,settings:p.settings},async(method,args)=> {
      if (!this.enabled(id)||this.runtimes.get(id)!==runtime) throw new Error("Plugin is disabled or its runtime was replaced");
      if (method === "secret") { const key = String(args.name); if (p.manifest.settings[key]?.type !== "secret") throw new Error("Unknown secret");if(!secretCache.has(key))secretCache.set(key,this.secrets.get(id,key).catch(error=>{secretCache.delete(key);throw error;}));return secretCache.get(key); }
      if (method === "state.get") return this.database.get(id,String(args.key));
      if (method === "state.set") { const key = String(args.key), result = this.database.set(id,key,args.value); this.event(id,"state",{key,...result}); return result; }
      if (method === "emit") { this.event(id,String(args.name).slice(0,100),args.data); return true; }
      if (method === "context") { const ctx = this.contexts.get(String(args.token)); const fn = ctx?.[String(args.method)]; if (!fn) throw new Error("Action context expired"); return fn(...(Array.isArray(args.args) ? args.args : [])); }
      if (method === "asset" && this.asset) {const caller=this.callers.get(String(args.token));if(!caller?.page)throw new Error("This call has no page for assets");return this.asset(caller.page,String(args.name),String(args.mimeType),Buffer.from(String(args.data),"base64"));}
      throw new Error("Unknown host RPC");
    },p.keepAlive);
    this.runtimes.set(id,runtime); return runtime;
  }
  async call(id: string, method: string, args: unknown, caller: PluginCaller): Promise<unknown> {
    await this.stopping.get(id);
    const p = this.get(id);
    if (!Object.hasOwn(p.manifest.methods,method)) throw new Error(`Unknown plugin method: ${method}`);
    const token=randomUUID();this.callers.set(token,caller);
    try{const result=await this.runtime(id).call("call",{method,args,caller:{...caller,token}});if(!this.enabled(id))throw new Error("Plugin was disabled during the call");return result;}finally{this.callers.delete(token);}
  }
  async hook(id: string, template: string, hook: string, args: unknown[], caller: PluginCaller): Promise<unknown> {
    await this.stopping.get(id);
    const token = randomUUID(), callbacks: Record<string, (...args: unknown[]) => unknown> = {};
    const safeArgs = args.map(arg => {
      if (!arg || typeof arg !== "object" || Array.isArray(arg)) return arg;
      return Object.fromEntries(Object.entries(arg).map(([key,value]) => { if (typeof value !== "function") return [key,value]; callbacks[key]=value; return [key,{__scribeCallback:key,__scribeToken:token}]; }));
    });
    this.contexts.set(token,callbacks);
    this.callers.set(token,caller);
    try { return await this.runtime(id).call("hook",{template,hook,args:safeArgs,caller:{...caller,token}}); }
    finally { this.contexts.delete(token);this.callers.delete(token); }
  }
  templates() {
    return this.database.list().filter(p=>this.enabled(p.manifest.id)).flatMap(p=>p.manifest.templates.flatMap(t=>{
      try{
        const original=this.text(p.manifest.id,t.html),html=declarePlugins(original,[p.manifest.id,...declaredPlugins(original)]);
        const metadata=normalizeTemplateInput({...JSON.parse(this.text(p.manifest.id,t.metadata)),html});
        return [{plugin:p.manifest.id,pluginName:p.manifest.name,definition:t,metadata,html,guide:this.text(p.manifest.id,t.guide)}];
      }catch(error){const message=`Template ${t.key} unavailable: ${String(error)}`;this.pastLogs.set(p.manifest.id,[...(this.pastLogs.get(p.manifest.id)??[]),message].slice(-200));console.error(`Plugin ${p.manifest.id}: ${message}`);return [];}
    }));
  }
  logs(id: string): string[] { this.get(id); return [...(this.pastLogs.get(id)??[]),...(this.runtimes.get(id)?.logs??[])].slice(-200); }
  stop(id: string): Promise<void> {
    const runtime=this.runtimes.get(id);this.runtimes.delete(id);
    if(!runtime)return this.stopping.get(id)??Promise.resolve();
    const done=runtime.stop().finally(()=>{this.pastLogs.set(id,[...(this.pastLogs.get(id)??[]),...runtime.logs].slice(-200));if(this.stopping.get(id)===done)this.stopping.delete(id);});this.stopping.set(id,done);return done;
  }
  async remove(id: string): Promise<void> {const p=this.get(id);p.enabled=false;this.database.save(p);await this.stop(id);this.secrets.remove(id);this.database.markRemoved(id,true);this.database.remove(id); this.event(id,"changed",null,true); }
  async restart(id:string):Promise<void>{await this.stop(id);if(this.enabled(id)&&this.get(id).manifest.backend)await this.runtime(id).start();}
  export(id: string, parts: ExportParts = {source:true}): Buffer {
    const p = this.get(id), files = readPackage(this.snapshot(p));
    files["scribe/parts.json"]=Buffer.from(JSON.stringify(parts));
    if (!parts.source) {
      for (const key of Object.keys(files)) if (key!==p.manifest.backend && (key.startsWith("src/")||key===p.manifest.source)) delete files[key];
      if(p.manifest.source){const {source,...manifest}=p.manifest;files["plugin.json"]=Buffer.from(JSON.stringify(manifest,null,2));}
    }
    if (parts.settings) files["scribe/settings.json"] = Buffer.from(JSON.stringify(p.settings));
    if (parts.state) files["scribe/state.json"] = Buffer.from(JSON.stringify(this.database.state(id)));
    if (parts.data) { const folder = path.join(this.directory(id),"data"); if (this.runtimes.get(id)?.status() === "running") throw new Error("Stop the plugin before exporting its data"); if(fs.existsSync(folder)) for(const [name,data] of Object.entries(readPackage(folder))) files[`scribe/data/${name}`]=data; }
    if(parts.source&&p.baseHash){const base=path.join(this.directory(id),"versions",p.baseHash);if(fs.existsSync(base))for(const [name,data]of Object.entries(readPackage(base)))files[`scribe/base/${name}`]=data;}
    return zip(files);
  }
  prepareMerge(id:string,files:PackageFiles):{source:string;incoming:string;base:string} {
    const p=this.get(id),folder=this.draft(id);if(!fs.existsSync(folder))writePackage(folder,readPackage(this.snapshot(p)));
    const incoming=path.join(folder,".scribe-merge",packageHash(files),"incoming"),base=path.join(folder,".scribe-merge",packageHash(files),"base");
    writePackage(incoming,this.codeFiles(files));
    const exportedBase=Object.fromEntries(Object.entries(files).filter(([name])=>name.startsWith("scribe/base/")).map(([name,data])=>[name.slice(12),data]));
    writePackage(base,Object.keys(exportedBase).length?exportedBase:readPackage(this.snapshot(p)));
    return {source:folder,incoming,base};
  }
  close(): Promise<void> {
    return this.closing??=(async()=>{for (const id of this.runtimes.keys()) this.stop(id);await Promise.all(this.stopping.values());this.database.close();})();
  }
}
