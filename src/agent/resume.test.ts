import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { RunSink, TurnInput } from "./providers/provider.js";
import type { Item, Thread, Turn } from "./types.js";

// The host keeps its data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-resume-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

type Host = InstanceType<typeof AgentHost>;
const hosts: Host[] = [];

before(() => store.load());

after(() => {
  for (const host of hosts) host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A host whose sessions record their turns and never finish them, as if the agent were still at work. */
function startHost(): { host: Host; ran: Map<string, TurnInput[]>; sinks: Map<string, RunSink> } {
  const host = new AgentHost(() => {});
  hosts.push(host);
  const ran = new Map<string, TurnInput[]>();
  const sinks = new Map<string, RunSink>();
  const internals = host as unknown as { providers: Record<string, { createSession: (thread: { id: string }) => unknown }> };
  internals.providers.pi.createSession = (thread) => ({
    update: () => {},
    warm: async () => {},
    run: (input: TurnInput, sink: RunSink) => {
      ran.set(thread.id, [...(ran.get(thread.id) ?? []), input]);
      sinks.set(thread.id, sink);
      return new Promise(() => {});
    },
    cancel: async () => {},
    dispose: () => {},
  });
  return { host, ran, sinks };
}

test("run info records model output and resets it when a cut-off turn resumes", async () => {
  const first = startHost();
  const id = first.host.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null } }).id;
  first.host.send(id, { text: "Work on this" });
  for (let i = 0; i < 50 && !first.sinks.has(id); i++) await new Promise((r) => setTimeout(r, 10));
  const sink = first.sinks.get(id)!;
  assert.ok(sink);
  const outputAt = (host: Host) => { const info = host.runInfo(id); return info.exists ? info.outputAt : undefined; };
  assert.equal(outputAt(first.host), undefined);
  sink.notice("info", "Connecting");
  sink.text("");
  sink.reasoning("");
  assert.equal(outputAt(first.host), undefined);
  sink.reasoning("Thinking");
  assert.ok(outputAt(first.host));
  sink.text("Working");
  assert.ok(outputAt(first.host));
  first.host.dispose();
  hosts.splice(hosts.indexOf(first.host), 1);

  const resumed = startHost();
  resumed.host.resumeInterrupted();
  for (let i = 0; i < 50 && !resumed.sinks.has(id); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(resumed.sinks.has(id));
  assert.equal(outputAt(resumed.host), undefined);
  resumed.sinks.get(id)!.toolStart({ toolId: "read", name: "Read", tool: "read", title: "Read a file" });
  assert.ok(outputAt(resumed.host));
  await resumed.host.deleteThread(id);
});

/** Leave a thread as a restart finds it: its last turn still running, and maybe messages queued behind it. */
function cutOff(host: Host, opts: { queued?: Array<Partial<Item>>; earlierInterrupted?: number } = {}): string {
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null } });
  const turns: Turn[] = [];
  const earlier = opts.earlierInterrupted ?? 0;
  for (let i = 0; i <= earlier; i++) {
    const last = i === earlier;
    turns.push({ id: `tu_${thread.id}_${i}`, threadId: thread.id, seq: i + 1, status: last ? "running" : "cancelled", ...(last ? {} : { interrupted: true }), model: "m", effort: null, mode: "board", startedAt: Date.now() });
  }
  for (const turn of turns) host.db.saveTurn(turn);
  const items = (opts.queued ?? []).map((extra, i) => ({ id: `it_${thread.id}_${i}`, threadId: thread.id, turnId: null, seq: i + 1, createdAt: Date.now(), kind: "user", text: `queued ${i}`, ...extra }) as Item);
  host.db.saveItems(items);
  return thread.id;
}

const userItems = (host: Host, threadId: string) => (host.threadDetail(threadId)?.items ?? []).filter((it): it is Item & { kind: "user" } => it.kind === "user");

test("a turn cut off by a restart is sent on with Scribe's note, and queued messages queue again", () => {
  const first = startHost().host;
  const id = cutOff(first, { queued: [{}, { card: { num: 7, title: "Fix" } }, { images: [{ id: "f1", name: "a.png", mimeType: "image/png", size: 1 }] }] });
  const looping = cutOff(first, { earlierInterrupted: 3 });
  first.dispose();
  hosts.splice(hosts.indexOf(first), 1);

  const { host, ran } = startHost();
  // Until it is sent on, the board must not take it for a stopped agent and release its card.
  const info = host.runInfo(id);
  assert.ok(info.exists && info.running);
  const cut = host.threadDetail(id)!.turns[0];
  assert.equal(cut.status, "cancelled");
  assert.equal(cut.interrupted, true);

  assert.deepEqual(host.resumeInterrupted(), [id]);
  const items = userItems(host, id);
  const note = items.at(-1)!;
  assert.equal(note.from, "scribe");
  assert.match(note.text, /^Scribe restarted while you were working/);
  assert.ok(note.turnId);
  // Text messages wait behind the new turn; one with an image cannot be sent again.
  const queued = (host as unknown as { queues: Map<string, Array<{ text: string; card?: { board: string } }>> }).queues.get(id)!;
  assert.deepEqual(queued.map((m) => m.text), ["queued 0", "queued 1"]);
  assert.equal(queued[1].card?.board, "");
  assert.equal(items.find((it) => it.text === "queued 2")?.dropped, true);

  // A thread whose turns keep getting cut off is left alone, so a turn that crashes Scribe cannot loop.
  const loopingInfo = host.runInfo(looping);
  assert.equal(loopingInfo.exists && loopingInfo.running, false);
  assert.equal(userItems(host, looping).length, 0);
});

