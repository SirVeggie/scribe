import assert from "node:assert/strict";
import { test } from "node:test";
import { applyStateOps } from "../stateOps.js";
import { kanbanActions } from "./kanban.js";
import type { ActionContext, SweepContext, ThreadRunInfo } from "./types.js";

const board = () => ({
  columns: [
    { id: "in", title: "Inbox" },
    { id: "ready", title: "Ready for agent", role: "agent" },
    { id: "work", title: "Agent working", role: "working" },
    { id: "rev", title: "Needs review", role: "review" },
    { id: "done", title: "Done", role: "done" },
  ],
  labels: [{ id: "lb1", name: "Bug" }],
  cards: [
    { id: "c1", num: 1, col: "ready", title: "One", comments: [], createdAt: 1, movedAt: 1 },
    { id: "c2", num: 2, col: "ready", title: "Two", comments: [], createdAt: 1, movedAt: 1 },
    { id: "c3", num: 3, col: "done", title: "Three", comments: [], createdAt: 1, movedAt: 1, doneAt: 1 },
  ],
  nextNum: 4,
});

const agent = (over: Partial<ActionContext["caller"]> = {}): ActionContext => ({
  caller: { by: "agent", label: "Claude Code", session: "s1", ...over },
  now: 1000,
  values: {},
});

function run(state: Record<string, unknown>, name: string, args: Record<string, unknown>, ctx = agent()) {
  const outcome = kanbanActions.actions[name].run(state, args, ctx);
  return { state: applyStateOps(state, outcome.ops), result: outcome.result as Record<string, unknown> };
}

const card = (state: Record<string, unknown>, num: number) =>
  (state.cards as Array<Record<string, unknown>>).find((c) => c.num === num)!;
const order = (state: Record<string, unknown>) => (state.cards as Array<{ num: number }>).map((c) => c.num);

test("create records the original worker and chat independently of later claims", () => {
  const initial = { ...board(), settings: { workers: {
    sol: { name: "Sol", threadId: "th_sol" },
    solo: { name: "Opus", solo: { th_solo: { card: 1, at: 1 } } },
  } } };
  const created = run(initial, "create", { title: "Reported issue", column: "agent" }, agent({ thread: "th_sol" })).state;
  assert.equal(card(created, 4).createdBy, "Sol");
  assert.equal(card(created, 4).createdThread, "th_sol");
  const claimed = run(created, "claim", { card: 4, assignee: "Other worker" }, agent({ thread: "th_other" })).state;
  const finished = run(claimed, "finish", { card: 4, summary: "Fixed" }, agent({ thread: "th_other" })).state;
  assert.equal(card(finished, 4).createdBy, "Sol");
  assert.equal(card(finished, 4).createdThread, "th_sol");
  assert.equal(card(finished, 4).thread, "th_other");
  for (const action of ["list", "get"]) {
    const result = run(finished, action, action === "get" ? { card: 4 } : {}).result;
    const row = action === "get" ? result : (result.cards as Array<Record<string, unknown>>).find(c => c.num === 4)!;
    assert.equal(row.createdBy, "Sol");
    assert.equal(row.createdThread, "th_sol");
  }
  assert.equal(card(run(initial, "create", { title: "Solo issue" }, agent({ thread: "th_solo" })).state, 4).createdBy, "Opus");
  const external = card(run(board(), "create", { title: "External issue" }).state, 4);
  assert.equal(external.createdBy, "Claude Code");
  assert.equal(external.createdThread, undefined);
  const user = card(run(board(), "create", { title: "My issue" }, { ...agent(), caller: { by: "user" } }).state, 4);
  assert.equal(user.createdBy, "user");
  assert.equal(user.createdThread, undefined);
});

test("list, get and logs preserve helper totals and the main chat breakdown", () => {
  const state = board() as Record<string, unknown>;
  const usage = { turns: 3, inputTokens: 100, promptTokens: 100, outputTokens: 12,
    costUsd: 0.2, costPartial: true, main: { turns: 1, inputTokens: 10, promptTokens: 10 },
    helpers: { threads: 2, turns: 2, inputTokens: 90, outputTokens: 12, costUsd: 0.2, costPartial: true } };
  card(state, 1).usage = usage;
  state.settings = { workerLog: [{ at: 1, kind: "done", text: "Done", usage }] };
  assert.deepEqual((run(state, "list", {}).result.cards as Array<{ usage: unknown }>)[0].usage, usage);
  assert.deepEqual(run(state, "get", { card: 1 }).result.usage, usage);
  assert.deepEqual((run(state, "logs", {}).result.logs as Array<{ usage: unknown }>)[0].usage, usage);
});

test("claim moves a card to working, records the holder, and refuses a second agent", () => {
  const { state } = run(board(), "claim", { card: "#2", text: "Fixing it" });
  const c = card(state, 2);
  assert.equal(c.col, "work");
  assert.equal(c.assignee, "Claude Code");
  assert.deepEqual(c.status, { kind: "working", text: "Fixing it" });
  assert.equal((c.claim as { holder: string }).holder, "Claude Code");
  assert.equal(c.from, "ready");
  assert.equal((c.claim as { from?: string }).from, "ready");
  assert.throws(() => run(state, "claim", { card: 2 }, agent({ session: "s2" })), /held by Claude Code/);
  // The same session may claim again.
  run(state, "claim", { card: 2 }, agent());
});

test("claim assignee uses the arg, else Claude/Cursor for in-app threads", () => {
  const named = run(board(), "claim", { card: 1, assignee: "Grok" });
  assert.equal(card(named.state, 1).assignee, "Grok");
  const cursor = run(board(), "claim", { card: 1 }, agent({ label: "Scribe chat: Grok Issues", provider: "cursor" }));
  assert.equal(card(cursor.state, 1).assignee, "Cursor");
  const claude = run(board(), "claim", { card: 1 }, agent({ label: "Scribe chat: Board", provider: "claude" }));
  assert.equal(card(claude.state, 1).assignee, "Claude");
  const codex = run(board(), "claim", { card: 1 }, agent({ label: "Scribe chat: Codex", provider: "codex" }));
  assert.equal(card(codex.state, 1).assignee, "Codex");
  assert.throws(() => run(board(), "claim", { card: 1, assignee: "  " }), /assignee is empty/);
});

test("finish comments, clears the claim, and hands the card to review", () => {
  const claimed = run(board(), "claim", { card: 1 }).state;
  const { state } = run(claimed, "finish", { card: 1, summary: "Done, see commit abc." });
  const c = card(state, 1);
  assert.equal(c.col, "rev");
  assert.equal(c.claim, undefined);
  assert.equal(c.status, undefined);
  assert.equal((c.comments as Array<{ by: string; text: string }>).at(-1)?.text, "Done, see commit abc.");
  assert.equal((c.comments as Array<{ by: string }>).at(-1)?.by, "Claude Code");
});

test("a thread's claim records it on the card, and finish keeps it", () => {
  const ctx = agent({ thread: "th_1" });
  const claimed = run(board(), "claim", { card: 1 }, ctx).state;
  assert.equal(card(claimed, 1).thread, "th_1");
  const { state } = run(claimed, "finish", { card: 1, summary: "Done." }, ctx);
  assert.equal(card(state, 1).thread, "th_1");
  assert.equal(card(run(board(), "claim", { card: 1 }, agent({ thread: undefined })).state, 1).thread, undefined);
});

test("finish without a summary hands in the comment posted since the claim, and never doubles it", () => {
  const claimed = run(board(), "claim", { card: 1 }, agent({ session: "s1" }));
  // A comment from before this claim does not count as the hand-in.
  const old = run(board(), "comment", { card: 1, text: "Old note" }).state;
  const reclaimed = run({ ...old }, "claim", { card: 1 }, { ...agent(), now: 2000 }).state;
  assert.throws(() => run(reclaimed, "finish", { card: 1 }, { ...agent(), now: 3000 }), /summary is required/);

  const commented = run(claimed.state, "comment", { card: 1, text: "Done: the filter works.\nRestart the app." }, { ...agent(), now: 1500 }).state;
  const reused = run(commented, "finish", { card: 1 }, { ...agent(), now: 1600 });
  const comments = card(reused.state, 1).comments as Array<{ text: string }>;
  assert.equal(comments.length, 1);
  assert.equal(reused.result.handIn, "your earlier comment");
  assert.equal(card(reused.state, 1).col, "rev");

  // The same text again as the summary is not posted twice; a different summary is.
  const same = run(commented, "finish", { card: 1, summary: "done:  the filter works. restart the app." }, { ...agent(), now: 1600 });
  assert.equal((card(same.state, 1).comments as unknown[]).length, 1);
  const other = run(commented, "finish", { card: 1, summary: "Also fixed the sort." }, { ...agent(), now: 1600 });
  assert.equal((card(other.state, 1).comments as unknown[]).length, 2);
});

