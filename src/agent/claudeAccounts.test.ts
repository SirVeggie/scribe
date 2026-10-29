import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { accountScore, combineLimits, pickAccount, planLabel, planWeight, prepareProfile, readAccountProfile, removeProfile, type PickCandidate } from "./claudeAccounts.js";
import { ClaudeAccountPool, mergeClaudeLimits, type AccountProvider } from "./claudeAccountPool.js";
import type { PlanLimits } from "./types.js";

const H = 3_600_000;
const now = 1_000 * H;
const limits = (five: number, week: number, weekResetH = 96, fiveResetH = 3): PlanLimits => ({
  at: now, source: "claude", availability: "available",
  windows: [
    { id: "five_hour", label: "5-hour", utilization: five, resetsAt: now + fiveResetH * H },
    { id: "seven_day", label: "Weekly", utilization: week, resetsAt: now + weekResetH * H },
  ],
});
const cand = (id: string, l?: PlanLimits, extra: Partial<PickCandidate> = {}): PickCandidate => ({ id, weight: 1, running: 0, ...(l ? { limits: l } : {}), ...extra });

test("the account whose weekly headroom expires soonest gets the next chat", () => {
  // 40% left over 20 h beats 70% left over 96 h.
  assert.equal(pickAccount([cand("a", limits(0.3, 0.6, 20)), cand("b", limits(0.1, 0.3, 96))], now), "a");
});

test("accounts at or near a full window are skipped while another has room", () => {
  assert.equal(pickAccount([cand("a", limits(0.97, 0.2, 10)), cand("b", limits(0.1, 0.3, 96))], now), "b");
  assert.equal(pickAccount([cand("a", limits(0.2, 0.96, 10)), cand("b", limits(0.1, 0.3, 96))], now), "b");
  assert.equal(accountScore(cand("a", limits(0.95, 0)), now), null);
});

test("running chats count against a nearly used 5-hour window, but not a roomy one", () => {
  const roomy = accountScore(cand("a", limits(0.1, 0.5), { running: 2 }), now)!;
  const idle = accountScore(cand("a", limits(0.1, 0.5)), now)!;
  assert.equal(roomy, idle);
  // 20% of the 5-hour window left and two chats running: it should lose to an account with room.
  const busy = cand("a", limits(0.8, 0.5, 48), { running: 2 });
  const other = cand("b", limits(0.1, 0.5, 120));
  assert.equal(pickAccount([busy, other], now), "b");
  assert.equal(pickAccount([{ ...busy, running: 0 }, other], now), "a");
});

test("equal accounts take turns: fewest running chats, then the one picked longest ago", () => {
  const l = limits(0.1, 0.3);
  assert.equal(pickAccount([cand("a", l, { running: 1 }), cand("b", l)], now), "b");
  assert.equal(pickAccount([cand("a", l, { lastPickedAt: now - 10 }), cand("b", l, { lastPickedAt: now - 100 })], now), "b");
});

test("a Max account's larger allowance counts in its favour", () => {
  assert.equal(pickAccount([cand("pro", limits(0.1, 0.5, 48)), cand("max", limits(0.1, 0.5, 48), { weight: 5 })], now), "max");
});

test("with every account full, the one that frees up soonest", () => {
  assert.equal(pickAccount([cand("a", limits(1, 0.5, 96, 4)), cand("b", limits(1, 0.5, 96, 1))], now), "b");
  // Both windows full on a: it waits for the later of the two.
  assert.equal(pickAccount([cand("a", limits(1, 1, 50, 1)), cand("b", limits(1, 0.2, 96, 3))], now), "b");
});

test("passed resets count as empty windows", () => {
  const l = limits(1, 0.5, 96, -1);
  assert.notEqual(accountScore(cand("a", l), now), null);
});

test("plan weights and labels", () => {
  assert.equal(planWeight({ plan: "claude_pro" }), 1);
  assert.equal(planWeight({ plan: "claude_max", tier: "default_claude_max_5x" }), 5);
  assert.equal(planWeight({ plan: "claude_max", tier: "default_claude_max_20x" }), 20);
  assert.equal(planLabel({ plan: "claude_max", tier: "default_claude_max_20x" }), "Max 20x");
  assert.equal(planLabel({ plan: "claude_pro", tier: "default_claude_ai" }), "Pro");
});

