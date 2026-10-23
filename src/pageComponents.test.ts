import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { get } from "node:http";
import { PageComponents, PAGE_COMPONENT_LIMIT, GLOBAL_COMPONENT_LIMIT, COMPONENT_LEASE_MS } from "./pageComponents.js";
import { PluginService } from "./plugins/service.js";
import { componentSite } from "./components.js";
import { BOARD_BRIDGE_JS } from "./bridge.js";
import { PageProblems, PAGE_PROBLEM_JS } from "./pageProblems.js";
import { contentOriginGate, framePageId } from "./contentOrigin.js";
import { pageComponentHost, pageComponentFromHost, componentItemFromHost, PORT } from "./config.js";
import { declaredPlugins } from "./plugins/manifest.js";
import { launchChromium } from "./chromium.js";

const manifest = { id: "page-fixture", name: "Page fixture", version: "1.0.0", summary: "Tests", backend: "backend.mjs", risky: false,
  methods: { update: { description: "Update", agent: "board" }, hidden: { description: "Hidden", agent: "read" } },
  components: { counter: { description: "Counter", html: "counter.html", props: { type: "object", required: ["name"], properties: { name: { type: "string" } } }, methods: ["update"], state: ["count", "rows/*"], events: ["tick"], height: { min: 100, max: 240 } } } };
const html = `<p id="name"></p><p id="count"></p><button id="reply" data-reply="Choose" data-context='{"choice":1}'>Choose</button><script>
document.getElementById('name').textContent=scribe.props.name;
window.seen=[]; window.ticks=[];
scribe.plugin.state.on('count',(value,revision)=>{seen.push({value,revision});document.getElementById('count').textContent=String(value)});
scribe.plugin.on('tick',data=>ticks.push(data));
window.initialLocal=scribe.local;
if(scribe.props.name==='Broken') throw new Error('component exploded');
</script>`;

