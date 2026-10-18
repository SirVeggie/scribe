import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { launchChromium } from "../chromium.js";
import { BOARD_BRIDGE_JS } from "../bridge.js";

function pageAudioHarness() {
  const posted: any[] = [], frames = new Map([["page", { revision: 1, el: { isConnected: true } }]]);
  let activated = false, visible = true, calls = 0, cancelled = 0, resolveEnd: (blob: Blob) => void;
  const button = { hidden: true, addEventListener() {} };
  const audio = {
    available: () => ({ mic: true, stt: true }), refresh: async () => {}, cancel() { cancelled++; },
    capture: async () => { calls++; return { ended: new Promise<Blob>(r => { resolveEnd = r; }),
      cancel() { cancelled++; resolveEnd(new Blob(["clip"], { type: "audio/webm" })); },
      stop() { resolveEnd(new Blob(["clip"], { type: "audio/webm" })); } }; },
    transcribe: async () => ({ ok: true, text: "Words" })
  };
  const source = { postMessage: (message: any) => posted.push(message) };
  const context = vm.createContext({ window: { scribeAudio: audio, scribePermissions: { ensure: async () => ({ ok: true }) } },
    document: { hidden: false, createElement: () => button, querySelector: () => ({ append() {} }), addEventListener() {} },
    tabsEl: { querySelectorAll: () => [] }, views: { shownIds: () => new Set(visible ? ["page"] : []) },
    frames, frameIdByWindow: (win: any) => win === source ? "page" : null, findAnyTab: () => ({ id: "page" }),
    frameActivated: () => activated, crypto: { randomUUID: () => "session" }, Blob, ArrayBuffer, AbortController,
    setInterval() {}, setTimeout, clearTimeout, Date });
  const app = fs.readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");
  vm.runInContext(app.slice(app.indexOf("  const pageAudioSessions ="), app.indexOf("\n  /**", app.indexOf("  async function onPageAudio"))), context);
  return { context, posted, button, get calls() { return calls; }, get cancelled() { return cancelled; },
    activate() { activated = true; }, hide() { visible = false; vm.runInContext("checkPageAudioVisibility()", context); },
    request: async (op: string, extra = {}) => { await context.onPageAudio({ source, origin: "http://127.0.0.2", data: { op, id: "page", reqId: "request", ...extra } }); return posted.at(-1)?.result; } };
}

test("listen combines ask permissions in one prompt and stops at a denied permission", async () => {
  let value = "ask", prompts = 0;
  const remembered: string[] = [];
  const context = vm.createContext({
    list: async () => ["audio.microphone", "audio.transcribe"].map(id => ({ id, label: id, detail: id })),
    request: async () => ({ result: value }),
    prompt: async (_tab: unknown, def: any) => { prompts++; assert.match(def.label, /audio.microphone and audio.transcribe/); return "allow"; },
    remember: async (_tab: unknown, def: any) => remembered.push(def.id)
  });
  const source = fs.readFileSync(new URL("../../public/permissions.js", import.meta.url), "utf8");
  vm.runInContext(source.slice(source.indexOf("  async function ensure("), source.indexOf("  /** The page's permissions")), context);
  const needs = [{ perm: "audio.microphone" }, { perm: "audio.transcribe" }];
  assert.equal((await context.ensure({ id: "page" }, needs)).ok, true);
  assert.equal(prompts, 1); assert.deepEqual(remembered, needs.map(n => n.perm));
  value = "deny";
  assert.equal((await context.ensure({ id: "page" }, needs)).error, "denied"); assert.equal(prompts, 1);
  value = "allow";
  assert.equal((await context.ensure({ id: "page" }, needs)).ok, true); assert.equal(prompts, 1);
});

test("shell refuses microphone without frame activation and cancels when a page is hidden", async () => {
  const h = pageAudioHarness();
  assert.equal((await h.request("record")).error, "no_gesture"); assert.equal(h.calls, 0);
  h.activate(); assert.equal((await h.request("record")).ok, true); assert.equal(h.calls, 1);
  assert.equal(h.button.hidden, false);
  h.hide(); assert.ok(h.cancelled > 0); assert.equal(h.button.hidden, true);
  assert.equal((await h.request("stop", { sessionId: "session" })).error, "cancelled");
});

test("shell returns a finished clip and checks permissions before opening the mic", async () => {
  const h = pageAudioHarness(); h.activate();
  h.context.window.scribePermissions.ensure = async () => ({ ok: false, error: "denied", permission: "audio.microphone" });
  assert.equal((await h.request("listen")).error, "denied"); assert.equal(h.calls, 0);
  h.context.window.scribePermissions.ensure = async () => ({ ok: true });
  await h.request("record");
  const result = await h.request("stop", { sessionId: "session" });
  assert.equal(result.ok, true); assert.equal(result.mimeType, "audio/webm");
  assert.equal(new TextDecoder().decode(result.buffer), "clip");
});

