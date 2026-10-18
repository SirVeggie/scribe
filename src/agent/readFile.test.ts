import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, mock } from "node:test";
import { readScopedFile, READ_FILE_MAX_BYTES, READ_FILE_MAX_LINE_CHARS } from "./readFile.js";
import { threadFilesDir } from "./attachments.js";
import type { ThreadWorktree } from "./types.js";
import { pageCheckoutDir, writeCheckout } from "../pageCheckout.js";
import { readHtmlPath } from "../mcp.js";

test("Code threads can read and edit their own page checkout without exposing other scratch files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-checkout-test-"));
  const tmpMock = mock.method(os, "tmpdir", () => root);
  const cwd = path.join(root, "workspace");
  const scope = { id: "thread-one", cwd, mode: "code", approval: "auto" } as const;
  const link = path.join(pageCheckoutDir(scope.id), "escape");
  try {
    await fs.mkdir(cwd);
    const tab = { key: "scribe:example", html: "<h1>Original</h1>" };
    const file = writeCheckout(tab, scope.id);
    const other = writeCheckout(tab, "thread-two");
    const standalone = writeCheckout(tab);
    assert.notEqual(file, other);
    assert.match((await readScopedFile(scope, { path: file })).content, /Original/);
    await fs.writeFile(file, "<h1>Edited</h1>");
    assert.deepEqual(readHtmlPath(file), { html: "<h1>Edited</h1>" });
    assert.equal(await fs.readFile(other, "utf8"), tab.html);
    for (const denied of [other, standalone, path.dirname(pageCheckoutDir(scope.id))]) {
      await assert.rejects(readScopedFile(scope, { path: denied }), /outside/);
    }
    for (const mode of ["ask", "plan", "board"] as const) {
      await assert.rejects(readScopedFile({ ...scope, mode }, { path: file }), /outside|mode/);
    }
    await assert.rejects(readScopedFile({ ...scope, id: undefined }, { path: file }), /outside/);
    await fs.symlink(path.dirname(other), link, "junction");
    await assert.rejects(readScopedFile(scope, { path: path.join(link, path.basename(other)) }), /link target/);
    // Re-checkout refreshes only this thread's copy.
    assert.equal(writeCheckout(tab, scope.id), file);
    assert.equal(await fs.readFile(file, "utf8"), tab.html);
  } finally {
    tmpMock.mock.restore();
    await fs.unlink(link).catch(() => {});
    assert.ok(path.basename(root).startsWith("scribe-checkout-test-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("external skills are readable under auto review without exposing adjacent files or nested link targets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-read-skills-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const cwd = path.join(root, "workspace");
  const previousHome = process.env.SCRIBE_HOME;
  process.env.SCRIBE_HOME = data;
  const homeMock = mock.method(os, "homedir", () => home);
  const shared = path.join(home, ".agents", "skills");
  const provider = path.join(data, "agent", "codex", "skills");
  const escape = path.join(shared, "help", "escape");
  try {
    await fs.mkdir(cwd);
    for (const folder of [shared, provider]) {
      await fs.mkdir(path.join(folder, "help", "docs"), { recursive: true });
      await fs.writeFile(path.join(folder, "help", "SKILL.md"), "Use this skill.");
      await fs.writeFile(path.join(folder, "help", "docs", "guide.md"), "Supporting instructions.");
      for (const mode of ["code", "ask", "plan"] as const) {
        const scope = { cwd, provider: "codex", mode, approval: "auto" } as const;
        assert.match((await readScopedFile(scope, { path: path.join(folder, "help", "SKILL.md") })).content, /Use this skill/);
        assert.match((await readScopedFile(scope, { path: path.join(folder, "help", "docs", "guide.md") })).content, /Supporting instructions/);
      }
    }
    const scope = { cwd, provider: "codex", mode: "code", approval: "auto" } as const;
    const privateFile = path.join(data, "agent", "codex", "auth.json");
    await fs.writeFile(privateFile, "private");
    await assert.rejects(readScopedFile(scope, { path: privateFile }), /outside/);
    await assert.rejects(readScopedFile({ ...scope, provider: "claude" }, { path: path.join(provider, "help", "SKILL.md") }), /outside/);
    await fs.symlink(path.dirname(privateFile), escape, "junction");
    await assert.rejects(readScopedFile(scope, { path: path.join(escape, "auth.json") }), /link target/);
    await assert.rejects(readScopedFile({ ...scope, mode: "board", cwd: null }, { path: path.join(shared, "help", "SKILL.md") }), /mode/);
  } finally {
    homeMock.mock.restore();
    if (previousHome === undefined) delete process.env.SCRIBE_HOME;
    else process.env.SCRIBE_HOME = previousHome;
    await fs.unlink(escape).catch(() => {});
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("scribe-read-skills-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("scoped reads paginate, enforce modes and scope, and bound bytes and output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-read-test-"));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  const scope = { cwd, mode: "code", approval: "auto" } as const;
  try {
    await fs.writeFile(path.join(cwd, "text.txt"), "one\r\ntwo\r\nthree\r\n");
    const first = await readScopedFile(scope, { path: "text.txt", offset: 2, limit: 1 });
    assert.equal(first.content, "2\ttwo");
    assert.equal(first.encoding, "utf-8");
    assert.equal(first.totalLines, 3);
    assert.equal(first.nextOffset, 3);
    assert.equal(first.truncated, true);
    const end = await readScopedFile(scope, { path: "text.txt", offset: first.nextOffset });
    assert.equal(end.content, "3\tthree");
    assert.equal(end.nextOffset, null);
    assert.equal((await readScopedFile(scope, { path: "text.txt", offset: 20 })).linesReturned, 0);
    await fs.writeFile(path.join(root, "outside.txt"), "outside");
    for (const mode of ["code", "ask", "plan"] as const) {
      for (const approval of ["ask", "edits", "auto", "full"] as const) {
        const thread = { cwd, mode, approval };
        assert.equal((await readScopedFile(thread, { path: "text.txt" })).linesReturned, 3);
        if (mode === "code" && approval === "full") assert.equal((await readScopedFile(thread, { path: "../outside.txt" })).content, "1\toutside");
        else await assert.rejects(readScopedFile(thread, { path: "../outside.txt" }), /outside the workspace/);
      }
    }
    // Pages reads in its workspace (#718), never outside it, whatever the approval level; with no workspace it reads nothing.
    assert.equal((await readScopedFile({ ...scope, mode: "board", approval: "full" }, { path: "text.txt" })).linesReturned, 3);
    await assert.rejects(readScopedFile({ ...scope, mode: "board", approval: "full" }, { path: "../outside.txt" }), /outside the workspace/);
    await assert.rejects(readScopedFile({ ...scope, mode: "board", approval: "full", cwd: null }, { path: path.join(cwd, "text.txt") }), /mode/);
    await assert.rejects(readScopedFile(null, { path: "text.txt" }), /mode/);
    await assert.rejects(readScopedFile({ ...scope, cwd: null }, { path: "text.txt" }), /No workspace/);
    // Junctions work without Windows symlink privileges.
    await fs.symlink(root, path.join(cwd, "escape"), "junction");
    await assert.rejects(readScopedFile(scope, { path: "escape/outside.txt" }), /link target/);
    await fs.writeFile(path.join(cwd, "binary"), Buffer.from([0, 1, 2]));
    await assert.rejects(readScopedFile(scope, { path: "binary" }), /NUL byte at byte offset 0/);
    await fs.writeFile(path.join(cwd, "unmarked-utf16"), Buffer.from([0x61, 0]));
    await assert.rejects(readScopedFile(scope, { path: "unmarked-utf16" }), /NUL byte at byte offset 1/);
    await fs.writeFile(path.join(cwd, "late-nul"), Buffer.concat([Buffer.alloc(64 * 1024 + 7, 97), Buffer.from([0])]));
    await assert.rejects(readScopedFile(scope, { path: "late-nul", limit: 1 }), /NUL byte at byte offset 65543/);
    await fs.writeFile(path.join(cwd, "invalid"), Buffer.from([255]));
    await assert.rejects(readScopedFile(scope, { path: "invalid" }), /UTF-8/);
    const listing = await readScopedFile(scope, { path: "." });
    assert.equal(listing.kind, "directory");
    assert.match(listing.content, /\ttext\.txt$/m);
    await fs.mkdir(path.join(cwd, "sub"));
    assert.match((await readScopedFile(scope, { path: "." })).content, /\tsub\/$/m);
    for (const input of [{ offset: 0 }, { offset: 1.5 }, { limit: 0 }, { limit: 1001 }]) {
      await assert.rejects(readScopedFile(scope, { path: "text.txt", ...input }), /offset|limit/);
    }
    await fs.writeFile(path.join(cwd, "long"), Array.from({ length: 20 }, () => "a".repeat(1_990)).join("\n"));
    const bounded = await readScopedFile(scope, { path: "long" });
    assert.equal(bounded.nextOffset, 17);
    assert.ok(bounded.content.length <= 32_000);
    // Sparse: the size check comes before any byte is read.
    await fs.writeFile(path.join(cwd, "huge"), "");
    await fs.truncate(path.join(cwd, "huge"), READ_FILE_MAX_BYTES + 1);
    await assert.rejects(readScopedFile(scope, { path: "huge" }), /64 MiB/);
    await fs.writeFile(path.join(cwd, "longline"), `${"x".repeat(32_001)}\nshort`);
    const cut = await readScopedFile(scope, { path: "longline" });
    assert.equal(cut.content, `1\t${"x".repeat(READ_FILE_MAX_LINE_CHARS)}… [${32_001 - READ_FILE_MAX_LINE_CHARS} more characters]\n2\tshort`);
    assert.match(cut.note, /1 line\(s\) were cut/);
    // Pages past the first stream chunk count lines across chunk edges, including a CRLF split between chunks.
    const many = Array.from({ length: 30_000 }, (_, i) => `line ${i + 1}`).join("\r\n");
    await fs.writeFile(path.join(cwd, "many"), `﻿${many}\r\n`);
    const tail = await readScopedFile(scope, { path: "many", offset: 29_999 });
    assert.equal(tail.totalLines, 30_000);
    assert.equal(tail.content, "29999\tline 29999\n30000\tline 30000");
    assert.equal((await readScopedFile(scope, { path: "many", limit: 1 })).content, "1\tline 1");
    await fs.writeFile(path.join(cwd, "split"), Buffer.concat([Buffer.alloc(64 * 1024 - 1, 97), Buffer.from("\r\nb")]));
    assert.equal((await readScopedFile(scope, { path: "split" })).totalLines, 2);
    await fs.writeFile(path.join(cwd, "blank"), "a\n\n");
    assert.equal((await readScopedFile(scope, { path: "blank" })).totalLines, 2);
  } finally {
    // Remove the junction itself first: never recurse through its target on Windows.
    await fs.unlink(path.join(cwd, "escape")).catch(() => {});
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("scribe-read-test-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("BOM-marked UTF-16 reads strip the BOM, paginate and validate the whole stream", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-read-utf16-"));
  const scope = { cwd: root, mode: "code", approval: "auto" } as const;
  try {
    for (const encoding of ["utf-16le", "utf-16be"] as const) {
      const file = path.join(root, encoding);
      const write = async (text: string) => {
        const bytes = Buffer.from(`\uFEFF${text}`, "utf16le");
        await fs.writeFile(file, encoding === "utf-16be" ? bytes.swap16() : bytes);
      };
      await write("héllo 世界 😀\r\nsecond\r\nthird\r\n");
      const first = await readScopedFile(scope, { path: file, limit: 1 });
      assert.equal(first.encoding, encoding);
      assert.equal(first.content, "1\théllo 世界 😀");
      assert.equal(first.totalLines, 3);
      assert.equal(first.nextOffset, 2);
      const rest = await readScopedFile(scope, { path: file, offset: first.nextOffset });
      assert.equal(rest.content, "2\tsecond\n3\tthird");
      assert.equal(rest.nextOffset, null);
      await write("");
      assert.equal((await readScopedFile(scope, { path: file })).totalLines, 0);
      // Split a surrogate pair, then a CRLF, at the 64 KiB chunk boundary.
      for (const prefix of ["a".repeat(32766) + "😀", "a".repeat(32766) + "\r\n"]) {
        await write(`${prefix}\nlast`);
        const tail = await readScopedFile(scope, { path: file, offset: 2 });
        assert.equal(tail.content, prefix.endsWith("\n") ? "2\t\n3\tlast" : "2\tlast");
      }
      await write("ok\n" + "a".repeat(32766) + "\0");
      await assert.rejects(readScopedFile(scope, { path: file, limit: 1 }), /NUL character/);
      await write("ok\n\uD800");
      await assert.rejects(readScopedFile(scope, { path: file, limit: 1 }), /invalid UTF-16/);
      await write("ok\n");
      await fs.appendFile(file, Buffer.from([0x61]));
      await assert.rejects(readScopedFile(scope, { path: file, limit: 1 }), /invalid UTF-16/);
    }
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("scribe-read-utf16-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recorded worktree links and own attachments are readable without granting adjacent files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-read-roots-"));
  const previousHome = process.env.SCRIBE_HOME;
  process.env.SCRIBE_HOME = path.join(root, "data");
  const cwd = path.join(root, "worktree");
  const repo = path.join(root, "main");
  const dependency = path.join(repo, "node_modules");
  const linked = path.join(cwd, "node_modules");
  const thread = { id: "thread-one", cwd, mode: "ask", approval: "full",
    worktree: { path: cwd, repo, links: ["node_modules"] } as ThreadWorktree } as const;
  try {
    await fs.mkdir(cwd);
    await fs.mkdir(dependency, { recursive: true });
    await fs.writeFile(path.join(dependency, "index.js"), "export default 1;");
    await fs.writeFile(path.join(repo, "private.txt"), "main checkout");
    await fs.symlink(dependency, linked, "junction");
    assert.match((await readScopedFile(thread, { path: "node_modules/index.js" })).content, /export default/);
    assert.match((await readScopedFile(thread, { path: path.join(dependency, "index.js") })).content, /export default/);
    await assert.rejects(readScopedFile(thread, { path: path.join(repo, "private.txt") }), /outside/);
    await assert.rejects(readScopedFile({ ...thread, worktree: null }, { path: "node_modules/index.js" }), /link target/);
    for (const id of [thread.id, "thread-two"]) {
      await fs.mkdir(threadFilesDir(id), { recursive: true });
      await fs.writeFile(path.join(threadFilesDir(id), "attached.txt"), id);
    }
    const attachment = path.join(threadFilesDir(thread.id), "attached.txt");
    assert.match((await readScopedFile(thread, { path: attachment })).content, /thread-one/);
    assert.match((await readScopedFile({ ...thread, cwd: null }, { path: attachment })).content, /thread-one/);
    await assert.rejects(readScopedFile(thread, { path: path.join(threadFilesDir("thread-two"), "attached.txt") }), /outside/);
    await assert.rejects(readScopedFile({ ...thread, mode: "board", cwd: null }, { path: attachment }), /mode/);
    const escape = path.join(dependency, "escape");
    await fs.symlink(repo, escape, "junction");
    await assert.rejects(readScopedFile(thread, { path: "node_modules/escape/private.txt" }), /link target/);
    await fs.unlink(escape);
    // A link listed by Scribe must still point to its recorded main-checkout counterpart.
    await fs.unlink(linked);
    await fs.symlink(repo, linked, "junction");
    await assert.rejects(readScopedFile(thread, { path: "node_modules/private.txt" }), /link target/);
  } finally {
    if (previousHome === undefined) delete process.env.SCRIBE_HOME;
    else process.env.SCRIBE_HOME = previousHome;
    await fs.unlink(linked).catch(() => {});
    await fs.unlink(path.join(dependency, "escape")).catch(() => {});
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("scribe-read-roots-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});
