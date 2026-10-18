import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { RunSink, TurnInput, TurnResult } from "./providers/provider.js";
import type { Thread } from "./types.js";

// The host keeps its data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-plan-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;

/** Each turn as the provider session saw it: the thread's mode and rung then, and the message. */
const runs: Array<{ threadId: string; mode: string; approval: string; text: string }> = [];
/** What the next turn does before it ends; by default it answers with one line. */
let script: (threadId: string, sink: RunSink) => Promise<void> = async (_id, sink) => sink.text("ok");

before(() => {
  store.load();
  host = new AgentHost(() => {});
  (host as unknown as { providers: Record<string, unknown> }).providers.pi = {
    id: "pi",
    label: "Native",
    status: async () => ({ id: "pi", label: "Native", available: true }),
    models: async () => [],
    complete: async () => "",
    prewarm: () => {},
    dispose: () => {},
    createSession: (created: Thread) => {
      let thread = created;
      return {
        warm: async () => {},
        update: (next: Thread) => { thread = next; },
        commands: async () => [],
        dispose: () => {},
        cancel: async () => {},
        run: async (input: TurnInput, sink: RunSink): Promise<TurnResult> => {
          runs.push({ threadId: thread.id, mode: thread.mode, approval: thread.approval, text: input.text });
          const next = script;
          script = async (_id, s) => s.text("ok");
          await next(thread.id, sink);
          return { status: "done" };
        },
      };
    },
  };
});

after(() => {
  host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "timed out");
}

const turnsOf = (threadId: string) => runs.filter((r) => r.threadId === threadId);
const idle = (threadId: string) => host.listThreads().find((t) => t.id === threadId)?.status === "idle";

test("/plan runs one turn at Board, and accepting on the plan page implements it at the thread's rung", async () => {
  const thread = host.createThread({ provider: "pi", approval: "full", cwd: dir, scope: { kind: "global", ref: null } });
  store.upsert({ key: "plan-a", title: "Plan", html: "<p>plan</p>" });
  script = async (threadId) => {
    setTimeout(() => store.logEvent("plan-a", { name: "accept", data: { notes: "keep it small" }, by: "user" }), 10);
    const answer = await host.askPage(threadId, { page: "plan-a", events: ["accept", "reject"], timeoutMs: 5000, signal: new AbortController().signal });
    assert.ok("answered" in answer && answer.answered);
  };
  host.send(thread.id, { text: "/plan add a login form" });
  await until(() => turnsOf(thread.id).length === 2 && idle(thread.id));
  const [plan, build] = turnsOf(thread.id);
  assert.deepEqual([plan.mode, plan.approval], ["board", "board"]);
  assert.match(plan.text, /<plan_turn>/);
  assert.match(plan.text, /page_ask/);
  assert.match(plan.text, /add a login form/);
  assert.ok(plan.text.endsWith("</plan_turn>\n\nadd a login form"));
  assert.deepEqual([build.mode, build.approval], ["code", "full"]);
  assert.match(build.text, /Implement the plan\./);
  assert.match(build.text, /keep it small/);
  assert.match(build.text, /scribe:plan-a/);
  assert.doesNotMatch(build.text, /<plan_turn>/);
  const detail = host.threadDetail(thread.id)!;
  const users = detail.items.filter((it) => it.kind === "user");
  assert.deepEqual(users.map((it) => it.kind === "user" && Boolean(it.plan)), [true, false]);
  assert.deepEqual(detail.turns.map((t) => Boolean(t.plan)), [true, false]);
});

test("a rejected plan page ends the plan turn without implementing", async () => {
  const thread = host.createThread({ provider: "pi", approval: "edits", cwd: dir, scope: { kind: "global", ref: null } });
  store.upsert({ key: "plan-b", title: "Plan", html: "<p>plan</p>" });
  script = async (threadId) => {
    setTimeout(() => store.logEvent("plan-b", { name: "reject", data: {}, by: "user" }), 10);
    await host.askPage(threadId, { page: "plan-b", events: ["accept", "reject"], timeoutMs: 5000, signal: new AbortController().signal });
  };
  host.send(thread.id, { text: "tidy up", plan: true });
  await until(() => turnsOf(thread.id).length === 1 && idle(thread.id));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(turnsOf(thread.id).length, 1);
  assert.equal(host.threadDetail(thread.id)!.items.some((it) => it.kind === "plan"), false);
});

