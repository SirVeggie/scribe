import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { AgentEvent, PlanLimits, Turn } from "./types.js";
import type { UsageWindowStarts } from "./usageWindowStarts.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-codex-quota-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
before(() => store.load());
after(() => { store.closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

type Internals = {
  usageWindowStarts: UsageWindowStarts;
  providers: { codex: { startUsageWindow(signal: AbortSignal): Promise<void>; startLogin(onLogin?: () => void): Promise<{ url: string | null }> } };
  refreshCodexUsage(): Promise<void>;
  recordLimits(provider: "codex" | "claude", info: unknown): void;
  codexUsageFetchAt: number;
  codexUsageTimer: NodeJS.Timeout | null;
};

test("expired Claude windows keep the reported reset, and sparse notifications cannot reschedule them", () => {
  const host = new AgentHost(() => {}, async () => quota(true));
  const internal = host as unknown as Internals;
  try {
    const reset = Date.now() - 1000;
    internal.recordLimits("claude", { rateLimitType: "five_hour", utilization: 0.2, resetsAt: reset });
    const before = internal.usageWindowStarts.view("claude")!.reset;
    const projected = host.limits().claude!;
    assert.equal(projected.windows[0].resetsAt, reset);
    assert.equal(projected.windows[0].expired, true);
    assert.equal(projected.windows[0].utilization, 0);
    (host as unknown as { planLimits: { claude: PlanLimits } }).planLimits.claude = projected;
    internal.recordLimits("claude", { status: "allowed" });
    assert.equal(internal.usageWindowStarts.view("claude")!.reset, before);
  } finally { host.dispose(); }
});

test("host defaults window starts off and dispatches an enabled overdue reset once", async () => {
  const reset = Math.floor((Date.now() - 11 * 60_000) / 1000);
  const host = new AgentHost(() => {}, async () => ({ ordinaryUsageAllowed: true, rateLimits: {
    limitId: "codex", primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: reset },
  } }));
  const internal = host as unknown as Internals;
  let calls = 0;
  internal.providers.codex.startUsageWindow = async () => { calls++; };
  try {
    host.db.setSetting("prefs", {});
    assert.deepEqual(host.prefs().usageWindowStarts, { claude: false, codex: false });
    await internal.usageWindowStarts.tick();
    assert.equal(calls, 0);
    host.db.setSetting("prefs", { usageWindowStarts: { codex: true } });
    await internal.usageWindowStarts.tick();
    await internal.usageWindowStarts.tick();
    assert.equal(calls, 1);
    assert.equal(host.limits().codex?.windowStart?.result, "Sent");
    assert.equal(host.db.getSetting<{ codex: { attempted: number } }>("usageWindowStarts", {} as never).codex.attempted, reset * 1000);
  } finally { host.db.setSetting("prefs", {}); host.dispose(); }
});
const quota = (allowed: boolean | null) => ({ ordinaryUsageAllowed: allowed, rateLimits: {
  limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) - 1 },
} });

test("successful Codex login refreshes expired auth quota without waiting for the poll interval", async () => {
  let expired = true;
  const host = new AgentHost(() => {}, async () => {
    if (expired) throw new Error("401 expired refresh token");
    return quota(true);
  });
  const internal = host as unknown as Internals;
  let completeLogin: (() => void) | undefined;
  internal.providers.codex.startLogin = async (onLogin) => {
    completeLogin = onLogin;
    return { url: null };
  };
  try {
    await internal.refreshCodexUsage();
    await host.codexLogin();
    assert.equal(host.limits().codex?.availability, "authentication_required");
    expired = false;
    assert.ok(completeLogin);
    completeLogin();
    await internal.refreshCodexUsage();
    assert.equal(host.limits().codex?.availability, "available");
  } finally { host.dispose(); }
});

test("host polls and persists Codex quota, throttles parallel reads and forwards sparse updates", async () => {
  const events: AgentEvent[] = [];
  let calls = 0;
  const host = new AgentHost((e) => events.push(e), async () => { calls++; return quota(false); });
  const internal = host as unknown as Internals;
  try {
    await Promise.all([internal.refreshCodexUsage(), internal.refreshCodexUsage()]);
    assert.equal(calls, 1);
    assert.equal(host.limits().codex?.windows[0].utilization, 1); // No reset overlay.
    assert.equal(host.db.getSetting<{ codex: PlanLimits }>("limits", {} as { codex: PlanLimits }).codex.ordinaryUsageAllowed, false);
    internal.recordLimits("codex", { rateLimits: { limitId: "codex", primary: { usedPercent: 0 } } });
    assert.equal(host.limits().codex?.windows[0].utilization, 0);
    assert.equal(host.limits().codex?.ordinaryUsageAllowed, false);
    assert.equal(calls, 1);
    assert.ok(events.some((e) => e.type === "agent_limits"));
    assert.ok(internal.codexUsageTimer);
  } finally { host.dispose(); }
});

