import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { grantRows, revokeGrant } from "./grants.js";
import { harnessDocs, parseHarnessOps, planHarnessChange, writeHarnessPlan } from "./harnessSetup.js";
import { cleanFile } from "./mcpConfig.js";

function roots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-harness-setup-"));
  const workspace = path.join(base, "ws");
  fs.mkdirSync(workspace);
  return { workspace, home: path.join(base, "home"), data: path.join(base, "data") };
}

const mcp = cleanFile({ mcpServers: { db: { command: "node", args: ["db.js"], env: { TOKEN: "tok-9f2x", PORT: "1" } } } });

test("mcp_set merges into the existing server, null drops a key, and secrets stay masked", () => {
  const r = roots();
  const ops = parseHarnessOps({ changes: [{ op: "mcp_set", name: "db", server: { args: ["db.js", "--fast"], env: { PORT: null, MODE: "x" } } }] });
  const plan = planHarnessChange(ops, { mcp, hookRules: [] }, r);
  assert.deepEqual(plan.mcp?.mcpServers.db, { command: "node", args: ["db.js", "--fast"], env: { TOKEN: "tok-9f2x", MODE: "x" } });
  assert.match(plan.lines[0], /^Change MCP server "db" for every workspace: runs: node db.js --fast; env TOKEN=•••, MODE=•••$/);
  assert.ok(!plan.lines[0].includes("tok-9f2x"));
  // The input file is untouched until the caller saves the plan.
  assert.deepEqual(mcp.mcpServers.db.args, ["db.js"]);
});

test("workspace servers go to the workspace layer; removal drops an empty layer", () => {
  const r = roots();
  const added = planHarnessChange(parseHarnessOps({ changes: [{ op: "mcp_set", name: "web", scope: "workspace", server: { url: "https://x.test/mcp", type: "http" } }] }), { mcp, hookRules: [] }, r);
  const layers = Object.values(added.mcp!.workspaces);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].path, r.workspace);
  assert.deepEqual(layers[0].mcpServers.web, { url: "https://x.test/mcp", type: "http" });
  const removed = planHarnessChange(parseHarnessOps({ changes: [{ op: "mcp_remove", name: "web", scope: "workspace" }] }), { mcp: added.mcp!, hookRules: [] }, r);
  assert.deepEqual(removed.mcp!.workspaces, {});
});

test("a bad op fails the whole change with a message naming it", () => {
  const r = roots();
  const ops = parseHarnessOps({ changes: [{ op: "hook_set", rule: { pattern: "rm -rf", action: "block" } }, { op: "mcp_set", name: "scribe", server: { command: "x" } }] });
  assert.throws(() => planHarnessChange(ops, { mcp, hookRules: [] }, r), /Change 2 \(mcp_set\): "scribe" is not a name/);
  assert.throws(() => parseHarnessOps({ changes: [] }), /Send changes/);
  assert.throws(() => planHarnessChange(parseHarnessOps({ changes: [{ op: "mcp_set", name: "a", server: { args: ["x"] } }] }), { mcp, hookRules: [] }, r), /command \(stdio\) or url/);
  assert.throws(() => planHarnessChange(parseHarnessOps({ changes: [{ op: "file_write", path: path.join(r.workspace, "src", "x.ts"), text: "" }] }), { mcp, hookRules: [] }, r), /only writes skill files/);
});

test("hook_set adds a rule, changes one by id, and hook_remove takes it away", () => {
  const r = roots();
  const added = planHarnessChange(parseHarnessOps({ changes: [{ op: "hook_set", rule: { match: "keyword", pattern: "rm -rf", action: "block", text: "No deletes" } }] }), { mcp, hookRules: [] }, r);
  assert.equal(added.hookRules?.length, 1);
  const id = added.hookRules![0].id;
  const changed = planHarnessChange(parseHarnessOps({ changes: [{ op: "hook_set", rule: { id, enabled: false } }] }), { mcp, hookRules: added.hookRules! }, r);
  assert.equal(changed.hookRules![0].enabled, false);
  assert.equal(changed.hookRules![0].pattern, "rm -rf");
  const gone = planHarnessChange(parseHarnessOps({ changes: [{ op: "hook_remove", id }] }), { mcp, hookRules: changed.hookRules! }, r);
  assert.deepEqual(gone.hookRules, []);
});

test("skills and instruction files are written only where the providers read them", () => {
  const r = roots();
  const folder = path.join(r.workspace, ".claude", "skills");
  const claudeMd = path.join(r.workspace, "CLAUDE.md");
  const plan = planHarnessChange(
    parseHarnessOps({ changes: [
      { op: "skill_create", folder, name: "deploy", description: "Deploy the app", text: "---\nname: deploy\ndescription: Deploy the app\n---\n\nRun it.\n" },
      { op: "file_write", path: claudeMd, text: "# Notes\n" },
    ] }),
    { mcp, hookRules: [] },
    r
  );
  assert.equal(plan.mcp, undefined);
  writeHarnessPlan(plan, r);
  assert.match(fs.readFileSync(path.join(folder, "deploy", "SKILL.md"), "utf8"), /Run it\./);
  assert.equal(fs.readFileSync(claudeMd, "utf8"), "# Notes\n");
  assert.throws(() => planHarnessChange(parseHarnessOps({ changes: [{ op: "skill_create", folder, name: "deploy", description: "again" }] }), { mcp, hookRules: [] }, r), /already a deploy folder/);
});

test("harness_docs lists the servers with masked env, the rules, and the ops", () => {
  const r = roots();
  const text = harnessDocs({ mcp, hookRules: [], classifier: false }, r);
  assert.match(text, /- db \[global\]: runs: node db\.js; env TOKEN=•••, PORT=•••/);
  assert.ok(!text.includes("tok-9f2x"));
  assert.match(text, /mcp_set/);
  assert.match(text, /No hook rules yet\./);
});

test("the thread grant shows with the others and can be taken back", () => {
  const thread = { cwd: null, worktree: null, scope: { kind: "global" as const, ref: null }, harnessAllowed: true };
  assert.deepEqual(grantRows(thread as never).map((g) => g.key), ["harness"]);
  assert.equal(revokeGrant(thread as never, "harness")?.harnessAllowed, false);
  assert.equal(revokeGrant({ ...thread, harnessAllowed: undefined } as never, "harness"), null);
});