test("agent comments store the assignee or worker name, not a generic agent", () => {
  const named = run(board(), "claim", { card: 1, assignee: "Grok" });
  assert.equal((card(run(named.state, "comment", { card: 1, text: "On it" }).state, 1).comments as Array<{ by: string }>)[0].by, "Grok");
  assert.equal((card(run(named.state, "finish", { card: 1, summary: "Done." }).state, 1).comments as Array<{ by: string }>).at(-1)?.by, "Grok");
  assert.equal((card(run(named.state, "release", { card: 1, note: "Need a spec" }).state, 1).comments as Array<{ by: string }>)[0].by, "Grok");

  const unlabeled = run(board(), "comment", { card: 1, text: "Hi" });
  assert.equal((card(unlabeled.state, 1).comments as Array<{ by: string }>)[0].by, "Claude Code");

  const grokWorker = {
    ...board(),
    settings: { workers: { w_g: { name: "Grok", threadId: "th_g" }, w_s: { name: "Opus", solo: { th_solo: { card: 2, at: 1 } } } } },
  };
  assert.equal((card(run(grokWorker, "comment", { card: 1, text: "From worker" }, agent({ thread: "th_g" })).state, 1).comments as Array<{ by: string }>)[0].by, "Grok");
  assert.equal((card(run(grokWorker, "comment", { card: 1, text: "From solo" }, agent({ thread: "th_solo" })).state, 1).comments as Array<{ by: string }>)[0].by, "Opus");

  const fromUser = run(named.state, "comment", { card: 1, text: "Looks good" }, { caller: { by: "user", label: "user" }, now: 1000, values: {} });
  assert.equal((card(fromUser.state, 1).comments as Array<{ by: string }>)[0].by, "user");
});

test("get returns the comments themselves, not just their count", () => {
  const commented = run(board(), "comment", { card: 1, text: "First **note**" }).state;
  const withImage = {
    ...commented,
    cards: (commented.cards as Array<Record<string, unknown>>).map((c) =>
      c.num === 1
        ? { ...c, images: [{ id: "im_1", name: "shot.png", data: "/blob/pa_aaaaaaaaaaaaaaaaaaaaaaaa" }] }
        : c
    ),
  };
  const { result } = run(withImage, "get", { card: 1 });
  const comments = result.comments as Array<{ by: string; text: string }>;
  assert.equal(comments.length, 1);
  assert.equal(comments[0].text, "First **note**");
  assert.equal(comments[0].by, "Claude Code");
  assert.equal(result.lastComment, undefined);
  assert.equal(result.column, "Ready for agent");
  assert.deepEqual(result.images, [{ id: "im_1", name: "shot.png", data: "/blob/pa_aaaaaaaaaaaaaaaaaaaaaaaa" }]);
});

test("moving into done sets doneAt and puts the card on top; moving out clears it", () => {
  let { state } = run(board(), "move", { card: 1, to: "done" });
  assert.deepEqual(order(state), [2, 1, 3]);
  assert.equal(card(state, 1).doneAt, 1000);
  ({ state } = run(state, "move", { card: 1, to: "Inbox" }));
  assert.equal(card(state, 1).doneAt, undefined);
  assert.equal(card(state, 1).col, "in");
  assert.throws(() => run(state, "move", { card: 1, to: "nowhere" }), /no column "nowhere". Columns: Inbox/);
});

test("creation and cross-column moves default to top in every column, with bottom available explicitly", () => {
  for (const col of board().columns) {
    const initial = board();
    initial.cards[0].col = col.id;
    initial.cards[1].col = col.id;
    initial.cards[2].col = "elsewhere";
    assert.deepEqual(order(run(initial, "create", { title: "New", column: col.id }).state), [4, 1, 2, 3]);
    assert.deepEqual(order(run(initial, "create", { title: "New", column: col.id, position: "bottom" }).state), [1, 2, 4, 3]);
    assert.deepEqual(order(run(initial, "move", { card: 3, to: col.id }).state), [3, 1, 2]);
    assert.deepEqual(order(run(initial, "move", { card: 3, to: col.id, position: "bottom" }).state), [1, 2, 3]);
    // Reaffirming a card's column leaves its manual ordering intact.
    assert.deepEqual(order(run(initial, "move", { card: 2, to: col.id }).state), [1, 2, 3]);
    assert.deepEqual(order(run(initial, "move", { card: 2, to: col.id, position: "top" }).state), [2, 1, 3]);
  }
});

test("create numbers the card, resolves labels, and lands at the column's top", () => {
  const { state, result } = run(board(), "create", { title: "New", column: "agent", labels: ["bug"] });
  assert.equal(result.num, 4);
  assert.equal(state.nextNum, 5);
  assert.deepEqual(order(state), [4, 1, 2, 3]);
  assert.deepEqual(card(state, 4).labels, ["lb1"]);
  assert.equal(card(state, 4).from, "ready");
  assert.throws(() => run(board(), "create", { title: "x", labels: ["nope"] }), /no label "nope"/);
});

test("list gives compact rows and column counts", () => {
  const { result } = run(board(), "list", { column: "agent" });
  assert.deepEqual((result.cards as Array<{ num: number }>).map((c) => c.num), [1, 2]);
  assert.equal((result.columns as Array<{ cards: number }>)[1].cards, 2);
  assert.equal((result.columns as Array<{ stopRequested?: boolean }>)[1].stopRequested, undefined);
});

test("list marks a paused agent column without hiding its cards", () => {
  const paused = {
    ...board(),
    columns: board().columns.map((c) => (c.id === "ready" ? { ...c, paused: true } : c)),
  };
  const { result } = run(paused, "list", { column: "agent" });
  const ready = (result.columns as Array<{ id: string; paused?: boolean }>).find((c) => c.id === "ready");
  assert.equal(ready?.paused, true);
  assert.equal((result.columns as Array<{ id: string; paused?: boolean }>).find((c) => c.id === "in")?.paused, undefined);
  assert.deepEqual((result.cards as Array<{ num: number }>).map((c) => c.num), [1, 2]);
});

const nums = (result: Record<string, unknown>) => (result.cards as Array<{ num: number }>).map((c) => c.num);

test("list with no column omits done-role cards and follows board order", () => {
  const scrambled = {
    ...board(),
    cards: [
      { id: "c3", num: 3, col: "done", title: "Done first in array shared-token", comments: [], createdAt: 1, movedAt: 1, doneAt: 1 },
      { id: "c2", num: 2, col: "ready", title: "Agent", comments: [], createdAt: 1, movedAt: 1 },
      { id: "c1", num: 1, col: "in", title: "Inbox shared-token", comments: [], createdAt: 1, movedAt: 1 },
      { id: "c4", num: 4, col: "work", title: "Working", comments: [], createdAt: 1, movedAt: 1 },
    ],
    nextNum: 5,
  };
  assert.deepEqual(nums(run(scrambled, "list", {}).result), [1, 2, 4]);
  assert.deepEqual(nums(run(scrambled, "list", { done: true }).result), [3]);
  assert.deepEqual(nums(run(scrambled, "list", { column: "done" }).result), [3]);
  assert.deepEqual(nums(run(scrambled, "list", { q: "Done first" }).result), [3]);
  assert.deepEqual(nums(run(scrambled, "list", { q: "Agent" }).result), [2]);
  const mixed = run(scrambled, "list", { q: "shared-token" }).result;
  assert.deepEqual(nums(mixed), [1, 3]);
  const capped = run(scrambled, "list", { done: true, limit: 1 }).result;
  assert.deepEqual(nums(capped), [3]);
  assert.equal(capped.more, undefined);
});

