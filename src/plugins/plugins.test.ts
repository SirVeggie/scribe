import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseManifest, declaredPlugins, declarePlugins } from "./manifest.js";
import { zip, unzip, packagePath, packageHash } from "./package.js";
import { PluginService } from "./service.js";
import { BoardStore } from "../store.js";
import { PluginActions } from "./actions.js";
import { exportTransfer, importTransfer } from "./transfer.js";
import { buildExport } from "../boardExport.js";
import { readPackage } from "./package.js";
import { mainRepository } from "./git.js";
import { git } from "../agent/git.js";
import { pathToFileURL } from "node:url";

const manifest = { id:"fixture",name:"Fixture",version:"1.0.0",summary:"Test plugin",backend:"index.mjs",risky:false,methods:{echo:{description:"Echo",agent:"read"}} };
test("manifest validates paths and method levels; declarations never grant access",()=> {
  assert.throws(()=>parseManifest({...manifest,backend:"../escape.mjs"}));
  assert.throws(()=>parseManifest({...manifest,methods:{echo:{description:"Echo",agent:"full"}}}));
  assert.throws(()=>parseManifest({...manifest,id:"ambiguous--id"}));
  const full='<!DOCTYPE html><html><head><title>Example</title></head><body>Example</body></html>';
  const declared=declarePlugins(full,["fixture"]);assert.ok(declared.startsWith("<!DOCTYPE html>"));assert.match(declared,/<head>\s*<meta name="scribe-plugins"/);assert.equal((declared.match(/<!DOCTYPE/gi)??[]).length,1);
  assert.deepEqual(declaredPlugins(declarePlugins("<p>Fragment</p>",["fixture"])),["fixture"]);
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
    const {hash}=service.preview(files); await assert.rejects(()=>service.install(files,"wrong")); await service.install(files,hash);
    assert.deepEqual(await service.call("fixture","echo",{hello:"world"},{kind:"agent"}),{hello:"world"});
    assert.equal(service.database.get("fixture","last").revision,1); assert.equal(events.length,2);
    await service.patch("fixture","index.mjs","export default {methods:{echo:()=> 'changed'}}");
    assert.deepEqual(await service.call("fixture","echo",{still:"old"},{kind:"page",page:"t_test"}),{still:"old"});
    await service.enable("fixture",false); await assert.rejects(()=>service.call("fixture","echo",{},{kind:"agent"}),/disabled/);
  } finally { await service.close(); fs.rmSync(root,{recursive:true,force:true}); }
});

test("plugin actions retry concurrent edits without applying stale ops or duplicate events",async()=> {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"scribe-plugin-actions-"));
  const previousHome=process.env.SCRIBE_HOME;process.env.SCRIBE_HOME=root;
  const service=new PluginService(path.join(root,"plugins")),store=new BoardStore();
  try {
    store.load();
    const m={...manifest,templates:[{key:"counter",metadata:"counter.json",html:"counter.html",actions:{increment:{description:"Increment",args:"{}"}},hooks:["reply","seed"]}]};
    const files={"plugin.json":Buffer.from(JSON.stringify(m)),"index.mjs":Buffer.from("export default {}"),"counter.json":Buffer.from('{"title":"Counter"}'),"counter.html":Buffer.from("<p>Counter</p>")};
    await service.install(files,service.preview(files).hash);
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
  }finally{store.closeDb();await service.close();if(previousHome===undefined)delete process.env.SCRIBE_HOME;else process.env.SCRIBE_HOME=previousHome;fs.rmSync(root,{recursive:true,force:true});}
});