test("the combined meter averages by plan size and resets with the soonest account", () => {
  const out = combineLimits([
    { id: "default", email: "a@x", weight: 1, limits: limits(0.2, 0.6, 20, 2) },
    { id: "acc_1", email: "b@x", weight: 5, limits: limits(0.8, 0.0, 96, 4) },
    { id: "acc_2", weight: 1 },
  ], now)!;
  const five = out.windows.find((w) => w.id === "five_hour")!;
  const week = out.windows.find((w) => w.id === "seven_day")!;
  // The 5-hour window also by weekly headroom: 1 × 0.4 for a, 5 × 1.0 for b.
  assert.ok(Math.abs(five.utilization - (0.2 * 0.4 + 0.8 * 5) / 5.4) < 1e-9);
  assert.ok(Math.abs(week.utilization - 0.6 / 6) < 1e-9);
  assert.equal(five.resetsAt, now + 2 * H);
  assert.equal(out.accounts?.length, 3);
  assert.equal(out.accounts?.[1].email, "b@x");
  assert.equal(combineLimits([{ id: "x", weight: 1 }], now), null);
});

test("an account with its week nearly used up barely counts in the combined 5-hour window", () => {
  const out = combineLimits([
    { id: "default", weight: 1, limits: limits(0, 0.99, 20, 2) },
    { id: "acc_1", weight: 1, limits: limits(0.7, 0.08, 96, 4) },
  ], now)!;
  const five = out.windows.find((w) => w.id === "five_hour")!;
  assert.ok(five.utilization > 0.69, `5-hour ${five.utilization}`);
  const spent = combineLimits([
    { id: "default", weight: 1, limits: limits(0.2, 1, 20, 2) },
    { id: "acc_1", weight: 1, limits: limits(0.6, 1, 96, 4) },
  ], now)!;
  assert.ok(Math.abs(spent.windows.find((w) => w.id === "five_hour")!.utilization - 0.4) < 1e-9, "every week spent: plan weights");
});

test("merging keeps newer windows and drops older readings", () => {
  const first = limits(0.2, 0.4);
  const later = { ...limits(0.3, 0.4), at: now + 1000, windows: [{ id: "five_hour", label: "5-hour", utilization: 0.3 }] };
  const merged = mergeClaudeLimits(first, later)!;
  assert.equal(merged.limits.windows.find((w) => w.id === "five_hour")!.utilization, 0.3);
  assert.equal(merged.limits.windows.find((w) => w.id === "seven_day")!.utilization, 0.4);
  assert.equal(mergeClaudeLimits(merged.limits, first), null);
  assert.equal(mergeClaudeLimits(first, { ...later, availability: "unavailable" }), null);
});

