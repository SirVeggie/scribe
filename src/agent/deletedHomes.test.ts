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
  assert.equal(host.getThread(pinned.id)?.archived, false);
  store.restoreFromTrash(page.id);
  assert.equal(host.getThread(thread.id)?.archived, false);
});

test("a thread the user archived stays archived when its page is restored", () => {
  const page = store.upsert({ title: "Other", html: "<p>y</p>" }).tab;
  const thread = host.createThread({ scope: { kind: "page", ref: page.id } });
  host.updateThread(thread.id, { archived: true });
  store.deleteMany([page.id]);
  store.restoreFromTrash(page.id);
  assert.equal(host.getThread(thread.id)?.archived, true);
});

test("a deleted folder's threads are archived with it", () => {
  const folder = store.createFolder({ name: "Work" });
  const thread = host.createThread({ scope: { kind: "folder", ref: folder.id } });
  store.deleteMany([], [folder.id]);
  assert.equal(host.getThread(thread.id)?.archived, true);
  store.restoreFromTrash(folder.id);
  assert.equal(host.getThread(thread.id)?.archived, false);
});