test("list with no column does not count omitted done cards as more", () => {
  const manyDone = {
    ...board(),
    cards: [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `d${i}`,
        num: 10 + i,
        col: "done",
        title: `Done ${i}`,
        comments: [],
        createdAt: 1,
        movedAt: 1,
        doneAt: 1,
      })),
      { id: "c1", num: 1, col: "ready", title: "Open", comments: [], createdAt: 1, movedAt: 1 },
    ],
    nextNum: 20,
  };
  const { result } = run(manyDone, "list", { limit: 10 });
  assert.deepEqual(nums(result), [1]);
  assert.equal(result.more, undefined);
  const allDone = run(manyDone, "list", { done: true, limit: 2 }).result;
  assert.deepEqual(nums(allDone), [10, 11]);
  assert.equal(allDone.more, 3);
});

test("list q matches title, description, comments, and checklist", () => {
  const state = {
    ...board(),
    cards: [
      { id: "c1", num: 1, col: "ready", title: "Alpha", description: "unique-desc-word", comments: [], createdAt: 1, movedAt: 1 },
      {
        id: "c2",
        num: 2,
        col: "ready",
        title: "Beta",
        comments: [{ id: "cm1", by: "user", at: 1, text: "unique-comment-word" }],
        createdAt: 1,
        movedAt: 1,
      },
      {
        id: "c3",
        num: 3,
        col: "ready",
        title: "Gamma",
        checklist: [{ id: "ck1", text: "unique-check-word", done: false }],
        comments: [],
        createdAt: 1,
        movedAt: 1,
      },
      { id: "c4", num: 4, col: "ready", title: "Delta", comments: [], createdAt: 1, movedAt: 1 },
    ],
  };
  const nums = (q: string) => (run(state, "list", { q }).result.cards as Array<{ num: number }>).map((c) => c.num);
  assert.deepEqual(nums("unique-desc-word"), [1]);
  assert.deepEqual(nums("unique-comment-word"), [2]);
  assert.deepEqual(nums("unique-check-word"), [3]);
  assert.deepEqual(nums("alpha unique-desc-word"), [1]);
  assert.deepEqual(nums("nope"), []);
});

const twoAgents = () => ({
  columns: [
    { id: "claude", title: "claude", role: "agent" },
    { id: "grok", title: "grok", role: "agent" },
    { id: "work", title: "Agent working", role: "working" },
    { id: "done", title: "Done", role: "done" },
  ],
  labels: [],
  cards: [
    { id: "c1", num: 1, col: "claude", title: "Claude job", comments: [], createdAt: 1, movedAt: 1 },
    { id: "c2", num: 2, col: "grok", title: "Grok job", comments: [], createdAt: 1, movedAt: 1 },
  ],
  nextNum: 3,
});

test("list by a shared role includes every matching column; id or title still picks one", () => {
  const { result } = run(twoAgents(), "list", { column: "agent" });
  assert.deepEqual((result.cards as Array<{ num: number }>).map((c) => c.num), [1, 2]);
  assert.deepEqual(
    (run(twoAgents(), "list", { column: "grok" }).result.cards as Array<{ num: number }>).map((c) => c.num),
    [2]
  );
  assert.deepEqual(
    (run(twoAgents(), "list", { column: "claude" }).result.cards as Array<{ num: number }>).map((c) => c.num),
    [1]
  );
});

test("create and move refuse a shared role and still accept a unique role, id, or title", () => {
  assert.throws(() => run(twoAgents(), "create", { title: "New", column: "agent" }), /matches more than one column: claude, grok/);
  assert.throws(() => run(twoAgents(), "move", { card: 1, to: "agent" }), /matches more than one column/);
  const created = run(twoAgents(), "create", { title: "New", column: "grok" });
  assert.equal(card(created.state, 3).col, "grok");
  assert.equal(card(run(twoAgents(), "move", { card: 1, to: "working" }).state, 1).col, "work");
  assert.equal(card(run(twoAgents(), "move", { card: 2, to: "claude" }).state, 2).col, "claude");
});

test("logs returns recent worker log lines, filtered and capped", () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({
    id: "lg_" + i,
    at: 1000 + i,
    kind: i === 3 ? "pause" : "launch",
    text: i === 3 ? "Could not merge #12" : "Started #" + (10 + i) + " Task",
    worker: i === 2 ? "Opus" : "Grok",
    workerId: i === 2 ? "w_opus" : "w_grok",
    card: 10 + i,
  }));
  const state = {
    ...board(),
    settings: {
      workers: { w_grok: { name: "Grok" }, w_opus: { name: "Opus" } },
      workerLog: [{ id: "lg_bad" }, ...entries],
    },
  };
  const all = run(state, "logs", {}).result;
  assert.equal(all.total, 6);
  assert.equal((all.logs as unknown[]).length, 6);
  assert.equal((all.logs as Array<{ kind: string }>)[1].kind, "launch");
  assert.equal((all.logs as Array<{ worker: string }>)[0].worker, undefined);

  const grok = run(state, "logs", { worker: "Grok" }).result;
  assert.equal(grok.total, 4);
  assert.deepEqual(
    (grok.logs as Array<{ card?: number }>).map((e) => e.card),
    [10, 11, 13, 14]
  );

  const paused = run(state, "logs", { kind: "PAUSE", q: "merge" }).result;
  assert.equal(paused.total, 1);
  assert.equal((paused.logs as Array<{ text: string }>)[0].text, "Could not merge #12");

  const numbered = run(state, "logs", { q: "#13" }).result;
  assert.equal(numbered.total, 1);
  assert.equal((numbered.logs as Array<{ card: number }>)[0].card, 13);

  const withUsage = {
    ...state,
    settings: {
      ...state.settings,
      workerLog: [
        {
          id: "lg_u",
          at: 2000,
          kind: "merge",
          text: "Merged #12 · 3.3M in · 800 out · 2 rounds",
          worker: "Grok",
          workerId: "w_grok",
          card: 12,
          thread: "th_12",
          usage: { turns: 2, inputTokens: 3_300_000, outputTokens: 800, cacheReadTokens: 0 },
        },
      ],
    },
  };
  const usageLog = (run(withUsage, "logs", {}).result.logs as Array<{ usage?: { inputTokens: number } }>)[0];
  assert.deepEqual(usageLog.usage, { turns: 2, inputTokens: 3_300_000, outputTokens: 800 });

  const many = {
    ...state,
    settings: {
      ...state.settings,
      workerLog: Array.from({ length: 100 }, (_, i) => ({ id: "lg_n" + i, at: i, kind: "wait", text: "Waiting " + i, workerId: "w_grok" })),
    },
  };
  const tail = run(many, "logs", {}).result;
  assert.equal(tail.total, 100);
  assert.equal(tail.more, 20);
  assert.equal((tail.logs as Array<{ text: string }>)[0].text, "Waiting 20");
  assert.equal((tail.logs as Array<{ text: string }>).at(-1)?.text, "Waiting 99");
  assert.equal((run(many, "logs", { limit: 3 }).result.logs as unknown[]).length, 3);
  assert.equal(run(board(), "logs", {}).result.total, 0);
  assert.throws(() => run(state, "logs", { worker: "nobody" }), /no agent worker/);
});

test("list shows the agent workers, marking one that was asked to stop", () => {
  const state = { ...board(), settings: { workers: { w_1: { name: "Opus", stop: true, run: { since: 1 } }, w_2: { name: "Other" } } } };
  const workers = run(state, "list", {}).result.workers;
  assert.deepEqual(workers, [
    { id: "w_1", name: "Opus", running: true, stopRequested: true },
    { id: "w_2", name: "Other" },
  ]);
  assert.equal(run(board(), "list", {}).result.workers, undefined);
});

test("claim refuses a further card for a worker asked to stop, but not its own card or other chats", () => {
  const state = { ...board(), settings: { workers: { w_1: { name: "Opus", stop: true, threadId: "th_1", run: { since: 1 } } } } };
  const own = run(state, "worker_claim", { card: 1, thread: "th_1", assignee: "Opus" }, { caller: { by: "user", label: "user" }, now: 1000, values: {} }).state;
  assert.throws(() => run(own, "claim", { card: 2 }, agent({ thread: "th_1" })), /asked the worker "Opus" to stop/);
  run(own, "claim", { card: 1 }, agent({ thread: "th_1" }));
  run(own, "claim", { card: 2 }, agent({ thread: "th_other" }));
});

