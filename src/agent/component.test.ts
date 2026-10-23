import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { parseComponentInput, componentLink, MAX_COMPONENT_HTML, type ComponentItem } from "./componentTool.js";
import { componentHost, componentItemFromHost, previewThreadFromHost, pageIdFromHost } from "../config.js";
import { contentOriginGate } from "../contentOrigin.js";
import { componentDocument, COMPONENT_CSP } from "../components.js";
import { itemText } from "./threadAccess.js";
import { launchChromium } from "../chromium.js";
import { PluginService } from "../plugins/service.js";
import { setPlugins } from "../plugins/current.js";
import { parseManifest, componentStateAllowed } from "../plugins/manifest.js";
import express from "express";
import { agentRouter } from "./routes.js";
import { componentSite } from "../components.js";
import { shellOrigins } from "../config.js";
import { probeComponent } from "../screenshot.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-components-"));
process.env.SCRIBE_HOME = dir;
process.env.SCRIBE_FAKE_AGENTS = "1";
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
let host: InstanceType<typeof AgentHost>;
before(() => { store.load(); host = new AgentHost(() => {}); });
after(() => { host.dispose(); store.closeDb(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

function runningThread() {
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null } });
  const turn = { id: `tu_${thread.id}`, threadId: thread.id, seq: 1, status: "running", model: "m", effort: null, mode: thread.mode, startedAt: Date.now() };
  const internals = host as unknown as { runs: Map<string, unknown>; turns: Map<string, unknown[]> };
  internals.turns.get(thread.id)?.push(turn);
  internals.runs.set(thread.id, { turn, textItem: null, reasoningItem: null, tools: new Map(), hooks: { called: new Set(), gated: new Set(), approved: new Set(), waiting: new Map(), told: new Set() } });
  return thread.id;
}
function component(threadId: string): ComponentItem {
  const item = host.threadDetail(threadId)!.items.find(it => it.kind === "component");
  assert.ok(item?.kind === "component");
  return item;
}

test("input caps count UTF-8 bytes and enforce exclusive HTML or plugin inputs", () => {
  assert.throws(() => parseComponentInput({ html: "å".repeat(MAX_COMPONENT_HTML) }), /UTF-8/);
  assert.throws(() => parseComponentInput({ html: " " }), /empty/);
  assert.throws(() => parseComponentInput({ html: "ok", plugin: "test" }), /either/);
  assert.throws(() => parseComponentInput({ html: "ok", wait: "yes" }), /true or false/);
});

