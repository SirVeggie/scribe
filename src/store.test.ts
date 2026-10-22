import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { parseImport, serializeExport } from "./boardExport.js";
import { RevisionConflictError } from "./htmlEdit.js";
import { templateFingerprint } from "./templates.js";
import { BoardStore } from "./store.js";
import { toMeta, type Template, type UpsertNotice } from "./types.js";

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

test("imports and disk folder files start read, while later agent writes still notify", () => {
  const store = loaded();
  const notices: UpsertNotice[] = [];
  store.on("tab_upserted", (_tab, _index, notice) => notices.push(notice));
  const imported = store.importBoard({ templates: [], pages: [
    { title: "Open import", html: "<p>open</p>" },
    { title: "Closed import", html: "<p>closed</p>", closedAt: 1 },
  ] }, "meta");
  assert.equal(notices.length, 2);
  assert.ok(notices.every(notice => notice.structural && notice.markUnread === false));

  const files = path.join(dir, "files");
  fs.mkdirSync(files);
  fs.writeFileSync(path.join(files, "one.md"), "one");
  fs.writeFileSync(path.join(files, "two.md"), "two");
  notices.length = 0;
  assert.equal(store.openDiskFolder(files, null).pages, 2);
  assert.equal(notices.filter(notice => notice.structural).length, 2);
  assert.ok(notices.filter(notice => notice.structural).every(notice => notice.markUnread === false));

  notices.length = 0;
  store.upsert({ key: imported.tabs[0].key, title: "Updated", html: "<p>changed</p>", activate: false });
  store.upsert({ title: "Agent page", html: "<p>new</p>", activate: false });
  assert.equal(notices.length, 2);
  assert.ok(notices.every(notice => notice.structural && notice.markUnread !== false));
  store.closeDb();
});

test("closed boards retain blocked form continuations across restart and dispatch after blockers clear", async () => {
  const store = loaded();
  const { tab } = store.openFromTemplate("builtin:kanban", { title: "Deferred", preset: "agent" });
  store.writeState(tab.id, { ops: [
    { op: "set", path: "columns", value: [{ id: "ready", role: "agent" }, { id: "input" }, { id: "work", role: "working" }, { id: "done", role: "done" }] },
    { op: "set", path: "settings", value: { workerInstructions: "Do the work", workers: { sol: { name: "Sol", mode: "board", run: { since: 1 } } } } },
    { op: "set", path: "cards", value: [
      { id: "c1", num: 1, title: "Work", col: "input", from: "ready", assignee: "Sol", comments: [], blockedBy: ["c2"] },
      { id: "c2", num: 2, title: "Blocker", col: "input" },
    ] },
  ] });
  store.setPagePermission(tab.id, "agent.unattended", "allow");
  const { tab: form } = store.upsert({ title: "Decision", html: "<p>Answers</p>" });
  store.setReplyTo(form.id, { page: tab.id, card: 1 });
  assert.equal(store.receiveReply(form.id, { data: { choice: "A" } }).deliver, undefined);
  store.closeTab(tab.id);
  store.closeDb();
  const again = loaded();
  const launches: unknown[] = [];
  const context = { now: Date.now(), thread: () => ({ exists: false as const }), sessionSeenAt: () => undefined, watch: () => false, release: () => {} };
  const launch = async (_page: string, item: unknown, validate: () => void) => { validate(); launches.push(item); return "new"; };
  again.driveActions(context, launch);
  assert.equal(launches.length, 0);
  again.runAction(tab.id, "move", { card: 2, to: "done" }, { by: "user" });
  again.driveActions(context, launch);
  // Another simultaneous pass sees the lease and cannot launch it again.
  again.driveActions(context, launch);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches.length, 1);
  const saved = (again.get(tab.id)!.state.cards as any[]).find(c => c.num === 1);
  assert.equal(saved.col, "work");
  assert.equal(saved.continuation, undefined);
  assert.equal(saved.claim.thread, "new");
  assert.match(saved.comments[0].text, /choice/);
  again.closeDb();
});

test("open tabs sort pinned first, then strip_seq", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.update("c", { pin: true, activate: false });
  assert.deepEqual(titles(store), ["C", "A", "B"]);
  store.update("c", { pin: false, activate: false });
  assert.deepEqual(titles(store), ["A", "B", "C"]);
  store.closeDb();
});

test("unpin restores the tab's original strip hole", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.update("b", { pin: true, activate: false });
  assert.deepEqual(titles(store), ["B", "A", "C"]);
  store.update("b", { pin: false, activate: false });
  assert.deepEqual(titles(store), ["A", "B", "C"]);
  store.closeDb();
});

test("pinned tabs follow strip_seq within the pinned group", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.update("c", { pin: true, activate: false });
  store.update("a", { pin: true, activate: false });
  assert.deepEqual(titles(store), ["A", "C", "B"]);
  store.closeDb();
});

test("persists strip order across reload", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.update("a", { pin: true, activate: false });
  store.persist();
  store.closeDb();
  const again = loaded();
  assert.deepEqual(titles(again), ["A", "B"]);
  again.closeDb();
});

test("Ctrl+Z keeps strip_seq so the tab returns to its hole", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.closeTab("b");
  assert.deepEqual(titles(store), ["A", "C"]);
  store.restoreLast();
  assert.deepEqual(titles(store), ["A", "B", "C"]);
  store.closeDb();
});

test("closing the active tab focuses its right neighbor, or the left one when rightmost", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.focus("b");
  const activeTitle = () => store.snapshot().tabs.find((tab) => tab.id === store.snapshot().activeId)?.title;
  store.closeTab("b");
  assert.equal(activeTitle(), "C");
  store.closeTab("c");
  assert.equal(activeTitle(), "A");
  store.closeDb();
});

test("opening a closed page assigns a new seq and appends", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.closeTab("b");
  store.restore("b", { placement: "append", activate: false });
  assert.deepEqual(titles(store), ["A", "C", "B"]);
  store.closeDb();
});

test("focus does not change strip order", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.focus("a");
  assert.deepEqual(titles(store), ["A", "B"]);
  store.closeDb();
});

test("toMeta omits stripSeq", () => {
  const store = loaded();
  const { tab } = store.upsert({ title: "A", html: "<p>a</p>" });
  assert.equal("stripSeq" in toMeta(tab), false);
  assert.equal(typeof tab.stripSeq, "number");
  store.closeDb();
});

test("swapStripSeq reorders two unpinned tabs and persists", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.persist();
  store.swapStripSeq("a", "b");
  assert.deepEqual(titles(store), ["B", "A", "C"]);
  store.persist();
  assert.equal(store.snapshot().persistError, null);
  store.closeDb();
  const again = loaded();
  assert.deepEqual(titles(again), ["B", "A", "C"]);
  again.closeDb();
});

test("swapStripSeq reorders two pinned tabs", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.update("a", { pin: true, activate: false });
  store.update("b", { pin: true, activate: false });
  assert.deepEqual(titles(store), ["A", "B", "C"]);
  store.swapStripSeq("a", "b");
  assert.deepEqual(titles(store), ["B", "A", "C"]);
  store.closeDb();
});

test("swapStripSeq rejects a cross-group pair", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.update("a", { pin: true, activate: false });
  assert.throws(() => store.swapStripSeq("a", "b"), /pin groups/);
  assert.deepEqual(titles(store), ["A", "B"]);
  store.closeDb();
});

test("swapStripSeq rejects a closed page", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.closeTab("a");
  assert.throws(() => store.swapStripSeq("a", "b"), /closed/);
  store.closeDb();
});

test("reorderTab after persist walks adjacent swaps without unique collisions", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.upsert({ title: "D", html: "<p>d</p>" });
  store.persist();
  store.reorderTab("a", null);
  assert.deepEqual(titles(store), ["B", "C", "D", "A"]);
  store.persist();
  assert.equal(store.snapshot().persistError, null);
  store.closeDb();
  const again = loaded();
  assert.deepEqual(titles(again), ["B", "C", "D", "A"]);
  again.closeDb();
});

test("persist remints duplicate strip_seq instead of failing", () => {
  const store = loaded();
  const a = store.upsert({ title: "A", html: "<p>a</p>" });
  const b = store.upsert({ title: "B", html: "<p>b</p>" });
  store.persist();
  b.tab.stripSeq = a.tab.stripSeq;
  store.persist();
  assert.equal(store.snapshot().persistError, null);
  assert.notEqual(a.tab.stripSeq, b.tab.stripSeq);
  store.closeDb();
  const again = loaded();
  assert.deepEqual(titles(again), ["A", "B"]);
  const seqs = again.listOpenTabs().map((tab) => tab.stripSeq);
  assert.equal(new Set(seqs).size, seqs.length);
  again.closeDb();
});

test("reorderTab walks adjacent swaps to the end of the group", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.upsert({ title: "D", html: "<p>d</p>" });
  store.reorderTab("a", null);
  assert.deepEqual(titles(store), ["B", "C", "D", "A"]);
  const seqs = store.listOpenTabs().map((tab) => tab.stripSeq);
  assert.equal(new Set(seqs).size, seqs.length);
  store.closeDb();
});

test("reorderTab stays inside the pinned group", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.upsert({ title: "D", html: "<p>d</p>" });
  store.update("a", { pin: true, activate: false });
  store.update("b", { pin: true, activate: false });
  store.reorderTab("a", null);
  assert.deepEqual(titles(store), ["B", "A", "C", "D"]);
  store.closeDb();
});

test("reorderTab does not steal a closed tab's strip hole", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.upsert({ title: "D", html: "<p>d</p>" });
  store.closeTab("b");
  store.reorderTab("a", null);
  assert.deepEqual(titles(store), ["C", "D", "A"]);
  store.restoreLast();
  assert.deepEqual(titles(store), ["C", "B", "D", "A"]);
  const seqs = store.listOpenTabs().map((tab) => tab.stripSeq);
  assert.equal(new Set(seqs).size, seqs.length);
  store.closeDb();
});

test("pin does not steal a closed tab's strip_seq", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.closeTab("a");
  store.update("c", { pin: true, activate: false });
  store.update("c", { pin: false, activate: false });
  store.restoreLast();
  assert.deepEqual(titles(store), ["A", "B", "C"]);
  const seqs = store.listOpenTabs().map((tab) => tab.stripSeq);
  assert.equal(new Set(seqs).size, seqs.length);
  store.closeDb();
});

test("migrates state.json once into scribe.sqlite", () => {
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      activeId: "t_aaa",
      tabs: [
        {
          id: "t_aaa",
          key: "alpha",
          title: "Alpha",
          html: "<p>a</p>",
          pinned: true,
          createdAt: 1,
          updatedAt: 1,
          revision: 1,
          state: {},
          stateRevision: 0,
          stateUpdatedAt: 0,
          assets: [],
        },
        {
          id: "t_bbb",
          key: "beta",
          title: "Beta",
          html: "<p>b</p>",
          pinned: false,
          createdAt: 2,
          updatedAt: 2,
          revision: 1,
          state: {},
          stateRevision: 0,
          stateUpdatedAt: 0,
          assets: [],
        },
      ],
    })
  );
  const store = loaded();
  assert.deepEqual(titles(store), ["Alpha", "Beta"]);
  assert.equal(fs.existsSync(path.join(dir, "scribe.sqlite")), true);
  assert.equal(fs.existsSync(path.join(dir, "state.json.bak")), true);
  assert.equal(fs.existsSync(path.join(dir, "state.json")), false);
  store.closeDb();
  const again = loaded();
  assert.deepEqual(titles(again), ["Alpha", "Beta"]);
  again.closeDb();
});

test("closing welcome discards it instead of keeping it in the Library", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ key: "welcome", title: "Welcome", html: "<p>help</p>" });
  store.closeTab("welcome");
  assert.deepEqual(titles(store), ["A"]);
  assert.equal(store.closedCount(), 0);
  assert.equal(store.get("welcome"), undefined);
  assert.throws(() => store.restoreLast(), /nothing to restore/);
  store.closeDb();
});

test("Ctrl+Z after closing welcome reopens a real closed tab", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ key: "welcome", title: "Welcome", html: "<p>help</p>" });
  store.closeTab("a");
  store.closeTab("welcome");
  assert.equal(store.closedCount(), 1);
  store.restoreLast();
  assert.deepEqual(titles(store), ["A"]);
  store.closeDb();
});

test("Clear discards welcome and closes other unpinned tabs", () => {
  const store = loaded();
  store.upsert({ key: "welcome", title: "Welcome", html: "<p>help</p>" });
  store.upsert({ title: "A", html: "<p>a</p>" });
  const closed = store.closeMany("unpinned");
  assert.equal(store.get("welcome"), undefined);
  assert.equal(closed.length, 1);
  assert.equal(store.closedCount(), 1);
  assert.equal(store.listClosedTabs()[0].title, "A");
  assert.equal(store.listClosedTabs()[0].id, closed[0]);
  store.closeDb();
});