test("list filters by assignee regardless of case", () => {
  const state = run(board(), "update", { card: 2, assignee: "Opus" }).state;
  assert.deepEqual((run(state, "list", { assignee: "opus" }).result.cards as Array<{ num: number }>).map((c) => c.num), [2]);
});

test("list and get include a card's last-chat usage", () => {
  const state = {
    ...board(),
    cards: [
      {
        id: "c1",
        num: 1,
        col: "ready",
        title: "One",
        comments: [],
        createdAt: 1,
        movedAt: 1,
        usage: { turns: 2, inputTokens: 3300000, outputTokens: 800, at: 9, thread: "th_1" },
      },
    ],
  };
  const row = (run(state, "list", {}).result.cards as Array<{ usage?: { inputTokens: number; at?: number } }>)[0];
  assert.deepEqual(row.usage, { turns: 2, inputTokens: 3300000, outputTokens: 800, at: 9, thread: "th_1" });
  const got = run(state, "get", { card: 1 }).result as { usage?: { inputTokens: number } };
  assert.equal(got.usage?.inputTokens, 3300000);
});

test("worker_step lets one window at a time move a worker on, once its thread is done", () => {
  const threads: Record<string, ThreadRunInfo> = {
    busy: { exists: true, running: true, title: "Busy" },
    fresh: { exists: true, running: false, title: "Fresh" },
    failed: { exists: true, running: false, title: "Failed", lastTurn: { status: "error", endedAt: 900, error: "rate limited" } },
  };
  const page = (now = 1000): ActionContext => ({ caller: { by: "user", label: "user" }, now, values: {}, thread: (id) => threads[id] ?? { exists: false } });
  const withWorker = (w: Record<string, unknown>) => ({ ...board(), settings: { workers: { w_op: { name: "Opus", ...w } } } });
  const workerOf = (state: Record<string, unknown>) => (state.settings as { workers: Record<string, Record<string, unknown>> }).workers.w_op;

  assert.throws(() => run(withWorker({}), "worker_step", { worker: "w_op", from: null, token: "a", start: true }), /board page itself/);
  assert.throws(() => run(withWorker({}), "worker_step", { worker: "w_op", from: null, token: "a" }, page()), /not running/);

  const started = run(withWorker({ stop: true, error: "old" }), "worker_step", { worker: "w_op", from: null, token: "a", start: true }, page());
  assert.deepEqual(workerOf(started.state).run, { since: 1000 });
  assert.deepEqual(workerOf(started.state).step, { token: "a", at: 1000 });
  assert.equal(workerOf(started.state).stop, undefined);
  assert.equal(workerOf(started.state).error, undefined);
  assert.throws(() => run(started.state, "worker_step", { worker: "w_op", from: null, token: "b" }, page()), /another window/);
  assert.throws(() => run(started.state, "worker_step", { worker: "w_op", from: null, token: "b", start: true }, page()), /already running/);
  run(started.state, "worker_step", { worker: "w_op", from: null, token: "b" }, page(1000 + 16 * 60 * 1000));
  run(withWorker({ step: { token: "gone", at: 999 } }), "worker_step", { worker: "w_op", from: null, token: "b", start: true }, page());
  // By name too; an unknown worker is refused.
  run(withWorker({}), "worker_step", { worker: "opus", from: null, token: "a", start: true }, page());
  assert.throws(() => run(withWorker({}), "worker_step", { worker: "nobody", from: null, token: "a", start: true }, page()), /no agent worker/);

  const running = { run: { since: 1 } };
  assert.throws(() => run(withWorker({ ...running, threadId: "busy" }), "worker_step", { worker: "w_op", from: "busy", token: "a" }, page()), /still working/);
  assert.throws(() => run(withWorker({ ...running, threadId: "fresh" }), "worker_step", { worker: "w_op", from: "fresh", token: "a" }, page()), /still working/);
  assert.throws(() => run(withWorker({ ...running, threadId: "failed" }), "worker_step", { worker: "w_op", from: "other", token: "a" }, page()), /moved on/);
  const failed = run(withWorker({ ...running, threadId: "failed" }), "worker_step", { worker: "w_op", from: "failed", token: "a" }, page());
  assert.deepEqual(failed.result, { ok: true, lastTurn: { status: "error", endedAt: 900, error: "rate limited" } });
  const gone = run(withWorker({ ...running, threadId: "deleted" }), "worker_step", { worker: "w_op", from: "deleted", token: "a" }, page());
  assert.deepEqual(gone.result, { ok: true, lastTurn: null });

  threads.failed = {
    exists: true,
    running: false,
    title: "Failed",
    lastTurn: { status: "error", endedAt: 900, error: "rate limited" },
    usage: { turns: 2, inputTokens: 3_300_000, outputTokens: 800 },
  };
  const withUsage = run(withWorker({ ...running, threadId: "failed" }), "worker_step", { worker: "w_op", from: "failed", token: "u" }, page());
  assert.deepEqual(withUsage.result, {
    ok: true,
    lastTurn: { status: "error", endedAt: 900, error: "rate limited" },
    usage: { turns: 2, inputTokens: 3_300_000, outputTokens: 800 },
  });
});

test("worker_claim claims a card for the chat the board started, so its agent needn't", () => {
  const page: ActionContext = { caller: { by: "user", label: "user" }, now: 1000, values: {} };
  assert.throws(() => run(board(), "worker_claim", { card: 1, thread: "th_a", assignee: "Opus" }), /board page itself/);
  assert.throws(() => run(board(), "worker_claim", { card: 1, assignee: "Opus" }, page), /thread is required/);
  const { state } = run(board(), "worker_claim", { card: 1, thread: "th_a", assignee: "Opus" }, page);
  const c = card(state, 1);
  assert.equal(c.col, "work");
  assert.equal(c.assignee, "Opus");
  assert.equal(c.thread, "th_a");
  assert.equal(c.threadAssignee, "Opus");
  assert.equal(c.from, "ready");
  assert.deepEqual(c.status, { kind: "working", text: "Agent starting" });
  assert.deepEqual(c.claim, { holder: "Opus", thread: "th_a", at: 1000, seenAt: 1000, from: "ready" });
  // The chat's own claim still goes through; another chat's is refused, and so is claiming it for another chat.
  run(state, "claim", { card: 1, assignee: "Opus" }, agent({ session: undefined, thread: "th_a" }));
  assert.throws(() => run(state, "claim", { card: 1 }, agent({ session: undefined, thread: "th_b" })), /held by Opus/);
  assert.throws(() => run(state, "worker_claim", { card: 1, thread: "th_b", assignee: "Opus" }, page), /held by Opus/);
  // Continue: a finished card goes back to working for the same chat.
  const finished = run(state, "finish", { card: 1, summary: "done" }, agent({ session: undefined, thread: "th_a" })).state;
  const reassigned = run(finished, "update", { card: 1, assignee: "Sol" }, page).state;
  assert.equal(card(reassigned, 1).assignee, "Sol");
  assert.equal(card(reassigned, 1).threadAssignee, "Opus");
  const again = run(finished, "worker_claim", { card: 1, thread: "th_a", assignee: "Opus" }, page).state;
  assert.equal(card(again, 1).col, "work");
  assert.equal((card(again, 1).claim as { from?: string }).from, "ready");
});

test("the sweep releases a card whose thread failed and flags one whose thread went quiet", () => {
  let state: Record<string, unknown> = board();
  state = run(state, "claim", { card: 1 }, agent({ session: undefined, thread: "th_fail" })).state;
  state = run(state, "claim", { card: 2 }, agent({ session: undefined, thread: "th_idle" })).state;
  const threads: Record<string, ThreadRunInfo> = {
    th_fail: { exists: true, running: false, title: "A", lastTurn: { status: "error", endedAt: 2000, error: "credit balance too low" } },
    th_idle: { exists: true, running: false, title: "B", lastTurn: { status: "done", endedAt: 2000 } },
  };
  const ctx = (now: number): SweepContext => ({ now, thread: (id) => threads[id] ?? { exists: false }, sessionSeenAt: () => undefined });
  const first = kanbanActions.sweep!(state, ctx(3000))!;
  state = applyStateOps(state, first.ops);
  assert.equal(card(state, 1).col, "ready");
  assert.equal(card(state, 1).claim, undefined);
  assert.match((card(state, 1).status as { text: string }).text, /failed: credit balance too low/);
  assert.equal(card(state, 2).col, "work");
  assert.deepEqual(first.events?.map((e) => e.name), ["claim_lost"]);
  const later = kanbanActions.sweep!(state, ctx(2000 + 31 * 60 * 1000))!;
  state = applyStateOps(state, later.ops);
  assert.equal((card(state, 2).claim as { stale?: boolean }).stale, true);
  assert.deepEqual(later.events?.map((e) => e.name), ["claim_stale"]);
  assert.equal(kanbanActions.sweep!(state, ctx(2000 + 40 * 60 * 1000)), null);
});

