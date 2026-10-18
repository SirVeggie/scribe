import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-browser-"));
process.env.SCRIBE_HOME = home;
const { store } = await import("./store.js");
store.load();
const framed = store.upsert({ key: "framed", title: "Framed", html: "<p>framed</p>" }).tab;

const {
  allowedBrowserUrl,
  blockedBoardRequest,
  browserAct,
  browserConsole,
  browserEval,
  browserHttpStatus,
  browserInput,
  browserNetwork,
  browserOpen,
  browserScreenshot,
  browserSessions,
  browserSnapshot,
  browserTabs,
  browserViews,
  closeAgentBrowser,
  closeThreadBrowser,
  onBrowserChange,
  resolveBrowserUrl,
  watchBrowser,
} = await import("./browser.js");

test("allowedBrowserUrl lets loopback through and nothing else", () => {
  for (const url of [
    "http://localhost:5173/",
    "http://app.localhost/",
    "https://127.0.0.1:8443/x",
    "http://127.0.0.2:4747/view/t_1",
    "http://[::1]:3000/",
    "about:blank",
  ]) {
    assert.equal(allowedBrowserUrl(url), true, url);
  }
  for (const url of [
    "https://example.com/",
    "http://192.168.1.10/",
    "http://localhost.evil.com/",
    "file:///C:/Windows/win.ini",
    "javascript:alert(1)",
    "not a url",
  ]) {
    assert.equal(allowedBrowserUrl(url), false, url);
  }
});

test("resolveBrowserUrl adds http:// to bare hosts", () => {
  assert.equal(resolveBrowserUrl({ url: "localhost:5173" }), "http://localhost:5173");
  assert.equal(resolveBrowserUrl({ url: "127.0.0.1:3000/a" }), "http://127.0.0.1:3000/a");
  assert.equal(resolveBrowserUrl({ url: "https://localhost/" }), "https://localhost/");
  assert.equal(resolveBrowserUrl({ url: "about:blank" }), "about:blank");
  assert.throws(() => resolveBrowserUrl({}), /Provide url or key/);
});

test("browserHttpStatus maps errors", () => {
  assert.equal(browserHttpStatus("no browser tab is open for this thread"), 404);
  assert.equal(browserHttpStatus("Could not launch a Chromium browser (Agent)."), 503);
  assert.equal(browserHttpStatus("locator.click: Timeout 8000ms exceeded."), 504);
  assert.equal(browserHttpStatus("The agent browser only opens loopback addresses"), 400);
});

const FIXTURE = `<!DOCTYPE html><html><head><title>Fixture</title></head><body>
<h1>Counter</h1>
<label>Name <input id="name"></label>
<button id="inc" onclick="count.textContent = String(Number(count.textContent) + 1); console.log('clicked ' + count.textContent)">Add one</button>
<output id="count">0</output>
<button onclick="fetch('/missing'); throw new Error('boom')">Break</button>
<a href="https://example.com/">Away</a>
</body></html>`;