test("an added account's folder links the shared folders and copies settings; removing it leaves them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-accounts-"));
  try {
    const base = path.join(root, "base");
    fs.mkdirSync(path.join(base, "skills", "one"), { recursive: true });
    fs.writeFileSync(path.join(base, "skills", "one", "SKILL.md"), "skill");
    fs.writeFileSync(path.join(base, "settings.json"), "{}");
    const dir = path.join(root, "acc");
    prepareProfile(dir, base);
    assert.ok(fs.existsSync(path.join(base, "projects")), "projects is made so resume works across accounts");
    assert.equal(fs.readFileSync(path.join(dir, "skills", "one", "SKILL.md"), "utf8"), "skill");
    assert.equal(fs.readFileSync(path.join(dir, "settings.json"), "utf8"), "{}");
    fs.writeFileSync(path.join(dir, "projects", "t.jsonl"), "x");
    assert.ok(fs.existsSync(path.join(base, "projects", "t.jsonl")));
    fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "b@x", organizationType: "claude_pro", accessToken: "nope" } }));
    assert.deepEqual(readAccountProfile(dir), { email: "b@x", plan: "claude_pro" });
    removeProfile(dir);
    assert.ok(!fs.existsSync(dir));
    assert.equal(fs.readFileSync(path.join(base, "skills", "one", "SKILL.md"), "utf8"), "skill");
    assert.ok(fs.existsSync(path.join(base, "projects", "t.jsonl")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function pool(settings: Record<string, unknown> = {}, running: Record<string, number> = {}) {
  const provider: AccountProvider = {
    loginAccount: async () => false, accountStatus: async () => null, logoutAccount: async () => undefined,
    fetchPlanUsage: async () => null, signedIn: () => true,
  };
  return new ClaudeAccountPool({
    getSetting: <T,>(key: string, fallback: T) => (key in settings ? settings[key] as T : fallback),
    setSetting: (key, value) => { settings[key] = value; },
    provider: () => provider, dataDir: os.tmpdir(), defaultLimits: () => undefined,
    running: (id) => running[id] ?? 0, changed: () => undefined, offline: true,
  });
}

test("with one account the pool stays out of the way", () => {
  const p = pool();
  assert.equal(p.multi(), false);
  assert.equal(p.resolve({}, null), undefined);
  assert.equal(p.combined(), null);
  assert.deepEqual(p.env(undefined), {});
});

test("chats keep their account while warm, move after an hour idle, and follow a pinned account", () => {
  const settings: Record<string, unknown> = {
    claudeAccounts: { accounts: [{ id: "acc_1", dir: path.join(os.tmpdir(), "nope-acc_1"), addedAt: 1 }], use: "distribute", picked: {} },
    claudeAccountLimits: { acc_1: { ...limits(0.1, 0.1, 10), at: Date.now() } },
  };
  const p = pool(settings, { default: 3 });
  assert.equal(p.multi(), true);
  const first = p.resolve({}, null);
  assert.equal(first, "acc_1");
  assert.equal(p.resolve({ claudeAccount: "default" }, Date.now() - 5 * 60_000), "default", "a warm chat stays");
  assert.equal(p.resolve({ claudeAccount: "default" }, Date.now() - 2 * H), "acc_1", "a cold chat goes to the pick");
  assert.equal(p.resolve({ claudeAccount: "acc_gone" }, null), "acc_1", "a logged-out account's chat moves");
  p.setUse("default");
  assert.equal(p.resolve({ claudeAccount: "acc_1" }, Date.now()), "default");
  assert.equal(p.alternative("default"), null, "no switching while pinned");
  p.setUse("distribute");
  assert.deepEqual(p.alternative("default"), { account: "acc_1", label: "another account" });
  assert.throws(() => p.setUse("acc_unknown"));
});

test("adding again replaces a sign-in whose browser was closed, and cancel ends it", async () => {
  const signals: AbortSignal[] = [];
  const provider: AccountProvider = {
    // Like `claude auth login` after the browser is closed: it never ends until stopped.
    loginAccount: (_dir, signal) => new Promise((resolve) => {
      signals.push(signal!);
      signal!.addEventListener("abort", () => resolve(false));
    }),
    accountStatus: async () => null, logoutAccount: async () => undefined, fetchPlanUsage: async () => null, signedIn: () => true,
  };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-add-"));
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(data, "default");
  try {
    const settings: Record<string, unknown> = {};
    const p = new ClaudeAccountPool({
      getSetting: <T,>(key: string, fallback: T) => (key in settings ? settings[key] as T : fallback),
      setSetting: (key, value) => { settings[key] = value; },
      provider: () => provider, dataDir: data, defaultLimits: () => undefined, running: () => 0, changed: () => undefined, offline: true,
    });
    p.add();
    const first = p.adding;
    p.add();
    assert.ok(signals[0].aborted, "the stuck sign-in is stopped");
    assert.notEqual(p.adding, first);
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(p.adding, "the old sign-in ending does not clear the new one");
    assert.equal(p.lastError, null);
    p.cancelAdd();
    assert.ok(signals[1].aborted);
    assert.equal(p.adding, null);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(p.lastError, null);
    assert.equal(p.multi(), false);
  } finally {
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    fs.rmSync(data, { recursive: true, force: true });
  }
});
