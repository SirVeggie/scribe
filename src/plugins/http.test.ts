import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { zip } from "./package.js";
import { launchChromium } from "../chromium.js";
import { git } from "../agent/git.js";

test("plugin HTTP gates, transfer and shell settings work on an isolated daemon",{timeout:90_000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"scribe-plugin-http-"));
  const probe=net.createServer();await new Promise<void>(resolve=>probe.listen(0,"127.0.0.1",resolve));const port=(probe.address() as net.AddressInfo).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const child=spawn(process.execPath,["--import","tsx",path.resolve("src/index.ts"),"--daemon"],{env:{...process.env,SCRIBE_HOME:root,SCRIBE_PORT:String(port),SCRIBE_FAKE_AGENTS:"1"},windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let output="";child.stdout.on("data",data=>{output+=String(data);});child.stderr.on("data",data=>{output+=String(data);});
  const exited=new Promise(resolve=>child.once("exit",resolve));
  const url=`http://127.0.0.1:${port}`;let browser:Awaited<ReturnType<typeof launchChromium>>|undefined;
  const userHeaders=()=>({"x-scribe-local-token":fs.readFileSync(path.join(root,"local-token"),"utf8").trim()});
  async function call(route:string,method="GET",body?:unknown,headers:Record<string,string>=userHeaders()){
    const response=await fetch(url+route,{method,headers:{...headers,...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};
  }
  try{
    for(let i=0;;i++){try{if(fs.existsSync(path.join(root,"local-token"))&&(await fetch(`${url}/api/health`)).ok)break;}catch{}if(i>250)throw new Error(output);await delay(100);}
    const manifest={id:"http-fixture",name:"HTTP fixture",version:"1.0.0",summary:"HTTP plugin test",backend:"backend.mjs",risky:false,methods:{read:{description:"Read",agent:"read"},change:{description:"Change",agent:"board"},danger:{description:"Ask",agent:"ask"}},settings:{token:{label:"Token",type:"secret"}}};
    const archive=zip({"plugin.json":Buffer.from(JSON.stringify(manifest)),"backend.mjs":Buffer.from('export default {methods:{read:()=>42,change:()=>true,danger:()=>true}}')}).toString("base64");
    const preview=await call("/api/plugins/preview","POST",{archive});assert.equal(preview.status,200,JSON.stringify(preview.data));
    assert.equal((await call("/api/plugins/install","POST",{archive,hash:preview.data.hash})).status,200);
    const repo=path.join(root,"repo"),sub=path.join(repo,"sub");fs.mkdirSync(sub,{recursive:true});await git(["init","--template="],repo);
    const resolved=await call(`/api/plugins/git-history/repositories/resolve?path=${encodeURIComponent(sub)}`);assert.equal(resolved.data.repository,path.normalize(repo));
    assert.equal((await call("/api/plugins/git-history/repositories","POST",{repository:sub})).status,400);
    assert.equal((await call("/api/plugins/git-history/repositories","POST",{repository:resolved.data.repository})).status,200);
    const made=await call("/api/tabs","POST",{title:"Plugin fixture",html:"<p>Fixture</p>",plugins:[manifest.id],activate:false});const id=made.data.tab.id;
    assert.deepEqual(made.data.tab.plugins,[manifest.id]);
    let pageCall=await call(`/api/tabs/${id}/plugins/${manifest.id}/call`,"POST",{method:"read"});assert.equal(pageCall.data.error,"permission");
    await call(`/api/tabs/${id}/permissions`,"PUT",{perm:`plugin.${manifest.id}`,value:"allow"});
    pageCall=await call(`/api/tabs/${id}/plugins/${manifest.id}/call`,"POST",{method:"read"});assert.equal(pageCall.data.result,42);
    const thread=await call("/api/agent/threads","POST",{provider:"claude",model:"default",approval:"readonly",scope:{kind:"page",ref:id},remember:false});assert.equal(thread.status,200,JSON.stringify(thread.data));
    const tid=thread.data.thread.id,secret=Buffer.from(fs.readFileSync(path.join(root,"agent-secret"),"utf8").trim(),"hex");
    const agentHeaders={"x-scribe-client":"agent","x-scribe-thread":tid,"x-scribe-token":createHmac("sha256",secret).update(`thread:${tid}`).digest("hex")};
    assert.equal((await call(`/api/plugins/${manifest.id}/call`,"POST",{method:"read"},agentHeaders)).data.result,42);
    assert.equal((await call(`/api/plugins/${manifest.id}/call`,"POST",{method:"change"},agentHeaders)).status,400);
    assert.equal((await call(`/api/plugins/${manifest.id}/files`,"PUT",{path:"oops",content:"bad"},agentHeaders)).status,400);
    assert.equal((await call(`/api/tabs/${id}/permissions`,"PUT",{perm:`plugin.${manifest.id}`,value:"allow"},agentHeaders)).status,403);
    const exported=await fetch(`${url}/api/export/${id}`,{headers:userHeaders()});assert.equal(exported.headers.get("content-type"),"application/zip");
    const bytes=Buffer.from(await exported.arrayBuffer());const imported=await fetch(`${url}/api/import?preview=1`,{method:"POST",headers:{...userHeaders(),"Content-Type":"application/octet-stream"},body:bytes});const importPreview=await imported.json();assert.equal(importPreview.plugins[0].manifest.id,manifest.id);
    browser=await launchChromium({headless:true,args:[],purpose:"Plugin settings integration"});
    const page=await browser.newPage();const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    await page.goto(url);await page.waitForFunction(()=>!!(window as any).scribeApp);
    await page.click("#settings-toggle");await page.getByRole("button",{name:"Plugins",exact:true}).click();
    await page.locator(`details[data-plugin="${manifest.id}"] > summary`).click();
    assert.equal(await page.getByLabel("HTTP fixture · Token").count(),1);
    await page.getByLabel("HTTP fixture · Token").fill("unsaved-secret");await page.evaluate(()=>void (window as any).scribePluginSettings.refresh());assert.equal(await page.getByLabel("HTTP fixture · Token").inputValue(),"unsaved-secret");
    await page.getByRole("button",{name:"Cancel changes",exact:true}).click();
    await page.evaluate(()=>{(window as any).exportChoice=(window as any).scribePluginSettings.exportChoices([{id:"http-fixture",name:"HTTP fixture",version:"1.0.0"}]);});
    await page.locator("dialog[open] .select-button").click();await page.getByRole("option",{name:"Settings",exact:true}).click();await page.keyboard.press("Escape");await page.getByRole("button",{name:"Export",exact:true}).click();
    assert.equal((await page.evaluate(()=>(window as any).exportChoice))["http-fixture"].settings,true);
    const other=await call("/api/tabs","POST",{title:"Other",html:"<p>Other</p>",activate:false});
    const content=await browser.newPage();await content.goto(`http://t-${id.slice(2)}.localhost:${port}/view/${id}`);
    const blocked=await content.evaluate(async({other,plugin})=>(await fetch(`/api/tabs/${other}/plugins/${plugin}/call`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({method:"read"})})).status,{other:other.data.tab.id,plugin:manifest.id});
    assert.equal(blocked,404);
    // Exercise the migrated page against the real bridge and bundled backend.
    assert.equal((await git(["-c","user.name=Fixture","-c","user.email=fixture@local","-c","commit.gpgsign=false","commit","--allow-empty","-m","Activity"],repo)).code,0);
    const example=fs.readFileSync(path.resolve("docs/examples/commit-activity.html"),"utf8");
    const activityHtml=example.replace('"S:\\\\Library\\\\Projects\\\\agent-board"',JSON.stringify(fs.realpathSync(repo)));
    assert.notEqual(activityHtml,example);
    const activityTab=await call("/api/tabs","POST",{title:"Activity test",html:activityHtml,activate:false});const activityId=activityTab.data.tab.id;
    await page.evaluate(async(id)=>{(window as any).scribeApp.closeSettings();await (window as any).scribeApp.openLink(id,null,{mode:"tab"});},activityId);
    const activityFrame=await page.waitForSelector(`iframe[src*="/view/${activityId}"]`);
    const activityPage=(await activityFrame!.contentFrame())!;assert.ok(activityPage);
    await activityPage.waitForFunction(()=>document.querySelector("#refresh")?.textContent==="Allow and refresh");
    assert.equal(await activityPage.locator(".stat .v").first().textContent(),"917");
    assert.equal(await page.getByRole("button",{name:"Allow",exact:true}).count(),0);
    assert.equal((await call(`/api/tabs/${activityId}/permissions`,"PUT",{perm:"plugin.git-history",value:"allow"})).status,200);
    await activityPage.getByRole("button",{name:"Allow and refresh",exact:true}).click();
    await activityPage.waitForFunction(()=>!!(window as any).scribe.state.gitActivity);
    assert.equal(await activityPage.locator(".stat .v").first().textContent(),"1");
    await activityPage.locator('[data-days="7"]').click();
    await activityPage.getByRole("button",{name:"Refresh",exact:true}).click();
    await activityPage.waitForFunction(()=>!(document.querySelector("#refresh") as HTMLButtonElement).disabled);
    assert.equal(await activityPage.locator("#status").textContent(),"");
    assert.equal(await activityPage.locator(".stat .v").first().textContent(),"1");
    await activityPage.goto(activityPage.url());await activityPage.waitForFunction(()=>!!(window as any).scribe.state.gitActivity);
    assert.equal(await activityPage.locator(".stat .v").first().textContent(),"1");
    // A repository with no commits in the chosen period still renders zero totals.
    await activityPage.evaluate(async()=>{const s=(window as any).scribe;s.set({gitActivity:{...s.state.gitActivity,days:{}}});await s.flush();});
    await activityPage.goto(activityPage.url());await activityPage.waitForFunction(()=>document.querySelector(".stat .v")?.textContent==="0");
    assert.deepEqual(errors,[]);
  }finally{
    await browser?.close();
    try{await call("/api/shutdown","POST",{});}catch{}
    child.kill();await exited;
    fs.rmSync(root,{recursive:true,force:true,maxRetries:15,retryDelay:100});
  }
});
