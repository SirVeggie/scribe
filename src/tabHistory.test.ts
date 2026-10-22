import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const navigation = app.slice(app.indexOf("  function neighborTabId("), app.indexOf("  function activeTab("));
const selection = app.slice(app.indexOf("  function selectTab("), app.indexOf("  async function confirmDelete("));

function viewer(ids: string[], activeId = ids[0]) {
  const state = { tabs: ids.map(id => ({ id })), closed: [] as { id: string }[], activeId };
  const location = { hash: `#${activeId}`, pathname: "/", search: "" };
  const entries = [{ boardIndex: 0, hash: location.hash }];
  let cursor = 0;
  let splitTarget: string | null = null;
  const poppedOut = new Set<string>();
  const api: any = {};
  const update = (entry: { boardIndex: number }, url: string) => {
    location.hash = url.includes("#") ? url.slice(url.indexOf("#")) : "";
    return { ...entry, hash: location.hash };
  };
  const history = {
    get state() { return entries[cursor]; },
    pushState(entry: { boardIndex: number }, _: string, url: string) {
      entries.splice(cursor + 1);
      entries.push(update(entry, url));
      cursor++;
    },
    replaceState(entry: { boardIndex: number }, _: string, url: string) { entries[cursor] = update(entry, url); },
    go(step: number) {
      if (!entries[cursor + step]) return;
      cursor += step;
      location.hash = entries[cursor].hash;
      api.onHistoryStep({ state: history.state });
    },
  };
  runInNewContext(`${navigation}\n${selection}\nObject.assign(api, { syncHash, selectTab, upsertClosed, neighborTabId, onHistoryStep });`, {
    api, state, location, history, childId: null, pendingFocus: null, lastInteractedAt: 0,
    views: { returnTarget: () => splitTarget, onClosed() {}, isShown: () => false, onSelect() {} },
    popout: { has: (id: string) => poppedOut.has(id) },
    unread: new Set(), unreadLibrary: new Set(), discardFrame() {}, refreshFrame() {},
    render() {}, reportViewer() {}, setTimeout() {},
  });
  api.syncHash();
  return {
    state, location, history, poppedOut,
    select: (id: string) => api.selectTab(id, { fromUser: true }),
    close: (id: string) => api.upsertClosed({ id }),
    split: (id: string) => { splitTarget = id; },
  };
}

test("closed imports stay read and subsequent content changes get an unread indicator", () => {
  const state = { tabs: [], closed: [], activeId: null };
  const unreadLibrary = new Set<string>();
  const api: any = {};
  const upsert = app.slice(app.indexOf("  function upsertClosed("), app.indexOf("  function libraryPages("));
  runInNewContext(`${upsert}\napi.upsertClosed = upsertClosed;`, {
    api, state, unreadLibrary, unread: new Set(),
    views: { isShown: () => false }, discardFrame() {}, neighborTabId: () => null,
  });
  const tab = { id: "import", revision: 1, stateRevision: 0 };
  api.upsertClosed(tab, true, false);
  assert.equal(unreadLibrary.has(tab.id), false);
  api.upsertClosed({ ...tab }, false);
  assert.equal(unreadLibrary.has(tab.id), false);
  api.upsertClosed({ ...tab, revision: 2 }, true);
  assert.equal(unreadLibrary.has(tab.id), true);
  api.upsertClosed({ id: "agent", revision: 1 }, true);
  assert.equal(unreadLibrary.has("agent"), true);
});

test("closing the focused tab returns to its source instead of its strip neighbor", () => {
  const v = viewer(["source", "left", "linked", "right"]);
  v.select("linked");
  v.close("linked");
  assert.equal(v.state.activeId, "source");
  assert.equal(v.location.hash, "#source");
  assert.equal(v.state.tabs.some(tab => tab.id === "linked"), false);
});

test("closing skips closed history entries and repeated visits to the closing tab", () => {
  const v = viewer(["source", "old", "linked", "right"]);
  v.select("linked");
  v.select("old");
  v.select("linked");
  v.close("old");
  assert.equal(v.state.activeId, "linked", "closing a background tab keeps focus");
  v.close("linked");
  assert.equal(v.state.activeId, "source");
  assert.deepEqual(v.state.tabs.map(tab => tab.id), ["source", "right"]);
});

test("successive closes return through the remaining open history", () => {
  const v = viewer(["a", "b", "c", "right"]);
  v.select("b");
  v.select("c");
  v.close("c");
  assert.equal(v.state.activeId, "b");
  v.close("b");
  assert.equal(v.state.activeId, "a");
});

test("Back and Forward set the closing history cursor; new focus discards forward history", () => {
  const v = viewer(["a", "b", "c", "d", "right"]);
  v.select("b");
  v.select("c");
  v.history.go(-1);
  assert.equal(v.state.activeId, "b");
  v.history.go(1);
  v.close("c");
  assert.equal(v.state.activeId, "b");
  v.history.go(-1);
  v.history.go(-1);
  assert.equal(v.state.activeId, "a");
  v.select("d");
  v.close("d");
  assert.equal(v.state.activeId, "a");
});

test("no valid previous tab falls back to right, then left, then no tab", () => {
  const v = viewer(["left", "current", "right"], "current");
  v.close("current");
  assert.equal(v.state.activeId, "right");
  v.close("right");
  assert.equal(v.state.activeId, "left");
  v.close("left");
  assert.equal(v.state.activeId, null);
  assert.equal(v.location.hash, "");
});

test("closed and popped-out history entries are ignored; split panes keep their return target", () => {
  const v = viewer(["a", "b", "current", "right"]);
  v.select("b");
  v.select("current");
  v.close("a");
  v.poppedOut.add("b");
  v.close("current");
  assert.equal(v.state.activeId, "right");
  const split = viewer(["a", "pane", "current", "right"]);
  split.select("current");
  split.split("pane");
  split.close("current");
  assert.equal(split.state.activeId, "pane");
});
