import { test } from "node:test";
import assert from "node:assert/strict";
import { usageView } from "./agentUsage.js";
import type { PlanLimits } from "./types.js";

const H = 60 * 60_000;
const now = Date.parse("2026-11-08T12:00:00Z");

function claude(five: number, week: number, fiveReset = now + 2 * H): PlanLimits {
  return { at: now - 30_000, status: "allowed", windows: [
    { id: "five_hour", label: "5h", utilization: five, resetsAt: fiveReset, pace: { durationMs: 5 * H, runsOutAt: now + H } },
    { id: "seven_day", label: "Week", utilization: week, resetsAt: now + 72 * H },
  ] };
}

test("first call: percents, ISO times and age, no change", () => {
  const view = usageView({ claude: claude(0.123, 0.4) }, {}, now);
  const c = view.providers.claude;
  assert.equal(c.ageSeconds, 30);
  assert.deepEqual(c.windows[0], { id: "five_hour", label: "5h", percent: 12.3, resetsAt: new Date(now + 2 * H).toISOString(), runsOutAt: new Date(now + H).toISOString() });
  assert.equal(view.since, undefined);
  assert.equal(c.windows[1].change, undefined);
});

test("later call: change in points since the previous snapshot; a reset leaves change out", () => {
  const prev = { at: now - 10 * 60_000, limits: { claude: claude(0.1, 0.4, now - H) } };
  const view = usageView({ claude: claude(0.05, 0.42, now + 4 * H) }, {}, now, prev);
  assert.equal(view.since, new Date(now - 10 * 60_000).toISOString());
  assert.equal(view.providers.claude.windows[0].reset, true);
  assert.equal(view.providers.claude.windows[0].change, undefined);
  assert.equal(view.providers.claude.windows[1].change, 2);
});

test("provider filter, accounts and Native spend", () => {
  const limits: Record<string, PlanLimits> = {
    claude: { ...claude(0.2, 0.3), nextAccount: "b", accounts: [
      { id: "default", weight: 1, email: "a@x", limits: claude(0.1, 0.2) },
      { id: "b", weight: 1, plan: "max", limits: claude(0.3, 0.4) },
    ] },
    codex: { at: now, windows: [], availability: "authentication_required", detail: "Log in" },
  };
  const spend = { deepseek: { day: "2026-11-08", costUsd: 0.12, label: "DeepSeek" } };
  const all = usageView(limits, spend, now);
  assert.equal(all.providers.codex.availability, "authentication_required");
  assert.deepEqual(all.spend, { deepseek: { costUsd: 0.12 } });
  assert.equal(all.providers.claude.accounts?.[1].current, true);
  assert.equal(all.providers.claude.accounts?.[1].windows[0].percent, 30);
  const only = usageView(limits, spend, now, undefined, "codex");
  assert.deepEqual(Object.keys(only.providers), ["codex"]);
  assert.equal(only.spend, undefined);
});
