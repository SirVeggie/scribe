import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanLimits } from "./types.js";
import { UsageWindowStarts, START_DELAY_MS, cleanWindowStarts, fiveHourReset, type WindowStartState, type WindowProvider } from "./usageWindowStarts.js";

const reset = 1_900_000_000_000;
function quota(provider: WindowProvider, at = reset): PlanLimits {
  return { at: reset, ordinaryUsageAllowed: true, availability: "available", windows: [
    { id: provider === "claude" ? "five_hour" : "codex:codex:primary", label: "5-hour", utilization: 0, resetsAt: at },
  ] };
}
function fixture(initial: WindowStartState = {}) {
  let now = reset;
  let enabled = { claude: true, codex: true };
  let state = structuredClone(initial);
  let busy = false;
  let fail = false;
  let pending: (() => Promise<void>) | undefined;
  const calls: WindowProvider[] = [];
  const reports: Record<WindowProvider, PlanLimits | null> = { claude: quota("claude"), codex: quota("codex") };
  const deps = {
    now: () => now, enabled: () => enabled, running: () => busy,
    read: async (p: WindowProvider) => reports[p],
    start: async (p: WindowProvider, signal: AbortSignal) => {
      assert.equal(state[p]?.result, "Sending"); // persisted before sending
      calls.push(p);
      if (pending) await pending();
      signal.throwIfAborted();
      if (fail) throw new Error("provider failure");
    },
    save: (s: WindowStartState) => { state = structuredClone(s); },
  };
  const scheduler = new UsageWindowStarts(deps, structuredClone(initial));
  return { scheduler, calls, reports, deps, state: () => state,
    time: (t: number) => { now = t; }, enable: (v: typeof enabled) => { enabled = v; },
    busy: () => { busy = true; }, fail: () => { fail = true; }, pending: (p: () => Promise<void>) => { pending = p; } };
}

test("an account change discards a pending old-account quota probe", async () => {
  const f = fixture();
  f.enable({ claude: false, codex: true });
  f.time(reset + START_DELAY_MS);
  let resolve!: (report: PlanLimits) => void;
  f.deps.read = () => new Promise<PlanLimits>(r => { resolve = r; });
  const pending = f.scheduler.tick();
  f.scheduler.reset("codex");
  resolve(quota("codex"));
  await pending;
  assert.deepEqual(f.calls, []);
  assert.equal(f.state().codex, undefined);
});

test("both providers send once at reset plus ten minutes, with restart deduplication", async () => {
  const f = fixture();
  await f.scheduler.tick();
  f.time(reset + START_DELAY_MS - 1);
  await f.scheduler.tick();
  assert.deepEqual(f.calls, []);
  f.time(reset + START_DELAY_MS);
  await f.scheduler.tick();
  assert.deepEqual(f.calls.sort(), ["claude", "codex"]);
  await f.scheduler.tick();
  const restarted = new UsageWindowStarts(f.deps, f.state());
  f.time(reset + START_DELAY_MS + 5 * 60_000);
  await restarted.tick();
  assert.equal(f.calls.length, 2);
});

test("a newer server reset cancels the old due attempt; no locally projected cycles", async () => {
  const f = fixture();
  await f.scheduler.tick();
  f.time(reset + START_DELAY_MS);
  f.reports.claude = quota("claude", reset + 5 * 60 * 60_000);
  await f.scheduler.tick();
  assert.deepEqual(f.calls, ["codex"]);
  f.time(reset + 25 * 60 * 60_000);
  f.reports.claude = null;
  await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
});

test("disabled providers do not read or send, and settings normalize strictly", async () => {
  const f = fixture();
  f.enable({ claude: false, codex: false });
  f.time(reset + START_DELAY_MS);
  await f.scheduler.tick();
  assert.deepEqual(f.state(), {});
  assert.deepEqual(cleanWindowStarts({ claude: true, codex: "true" }), { claude: true, codex: false });
});

test("ongoing work and weekly exhaustion skip the cycle", async () => {
  for (const reason of ["busy", "weekly", "permission", "missing", "unavailable"]) {
    const f = fixture();
    if (reason === "busy") f.busy();
    if (reason === "weekly") for (const p of ["claude", "codex"] as const) f.reports[p]!.windows.push({
      id: p === "claude" ? "seven_day" : "codex:codex:secondary", label: "Weekly", utilization: 1, resetsAt: reset + 7 * 86400_000 });
    if (reason === "permission") { f.enable({ claude: false, codex: true }); f.reports.codex!.ordinaryUsageAllowed = false; }
    if (reason === "missing") for (const p of ["claude", "codex"] as const) f.reports[p]!.windows = [];
    if (reason === "unavailable") for (const p of ["claude", "codex"] as const) f.reports[p]!.availability = "unavailable";
    f.scheduler.observe("claude", quota("claude"));
    f.scheduler.observe("codex", quota("codex"));
    f.time(reset + START_DELAY_MS);
    await f.scheduler.tick();
    assert.deepEqual(f.calls, [], reason);
  }
});

test("failed requests are not retried, even much later", async () => {
  const f = fixture();
  f.fail();
  f.time(reset + START_DELAY_MS);
  await f.scheduler.tick();
  f.time(reset + 50 * 60 * 60_000);
  await f.scheduler.tick();
  assert.equal(f.calls.length, 2);
  assert.match(f.state().claude!.result!, /no retry/);
});

test("parallel ticks cannot duplicate a request and disposal aborts pending work", async () => {
  const f = fixture();
  let finish!: () => void;
  f.pending(() => new Promise<void>((resolve) => { finish = resolve; }));
  f.enable({ claude: true, codex: false });
  f.time(reset + START_DELAY_MS);
  const first = f.scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  f.scheduler.dispose();
  finish();
  await first;
});

test("Codex model buckets cannot masquerade as the main five-hour window", () => {
  const q = quota("codex");
  q.windows[0].label = "Codex Plan · 5-hour";
  assert.equal(fiveHourReset("codex", q), reset);
  q.windows[0].id = "codex:spark:primary";
  assert.equal(fiveHourReset("codex", q), undefined);
});

test("a newly reported next window schedules a new attempt ten minutes after its reset", async () => {
  const f = fixture();
  f.enable({ claude: true, codex: false });
  f.time(reset + START_DELAY_MS);
  await f.scheduler.tick();
  const next = reset + START_DELAY_MS + 5 * 60 * 60_000;
  f.reports.claude = quota("claude", next);
  f.scheduler.observe("claude", f.reports.claude);
  f.time(next + START_DELAY_MS - 1);
  await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  f.time(next + START_DELAY_MS);
  await f.scheduler.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.state().claude?.attempted, next);
});

test("disabling during a quota read prevents sending", async () => {
  const f = fixture();
  f.enable({ claude: true, codex: false });
  let resolve!: (q: PlanLimits) => void;
  f.deps.read = () => new Promise((r) => { resolve = r; });
  f.time(reset + START_DELAY_MS);
  const pending = f.scheduler.tick();
  f.enable({ claude: false, codex: false });
  f.scheduler.settingsChanged();
  resolve(quota("claude"));
  await pending;
  assert.deepEqual(f.calls, []);
});
