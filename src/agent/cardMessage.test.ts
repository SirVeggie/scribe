import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import type { SteerInput } from "./providers/provider.js";
import type { Thread } from "./types.js";

// The host keeps its data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-card-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
const { createWorktree, discardWorktree } = await import("./worktree.js");

let host: InstanceType<typeof AgentHost>;

before(() => {
  store.load();
  host = new AgentHost(() => {});
});

after(() => {
  host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const card = { num: 12, title: "Fix it", board: "Todo", boardKey: "scribe:todo" };

/** A thread with a running turn, and a session that steers when `steers` (it records what it got). */
function runningThread(steers: boolean): { id: string; steered: SteerInput[] } {
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null } });
  const turn = { id: `tu_${thread.id}`, threadId: thread.id, seq: 1, status: "running", model: "m", effort: null, mode: thread.mode, startedAt: Date.now() };
  const internals = host as unknown as { runs: Map<string, unknown>; turns: Map<string, unknown[]>; sessions: Map<string, unknown> };
  internals.turns.get(thread.id)?.push(turn);
  internals.runs.set(thread.id, { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), repo: null, cancelled: false, usage: {}, steer: null, hooks: { lastUser: "", dock: false, called: new Set(), gated: new Set(), approved: new Set(), waiting: new Map(), told: new Set(), earlyItem: null } });
  const steered: SteerInput[] = [];
  const dispose = () => {};
  internals.sessions.set(thread.id, steers ? { dispose, steer: (input: SteerInput) => (steered.push(input), `s${steered.length}`) } : { dispose });
  return { id: thread.id, steered };
}

const userItems = (threadId: string) => (host.threadDetail(threadId)?.items ?? []).filter((it) => it.kind === "user");

test("a card comment is not sent to an idle thread", () => {
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null } });
  assert.deepEqual(host.cardMessage(thread.id, card, "please also add tests"), { delivered: null });
  assert.equal(userItems(thread.id).length, 0);
});

