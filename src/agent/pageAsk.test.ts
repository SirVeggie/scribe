import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { AgentEvent } from "./types.js";

// The host and the store keep their data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-ask-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

const events: AgentEvent[] = [];
let host: InstanceType<typeof AgentHost>;

before(() => {
  store.load();
  host = new AgentHost((event) => events.push(event));
});

after(() => {
  host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A thread with a running turn, as if the agent were mid-turn. */
function runningThread(): string {
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null } });
  const turn = { id: `tu_${thread.id}`, threadId: thread.id, seq: 1, status: "running", model: "m", effort: null, mode: thread.mode, startedAt: Date.now() };
  const internals = host as unknown as { runs: Map<string, unknown>; turns: Map<string, unknown[]> };
  internals.turns.get(thread.id)?.push(turn);
  internals.runs.set(thread.id, { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), repo: null, cancelled: false, usage: {}, steer: null, hooks: { lastUser: "", dock: false, called: new Set(), gated: new Set(), approved: new Set(), waiting: new Map(), told: new Set(), earlyItem: null } });
  return thread.id;
}

function pageQuestion(threadId: string) {
  const item = host.threadDetail(threadId)?.items.find((it) => it.kind === "question" && it.page);
  assert.ok(item && item.kind === "question");
  return item;
}

const status = (threadId: string) => host.listThreads().find((t) => t.id === threadId)?.status;

test("page_ask waits on the page's submit and returns its state", async () => {
  store.upsert({ key: "ask-form", title: "Pick one", html: "<p>form</p>", state: { choice: null } });
  const threadId = runningThread();
  const abort = new AbortController();
  const pending = host.askPage(threadId, { page: "ask-form", prompt: "Which one?", events: ["submit"], timeoutMs: 5000, signal: abort.signal });
  await new Promise((r) => setImmediate(r));
  const item = pageQuestion(threadId);
  assert.equal(item.status, "pending");
  assert.equal(item.title, "Which one?");
  assert.equal(item.page?.key, "scribe:ask-form");
  assert.equal(status(threadId), "waiting");
  const asking = host.listThreads().find((t) => t.id === threadId)?.asking;
  assert.deepEqual(asking, { kind: "question", itemId: item.id, title: "Which one?", page: item.page });

  store.logEvent("ask-form", { name: "other", data: null, by: "user" });
  store.writeState("ask-form", { ops: [{ op: "set", path: "choice", value: "b" }] });
  store.logEvent("ask-form", { name: "submit", data: { ok: true }, by: "user" });
  const result = await pending;
  assert.ok("answered" in result && result.answered === true);
  assert.deepEqual(result.state, { choice: "b" });
  assert.deepEqual(result.events.map((e) => e.name), ["submit"]);
  assert.equal(pageQuestion(threadId).status, "answered");
  assert.equal(pageQuestion(threadId).event, "submit");
  assert.equal(status(threadId), "running");
  assert.equal(host.listThreads().find((t) => t.id === threadId)?.asking, undefined);
});

test("a form's scribe.reply answers page_ask with its data (#1063)", async () => {
  store.upsert({ key: "ask-reply", title: "Reply form", html: "<p>form</p>" });
  const threadId = runningThread();
  const page = store.get("ask-reply")!;
  const pending = host.askPage(threadId, { page: "ask-reply", events: ["submit"], timeoutMs: 5000, signal: new AbortController().signal });
  await new Promise((r) => setImmediate(r));
  assert.equal(host.asksPage(threadId, page.id), true);
  host.pageReplied(page.id, { summary: " Picked\n A ", data: { approach: "A", notes: "x".repeat(5000) } });
  const result = await pending;
  assert.ok("answered" in result && result.answered === true);
  assert.deepEqual(result.events.map((e) => e.name), ["reply"]);
  assert.equal(result.reply?.summary, "Picked A");
  assert.equal((result.reply?.data as { approach: string }).approach, "A");
  assert.equal(pageQuestion(threadId).status, "answered");
  assert.equal(host.asksPage(threadId, page.id), false);
});

