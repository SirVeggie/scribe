import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bridgeAsks } from "./mcpBridge.js";
import { applyImport, removeCursorImports, bridgedToolName, claudeOwnServers, cleanFile, cleanServer, expandEnv, importCandidates, readMcpFile, resolveServer, serversForThread, setServerEnabled, writeMcpFile } from "./mcpConfig.js";

const thread = (mode: "code" | "ask" | "plan" | "board", cwd: string | null = null) => ({ mode, cwd, worktree: null });

test("Codex TOML imports stdio and HTTP servers while preserving token environment references", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-codex-mcp-"));
  const file = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(file));
  const source = `model = "gpt-5"
[mcp_servers.local]
command = "node"
args = ["server.js", "--stdio"]
cwd = 'C:\\tools'
enabled = false
[mcp_servers.local.env]
PORT = "9000"
[mcp_servers.remote]
url = "https://example.com/mcp"
bearer_token_env_var = "SCRIBE_MCP_TEST_TOKEN"
[mcp_servers.remote.http_headers]
"X-Client" = "scribe"
[mcp_servers.incomplete]
args = ["no-command"]
[mcp_servers.scribe]
command = "reserved"
`;
  try {
    assert.deepEqual(importCandidates([], cleanFile({}), home), []);
    fs.writeFileSync(file, source);
    const current = cleanFile({ mcpServers: { remote: { command: "old" } } });
    const found = importCandidates([], current, home);
    assert.deepEqual(found.map((c) => [c.source, c.name, c.scope, c.exists]), [["codex", "local", "global", false], ["codex", "remote", "global", true]]);
    assert.equal(found[0].file, file);
    assert.deepEqual(found[0].server, { command: "node", args: ["server.js", "--stdio"], env: { PORT: "9000" }, cwd: "C:\\tools", enabled: false });
    assert.deepEqual(found[1].server.headers, { "X-Client": "scribe", Authorization: "Bearer ${SCRIBE_MCP_TEST_TOKEN}" });
    const imported = applyImport(current, found);
    assert.equal(imported.mcpServers.remote.url, "https://example.com/mcp");
    assert.equal(imported.mcpServers.remote.approve, undefined);
    const previous = process.env.SCRIBE_MCP_TEST_TOKEN;
    try {
      process.env.SCRIBE_MCP_TEST_TOKEN = "test-secret";
      assert.equal(resolveServer("remote", "global", imported.mcpServers.remote)?.headers.Authorization, "Bearer test-secret");
      assert.equal(imported.mcpServers.remote.headers?.Authorization, "Bearer ${SCRIBE_MCP_TEST_TOKEN}");
    } finally {
      if (previous === undefined) delete process.env.SCRIBE_MCP_TEST_TOKEN;
      else process.env.SCRIBE_MCP_TEST_TOKEN = previous;
    }
    assert.equal(fs.readFileSync(file, "utf8"), source);
    fs.writeFileSync(file, "[invalid");
    assert.deepEqual(importCandidates([], current, home), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("cleanServer keeps known fields and reads other apps' shapes", () => {
  assert.deepEqual(cleanServer({ command: "npx", args: ["-y", "x"], env: { A: 1 }, foo: "bar" }), { command: "npx", args: ["-y", "x"], env: { A: "1" } });
  assert.deepEqual(cleanServer({ type: "streamable-http", url: "https://x/mcp" }), { url: "https://x/mcp", type: "http" });
  assert.equal(cleanServer({ command: "x", disabled: true })?.enabled, false);
  assert.equal(cleanServer({ args: ["x"] }), null);
  assert.deepEqual(cleanServer({ enabled: false }), { enabled: false });
});

test("servers reach threads by mode, enabled, and workspace layer", () => {
  const file = cleanFile({
    mcpServers: {
      docs: { command: "docs" },
      board: { command: "b", modes: ["board", "code"] },
      off: { command: "o", enabled: false },
      shared: { command: "global" },
    },
    workspaces: {
      "S:\\Proj": { mcpServers: { shared: { command: "local" }, docs: { enabled: false }, db: { command: "db", approve: "auto" } } },
    },
  });
  const names = (mode: "code" | "plan" | "board", cwd: string | null) => serversForThread(thread(mode, cwd), file, null).map((s) => s.name).sort();
  assert.deepEqual(names("code", null), ["board", "docs", "shared"]);
  assert.deepEqual(names("board", null), ["board"]);
  assert.deepEqual(names("code", "s:/proj/sub"), ["board", "db", "shared"]);
  assert.deepEqual(names("code", "S:\\Projector"), ["board", "docs", "shared"]);
  const shared = serversForThread(thread("plan", "S:\\Proj"), file, null).find((s) => s.name === "shared");
  assert.equal(shared?.command, "local");
  assert.equal(shared?.layer, "S:\\Proj");
  assert.equal(serversForThread(thread("code", "S:\\Proj"), file, null).find((s) => s.name === "db")?.approve, "auto");
});

test("a worktree thread gets its home workspace's servers", () => {
  const file = cleanFile({ workspaces: { "S:\\Proj": { mcpServers: { db: { command: "db" } } } } });
  const wt = { mode: "code" as const, cwd: "C:\\wt\\x", worktree: { home: "S:\\Proj", repo: "S:\\Proj", path: "C:\\wt\\x", branch: "b", base: "master", baseCommit: "", links: [], createdAt: 0 } };
  assert.deepEqual(serversForThread(wt, file, null).map((s) => s.name), ["db"]);
});

test("Code chats inherit only Keeper, using the home workspace for worker worktrees", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-keeper-"));
  const ws = path.join(home, "proj");
  const sharedWs = path.join(home, "shared");
  fs.mkdirSync(ws);
  fs.mkdirSync(sharedWs);
  try {
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
      mcpServers: { keeper: { command: "global", approve: "auto" }, unrelated: { command: "other" } },
      projects: { [ws]: { mcpServers: { keeper: { command: "project" } } } },
    }));
    fs.writeFileSync(path.join(sharedWs, ".mcp.json"), JSON.stringify({ mcpServers: { keeper: { url: "http://localhost/mcp" } } }));
    const empty = cleanFile({});
    const global = serversForThread(thread("code"), empty, home);
    assert.deepEqual(global.map((s) => s.name), ["keeper"]);
    assert.equal(global[0].command, "global");
    assert.equal(global[0].approve, "ask");
    for (const mode of ["ask", "plan", "board"] as const) {
      assert.deepEqual(serversForThread(thread(mode, ws), empty, home), []);
    }
    const wt = { ...thread("code", path.join(home, "worktree")), worktree: { home: ws, repo: ws, path: path.join(home, "worktree"), branch: "worker", base: "master", baseCommit: "", links: [], createdAt: 0 } };
    assert.equal(serversForThread(wt, empty, home)[0].command, "project");
    assert.equal(serversForThread(thread("code", sharedWs), empty, home)[0].url, "http://localhost/mcp");

    const custom = cleanFile({ mcpServers: { keeper: { command: "scribe", approve: "auto" } } });
    assert.equal(serversForThread(wt, custom, home)[0].command, "scribe");
    assert.equal(serversForThread(wt, custom, home)[0].approve, "auto");
    for (const keeper of [{ enabled: false }, { command: "scribe", modes: ["ask"] }]) {
      assert.deepEqual(serversForThread(wt, cleanFile({ mcpServers: { keeper } }), home), []);
      assert.deepEqual(serversForThread(wt, cleanFile({ workspaces: { [ws]: { mcpServers: { keeper } } } }), home), []);
    }
    const disabledWs = path.join(home, "disabled");
    fs.mkdirSync(disabledWs);
    fs.writeFileSync(path.join(disabledWs, ".mcp.json"), JSON.stringify({ mcpServers: { keeper: { disabled: true } } }));
    assert.deepEqual(serversForThread(thread("code", disabledWs), empty, home), []);
    assert.deepEqual(serversForThread(thread("code"), empty, path.join(home, "absent")), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("reserved and odd names are dropped", () => {
  const file = cleanFile({ mcpServers: { scribe: { command: "x" }, "bad name": { command: "x" }, ok: { command: "x" } } });
  assert.deepEqual(Object.keys(file.mcpServers), ["ok"]);
});

test("env expansion and tool names", () => {
  assert.equal(expandEnv("a ${FOO} ${env:FOO} ${NOPE}", { FOO: "1" }), "a 1 1 ");
  assert.equal(bridgedToolName("my.server", "do thing"), "my_server__do_thing");
  assert.equal(bridgedToolName("s", "x".repeat(80)).length, 64);
});

test("approval: ask unless full access or the server runs without asking", () => {
  assert.equal(bridgeAsks({ approval: "ask" }, { approve: "ask" }), true);
  assert.equal(bridgeAsks({ approval: "auto" }, { approve: "ask" }), true);
  assert.equal(bridgeAsks({ approval: "full" }, { approve: "ask" }), false);
  assert.equal(bridgeAsks({ approval: "ask" }, { approve: "auto" }), false);
});

test("import lists other apps' servers and applies the picked ones", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-mcp-"));
  const ws = path.join(home, "proj");
  fs.mkdirSync(path.join(ws, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { a: { command: "a" } }, projects: { [ws]: { mcpServers: { b: { type: "sse", url: "http://b" } } } } }));
  fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { a: { command: "a2" }, c: { url: "http://c" } } }));
  fs.writeFileSync(path.join(ws, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { d: { command: "d" } } }));
  const current = cleanFile({ mcpServers: { c: { command: "mine" } } });
  const found = importCandidates([ws], current, home);
  const ids = found.map((c) => `${c.source}:${c.scope === "global" ? "g" : "w"}:${c.name}${c.exists ? "!" : ""}`).sort();
  assert.deepEqual(ids, ["claude:g:a", "claude:w:b", "cursor:g:a", "cursor:g:c!", "cursor:w:d"]);
  const next = applyImport(current, found.filter((c) => c.name !== "c"));
  assert.deepEqual(Object.keys(next.mcpServers).sort(), ["a", "c"]);
  assert.equal(next.mcpServers.c.command, "mine");
  const file = path.join(home, "mcp.json");
  writeMcpFile(next, file);
  const back = readMcpFile(file);
  assert.deepEqual(Object.keys(Object.values(back.workspaces)[0].mcpServers).sort(), ["b", "d"]);
  fs.rmSync(home, { recursive: true, force: true });
});