test("a card comment is steered into the running turn, worded as the board's", () => {
  const { id, steered } = runningThread(true);
  assert.deepEqual(host.cardMessage(id, card, "please also add tests"), { delivered: "steered" });
  assert.equal(steered.length, 1);
  assert.match(steered[0].text, /A new comment on card #12 "Fix it" of the Kanban board "Todo" \(scribe:todo\)/);
  assert.match(steered[0].text, /<card_comment>\nplease also add tests\n<\/card_comment>$/);
  const [item] = userItems(id);
  assert.ok(item && item.kind === "user");
  assert.equal(item.text, "please also add tests");
  assert.equal(item.steer, "waiting");
  assert.deepEqual(item.card, { num: 12, title: "Fix it" });
});

test("a card comment queues when the provider cannot steer, or something else is queued first", () => {
  const plain = runningThread(false);
  assert.deepEqual(host.cardMessage(plain.id, card, "one"), { delivered: "queued" });
  const busy = runningThread(true);
  host.send(busy.id, { text: "typed first" });
  assert.deepEqual(host.cardMessage(busy.id, card, "two"), { delivered: "queued" });
  assert.equal(busy.steered.length, 0);
});

test("Continue sends the host's own note, never steered", () => {
  const { id, steered } = runningThread(true);
  assert.deepEqual(host.cardMessage(id, { ...card, resume: true }, "ignored"), { delivered: "queued" });
  assert.equal(steered.length, 0);
  const [item] = userItems(id);
  assert.ok(item && item.kind === "user");
  assert.match(item.text, /^Continue the work on card #12\./);
  assert.deepEqual(item.card, { num: 12, title: "Fix it", resume: true });
});

test("Continue after a form's reply points the agent at the answer on the card", () => {
  const { id } = runningThread(false);
  assert.deepEqual(host.cardMessage(id, { ...card, resume: true, reply: "scribe:card-12-form" }, "ignored"), { delivered: "queued" });
  const [item] = userItems(id);
  assert.ok(item && item.kind === "user");
  assert.match(item.text, /^Continue the work on card #12 with the user's answer: it is the card's newest comment\./);
  assert.deepEqual(item.card, { num: 12, title: "Fix it", resume: true, reply: "scribe:card-12-form" });
});

test("worker continuation registers a new run before sending into the same page thread", async () => {
  const calls: string[] = [];
  const run = { tag: "worker:sol", data: { card: 12 }, merge: true, resumePrompt: "go on" };
  const fake = {
    threads: new Map([["old", { id: "old", scope: { kind: "page", ref: "board" } }]]),
    runInfo: () => ({ exists: true, running: false, run: { phase: "ended" } }),
    watchPageThread: (id: string, input: any) => { calls.push(`watch:${id}`); assert.equal(input.tag, run.tag); assert.ok(input.after > 0); },
    send: (id: string, msg: any) => { calls.push(`send:${id}`); assert.equal(msg.text, "Read the card again"); },
  };
  const result = await host.launchPageThread.call(fake as any, "board", "Read the card again", {} as any, run, "old");
  assert.equal(result, "old");
  assert.deepEqual(calls, ["watch:old", "send:old"]);
});

test("worker continuation rejects busy chats and falls back for missing or foreign chats", async () => {
  for (const previous of [undefined, { id: "old", scope: { kind: "page", ref: "other" } }, { id: "old", archived: true, scope: { kind: "page", ref: "board" } }]) {
    const fake = {
      threads: new Map(previous ? [["old", previous]] : []),
      providerStatus: async () => { throw new Error("fresh launch reached"); },
    };
    await assert.rejects(host.launchPageThread.call(fake as any, "board", "continue", {} as any, {} as any, "old"), /fresh launch reached/);
  }
  const fake = {
    threads: new Map([["old", { id: "old", scope: { kind: "page", ref: "board" } }]]),
    runInfo: () => ({ exists: true, running: true }),
  };
  await assert.rejects(host.launchPageThread.call(fake as any, "board", "continue", {} as any, {} as any, "old"), /still busy/);
});

test("older boards' direct Continue calls persist requests without sending or claiming", () => {
  const { tab } = store.openFromTemplate("builtin:kanban", { title: "Deferred", preset: "agent" });
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "page", ref: tab.id } });
  store.writeState(tab.id, { ops: [
    { op: "set", path: "columns", value: [{ id: "todo" }, { id: "ready", role: "agent" }] },
    { op: "set", path: "settings", value: { workers: { sol: { name: "Sol" } } } },
    { op: "set", path: "cards", value: [{ id: "pending", num: 12, col: "todo", title: "Blocked", assignee: "Sol", thread: thread.id, threadAssignee: "Sol", blockedBy: ["other"] }] },
  ] });
  assert.deepEqual(host.cardMessage(thread.id, { ...card, resume: true }, ""), { delivered: null, deferred: true });
  const saved = (store.get(tab.id)!.state.cards as any[])[0];
  assert.ok(saved.continuation);
  assert.equal(saved.claim, undefined);
  assert.equal(saved.col, "ready");
  assert.equal(userItems(thread.id).length, 0);
});

test("accepted continuation retries return the existing run without another message", async () => {
  const run = { tag: "worker:sol", data: { continuation: "request" }, merge: true, resumePrompt: "go on" };
  let sends = 0;
  const fake = {
    threads: new Map([["old", { id: "old", scope: { kind: "page", ref: "board" } }]]),
    runInfo: () => ({ exists: true, running: true, run: { phase: "running", data: run.data } }),
    send: () => { sends++; },
  };
  assert.equal(await host.launchPageThread.call(fake as any, "board", "go", {} as any, run, "old"), "old");
  assert.equal(sends, 0);
});

