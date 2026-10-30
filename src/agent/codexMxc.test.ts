import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { policyFor } from "./access.js";
import { MXC_PROFILES, mxcConfig, mxcDenyPaths, mxcProfile, profileSandbox, resetWindowsSandbox, windowsSandbox } from "./codexMxc.js";
import { codexPermissions } from "./effectivePermissions.js";
import { threadOptions, turnPermissionOverrides } from "./providers/codex.js";
import type { Thread } from "./types.js";

/** A Scribe data folder with a worktree under it, and a home with a key. */
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "scribe-mxc-")));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const codexHome = path.join(data, "agent", "codex");
  const cwd = path.join(data, "worktrees", "repo-1", "mine");
  for (const dir of [path.join(home, ".ssh"), cwd, path.join(data, "worktrees", "repo-1", "other"), path.join(codexHome, "sessions"), path.join(codexHome, "tmp"), path.join(codexHome, ".sandbox-bin")]) {
    await fs.mkdir(dir, { recursive: true });
  }
  for (const file of [path.join(data, "local-token"), path.join(data, "agent-secret"), path.join(data, "scribe.sqlite"), path.join(codexHome, "auth.json")]) await fs.writeFile(file, "x");
  return { root, home, data, codexHome, cwd, done: () => fs.rm(root, { recursive: true, force: true }) };
}

test("mxcDenyPaths denies the data folder around the thread's worktree, and the home's secrets (#916)", async () => {
  const f = await fixture();
  try {
    const policy = policyFor({ id: "th_mxc", cwd: f.cwd, mode: "code", approval: "auto", provider: "codex" } as Thread, { home: f.home, data: f.data });
    const deny = mxcDenyPaths(policy, f.codexHome);
    const has = (p: string) => deny.some((d) => path.relative(d, p) === "");
    for (const p of [path.join(f.data, "local-token"), path.join(f.data, "agent-secret"), path.join(f.data, "scribe.sqlite"),
      path.join(f.codexHome, "auth.json"), path.join(f.codexHome, "sessions"), path.join(f.data, "worktrees", "repo-1", "other"), path.join(f.home, ".ssh")]) {
      assert.ok(has(p), `${p} is denied`);
    }
    // Never the folders the worktree sits in (Node lstat's each), the worktree, or Codex's own sandbox files.
    for (const p of [f.data, path.join(f.data, "worktrees"), path.join(f.data, "worktrees", "repo-1"), f.cwd, path.join(f.codexHome, "tmp"), path.join(f.codexHome, ".sandbox-bin")]) {
      assert.ok(!deny.some((d) => path.relative(d, p) === "" || !path.relative(d, p).startsWith("..")), `${p} stays usable`);
    }
    // Missing paths are left out: MXC won't start a command under a denied path whose folder is gone.
    assert.ok(deny.every((d) => existsSync(d)));
  } finally {
    await f.done();
  }
});

test("MXC profiles: the sandbox mode picks one, and a reported profile id maps back", () => {
  assert.equal(mxcProfile("read-only", true), MXC_PROFILES.read);
  assert.equal(mxcProfile("workspace-write", false), MXC_PROFILES.write);
  assert.equal(mxcProfile("workspace-write", true), MXC_PROFILES.web);
  assert.equal(mxcProfile("danger-full-access", false), ":danger-full-access");
  for (const id of Object.values(MXC_PROFILES)) assert.ok(profileSandbox(id));
  const config = mxcConfig(["C:\\data\\local-token"], "S:\\repo\\.git") as { "windows.sandbox": string; permissions: Record<string, any> };
  assert.equal(config["windows.sandbox"], "mxc");
  assert.deepEqual(config.permissions[MXC_PROFILES.write].filesystem, { "C:/data/local-token": "deny" });
  assert.deepEqual(config.permissions[MXC_PROFILES.write].workspace_roots, { "S:/repo/.git": true });
  assert.equal(config.permissions[MXC_PROFILES.write].network.enabled, false);
  assert.equal(config.permissions[MXC_PROFILES.web].network.enabled, true);
  assert.equal(config.permissions[MXC_PROFILES.read].extends, ":read-only");
  // Legacy policy for :danger-full-access says workspace writes to C:\; the profile id wins.
  const full = codexPermissions({ sandboxPolicy: { type: "workspaceWrite" }, activePermissionProfile: { id: ":danger-full-access" }, approvalPolicy: "never" }, { sandbox: "danger-full-access" });
  assert.equal(full.sandbox, "danger-full-access");
});

test("threadOptions and turn overrides send a profile id under MXC, never a sandbox mode with it", () => {
  const t = { model: "default", effort: null, mode: "code", approval: "auto", web: "off", cwd: null } as unknown as Thread;
  const mxc = mxcConfig([], null);
  const options = threadOptions(t, "/work", "win32", mxc);
  assert.equal(options.sandbox, undefined);
  assert.equal(options.permissions, MXC_PROFILES.write);
  const config = options.config as Record<string, unknown>;
  assert.equal(config["windows.sandbox"], "mxc");
  assert.equal(config["sandbox_workspace_write.network_access"], undefined);
  assert.equal(config["sandbox_workspace_write.writable_roots"], undefined);
  const turn = turnPermissionOverrides({ ...t, web: "on" }, "/work", true);
  assert.equal(turn.sandboxPolicy, undefined);
  assert.equal(turn.permissions, MXC_PROFILES.web);
  assert.equal(turnPermissionOverrides({ ...t, approval: "full" }, "/work", true).permissions, ":danger-full-access");
  assert.equal(turnPermissionOverrides({ ...t, mode: "board" }, "/work", true).permissions, MXC_PROFILES.read);
  // Without MXC, the unelevated keys as before.
  assert.equal(threadOptions(t, "/work", "win32").sandbox, "workspace-write");
});

test("windowsSandbox: nothing off Windows; SCRIBE_CODEX_SANDBOX forces an engine", () => {
  const before = process.env.SCRIBE_CODEX_SANDBOX;
  try {
    resetWindowsSandbox("mxc");
    assert.equal(windowsSandbox("linux"), null);
    assert.equal(windowsSandbox("win32"), "mxc");
    process.env.SCRIBE_CODEX_SANDBOX = "unelevated";
    assert.equal(windowsSandbox("win32"), "unelevated");
  } finally {
    if (before === undefined) delete process.env.SCRIBE_CODEX_SANDBOX;
    else process.env.SCRIBE_CODEX_SANDBOX = before;
    resetWindowsSandbox();
  }
});
