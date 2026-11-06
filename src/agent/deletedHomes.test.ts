import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// The host keeps its data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-deleted-homes-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;

before(() => {
  store.load();
  host = new AgentHost(() => {});
});

after(() => {
  host.dispose();
});

test("a deleted page's threads are archived with it and come back when it is restored (#1036)", () => {
  const page = store.upsert({ title: "Notes", html: "<p>x</p>" }).tab;
  const thread = host.createThread({ scope: { kind: "page", ref: page.id } });
  const pinned = host.createThread({ scope: { kind: "page", ref: page.id } });
  host.updateThread(pinned.id, { pinned: true });
  store.deleteMany([page.id]);
  assert.equal(host.getThread(thread.id)?.archived, true);
  assert.equal(host.getThread(pinned.id)?.archived, true);
  store.restoreFromTrash(page.id);
  assert.equal(host.getThread(thread.id)?.archived, false);
  assert.equal(host.getThread(pinned.id)?.archived, false);
  assert.equal(host.getThread(pinned.id)?.pinned, true);
});

test("a thread the user archived stays archived when its page is restored", () => {
  const page = store.upsert({ title: "Other", html: "<p>y</p>" }).tab;
  const thread = host.createThread({ scope: { kind: "page", ref: page.id } });
  host.updateThread(thread.id, { archived: true });
  store.deleteMany([page.id]);
  store.restoreFromTrash(page.id);
  assert.equal(host.getThread(thread.id)?.archived, true);
});

test("a purged skill is dropped from threads and Kanban workers", () => {
  const board = store.upsert({ title: "Board", html: "<p>b</p>", state: { settings: { workers: { w1: { name: "W", skills: ["sk_a", "sk_b"] } } } } }).tab;
  const thread = host.createThread({ scope: { kind: "global", ref: null } });
  host.updateThread(thread.id, { skills: ["sk_a", "sk_b"] });
  host.forgetSkill("sk_a");
  assert.deepEqual(host.getThread(thread.id)?.skills, ["sk_b"]);
  const workers = (store.get(board.id)!.state as { settings: { workers: Record<string, { skills: string[] }> } }).settings.workers;
  assert.deepEqual(workers.w1.skills, ["sk_b"]);
});

test("linkedFrom finds pages and card text that link to a page by key", () => {
  const target = store.upsert({ key: "link-target", title: "Target", html: "<p>t</p>" }).tab;
  const page = store.upsert({ title: "Linker", html: '<a data-scribe-open="scribe:link-target">x</a>' }).tab;
  const board = store.upsert({ title: "Cards", html: "<p>c</p>", state: { cards: [{ description: "See [[scribe:link-target]]" }] } }).tab;
  store.upsert({ title: "Near miss", html: "<p>scribe:link-target-2</p>" });
  assert.deepEqual(store.linkedFrom(target.id).map((p) => p.id).sort(), [page.id, board.id].sort());
});

test("a deleted folder's threads are archived with it", () => {
  const folder = store.createFolder({ name: "Work" });
  const thread = host.createThread({ scope: { kind: "folder", ref: folder.id } });
  store.deleteMany([], [folder.id]);
  assert.equal(host.getThread(thread.id)?.archived, true);
  store.restoreFromTrash(folder.id);
  assert.equal(host.getThread(thread.id)?.archived, false);
});
