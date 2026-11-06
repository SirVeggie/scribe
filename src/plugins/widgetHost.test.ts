import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type express from "express";
import { limitWidgetAction, relayWidgetEvents, SLOW_CLIENT, type WidgetRate } from "./widgetHost.js";
import type { PluginService } from "./service.js";

function fixture() {
  const listeners = new Set<Parameters<PluginService["subscribe"]>[0]>();
  const plugins = { subscribe(listener: Parameters<PluginService["subscribe"]>[0]) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const emit = (id: string, name: string, data: unknown, registry = false) => { for (const fn of listeners) fn(id, name, data, registry); };
  function response() {
    const res = Object.assign(new EventEmitter(), {
      chunks: [] as string[], ended: 0, destroyed: 0, writable: true, writableLength: 0,
      set() {}, flushHeaders() {},
      write(chunk: string) { this.chunks.push(chunk); return this.writable; },
      end() { this.ended++; res.emit("close"); },
      destroy() { this.destroyed++; res.emit("close"); },
    });
    return { res, response: res as unknown as express.Response, messages: () => res.chunks.filter(s => s.startsWith("data: ")).map(s => JSON.parse(s.slice(6))) };
  }
  return { plugins, listeners, emit, response };
}

test("component relay filters declarations and payload size, reloads and cleans up", () => {
  const f = fixture(), r = f.response();
  relayWidgetEvents(r.response, { plugins: f.plugins, plugin: "counter", definition: { state: ["rows/*"], events: ["tick"] }, valid: () => true });
  try {
    f.emit("other", "tick", 1);
    f.emit("counter", "private", 1);
    f.emit("counter", "state", { key: "private", revision: 1 });
    f.emit("counter", "state", { key: "rows/a", revision: 2, value: "not relayed" });
    f.emit("counter", "tick", "x".repeat(65534));
    f.emit("counter", "tick", "x".repeat(65535));
    const messages = r.messages();
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[0], { type: "ready" });
    assert.deepEqual(messages[1], { type: "plugin-state", key: "rows/a", revision: 2 });
    assert.equal(messages[2].data.length, 65534);
    f.emit("other", "registry", {}, true);
    assert.equal(r.res.ended, 0);
    f.emit("*", "registry", {}, true);
    assert.deepEqual(r.messages().at(-1), { type: "reload" });
    assert.equal(r.res.ended, 1);
    assert.equal(f.listeners.size, 0);
  } finally { r.res.emit("close"); }
});

test("relay polling revokes idle streams and stops checking closed streams", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const start = t.mock.method(globalThis, "setInterval");
  const stop = t.mock.method(globalThis, "clearInterval");
  const f = fixture(), a = f.response(), b = f.response();
  let valid = true, checks = 0;
  const options = { plugins: f.plugins, plugin: "counter", definition: { state: [], events: [] }, valid: () => { checks++; return valid; } };
  relayWidgetEvents(a.response, options);
  relayWidgetEvents(b.response, options);
  try {
    assert.equal(start.mock.callCount(), 1, "streams share one interval");
    t.mock.timers.tick(1000);
    assert.equal(checks, 2);
    assert.equal(a.res.chunks.at(-1), ": keepalive\n\n");
    a.res.emit("close");
    valid = false;
    t.mock.timers.tick(1000);
    assert.equal(checks, 3);
    assert.deepEqual(b.messages().at(-1), { type: "reload" });
    assert.equal(f.listeners.size, 0);
    assert.equal(stop.mock.callCount(), 1, "last stream clears the interval");
    t.mock.timers.tick(1000);
    assert.equal(checks, 3);
  } finally { a.res.emit("close"); b.res.emit("close"); }
});

test("relay checks validity before delivery and closes when the buffer passes its cap", () => {
  const f = fixture(), a = f.response(), b = f.response();
  const options = { plugins: f.plugins, plugin: "counter", definition: { state: [], events: ["tick"] } };
  relayWidgetEvents(a.response, { ...options, valid: () => false });
  b.res.writable = false;
  b.res.writableLength = SLOW_CLIENT.bufferBytes + 1;
  relayWidgetEvents(b.response, { ...options, valid: () => true });
  try {
    assert.equal(b.res.destroyed, 1);
    f.emit("counter", "tick", "private");
    assert.deepEqual(a.messages(), [{ type: "ready" }, { type: "reload" }]);
    assert.equal(a.res.ended, 1);
    assert.equal(f.listeners.size, 0);
  } finally { a.res.emit("close"); b.res.emit("close"); }
});