test("host blocks automatic recovery until a full read authorizes it, and clears expired auth quota", async () => {
  let report: unknown = quota(false);
  let error: Error | null = null;
  const host = new AgentHost(() => {}, async () => { if (error) throw error; return report; });
  const internal = host as unknown as Internals;
  try {
    const thread = host.createThread({ provider: "codex", mode: "board", scope: { kind: "global", ref: null } });
    const now = Date.now();
    host.db.saveTurn({ id: "quota-turn", threadId: thread.id, seq: 1, status: "error", model: "default", effort: null,
      mode: "board", startedAt: now - 2000, endedAt: now - 1000, limitResetsAt: now - 100, error: "You've hit your usage limit" } as Turn);
    const recovery = () => { const info = host.runInfo(thread.id); return info.exists ? info.lastTurn?.usageRecoveryAllowed : undefined; };
    await internal.refreshCodexUsage();
    assert.equal(recovery(), false);
    assert.throws(() => host.send(thread.id, { from: "page", text: "resume" }), /not confirmed/);
    assert.equal(host.threadDetail(thread.id)?.items.length, 0);
    internal.recordLimits("codex", { rateLimits: { limitId: "codex", primary: { usedPercent: 0 } } });
    assert.equal(recovery(), false);
    internal.codexUsageFetchAt = 0;
    report = quota(true);
    await internal.refreshCodexUsage();
    assert.equal(recovery(), true);
    internal.codexUsageFetchAt = 0;
    error = new Error("401 Unauthorized: expired refresh token");
    await internal.refreshCodexUsage();
    assert.equal(recovery(), false);
    assert.equal(host.limits().codex?.availability, "authentication_required");
    assert.equal(host.limits().codex?.windows.length, 0);
    assert.match(host.limits().codex?.detail ?? "", /Log in again/);
    internal.codexUsageFetchAt = 0;
    error = new Error("app-server exited");
    await internal.refreshCodexUsage();
    assert.equal(host.limits().codex?.availability, "unavailable");
  } finally { host.dispose(); }
});

test("disposing during a quota read prevents writes and rescheduling", async () => {
  let resolve!: (value: unknown) => void;
  const host = new AgentHost(() => {}, () => new Promise((r) => { resolve = r; }));
  const internal = host as unknown as Internals;
  const pending = internal.refreshCodexUsage();
  host.dispose();
  resolve(quota(true));
  await pending;
});

test("live Codex quota clears probe errors without granting recovery permission", async () => {
  const host = new AgentHost(() => {}, async () => { throw new Error("401 expired refresh token"); });
  const internal = host as unknown as Internals;
  try {
    await internal.refreshCodexUsage();
    assert.equal(host.limits().codex?.availability, "authentication_required");
    internal.recordLimits("codex", { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } } });
    const limits = host.limits().codex!;
    assert.equal(limits.availability, "available");
    assert.equal(limits.detail, undefined);
    assert.equal(limits.windows[0].utilization, 0.25);
    assert.equal(limits.ordinaryUsageAllowed, null);
    assert.equal(limits.permissionAt, undefined);
  } finally { host.dispose(); }
});

test("a failed background probe cannot overwrite quota reported while it was running", async () => {
  let reject!: (error: Error) => void;
  const host = new AgentHost(() => {}, () => new Promise((_resolve, r) => { reject = r; }));
  const internal = host as unknown as Internals;
  try {
    const pending = internal.refreshCodexUsage();
    internal.recordLimits("codex", { rateLimits: { primary: { usedPercent: 40 } } });
    reject(new Error("401 expired refresh token"));
    await pending;
    assert.equal(host.limits().codex?.availability, "available");
    assert.equal(host.limits().codex?.detail, undefined);
    assert.equal(host.limits().codex?.windows[0].utilization, 0.4);
    assert.equal(host.limits().codex?.ordinaryUsageAllowed, null);
  } finally { host.dispose(); }
});
