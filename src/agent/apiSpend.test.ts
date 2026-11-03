import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchDeepSeekBalance, localDay, nativeApi, parseDeepSeekBalance, todaysSpend } from "./apiSpend.js";

test("todaysSpend sums today's Native turns per API and skips older, reverted and unpriced ones", () => {
  const now = new Date(2026, 10, 3, 15, 0).getTime();
  const today = new Date(2026, 10, 3, 0, 5).getTime();
  const yesterday = new Date(2026, 10, 2, 23, 55).getTime();
  const spend = todaysSpend([
    [
      { model: "deepseek/deepseek-flash", startedAt: today, usage: { costUsd: 0.25 } },
      { model: "deepseek/deepseek-v4-pro", startedAt: today + 1000, usage: { costUsd: 0.5 } },
      { model: "deepseek/deepseek-flash", startedAt: yesterday, usage: { costUsd: 9 } },
      { model: "deepseek/deepseek-flash", startedAt: today, usage: { costUsd: 9 }, reverted: true },
    ],
    [
      { model: "src-abc/deepseek-flash", startedAt: today, usage: { costUsd: 0.1 } },
      { model: "openai-codex/gpt", startedAt: today, usage: { costUsd: 0 } },
      { model: "default", startedAt: today, usage: { costUsd: 1 } },
      { model: "openrouter/x", startedAt: today },
    ],
  ], now);
  assert.deepEqual(Object.fromEntries(spend), { deepseek: 0.75, "src-abc": 0.1 });
});

test("nativeApi and localDay", () => {
  assert.equal(nativeApi("deepseek/deepseek-flash"), "deepseek");
  assert.equal(nativeApi("default"), null);
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59).getTime()), "2026-01-05");
});

test("parseDeepSeekBalance reads every currency and drops malformed rows", () => {
  const parsed = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
      { currency: "USD", total_balance: "4.20" },
      { total_balance: "1" },
      { currency: "EUR" },
    ],
  }, 5);
  assert.deepEqual(parsed, {
    at: 5,
    available: true,
    amounts: [
      { currency: "CNY", total: "110.00", granted: "10.00", toppedUp: "100.00" },
      { currency: "USD", total: "4.20" },
    ],
  });
  assert.equal(parseDeepSeekBalance({ error: "nope" }), null);
  assert.equal(parseDeepSeekBalance({ balance_infos: [] })?.available, false);
});

test("fetchDeepSeekBalance sends the key to DeepSeek only and fails on HTTP errors", async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const ok = (async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "3" }] }));
  }) as typeof fetch;
  const balance = await fetchDeepSeekBalance("sk-test", ok);
  assert.equal(calls[0][0], "https://api.deepseek.com/user/balance");
  assert.equal((calls[0][1]?.headers as Record<string, string>).Authorization, "Bearer sk-test");
  assert.deepEqual(balance?.amounts, [{ currency: "USD", total: "3" }]);
  const denied = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  await assert.rejects(fetchDeepSeekBalance("sk-bad", denied), /HTTP 401/);
});
