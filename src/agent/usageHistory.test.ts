import test from "node:test";
import assert from "node:assert/strict";
import type { Item } from "./types.js";
import { threadOrigin, usageCsv, usageHistory, type UsageSource } from "./usageHistory.js";

const day = (d: number, h = 12) => new Date(2026, 9, d, h).getTime();

test("threadOrigin reads a worker's prompt, and a card comment's card", () => {
  const prompt = [
    'You are the agent worker "Opus" on the Kanban board "Scribe Todo" (Scribe page id t_1). You take the cards…',
    "",
    "Your card: #12 Fix the thing",
    "labels: Bug",
  ].join("\n");
  assert.deepEqual(threadOrigin([{ kind: "user", text: prompt, from: "page" } as Item], "t_1"), { worker: "Opus", card: { board: "t_1", num: 12, title: "Fix the thing" } });
  // Typed by the user, the same words are no worker prompt.
  assert.deepEqual(threadOrigin([{ kind: "user", text: prompt } as Item], null), {});
  assert.deepEqual(threadOrigin([{ kind: "user", text: "hi", from: "page", card: { num: 4, title: "Four" } } as Item], "t_1"), { card: { board: "t_1", num: 4, title: "Four" } });
});

test("usageHistory groups turns by day and keys, rolls helpers into their thread and card once", () => {
  const sources: UsageSource[] = [
    {
      id: "main", title: "Main", provider: "claude", workspace: "C:/w", origin: { worker: "Opus", card: { board: "t_1", num: 7, title: "Seven" } },
      turns: [
        { id: "a", model: "opus", startedAt: day(1), usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5, costUsd: 1, reportedCostUsd: 1, plan: [{ id: "5h", label: "5 hours", used: 0.1 }] } },
        { id: "b", model: "opus", startedAt: day(2), usage: { inputTokens: 10, outputTokens: 5 } },
        { id: "r", model: "opus", startedAt: day(2), reverted: true, usage: { inputTokens: 1000, costUsd: 50 } },
      ],
    },
    {
      id: "help", helperOf: "main", provider: "codex", workspace: "C:/w", origin: {},
      turns: [{ id: "c", model: "gpt", startedAt: day(1, 13), usage: { inputTokens: 100, cacheReadTokens: 60, outputTokens: 1, costUsd: 0.5, estimatedCostUsd: 0.5 } }],
    },
    { id: "old", provider: "claude", workspace: null, origin: {}, turns: [{ id: "d", model: "opus", startedAt: day(3), usage: { inputTokens: 1, costUsd: 3 } }] },
  ];
  const h = usageHistory(sources, null, (b) => (b === "t_1" ? "Board" : undefined), (b, n) => (n === 7 ? "Seven now" : undefined));
  const total = h.rows.reduce((n, r) => n + r.turns, 0);
  assert.equal(total, 4, "reverted turn left out");
  const helperRow = h.rows.find((r) => r.provider === "codex")!;
  assert.equal(helperRow.worker, "Opus", "helper turns count under the worker that started them");
  assert.equal(helperRow.helperTurns, 1);
  assert.equal(helperRow.fresh, 40, "codex counts cached input inside inputTokens");
  const first = h.rows.find((r) => r.day.endsWith("-01") && r.provider === "claude")!;
  assert.equal(first.prompt, 100);
  assert.equal(first.cacheRead, 90);
  assert.equal(first.fresh, 10);
  const unpriced = h.rows.find((r) => r.day.endsWith("-02"))!;
  assert.equal(unpriced.unpricedTurns, 1);
  assert.deepEqual(h.plan, [{ day: first.day, id: "5h", label: "5 hours", used: 0.1 }]);

  assert.equal(h.threads[0].id, "old", "most expensive first");
  const main = h.threads.find((t) => t.id === "main")!;
  assert.equal(main.costUsd, 1.5);
  assert.equal(main.helpers, 1);
  assert.equal(main.turns, 3);
  assert.equal(h.threads.length, 2, "the helper is no thread row of its own");
  assert.deepEqual(h.cards.map((c) => [c.num, c.title, c.boardTitle, c.costUsd, c.threads, c.workers]), [[7, "Seven now", "Board", 1.5, 2, ["Opus"]]]);

  const since = usageHistory(sources, day(2, 0));
  assert.equal(since.rows.reduce((n, r) => n + r.turns, 0), 2);
});

test("usageCsv writes one line per turn, oldest first, quoting what needs it", () => {
  const csv = usageCsv(
    [
      { id: "t", provider: "claude", workspace: "C:/a,b", origin: { worker: 'Say "hi"' }, turns: [
        { id: "2", model: "m", startedAt: day(2), usage: { inputTokens: 3, costUsd: 0.25 } },
        { id: "1", model: "m", startedAt: day(1) },
      ] },
    ],
    null
  );
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^date,time,thread,root_thread,helper,provider,model,workspace,worker/);
  assert.match(lines[1], /,"C:\/a,b","Say ""hi""",/);
  assert.match(lines[1], /,0$/, "no cost recorded");
  assert.match(lines[2], /,0\.25,,,1$/);
});
