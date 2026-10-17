import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeUsageDelta, claudeBillingSource, claudePlanSnapshot } from "./claudeUsage.js";
import { applyExpiredWindows, planLimitsFromRateLimitInfo, planLimitsFromUsageReport } from "./planLimits.js";
import { sumThreadUsage } from "./usage.js";
import type { Turn } from "./types.js";
import { ClaudeProvider } from "./providers/claude.js";
import type { Thread, PlanLimits, Usage } from "./types.js";
import type { SessionContext } from "./providers/provider.js";

const model = (n: number) => ({ inputTokens: n, outputTokens: n * 2, cacheReadInputTokens: n * 3, cacheCreationInputTokens: n * 4, contextWindow: 200000 });
const result = (n: number, cost = n / 100) => ({ subtype: "success", modelUsage: { main: model(n) }, total_cost_usd: cost });
const baseline = (n: number, cost = n / 100) => ({ session: { model_usage: { main: model(n) }, total_cost_usd: cost } });

test("streaming totals become turn deltas including cached input, not context-window deltas", () => {
  const counter = new ClaudeUsageDelta();
  counter.baseline(baseline(0));
  const a = counter.result(result(100));
  const b = counter.result(result(150));
  assert.equal(a.estimatedCostUsd, 1);
  assert.equal(a.reportedCostUsd, undefined);
  assert.equal(b.costUsd, 0.5);
  assert.equal(b.inputTokens, 50);
  assert.equal(b.cacheReadTokens, 150);
  assert.equal(b.cacheWriteTokens, 200);
  assert.equal(b.contextWindow, 200000);
  const total = sumThreadUsage([{ usage: a }, { usage: b }] as Turn[])!;
  assert.equal(total.inputTokens, 150);
  assert.equal(total.costUsd, 1.5);
});

test("resume and fork subtract SDK restored history, regardless of old Scribe totals", () => {
  for (const _kind of ["resume", "fork"]) {
    const counter = new ClaudeUsageDelta();
    counter.baseline(baseline(1000, 20));
    assert.equal(counter.result(result(1020, 20.5)).costUsd, 0.5);
    assert.equal(counter.result(result(1030, 21)).inputTokens, 10);
  }
});

test("clear starts a new epoch; startup errors cannot replace the baseline with zeros", () => {
  const counter = new ClaudeUsageDelta();
  counter.baseline(baseline(100));
  assert.equal(counter.result({ ...result(0), subtype: "error_during_execution" }).costUsd, undefined);
  assert.equal(counter.result(result(120)).inputTokens, 20);
  assert.equal(counter.result(result(5)).inputTokens, 5);
  assert.equal(counter.result(result(8)).inputTokens, 3);
  assert.equal(counter.result({ ...result(10), subtype: "error_max_turns" }).inputTokens, 2);
  assert.equal(counter.result(result(12)).inputTokens, 2);
});

test("missing baselines and malformed/zeroed errors stay unknown, then recover", () => {
  const counter = new ClaudeUsageDelta();
  counter.baseline(null);
  assert.deepEqual(counter.result(result(100)), { costPartial: true });
  assert.equal(counter.result({ modelUsage: null }).costUsd, undefined);
  assert.equal(counter.result(result(110)).inputTokens, 10);
  assert.equal(counter.result({ ...result(0), is_error: true }).inputTokens, undefined);
  assert.equal(counter.result(result(120)).inputTokens, 10);
});

test("modelUsage includes SDK subagents once; new models contribute their own deltas", () => {
  const counter = new ClaudeUsageDelta();
  counter.baseline(baseline(100));
  assert.equal(counter.result({ ...result(110), modelUsage: { main: model(110), helper: model(25) } }).inputTokens, 35);
  assert.equal(counter.result({ ...result(120), modelUsage: { main: model(120), helper: model(30) } }).inputTokens, 15);
});

test("only metadata is retained and quota snapshots never reuse another source", () => {
  const api = claudeBillingSource({ apiProvider: "firstParty", email: "test@example.invalid", apiKeySource: "env", apiKey: "secret", token: "secret" });
  assert.deepEqual(api, { apiProvider: "firstParty", email: "test@example.invalid", apiKeySource: "env" });
  const subscription = claudePlanSnapshot({ rate_limits: { five_hour: { utilization: 50 } } }, { tokenSource: "oauth" }, 1);
  const cloud = claudePlanSnapshot({ rate_limits_available: false }, { apiProvider: "bedrock" }, 2);
  assert.equal(subscription.windows.length, 1);
  assert.equal(cloud.availability, "unavailable");
  assert.equal(cloud.windows.length, 0);
  assert.equal(cloud.extraUsage, undefined);
  assert.deepEqual(cloud.billingSource, { apiProvider: "bedrock" });
  assert.equal(claudePlanSnapshot(null, {}, 3).availability, "unavailable");
});

