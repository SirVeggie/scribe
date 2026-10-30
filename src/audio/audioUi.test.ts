import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import http from "node:http";
import { test } from "node:test";
import { launchChromium } from "../chromium.js";
import { BOARD_BRIDGE_JS } from "../bridge.js";
import { httpFixture } from "../test/httpFixture.js";

function pageAudioHarness() {
  const posted: any[] = [], frames = new Map([["page", { revision: 1, el: { isConnected: true } }]]);
  let activated = false, visible = true, calls = 0, cancelled = 0, resolveEnd: (value: any) => void;
  const streamMessages: any[] = [];
  let stopClick: () => void;
  const button = { hidden: true, addEventListener(_name: string, fn: () => void) { stopClick = fn; } };
  const audio = {
    available: () => ({ mic: true, stt: true }), refresh: async () => {}, cancel() { cancelled++; },
    capture: async (opts: any) => { calls++; return { sampleRate: 48000, ended: new Promise(r => { resolveEnd = r; }),
      cancel(reason = "stopped") { cancelled++; resolveEnd(opts.live ? reason : new Blob(["clip"], { type: "audio/webm" })); },
      stop(reason = "stopped") { resolveEnd(opts.live ? reason : new Blob(["clip"], { type: "audio/webm" })); } }; },
    transcribe: async () => ({ ok: true, text: "Words" })
  };
  const source = { postMessage: (message: any) => posted.push(message) };
  const context = vm.createContext({ window: { scribeAudio: audio, scribePermissions: { ensure: async () => ({ ok: true }) } },
    document: { hidden: false, createElement: () => button, querySelector: () => ({ append() {} }), addEventListener() {} },
    tabsEl: { querySelectorAll: () => [] }, views: { shownIds: () => new Set(visible ? ["page"] : []) },
    frames, frameIdByWindow: (win: any) => win === source ? "page" : null, findAnyTab: () => ({ id: "page" }),
    frameActivated: () => activated, crypto: { randomUUID: () => "session" }, Blob, ArrayBuffer, AbortController,
    MessageChannel: class { port1 = { postMessage(message: any) { streamMessages.push(message); }, close() {} }; port2 = {}; },
    setInterval() {}, setTimeout, clearTimeout, Date });
  const app = fs.readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");
  vm.runInContext(app.slice(app.indexOf("  const pageAudioSessions ="), app.indexOf("\n  /**", app.indexOf("  async function onPageAudio"))), context);
  return { context, posted, button, streamMessages, shellStop: () => stopClick(), end: (reason: string) => resolveEnd(reason),
    get calls() { return calls; }, get cancelled() { return cancelled; },
    activate() { activated = true; }, hide() { visible = false; vm.runInContext("checkPageAudioVisibility()", context); },
    request: async (op: string, extra = {}) => { await context.onPageAudio({ source, origin: "http://127.0.0.2", data: { op, id: "page", reqId: "request", ...extra } }); return posted.at(-1)?.result; } };
}

