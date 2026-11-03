import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PluginRuntime } from "./runtime.js";
import { PluginTasks, STALE_MS, type TaskView } from "./tasks.js";

const until = async (check: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 25)); return check(); };

test("a task records progress and lines, ends with its result, and wakes a waiter", async () => {
  const events: TaskView[] = [], tasks = new PluginTasks(new DatabaseSync(":memory:"), (_plugin, task) => events.push(task));
  const task = tasks.start("p", "Build trunk", { kind: "agent", thread: "th_1" });
  tasks.progress("p", task.id, { text: "Compiling", pct: 142 });
  tasks.log("p", task.id, "line 1");
  assert.deepEqual(tasks.get(task.id)?.progress, { text: "Compiling", pct: 100 });
  const waiting = tasks.wait(task.id, 5000);
  tasks.finish("p", task.id, { result: { ok: true } });
  const { task: ended, timedOut } = await waiting;
  assert.equal(timedOut, false);
  assert.equal(ended?.status, "done");
  assert.deepEqual(ended?.result, { ok: true });
  assert.deepEqual(ended?.lines, ["line 1"]);
  assert.equal(tasks.list({ thread: "th_1" }).length, 1);
  assert.equal(events.at(-1)?.status, "done");
  assert.throws(() => tasks.progress("p", task.id, { text: "late" }), /not running/);
});

test("a wait on a running task times out and says so", async () => {
  const tasks = new PluginTasks(new DatabaseSync(":memory:"), () => {});
  const task = tasks.start("p", "Long", { kind: "system" });
  const { task: still, timedOut } = await tasks.wait(task.id, 50);
  assert.equal(timedOut, true);
  assert.equal(still?.status, "running");
});

test("a task with no update for a while is stale, not ended", () => {
  let now = 1_000;
  const tasks = new PluginTasks(new DatabaseSync(":memory:"), () => {}, () => now);
  const task = tasks.start("p", "Quiet", { kind: "system" });
  now += STALE_MS + 1;
  assert.equal(tasks.get(task.id)?.stale, true);
  assert.equal(tasks.get(task.id)?.status, "running");
});

test("running tasks show as interrupted after a restart or a backend stop", () => {
  const db = new DatabaseSync(":memory:");
  const first = new PluginTasks(db, () => {});
  const cut = first.start("p", "Cut off", { kind: "system" }).id;
  const second = new PluginTasks(db, () => {});
  assert.equal(second.get(cut)?.status, "interrupted");
  const stopped = second.start("p", "Stopped", { kind: "system" }).id;
  second.requestStop("p", stopped);
  const other = second.start("p", "Other", { kind: "system" }).id;
  second.interrupt("p");
  assert.equal(second.get(stopped)?.status, "stopped");
  assert.equal(second.get(other)?.status, "interrupted");
});

test("ctx.task runs over the runner: progress, Stop aborts t.signal, and the lease holds the backend", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-tasks-")), entry = path.join(dir, "index.mjs");
  fs.writeFileSync(entry, `export default { methods: {
    run: async (args, ctx) => {
      const t = await ctx.task({ title: "Tests" });
      await t.progress({ text: "Starting", pct: 10 });
      await t.log("first line");
      t.signal.addEventListener("abort", () => t.fail("stopped by user"));
      return { task: t.id };
    },
  } };`);
  const tasks = new PluginTasks(new DatabaseSync(":memory:"), () => {});
  const runtime: PluginRuntime = new PluginRuntime({ entry, dataDir: dir, settings: {} }, async (method, args) => {
    if (method !== "task") throw new Error("no host");
    const id = String(args.id);
    if (args.op === "start") return { id: tasks.start("p", String(args.title), { kind: "agent", thread: "th_9" }).id };
    if (args.op === "progress") tasks.progress("p", id, args);
    else if (args.op === "log") tasks.log("p", id, args.line);
    else if (args.op === "done") tasks.finish("p", id, { result: args.result });
    else if (args.op === "fail") tasks.finish("p", id, { error: args.error });
    return true;
  }, false, 100);
  runtime.onStopped = () => tasks.interrupt("p");
  t.after(async () => { await runtime.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { task } = await runtime.call("call", { method: "run", args: {}, caller: { kind: "agent" } }) as { task: string };
  const view = tasks.get(task)!;
  assert.equal(view.status, "running");
  assert.equal(view.thread, "th_9");
  assert.equal(view.progress?.text, "Starting");
  assert.deepEqual(view.lines, ["first line"]);
  assert.ok(await until(() => runtime.busy().includes("Tests")), "the task holds a lease");
  await new Promise(r => setTimeout(r, 300));
  assert.equal(runtime.status(), "running", "kept past the idle time while the task runs");
  tasks.requestStop("p", task);
  assert.equal(runtime.notify("task.stop", { id: task }), true);
  assert.ok(await until(() => tasks.get(task)?.status === "stopped"), "Stop aborted t.signal and the plugin failed the task");
  assert.equal(tasks.get(task)?.error, "stopped by user");
  assert.ok(await until(() => runtime.status() === "idle", 3000), "the lease ended with the task");
});
