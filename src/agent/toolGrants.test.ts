import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ApprovalRequest, RunSink } from "./providers/provider.js";
import type { ApprovalPolicy, ProviderId, Thread } from "./types.js";
import { commandAllowed, commandKey, GRANT_OPTION } from "./toolGrants.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-tool-grants-"));
const workspace = path.join(dir, "workspace");
const outside = path.join(dir, "outside");
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(outside, "sub"), { recursive: true });
fs.writeFileSync(path.join(outside, "a.txt"), "a");
fs.writeFileSync(path.join(outside, "b.txt"), "b");
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
let host: InstanceType<typeof AgentHost>;
before(() => { store.load(); host = new AgentHost(() => {}); });
after(() => { host.dispose(); store.closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

function running(provider: ProviderId = "codex", approval: ApprovalPolicy = "edits") {
  const thread = host.createThread({ provider, approval, mode: "code", cwd: workspace, scope: { kind: "global", ref: null } });
  const turn = { id: `tu_${thread.id}`, threadId: thread.id, seq: 1, status: "running", model: "m", effort: null, mode: "code", startedAt: Date.now() };
  const run = { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), repo: null, cancelled: false, usage: {}, steer: null };
  const internal = host as unknown as { threads: Map<string, Thread>; runs: Map<string, unknown>; turns: Map<string, unknown[]>; makeSink(id: string, run: unknown): RunSink };
  internal.turns.get(thread.id)?.push(turn);
  internal.runs.set(thread.id, run);
  return { id: thread.id, thread: internal.threads.get(thread.id)!, sink: internal.makeSink(thread.id, run) };
}

const options: ApprovalRequest["options"] = [{ id: "allow", label: "Allow once", kind: "allow_once" }, { id: "deny", label: "Deny", kind: "reject_once" }];
const edit = (file: string): ApprovalRequest => ({ tool: "other", access: "write", title: `Edit ${file}`, paths: [file], options });
const run = (command: string): ApprovalRequest => ({ tool: "execute", title: "Run command", detail: command, command, options });

/** The pending ask's options, answered with `pick`; null when nothing was asked. */
async function answer(t: ReturnType<typeof running>, req: ApprovalRequest, pick: string | null) {
  const pending = t.sink.approval(req);
  await new Promise((resolve) => setImmediate(resolve));
  const item = host.threadDetail(t.id)?.items.find((it) => it.kind === "approval" && it.status === "pending");
  if (!item || item.kind !== "approval") return { asked: null, decision: await pending };
  host.resolveApproval(item.requestId, pick ?? "deny");
  return { asked: item.options.map((o) => o.id), decision: await pending };
}

test("command keys take the program and a plain subcommand, and never match chained commands", () => {
  assert.equal(commandKey("git status --short"), "git status");
  assert.equal(commandKey("ls -la"), "ls");
  assert.equal(commandKey("npm test"), "npm test");
  assert.equal(commandKey("git status && rm -rf x"), null);
  assert.equal(commandKey("echo $(whoami)"), null);
  assert.equal(commandKey("cat a > b"), null);
  assert.ok(commandAllowed("git status", "git  status --short"));
  assert.ok(!commandAllowed("git status", "git log"));
  assert.ok(!commandAllowed("git status", "git status; rm x"));
  assert.ok(!commandAllowed("git", "gitk"));
  assert.ok(commandAllowed("", "anything | at all"));
});

test("a file allowed for the thread is not asked about again; a folder grant covers its files", async () => {
  const t = running();
  const a = path.join(outside, "a.txt");
  const first = await answer(t, edit(a), GRANT_OPTION.file);
  assert.deepEqual(first.asked, ["allow", GRANT_OPTION.file, GRANT_OPTION.folder, "deny"]);
  assert.equal(first.decision.optionId, "allow");
  assert.equal((await answer(t, edit(a), null)).asked, null);
  // Another file in the same folder still asks; this time allow the folder.
  const b = await answer(t, edit(path.join(outside, "b.txt")), GRANT_OPTION.folder);
  assert.ok(b.asked);
  assert.equal((await answer(t, edit(path.join(outside, "sub", "new.txt")), null)).asked, null);
  assert.ok((await answer(t, edit(path.join(dir, "elsewhere.txt")), "deny")).asked);
  assert.ok(host.threadDetail(t.id)?.thread.grants?.some((g) => g.kind === "tools"));
});

test("a read folder grant covers reads but not edits", async () => {
  const t = running("claude");
  const read: ApprovalRequest = { tool: "read", title: "Read", paths: [path.join(outside, "sub")], options };
  const first = await answer(t, read, GRANT_OPTION.readFolder);
  assert.deepEqual(first.asked, ["allow", GRANT_OPTION.readFolder, "deny"]);
  assert.equal((await answer(t, { ...read, paths: [path.join(outside, "sub", "x.txt")] }, null)).asked, null);
  assert.ok((await answer(t, edit(path.join(outside, "sub", "x.txt")), "deny")).asked);
});

test("Native commands can be allowed by their first words for the thread, or for every thread", async () => {
  const t = running("pi");
  const first = await answer(t, run("git status --short"), GRANT_OPTION.command);
  assert.deepEqual(first.asked, ["allow", GRANT_OPTION.command, GRANT_OPTION.allCommands, GRANT_OPTION.alwaysCommand, "deny"]);
  assert.equal(first.decision.optionId, "allow");
  assert.equal((await answer(t, run("git status"), null)).asked, null);
  assert.ok((await answer(t, run("git log"), "deny")).asked);
  const chained = await answer(t, run("git status && rm x"), "deny");
  assert.deepEqual(chained.asked, ["allow", GRANT_OPTION.allCommands, "deny"]);

  await answer(running("cursor"), run("npm test -- --watch"), GRANT_OPTION.alwaysCommand);
  assert.deepEqual(host.prefs().commandAllowlist, ["npm test"]);
  assert.equal((await answer(running("pi"), run("npm test"), null)).asked, null);
  host.setPrefs({ commandAllowlist: [] });
});

test("providers with their own command approvals and hook asks get no Scribe grant options", async () => {
  const codex = await answer(running("codex"), run("git status"), "deny");
  assert.deepEqual(codex.asked, ["allow", "deny"]);
  const hook = await answer(running("pi"), { ...run("git status"), humanOnly: true }, "deny");
  assert.deepEqual(hook.asked, ["allow", "deny"]);
});

test("a tool grant can be taken back from the thread's permissions", async () => {
  const t = running("pi");
  await answer(t, run("ls -la"), GRANT_OPTION.command);
  const row = host.threadDetail(t.id)?.thread.grants?.find((g) => g.kind === "tools");
  assert.ok(row);
  host.revokeGrant(t.id, row.key);
  assert.ok((await answer(t, run("ls"), "deny")).asked);
});