test("load drops closed welcome tabs", () => {
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      activeId: "t_aaa",
      tabs: [
        {
          id: "t_aaa",
          key: "alpha",
          title: "Alpha",
          html: "<p>a</p>",
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
          revision: 1,
          state: {},
          stateRevision: 0,
          stateUpdatedAt: 0,
          assets: [],
        },
      ],
      archive: [
        {
          tab: {
            id: "t_www",
            key: "welcome",
            title: "Welcome",
            html: "<p>help</p>",
            pinned: false,
            createdAt: 2,
            updatedAt: 2,
            revision: 1,
            state: {},
            stateRevision: 0,
            stateUpdatedAt: 0,
            assets: [],
          },
        },
      ],
    })
  );
  const store = loaded();
  assert.deepEqual(titles(store), ["Alpha"]);
  assert.equal(store.closedCount(), 0);
  store.closeDb();
  const again = loaded();
  assert.equal(again.closedCount(), 0);
  assert.equal(again.get("welcome"), undefined);
  again.closeDb();
});

test("export then import restores html, state, and pin without overwriting", () => {
  const store = loaded();
  const { tab } = store.upsert({
    key: "todos",
    title: "Todos",
    html: "<p>list</p>",
    pin: true,
    state: { items: ["a"] },
  });
  const pack = store.exportFile({ id: tab.id });
  assert.equal(pack.pages.length, 1);
  assert.deepEqual(pack.pages[0].state, { items: ["a"] });
  const copy = store.importBoard(
    {
      templates: [],
      pages: pack.pages.map((page) => ({
        key: page.key,
        title: page.title,
        html: page.html,
        pinned: page.pinned,
        state: page.state,
      })),
    },
    "meta"
  );
  assert.equal(copy.opened, 1);
  assert.equal(copy.closed, 0);
  const original = store.get("todos");
  const imported = store.get(copy.tabs[0].id);
  assert.ok(original);
  assert.ok(imported);
  assert.notEqual(imported.id, original.id);
  assert.notEqual(imported.key, "todos");
  assert.equal(imported.title, "Todos");
  assert.equal(imported.pinned, true);
  assert.match(imported.html, /<p>list<\/p>/);
  assert.deepEqual(imported.state, { items: ["a"] });
  assert.deepEqual(original.state, { items: ["a"] });
  store.closeDb();
});

test("import destination follows closedAt unless forced closed", () => {
  const store = loaded();
  const open = store.importBoard({ templates: [], pages: [{ title: "Open", html: "<p>o</p>" }] }, "meta");
  const fromMeta = store.importBoard(
    { templates: [], pages: [{ title: "Was closed", html: "<p>a</p>", closedAt: 50 }] },
    "meta"
  );
  const forced = store.importBoard({ templates: [], pages: [{ title: "Forced", html: "<p>f</p>" }] }, "closed");
  assert.equal(open.opened, 1);
  assert.equal(fromMeta.closed, 1);
  assert.equal(fromMeta.opened, 0);
  assert.equal(forced.closed, 1);
  assert.equal(store.get(fromMeta.tabs[0].id)?.closedAt, 50);
  assert.ok(store.get(forced.tabs[0].id)?.closedAt);
  assert.equal(store.list().some((tab) => tab.title === "Forced"), false);
  store.closeDb();
});

test("export all skips the welcome page", () => {
  const store = loaded();
  store.upsert({ key: "welcome", title: "Welcome", html: "<p>help</p>" });
  store.upsert({ title: "Keep", html: "<p>k</p>" });
  const pack = store.exportFile();
  assert.deepEqual(
    pack.pages.map((page) => page.title),
    ["Keep"]
  );
  store.closeDb();
});

test("template open creates a pinned bound page and blocks html edits", () => {
  const store = loaded();
  const { template } = store.upsertTemplate({
    key: "todo",
    title: "Todo",
    html: "<h1>{{title}}</h1><p>{{item}}</p>",
    fields: [
      { key: "title", label: "Title", type: "text", required: true },
      { key: "item", label: "Item", type: "text", default: "task" },
    ],
    titleTemplate: "{{title}}",
    initialState: { todos: [] },
  });
  const { tab } = store.openFromTemplate(template.key, { title: "Shopping" });
  assert.equal(tab.pinned, true);
  assert.equal(tab.title, "Shopping");
  assert.match(tab.html, /Shopping/);
  assert.equal(tab.templateId, template.id);
  assert.deepEqual(tab.state, { todos: [] });
  assert.throws(() => store.upsert({ key: tab.key, title: "X", html: "<p>nope</p>" }), /bound to template/);
  assert.throws(() => store.patchHtml(tab.id, { edits: [{ oldString: "<h1>", newString: "<h2>" }] }), /bound to template/);
  store.closeDb();
});

test("a template with pin false opens its pages unpinned", () => {
  const store = loaded();
  const { template } = store.upsertTemplate({ key: "doc", title: "Doc", html: "<p>doc</p>", pin: false });
  assert.equal(store.openFromTemplate(template.key, {}).tab.pinned, false);
  assert.equal(store.templateMeta(template, 0).pin, false);
  // An upsert without pin keeps the setting, and it survives a reload.
  store.upsertTemplate({ key: "doc", title: "Doc", html: "<p>doc 2</p>" });
  store.closeDb();
  const again = loaded();
  assert.equal(again.openFromTemplate("doc", {}).tab.pinned, false);
  again.upsertTemplate({ key: "doc", title: "Doc", html: "<p>doc 2</p>", pin: true });
  assert.equal(again.openFromTemplate("doc", {}).tab.pinned, true);
  // Built-ins: the note is page-like, the board is app-like.
  assert.equal(again.openFromTemplate("builtin:markdown-note", {}).tab.pinned, false);
  assert.equal(again.openFromTemplate("builtin:kanban", { title: "Board" }).tab.pinned, true);
  again.closeDb();
});

test("patchHtml with html replaces the body but keeps state and events", () => {
  const store = loaded();
  const { tab } = store.upsert({ key: "page", title: "Page", html: "<!DOCTYPE html><p>old</p>", state: { n: 1 } });
  store.logEvent("page", { name: "submitted", by: "user" });
  const { tab: patched, applied } = store.patchHtml("page", {
    html: "<!DOCTYPE html><p>new</p>",
    expectedRevision: tab.revision,
  });
  assert.equal(applied, 1);
  assert.equal(patched.html, "<!DOCTYPE html><p>new</p>");
  assert.equal(patched.revision, 2);
  assert.deepEqual(patched.state, { n: 1 });
  assert.equal(patched.events.at(-1)?.name, "submitted");
  store.closeDb();
});

test("patchHtml refuses a stale expectedRevision and changes nothing", () => {
  const store = loaded();
  store.upsert({ key: "page", title: "Page", html: "<p>a</p>" });
  store.patchHtml("page", { edits: [{ oldString: "<p>a</p>", newString: "<p>b</p>" }] });
  assert.throws(
    () => store.patchHtml("page", { html: "<p>clobber</p>", expectedRevision: 1 }),
    (err: unknown) => err instanceof RevisionConflictError && /since revision 1 \(now 2\)/.test(err.message)
  );
  assert.throws(
    () => store.update("page", { title: "Renamed", expectedRevision: 1 }),
    (err: unknown) => err instanceof RevisionConflictError
  );
  const tab = store.get("page")!;
  assert.match(tab.html, /<p>b<\/p>/);
  assert.equal(tab.title, "Page");
  store.closeDb();
});

test("upsert refuses to replace a page whose revision moved past expectedRevision", () => {
  const store = loaded();
  store.upsert({ key: "page", title: "Page", html: "<p>a</p>" });
  store.patchHtml("page", { edits: [{ oldString: "<p>a</p>", newString: "<p>user</p>" }] });
  assert.throws(
    () => store.upsert({ key: "page", title: "Page", html: "<p>agent</p>", expectedRevision: 1 }),
    (err: unknown) => err instanceof RevisionConflictError
  );
  assert.match(store.get("page")!.html, /<p>user<\/p>/);
  store.upsert({ key: "page", title: "Page", html: "<p>agent</p>", expectedRevision: 2 });
  assert.match(store.get("page")!.html, /<p>agent<\/p>/);
  // A new key has nothing to conflict with.
  assert.equal(store.upsert({ key: "fresh", title: "Fresh", html: "<p>x</p>", expectedRevision: 7 }).created, true);
  store.closeDb();
});

test("patchHtml rejects edits and html together", () => {
  const store = loaded();
  store.upsert({ key: "page", title: "Page", html: "<p>a</p>" });
  assert.throws(
    () => store.patchHtml("page", { html: "<p>b</p>", edits: [{ oldString: "a", newString: "c" }] }),
    /either edits or html/
  );
  store.closeDb();
});

test("updating a template re-renders instances and can mark them incompatible", () => {
  const store = loaded();
  store.upsertTemplate({
    key: "todo",
    title: "Todo",
    html: "<h1>{{title}}</h1>",
    fields: [{ key: "title", label: "Title", type: "text", required: true }],
    stateVersion: 1,
  });
  const { tab } = store.openFromTemplate("todo", { title: "A" });
  store.upsertTemplate({
    key: "todo",
    title: "Todo",
    html: "<h1>{{title}}</h1><p>v2</p>",
    fields: [{ key: "title", label: "Title", type: "text", required: true }],
    stateVersion: 2,
  });
  const again = store.get(tab.id);
  assert.ok(again);
  assert.match(again.html, /v2/);
  assert.equal(again.templateCompatible, false);
  const resolved = store.writeState(tab.id, { ops: [{ op: "set", path: "todos", value: [] }], resolveIncompatibility: true });
  assert.equal(resolved.ok, true);
  assert.equal(store.get(tab.id)?.templateCompatible, true);
  store.closeDb();
});

test("deleting a template unlinks pages and they stay editable", () => {
  const store = loaded();
  store.upsertTemplate({
    key: "todo",
    title: "Todo",
    html: "<h1>{{title}}</h1>",
    fields: [{ key: "title", label: "Title", type: "text", required: true }],
  });
  const { tab } = store.openFromTemplate("todo", { title: "A" });
  store.deleteTemplate("todo");
  const leftover = store.get(tab.id);
  assert.ok(leftover);
  assert.equal(leftover.templateId, undefined);
  const { tab: updated } = store.update(tab.id, { html: "<p>free</p>", activate: false });
  assert.match(updated.html, /<p>free<\/p>/);
  store.closeDb();
});

test("templates persist across reload", () => {
  const store = loaded();
  store.upsertTemplate({
    key: "todo",
    title: "Todo",
    html: "<h1>{{title}}</h1>",
    fields: [{ key: "title", label: "Title", type: "text", required: true }],
  });
  const { tab } = store.openFromTemplate("todo", { title: "Shop" });
  store.persist();
  store.closeDb();
  const again = loaded();
  assert.equal(again.getTemplate("todo")?.title, "Todo");
  assert.equal(again.get(tab.id)?.templateId, again.getTemplate("todo")?.id);
  assert.equal(again.get(tab.id)?.templateValues?.title, "Shop");
  again.closeDb();
});

function todoTemplate(store: BoardStore, html = "<h1>{{title}}</h1>", stateVersion = 1) {
  return store.upsertTemplate({
    key: "todo",
    title: "Todo",
    html,
    fields: [
      { key: "title", label: "Title", type: "text", required: true },
      { key: "columns", label: "Columns", type: "number", default: 3 },
    ],
    titleTemplate: "{{title}}",
    initialState: { todos: [] },
    stateVersion,
  }).template;
}

function roundTrip(pack: ReturnType<BoardStore["exportFile"]>) {
  return parseImport(serializeExport(pack), "pack.scribe.json");
}

function otherBoard(): BoardStore {
  process.env.SCRIBE_HOME = fs.mkdtempSync(path.join(dir, "other-"));
  return loaded();
}

test("exporting a templated page includes its template and binding", () => {
  const store = loaded();
  const template = todoTemplate(store);
  store.upsertTemplate({ key: "unused", title: "Unused", html: "<p>u</p>" });
  const { tab } = store.openFromTemplate("todo", { title: "Shop", columns: 4 });
  const single = store.exportFile({ id: tab.id });
  assert.deepEqual(single.templates.map((item) => item.id), [template.id]);
  assert.deepEqual(single.pages[0].template, {
    templateId: template.id,
    values: { title: "Shop", columns: 4 },
    stateVersion: 1,
    compatible: true,
  });
  assert.equal(store.exportFile().templates.length, 2);
  store.closeDb();
});

