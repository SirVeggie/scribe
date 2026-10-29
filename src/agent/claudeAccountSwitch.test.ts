import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { RunSink, SessionContext, TurnInput, TurnResult } from "./providers/provider.js";
import type { Item, Thread } from "./types.js";

// Scratch data, and a scratch default Claude folder so account folders never link into the real one.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-accounts-host-"));
process.env.SCRIBE_HOME = dir;
process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude-default");
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;
const runs: Array<{ threadId: string; text: string; account?: string; env: Record<string, string> }> = [];
let next: TurnResult | null = null;
const accountDir = path.join(dir, "acc_t");

before(() => {
  store.load();
  host = new AgentHost(() => {});
  (host as unknown as { providers: Record<string, unknown> }).providers.claude = {
    id: "claude",
    label: "Claude",
    status: async () => ({ id: "claude", label: "Claude", available: true, logout: true }),
    models: async () => [],
    complete: async () => "",
    prewarm: () => {},
    dispose: () => {},
    signedIn: () => true,
    fetchPlanUsage: async () => null,
    loginAccount: async () => false,
    accountStatus: async () => null,
    logoutAccount: async () => undefined,
    loginSwapped: () => {},
    createSession: (created: Thread, ctx: SessionContext) => {
      let thread = created;
      return {
        warm: async () => {},
        update: (t: Thread) => { thread = t; },
        commands: async () => [],
        dispose: () => {},
        cancel: async () => {},
        run: async (input: TurnInput, sink: RunSink): Promise<TurnResult> => {
          runs.push({ threadId: thread.id, text: input.text, account: thread.claudeAccount, env: ctx.claudeEnv?.(thread) ?? {} });
          const result = next ?? { status: "done" as const };
          next = null;
          if (result.status === "done") sink.text("ok");
          return result;
        },
      };
    },
  };
  // An added account, as a finished sign-in leaves it.
  const pool = (host as unknown as { claudePool: { state: { accounts: unknown[] } } }).claudePool;
  pool.state.accounts.push({ id: "acc_t", dir: accountDir, email: "second@example.com", addedAt: 1 });
});

after(() => {
  host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "timed out");
}

const view = (id: string) => host.listThreads().find((t) => t.id === id)!;
const items = (id: string) => (host as unknown as { loadItems(id: string): Item[] }).loadItems(id);
const card = (id: string) => items(id).find((it): it is Extract<Item, { kind: "usage_limit" }> => it.kind === "usage_limit");

test("a Claude chat gets an account, and a usage limit offers going on with the other one", async () => {
  const thread = host.createThread({ provider: "claude", approval: "full", cwd: dir, scope: { kind: "global", ref: null } });
  next = { status: "error", error: `Claude AI usage limit reached|${Math.floor((Date.now() + 3_600_000) / 1000)}` };
  host.send(thread.id, { text: "do the thing" });
  await until(() => view(thread.id).status === "idle" && Boolean(card(thread.id)));
  const first = runs.at(-1)!;
  assert.ok(first.account === "default" || first.account === "acc_t", "the chat runs on one of the accounts");
  assert.deepEqual(first.env, first.account === "acc_t" ? { CLAUDE_CONFIG_DIR: accountDir } : {});
  if (first.account === "acc_t") assert.ok(fs.existsSync(path.join(accountDir, "projects")), "an added account's folder shares transcripts");

  const other = first.account === "acc_t" ? "default" : "acc_t";
  const limit = card(thread.id)!;
  assert.equal(limit.switchTo?.account, other);
  assert.equal(view(thread.id).asking?.switchTo?.account, other);

  host.resolveUsageLimit(thread.id, limit.id, true, other);
  await until(() => runs.length === 2 && view(thread.id).status === "idle");
  assert.equal(card(thread.id)?.status, "resumed");
  assert.ok(card(thread.id)?.switched);
  assert.match(runs[1].text, /another Claude account/);
  assert.equal(runs[1].account, other, "the chat went on with the other account");
  assert.equal(view(thread.id).claudeAccount, other);

  // The next turn keeps the account it moved to (its cache is there now).
  host.send(thread.id, { text: "more" });
  await until(() => runs.length === 3 && view(thread.id).status === "idle");
  assert.equal(runs[2].account, other);
});

test("pinning an account moves every chat to it; an unknown account is refused", async () => {
  host.setClaudeAccountUse("acc_t");
  const thread = host.createThread({ provider: "claude", approval: "full", cwd: dir, scope: { kind: "global", ref: null } });
  host.send(thread.id, { text: "hi" });
  await until(() => runs.at(-1)?.threadId === thread.id && view(thread.id).status === "idle");
  assert.equal(runs.at(-1)!.account, "acc_t");
  assert.throws(() => host.setClaudeAccountUse("acc_nope"));
  assert.equal(host.claudeAccounts().use, "acc_t");
  host.setClaudeAccountUse("distribute");
});

test("Claude Code's own login can be traded with an added account; chats and the pin follow their account", async () => {
  const base = process.env.CLAUDE_CONFIG_DIR!;
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(accountDir, { recursive: true });
  fs.writeFileSync(path.join(base, ".credentials.json"), "secret-one");
  fs.writeFileSync(path.join(base, ".claude.json"), JSON.stringify({ theme: "dark", oauthAccount: { emailAddress: "one@example.com" } }));
  fs.writeFileSync(path.join(accountDir, ".credentials.json"), "secret-two");
  fs.writeFileSync(path.join(accountDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "second@example.com" } }));
  host.setClaudeAccountUse("acc_t");
  const thread = host.createThread({ provider: "claude", approval: "full", cwd: dir, scope: { kind: "global", ref: null } });
  host.send(thread.id, { text: "hi" });
  await until(() => runs.at(-1)?.threadId === thread.id && view(thread.id).status === "idle");
  assert.equal(view(thread.id).claudeAccount, "acc_t");

  host.setClaudeCodeAccount("acc_t");
  assert.equal(fs.readFileSync(path.join(base, ".credentials.json"), "utf8"), "secret-two");
  assert.equal(fs.readFileSync(path.join(accountDir, ".credentials.json"), "utf8"), "secret-one");
  const own = JSON.parse(fs.readFileSync(path.join(base, ".claude.json"), "utf8"));
  assert.equal(own.oauthAccount.emailAddress, "second@example.com");
  assert.equal(own.theme, "dark", "the rest of Claude Code's settings stay");
  const list = host.claudeAccounts();
  assert.equal(list.accounts.find((a) => a.default)?.email, "second@example.com");
  assert.equal(list.accounts.find((a) => a.id === "acc_t")?.email, "one@example.com");
  assert.equal(list.use, "default", "the pinned account is still second@");
  assert.equal(view(thread.id).claudeAccount, "default", "the chat stays with second@ in its new folder");
  host.setClaudeAccountUse("distribute");
});