test("listen combines ask permissions in one prompt and stops at a denied permission", async () => {
  let value = "ask", prompts = 0;
  const remembered: string[] = [];
  const context = vm.createContext({
    list: async () => ["audio.microphone", "audio.transcribe"].map(id => ({ id, label: id, detail: id })),
    request: async () => ({ result: value }),
    prompt: async (_tab: unknown, def: any) => { prompts++; assert.match(def.label, /audio.microphone and audio.transcribe/); return { value: "allow", keep: false }; },
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

test("stream checks only its own permission and requires a gesture before opening the microphone", async () => {
  const h = pageAudioHarness();
  assert.equal((await h.request("stream")).error, "no_gesture"); assert.equal(h.calls, 0);
  h.activate();
  let allowed = false;
  h.context.window.scribePermissions.ensure = async (_tab: any, need: any) => {
    assert.equal(need.perm, "audio.microphoneStream");
    return allowed ? { ok: true } : { ok: false, error: "denied" };
  };
  assert.equal((await h.request("stream")).error, "denied"); assert.equal(h.calls, 0);
  allowed = true;
  const live = await h.request("stream");
  assert.equal(live.ok, true); assert.equal(live.sampleRate, 48000); assert.ok(live.port);
  await h.request("stop", { sessionId: "session" });
  assert.equal(h.streamMessages.at(-1).end, "stopped");
});

test("stream delivers one end reason and clears the recording marker for each exit", async () => {
  for (const reason of ["stopped", "hidden", "max", "user", "revoked"] as const) {
    const h = pageAudioHarness(); h.activate(); await h.request("stream");
    if (reason === "stopped") await h.request("stop", { sessionId: "session" });
    else if (reason === "hidden") h.hide();
    else if (reason === "user") h.shellStop();
    else if (reason === "revoked") vm.runInContext('cancelPageAudio("page", "revoked")', h.context);
    else h.end(reason);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.streamMessages.filter(m => m.end).length, 1);
    assert.equal(h.streamMessages.at(-1).end, reason); assert.equal(h.button.hidden, true);
    h.hide(); assert.equal(h.streamMessages.filter(m => m.end).length, 1);
  }
});

test("pure jitter buffer waits for 60 ms, preserves sample order, caps latency and rebuffers underruns", () => {
  const context = vm.createContext({ AudioWorkletProcessor: class {}, registerProcessor() {}, Float32Array });
  vm.runInContext(fs.readFileSync(new URL("../../public/audio-stream-worklet.js", import.meta.url), "utf8"), context);
  const step = context.audioJitterStep;
  const empty = { frames: [], offset: 0, queued: 0, playing: false };
  const first = Float32Array.from({ length: 40 }, (_, i) => i + 1);
  let state = step(empty, first, 10, 1000);
  assert.equal(state.queued, 40); assert.ok(state.output.every((v: number) => v === 0));
  state = step(state, new Float32Array(20).fill(99), 30, 1000);
  assert.deepEqual(Array.from(state.output), Array.from(first.subarray(0, 30)));
  assert.equal(state.queued, 30);
  const before = state;
  state = step(state, null, 40, 1000);
  assert.deepEqual(Array.from(state.output), [...Array.from(first.subarray(30)), ...Array(20).fill(99), ...Array(10).fill(0)]);
  assert.equal(state.playing, false); assert.equal(before.queued, 30); assert.equal(before.offset, 30);
  state = step(state, new Float32Array(20).fill(2), 10, 1000);
  assert.ok(state.output.every((v: number) => v === 0));
  const overflow = Float32Array.from({ length: 300 }, (_, i) => i);
  state = step(state, overflow, 60, 1000);
  assert.deepEqual(Array.from(state.output), Array.from(overflow.subarray(240)));
  assert.equal(state.queued, 0); assert.equal(empty.frames.length, 0); assert.equal(first[0], 1);
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
test("page listen, record and live samples round trip through a cross-origin iframe with no microphone delegation", async t => {
  const browser = await launchChromium({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"], purpose: "Page audio test" });
  t.after(() => browser.close());
  // Worklet module fetches bypass Playwright's page routes. Serve them on real loopback sockets.
  const worklet = fs.readFileSync(new URL("../../public/audio-stream-worklet.js", import.meta.url), "utf8");
  let failPlayback = false;
  const workletRequests: string[] = [];
  const serveWorklet: http.RequestListener = (req, res) => {
    workletRequests.push(req.headers.host!);
    res.writeHead(failPlayback && req.headers.host?.startsWith("127.0.0.2:") ? 500 : 200, { "Content-Type": "text/javascript" });
    res.end(worklet);
  };
  const app = fs.readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");
  const handlers = app.slice(app.indexOf("  const pageAudioSessions ="), app.indexOf("\n  /**", app.indexOf("  async function onPageAudio")));
  const fixture = fs.readFileSync(new URL("./page-test.html", import.meta.url), "utf8");
  const { port } = await httpFixture(t, (req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    if (path === "/audio-stream-worklet.js") return serveWorklet(req, res);
    if (path === "/api/audio/settings") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ available: true }));
    }
    if (path === "/api/audio/transcriptions") {
      if (req.headers["x-scribe-tab"] !== "page") {
        res.writeHead(400); return res.end("Missing page header");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, text: "spoken words" }));
    }
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(`<header class="chrome"></header><div id="tabs"><div class="tab" data-id="page"></div></div><iframe src="http://127.0.0.2:${port}/page" sandbox="allow-scripts allow-same-origin"></iframe>`);
    }
    res.writeHead(404); res.end();
  });
  await httpFixture(t, (req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    if (path === "/audio-stream-worklet.js") return serveWorklet(req, res);
    if (path === "/page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(`<script>window.__SCRIBE_BOOT__ = {id:'page',capture:true};</script><script>${BOARD_BRIDGE_JS}</script>${fixture}`);
    }
    res.writeHead(404); res.end();
  }, { host: "127.0.0.2", port });
  const page = await browser.newPage(); page.setDefaultTimeout(7000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.addScriptTag({ content: fs.readFileSync(new URL("../../public/audio.js", import.meta.url), "utf8") });
  await page.addScriptTag({ content: `(() => {
    const iframe = document.querySelector('iframe'), tabsEl = document.getElementById('tabs');
    const frames = new Map([['page',{revision:1,el:iframe}]]);
    window.audioVisible = true;
    const views = {shownIds:() => new Set(window.audioVisible ? ['page'] : [])};
    const frameIdByWindow = win => win === iframe.contentWindow ? 'page' : null;
    const findAnyTab = () => ({id:'page'});
    const frameActivated = id => navigator.userActivation.isActive && document.activeElement === iframe;
    window.scribePermissions = {ensure:async () => ({ok:true})};
    ${handlers}
    window.hideAudioPage = () => { window.audioVisible = false; checkPageAudioVisibility(); };
    window.revokeAudio = () => cancelPageAudio('page', 'revoked');
    window.addEventListener('message', event => { if(event.origin === 'http://127.0.0.2:${port}' && event.data.type === 'scribe-audio') onPageAudio(event); });
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
  const child = page.frames().find(f => f.url().includes("127.0.0.2"))!;
  // Playwright evaluate grants activation; invoke from a timer after it expires.
  assert.equal(await child.evaluate(() => new Promise(resolve => {
    setTimeout(async () => resolve((await (window as any).scribe.audio.stream()).error), 5100);
  })), "no_gesture");
  await frame.locator("#stream").click();
  await child.waitForFunction(() => Number((document.getElementById("level") as HTMLElement).dataset.peak) > .001).catch(async error => {
    throw new Error(`${error.message}; page status: ${await frame.locator("#output").innerText()}; errors: ${errors.join("; ")}`);
  });
  assert.equal(await child.evaluate("session.stream instanceof MediaStream"), true);
  assert.equal(await child.evaluate("session.stream.getAudioTracks()[0].readyState"), "live");
  assert.equal(await page.locator(".tab-recording").count(), 1);
  await frame.locator("#stop").click();
  await child.waitForFunction(() => document.getElementById("output")?.dataset.end === "stopped");
  assert.equal(await child.evaluate("session.stream.getAudioTracks()[0].readyState"), "ended");
  await page.waitForFunction(() => (document.querySelector(".page-audio-stop") as HTMLButtonElement).hidden);
  await frame.locator("#stream").click();
  await child.waitForFunction(() => Number((document.getElementById("level") as HTMLElement).dataset.peak) > .001);
  await page.evaluate(() => (window as any).hideAudioPage());
  await child.waitForFunction(() => document.getElementById("output")?.dataset.end === "hidden");
  assert.equal(await child.evaluate("session.stream.getAudioTracks()[0].readyState"), "ended");
  assert.equal(await page.locator(".tab-recording").count(), 0);
  await page.evaluate(() => { (window as any).audioVisible = true; });
  for (const reason of ["user", "revoked"] as const) {
    await frame.locator("#stream").click();
    await child.waitForFunction(() => Number((document.getElementById("level") as HTMLElement).dataset.peak) > .001);
    if (reason === "user") await page.locator(".page-audio-stop").click();
    else await page.evaluate(() => (window as any).revokeAudio());
    await child.waitForFunction(r => document.getElementById("output")?.dataset.end === r, reason);
    assert.equal(await child.evaluate("session.stream.getAudioTracks()[0].readyState"), "ended");
  }
  await child.evaluate("document.getElementById('stream').onclick = () => start('stream', 500)");
  await frame.locator("#stream").click();
  await child.waitForFunction(() => document.getElementById("output")?.dataset.end === "max");
  assert.equal(await child.evaluate("session.stream.getAudioTracks()[0].readyState"), "ended");
  // An end during module setup must still reach a handler assigned after awaiting stream().
  await child.evaluate(`document.getElementById('stream').onclick = async () => {
    window.earlyLive = await scribe.audio.stream({ maxMs: 1 });
    window.earlyLive.onend = reason => { window.earlyReason = reason; };
  }`);
  await frame.locator("#stream").click();
  await child.waitForFunction(() => (window as any).earlyReason === "max");
  assert.equal(await child.evaluate("earlyLive.stream.getAudioTracks()[0].readyState"), "ended");
  // A page worklet load failure resolves a typed failure and releases the shell microphone.
  failPlayback = true;
  await child.evaluate("document.getElementById('stream').onclick = () => start('stream')");
  await frame.locator("#stream").click();
  await frame.locator("#output").filter({ hasText: "unavailable" }).waitFor();
  await page.waitForFunction(() => (document.querySelector(".page-audio-stop") as HTMLButtonElement).hidden);
  assert.equal(await page.locator("iframe").getAttribute("allow"), null);
  assert.deepEqual(errors, []);
  assert.ok(workletRequests.includes(`127.0.0.1:${port}`));
  assert.ok(workletRequests.includes(`127.0.0.2:${port}`));
});