test("Cursor cleanup backs up global and workspace files and preserves unselected and unknown fields", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-cursor-cleanup-"));
  try {
    const ws = path.join(home, "project");
    const files = [home, ws].map((dir) => path.join(dir, ".cursor", "mcp.json"));
    const original = '{\r\n  "other": {"keep": true}, "mcpServers": {"take": {"command": "take", "cursorOnly": 42}, "leave": {"command": "leave", "unknown": true}}\r\n}\r\n';
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, original);
    }
    const picked = importCandidates([ws], cleanFile({}), home).filter((c) => c.name === "take");
    const current = applyImport(cleanFile({}), picked);
    const results = removeCursorImports(picked, current, home);
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.error, undefined);
      assert.deepEqual(result.names, ["take"]);
      assert.equal(fs.readFileSync(result.backup!, "utf8"), original);
      assert.deepEqual(JSON.parse(fs.readFileSync(result.file, "utf8")), {
        other: { keep: true }, mcpServers: { leave: { command: "leave", unknown: true } },
      });
    }
    assert.equal(current.mcpServers.take.command, "take");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cursor cleanup refuses changed source files, changed Scribe copies and unrelated paths", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-cursor-cleanup-"));
  try {
    const file = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(file));
    const original = JSON.stringify({ mcpServers: { take: { command: "take" } } });
    fs.writeFileSync(file, original);
    const picked = importCandidates([], cleanFile({}), home);
    const current = applyImport(cleanFile({}), picked);
    fs.writeFileSync(file, original + "\n");
    assert.match(removeCursorImports(picked, current, home)[0].error!, /file changed/);
    assert.equal(fs.readFileSync(file, "utf8"), original + "\n");
    fs.writeFileSync(file, original);
    current.mcpServers.take.command = "edited";
    assert.match(removeCursorImports(picked, current, home)[0].error!, /no longer matches/);
    assert.throws(() => removeCursorImports([{ ...picked[0], file: path.join(home, "other.json") }], current, home), /Not a Cursor/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["mcp.json"]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("claudeOwnServers names what Claude Code would load in a workspace", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-claude-own-"));
  const ws = path.join(home, "proj");
  fs.mkdirSync(ws);
  assert.deepEqual(claudeOwnServers(ws, home), []);
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    mcpServers: { keeper: { command: "k" }, scribe: { command: "s" } },
    projects: { [ws]: { mcpServers: { local: { command: "l" } } }, [path.join(home, "other")]: { mcpServers: { nope: { command: "n" } } } },
  }));
  fs.writeFileSync(path.join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { url: "http://s" }, keeper: { command: "k2" } } }));
  assert.deepEqual(claudeOwnServers(ws, home).sort(), ["keeper", "local", "shared"]);
  assert.deepEqual(claudeOwnServers(null, home), ["keeper"]);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a server's switch turns it off for one workspace, or where it is defined", () => {
  const file = cleanFile({
    mcpServers: { github: { command: "gh" }, off: { command: "x", enabled: false } },
    workspaces: { "/work/app": { path: "/work/app", mcpServers: { local: { command: "l" } } } },
  });
  const names = (f: typeof file, cwd: string | null) => serversForThread(thread("code", cwd), f, null).map((s) => s.name).sort();

  // From Everywhere, seen in a workspace: off there alone.
  const here = cleanFile(setServerEnabled(file, "github", "/work/app/sub", false));
  assert.deepEqual(here.workspaces["/work/app/sub"].mcpServers, { github: { enabled: false } });
  assert.deepEqual(names(here, "/work/app/sub"), ["local"]);
  assert.deepEqual(names(here, "/work/app"), ["github", "local"]);
  // On again drops the override, and an empty layer with it.
  const back = cleanFile(setServerEnabled(here, "github", "/work/app/sub", true));
  assert.deepEqual(back, file);

  // With no workspace, or for a workspace's own server, the entry itself changes.
  assert.equal(setServerEnabled(file, "github", null, false).mcpServers.github.enabled, false);
  assert.deepEqual(setServerEnabled(file, "off", null, true).mcpServers.off, { command: "x" });
  const local = setServerEnabled(file, "local", "/work/app", false);
  assert.equal(local.workspaces["/work/app"].mcpServers.local.enabled, false);
  assert.deepEqual(names(local, "/work/app"), ["github"]);
  assert.throws(() => setServerEnabled(file, "missing", null, true), /not found/);
  // The file passed in is left as it was.
  assert.equal(file.mcpServers.github.enabled, undefined);
});