test("importing a templated page on another board recreates the template and binds the page", () => {
  const source = loaded();
  const template = todoTemplate(source);
  const { tab } = source.openFromTemplate("todo", { title: "Shop", columns: 4 });
  const parsed = roundTrip(source.exportFile({ id: tab.id }));
  source.closeDb();

  const target = otherBoard();
  const result = target.importBoard(parsed, "meta");
  assert.equal(result.templatesCreated, 1);
  assert.equal(result.templatesReused, 0);
  const created = target.getTemplate("todo");
  assert.equal(created?.id, template.id);
  const imported = target.get(result.tabs[0].id)!;
  assert.equal(imported.templateId, template.id);
  assert.deepEqual(imported.templateValues, { title: "Shop", columns: 4 });
  assert.throws(() => target.update(imported.id, { html: "<p>x</p>" }), /bound to template/);
  todoTemplate(target, "<h1>{{title}}</h1><p>v2</p>");
  assert.match(target.get(imported.id)!.html, /v2/);
  target.persist();
  target.closeDb();
});

test("importing a template the board already has reuses it, even repeatedly", () => {
  const store = loaded();
  const template = todoTemplate(store);
  const { tab } = store.openFromTemplate("todo", { title: "Shop" });
  const parsed = roundTrip(store.exportFile({ id: tab.id }));
  const first = store.importBoard(parsed, "meta");
  const second = store.importBoard(parsed, "meta");
  assert.equal(first.templatesCreated + second.templatesCreated, 0);
  assert.equal(second.templatesReused, 1);
  assert.equal(store.listTemplates().length, 1);
  assert.equal(store.get(second.tabs[0].id)?.templateId, template.id);
  assert.equal(store.listTemplates()[0].instanceCount, 3);
  store.closeDb();
});

test("a same-id template with different content is imported as a separate template once", () => {
  const store = loaded();
  const template = todoTemplate(store);
  const { tab } = store.openFromTemplate("todo", { title: "Shop" });
  const parsed = roundTrip(store.exportFile({ id: tab.id }));
  todoTemplate(store, "<h1>{{title}}</h1><p>local edit</p>");

  const first = store.importBoard(parsed, "meta");
  assert.equal(first.templatesCreated, 1);
  const copy = store.get(first.tabs[0].id)!;
  assert.notEqual(copy.templateId, template.id);
  const copyTemplate = store.getTemplate(copy.templateId!)!;
  assert.notEqual(copyTemplate.key, "todo");
  assert.doesNotMatch(copy.html, /local edit/);

  const second = store.importBoard(parsed, "meta");
  assert.equal(second.templatesCreated, 0);
  assert.equal(store.get(second.tabs[0].id)?.templateId, copyTemplate.id);
  assert.equal(store.listTemplates().length, 2);
  store.closeDb();
});

test("import keeps a page's incompatible flag and state version", () => {
  const store = loaded();
  todoTemplate(store);
  const { tab } = store.openFromTemplate("todo", { title: "Shop" });
  todoTemplate(store, "<h1>{{title}}</h1>", 2);
  const parsed = roundTrip(store.exportFile({ id: tab.id }));
  const result = store.importBoard(parsed, "meta");
  const imported = store.get(result.tabs[0].id)!;
  assert.equal(imported.templateCompatible, false);
  assert.equal(imported.templateStateVersion, store.get(tab.id)?.templateStateVersion);
  assert.match(imported.templateIncompatibleReason ?? "", /template changed/);
  store.closeDb();
});

test("export all with only templates round-trips to another board", () => {
  const source = loaded();
  todoTemplate(source);
  const parsed = roundTrip(source.exportFile());
  assert.equal(parsed.pages.length, 0);
  source.closeDb();
  const target = otherBoard();
  const result = target.importBoard(parsed, "meta");
  assert.equal(result.templatesCreated, 1);
  assert.equal(result.tabs.length, 0);
  assert.equal(target.getTemplate("todo")?.title, "Todo");
  target.closeDb();
});

test("exporting one template excludes pages, folders and other templates and round-trips its definition", () => {
  const source = loaded();
  todoTemplate(source);
  const { template } = source.upsertTemplate({
    key: "portable", title: "Portable", html: "<h1>{{title}}</h1>",
    fields: [{ key: "title", label: "Title", type: "text", default: "New" }],
    titleTemplate: "{{title}} board", initialState: { items: [] }, stateVersion: 3,
    guide: "Keep the items in state.", pin: false,
    agentActions: [{ id: "summarise", label: "Summarise", prompt: "Summarise {{page.title}}." }],
  });
  source.openFromTemplate(template.id, { title: "Existing" });
  source.createFolder({ name: "Unrelated" });
  const file = source.exportFile({ templateId: template.id });
  assert.deepEqual(file.templates, [template]);
  assert.deepEqual(file.pages, []);
  assert.equal(file.folders, undefined);
  assert.throws(() => source.exportFile({ templateId: "missing" }), /template not found/);
  const parsed = roundTrip(file);
  source.closeDb();
  const target = otherBoard();
  const result = target.importBoard(parsed, "meta");
  assert.equal(result.templatesCreated, 1);
  assert.equal(result.tabs.length, 0);
  const imported = target.getTemplate("portable")!;
  assert.equal(templateFingerprint(imported), templateFingerprint(template));
  assert.equal(imported.guide, template.guide);
  assert.equal(imported.pin, false);
  target.closeDb();
});

test("export all with only welcome throws", () => {
  const store = loaded();
  store.upsert({ key: "welcome", title: "Welcome", html: "<p>help</p>" });
  assert.throws(() => store.exportFile(), /nothing to export/);
  store.closeDb();
});

test("tabs hidden from the agent vanish from every agent listing", () => {
  const store = loaded();
  store.upsert({ key: "open", title: "Open secret", html: "<p>alpha</p>" });
  store.upsert({ key: "shown", title: "Shown", html: "<p>alpha</p>" });
  store.upsert({ key: "old", title: "Old secret", html: "<p>alpha</p>" });
  store.closeTab("old");
  store.focus("open");
  store.setAgentHidden("open", true);
  store.setAgentHidden("old", true);

  assert.deepEqual(store.list("agent").map((tab) => tab.key), ["scribe:shown"]);
  assert.equal(store.list("user").length, 2);
  assert.equal(store.closedCount("agent"), 0);
  assert.equal(store.closedCount("user"), 1);
  assert.equal(store.getActiveId("agent"), null);
  assert.equal(store.getActiveId("user"), store.get("open")?.id);
  assert.equal(store.get("open", "agent"), undefined);
  assert.equal(store.get("old", "agent"), undefined);
  assert.deepEqual(store.searchOpen("alpha", "agent").hits.map((hit) => hit.tab.key), ["scribe:shown"]);
  assert.deepEqual(store.searchLibrary("alpha", { viewer: "agent" }).hits.map((hit) => hit.tab.key), ["scribe:shown"]);
  assert.deepEqual(store.searchPages("alpha", undefined, "agent").hits.map((hit) => hit.tab.key), ["scribe:shown"]);
  store.closeDb();
});

test("an agent writing a hidden tab's key gets a separate tab", () => {
  const store = loaded();
  store.upsert({ key: "page", title: "Private", html: "<p>mine</p>" });
  store.setAgentHidden("page", true);
  const { tab, created } = store.upsert({ key: "page", title: "Agent", html: "<p>theirs</p>", viewer: "agent" });
  assert.equal(created, true);
  assert.notEqual(tab.key, "page");
  assert.match(store.get("page")!.html, /mine/);
  store.closeDb();
});

test("agent bulk close skips hidden tabs", () => {
  const store = loaded();
  store.upsert({ key: "a", title: "A", html: "<p>a</p>" });
  store.upsert({ key: "b", title: "B", html: "<p>b</p>" });
  store.setAgentHidden("a", true);
  store.closeMany("all", "agent");
  assert.deepEqual(titles(store), ["A"]);
  store.closeDb();
});

test("hide-from-agent persists and survives export and import", () => {
  const store = loaded();
  store.upsert({ key: "page", title: "Page", html: "<p>p</p>" });
  store.setAgentHidden("page", true);
  store.closeDb();

  const again = loaded();
  assert.equal(again.get("page")?.agentHidden, true);
  const parsed = parseImport(serializeExport(again.exportFile({ id: "page" })));
  const copy = again.importBoard(parsed, "meta");
  assert.equal(copy.tabs[0].agentHidden, true);
  again.setAgentHidden("page", false);
  assert.equal(again.get("scribe:page", "agent")?.key, "scribe:page");
  again.closeDb();
});

test("folder settings inherit, appear in listings, persist, and clear", () => {
  const store = loaded();
  const work = store.createFolder({ name: "Work" });
  const child = store.createFolder({ name: "Releases", parentId: work.id });
  store.upsert({ title: "Instructions", html: "<p>Page titles are ordinary now</p>", folder: "Work" });
  assert.deepEqual(store.folderInstructionsFor(child.id), []);
  store.setFolderInstructions(work.id, "Work summary", "Parent rule");
  store.setFolderInstructions(child.id, "Release summary", "Child rule");
  assert.deepEqual(store.folderInstructionsFor(child.id).map((item) => item.text), ["Parent rule", "Child rule"]);
  assert.equal(store.folderTree("agent")[0].description, "Work summary");
  store.closeDb();
  const again = loaded();
  assert.equal(again.folderInstructionsFor(child.id)[1].description, "Release summary");
  const exported = parseImport(serializeExport(again.exportFile({ folderId: work.id })));
  assert.equal(exported.folders?.find((folder) => folder.path === "Work/Releases")?.instructions, "Child rule");
  again.setFolderInstructions(child.id, "", "");
  assert.equal(again.folderInstructionsFor(child.id).length, 1);
  again.setFolderInstructions(work.id, "Description only", "");
  assert.equal(again.folderInstructionsFor(child.id)[0].description, "Description only");
  again.importBoard(exported, "meta");
  assert.equal(again.folderInstructionsFor(child.id)[1].text, "Child rule");
  again.closeDb();
});

test("a mixed Library selection exports only its pages and subtrees and deletes as one restorable batch", () => {
  const store = loaded();
  const work = store.createFolder({ name: "Work" });
  const child = store.createFolder({ name: "Child", parentId: work.id });
  const empty = store.createFolder({ name: "Empty" });
  store.setFolderInstructions(child.id, "Child description", "Child instructions");
  const a = store.upsert({ key: "a", title: "A", html: "<p>A</p>", folder: "Work" }).tab;
  const b = store.upsert({ key: "b", title: "B", html: "<p>B</p>", folder: "Work/Child" }).tab;
  const x = store.upsert({ key: "x", title: "X", html: "<p>X</p>" }).tab;
  const y = store.upsert({ key: "y", title: "Y", html: "<p>Y</p>" }).tab;
  const pack = store.exportFile({ pageIds: [a.id, x.id, x.id], folderIds: [work.id, child.id, empty.id] });
  assert.deepEqual(new Set(pack.pages.map(page => page.key)), new Set([a.key, b.key, x.key]));
  assert.deepEqual(pack.folders?.map(folder => folder.path).sort(), ["Empty", "Work", "Work/Child"]);
  assert.equal(pack.folders?.find(folder => folder.path === "Work/Child")?.instructions, "Child instructions");
  assert.throws(() => store.exportFile({ pageIds: [], folderIds: [] }), /nothing to export/);
  assert.throws(() => store.exportFile({ folderIds: ["missing"] }), /folder not found/);
  const deleted = store.deleteMany([a.id, x.id], [work.id, child.id, empty.id]);
  assert.deepEqual(new Set(deleted.map(tab => tab.id)), new Set([a.id, b.id, x.id]));
  assert.equal(store.listFolders().length, 0);
  assert.equal(store.get(y.id)?.title, "Y");
  store.restoreLast();
  assert.equal(store.listFolders().length, 3);
  for (const tab of [a, b, x, y]) assert.ok(store.get(tab.id));
  assert.equal(store.listFolders().find(folder => folder.id === child.id)?.parentId, work.id);
  store.closeDb();
});

test("an empty folder's settings survive export and import", () => {
  const store = loaded();
  const folder = store.createFolder({ name: "Empty" });
  store.setFolderInstructions(folder.id, "Future work", "Ask before adding pages.");
  const parsed = parseImport(serializeExport(store.exportFile({ folderId: folder.id })));
  assert.equal(parsed.pages.length, 0);
  store.deleteFolder(folder.id, "lift");
  store.importBoard(parsed, "meta");
  const imported = store.listFolders().find((item) => item.name === "Empty")!;
  assert.equal(imported.instructions, "Ask before adding pages.");
  store.closeDb();
});

