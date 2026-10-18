import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lastSeenPages,
  mcpToolName,
  pageEditsBlock,
  pageEditsSince,
  rememberPages,
  writePageRefs,
  type PageSnapshot,
} from "./pageEdits.js";
import type { Item, Turn } from "./types.js";

const snap = (over: Partial<PageSnapshot> & Pick<PageSnapshot, "id">): PageSnapshot => ({
  key: `scribe:${over.id}`,
  title: over.id,
  revision: 1,
  stateRevision: 1,
  ...over,
});

const tool = (over: Partial<Extract<Item, { kind: "tool" }>>): Extract<Item, { kind: "tool" }> =>
  ({
    id: "i1",
    threadId: "th",
    turnId: "tu",
    seq: 1,
    createdAt: 1,
    kind: "tool",
    toolId: "c1",
    name: "mcp",
    tool: "mcp",
    title: "Scribe: page_show",
    status: "done",
    startedAt: 1,
    ...over,
  });

test("pageEditsSince reports html, state, or both, and skips unchanged or missing pages", () => {
  const seen = [snap({ id: "a", revision: 14, stateRevision: 3 }), snap({ id: "b", revision: 2, stateRevision: 8 }), snap({ id: "gone" })];
  const current = [
    snap({ id: "a", title: "Foo", revision: 16, stateRevision: 3 }),
    snap({ id: "b", revision: 2, stateRevision: 9 }),
    snap({ id: "c", revision: 1, stateRevision: 1 }),
  ];
  const edits = pageEditsSince(seen, current);
  assert.equal(edits.length, 2);
  assert.equal(edits[0].to.title, "Foo");
  assert.deepEqual({ html: edits[0].html, state: edits[0].state }, { html: true, state: false });
  assert.deepEqual({ html: edits[1].html, state: edits[1].state }, { html: false, state: true });
});

test("pageEditsSince ignores state when the snapshot never recorded it", () => {
  const seen = [snap({ id: "a", revision: 10, stateRevision: -1 })];
  assert.equal(pageEditsSince(seen, [snap({ id: "a", revision: 10, stateRevision: 99 })]).length, 0);
  assert.equal(pageEditsSince(seen, [snap({ id: "a", revision: 11, stateRevision: 99 })]).length, 1);
});

test("pageEditsBlock names the page and the revisions", () => {
  const text = pageEditsBlock([
    {
      from: snap({ id: "a", title: "Foo", key: "scribe:foo", revision: 14, stateRevision: 3 }),
      to: snap({ id: "a", title: "Foo", key: "scribe:foo", revision: 16, stateRevision: 3 }),
      html: true,
      state: false,
    },
    {
      from: snap({ id: "b", title: "Board", key: "scribe:board", revision: 1, stateRevision: 8 }),
      to: snap({ id: "b", title: "Board", key: "scribe:board", revision: 1, stateRevision: 9 }),
      html: false,
      state: true,
    },
  ]);
  assert.match(text, /^<context>\n/);
  assert.match(text, /The user edited "Foo" \(scribe:foo\) since your last turn \(rev 14 → 16\); re-read it before changing it\./);
  assert.match(text, /The user edited "Board" \(scribe:board\) since your last turn \(state rev 8 → 9\); re-read it before changing it\./);
  assert.match(
    pageEditsBlock([
      {
        from: snap({ id: "c", title: "Both", key: "scribe:both", revision: 1, stateRevision: 2 }),
        to: snap({ id: "c", title: "Both", key: "scribe:both", revision: 2, stateRevision: 3 }),
        html: true,
        state: true,
      },
    ]),
    /rev 1 → 2, state rev 2 → 3/
  );
  assert.equal(pageEditsBlock([]), "");
});

test("lastSeenPages prefers the newest turn's snapshots, then pages those turns wrote", () => {
  const turns = [
    { seenPages: [snap({ id: "old" })], page: { id: "wrote", title: "Wrote", before: 1, after: 2 } },
    { page: { id: "later", title: "Later", before: 3, after: 4 } },
    {},
  ] as Turn[];
  assert.deepEqual(lastSeenPages(turns), [snap({ id: "old" })]);
  assert.deepEqual(
    lastSeenPages(turns.slice(1)),
    [snap({ id: "later", key: "", title: "Later", revision: 4, stateRevision: -1 })]
  );
  assert.deepEqual(lastSeenPages([]), []);
});

test("writePageRefs reads key or id from successful page writes across providers", () => {
  assert.deepEqual(
    writePageRefs([
      tool({ name: "mcp__scribe__page_show", title: "Scribe: page_show", input: { key: "scribe:a", title: "A" } }),
      tool({ name: "page_patch", title: "Scribe: page_patch", input: { id: "t_b" } }),
      tool({ name: "mcp", title: "Scribe: page_update", input: { key: "scribe:c" } }),
      tool({ name: "mcp", title: "Scribe: page_read", input: { key: "scribe:skip" } }),
      tool({ name: "mcp", title: "Scribe: page_action", status: "error", input: { key: "scribe:fail" } }),
    ]),
    ["scribe:a", "t_b", "scribe:c"]
  );
});

test("mcpToolName understands Claude, Cursor and Pi names", () => {
  assert.equal(mcpToolName(tool({ name: "mcp__scribe__page_show", title: "Scribe: page_show · scribe:a" })), "page_show");
  assert.equal(mcpToolName(tool({ name: "page_patch", title: "Scribe: page_patch" })), "page_patch");
  assert.equal(mcpToolName(tool({ name: "mcp", title: "Scribe: page_action" })), "page_action");
});

test("rememberPages keeps newly watched pages first and caps the list", () => {
  const watched = [snap({ id: "new" })];
  const prior = [snap({ id: "new", revision: 9 }), snap({ id: "old" }), snap({ id: "older" })];
  assert.deepEqual(
    rememberPages(watched, prior, 2).map((p) => p.id),
    ["new", "old"]
  );
  assert.equal(rememberPages(watched, prior, 2)[0].revision, 1);
});
