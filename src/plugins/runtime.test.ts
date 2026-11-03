import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginRuntime } from "./runtime.js";

const backend = `
const sleep = ms => new Promise(r => setTimeout(r, ms));
let aborted = false;
export default { methods: {
  wait: (args, ctx) => new Promise(resolve => ctx.signal.addEventListener("abort", () => { aborted = true; resolve(null); })),
  aborted: () => aborted,
  spin: () => { for (;;) {} },
  work: (args, ctx) => { ctx.busy(sleep(args.ms), "Building trunk"); return "started"; },
  fail: (args, ctx) => { ctx.busy(async () => { throw new Error("boom"); }); return "started"; },
  env: () => ({ mine: process.env.PLUGIN_954_VAR ?? null, scribe: process.env.SCRIBE_954_SECRET ?? null }),
} };`;
function fixture(t: { after(fn: () => unknown): void }, options: { env?: string[]; idleMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-runtime-")), entry = path.join(dir, "index.mjs");
  fs.writeFileSync(entry, backend);
  const runtime = new PluginRuntime({ entry, dataDir: dir, settings: {}, env: options.env }, async () => { throw new Error("no host"); }, false, options.idleMs);
  t.after(async () => { await runtime.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (method: string, args: unknown = {}, opts?: { timeoutMs?: number; signal?: AbortSignal }) => runtime.call("call", { method, args, caller: { kind: "agent" } }, opts);
  return { runtime, call };
}
const until = async (check: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 25)); return check(); };

test("a timed-out call fails on its own: the backend keeps running and the call's signal aborts", async t => {
  const { runtime, call } = fixture(t);
  await assert.rejects(call("wait", {}, { timeoutMs: 300 }), /timed out/);
  assert.equal(runtime.status(), "running");
  assert.equal(await call("aborted"), true);
});

test("cancelling a call aborts its signal without stopping the backend", async t => {
  const { runtime, call } = fixture(t), abort = new AbortController();
  const pending = call("wait", {}, { signal: abort.signal });
  setTimeout(() => abort.abort(), 100);
  await assert.rejects(pending, /cancelled/);
  assert.equal(await call("aborted"), true);
  assert.equal(runtime.status(), "running");
});

test("a backend whose event loop is blocked is stopped after a timed-out call", async t => {
  const { runtime, call } = fixture(t);
  await call("aborted");
  await assert.rejects(call("spin", {}, { timeoutMs: 200 }), /timed out/);
  assert.ok(await until(() => runtime.status() !== "running", 10_000), "the hung backend was stopped");
});

test("ctx.busy keeps the backend from its idle stop until the work settles", async t => {
  const { runtime, call } = fixture(t, { idleMs: 150 });
  assert.equal(await call("work", { ms: 800 }), "started");
  assert.ok(await until(() => runtime.busy().length > 0, 1000));
  assert.deepEqual(runtime.busy(), ["Building trunk"]);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(runtime.status(), "running", "still running past the idle time while busy");
  assert.ok(await until(() => runtime.status() === "idle", 3000), "stopped once the work was done and the idle time passed");
});

test("failed background work is logged and does not crash the backend", async t => {
  const { runtime, call } = fixture(t, { idleMs: 60_000 });
  assert.equal(await call("fail"), "started");
  assert.ok(await until(() => runtime.logs.some(line => /Background work failed: Error: boom/.test(line))));
  assert.ok(await until(() => runtime.busy().length === 0));
  assert.equal(runtime.status(), "running");
});

test("access.env passes declared variables, never Scribe's own", async t => {
  process.env.PLUGIN_954_VAR = "C:/jdk"; process.env.SCRIBE_954_SECRET = "token";
  t.after(() => { delete process.env.PLUGIN_954_VAR; delete process.env.SCRIBE_954_SECRET; });
  const { call } = fixture(t, { env: ["PLUGIN_954_VAR", "SCRIBE_954_SECRET"] });
  assert.deepEqual(await call("env"), { mine: "C:/jdk", scribe: null });
});
