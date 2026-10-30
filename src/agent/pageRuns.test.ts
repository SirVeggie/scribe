import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPACITY_RETRY_MS, MAX_LIMIT_WAITS, MAX_MERGE_FIXES, MAX_RESUME_TRIES, NO_TURN_MS, PageRuns, RESUME_DELAY_MS, runView, type PageRun, type RunDeps, type RunNote } from "./pageRuns.js";
import type { Turn } from "./types.js";
import { usageLimitResetsAt, UNKNOWN_RESET_RETRY_MS } from "./planLimits.js";

/** A thread whose turns the test sets, and a record of what the runs did with it. */
function harness(opts: { worktree?: boolean } = {}) {
  const state = {
    now: 1_000_000,
    idle: true,
    exists: true,
    turns: [] as Turn[],
    recovery: true,
    worktree: opts.worktree ?? true,
    hold: null as string | null,
    sendFails: null as string | null,
    mergeFails: [] as string[],
    sent: [] as string[],
    merges: 0,
    notes: [] as RunNote[],
    saved: [] as PageRun[],
  };
  let seq = 0;
  const deps: RunDeps = {
    now: () => state.now,
    idle: () => state.idle,
    exists: () => state.exists,
    lastTurn: () => state.turns.at(-1),
    recoveryAllowed: () => state.recovery,
    hasWorktree: () => state.worktree,
    hold: () => state.hold,
    send: (_id, text) => {
      if (state.sendFails) throw new Error(state.sendFails);
      state.sent.push(text);
    },
    merge: async () => {
      const fail = state.mergeFails.shift();
      if (fail) throw new Error(fail);
      state.merges++;
      state.worktree = false;
      return "Merged 1 commit from b into main.";
    },
    save: (runs) => (state.saved = runs),
    changed: (_run, note) => {
      if (note) state.notes.push(note);
    },
  };
  const turn = (patch: Partial<Turn>): Turn => {
    const t = { id: `t${++seq}`, threadId: "th", seq, status: "done", model: "m", effort: null, mode: "code", startedAt: state.now, endedAt: state.now, ...patch } as Turn;
    state.turns.push(t);
    return t;
  };
  const runs = new PageRuns(deps);
  return { state, deps, runs, turn };
}

test("a done turn merges the branch and ends the run", async () => {
  const { state, runs, turn } = harness();
  runs.register("th", "page1", { tag: "worker:w1", data: { worker: "w1", card: 12 } });
  turn({});
  await runs.check("th");
  const run = runs.get("th")!;
  assert.equal(run.phase, "ended");
  assert.deepEqual(run.outcome, { kind: "done", merged: true, message: "Merged 1 commit from b into main." });
  assert.equal(state.merges, 1);
  assert.deepEqual(run.data, { worker: "w1", card: 12 });
  assert.equal(state.notes.at(-1)?.kind, "end");
  assert.equal(state.saved.length, 1);
});

test("turns from before the run was handed over don't count", async () => {
  const { state, runs, turn } = harness();
  turn({ startedAt: state.now - 5000 });
  runs.register("th", "page1", {});
  await runs.check("th");
  assert.equal(runs.get("th")!.phase, "running");
  state.now += NO_TURN_MS + 1;
  await runs.check("th");
  assert.equal(runs.get("th")!.outcome?.kind, "failed");
});

test("after: 0 takes the thread as it is", async () => {
  const { state, runs, turn } = harness();
  turn({ startedAt: state.now - 5000 });
  runs.register("th", "page1", { after: 0 });
  await runs.check("th");
  assert.equal(runs.get("th")!.outcome?.kind, "done");
});

test("nothing happens while the thread is busy", async () => {
  const { state, runs, turn } = harness();
  runs.register("th", "page1", {});
  turn({});
  state.idle = false;
  await runs.check("th");
  assert.equal(runs.get("th")!.phase, "running");
  assert.equal(state.merges, 0);
});