test("period spend/cap/currency survive null utilization without asserting current overage", () => {
  for (const utilization of [null, 0, 25]) {
    const report = { rate_limits: { extra_usage: { is_enabled: true, used_credits: 2500, monthly_limit: 10000, currency: "USD", utilization } } };
    const snapshot = claudePlanSnapshot(report, { tokenSource: "oauth" }, 100);
    assert.deepEqual(snapshot.extraUsage, { at: 100, enabled: true, usedCredits: 2500, monthlyLimit: 10000, currency: "USD" });
    assert.equal(snapshot.overage, undefined);
    const live = planLimitsFromRateLimitInfo({ isUsingOverage: false }, 200, snapshot)!;
    assert.equal(live.overage, false);
    assert.equal(live.overageAt, 200);
    assert.deepEqual(live.extraUsage, snapshot.extraUsage);
  }
  assert.deepEqual(planLimitsFromUsageReport({ rate_limits: { extra_usage: { is_enabled: false, used_credits: 0 } } }, 1)?.extraUsage, { at: 1, enabled: false, usedCredits: 0 });
});

test("a passed reset retains the observed Claude percentage and marks it expired", () => {
  const limits = claudePlanSnapshot({ rate_limits: { five_hour: { utilization: 90, resets_at: 1 } } }, {}, 500);
  assert.equal(applyExpiredWindows(limits, 2000).windows[0].utilization, 0.9);
  assert.equal(applyExpiredWindows(limits, 2000).windows[0].expired, true);
});

test("empty quota probes retain the same source's timestamp and figures, but source changes clear them", () => {
  const source = { tokenSource: "oauth", email: "one@example.invalid" };
  const previous = claudePlanSnapshot({ rate_limits: { five_hour: { utilization: 60 } } }, source, 100);
  for (const report of [null, {}, { rate_limits: {} }]) {
    assert.equal(claudePlanSnapshot(report, source, 200, previous), previous);
  }
  assert.equal(claudePlanSnapshot(null, { ...source, email: "two@example.invalid" }, 200, previous).windows.length, 0);
  assert.equal(claudePlanSnapshot({ rate_limits_available: false }, source, 200, previous).windows.length, 0);
});

test("Claude response measurements deduplicate blocks, omit child messages and reset on adoption", async () => {
  const provider = new ClaudeProvider();
  const session = provider.createSession({ id: "measure", nativeId: "synthetic-measure" } as Thread, {} as SessionContext) as any;
  const reported: Usage[] = [];
  session.sink = { usage: (u: Usage) => reported.push(u) };
  const message = (id: string, input = 100) => ({ id, model: "claude", usage: { input_tokens: input, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }, content: [] });
  try {
    session.onAssistant({ message: message("first"), parent_tool_use_id: null });
    session.onAssistant({ message: message("first"), parent_tool_use_id: null });
    session.onAssistant({ message: message("child"), parent_tool_use_id: "tool" });
    session.onAssistant({ message: { ...message("synthetic"), model: "<synthetic>" }, parent_tool_use_id: null });
    session.onAssistant({ message: message("second", 200), parent_tool_use_id: null });
    assert.deepEqual(reported, [{ modelCalls: 1, firstPromptTokens: 1050 }, { modelCalls: 2 }]);
    session.adopt = async () => ({ status: "done" });
    await session.run({ text: "", instructions: "", images: [], documents: [] }, session.sink, { adopt: "steer" });
    session.onAssistant({ message: message("third", 300), parent_tool_use_id: null });
    assert.deepEqual(reported.at(-1), { modelCalls: 1, firstPromptTokens: 1250 });
  } finally { session.sink = null; session.dispose(); provider.dispose(); }
});

test("provider result routing isolates live quotas, ignores child results and retains closed-query observations", () => {
  const provider = new ClaudeProvider();
  const snapshots = new Map<string, PlanLimits>();
  const ctx = { claudeLimits: (id: string, limits: PlanLimits) => snapshots.set(id, limits) } as SessionContext;
  const a = provider.createSession({ id: "a", nativeId: "synthetic-a" } as Thread, ctx) as any;
  const b = provider.createSession({ id: "b", nativeId: "synthetic-b" } as Thread, ctx) as any;
  const reported: Usage[] = [];
  try {
    a.accounting.baseline(baseline(100));
    a.queryLimits = claudePlanSnapshot({ rate_limits: { five_hour: { utilization: 30 } } }, { tokenSource: "oauth" });
    a.sink = { usage: (u: Usage) => reported.push(u) };
    a.turnOpen = true;
    a.turnTools.add("child");
    a.onMessage({ type: "result", ...result(150), parent_tool_use_id: "child" });
    assert.equal(reported.length, 0);
    assert.equal(a.turnOpen, true);
    a.onMessage({ type: "rate_limit_event", rate_limit_info: { isUsingOverage: false, rateLimitType: "five_hour", utilization: 0.4 } });
    assert.equal(snapshots.get("a")?.windows[0].utilization, 0.4);
    assert.equal(snapshots.has("b"), false);
    a.onMessage({ type: "result", ...result(150) });
    assert.equal(reported[0].inputTokens, 50);
    assert.equal(reported[0].estimatedCostUsd, 0.5);
    assert.equal(reported[0].costPartial, false);
    assert.deepEqual(reported[0].billingSource, { tokenSource: "oauth" });
    a.query = { close() {} };
    a.close();
    assert.equal(snapshots.get("a")?.availability, "available");
    assert.deepEqual(snapshots.get("a")?.billingSource, { tokenSource: "oauth" });
    assert.equal(snapshots.get("a")?.windows[0].utilization, 0.4);
  } finally { a.sink = null; a.dispose(); b.dispose(); provider.dispose(); }
});
