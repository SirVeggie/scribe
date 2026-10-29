import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeProvider } from "./providers/claude.js";
import { CursorProvider } from "./providers/cursor.js";
import { SparePool, type SessionContext } from "./providers/provider.js";
import type { Thread } from "./types.js";

class FakeSession {
  constructor(private id: string) {}
  scribeThreadId() {
    return this.id;
  }
  disposed = false;
  updated: string | null = null;
  dispose() {
    this.disposed = true;
  }
  update(thread: Thread) {
    this.updated = thread.id;
  }
}

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: "th_a",
    title: "T",
    titleLocked: false,
    provider: "claude",
    model: "default",
    effort: null,
    modelParams: {},
    mode: "board",
    approval: "edits",
    web: "off",
    scope: { kind: "page", ref: "t_1" },
    cwd: null,
    nativeId: null,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    activityAt: 1,
    ...over,
  };
}

function ctx(): SessionContext {
  return { boardMcp: { command: "node", args: [], env: {} }, scratchDir: "/tmp/scribe-scratch", webAllowlist: () => [] };
}

function poolOf(provider: { dispose(): void }): SparePool<FakeSession> {
  return (provider as unknown as { spares: SparePool<FakeSession> }).spares;
}

test("take with a thread id only returns the spare warmed for that thread", () => {
  const pool = new SparePool<FakeSession>();
  const spare = new FakeSession("th_a");
  pool.put("k", spare);
  assert.equal(pool.take("k", "th_b"), null);
  assert.equal(pool.get("k"), spare);
  assert.equal(spare.disposed, false);
  assert.equal(pool.take("k", "th_a"), spare);
  assert.equal(pool.get("k"), null);
  pool.dispose();
});

test("a second thread that sends first does not consume the spare, so the matching thread can still take it", () => {
  const pool = new SparePool<FakeSession>();
  const spare = new FakeSession("th_a");
  pool.put("settings", spare);
  assert.equal(pool.take("settings", "th_b"), null);
  assert.equal(pool.take("settings", "th_c"), null);
  assert.equal(pool.take("settings", "th_a"), spare);
  pool.dispose();
});

test("take without a thread id still removes the spare (replace, TTL, dispose)", () => {
  const pool = new SparePool<FakeSession>();
  const spare = new FakeSession("th_a");
  pool.put("k", spare);
  assert.equal(pool.take("k"), spare);
  assert.equal(pool.get("k"), null);
  assert.equal(spare.disposed, false);
  pool.dispose();
});

test("put replaces the spare for a key even when thread ids differ", () => {
  const pool = new SparePool<FakeSession>();
  const a = new FakeSession("th_a");
  const b = new FakeSession("th_b");
  pool.put("k", a);
  pool.put("k", b);
  assert.equal(a.disposed, true);
  assert.equal(pool.take("k", "th_a"), null);
  assert.equal(pool.take("k", "th_b"), b);
  pool.dispose();
});

test("Claude createSession leaves the spare when a different thread sends first", () => {
  const provider = new ClaudeProvider();
  const spare = new FakeSession("th_a");
  const a = thread({ id: "th_a" });
  const key = JSON.stringify([a.mode, "", a.web, a.cwd, a.scope.kind, a.scope.ref, null]);
  poolOf(provider).put(key, spare);
  const other = provider.createSession(thread({ id: "th_b" }), ctx());
  assert.notEqual(other, spare);
  assert.equal(provider.spareThreadId(a), "th_a");
  assert.equal(provider.createSession(a, ctx()), spare);
  assert.equal(spare.updated, "th_a");
  other.dispose();
  provider.dispose();
});

test("Cursor createSession leaves the spare when a different thread sends first", () => {
  const provider = new CursorProvider();
  const sessionCtx = ctx();
  const spare = new FakeSession("th_a");
  const a = thread({ id: "th_a", provider: "cursor" });
  const key = JSON.stringify([`board:${sessionCtx.scratchDir}`, a.mode, "", a.web, a.approval, false, sessionCtx.webSearchUrl?.() ?? ""]);
  poolOf(provider).put(key, spare);
  const other = provider.createSession(thread({ id: "th_b", provider: "cursor" }), sessionCtx);
  assert.notEqual(other, spare);
  assert.equal(provider.spareThreadId(a, sessionCtx), "th_a");
  assert.equal(provider.createSession(a, sessionCtx), spare);
  assert.equal(spare.updated, "th_a");
  other.dispose();
  provider.dispose();
});

