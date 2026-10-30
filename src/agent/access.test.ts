import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkPath, cleanProtectedPaths, policyFor, type PolicyEnv } from "./access.js";
import { threadFilesDir } from "./attachments.js";
import { readScopedFile } from "./readFile.js";
import type { Thread, ThreadWorktree } from "./types.js";

/** A home, a Scribe data folder, a workspace and a folder outside it, all under one temp root. */
async function fixture(name: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `scribe-access-${name}-`)));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  for (const dir of [home, data, cwd, outside, path.join(home, ".ssh")]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(cwd, "a.txt"), "a");
  await fs.writeFile(path.join(outside, "b.txt"), "b");
  await fs.writeFile(path.join(home, ".ssh", "id_ed25519"), "key");
  await fs.writeFile(path.join(data, "local-token"), "token");
  const env: PolicyEnv = { home, data };
  return { root, home, data, cwd, outside, env, done: () => fs.rm(root, { recursive: true, force: true }) };
}

type T = Parameters<typeof policyFor>[0];
const code = (cwd: string, extra: Partial<Thread> = {}): T => ({ id: "access-test", cwd, mode: "code", approval: "edits", provider: "pi", ...extra }) as T;

test("checkPath allows the workspace, asks outside it, and resolves '..' before deciding", async () => {
  const f = await fixture("roots");
  try {
    const policy = policyFor(code(f.cwd), f.env);
    assert.equal(checkPath(policy, "a.txt", "read").verdict, "allow");
    assert.equal(checkPath(policy, "new/file.txt", "write").verdict, "allow");
    assert.equal(checkPath(policy, path.join(f.outside, "b.txt"), "read").verdict, "ask");
    assert.equal(checkPath(policy, path.join(f.outside, "b.txt"), "write").verdict, "ask");
    // '..' climbs out of the workspace however it is spelled.
    const up = checkPath(policy, "../outside/b.txt", "read");
    assert.equal(up.verdict, "ask");
    assert.equal(up.real, path.join(f.outside, "b.txt"));
    assert.equal(checkPath(policy, "sub/../../outside/b.txt", "write").verdict, "ask");
    assert.equal(checkPath(policy, "../workspace/a.txt", "read").verdict, "allow");
    assert.equal(checkPath(policy, "bad\0path", "read").verdict, "deny");
    // No workspace: relative paths have nothing to resolve against.
    assert.equal(checkPath(policyFor(code(null as unknown as string), f.env), "a.txt", "read").verdict, "deny");
    // Full access drops the roots, never the protected paths.
    const full = policyFor(code(f.cwd, { approval: "full" }), f.env);
    assert.equal(checkPath(full, path.join(f.outside, "b.txt"), "write").verdict, "allow");
    assert.equal(checkPath(full, path.join(f.home, ".ssh", "id_ed25519"), "read").verdict, "deny");
  } finally { await f.done(); }
});

test("a junction inside the workspace is judged by its target", async () => {
  const f = await fixture("junction");
  try {
    await fs.symlink(f.outside, path.join(f.cwd, "escape"), "junction");
    await fs.symlink(path.join(f.home, ".ssh"), path.join(f.cwd, "keys"), "junction");
    const policy = policyFor(code(f.cwd), f.env);
    const read = checkPath(policy, "escape/b.txt", "read");
    assert.equal(read.verdict, "ask");
    assert.equal(read.real, path.join(f.outside, "b.txt"));
    assert.match(read.verdict === "ask" ? read.reason : "", /link target/);
    // A new file through the junction lands outside too.
    assert.equal(checkPath(policy, "escape/new.txt", "write").verdict, "ask");
    // '..' after a junction climbs from its target, not from the workspace.
    assert.equal(checkPath(policy, "escape/../outside/b.txt", "read").real, path.join(f.outside, "b.txt"));
    assert.equal(checkPath(policy, "keys/id_ed25519", "read").verdict, "deny");
  } finally { await f.done(); }
});

test("a worktree's links are readable but never writable, and its own folder in Scribe's data stays usable", async () => {
  const f = await fixture("worktree");
  try {
    const repo = path.join(f.root, "repo");
    const wtPath = path.join(f.data, "worktrees", "repo-1", "branch");
    await fs.mkdir(path.join(repo, "node_modules", "pkg"), { recursive: true });
    await fs.mkdir(path.join(repo, ".git"), { recursive: true });
    await fs.writeFile(path.join(repo, "node_modules", "pkg", "index.js"), "x");
    await fs.mkdir(wtPath, { recursive: true });
    await fs.symlink(path.join(repo, "node_modules"), path.join(wtPath, "node_modules"), "junction");
    await fs.mkdir(path.join(f.data, "worktrees", "repo-1", "other"), { recursive: true });
    const worktree = { path: wtPath, repo, home: repo, branch: "b", baseCommit: "0".repeat(40), links: ["node_modules"] } as ThreadWorktree;
    const policy = policyFor(code(wtPath, { worktree }), f.env);
    assert.equal(checkPath(policy, "src/new.ts", "write").verdict, "allow");
    assert.equal(checkPath(policy, "node_modules/pkg/index.js", "read").verdict, "allow");
    assert.equal(checkPath(policy, "node_modules/pkg/index.js", "write").verdict, "deny");
    assert.equal(checkPath(policy, path.join(repo, ".git", "HEAD"), "write").verdict, "allow");
    // Another thread's worktree and Scribe's own files are protected.
    assert.equal(checkPath(policy, path.join(f.data, "worktrees", "repo-1", "other", "x"), "read").verdict, "deny");
    assert.equal(checkPath(policy, path.join(f.data, "local-token"), "read").verdict, "deny");
    assert.equal(checkPath(policy, "../../../local-token", "read").verdict, "deny");
  } finally { await f.done(); }
});