const pluginManifest = { id: "component-fixture", name: "Component fixture", version: "1.0.0", summary: "Component tests", backend: "backend.mjs", risky: false,
  methods: { update: { description: "Update", agent: "board" }, read: { description: "Read", agent: "read" }, ask: { description: "Ask", agent: "ask" } },
  components: { counter: { description: "Live counter", html: "counter.html", props: { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string" } } }, methods: ["update", "read", "ask"], state: ["count", "rows/*"], events: ["tick"], height: { min: 100, max: 220 } } } };
const pluginHtml = `<p id="name"></p><p id="count"></p><script>
  nameNode = document.getElementById('name'); nameNode.textContent = scribe.props.name;
  window.seen = []; window.ticks = [];
  scribe.plugin.state.on('count', (value, revision) => { window.seen.push({value, revision}); document.getElementById('count').textContent = String(value); });
  scribe.plugin.on('tick', data => window.ticks.push(data));
</script>`;
function pluginFiles(html = pluginHtml, manifest = pluginManifest) {
  return { "plugin.json": Buffer.from(JSON.stringify(manifest)), "counter.html": Buffer.from(html), "backend.mjs": Buffer.from(`export default { methods: { read: () => 42, ask: () => true, update: async (args,ctx) => { const result = await ctx.state.set('count', args.value); await ctx.emit('tick',args.value); return result; } } }`) };
}

test("plugin manifests reject bad schemas, paths and capabilities", () => {
  assert.equal(parseManifest(pluginManifest).components.counter.height.max, 220);
  for (const props of [{ type: "object", wat: true }, { type: "object", properties: { n: { type: "number", default: 1 } } }, { type: "array" }]) {
    assert.throws(() => parseManifest({ ...pluginManifest, components: { counter: { ...pluginManifest.components.counter, props } } }), /props/i);
  }
  assert.equal(componentStateAllowed(["rows/*"], "rows/a"), true);
  assert.equal(componentStateAllowed(["rows/*"], "rows-private/a"), false);
  assert.throws(() => parseManifest({ ...pluginManifest, components: { counter: { ...pluginManifest.components.counter, html: "../escape" } } }));
});

test("plugin items validate before insertion, preserve identity, gate calls and use current versions", async () => {
  const service = new PluginService(path.join(dir, "component-plugins")); setPlugins(service);
  try {
    const files = pluginFiles(); await service.install(files, service.preview(files).hash);
    const thread = runningThread(); host.updateThread(thread, { approval: "full" });
    await assert.rejects(host.showComponent(thread, { plugin: pluginManifest.id, component: "counter", props: { name: 2 } }), /props/);
    assert.equal(host.threadDetail(thread)!.items.filter(i => i.kind === "component").length, 0);
    const showing = host.showComponent(thread, { plugin: pluginManifest.id, component: "counter", props: { name: "Hello" }, fallback: "Saved counter" });
    const item = component(thread);
    // Settle the mounted-render path without launching a background browser in this server test.
    const boot = host.componentProblems.boot(item.id, 0)!;
    host.componentProblems.report(item.id, { token: boot.token, phase: "done", problems: [] }); await showing;
    assert.equal(item.html, undefined); assert.equal(item.plugin, pluginManifest.id);
    assert.match(itemText(item)!, /Saved counter/);
    assert.equal(await host.componentPluginAction(thread, item.id, { op: "call", method: "read" }), 42);
    await assert.rejects(host.componentPluginAction(thread, item.id, { op: "call", method: "other" }), /declared/);
    await assert.rejects(host.componentPluginAction(thread, item.id, { op: "state", key: "private" }), /declared/);
    await assert.rejects(host.componentPluginAction(thread, item.id, { op: "subscribe", event: "private" }), /declared/);
    host.updateThread(thread, { approval: "readonly" });
    await assert.rejects(host.componentPluginAction(thread, item.id, { op: "call", method: "update" }), /Board/);
    const home = store.upsert({ key: "component-home", title: "Component home", html: "<p>Home</p>", activate: false }).tab;
    host.updateThread(thread, { scope: { kind: "page", ref: home.id }, approval: "full" });
    store.setPagePermission(home.id, `plugin.${pluginManifest.id}`, "deny");
    await assert.rejects(host.componentPluginAction(thread, item.id, { op: "call", method: "read" }), /denies/);
    assert.equal(host.componentView(thread, item.id).available, false);
    store.setPagePermission(home.id, `plugin.${pluginManifest.id}`, "allow");
    const updated = pluginFiles("<p>Current version</p>", { ...pluginManifest, version: "1.1.0" });
    assert.deepEqual(service.preview(updated).changes?.components, []);
    await service.install(updated, service.preview(updated).hash, true);
    assert.match(host.componentPlugin(thread, item.id).html, /Current version/);
    const incompatible = pluginFiles("<p>New</p>", { ...pluginManifest, version: "1.2.0", components: { counter: { ...pluginManifest.components.counter, props: { ...pluginManifest.components.counter.props, required: ["missing"] } } } });
    await service.install(incompatible, service.preview(incompatible).hash, true);
    assert.equal(host.componentView(thread, item.id).available, false);
    await service.enable(pluginManifest.id, false);
    assert.equal(host.componentView(thread, item.id).available, false);
  } finally { setPlugins(null); await service.close(); }
});

test("component hosts cannot collide with page or worktree origins and expose no APIs", () => {
  const id = "it_012345abcdef";
  const hostname = componentHost(id);
  assert.equal(componentItemFromHost(hostname), id);
  assert.equal(pageIdFromHost(hostname), undefined);
  assert.equal(previewThreadFromHost(hostname), undefined);
  for (const route of ["/", "/api/agent/threads", "/api/tabs/x/state", "/kit.js", "/blob/x", "/view/x", "/component/it_aaaaaaaaaaaa"]) {
    let status = 0, allowed = false;
    const response = { status(code: number) { status = code; return this; }, type() { return this; }, send() {} };
    contentOriginGate({ hostname, path: route, method: "GET" } as any, response as any, () => { allowed = true; });
    assert.equal(status, 403, route); assert.equal(allowed, false);
  }
  assert.match(COMPONENT_CSP, /connect-src 'none'/);
  assert.match(COMPONENT_CSP, /sandbox allow-scripts;/);
});

test("component links cannot open files or loopback aliases", () => {
  for (const link of ["file:///C:/private.txt", "javascript:alert(1)", "http://localhost/", "http://127.1/", "http://0.0.0.0/", "http://[::ffff:7f00:1]/", "http://w-it-012345abcdef.localhost/"]) assert.throws(() => componentLink(link), /Components can open/);
  assert.equal(componentLink("scribe:agent-todo#card=777"), "scribe:agent-todo#card=777");
  assert.equal(componentLink("https://example.com/test"), "https://example.com/test");
});

test("question consumers can skip component waits and server caps write bursts", async () => {
  const thread = runningThread();
  const pending = host.showComponent(thread, { html: "<p>choice</p>", wait: true });
  const item = component(thread);
  host.resolveQuestion(item.id, { skipped: true });
  assert.deepEqual(await pending, { skipped: true });
  for (let i = 0; i < 10; i++) host.updateComponent(thread, item.id, { action: "summary", summary: String(i) });
  assert.throws(() => host.updateComponent(thread, item.id, { action: "summary", summary: "too many" }), /too frequent/);
});

test("wait returns structured clicks; local/summary persist without exposing HTML in history", async () => {
  const thread = runningThread();
  const pending = host.showComponent(thread, { html: "<p>secret raw markup</p>", fallback: "Fallback", wait: true });
  const item = component(thread);
  assert.equal(host.threadDetail(thread)?.thread.status, "waiting");
  host.updateComponent(thread, item.id, { action: "local", local: { tab: "two" } });
  host.updateComponent(thread, item.id, { action: "summary", summary: "Updated table" });
  assert.equal(component(thread).local?.tab, "two");
  assert.match(itemText(item)!, /Updated table/);
  assert.doesNotMatch(itemText(item)!, /raw markup/);
  host.updateComponent(thread, item.id, { action: "reply", summary: "Blue", data: { color: "blue" } });
  assert.deepEqual(await pending, { answered: true, summary: "Blue", data: { color: "blue" } });
  assert.equal(item.status, "answered");
  assert.throws(() => host.updateComponent(thread, item.id, { action: "reply", summary: "Again" }), /no longer waiting/);
});

test("skip and cancellation settle waits; nonwait replies send only their summary", async () => {
  const thread = runningThread();
  const pending = host.showComponent(thread, { html: "<p>choice</p>", wait: true });
  host.updateComponent(thread, component(thread).id, { action: "skip" });
  assert.deepEqual(await pending, { skipped: true });
  const cancelledThread = runningThread();
  const abort = new AbortController();
  const cancelled = host.showComponent(cancelledThread, { html: "<p>choice</p>", wait: true }, abort.signal);
  abort.abort();
  await assert.rejects(cancelled, /aborted/);
  assert.equal(component(cancelledThread).status, "expired");
  const shownThread = runningThread();
  await host.showComponent(shownThread, { html: "<p>table</p>" });
  const item = component(shownThread);
  assert.throws(() => host.updateComponent(shownThread, item.id, { action: "local", local: { value: "x".repeat(70_000) } }), /64 KiB/);
  host.updateComponent(shownThread, item.id, { action: "reply", summary: "Use the blue option", data: { private: "not sent" } });
  assert.ok(host.threadDetail(shownThread)!.items.some(it => it.kind === "user" && it.text === "Use the blue option" && it.from === "component"));
});

test("real browser: kit table and three buttons, sandbox, no-network, reply, state and lazy remount", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Inline component host test" });
  try {
    const thread = runningThread();
    const pending = host.showComponent(thread, { html: `<table class="table"><thead><tr><th>Color</th></tr></thead><tbody><tr><td>Blue</td></tr></tbody></table><button data-reply="Red" data-context='{"color":"red"}'>Red</button><button data-reply="Blue" data-context='{"color":"blue"}'>Blue</button><button data-reply="Green">Green</button><script>window.loads = 1; fetch('https://example.test/leak').catch(()=>window.blocked=true);</script>`, wait: true });
    const item = component(thread);
    const read = (name: string) => fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8");
    let outgoing = 0, documents = 0, writes = 0;
    const page = await browser.newPage();
    page.setDefaultTimeout(7000);
    await page.route("**/*", async route => {
      const req = route.request(), target = new URL(req.url());
      if (target.hostname === componentHost(item.id)) {
        documents++;
        return route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": COMPONENT_CSP }, body: componentDocument(host.componentItem(thread, item.id), { css: read("kit.css"), js: read("kit.js"), bridge: read("component-bridge.js") }) });
      }
      if (target.pathname.startsWith("/api/agent")) {
        if (req.method() === "POST") writes++;
        try { const result = req.method() === "GET" ? host.componentItem(thread, item.id) : host.updateComponent(thread, item.id, req.postDataJSON()); return route.fulfill({ json: result }); }
        catch (error) { return route.fulfill({ status: 400, json: { error: (error as Error).message } }); }
      }
      if (target.hostname !== "localhost") { outgoing++; return route.abort(); }
      return route.fulfill({ contentType: "text/html", body: "<main></main><div style='height:4000px'></div>" });
    });
    await page.goto("http://localhost:4747/component-test");
    await page.addScriptTag({ content: "window.__name = value => value; window.scribeApp = { showNotice: console.error };" });
    await page.addScriptTag({ content: read("component-host.js") });
    await page.evaluate(item => {
      const w = window as any;
      const R = {
        el(tag: string, cls: string, text: string) { const node = document.createElement(tag); if (cls) node.className = cls; if (text) node.textContent = text; return node; },
        button(text: string, cls: string, action: () => void) { const node = R.el("button", cls, text); node.onclick = action; return node; },
        renderMarkdown(node: HTMLElement, text: string) { node.textContent = text; },
      };
      document.querySelector("main")!.append(w.ScribeComponents.render(item, R, {}));
    }, item);
    const frame = page.frameLocator(".ag-component iframe");
    await frame.getByRole("button", { name: "Blue", exact: true }).waitFor();
    assert.equal(await frame.getByRole("button").count(), 3);
    assert.equal(await frame.locator("table").innerText(), "Color\nBlue");
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");
    await frame.locator("body").evaluate(async () => { await (window as any).scribe.setLocal({ tab: "saved" }); await (window as any).scribe.setSummary("Table of colors"); });
    assert.equal(host.componentItem(thread, item.id).local?.tab, "saved");
    assert.equal(host.componentItem(thread, item.id).summary, "Table of colors");
    const beforeBurst = writes;
    await frame.locator("body").evaluate(async () => {
      const api = (window as any).scribe;
      await Promise.all(Array.from({ length: 30 }, (_, i) => api.setLocal({ tab: `saved-${i}` })));
    });
    assert.equal(writes - beforeBurst, 1, "typing coalesces to one persisted state write");
    assert.equal(host.componentItem(thread, item.id).local?.tab, "saved-29");
    assert.equal(outgoing, 0);
    const child = page.frames().find(f => f.url().includes("/component/"))!;
    assert.equal(await child.evaluate(() => { try { return !!parent.document; } catch { return false; } }), false);
    await frame.getByRole("button", { name: "Blue", exact: true }).click();
    assert.deepEqual(await pending, { answered: true, data: { color: "blue" }, summary: "Blue" });
    await page.evaluate(item => (window as any).ScribeComponents.update(item), host.componentItem(thread, item.id));
    assert.equal(documents, 1, "state updates keep the frame mounted");
    await page.evaluate(() => scrollTo(0, 3500));
    await page.waitForFunction(() => !document.querySelector(".ag-component iframe"));
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForFunction(() => !!document.querySelector(".ag-component iframe"));
    await frame.getByRole("button", { name: "Blue", exact: true }).waitFor();
    assert.equal(await frame.locator("body").evaluate(() => (window as any).scribe.local.tab), "saved-29");
    // The shell's temporary embed uses this same URL and attachment path, never a full page bridge.
    await page.evaluate(async item => {
      const w = window as any;
      const expanded = document.createElement("iframe");
      expanded.id = "expanded";
      expanded.sandbox = "allow-scripts allow-same-origin allow-forms";
      document.querySelector("main")!.append(expanded);
      await w.ScribeComponents.attachUrl(expanded, w.ScribeComponents.url(item));
    }, item);
    const expanded = page.frameLocator("#expanded");
    await expanded.getByRole("button", { name: "Blue", exact: true }).waitFor();
    assert.equal(await page.locator("#expanded").getAttribute("sandbox"), "allow-scripts");
    assert.equal(await expanded.locator("body").evaluate(() => (window as any).scribe.state), undefined);
  } finally { await browser.close(); }
});

