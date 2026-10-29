import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { diffPatch, diffTrees, revertTrees, snapshotTree } from "./git.js";
import { commitAll, createWorktree, discardWorktree, dropBranchIfEmpty, headCommit, mergeWorktree, removeWorktree, reopenWorktree, resetHead, unlinkOrphanedWorktrees, worktreeProgress, worktreeRemaining, worktreeStatus } from "./worktree.js";

let root = "";
let repo = "";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-wt-"));
  process.env.SCRIBE_HOME = path.join(root, "home");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(repo, "src", "a.txt"), "one\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "init");
  fs.mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "x");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("a worktree branches from HEAD, links node_modules, and keeps the link out of git", async () => {
  fs.writeFileSync(path.join(repo, "src", "a.txt"), "dirty\n");
  const made = await createWorktree(path.join(repo, "src"), repo, "Fix the dropdown!");
  sh(repo, "checkout", "-q", "--", "src/a.txt");
  const wt = made.worktree;
  assert.equal(wt.branch, "agent/fix-the-dropdown");
  assert.equal(wt.base, "main");
  assert.equal(made.cwd, path.join(wt.path, "src"));
  assert.ok(wt.path.startsWith(path.join(root, "home", "worktrees")));
  assert.deepEqual(wt.links, ["node_modules"]);
  assert.ok(fs.existsSync(path.join(wt.path, "node_modules", "dep", "index.js")));
  assert.equal(made.notes.length, 1, "warns that uncommitted main-checkout changes are not carried over");
  assert.equal(fs.readFileSync(path.join(wt.path, "src", "a.txt"), "utf8"), "one\n");
  assert.equal(sh(wt.path, "status", "--porcelain"), "");
  const status = await worktreeStatus(wt);
  assert.deepEqual(status.dirty, []);
  assert.equal(status.ahead, 0);

  // A second thread with the same title gets its own branch and folder.
  const second = await createWorktree(repo, repo, "Fix the dropdown!");
  assert.equal(second.worktree.branch, "agent/fix-the-dropdown-2");
  await removeWorktree(second.worktree);
  assert.ok(await dropBranchIfEmpty(second.worktree));

  // Work, then merge into main.
  fs.writeFileSync(path.join(wt.path, "src", "a.txt"), "two\n");
  assert.deepEqual(await worktreeProgress(wt), { ahead: 0, dirty: true });
  await assert.rejects(mergeWorktree(wt), /uncommitted/);
  assert.ok(await commitAll(wt, "change a"));
  assert.deepEqual(await worktreeProgress(wt), { ahead: 1, dirty: false });
  assert.deepEqual(await mergeWorktree(wt), { commits: 1, base: "main" });
  assert.deepEqual(await worktreeProgress(wt), { ahead: 0, dirty: false }, "merged commits stop counting against the original starting commit (#709)");
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "two\n");
  await removeWorktree(wt);
  assert.ok(!fs.existsSync(wt.path));
  assert.ok(fs.existsSync(path.join(repo, "node_modules", "dep", "index.js")), "removing the worktree leaves the linked folder alone");
  assert.ok(await dropBranchIfEmpty(wt));
});

test("discard removes committed and uncommitted work without touching the main checkout or linked dependencies", async () => {
  const base = sh(repo, "rev-parse", "HEAD");
  const { worktree: wt } = await createWorktree(repo, repo, "Discard me");
  fs.writeFileSync(path.join(wt.path, "committed.txt"), "discard\n");
  await commitAll(wt, "work to discard");
  fs.writeFileSync(path.join(wt.path, "untracked.txt"), "discard too\n");
  fs.writeFileSync(path.join(wt.path, "src", "a.txt"), "dirty\n");
  assert.equal(await discardWorktree(wt), true);
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(sh(repo, "branch", "--list", wt.branch), "");
  assert.equal(sh(repo, "rev-parse", "HEAD"), base);
  assert.equal(fs.existsSync(path.join(repo, "committed.txt")), false);
  assert.equal(fs.readFileSync(path.join(repo, "node_modules", "dep", "index.js"), "utf8"), "x");
});

