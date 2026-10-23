import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ItemBody } from "./types.js";
import { WEB_IMPORTANCE_WAIT_MS } from "./webAccess.js";

// The host and the store keep their data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-page-access-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
const { pageReach } = await import("../pageAccess.js");

let host: InstanceType<typeof AgentHost>;

type Internals = {
  runs: Map<string, unknown>;
  turns: Map<string, unknown[]>;
  addItem(threadId: string, turnId: string | null, body: ItemBody): unknown;
};

before(() => {
  store.load();
  host = new AgentHost(() => {});
});

after(() => {
  host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

function running(threadId: string): void {
  const turn = { id: `tu_${threadId}`, threadId, seq: 1, status: "running", model: "m", effort: null, mode: "board", startedAt: Date.now() };
  const internals = host as unknown as Internals;
  internals.turns.get(threadId)?.push(turn);
  internals.runs.set(threadId, { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), repo: null, cancelled: false, usage: {}, steer: null, hooks: { lastUser: "", dock: false, called: new Set(), gated: new Set(), approved: new Set(), waiting: new Map(), told: new Set(), earlyItem: null } });
}

function pendingApprovals(threadId: string) {
  return (host.threadDetail(threadId)?.items ?? []).filter((it) => it.kind === "approval" && it.status === "pending");
}

async function answer(threadId: string, optionId: string) {
  for (let i = 0; i < 50 && !pendingApprovals(threadId).length; i += 1) await new Promise((r) => setImmediate(r));
  const [item] = pendingApprovals(threadId);
  assert.ok(item && item.kind === "approval");
  host.resolveApproval(item.requestId || item.id, optionId);
  return item;
}

function page(key: string, folderId?: string) {
  const { tab } = store.upsert({ key, title: key.replace(/-/g, " "), html: "<p>x</p>", activate: false });
  return folderId ? store.movePage(tab.id, folderId, 0) : tab;
}

test("plugin approvals can be cancelled, expire unattended, and grant revocable thread access",async()=>{
  const chat=host.createThread({provider:"claude",mode:"board",scope:{kind:"global",ref:null}});running(chat.id);
  const first=host.requestPluginApproval(chat.id,"Plugin call","Read Jira",true,"jira");
  await answer(chat.id,"thread");assert.equal((await first).allowed,true);
  assert.equal(host.threadDetail(chat.id)?.thread.grants?.some(row=>row.key==="plugins:jira"),true);
  host.revokeGrant(chat.id,"plugins:jira");assert.deepEqual(host.getThread(chat.id)?.pluginGrants,[]);
  const abort=new AbortController(),cancelled=host.requestPluginApproval(chat.id,"Plugin call","Cancelled",true,"jira",{signal:abort.signal});abort.abort();assert.equal((await cancelled).allowed,false);
  const internals=host as unknown as {unattended(id:string):boolean},original=internals.unattended,wait=WEB_IMPORTANCE_WAIT_MS.trivial;
  try{internals.unattended=()=>true;WEB_IMPORTANCE_WAIT_MS.trivial=5;assert.equal((await host.requestPluginApproval(chat.id,"Plugin install","Timed out",false,undefined,{importance:"trivial"})).allowed,false);}
  finally{internals.unattended=original;WEB_IMPORTANCE_WAIT_MS.trivial=wait;}
});

const reach = (threadId: string, tabId: string) => (host as unknown as { reachOf(t: string, tab: unknown): string }).reachOf(threadId, store.get(tabId));

test("page_access: this thread, always for its page, or deny; Ask always pages only offer this thread", async () => {
  const board = page("pa-board");
  const notes = page("pa-notes");
  const spec = page("pa-spec");
  const chat = host.createThread({ provider: "claude", mode: "board", scope: { kind: "page", ref: board.id } });
  running(chat.id);
  assert.equal(reach(chat.id, notes.id), "ask");

  const thread = host.requestPageAccess(chat.id, { page: notes.key, reason: "the card links it" });
  const card = await answer(chat.id, "thread");
  assert.ok(card.kind === "approval");
  assert.deepEqual(card.options.map((o) => o.label), ["Allow for this thread", "Always allow for pa board", "Deny"]);
  assert.equal((await thread).allowed, true);
  assert.equal(reach(chat.id, notes.id), "allow");
  assert.equal(host.getThread(chat.id)?.pageGrants?.length, 1);

  const always = host.requestPageAccess(chat.id, { page: spec.key });
  await answer(chat.id, "always");
  assert.equal((await always).allowed, true);
  assert.deepEqual(store.get(board.id)?.access?.grants, [{ kind: "page", id: spec.id }]);
  const other = host.createThread({ provider: "claude", mode: "board", scope: { kind: "page", ref: board.id } });
  assert.equal(reach(other.id, spec.id), "allow", "another chat on the board inherits it");

  running(other.id);
  const denied = host.requestPageAccess(other.id, { page: notes.key });
  await answer(other.id, "deny");
  assert.equal((await denied).allowed, false);

  store.setPageAccessLevel(spec.id, "ask");
  assert.equal(reach(other.id, spec.id), "ask", "Ask always ignores the board's grant");
  const asked = host.requestPageAccess(other.id, { page: spec.key });
  const askCard = await answer(other.id, "thread");
  assert.ok(askCard.kind === "approval");
  assert.deepEqual(askCard.options.map((o) => o.id), ["thread", "deny"]);
  assert.equal((await asked).allowed, true);
});

test("an untrusted chat asks for a Trusted only page by key, for this thread only; full access does not answer", async () => {
  const home = page("trq-home");
  const secret = page("trq-secret");
  store.setPageAccessLevel(secret.id, "trusted");
  const chat = host.createThread({ provider: "claude", mode: "board", approval: "full", scope: { kind: "page", ref: home.id } });
  running(chat.id);
  assert.equal(reach(chat.id, secret.id), "request");
  const asked = host.requestPageAccess(chat.id, { page: secret.key });
  const card = await answer(chat.id, "thread");
  assert.ok(card.kind === "approval");
  assert.deepEqual(card.options.map((o) => o.id), ["thread", "deny"]);
  assert.equal((await asked).allowed, true);
  assert.equal(reach(chat.id, secret.id), "allow");
});

test("Restricted pages are not found by a chat, and it cannot ask; full access changes nothing", async () => {
  const board = page("tr-board");
  const secret = page("tr-secret");
  const chat = host.createThread({ provider: "claude", mode: "board", approval: "full", scope: { kind: "global", ref: null } });
  running(chat.id);
  store.setPageAccessLevel(secret.id, "restricted");
  assert.equal(reach(chat.id, secret.id), "hidden");
  assert.deepEqual(await host.requestPageAccess(chat.id, { page: secret.key }), { allowed: false, message: `tab not found: ${secret.key}` });
  assert.equal(pendingApprovals(chat.id).length, 0);
  assert.equal(store.get(secret.id)?.agentHidden, true);
  const own = host.createThread({ provider: "claude", mode: "board", scope: { kind: "page", ref: secret.id } });
  assert.equal(reach(own.id, secret.id), "allow", "a chat on the page itself");
  assert.equal(reach(chat.id, board.id), "allow");
});

test("the user's @mention reaches any page; page, helper and hook messages grant nothing", () => {
  const secret = page("mention-secret");
  store.setPageAccessLevel(secret.id, "restricted");
  const chip = { kind: "page" as const, id: secret.id, key: secret.key, title: secret.title };
  for (const from of ["page", "agent", "hook"] as const) {
    const chat = host.createThread({ provider: "claude", mode: "board", scope: { kind: "global", ref: null } });
    running(chat.id);
    host.send(chat.id, { text: "look", from, context: [chip] });
    assert.equal(reach(chat.id, secret.id), "hidden", from);
  }
  const chat = host.createThread({ provider: "claude", mode: "board", scope: { kind: "global", ref: null } });
  running(chat.id);
  host.send(chat.id, { text: "look at @this", context: [chip] });
  assert.equal(reach(chat.id, secret.id), "allow");
  assert.deepEqual(host.getThread(chat.id)?.pageGrants, [{ kind: "page", id: secret.id, mention: true }]);
  // Reached through the mention, it does not taint the chat.
  host.notePageReached(chat.id, store.get(secret.id)!);
  assert.equal(host.getThread(chat.id)?.tainted, undefined);
  assert.ok(host.listThreads().find((t) => t.id === chat.id)?.grants?.some((g) => g.key === `pages:page:${secret.id}`));
  host.revokeGrant(chat.id, `pages:page:${secret.id}`);
  assert.equal(reach(chat.id, secret.id), "hidden");
});

test("reading trusted content taints a chat; untrusted readers then only get its transcript from the user's #tag", async () => {
  const secret = page("taint-secret");
  store.setPageAccessLevel(secret.id, "trusted");
  host.saveModelSource(null, { name: "Local", baseUrl: "http://localhost:1/v1", trusted: true });
  const trusted = host.createThread({ provider: "pi", model: "src-local/qwen", mode: "board", scope: { kind: "global", ref: null } });
  assert.equal(host.threadTrusted(host.getThread(trusted.id)!), true);
  assert.equal(reach(trusted.id, secret.id), "allow");
  host.notePageReached(trusted.id, store.get(secret.id)!);
  assert.equal(host.getThread(trusted.id)?.tainted, true);
  (host as unknown as Internals).addItem(trusted.id, null, { kind: "text", text: "The secret says hello" });

  const reader = host.createThread({ provider: "claude", mode: "board", scope: { kind: "global", ref: null } });
  running(reader.id);
  const listing = host.listReadableThreads(reader.id, {});
  await answer(reader.id, "all");
  assert.equal((await listing).threads.some((t) => t.id === trusted.id), false);
  host.send(reader.id, { text: "read it", context: [{ kind: "thread", id: trusted.id, title: "x" }] });
  assert.match(JSON.stringify(await host.readOtherThread(reader.id, { thread: trusted.id })), /The secret says hello/);
  assert.equal(host.getThread(reader.id)?.tainted, true, "it now holds that content too");
});

test("a chat that follows a page it showed still reaches its old home; picking a scope drops it", () => {
  const board = page("follow-board");
  const report = page("follow-report");
  const notes = page("follow-notes");
  const chat = host.createThread({ provider: "claude", mode: "board", scope: { kind: "page", ref: board.id } });
  assert.equal(host.followToPage(chat.id, report.id), true);
  assert.equal(reach(chat.id, board.id), "allow");
  assert.equal(reach(chat.id, notes.id), "ask");
  host.updateThread(chat.id, { scope: { kind: "page", ref: notes.id } });
  assert.equal(reach(chat.id, board.id), "ask");
});

test("a page made before origins were recorded counts as made from its creator's home", () => {
  const board = page("legacy-board");
  const worker = host.createThread({ provider: "claude", mode: "board", scope: { kind: "page", ref: board.id } });
  const { tab: report } = store.upsert({ key: "legacy-report", title: "Old report", html: "<p>r</p>", activate: false, actor: { thread: worker.id, at: Date.now() } });
  assert.equal(report.access?.origin, undefined);
  const chat = host.createThread({ provider: "claude", mode: "board", scope: { kind: "page", ref: board.id } });
  assert.equal(reach(chat.id, report.id), "allow");
});

test("a chat reads, but does not change, Normal pages linked from the card it holds (#762)", () => {
  const { tab: board } = store.openFromTemplate("kanban", {}, { activate: false });
  const design = page("held-design");
  const askAlways = page("held-ask-always");
  store.setPageAccessLevel(askAlways.id, "ask");
  const worker = host.createThread({ provider: "claude", mode: "board", scope: { kind: "page", ref: board.id } });
  const helper = host.createThread({ provider: "claude", mode: "board", scope: { kind: "page", ref: board.id } });
  (host as unknown as { threads: Map<string, { helperOf?: string }> }).threads.get(helper.id)!.helperOf = worker.id;
  const card = { id: "c_held", num: 900, col: "x", title: "Held", description: `See [[scribe:${design.key.replace(/^scribe:/, "")}]] and scribe:${askAlways.key.replace(/^scribe:/, "")}`, comments: [], createdAt: 1, movedAt: 1 };
  assert.ok(store.writeState(board.id, { ops: [{ op: "insert", path: "cards", value: card }] }).ok);
  const reader = (id: string) => host.pageReader(id)!;
  const lookup = store.accessLookup();
  const reachAs = (id: string, tabId: string, read: boolean) => pageReach(reader(id), host.accessPage(store.get(tabId)!), lookup, read);
  assert.equal(reachAs(worker.id, design.id, true), "ask", "not before the claim");
  store.runAction(board.id, "claim", { card: 900 }, { by: "agent", label: "Opus", thread: worker.id });
  assert.equal(reachAs(worker.id, design.id, true), "allow");
  assert.equal(reachAs(helper.id, design.id, true), "allow", "a helper reads its parent's card links");
  assert.equal(reachAs(worker.id, design.id, false), "ask", "changing it still asks");
  assert.equal(reachAs(worker.id, askAlways.id, true), "ask", "an Ask always page still asks");
  store.runAction(board.id, "finish", { card: 900, summary: "x" }, { by: "agent", label: "Opus", thread: worker.id });
  assert.equal(reachAs(worker.id, design.id, true), "ask", "the claim ended");
});
