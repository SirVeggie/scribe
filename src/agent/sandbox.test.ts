import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { policyFor, type PolicyEnv } from "./access.js";
import { blockSummary, claudeSandbox, openHostAllowed, providerHosts, sandboxBlocks, sandboxed, sandboxedRun, sandboxNet, srtFilesystem, type SandboxHooks } from "./sandbox.js";
import type { Thread } from "./types.js";

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "scribe-sandbox-")));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  for (const dir of [home, data, cwd, outside, path.join(home, ".ssh")]) await fs.mkdir(dir, { recursive: true });
  const env: PolicyEnv = { home, data, tmp: path.join(root, "tmp") };
  await fs.mkdir(env.tmp!, { recursive: true });
  return { root, home, data, cwd, outside, env, done: () => fs.rm(root, { recursive: true, force: true }) };
}

type T = Parameters<typeof policyFor>[0];
const code = (cwd: string, extra: Partial<Thread> = {}): T => ({ id: "sandbox-test", cwd, mode: "code", approval: "edits", provider: "pi", ...extra }) as T;

test("the sandbox applies to Code mode short of Full access, on Linux only", () => {
  assert.equal(sandboxed({ mode: "code", approval: "edits" }, "linux"), true);
  assert.equal(sandboxed({ mode: "code", approval: "auto" }, "linux"), true);
  assert.equal(sandboxed({ mode: "code", approval: "full" }, "linux"), false);
  assert.equal(sandboxed({ mode: "board", approval: "edits" }, "linux"), false);
  // Windows and macOS stay as they were until #900.
  assert.equal(sandboxed({ mode: "code", approval: "edits" }, "win32"), false);
  assert.equal(sandboxed({ mode: "code", approval: "edits" }, "darwin"), false);
});

test("srtFilesystem writes only to the roots and keeps protected paths and links closed", async () => {
  const f = await fixture();
  try {
    const policy = policyFor(code(f.cwd), f.env);
    const fsCfg = srtFilesystem(policy);
    assert.ok(fsCfg.allowWrite.includes(f.cwd));
    assert.ok(fsCfg.allowWrite.includes(f.env.tmp!), "the temp folder is a write root for the OS sandbox");
    assert.ok(!fsCfg.allowWrite.includes(f.outside));
    assert.ok(fsCfg.denyRead.includes(f.data), "Scribe's data folder");
    assert.ok(fsCfg.denyRead.includes(path.join(f.home, ".ssh")));
    // The data folder is not inside a write root, so it needs no write deny (that would close a worktree inside it).
    assert.ok(!fsCfg.denyWrite.includes(f.data));
  } finally {
    await f.done();
  }
});

test("srtFilesystem reopens the thread's own folder inside Scribe's data and denies writes to a protected path inside the workspace", async () => {
  const f = await fixture();
  try {
    const wt = path.join(f.data, "worktrees", "repo-1", "thread-1");
    const secret = path.join(f.cwd, "secrets");
    await fs.mkdir(wt, { recursive: true });
    await fs.mkdir(secret, { recursive: true });
    const inData = srtFilesystem(policyFor(code(wt), f.env));
    assert.ok(inData.allowRead.includes(wt), "a worktree in the data folder is readable again");
    assert.ok(inData.allowWrite.includes(wt));
    assert.ok(!inData.denyWrite.some((p) => p === f.data));
    const userProtected = srtFilesystem(policyFor(code(f.cwd), { ...f.env, protectedPaths: [secret] }));
    assert.ok(userProtected.denyRead.includes(secret));
    assert.ok(userProtected.denyWrite.includes(secret), "a protected path inside a write root stays unwritable");
  } finally {
    await f.done();
  }
});

test("sandboxNet follows the Web setting: provider hosts when off, the allowlist when limited, any host when on", () => {
  const off = sandboxNet({ mode: "code", approval: "edits", provider: "claude", web: "off" }, ["github.com"], 4747);
  assert.equal(off.open, false);
  assert.ok(off.allow.includes("anthropic.com") && off.allow.includes("*.anthropic.com"));
  assert.ok(!off.allow.includes("github.com"));
  // Loopback only to Scribe's own port.
  assert.ok(off.allow.includes("127.0.0.1:4747") && off.allow.includes("localhost:4747"));
  assert.ok(!off.allow.some((h) => h === "localhost" || h === "127.0.0.1"));

  const limited = sandboxNet({ mode: "code", approval: "edits", provider: "codex", web: "limited", webGrants: { domains: ["example.org"] } }, ["github.com"], 4747);
  assert.equal(limited.open, false);
  for (const h of ["github.com", "*.github.com", "example.org", "*.example.org", "openai.com"]) assert.ok(limited.allow.includes(h), h);

  assert.equal(sandboxNet({ mode: "code", approval: "edits", provider: "pi", web: "on" }, [], 4747).open, true);
  assert.equal(sandboxNet({ mode: "code", approval: "edits", provider: "pi", web: "off", webGrants: { all: true } }, [], 4747).open, true);
});

