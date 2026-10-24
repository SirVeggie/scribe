import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { RunSink, TurnInput, TurnResult } from "./providers/provider.js";
import type { ApprovalPolicy, Thread } from "./types.js";

// The host keeps its data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-helper-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;
/** What the stub provider's sessions were asked, and how the next turn ends. */
const asked: Array<{ thread: Thread; input: TurnInput }> = [];
let hanging = false;
let failWithActivity = false;
const helperWaits = new Map<string, () => void>();
/** Messages steered into a running stub turn. */
const steered: string[] = [];

type Internals = { providers: Record<string, unknown>; runs: Map<string, unknown>; turns: Map<string, unknown[]>; pending: Map<string, { itemId: string; threadId: string }> };

before(() => {
  store.load();
  host = new AgentHost(() => {});
  // A provider that runs no model: a turn answers with one line, or waits for cancel.
  (host as unknown as Internals).providers.pi = {
    id: "pi",
    label: "Native",
    status: async () => ({ id: "pi", label: "Native", available: true }),
    models: async () => [
      { id: "local/qwen-coder", label: "Qwen Coder", provider: "pi", efforts: [], params: [] },
      { id: "local/qwen-small", label: "Qwen Small", provider: "pi", efforts: [], params: [] },
    ],
    complete: async () => "",
    resolveModel: async () => null,
    prewarm: () => {},
    dispose: () => {},
    createSession: (thread: Thread) => ({
      warm: async () => {},
      update: () => {},
      commands: async () => [],
      dispose: () => {},
      cancel: async () => helperWaits.get(thread.id)?.(),
      steer: (input: { text: string }) => {
        steered.push(input.text);
        return `st_${steered.length}`;
      },
      run: async (input: TurnInput, sink: RunSink): Promise<TurnResult> => {
        asked.push({ thread, input });
        sink.usage({ inputTokens: 20, cacheReadTokens: 10, outputTokens: 5 });
        if (failWithActivity) {
          failWithActivity = false;
          sink.text("I have the wiring. Next I'll add tests.");
          for (let i = 0; i < 7; i++) {
            sink.toolStart({ toolId: `edit_${i}`, name: "edit", tool: "edit", title: `Edit file ${i}`, status: "running" });
            if (i < 6) sink.toolUpdate(`edit_${i}`, { status: "done" });
          }
          return { status: "error", error: "Agent turn stopped after repeated resume attempts made no progress" };
        }
        if (hanging) {
          await new Promise<void>((resolve) => { helperWaits.set(thread.id, resolve); });
          helperWaits.delete(thread.id);
          return { status: "cancelled" };
        }
        sink.text(`did: ${input.text.split("\n").at(-1)}`);
        return { status: "done" };
      },
    }),
  };
});

after(async () => {
  // A turn's last bookkeeping (page runs, worktree progress) trails the reply by a tick.
  await new Promise((resolve) => setTimeout(resolve, 100));
  host.dispose();
  store.closeDb();
  // Windows can still hold the scratch folder for a moment (EPERM); a leftover temp folder is no test failure.
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // left for the OS to clean up
  }
});

function parent(approval: ApprovalPolicy = "full"): string {
  return host.createThread({ provider: "codex", mode: "code", approval, cwd: null, scope: { kind: "global", ref: null } }).id;
}

/** Give a thread a running turn, so the user can be asked. */
function running(id: string): void {
  const internals = host as unknown as Internals;
  const turn = { id: `tu_${id}`, threadId: id, seq: 1, status: "running", model: "m", effort: null, mode: "board", startedAt: Date.now() };
  internals.turns.get(id)?.push(turn);
  internals.runs.set(id, { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), repo: null, cancelled: false, usage: {}, steer: null, hooks: { lastUser: "", dock: false, called: new Set(), gated: new Set(), approved: new Set(), waiting: new Map(), told: new Set(), earlyItem: null } });
}

