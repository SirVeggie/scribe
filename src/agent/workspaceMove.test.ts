import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Thread } from "./types.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-workspace-move-"));
process.env.SCRIBE_HOME = path.join(dir, "home");
process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude");
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
const { claudeProjectDir, findMoved, folderId, moveClaudeProject, movePath } = await import("./workspaceMove.js");
const { readMcpFile, writeMcpFile } = await import("./mcpConfig.js");
const { workspaceKey } = await import("./prefs.js");

let host: InstanceType<typeof AgentHost>;
before(() => {
  store.load();
  host = new AgentHost(() => {});
});
after(() => {
  host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const thread = (patch: Partial<Thread>) => host.createThread({ provider: "pi", mode: "code", cwd: null, scope: { kind: "global", ref: null }, ...patch }, { remember: false });

test("movePath rewrites the folder and what is inside it, not its namesakes", () => {
  const from = path.join(dir, "app");
  const to = path.join(dir, "app-v2");
  assert.equal(movePath(from, from, to), to);
  assert.equal(movePath(path.join(from, "src", "a"), from, to), path.join(to, "src", "a"));
  assert.equal(movePath(`${from}${path.sep}`, from, to), to);
  assert.equal(movePath(path.join(dir, "app-other"), from, to), null);
  assert.equal(movePath(dir, from, to), null);
});

test("findMoved follows a rename, a renamed parent, and a move next to another workspace", () => {
  const root = fs.mkdtempSync(path.join(dir, "find-"));
  const old = path.join(root, "projects", "app");
  fs.mkdirSync(old, { recursive: true });
  const known = { path: old, ...folderId(old)! };

  fs.renameSync(old, path.join(root, "projects", "app2"));
  assert.equal(findMoved(known), path.join(root, "projects", "app2"));

  fs.renameSync(path.join(root, "projects"), path.join(root, "work"));
  assert.equal(findMoved(known), path.join(root, "work", "app2"));

  fs.mkdirSync(path.join(root, "elsewhere"));
  fs.renameSync(path.join(root, "work", "app2"), path.join(root, "elsewhere", "app3"));
  fs.rmdirSync(path.join(root, "work"));
  assert.equal(findMoved({ ...known, path: path.join(root, "gone", "deeper", "app") }, [path.join(root, "elsewhere")]), path.join(root, "elsewhere", "app3"));

  fs.rmdirSync(path.join(root, "elsewhere", "app3"));
  assert.equal(findMoved(known, [path.join(root, "elsewhere")]), null);
});

test("moveClaudeProject renames the session folder, and merges into one that is already there", () => {
  const a = path.join(dir, "c", "one");
  const b = path.join(dir, "c", "two");
  fs.mkdirSync(claudeProjectDir(a), { recursive: true });
  fs.writeFileSync(path.join(claudeProjectDir(a), "s1.jsonl"), "1");
  assert.equal(moveClaudeProject(a, b), 1);
  assert.equal(fs.existsSync(claudeProjectDir(a)), false);
  assert.equal(fs.readFileSync(path.join(claudeProjectDir(b), "s1.jsonl"), "utf8"), "1");

  fs.mkdirSync(claudeProjectDir(a), { recursive: true });
  fs.writeFileSync(path.join(claudeProjectDir(a), "s1.jsonl"), "old");
  fs.writeFileSync(path.join(claudeProjectDir(a), "s2.jsonl"), "2");
  assert.equal(moveClaudeProject(a, b), 1);
  assert.equal(fs.readFileSync(path.join(claudeProjectDir(b), "s1.jsonl"), "utf8"), "1");
  assert.equal(fs.readFileSync(path.join(claudeProjectDir(b), "s2.jsonl"), "utf8"), "2");
  assert.equal(moveClaudeProject(path.join(dir, "c", "none"), b), 0);
});

test("a renamed workspace is detected and every stored path follows it", async () => {
  const parent = fs.mkdtempSync(path.join(dir, "ws-"));
  const old = path.join(parent, "app");
  const sub = path.join(old, "packages", "web");
  fs.mkdirSync(sub, { recursive: true });
  const moved = path.join(parent, "app-v2");

  const root = thread({ cwd: old, provider: "claude" });
  const inner = thread({ cwd: sub, scope: { kind: "workspace", ref: sub } });
  const other = thread({ cwd: parent });
  host.setPrefs({ recentWorkspaces: [old, parent], scopeWorkspaces: { "folder:f1": old }, worktrees: { [workspaceKey(old)]: true } });
  writeMcpFile({ mcpServers: {}, workspaces: { [workspaceKey(old)]: { path: old, mcpServers: { x: { command: "x" } } } } });
  const page = store.upsert({ title: "Board", html: "<p>b</p>", key: "ws-move-board", state: { settings: { workers: { w1: { name: "A", cwd: sub }, w2: { name: "B", cwd: parent } } } } }).tab;
  store.setPagePermission(page.id, "agent.workspace", "ask", [{ path: old, approval: "auto" }]);
  store.setWorkspace(page.id, sub);
  fs.mkdirSync(claudeProjectDir(old), { recursive: true });
  fs.writeFileSync(path.join(claudeProjectDir(old), "s.jsonl"), "{}");

  assert.deepEqual(host.missingWorkspaces(), []);
  fs.renameSync(old, moved);
  assert.deepEqual(host.missingWorkspaces(), [{ path: old, threads: 2, found: moved, dismissed: false }]);
  host.dismissWorkspaceMove(old);
  assert.equal(host.missingWorkspaces()[0].dismissed, true);

  await assert.rejects(host.relocateWorkspace(old, path.join(parent, "nope")), /Folder not found/);
  await assert.rejects(host.relocateWorkspace(parent, moved), /still exists/);
  const result = await host.relocateWorkspace(old, moved);
  assert.equal(result.threads, 2);
  assert.deepEqual(result.notes, ["Moved Claude's sessions and memory (1 file)."]);

  assert.equal(host.getThread(root.id)!.cwd, moved);
  assert.equal(host.getThread(inner.id)!.cwd, path.join(moved, "packages", "web"));
  assert.deepEqual(host.getThread(inner.id)!.scope, { kind: "workspace", ref: path.join(moved, "packages", "web") });
  assert.equal(host.getThread(other.id)!.cwd, parent);
  const prefs = host.prefs();
  assert.deepEqual(prefs.recentWorkspaces, [moved, parent]);
  assert.deepEqual(prefs.scopeWorkspaces, { "folder:f1": moved });
  assert.deepEqual(prefs.worktrees, { [workspaceKey(moved)]: true });
  assert.deepEqual(Object.values(readMcpFile().workspaces).map((layer) => layer.path), [moved]);
  assert.deepEqual(store.pagePermissions(page.id).get("agent.workspace")!.folders, [{ path: moved, approval: "auto" }]);
  assert.equal(store.get(page.id)!.workspace, path.join(moved, "packages", "web"));
  const workers = (store.get(page.id)!.state as { settings: { workers: Record<string, { cwd: string }> } }).settings.workers;
  assert.equal(workers.w1.cwd, path.join(moved, "packages", "web"));
  assert.equal(workers.w2.cwd, parent);
  assert.equal(fs.existsSync(path.join(claudeProjectDir(moved), "s.jsonl")), true);
  assert.deepEqual(host.missingWorkspaces(), []);

  // The new folder's id is saved, so a second rename is found too.
  const again = path.join(parent, "app-v3");
  fs.renameSync(moved, again);
  assert.equal(host.missingWorkspaces()[0].found, again);
});
