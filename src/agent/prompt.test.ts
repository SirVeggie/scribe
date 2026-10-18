import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanInstructionsOff, contextBlock, contextChipKey, cursorScribeServers, freshContext, guidesBlock, pageKeysIn, threadInstructions } from "./prompt.js";
import type { ContextChip, Thread } from "./types.js";

const page = (id: string, title = id): ContextChip => ({ kind: "page", id, key: `scribe:${id}`, title });
const folder = (id: string): ContextChip => ({ kind: "folder", id, path: `Folder/${id}` });
const file = (p: string): ContextChip => ({ kind: "file", path: p });
const sel = (text: string): ContextChip => ({ kind: "selection", text });

test("freshContext drops pages, folders and files the thread already has", () => {
  const already = [page("t1", "Todo"), folder("f1"), file("/a.ts")];
  assert.deepEqual(freshContext([page("t1", "Todo"), page("t2", "Notes")], already), [page("t2", "Notes")]);
  assert.deepEqual(freshContext([folder("f1"), file("/a.ts"), file("/b.ts")], already), [file("/b.ts")]);
  assert.deepEqual(freshContext([page("t1")], already), []);
  assert.deepEqual(freshContext(undefined, already), []);
});

test("freshContext keeps selections and unique chips in one message", () => {
  const chips: ContextChip[] = [page("t1"), page("t1"), sel("hello"), sel("hello")];
  assert.deepEqual(freshContext(chips, []), [page("t1"), sel("hello"), sel("hello")]);
});

test("contextBlock names pages, folders, files and selections", () => {
  const text = contextBlock([page("t1", "Todo"), folder("f1"), file("src/a.ts"), sel("hello")]);
  assert.match(text, /Scribe page: "Todo" \(key: scribe:t1\)/);
  assert.match(text, /Library folder: Folder\/f1/);
  assert.match(text, /File: src\/a\.ts/);
  assert.match(text, /Selected text:\n"""\nhello\n"""/);
  assert.equal(contextBlock([]), "");
});

test("contextChipKey ignores selections", () => {
  assert.equal(contextChipKey(page("t1")), "page:t1");
  assert.equal(contextChipKey(sel("x")), null);
});

test("threads with a workspace are told their shell already starts there", () => {
  const thread = (over: Partial<Thread>): Thread =>
    ({ provider: "claude", mode: "code", cwd: "/work", scope: { kind: "global", ref: null }, ...over }) as Thread;
  assert.match(threadInstructions(thread({}), {}), /Workspace: \/work\nShell commands already run in the workspace folder/);
  assert.doesNotMatch(threadInstructions(thread({ cwd: null }), {}), /Shell commands already run/);
  assert.doesNotMatch(threadInstructions(thread({ mode: "board" }), {}), /Shell commands/);
});

test("Code threads with no workspace are told they start in a scratch folder", () => {
  const thread = (over: Partial<Thread>): Thread =>
    ({ provider: "claude", mode: "code", cwd: null, scope: { kind: "global", ref: null }, ...over }) as Thread;
  assert.match(threadInstructions(thread({}), {}), /Workspace: none\. .*scratch folder/);
  assert.doesNotMatch(threadInstructions(thread({ mode: "board" }), {}), /Workspace: none/);
  assert.doesNotMatch(threadInstructions(thread({ cwd: "/work" }), {}), /Workspace: none/);
});

test("helper agents are only mentioned when they are on, and never to a helper", () => {
  const thread = (over: Partial<Thread>): Thread =>
    ({ provider: "claude", mode: "code", cwd: "/work", scope: { kind: "global", ref: null }, ...over }) as Thread;
  assert.doesNotMatch(threadInstructions(thread({}), {}), /agent_run/);
  assert.match(threadInstructions(thread({}), { helpers: true }), /agent_run .*Use it only when the user, or the instructions for this thread, told you/);
  const helper = threadInstructions(thread({ helperOf: "th_1" }), { helpers: true });
  assert.doesNotMatch(helper, /agent_run/);
  assert.match(helper, /Helper thread: .*Your final reply goes back to that agent/);
});

test("every thread is told to check a message that looks meant for another thread", () => {
  const thread = (over: Partial<Thread>): Thread =>
    ({ provider: "cursor", mode: "board", cwd: null, scope: { kind: "global", ref: null }, ...over }) as Thread;
  for (const t of [thread({}), thread({ mode: "code", cwd: "/work" }), thread({ provider: "claude", mode: "ask" })]) {
    assert.match(threadInstructions(t, {}), /Wrong thread: .*ask in one short line whether it was meant for this thread/);
  }
});