test("thread and turn diffs survive commits, merging and worktree removal (#881)", async () => {
  const { AgentHost } = await import("./host.js");
  const { worktree: wt } = await createWorktree(repo, repo, "Saved thread diff");
  const beforeTree = (await snapshotTree(wt.path))!;
  fs.writeFileSync(path.join(wt.path, "review.txt"), "keep this diff\n");
  const afterTree = (await snapshotTree(wt.path))!;
  const files = await diffTrees(wt.path, beforeTree, afterTree);
  const turn = { id: "turn", repo: wt.path, beforeTree, afterTree, files };
  const thread = { worktree: wt };
  const host = Object.assign(Object.create(AgentHost.prototype), {
    threads: new Map([["thread", thread]]), runs: new Map(), loadTurns: () => [turn],
  });
  const check = async () => {
    for (const turnId of [undefined, turn.id]) {
      const changes = await host.changes("thread", turnId);
      assert.equal(changes.repo, repo, "saved diffs use the surviving shared repository");
      assert.deepEqual(changes.files, files);
      assert.match((await host.patch("thread", turnId)).patch, /\+keep this diff/);
    }
    assert.equal(turn.repo, wt.path, "the revert target stays in the original worktree");
  };
  await check();
  await commitAll(wt, "save review changes");
  assert.equal(sh(wt.path, "status", "--porcelain"), "");
  await check();
  await mergeWorktree(wt);
  await removeWorktree(wt);
  await dropBranchIfEmpty(wt);
  thread.worktree = { ...wt, closed: { how: "merged", at: Date.now() } };
  await check();
  // A leftover empty directory from failed Windows cleanup is not a repository either.
  fs.mkdirSync(wt.path);
  await check();
  await removeWorktree(wt);
});

test("unavailable repositories and missing snapshot objects report diff errors instead of no changes", async () => {
  const tree = (await snapshotTree(repo))!;
  const missing = "0".repeat(40);
  for (const cwd of [repo, path.join(root, "missing-repo")]) {
    await assert.rejects(diffTrees(cwd, tree, missing), /Could not compare saved changes/);
    await assert.rejects(diffPatch(cwd, tree, missing), /Could not read saved changes/);
  }
});

test("cleanup accepts an already deregistered worktree with a leftover folder", async () => {
  const { worktree: wt } = await createWorktree(repo, repo, "Already removed");
  await removeWorktree(wt);
  fs.mkdirSync(wt.path);
  await removeWorktree(wt);
  await removeWorktree(wt);
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(fs.readFileSync(path.join(repo, "node_modules", "dep", "index.js"), "utf8"), "x");
  assert.ok(await dropBranchIfEmpty(wt));
});

