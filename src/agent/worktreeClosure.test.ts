import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { RunSink, TurnInput, TurnResult } from "./providers/provider.js";
import type { Thread, ThreadWorktree } from "./types.js";

// A closure (Merge, Leave, cleanup) holds its worktree folder while Git removes it (#736).
const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-closure-"));
process.env.SCRIBE_HOME = path.join(root, "home");
process.env.SCRIBE_FAKE_AGENTS = "1";
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
const { commitAll, discardWorktree } = await import("./worktree.js");

const repo = path.join(root, "repo");
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

type Internals = {
  fakes: Record<string, unknown>;
  threads: Map<string, Thread>;
  runs: Map<string, unknown>;
  queues: Map<string, unknown[]>;
  expireWorktree(threadId: string, wt: ThreadWorktree, landed?: boolean): Promise<void>;
};

let host: InstanceType<typeof AgentHost>;
const internals = () => host as unknown as Internals;
/** What each turn's session got: its prompt, and whether its worktree folder was there. */
const turns: Array<{ text: string; present: boolean }> = [];

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const idle = (id: string) => until(() => !internals().runs.has(id) && !internals().queues.get(id)?.length, "the turn to end");
const open = (id: string) => internals().threads.get(id)!.worktree!;

before(() => {
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(repo, "src", "a.txt"), "one\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "init");
  store.load();
  host = new AgentHost(() => {});
  let current: Thread | null = null;
  internals().fakes.codex = {
    id: "codex",
    label: "Codex",
    status: async () => ({ id: "codex", label: "Codex", available: true }),
    models: async () => [],
    complete: async () => "",
    prewarm: () => {},
    dispose: () => {},
    createSession: (thread: Thread) => ({
      warm: async () => {},
      update: (next: Thread) => { current = next; },
      commands: async () => [],
      dispose: () => {},
      cancel: async () => {},
      run: async (input: TurnInput, _sink: RunSink): Promise<TurnResult> => {
        const wt = (current ?? thread).worktree;
        turns.push({ text: input.text, present: Boolean(wt && !wt.closed && fs.existsSync(path.join(wt.path, ".git"))) });
        return { status: "done" };
      },
    }),
  };
});

after(() => {
  host.dispose();
  store.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a turn, a second Merge and a cleanup wait for a pending worktree removal, then go on from what it left (#736)", async () => {
  const thread = host.createThread({ provider: "codex", mode: "code", approval: "full", cwd: repo, useWorktree: true, scope: { kind: "global", ref: null } });
  host.send(thread.id, { text: "first" });
  await idle(thread.id);
  const first = open(thread.id);
  assert.ok(first && !first.closed && fs.existsSync(first.path), "the first turn opened a worktree");
  const fork = host.fork(thread.id);
  assert.equal(open(fork.id).path, first.path, "the fork shares the folder");
  fs.writeFileSync(path.join(first.path, "work.txt"), "done\n");
  await commitAll(first, "work");

  // The Merge is now pending in Git. Everything below starts before it settles.
  const merge = host.finishWorktree(thread.id, "merge");
  const again = host.finishWorktree(fork.id, "leave");
  const cleanup = internals().expireWorktree(thread.id, first);
  host.send(thread.id, { text: "second" });
  assert.ok(internals().runs.has(thread.id), "the turn has started and waits");

  const result = await merge;
  assert.match(result.message, /Merged 1 commit/);
  await assert.rejects(again, /no open worktree/, "the fork's Leave sees the folder already closed by the Merge");
  await cleanup;
  await idle(thread.id);

  const second = turns.at(-1)!;
  assert.match(second.text, /was merged into main, and its worktree was removed/, "the waiting turn reopened a worktree from the base");
  assert.ok(second.present, "it ran in an open worktree that is not being removed");
  const reopened = open(thread.id);
  assert.ok(!reopened.closed && fs.existsSync(reopened.path));
  assert.notEqual(reopened.createdAt, first.createdAt);
  assert.equal(fs.readFileSync(path.join(reopened.path, "work.txt"), "utf8"), "done\n", "the new worktree starts from the merged base");
  assert.equal(internals().threads.get(fork.id)?.worktree?.closed?.how, "left");
  assert.equal(internals().threads.get(fork.id)?.useWorktree, false);

  // The cleanup that waited checked the worktree it was given, not the one opened since in its folder.
  await internals().expireWorktree(thread.id, first);
  assert.ok(fs.existsSync(reopened.path), "a stale cleanup leaves the reopened worktree alone");
  await discardWorktree(reopened);
});

test("a turn waiting on a failed removal goes on in the worktree that stayed open (#736)", async (t) => {
  const thread = host.createThread({ provider: "codex", mode: "code", approval: "full", cwd: repo, useWorktree: true, scope: { kind: "global", ref: null } });
  host.send(thread.id, { text: "first" });
  await idle(thread.id);
  const wt = open(thread.id);
  fs.writeFileSync(path.join(wt.path, "left.txt"), "wip\n");
  const rm = fs.rmSync;
  // Leave commits the work, then Git's removal and the fallback both fail.
  const blocked = t.mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => {
    if (args[0] === wt.path) throw new Error("EPERM: folder still in use");
    return rm(...args);
  });
  const leave = host.finishWorktree(thread.id, "leave");
  host.send(thread.id, { text: "second" });
  // Make git worktree remove fail too by holding the worktree locked.
  sh(repo, "worktree", "lock", wt.path);
  try {
    await assert.rejects(leave, /Could not remove the worktree folder/);
  } finally {
    sh(repo, "worktree", "unlock", wt.path);
    blocked.mock.restore();
  }
  await idle(thread.id);
  const second = turns.at(-1)!;
  assert.equal(second.text.includes("worktree was removed"), false);
  assert.ok(second.present, "the turn ran in the worktree that is still open");
  assert.equal(open(thread.id).closed, undefined);
  await discardWorktree(open(thread.id));
});
