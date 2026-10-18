import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ItemBody } from "./types.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-follow-"));
process.env.SCRIBE_HOME = dir;
process.env.SCRIBE_FAKE_AGENTS = "1";
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;

before(() => {
  store.load();
  host = new AgentHost(() => undefined);
});

after(() => {
  host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

function page(key: string): string {
  return store.upsert({ key, title: key, html: `<p>${key}</p>` }).tab.id;
}

test("followToPage rebinds a user thread to the page it opened", () => {
  const pageId = page("follow-target");
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "page", ref: "t_old" } });
  assert.equal(host.followToPage(thread.id, pageId), true);
  assert.deepEqual(host.getThread(thread.id)?.scope, { kind: "page", ref: pageId });
});

test("followToPage binds a global floating-chat thread to the new page", () => {
  const pageId = page("follow-global");
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null } });
  assert.equal(host.followToPage(thread.id, pageId), true);
  assert.deepEqual(host.getThread(thread.id)?.scope, { kind: "page", ref: pageId });
});

test("followToPage is a no-op when the thread already belongs to that page", () => {
  const pageId = page("follow-same");
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "page", ref: pageId } });
  assert.equal(host.followToPage(thread.id, pageId), false);
  assert.deepEqual(host.getThread(thread.id)?.scope, { kind: "page", ref: pageId });
});

test("followToPage leaves a board-owned thread on its page", () => {
  const pageId = page("follow-board");
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "page", ref: "t_board" } });
  const internals = host as unknown as { addItem: (threadId: string, turnId: string | null, body: ItemBody) => unknown };
  internals.addItem(thread.id, null, { kind: "user", text: "Take card #1", from: "page" });
  assert.equal(host.followToPage(thread.id, pageId), false);
  assert.deepEqual(host.getThread(thread.id)?.scope, { kind: "page", ref: "t_board" });
});

test("createThread on a New page draft promotes it to a real blank page", () => {
  const draft = store.createDraft();
  assert.equal(store.get(draft.id), undefined);
  host.createThread({ provider: "pi", mode: "board", scope: { kind: "page", ref: draft.id } });
  const tab = store.get(draft.id);
  assert.ok(tab);
  assert.equal(tab.html, "");
  assert.equal(tab.title, "New page");
  assert.equal(store.isDraft(draft.id), false);
});

test("followToPage ignores a missing thread or page", () => {
  const pageId = page("follow-missing");
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null } });
  assert.equal(host.followToPage("th_nope", pageId), false);
  assert.equal(host.followToPage(thread.id, "t_nope"), false);
  assert.deepEqual(host.getThread(thread.id)?.scope, { kind: "global", ref: null });
});

function newPage() {
  const draft = store.createDraft();
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "page", ref: draft.id } });
  return { id: draft.id, thread: thread.id };
}

async function settled(thread: string) {
  const deadline = Date.now() + 5000;
  while (true) {
    const info = host.runInfo(thread);
    if (!info.exists || !info.running) break;
    assert.ok(Date.now() < deadline, "fake turn should finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setImmediate(resolve));
}

test("closing an untouched New page removes it from Library and retains its thread", () => {
  const { id, thread } = newPage();
  store.closeTab(id);
  assert.equal(store.get(id), undefined);
  assert.ok(host.getThread(thread));
  assert.ok(store.listTrash().some((batch) => batch.tabs.some((tab) => tab.id === id)));
});

test("closed New pages wait for every running thread", async () => {
  const { id, thread } = newPage();
  const second = host.createThread({ provider: "pi", mode: "board", scope: { kind: "page", ref: id } });
  host.send(thread, { text: "[fake:hang]" });
  host.send(second.id, { text: "[fake:hang]" });
  store.closeTab(id);
  assert.ok(store.get(id));
  await host.cancel(thread);
  await settled(thread);
  assert.ok(store.get(id), "the second thread still needs the page");
  await host.cancel(second.id);
  await settled(second.id);
  assert.equal(store.get(id), undefined);
});

test("queued turns keep the closed New page until the last turn finishes", async () => {
  const { id, thread } = newPage();
  host.send(thread, { text: "[fake:delay=50]" });
  assert.equal(host.send(thread, { text: "[fake:delay=50]" }).queued, true);
  store.closeTab(id);
  assert.ok(store.get(id));
  await settled(thread);
  assert.equal(store.get(id), undefined);
});

test("an agent write while the closed page is running prevents cleanup", async () => {
  const { id, thread } = newPage();
  host.send(thread, { text: "[fake:hang]" });
  store.closeTab(id);
  store.patchHtml(id, { html: "<p>Investigation</p>", actor: { thread, at: Date.now() } });
  await host.cancel(thread);
  await settled(thread);
  assert.match(store.get(id)?.html ?? "", /<p>Investigation<\/p>/);
});

test("agent state edits protect a New page even when its HTML is blank", () => {
  const { id, thread } = newPage();
  store.writeState(id, { ops: [{ op: "set", path: "notes", value: "keep" }], actor: { thread, at: Date.now() } });
  store.closeTab(id);
  assert.ok(store.get(id));
});

test("reopening a New page cancels deferred cleanup", async () => {
  const { id, thread } = newPage();
  host.send(thread, { text: "[fake:hang]" });
  store.closeTab(id);
  store.openPage(id);
  await host.cancel(thread);
  await settled(thread);
  assert.ok(store.get(id));
  assert.equal(store.isClosed(id), false);
});

test("closing a page with content keeps it in the Library", () => {
  const id = page("keep-content");
  store.closeTab(id);
  assert.ok(store.get(id));
});

test("closing a New page in one space preserves its tab in another space", () => {
  const { id } = newPage();
  store.ensureSpaces();
  const main = store.spacesView().activeId!;
  store.createSpace({ copyTabs: true, activate: true });
  store.closeTab(id);
  assert.ok(store.get(id));
  store.switchSpace(main);
  assert.equal(store.isClosed(id), false);
  store.closeTab(id);
  assert.equal(store.get(id), undefined);
});

test("deferred cleanup survives a host restart", async () => {
  const { id, thread } = newPage();
  // A thread waiting to resume must protect the page just like a live turn.
  const internals = host as unknown as { resuming: Set<string> };
  internals.resuming.add(thread);
  store.closeTab(id);
  assert.ok(store.get(id));
  host.dispose();
  host = new AgentHost(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(id), undefined);
  assert.ok(host.getThread(thread));
});