test("a landed merge closes successfully when its deregistered folder cannot be removed", async (t) => {
  const { AgentHost } = await import("./host.js");
  const { worktree: wt } = await createWorktree(repo, repo, "Cleanup fails");
  fs.writeFileSync(path.join(wt.path, "cleanup.txt"), "merged\n");
  await commitAll(wt, "merge despite cleanup failure");
  const commit = sh(wt.path, "rev-parse", "HEAD");
  const thread = { id: "cleanup-test", title: "Cleanup fails", cwd: wt.path, worktree: wt, nativeId: "session" };
  const notices: { text: string }[] = [];
  const threads = new Map([[thread.id, thread]]);
  const host = Object.assign(Object.create(AgentHost.prototype), {
    runs: new Map(), threads, worktreeClosures: new Map(),
    requireThread: (id: string) => threads.get(id),
    sharers: () => [],
    sessions: new Map([[thread.id, { dispose() {
      // Reproduce Git having removed its registration before folder cleanup fails.
      fs.unlinkSync(path.join(wt.path, "node_modules"));
      sh(repo, "worktree", "remove", "--force", wt.path);
      fs.mkdirSync(wt.path);
    } }]]),
    db: { saveThread() {} },
    addItem: (_id: string, _turn: null, item: { text: string }) => notices.push(item),
    emitThread() {}, flushNow() {},
  });
  const rm = fs.rmSync;
  const blocked = t.mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => {
    if (args[0] === wt.path) throw new Error("EPERM: folder still in use");
    return rm(...args);
  });
  try {
    const result = await host.finishWorktree(thread.id, "merge");
    assert.equal(result.ok, true);
    assert.match(result.message, /Merged 1 commit/);
    assert.match(result.message, /Worktree cleanup failed:.*EPERM/);
    assert.equal(sh(repo, "rev-parse", "HEAD"), commit);
    assert.equal(threads.get(thread.id)?.worktree.closed?.how, "merged");
    assert.equal(threads.get(thread.id)?.cwd, repo);
    assert.match(notices[0].text, /Worktree cleanup failed/);
    assert.doesNotMatch(notices[0].text, /Worktree removed/);
    assert.equal(sh(repo, "branch", "--list", wt.branch).trim(), wt.branch);
  } finally {
    blocked.mock.restore();
    await removeWorktree(wt);
    await dropBranchIfEmpty(wt);
  }
});

test("idle worktrees close when empty and are listed as stale when they hold changes (#686)", async () => {
  const { AgentHost } = await import("./host.js");
  const old = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const empty = { ...(await createWorktree(repo, repo, "Idle empty")).worktree, createdAt: old };
  const worked = { ...(await createWorktree(repo, repo, "Idle worked")).worktree, createdAt: old };
  const fresh = (await createWorktree(repo, repo, "Fresh")).worktree;
  fs.writeFileSync(path.join(worked.path, "w.txt"), "w\n");
  await commitAll(worked, "work");
  const threads = new Map(
    [
      { id: "idle-empty", title: "Idle empty", cwd: empty.path, worktree: empty, useWorktree: true, nativeId: "s1" },
      { id: "idle-worked", title: "Idle worked", cwd: worked.path, worktree: worked, useWorktree: true, nativeId: "s2" },
      { id: "fresh", title: "Fresh", cwd: fresh.path, worktree: fresh, useWorktree: true, nativeId: "s3" },
    ].map((t) => [t.id, t])
  );
  const settings = new Map<string, unknown>();
  const notices: { text: string }[] = [];
  const host = Object.assign(Object.create(AgentHost.prototype), {
    threads, runs: new Map(), resuming: new Set(), status: new Map(), queues: new Map(), pageRuns: new Map(), sessions: new Map(), closed: false, worktreeClosures: new Map(),
    db: {
      saveThread() {},
      listTurns: () => [],
      getSetting: (k: string, d: unknown) => (settings.has(k) ? settings.get(k) : d),
      setSetting: (k: string, v: unknown) => settings.set(k, v),
    },
    addItem: (_id: string, _turn: null, item: { text: string }) => notices.push(item),
    emitThread() {}, flushNow() {},
  });
  try {
    for (const { thread, wt, ahead, dirty } of await host.idleWorktrees()) if (!ahead && !dirty) await host.expireWorktree(thread.id, wt);
    assert.equal(fs.existsSync(empty.path), false);
    assert.equal(threads.get("idle-empty")?.worktree.closed?.how, "expired");
    assert.equal(threads.get("idle-empty")?.useWorktree, true, "its next message opens a worktree again");
    assert.equal(threads.get("idle-empty")?.nativeId, "s1");
    assert.equal(threads.get("idle-empty")?.cwd, repo);
    assert.match(notices[0].text, /held no changes/);
    assert.ok(fs.existsSync(worked.path), "a worktree with changes is kept");
    assert.ok(fs.existsSync(fresh.path), "a recently made worktree is kept");

    const first = await host.staleWorktrees(true);
    assert.deepEqual(first.worktrees.map((w: { threadId: string }) => w.threadId), ["idle-worked"]);
    assert.equal(first.worktrees[0].ahead, 1);
    assert.equal(first.remind, true);
    assert.equal((await host.staleWorktrees(true)).remind, false, "reminds at most once a day");
  } finally {
    for (const wt of [worked, fresh]) {
      await discardWorktree(wt);
    }
  }
});

