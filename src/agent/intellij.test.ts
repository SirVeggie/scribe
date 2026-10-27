import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import type { AgentHost } from "./host.js";
import { git, snapshotTree } from "./git.js";
import { intellijDiffArgs, intellijExportDiff, intellijFileArgs, intellijProject, launchIntelliJ, intellijSettings } from "./intellij.js";

test("IntelliJ exports exact historical blobs, renames, additions, deletions and binary bytes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-idea-test-"));
  try {
    const repo = path.join(dir, "worktree with spaces");
    await fs.mkdir(repo);
    assert.equal((await git(["init"], repo)).code, 0);
    await fs.writeFile(path.join(repo, ".gitattributes"), "* -text\n");
    const original = "first\r\nsecond\r\n";
    await fs.writeFile(path.join(repo, "old ü.txt"), original);
    await fs.writeFile(path.join(repo, "deleted.txt"), "deleted\n");
    await fs.writeFile(path.join(repo, "modified.txt"), "before\n");
    const from = (await snapshotTree(repo))!;
    await fs.rename(path.join(repo, "old ü.txt"), path.join(repo, "new ü.txt"));
    await fs.unlink(path.join(repo, "deleted.txt"));
    await fs.writeFile(path.join(repo, "modified.txt"), "after\n");
    const bytes = Buffer.from([0, 255, 13, 10, 128]);
    await fs.writeFile(path.join(repo, "added.bin"), bytes);
    const to = (await snapshotTree(repo))!;
    await fs.writeFile(path.join(repo, "modified.txt"), "later changes\n");
    const root = path.join(dir, "exports");
    const exported = async (file: string) => {
      const args = await intellijDiffArgs(repo, from, to, file, root);
      assert.equal(args[0], "diff");
      return Promise.all(args.slice(1).map(p => fs.readFile(p)));
    };
    assert.deepEqual(await exported("new ü.txt"), [Buffer.from(original), Buffer.from(original)]);
    assert.deepEqual(await exported("deleted.txt"), [Buffer.from("deleted\n"), Buffer.alloc(0)]);
    assert.deepEqual(await exported("modified.txt"), [Buffer.from("before\n"), Buffer.from("after\n")]);
    assert.deepEqual(await exported("added.bin"), [Buffer.alloc(0), bytes]);
    await assert.rejects(intellijDiffArgs(repo, from, to, "../outside", root), /not part/);
    await assert.rejects(intellijDiffArgs(repo, "HEAD", to, "modified.txt", root), /snapshots/);
    const args = await intellijFileArgs(repo, "new ü.txt", 42, 5);
    assert.deepEqual(args.slice(0, 4), ["--line", "42", "--column", "5"]);
    assert.equal(args[4], path.join(await fs.realpath(repo), "new ü.txt"));
    await assert.rejects(intellijFileArgs(repo, "../outside", 1, 1), /inside/);
    await assert.rejects(intellijFileArgs(repo, "deleted.txt", 1, 1), /no longer exists/);
    await fs.writeFile(path.join(dir, "outside.txt"), "outside");
    try {
      await fs.symlink(path.join(dir, "outside.txt"), path.join(repo, "linked.txt"));
      await assert.rejects(intellijFileArgs(repo, "linked.txt", 1, 1), /inside/);
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err; }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("IntelliJ launch preserves literal arguments and reports missing launchers", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-idea-launch-"));
  try {
    const output = path.join(dir, "args.json"), script = path.join(dir, "launcher.cjs");
    await fs.writeFile(script, 'require("fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));');
    const literal = ['diff', 'space ü & $() ` file.txt', 'other.txt'];
    await launchIntelliJ(process.execPath, [script, output, ...literal]);
    let captured: string | undefined;
    for (let i = 0; i < 100; i++) {
      captured = await fs.readFile(output, "utf8").catch(() => undefined);
      if (captured) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(JSON.parse(captured!), literal);
    await assert.rejects(launchIntelliJ(path.join(dir, "missing.exe"), []), /Could not launch/);
    assert.deepEqual(intellijSettings(undefined), { enabled: false, launcher: "" });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("IntelliJ routes persist the opt-in and reject disabled, cross-origin and unavailable diff requests", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-idea-routes-"));
  const oldHome = process.env.SCRIBE_HOME;
  process.env.SCRIBE_HOME = dir;
  const { agentRouter } = await import("./routes.js");
  const settings = new Map<string, unknown>();
  const host = {
    db: { getSetting: (key: string, fallback: unknown) => settings.get(key) ?? fallback, setSetting: (key: string, value: unknown) => settings.set(key, value) },
    getThread: () => ({ id: "thread", cwd: dir }),
    changes: async () => ({ repo: null, files: [] }),
    fileVersions: (_thread: string, file: string) => file === "saved.ts" ? { before: Buffer.from("a"), after: Buffer.from("b") } : null,
  } as unknown as AgentHost;
  const app = express();
  app.use("/api/agent", agentRouter(host));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent/integrations`;
  const request = (method: string, suffix: string, body: unknown, origin?: string) => fetch(base + suffix, {
    method, headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
  });
  try {
    assert.deepEqual(await (await fetch(base)).json(), { intellij: { enabled: false, launcher: "" } });
    const disabled = await request("POST", "/intellij/open", { mode: "file", path: "file.ts" });
    assert.equal(disabled.status, 400);
    assert.match((await disabled.json()).error, /Enable IntelliJ/);
    const value = { enabled: true, launcher: process.execPath };
    assert.equal((await request("PUT", "", { intellij: value })).status, 200);
    assert.deepEqual(await (await fetch(base)).json(), { intellij: value });
    assert.equal((await request("PUT", "", { intellij: { enabled: false } }, "https://untrusted.invalid")).status, 403);
    const missing = await request("POST", "/intellij/open", { mode: "diff", threadId: "thread", path: "file.ts" });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /snapshots/);
    const saved = await request("POST", "/intellij/open", { mode: "diff", threadId: "thread", path: "saved.ts" });
    assert.equal(saved.status, 200);
    const traversal = await request("POST", "/intellij/open", { mode: "file", threadId: "thread", path: "../outside" });
    assert.equal(traversal.status, 400);
    assert.match((await traversal.json()).error, /inside/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (oldHome === undefined) delete process.env.SCRIBE_HOME; else process.env.SCRIBE_HOME = oldHome;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("IntelliJ opens a file in its own .idea project and diffs saved versions without git", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-idea-project-"));
  try {
    const root = await fs.realpath(dir);
    await fs.mkdir(path.join(root, "src", "main"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "main", "A.java"), "class A {}");
    assert.equal(await intellijProject(root, path.join(root, "src", "main")), null);
    assert.deepEqual(await intellijFileArgs(root, "src/main/A.java", 3, 2), ["--line", "3", "--column", "2", path.join(root, "src", "main", "A.java")]);
    await fs.mkdir(path.join(root, ".idea"));
    assert.equal(await intellijProject(root, path.join(root, "src", "main")), root);
    assert.deepEqual(await intellijFileArgs(root, "src/main/A.java", 3, 2), [root, "--line", "3", "--column", "2", path.join(root, "src", "main", "A.java")]);
    const args = await intellijExportDiff("src/main/A.java", Buffer.from("old"), Buffer.from("new"), path.join(root, "exports"));
    assert.equal(args[0], "diff");
    assert.deepEqual(await Promise.all(args.slice(1).map(p => fs.readFile(p, "utf8"))), ["old", "new"]);
    assert.ok(args[1].endsWith("A.java") && args[2].endsWith("A.java"));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("File snapshots keep content by id and treat a missing file as empty", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-snapshots-"));
  const oldHome = process.env.SCRIBE_HOME;
  process.env.SCRIBE_HOME = dir;
  try {
    const { saveSnapshot, readSnapshot, removeThreadSnapshots, MAX_SNAPSHOT_BYTES } = await import("./fileSnapshots.js");
    const id = saveSnapshot("th_1", "hello ü")!;
    assert.match(id, /^[0-9a-f]{64}$/);
    assert.equal(readSnapshot("th_1", id)!.toString("utf8"), "hello ü");
    assert.equal(saveSnapshot("th_1", null), null);
    assert.equal(readSnapshot("th_1", null)!.length, 0);
    assert.equal(saveSnapshot("th_1", "x".repeat(MAX_SNAPSHOT_BYTES + 1)), undefined);
    assert.equal(readSnapshot("th_1", "../../etc"), null);
    removeThreadSnapshots("th_1");
    assert.equal(readSnapshot("th_1", id), null);
  } finally {
    if (oldHome === undefined) delete process.env.SCRIBE_HOME; else process.env.SCRIBE_HOME = oldHome;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
