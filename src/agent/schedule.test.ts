import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { threadInstructions } from "./prompt.js";
import { scheduleTime } from "./schedule.js";
import type { RunSink, TurnInput, TurnResult } from "./providers/provider.js";
import type { ApprovalPolicy, Thread } from "./types.js";

// The host keeps its data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-thread-schedule-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;
const a = path.join(dir, "a");
const b = path.join(dir, "b");
fs.mkdirSync(a);
fs.mkdirSync(b);

/** What each turn of the stub provider was sent, with the workspace its session had then. */
const turns: Array<{ id: string; cwd: string | null; text: string }> = [];
/** What the next turn does in place of a model: its thread_schedule call. */
let act: ((threadId: string) => Promise<unknown>) | null = null;

type Internals = { providers: Record<string, unknown>; runs: Map<string, unknown>; threads: Map<string, Thread> };

before(() => {
  store.load();
  host = new AgentHost(() => {});
  (host as unknown as Internals).providers.pi = {
    id: "pi",
    label: "Native",
    status: async () => ({ id: "pi", label: "Native", available: true }),
    models: async () => [{ id: "local/m", label: "M", provider: "pi", efforts: [], params: [] }],
    complete: async () => "",
    resolveModel: async () => null,
    prewarm: () => {},
    dispose: () => {},
    createSession: (thread: Thread) => {
      let current = thread;
      return {
        warm: async () => {},
        update: (next: Thread) => {
          current = next;
        },
        commands: async () => [],
        dispose: () => {},
        cancel: async () => {},
        run: async (input: TurnInput, sink: RunSink): Promise<TurnResult> => {
          turns.push({ id: current.id, cwd: current.cwd, text: input.text });
          const step = act;
          act = null;
          if (step) sink.text(JSON.stringify(await step(current.id)));
          return { status: "done" };
        },
      };
    },
  };
});

after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  host.dispose();
  store.closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // left for the OS to clean up
  }
});

function thread(approval: ApprovalPolicy = "edits", extra: Record<string, unknown> = {}): string {
  return host.createThread({ provider: "pi", mode: "code", approval, cwd: a, scope: { kind: "workspace", ref: a }, ...extra }).id;
}

const view = (id: string) => host.threadDetail(id)!;

async function idle(id: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    if (!(host as unknown as Internals).runs.has(id)) {
      // A continuation starts in the same tick as the turn's end; give it one more look.
      await new Promise((r) => setTimeout(r, 20));
      if (!(host as unknown as Internals).runs.has(id)) return;
    }
  }
  throw new Error("the turn did not end");
}

const mine = (id: string) => turns.filter((t) => t.id === id);
const raw = (id: string) => (host as unknown as Internals).threads.get(id)!;
const check = () => (host as unknown as { checkSchedules(): void }).checkSchedules();

test("times: minutes from now, a local time of day (the next one), or a date-time", () => {
  const now = new Date(2026, 10, 8, 17, 0).getTime();
  assert.equal(scheduleTime({ inMinutes: 90 }, now), now + 90 * 60_000);
  assert.equal(scheduleTime({ at: "18:30" }, now), new Date(2026, 10, 8, 18, 30).getTime());
  assert.equal(scheduleTime({ at: "9:05" }, now), new Date(2026, 10, 9, 9, 5).getTime());
  assert.equal(scheduleTime({ at: "2026-11-10T08:00" }, now), new Date(2026, 10, 10, 8, 0).getTime());
  assert.equal(scheduleTime({ at: "2026-11-10 08:00" }, now), new Date(2026, 10, 10, 8, 0).getTime());
  assert.throws(() => scheduleTime({ at: "2026-11-01T08:00" }, now), /already passed/);
  assert.throws(() => scheduleTime({ at: "soon" }, now), /Not a date and time/);
  assert.throws(() => scheduleTime({ at: "25:00" }, now), /Not a time of day/);
  assert.throws(() => scheduleTime({}, now), /Pass at or inMinutes/);
  assert.throws(() => scheduleTime({ inMinutes: 0 }, now), /positive/);
  assert.throws(() => scheduleTime({ inMinutes: 60 * 24 * 400 }, now), /a year ahead/);
});

test("the agent schedules itself; once due, Scribe sends its message as a new turn", async () => {
  const id = thread();
  let reply: { message: string } | undefined;
  act = async (threadId) => (reply = host.scheduleOp(threadId, { inMinutes: 30, message: "Rebuild and restart the app." }));
  host.send(id, { text: "do it after 18:30" });
  await idle(id);
  assert.match(reply!.message, /^Scheduled for .* \(local time\)/);
  const s = view(id).thread.scheduled!;
  assert.equal(s.message, "Rebuild and restart the app.");
  assert.ok(Math.abs(s.at - (Date.now() + 30 * 60_000)) < 5000);
  // Not due yet: nothing is sent.
  check();
  await idle(id);
  assert.equal(mine(id).length, 1);
  raw(id).scheduled!.at = Date.now() - 1;
  check();
  await idle(id);
  assert.equal(view(id).thread.scheduled, undefined);
  const [, sent] = mine(id);
  assert.match(sent.text, /the time you scheduled with thread_schedule/);
  assert.match(sent.text, /Rebuild and restart the app\.$/);
});

test("Continue now sends it early, Cancel drops it, and a new schedule replaces the old", async () => {
  const id = thread();
  host.scheduleOp(id, { inMinutes: 600 });
  assert.match(host.scheduleOp(id, { inMinutes: 5 }).message, /^Replaced the earlier schedule/);
  host.resolveSchedule(id, true);
  await idle(id);
  assert.equal(view(id).thread.scheduled, undefined);
  assert.match(mine(id)[0].text, /sent your scheduled continuation early[\s\S]*Go on with the task\.$/);

  host.scheduleOp(id, { inMinutes: 5 });
  host.resolveSchedule(id, false);
  assert.equal(view(id).thread.scheduled, undefined);
  assert.throws(() => host.resolveSchedule(id, false), /Nothing is scheduled/);
  host.scheduleOp(id, { inMinutes: 5 });
  assert.equal(host.scheduleOp(id, { cancel: true }).message, "Cancelled the scheduled continuation.");
  assert.equal(mine(id).length, 1);
});

test("an agent can schedule its own helper, but not other threads", () => {
  const parent = thread();
  const helper = thread();
  const other = thread();
  raw(helper).helperOf = parent;
  const reply = host.scheduleOp(parent, { thread: helper, inMinutes: 10, message: "Check the build." });
  assert.equal(reply.thread, helper);
  assert.equal(view(helper).thread.scheduled?.by, parent);
  assert.throws(() => host.scheduleOp(parent, { thread: other, inMinutes: 10 }), /this thread or a helper/);
  assert.throws(() => host.scheduleOp(helper, { thread: parent, inMinutes: 10 }), /this thread or a helper/);
});

test("a thread's instructions name thread_schedule, but not a helper's", () => {
  const id = thread();
  assert.match(threadInstructions(raw(id), {}), /thread_schedule/);
  raw(id).helperOf = "someone";
  assert.doesNotMatch(threadInstructions(raw(id), {}), /thread_schedule/);
});