async function approvalFor(id: string): Promise<{ itemId: string }> {
  const pending = (host as unknown as Internals).pending;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const request = [...pending.values()].find((item) => item.threadId === id);
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`thread ${id} did not request helper approval`);
}

test("helpers default on when preferences have no saved choice", () => {
  assert.equal(host.prefs().helpers, true);
  host.setPrefs({ memory: false });
  assert.equal(host.prefs().helpers, true);
});

test("helpers are refused when the user turns them off", async () => {
  host.setPrefs({ helpers: false });
  assert.equal(host.prefs().helpers, false);
  host.setPrefs({ memory: true });
  assert.equal(host.prefs().helpers, false);
  await assert.rejects(host.runHelper(parent(), { task: "x", title: "Inspect files", provider: "pi" }), /turned off/);
  await assert.rejects(host.helperModels(parent()), /turned off/);
});

test("new helpers require a nonblank title before starting a thread", async () => {
  host.setPrefs({ helpers: true });
  const id = parent();
  const before = host.listThreads().length;
  for (const title of [undefined, "", " \n\t "]) {
    await assert.rejects(host.runHelper(id, { task: "inspect the files", provider: "pi", title }), /title is required for a new helper/);
  }
  assert.equal(host.listThreads().length, before);
});

test("a helper runs the brief on the named model with the caller's settings and returns its reply", async () => {
  host.setPrefs({ helpers: true });
  const id = parent();
  asked.length = 0;
  const result = await host.runHelper(id, { task: "rename foo to bar", title: "  Rename\n  symbol  ", provider: "pi", model: "qwen coder" });
  assert.equal(result.status, "done");
  assert.equal(result.reply, "did: rename foo to bar");
  assert.equal(result.partialReply, undefined);
  assert.equal(result.recentTools, undefined);
  assert.deepEqual(result.usage, { turns: 1, inputTokens: 20, cacheReadTokens: 10, outputTokens: 5, promptTokens: 30, costPartial: true });
  const helper = host.getThread(String(result.thread))!;
  assert.equal(helper.title, "Helper: Rename symbol");
  assert.equal(helper.titleLocked, true);
  assert.equal(helper.helperOf, id);
  assert.equal(helper.model, "local/qwen-coder");
  assert.equal(helper.mode, "code");
  assert.equal(helper.approval, "full");
  assert.deepEqual(helper.scope, { kind: "workspace", ref: null });
  assert.match(asked[0].input.text, /A brief from the agent this helper thread works for/);
  assert.match(asked[0].input.instructions, /Helper thread:/);
  assert.doesNotMatch(asked[0].input.instructions, /agent_run/);
  // A helper's finished turn is not the user's unread reply.
  assert.equal(host.listThreads().find((t) => t.id === helper.id)?.unread, false);

  const again = await host.runHelper(id, { task: "now the tests", thread: helper.id });
  assert.equal(again.thread, helper.id);
  assert.equal(again.reply, "did: now the tests");
  assert.equal(host.getThread(helper.id)!.title, "Helper: Rename symbol");
  assert.equal((again.usage as { promptTokens: number }).promptTokens, 60);
  const info = host.runInfo(id);
  assert.ok(info.exists);
  if (info.exists) {
    assert.equal(info.usage?.inputTokens, 60);
    assert.equal(info.usage?.helpers?.threads, 1);
    assert.equal(info.usage?.helpers?.turns, 2);
  }
});