test("providerHosts reads Native's model provider from the model id", () => {
  assert.deepEqual(providerHosts({ provider: "pi", model: "openrouter/anthropic/claude" }), ["openrouter.ai"]);
  assert.deepEqual(providerHosts({ provider: "pi", model: "somewhere-unknown/x" }), []);
  assert.deepEqual(providerHosts({ provider: "cursor" }), ["cursor.sh", "cursor.com"]);
});

test("open hosts: names and public addresses pass, loopback and private ranges never do", () => {
  assert.equal(openHostAllowed("example.com"), true);
  assert.equal(openHostAllowed("8.8.8.8"), true);
  for (const host of ["localhost", "app.localhost", "127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.0.1", "169.254.169.254", "[::1]", "fd00::1"]) {
    assert.equal(openHostAllowed(host), false, host);
  }
});

test("claudeSandbox carries the policy and makes the list strict unless web is on", async () => {
  const f = await fixture();
  try {
    const policy = policyFor(code(f.cwd), f.env);
    const strict = claudeSandbox({ policy, net: { open: false, allow: ["anthropic.com"] } });
    assert.equal(strict.enabled, true);
    assert.equal(strict.allowUnsandboxedCommands, false);
    assert.equal((strict.network as { strictAllowlist?: boolean }).strictAllowlist, true);
    assert.deepEqual(strict.filesystem, srtFilesystem(policy));
    const open = claudeSandbox({ policy, net: { open: true, allow: [] } });
    assert.equal((open.network as { strictAllowlist?: boolean }).strictAllowlist, undefined);
  } finally {
    await f.done();
  }
});

test("sandboxBlocks keeps writes the policy refuses, offers their folder, and never offers a protected path or a private host", async () => {
  const f = await fixture();
  try {
    const policy = policyFor(code(f.cwd), f.env);
    const outsideFile = path.join(f.outside, "new.txt");
    const blocks = sandboxBlocks(
      [
        // The Linux monitor reports every write outside srt's session list; inside the workspace it is fine.
        `deny openat ${path.join(f.cwd, "ok.txt")}`,
        `deny openat ${outsideFile}`,
        `deny openat ${outsideFile}`,
        `deny unlinkat ${path.join(f.home, ".ssh", "id_ed25519")}`,
        "deny network-outbound example.com:443 (host is not on the allow list)",
        "deny network-outbound internal.example:80 (resolved to a private address)",
        "deny network-outbound 10.0.0.5:22 (not allowed by this thread's Web setting)",
        "something else entirely",
      ],
      policy,
    );
    assert.deepEqual(
      blocks.map((b) => [b.op, b.target, b.grant ?? null]),
      [
        ["write", outsideFile, { kind: "folder", path: f.outside }],
        ["write", path.join(f.home, ".ssh", "id_ed25519"), null],
        ["network", "example.com:443", { kind: "host", host: "example.com" }],
        ["network", "internal.example:80", null],
        ["network", "10.0.0.5:22", null],
      ],
    );
    assert.match(blockSummary(blocks), /^The sandbox blocked: write .*new\.txt; .*connect to example\.com:443/);
  } finally {
    await f.done();
  }
});

test("sandboxedRun runs the command as is without a sandbox, and when srt cannot start says so once per call", async () => {
  const plain = await sandboxedRun(null, "echo hi", {}, async (line) => line);
  assert.deepEqual(plain, { result: "echo hi" });
  const missing: string[] = [];
  const hooks: SandboxHooks = {
    spec: () => ({ policy: policyFor(code(os.tmpdir()), {}), net: { open: false, allow: [] } }),
    blocked: async () => "blocked",
    missing: (reason) => missing.push(reason),
  };
  // Not Linux (or no bubblewrap): the wrap fails, the command still runs.
  if (process.platform !== "linux") {
    const run = await sandboxedRun(hooks, "echo hi", {}, async (line) => line);
    assert.equal(run.result, "echo hi");
    assert.equal(missing.length, 1);
  }
  const off: SandboxHooks = { ...hooks, spec: () => null };
  assert.deepEqual(await sandboxedRun(off, "echo hi", {}, async (line) => line), { result: "echo hi" });
});