test("a template without a title field leaves the page's title alone", () => {
  const store = loaded();
  // A page made while the template still asked for a title.
  const { template } = store.upsertTemplate({
    title: "Note",
    html: "<h1>{{title}}</h1>",
    fields: [{ key: "title", label: "Title", type: "text" }],
    titleTemplate: "{{title}}",
  });
  const { tab } = store.openFromTemplate(template.id, { title: "Guide" });
  assert.equal(tab.title, "Guide");
  // The template drops the field: the page keeps the title it had, and a rename survives a re-render.
  store.upsertTemplate({ id: template.id, title: "Note", html: "<h1></h1>", fields: [] });
  assert.equal(store.get(tab.id)?.title, "Guide");
  store.renamePage(tab.id, "Mine");
  store.upsertTemplate({ id: template.id, title: "Note", html: "<h1>x</h1>", fields: [] });
  assert.equal(store.get(tab.id)?.title, "Mine");
  assert.equal(store.openFromTemplate(template.id, {}).tab.title, "Note");
  store.closeDb();
});

test("agent page writes record created-by and last-changed-by", () => {
  const store = loaded();
  const actor = { thread: "th_abc", title: "Fix provenance", at: 1_700_000_000_000 };
  const { tab } = store.upsert({
    key: "notes",
    title: "Notes",
    html: "<p>a</p>",
    viewer: "agent",
    actor,
  });
  assert.equal(tab.provenance?.created?.thread, "th_abc");
  assert.equal(tab.provenance?.created?.title, "Fix provenance");
  assert.equal(tab.provenance?.changed?.thread, "th_abc");
  assert.equal(toMeta(tab).provenance?.created?.thread, "th_abc");

  const later = { thread: "th_def", title: "Follow-up", at: 1_700_000_100_000 };
  store.upsert({ key: "notes", title: "Notes", html: "<p>hello</p>", viewer: "agent", actor: later });
  const updated = store.get("notes")!;
  assert.equal(updated.provenance?.created?.thread, "th_abc");
  assert.equal(updated.provenance?.changed?.thread, "th_def");
  assert.equal(updated.provenance?.changed?.title, "Follow-up");

  store.patchHtml("notes", { edits: [{ oldString: "<p>hello</p>", newString: "<p>patched</p>" }], viewer: "agent", actor: { thread: "th_ghi", title: "Patch", at: 1_700_000_200_000 } });
  assert.equal(store.get("notes")?.provenance?.changed?.thread, "th_ghi");

  store.writeState("notes", { ops: [{ op: "set", path: "n", value: 1 }], actor: { thread: "th_jkl", title: "State", at: 1_700_000_300_000 } });
  assert.equal(store.get("notes")?.provenance?.changed?.thread, "th_jkl");
  store.closeDb();
});

test("user writes leave provenance alone; external agents have no thread", () => {
  const store = loaded();
  store.upsert({ key: "page", title: "Page", html: "<p>a</p>" });
  assert.equal(store.get("page")?.provenance, undefined);

  store.upsert({ key: "page", title: "Page", html: "<p>b</p>", viewer: "agent", actor: { at: 1_700_000_000_000 } });
  const tab = store.get("page")!;
  assert.equal(tab.provenance?.created, undefined);
  assert.equal(tab.provenance?.changed?.thread, undefined);
  assert.ok(tab.provenance?.changed?.at);

  store.update("page", { title: "Renamed", viewer: "user" });
  assert.equal(store.get("page")?.provenance?.changed?.thread, undefined);
  store.update("page", { pin: true, activate: false, actor: { thread: "th_nope", title: "Pin", at: 1 } });
  assert.equal(store.get("page")?.provenance?.changed?.thread, undefined);
  store.closeDb();
});

test("an activating agent write names its thread on the upsert notice", () => {
  const store = loaded();
  const notices: Array<[string, { activate: boolean; structural: boolean; thread?: string }]> = [];
  store.on("tab_upserted", (tab, _index, notice) => notices.push([tab.id, notice]));
  const actor = { thread: "th_abc", title: "Show", at: 1 };
  const { tab } = store.upsert({ key: "shown", title: "Shown", html: "<p>a</p>", viewer: "agent", actor });
  const created = notices.find(([id]) => id === tab.id);
  assert.equal(created?.[1].activate, true);
  assert.equal(created?.[1].thread, "th_abc");

  notices.length = 0;
  store.upsert({ key: "bg", title: "Bg", html: "<p>b</p>", viewer: "agent", actor, activate: false });
  assert.equal(notices[0][1].activate, false);
  assert.equal(notices[0][1].thread, "th_abc");
  store.closeDb();
});

test("page provenance persists, exports, and migrates a missing column", () => {
  const store = loaded();
  const actor = { thread: "th_abc", title: "Maker", at: 1_700_000_000_000 };
  const { tab } = store.upsert({ key: "made", title: "Made", html: "<p>a</p>", viewer: "agent", actor });
  store.closeDb();

  const again = loaded();
  assert.equal(again.get(tab.id)?.provenance?.created?.thread, "th_abc");
  assert.equal(again.get(tab.id)?.provenance?.created?.title, "Maker");
  const parsed = parseImport(serializeExport(again.exportFile({ id: tab.id })));
  const copy = again.importBoard(parsed, "meta");
  assert.equal(copy.tabs[0].provenance?.created?.thread, "th_abc");
  again.closeDb();

  const db = new DatabaseSync(path.join(dir, "scribe.sqlite"));
  db.exec("ALTER TABLE tabs DROP COLUMN provenance");
  db.close();
  const migrated = loaded();
  assert.equal(migrated.get(tab.id)?.provenance, undefined);
  migrated.upsert({ key: "made", title: "Made", html: "<p>b</p>", viewer: "agent", actor: { thread: "th_new", title: "After", at: 2 } });
  assert.equal(migrated.get("made")?.provenance?.changed?.thread, "th_new");
  migrated.closeDb();
});

const V1_SCHEMA = `
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE tabs (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  html TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('open','archived','deleted')),
  strip_seq INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  deleted_at INTEGER,
  revision INTEGER NOT NULL,
  state_revision INTEGER NOT NULL,
  state_updated_at INTEGER NOT NULL DEFAULT 0,
  signal_revision INTEGER NOT NULL DEFAULT 0,
  signal TEXT,
  assets TEXT NOT NULL DEFAULT '[]'
);
INSERT INTO meta (k, v) VALUES ('schema', '1');
`;

function insertV1Tab(db: DatabaseSync, id: string, status: string, seq: number, pinned = 0, archivedAt: number | null = null) {
  db.prepare(
    `INSERT INTO tabs (id, key, title, html, pinned, status, strip_seq, created_at, updated_at, archived_at, revision, state_revision)
     VALUES (?, ?, ?, '<p>x</p>', ?, ?, ?, 1, 1, ?, 1, 0)`
  ).run(id, id, id.toUpperCase(), pinned, status, seq, archivedAt);
}

test("a schema v1 board migrates archived tabs into the Library", () => {
  const db = new DatabaseSync(path.join(dir, "scribe.sqlite"));
  db.exec(V1_SCHEMA);
  insertV1Tab(db, "open_b", "open", 2);
  insertV1Tab(db, "open_a", "open", 3, 1);
  insertV1Tab(db, "old", "archived", 1, 0, 10);
  insertV1Tab(db, "newer", "archived", 4, 0, 20);
  db.close();

  const store = loaded();
  assert.deepEqual(titles(store), ["OPEN_A", "OPEN_B"]);
  assert.equal(store.closedCount(), 2);
  assert.equal(store.get("old")?.closedAt, 10);
  assert.equal(store.get("open_a")?.agentHidden, undefined);
  const order = store.searchLibrary("", {}).hits.map((hit) => hit.tab.key);
  assert.deepEqual(order, ["scribe:open_a", "scribe:open_b", "scribe:newer", "scribe:old"]);
  store.setAgentHidden("old", true);
  store.closeDb();

  const check = new DatabaseSync(path.join(dir, "scribe.sqlite"));
  const schema = check.prepare("SELECT v FROM meta WHERE k = 'schema'").get() as { v: string };
  check.close();
  assert.equal(schema.v, "3");
  const again = loaded();
  assert.equal(again.get("old")?.agentHidden, true);
  again.closeDb();
});

test("creating with activate:false lands in the Library, not the strip", () => {
  const store = loaded();
  const { tab: open } = store.upsert({ key: "open", title: "Open", html: "<p>a</p>" });
  const { tab, created, closed } = store.upsert({
    key: "quiet",
    title: "Quiet",
    html: "<p>q</p>",
    activate: false,
  });
  assert.equal(created, true);
  assert.equal(closed, true);
  assert.equal(store.isClosed(tab.id), true);
  assert.equal(store.isOpen(tab.id), false);
  assert.deepEqual(titles(store), ["Open"]);
  assert.equal(store.getActiveId(), open.id);
  assert.ok(tab.closedAt);
  assert.equal(store.searchLibrary("Quiet", {}).hits[0]?.tab.title, "Quiet");
  store.persist();
  store.closeDb();
  const again = loaded();
  assert.equal(again.isClosed("quiet"), true);
  assert.deepEqual(titles(again), ["Open"]);
  assert.equal(again.getActiveId(), again.get("open")?.id);
  again.closeDb();
});

test("background create on an empty strip does not open a tab", () => {
  const store = loaded();
  const { closed } = store.upsert({ key: "quiet", title: "Quiet", html: "<p>q</p>", activate: false });
  assert.equal(closed, true);
  assert.equal(store.list().length, 0);
  assert.equal(store.getActiveId(), null);
  store.closeDb();
});

test("re-showing a background-created page without activate opens it", () => {
  const store = loaded();
  store.upsert({ key: "quiet", title: "Quiet", html: "<p>q</p>", activate: false });
  const { created, closed } = store.upsert({ key: "quiet", title: "Quiet", html: "<p>q2</p>" });
  assert.equal(created, false);
  assert.equal(closed, false);
  assert.equal(store.isOpen("quiet"), true);
  store.closeDb();
});

test("re-showing a background-created page with activate:false stays closed", () => {
  const store = loaded();
  store.upsert({ key: "quiet", title: "Quiet", html: "<p>q</p>", activate: false });
  const { closed } = store.upsert({ key: "quiet", title: "Quiet", html: "<p>q2</p>", activate: false });
  assert.equal(closed, true);
  assert.equal(store.isClosed("quiet"), true);
  store.closeDb();
});

test("closing a tab keeps the page in the Library at its position", () => {
  const store = loaded();
  store.upsert({ key: "a", title: "A", html: "<p>a</p>" });
  store.upsert({ key: "b", title: "B", html: "<p>b</p>" });
  const before = store.searchLibrary("", {}).hits.map((hit) => hit.tab.key);
  assert.deepEqual(before, ["scribe:b", "scribe:a"]);
  store.closeTab("a");
  assert.deepEqual(store.searchLibrary("", {}).hits.map((hit) => hit.tab.key), before);
  assert.equal(store.isClosed("a"), true);
  store.openPage("a", { activate: false });
  assert.equal(store.isOpen("a"), true);
  assert.deepEqual(store.searchLibrary("", {}).hits.map((hit) => hit.tab.key), before);
  store.closeDb();
});

test("folders nest, hold pages, and persist", () => {
  const store = loaded();
  const work = store.createFolder({ name: "Work" });
  const sub = store.createFolder({ name: "Releases", parentId: work.id });
  store.upsert({ key: "a", title: "A", html: "<p>a</p>" });
  store.upsert({ key: "b", title: "B", html: "<p>b</p>", folder: "Work/Releases" });
  store.movePage("a", work.id, 0);
  assert.equal(store.get("b")?.folderId, sub.id);
  assert.equal(store.folderPath(store.get("a")?.folderId), "Work");
  assert.equal(store.findFolderPath("work/releases"), sub.id);
  assert.throws(() => store.moveFolder(work.id, sub.id, 0), /into itself/);
  store.persist();
  store.closeDb();
  const again = loaded();
  assert.equal(again.listFolders().length, 2);
  assert.equal(again.folderPath(again.get("b")?.folderId), "Work/Releases");
  again.closeDb();
});

