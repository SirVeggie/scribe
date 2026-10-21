import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dataDir } from "../config.js";
import { PAGE_PERMISSIONS } from "../pagePermissions.js";
import { parseManifest, pluginId, type PluginManifest } from "./manifest.js";
import { PluginDatabase, type PluginRecord } from "./database.js";
import { packageHash, packagePath, readPackage, writePackage, zip, type PackageFiles } from "./package.js";
import { PluginRuntime } from "./runtime.js";
import { PluginSecrets } from "./secrets.js";

export type PluginCaller = { kind: "page" | "agent" | "system"; page?: string; thread?: string };
export type ExportParts = { source?: boolean; settings?: boolean; state?: boolean; data?: boolean };
export class PluginService {
  readonly database: PluginDatabase;
  private secrets: PluginSecrets;
  private runtimes = new Map<string, PluginRuntime>();
  private contexts = new Map<string, Record<string, (...args: unknown[]) => unknown>>();
  constructor(readonly root = path.join(dataDir(), "plugins"), private event: (id: string, name: string, data: unknown) => void = () => {}, private asset?: (page: string, name: string, mimeType: string, bytes: Buffer) => unknown) {
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
    return this.database.list().map(p => ({ id: p.manifest.id, name: p.manifest.name, version: p.manifest.version, summary: p.manifest.summary, enabled: p.enabled && this.database.enabled(), keepAlive: p.keepAlive, status: this.runtimes.get(p.manifest.id)?.status() ?? "idle", edited: fs.existsSync(this.draft(p.manifest.id)) && packageHash(readPackage(this.draft(p.manifest.id))) !== p.hash }));
  }
  inspect(id: string) {
    const p = this.get(id);
    return { ...this.list().find(p => p.id === id), manifest: p.manifest, settings: p.settings, secrets: Object.fromEntries(Object.entries(p.manifest.settings).filter(([,v]) => v.type === "secret").map(([k]) => [k, this.secrets.has(id,k)])), readme: this.text(id,p.manifest.readme), methods: p.manifest.methods, logs: this.logs(id) };
  }
  private text(id: string, file?: string): string { return file ? fs.readFileSync(packagePath(this.snapshot(this.get(id)),file),"utf8") : ""; }
  guide(id: string) { const p = this.get(id); return { id, summary: p.manifest.summary, guide: this.text(id,p.manifest.guide), methods: p.manifest.methods }; }
  private snapshot(p: PluginRecord): string { return path.join(this.directory(p.manifest.id), "versions", p.hash); }
  validate(files: PackageFiles): PluginManifest {
    if (!files["plugin.json"]) throw new Error("Package needs plugin.json");
    const manifest = parseManifest(JSON.parse(files["plugin.json"].toString("utf8")));
    for (const file of [manifest.backend, manifest.guide, manifest.readme, ...manifest.templates.flatMap(t => [t.metadata,t.html,t.guide])]) if (file && !files[file]) throw new Error(`Missing package file: ${file}`);
    if (!manifest.backend && (Object.keys(manifest.methods).length || manifest.templates.some(t => t.actions || t.hooks?.length))) throw new Error("Methods and hooks require a backend");
    return manifest;
  }
  preview(files: PackageFiles) {
    const manifest = this.validate(files), hash = packageHash(files), previous = this.database.list().find(p => p.manifest.id === manifest.id);
    return { manifest, hash, previous: previous ? { version: previous.manifest.version, author: previous.manifest.author, edited: this.list().find(p => p.id === manifest.id)?.edited } : null, changes: previous ? { addedMethods: Object.keys(manifest.methods).filter(m => !Object.hasOwn(previous.manifest.methods,m)), removedMethods: Object.keys(previous.manifest.methods).filter(m => !Object.hasOwn(manifest.methods,m)), access: manifest.access } : null };
  }
  /** Caller must collect consent for precisely this hash before invoking install. */
  install(files: PackageFiles, expectedHash: string, replace = false): PluginRecord {
    const manifest = this.validate(files), hash = packageHash(files);
    if (hash !== expectedHash) throw new Error("Package changed after consent; review it again");
    const previous = this.database.list().find(p => p.manifest.id === manifest.id);
    if (previous && previous.hash !== hash && !replace) throw new Error("Plugin already exists; review changes and choose replace or keep mine");
    const settings = Object.fromEntries(Object.entries(manifest.settings).filter(([,v]) => v.type !== "secret").map(([k,v]) => [k, previous?.settings[k] ?? v.default ?? (v.type === "paths" ? [] : v.type === "boolean" ? false : "")]));
    const record: PluginRecord = { manifest, hash, enabled: true, keepAlive: previous?.keepAlive ?? false, settings, installedAt: Date.now() };
    writePackage(this.snapshot(record), files);
    this.stop(manifest.id); this.database.save(record); this.permission(manifest); this.event(manifest.id,"changed",null);
    return record;
  }
  create(manifestInput: unknown): { id: string; files: string[] } {
    const manifest = parseManifest(manifestInput), folder = this.draft(manifest.id);
    if (fs.existsSync(folder)) throw new Error("Plugin source already exists");
    writePackage(folder, { "plugin.json": Buffer.from(JSON.stringify(manifest,null,2)+"\n"), ...(manifest.backend ? { [manifest.backend]: Buffer.from("export default { methods: {}, templates: {} };\n") } : {}), ...(manifest.guide ? { [manifest.guide]: Buffer.from(`# ${manifest.name}\n\n${manifest.summary}\n`) } : {}) });
    this.history(manifest.id,"Create plugin"); return { id: manifest.id, files: Object.keys(readPackage(folder)) };
  }
  read(id: string, name?: string): unknown {
    const folder = fs.existsSync(this.draft(id)) ? this.draft(id) : this.snapshot(this.get(id));
    const files = readPackage(folder);
    if (!name) return Object.keys(files);
    packagePath(folder,name); if (!Object.hasOwn(files,name)) throw new Error("Plugin file not found");
    if (files[name].length > 100_000) throw new Error("File too large for plugin_read");
    return files[name].toString("utf8");
  }
  patch(id: string, name: string, content: string): void {
    const folder = this.draft(id);
    if (!fs.existsSync(folder)) writePackage(folder,readPackage(this.snapshot(this.get(id))));
    const target = packagePath(folder,name);
    if (name.split("/").some(p => p === ".git" || p === "node_modules")) throw new Error("Reserved source path");
    // Check all existing parents for junctions/symlinks before writing.
    let parent = path.dirname(target);
    while (parent !== folder) { if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error("Linked paths are refused"); parent = path.dirname(parent); }
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("Linked paths are refused");
    if (Buffer.byteLength(content) > 1_000_000) throw new Error("Plugin source file too large");
    fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,content);
    this.history(id,`Edit ${name}`);
  }
  reload(id: string): { manifest: PluginManifest; hash: string; previous: unknown; changes: unknown } {
    const files = readPackage(this.draft(id)), manifest = this.validate(files);
    const previous = this.database.list().find(p => p.manifest.id === id);
    if (manifest.id !== id) throw new Error("Changing a plugin id requires a new plugin");
    if (previous && packageHash(files) !== previous.hash && manifest.version === previous.manifest.version) {
      const [major,minor,patch] = manifest.version.split(".").map(Number); manifest.version = `${major}.${minor}.${patch+1}`;
      files["plugin.json"] = Buffer.from(JSON.stringify(manifest,null,2)+"\n"); fs.writeFileSync(path.join(this.draft(id),"plugin.json"),files["plugin.json"]); this.history(id,"Bump plugin version");
    }
    return this.preview(files);
  }
  private history(id: string, message: string): void {
    const cwd = this.draft(id), opts = { cwd, windowsHide: true, stdio: "ignore" as const, timeout: 10_000 };
    try { if (!fs.existsSync(path.join(cwd,".git"))) execFileSync("git",["init"],opts); execFileSync("git",["add","--all"],opts); execFileSync("git",["-c","user.name=Scribe","-c","user.email=scribe@localhost","commit","--allow-empty","-m",message],opts); } catch { /* Source remains editable when Git is unavailable. */ }
  }
  enabled(id: string): boolean { try { return this.database.enabled() && this.get(id).enabled; } catch { return false; } }
  enableAll(enabled: boolean): void { this.database.enable(enabled); if (!enabled) for (const id of this.runtimes.keys()) this.stop(id); this.event("*","changed",null); }
  enable(id: string, enabled: boolean, keepAlive?: boolean): void { const p = this.get(id); p.enabled = enabled; if (keepAlive !== undefined) p.keepAlive = keepAlive; this.stop(id); this.database.save(p); if (enabled && p.keepAlive && this.database.enabled()) void this.runtime(id).start().catch(()=>{}); this.event(id,"changed",null); }
  async configure(id: string, settings: Record<string, unknown>): Promise<void> {
    const p = this.get(id);
    for (const [key,value] of Object.entries(settings)) {
      const field = p.manifest.settings[key]; if (!field) throw new Error(`Unknown setting: ${key}`);
      if (field.type === "secret") { if (typeof value !== "string") throw new Error("Secret must be text"); await this.secrets.set(id,key,value); continue; }
      if ((field.type === "string" && typeof value !== "string") || (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) || (field.type === "boolean" && typeof value !== "boolean") || (field.type === "paths" && (!Array.isArray(value) || value.some(v=> typeof v !== "string")))) throw new Error(`Invalid value for ${key}`);
      p.settings[key] = value;
    }
    this.stop(id); this.database.save(p);
  }
  private runtime(id: string): PluginRuntime {
    if (!this.enabled(id)) throw new Error("Plugin is disabled");
    let runtime = this.runtimes.get(id); if (runtime) return runtime;
    const p = this.get(id); if (!p.manifest.backend) throw new Error("Plugin has no backend");
    const folder = path.join(this.directory(id),"data"); fs.mkdirSync(folder,{recursive:true});
    runtime = new PluginRuntime({entry:packagePath(this.snapshot(p),p.manifest.backend),dataDir:folder,settings:p.settings},async(method,args)=> {
      if (!this.enabled(id)) throw new Error("Plugin is disabled");
      if (method === "secret") { const key = String(args.name); if (p.manifest.settings[key]?.type !== "secret") throw new Error("Unknown secret"); return this.secrets.get(id,key); }
      if (method === "state.get") return this.database.get(id,String(args.key));
      if (method === "state.set") { const key = String(args.key), result = this.database.set(id,key,args.value); this.event(id,"state",{key,...result}); return result; }
      if (method === "emit") { this.event(id,String(args.name).slice(0,100),args.data); return true; }
      if (method === "context") { const ctx = this.contexts.get(String(args.token)); const fn = ctx?.[String(args.method)]; if (!fn) throw new Error("Action context expired"); return fn(...(Array.isArray(args.args) ? args.args : [])); }
      if (method === "asset" && this.asset && typeof args.page === "string") return this.asset(args.page,String(args.name),String(args.mimeType),Buffer.from(String(args.data),"base64"));
      throw new Error("Unknown host RPC");
    },p.keepAlive);
    this.runtimes.set(id,runtime); return runtime;
  }
  async call(id: string, method: string, args: unknown, caller: PluginCaller): Promise<unknown> {
    const p = this.get(id);
    if (!Object.hasOwn(p.manifest.methods,method)) throw new Error(`Unknown plugin method: ${method}`);
    return this.runtime(id).call("call",{method,args,caller});
  }
  async hook(id: string, template: string, hook: string, args: unknown[], caller: PluginCaller): Promise<unknown> {
    const token = randomUUID(), callbacks: Record<string, (...args: unknown[]) => unknown> = {};
    const safeArgs = args.map(arg => {
      if (!arg || typeof arg !== "object" || Array.isArray(arg)) return arg;
      return Object.fromEntries(Object.entries(arg).map(([key,value]) => { if (typeof value !== "function") return [key,value]; callbacks[key]=value; return [key,{__scribeCallback:key}]; }));
    });
    this.contexts.set(token,callbacks);
    try { return await this.runtime(id).call("hook",{template,hook,args:safeArgs,caller:{...caller,token}}); }
    finally { this.contexts.delete(token); }
  }
  templates() {
    return this.database.list().filter(p=>this.enabled(p.manifest.id)).flatMap(p=>p.manifest.templates.map(t=>({plugin:p.manifest.id, definition:t, metadata:JSON.parse(this.text(p.manifest.id,t.metadata)), html:`<meta name="scribe-plugins" content="${p.manifest.id}">\n${this.text(p.manifest.id,t.html)}`,guide:this.text(p.manifest.id,t.guide)})));
  }
  logs(id: string): string[] { this.get(id); return this.runtimes.get(id)?.logs ?? []; }
  stop(id: string): void { this.runtimes.get(id)?.stop(); this.runtimes.delete(id); }
  remove(id: string): void { this.stop(id); this.database.remove(id); this.event(id,"changed",null); }
  export(id: string, parts: ExportParts = {source:true}): Buffer {
    const p = this.get(id), files = readPackage(this.snapshot(p));
    if (!parts.source) for (const key of Object.keys(files)) if (key.startsWith("src/")) delete files[key];
    if (parts.settings) files["scribe/settings.json"] = Buffer.from(JSON.stringify(p.settings));
    if (parts.state) files["scribe/state.json"] = Buffer.from(JSON.stringify(this.database.state(id)));
    if (parts.data) { const folder = path.join(this.directory(id),"data"); if (this.runtimes.get(id)?.status() === "running") throw new Error("Stop the plugin before exporting its data"); if(fs.existsSync(folder)) for(const [name,data] of Object.entries(readPackage(folder))) files[`scribe/data/${name}`]=data; }
    return zip(files);
  }
  close(): void { for (const id of this.runtimes.keys()) this.stop(id); this.database.close(); }
}
