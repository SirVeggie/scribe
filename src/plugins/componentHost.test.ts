import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type express from "express";
import { limitComponentAction, relayComponentEvents, type ComponentRate } from "./componentHost.js";
import type { PluginService } from "./service.js";

function fixture() {
  const listeners = new Set<Parameters<PluginService["subscribe"]>[0]>();
  const plugins = { subscribe(listener: Parameters<PluginService["subscribe"]>[0]) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const emit = (id: string, name: string, data: unknown, registry = false) => { for (const fn of listeners) fn(id, name, data, registry); };
  function response() {
    const res = Object.assign(new EventEmitter(), {
      chunks: [] as string[], ended: 0, writable: true,
      set() {}, flushHeaders() {},
      write(chunk: string) { this.chunks.push(chunk); return this.writable; },
      end() { this.ended++; res.emit("close"); },
    });
    return { res, response: res as unknown as express.Response, messages: () => res.chunks.filter(s => s.startsWith("data: ")).map(s => JSON.parse(s.slice(6))) };
  }
  return { plugins, listeners, emit, response };
}

test("component relay filters declarations and payload size, reloads and cleans up", () => {
  const f = fixture(), r = f.response();
  relayComponentEvents(r.response, { plugins: f.plugins, plugin: "counter", definition: { state: ["rows/*"], events: ["tick"] }, valid: () => true });
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
  relayComponentEvents(a.response, options);
  relayComponentEvents(b.response, options);
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

test("relay checks validity before delivery and closes on backpressure", () => {
  const f = fixture(), a = f.response(), b = f.response();
  const options = { plugins: f.plugins, plugin: "counter", definition: { state: [], events: ["tick"] } };
  relayComponentEvents(a.response, { ...options, valid: () => false });
  b.res.writable = false;
  relayComponentEvents(b.response, { ...options, valid: () => true });
  try {
    assert.equal(b.res.ended, 1);
    f.emit("counter", "tick", "private");
    assert.deepEqual(a.messages(), [{ type: "ready" }, { type: "reload" }]);
    assert.equal(a.res.ended, 1);
    assert.equal(f.listeners.size, 0);
  } finally { a.res.emit("close"); b.res.emit("close"); }
});

test("component limiter bounds requests and active actions, and releases failures", async t => {
  t.mock.timers.enable({ apis: ["Date"] });
  const rate: ComponentRate = { at: Date.now(), count: 0, active: 0 };
  for (let i = 0; i < 100; i++) await limitComponentAction(rate, () => i);
  await assert.rejects(limitComponentAction(rate, () => 0), /frequent/);
  t.mock.timers.tick(1000);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const active = Array.from({ length: 16 }, () => limitComponentAction(rate, () => pending));
  assert.equal(rate.active, 16);
  await assert.rejects(limitComponentAction(rate, () => 0), /frequent/);
  release(); await Promise.all(active);
  assert.equal(rate.active, 0);
  await assert.rejects(limitComponentAction(rate, () => { throw new Error("failed"); }), /failed/);
  await assert.rejects(limitComponentAction(rate, async () => { throw new Error("failed async"); }), /failed async/);
  assert.equal(rate.active, 0);
  assert.equal(await limitComponentAction(rate, () => 42), 42);
});
