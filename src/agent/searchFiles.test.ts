import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { searchScopedFiles } from "./searchFiles.js";
import { threadFilesDir } from "./attachments.js";
import type { ThreadWorktree } from "./types.js";

test("scoped search filters, paginates and bounds matches without shell interpretation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-search-test-"));
  const scope = { cwd: root, mode: "ask", approval: "ask" } as const;
  try {
    await fs.mkdir(path.join(root, "sub"));
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.writeFile(path.join(root, "a.ts"), "Hello.World\nhello.world\nno match\n");
    await fs.writeFile(path.join(root, "sub", "b.ts"), "hello.world\n");
    await fs.writeFile(path.join(root, "other.txt"), "hello.world\n");
    await fs.writeFile(path.join(root, ".hidden.ts"), "hello.world\n");
    await fs.writeFile(path.join(root, "node_modules", "dep.ts"), "hello.world\n");
    await fs.writeFile(path.join(root, "binary"), Buffer.from([0, 1, 2]));
    const first = await searchScopedFiles(scope, { glob: "*.ts", limit: 1 }, false);
    assert.deepEqual(first.results, [{ path: path.join(root, "a.ts") }]);
    assert.equal(first.nextOffset, 2);
    const second = await searchScopedFiles(scope, { glob: "*.ts", offset: 2 }, false);
    assert.deepEqual(second.results, [{ path: path.join(root, "sub", "b.ts") }]);
    assert.equal(second.nextOffset, null);
    assert.equal((await searchScopedFiles(scope, { includeHidden: true }, false)).results.length, 5);
    assert.equal((await searchScopedFiles(scope, { glob: ".*.ts", includeHidden: true }, false)).results.length, 1);
    assert.equal((await searchScopedFiles(scope, { glob: "**/*.ts" }, false)).results.length, 2);
    assert.equal((await searchScopedFiles(scope, { glob: "!*.ts" }, false)).results.length, 2);
    assert.equal((await searchScopedFiles(scope, { path: "node_modules" }, false)).results.length, 1);
    const input = { pattern: "HELLO.WORLD", fixedStrings: true, ignoreCase: true, glob: "*.ts" };
    const match = await searchScopedFiles(scope, { ...input, limit: 1 }, true);
    assert.deepEqual(match.results, [{ path: path.join(root, "a.ts"), line: 1, text: "Hello.World" }]);
    assert.equal(match.nextOffset, 2);
    assert.equal((await searchScopedFiles(scope, { ...input, offset: 2 }, true)).results.length, 2);
    assert.deepEqual((await searchScopedFiles(scope, { pattern: "not present" }, true)).results, []);
    assert.deepEqual((await searchScopedFiles(scope, { pattern: "$(echo secret)`x`", fixedStrings: true }, true)).results, []);
    await assert.rejects(searchScopedFiles(scope, { pattern: "[" }, true), /File search failed/);
    for (const input of [{ offset: 0 }, { limit: 1001 }, { ignoreCase: "true" }]) {
      await assert.rejects(searchScopedFiles(scope, input, false), /offset|limit|boolean/);
    }
    await fs.writeFile(path.join(root, "many.txt"), Array.from({ length: 1000 }, () => "x".repeat(3000)).join("\n"));
    const bounded = await searchScopedFiles(scope, { path: "many.txt", pattern: "x" }, true);
    assert.equal(bounded.truncated, true);
    assert.ok(JSON.stringify(bounded.results).length < 32_000);
    assert.equal((bounded.results[0] as { text: string }).text.length, 2000);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("scribe-search-test-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("search uses read roots for modes, attachments, recorded links and nested escapes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-search-roots-"));
  const previousHome = process.env.SCRIBE_HOME;
  process.env.SCRIBE_HOME = path.join(root, "data");
  const cwd = path.join(root, "workspace"), repo = path.join(root, "repo");
  const linked = path.join(cwd, "linked"), escape = path.join(repo, "linked", "escape"), cycle = path.join(cwd, "cycle");
  const scope = { id: "one", cwd, mode: "plan", approval: "full", worktree: { path: cwd, repo, links: ["linked"] } as ThreadWorktree } as const;
  try {
    await fs.mkdir(cwd);
    await fs.mkdir(path.join(repo, "linked"), { recursive: true });
    await fs.writeFile(path.join(repo, "secret.txt"), "secret");
    await fs.writeFile(path.join(repo, "linked", "allowed.txt"), "allowed");
    await fs.symlink(path.join(repo, "linked"), linked, "junction");
    await fs.symlink(repo, escape, "junction");
    await fs.symlink(cwd, cycle, "junction");
    const found = await searchScopedFiles(scope, {}, false);
    assert.deepEqual(found.results, [{ path: path.join(linked, "allowed.txt") }]);
    assert.equal(found.skipped, 1);
    assert.deepEqual((await searchScopedFiles(scope, { pattern: "secret" }, true)).results, []);
    await assert.rejects(searchScopedFiles({ ...scope, worktree: null }, { path: "linked" }, false), /link target/);
    await assert.rejects(searchScopedFiles(scope, { path: repo }, true), /outside/);
    assert.equal((await searchScopedFiles({ ...scope, mode: "code" }, { path: path.join(repo, "secret.txt"), pattern: "secret" }, true)).results.length, 1);
    for (const id of ["one", "two"]) {
      await fs.mkdir(threadFilesDir(id), { recursive: true });
      await fs.writeFile(path.join(threadFilesDir(id), "attached.txt"), id);
    }
    assert.equal((await searchScopedFiles(scope, { path: threadFilesDir("one") }, false)).results.length, 1);
    await assert.rejects(searchScopedFiles(scope, { path: threadFilesDir("two") }, false), /outside/);
    await assert.rejects(searchScopedFiles({ ...scope, mode: "board", cwd: null }, {}, false), /mode/);
    await assert.rejects(searchScopedFiles(null, {}, false), /mode/);
    // Retargeting a recorded link cannot grant a new destination.
    await fs.unlink(linked);
    await fs.symlink(repo, linked, "junction");
    await assert.rejects(searchScopedFiles(scope, { path: "linked" }, false), /link target/);
  } finally {
    for (const link of [linked, escape, cycle]) await fs.unlink(link).catch(() => {});
    if (previousHome === undefined) delete process.env.SCRIBE_HOME;
    else process.env.SCRIBE_HOME = previousHome;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("scribe-search-roots-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});