test("a session that cannot be resumed starts over with a recap that keeps a stopped turn's message", async () => {
  const first = startHost().host;
  const view = first.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null } });
  const id = view.id;
  const thread = (first as unknown as { threads: Map<string, Thread> }).threads.get(id)!;
  first.db.saveThread({ ...thread, nativeId: "lost-session" });
  first.db.saveTurn({ id: `tu_${id}_0`, threadId: id, seq: 1, status: "cancelled", model: "m", effort: null, mode: "board", startedAt: Date.now() });
  first.db.saveItems([
    { id: `it_${id}_0`, threadId: id, turnId: `tu_${id}_0`, seq: 1, createdAt: Date.now(), kind: "user", text: "Issues: 1) the first list" } as Item,
    { id: `it_${id}_1`, threadId: id, turnId: `tu_${id}_0`, seq: 2, createdAt: Date.now(), kind: "text", text: "Looking into these." } as Item,
  ]);
  first.dispose();
  hosts.splice(hosts.indexOf(first), 1);

  const { host, ran } = startHost();
  (host as unknown as { providers: Record<string, { resumable?: (id: string) => Promise<boolean> }> }).providers.pi.resumable = async () => false;
  host.send(id, { text: "Also 9) one more" });
  for (let i = 0; i < 50 && !ran.get(id); i++) await new Promise((r) => setTimeout(r, 10));
  const [input] = ran.get(id) ?? [];
  assert.ok(input);
  assert.match(input.text, /<earlier_conversation>/);
  assert.match(input.text, /User: Issues: 1\) the first list/);
  assert.match(input.text, /You \(stopped before it finished\): Looking into these\./);
  assert.match(input.text, /Also 9\) one more/);
});

test("a draft thread keeps its unsent text across a restart until the user sends", () => {
  const first = startHost().host;
  const id = first.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null }, draft: { text: "half a thought" } }, { remember: false }).id;
  first.updateThread(id, { draft: { text: "half a thought, and more" } });
  first.dispose();
  hosts.splice(hosts.indexOf(first), 1);

  const { host } = startHost();
  assert.deepEqual(host.threadDetail(id)?.thread.draft, { text: "half a thought, and more" });
  host.send(id, { text: "half a thought, and more" });
  assert.equal(host.threadDetail(id)?.thread.draft, null);
});

test("the resumed turn reaches the agent worded as Scribe's", async () => {
  const first = startHost().host;
  const id = cutOff(first);
  first.dispose();
  hosts.splice(hosts.indexOf(first), 1);
  const { host, ran } = startHost();
  host.resumeInterrupted();
  for (let i = 0; i < 50 && !ran.get(id); i++) await new Promise((r) => setTimeout(r, 10));
  const [input] = ran.get(id) ?? [];
  assert.ok(input);
  assert.match(input.text, /<context>\nSent by Scribe itself, not typed by the user\.\n<\/context>/);
  assert.match(input.text, /Scribe restarted while you were working/);
});

test("a helper cut off by a restart is told to report to its agent, not to ask the user", () => {
  const first = startHost().host;
  const caller = cutOff(first);
  const helper = cutOff(first);
  const thread = (first as unknown as { threads: Map<string, Thread> }).threads.get(helper)!;
  first.db.saveThread({ ...thread, helperOf: caller });
  first.dispose();
  hosts.splice(hosts.indexOf(first), 1);

  const { host } = startHost();
  const resumed = host.resumeInterrupted();
  assert.ok(resumed.includes(caller) && resumed.includes(helper));
  const note = userItems(host, helper).at(-1)!;
  assert.equal(note.from, "scribe");
  assert.match(note.text, /do not ask the user/);
  assert.doesNotMatch(note.text, /ask again/);
  const callerNote = userItems(host, caller).at(-1)!;
  assert.match(callerNote.text, /ask again/);
  assert.match(callerNote.text, new RegExp(`sent on with its task: ${helper}`));
});

test("run info and thread views total token usage across turns", () => {
  const { host } = startHost();
  const id = host.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null } }).id;
  const base = { threadId: id, model: "m" as const, effort: null, mode: "board" as const, startedAt: 1 };
  const turns: Turn[] = [
    { ...base, id: "tu_a", seq: 1, status: "done", endedAt: 2, usage: { inputTokens: 100, outputTokens: 20 } },
    { ...base, id: "tu_b", seq: 2, status: "done", endedAt: 4, usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 5 } },
    { ...base, id: "tu_c", seq: 3, status: "done", endedAt: 6, reverted: true, usage: { inputTokens: 999, outputTokens: 999 } },
  ];
  for (const turn of turns) host.db.saveTurn(turn);
  (host as unknown as { turns: Map<string, Turn[]> }).turns.set(id, turns);
  const info = host.runInfo(id);
  assert.equal(info.exists, true);
  if (!info.exists) return;
  assert.deepEqual(info.usage, { turns: 2, inputTokens: 150, outputTokens: 30, cacheReadTokens: 5, promptTokens: 155, costPartial: true });
  const view = host.listThreads().find((t) => t.id === id);
  assert.deepEqual(view?.usage, { turns: 2, inputTokens: 150, outputTokens: 30, cacheReadTokens: 5 });
});
