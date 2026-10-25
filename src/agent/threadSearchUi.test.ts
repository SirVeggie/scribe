import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { searchWords } from "./threadSearch.js";

const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
function client(options: { deferred?: boolean; manualTimers?: boolean } = {}) {
  const requests: string[] = [];
  const notifications: string[] = [];
  const pending: ((data: any) => void)[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const threads = new Map();
  const ctx = vm.createContext({
    S: { threads, current: null, details: new Map(), search: "" },
    setTimeout: options.manualTimers ? (fn: () => void) => { timers.set(++timerId, fn); return timerId; } : setTimeout,
    clearTimeout: options.manualTimers ? (id: number) => timers.delete(id) : clearTimeout,
    renderLists: () => notifications.push("lists"),
    window: { dispatchEvent: () => notifications.push("invalidated") }, CustomEvent: class {},
    views: () => [], dock: { onItem: () => {}, onDelta: () => {} }, pageStepsChanged: () => {},
    scopeLabel: (scope: any) => ({ text: scope.ref || "Global" }),
    workspaceDir: (t: any) => t.cwd || "",
    hiddenWorkspaceKeys: () => new Set(), inHiddenWorkspace: () => false,
    nestsUnder: () => false,
    api: async (_method: string, url: string) => {
      requests.push(url);
      if (options.deferred) return new Promise((resolve) => pending.push(resolve));
      return { hits: [{ id: "body", words: ["x", "llama.cpp", "h2o"], snippet: "llama.cpp H2O x" }] };
    },
  });
  vm.runInContext(source.slice(source.indexOf("  function threadRank("), source.indexOf("  /** Keep in sync with src/agent/threadList.ts */")) +
    source.slice(source.indexOf("  function searchThreads("), source.indexOf("  function threadTitle(")), ctx);
  const run = (code: string) => vm.runInContext(code, ctx);
  const json = (code: string) => JSON.parse(JSON.stringify(run(code)));
  const add = (id: string, title: string, activityAt = 1, extra = {}) => threads.set(id, { id, title, activityAt, scope: { kind: "global" }, ...extra });
  // Use the real event handler; unloaded item events return before touching views.
  const eventStart = source.indexOf("  function onEvent(");
  const eventEnd = source.indexOf("\n  }", eventStart) + 4;
  vm.runInContext(source.slice(eventStart, eventEnd), ctx);
  const tick = async () => {
    const batch = [...timers.values()];
    timers.clear();
    for (const fn of batch) fn();
    await Promise.resolve();
  };
  return { run, json, add, requests, pending, tick, notifications };
}

test("client and daemon agree on technical words and stopword dropping", () => {
  const c = client();
  for (const q of ["please show my llama.cpp page", "a", "x", "H2O llama.cpp x", "the my", "", "a b b c"]) {
    assert.deepEqual(c.json(`searchWords(${JSON.stringify(q)})`), searchWords(q));
  }
});

test("short message queries reach the daemon without needing an extra word", async () => {
  const c = client();
  c.add("body", "Model setup");
  assert.equal(await c.run('searchMessages("x")'), true);
  assert.deepEqual(c.requests, ["/thread-search?q=x"]);
  assert.deepEqual(c.json('searchThreads("x").map(t => [t.id, t.snippet])'), [["body", "llama.cpp H2O x"]]);
  assert.equal(await c.run('searchMessages("please show llama.cpp H2O x")'), true);
  assert.deepEqual(c.json('searchThreads("please show llama.cpp H2O x").map(t => t.id)'), ["body"]);
});

test("exact, word, fuzzy, mixed and message matches rank ahead of recency and pinning", () => {
  const c = client();
  c.add("body", "Model setup", 100, { pinned: true });
  c.add("mixed", "llama configuration", 90);
  c.add("scope", "Unrelated", 80, { scope: { ref: "llama h2o" } });
  c.add("fuzzy", "Local language model adapter H2O", 70);
  c.add("title", "Local llama with H2O", 65);
  c.add("words", "h2o with llama", 60);
  c.add("exact", "llama h2o", 1);
  c.run('messageSearch.cache.set("llama h2o", { hits: new Map([ ["body", { words: ["llama", "h2o"], snippet: "body match" }], ["mixed", { words: ["h2o"], snippet: "mixed match" }] ]) })');
  // All-word titles rank ahead of content, even a pinned content hit.
  assert.deepEqual(c.json('searchThreads("llama h2o").map(t => t.id)'), ["exact", "title", "words", "fuzzy", "scope", "mixed", "body"]);
  c.add("sequence", "Lively learning model architecture", 1);
  assert.deepEqual(c.json('searchThreads("llma").map(t => t.id)'), ["mixed", "fuzzy", "title", "words", "exact", "sequence"]);
  assert.equal(c.json('searchThreads("llma").find(t => t.id === "sequence").snippet'), "");
  assert.deepEqual(c.json('searchThreads("please show my llama h2o page").map(t => t.id)'), ["exact", "title", "words", "fuzzy", "scope", "mixed", "body"]);
  assert.deepEqual(c.json('rankedThreads([...S.threads.values()], "llama h2o").map(r => r.thread.id)'), c.json('searchThreads("llama h2o").map(t => t.id)'));
});

test("obsolete in-flight completions cannot overwrite newer hits or populate the cache", async () => {
  const c = client({ deferred: true, manualTimers: true });
  const old = c.run('searchMessages("old")');
  await c.tick();
  const latest = c.run('searchMessages("new")');
  assert.equal(await old, false); // Cancel settles even an in-flight caller immediately.
  await c.tick();
  c.pending[1]({ hits: [{ id: "new", words: ["new"] }] });
  assert.equal(await latest, true);
  c.pending[0]({ hits: [{ id: "old", words: ["old"] }] });
  await Promise.resolve();
  assert.deepEqual(c.json('[...messageSearch.last.keys()]'), ["new"]);
  assert.deepEqual(c.json('[...messageSearch.cache.keys()]'), ["new"]);
});

test("empty and cached queries cancel obsolete requests; cache hits become the fallback", async () => {
  const c = client({ deferred: true, manualTimers: true });
  c.run('messageSearch.cache.set("cached", { at: Date.now(), hits: new Map([["cached", {}]]) })');
  const old = c.run('searchMessages("old")');
  await c.tick();
  assert.equal(await c.run('searchMessages("cached")'), false);
  assert.equal(await old, false);
  c.pending[0]({ hits: [{ id: "old" }] });
  await Promise.resolve();
  assert.deepEqual(c.json('[...messageSearch.last.keys()]'), ["cached"]);
  const debounced = c.run('searchMessages("pending")');
  assert.equal(await c.run('searchMessages("")'), false);
  assert.equal(await debounced, false);
  await c.tick();
  assert.equal(c.requests.length, 1);
});

test("unloaded message additions, deltas and deletions mark cached hits stale and drop in-flight ones", async () => {
  for (const event of [
    { type: "agent_item", item: { id: "item", threadId: "unloaded", kind: "text", text: "edited" } },
    { type: "agent_delta", threadId: "unloaded", itemId: "item", append: "new text" },
    { type: "agent_item_deleted", threadId: "unloaded", id: "item" },
  ]) {
    const c = client({ deferred: true, manualTimers: true });
    c.run('messageSearch.cache.set("cached", { at: Date.now(), hits: new Map([["deleted", {}]]) }); messageSearch.last = new Map([["deleted", {}]])');
    const old = c.run('searchMessages("old")');
    await c.tick();
    c.run(`onEvent(${JSON.stringify(event)})`);
    assert.equal(await old, false);
    // The old hits stay shown until a refreshed search replaces them (#835).
    assert.deepEqual(c.json('[messageSearch.cache.get("cached").at, [...messageSearch.last.keys()]]'), [0, ["deleted"]]);
    c.pending[0]({ hits: [{ id: "obsolete" }] });
    await Promise.resolve();
    assert.deepEqual(c.json('[...messageSearch.cache.keys(), ...messageSearch.last.keys()]'), ["cached", "deleted"]);
    const fresh = c.run('searchMessages("cached")');
    await c.tick();
    c.pending[1]({ hits: [{ id: "updated", words: ["cached"] }] });
    assert.equal(await fresh, true);
    assert.deepEqual(c.json('[...messageSearch.last.keys()]'), ["updated"]);
  }
});

test("text edits and eligibility changes invalidate hits, while metadata-only item updates preserve them", () => {
  const c = client({ manualTimers: true });
  for (const update of [{ text: "after" }, { dropped: true }, { dropped: false, parentToolId: "tool" }]) {
    c.run('{ const item = { id: "i", threadId: "t", seq: 1, kind: "user", text: "before" }; S.details.set("t", { byId: new Map([["i", item]]), items: [item] }); }');
    c.run('messageSearch.cache.set("before", { at: Date.now(), hits: new Map() })');
    c.run(`onEvent({ type: "agent_item", item: { ...S.details.get("t").byId.get("i"), ${Object.entries(update).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(",")} } })`);
    assert.equal(c.run('messageSearch.cache.get("before").at'), 0);
  }
  c.run('messageSearch.cache.set("cached", { at: 1, hits: new Map() }); onEvent({ type: "agent_item", item: { ...S.details.get("t").byId.get("i"), editing: true } })');
  assert.equal(c.run('messageSearch.cache.get("cached").at'), 1);
});

test("streaming invalidations coalesce and refresh an active thread-list query", async () => {
  const c = client({ deferred: true, manualTimers: true });
  c.run('S.search = "current"; invalidateMessageSearch(); invalidateMessageSearch(); invalidateMessageSearch()');
  assert.equal(c.requests.length, 0);
  await c.tick();
  assert.deepEqual(c.notifications, ["lists", "invalidated"]);
  await c.tick();
  assert.deepEqual(c.requests, ["/thread-search?q=current"]);
  c.pending[0]({ hits: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(c.notifications, ["lists", "invalidated", "lists"]);
});

test("a refresh after invalidation keeps content hits until fresh ones arrive (#835)", async () => {
  const c = client({ deferred: true, manualTimers: true });
  c.add("title", "current work");
  c.add("body", "Unrelated");
  c.run('messageSearch.cache.set("current", { at: Date.now(), hits: new Map([["body", { words: ["current"], snippet: "current" }]]) })');
  c.run('S.search = "current"; invalidateMessageSearch()');
  assert.deepEqual(c.json('searchThreads("current").map(t => t.id)'), ["title", "body"]);
  await c.tick();
  await c.tick();
  assert.deepEqual(c.requests, ["/thread-search?q=current"]);
  assert.deepEqual(c.json('searchThreads("current").map(t => t.id)'), ["title", "body"]);
});
