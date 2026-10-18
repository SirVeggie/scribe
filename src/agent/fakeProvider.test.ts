import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionCaller } from "../actions/types.js";
import { FakeProvider, fakePlan } from "./providers/fake.js";
import type { RunSink, SessionContext } from "./providers/provider.js";
import type { Thread } from "./types.js";

const WORKER = 'You are the agent worker "Fake" on the Kanban board "Test" (Scribe page id t_abc123). ...\nYour card: #12 Fix login [fake:delay=5, nofinish]';

test("fakePlan reads the worker prompt and directives", () => {
  assert.deepEqual(fakePlan(WORKER), { delayMs: 5, error: false, hang: false, finish: false, commit: false, limitSec: 0, stream: 0, helpers: 0, commands: [], board: { page: "t_abc123", card: 12 } });
  const plain = fakePlan("hello [fake:error]", 100);
  assert.equal(plain.delayMs, 100);
  assert.equal(plain.error, true);
  assert.equal(plain.board, null);
  assert.equal(fakePlan("[fake:stream]").stream, 12);
  assert.equal(fakePlan("[fake:stream=3, delay=0]").stream, 3);
  assert.equal(fakePlan("[fake:limit=5]").limitSec, 5);
  assert.equal(fakePlan("[fake:limit]").limitSec, 30);
  assert.equal(fakePlan("[fake:helper=10]").helpers, 10);
  assert.equal(fakePlan("[fake:helper=11]").helpers, 10);
});

function sink(): RunSink & { texts: string[] } {
  const texts: string[] = [];
  const noop = () => {};
  return {
    texts,
    nativeId: noop,
    text: (delta) => texts.push(delta),
    reasoning: noop,
    breakBlock: noop,
    toolStart: noop,
    toolUpdate: noop,
    beforeWrite: async () => {},
    approval: async () => ({ optionId: "deny" }),
    question: async () => ({ skipped: true }),
    todos: noop,
    usage: noop,
    notice: noop,
    commands: noop,
    title: noop,
  };
}

function setup() {
  const calls: Array<{ page: string; name: string; args: Record<string, unknown>; caller: ActionCaller }> = [];
  const provider = new FakeProvider("cursor", "Cursor", {
    runAction: (page, name, args, caller) => calls.push({ page, name, args, caller }),
    runInfo: () => ({ exists: false }),
    delayMs: 5,
  });
  const thread = { id: "th1", title: "Worker", provider: "cursor" } as Thread;
  const session = provider.createSession(thread, {} as SessionContext);
  return { calls, session };
}

test("a fake worker turn claims and finishes its card as its thread", async () => {
  const { calls, session } = setup();
  const result = await session.run({ text: WORKER.replace("nofinish", ""), images: [], documents: [], instructions: "" }, sink());
  assert.deepEqual(result, { status: "done" });
  assert.deepEqual(
    calls.map((c) => [c.page, c.name, c.args.card]),
    [
      ["t_abc123", "claim", 12],
      ["t_abc123", "finish", 12],
    ]
  );
  assert.equal(calls[0].caller.thread, "th1");
  assert.equal(calls[0].caller.by, "agent");
});

test("directives: nofinish leaves the claim, error fails the turn, hang waits for cancel", async () => {
  const { calls, session } = setup();
  await session.run({ text: WORKER, images: [], documents: [], instructions: "" }, sink());
  assert.deepEqual(calls.map((c) => c.name), ["claim"]);

  const failed = await session.run({ text: "[fake:error]", images: [], documents: [], instructions: "" }, sink());
  assert.equal(failed.status, "error");

  const hanging = session.run({ text: "[fake:hang]", images: [], documents: [], instructions: "" }, sink());
  setTimeout(() => void session.cancel(), 10);
  assert.deepEqual(await hanging, { status: "cancelled" });
});