test("relay waits for drain on transient backpressure and closes a client that stays blocked", t => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const f = fixture(), a = f.response(), b = f.response();
  const options = { plugins: f.plugins, plugin: "counter", definition: { state: [], events: ["tick"] }, valid: () => true };
  a.res.writable = b.res.writable = false;
  relayWidgetEvents(a.response, options);
  relayWidgetEvents(b.response, options);
  try {
    f.emit("counter", "tick", 1);
    assert.equal(a.res.destroyed + b.res.destroyed, 0, "a false write alone keeps the stream");
    t.mock.timers.tick(SLOW_CLIENT.drainMs - 1000);
    assert.ok(!a.res.chunks.includes(": keepalive\n\n"), "no keepalive while blocked");
    a.res.writable = true;
    a.res.emit("drain");
    t.mock.timers.tick(1000);
    assert.equal(a.res.destroyed, 0);
    assert.equal(a.res.chunks.at(-1), ": keepalive\n\n");
    assert.equal(b.res.destroyed, 1, "no drain within the timeout drops the stream");
    assert.equal(f.listeners.size, 1);
  } finally { a.res.emit("close"); b.res.emit("close"); }
});

test("relay over real HTTP keeps a large event past the high-water mark and closes a stalled client", async () => {
  const f = fixture();
  let wroteFalse = 0, closed = false;
  const server = http.createServer((req, res) => {
    const write = res.write.bind(res) as (chunk: string) => boolean;
    (res as { write: (chunk: string) => boolean }).write = chunk => { const ok = write(chunk); if (!ok) wroteFalse++; return ok; };
    res.on("close", () => { closed = true; });
    relayWidgetEvents(Object.assign(res, { set(headers: Record<string, string>) { for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); } }) as unknown as express.Response,
      { plugins: f.plugins, plugin: "counter", definition: { state: [], events: ["tick"] }, valid: () => true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const big = "x".repeat(65500); // just under the 64 KiB event cap with its wrapper
  try {
    const client = await new Promise<http.IncomingMessage>(resolve => http.get(`http://127.0.0.1:${port}/`, resolve));
    client.pause();
    const tick = () => new Promise<void>(resolve => setImmediate(resolve));
    while (f.listeners.size === 0) await tick();
    // Fill the socket while the client is paused until a write reports backpressure.
    let sent = 0;
    while (!wroteFalse && sent < 2000) { f.emit("counter", "tick", { n: sent++, big }); await tick(); }
    assert.ok(wroteFalse, "a large event reaches the high-water mark");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(closed, false, "a false write does not close the stream");
    assert.equal(f.listeners.size, 1);
    // A reading client drains the buffer and receives every event intact.
    let text = "";
    client.setEncoding("utf8");
    client.on("data", chunk => { text += chunk; });
    client.resume();
    const want = sent;
    while ((text.match(/"type":"plugin-event"/g)?.length ?? 0) < want) await tick();
    const events = text.split("\n\n").filter(s => s.startsWith("data: ")).map(s => JSON.parse(s.slice(6))).filter(m => m.type === "plugin-event");
    assert.deepEqual(events.map(m => m.data.n), Array.from({ length: want }, (_, i) => i));
    assert.ok(events.every(m => m.data.big === big));
    // A client that stops reading for good is closed once the buffer passes its cap.
    client.pause();
    for (let i = 0; i < 4000 && !closed; i++) { f.emit("counter", "tick", { n: i, big }); await tick(); }
    assert.equal(closed, true, "a stalled client is closed");
    assert.equal(f.listeners.size, 0);
    client.destroy();
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("component limiter bounds requests and active actions, and releases failures", async t => {
  t.mock.timers.enable({ apis: ["Date"] });
  const rate: WidgetRate = { at: Date.now(), count: 0, active: 0 };
  for (let i = 0; i < 100; i++) await limitWidgetAction(rate, () => i);
  await assert.rejects(limitWidgetAction(rate, () => 0), /frequent/);
  t.mock.timers.tick(1000);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const active = Array.from({ length: 16 }, () => limitWidgetAction(rate, () => pending));
  assert.equal(rate.active, 16);
  await assert.rejects(limitWidgetAction(rate, () => 0), /frequent/);
  release(); await Promise.all(active);
  assert.equal(rate.active, 0);
  await assert.rejects(limitWidgetAction(rate, () => { throw new Error("failed"); }), /failed/);
  await assert.rejects(limitWidgetAction(rate, async () => { throw new Error("failed async"); }), /failed async/);
  assert.equal(rate.active, 0);
  assert.equal(await limitWidgetAction(rate, () => 42), 42);
});