test("a plan limit moves the chat to another account with room right away (#920)", async () => {
  const { state, deps, runs, turn } = harness();
  let room = true;
  deps.switchAccount = () => (room ? "b@example.org" : null);
  runs.register("th", "page1", {});
  turn({ status: "error", error: "usage limit", limitResetsAt: state.now + 3_600_000 });
  await runs.check("th");
  let run = runs.get("th")!;
  assert.equal(run.phase, "running");
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0], /another Claude account/);
  assert.equal(state.notes.at(-1)?.kind, "resume");
  await runs.check("th");
  assert.equal(state.sent.length, 1, "the same limit turn moves it once");
  // The other account runs out too and none is left: wait for the reset.
  room = false;
  state.now += 1000;
  turn({ status: "error", error: "usage limit", limitResetsAt: state.now + 3_600_000 });
  await runs.check("th");
  run = runs.get("th")!;
  assert.equal(run.phase, "waiting");
  assert.equal(run.wait?.count, 2);
  // An account frees up during the wait: it goes on there before the reset.
  room = true;
  await runs.check("th");
  run = runs.get("th")!;
  assert.equal(run.phase, "running");
  assert.equal(state.sent.length, 2);
});

test("a plan limit waits for the reset, then for the provider's confirmation, then sends the chat on", async () => {
  const { state, runs, turn } = harness();
  runs.register("th", "page1", { resumePrompt: "Go on with #12." });
  const resetsAt = state.now + 3_600_000;
  turn({ status: "error", error: "usage limit", limitResetsAt: resetsAt });
  await runs.check("th");
  let run = runs.get("th")!;
  assert.equal(run.phase, "waiting");
  assert.equal(run.wait?.until, resetsAt + RESUME_DELAY_MS);
  assert.equal(state.notes.at(-1)?.kind, "limit");
  // Checking again before the reset changes nothing, and the same limit turn isn't counted twice.
  await runs.check("th");
  assert.equal(runs.get("th")!.wait?.count, 1);
  state.now = resetsAt + RESUME_DELAY_MS;
  state.recovery = false;
  await runs.check("th");
  run = runs.get("th")!;
  assert.equal(run.phase, "waiting");
  assert.equal(run.wait?.tries, undefined, "an unconfirmed reset doesn't use up a try");
  assert.deepEqual(state.sent, []);
  state.recovery = true;
  state.now = run.wait!.until;
  await runs.check("th");
  run = runs.get("th")!;
  assert.equal(run.phase, "running");
  assert.deepEqual(state.sent, ["Go on with #12."]);
  // The resumed turn finishes: merged.
  state.now += 1000;
  turn({});
  await runs.check("th");
  assert.equal(runs.get("th")!.outcome?.kind, "done");
});

test("Claude's session limit keeps the run waiting and resumes the same chat (#701)", async () => {
  const { state, runs, turn } = harness();
  runs.register("th", "page1", { tag: "worker:w1", data: { worker: "w1", card: 12 }, resumePrompt: "Go on with #12." });
  const error = "You've hit your session limit · resets 9am (Europe/Helsinki)";
  // The host derives this field from the provider's error, even without a quota report.
  turn({ status: "error", error, limitResetsAt: usageLimitResetsAt(error, undefined, state.now, state.now) });
  await runs.check("th");
  const run = runs.get("th")!;
  assert.equal(run.phase, "waiting");
  assert.equal(run.outcome, undefined);
  assert.equal(run.wait?.until, state.now + UNKNOWN_RESET_RETRY_MS + RESUME_DELAY_MS);
  assert.equal(state.merges, 0);
  assert.deepEqual(state.sent, []);
  state.now = run.wait!.until;
  await runs.check("th");
  assert.equal(run.phase, "running");
  assert.deepEqual(state.sent, ["Go on with #12."]);
  state.now += 1000;
  turn({});
  await runs.check("th");
  assert.equal(runs.get("th")?.outcome?.kind, "done");
});

