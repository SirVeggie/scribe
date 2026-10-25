import { z } from "zod";
import type { BoardStore } from "../store.js";
import type { Tab } from "../types.js";
import { isPlainObject } from "../types.js";
import { parseTemplateValues } from "../templates.js";
import { checkPermission } from "../pagePermissions.js";
import type { ActionCaller, ActionContext, ActionOutcome, DriveContext, PageLaunch, ReplyDelivery, RunEvent, SweepContext } from "../actions/types.js";
import { PluginService } from "./service.js";
import { MAX_EVENT_DATA_BYTES } from "../config.js";

const record=z.record(z.string(),z.unknown());
const launchSchema=z.object({resumeThread:z.string().max(100).optional(),prompt:z.string().min(1).max(100_000),settings:z.object({title:z.string().min(1).max(300),mode:z.string().default("board"),provider:z.string().optional(),model:z.string().optional(),effort:z.string().optional(),customMode:z.string().optional(),show:z.string().optional(),web:z.string().default("off"),approval:z.string().default("board"),modelParams:z.record(z.string(),z.string()).default({}),cwd:z.string().optional(),worktree:z.boolean().optional(),helpers:z.boolean().default(false)}),run:z.object({tag:z.string().max(100),data:record.refine(value=>JSON.stringify(value).length<=4000),merge:z.boolean().default(true),resumePrompt:z.string().default(""),after:z.number().optional()}),ref:record.default({})});
const deliverSchema=z.object({thread:z.string().min(1).max(100),num:z.number().int().positive(),title:z.string().max(300),text:z.string().max(100_000),resume:z.boolean(),ref:z.record(z.string(),z.string()).optional()});
const outcomeSchema = z.object({ops:z.array(z.unknown()).max(10000),result:z.unknown().optional(),events:z.array(z.object({name:z.string().trim().min(1).max(100),data:z.unknown().optional().refine(value=>value===undefined||Buffer.byteLength(JSON.stringify(value))<=MAX_EVENT_DATA_BYTES)})).max(100).optional(),deliver:deliverSchema.optional(),launch:launchSchema.optional()});
export class PluginActions {
  private busy = new Set<string>();
  constructor(readonly service: PluginService, private store: BoardStore) {}
  binding(tab: Tab) {
    if (!tab.templateId) return null;
    const template=this.store.findTemplate(tab.templateId)?.template;
    const key=template?.source?.builtin;
    return this.service.database.list().flatMap(p=>p.manifest.templates.map(t=>({id:p.manifest.id,t,key:`plugin-${p.manifest.id}--${t.key}`}))).find(t=>t.key===key) ?? null;
  }
  async seed(templateId: string, values: unknown): Promise<Record<string, unknown> | undefined> {
    const template=this.store.findTemplate(templateId)?.template;
    if(!template)return undefined;
    const key=template.source?.builtin ?? template.key;
    const binding=this.service.database.list().flatMap(p=>p.manifest.templates.map(t=>({id:p.manifest.id,t,key:`plugin-${p.manifest.id}--${t.key}`}))).find(t=>t.key===key);
    if(!binding)return undefined;
    if(!this.service.enabled(binding.id))throw new Error("Plugin is disabled");
    if(!binding.t.hooks?.includes("seed"))return undefined;
    const state=await this.service.hook(binding.id,binding.t.key,"seed",[structuredClone(template.initialState??{}),parseTemplateValues(template.fields,values)],{kind:"system"});
    if(!isPlainObject(state))throw new Error("Plugin seed must return an object");
    if(!this.service.enabled(binding.id))throw new Error("Plugin was disabled during seed");
    return state;
  }
  async reply(source: Tab, data: unknown, summary: unknown, thread?:ActionContext["thread"]) {
    if(!source.replyTo)throw new Error("This page has no reply target");
    const target=this.store.get(source.replyTo.page); if(!target)throw new Error("Reply target was removed");
    const binding=this.binding(target);
    if(!binding?.t.hooks?.includes("reply"))return null;
    if(data!==undefined && !isPlainObject(data))throw new Error("Reply data must be an object");
    if(JSON.stringify(data??{}).length>64_000)throw new Error("Reply data too large");
    const reply={from:{id:source.id,key:source.key,title:source.title},card:source.replyTo.card,summary:typeof summary==="string"?summary.trim().replace(/\s+/g," ").slice(0,300):"",data:data??{}};
    const outcome=await this.invoke(target,"reply",t=>[t.state,reply,{caller:{by:"user"},now:Date.now(),values:t.templateValues??{},thread}]) as ActionOutcome&{deliver?:ReplyDelivery};
    return {target,result:outcome.result,deliver:outcome.deliver};
  }
  async replyDelivered(target:Tab,deliver:ReplyDelivery,delivered:unknown,thread?:ActionContext["thread"]):Promise<void> {
    if(!this.binding(target)?.t.hooks?.includes("replyDelivered"))return;
    await this.invoke(target,"replyDelivered",t=>[t.state,deliver,delivered,{caller:{by:"user"},now:Date.now(),values:t.templateValues??{},thread}]);
  }
  async runHold(tab:Tab,thread:string):Promise<string|null> {
    const binding=this.binding(tab);if(!binding?.t.hooks?.includes("runHold"))return null;
    const result=await this.service.hook(binding.id,binding.t.key,"runHold",[tab.state,thread],{kind:"system",page:tab.id});
    return typeof result==="string"?result:null;
  }
  async runEvent(tab:Tab,event:RunEvent):Promise<void> {
    if(!this.binding(tab)?.t.hooks?.includes("runEvent"))return;
    await this.invoke(tab,"runEvent",t=>[t.state,event,Date.now()],undefined,false,true);
  }
  async invoke(tab: Tab, hook: string, args: (tab: Tab)=>unknown[], caller: ActionCaller = {by:"user"}, readOnly: boolean | string=false,system=false): Promise<unknown> {
    for(let attempt=0;attempt<3;attempt++) {
      const current=this.store.get(tab.id); if(!current) throw new Error("Page was removed");
      const binding=this.binding(current); if(!binding) throw new Error("Page has no plugin actions");
      if (!this.service.enabled(binding.id)) throw new Error("Plugin is disabled");
      if(checkPermission(this.store.pagePermissions(current.id),{perm:`plugin.${binding.id}`})!=="allow")throw new Error("This page needs permission to run its plugin actions");
      const revision=current.stateRevision, templateId=current.templateId;
      const raw=await this.service.hook(binding.id,binding.t.key,hook,args(current),{kind:system?"system":caller.by==="agent"?"agent":"page",page:tab.id,thread:caller.thread});
      const latest=this.store.get(tab.id);
      if(!latest || latest.templateId!==templateId || !this.service.enabled(binding.id)) throw new Error("Plugin or page changed during the call");
      if(checkPermission(this.store.pagePermissions(latest.id),{perm:`plugin.${binding.id}`})!=="allow")throw new Error("Plugin permission was revoked during the call");
      if(latest.stateRevision!==revision) continue;
      if(raw===null) return null;
      const outcome=outcomeSchema.parse(raw);
      if(readOnly && (outcome.ops.length || outcome.events?.length || outcome.launch || outcome.deliver)) throw new Error(typeof readOnly==="string"?readOnly:"This action changes the page; Read-only chats cannot run it");
      const write=this.store.writeState(tab.id,{ops:outcome.ops,expectedRevision:revision,byUser:!system&&caller.by==="user"});
      if(!write.ok) continue;
      for(const event of outcome.events ?? []) this.store.logEvent(tab.id,{...event,by:system?"scribe":caller.by});
      return outcome;
    }
    throw new Error("Page changed during the plugin call three times; try again");
  }
  async action(tab:Tab,name:string,args:Record<string,unknown>,caller:ActionCaller,thread?:ActionContext["thread"],readOnly: boolean | string=false) {
    const binding=this.binding(tab); if(!binding?.t.actions || !Object.hasOwn(binding.t.actions,name)) throw new Error(`Unknown plugin action: ${name}`);
    const outcome=await this.invoke(tab,`action:${name}`,current=>[current.state,args,{caller,now:Date.now(),values:current.templateValues??{},thread}],caller,readOnly) as ActionOutcome;
    return {result:outcome?.result,stateRevision:this.store.get(tab.id)!.stateRevision};
  }
  async sweep(ctx:SweepContext,drive:Omit<DriveContext,"page"|"mayStart">,launch:(id:string,item:PageLaunch,validate:()=>void|Promise<void>)=>Promise<string>):Promise<void> {
    for(const id of this.store.pageIds()) {
      const tab=this.store.get(id); if(!tab || this.busy.has(id)) continue;
      const binding=this.binding(tab); if(!binding || !this.service.enabled(binding.id)) continue;
      if(checkPermission(this.store.pagePermissions(id),{perm:`plugin.${binding.id}`})!=="allow")continue;
      this.busy.add(id);
      void (async()=> {
        if(binding.t.hooks?.includes("sweep")) await this.invoke(tab,"sweep",t=>[t.state,ctx],undefined,false,true);
        if(binding.t.hooks?.includes("drive")) for(let i=0;i<20;i++) {
          const outcome=await this.invoke(tab,"drive",t=>[t.state,{...drive,page:{id:t.id,title:t.title},mayStart:(settings:unknown)=>this.store.mayStartAgent(t.id,settings as PageLaunch["settings"])}],undefined,false,true) as (ActionOutcome&{launch?:PageLaunch})|null;
          if(!outcome) break;
          if(outcome.launch) {
            const item=outcome.launch;
            const result=await launch(id,item,async()=>{
              const current=this.store.get(id);
              if(!current||!this.service.enabled(binding.id)||this.store.mayStartAgent(id,item.settings))throw new Error("Plugin worker conditions changed");
              const revision=current.stateRevision;
              if(binding.t.hooks?.includes("launchAllowed") && await this.service.hook(binding.id,binding.t.key,"launchAllowed",[current.state,item,Date.now()],{kind:"system",page:id})===false)throw new Error("Plugin worker conditions changed");
              if(this.store.get(id)?.stateRevision!==revision||!this.service.enabled(binding.id)||this.store.mayStartAgent(id,item.settings)||checkPermission(this.store.pagePermissions(id),{perm:`plugin.${binding.id}`})!=="allow")throw new Error("Plugin worker conditions changed during validation");
            }).then(threadId=>({threadId}),error=>({error:String(error)}));
            if(binding.t.hooks?.includes("launched")) await this.invoke(tab,"launched",t=>[t.state,item,result,Date.now()],undefined,false,true);
          }
          if(!outcome.ops.length) break;
        }
      })().catch(error=>console.error(`Plugin actions failed on ${tab.key}:`,String(error))).finally(()=>this.busy.delete(id));
    }
  }
}