test("optional app instructions are on by default and left out once turned off", () => {
  const thread = { provider: "claude", mode: "code", cwd: "/work", scope: { kind: "global", ref: null } } as Thread;
  const all = threadInstructions(thread, {});
  for (const re of [/Wrong thread: /, /User slips: .*check with them in a short line before changing code/, /Code blocks: /, /rename it with thread_update \(title\)/]) assert.match(all, re);
  const none = threadInstructions(thread, { instructionsOff: ["wrongThread", "userSlip", "codeBlocks", "threadTitle"] });
  for (const re of [/Wrong thread: /, /User slips: /, /Code blocks: /, /rename it with thread_update/]) assert.doesNotMatch(none, re);
  // The workspace move is not optional.
  assert.match(none, /This thread: When the work moves to a folder outside the workspace/);
  assert.doesNotMatch(threadInstructions({ ...thread, mode: "board", cwd: null } as Thread, { instructionsOff: ["threadTitle"] }), /This thread:/);
  // Pages with a workspace reads files there (#718).
  const pages = threadInstructions({ ...thread, mode: "board" } as Thread, { instructionsOff: ["threadTitle"] });
  assert.match(pages, /This thread: When you need to read files in a folder outside the workspace/);
  assert.match(pages, /Access: Board\. You can read and search files in the workspace, but not edit them or run commands\./);
  assert.match(pages, /Workspace: \/work\nRelative file paths are relative to this folder\./);
  assert.doesNotMatch(pages, /Shell commands already run/);
  assert.deepEqual(cleanInstructionsOff(["userSlip", "bogus", "userSlip", 3]), ["userSlip"]);
});

test("a thread on a blank New page is told that the page it shows takes that page's place", () => {
  const thread = { provider: "claude", mode: "board", cwd: null, scope: { kind: "page", ref: "t_1" } } as Thread;
  const info = (blank: boolean) => ({ page: { id: "t_1", key: "scribe:new-page", title: "New page", folder: null, blank } });
  assert.match(threadInstructions(thread, info(true)), /takes this blank page's place/);
  assert.doesNotMatch(threadInstructions(thread, info(false)), /blank page/);
  assert.match(threadInstructions(thread, info(false)), /This thread belongs to the Scribe page "New page"/);
});

test("worktree threads with a linked node_modules are told how to change dependencies", () => {
  const wt = (links: string[]) =>
    ({ provider: "claude", mode: "code", cwd: "/wt", scope: { kind: "global", ref: null }, worktree: { home: "/repo", repo: "/repo", path: "/wt", branch: "agent/x", base: "master", baseCommit: "abc", links, createdAt: 0 } }) as Thread;
  const instructions = threadInstructions(wt(["node_modules"]), {});
  assert.match(instructions, /even with --package-lock-only: npm can still change node_modules\/\.package-lock\.json through the link/);
  assert.match(instructions, /verify node_modules is a link and remove only that link/);
  assert.match(instructions, /cmd \/c rmdir node_modules/);
  assert.match(instructions, /rm node_modules/);
  assert.match(instructions, /never a recursive delete/);
  assert.match(instructions, /Then edit package\.json and run `npm install --package-lock-only --ignore-scripts`/);
  assert.doesNotMatch(instructions, /only rewrites package-lock\.json/);
  assert.doesNotMatch(threadInstructions(wt([]), {}), /package-lock-only/);
});

test("threadInstructions includes folder settings, parents first", () => {
  const thread = {
    provider: "claude",
    mode: "board",
    cwd: null,
    scope: { kind: "page", ref: "t1" },
  } as Thread;
  const text = threadInstructions(thread, {
    page: { id: "t1", key: "scribe:notes", title: "Notes", folder: "Work/Releases" },
    folderInstructions: [
      { folder: null, description: "Root summary", text: "Root rule." },
      { folder: "Work/Releases", text: "Release rule." },
    ],
  });
  assert.match(text, /Folder instructions \(for this Library folder and its parents\)/);
  const rootAt = text.indexOf('folder="Library root"');
  const nestedAt = text.indexOf('folder="Work/Releases"');
  assert.ok(rootAt >= 0 && nestedAt > rootAt);
  assert.match(text, /Root rule\./);
  assert.match(text, /Description: Root summary/);
  assert.match(text, /Release rule\./);
  assert.doesNotMatch(threadInstructions(thread, { page: { id: "t1", key: "scribe:notes", title: "Notes", folder: "Work" } }), /Folder instructions/);
});

test("guidesBlock sends each guide once, naming every page it covers", () => {
  const kanban = { id: "tpl_kanban", title: "Kanban board", text: "Use page_action." };
  const todo = { id: "tpl_todo", title: "Todo list", text: "Items live in todos." };
  const block = guidesBlock([
    { key: "scribe:a", guide: kanban, given: false },
    { key: "scribe:b", guide: kanban, given: false },
    { key: "scribe:c", guide: todo, given: true },
  ]);
  assert.equal(block.match(/Use page_action\./g)?.length, 1);
  assert.match(block, /<page_guide template="Kanban board" pages="scribe:a, scribe:b">/);
  assert.match(block, /<page_guide template="Todo list" pages="scribe:c">Given earlier/);
  assert.doesNotMatch(block, /Items live in todos/);
  assert.equal(guidesBlock([]), "");
});

test("pageKeysIn finds scribe: keys without trailing punctuation or repeats", () => {
  assert.deepEqual(pageKeysIn("See [[scribe:agent-todo]] and scribe:Notes.v2. Also scribe:agent-todo, not xscribe:nope."), ["scribe:agent-todo", "scribe:notes.v2"]);
});

test("threads with no Scribe scope are told they have no page tools", () => {
  const thread = (over: Partial<Thread>): Thread =>
    ({ provider: "claude", mode: "board", web: "on", cwd: null, scope: { kind: "workspace", ref: null }, ...over }) as Thread;
  const none = threadInstructions(thread({}), {});
  assert.match(none, /no access to Scribe pages/);
  assert.match(none, /Mode: Chat\./);
  assert.doesNotMatch(none, /page_show/);
  const global = threadInstructions(thread({ scope: { kind: "global", ref: null } }), {});
  assert.match(global, /page_show/);
  assert.match(global, /Access: Board\./);
});

test("cursorScribeServers finds Scribe servers in a Cursor MCP config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-mcp-"));
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { scribe: { command: "node" }, board: { args: ["S:/x/agent-board/dist/index.js"] }, keeper: { command: "node" } } }));
  assert.deepEqual(cursorScribeServers(file), ["scribe", "board"]);
  assert.deepEqual(cursorScribeServers(path.join(dir, "missing.json")), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Pi threads hear about web_search only when a SearXNG instance is set", () => {
  const thread = (over: Partial<Thread>): Thread =>
    ({ provider: "pi", mode: "code", cwd: "/work", web: "on", scope: { kind: "global", ref: null }, ...over }) as Thread;
  assert.match(threadInstructions(thread({}), {}), /there is no web search/);
  assert.match(threadInstructions(thread({}), { webSearch: true }), /web_search searches the web/);
  assert.match(threadInstructions(thread({ web: "limited" }), { webSearch: true }), /covers those sites\)\. web_search or web_fetch elsewhere/);
  assert.match(threadInstructions(thread({ web: "limited", provider: "cursor" }), {}), /web_fetch \(there is no web search\)/);
});