test("the sweep keeps a claim whose thread id is unknown while its MCP session is still live", () => {
  const state = run(board(), "claim", { card: 1 }, agent({ session: "s1", thread: "th_draft" })).state;
  const live: SweepContext = {
    now: 10_000,
    thread: () => ({ exists: false }),
    sessionSeenAt: (session) => (session === "s1" ? 9000 : undefined),
  };
  assert.equal(kanbanActions.sweep!(state, live), null);
  const gone: SweepContext = {
    now: 10_000 + 61 * 60 * 1000,
    thread: () => ({ exists: false }),
    sessionSeenAt: (session) => (session === "s1" ? 9000 : undefined),
  };
  const lost = kanbanActions.sweep!(state, gone)!;
  assert.equal(card(state, 1).col, "work");
  const next = applyStateOps(state, lost.ops);
  assert.equal(card(next, 1).col, "ready");
  assert.equal(card(next, 1).claim, undefined);
  assert.match((card(next, 1).status as { text: string }).text, /was deleted/);
  assert.deepEqual(lost.events?.map((e) => e.name), ["claim_lost"]);
});

test("claim, release, and sweep return a card to the agent column it came from, not the first one", () => {
  const two = () => ({
    columns: [
      { id: "claude", title: "claude", role: "agent" },
      { id: "grok", title: "grok", role: "agent" },
      { id: "work", title: "Agent working", role: "working" },
      { id: "done", title: "Done", role: "done" },
    ],
    labels: [],
    cards: [
      { id: "c1", num: 1, col: "grok", title: "One", comments: [], createdAt: 1, movedAt: 1 },
      { id: "c2", num: 2, col: "claude", title: "Two", comments: [], createdAt: 1, movedAt: 1 },
    ],
    nextNum: 3,
  });
  const claimed = run(two(), "claim", { card: 1 }, agent({ session: undefined, thread: "th_g" }));
  assert.equal(card(claimed.state, 1).col, "work");
  assert.equal(card(claimed.state, 1).from, "grok");
  assert.equal((card(claimed.state, 1).claim as { from?: string }).from, "grok");

  const released = run(claimed.state, "release", { card: 1 });
  assert.equal(card(released.state, 1).col, "grok");

  const again = run(claimed.state, "claim", { card: 1 }, agent({ session: undefined, thread: "th_g" }));
  assert.equal((card(again.state, 1).claim as { from?: string }).from, "grok");

  const threads: Record<string, ThreadRunInfo> = {
    th_g: { exists: true, running: false, title: "G", lastTurn: { status: "cancelled", endedAt: 2000 } },
  };
  const ctx: SweepContext = { now: 3000, thread: (id) => threads[id] ?? { exists: false }, sessionSeenAt: () => undefined };
  const lost = kanbanActions.sweep!(claimed.state, ctx)!;
  assert.equal(card(applyStateOps(claimed.state, lost.ops), 1).col, "grok");
});

test("sweep falls back to the first agent column when the origin column is gone", () => {
  const claimed = run(
    {
      columns: [
        { id: "claude", title: "claude", role: "agent" },
        { id: "grok", title: "grok", role: "agent" },
        { id: "work", title: "Agent working", role: "working" },
      ],
      labels: [],
      cards: [{ id: "c1", num: 1, col: "grok", title: "One", comments: [], createdAt: 1, movedAt: 1 }],
      nextNum: 2,
    },
    "claim",
    { card: 1 },
    agent({ session: undefined, thread: "th" })
  );
  const gone = {
    ...claimed.state,
    columns: (claimed.state.columns as Array<{ id: string }>).filter((c) => c.id !== "grok"),
  };
  const threads: Record<string, ThreadRunInfo> = {
    th: { exists: true, running: false, title: "A", lastTurn: { status: "error", endedAt: 2000 } },
  };
  const lost = kanbanActions.sweep!(gone, {
    now: 3000,
    thread: (id) => threads[id] ?? { exists: false },
    sessionSeenAt: () => undefined,
  })!;
  assert.equal(card(applyStateOps(gone, lost.ops), 1).col, "claude");
});

test("the sweep keeps a running worker's card claimed while its chat waits out a plan limit", () => {
  const resetsAt = 50_000;
  const limited: ThreadRunInfo = { exists: true, running: false, title: "W", lastTurn: { status: "error", endedAt: 2000, error: "You've hit your limit", limitResetsAt: resetsAt } };
  const claimed = run(board(), "claim", { card: 1 }, agent({ session: undefined, thread: "th_w" })).state;
  const withWorker = (w: Record<string, unknown>) => ({ ...claimed, settings: { workers: { w_1: { threadId: "th_w", ...w } } } });
  const ctx = (now: number): SweepContext => ({ now, thread: () => limited, sessionSeenAt: () => undefined });

  const waiting = kanbanActions.sweep!(withWorker({ run: { since: 1 } }), ctx(3000))!;
  const state = applyStateOps(withWorker({ run: { since: 1 } }), waiting.ops);
  assert.equal(card(state, 1).col, "work");
  assert.ok(card(state, 1).claim);
  assert.equal((card(state, 1).status as { kind: string }).kind, "info");
  assert.match((card(state, 1).status as { text: string }).text, /Out of plan usage/);
  assert.equal(waiting.events?.length, 0);
  // The status is set once, not on every sweep.
  assert.equal(kanbanActions.sweep!(state, ctx(4000)), null);

  // Long after the reset, with no one picking it up, the claim goes stale.
  const late = kanbanActions.sweep!(state, ctx(resetsAt + 31 * 60 * 1000))!;
  assert.deepEqual(late.events?.map((e) => e.name), ["claim_stale"]);

  // A stopped worker (or a chat no worker runs) loses the card as before.
  const stopped = kanbanActions.sweep!(withWorker({}), ctx(3000))!;
  assert.deepEqual(stopped.events?.map((e) => e.name), ["claim_lost"]);
});

test("the sweep keeps a one-card run's card claimed while that chat waits out a plan limit", () => {
  const resetsAt = 50_000;
  const limited: ThreadRunInfo = {
    exists: true,
    running: false,
    title: "S",
    lastTurn: { status: "error", endedAt: 2000, error: "You've hit your limit", limitResetsAt: resetsAt },
  };
  const claimed = run(board(), "claim", { card: 1 }, agent({ session: undefined, thread: "th_solo" })).state;
  const withSolo = (over: Record<string, unknown> = {}) => ({
    ...claimed,
    settings: { workers: { w_1: { name: "Opus", solo: { th_solo: { card: 1, at: 1 } }, ...over } } },
  });
  const ctx = (now: number): SweepContext => ({ now, thread: () => limited, sessionSeenAt: () => undefined });

  const waiting = kanbanActions.sweep!(withSolo(), ctx(3000))!;
  const state = applyStateOps(withSolo(), waiting.ops);
  assert.equal(card(state, 1).col, "work");
  assert.ok(card(state, 1).claim);
  assert.equal((card(state, 1).status as { kind: string }).kind, "info");
  assert.match((card(state, 1).status as { text: string }).text, /Out of plan usage/);
  assert.equal(waiting.events?.length, 0);

  // Beside the worker's own run on a different chat, the one-card run still waits.
  const beside = kanbanActions.sweep!(withSolo({ threadId: "th_other", run: { since: 1 } }), ctx(3000))!;
  assert.equal(card(applyStateOps(withSolo({ threadId: "th_other", run: { since: 1 } }), beside.ops), 1).col, "work");

  // Dropping the solo entry releases the card as a failed turn.
  const gone = kanbanActions.sweep!(withSolo({ solo: {} }), ctx(3000))!;
  assert.deepEqual(gone.events?.map((e) => e.name), ["claim_lost"]);
});

