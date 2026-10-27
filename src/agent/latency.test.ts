import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize, turnLatency } from "./latency.js";
import { harnessStats } from "./harness.js";
import type { Thread, Turn } from "./types.js";

test("turn latency splits the time after sending between model, tools and waits, counting overlaps once", () => {
  const latency = turnLatency({
    startedAt: 0,
    sentAt: 100,
    firstAt: 400,
    endedAt: 2100,
    // Two parallel calls (500–1000, 700–1200) and one left open, which ends with the turn.
    tools: [[500, 1000], [700, 1200], [1800, undefined]],
    // An approval inside the second call, and one before the first.
    waits: [[900, 1100], [300, 400]],
  });
  assert.deepEqual(latency, { totalMs: 2100, setupMs: 100, firstMs: 300, toolMs: 800, waitMs: 300, modelMs: 900 });
});

test("turn latency without a send time counts from the turn start and leaves first output out", () => {
  assert.deepEqual(turnLatency({ startedAt: 10, firstAt: 50, endedAt: 110, tools: [[0, 30]], waits: [] }), { totalMs: 100, toolMs: 20, waitMs: 0, modelMs: 80 });
  assert.equal(turnLatency({ startedAt: 10, endedAt: 5, tools: [], waits: [] }), undefined);
});

test("summarize takes nearest-rank median and p90", () => {
  assert.equal(summarize([]), undefined);
  assert.deepEqual(summarize([5]), { samples: 1, median: 5, p90: 5 });
  assert.deepEqual(summarize([10, 1, 9, 2, 8, 3, 7, 4, 6, 5]), { samples: 10, median: 5, p90: 9 });
});

test("harness stats report latency by provider and model from finished turns only", () => {
  const threads = [{ id: "a", provider: "codex", model: "gpt", title: "A" }] as Thread[];
  const at = (ms: number) => ({ totalMs: ms, firstMs: ms / 10, toolMs: ms / 2, waitMs: 0, modelMs: ms / 2 });
  const turn = (id: string, over: Partial<Turn>): Turn => ({ id, threadId: "a", seq: 1, status: "done", model: "gpt", effort: null, mode: "code", startedAt: 1000, ...over });
  const turns = [
    turn("1", { usage: { latency: at(1000) } }),
    turn("2", { usage: { latency: at(3000) } }),
    turn("3", { model: "mini", usage: { latency: at(200) } }),
    turn("failed", { status: "error", usage: { latency: at(99_000) } }),
    turn("untimed", { usage: { inputTokens: 5 } }),
  ];
  const stats = harnessStats(threads, () => turns, () => []);
  const provider = stats.providers[0].latency!;
  assert.deepEqual(provider.total, { samples: 3, median: 1000, p90: 3000 });
  assert.deepEqual(provider.first, { samples: 3, median: 100, p90: 300 });
  assert.equal(provider.modelMs, 2100);
  assert.deepEqual(stats.models.find((m) => m.model === "mini")?.latency?.total, { samples: 1, median: 200, p90: 200 });
});
