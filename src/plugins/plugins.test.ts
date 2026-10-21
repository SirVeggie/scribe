import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseManifest, declaredPlugins } from "./manifest.js";
import { zip, unzip, packagePath, packageHash } from "./package.js";
import { PluginService } from "./service.js";
import { BoardStore } from "../store.js";
import { PluginActions } from "./actions.js";

const manifest = { id:"fixture",name:"Fixture",version:"1.0.0",summary:"Test plugin",backend:"index.mjs",risky:false,methods:{echo:{description:"Echo",agent:"read"}} };
test("manifest validates paths and method levels; declarations never grant access",()=> {
  assert.throws(()=>parseManifest({...manifest,backend:"../escape.mjs"}));
  assert.throws(()=>parseManifest({...manifest,methods:{echo:{description:"Echo",agent:"full"}}}));
  assert.deepEqual(declaredPlugins('<meta content="fixture,other" name="scribe-plugins"><meta name="scribe-plugins" content="fixture">'),["fixture","other"]);
  for(const name of ["../evil","C:/evil","a/../../evil","a\\evil"]) assert.throws(()=>packagePath(os.tmpdir(),name));
});
test("package zip roundtrip preserves binary and UTF-8 names",async()=> {
  const files={"plugin.json":Buffer.from(JSON.stringify(manifest)),"src/ä.txt":Buffer.from([0,1,255])};
  const result=await unzip(zip(files)); assert.deepEqual(Object.keys(result),Object.keys(files)); assert.equal(packageHash(result),packageHash(files));
});
test("installed snapshots remain stable after source edits; backend persists keyed state",async()=> {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"scribe-plugin-")); const events:unknown[]=[];
  const service=new PluginService(root,(...args)=>events.push(args));
  try {
    const files={"plugin.json":Buffer.from(JSON.stringify(manifest)),"index.mjs":Buffer.from('export default {methods:{echo:async(args,ctx)=>{await ctx.state.set("last",args); return (await ctx.state.get("last")).value}}}')};
    const {hash}=service.preview(files); assert.throws(()=>service.install(files,"wrong")); service.install(files,hash);
    assert.deepEqual(await service.call("fixture","echo",{hello:"world"},{kind:"agent"}),{hello:"world"});
    assert.equal(service.database.get("fixture","last").revision,1); assert.equal(events.length,2);
    service.patch("fixture","index.mjs","export default {methods:{echo:()=> 'changed'}}");
    assert.deepEqual(await service.call("fixture","echo",{still:"old"},{kind:"page",page:"t_test"}),{still:"old"});
    service.enable("fixture",false); await assert.rejects(()=>service.call("fixture","echo",{},{kind:"agent"}),/disabled/);
  } finally { service.close(); await new Promise(r=>setTimeout(r,100)); fs.rmSync(root,{recursive:true,force:true}); }
});

test("plugin actions retry concurrent edits without applying stale ops or duplicate events",async()=> {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"scribe-plugin-actions-"));
  const previousHome=process.env.SCRIBE_HOME;process.env.SCRIBE_HOME=root;
  const service=new PluginService(path.join(root,"plugins")),store=new BoardStore();
  try {
    store.load();
    const m={...manifest,templates:[{key:"counter",metadata:"counter.json",html:"counter.html",actions:{increment:{description:"Increment",args:"{}"}},hooks:["reply","seed"]}]};
    const files={"plugin.json":Buffer.from(JSON.stringify(m)),"index.mjs":Buffer.from("export default {}"),"counter.json":Buffer.from("{}"),"counter.html":Buffer.from("<p>Counter</p>")};
    service.install(files,service.preview(files).hash);
    store.setPluginTemplates([{id:"builtin:plugin-fixture--counter",key:"plugin-fixture--counter",title:"Counter",description:"",html:"<p>Counter</p>",fields:[],initialState:{count:0},stateVersion:1,createdAt:1,updatedAt:1}]);
    const {tab}=store.openFromTemplate("builtin:plugin-fixture--counter",{});
    const actions=new PluginActions(service,store);let calls=0;
    service.hook=async(_id,_template,_hook,args)=> {
      const state=args[0] as {count:number};
      if(++calls===1)store.writeState(tab.id,{ops:[{op:"set",path:"count",value:10}]});
      await Promise.resolve();
      return {ops:[{op:"set",path:"count",value:state.count+1}],result:state.count+1,events:[{name:"incremented"}]};
    };
    const result=await actions.action(tab,"increment",{},{by:"user"});
    assert.equal(result.result,11);assert.equal(store.get(tab.id)!.state.count,11);assert.equal(calls,2);
    assert.equal(store.get(tab.id)!.events.filter(e=>e.name==="incremented").length,1);
    await assert.rejects(()=>actions.action(tab,"increment",{},{by:"agent"},undefined,true),/Read-only/);
    store.setPagePermission(tab.id,"plugin.fixture","deny");
    await assert.rejects(()=>actions.action(tab,"increment",{},{by:"user"}),/permission/);
  }finally{store.closeDb();service.close();if(previousHome===undefined)delete process.env.SCRIBE_HOME;else process.env.SCRIBE_HOME=previousHome;fs.rmSync(root,{recursive:true,force:true});}
});
