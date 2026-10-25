import { Router } from "express";
import type express from "express";
import { identify } from "../callers.js";
import type { AgentHost } from "../agent/host.js";
import { noPages } from "../agent/types.js";
import type { BoardStore } from "../store.js";
import { checkPermission } from "../pagePermissions.js";
import { PluginService } from "./service.js";
import { readPackage, unzip } from "./package.js";
import { mainRepository } from "./git.js";
import { randomUUID } from "node:crypto";
import type { PackageFiles } from "./package.js";
import { parseWebImportance } from "../agent/webAccess.js";
import { pluginId, declaredPlugins, declarePlugins } from "./manifest.js";
import { zip } from "./package.js";

export function pluginRouter(service: PluginService, store: BoardStore, host: AgentHost): Router {
  const router=Router();
  const reviews=new Map<string,PackageFiles>();
  const wrap=(fn:(req:express.Request,res:express.Response,signal:AbortSignal)=>unknown)=>(req:express.Request,res:express.Response)=>{
    req.setTimeout(0);res.setTimeout(0);const abort=new AbortController(),onClose=()=>{if(!res.writableEnded)abort.abort();};res.on("close",onClose);
    Promise.resolve().then(()=>fn(req,res,abort.signal)).then(data=>{if(!res.headersSent&&!res.destroyed)res.json(data??{ok:true});}).catch(error=>{if(!res.headersSent&&!res.destroyed)res.status(400).json({ok:false,error:String(error.message??error)});}).finally(()=>res.off("close",onClose));
  };
  const thread=(req:express.Request)=>{const caller=identify(req); if(caller.viewer!=="agent") return null; const t=caller.thread?host.getThread(caller.thread):null; if(!t || noPages(t.scope)) throw new Error("Plugin tools need a Scribe thread with page access"); return t;};
  const author=(req:express.Request)=>{const t=thread(req); if(t?.approval==="readonly") throw new Error("Read-only chats cannot change plugins");return t;};
  const user=(req:express.Request)=>{if(identify(req).viewer!=="user")throw new Error("Only the Scribe UI can change plugin settings");};
  const consent=async(req:express.Request,title:string,detail:string,signal:AbortSignal,sourceUrl?:string)=>{
    const t=author(req); if(!t)return true; if(t.approval==="full")return true;
    return (await host.requestPluginApproval(t.id,title,detail,false,undefined,{signal,sourceUrl,importance:parseWebImportance(req.body?.importance)??"useful"})).allowed;
  };
  router.get("/reviews/:token",wrap((req,res)=>{user(req);const files=reviews.get(req.params.token);if(!files)throw new Error("This source review has ended");res.setHeader("Content-Security-Policy","default-src 'none'; sandbox");res.type("text/plain").send(Object.entries(files).filter(([name])=>!name.startsWith("scribe/")).map(([name,data])=>`${name}\n${data.toString("utf8")}`).join("\n\n"));}));
  router.get("/",wrap(req=>{
    const t=thread(req),plugins=service.list();
    if(t)return {enabled:service.database.enabled(),plugins};
    const counts=new Map<string,number>();
    for(const page of [...store.listOpenTabs(),...store.listClosedTabs()])for(const id of new Set(declaredPlugins(page.html)))counts.set(id,(counts.get(id)??0)+1);
    return {enabled:service.database.enabled(),plugins:plugins.map(plugin=>({...plugin,pages:counts.get(plugin.id)??0}))};
  }));
  router.put("/",wrap(req=>{user(req);service.enableAll(req.body?.enabled===true);}));
  router.post("/create",wrap(req=>{author(req);return service.create(req.body?.manifest);}));
  router.post("/git-history/repositories",wrap(async req=>{
    user(req);const repository=String(req.body?.repository??"");
    const repo=await mainRepository(repository);if(!repo)throw new Error("No Git repository at this path");
    if(repo!==repository)throw new Error("Repository resolution changed; review the resolved root before adding it");
    const previous=service.get("git-history").settings.repositories;
    await service.configure("git-history",{repositories:[...new Set([...(Array.isArray(previous)?previous:[]),repo])]});return {ok:true,repository:repo};
  }));
  router.get("/git-history/repositories/resolve",wrap(async req=>{user(req);const repository=await mainRepository(String(req.query.path??""));if(!repository)throw new Error("No Git repository at this path");return {repository};}));
  router.post("/preview",wrap(async req=>{author(req);return service.preview(await unzip(Buffer.from(String(req.body?.archive),"base64")),true);}));
  router.post("/copy",wrap(async req=>{
    user(req);const id=pluginId.parse(req.body?.id),files=await unzip(Buffer.from(String(req.body?.archive),"base64")),manifest=service.validate(files),old=manifest.id;
    if(service.database.list().some(p=>p.manifest.id===id))throw new Error("A plugin with this copy id already exists");
    manifest.id=id;manifest.name+=" (copy)";
    for(const template of manifest.templates){let html=files[template.html].toString("utf8");html=html.replaceAll(`scribe.plugin("${old}")`,`scribe.plugin("${id}")`).replaceAll(`scribe.plugin('${old}')`,`scribe.plugin('${id}')`);files[template.html]=Buffer.from(declarePlugins(html,[id,...declaredPlugins(html).filter(value=>value!==old)]));}
    files["plugin.json"]=Buffer.from(JSON.stringify(manifest,null,2));return {archive:zip(files).toString("base64"),preview:service.preview(files,true)};
  }));
  router.post("/merge",wrap(async req=>{
    user(req);const files=await unzip(Buffer.from(String(req.body?.archive),"base64")),preview=service.preview(files),id=String(req.body?.id);
    if(preview.manifest.id!==id)throw new Error("Plugin id mismatch");
    const providers=await host.providerStatus(),asked=req.body?.provider===undefined?undefined:String(req.body.provider);
    // The dialog's model menu names the provider and model; without one, the first available provider's default.
    const provider=asked===undefined?providers.find(p=>p.available)?.id:providers.find(p=>p.id===asked&&p.available)?.id;
    if(!provider)throw new Error(asked===undefined?"No agent provider is available for the merge":`${asked} is not available for the merge`);
    const model=typeof req.body?.model==="string"&&req.body.model.trim()?req.body.model.trim():"default";
    const folders=service.prepareMerge(id,files);
    const thread=host.createThread({provider,model,mode:"code",approval:"edits",cwd:folders.source,title:`Merge ${preview.manifest.name} update`,scope:{kind:"global",ref:null}},{remember:false});
    host.send(thread.id,{text:`Merge an imported update of plugin ${id} into the source in this workspace. The user's local source is in the workspace root; incoming files are at ${folders.incoming}; the exported base (or installed version as reference when no base was provided) is at ${folders.base}. ${Object.keys(files).some(name=>name.startsWith("scribe/base/"))?"An exported common base is provided.":"No common ancestor is known. The installed reference may itself contain local customizations: inspect and preserve them rather than treating it as an unchanged common base."} Preserve both sides' intended changes, update plugin.json's semver, run plugin_reload to validate and bundle, then plugin_install with replace:true to ask for activation. Do not edit .scribe-merge or .git. Plugin methods, settings, actions and permission changes need to remain visible in the install preview.`,from:"scribe"});
    return {ok:true,thread:thread.id};
  }));
  router.post("/install",wrap(async(req,_res,signal)=>{
    const t=author(req);
    if(!req.body?.archive)await service.reload(String(req.body?.id));
    const files=req.body?.archive?await unzip(Buffer.from(String(req.body.archive),"base64")):readPackage(service.draft(String(req.body?.id)));
    const preview=service.preview(files);
    if(t){
      const token=randomUUID();reviews.set(token,files);
      try{if(!(await consent(req,`Install ${preview.manifest.name} ${preview.manifest.version}?`,JSON.stringify(preview,null,2),signal,`/api/plugins/reviews/${token}`)))throw new Error("Plugin installation denied");}
      finally{reviews.delete(token);}
    }
    if(!req.body?.archive && preview.hash!==service.preview(readPackage(service.draft(preview.manifest.id))).hash)throw new Error("Plugin source changed during approval; review it again");
    if(!t && req.body?.hash!==preview.hash)throw new Error("Review this package before installing it");
    await service.stop(preview.manifest.id);
    return service.install(files,preview.hash,req.body?.replace===true,req.body?.approvePaths===true);
  }));
  router.get("/:plugin/bundled-update",wrap(req=>{user(req);return service.bundledUpdate(req.params.plugin);}));
  router.get("/:plugin/guide",wrap(req=>{thread(req);return service.guide(req.params.plugin);}));
  router.get("/:plugin/logs",wrap(req=>{thread(req);return {logs:service.logs(req.params.plugin)};}));
  router.get("/:plugin/state/:stateKey",wrap(async(req,_res,signal)=>{
    const t=thread(req),id=req.params.plugin;if(!service.enabled(id))throw new Error("Plugin is disabled");
    const home=t?.scope.kind==="page"&&t.scope.ref?store.get(t.scope.ref):null,permission=home?checkPermission(store.pagePermissions(home.id),{perm:`plugin.${id}`}):"ask";
    if(permission==="deny")throw new Error("This page denies the plugin");
    if(t&&permission!=="allow"&&t.approval!=="full"&&!(await host.requestPluginApproval(t.id,`Read ${id} state`,req.params.stateKey,true,id,{signal})).allowed)throw new Error("Plugin state access denied");
    return service.database.get(id,req.params.stateKey);
  }));
  router.get("/:plugin/files",wrap(req=>{thread(req);return {files:service.read(req.params.plugin,typeof req.query.path==="string"?req.query.path:undefined)};}));
  router.put("/:plugin/files",wrap(req=>{author(req);return service.patch(req.params.plugin,String(req.body?.path),String(req.body?.content));}));
  router.post("/:plugin/reload",wrap(req=>{author(req);return service.reload(req.params.plugin);}));
  router.post("/:plugin/call",wrap(async(req,_res,signal)=>{
    const t=thread(req),id=req.params.plugin,method=String(req.body?.method);
    const def=service.get(id).manifest.methods[method]; if(!def)throw new Error("Unknown plugin method");
    if(t) {
      if(!def.agent)throw new Error("Method is not agent-callable");
      if(t.approval==="readonly"&&def.agent!=="read")throw new Error("Method requires Board or higher access");
      if(def.agent==="ask") {
        const home=t.scope.kind==="page"&&t.scope.ref?store.get(t.scope.ref):null;
        const permission=home?checkPermission(store.pagePermissions(home.id),{perm:`plugin.${id}`}):"ask";
        if(permission==="deny")throw new Error("This page denies the plugin");
        if(permission!=="allow" && t.approval!=="full" && !(await host.requestPluginApproval(t.id,`${service.get(id).manifest.name}: ${method}`,JSON.stringify(req.body?.args??{}),true,id,{signal,importance:parseWebImportance(req.body?.importance)??"useful"})).allowed)throw new Error("Plugin method denied");
      }
    } else throw new Error("Use a page-scoped route to call a plugin");
    return {ok:true,result:await service.call(id,method,req.body?.args??{},{kind:"agent",thread:t.id,...(t.scope.kind==="page"&&t.scope.ref?{page:t.scope.ref}: {})})};
  }));
  router.get("/:plugin",wrap(req=>{user(req);return service.inspect(req.params.plugin);}));
  router.put("/:plugin",wrap(async req=>{user(req);if(req.body?.settings)await service.configure(req.params.plugin,req.body.settings); if(typeof req.body?.enabled==="boolean"||typeof req.body?.keepAlive==="boolean")await service.enable(req.params.plugin,typeof req.body.enabled==="boolean"?req.body.enabled:service.get(req.params.plugin).enabled,req.body.keepAlive);}));
  router.post("/:plugin/restart",wrap(req=>{user(req);return service.restart(req.params.plugin);}));
  router.delete("/:plugin",wrap(req=>{user(req);return service.remove(req.params.plugin);}));
  router.get("/:plugin/export",wrap((req,res)=>{user(req);const bytes=service.export(req.params.plugin,{source:req.query.source!=="false",settings:req.query.settings==="true",state:req.query.state==="true",data:req.query.data==="true"});res.type("application/zip").attachment(`${req.params.plugin}.scribeplugin`).send(bytes);}));
  return router;
}