test("skipping the chat card ends page_ask with the user's note", async () => {
  store.upsert({ key: "ask-skip", title: "Skip me", html: "<p>form</p>" });
  const threadId = runningThread();
  const pending = host.askPage(threadId, { page: "ask-skip", events: ["submit"], timeoutMs: 5000, signal: new AbortController().signal });
  await new Promise((r) => setImmediate(r));
  host.resolveQuestion(pageQuestion(threadId).requestId, { skipped: true, reason: "use your judgement" });
  const result = await pending;
  assert.deepEqual(result, { skipped: true, note: "use your judgement", page: { id: pageQuestion(threadId).page!.id, key: "scribe:ask-skip" } });
  assert.equal(pageQuestion(threadId).status, "skipped");
  assert.equal(status(threadId), "running");
});

test("a cancelled call expires the card", async () => {
  store.upsert({ key: "ask-cancel", title: "Cancel", html: "<p>form</p>" });
  const threadId = runningThread();
  const abort = new AbortController();
  const pending = host.askPage(threadId, { page: "ask-cancel", events: ["submit"], timeoutMs: 5000, signal: abort.signal });
  await new Promise((r) => setImmediate(r));
  abort.abort();
  const result = await pending;
  assert.ok("answered" in result && result.answered === false);
  assert.equal(result.timedOut, false);
  assert.equal(pageQuestion(threadId).status, "expired");
});

test("page_ask needs a running turn", async () => {
  store.upsert({ key: "ask-idle", title: "Idle", html: "<p>form</p>" });
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null } });
  await assert.rejects(host.askPage(thread.id, { page: "ask-idle", events: ["submit"], timeoutMs: 1000, signal: new AbortController().signal }), /turn running/);
});

test("ask_user shows Scribe's own question card and answers with labels and values", async () => {
  const { parseQuestionInput, formatAnswers } = await import("./questionTool.js");
  const req = parseQuestionInput({
    title: "Before I start",
    questions: [
      { question: "Which database?", options: ["Postgres", { label: "SQLite", description: "file" }] },
      { question: "Name it", type: "text" },
      { question: "How sure?", type: "scale", min: 1, max: 5, minLabel: "Not", maxLabel: "Very" },
      { question: "Port", type: "number", optional: true },
    ],
  });
  assert.equal(req.display, "dialog");
  assert.equal(req.questions[1].type, "text");
  assert.equal(req.questions[0].type, undefined);
  const threadId = runningThread();
  const pending = host.askQuestions(threadId, req, new AbortController().signal);
  await new Promise((r) => setImmediate(r));
  const item = host.threadDetail(threadId)?.items.find((it) => it.kind === "question" && !it.page);
  assert.ok(item && item.kind === "question");
  assert.equal(item.display, "dialog");
  assert.equal(status(threadId), "waiting");
  assert.equal(host.listThreads().find((t) => t.id === threadId)?.asking?.form, true);
  host.resolveQuestion(item.requestId, { answers: { q1: ["o2"], q2: ["importer"], q3: ["4"], q4: [] }, notes: { q1: "for now" } });
  const text = formatAnswers(req, await pending);
  assert.match(text, /Which database\?\n→ SQLite\nNote: for now/);
  assert.match(text, /Name it\n→ importer/);
  assert.match(text, /How sure\?\n→ 4/);
  assert.match(text, /Port\n→ \(no answer\)/);
  assert.equal(status(threadId), "running");
});

test("ask_user rejects questions it cannot show", async () => {
  const { parseQuestionInput } = await import("./questionTool.js");
  assert.throws(() => parseQuestionInput({ questions: [] }), /at least one/);
  assert.throws(() => parseQuestionInput({ questions: [{ question: "One?", options: ["only"] }] }), /two options/);
  assert.throws(() => parseQuestionInput({ questions: [{ question: "Big?", type: "scale", min: 0, max: 50 }] }), /scale/);
  assert.equal(parseQuestionInput({ questions: [{ question: "Short?", type: "text" }] }).display, "inline");
  assert.equal(parseQuestionInput({ questions: [{ question: "Long?", type: "text", long: true }] }).display, "dialog");
});