test("ZIP transfers preserve plugin code, selected state and settings, while defaults omit private data",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"scribe-plugin-transfer-")),service=new PluginService(root);
  try{
    const m={...manifest,settings:{folder:{label:"Folder",type:"string",default:"public"},token:{label:"Token",type:"secret"}}};
    const files={"plugin.json":Buffer.from(JSON.stringify(m)),"index.mjs":Buffer.from("export default {}"),"src/index.ts":Buffer.from("// editable source")};await service.install(files,service.preview(files).hash);
    await service.configure("fixture",{folder:"chosen"});service.database.set("fixture","cache",{items:[1]});
    const defaultPackage=await unzip(service.export("fixture"));assert.ok(defaultPackage["src/index.ts"]);assert.equal(defaultPackage["scribe/state.json"],undefined);assert.equal(defaultPackage["scribe/settings.json"],undefined);
    const withState=await unzip(service.export("fixture",{source:true,settings:true,state:true}));assert.deepEqual(JSON.parse(withState["scribe/state.json"].toString()),{cache:{items:[1]}});assert.deepEqual(JSON.parse(withState["scribe/settings.json"].toString()),{folder:"chosen"});
    const board=buildExport([]);board.pages.push({key:"scribe:fixture",title:"Fixture",html:'<meta name="scribe-plugins" content="fixture"><p>Fixture</p>',pinned:false,createdAt:1,updatedAt:1,state:{},assets:[]});
    const zipBytes=await exportTransfer(board,service);const imported=await importTransfer(zipBytes,"test.scribe.zip");assert.equal(imported.parsed?.kind,"export");assert.equal(imported.packages[0].id,"fixture");
    const excluded=await unzip(await exportTransfer(board,service,{fixture:{code:false}}));assert.equal(excluded["plugins/fixture.scribeplugin"],undefined);assert.deepEqual(JSON.parse(excluded["scribe.json"].toString()).pages[0].requires,[{id:"fixture",version:"1.0.0"}]);
    const legacy=await importTransfer(Buffer.from(JSON.stringify(board)),"old.json");assert.equal(legacy.parsed?.kind,"export");
    assert.throws(()=>service.validate({...files,".git/hooks/post-commit":Buffer.from("bad")}),/Reserved/);
  }finally{await service.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("DPAPI secrets stay outside settings and export payloads",{skip:process.platform!=="win32"},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"scribe-plugin-secret-")),service=new PluginService(root);
  try{
    const m={...manifest,settings:{token:{label:"Token",type:"secret"}}},files={"plugin.json":Buffer.from(JSON.stringify(m)),"index.mjs":Buffer.from('export default {methods:{echo:async(_args,ctx)=>({hasSecret:!!(await ctx.secret("token"))})}}')};
    await service.install(files,service.preview(files).hash);await service.configure("fixture",{token:"fixture-secret-123"});
    assert.equal(JSON.stringify(service.inspect("fixture")).includes("fixture-secret-123"),false);
    const archive=await unzip(service.export("fixture",{source:true,settings:true,state:true}));assert.equal(Object.values(archive).some(data=>data.includes("fixture-secret-123")),false);
    assert.deepEqual(await service.call("fixture","echo",{},{kind:"agent"}),{hasSecret:true});
  }finally{await service.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("Board authoring cannot bundle files outside the plugin source tree",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"scribe-plugin-build-")),service=new PluginService(path.join(root,"plugins"));
  try{
    const m={...manifest,source:"src/index.ts"};await service.create(m);
    const outside=path.join(root,"private.json");fs.writeFileSync(outside,'{"token":"do-not-bundle"}');
    await service.patch("fixture","src/index.ts",`import data from ${JSON.stringify(outside.split(path.sep).join("/"))};export default {methods:{echo:()=>data}};`);
    await assert.rejects(()=>service.reload("fixture"),/must be relative/);
    const relative=path.relative(path.join(service.draft("fixture"),"src"),outside).split(path.sep).join("/");
    await service.patch("fixture","src/index.ts",`import data from ${JSON.stringify(relative)};export default {methods:{echo:()=>data}};`);
    await assert.rejects(()=>service.reload("fixture"),/leaves its source folder/);
    assert.equal(String(service.read("fixture","index.mjs")).includes("do-not-bundle"),false);
    await service.patch("fixture","src/index.ts",'import fs from "node:fs";export default {methods:{echo:()=>!!fs}};');
    await service.reload("fixture");assert.match(String(service.read("fixture","index.mjs")),/node:fs/);
    const built=readPackage(service.draft("fixture"));await service.install(built,service.preview(built).hash);
    const compiledOnly=await unzip(service.export("fixture",{source:false}));assert.equal(JSON.parse(compiledOnly["plugin.json"].toString()).source,undefined);assert.equal(compiledOnly["src/index.ts"],undefined);service.validate(compiledOnly);
  }finally{await service.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("Git history folds worktrees into their main repository and ignores deleted paths",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"scribe-plugin-git-")),repo=path.join(root,"repo"),worktree=path.join(root,"worktree");fs.mkdirSync(repo);
  try{
    assert.equal((await git(["init","--template="],repo)).code,0);assert.equal((await git(["-c","user.name=Fixture","-c","user.email=fixture@local","-c","commit.gpgsign=false","commit","--allow-empty","-m","Initial"],repo)).code,0);assert.equal((await git(["worktree","add","--detach",worktree],repo)).code,0);
    assert.equal(await mainRepository(worktree),path.normalize(repo));
    const backend=await import(pathToFileURL(path.resolve("plugins/builtin/git-history/backend.mjs")).href);
    const result=backend.default.methods.repositories({}, {settings:{repositories:[repo,path.join(root,"deleted")]}});assert.deepEqual(result.repositories,[fs.realpathSync(repo)]);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("Git activity counts complete history beyond the log limit and refuses unapproved roots",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"scribe-plugin-activity-"));
  try{
    assert.equal((await git(["init","--template="],root)).code,0);
    let input="";
    for(let i=0;i<2001;i++)input+=`commit refs/heads/activity\ncommitter Fixture <fixture@local> ${946684800+i} +0200\ndata 7\nCommit!\n\n`;
    assert.equal((await git(["fast-import","--quiet"],root,{input})).code,0);
    assert.equal((await git(["symbolic-ref","HEAD","refs/heads/activity"],root)).code,0);
    const backend=await import(pathToFileURL(path.resolve("plugins/builtin/git-history/backend.mjs")).href);
    const ctx={settings:{repositories:[root]}};
    const result=await backend.default.methods.activity({repository:root},ctx);
    assert.equal(result.total,2001);assert.deepEqual(result.days,{"2000-01-01":2001});assert.equal(result.branch,"activity");assert.ok(result.queriedAt>Date.now()-30_000);
    await assert.rejects(()=>backend.default.methods.activity({repository:root},{settings:{repositories:[]}}),/not approved/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("backend asset saves are bound to the actual calling page",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"scribe-plugin-assets-"));let target="";
  const service=new PluginService(root,()=>{},(page)=>{target=page;return {id:"asset"};});
  try{
    const files={"plugin.json":Buffer.from(JSON.stringify(manifest)),"index.mjs":Buffer.from('export default {methods:{echo:async(_args,ctx)=>{ctx.caller.page="forged";return ctx.saveAsset("sample.txt","text/plain",Buffer.from("sample"))}}}')};
    await service.install(files,service.preview(files).hash);await service.call("fixture","echo",{},{kind:"page",page:"actual"});assert.equal(target,"actual");
  }finally{await service.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("failed backend initialization stops the process and records a crash",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"scribe-plugin-init-")),service=new PluginService(root);
  try{
    const files={"plugin.json":Buffer.from(JSON.stringify(manifest)),"index.mjs":Buffer.from('throw new Error("fixture init failure")')};await service.install(files,service.preview(files).hash);
    await assert.rejects(()=>service.call("fixture","echo",{},{kind:"agent"}),/fixture init failure/);assert.equal(service.list()[0].status,"idle");assert.match(service.logs("fixture").join("\n"),/Stopped/);
  }finally{await service.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("corrupt templates are refused before installation and quarantined after disk corruption",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"scribe-plugin-invalid-")),service=new PluginService(root);
  try{
    const m={...manifest,templates:[{key:"example",metadata:"page.json",html:"page.html"}]};
    const files={"plugin.json":Buffer.from(JSON.stringify(m)),"index.mjs":Buffer.from("export default {}"),"page.json":Buffer.from("bad JSON"),"page.html":Buffer.from("<p>Example</p>")};
    assert.throws(()=>service.preview(files));files["page.json"]=Buffer.from('{"title":"Example"}');
    const record=await service.install(files,service.preview(files).hash);fs.writeFileSync(path.join(root,"fixture","versions",record.hash,"page.json"),"corrupt");
    assert.deepEqual(service.templates(),[]);assert.match(service.logs("fixture").join("\n"),/unavailable/);
  }finally{await service.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("imports validate settings, require folder approval and replace stale SQLite sidecars",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"scribe-plugin-data-")),service=new PluginService(root);
  try{
    const m={...manifest,settings:{repositories:{label:"Repositories",type:"paths",default:[]}}},files:Record<string,Buffer>={"plugin.json":Buffer.from(JSON.stringify(m)),"index.mjs":Buffer.from("export default {}")};
    await service.install(files,service.preview(files).hash);
    files["scribe/settings.json"]=Buffer.from('{"repositories":42}');assert.throws(()=>service.preview(files),/Invalid value/);
    files["scribe/settings.json"]=Buffer.from(JSON.stringify({repositories:[root]}));await assert.rejects(()=>service.install(files,service.preview(files).hash,true),/explicit approval/);
    const data=path.join(root,"fixture","data");fs.mkdirSync(data,{recursive:true});fs.writeFileSync(path.join(data,"plugin.sqlite-wal"),"old");
    files["scribe/data/plugin.sqlite"]=Buffer.from("new database");
    await service.install(files,service.preview(files).hash,true,true);assert.equal(fs.existsSync(path.join(data,"plugin.sqlite-wal")),false);assert.equal(fs.readFileSync(path.join(data,"plugin.sqlite"),"utf8"),"new database");
  }finally{await service.close();fs.rmSync(root,{recursive:true,force:true});}
});