test("folderTree lists paths depth-first with direct page counts", () => {
  const store = loaded();
  const work = store.createFolder({ name: "Work" });
  store.createFolder({ name: "Releases", parentId: work.id });
  store.createFolder({ name: "Notes" });
  store.upsert({ key: "a", title: "A", html: "<p>a</p>", folder: "Work" });
  store.upsert({ key: "b", title: "B", html: "<p>b</p>", folder: "Work/Releases" });
  store.upsert({ key: "c", title: "C", html: "<p>c</p>", folder: "Work/Releases" });
  store.upsert({ key: "loose", title: "Loose", html: "<p>l</p>" });
  const tree = store.folderTree().map(({ path, pages }) => ({ path, pages }));
  const paths = tree.map((row) => row.path);
  assert.deepEqual(new Set(paths), new Set(["Work", "Work/Releases", "Notes"]));
  assert.ok(paths.indexOf("Work/Releases") === paths.indexOf("Work") + 1);
  assert.deepEqual(
    tree.find((row) => row.path === "Work"),
    { path: "Work", pages: 1 }
  );
  assert.deepEqual(
    tree.find((row) => row.path === "Work/Releases"),
    { path: "Work/Releases", pages: 2 }
  );
  store.closeDb();
});

test("folder param only applies when a page is created", () => {
  const store = loaded();
  store.upsert({ key: "a", title: "A", html: "<p>a</p>" });
  store.upsert({ key: "a", title: "A", html: "<p>a2</p>", folder: "Elsewhere" });
  assert.equal(store.get("a")?.folderId, undefined);
  assert.equal(store.listFolders().length, 0);
  store.closeDb();
});

test("moving a strip tab into the Library with close closes it", () => {
  const store = loaded();
  const folder = store.createFolder({ name: "F" });
  store.upsert({ key: "a", title: "A", html: "<p>a</p>" });
  store.movePage("a", folder.id, 0, { close: true });
  assert.equal(store.isClosed("a"), true);
  assert.equal(store.get("a")?.folderId, folder.id);
  store.closeDb();
});

test("deleting a folder with its pages is one undo step", () => {
  const store = loaded();
  const folder = store.createFolder({ name: "F" });
  const inner = store.createFolder({ name: "Inner", parentId: folder.id });
  store.upsert({ key: "a", title: "A", html: "<p>a</p>", folder: "F" });
  store.upsert({ key: "b", title: "B", html: "<p>b</p>", folder: "F/Inner" });
  store.closeTab("b");
  const { deleted } = store.deleteFolder(folder.id, "delete");
  assert.equal(deleted.length, 2);
  assert.equal(store.get("a"), undefined);
  assert.equal(store.listFolders().length, 0);
  store.restoreLast();
  assert.equal(store.isOpen("a"), true);
  assert.equal(store.isClosed("b"), true);
  assert.equal(store.get("b")?.folderId, inner.id);
  assert.equal(store.listFolders().length, 2);
  store.closeDb();
});

test("lifting a folder moves its contents up a level", () => {
  const store = loaded();
  const folder = store.createFolder({ name: "F" });
  store.createFolder({ name: "Inner", parentId: folder.id });
  store.upsert({ key: "a", title: "A", html: "<p>a</p>", folder: "F" });
  store.deleteFolder(folder.id, "lift");
  assert.equal(store.get("a")?.folderId, undefined);
  assert.deepEqual(store.listFolders().map((item) => [item.name, item.parentId]), [["Inner", null]]);
  store.closeDb();
});

test("a bulk delete counts as a single Trash entry and the Trash has no count cap", () => {
  const store = loaded();
  for (let i = 0; i < 15; i += 1) {
    store.upsert({ key: `p${i}`, title: `P${i}`, html: "<p>x</p>" });
  }
  store.deleteMany(["p0", "p1", "p2"]);
  for (let i = 3; i < 15; i += 1) {
    store.deletePermanent(`p${i}`);
  }
  assert.equal(store.listTrash().length, 13);
  assert.deepEqual(store.listTrash()[0].tabs.map((tab) => tab.key), ["scribe:p14"]);
  for (let i = 14; i >= 3; i -= 1) {
    store.restoreLast();
  }
  store.restoreLast();
  assert.equal(store.list().length, 15);
  assert.equal(store.listTrash().length, 0);
  store.closeDb();
});

test("the Trash drops deletes older than 7 days on load", () => {
  const store = loaded();
  store.upsert({ key: "old", title: "Old", html: "<p>o</p>" });
  store.upsert({ key: "new", title: "New", html: "<p>n</p>" });
  store.deletePermanent("old");
  store.deletePermanent("new");
  store.closeDb();
  const db = new DatabaseSync(path.join(dir, "scribe.sqlite"));
  db.prepare("UPDATE tabs SET deleted_at = ? WHERE key = 'scribe:old'").run(Date.now() - 8 * 24 * 60 * 60 * 1000);
  db.close();
  const again = loaded();
  assert.deepEqual(
    again.listTrash().flatMap((batch) => batch.tabs.map((tab) => tab.key)),
    ["scribe:new"]
  );
  again.closeDb();
  const check = new DatabaseSync(path.join(dir, "scribe.sqlite"));
  const rows = check.prepare("SELECT key FROM tabs").all() as Array<{ key: string }>;
  check.close();
  assert.deepEqual(rows.map((row) => row.key), ["scribe:new"]);
});

test("cleanup picks closed, unpinned pages older than the cutoff by default", () => {
  const store = loaded();
  const day = 24 * 60 * 60 * 1000;
  const age = (key: string, fields: { updatedAt?: number; stateUpdatedAt?: number; closedAt?: number; createdAt?: number }) =>
    Object.assign(store.get(key)!, fields);
  for (const key of ["old", "fresh", "pinned", "open", "reclosed"]) {
    store.upsert({ key, title: key, html: `<p>${key}</p>` });
  }
  store.update("pinned", { pin: true, activate: false });
  for (const key of ["old", "fresh", "pinned", "reclosed"]) {
    store.closeTab(key);
  }
  const long = Date.now() - 40 * day;
  age("old", { createdAt: long, updatedAt: long, stateUpdatedAt: long, closedAt: long });
  age("pinned", { createdAt: long, updatedAt: long, stateUpdatedAt: long, closedAt: long });
  age("open", { createdAt: long, updatedAt: long, stateUpdatedAt: long });
  age("reclosed", { createdAt: long, updatedAt: long, stateUpdatedAt: long });
  const keys = (opts: Parameters<BoardStore["cleanupCandidates"]>[0]) =>
    store.cleanupCandidates(opts).map((tab) => tab.key).sort();

  assert.deepEqual(keys({ days: 30 }), ["scribe:old"]);
  assert.deepEqual(keys({ days: 30, includePinned: true }), ["scribe:old", "scribe:pinned"]);
  assert.deepEqual(keys({ days: 30, includeOpen: true }), ["scribe:old", "scribe:open"]);
  assert.deepEqual(keys({ days: 30, basis: "edited" }), ["scribe:old", "scribe:reclosed"]);
  assert.deepEqual(keys({ days: 30, basis: "created", includeOpen: true, includePinned: true }), [
    "scribe:old",
    "scribe:open",
    "scribe:pinned",
    "scribe:reclosed",
  ]);
  assert.deepEqual(keys({ days: 30, basis: "closed", includeOpen: true }), ["scribe:old"]);
  assert.throws(() => store.cleanupCandidates({ days: 0 }));
  assert.throws(() => store.cleanupCandidates({ days: 30, basis: "nope" as never }));

  assert.deepEqual(store.cleanup({ days: 30, includePinned: true }).map((tab) => tab.key).sort(), ["scribe:old", "scribe:pinned"]);
  assert.equal(store.listTrash().length, 1);
  store.closeDb();
});

test("restoring one page from a Trash batch puts it back closed and leaves the rest", () => {
  const store = loaded();
  store.upsert({ key: "a", title: "A", html: "<p>a</p>" });
  store.upsert({ key: "b", title: "B", html: "<p>b</p>" });
  const [a] = store.deleteMany(["a", "b"]);
  store.restoreFromTrash(a.id);
  assert.equal(store.isClosed("a"), true);
  assert.equal(store.isOpen("a"), false);
  assert.deepEqual(store.listTrash()[0].tabs.map((tab) => tab.key), ["scribe:b"]);
  store.closeDb();
});

test("a trashed folder restores or purges with what it held", () => {
  const store = loaded();
  const folder = store.createFolder({ name: "F" });
  const inner = store.createFolder({ name: "Inner", parentId: folder.id });
  store.upsert({ key: "a", title: "A", html: "<p>a</p>", folder: "F" });
  store.upsert({ key: "b", title: "B", html: "<p>b</p>", folder: "F/Inner" });
  store.upsert({ key: "c", title: "C", html: "<p>c</p>" });
  store.deleteFolder(folder.id, "delete");
  store.restoreFromTrash(inner.id);
  assert.deepEqual(store.listFolders().map((item) => [item.name, item.parentId]), [["Inner", null]]);
  assert.equal(store.get("b")?.folderId, inner.id);
  assert.equal(store.isClosed("b"), true);
  assert.equal(store.get("a"), undefined);
  assert.equal(store.purgeFromTrash(folder.id), 1);
  assert.equal(store.listTrash().length, 0);
  store.deletePermanent("c");
  assert.equal(store.emptyTrash(), 1);
  store.persist();
  store.closeDb();
  const again = loaded();
  assert.equal(again.listTrash().length, 0);
  assert.deepEqual(again.listFolders().map((item) => item.name), ["Inner"]);
  again.closeDb();
});

test("a user rename holds the title against agent writes and bumps the revision", () => {
  const store = loaded();
  const firstRevision = store.upsert({ key: "page", title: "Agent title", html: "<p>a</p>", viewer: "agent" }).tab.revision;
  const renamed = store.renamePage("page", "My title");
  assert.equal(renamed.revision, firstRevision + 1);
  const shown = store.upsert({ key: "page", title: "Agent again", html: "<p>b</p>", viewer: "agent" });
  assert.equal(shown.tab.title, "My title");
  assert.ok(shown.titleKept);
  assert.throws(
    () => store.patchHtml("page", { title: "X", edits: [{ oldString: "b", newString: "c" }], expectedRevision: firstRevision, viewer: "agent" }),
    (err: unknown) => err instanceof RevisionConflictError
  );
  store.update("page", { title: "User can", viewer: "user" });
  assert.equal(store.get("page")?.title, "User can");
  store.closeDb();
});

test("updatedAt only moves when content changes", () => {
  const store = loaded();
  const { tab } = store.upsert({ key: "page", title: "Page", html: "<p>a</p>" });
  const at = tab.updatedAt;
  store.update("page", { pin: true, activate: false });
  store.logEvent("page", { name: "go", by: "user" });
  store.writeState("page", { ops: [{ op: "set", path: "n", value: 1 }] });
  store.closeTab("page");
  store.openPage("page", { activate: false });
  assert.equal(store.get("page")?.updatedAt, at);
  store.closeDb();
});

test("writeState applies ops strictly or leniently and reports what applied", () => {
  const store = loaded();
  store.upsert({ key: "page", title: "Page", html: "<p>a</p>" });
  store.writeState("page", { ops: [{ op: "set", path: "", value: { cards: [{ id: "c1", num: 1, col: "a" }, { id: "c2", num: 2, col: "a" }], n: 1 } }] });
  const revision = store.get("page")!.stateRevision;
  const deltas: unknown[] = [];
  store.on("tab_state", (_tab, delta) => deltas.push(delta));
  const result = store.writeState("page", {
    ops: [{ op: "set", path: "n", value: 2 }, { op: "merge", path: "cards/num=2", value: { col: "b" } }, { op: "move", path: "cards/c2", at: "start" }],
    client: "c_1",
  });
  assert.ok(result.ok);
  assert.equal(result.fromRevision, revision);
  assert.equal(result.applied.length, 3);
  const tab = store.get("page")!;
  assert.equal(tab.stateRevision, revision + 1);
  assert.deepEqual(tab.state, { cards: [{ id: "c2", num: 2, col: "b" }, { id: "c1", num: 1, col: "a" }], n: 2 });
  assert.deepEqual(deltas, [{ fromRevision: revision, ops: result.applied, client: "c_1", writeId: undefined }]);
  assert.throws(
    () => store.writeState("page", { ops: [{ op: "set", path: "n", value: 3 }, { op: "remove", path: "cards/c9" }] }),
    /no item matches "c9"/
  );
  assert.equal(store.get("page")!.state.n, 2);
  const lenient = store.writeState("page", { ops: [{ op: "set", path: "n", value: 3 }, { op: "remove", path: "cards/c9" }], lenient: true });
  assert.ok(lenient.ok);
  assert.equal(lenient.skipped.length, 1);
  assert.equal(store.get("page")!.state.n, 3);
  assert.deepEqual(store.writeState("page", { ops: [], expectedRevision: 1 }), { ok: false, stateRevision: revision + 2 });
  store.closeDb();
});