test("failed helpers report partial replies, changed files and bounded recent activity", async () => {
  const id = parent();
  failWithActivity = true;
  const result = await host.runHelper(id, { task: "wire the feature", title: "Wire feature", provider: "pi" });
  assert.equal(result.status, "error");
  assert.equal(result.error, "Agent turn stopped after repeated resume attempts made no progress");
  assert.doesNotMatch(String(result.note), /Cursor/);
  assert.equal(result.partialReply, true);
  assert.match(String(result.reply), /Next I'll add tests/);
  assert.match(String(result.note), /stopped before completing its turn/);
  assert.match(String(result.note), /do not prove the task is complete/);
  const recent = result.recentTools as Array<{ name: string; title: string; status: string }>;
  assert.equal(recent.length, 5);
  assert.equal(recent[0].title, "Edit file 2");
  assert.equal(recent[0].status, "done");
  assert.equal(recent[4].status, "error"); // host settles unfinished tools on failure
  const helperId = String(result.thread);
  const turns = (host as unknown as Internals).turns.get(helperId)!;
  Object.assign(turns.at(-1)!, { files: [{ status: "M", path: "feature.ts", added: 2, removed: 0 }] });
  // Persisted Cursor failures use the same report, with the provider's checkpoint explanation.
  const helper = host.getThread(helperId)!;
  const provider = helper.provider;
  try {
    helper.provider = "cursor";
    const report = await host.runHelper(id, { task: "", thread: helperId });
    assert.deepEqual(report.files, ["M feature.ts"]);
    assert.match(String(report.note), /Cursor's SDK.*checkpoint/);
    assert.match(String(report.note), /File edits and tool activity can still have occurred/);
  } finally {
    helper.provider = provider;
  }
});

test("new helpers inherit or lower the rung and follow-ups keep it", async () => {
  host.setPrefs({ helpers: true });
  const id = host.createThread({ provider: "codex", approval: "full", cwd: dir, scope: { kind: "workspace", ref: dir } }).id;
  // access is the rung; the old mode names still work (plan is Board, ask is Board).
  const cases = [[undefined, "code", "full"], ["auto", "code", "auto"], ["readonly", "board", "readonly"], ["plan", "board", "board"], ["ask", "board", "board"]] as const;
  for (const [access, mode, approval] of cases) {
    asked.length = 0;
    const result = await host.runHelper(id, { task: "inspect the files", title: "Inspect files", provider: "pi", mode: access });
    const helper = host.getThread(String(result.thread))!;
    assert.equal(helper.mode, mode, String(access));
    assert.equal(helper.approval, approval, String(access));
    assert.equal(asked[0].thread.mode, mode);
    assert.equal(helper.cwd, dir);
    assert.equal(helper.web, host.getThread(id)!.web);
    assert.deepEqual(helper.scope, { kind: "workspace", ref: dir });
    await host.runHelper(id, { task: "inspect again", thread: helper.id, mode: "full" });
    assert.equal(host.getThread(helper.id)!.approval, approval);
  }
});

test("a helper of a thread in a worktree keeps the user's folder as its workspace", async () => {
  host.setPrefs({ helpers: true });
  const id = host.createThread({ provider: "codex", mode: "code", approval: "full", cwd: dir, scope: { kind: "global", ref: null } }).id;
  const tree = path.join(dir, "worktrees", "helper-tree");
  fs.mkdirSync(tree, { recursive: true });
  const threads = (host as unknown as { threads: Map<string, Thread> }).threads;
  threads.set(id, { ...threads.get(id)!, cwd: tree, useWorktree: true, worktree: { home: dir, repo: dir, path: tree, branch: "agent/helper-tree", base: "master", baseCommit: "abc", links: [], createdAt: Date.now() } });
  const result = await host.runHelper(id, { task: "inspect the files", title: "Inspect files", provider: "pi" });
  const helper = host.getThread(String(result.thread))!;
  assert.equal(helper.cwd, tree);
  assert.equal(helper.worktree?.path, tree);
  assert.deepEqual(helper.scope, { kind: "workspace", ref: dir });
});

test("helpers may not exceed their parent's rung", async () => {
  host.setPrefs({ helpers: true });
  const rungs = ["readonly", "board", "edits", "auto", "full"] as const;
  for (const [at, approval] of rungs.entries()) {
    const id = host.createThread({ provider: "codex", approval, cwd: null, scope: { kind: "global", ref: null } }).id;
    for (const requested of rungs.slice(at + 1)) {
      await assert.rejects(host.runHelper(id, { task: "inspect", title: "Inspect files", provider: "pi", mode: requested }), /may not exceed this thread's/);
    }
    for (const requested of ["invalid", ""]) {
      await assert.rejects(host.runHelper(id, { task: "inspect", title: "Inspect files", provider: "pi", mode: requested }), /Unknown helper access/);
    }
  }
  const board = host.createThread({ provider: "codex", approval: "board", cwd: null, scope: { kind: "global", ref: null }, helpersAllowed: true }).id;
  // A Board thread's helper works on the same pages.
  const result = await host.runHelper(board, { task: "inspect the pages", title: "Inspect files", provider: "pi", mode: "board" });
  assert.equal(host.getThread(String(result.thread))!.mode, "board");
  assert.deepEqual(host.getThread(String(result.thread))!.scope, { kind: "global", ref: null });
});

test("a helper's rung is rechecked if the parent changes while approval is pending", async () => {
  host.setPrefs({ helpers: true });
  const id = host.createThread({ provider: "codex", approval: "edits", cwd: null, scope: { kind: "workspace", ref: null } }).id;
  running(id);
  const internals = host as unknown as Internals;
  const rejected = assert.rejects(host.runHelper(id, { task: "inspect", title: "Inspect files", provider: "pi", mode: "edits" }), /may not exceed this thread's board rung/);
  const request = await approvalFor(id);
  host.updateThread(id, { approval: "board" });
  host.resolveApproval(request.itemId, "once");
  await rejected;
  internals.runs.delete(id);
});

test("a helper cannot start helpers, and only its own thread can send it on", async () => {
  host.setPrefs({ helpers: true });
  const id = parent();
  const { thread } = await host.runHelper(id, { task: "one", title: "Inspect files", provider: "pi" });
  await assert.rejects(host.runHelper(String(thread), { task: "two", title: "Inspect files", provider: "pi" }), /cannot start helpers/);
  await assert.rejects(host.runHelper(parent(), { task: "two", thread: String(thread) }), /No helper/);
});

test("an unknown or ambiguous model lists the models to pick from", async () => {
  host.setPrefs({ helpers: true });
  await assert.rejects(host.runHelper(parent(), { task: "x", title: "Inspect files", provider: "pi", model: "qwen" }), /matches several pi models\. Pick one of: local\/qwen-coder, local\/qwen-small/);
  await assert.rejects(host.runHelper(parent(), { task: "x", title: "Inspect files", provider: "pi", model: "gpt" }), /No pi model "gpt"/);
  await assert.rejects(host.runHelper(parent(), { task: "x", title: "Inspect files", provider: "nope" }), /provider is required/);
  const { providers } = await host.helperModels(parent(), "pi");
  assert.deepEqual((providers[0].models as Array<{ id: string }>).map((m) => m.id), ["local/qwen-coder", "local/qwen-small"]);
});

test("without full access the user is asked first, and Allow for this thread sticks", async (t) => {
  host.setPrefs({ helpers: true });
  // Approval follows provider discovery, which can take longer than the old 10 ms answer timer.
  const provider = (host as unknown as Internals).providers.pi as { status: () => Promise<unknown> };
  const status = provider.status;
  t.mock.method(provider, "status", async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return status();
  });
  const id = parent("edits");
  await assert.rejects(host.runHelper(id, { task: "x", title: "Inspect files", provider: "pi" }), /cannot be asked/);
  running(id);
  const denied = assert.rejects(host.runHelper(id, { task: "x", title: "Inspect files", provider: "pi" }), /denied the helper/);
  host.resolveApproval((await approvalFor(id)).itemId, "deny");
  await denied;
  const allowed = host.runHelper(id, { task: "x", title: "Inspect files", provider: "pi" });
  host.resolveApproval((await approvalFor(id)).itemId, "thread");
  assert.equal((await allowed).status, "done");
  assert.equal(host.getThread(id)?.helpersAllowed, true);
  assert.equal((await host.runHelper(id, { task: "y", title: "Inspect files", provider: "pi" })).status, "done");
  // The permissions list takes it back.
  assert.deepEqual(host.listThreads().find((t) => t.id === id)?.grants, [{ kind: "helpers", key: "helpers", label: "Start helpers without asking" }]);
  assert.equal(host.revokeGrant(id, "helpers").grants, undefined);
  assert.equal(host.getThread(id)?.helpersAllowed, undefined);
});

test("a thread made with helpers allowed (a board worker) is not asked", async () => {
  host.setPrefs({ helpers: true });
  const id = host.createThread({ provider: "codex", mode: "board", approval: "board", cwd: null, scope: { kind: "global", ref: null }, helpersAllowed: true }).id;
  assert.equal((await host.runHelper(id, { task: "x", title: "Inspect files", provider: "pi" })).status, "done");
});

test("the caller's agent_run call names its helper thread", async () => {
  host.setPrefs({ helpers: true });
  const id = parent();
  running(id);
  const internals = host as unknown as Internals & { addItem: (thread: string, turn: string, body: unknown) => { helper?: string } };
  const call = (task: string) => internals.addItem(id, `tu_${id}`, { kind: "tool", toolId: `c_${task}`, name: "mcp__scribe__agent_run", tool: "mcp", title: "Scribe: agent_run", input: { task, title: "Inspect files", provider: "pi" }, status: "running", startedAt: Date.now() });
  const one = call("one");
  const two = call("two");
  const second = await host.runHelper(id, { task: "two", title: "Inspect files", provider: "pi" });
  assert.equal(two.helper, second.thread);
  assert.equal(one.helper, undefined);
  const first = await host.runHelper(id, { task: "one", title: "Inspect files", provider: "pi" });
  assert.equal(one.helper, first.thread);
  internals.runs.delete(id);
});

test("a working helper is steered by a follow-up, and thread with no task waits for its report", async () => {
  host.setPrefs({ helpers: true });
  const id = parent();
  const { thread } = await host.runHelper(id, { task: "one", title: "Inspect files", provider: "pi" });
  // Idle: its last report again.
  assert.equal((await host.runHelper(id, { thread: String(thread), task: "" })).reply, "did: one");
  hanging = true;
  try {
    const first = host.runHelper(id, { task: "long", thread: String(thread) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // A follow-up while it works steers its turn; one more while that is pending waits behind the turn.
    const steer = await host.runHelper(id, { task: "more", thread: String(thread), background: true });
    assert.equal(steer.status, "steered");
    assert.ok(steered.at(-1)?.includes("more"));
    assert.equal((await host.runHelper(id, { task: "later", thread: String(thread), background: true })).status, "queued");
    const waiting = host.runHelper(id, { thread: String(thread), task: "" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await host.cancel(String(thread));
    assert.equal((await first).status, "cancelled");
    assert.equal((await waiting).status, "cancelled");
  } finally {
    hanging = false;
  }
  await assert.rejects(host.runHelper(id, { task: "" }), /task is required/);
});

test("archiving or deleting a thread takes its helpers along", async () => {
  host.setPrefs({ helpers: true });
  const id = parent();
  const { thread } = await host.runHelper(id, { task: "one", title: "Inspect files", provider: "pi" });
  host.updateThread(id, { archived: true });
  assert.equal(host.getThread(String(thread))?.archived, true);
  host.updateThread(id, { archived: false });
  assert.equal(host.getThread(String(thread))?.archived, false);
  await host.deleteThread(id);
  assert.equal(host.getThread(String(thread)), null);
});

test("stopping the caller stops its helper", async () => {
  host.setPrefs({ helpers: true });
  const id = parent();
  hanging = true;
  try {
    const call = host.runHelper(id, { task: "long", title: "Inspect files", provider: "pi" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await host.cancel(id);
    const report = await call;
    assert.equal(report.status, "cancelled");
    assert.equal(report.partialReply, true);
    assert.deepEqual(report.recentTools, []);
    assert.match(String(report.note), /stopped before completing its turn/);
  } finally {
    hanging = false;
  }
});

test("a thread allows ten working helpers and refuses an eleventh", async () => {
  host.setPrefs({ helpers: true });
  const id = parent();
  hanging = true;
  try {
    for (let i = 0; i < 10; i++) {
      const result = await host.runHelper(id, { task: `helper ${i}`, title: "Inspect files", provider: "pi", background: true });
      assert.equal(result.status, "running");
    }
    await assert.rejects(
      host.runHelper(id, { task: "one too many", title: "Inspect files", provider: "pi", background: true }),
      /already has 10 helpers working/
    );
  } finally {
    await host.cancel(id);
    hanging = false;
  }
});

test("background launches overlap and steering or an aborted wait keeps helpers running", async () => {
  host.setPrefs({ helpers: true });
  const id = parent();
  hanging = true;
  const helpers: string[] = [];
  try {
    // Sequential launch calls must return even though none of the helpers has finished.
    for (const task of ["alpha", "beta", "gamma"]) {
      const result = await host.runHelper(id, { task, title: "Inspect files", provider: "pi", background: true });
      assert.equal(result.status, "running");
      helpers.push(String(result.thread));
    }
    for (let i = 0; i < 100 && !helpers.every((helper) => helperWaits.has(helper)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(helpers.every((helper) => helperWaits.has(helper)), "all three sessions run concurrently");
    const info = host.runInfo(id);
    assert.ok(info.exists);
    if (info.exists) {
      assert.equal(info.usage?.helpers?.threads, 3);
      assert.equal(info.usage?.inputTokens, 90, "live reported usage is included without waiting");
      assert.equal(info.usage?.outputTokens, 15);
    }
    await host.cancel(id, { keepQueue: true });
    assert.ok(helpers.every((helper) => helperWaits.has(helper)));
    const abort = new AbortController();
    const waiting = host.runHelper(id, { task: "", thread: helpers[0], signal: abort.signal });
    const rejected = assert.rejects(waiting, /cancelled/);
    abort.abort();
    await rejected;
    assert.ok(helpers.every((helper) => helperWaits.has(helper)), "disconnect only cancels the caller's wait");
    await assert.rejects(host.runHelper(parent(), { task: "", thread: helpers[0], stop: true }), /No helper/);
    const stopped = await host.runHelper(id, { task: "", thread: helpers[0], stop: true });
    assert.equal(stopped.status, "cancelled");
    assert.ok(helpers.slice(1).every((helper) => helperWaits.has(helper)), "stopping one helper leaves the others working");
    const reports = helpers.map((thread) => host.runHelper(id, { thread, task: "" }));
    await host.cancel(id);
    assert.deepEqual((await Promise.all(reports)).map((report) => report.status), ["cancelled", "cancelled", "cancelled"]);
  } finally {
    for (const helper of helpers) await host.cancel(helper);
    hanging = false;
  }
});

test("a tainted thread is asked before an untrusted helper, even with full access", async () => {
  host.setPrefs({ helpers: true });
  const id = parent("full");
  const thread = host.getThread(id)!;
  thread.tainted = true;
  await assert.rejects(host.runHelper(id, { task: "x", title: "Inspect files", provider: "pi" }), /Trusted only content/);
  running(id);
  const denied = assert.rejects(host.runHelper(id, { task: "x", title: "Inspect files", provider: "pi" }), /kept this thread's trusted content/);
  host.resolveApproval((await approvalFor(id)).itemId, "deny");
  await denied;
  const allowed = host.runHelper(id, { task: "x", title: "Inspect files", provider: "pi" });
  host.resolveApproval((await approvalFor(id)).itemId, "allow");
  assert.equal((await allowed).status, "done");
  (host as unknown as Internals).runs.delete(id);
});