test("worker_step passes on when a plan limit resets", () => {
  const threads: Record<string, ThreadRunInfo> = {
    limited: { exists: true, running: false, title: "L", lastTurn: { status: "error", endedAt: 900, error: "limit", limitResetsAt: 5000 } },
  };
  const page: ActionContext = { caller: { by: "user", label: "user" }, now: 1000, values: {}, thread: (id) => threads[id] ?? { exists: false } };
  const state = { ...board(), settings: { workers: { w_1: { threadId: "limited", run: { since: 1 } } } } };
  const r = run(state, "worker_step", { worker: "w_1", from: "limited", token: "a" }, page);
  assert.deepEqual(r.result, { ok: true, lastTurn: { status: "error", endedAt: 900, error: "limit", limitResetsAt: 5000 } });
});

test("worker and one-card steps retain the host's authoritative Codex recovery flag", () => {
  for (const usageRecoveryAllowed of [false, true]) {
    const lastTurn = { status: "error", endedAt: 900, limitResetsAt: 500, usageRecoveryAllowed };
    const page: ActionContext = { caller: { by: "user", label: "user" }, now: 1000, values: {},
      thread: () => ({ exists: true, running: false, title: "Codex", lastTurn }) };
    const state = { ...board(), settings: { workers: { w_1: { threadId: "limited", run: { since: 1 }, solo: { limited: { card: 1, at: 1 } } } } } };
    assert.deepEqual(run(state, "worker_step", { worker: "w_1", from: "limited", token: "a" }, page).result, { ok: true, lastTurn });
    assert.deepEqual(run(state, "worker_solo_step", { worker: "w_1", thread: "limited", token: "a" }, page).result, { ok: true, lastTurn });
  }
});

test("worker_solo_step lets one window wrap up a one-card run and passes on a plan limit", () => {
  const threads: Record<string, ThreadRunInfo> = {
    busy: { exists: true, running: true, title: "Busy" },
    limited: { exists: true, running: false, title: "L", lastTurn: { status: "error", endedAt: 900, error: "limit", limitResetsAt: 5000 } },
    done: { exists: true, running: false, title: "D", lastTurn: { status: "done", endedAt: 900 } },
  };
  const page = (now = 1000): ActionContext => ({ caller: { by: "user", label: "user" }, now, values: {}, thread: (id) => threads[id] ?? { exists: false } });
  const withSolo = (solo: Record<string, unknown>) => ({
    ...board(),
    settings: { workers: { w_1: { name: "Opus", solo } } },
  });
  const soloOf = (state: Record<string, unknown>, tid: string) => {
    const settings = state.settings as { workers: { w_1: { solo: Record<string, { step?: { token: string; at: number } }> } } };
    return settings.workers.w_1.solo[tid];
  };

  assert.throws(() => run(withSolo({ th: { card: 1, at: 1 } }), "worker_solo_step", { worker: "w_1", thread: "th", token: "a" }), /board page itself/);
  assert.throws(() => run(withSolo({}), "worker_solo_step", { worker: "w_1", thread: "th", token: "a" }, page()), /not a one-card run/);
  assert.throws(() => run(withSolo({ th: { card: 1, at: 1 } }), "worker_solo_step", { worker: "w_1", thread: "  ", token: "a" }, page()), /thread is required/);
  assert.throws(() => run(withSolo({ th: { card: 1, at: 1 } }), "worker_solo_step", { worker: "w_1", thread: "th", token: "  " }, page()), /token is required/);
  assert.throws(() => run(withSolo({ busy: { card: 1, at: 1 } }), "worker_solo_step", { worker: "w_1", thread: "busy", token: "a" }, page()), /still working/);

  const limited = run(withSolo({ limited: { card: 1, at: 1 } }), "worker_solo_step", { worker: "w_1", thread: "limited", token: "a" }, page());
  assert.deepEqual(limited.result, { ok: true, lastTurn: { status: "error", endedAt: 900, error: "limit", limitResetsAt: 5000 } });
  assert.deepEqual(soloOf(limited.state, "limited").step, { token: "a", at: 1000 });
  assert.throws(() => run(limited.state, "worker_solo_step", { worker: "w_1", thread: "limited", token: "b" }, page()), /another window/);
  run(limited.state, "worker_solo_step", { worker: "w_1", thread: "limited", token: "b" }, page(1000 + 16 * 60 * 1000));

  threads.done = {
    exists: true,
    running: false,
    title: "D",
    lastTurn: { status: "done", endedAt: 900 },
    usage: { turns: 1, inputTokens: 40, outputTokens: 12 },
  };
  const done = run(withSolo({ done: { card: 2, at: 1 } }), "worker_solo_step", { worker: "w_1", thread: "done", token: "c" }, page());
  // endedAt lets the page tell a Continue's turn from the one before it (#253).
  assert.deepEqual(done.result, {
    ok: true,
    lastTurn: { status: "done", endedAt: 900 },
    usage: { turns: 1, inputTokens: 40, outputTokens: 12 },
  });
  const gone = run(withSolo({ missing: { card: 3, at: 1 } }), "worker_solo_step", { worker: "w_1", thread: "missing", token: "d" }, page());
  assert.deepEqual(gone.result, { ok: true, lastTurn: null });
});

test("worker launch status changes only after fresh output, preserving custom statuses", () => {
  const page: ActionContext = { caller: { by: "user" }, now: 1000, values: {} };
  let state = run(board(), "worker_claim", { card: 1, thread: "th_w", assignee: "Sol" }, page).state;
  let info: ThreadRunInfo = { exists: true, running: true, title: "W" };
  const ctx: SweepContext = { now: 3000, thread: () => info, sessionSeenAt: () => undefined };
  assert.equal(kanbanActions.sweep!(state, ctx), null);
  info = { ...info, outputAt: 999 };
  assert.equal(kanbanActions.sweep!(state, ctx), null);
  info = { ...info, outputAt: 1001 };
  const shortTurn: ThreadRunInfo = { exists: true, running: false, title: "W", outputAt: 1001, lastTurn: { status: "done", endedAt: 2000 } };
  const completed = applyStateOps(state, kanbanActions.sweep!(state, { ...ctx, thread: () => shortTurn })!.ops);
  assert.deepEqual(card(completed, 1).status, { kind: "working", text: "Agent working" });
  state = applyStateOps(state, kanbanActions.sweep!(state, ctx)!.ops);
  assert.deepEqual(card(state, 1).status, { kind: "working", text: "Agent working" });
  assert.equal(kanbanActions.sweep!(state, ctx), null);
  for (const status of [{ kind: "working", text: "Testing it" }, { kind: "blocked", text: "Need input" }, null]) {
    const custom = run(state, "update", { card: 1, status }).state;
    assert.equal(kanbanActions.sweep!(custom, ctx), null);
  }
});

test("fresh resumed output clears the board's usage-limit status", () => {
  const claimed = run(board(), "claim", { card: 1 }, agent({ thread: "th_w" })).state;
  let state = { ...claimed, settings: { workers: { w_1: { threadId: "th_w", run: { since: 1 } } } } };
  let info: ThreadRunInfo = { exists: true, running: false, title: "W", lastTurn: { status: "error", endedAt: 2000, limitResetsAt: 5000 } };
  const ctx: SweepContext = { now: 3000, thread: () => info, sessionSeenAt: () => undefined };
  state = applyStateOps(state, kanbanActions.sweep!(state, ctx)!.ops) as typeof state;
  assert.match((card(state, 1).status as { text: string }).text, /Out of plan usage/);
  info = { exists: true, running: true, title: "W" };
  assert.equal(kanbanActions.sweep!(state, ctx), null);
  info = { ...info, outputAt: 6000 };
  state = applyStateOps(state, kanbanActions.sweep!(state, ctx)!.ops) as typeof state;
  assert.deepEqual(card(state, 1).status, { kind: "working", text: "Agent working" });
});