test("events are logged with a sequence, kept to the newest 500, and survive a reload", () => {
  const store = loaded();
  store.upsert({ key: "page", title: "Page", html: "<p>a</p>", state: { cards: [] } });
  const first = store.logEvent("page", { name: "card_ready", data: { card: "c1" }, by: "user", ops: [{ op: "insert", path: "cards", value: { id: "c1" } }] });
  assert.equal(first.event.seq, 1);
  assert.deepEqual(first.tab.state.cards, [{ id: "c1" }]);
  for (let i = 0; i < 505; i += 1) {
    store.logEvent("page", { name: "tick", by: "agent" });
  }
  const tab = store.get("page")!;
  assert.equal(tab.eventSeq, 506);
  assert.equal(tab.events.length, 500);
  assert.equal(tab.events[0].seq, 7);
  assert.throws(() => store.logEvent("page", { name: "big", by: "user", data: { text: "x".repeat(5000) } }), /too large/);
  assert.throws(() => store.logEvent("page", { name: "bad name!", by: "user" }), /invalid signal name/);
  store.persist();
  store.closeDb();
  const again = loaded();
  assert.equal(again.get("page")!.eventSeq, 506);
  assert.equal(again.get("page")!.events.at(-1)?.name, "tick");
  again.closeDb();
});

test("local state is kept per viewer and goes with the page", () => {
  const store = loaded();
  const { tab } = store.upsert({ key: "page", title: "Page", html: "<p>a</p>" });
  store.setLocal("page", "desktop", { filter: "mine" });
  assert.deepEqual(store.latestLocal("page"), { filter: "mine" });
  store.setLocal("page", "browser", { filter: "all" });
  assert.deepEqual(store.getLocal("page", "desktop"), { filter: "mine" });
  assert.deepEqual(store.getLocal("scribe:page", "browser"), { filter: "all" });
  assert.deepEqual(store.getLocal("page", "other"), {});
  assert.throws(() => store.setLocal("page", "desktop", { big: "x".repeat(70 * 1024) }), /too large/);
  store.setLocal("page", "desktop", {});
  assert.deepEqual(store.getLocal("page", "desktop"), {});
  assert.deepEqual(store.latestLocal("page"), { filter: "all" });
  store.setLocal("page", "browser", {});
  assert.deepEqual(store.latestLocal("page"), {});
  store.deletePermanent(tab.id);
  store.closeDb();
});

test("page permissions are kept per page, reset by an agent rewrite, and not exported", () => {
  const store = loaded();
  const { tab } = store.upsert({ key: "page", title: "Page", html: "<p>a</p>" });
  const folder = path.join(dir, "work");
  assert.equal(store.pagePermissions("page").size, 0);
  store.setPagePermission("page", "agent.unattended", "allow");
  store.setPagePermission("page", "audio.microphone", "allow");
  store.setPagePermission("page", "audio.microphoneStream", "allow");
  store.setPagePermission("page", "audio.transcribe", "allow");
  store.setPagePermission("page", "agent.chat", "deny");
  // A per-folder permission has no blanket allow: it is stored as ask, with its folders.
  store.setPagePermission("page", "agent.workspace", "allow", [{ path: folder, approval: "edits" }, { path: "relative", approval: "full" }]);
  const grants = store.pagePermissions("scribe:page");
  assert.equal(grants.get("agent.unattended")?.value, "allow");
  assert.deepEqual(grants.get("agent.workspace")?.folders, [{ path: folder, approval: "edits" }]);
  assert.equal(grants.get("agent.workspace")?.value, "ask");
  assert.throws(() => store.setPagePermission("page", "agent.nope", "allow"), /unknown permission/);

  // Back at the default with no folders: the row goes.
  store.setPagePermission("page", "agent.chat", "allow");
  assert.equal(store.pagePermissions("page").has("agent.chat"), false);

  store.closeDb();
  const again = loaded();
  assert.equal(again.pagePermissions("page").get("agent.unattended")?.value, "allow");
  assert.equal(JSON.stringify(again.exportFile()).includes("agent.unattended"), false);

  assert.equal(again.resetRiskyPermissions("page"), true);
  assert.equal(again.pagePermissions("page").has("audio.microphone"), false);
  assert.equal(again.pagePermissions("page").has("audio.microphoneStream"), false);
  assert.equal(again.pagePermissions("page").get("audio.transcribe")?.value, "allow");
  assert.equal(again.pagePermissions("page").size, 1);
  assert.equal(again.resetRiskyPermissions("page"), false);
  again.deletePermanent(tab.id);
  again.closeDb();
});

test("page keys get the scribe: prefix, and lookups take either form", () => {
  const store = loaded();
  const { tab } = store.upsert({ key: "Sprint Notes", title: "Sprint", html: "<p>a</p>" });
  assert.equal(tab.key, "scribe:sprint-notes");
  assert.equal(store.get("sprint-notes")?.id, tab.id);
  assert.equal(store.get("scribe:sprint-notes")?.id, tab.id);
  assert.equal(store.upsert({ key: "scribe:sprint-notes", title: "Sprint 2", html: "<p>b</p>" }).tab.id, tab.id);
  store.closeDb();
});

test("built-in templates are listed apart from the user's own", () => {
  const store = loaded();
  const builtins = store.listBuiltinTemplates();
  assert.ok(builtins.some((item) => item.id === "builtin:todo-list" && item.builtIn));
  assert.ok(builtins.every((item) => !item.localId));
  assert.equal(store.listTemplates().length, 0);
  assert.equal(store.findTemplate("todo-list")?.builtIn, true);
  store.closeDb();
});

test("opening a built-in opens a local copy, created once", () => {
  const store = loaded();
  const first = store.openFromTemplate("builtin:todo-list", { title: "Chores" });
  assert.equal(first.copiedBuiltin, true);
  const copy = store.getTemplate(first.tab.templateId!)!;
  assert.equal(copy.key, "todo-list");
  assert.equal(copy.source?.builtin, "todo-list");
  const second = store.openFromTemplate("builtin:todo-list", { title: "Errands" });
  assert.equal(second.copiedBuiltin, false);
  assert.equal(second.tab.templateId, copy.id);
  assert.equal(store.listTemplates().length, 1);
  assert.equal(store.listTemplates()[0].builtinSource, "todo-list");
  assert.equal(store.listBuiltinTemplates().find((item) => item.key === "todo-list")?.localId, copy.id);
  // The key now finds the user's copy, not the built-in.
  assert.equal(store.findTemplate("todo-list")?.template.id, copy.id);
  store.closeDb();
});

test("plugin template metadata identifies the plugin on catalog entries and local copies", () => {
  const store = loaded();
  try {
    const plugin = { id: "jira", name: "Jira" };
    const template = {
      ...store.findTemplate("todo-list")!.template,
      id: "builtin:plugin-jira--tasks", key: "plugin-jira--tasks", plugin,
    };
    store.setPluginTemplates([template]);
    assert.deepEqual(store.listBuiltinTemplates().find(t => t.id === template.id)?.plugin, plugin);
    store.openFromTemplate(template.id, { title: "Tasks" });
    assert.deepEqual(store.listTemplates()[0].plugin, plugin);
    store.setPluginTemplates([{ ...template, plugin: { ...plugin, name: "Jira renamed" } }]);
    assert.equal(store.listTemplates()[0].plugin?.name, "Jira renamed");
    store.setPluginTemplates([]);
    assert.equal(store.listTemplates().length, 0);
  } finally {
    store.closeDb();
  }
});

test("Kanban opens with usable preset state before any browser script runs", () => {
  const store = loaded();
  try {
    const presets: Array<[string, Array<[string, string?, number?]>]> = [
      ["simple", [["To do"], ["Doing"], ["Done", "done"]]],
      ["dev", [["Backlog"], ["Ready"], ["In progress", undefined, 3], ["Review"], ["Done", "done"]]],
      ["agent", [["Inbox"], ["Ready for agent", "agent"], ["Agent working", "working"], ["Needs review", "review"], ["Done", "done"]]],
    ];
    for (const [preset, expected] of presets) {
      for (const agentMode of [true, false]) {
        const { tab } = store.openFromTemplate("builtin:kanban", { title: preset, preset, agentMode });
        const cols = tab.state.columns as Array<{ id: string; title: string; role?: string; wip?: number }>;
        assert.deepEqual(cols.map((c) => [c.title, c.role, c.wip]), expected.map(([title, role, wip]) =>
          [title, role, wip]));
        assert.equal(new Set(cols.map((c) => c.id)).size, cols.length);
        assert.deepEqual((tab.state.labels as Array<{ name: string }>).map((l) => l.name), ["Bug", "Feature", "Chore"]);
        assert.deepEqual(tab.state.cards, []);
        assert.equal(tab.state.nextNum, 1);
        store.runAction(tab.id, "create", {
          title: "Headless card", labels: ["Bug"],
          ...(preset === "agent" ? { column: "agent" } : {}),
        }, { by: "agent" });
        const [card] = tab.state.cards as Array<{ num: number; col: string }>;
        assert.equal(card.num, 1);
        assert.equal(card.col, cols[preset === "agent" ? 1 : 0].id);
        assert.equal(tab.state.nextNum, 2);
      }
    }
    const template = store.findTemplate("kanban")!.template;
    assert.deepEqual(template.fields.map(field => field.key), ["preset"]);
    assert.deepEqual(template.initialState, { columns: [], labels: [], cards: [], nextNum: 1 });
  } finally {
    store.closeDb();
  }
});

test("Kanban seeds a draft and persists its columns and headless actions", () => {
  const store = loaded();
  const draft = store.createDraft();
  const { tab, template } = store.openFromTemplate("builtin:kanban", { preset: "agent" }, { into: draft.id });
  assert.equal(tab.id, draft.id);
  store.runAction(tab.id, "create", { title: "Persisted card", column: "agent" }, { by: "agent" });
  const state = structuredClone(tab.state);
  const other = store.openFromTemplate(template.id, { preset: "agent" }).tab;
  assert.notDeepEqual(other.state.columns, tab.state.columns);
  assert.deepEqual(other.state.cards, []);
  store.persist();
  store.closeDb();
  const again = loaded();
  try {
    assert.deepEqual(again.get(tab.id)!.state, state);
    again.runAction(tab.id, "claim", { card: 1 }, { by: "agent", label: "Test" });
  } finally {
    again.closeDb();
  }
});

test("Kanban keeps a local copy's custom initial columns and labels", () => {
  const store = loaded();
  try {
    const { template } = store.copyBuiltinTemplate("kanban");
    const initialState = {
      columns: [{ id: "custom", title: "Custom" }],
      labels: [{ id: "custom-label", name: "Custom label" }],
      cards: [], nextNum: 7, settings: { showDoneDate: true },
    };
    store.upsertTemplate({ id: template.id, title: template.title, html: template.html, fields: template.fields, initialState });
    const { tab } = store.openFromTemplate(template.id, { preset: "agent" });
    assert.deepEqual(tab.state, initialState);
    store.runAction(tab.id, "create", { title: "Custom card" }, { by: "agent" });
    assert.deepEqual(template.initialState, initialState);
  } finally {
    store.closeDb();
  }
});

test("a built-in's local copy keeps its link after edits and a reload", () => {
  const store = loaded();
  const { template } = store.copyBuiltinTemplate("markdown-note");
  store.upsertTemplate({ id: template.id, title: "My notes", html: "<p>mine</p>" });
  store.persist();
  store.closeDb();
  const again = loaded();
  assert.equal(again.copyBuiltinTemplate("markdown-note").created, false);
  assert.equal(again.getTemplate(template.id)?.source?.builtin, "markdown-note");
  assert.equal(again.listTemplates().length, 1);
  again.closeDb();
});

/** A copy of markdown-note that looks as if it was made from an older built-in, then reloaded. */
function staleCopy(edit: (copy: Template, builtin: Template) => void) {
  const store = loaded();
  const { template } = store.copyBuiltinTemplate("markdown-note");
  store.upsertTemplate({ id: template.id, title: template.title, html: "<p>old</p>", fields: template.fields });
  const copy = store.getTemplate(template.id)!;
  copy.source = { builtin: "markdown-note", fingerprint: templateFingerprint(copy) };
  edit(copy, store.findTemplate("builtin:markdown-note")!.template);
  const { tab } = store.openFromTemplate(template.id, {});
  store.persist();
  store.closeDb();
  return { id: template.id, tabId: tab.id, again: loaded() };
}

test("an unedited built-in copy follows the built-in and re-renders its pages", () => {
  const { id, tabId, again } = staleCopy(() => {});
  const builtin = again.findTemplate("builtin:markdown-note")!.template;
  const copy = again.getTemplate(id)!;
  assert.equal(copy.html, builtin.html);
  assert.equal(copy.source?.fingerprint, templateFingerprint(builtin));
  assert.doesNotMatch(again.get(tabId)!.html, /<p>old<\/p>/);
  assert.equal(again.listTemplates()[0].builtinUpdate, undefined);
  again.closeDb();
});