test("protected paths beat grants; the thread keeps its own attachments and account", async () => {
  const f = await fixture("deny");
  const previous = process.env.SCRIBE_HOME;
  process.env.SCRIBE_HOME = f.data;
  try {
    const own = path.join(f.data, "agent", "claude-accounts", "acc_1");
    const other = path.join(f.data, "agent", "claude-accounts", "acc_2");
    for (const dir of [own, other, threadFilesDir("access-test"), threadFilesDir("someone-else")]) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(own, "settings.json"), "{}");
    await fs.writeFile(path.join(own, ".credentials.json"), "{}");
    await fs.writeFile(path.join(threadFilesDir("access-test"), "mine.txt"), "x");
    const grants = [
      { kind: "folder", path: f.data, access: "write" },
      { kind: "folder", path: path.join(f.home, ".ssh"), access: "write" },
      { kind: "folder", path: f.outside, access: "read" },
    ] as Thread["toolGrants"];
    const extra = path.join(f.outside, "private");
    const policy = policyFor(code(f.cwd, { provider: "claude", claudeAccount: "acc_1", toolGrants: grants }), { ...f.env, protectedPaths: [extra] });
    assert.equal(checkPath(policy, path.join(f.home, ".ssh", "id_ed25519"), "read").verdict, "deny");
    assert.equal(checkPath(policy, path.join(f.data, "local-token"), "read").verdict, "deny");
    assert.equal(checkPath(policy, path.join(f.data, "scribe.sqlite"), "write").verdict, "deny");
    assert.equal(checkPath(policy, path.join(other, "settings.json"), "read").verdict, "deny");
    assert.equal(checkPath(policy, path.join(threadFilesDir("someone-else"), "x"), "read").verdict, "deny");
    assert.equal(checkPath(policy, path.join(own, "settings.json"), "read").verdict, "allow");
    assert.equal(checkPath(policy, path.join(own, ".credentials.json"), "read").verdict, "deny");
    assert.equal(checkPath(policy, path.join(threadFilesDir("access-test"), "mine.txt"), "read").verdict, "allow");
    // A read grant reads, it doesn't write; the user's own protected path wins over it.
    assert.equal(checkPath(policy, path.join(f.outside, "b.txt"), "read").verdict, "allow");
    assert.equal(checkPath(policy, path.join(f.outside, "b.txt"), "write").verdict, "ask");
    assert.equal(checkPath(policy, path.join(extra, "notes.txt"), "read").verdict, "deny");
  } finally {
    if (previous === undefined) delete process.env.SCRIBE_HOME; else process.env.SCRIBE_HOME = previous;
    await f.done();
  }
});

test("on Windows, paths match whatever their case", { skip: process.platform !== "win32" }, async () => {
  const f = await fixture("case");
  try {
    const policy = policyFor(code(f.cwd), f.env);
    assert.equal(checkPath(policy, f.cwd.toUpperCase() + "\\A.TXT", "read").verdict, "allow");
    assert.equal(checkPath(policy, path.join(f.home, ".SSH", "ID_ED25519").toLowerCase(), "read").verdict, "deny");
    assert.equal(checkPath(policy, path.join(f.data.toUpperCase(), "LOCAL-TOKEN"), "read").verdict, "deny");
    // A drive-relative path depends on process state, so it never resolves.
    assert.equal(checkPath(policy, "C:a.txt", "read").verdict, "deny");
  } finally { await f.done(); }
});

test("read_file asks outside the roots, and an allowed folder covers a search's walk", async () => {
  const f = await fixture("ask");
  try {
    const thread = { id: "access-ask", cwd: f.cwd, mode: "code", approval: "edits", provider: "codex" } as const;
    const asked: string[] = [];
    const file = path.join(f.outside, "b.txt");
    await assert.rejects(readScopedFile(thread, { path: file }, { env: f.env }), /outside/);
    await assert.rejects(readScopedFile(thread, { path: file }, { env: f.env, ask: async (real) => { asked.push(real); return false; } }), /did not allow/);
    assert.match((await readScopedFile(thread, { path: file }, { env: f.env, ask: async (real) => { asked.push(real); return true; } })).content, /b/);
    assert.deepEqual(asked, [file, file]);
    // Protected paths are never asked about.
    await assert.rejects(readScopedFile(thread, { path: path.join(f.home, ".ssh", "id_ed25519") }, { env: f.env, ask: async () => { throw new Error("asked"); } }), /protected/);
  } finally { await f.done(); }
});

test("protected path settings keep absolute, unique paths", () => {
  const abs = path.resolve("/some/where");
  assert.deepEqual(cleanProtectedPaths([abs, abs, "relative/path", "", 3, "x\ny"]), [abs]);
  assert.deepEqual(cleanProtectedPaths("nope"), []);
});
