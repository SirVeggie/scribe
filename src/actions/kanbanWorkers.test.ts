import assert from "node:assert/strict";
import { test } from "node:test";
import { applyStateOps } from "../stateOps.js";
import { kanbanActions } from "./kanban.js";
import type { DriveContext, DriveOutcome, PageRunInput, ThreadRunInfo } from "./types.js";

type State = Record<string, unknown>;
type Card = Record<string, unknown> & { num: number; col: string };

const board = (worker: Record<string, unknown> = {}, extra: State = {}): State => ({
  columns: [
    { id: "in", title: "Inbox" },
    { id: "ready", title: "Ready for agent", role: "agent" },
    { id: "work", title: "Agent working", role: "working" },
    { id: "rev", title: "Needs review", role: "review" },
    { id: "done", title: "Done", role: "done" },
  ],
  labels: [],
  cards: [
    { id: "c1", num: 1, col: "ready", title: "One", assignee: "Opus", comments: [], createdAt: 1, movedAt: 1 },
    { id: "c2", num: 2, col: "ready", title: "Two", assignee: "Opus", comments: [], createdAt: 1, movedAt: 1 },
    { id: "c3", num: 3, col: "ready", title: "Three", assignee: "Someone", comments: [], createdAt: 1, movedAt: 1 },
  ],
  nextNum: 4,
  settings: { workerInstructions: "Do the cards.", workers: { w_op: { name: "Opus", mode: "code", cwd: "C:/repo", worktree: true, ...worker } } },
  ...extra,
});

function ctx(threads: Record<string, ThreadRunInfo> = {}, over: Partial<DriveContext> = {}) {
  const watched: Array<{ thread: string; run: PageRunInput }> = [];
  const released: string[] = [];
  const c: DriveContext = {
    now: 10_000,
    thread: (id) => threads[id] ?? { exists: false },
    sessionSeenAt: () => undefined,
    page: { id: "t_board", title: "Todo" },
    mayStart: () => null,
    watch: (thread, run) => (watched.push({ thread, run }), true),
    release: (thread) => void released.push(thread),
    ...over,
  };
  return { c, watched, released };
}

const drive = (state: State, c: DriveContext) => kanbanActions.drive!(state, c);
const apply = (state: State, out: DriveOutcome | null) => (out ? applyStateOps(state, out.ops) : state);
const worker = (state: State) => ((state.settings as State).workers as Record<string, Record<string, unknown>>).w_op;
const card = (state: State, num: number) => (state.cards as Card[]).find((c) => c.num === num)!;
const log = (state: State) => ((state.settings as State).workerLog as Array<{ kind: string; text: string }> | undefined) ?? [];
const ended = (outcome: Record<string, unknown>, extra: Record<string, unknown> = {}): ThreadRunInfo => ({
  exists: true,
  running: false,
  title: "chat",
  lastTurn: { status: "done", endedAt: 9000 },
  run: { phase: "ended", fixes: 0, createdAt: 1, merge: true, outcome: outcome as never },
  ...extra,
});