test("an edited built-in copy is not updated", () => {
  const { id, again } = staleCopy((copy) => {
    copy.html = "<p>mine</p>";
  });
  assert.equal(again.getTemplate(id)!.html, "<p>mine</p>");
  assert.equal(again.listTemplates()[0].builtinUpdate, true);
  // An ordinary edit keeps the flag; one that says it merged the built-in clears it.
  const copy = again.getTemplate(id)!;
  again.upsertTemplate({ id, title: copy.title, html: "<p>mine 2</p>", fields: copy.fields });
  assert.equal(again.listTemplates()[0].builtinUpdate, true);
  again.upsertTemplate({ id, title: copy.title, html: "<p>merged</p>", fields: copy.fields, syncedWithBuiltin: true });
  assert.equal(again.listTemplates()[0].builtinUpdate, undefined);
  again.closeDb();
});

test("a built-in copy is not updated when the built-in's stateVersion changed", () => {
  const { id, again } = staleCopy((copy) => {
    copy.stateVersion = 2;
    copy.source = { builtin: "markdown-note", fingerprint: templateFingerprint(copy) };
  });
  assert.equal(again.getTemplate(id)!.html, "<p>old</p>");
  assert.equal(again.listTemplates()[0].builtinUpdate, true);
  again.closeDb();
});

test("a built-in copy that already matches its changed built-in is not flagged", () => {
  // The same change was made to the copy before it landed in the built-in.
  const { id, again } = staleCopy((copy, builtin) => {
    Object.assign(copy, structuredClone({ ...builtin, id: copy.id, key: copy.key, source: copy.source }));
  });
  const builtin = again.findTemplate("builtin:markdown-note")!.template;
  assert.equal(again.getTemplate(id)!.source?.fingerprint, templateFingerprint(builtin));
  assert.equal(again.listTemplates()[0].builtinUpdate, undefined);
  again.closeDb();
});

test("editing a built-in copy to match its built-in clears the update flag", () => {
  const { id, again } = staleCopy((copy) => {
    copy.html = "<p>mine</p>";
  });
  assert.equal(again.listTemplates()[0].builtinUpdate, true);
  const builtin = again.findTemplate("builtin:markdown-note")!.template;
  again.upsertTemplate({ ...builtin, id });
  assert.equal(again.listTemplates()[0].builtinUpdate, undefined);
  again.closeDb();
});

/** A copy of templates/builtin to change on disk, as the dev watcher sees it. */
function builtinDirCopy(): string {
  const target = path.join(dir, "builtin");
  fs.cpSync(path.join(import.meta.dirname, "..", "templates", "builtin"), target, { recursive: true });
  return target;
}

test("reloading a changed built-in updates its unedited copy and pages", () => {
  const store = loaded();
  const { template } = store.copyBuiltinTemplate("markdown-note");
  const { tab } = store.openFromTemplate(template.id, {});
  const builtins = builtinDirCopy();
  assert.deepEqual(store.reloadBuiltins(builtins), []);
  const htmlPath = path.join(builtins, "markdown-note.html");
  fs.writeFileSync(htmlPath, fs.readFileSync(htmlPath, "utf8").replace("</body>", "<p>reloaded-marker</p></body>"));
  assert.deepEqual(store.reloadBuiltins(builtins), ["markdown-note"]);
  assert.match(store.getTemplate(template.id)!.html, /reloaded-marker/);
  assert.match(store.get(tab.id)!.html, /reloaded-marker/);
  assert.equal(store.listTemplates()[0].builtinUpdate, undefined);
  store.closeDb();
});

test("reloading a changed built-in flags an edited copy", () => {
  const store = loaded();
  const { template } = store.copyBuiltinTemplate("markdown-note");
  store.upsertTemplate({ id: template.id, title: template.title, html: "<p>mine</p>", fields: template.fields });
  const builtins = builtinDirCopy();
  const guidePath = path.join(builtins, "markdown-note.guide.md");
  fs.writeFileSync(guidePath, "A new guide.");
  assert.deepEqual(store.reloadBuiltins(builtins), ["markdown-note"]);
  assert.equal(store.templateGuide(template.id)?.text, "A new guide.");
  const htmlPath = path.join(builtins, "markdown-note.html");
  fs.writeFileSync(htmlPath, "<p>changed</p>");
  assert.deepEqual(store.reloadBuiltins(builtins), ["markdown-note"]);
  assert.equal(store.getTemplate(template.id)!.html, "<p>mine</p>");
  assert.equal(store.listTemplates()[0].builtinUpdate, true);
  store.closeDb();
});

test("a built-in that fails to load keeps the old built-ins", () => {
  const store = loaded();
  const builtins = builtinDirCopy();
  fs.writeFileSync(path.join(builtins, "markdown-note.json"), "{ broken");
  assert.deepEqual(store.reloadBuiltins(builtins), []);
  assert.ok(store.findTemplate("builtin:markdown-note"));
  store.closeDb();
});

test("built-ins cannot be updated or deleted", () => {
  const store = loaded();
  assert.throws(() => store.upsertTemplate({ id: "builtin:embed", title: "X", html: "<p>x</p>" }), /read-only/);
  assert.throws(() => store.deleteTemplate("builtin:embed"), /cannot be deleted/);
  assert.throws(() => store.deleteTemplate("embed"), /cannot be deleted/);
  store.closeDb();
});

test("opening a built-in with bad values leaves no copy behind", () => {
  const store = loaded();
  assert.throws(() => store.openFromTemplate("builtin:embed", {}), /required/);
  assert.equal(store.listTemplates().length, 0);
  store.closeDb();
});

test("a local template identical to a built-in is adopted as its copy", () => {
  const store = loaded();
  const builtin = store.findTemplate("builtin:embed")!.template;
  const { template } = store.upsertTemplate({
    key: "my-embed",
    title: builtin.title,
    description: builtin.description,
    html: builtin.html,
    fields: builtin.fields,
    titleTemplate: builtin.titleTemplate,
    stateVersion: builtin.stateVersion,
  });
  store.persist();
  store.closeDb();
  const again = loaded();
  assert.equal(again.getTemplate(template.id)?.source?.builtin, "embed");
  assert.equal(again.openFromTemplate("builtin:embed", { url: "https://example.com" }).tab.templateId, template.id);
  again.closeDb();
});

test("template tables without the built-in columns are migrated", () => {
  const store = loaded();
  store.persist();
  store.closeDb();
  const db = new DatabaseSync(path.join(dir, "scribe.sqlite"));
  db.exec("ALTER TABLE templates DROP COLUMN builtin_key; ALTER TABLE templates DROP COLUMN builtin_fingerprint; ALTER TABLE templates DROP COLUMN guide;");
  db.close();
  const again = loaded();
  const { template } = again.copyBuiltinTemplate("embed");
  again.persist();
  again.closeDb();
  const third = loaded();
  assert.equal(third.getTemplate(template.id)?.source?.builtin, "embed");
  third.closeDb();
});

test("an exported built-in copy stays linked on import", () => {
  const source = loaded();
  const { tab } = source.openFromTemplate("builtin:embed", { url: "https://example.com" });
  const parsed = roundTrip(source.exportFile({ id: tab.id }));
  source.closeDb();
  const target = otherBoard();
  target.importBoard(parsed, "meta");
  const imported = target.listTemplates();
  assert.equal(imported.length, 1);
  assert.equal(imported[0].builtinSource, "embed");
  target.closeDb();
});

function pageAssetRows(): Array<{ id: string; tab_id: string; orphaned_at: number | null }> {
  const db = new DatabaseSync(path.join(dir, "scribe.sqlite"));
  try {
    return db.prepare("SELECT id, tab_id, orphaned_at FROM page_assets ORDER BY created_at, id").all() as Array<{
      id: string;
      tab_id: string;
      orphaned_at: number | null;
    }>;
  } finally {
    db.close();
  }
}

/** Pretend every orphaned asset lost its references long ago, so the next check deletes it. */
function ageOrphans(): void {
  const db = new DatabaseSync(path.join(dir, "scribe.sqlite"));
  try {
    db.prepare("UPDATE page_assets SET orphaned_at = 1 WHERE orphaned_at IS NOT NULL").run();
  } finally {
    db.close();
  }
}

test("a page asset saved right after creating its page is stored and served", () => {
  const store = loaded();
  const { tab } = store.upsert({ key: "kanban", title: "Kanban", html: "<p>board</p>" });
  const { asset, usage } = store.savePageAsset("kanban", {
    name: "card.png",
    mimeType: "image/png; charset=binary",
    data: Buffer.from("png-bytes"),
  });
  assert.match(asset.id, /^pa_[0-9a-f]{24}$/);
  assert.equal(asset.mimeType, "image/png");
  assert.equal(usage.count, 1);
  assert.equal(usage.bytes, 9);
  assert.equal(usage.warning, undefined);
  assert.equal(store.readPageAsset(asset.id)?.data.toString(), "png-bytes");
  const owned = store.readTabPageAsset("kanban", asset.id);
  assert.equal(owned.meta.id, asset.id);
  assert.equal(owned.data.toString(), "png-bytes");
  const other = store.upsert({ key: "other", title: "Other", html: "<p>x</p>" }).tab;
  assert.throws(() => store.readTabPageAsset(other.id, asset.id), /asset not found/);
  assert.deepEqual(
    store.listPageAssets(tab.id).assets.map((item) => item.id),
    [asset.id]
  );
  store.closeDb();
});

test("page assets stay while referenced and go once unreferenced past the grace period", () => {
  const store = loaded();
  store.upsert({ key: "kanban", title: "Kanban", html: "<p>board</p>" });
  const kept = store.savePageAsset("kanban", { data: Buffer.from("a") }).asset;
  const dropped = store.savePageAsset("kanban", { data: Buffer.from("b") }).asset;
  const neverUsed = store.savePageAsset("kanban", { data: Buffer.from("c") }).asset;
  store.writeState("kanban", { ops: [{ op: "set", path: "cards", value: [{ image: kept.id }, { image: `/blob/${dropped.id}` }] }] });
  store.persist();
  assert.deepEqual(Object.fromEntries(pageAssetRows().map((row) => [row.id, row.orphaned_at === null])), {
    [kept.id]: true,
    [dropped.id]: true,
    [neverUsed.id]: false,
  });

  store.writeState("kanban", { ops: [{ op: "set", path: "cards", value: [{ image: kept.id }] }] });
  store.persist();
  // Within the grace period nothing is deleted, so an undo can bring the card back.
  assert.equal(pageAssetRows().length, 3);

  ageOrphans();
  store.sweepAssets();
  assert.deepEqual(pageAssetRows().map((row) => row.id), [kept.id]);
  assert.equal(store.pageAssetUsageOf(store.get("kanban")!.id).count, 1);
  store.closeDb();
});

test("a reference restored within the grace period keeps the asset", () => {
  const store = loaded();
  store.upsert({ key: "kanban", title: "Kanban", html: "<p>board</p>" });
  const asset = store.savePageAsset("kanban", { data: Buffer.from("a") }).asset;
  store.writeState("kanban", { ops: [{ op: "set", path: "image", value: asset.id }] });
  store.persist();
  store.writeState("kanban", { ops: [{ op: "set", path: "image", value: null }] });
  store.persist();
  store.writeState("kanban", { ops: [{ op: "set", path: "image", value: asset.id }] });
  store.persist();
  ageOrphans();
  store.sweepAssets();
  assert.equal(pageAssetRows().length, 1);
  store.closeDb();
});

test("page assets survive the Trash and go with the page when it is purged", () => {
  const store = loaded();
  const { tab } = store.upsert({ key: "kanban", title: "Kanban", html: "<p>board</p>" });
  const asset = store.savePageAsset("kanban", { data: Buffer.from("a") }).asset;
  store.writeState("kanban", { ops: [{ op: "set", path: "image", value: asset.id }] });
  store.deleteMany([tab.id]);
  store.persist();
  assert.equal(pageAssetRows().length, 1);
  store.purgeFromTrash(tab.id);
  store.persist();
  assert.equal(pageAssetRows().length, 0);
  assert.equal(store.pageAssetUsageOf(tab.id).count, 0);
  store.closeDb();
});

