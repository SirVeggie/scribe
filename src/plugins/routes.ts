import { Router } from "express";
import type express from "express";
import { identify } from "../callers.js";
import type { AgentHost } from "../agent/host.js";
import { noPages } from "../agent/types.js";
import type { BoardStore } from "../store.js";
import { checkPermission } from "../pagePermissions.js";
import { PluginService } from "./service.js";
import { readPackage, unzip } from "./package.js";
import { findRepo } from "../agent/git.js";

export function pluginRouter(service: PluginService, store: BoardStore, host: AgentHost): Router {
  const router=Router();
  const wrap=(fn:(req:express.Request,res:express.Response)=>unknown)=>(req:express.Request,res:express.Response)=>{ Promise.resolve().then(()=>fn(req,res)).then(data=>{if(!res.headersSent)res.json(data??{ok:true});}).catch(error=>{if(!res.headersSent)res.status(400).json({ok:false,error:String(error.message??error)});}); };
  const thread=(req:express.Request)=>{const caller=identify(req); if(caller.viewer!=="agent") return null; const t=caller.thread?host.getThread(caller.thread):null; if(!t || noPages(t.scope)) throw new Error("Plugin tools need a Scribe thread with page access"); return t;};
  const author=(req:express.Request)=>{const t=thread(req); if(t?.approval==="readonly") throw new Error("Read-only chats cannot change plugins");return t;};
  const user=(req:express.Request)=>{if(identify(req).viewer!=="user")throw new Error("Only the Scribe UI can change plugin settings");};
  const consent=async(req:express.Request,title:string,detail:string)=>{
    const t=author(req); if(!t)return true; if(t.approval==="full")return true;
    return (await host.requestPluginApproval(t.id,title,detail,false)).allowed;
  };
  router.get("/",wrap(req=>{thread(req);return {enabled:service.database.enabled(),plugins:service.list()};}));
  router.put("/",wrap(req=>{user(req);service.enableAll(req.body?.enabled===true);}));
  router.post("/create",wrap(req=>{author(req);return service.create(req.body?.manifest);}));
  router.post("/git-history/repositories",wrap(async req=>{
    user(req);const repository=String(req.body?.repository??"");
    const repo=await findRepo(repository);if(!repo)throw new Error("No Git repository at this path");
    const previous=service.get("git-history").settings.repositories;
    await service.configure("git-history",{repositories:[...new Set([...(Array.isArray(previous)?previous:[]),repo])]});return {ok:true,repository:repo};
  }));
  router.post("/preview",wrap(async req=>{author(req);const files=await unzip(Buffer.from(String(req.body?.archive),"base64"));return {...service.preview(files),source:Object.fromEntries(Object.entries(files).filter(([name,data])=>!name.startsWith("scribe/")&&data.length<100_000).map(([name,data])=>[name,data.toString("utf8")]))};}));
  router.post("/merge",wrap(async req=>{
    user(req);const files=await unzip(Buffer.from(String(req.body?.archive),"base64")),preview=service.preview(files),id=String(req.body?.id);
    if(preview.manifest.id!==id)throw new Error("Plugin id mismatch");
    const folders=service.prepareMerge(id,files),providers=await host.providerStatus(),provider=providers.find(p=>p.available)?.id;
    if(!provider)throw new Error("No agent provider is available for the merge");
    const thread=host.createThread({provider,model:"default",mode:"code",approval:"edits",cwd:folders.source,title:`Merge ${preview.manifest.name} update`,scope:{kind:"global",ref:null}},{remember:false});
    host.send(thread.id,{text:`Merge an imported update of plugin ${id} into the source in this workspace. The user's local source is in the workspace root; incoming files are at ${folders.incoming}; the exported base (or installed version as reference when no base was provided) is at ${folders.base}. Preserve both sides' intended changes, update plugin.json's semver, run plugin_reload to validate and bundle, then plugin_install with replace:true to ask for activation. Do not edit .scribe-merge or .git. Plugin methods, settings, actions and permission changes need to remain visible in the install preview.`,from:"scribe"});
    return {ok:true,thread:thread.id};
  }));
  router.post("/install",wrap(async req=>{
    const t=author(req);
    const files=req.body?.archive?await unzip(Buffer.from(String(req.body.archive),"base64")):readPackage(service.draft(String(req.body?.id)));
    const preview=service.preview(files);
    if(t && !(await consent(req,`Install ${preview.manifest.name} ${preview.manifest.version}?`,JSON.stringify(preview,null,2))))throw new Error("Plugin installation denied");
    if(!t && req.body?.hash!==preview.hash)throw new Error("Review this package before installing it");
    await service.stop(preview.manifest.id);
    return service.install(files,preview.hash,req.body?.replace===true);
  }));
  router.get("/:plugin/guide",wrap(req=>{thread(req);return service.guide(req.params.plugin);}));
  router.get("/:plugin/logs",wrap(req=>{thread(req);return {logs:service.logs(req.params.plugin)};}));
  router.get("/:plugin/state/:stateKey",wrap(req=>{thread(req);if(!service.enabled(req.params.plugin))throw new Error("Plugin is disabled");return service.database.get(req.params.plugin,req.params.stateKey);}));
  router.get("/:plugin/files",wrap(req=>{thread(req);return {files:service.read(req.params.plugin,typeof req.query.path==="string"?req.query.path:undefined)};}));
  router.put("/:plugin/files",wrap(req=>{author(req);service.patch(req.params.plugin,String(req.body?.path),String(req.body?.content));}));
  router.post("/:plugin/reload",wrap(req=>{author(req);return service.reload(req.params.plugin);}));
  router.post("/:plugin/call",wrap(async req=>{
    const t=thread(req),id=req.params.plugin,method=String(req.body?.method);
    const def=service.get(id).manifest.methods[method]; if(!def)throw new Error("Unknown plugin method");
    if(t) {
      if(!def.agent)throw new Error("Method is not agent-callable");
      if(t.approval==="readonly"&&def.agent!=="read")throw new Error("Method requires Board or higher access");
      if(def.agent==="ask") {
        const home=t.scope.kind==="page"&&t.scope.ref?store.get(t.scope.ref):null;
        const permission=home?checkPermission(store.pagePermissions(home.id),{perm:`plugin.${id}`}):"ask";
        if(permission==="deny")throw new Error("This page denies the plugin");
        if(permission!=="allow" && t.approval!=="full" && !(await host.requestPluginApproval(t.id,`${service.get(id).manifest.name}: ${method}`,JSON.stringify(req.body?.args??{}),true,id)).allowed)throw new Error("Plugin method denied");
      }
    } else throw new Error("Use a page-scoped route to call a plugin");
    return {ok:true,result:await service.call(id,method,req.body?.args??{},{kind:"agent",thread:t.id,...(t.scope.kind==="page"&&t.scope.ref?{page:t.scope.ref}: {})})};
  }));
  router.get("/:plugin",wrap(req=>{user(req);return service.inspect(req.params.plugin);}));
  router.put("/:plugin",wrap(async req=>{user(req);if(req.body?.settings)await service.configure(req.params.plugin,req.body.settings); if(typeof req.body?.enabled==="boolean")service.enable(req.params.plugin,req.body.enabled,req.body.keepAlive);}));
  router.post("/:plugin/restart",wrap(req=>{user(req);service.stop(req.params.plugin);}));
  router.delete("/:plugin",wrap(req=>{user(req);service.remove(req.params.plugin);}));
  router.get("/:plugin/export",wrap((req,res)=>{user(req);const bytes=service.export(req.params.plugin,{source:req.query.source!=="false",settings:req.query.settings==="true",state:req.query.state==="true",data:req.query.data==="true"});res.type("application/zip").attachment(`${req.params.plugin}.scribeplugin`).send(bytes);}));
  return router;
}
