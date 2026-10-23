import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { parseComponentInput, MAX_COMPONENT_HTML, type ComponentItem } from "./componentTool.js";
import { componentHost, componentItemFromHost, previewThreadFromHost, pageIdFromHost } from "../config.js";
import { contentOriginGate } from "../contentOrigin.js";
import { componentDocument, COMPONENT_CSP } from "../components.js";
import { itemText } from "./threadAccess.js";
import { launchChromium } from "../chromium.js";

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

test("input caps count UTF-8 bytes and reject reserved plugin inputs", () => {
  assert.throws(() => parseComponentInput({ html: "å".repeat(MAX_COMPONENT_HTML) }), /UTF-8/);
  assert.throws(() => parseComponentInput({ html: " " }), /empty/);
  assert.throws(() => parseComponentInput({ html: "ok", plugin: "test" }), /reserved/);
  assert.throws(() => parseComponentInput({ html: "ok", wait: "yes" }), /true or false/);
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
    let outgoing = 0, documents = 0;
    const page = await browser.newPage();
    page.setDefaultTimeout(7000);
    await page.route("**/*", async route => {
      const req = route.request(), target = new URL(req.url());
      if (target.hostname === componentHost(item.id)) {
        documents++;
        return route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": COMPONENT_CSP }, body: componentDocument(host.componentItem(thread, item.id), { css: read("kit.css"), js: read("kit.js"), bridge: read("component-bridge.js") }) });
      }
      if (target.pathname.startsWith("/api/agent")) {
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
    assert.equal(await frame.locator("body").evaluate(() => (window as any).scribe.local.tab), "saved");
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