test("the startup sweep removes page assets whose page row is gone", () => {
  const store = loaded();
  store.upsert({ key: "kanban", title: "Kanban", html: "<p>board</p>" });
  store.closeDb();
  const db = new DatabaseSync(path.join(dir, "scribe.sqlite"));
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(
    "INSERT INTO page_assets (id, tab_id, name, mime_type, bytes, data, created_at, orphaned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(`pa_${"0".repeat(24)}`, "t_gone", "x", "image/png", 1, Buffer.from("x"), 1, null);
  db.close();
  const reopened = loaded();
  assert.equal(pageAssetRows().length, 0);
  reopened.closeDb();
});

test("export and import carry page assets and re-id them when the ids are taken", () => {
  const store = loaded();
  const { tab } = store.upsert({ key: "kanban", title: "Kanban", html: "<p>board</p>" });
  const asset = store.savePageAsset("kanban", { name: "card.png", mimeType: "image/png", data: Buffer.from("img") }).asset;
  store.writeState("kanban", { ops: [{ op: "set", path: "cards", value: [{ image: `/blob/${asset.id}` }] }] });
  const file = parseImport(Buffer.from(serializeExport(store.exportFile({ id: tab.id }))), "kanban.json");
  assert.equal(file.pages[0].pageAssets?.length, 1);

  const result = store.importBoard(file, "meta");
  const imported = store.get(result.tabs[0].id)!;
  const cards = imported.state.cards as Array<{ image: string }>;
  const newId = cards[0].image.replace("/blob/", "");
  assert.notEqual(newId, asset.id);
  assert.equal(store.readPageAsset(newId)?.data.toString(), "img");
  assert.equal(store.readPageAsset(newId)?.meta.tabId, imported.id);
  assert.equal(pageAssetRows().filter((row) => row.orphaned_at === null).length, 2);
  store.closeDb();
});

test("writeState stores local files as page assets and swaps asset:<name> in ops for their URLs", () => {
  const store = loaded();
  store.upsert({ key: "todos", title: "Todos", html: "<p>list</p>", state: { todos: [] } });
  const file = path.join(dir, "photo.png");
  fs.writeFileSync(file, "png");
  const result = store.writeState("todos", {
    ops: [{ op: "insert", path: "todos", value: { id: "t1", text: "Buy", images: [{ id: "i1", name: "photo.png", data: "asset:Photo.png" }] } }],
    assets: [{ path: file }],
  });
  assert.ok(result.ok);
  assert.equal(result.assets?.length, 1);
  const url = (result.tab.state.todos as Array<{ images: Array<{ data: string }> }>)[0].images[0].data;
  assert.equal(url, `/blob/${result.assets![0].id}`);
  assert.equal(result.assets![0].mimeType, "image/png");
  store.persist();
  assert.equal(pageAssetRows()[0].orphaned_at, null);

  assert.throws(
    () => store.writeState("todos", { ops: [{ op: "set", path: "note", value: "asset:missing.png" }], assets: [{ path: file }] }),
    /asset:missing.png but no such file was passed.*no state value is exactly asset:<name> for photo.png/
  );
  assert.equal(pageAssetRows().length, 1);
  store.closeDb();
});

test("a page from a built-in copy gets the built-in's guide; a user template keeps its own", () => {
  const store = loaded();
  const { template: copy } = store.copyBuiltinTemplate("kanban");
  const guide = store.templateGuide(copy.id);
  assert.equal(guide?.id, "builtin:kanban");
  assert.match(guide?.text ?? "", /`claim` \{ card, text\?, assignee\? \}/);
  assert.equal(store.templateGuide("embed"), undefined);

  const { template } = store.upsertTemplate({ key: "log", title: "Log", html: "<p>log</p>", guide: "  Append to entries.  " });
  assert.equal(store.templateGuide("log")?.text, "Append to entries.");
  store.upsertTemplate({ key: "log", title: "Log", html: "<p>log v2</p>" });
  assert.equal(store.templateGuide("log")?.text, "Append to entries.", "an update without guide keeps it");
  store.persist();
  store.closeDb();

  const again = loaded();
  assert.equal(again.templateGuide(template.id)?.text, "Append to entries.");
  again.upsertTemplate({ key: "log", title: "Log", html: "<p>log</p>", guide: "" });
  assert.equal(again.templateGuide("log"), undefined);
  again.closeDb();
});

test("a built-in copy offers the built-in's agent actions; a user template keeps its own", () => {
  const store = loaded();
  const { template: copy } = store.copyBuiltinTemplate("markdown-note");
  assert.equal(copy.agentActions, undefined, "the copy does not store them");
  assert.equal(store.templateMeta(copy).agentActions?.[0]?.id, "summarise");
  assert.equal(store.listBuiltinTemplates().find((t) => t.key === "markdown-note")?.agentActions?.[0]?.id, "summarise");

  const action = { id: "ping", label: "Ping", prompt: "Ping {{page.key}}" };
  store.upsertTemplate({ key: "log", title: "Log", html: "<p>log</p>", agentActions: [action] });
  store.upsertTemplate({ key: "log", title: "Log", html: "<p>log v2</p>" });
  assert.equal(store.findTemplate("log")?.template.agentActions?.[0]?.id, "ping", "an update without agentActions keeps them");
  store.persist();
  store.closeDb();

  const again = loaded();
  const log = again.findTemplate("log")!.template;
  assert.deepEqual(again.templateMeta(log).agentActions, [{ ...action, where: ["menu", "palette", "slash"] }]);
  again.upsertTemplate({ key: "log", title: "Log", html: "<p>log</p>", agentActions: [] });
  assert.equal(again.templateMeta(again.findTemplate("log")!.template).agentActions, undefined);
  again.closeDb();
});

test("a new page can take the key of a page in the Trash, and both save", () => {
  const store = loaded();
  const { tab: old } = store.upsert({ key: "kanban", title: "Kanban", html: "<p>old</p>" });
  store.persist();
  store.deleteMany([old.id]);
  store.persist();
  const { tab: fresh } = store.upsert({ key: "kanban", title: "Kanban", html: "<p>new</p>" });
  store.persist();
  assert.equal(store.snapshot().persistError, null);
  assert.equal(fresh.key, "scribe:kanban");
  assert.notEqual(old.key, "kanban");

  store.restoreFromTrash(old.id);
  store.persist();
  assert.equal(store.snapshot().persistError, null);
  assert.equal(store.get("kanban")?.id, fresh.id);
  store.closeDb();

  const again = loaded();
  assert.equal(again.get("kanban")?.id, fresh.id);
  assert.ok(again.get(old.id));
  again.closeDb();
});

test("pages opened from a template with a trashed page's title get the plain key", () => {
  const store = loaded();
  const first = store.upsert({ title: "Scribe work", html: "<p>a</p>" }).tab;
  store.persist();
  store.deleteMany([first.id]);
  const second = store.upsert({ title: "Scribe work", html: "<p>b</p>" }).tab;
  store.persist();
  assert.equal(store.snapshot().persistError, null);
  assert.equal(second.key, "scribe:scribe-work");
  store.closeDb();
});

test("a New page draft stays out of the strip and the Library until it is promoted", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  const draft = store.createDraft();
  assert.equal(store.get(draft.id), undefined);
  assert.equal(store.list().length, 1);
  assert.equal(store.createDraft(draft.id), draft);
  const promoted = store.promoteDraft(draft.id, { activate: false });
  assert.equal(promoted?.id, draft.id);
  assert.equal(store.isDraft(draft.id), false);
  assert.deepEqual(titles(store), ["A", "New page"]);
  assert.equal(toMeta(store.get(draft.id)!).blank, true);
  store.persist();
  store.closeDb();
  const again = loaded();
  assert.equal(again.get(draft.id)?.html, "");
  again.closeDb();
});

test("a discarded draft is gone, and restoring a lost draft keeps its id", () => {
  const store = loaded();
  const draft = store.createDraft();
  assert.equal(store.discardDraft(draft.id), true);
  assert.equal(store.promoteDraft(draft.id), undefined);
  assert.equal(store.createDraft(draft.id).id, draft.id);
  assert.equal(store.isDraft(draft.id), true);
  store.closeDb();
});

test("a template fills a draft in place", () => {
  const store = loaded();
  store.upsertTemplate({
    key: "todo",
    title: "Todo",
    html: "<h1>{{title}}</h1>",
    fields: [{ key: "title", label: "Title", type: "text", required: true }],
    titleTemplate: "{{title}}",
  });
  const draft = store.createDraft();
  const { tab } = store.openFromTemplate("todo", { title: "Shop" }, { into: draft.id });
  assert.equal(tab.id, draft.id);
  assert.equal(tab.templateId, store.getTemplate("todo")?.id);
  assert.equal(tab.title, "Shop");
  assert.equal(store.getActiveId(), draft.id);
  assert.throws(() => store.openFromTemplate("todo", { title: "Again" }, { into: draft.id }), /not blank/);
  store.closeDb();
});

test("a focused new page from the blank page's thread fills it; background pages do not", () => {
  const store = loaded();
  const draft = store.createDraft();
  store.promoteDraft(draft.id, { activate: false });
  const form = store.upsert({ key: "form", title: "Form", html: "<p>f</p>", activate: false, into: draft.id, viewer: "agent" });
  assert.notEqual(form.tab.id, draft.id);
  const shown = store.upsert({ key: "plan", title: "Plan", html: "<p>p</p>", into: draft.id, viewer: "agent" });
  assert.equal(shown.tab.id, draft.id);
  assert.equal(shown.created, true);
  assert.equal(store.get("plan")?.id, draft.id);
  assert.equal(toMeta(shown.tab).blank, undefined);
  const next = store.upsert({ key: "other", title: "Other", html: "<p>o</p>", into: draft.id, viewer: "agent" });
  assert.notEqual(next.tab.id, draft.id);
  store.closeDb();
});

test("a page's reply target is set by agents, persists, and sends a reply event to a page without a reply hook", () => {
  const store = loaded();
  store.upsert({ key: "notes", title: "Notes", html: "<p>n</p>" });
  const { tab: form } = store.upsert({ key: "form", title: "Form", html: "<p>f</p>" });
  assert.throws(() => store.receiveReply(form.id, { data: { a: 1 } }), /no reply target/);
  assert.throws(() => store.setReplyTo(form.id, { page: "missing" }), /not found/);
  assert.throws(() => store.setReplyTo(form.id, { page: "form" }), /another page/);
  assert.throws(() => store.setReplyTo(form.id, { page: "notes", card: "x" }), /card number/);
  const notes = store.get("notes")!;
  store.setReplyTo(form.id, { page: "scribe:notes", card: 4 });
  assert.deepEqual(store.get(form.id)?.replyTo, { page: notes.id, card: 4 });

  const { target, deliver } = store.receiveReply(form.id, { summary: "  Picked\n A ", data: { approach: "A" } });
  assert.equal(target.id, notes.id);
  assert.equal(deliver, undefined);
  const event = store.get("notes")!.events.at(-1)!;
  assert.equal(event.name, "reply");
  assert.deepEqual(event.data, { from: { id: form.id, key: form.key, title: "Form" }, card: 4, summary: "Picked A", data: { approach: "A" } });
  assert.throws(() => store.receiveReply(form.id, { data: ["no"] }), /object/);
  assert.throws(() => store.receiveReply(form.id, { data: { big: "x".repeat(25_000) } }), /over 20 KB/);
  store.closeDb();

  const again = loaded();
  assert.deepEqual(again.get(form.id)?.replyTo, { page: notes.id, card: 4 });
  again.setReplyTo(form.id, null);
  assert.equal(again.get(form.id)?.replyTo, undefined);
  again.closeDb();

  const db = new DatabaseSync(path.join(dir, "scribe.sqlite"));
  db.exec("ALTER TABLE tabs DROP COLUMN reply_to");
  db.close();
  const migrated = loaded();
  migrated.setReplyTo(form.id, { page: "notes" });
  migrated.closeDb();
  const last = loaded();
  assert.deepEqual(last.get(form.id)?.replyTo, { page: notes.id });
  last.closeDb();
});

test("a template change marks its pages' upsert notices, so a page on screen can hold the reload", () => {
  const store = loaded();
  const { template } = store.upsertTemplate({ key: "doc", title: "Doc", html: "<p>doc</p>" });
  const { tab } = store.openFromTemplate(template.key, {});
  const notices: Array<[string, { structural: boolean; template?: boolean }]> = [];
  store.on("tab_upserted", (meta, _index, notice) => notices.push([meta.id, notice]));
  store.upsertTemplate({ key: "doc", title: "Doc", html: "<p>doc 2</p>" });
  const refreshed = notices.find(([id]) => id === tab.id);
  assert.equal(refreshed?.[1].structural, true);
  assert.equal(refreshed?.[1].template, true);

  notices.length = 0;
  store.update(tab.id, { title: "Renamed", viewer: "user" });
  assert.equal(notices.find(([id]) => id === tab.id)?.[1].template, undefined);
  store.closeDb();
});