test("plugin frames relay live revisions/events, release subscriptions on unmount and fall back on disable", { timeout: 30_000 }, async () => {
  const service = new PluginService(path.join(dir, "live-plugins")); setPlugins(service);
  const browser = await launchChromium({ headless: true, args: [], purpose: "Plugin component bridge test" });
  const app = express();
  app.use(componentSite(() => host, path.resolve("public")));
  app.use("/api/agent", agentRouter(host));
  app.get("/", (_req, res) => res.send("<main></main><div style='height:4000px'></div>"));
  const server = app.listen(0, "0.0.0.0"); await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  try {
    const files = pluginFiles(); await service.install(files, service.preview(files).hash);
    service.database.set(pluginManifest.id, "count", 1);
    const thread = runningThread(); host.updateThread(thread, { approval: "full" });
    const showing = host.showComponent(thread, { plugin: pluginManifest.id, component: "counter", props: { name: "Live" }, fallback: "Counter fallback" });
    const item = component(thread), boot = host.componentProblems.boot(item.id, 0)!;
    host.componentProblems.report(item.id, { token: boot.token, phase: "done", problems: [] }); await showing;
    const page = await browser.newPage(); page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
    // The fixture uses an ephemeral port; production uses the configured shell origin.
    await page.route("**/api/agent/**", async route => {
      if (route.request().method() === "GET") return route.continue();
      const response = await route.fetch({ headers: { ...route.request().headers(), origin: shellOrigins()[0] } });
      return route.fulfill({ response });
    });
    await page.route("**/component/**", async route => {
      const read = (file: string) => fs.readFileSync(`public/${file}`, "utf8");
      await route.fulfill({ contentType: "text/html", body: componentDocument({ ...item, html: host.componentPlugin(thread, item.id).html }, { css: read("kit.css"), js: read("kit.js"), bridge: read("component-bridge.js") }), headers: { "content-security-policy": COMPONENT_CSP.replace(/frame-ancestors[^;]+/, `frame-ancestors http://localhost:${port}`) } });
    });
    await page.goto(`http://localhost:${port}/`);
    await page.addScriptTag({ content: "window.__name = value => value; window.scribeApp = { showNotice: console.error };" });
    await page.addScriptTag({ content: fs.readFileSync("public/component-host.js", "utf8") });
    await page.evaluate(item => {
      const w = window as any;
      const R = { el(tag: string, cls: string, text: string) { const n = document.createElement(tag); n.className = cls || ""; n.textContent = text || ""; return n; }, button(text: string, cls: string, fn: () => void) { const n = R.el("button", cls, text); n.onclick = fn; return n; }, renderMarkdown(n: HTMLElement, text: string) { n.textContent = text; } };
      document.querySelector("main")!.append(w.ScribeComponents.render(item, R, {}));
    }, item);
    const frame = page.frameLocator(".ag-component iframe");
    try { await frame.locator("#name").waitFor(); } catch (error) { throw new Error(`${error}\n${errors.join("\n")}\n${await page.locator("main").innerText()}\n${page.frames().map(f=>f.url()).join("\n")}`); }
    await page.waitForFunction(() => !!document.querySelector("iframe"));
    const child = () => page.frames().find(f => f.url().includes("/component/"))!;
    try { await child().waitForFunction(() => (window as any).seen.some((v: any) => v.value === 1)); } catch (error) { throw new Error(`${error}\n${errors.join("\n")}`); }
    await child().waitForFunction(() => (window as any).ticks !== undefined);
    await new Promise(resolve => setTimeout(resolve, 150));
    await host.componentPluginAction(thread, item.id, { op: "call", method: "update", args: { value: 2 } });
    await child().waitForFunction(() => (window as any).seen.some((v: any) => v.value === 2 && v.revision === 2));
    await child().waitForFunction(() => (window as any).ticks.includes(2));
    await assert.rejects(child().evaluate(() => (window as any).scribe.plugin.state.get("private")), /not declared/);
    assert.equal(await child().evaluate(() => Object.isFrozen((window as any).scribe.props)), true);
    await page.evaluate(() => scrollTo(0, 3500));
    await page.waitForFunction(() => !document.querySelector(".ag-component iframe"));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((service as any).listeners.size, 0, "unmount closes server subscription");
    await host.componentPluginAction(thread, item.id, { op: "call", method: "update", args: { value: 3 } });
    await page.evaluate(() => scrollTo(0, 0));
    await frame.locator("#count").waitFor();
    await child().waitForFunction(() => (window as any).seen.some((v: any) => v.value === 3 && v.revision === 3));
    // Simulate the stream and websocket both requesting a remount during a slow metadata GET.
    await page.route("**/api/agent/threads/*/components/*", async route => {
      if (route.request().method() === "GET" && !route.request().url().endsWith("/events")) await new Promise(resolve => setTimeout(resolve, 100));
      await route.fallback();
    });
    await page.evaluate(plugin => {
      (window as any).ScribeComponents.pluginChanged({plugin});
      setTimeout(() => (window as any).ScribeComponents.pluginChanged({plugin}), 25);
    }, pluginManifest.id);
    await frame.locator("#count").waitFor();
    await child().waitForFunction(() => (window as any).seen.some((v: any) => v.value === 3));
    host.updateThread(thread, { approval: "readonly" });
    const revokeBy = Date.now() + 2500;
    while ((service as any).listeners.size && Date.now() < revokeBy) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((service as any).listeners.size, 0, "dropping Full access revokes the established stream");
    host.updateThread(thread, { approval: "full" });
    await page.evaluate(plugin => (window as any).ScribeComponents.pluginChanged({plugin}), pluginManifest.id);
    await frame.locator("#count").waitFor();
    await child().waitForFunction(() => (window as any).seen.some((v: any) => v.value === 3));
    await service.enable(pluginManifest.id, false);
    await page.waitForFunction(() => !document.querySelector(".ag-component iframe") && document.querySelector(".ag-component")?.textContent?.includes("disabled"));
    assert.match(await page.locator(".ag-component").innerText(), /Counter fallback/);
    assert.equal((service as any).listeners.size, 0);
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    setPlugins(null); await service.close();
  }
});