// Same pattern as space cards: pointerdown on the item, pointermove must travel past 6px
// on that item before setPointerCapture, then reorder when the pointer is over another card.
const DRAG_FIXTURE = `<!DOCTYPE html><html><head><title>Drag</title>
<style>
#grid { display: flex; gap: 16px; padding: 24px; }
.card { width: 120px; height: 80px; border: 1px solid #000; display: flex; align-items: center; justify-content: center; user-select: none; touch-action: none; }
</style></head><body>
<div id="grid">
  <div class="card" id="a">Alpha</div>
  <div class="card" id="b">Beta</div>
</div>
<script>
let drag = null;
const grid = document.getElementById("grid");
for (const item of grid.querySelectorAll(".card")) {
  item.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = { item, startX: event.clientX, startY: event.clientY, pointerId: event.pointerId, moved: false };
    item.addEventListener("pointermove", onMove);
    item.addEventListener("pointerup", onUp);
  });
}
function onMove(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    drag.item.setPointerCapture(event.pointerId);
  }
  const cards = [...grid.querySelectorAll(".card")];
  const over = cards.find((other) => {
    if (other === drag.item) return false;
    const rect = other.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  });
  if (over) {
    grid.insertBefore(drag.item, cards.indexOf(over) < cards.indexOf(drag.item) ? over : over.nextSibling);
  }
}
function onUp() {
  if (!drag) return;
  drag.item.removeEventListener("pointermove", onMove);
  drag.item.removeEventListener("pointerup", onUp);
  drag = null;
}
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(FIXTURE);
    return;
  }
  if (req.url === "/shell") {
    // Like the Scribe shell: the page iframe is on another origin, so the shell can't script it.
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><title>Shell</title><iframe id="page" src="http://localhost:${port()}/view/${encodeURIComponent(framed.id)}"></iframe>`);
    return;
  }
  if (req.url?.startsWith("/view/")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<!DOCTYPE html><title>View</title><button onclick="this.textContent = 'Pressed'">Press me</button><script>window.inside = "page " + location.host;</script>`
    );
    return;
  }
  if (req.url === "/drag") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(DRAG_FIXTURE);
    return;
  }
  res.writeHead(404);
  res.end("nope");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = () => (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port()}`;

after(async () => {
  await closeAgentBrowser();
  server.close();
  store.closeDb();
  fs.rmSync(home, { recursive: true, force: true });
});

let launched = true;

test("a thread opens a page, acts on refs, and reads console and network", async (t) => {
  let opened;
  try {
    opened = await browserOpen("thr_a", { url: `${base}/` });
  } catch (err) {
    if ((err as Error).message.includes("Could not launch")) {
      launched = false;
      t.skip("no Chromium browser installed");
      return;
    }
    throw err;
  }
  assert.equal(opened.tab, "b1");
  assert.equal(opened.title, "Fixture");
  assert.ok("snapshot" in opened && opened.snapshot);
  const ref = /button "Add one" \[ref=(e\d+)\]/.exec(opened.snapshot as string)?.[1];
  assert.ok(ref, opened.snapshot as string);

  const clicked = await browserAct("thr_a", { action: "click", ref });
  assert.ok("snapshot" in clicked);
  assert.match(clicked.snapshot as string, /status \[ref=e\d+\]: "1"/);
  assert.equal(await browserEval("thr_a", { script: "document.getElementById('count').textContent" }).then((r) => r.result), '"1"');

  await browserAct("thr_a", { action: "fill", selector: "#name", value: "Ada" });
  assert.equal((await browserEval("thr_a", { script: "return document.getElementById('name').value" })).result, '"Ada"');

  const broke = await browserAct("thr_a", { action: "click", text: "Break", snapshot: false });
  assert.ok(broke.consoleErrors?.some((line) => /boom/.test(line)), JSON.stringify(broke));

  const logs = await browserConsole("thr_a", { pattern: "clicked" });
  assert.deepEqual(
    logs.messages.map((row) => row.text),
    ["clicked 1"]
  );
  const failed = await browserNetwork("thr_a", { failedOnly: true });
  assert.ok(failed.requests.some((row) => row.url.endsWith("/missing") && row.status === 404), JSON.stringify(failed));

  const shot = await browserScreenshot("thr_a", { selector: "h1" });
  assert.equal(shot.mimeType, "image/png");
  assert.ok(shot.bytes > 0);

  const part = await browserSnapshot("thr_a", { selector: "h1" });
  assert.match(part.snapshot as string, /Counter/);
});

test("browser_eval reaches a cross-origin page frame by page key or iframe selector", async (t) => {
  if (!launched) {
    t.skip("no Chromium browser installed");
    return;
  }
  await browserOpen("thr_frame", { url: `${base}/shell`, snapshot: false });
  const expected = JSON.stringify(`page localhost:${port()}`);
  assert.equal((await browserEval("thr_frame", { script: "window.inside ?? null" })).result, "null");
  const byKey = await browserEval("thr_frame", { script: "window.inside", frame: "scribe:framed" });
  assert.equal(byKey.result, expected);
  assert.match(byKey.frame ?? "", /\/view\//);
  assert.equal((await browserEval("thr_frame", { script: "window.inside", frame: framed.id })).result, expected);
  assert.equal((await browserEval("thr_frame", { script: "window.inside", frame: "#page" })).result, expected);
  await assert.rejects(browserEval("thr_frame", { script: "1", frame: "#nope" }), /frame not found/);
  await closeThreadBrowser("thr_frame");
});

test("browser_act, snapshot, and screenshot reach a page frame", async (t) => {
  if (!launched) {
    t.skip("no Chromium browser installed");
    return;
  }
  await browserOpen("thr_frame_act", { url: `${base}/shell`, snapshot: false });
  // Without frame, text only looks in the shell.
  await assert.rejects(browserAct("thr_frame_act", { action: "click", text: "Press me", snapshot: false }), /Timeout/);
  const clicked = await browserAct("thr_frame_act", { action: "click", text: "Press me", frame: "scribe:framed" });
  assert.ok("snapshot" in clicked);
  assert.match(clicked.snapshot as string, /button "Pressed"/);
  assert.doesNotMatch(clicked.snapshot as string, /iframe/);

  const inner = await browserSnapshot("thr_frame_act", { frame: "#page" });
  assert.match(inner.frame ?? "", /\/view\//);
  const ref = /button "Pressed".*\[ref=(f\d+e\d+)\]/.exec(inner.snapshot as string)?.[1];
  assert.ok(ref, inner.snapshot as string);
  // A frame ref works from the top page too.
  await browserEval("thr_frame_act", { script: "document.querySelector('button').textContent = 'Press me'", frame: "#page" });
  const again = await browserAct("thr_frame_act", { action: "click", ref, snapshot: false });
  assert.equal(again.action, "click");
  assert.equal((await browserEval("thr_frame_act", { script: "document.querySelector('button').textContent", frame: "#page" })).result, '"Pressed"');

  const shot = await browserScreenshot("thr_frame_act", { frame: "scribe:framed" });
  assert.ok(shot.bytes > 0);
  await closeThreadBrowser("thr_frame_act");
});

test("links off loopback are blocked, and threads get their own browser", async (t) => {
  if (!launched) {
    t.skip("no Chromium browser installed");
    return;
  }
  await assert.rejects(browserOpen("thr_a", { url: "https://example.com/" }), /only opens loopback/);
  await browserAct("thr_a", { action: "click", text: "Away", snapshot: false }).catch(() => undefined);
  const { result } = await browserEval("thr_a", { script: "location.host" });
  assert.notEqual(result, '"example.com"');

  await assert.rejects(browserSnapshot("thr_b", {}), /call browser_open first/);
  await browserOpen("thr_b", { url: `${base}/`, snapshot: false });
  assert.equal((await browserEval("thr_b", { script: "document.getElementById('count').textContent" })).result, '"0"');
  assert.equal(browserSessions().length, 2);

  await browserOpen("thr_b", { url: `${base}/`, newTab: true, snapshot: false });
  assert.deepEqual(
    (await browserTabs("thr_b", {})).tabs.map((tab) => [tab.tab, tab.current]),
    [
      ["b1", false],
      ["b2", true],
    ]
  );
  await browserTabs("thr_b", { close: "b2" });
  assert.deepEqual((await browserTabs("thr_b", {})).tabs.map((tab) => tab.tab), ["b1"]);

  await closeThreadBrowser("thr_b");
  assert.deepEqual(
    browserSessions().map((session) => session.threadId),
    ["thr_a"]
  );
});

test("drag interpolates pointermove so pointer-capture reorder UIs run", async (t) => {
  if (!launched) {
    t.skip("no Chromium browser installed");
    return;
  }
  const order = () =>
    browserEval("thr_drag", {
      script: "return [...document.querySelectorAll('.card')].map((el) => el.id).join('')",
    }).then((r) => r.result);

  await browserOpen("thr_drag", { url: `${base}/drag`, snapshot: false });
  await browserAct("thr_drag", { action: "drag", selector: "#a", to: { selector: "#b" }, steps: 1, snapshot: false });
  assert.equal(await order(), '"ab"', "one jump never fires pointermove on the source");

  await browserOpen("thr_drag", { url: `${base}/drag`, snapshot: false });
  await browserAct("thr_drag", { action: "drag", selector: "#a", to: { selector: "#b" }, snapshot: false });
  assert.equal(await order(), '"ba"');

  await closeThreadBrowser("thr_drag");
});

test("the live view streams frames and follows tabs, and the user's input reaches the page", async (t) => {
  if (!launched) {
    t.skip("no Chromium browser installed");
    return;
  }
  const changes: Array<string | null> = [];
  const stopChanges = onBrowserChange((view, threadId) => {
    if (threadId === "thr_live") changes.push(view ? view.tabs.find((tab) => tab.current)?.tab ?? "" : null);
  });
  const frames: Array<{ tab: string; width: number; height: number }> = [];
  const views: Array<string | undefined> = [];
  // Watching before the thread has a browser waits for it.
  const stop = watchBrowser(
    "thr_live",
    (frame) => frames.push({ tab: frame.tab, width: frame.width, height: frame.height }),
    (view) => views.push(view?.tabs.find((tab) => tab.current)?.url)
  );
  await browserOpen("thr_live", { url: `${base}/`, snapshot: false });
  await until(() => frames.some((frame) => frame.tab === "b1"));
  assert.equal(frames[0].width, 1280);
  assert.equal(frames[0].height, 800);
  await until(() => views.includes(`${base}/`));
  assert.ok((await browserViews()).some((view) => view.threadId === "thr_live"));

  // Clicks land at viewport pixels; keys and text go to the focused field.
  const box = JSON.parse(
    (await browserEval("thr_live", { script: "const r = document.getElementById('inc').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }" })).result
  );
  await browserInput("thr_live", { kind: "down", ...box });
  await browserInput("thr_live", { kind: "up", ...box });
  assert.equal((await browserEval("thr_live", { script: "document.getElementById('count').textContent" })).result, '"1"');
  await browserAct("thr_live", { action: "click", selector: "#name", snapshot: false });
  await browserInput("thr_live", { kind: "text", text: "Ad" });
  await browserInput("thr_live", { kind: "key", key: "a" });
  await browserInput("thr_live", { kind: "key", key: "Backspace" });
  await browserInput("thr_live", { kind: "key", key: "A" });
  assert.equal((await browserEval("thr_live", { script: "document.getElementById('name').value" })).result, '"AdA"');

  await browserOpen("thr_live", { url: `${base}/drag`, newTab: true, snapshot: false });
  await until(() => frames.some((frame) => frame.tab === "b2"));
  await until(() => changes.at(-1) === "b2");

  stop();
  await closeThreadBrowser("thr_live");
  await until(() => changes.at(-1) === null);
  stopChanges();
});

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("blockedBoardRequest keeps the agent browser off the board's file-opening routes (#655)", () => {
  for (const url of [
    "http://127.0.0.1:4747/api/files/open",
    "http://localhost:4747/api/files/open-folder",
    "http://127.0.0.1:4747/api/files/upload?name=x",
    "http://127.0.0.1:4747/api/files/list?path=C%3A%5C",
    "http://127.0.0.1:4747/api/temp-pages/url",
  ]) {
    assert.equal(blockedBoardRequest(url, 4747), true, url);
  }
  for (const url of [
    "http://127.0.0.1:4747/",
    "http://127.0.0.1:4747/api/tabs",
    "http://localhost:5173/api/files/open",
    "https://example.com:4747/api/files/open",
    "about:blank",
  ]) {
    assert.equal(blockedBoardRequest(url, 4747), false, url);
  }
});
