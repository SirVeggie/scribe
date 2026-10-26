import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-browser-handoff-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
const { browserControl, browserHandoffResult, browserInput, browserView, closeAgentBrowser } = await import("../browser.js");
let host: InstanceType<typeof AgentHost>;
before(() => { store.load(); host = new AgentHost(() => {}); });
after(async () => { await closeAgentBrowser(); host.dispose(); store.closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

function runningThread(): string {
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null } });
  const turn = { id: `tu_${thread.id}`, threadId: thread.id, seq: 1, status: "running", model: "m", effort: null, mode: thread.mode, startedAt: Date.now() };
  const internals = host as unknown as { runs: Map<string, unknown>; turns: Map<string, unknown[]> };
  internals.turns.get(thread.id)?.push(turn);
  internals.runs.set(thread.id, { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), repo: null, cancelled: false, usage: {}, steer: null, hooks: { lastUser: "", dock: false, called: new Set(), gated: new Set(), approved: new Set(), waiting: new Map(), told: new Set(), earlyItem: null } });
  return thread.id;
}
async function waitForCard(threadId: string) {
  for (let i = 0; i < 200; i++) {
    const item = host.threadDetail(threadId)?.items.find(item => item.kind === "browser_handoff");
    if (item?.kind === "browser_handoff") return item;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("No handoff card appeared");
}

test("browser handoff waits as a chat item, then returns the user activity and snapshot", async () => {
  const threadId = runningThread();
  const pending = host.handoffBrowser(threadId, "Please sign in", new AbortController().signal);
  const card = await waitForCard(threadId);
  assert.equal(card.status, "pending");
  await assert.rejects(host.handoffBrowser(threadId, "Another request", new AbortController().signal), /already pending/);
  assert.equal(host.listThreads().find(thread => thread.id === threadId)?.status, "waiting");
  assert.equal(host.listThreads().find(thread => thread.id === threadId)?.asking?.title, "Please sign in");
  assert.deepEqual((await browserView(threadId))?.handoff, { message: "Please sign in" });
  await browserInput(threadId, { kind: "text", text: "private" });
  await browserControl(threadId, "free");
  host.handBackBrowser(threadId);
  assert.deepEqual(await pending, ["Typed 7 characters into field"]);
  const result = await browserHandoffResult(threadId);
  assert.equal(result.control, "agent");
  assert.deepEqual(result.userActivity, ["Typed 7 characters into field"]);
  assert.ok("snapshot" in result);
  assert.equal(card.status, "done");
  assert.equal((await browserView(threadId))?.handoff, null);
  assert.equal(host.listThreads().find(thread => thread.id === threadId)?.status, "running");
});

test("browser handoff cancellation clears its card and browser marker", async () => {
  const threadId = runningThread();
  const abort = new AbortController();
  const pending = host.handoffBrowser(threadId, "Check this", abort.signal);
  const card = await waitForCard(threadId);
  abort.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(card.status, "cancelled");
  assert.equal((await browserView(threadId))?.control, "free");
  assert.equal((await browserView(threadId))?.handoff, null);
  assert.equal(host.listThreads().find(thread => thread.id === threadId)?.status, "running");
});

test("browser page follows thread renames", () => {
  const threadId = runningThread();
  const page = store.openBrowserPage(threadId, "Before").tab;
  host.updateThread(threadId, { title: "After" });
  assert.equal(page.title, "After");
});