async function fixture(now = Date.now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-page-components-"));
  const plugins = new PluginService(dir);
  const files = { "plugin.json": Buffer.from(JSON.stringify(manifest)), "counter.html": Buffer.from(html), "backend.mjs": Buffer.from(`export default {methods:{hidden:()=>42,update:async(args,ctx)=>{await ctx.state.set('count',args.value);await ctx.emit('tick',args.value);return args.value;}}}`) };
  await plugins.install(files, plugins.preview(files).hash);
  let permission = "allow", revision = 1;
  const store = { get: ((id: string) => /^t_[a-z0-9]{8}$/.test(id) ? { id, revision } : undefined) as any, pagePermissions: (() => new Map([[`plugin.${manifest.id}`, { value: permission }]])) as any };
  const mounts = new PageComponents(store, plugins, now);
  return { plugins, mounts, files, setPermission(value: string) { permission = value; }, nextRevision() { revision++; }, async close() { await plugins.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}

test("page mounts validate props, identity, declarations, permissions, versions and limits", async () => {
  const f = await fixture();
  try {
    const spec = { plugin: manifest.id, component: "counter", props: { name: "Hello" } };
    assert.throws(() => f.mounts.resolve("t_aaaaaaaa", { ...spec, props: { name: 1 } }), /props/i);
    const mount = f.mounts.resolve("t_aaaaaaaa", spec);
    assert.equal(pageComponentFromHost(pageComponentHost(mount.id)), mount.id);
    assert.equal(componentItemFromHost(pageComponentHost(mount.id)), undefined);
    assert.deepEqual(declaredPlugins(`<scribe-component plugin="page-fixture" name="counter"></scribe-component>`), [manifest.id]);
    assert.throws(() => f.mounts.current("t_bbbbbbbb", mount.id), /expired/);
    assert.equal(await f.mounts.action("t_aaaaaaaa", mount.id, { op: "call", method: "update", args: { value: 2 } }), 2);
    assert.equal((await f.mounts.action("t_aaaaaaaa", mount.id, { op: "state", key: "count" }) as any).value, 2);
    await assert.rejects(f.mounts.action("t_aaaaaaaa", mount.id, { op: "call", method: "hidden" }), /declared/);
    await assert.rejects(f.mounts.action("t_aaaaaaaa", mount.id, { op: "state", key: "private" }), /declared/);
    await assert.rejects(f.mounts.action("t_aaaaaaaa", mount.id, { op: "subscribe", event: "private" }), /declared/);
    await assert.rejects(f.mounts.action("t_aaaaaaaa", mount.id, { op: "open", link: "file:///secret" }), /open/);
    f.setPermission("ask");
    assert.ok(f.mounts.current("t_aaaaaaaa", mount.id, false));
    await assert.rejects(f.mounts.action("t_aaaaaaaa", mount.id, { op: "state", key: "count" }), /permission/);
    f.setPermission("deny");
    assert.throws(() => f.mounts.resolve("t_aaaaaaaa", spec), /denies/);
    assert.throws(() => f.mounts.current("t_aaaaaaaa", mount.id, false), /denies/);
    f.setPermission("allow");
    const changed = { ...f.files, "counter.html": Buffer.from(html + "<p>new</p>") };
    await f.plugins.install(changed, f.plugins.preview(changed).hash, true);
    assert.throws(() => f.mounts.current("t_aaaaaaaa", mount.id), /changed/);
    const fresh = f.mounts.resolve("t_aaaaaaaa", spec);
    for (let i = 0; i < 100; i++) await f.mounts.action("t_aaaaaaaa", fresh.id, { op: "state", key: "count" });
    await assert.rejects(f.mounts.action("t_aaaaaaaa", fresh.id, { op: "state", key: "count" }), /frequent/);
    f.nextRevision(); assert.throws(() => f.mounts.current("t_aaaaaaaa", fresh.id), /changed/);
    const released = f.mounts.resolve("t_aaaaaaaa", spec); f.mounts.release("t_aaaaaaaa", released.id);
    assert.throws(() => f.mounts.current("t_aaaaaaaa", released.id), /expired/);
  } finally { await f.close(); }
});

test("page component leases protect active viewers and reclaim only abandoned mounts", async () => {
  let now = 1000;
  const f = await fixture(() => now);
  const spec = { plugin: manifest.id, component: "counter", props: { name: "Hello" } };
  try {
    for (let i = 0; i < 100; i++) f.mounts.validate("t_aaaaaaaa", spec);
    const first = f.mounts.resolve("t_aaaaaaaa", spec);
    for (let i = 1; i < PAGE_COMPONENT_LIMIT; i++) f.mounts.resolve("t_aaaaaaaa", spec);
    assert.throws(() => f.mounts.resolve("t_aaaaaaaa", spec), /64 active instances/);
    assert.ok(f.mounts.validate("t_aaaaaaaa", spec), "schema checks do not consume active capacity");
    assert.match(f.mounts.renewAll("t_bbbbbbbb", [first.id]).errors[first.id], /expired/);
    assert.throws(() => f.mounts.renewAll("t_aaaaaaaa", Array(65).fill(first.id)), /Invalid/);
    assert.ok(f.mounts.current("t_aaaaaaaa", first.id), "a full page never evicts an active mount");
    now += COMPONENT_LEASE_MS - 1;
    assert.deepEqual(f.mounts.renewAll("t_aaaaaaaa", [first.id]).errors, {});
    now += 2;
    const next = f.mounts.resolve("t_aaaaaaaa", spec);
    assert.ok(f.mounts.current("t_aaaaaaaa", first.id));
    assert.ok(f.mounts.current("t_aaaaaaaa", next.id));
    for (let i = 2; i < GLOBAL_COMPONENT_LIMIT; i++) f.mounts.resolve(`t_${String(Math.floor(i / 60)).padStart(8, "0")}`, spec);
    assert.throws(() => f.mounts.resolve("t_99999999", spec), /500 active page instances/);
    assert.ok(f.mounts.current("t_aaaaaaaa", first.id));
    f.mounts.release("t_aaaaaaaa", next.id);
    assert.ok(f.mounts.resolve("t_99999999", spec));
    now += COMPONENT_LEASE_MS;
    f.mounts.resolve("t_88888888", spec);
    assert.throws(() => f.mounts.renew("t_aaaaaaaa", first.id), /expired/);
    assert.ok(f.mounts.resolve("t_aaaaaaaa", spec), "expired leases free capacity globally");
    f.nextRevision();
    assert.ok(f.mounts.resolve("t_aaaaaaaa", spec));
  } finally { await f.close(); }
});

test("capture mounts have a separate page limit and cannot consume viewer slots", async () => {
  const f = await fixture();
  const spec = { plugin: manifest.id, component: "counter", props: { name: "Hello" } };
  try {
    for (let i = 0; i < PAGE_COMPONENT_LIMIT; i++) f.mounts.resolve("t_aaaaaaaa", { ...spec, capture: true });
    assert.throws(() => f.mounts.resolve("t_aaaaaaaa", { ...spec, capture: true }), /64 active instances.*captures/);
    const viewer = f.mounts.resolve("t_aaaaaaaa", spec);
    assert.ok(f.mounts.current("t_aaaaaaaa", viewer.id));
  } finally { await f.close(); }
});

test("page component browser: isolation, state/events, replies, local state, diagnostics and cleanup", async () => {
  let now = Date.now();
  const f = await fixture(() => now), app = express();
  let port = 0;
  let problems: any;
  const reporting = new PageProblems();
  const signals: any[] = [];
  // Production uses PORT; adapt the CSP and returned URLs to this fixture's ephemeral port.
  app.use((req, res, next) => { const set = res.setHeader.bind(res); res.setHeader = ((key: string, value: any) => set(key, key.toLowerCase() === "content-security-policy" ? String(value).replaceAll(`:${PORT}`, `:${port}`) : value)) as any; next(); });
  app.use(contentOriginGate);
  app.use((req, _res, next) => { if (req.path.startsWith("/component/")) setTimeout(next, 650); else next(); });
  app.use(componentSite(() => undefined, path.resolve("public"), f.mounts));
  app.use(express.json());
  app.get("/", (_req, res) => res.type("html").send(`<iframe id="page" style="width:900px;height:800px" src="http://t-aaaaaaaa.localhost:${port}/view/t_aaaaaaaa"></iframe><script>
window.shellReplies=[];window.noTarget=false;
addEventListener('message',e=>{if(e.data?.type==='scribe-reply'){shellReplies.push(e.data);e.source.postMessage({type:'scribe-open-result',id:e.data.id,reqId:e.data.reqId,result:window.noTarget?{ok:false,error:'no reply target'}:{ok:true,target:{key:'scribe:target'}}},e.origin)}});
</script>`));
  app.get("/view/:id", (_req, res) => { const diagnostic = reporting.boot("t_aaaaaaaa", 1); res.type("html").send(`<!doctype html><head><script>window.__SCRIBE_BOOT__={id:'t_aaaaaaaa',state:{},local:{'component:live':{saved:7}}};window.__SCRIBE_PROBLEMS__={...${JSON.stringify(diagnostic)},id:'t_aaaaaaaa',tones:['error'],insertLine:0,insertedLines:0};${PAGE_PROBLEM_JS}\n${BOARD_BRIDGE_JS}</script></head><body>
<scribe-component id="live" plugin="page-fixture" name="counter" props='{"name":"Hello"}'><p>Fallback</p></scribe-component>
<scribe-component id="bad" plugin="page-fixture" name="counter" props='{"name":1}'></scribe-component>
<scribe-component id="broken" plugin="page-fixture" name="counter" props='{"name":"Broken"}'></scribe-component>
<div style="height:5000px"></div>
<scribe-component id="offscreen" plugin="page-fixture" name="counter" props='{"name":"Far away"}'></scribe-component>
<scribe-component id="offscreen-bad" plugin="page-fixture" name="counter" props='{}'></scribe-component>
<script>window.replies=[];window.captureReply=e=>{e.preventDefault();replies.push(e.detail)};document.getElementById('live').addEventListener('scribe-component-reply',captureReply);</script></body>`); });
  app.get("/api/tabs/:id/plugins", (_req, res) => res.json({ plugins: [] }));
  app.post("/api/tabs/:id/problems", (req, res) => { if (req.body.phase === "done") problems = req.body; reporting.report(req.params.id, req.body); res.json({ ok: true }); });
  app.post("/api/tabs/:id/events", (req, res) => { signals.push(req.body); res.json({ ok: true }); });
  app.post("/api/tabs/:id/components", (req, res) => { try { assert.equal(framePageId(req), req.params.id); const mount = f.mounts.resolve(req.params.id, req.body); res.json({ ok: true, ...mount, url: mount.url.replace(`:${PORT}`, `:${port}`) }); } catch (e) { res.json({ ok: false, error: (e as Error).message }); } });
  app.post("/api/tabs/:id/components/validate", (req, res) => { try { res.json({ ok: true, ...f.mounts.validate(req.params.id, req.body) }); } catch (e) { res.json({ ok: false, error: (e as Error).message }); } });
  app.post("/api/tabs/:id/components/leases", (req, res) => { try { res.json(f.mounts.renewAll(req.params.id, req.body.ids)); } catch (e) { res.json({ ok: false, error: (e as Error).message }); } });
  app.post("/api/tabs/:id/components/:component/plugin", async (req, res) => { try { res.json({ ok: true, result: await f.mounts.action(req.params.id, req.params.component, req.body) }); } catch (e) { res.json({ ok: false, error: (e as Error).message }); } });
  app.get("/api/tabs/:id/components/:component/events", (req, res) => { try { f.mounts.events(req.params.id, req.params.component, res); } catch (e) { res.status(403).json({ error: (e as Error).message }); } });
  app.delete("/api/tabs/:id/components/:component", (req, res) => { f.mounts.release(req.params.id, req.params.component); res.json({ ok: true }); });
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); port = (server.address() as any).port;
  const browser = await launchChromium({ headless: true, args: [], purpose: "Page components test" });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(7000);
    await page.addInitScript(() => {
      const interval = window.setInterval;
      window.setInterval = ((fn: TimerHandler, delay?: number, ...args: any[]) => interval(fn, delay === 20000 ? 100 : delay, ...args)) as typeof window.setInterval;
    });
    const collected = reporting.collect("t_aaaaaaaa", 1, async () => {});
    await page.goto(`http://localhost:${port}/`);
    const hostPage = () => page.frames().find(frame => frame.url().includes("/view/"))!;
    const hostLocator = page.frameLocator("#page");
    const widget = hostLocator.frameLocator("#live iframe");
    await widget.locator("#name").waitFor(); assert.equal(await widget.locator("#name").textContent(), "Hello");
    const child = async () => (await hostPage().locator("#live iframe").elementHandle())!.contentFrame();
    assert.deepEqual(await (await child())!.evaluate(() => (window as any).initialLocal), { saved: 7 });
    await (await child())!.waitForFunction(() => (window as any).seen.length > 0);
    assert.equal(await (await child())!.evaluate(async () => { try { await fetch('/api/tabs/t_aaaaaaaa/state'); return false; } catch { return true; } }), true);
    assert.equal(await (await child())!.evaluate(() => { try { return Boolean((parent as any).scribe); } catch { return false; } }), false);
    const componentOrigin = new URL((await child())!.url()).host;
    const status = await new Promise(resolve => get({ hostname: "127.0.0.1", port, path: "/api/tabs/t_aaaaaaaa/state", headers: { host: componentOrigin } }, response => { response.resume(); resolve(response.statusCode); })); assert.equal(status, 403);
    await assert.rejects((await child())!.evaluate(() => (window as any).scribe.plugin.call("hidden")), /declared/);
    await (await child())!.evaluate(() => (window as any).scribe.plugin.call("update", { value: 4 }));
    await (await child())!.waitForFunction(() => (window as any).seen.some((v: any) => v.value === 4) && (window as any).ticks.includes(4));
    await (await child())!.evaluate(() => (window as any).scribe.reply({ choice: 9 }, { summary: "Forged" }).catch(() => {}));
    assert.deepEqual(await hostPage().evaluate(() => (window as any).replies), []);
    await widget.locator("#reply").click();
    await hostPage().waitForFunction(() => (window as any).replies.length === 1);
    assert.equal((await hostPage().evaluate(() => (window as any).replies[0])).summary, "Choose");
    await hostLocator.locator("#bad [role=alert]").waitFor();
    const deadline = Date.now() + 3000; while (!problems && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(problems?.problems.some((p: any) => p.code === "component_error" && /props/i.test(p.message)), JSON.stringify(problems));
    assert.ok(problems?.problems.some((p: any) => p.code === "uncaught_error" && /page-fixture\/counter:.*component exploded/.test(p.message)), JSON.stringify(problems));
    assert.ok((await collected).some(p => p.code === "uncaught_error" && /component exploded/.test(p.message)), "slow nested reports survive the actual server collection window");
    assert.equal(await hostLocator.locator("#offscreen iframe").count(), 0);
    await hostLocator.locator("#offscreen-bad [role=alert]").waitFor({ state: "attached" });
    assert.ok(problems?.problems.some((p: any) => p.code === "component_error" && /required/.test(p.message)), "offscreen schema failures participate in diagnostics");
    await (await child())!.evaluate(() => (window as any).scribe.setLocal({ saved: 9 }));
    const oldMount = new URL((await child())!.url()).pathname.split("/").pop()!;
    const oldHeight = await hostLocator.locator("#live").evaluate(el => el.getBoundingClientRect().height);
    await hostPage().evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await hostLocator.locator("#offscreen").scrollIntoViewIfNeeded();
    await hostLocator.frameLocator("#offscreen iframe").locator("#name").waitFor();
    await hostPage().waitForFunction(() => !document.querySelector("#live iframe"));
    assert.throws(() => f.mounts.current("t_aaaaaaaa", oldMount), /expired/);
    assert.equal(await hostLocator.locator("#live").evaluate(el => el.getBoundingClientRect().height), oldHeight);
    await hostLocator.locator("#live").scrollIntoViewIfNeeded();
    await widget.locator("#name").waitFor();
    assert.deepEqual(await (await child())!.evaluate(() => (window as any).initialLocal), { saved: 9 });
    const beforeExpiry = new URL((await child())!.url()).pathname.split("/").pop()!;
    now += COMPONENT_LEASE_MS;
    const reclaim = f.mounts.resolve("t_bbbbbbbb", { plugin: manifest.id, component: "counter", props: { name: "Reclaim" } });
    f.mounts.release("t_bbbbbbbb", reclaim.id);
    await hostPage().waitForFunction(old => {
      const frame = document.querySelector<HTMLIFrameElement>("#live iframe");
      return Boolean(frame && !frame.src.includes(old));
    }, beforeExpiry);
    await widget.locator("#name").waitFor();
    assert.deepEqual(await (await child())!.evaluate(() => (window as any).initialLocal), { saved: 9 }, "a reclaimed lease silently remounts with local state");
    const beforeRegistry = new URL((await child())!.url()).pathname.split("/").pop()!;
    (f.plugins as any).event(manifest.id, "registry", {}, true);
    await hostPage().waitForFunction(old => {
      const frame = document.querySelector<HTMLIFrameElement>("#live iframe");
      return Boolean(frame && !frame.src.includes(old));
    }, beforeRegistry);
    await widget.locator("#name").waitFor();
    await (await child())!.evaluate(() => (window as any).scribe.plugin.call("update", { value: 8 }));
    await (await child())!.waitForFunction(() => (window as any).seen.some((v: any) => v.value === 8) && (window as any).ticks.includes(8));
    await hostPage().evaluate(() => { const el = document.getElementById('live')!; el.removeEventListener('scribe-component-reply', (window as any).captureReply); el.setAttribute('props', JSON.stringify({name:'Again'})); });
    await widget.locator("#name").filter({ hasText: "Again" }).waitFor();
    assert.deepEqual(await (await child())!.evaluate(() => (window as any).initialLocal), { saved: 9 });
    await widget.locator("#reply").click();
    await page.waitForFunction(() => (window as any).shellReplies.length === 1);
    assert.equal((await page.evaluate(() => (window as any).shellReplies[0])).summary, "Choose");
    await page.evaluate(() => { (window as any).noTarget = true; });
    await hostPage().evaluate(() => document.getElementById('live')!.setAttribute('props', JSON.stringify({name:'Signal'})));
    await widget.locator("#name").filter({ hasText: "Signal" }).waitFor();
    await widget.locator("#reply").click();
    const signalDeadline = Date.now() + 1500; while (!signals.length && Date.now() < signalDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(signals.some(signal => signal.name === "submitted"), JSON.stringify(signals));
    f.setPermission("deny");
    await hostLocator.locator("#live [role=alert]").waitFor();
    assert.equal((f.plugins as any).listeners.size, 0);
    f.setPermission("allow"); problems = undefined;
    const context = await browser.newContext();
    await context.addInitScript(() => { (window as any).__SCRIBE_CAPTURE__ = true; });
    const capture = await context.newPage();
    const captureCollected = reporting.collect("t_aaaaaaaa", 1, async () => {});
    await capture.goto(`http://t-aaaaaaaa.localhost:${port}/view/t_aaaaaaaa`);
    const captureDeadline = Date.now() + 3500; while (!problems && Date.now() < captureDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(problems?.problems.some((p: any) => p.code === "uncaught_error" && /component exploded/.test(p.message)), JSON.stringify(problems));
    assert.ok(!problems?.problems.some((p: any) => /capture/.test(p.message)), JSON.stringify(problems));
    assert.ok((await captureCollected).some(p => /component exploded/.test(p.message)));
    await capture.frameLocator("#offscreen iframe").locator("#name").waitFor({ state: "attached" });
    await context.close();
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});