test("equivalent commits count as landed, while additional work stays ahead (#709)", async () => {
  const { worktree: wt } = await createWorktree(repo, repo, "Equivalent patch");
  try {
    fs.writeFileSync(path.join(wt.path, "equivalent.txt"), "same patch\n");
    await commitAll(wt, "original commit");
    const original = sh(wt.path, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "equivalent.txt"), "same patch\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "landed through another thread");
    assert.notEqual(sh(repo, "rev-parse", "HEAD"), original);
    assert.equal(sh(repo, "rev-list", "--count", `main..${wt.branch}`), "1");
    assert.equal((await worktreeStatus(wt)).ahead, 0);
    assert.deepEqual(await worktreeRemaining(wt), { ahead: 0, dirty: false });
    fs.writeFileSync(path.join(wt.path, "still-local.txt"), "keep me\n");
    await commitAll(wt, "additional work");
    assert.equal((await worktreeRemaining(wt)).ahead, 1);
    assert.equal(await dropBranchIfEmpty(wt), false);
  } finally {
    await discardWorktree(wt);
  }
});

test("dirty changes already committed on base are recognized without changing either index (#709)", async () => {
  fs.writeFileSync(path.join(repo, "delete-landed.txt"), "delete\n");
  fs.writeFileSync(path.join(repo, "rename-landed.txt"), "rename\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "prepare dirty recovery");
  const { worktree: wt } = await createWorktree(repo, repo, "Dirty recovery");
  try {
    for (const dir of [wt.path, repo]) {
      fs.writeFileSync(path.join(dir, "src", "a.txt"), "recovered edit\n");
      fs.unlinkSync(path.join(dir, "delete-landed.txt"));
      fs.renameSync(path.join(dir, "rename-landed.txt"), path.join(dir, "renamed-landed.txt"));
      fs.writeFileSync(path.join(dir, "binary-landed.bin"), Buffer.from([0, 255, 1, 128]));
      fs.writeFileSync(path.join(dir, "untracked-landed.txt"), "recovered untracked\n");
    }
    sh(wt.path, "add", "src/a.txt", "rename-landed.txt", "renamed-landed.txt");
    assert.equal((await worktreeRemaining(wt)).dirty, true, "uncommitted main-checkout files do not count as landed");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "recover dirty work elsewhere");
    const localStatus = sh(wt.path, "status", "--porcelain");
    const localIndex = sh(wt.path, "write-tree");
    fs.writeFileSync(path.join(repo, "main-uncommitted.txt"), "unrelated staged main work\n");
    sh(repo, "add", "main-uncommitted.txt");
    const mainIndex = sh(repo, "write-tree");
    assert.deepEqual(await worktreeRemaining(wt), { ahead: 0, dirty: false });
    assert.equal(sh(wt.path, "status", "--porcelain"), localStatus);
    assert.equal(sh(wt.path, "write-tree"), localIndex);
    assert.equal(sh(repo, "write-tree"), mainIndex);
    // A staged blob must not disappear just because the working file has landed.
    fs.writeFileSync(path.join(wt.path, "src", "a.txt"), "unique staged edit\n");
    sh(wt.path, "add", "src/a.txt");
    fs.writeFileSync(path.join(wt.path, "src", "a.txt"), "recovered edit\n");
    assert.equal((await worktreeRemaining(wt)).dirty, true);
    sh(wt.path, "reset", "-q", "HEAD", "--", "src/a.txt");
    fs.writeFileSync(path.join(wt.path, "untracked-landed.txt"), "a new local edit\n");
    assert.equal((await worktreeRemaining(wt)).dirty, true);
    fs.writeFileSync(path.join(wt.path, "untracked-landed.txt"), "recovered untracked\n");
    assert.deepEqual(await mergeWorktree(wt), { commits: 0, base: "main" }, "Merge can close a dirty worktree once all of its changes landed");
  } finally {
    sh(repo, "reset", "-q", "HEAD", "--", "main-uncommitted.txt");
    fs.rmSync(path.join(repo, "main-uncommitted.txt"), { force: true });
    await discardWorktree(wt);
  }
});

