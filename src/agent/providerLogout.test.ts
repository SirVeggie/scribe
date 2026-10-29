import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { authCommand } from "./providers/authCommand.js";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-logout-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
before(() => store.load());
after(() => { store.closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

test("logout refuses busy chats, clears account caches, and drops idle sessions", async () => {
  const host = new AgentHost(() => {}, async () => null);
  const internal = host as any;
  internal.fakes = {}; // No real SDK or credential commands in this test.
  let calls = 0;
  let disposed = 0;
  internal.providers.codex.logout = async () => { calls++; };
  const thread = host.createThread({ provider: "codex" });
  internal.status.set(thread.id, "running");
  try {
    await assert.rejects(host.providerLogout("codex"), /Finish or stop Codex chats/);
    assert.equal(calls, 0);
    internal.status.set(thread.id, "idle");
    internal.sessions.set(thread.id, { dispose: () => { disposed++; } });
    internal.planLimits = { codex: { at: 1, windows: [] }, claude: { at: 2, windows: [] } };
    internal.planPace = { "codex:old": {}, "claude:keep": {} };
    internal.usageWindowStarts.observe("codex", { at: 1, windows: [{ id: "codex:codex:primary", label: "5-hour", resetsAt: Date.now() + 10000 }] });
    host.db.setSetting("models.codex", [{ id: "old-account-model" }]);
    await host.providerLogout("codex");
    assert.equal(calls, 1);
    assert.equal(disposed, 1);
    assert.equal(internal.sessions.has(thread.id), false);
    assert.equal(host.limits().codex, undefined);
    assert.equal(host.limits().claude?.at, 2);
    assert.deepEqual(host.cachedModels("codex"), []);
    assert.deepEqual(internal.planPace, { "claude:keep": {} });
    assert.equal(internal.usageWindowStarts.view("codex"), undefined);
    assert.equal(host.listThreads().some(t => t.id === thread.id), true);
  } finally { host.dispose(); }
});

test("failed logout retains cached quota and releases the auth lock", async () => {
  const host = new AgentHost(() => {}, async () => null);
  const internal = host as any;
  internal.fakes = {};
  internal.providers.cursor.logout = async () => { throw new Error("logout failed"); };
  internal.planLimits.cursor = { at: 12, windows: [] };
  try {
    await assert.rejects(host.providerLogout("cursor"), /logout failed/);
    assert.equal(host.limits().cursor?.at, 12);
    assert.equal(internal.loggingOut.size, 0);
  } finally { host.dispose(); }
});

test("credential commands propagate failures without exposing command output", async () => {
  await authCommand(process.execPath, ["-e", "process.exit(0)"], process.env, "Test logout");
  await assert.rejects(authCommand(process.execPath, ["-e", "console.error('private credential'); process.exit(2)"], process.env, "Test logout"), error => {
    assert.match((error as Error).message, /Test logout failed/);
    assert.doesNotMatch((error as Error).message, /private credential/);
    return true;
  });
});

test("Codex clears both shared credential stores and Claude uses its auth logout command", async (t) => {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  t.mock.method(childProcess, "execFile", ((file: string, args: string[], options: { env: NodeJS.ProcessEnv }, callback: (error: null) => void) => {
    calls.push({ file, args, env: options.env });
    callback(null);
    return {};
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try {
    const { CodexProvider, scribeCodexHome } = await import("./providers/codex.js");
    const { ClaudeProvider } = await import("./providers/claude.js");
    await new CodexProvider().logout();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].file, process.execPath);
    assert.equal(calls[0].args.at(-1), "logout");
    assert.equal(calls[0].env.CODEX_HOME, undefined);
    assert.equal(calls[1].env.CODEX_HOME, scribeCodexHome());
    await new ClaudeProvider().logout();
    assert.deepEqual(calls[2].args, ["auth", "logout"]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
