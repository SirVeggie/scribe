import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseSpaces } from "./spaces.js";
import { BoardStore } from "./store.js";
import { toMeta } from "./types.js";

let dir = "";
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.SCRIBE_HOME;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-"));
  process.env.SCRIBE_HOME = dir;
});

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env.SCRIBE_HOME;
  } else {
    process.env.SCRIBE_HOME = prevHome;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function loaded(): BoardStore {
  const store = new BoardStore();
  store.load();
  return store;
}

function titles(store: BoardStore): string[] {
  return store.list().map((tab) => tab.title);
}

function page(store: BoardStore, title: string): string {
  return store.upsert({ title, html: `<p>${title}</p>` }).tab.id;
}

test("the first space adopts the current strip", () => {
  const store = loaded();
  page(store, "A");
  page(store, "B");
  assert.equal(store.spacesView().spaces.length, 0);
  store.ensureSpaces();
  const view = store.spacesView();
  assert.equal(view.spaces.length, 1);
  assert.equal(view.spaces[0].name, "Main");
  assert.equal(view.spaces[0].active, true);
  assert.equal(view.spaces[0].tabs.length, 2);
  store.closeDb();
});

test("switching swaps the strip and comes back with order, pins, and focus", () => {
  const store = loaded();
  const a = page(store, "A");
  page(store, "B");
  page(store, "C");
  store.update(page(store, "D"), { pin: true, activate: false });
  store.focus(a);
  const work = store.createSpace({ name: "Work" });
  const main = store.spacesView().activeId!;
  store.switchSpace(work.id);
  assert.deepEqual(titles(store), []);
  assert.equal(store.getActiveId(), null);
  assert.ok(store.isClosed(a));
  const e = page(store, "E");
  assert.deepEqual(titles(store), ["E"]);
  store.switchSpace(main);
  assert.deepEqual(titles(store), ["D", "C", "B", "A"]);
  assert.equal(store.get("d")?.pinned, true);
  assert.equal(store.getActiveId(), a);
  assert.ok(store.isClosed(e));
  store.switchSpace(work.id);
  assert.deepEqual(titles(store), ["E"]);
  store.closeDb();
});

test("a switch keeps the tab the viewer has in front, not the last opened one (#74)", () => {
  const store = loaded();
  const a = page(store, "A");
  page(store, "B");
  const work = store.createSpace({ name: "Work" });
  const main = store.spacesView().activeId!;
  store.noteFocus(a);
  store.noteFocus("missing");
  assert.equal(store.spacesView().spaces[0].activeId, a);
  store.switchSpace(work.id);
  store.switchSpace(main);
  assert.equal(store.getActiveId(), a);
  store.closeDb();
});

test("a page can be a tab in two spaces", () => {
  const store = loaded();
  const a = page(store, "A");
  const other = store.createSpace({ copyTabs: true, activate: true });
  assert.deepEqual(titles(store), ["A"]);
  page(store, "B");
  store.cycleSpace(-1);
  assert.deepEqual(titles(store), ["A"]);
  assert.equal(store.getActiveId(), a);
  store.switchSpace(other.id);
  assert.deepEqual(titles(store), ["B", "A"]);
  store.closeDb();
});

test("spaces and the parked strips survive a reload", () => {
  const store = loaded();
  page(store, "A");
  const work = store.createSpace({ name: "Work", color: "teal", activate: true });
  page(store, "B");
  store.persist();
  store.closeDb();
  const again = loaded();
  const view = again.spacesView();
  assert.deepEqual(view.spaces.map((space) => space.name), ["Main", "Work"]);
  assert.equal(view.activeId, work.id);
  assert.equal(view.spaces[1].color, "teal");
  assert.deepEqual(titles(again), ["B"]);
  again.switchSpace(view.spaces[0].id);
  assert.deepEqual(titles(again), ["A"]);
  again.closeDb();
});

test("Ctrl+Z and clean-up leave tabs parked in other spaces alone", () => {
  const store = loaded();
  page(store, "A");
  page(store, "B");
  store.createSpace({ activate: true });
  assert.throws(() => store.restoreLast(), /nothing to restore/);
  const old = { days: 0.000001, basis: "closed" as const };
  assert.deepEqual(store.cleanupCandidates(old), []);
  store.closeDb();
});

test("delete switches away from the active space, and undo brings it back in place", () => {
  const store = loaded();
  page(store, "A");
  const main = (store.ensureSpaces(), store.spacesView().activeId!);
  const second = store.createSpace({ name: "Second" });
  store.createSpace({ name: "Third" });
  store.switchSpace(second.id);
  page(store, "B");
  store.deleteSpace(second.id);
  assert.deepEqual(store.spacesView().spaces.map((space) => space.name), ["Main", "Third"]);
  assert.notEqual(store.spacesView().activeId, second.id);
  assert.deepEqual(store.spacesView().deleted.map((space) => space.name), ["Second"]);
  store.restoreSpace();
  assert.deepEqual(store.spacesView().spaces.map((space) => space.name), ["Main", "Second", "Third"]);
  store.switchSpace(second.id);
  assert.deepEqual(titles(store), ["B"]);
  store.deleteSpace(main);
  store.deleteSpace(second.id);
  assert.throws(() => store.deleteSpace(store.spacesView().activeId!), /last space/);
  store.closeDb();
});

test("move, rename, and recolor", () => {
  const store = loaded();
  const b = store.createSpace({ name: "B" });
  store.createSpace({ name: "C" });
  store.moveSpace(b.id, 99);
  assert.deepEqual(store.spacesView().spaces.map((space) => space.name), ["Main", "C", "B"]);
  store.moveSpace(b.id, 0);
  store.updateSpace(b.id, { name: "  Home   base ", color: "pink" });
  const first = store.spacesView().spaces[0];
  assert.equal(first.name, "Home base");
  assert.equal(first.color, "pink");
  assert.throws(() => store.updateSpace(b.id, { color: "plaid" }), /unknown space color/);
  store.closeDb();
});

test("deleted pages drop out of a space's tabs", () => {
  const store = loaded();
  const a = page(store, "A");
  page(store, "B");
  const main = (store.ensureSpaces(), store.spacesView().activeId!);
  store.createSpace({ activate: true });
  store.deleteMany([a]);
  assert.deepEqual(store.spacesView().spaces[0].tabs.length, 1);
  store.switchSpace(main);
  assert.deepEqual(titles(store), ["B"]);
  store.closeDb();
});

test("parseSpaces drops malformed entries", () => {
  const data = parseSpaces(
    JSON.stringify({
      list: [{ id: "s_1", name: "", tabs: ["t1", { id: "t1" }, { id: "t2", pinned: 1 }], color: "nope" }, { name: "no id" }],
      activeId: "missing",
      deleted: [{ space: { id: "s_1" } }],
    })
  );
  assert.equal(data.list.length, 1);
  assert.equal(data.list[0].name, "Space");
  assert.deepEqual(data.list[0].tabs, [{ id: "t1", pinned: false }, { id: "t2", pinned: true }]);
  assert.equal(data.activeId, "s_1");
  assert.equal(data.deleted.length, 0);
  assert.deepEqual(parseSpaces("{bad"), { list: [], activeId: null, deleted: [] });
});

test("a space's home folder takes the pages made in it, and the lens is kept (#260)", () => {
  const store = loaded();
  store.ensureSpaces();
  const main = store.spacesView().activeId!;
  const home = store.createFolder({ name: "Work" });
  const work = store.createSpace({ name: "Work", activate: true });
  store.updateSpace(work.id, {
    home: home.id,
    lens: { on: true, match: "any", conditions: [{ type: "home" }, { type: "age", days: 7 }, { type: "bogus" }, { type: "about", text: "  audio  " }] },
  });
  const made = store.upsert({ title: "Notes", html: "<p>n</p>" }).tab;
  assert.equal(made.madeIn, work.id);
  assert.equal(made.folderId, home.id);
  assert.equal(toMeta(made).madeIn, work.id);
  // A folder given wins; a temporary page stays out of the Library.
  assert.equal(store.upsert({ title: "Filed", html: "<p>f</p>", folder: "Elsewhere" }).tab.folderId, store.findFolderPath("Elsewhere"));
  assert.equal(store.upsert({ title: "Temp", html: "<p>t</p>", temp: true }).tab.folderId, undefined);
  // A chat started in Main makes its page in Main, wherever the user is now.
  const agent = store.upsert({ title: "Agent", html: "<p>a</p>", actor: { at: 1, thread: "th_1", space: main } }).tab;
  assert.equal(agent.madeIn, main);
  assert.equal(agent.folderId, undefined);
  // A home the agent could not reach is skipped.
  assert.equal(store.upsert({ title: "Hidden", html: "<p>h</p>", actor: { at: 1, thread: "th_2", space: work.id }, homeFits: () => false }).tab.folderId, undefined);
  store.persist();
  store.closeDb();
  const again = loaded();
  const space = again.spacesView().spaces.find((item) => item.id === work.id)!;
  assert.equal(space.home, home.id);
  assert.deepEqual(space.lens, { on: true, match: "any", conditions: [{ type: "home" }, { type: "age", basis: "activity", days: 7 }, { type: "about", text: "audio" }] });
  assert.equal(again.get(made.id)?.madeIn, work.id);
  assert.deepEqual(again.folderTree().find((folder) => folder.id === home.id)?.homeOf, ["Work"]);
  again.updateSpace(work.id, { home: null, lens: null });
  assert.equal(again.spacesView().spaces.find((item) => item.id === work.id)?.home, undefined);
  assert.throws(() => again.updateSpace(work.id, { home: "f_missing" }), /folder not found/);
  again.closeDb();
});