test("unique merge commits are kept even when their constituent patches landed elsewhere (#709)", async () => {
  const { worktree: wt } = await createWorktree(repo, repo, "Keep merge resolution");
  const side = `${wt.branch}-side`;
  try {
    sh(wt.path, "checkout", "-q", "-b", side);
    fs.writeFileSync(path.join(wt.path, "merge-side.txt"), "side\n");
    await commitAll(wt, "side patch");
    sh(wt.path, "checkout", "-q", wt.branch);
    sh(wt.path, "merge", "-q", "--no-ff", "-m", "unique merge", side);
    fs.writeFileSync(path.join(repo, "merge-side.txt"), "side\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "same side patch elsewhere");
    assert.equal((await worktreeRemaining(wt)).ahead, 1, "a unique merge is never silently excluded like git cherry excludes merges");
  } finally {
    await discardWorktree(wt);
    sh(repo, "branch", "-D", side);
  }
});

test("unfinished Git operations and failed base comparisons prevent cleanup (#709)", async () => {
  const { worktree: wt } = await createWorktree(repo, repo, "Keep interrupted work");
  try {
    const marker = path.resolve(wt.path, sh(wt.path, "rev-parse", "--git-path", "MERGE_HEAD"));
    fs.writeFileSync(marker, `${sh(wt.path, "rev-parse", "HEAD")}\n`);
    await assert.rejects(worktreeRemaining(wt), /unfinished Git operation/);
    fs.unlinkSync(marker);
    await assert.rejects(worktreeRemaining({ ...wt, base: null, baseCommit: "missing-base" }), /Could not compare/);
  } finally {
    await discardWorktree(wt);
  }
});

test("a merge closes quiet worktrees whose work landed with it and keeps busy or unused ones (#709)", async () => {
  const { AgentHost } = await import("./host.js");
  const target = (await createWorktree(repo, repo, "Other committed work")).worktree;
  const recovered = (await createWorktree(repo, repo, "Other dirty work")).worktree;
  const busy = (await createWorktree(repo, repo, "Other busy work")).worktree;
  const unused = (await createWorktree(repo, repo, "Other unused work")).worktree;
  const donor = (await createWorktree(repo, repo, "Merge for other chats")).worktree;
  for (const wt of [target, busy, donor]) {
    fs.writeFileSync(path.join(wt.path, "shared-landed.txt"), "landed elsewhere\n");
    await commitAll(wt, wt.branch);
  }
  for (const wt of [recovered, donor]) fs.writeFileSync(path.join(wt.path, "dirty-landed.txt"), "dirty recovery\n");
  await commitAll(donor, "recover another chat's dirty file");
  const threads = new Map([target, recovered, busy, unused, donor].map((wt) => [wt.branch, {
    id: wt.branch, title: wt.branch, cwd: wt.path, worktree: wt, useWorktree: true, nativeId: wt.branch,
  }]));
  const host = Object.assign(Object.create(AgentHost.prototype), {
    threads, runs: new Map([[busy.branch, {}]]), resuming: new Set(), status: new Map(), queues: new Map(), pageRuns: new Map(), sessions: new Map(), closed: false, worktreeClosures: new Map(),
    db: { saveThread() {}, listTurns: () => [] },
    addItem() {}, emitThread() {}, flushNow() {},
  });
  try {
    await host.finishWorktree(donor.branch, "merge");
    for (const wt of [target, recovered, donor]) {
      assert.equal(fs.existsSync(wt.path), false);
      assert.equal(threads.get(wt.branch)?.worktree.closed?.how, "merged");
      assert.equal(threads.get(wt.branch)?.useWorktree, true);
      assert.equal(sh(repo, "branch", "--list", wt.branch), "");
    }
    assert.equal(fs.existsSync(busy.path), true, "a running thread is left alone even if its patches have landed");
    assert.equal(fs.existsSync(unused.path), true, "a newly opened worktree remains ready for its first turn");
    await host.expireWorktree(busy.branch, busy);
    assert.equal(fs.existsSync(busy.path), true, "cleanup rechecks a thread that became busy");
  } finally {
    for (const wt of [target, recovered, busy, unused, donor]) await discardWorktree(wt);
  }
});

test("a merged worktree reopens in the same folder from the latest base", async () => {
  const { worktree: wt } = await createWorktree(repo, repo, "Reopen me");
  fs.writeFileSync(path.join(wt.path, "r.txt"), "r1\n");
  await commitAll(wt, "add r");
  await mergeWorktree(wt);
  await removeWorktree(wt);
  await dropBranchIfEmpty(wt);
  // Other work lands on main meanwhile.
  fs.writeFileSync(path.join(repo, "later.txt"), "later\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "later");

  const again = await reopenWorktree(wt, "Reopen me");
  assert.ok(again.sameFolder);
  assert.equal(again.worktree.path, wt.path);
  assert.equal(again.worktree.branch, wt.branch);
  assert.equal(again.worktree.baseCommit, sh(repo, "rev-parse", "HEAD"));
  assert.ok(fs.existsSync(path.join(wt.path, "later.txt")));
  await removeWorktree(again.worktree);

  // A branch that is still there but already merged starts over in the same folder too.
  const kept = await reopenWorktree(wt, "Reopen me");
  assert.ok(kept.sameFolder);
  fs.writeFileSync(path.join(wt.path, "unmerged.txt"), "u\n");
  await commitAll(kept.worktree, "unmerged");
  await removeWorktree(kept.worktree);

  // One with work not merged is left alone: the thread gets a new branch and folder.
  const moved = await reopenWorktree(wt, "Reopen me");
  assert.equal(moved.sameFolder, false);
  assert.notEqual(moved.worktree.branch, wt.branch);
  assert.notEqual(moved.worktree.path, wt.path);
  await removeWorktree(moved.worktree);
  await dropBranchIfEmpty(moved.worktree);
  sh(repo, "branch", "-D", wt.branch);
});

test("merge refuses when the main checkout is on another branch", async () => {
  const { worktree: wt } = await createWorktree(repo, repo, "other");
  fs.writeFileSync(path.join(wt.path, "b.txt"), "b\n");
  await commitAll(wt, "add b");
  sh(repo, "checkout", "-q", "-b", "side");
  await assert.rejects(mergeWorktree(wt), /Switch it to main/);
  sh(repo, "checkout", "-q", "main");
  await removeWorktree(wt);
  assert.equal(await dropBranchIfEmpty(wt), false, "a branch with commits is kept");
  assert.equal(sh(repo, "branch", "--list", wt.branch).replace("*", "").trim(), wt.branch);
});

test("merge rebases a branch the base has moved past, and leaves a conflicting one as it was", async () => {
  const { worktree: wt } = await createWorktree(repo, repo, "rebase me");
  fs.writeFileSync(path.join(wt.path, "mine.txt"), "mine\n");
  await commitAll(wt, "add mine");
  fs.writeFileSync(path.join(repo, "theirs.txt"), "theirs\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "theirs");
  assert.deepEqual(await mergeWorktree(wt), { commits: 1, base: "main" });
  assert.equal(sh(repo, "rev-list", "--merges", "--count", "HEAD~1..HEAD"), "0", "a fast-forward, no merge commit");
  assert.equal(sh(repo, "log", "-1", "--format=%s"), "add mine");
  await removeWorktree(wt);
  await dropBranchIfEmpty(wt);

  const { worktree: clash } = await createWorktree(repo, repo, "clash");
  fs.writeFileSync(path.join(clash.path, "theirs.txt"), "mine instead\n");
  await commitAll(clash, "change theirs");
  const before = sh(clash.path, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "theirs.txt"), "theirs again\n");
  sh(repo, "commit", "-q", "-am", "theirs again");
  await assert.rejects(mergeWorktree(clash), /did not go through/);
  assert.equal(sh(clash.path, "rev-parse", "HEAD"), before, "the aborted rebase leaves the branch alone");
  assert.equal(sh(clash.path, "status", "--porcelain"), "");
  assert.equal(sh(repo, "status", "--porcelain"), "");
  await removeWorktree(clash);
  sh(repo, "branch", "-D", clash.branch);
});

test("a worktree with no recorded base merges into the main checkout's branch only when it holds the starting commit", async () => {
  const { worktree: made } = await createWorktree(repo, repo, "no base");
  const wt = { ...made, base: null };
  fs.writeFileSync(path.join(wt.path, "nobase.txt"), "x\n");
  await commitAll(wt, "add nobase");

  sh(repo, "checkout", "-q", "--orphan", "unrelated");
  sh(repo, "commit", "-q", "--allow-empty", "-m", "unrelated");
  await assert.rejects(mergeWorktree(wt), /does not hold its starting commit/);
  sh(repo, "checkout", "-q", "-f", "main");
  sh(repo, "branch", "-D", "unrelated");

  sh(repo, "checkout", "-q", "--detach");
  await assert.rejects(mergeWorktree(wt), /detached HEAD/);
  sh(repo, "checkout", "-q", "main");

  assert.deepEqual(await mergeWorktree(wt), { commits: 1, base: "main" });
  assert.equal(sh(repo, "log", "-1", "--format=%s"), "add nobase");
  await removeWorktree(wt);
  await dropBranchIfEmpty(wt);
});

test("reverting a worktree turn undoes its commits too", async () => {
  const { worktree: wt } = await createWorktree(repo, repo, "revert me");
  const beforeTree = (await snapshotTree(wt.path))!;
  const beforeHead = (await headCommit(wt.path))!;
  fs.writeFileSync(path.join(wt.path, "c.txt"), "c\n");
  await commitAll(wt, "add c");
  fs.writeFileSync(path.join(wt.path, "d.txt"), "d\n");
  const afterTree = (await snapshotTree(wt.path))!;
  assert.deepEqual(await revertTrees(wt.path, beforeTree, afterTree), { ok: true });
  assert.deepEqual(await resetHead(wt.path, beforeHead), { ok: true });
  assert.equal(await headCommit(wt.path), beforeHead);
  assert.ok(!fs.existsSync(path.join(wt.path, "c.txt")));
  assert.ok(!fs.existsSync(path.join(wt.path, "d.txt")));
  assert.equal(sh(wt.path, "status", "--porcelain"), "");
  await removeWorktree(wt);
  assert.ok(await dropBranchIfEmpty(wt));
});

test("a worktree no thread uses loses its links, so removing it by hand is safe", async () => {
  const { worktree: kept } = await createWorktree(repo, repo, "kept");
  const { worktree: orphan } = await createWorktree(repo, repo, "orphan");
  const cut = unlinkOrphanedWorktrees([kept.path]);
  assert.deepEqual(cut, [path.join(orphan.path, "node_modules")]);
  assert.ok(fs.existsSync(path.join(kept.path, "node_modules", "dep", "index.js")));
  assert.ok(!fs.existsSync(path.join(orphan.path, "node_modules")));
  fs.rmSync(orphan.path, { recursive: true, force: true });
  assert.ok(fs.existsSync(path.join(repo, "node_modules", "dep", "index.js")), "deleting the orphan leaves the main checkout's node_modules");
  await removeWorktree(kept);
  sh(repo, "worktree", "prune");
});