test("caret insertion replaces selection and spaces words without separating punctuation", () => {
  const context = vm.createContext({ window: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync(new URL("../../public/audio.js", import.meta.url), "utf8"), context);
  const insert = context.window.scribeAudio.insertAtCaret;
  for (const [value, start, end, text, expected, caret] of [
    ["", 0, 0, " Hello ", "Hello", 5],
    ["Hello", 5, 5, "world", "Hello world", 11],
    ["Hello wrong!", 6, 11, "world", "Hello world!", 11],
    ["Hello friend", 5, 5, "dear", "Hello dear friend", 10],
    ["Hello", 5, 5, ",", "Hello,", 6],
    ["(now)", 1, 4, "later", "(later)", 6],
    ["a\nb", 2, 2, "new", "a\nnew b", 6],
    ["Hello", 1, 4, "  ", "Hello", 4],
  ] as const) {
    const result = insert(value, start, end, text);
    assert.equal(result.value, expected); assert.equal(result.caret, caret);
  }
});

test("Chromium capture stops tracks, enforces one session and cap; composer handles editing, cancellation, sending and push-to-talk", async () => {
  const browser = await launchChromium({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"], purpose: "Audio UI test" });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(7000);
    const settings = { stt: { source: "test", model: "whisper-1" }, input: { sendAfterDictation: false, pushToTalk: true }, sources: [{ id: "test", name: "Test" }], available: true };
    let transcriptionRequests = 0, delay = 0;
    await page.route("http://127.0.0.1:47999/**", async route => {
      const url = route.request().url();
      if (url.includes("/api/audio/settings")) return route.fulfill({ json: settings });
      if (url.includes("/api/audio/transcriptions")) {
        transcriptionRequests++; if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        return route.fulfill({ json: { ok: true, text: "spoken words" } });
      }
      return route.fulfill({ contentType: "text/html", body: '<main><textarea></textarea><div class="bar"><button class="ag-mic"><span class="ag-mic-status"></span></button></div></main>' });
    });
    await page.goto("http://127.0.0.1:47999/");
    for (const name of ["audio.js", "audio-composer.js"]) await page.addScriptTag({ content: fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8") });
    await page.evaluate(`(() => {
      window.notices = []; window.sent = 0; window.openedSettings = null;
      window.scribeAudio.notice = text => window.notices.push(text);
      window.scribeApp = { openSettings: category => window.openedSettings = category };
      window.view = { bar: document.querySelector('.bar'), input: document.querySelector('textarea'), threadId: 'thread', visible: () => true,
        focus() { this.input.focus(); }, send() { window.sent++; } };
      window.composer = window.scribeAudio.bindComposer(window.view);
      document.querySelector('button').onclick = () => window.composer.toggle();
      const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.streams = [];
      navigator.mediaDevices.getUserMedia = async opts => { const stream = await get(opts); window.streams.push(stream); return stream; };
    })()`);
    await page.evaluate(async () => { const audio = (window as any).scribeAudio; await audio.refresh(); (window as any).capture = await audio.capture({ owner: { kind: "chat", threadId: "direct" }, maxMs: 150 }); });
    assert.equal(await page.evaluate(async () => { try { await (window as any).scribeAudio.capture({}); return false; } catch { return true; } }), true);
    await page.waitForFunction(() => (window as any).capture.state === "stopped");
    assert.ok(await page.evaluate(async () => (await (window as any).capture.stop()).size > 0));
    assert.equal(await page.evaluate(() => (window as any).streams.every((s: MediaStream) => s.getTracks().every(t => t.readyState === "ended"))), true);

    await page.locator("textarea").fill("Hello wrong!");
    await page.locator("button").click(); await page.waitForFunction(() => document.querySelector("button")?.getAttribute("data-state") === "recording");
    delay = 250;
    await page.locator("button").click();
    await page.waitForFunction(() => document.querySelector("button")?.getAttribute("data-state") === "transcribing");
    await page.evaluate(() => { const input = document.querySelector("textarea")!; input.value = "Edited wrong!"; input.setSelectionRange(7, 12); });
    await page.waitForFunction(() => document.querySelector("button")?.getAttribute("data-state") === "idle");
    assert.equal(await page.locator("textarea").inputValue(), "Edited spoken words!");
    assert.equal(await page.evaluate(() => (window as any).sent), 0);
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("textarea")), true);
    delay = 0;

    const previous = transcriptionRequests;
    await page.locator("button").click(); await page.waitForFunction(() => document.querySelector("button")?.getAttribute("data-state") === "recording");
    await page.keyboard.press("Escape");
    assert.equal(transcriptionRequests, previous);
    assert.equal(await page.evaluate(() => (window as any).streams.every((s: MediaStream) => s.getTracks().every(t => t.readyState === "ended"))), true);

    settings.input.sendAfterDictation = true;
    await page.locator("textarea").focus();
    await page.keyboard.down("Control"); await page.keyboard.down("Shift"); await page.keyboard.down("Space");
    await page.waitForFunction(() => document.querySelector("button")?.getAttribute("data-state") === "recording");
    await page.keyboard.up("Space"); await page.keyboard.up("Shift"); await page.keyboard.up("Control");
    await page.waitForFunction(() => (window as any).sent === 1);

    // A late response following a thread switch must be discarded.
    delay = 250;
    await page.locator("button").click(); await page.waitForFunction(() => document.querySelector("button")?.getAttribute("data-state") === "recording");
    await page.locator("button").click(); await page.waitForFunction(() => document.querySelector("button")?.getAttribute("data-state") === "transcribing");
    await page.evaluate(() => { (window as any).composer.cancel(); (window as any).view.threadId = "other"; (window as any).view.input.value = "Other draft"; });
    await page.waitForTimeout(350);
    assert.equal(await page.locator("textarea").inputValue(), "Other draft");
    assert.equal(await page.evaluate(() => (window as any).sent), 1);
    delay = 0;

    settings.available = false;
    await page.locator("button").click(); await page.waitForFunction(() => (window as any).openedSettings === "Audio");
    assert.equal(await page.evaluate(() => (window as any).notices.length), 0);

    // Permission-denied errors produce one useful notice.
    settings.available = true;
    // The unavailable check hid the button; reading settings again shows it.
    await page.evaluate(() => (window as any).scribeAudio.refresh());
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("blocked", "NotAllowedError"); }; });
    await page.locator("button").click(); await page.waitForFunction(() => (window as any).notices.length === 1);
    assert.match(await page.evaluate(() => (window as any).notices[0]), /Microphone blocked.*site permissions/);
  } finally { await browser.close(); }
});
test("page listen and record round trip through a cross-origin iframe with no microphone delegation", async () => {
  const browser = await launchChromium({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"], purpose: "Page audio test" });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(7000);
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    const app = fs.readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");
    const handlers = app.slice(app.indexOf("  const pageAudioSessions ="), app.indexOf("\n  /**", app.indexOf("  async function onPageAudio")));
    const fixture = fs.readFileSync(new URL("./page-test.html", import.meta.url), "utf8");
    await page.route("http://127.0.0.2:47999/**", route => route.fulfill({ contentType: "text/html", body:
      `<script>window.__SCRIBE_BOOT__ = {id:'page',capture:true};</script><script>${BOARD_BRIDGE_JS}</script>${fixture}` }));
    await page.route("http://127.0.0.1:47999/**", route => {
      const url = route.request().url();
      if (url.includes("/api/audio/settings")) return route.fulfill({ json: { available: true } });
      if (url.includes("/api/audio/transcriptions")) {
        assert.equal(route.request().headers()["x-scribe-tab"], "page");
        return route.fulfill({ json: { ok: true, text: "spoken words" } });
      }
      return route.fulfill({ contentType: "text/html", body: `<header class="chrome"></header><div id="tabs"><div class="tab" data-id="page"></div></div><iframe src="http://127.0.0.2:47999/page" sandbox="allow-scripts allow-same-origin"></iframe>` });
    });
    await page.goto("http://127.0.0.1:47999/");
    await page.addScriptTag({ content: fs.readFileSync(new URL("../../public/audio.js", import.meta.url), "utf8") });
    await page.addScriptTag({ content: `(() => {
      const iframe = document.querySelector('iframe'), tabsEl = document.getElementById('tabs');
      const frames = new Map([['page',{revision:1,el:iframe}]]);
      const views = {shownIds:() => new Set(['page'])};
      const frameIdByWindow = win => win === iframe.contentWindow ? 'page' : null;
      const findAnyTab = () => ({id:'page'});
      const frameActivated = id => navigator.userActivation.isActive && document.activeElement === iframe;
      window.scribePermissions = {ensure:async () => ({ok:true})};
      ${handlers}
      window.addEventListener('message', event => { if(event.origin === 'http://127.0.0.2:47999' && event.data.type === 'scribe-audio') onPageAudio(event); });
    })();` });
    const frame = page.frameLocator("iframe");
    await frame.locator("#record").click();
    await frame.locator("#output").filter({ hasText: "Recording" }).waitFor();
    assert.equal(await page.locator(".tab-recording").count(), 1);
    await page.waitForTimeout(200); // Give the fake microphone time to produce an audio packet.
    await frame.locator("#stop").click();
    await frame.locator("#output").filter({ hasText: "mimeType" }).waitFor();
    const result = JSON.parse(await frame.locator("#output").innerText());
    assert.ok(result.bytes > 0); assert.ok(result.durationMs >= 0);
    await frame.locator("#listen").click();
    await frame.locator("#output").filter({ hasText: "Recording" }).waitFor();
    await page.locator(".page-audio-stop").click();
    await frame.locator("#stop").click();
    await frame.locator("#output").filter({ hasText: "spoken words" }).waitFor();
    assert.equal(await page.locator("iframe").getAttribute("allow"), null);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