test("on Read-only the plan comes back in the chat, and accepting it sends the implementation turn", async () => {
  const thread = host.createThread({ provider: "pi", approval: "readonly", cwd: dir, scope: { kind: "global", ref: null } });
  script = async (_id, sink) => sink.text("1. Do the thing");
  host.send(thread.id, { text: "fix the bug", plan: true });
  await until(() => turnsOf(thread.id).length === 1 && idle(thread.id));
  assert.deepEqual([turnsOf(thread.id)[0].mode, turnsOf(thread.id)[0].approval], ["board", "readonly"]);
  assert.match(turnsOf(thread.id)[0].text, /final message/);
  const plan = host.threadDetail(thread.id)!.items.find((it) => it.kind === "plan");
  assert.ok(plan && plan.kind === "plan");
  assert.equal(plan.status, "pending");
  assert.equal(plan.text, "1. Do the thing");
  assert.deepEqual(host.listThreads().find((t) => t.id === thread.id)?.asking, { kind: "plan", itemId: plan.id, title: "Plan" });

  host.resolvePlan(thread.id, plan.id, { accepted: true, note: "add a test" });
  await until(() => turnsOf(thread.id).length === 2 && idle(thread.id));
  assert.match(turnsOf(thread.id)[1].text, /Implement the plan\.[\s\S]*add a test/);
  const after = host.threadDetail(thread.id)!.items.find((it) => it.id === plan.id);
  assert.ok(after?.kind === "plan" && after.status === "accepted");
  assert.throws(() => host.resolvePlan(thread.id, plan.id, { accepted: true }), /no longer waiting/);
});

test("changes requested on a chat plan send a new plan turn with the note", async () => {
  const thread = host.createThread({ provider: "pi", approval: "edits", cwd: dir, scope: { kind: "workspace", ref: dir } });
  script = async (_id, sink) => sink.text("Plan v1");
  host.send(thread.id, { text: "refactor", plan: true });
  await until(() => turnsOf(thread.id).length === 1 && idle(thread.id));
  // Scope None: no pages, so the plan is the final message even above Board.
  assert.match(turnsOf(thread.id)[0].text, /final message/);
  const plan = host.threadDetail(thread.id)!.items.find((it) => it.kind === "plan")!;
  host.resolvePlan(thread.id, plan.id, { accepted: false, note: "smaller steps" });
  await until(() => turnsOf(thread.id).length === 2 && idle(thread.id));
  const again = turnsOf(thread.id)[1];
  assert.equal(again.mode, "board");
  assert.match(again.text, /<plan_turn>[\s\S]*smaller steps/);
});

test("a thread started in the old plan mode plans its first message only; plan: false drops that", async () => {
  const thread = host.createThread({ provider: "pi", mode: "plan" as never, approval: "edits", cwd: dir, planNext: true, scope: { kind: "global", ref: null } });
  assert.equal(thread.mode, "code");
  assert.equal(host.getThread(thread.id)?.planNext, true);
  host.send(thread.id, { text: "first" });
  await until(() => turnsOf(thread.id).length === 1 && idle(thread.id));
  assert.equal(turnsOf(thread.id)[0].mode, "board");
  assert.equal(host.getThread(thread.id)?.planNext, undefined);
  host.send(thread.id, { text: "second" });
  await until(() => turnsOf(thread.id).length === 2 && idle(thread.id));
  assert.equal(turnsOf(thread.id)[1].mode, "code");

  const other = host.createThread({ provider: "pi", approval: "edits", cwd: dir, planNext: true, scope: { kind: "global", ref: null } });
  host.send(other.id, { text: "just do it", plan: false });
  await until(() => turnsOf(other.id).length === 1 && idle(other.id));
  assert.equal(turnsOf(other.id)[0].mode, "code");
  assert.equal(host.getThread(other.id)?.planNext, undefined);
});