test("dispatch validation can stop continuation before any message is sent", async () => {
  let sent = false;
  const fake = {
    threads: new Map([["old", { id: "old", scope: { kind: "page", ref: "board" } }]]),
    runInfo: () => ({ exists: true, running: false }),
    send: () => { sent = true; },
    watchPageThread: () => { throw new Error("must not watch"); },
  };
  await assert.rejects(host.launchPageThread.call(fake as any, "board", "go", {} as any, { data: {} } as any, "old", () => { throw new Error("conditions changed"); }), /conditions changed/);
  assert.equal(sent, false);
});

/** Reproduce a page's start → watch → send → worker_claim sequence without calling a provider. */
async function retryFixture() {
  const repo = fs.mkdtempSync(path.join(dir, "retry-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "tracked.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const home = path.join(repo, "src");
  const { tab } = store.openFromTemplate("builtin:kanban", { title: "Retry", preset: "agent" });
  const settings = { provider: "pi" as const, mode: "code" as const, cwd: home, useWorktree: true, scope: { kind: "page" as const, ref: tab.id } };
  const earlier = host.createThread(settings, { remember: false });
  const made = await createWorktree(home, repo, "Failed worker");
  const internals = host as unknown as {
    threads: Map<string, Thread>;
    status: Map<string, string>;
    db: { listThreads(): Thread[]; saveThread(thread: Thread): void };
    makeWorktree(id: string, turn: string): Promise<{ thread: Thread; reopened: string }>;
  };
  Object.assign(internals.threads.get(earlier.id)!, { worktree: made.worktree, cwd: made.cwd });
  internals.db.saveThread(internals.threads.get(earlier.id)!);
  store.writeState(tab.id, { ops: [
    { op: "set", path: "cards", value: [{ id: "retry", num: 12, col: "ready", title: "Finish", assignee: "Sol", thread: earlier.id, threadAssignee: "Sol" }] },
  ] });
  const replacement = host.createThread(settings, { remember: false });
  const run = { tag: "solo:sol", data: { worker: "sol", card: 12 }, merge: true, resumePrompt: "go on" };
  return { repo, home, tab, earlier, replacement, run, wt: made.worktree, internals, git };
}

test("a replacement worker reuses the card's worktree with committed, staged and untracked work (#702)", async () => {
  const f = await retryFixture();
  try {
    execFileSync("git", ["commit", "--allow-empty", "-qm", "unfinished attempt"], { cwd: f.wt.path });
    fs.writeFileSync(path.join(f.wt.path, "src", "tracked.txt"), "unfinished edit\n");
    execFileSync("git", ["add", "src/tracked.txt"], { cwd: f.wt.path });
    fs.writeFileSync(path.join(f.wt.path, "new.txt"), "untracked work\n");
    const before = f.git("worktree", "list", "--porcelain");
    host.watchPageThread(f.replacement.id, f.run);
    assert.equal(f.internals.threads.get(f.replacement.id)?.retryWorktreeFrom, f.earlier.id);
    const persisted = f.internals.db.listThreads().find((t) => t.id === f.replacement.id)!;
    assert.equal(persisted.retryWorktreeFrom, f.earlier.id, "the old holder survives a daemon restart");
    f.internals.threads.set(f.replacement.id, persisted);
    // worker_claim now points the card at the replacement; recovery must remember the old holder.
    store.writeState(f.tab.id, { ops: [{ op: "set", path: "cards/id=retry/thread", value: f.replacement.id }] });
    const result = await f.internals.makeWorktree(f.replacement.id, "retry-turn");
    assert.equal(result.thread.worktree?.path, f.wt.path);
    assert.equal(result.thread.worktree?.branch, f.wt.branch);
    assert.equal(result.thread.cwd, path.join(f.wt.path, "src"));
    assert.equal(result.thread.retryWorktreeFrom, undefined);
    assert.equal(f.git("worktree", "list", "--porcelain"), before, "no second worktree is created");
    assert.equal(fs.readFileSync(path.join(f.wt.path, "src", "tracked.txt"), "utf8"), "unfinished edit\n");
    assert.equal(fs.readFileSync(path.join(f.wt.path, "new.txt"), "utf8"), "untracked work\n");
    assert.match(execFileSync("git", ["diff", "--cached"], { cwd: f.wt.path, encoding: "utf8" }), /unfinished edit/);
    assert.match(result.reopened, /Reusing the earlier chat's worktree/);
    assert.ok(result.reopened.includes(f.wt.path));
    assert.ok(result.reopened.includes(f.wt.branch));
    assert.match(result.reopened, /1 unmerged commit\(s\) and 2 uncommitted file\(s\)/);
    assert.match(result.reopened, /src\/tracked.txt/);
    assert.match(result.reopened, /new.txt/);
    execFileSync("git", ["add", "-A"], { cwd: f.wt.path });
    execFileSync("git", ["commit", "-qm", "finish recovered work"], { cwd: f.wt.path });
    await host.finishWorktree(f.replacement.id, "merge");
    assert.equal(fs.readFileSync(path.join(f.repo, "src", "tracked.txt"), "utf8"), "unfinished edit\n");
    assert.equal(fs.readFileSync(path.join(f.repo, "new.txt"), "utf8"), "untracked work\n");
    assert.equal(f.internals.threads.get(f.earlier.id)?.worktree?.closed?.how, "left");
    assert.equal(f.internals.threads.get(f.replacement.id)?.worktree?.closed?.how, "merged");
    assert.equal(fs.existsSync(f.wt.path), false, "merge closes the shared worktree for both chats");
  } finally {
    if (fs.existsSync(f.wt.path)) await discardWorktree(f.wt);
  }
});

test("worker recovery rejects an earlier chat or shared helper that is still busy", async () => {
  const f = await retryFixture();
  try {
    fs.writeFileSync(path.join(f.wt.path, "unfinished.txt"), "keep\n");
    host.watchPageThread(f.replacement.id, f.run);
    const before = f.git("worktree", "list", "--porcelain");
    f.internals.status.set(f.earlier.id, "running");
    await assert.rejects(f.internals.makeWorktree(f.replacement.id, "retry-turn"), /still in use/);
    f.internals.status.set(f.earlier.id, "idle");
    const helper = host.createThread({ provider: "pi", mode: "code", cwd: f.wt.path });
    Object.assign(f.internals.threads.get(helper.id)!, { worktree: { ...f.wt } });
    f.internals.status.set(helper.id, "waiting");
    await assert.rejects(f.internals.makeWorktree(f.replacement.id, "retry-turn"), /still in use/);
    f.internals.status.set(helper.id, "idle");
    assert.equal(f.git("worktree", "list", "--porcelain"), before);
    assert.equal(fs.readFileSync(path.join(f.wt.path, "unfinished.txt"), "utf8"), "keep\n");
    assert.equal((await f.internals.makeWorktree(f.replacement.id, "retry-turn")).thread.worktree?.path, f.wt.path);
  } finally {
    f.internals.status.set(f.earlier.id, "idle");
    await discardWorktree(f.wt);
  }
});

test("recovery stays within the board and workspace and excludes Ask chats", async () => {
  const f = await retryFixture();
  try {
    const original = f.internals.threads.get(f.earlier.id)!;
    const target = f.internals.threads.get(f.replacement.id)!;
    for (const scenario of ["foreign page", "other workspace", "Ask", "ordinary run"]) {
      const scope = original.scope;
      const cwd = target.cwd;
      if (scenario === "foreign page") original.scope = { kind: "page", ref: "elsewhere" };
      if (scenario === "other workspace") target.cwd = f.repo;
      const input = scenario === "Ask" ? { ...f.run, data: { ...f.run.data, ask: true } }
        : scenario === "ordinary run" ? { ...f.run, tag: "custom" } : f.run;
      host.watchPageThread(f.replacement.id, input);
      assert.equal(target.retryWorktreeFrom, undefined, scenario);
      original.scope = scope;
      target.cwd = cwd;
    }
  } finally {
    await discardWorktree(f.wt);
  }
});