test("a running worker with no chat gets its first ready card launched, under a step lease", () => {
  const { c } = ctx();
  const state = board({ run: { since: 5 } });
  const out = drive(state, c)!;
  assert.ok(out.launch);
  assert.equal(out.launch.ref.card, 1);
  assert.equal(out.launch.settings.cwd, "C:/repo");
  assert.equal(out.launch.settings.worktree, true);
  assert.equal(out.launch.settings.approval, "auto");
  assert.equal(out.launch.run.tag, "worker:w_op");
  assert.match(out.launch.prompt, /Your card: #1 One/);
  assert.match(out.launch.prompt, /Your other ready cards when this chat started: #2 Two\./);
  const next = apply(state, out);
  assert.equal((worker(next).step as { token: string }).token, out.launch.ref.token);
  // Leased: the next pass leaves it alone, as an older board window's worker_step would.
  assert.equal(drive(next, c), null);
  assert.throws(() => kanbanActions.actions.worker_step.run(next, { worker: "w_op", from: null, token: "other" }, { caller: { by: "user" }, now: 10_001, values: {} }), /another window/);

  const done = applyStateOps(next, kanbanActions.launched!(next, out.launch, { threadId: "th_1" }, 11_000)!.ops);
  assert.equal(worker(done).threadId, "th_1");
  assert.equal(worker(done).step, undefined);
  assert.deepEqual(worker(done).run, { since: 5, card: 1, startedAt: 10_000 });
  assert.equal(card(done, 1).col, "work");
  assert.equal((card(done, 1).claim as { thread: string }).thread, "th_1");
  assert.equal(log(done).at(-1)!.kind, "launch");
});

test("a worker waits without a step when nothing is ready, and a failed launch pauses it", () => {
  const { c } = ctx();
  const idle = board({ run: { since: 5 } }, { cards: [] });
  assert.equal(drive(idle, c), null);

  const state = board({ run: { since: 5 } });
  const out = drive(state, c)!;
  const next = apply(state, out);
  const failed = applyStateOps(next, kanbanActions.launched!(next, out.launch!, { error: "Check the worker's setup: unknown model x." }, 11_000)!.ops);
  assert.equal(worker(failed).run, undefined);
  assert.equal(worker(failed).error, "Check the worker's setup: unknown model x.");
  assert.equal(log(failed).at(-1)!.kind, "pause");
});

test("a returned card continues its previous worker chat and is claimed under the normal lease", () => {
  const state = board({ run: { since: 5 } });
  Object.assign(card(state, 1), { thread: "old", threadAssignee: "opus" });
  const { c } = ctx({ old: ended({ kind: "done", merged: true }) });
  const out = drive(state, c)!;
  assert.equal(out.launch?.resumeThread, "old");
  assert.match(out.launch!.prompt, /Continue the work on card #1/);
  assert.match(out.launch!.prompt, /Get the card again and read it in full/);
  const leased = apply(state, out);
  assert.equal(drive(leased, c), null);
  const next = applyStateOps(leased, kanbanActions.launched!(leased, out.launch!, { threadId: "old" }, 11_000)!.ops);
  assert.equal(worker(next).threadId, "old");
  assert.equal(card(next, 1).col, "work");
  assert.equal((card(next, 1).claim as { thread: string }).thread, "old");
  assert.equal(log(next).at(-1)!.kind, "resume");
});

test("reassigned, unknown-owner and deleted chats start fresh", () => {
  for (const owner of ["Other", undefined, "Opus"]) {
    const state = board({ run: { since: 5 } });
    Object.assign(card(state, 1), { thread: "old", threadAssignee: owner });
    const { c } = ctx(owner === "Opus" ? {} : { old: ended({ kind: "done" }) });
    assert.equal(drive(state, c)!.launch?.resumeThread, undefined);
  }
});

test("a returned card does not duplicate a busy previous chat or bypass scheduling gates", () => {
  for (const info of [ended({ kind: "done" }, { running: true }), ended({ kind: "done" }, { run: { phase: "waiting" } })]) {
    const state = board({ run: { since: 5 } });
    Object.assign(card(state, 1), { thread: "old", threadAssignee: "Opus" });
    assert.equal(drive(state, ctx({ old: info as ThreadRunInfo }).c), null);
  }
  const state = board({ run: { since: 5 } });
  Object.assign(card(state, 1), { thread: "old", threadAssignee: "Opus", blockedBy: ["c2"] });
  assert.equal(drive(state, ctx({ old: ended({ kind: "done" }) }).c)!.launch?.ref.card, 2);
  const paused = board({ run: { since: 5 } }, { columns: [{ id: "ready", role: "agent", paused: true }] });
  Object.assign(card(paused, 1), { thread: "old", threadAssignee: "Opus" });
  assert.equal(drive(paused, ctx({ old: ended({ kind: "done" }) }).c), null);
});

test("without the board's permission to start chats on its own, the worker pauses with why", () => {
  const { c } = ctx({}, { mayStart: () => "Scribe needs this board's permission" });
  const next = apply(board({ run: { since: 5 } }), drive(board({ run: { since: 5 } }), c));
  assert.equal(worker(next).run, undefined);
  assert.match(String(worker(next).error), /permission/);
});

test("a merged chat is wrapped up, released, and the next card starts in the same pass", () => {
  const state = board({ run: { since: 5, card: 1, startedAt: 100 }, threadId: "th_1" });
  card(state, 1).col = "rev";
  card(state, 1).thread = "th_1";
  const { c, released } = ctx({ th_1: ended({ kind: "done", merged: true }, { usage: { turns: 3, inputTokens: 1000, outputTokens: 50 } }) });
  const out = drive(state, c)!;
  assert.deepEqual(released, ["th_1"]);
  assert.equal(out.launch?.ref.card, 2);
  const next = apply(state, out);
  assert.equal(worker(next).threadId, undefined);
  assert.match(log(next).find((l) => l.kind === "merge")!.text, /^Merged #1 · 1k in · 50 out · 3 rounds$/);
  assert.equal((card(next, 1).usage as { turns: number }).turns, 3);
});

test("a chat that ended still holding its card leaves it blocked and goes on with the next", () => {
  const state = board({ run: { since: 5, card: 1, startedAt: 100 }, threadId: "th_1" });
  Object.assign(card(state, 1), { col: "work", thread: "th_1", claim: { holder: "Opus", thread: "th_1", at: 100, from: "ready" } });
  const { c } = ctx({ th_1: ended({ kind: "done", held: "it still holds #1" }) });
  const out = drive(state, c)!;
  assert.equal(out.launch?.ref.card, 2);
  const next = apply(state, out);
  assert.equal(card(next, 1).col, "ready");
  assert.equal(card(next, 1).claim, undefined);
  assert.deepEqual(card(next, 1).status, { kind: "blocked", text: "Agent didn't finish" });
  assert.equal(worker(next).fails, 1);
  // Blocked cards go on top of their ready column.
  assert.deepEqual((next.cards as Card[]).filter((x) => x.col === "ready").map((x) => x.num), [1, 2, 3]);
});

test("three failed chats in a row pause the worker", () => {
  const state = board({ run: { since: 5, card: 1, startedAt: 100 }, threadId: "th_1", fails: 2 });
  Object.assign(card(state, 1), { col: "work", thread: "th_1", claim: { holder: "Opus", thread: "th_1", at: 100 } });
  const { c } = ctx({ th_1: ended({ kind: "failed", error: "boom" }) });
  const out = drive(state, c)!;
  assert.equal(out.launch, undefined);
  const next = apply(state, out);
  assert.equal(worker(next).run, undefined);
  assert.match(String(worker(next).error), /^3 cards in a row didn't get done/);
});

test("a merge no agent can fix pauses the worker and keeps its chat for the next start", () => {
  const state = board({ run: { since: 5, card: 1, startedAt: 100 }, threadId: "th_1" });
  Object.assign(card(state, 1), { col: "rev", thread: "th_1" });
  const { c, watched } = ctx({ th_1: ended({ kind: "merge_failed", fixable: false, message: "The main checkout is on another branch." }) });
  const next = apply(state, drive(state, c));
  assert.equal(worker(next).run, undefined);
  assert.equal(worker(next).merge, "th_1");
  assert.deepEqual(worker(next).mergeCards, ["c1"]);
  assert.equal(card(next, 1).col, "ready");

  // ▶ again: Scribe takes the chat back to merge it, before any new card.
  const started = applyStateOps(next, kanbanActions.actions.worker_start.run(next, { worker: "w_op" }, { caller: { by: "user" }, now: 12_000, values: {} }).ops);
  const idle: ThreadRunInfo = { exists: true, running: false, title: "chat", lastTurn: { status: "done" } };
  const again = ctx({ th_1: idle });
  const out = drive(started, again.c)!;
  assert.equal(again.watched[0].thread, "th_1");
  assert.equal(out.launch, undefined);
  assert.equal(worker(apply(started, out)).merge, undefined);
  assert.equal(watched.length, 0);
});

test("stop after this card ends the run once the chat is wrapped up", () => {
  const state = board({ run: { since: 5, card: 1, startedAt: 100 }, threadId: "th_1", stop: true });
  Object.assign(card(state, 1), { col: "rev", thread: "th_1" });
  const { c } = ctx({ th_1: ended({ kind: "done", merged: true }) });
  const out = drive(state, c)!;
  assert.equal(out.launch, undefined);
  const next = apply(state, out);
  assert.equal(worker(next).run, undefined);
  assert.equal(log(next).at(-1)!.kind, "stop");
});

test("a running chat or a limit wait is left alone", () => {
  const state = board({ run: { since: 5, card: 1, startedAt: 100 }, threadId: "th_1" });
  const running = ctx({ th_1: { exists: true, running: true, title: "chat", run: { phase: "running", fixes: 0, createdAt: 1, merge: true } } });
  assert.equal(drive(state, running.c), null);
  const waiting = ctx({ th_1: { exists: true, running: false, title: "chat", run: { phase: "waiting", fixes: 0, createdAt: 1, merge: true, wait: { until: 99_999, count: 1 } } } });
  assert.equal(drive(state, waiting.c), null);
});

test("max parallel workers holds a second worker back while the first starts", () => {
  const state = board({ run: { since: 5 } });
  const settings = state.settings as State;
  settings.maxWorkers = 1;
  (settings.workers as State).w_two = { name: "Someone", mode: "ask", run: { since: 5 } };
  const { c } = ctx();
  const first = drive(state, c)!;
  assert.equal(first.launch?.ref.worker, "w_op");
  assert.equal(drive(apply(state, first), c), null);
});

function queuedPair(firstProvider?: string, secondProvider?: string, settings: State = {}): State {
  const state = board({ provider: firstProvider, run: { since: 5 } });
  Object.assign(state.settings as State, settings);
  ((state.settings as State).workers as State).w_two = { name: "Someone", mode: "ask", provider: secondProvider, run: { since: 5 } };
  return state;
}

test("provider limit defaults to one across different workers, including launch leases", () => {
  const { c } = ctx();
  const state = queuedPair("codex", "codex");
  const first = drive(state, c)!;
  assert.equal(first.launch?.ref.worker, "w_op");
  const starting = apply(state, first);
  assert.equal(drive(starting, c), null);
  const started = applyStateOps(starting, kanbanActions.launched!(starting, first.launch!, { threadId: "th_1" }, c.now)!.ops);
  const running = ctx({ th_1: { exists: true, running: true, title: "First" } }).c;
  assert.equal(drive(started, running), null);
  // Finishing the first chat frees the provider slot for the other worker.
  Object.assign(card(started, 1), { col: "rev", claim: undefined });
  Object.assign(card(started, 2), { col: "rev" });
  const finished = ctx({ th_1: ended({ kind: "done" }) }).c;
  const wrapped = apply(started, drive(started, finished));
  assert.equal(drive(wrapped, finished)?.launch?.ref.worker, "w_two");
});

test("different providers run together unless the total limit is reached", () => {
  const { c } = ctx();
  for (const total of [0, 1]) {
    const state = queuedPair("codex", "claude", { maxWorkers: total });
    const starting = apply(state, drive(state, c));
    assert.equal(drive(starting, c)?.launch?.ref.worker, total ? undefined : "w_two");
  }
});

test("provider limit can be raised or disabled, independently of the total limit", () => {
  const { c } = ctx();
  for (const perProvider of [0, 2]) {
    const state = queuedPair("codex", "codex", { maxWorkersPerProvider: perProvider });
    const starting = apply(state, drive(state, c));
    assert.equal(drive(starting, c)?.launch?.ref.worker, "w_two");
  }
});

test("implicit provider shares the slot with the resolved board default", () => {
  const { c } = ctx({}, { defaultProvider: "codex" });
  for (const providers of [[undefined, "codex"], ["codex", undefined]]) {
    const state = queuedPair(...providers);
    assert.equal(drive(apply(state, drive(state, c)), c), null);
  }
});

test("expired launch leases do not occupy provider slots", () => {
  const state = queuedPair("codex", "codex");
  Object.assign(worker(state), { step: { token: "old", at: 1 } });
  Object.assign(card(state, 1), { col: "rev" });
  Object.assign(card(state, 2), { col: "rev" });
  const { c } = ctx({}, { now: 1_000_000 });
  assert.equal(drive(state, c)?.launch?.ref.worker, "w_two");
});

test("an ended one-card run is wrapped up and forgotten, and the worker's own queue is untouched", () => {
  const state = board({ solo: { th_s: { card: 3, at: 50 } } });
  Object.assign(card(state, 3), { col: "rev", thread: "th_s" });
  const { c, released } = ctx({ th_s: ended({ kind: "done", merged: true }) });
  const out = drive(state, c)!;
  assert.deepEqual(released, ["th_s"]);
  const next = apply(state, out);
  assert.equal(worker(next).solo, undefined);
  assert.equal(log(next).at(-1)!.text, "Merged one-card run #3");
  assert.equal(drive(next, c), null);
});

test("a chat that started after the worker was stopped is wrapped up as a one-card run", () => {
  const state = board({ run: { since: 5 } });
  const { c } = ctx();
  const out = drive(state, c)!;
  const stopped = applyStateOps(apply(state, out), [{ op: "merge", path: "settings/workers/w_op", value: { run: null, step: null } }]);
  const next = applyStateOps(stopped, kanbanActions.launched!(stopped, out.launch!, { threadId: "th_9" }, 11_000)!.ops);
  assert.equal(worker(next).threadId, undefined);
  assert.deepEqual(worker(next).solo, { th_9: { card: 1, at: 11_000 } });
});

test("worker_start is the page's, needs a ready worker, and logs the start", () => {
  const user = { caller: { by: "user" as const }, now: 1, values: {} };
  assert.throws(() => kanbanActions.actions.worker_start.run(board(), { worker: "w_op" }, { ...user, caller: { by: "agent" } }), /board page itself/);
  assert.throws(() => kanbanActions.actions.worker_start.run(board({ cwd: "" }), { worker: "w_op" }, user), /needs a folder/);
  assert.throws(() => kanbanActions.actions.worker_start.run(board({ run: { since: 1 } }), { worker: "w_op" }, user), /already running/);
  const next = applyStateOps(board(), kanbanActions.actions.worker_start.run(board(), { worker: "w_op" }, user).ops);
  assert.deepEqual(worker(next).run, { since: 1 });
  assert.equal(log(next)[0].text, "Started");
});