test("model capacity waits ten minutes, survives restart, and resumes without quota confirmation", async () => {
  const { state, deps, runs, turn } = harness();
  runs.register("th", "page1", { resumePrompt: "Your plan's usage limit has reset. Get card #749 again before continuing." });
  turn({ status: "error", error: "Selected model is at capacity. Please try a different model." });
  await runs.check("th");
  const until = state.now + CAPACITY_RETRY_MS;
  assert.equal(runs.get("th")!.wait?.until, until);
  assert.equal(runView(runs.get("th")!).wait?.reason, "capacity");
  const restored = new PageRuns(deps, state.saved);
  state.recovery = false;
  state.now = until - 1;
  await restored.check("th");
  assert.deepEqual(state.sent, []);
  assert.equal(state.merges, 0);
  state.now = until;
  await restored.check("th");
  assert.equal(restored.get("th")!.phase, "running");
  assert.deepEqual(state.sent, ["Retrying after waiting for model capacity. Get card #749 again before continuing."]);
  state.now += 1;
  turn({});
  await restored.check("th");
  assert.equal(restored.get("th")!.outcome?.kind, "done");
});

test("repeated model capacity errors have a bounded number of retries", async () => {
  const { state, runs, turn } = harness();
  runs.register("th", "page1", {});
  for (let i = 0; i < MAX_LIMIT_WAITS; i++) {
    turn({ status: "error", error: "Model is at capacity, try another model" });
    await runs.check("th");
    await runs.check("th");
    assert.equal(runs.get("th")!.wait?.count, i + 1);
    state.now = runs.get("th")!.wait!.until;
    await runs.check("th");
    state.now += 1;
  }
  turn({ status: "error", error: "Model is at capacity" });
  await runs.check("th");
  assert.equal(runs.get("th")!.outcome?.kind, "limit");
  assert.match(runs.get("th")!.outcome!.error!, /model capacity/);
});

test("failed sends after a reset back off, then end the run", async () => {
  const { state, runs, turn } = harness();
  runs.register("th", "page1", {});
  turn({ status: "error", limitResetsAt: state.now });
  await runs.check("th");
  state.sendFails = "Scribe is starting";
  for (let i = 0; i < MAX_RESUME_TRIES; i++) {
    state.now = runs.get("th")!.wait!.until;
    await runs.check("th");
    assert.equal(runs.get("th")!.phase, "waiting");
    assert.equal(runs.get("th")!.wait?.tries, i + 1);
  }
  state.now = runs.get("th")!.wait!.until;
  await runs.check("th");
  const run = runs.get("th")!;
  assert.equal(run.outcome?.kind, "failed");
  assert.match(run.outcome?.error ?? "", /Could not send the agent on/);
});

test("a run that keeps hitting its limit ends with outcome limit", async () => {
  const { state, runs, turn } = harness();
  runs.register("th", "page1", {});
  for (let i = 0; i < MAX_LIMIT_WAITS; i++) {
    turn({ status: "error", limitResetsAt: state.now });
    await runs.check("th");
    state.now = runs.get("th")!.wait!.until;
    await runs.check("th");
    state.now += 1000;
  }
  turn({ status: "error", limitResetsAt: state.now });
  await runs.check("th");
  assert.equal(runs.get("th")!.outcome?.kind, "limit");
});

test("failed and stopped turns end the run without a merge", async () => {
  for (const status of ["error", "cancelled"] as const) {
    const { state, runs, turn } = harness();
    runs.register("th", "page1", {});
    turn({ status, error: status === "error" ? "boom" : undefined });
    await runs.check("th");
    assert.equal(runs.get("th")!.outcome?.kind, status === "error" ? "failed" : "cancelled");
    assert.equal(state.merges, 0);
  }
});