test("output while asking preserves the question and restores working after the answer", () => {
  const page: ActionContext = { caller: { by: "user" }, now: 1000, values: {} };
  let state = run(board(), "worker_claim", { card: 1, thread: "th_w", assignee: "Sol" }, page).state;
  let info: ThreadRunInfo = { exists: true, running: true, title: "W", outputAt: 2000, asking: { kind: "approval", title: "Run tests" } };
  const ctx: SweepContext = { now: 3000, thread: () => info, sessionSeenAt: () => undefined };
  state = applyStateOps(state, kanbanActions.sweep!(state, ctx)!.ops);
  assert.deepEqual(card(state, 1).status, { kind: "blocked", text: "Waiting for your approval: Run tests" });
  info = { exists: true, running: true, title: "W", outputAt: 2000 };
  state = applyStateOps(state, kanbanActions.sweep!(state, ctx)!.ops);
  assert.deepEqual(card(state, 1).status, { kind: "working", text: "Agent working" });
});

test("the sweep marks a card blocked while its thread waits on the user, and puts its status back after", () => {
  let state: Record<string, unknown> = board();
  state = run(state, "claim", { card: 1, text: "Building it" }, agent({ session: undefined, thread: "th_ask" })).state;
  const working = card(state, 1).status;
  let info: ThreadRunInfo = { exists: true, running: true, title: "W", asking: { kind: "question", title: "Pick one", page: { key: "scribe:form", title: "Which layout?" } } };
  const ctx: SweepContext = { now: 3000, thread: () => info, sessionSeenAt: () => undefined };
  const asked = kanbanActions.sweep!(state, ctx)!;
  state = applyStateOps(state, asked.ops);
  assert.deepEqual(card(state, 1).status, { kind: "blocked", text: "Waiting for your answer: Which layout?" });
  assert.equal(card(state, 1).col, "work");
  assert.equal(asked.events?.length ?? 0, 0);
  assert.equal(kanbanActions.sweep!(state, ctx), null);

  // A second question while still waiting keeps the status from before the first.
  info = { exists: true, running: true, title: "W", asking: { kind: "approval", title: "Run npm test" } };
  state = applyStateOps(state, kanbanActions.sweep!(state, ctx)!.ops);
  assert.deepEqual(card(state, 1).status, { kind: "blocked", text: "Waiting for your approval: Run npm test" });

  info = { exists: true, running: true, title: "W" };
  state = applyStateOps(state, kanbanActions.sweep!(state, ctx)!.ops);
  assert.deepEqual(card(state, 1).status, working);
  assert.equal((card(state, 1).claim as { waiting?: unknown }).waiting, undefined);
  assert.equal(kanbanActions.sweep!(state, ctx), null);
});

test("the sweep leaves a status the user set while the agent waited", () => {
  let state: Record<string, unknown> = board();
  state = run(state, "claim", { card: 1 }, agent({ session: undefined, thread: "th_ask" })).state;
  let info: ThreadRunInfo = { exists: true, running: true, title: "W", asking: { kind: "plan", title: "Plan" } };
  const ctx: SweepContext = { now: 3000, thread: () => info, sessionSeenAt: () => undefined };
  state = applyStateOps(state, kanbanActions.sweep!(state, ctx)!.ops);
  state = run(state, "update", { card: 1, status: { kind: "info", text: "Answered in chat" } }).state;
  info = { exists: true, running: true, title: "W" };
  state = applyStateOps(state, kanbanActions.sweep!(state, ctx)!.ops);
  assert.deepEqual(card(state, 1).status, { kind: "info", text: "Answered in chat" });
  assert.equal((card(state, 1).claim as { waiting?: unknown }).waiting, undefined);
});

test("worker_step waits while Scribe sees a run through, and returns the run once it ended", () => {
  const ended = { phase: "ended" as const, fixes: 0, after: 1, createdAt: 1, merge: true, outcome: { kind: "done" as const, merged: true } };
  const threads: Record<string, ThreadRunInfo> = {
    waiting: { exists: true, running: false, title: "W", lastTurn: { status: "error", endedAt: 900, limitResetsAt: 5000 }, run: { phase: "waiting", fixes: 0, after: 1, createdAt: 1, merge: true, wait: { until: 5000, count: 1 } } },
    merging: { exists: true, running: false, title: "M", lastTurn: { status: "done", endedAt: 900 }, run: { phase: "running", fixes: 0, after: 1, createdAt: 1, merge: true } },
    ended: { exists: true, running: false, title: "E", lastTurn: { status: "done", endedAt: 900 }, run: ended },
  };
  const page: ActionContext = { caller: { by: "user", label: "user" }, now: 1000, values: {}, thread: (id) => threads[id] ?? { exists: false } };
  const withWorker = (threadId: string) => ({ ...board(), settings: { workers: { w_op: { name: "Opus", run: { since: 1 }, threadId } } } });
  assert.throws(() => run(withWorker("waiting"), "worker_step", { worker: "w_op", from: "waiting", token: "a" }, page), /usage limit/);
  assert.throws(() => run(withWorker("merging"), "worker_step", { worker: "w_op", from: "merging", token: "a" }, page), /seeing the agent through/);
  const done = run(withWorker("ended"), "worker_step", { worker: "w_op", from: "ended", token: "a" }, page);
  assert.deepEqual(done.result.run, ended);
});

test("runHold keeps a chat's branch unmerged while it still holds a card", () => {
  const claimed = run(board(), "claim", { card: 1 }, agent({ thread: "th1" })).state;
  assert.equal(kanbanActions.runHold!(claimed, "th1"), "it still holds #1");
  assert.equal(kanbanActions.runHold!(claimed, "th2"), null);
});

test("runEvent logs Scribe's steps for a worker's chat in the worker log", () => {
  const state = { ...board(), settings: { workers: { w_op: { name: "Opus" } } } };
  const view = { phase: "waiting" as const, fixes: 0, after: 1, createdAt: 1, merge: true, data: { worker: "w_op", card: 2 }, wait: { until: 5000, count: 1 } };
  const limit = kanbanActions.runEvent!(state, { kind: "limit", text: "x", resetsAt: 5000, thread: "th1", run: view }, 1000)!;
  const after = applyStateOps(state, limit.ops) as { settings: { workerLog: Array<Record<string, unknown>> } };
  const line = after.settings.workerLog[0];
  assert.equal(line.kind, "limit");
  assert.equal(line.worker, "Opus");
  assert.equal(line.card, 2);
  assert.match(String(line.text), /^Out of plan usage until .+ \(wait 1\)$/);
  // Not a worker's chat, or its end (the board logs that with the chat's token totals): nothing.
  assert.equal(kanbanActions.runEvent!(after, { kind: "end", text: "Done", thread: "th1", run: { ...view, phase: "ended", outcome: { kind: "done", merged: true } } }, 2000), null);
  assert.equal(kanbanActions.runEvent!(state, { kind: "limit", text: "x", thread: "th1", run: { ...view, data: {} } }, 1000), null);
  assert.equal(kanbanActions.runEvent!(state, { kind: "end", text: "x", thread: "th1", run: { ...view, phase: "ended", outcome: { kind: "failed" } } }, 1000), null);
});

test("sweep keeps a card claimed while Scribe waits out its chat's usage limit", () => {
  const claimed = run(board(), "claim", { card: 1 }, agent({ thread: "th1" })).state;
  const info: ThreadRunInfo = { exists: true, running: false, title: "T", lastTurn: { status: "error", endedAt: 900, limitResetsAt: 1000 }, run: { phase: "waiting", fixes: 0, after: 1, createdAt: 1, merge: true, wait: { until: 61000, count: 1 } } };
  // Long after the reset (Codex hasn't confirmed it yet): still waiting, not stale or released.
  const ctx: SweepContext = { now: 1000 + 2 * 60 * 60 * 1000, thread: () => info, sessionSeenAt: () => undefined };
  const out = kanbanActions.sweep!(claimed, ctx);
  const next = out ? applyStateOps(claimed, out.ops) : claimed;
  const c = card(next, 1) as { claim?: { stale?: boolean }; status?: { kind: string; text: string } };
  assert.ok(c.claim && !c.claim.stale);
  assert.match(c.status!.text, /^Out of plan usage\. The worker goes on after the limit resets/);
});

const reply = (over: Record<string, unknown> = {}) => ({
  from: { id: "t_form", key: "scribe:card-2-form", title: "Form" },
  card: 2,
  summary: "Picked A",
  data: { approach: "A", skipped: "", notes: "line one\nline two" },
  ...over,
});