test("component diagnostic capture reports script and bridge errors without invoking methods", { timeout: 15_000 }, async () => {
  const item: ComponentItem = { id: "it_012345abcdef", threadId: "th_capture", turnId: "tu_capture", seq: 1, createdAt: Date.now(), kind: "component", plugin: "component-fixture", component: "counter", props: { name: "Capture" }, wait: false, status: "shown", html: `<script>window.calls=0; scribe.plugin.call('update',{value:99}).then(result=>{if(result.error!=='capture')throw new Error('capture failed')}); setTimeout(()=>{throw new Error('Render failure')},0);</script>` };
  const controller = new AbortController();
  const report = await probeComponent(item, controller.signal) as { problems: Array<{code:string;message:string}> };
  assert.ok(report.problems.some(p => p.code === "uncaught_error" && p.message.includes("Render failure")));
  assert.ok(!report.problems.some(p => p.message.includes("capture failed")));
});

test("Allow once live consent expires when its specific turn ends", { timeout: 10_000 }, async () => {
  const service = new PluginService(path.join(dir, "once-plugins")); setPlugins(service);
  const app = express(); app.use("/api/agent", agentRouter(host));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const approve = host.requestPluginApproval;
  try {
    const files = pluginFiles(); await service.install(files, service.preview(files).hash);
    const thread = runningThread(); host.updateThread(thread, { approval: "readonly" });
    const showing = host.showComponent(thread, { plugin: pluginManifest.id, component: "counter", props: { name: "Once" } });
    const item = component(thread), boot = host.componentProblems.boot(item.id, 0)!;
    host.componentProblems.report(item.id, { token: boot.token, phase: "done", problems: [] }); await showing;
    host.requestPluginApproval = async () => ({ allowed: true });
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/threads/${thread}/components/${item.id}/events`, { signal: AbortSignal.timeout(4000) });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /ready/);
    (host as any).runs.delete(thread);
    assert.equal(host.runInfo(thread).exists, true, "the thread still exists after its turn ends");
    assert.match(new TextDecoder().decode((await reader.read()).value), /reload/);
    assert.equal((await reader.read()).done, true);
    assert.equal((service as any).listeners.size, 0);
  } finally {
    host.requestPluginApproval = approve;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    setPlugins(null); await service.close();
  }
});