test("the page can hold a merge, and merge: false or no worktree skips it", async () => {
  {
    const { state, runs, turn } = harness();
    state.hold = "it still holds #12";
    runs.register("th", "page1", {});
    turn({});
    await runs.check("th");
    assert.deepEqual(runs.get("th")!.outcome, { kind: "done", merged: false, held: "it still holds #12" });
    assert.equal(state.merges, 0);
  }
  {
    const { state, runs, turn } = harness();
    runs.register("th", "page1", { merge: false });
    turn({});
    await runs.check("th");
    assert.deepEqual(runs.get("th")!.outcome, { kind: "done" });
    assert.equal(state.merges, 0);
  }
  {
    const { state, runs, turn } = harness({ worktree: false });
    runs.register("th", "page1", {});
    turn({});
    await runs.check("th");
    assert.deepEqual(runs.get("th")!.outcome, { kind: "done" });
    assert.equal(state.merges, 0);
  }
});

test("a branch that won't merge goes back to the agent, then ends merge_failed", async () => {
  const { state, runs, turn } = harness();
  state.mergeFails = Array(MAX_MERGE_FIXES + 1).fill("CONFLICT in src/a.ts");
  runs.register("th", "page1", {});
  turn({});
  for (let i = 0; i < MAX_MERGE_FIXES; i++) {
    await runs.check("th");
    assert.equal(runs.get("th")!.fixes, i + 1);
    assert.match(state.sent.at(-1) ?? "", /could not merge your branch: CONFLICT/);
    state.now += 1000;
    turn({});
  }
  await runs.check("th");
  assert.deepEqual(runs.get("th")!.outcome, { kind: "merge_failed", message: "CONFLICT in src/a.ts", fixable: true });
});

test("a merge no agent can fix ends at once", async () => {
  const { state, runs, turn } = harness();
  state.mergeFails = ["The main checkout is on feature-x, not main."];
  runs.register("th", "page1", {});
  turn({});
  await runs.check("th");
  assert.equal(runs.get("th")!.outcome?.fixable, false);
  assert.deepEqual(state.sent, []);
});

test("a merge fixed by the agent ends done", async () => {
  const { state, runs, turn } = harness();
  state.mergeFails = ["CONFLICT"];
  runs.register("th", "page1", {});
  turn({});
  await runs.check("th");
  state.now += 1000;
  turn({});
  await runs.check("th");
  const run = runs.get("th")!;
  assert.equal(run.outcome?.kind, "done");
  assert.equal(run.fixes, 1);
});

test("a fix turn that starts inside send counts, even when the clock moved on while sending (#319)", async () => {
  const { state, deps, runs, turn } = harness();
  state.mergeFails = ["CONFLICT"];
  const send = deps.send;
  deps.send = (id, text) => {
    send(id, text);
    turn({ status: "running", endedAt: undefined });
    state.now += 5;
  };
  runs.register("th", "page1", {});
  turn({});
  await runs.check("th");
  state.turns.at(-1)!.status = "done";
  state.now += NO_TURN_MS + 1;
  await runs.check("th");
  assert.equal(runs.get("th")!.outcome?.kind, "done");
  assert.equal(state.merges, 1);
});

test("release forgets the run; a deleted chat ends it", async () => {
  const { state, runs } = harness();
  runs.register("th", "page1", {});
  assert.equal(runs.release("th"), true);
  assert.equal(runs.get("th"), undefined);
  runs.register("th", "page1", {});
  state.exists = false;
  await runs.check("th");
  assert.equal(runs.get("th")!.outcome?.kind, "failed");
});

test("saved runs come back after a restart", async () => {
  const first = harness();
  first.runs.register("th", "page1", { tag: "x" });
  const again = new PageRuns(first.deps, first.state.saved);
  assert.equal(again.get("th")?.tag, "x");
});

test("run data must stay small", () => {
  const { runs } = harness();
  assert.throws(() => runs.register("th", "page1", { data: { big: "x".repeat(5000) } }), /4000/);
});