test("Codex web instructions describe disabled search and the limits of a web_request grant", () => {
  for (const web of ["off", "limited", "on"] as const) {
    const thread = { provider: "codex", mode: "code", cwd: "/work", web, scope: { kind: "global", ref: null } } as Thread;
    // A configured SearXNG instance still does not give Codex a search/fetch bridge.
    const text = threadInstructions(thread, { webSearch: true });
    if (web === "on") {
      assert.doesNotMatch(text, /Native web search is disabled|web_request can record|switch Web to On/);
    } else {
      assert.ok(text.includes(`Web ${web === "limited" ? "Limited" : "Off"}`));
      assert.match(text, /Native web search is disabled/);
      assert.match(text, /Scribe provides no web_search or web_fetch tools for Codex/);
      assert.match(text, /allowlist does not enable native search/);
      assert.match(text, /web_request can record why you need web access/);
      assert.match(text, /even an allowed request does not enable search or fetch/);
      assert.match(text, /switch Web to On to enable native search/);
      assert.doesNotMatch(text, /asks the user first|call web_request first/);
    }
  }
});

test("Claude threads are told which of the user's own MCP servers they do not get", () => {
  const thread = (over: Partial<Thread>): Thread =>
    ({ provider: "claude", mode: "code", cwd: "/work", web: "on", scope: { kind: "global", ref: null }, ...over }) as Thread;
  assert.match(threadInstructions(thread({}), { mcpLeftOut: ["keeper", "db"] }), /MCP servers: .*Not available here, even where a skill says to use one: `keeper`, `db`\. Do not search for their tools/);
  assert.doesNotMatch(threadInstructions(thread({}), {}), /MCP servers:/);
  assert.doesNotMatch(threadInstructions(thread({}), { mcpLeftOut: [] }), /MCP servers:/);
  assert.doesNotMatch(threadInstructions(thread({ provider: "cursor" }), { mcpLeftOut: ["keeper"] }), /MCP servers:/);
});