const threads = (map: Record<string, ThreadRunInfo>) => (id: string): ThreadRunInfo => map[id] ?? { exists: false };
const userCtx = (thread?: (id: string) => ThreadRunInfo): ActionContext => ({ caller: { by: "user" }, now: 5000, values: {}, ...(thread ? { thread } : {}) });
const idle: ThreadRunInfo = { exists: true, running: false, title: "chat" };
const running: ThreadRunInfo = { exists: true, running: true, title: "chat" };

test("a reply becomes the user's comment, with the answers and a peek link to the form", () => {
  const outcome = kanbanActions.reply!(board(), reply(), userCtx());
  const state = applyStateOps(board(), outcome.ops);
  const comments = card(state, 2).comments as Array<{ by: string; text: string; followUp?: string }>;
  assert.equal(comments.length, 1);
  assert.equal(comments[0].by, "user");
  assert.equal(comments[0].followUp, undefined);
  assert.equal(comments[0].text, "**Reply from [[peek:scribe:card-2-form]]:** Picked A\n\n- **approach:** A\n\n**notes:**\n> line one\n> line two");
  assert.equal(outcome.deliver, undefined);
  assert.deepEqual(outcome.events, [{ name: "comment", data: { card: "c2", num: 2, column: "Ready for agent", columnId: "ready", role: "agent", reply: "scribe:card-2-form" } }]);
  assert.throws(() => kanbanActions.reply!(board(), reply({ card: undefined }), userCtx()), /no card/);
});

test("a reply goes into the running turn of the card's holder, and records how", () => {
  const start = board();
  card(start, 2).claim = { holder: "Opus", thread: "th1", at: 1 };
  card(start, 2).thread = "th1";
  card(start, 2).threadAssignee = "Opus";
  const outcome = kanbanActions.reply!(start, reply(), userCtx(threads({ th1: running })));
  assert.equal(outcome.deliver?.thread, "th1");
  assert.equal(outcome.deliver?.resume, false);
  const state = applyStateOps(start, outcome.ops);
  const after = kanbanActions.replyDelivered!(state, outcome.deliver!, "steered", userCtx())!;
  const done = applyStateOps(state, after.ops);
  assert.equal((card(done, 2).comments as Array<{ sent?: string }>)[0].sent, "steered");
  assert.equal(card(done, 2).col, "ready");
});

test("a reply immediately moves its pending continuation to ready without starting or claiming", () => {
  const start = { ...board(), settings: { workers: { opus: { name: "Opus" } } } };
  card(start, 2).col = "rev";
  card(start, 2).thread = "th1";
  card(start, 2).threadAssignee = "Opus";
  card(start, 2).assignee = "Opus";
  const outcome = kanbanActions.reply!(start, reply(), userCtx(threads({ th1: idle })));
  assert.equal(outcome.deliver, undefined);
  const state = applyStateOps(start, outcome.ops);
  const c = card(state, 2);
  assert.equal(c.col, "ready");
  assert.equal(c.from, "ready");
  assert.equal(c.doneAt, undefined);
  assert.equal(c.claim, undefined);
  assert.equal(c.assignee, "Opus");
  const request = c.continuation as { id: string; thread: string; comment: string };
  assert.ok(request.id);
  assert.equal(request.thread, "th1");
  assert.equal(request.comment, (c.comments as Array<{ id: string }>)[0].id);
});

test("a reply never directly starts a waiting or missing chat", () => {
  const start = { ...board(), settings: { workers: { opus: { name: "Opus" } } } };
  card(start, 2).assignee = "Opus";
  card(start, 2).thread = "th1";
  const waiting: ThreadRunInfo = { ...idle, run: { phase: "waiting" } as never };
  const held = kanbanActions.reply!(start, reply(), userCtx(threads({ th1: waiting })));
  assert.equal(held.deliver, undefined);
  const gone = kanbanActions.reply!(start, reply(), userCtx(threads({})));
  assert.equal(gone.deliver, undefined);
  const state = applyStateOps(start, gone.ops);
  assert.ok(card(state, 2).continuation);
});

test("Continue immediately returns to the original paused ready inbox and Dismiss leaves it there", () => {
  const start = { ...board(), settings: { workers: { opus: { name: "Opus" } } } };
  start.columns.push({ id: "ready2", title: "Second inbox", role: "agent", paused: true } as typeof start.columns[number]);
  Object.assign(card(start, 3), { assignee: "Opus", from: "ready2", blockedBy: ["c1"] });
  const queued = run(start, "continue", { card: 3 }, userCtx()).state;
  assert.equal(card(queued, 3).col, "ready2");
  assert.equal(card(queued, 3).from, "ready2");
  assert.equal(card(queued, 3).doneAt, undefined);
  assert.equal(card(queued, 3).claim, undefined);
  assert.ok(card(queued, 3).continuation);
  const dismissed = run(queued, "continue", { card: 3, dismiss: true }, userCtx()).state;
  assert.equal(card(dismissed, 3).col, "ready2");
  assert.equal(card(dismissed, 3).continuation, undefined);
});

test("a form reply on a person's card offers Ask without resuming or claiming the old chat", () => {
  for (const assignee of [undefined, "Person"]) for (const defaultWorker of [undefined, "opus"]) {
    const start = { ...board(), settings: { defaultWorker, workers: { opus: { name: "Opus" } } } };
    Object.assign(card(start, 2), { assignee, thread: "old", col: "rev" });
    const outcome = kanbanActions.reply!(start, reply(), userCtx(threads({ old: idle })));
    assert.equal(outcome.deliver, undefined);
    const c = card(applyStateOps(start, outcome.ops), 2);
    assert.equal(c.assignee, assignee);
    assert.equal(c.col, "rev");
    assert.equal(c.thread, "old");
    assert.equal(c.claim, undefined);
    assert.equal((c.comments as Array<{ followUp?: string }>)[0].followUp, defaultWorker ? "offer" : undefined);
  }
});

test("get with cards reads several cards in full and names the missing ones", () => {
  const commented = run(board(), "comment", { card: 2, text: "Note" }).state;
  const { result } = run(commented, "get", { cards: [2, 1, 99] });
  const got = result.cards as Array<{ num: number; comments: Array<{ text: string }>; column: string }>;
  assert.deepEqual(got.map((c) => c.num), [2, 1]);
  assert.equal(got[0].comments[0].text, "Note");
  assert.equal(got[0].column, "Ready for agent");
  assert.deepEqual(result.missing, [99]);
  assert.throws(() => run(board(), "get", { cards: [] }), /list of card numbers/);
  assert.throws(() => run(board(), "get", { cards: Array.from({ length: 31 }, (_, i) => i) }), /up to 30/);
});

test("update can comment and move in the same step, and answers lean", () => {
  const { state, result } = run(board(), "update", { card: 1, priority: 3, comment: "Triaged", to: "Inbox" });
  assert.deepEqual(result, { num: 1, column: "Inbox" });
  assert.equal(card(state, 1).priority, 3);
  assert.equal(card(state, 1).col, "in");
  assert.equal(card(state, 1).movedAt, 1000);
  assert.equal((card(state, 1).comments as Array<{ text: string }>)[0].text, "Triaged");
  assert.deepEqual(run(board(), "update", { card: 1, comment: "Only a note" }).result, { num: 1, column: "Ready for agent" });
  assert.throws(() => run(board(), "update", { card: 1 }), /nothing to change/);
  assert.throws(() => run(board(), "update", { card: 1, position: "top" }), /position needs to/);
});

test("batch applies each card's update in order, all or none", () => {
  const { state, result } = run(board(), "batch", {
    changes: [
      { card: 1, assignee: "Opus", to: "Inbox" },
      { card: 2, priority: 2, comment: "Later", to: "Inbox" },
    ],
  });
  assert.deepEqual(result.cards, [{ num: 1, column: "Inbox" }, { num: 2, column: "Inbox" }]);
  assert.equal(card(state, 1).assignee, "Opus");
  assert.equal(card(state, 2).priority, 2);
  // Each move lands at the top of Inbox.
  assert.deepEqual((state.cards as Array<{ num: number; col: string }>).filter((c) => c.col === "in").map((c) => c.num), [2, 1]);
  assert.throws(
    () => run(board(), "batch", { changes: [{ card: 1, priority: 1 }, { card: 9, priority: 1 }] }),
    /changes\[1\] \(card 9\): .*nothing was changed/
  );
  assert.throws(() => run(board(), "batch", { changes: [] }), /changes is a list/);
});
