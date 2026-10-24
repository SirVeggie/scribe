import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { claudePlanSnapshot } from "./claudeUsage.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-claude-quota-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
before(() => store.load());
after(() => { store.closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

test("Claude caches survive failed background reads and host restarts without crossing thread sources", async () => {
  let host = new AgentHost(() => {}, async () => null);
  let internal = host as any;
  const source = { tokenSource: "oauth", email: "one@example.invalid" };
  const snapshot = claudePlanSnapshot({ rate_limits: { five_hour: { utilization: 60, resets_at: 1 } } }, source, 100);
  let threadId: string;
  try {
    // Disable automatic probes; every read in this test is an explicit local double.
    internal.fakes = {};
    threadId = host.createThread({ provider: "claude" }).id;
    internal.ctx.claudeLimits(threadId, snapshot);
    internal.commitLimits("claude", snapshot, false);
    for (const response of [null, { report: null, billingSource: source }, new Error("probe failed")]) {
      internal.providers.claude.fetchPlanUsage = async () => {
        if (response instanceof Error) throw response;
        return response;
      };
      internal.lastUsageFetchAt = 0;
      await internal.refreshClaudeUsage();
      assert.equal(host.limits().claude?.windows[0].utilization, 0.6);
      assert.equal(host.limits().claude?.at, 100);
    }
    internal.ctx.claudeLimits(threadId, claudePlanSnapshot(null, source, 200));
    assert.equal(internal.claudeThreadLimits.get(threadId).at, 100);
  } finally { host.dispose(); }

  host = new AgentHost(() => {}, async () => null);
  internal = host as any;
  try {
    internal.fakes = {};
    assert.equal(host.limits().claude?.windows[0].utilization, 0.6);
    assert.equal(internal.claudeThreadLimits.get(threadId!).at, 100);
    internal.ctx.claudeLimits(threadId!, claudePlanSnapshot(null, { apiProvider: "bedrock" }, 300));
    assert.equal(internal.claudeThreadLimits.get(threadId!).windows.length, 0);
    await host.deleteThread(threadId!);
    assert.equal(host.db.getSetting<Record<string, unknown>>("claudeThreadLimits", {})[threadId!], undefined);
  } finally { host.dispose(); }
});

test("Claude account refresh survives busy turns and throttling with one retry timer", async (t) => {
  const host = new AgentHost(() => {}, async () => null);
  const internal = host as any;
  internal.fakes = {};
  const now = 1_800_000_000_000;
  const timers: Array<{ callback: () => void; delay: number; active: boolean; unref: () => void }> = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
    const timer = { callback, delay, active: true, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer: any) => { timer.active = false; });
  let reads = 0;
  let busy = true;
  internal.claudeTurnRunning = () => busy;
  internal.providers.claude.fetchPlanUsage = async () => {
    reads++;
    return { report: { rate_limits: { five_hour: { utilization: 42 } } }, billingSource: {} };
  };
  try {
    internal.lastUsageFetchAt = now - 4 * 60_000;
    await internal.refreshClaudeUsage();
    await internal.refreshClaudeUsage();
    assert.equal(reads, 0);
    assert.deepEqual(timers.filter(timer => timer.active).map(timer => timer.delay), [30_000]);

    internal.lastUsageFetchAt = now - 5 * 60_000;
    await internal.refreshClaudeUsage();
    assert.equal(reads, 1, "continuous turns cannot indefinitely defer the account probe");
    assert.equal(host.limits().claude?.windows[0].utilization, 0.42);
    assert.equal(timers.filter(timer => timer.active).length, 0);

    busy = false;
    internal.lastUsageFetchAt = now - 10_000;
    await internal.refreshClaudeUsage();
    await internal.refreshClaudeUsage();
    assert.equal(reads, 1);
    const pending = timers.filter(timer => timer.active);
    assert.deepEqual(pending.map(timer => timer.delay), [50_000]);
    internal.commitLimits("codex", { at: now, source: "codex", availability: "available", windows: [] }, false);
    assert.equal(pending[0].active, true, "another provider cannot cancel Claude's pending refresh");
    // Run the retained request at the end of its throttle window.
    internal.lastUsageFetchAt = now - 60_000;
    pending[0].callback();
    await internal.usageFetch;
    assert.equal(reads, 2);
    assert.equal(timers.filter(timer => timer.active).length, 0);
  } finally { host.dispose(); }
});
