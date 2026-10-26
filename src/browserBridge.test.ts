import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { BOARD_BRIDGE_JS } from "./bridge.js";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const relay = app.slice(app.indexOf("  const browserPageWatches ="), app.indexOf("  async function onPageFile(event)"));
function harness(browserPage = true) {
  const replies: any[] = [], calls: any[] = [], streams: FakeSource[] = [];
  const source = { postMessage: (data: unknown) => replies.push(data) };
  const frame = { contentWindow: source, isConnected: true };
  class FakeSource {
    listeners = new Map<string, (event: any) => void>();
    closed = false;
    constructor(readonly url: string) { streams.push(this); }
    addEventListener(type: string, fn: (event: any) => void) { this.listeners.set(type, fn); }
    close() { this.closed = true; }
  }
  const tab = { id: "page1", key: "scribe:browser-thread1", title: "Thread one", ...(browserPage ? { browser: { threadId: "thread1" } } : {}) };
  const fetch = async (url: string, options: any) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ ok: true }) }; };
  const handle = new Function("frameIdByWindow", "findAnyTab", "document", "EventSource", "fetch", relay + "\nreturn onPageBrowser;")(
    () => tab.id, () => tab, { querySelectorAll: () => [frame], documentElement: {} }, FakeSource, fetch
  );
  const call = (op: string, extra = {}) => handle({ source, data: { type: "scribe-browser", op, id: tab.id, reqId: "r1", ...extra } });
  return { call, replies, calls, streams, frame, removed: () => { frame.isConnected = false; streams.at(-1)!.listeners.get("view")!({ data: "{}" }); } };
}

test("browser bridge relays only its bound thread and rejects ordinary pages", async () => {
  const h = harness();
  await h.call("info");
  assert.deepEqual(h.replies.at(-1).result, { ok: true, threadId: "thread1", key: "scribe:browser-thread1", title: "Thread one" });
  await h.call("navigate", { options: { url: "https://example.com" }, threadId: "other" });
  assert.deepEqual(h.calls, [{ url: "/api/agent/threads/thread1/browser/navigate", body: { url: "https://example.com" } }]);
  const ordinary = harness(false);
  await ordinary.call("control", { options: { action: "take" } });
  assert.equal(ordinary.replies.at(-1).result.error, "not_a_browser_page");
  assert.equal(ordinary.calls.length, 0);
});

test("browser bridge forwards frame/view events and closes streams on stop or frame removal", async () => {
  const h = harness();
  await h.call("watch", { watchId: "w1" });
  assert.equal(h.streams[0].url, "/api/agent/threads/thread1/browser/live");
  const frame = { tab: "b1", data: "jpeg", width: 1280, height: 800 };
  h.streams[0].listeners.get("frame")!({ data: JSON.stringify(frame) });
  assert.deepEqual(h.replies.at(-1), { type: "scribe-browser-event", id: "page1", watchId: "w1", event: { type: "frame", ...frame } });
  h.streams[0].listeners.get("view")!({ data: JSON.stringify({ control: "user" }) });
  assert.deepEqual(h.replies.at(-1).event, { type: "view", view: { control: "user" } });
  await h.call("stop", { watchId: "w1" });
  assert.equal(h.streams[0].closed, true);
  await h.call("watch", { watchId: "w2" });
  const sent = h.replies.length;
  h.removed();
  assert.equal(h.streams[1].closed, true);
  assert.equal(h.replies.length, sent);
});

test("injected browser bridge is valid JavaScript", () => {
  assert.doesNotThrow(() => new Function(BOARD_BRIDGE_JS));
});
