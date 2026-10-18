import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { RunSink, ApprovalRequest, SessionContext } from "./providers/provider.js";
import type { ApprovalPolicy, Thread, ThreadMode } from "./types.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-approval-"));
const workspace = path.join(dir, "workspace");
const outside = path.join(dir, "workspace-other");
fs.mkdirSync(workspace);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(workspace, "existing.txt"), "inside");
fs.writeFileSync(path.join(outside, "existing.txt"), "outside");
const linkedModules = path.join(workspace, "node_modules");
fs.symlinkSync(outside, linkedModules, process.platform === "win32" ? "junction" : "dir");
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
const { ClaudeProvider } = await import("./providers/claude.js");
let host: InstanceType<typeof AgentHost>;
before(() => { store.load(); host = new AgentHost(() => {}); });
after(() => { host.dispose(); store.closeDb(); fs.unlinkSync(linkedModules); fs.rmSync(dir, { recursive: true, force: true }); });

function running(approval: ApprovalPolicy, mode: ThreadMode = "code", cwd: string | null = workspace) {
  const thread = host.createThread({ provider: "codex", approval, mode, cwd, scope: { kind: "global", ref: null } });
  const turn = { id: `tu_${thread.id}`, threadId: thread.id, seq: 1, status: "running", model: "m", effort: null, mode, startedAt: Date.now() };
  const run = { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), repo: null, cancelled: false, usage: {}, steer: null };
  const internal = host as unknown as { threads: Map<string, Thread>; runs: Map<string, unknown>; turns: Map<string, unknown[]>; makeSink(id: string, run: unknown): RunSink };
  internal.turns.get(thread.id)?.push(turn);
  internal.runs.set(thread.id, run);
  return { id: thread.id, thread: internal.threads.get(thread.id)!, sink: internal.makeSink(thread.id, run) };
}

const request: ApprovalRequest = { tool: "edit", title: "Override native denial", humanOnly: true,
  options: [{ id: "retry", label: "Approve one retry", kind: "allow_once" }, { id: "deny", label: "Keep denied", kind: "reject_once" }] };

test("native denial overrides require a human in every approval policy", async () => {
  for (const policy of ["edits", "auto", "full"] as const) {
    const { id, sink } = running(policy);
    const pending = sink.approval(request);
    const item = host.threadDetail(id)?.items.find((it) => it.kind === "approval");
    assert.ok(item && item.kind === "approval");
    assert.equal(item.status, "pending");
    assert.equal(host.listThreads().find((t) => t.id === id)?.status, "waiting");
    host.resolveApproval(item.requestId, "retry");
    assert.deepEqual(await pending, { optionId: "retry", note: undefined });
  }
});

test("human-only overrides retain Pages tool refusals and ordinary Full/Edits grants", async () => {
  const board = running("full", "board");
  assert.equal((await board.sink.approval(request)).optionId, "deny");
  assert.equal(host.threadDetail(board.id)?.items.some((it) => it.kind === "approval"), false);
  for (const policy of ["full", "edits"] as const) {
    const { id, sink } = running(policy);
    assert.equal((await sink.approval({ ...request, humanOnly: false, paths: ["existing.txt"] })).optionId, "retry");
    assert.equal(host.threadDetail(id)?.items.some((it) => it.kind === "approval"), false);
  }
});

test("a helper's native MCP denial exposes a human retry without granting the parent", async () => {
  const parent = running("auto");
  const helper = running("auto");
  helper.thread.helperOf = parent.id;
  const retryRequest: ApprovalRequest = { ...request, tool: "mcp",
    title: "Codex Auto-review denied this action", detail: "scribe/page_action",
    options: [{ id: "approveRetry", label: "Approve one retry", kind: "allow_once" },
      { id: "keepDenied", label: "Keep denied", kind: "reject_once" }] };
  for (const optionId of ["approveRetry", "keepDenied"]) {
    const pending = helper.sink.approval(retryRequest);
    const view = host.listThreads().find((t) => t.id === helper.id)!;
    assert.equal(view.status, "waiting");
    assert.equal(view.helperOf, parent.id);
    assert.equal(view.asking?.kind, "approval");
    assert.deepEqual(view.asking?.options, retryRequest.options);
    assert.equal(view.asking?.detail, "scribe/page_action");
    assert.ok(view.asking?.itemId);
    assert.equal(host.listThreads().find((t) => t.id === parent.id)?.asking, undefined);
    host.resolveApproval(view.asking!.itemId, optionId);
    assert.equal((await pending).optionId, optionId);
    assert.equal(host.listThreads().find((t) => t.id === helper.id)?.asking, undefined);
    assert.equal(helper.thread.approval, "auto");
    assert.equal(parent.thread.approval, "auto");
  }
});

async function asksUser(paths: string[] | undefined, tool: ApprovalRequest["tool"] = "edit", cwd: string | null = workspace) {
  const { id, sink } = running("edits", "code", cwd);
  const pending = sink.approval({ ...request, humanOnly: false, paths, tool });
  const item = host.threadDetail(id)?.items.find((it) => it.kind === "approval");
  assert.ok(item && item.kind === "approval", `Must ask for ${JSON.stringify(paths)}`);
  assert.equal(item.status, "pending");
  host.resolveApproval(item.requestId, "deny");
  assert.equal((await pending).optionId, "deny");
}

test("Edits grants existing and new targets only within the workspace", async () => {
  for (const paths of [["existing.txt"], [path.join(workspace, "existing.txt")], ["new/nested/file.txt"], ["new/../file.txt"]]) {
    const { id, sink } = running("edits");
    assert.equal((await sink.approval({ ...request, humanOnly: false, paths })).optionId, "retry");
    assert.equal(host.threadDetail(id)?.items.some((it) => it.kind === "approval"), false);
  }
});

test("Edits asks for outside targets, junction writes, relative escapes and unknown paths", async () => {
  for (const paths of [
    [path.join(outside, "existing.txt")],
    [path.join(outside, "new/file.txt")],
    ["../workspace-other/existing.txt"],
    ["node_modules/existing.txt"],
    ["node_modules/new/file.txt"],
    ["node_modules/../escaped.txt"],
    ["existing.txt", path.join(outside, "existing.txt")],
    undefined, [], [""], ["bad\0path"],
  ]) await asksUser(paths);
  await asksUser(["existing.txt"], "edit", null);
  if (process.platform === "win32") {
    const drive = path.parse(workspace).root[0].toUpperCase() === "Z" ? "Y" : "Z";
    await asksUser([`${drive}:\\outside.txt`]);
  }
});

test("Edits uses the worktree itself and never grants its recorded dependency links for writes", async () => {
  const { id, thread, sink } = running("edits", "code", outside);
  thread.worktree = { home: outside, repo: outside, path: workspace, branch: "test", base: "master", baseCommit: "test", links: ["node_modules"], createdAt: Date.now() };
  assert.equal((await sink.approval({ ...request, humanOnly: false, paths: ["existing.txt"] })).optionId, "retry");
  for (const file of [path.join(outside, "existing.txt"), "node_modules/existing.txt"]) {
    const pending = sink.approval({ ...request, humanOnly: false, paths: [file] });
    const item = host.threadDetail(id)?.items.find((it) => it.kind === "approval" && it.status === "pending");
    assert.ok(item && item.kind === "approval");
    host.resolveApproval(item.requestId, "deny");
    assert.equal((await pending).optionId, "deny");
  }
});

test("Claude passes edit and write targets to the host approval gate", async () => {
  const provider = new ClaudeProvider();
  try {
    for (const [name, input] of [
      ["Edit", { file_path: "existing.txt" }],
      ["Write", { file_path: "new/file.txt" }],
      ["NotebookEdit", { notebook_path: "new/book.ipynb" }],
      ["Edit", { file_path: path.join(outside, "existing.txt") }],
      ["Write", { file_path: "node_modules/new/file.txt" }],
    ] as const) {
      const { id, thread, sink } = running("edits");
      const session = provider.createSession(thread, { approval: (_id, req) => sink.approval(req) } as SessionContext);
      const internal = session as unknown as { canUseTool(name: string, input: Record<string, unknown>, opts: { signal: AbortSignal }): Promise<{ behavior: string }> };
      const pending = internal.canUseTool(name, input, { signal: new AbortController().signal });
      const item = host.threadDetail(id)?.items.find((it) => it.kind === "approval");
      if ("file_path" in input && (input.file_path.startsWith(outside) || input.file_path.startsWith("node_modules"))) {
        assert.ok(item && item.kind === "approval");
        host.resolveApproval(item.requestId, "deny");
        assert.equal((await pending).behavior, "deny");
      } else {
        assert.equal(item, undefined);
        assert.equal((await pending).behavior, "allow");
      }
      session.dispose();
    }
  } finally { provider.dispose(); }
});

test("Edits checks delete and every move target; Full still grants outside edits", async () => {
  await asksUser([path.join(outside, "existing.txt")], "delete");
  await asksUser(["existing.txt", path.join(outside, "moved.txt")], "move");
  const { id, sink } = running("full");
  assert.equal((await sink.approval({ ...request, humanOnly: false, paths: [path.join(outside, "existing.txt")] })).optionId, "retry");
  assert.equal(host.threadDetail(id)?.items.some((it) => it.kind === "approval"), false);
});

test("Native Auto review grants confident commands and asks on failed review", async () => {
  const { id, thread, sink } = running("auto");
  thread.provider = "pi";
  const internals = host as unknown as { runs: Map<string, any> };
  internals.runs.get(id).hooks = { lastUser: "Check status", approved: new Set() };
  host.hookBackend = {
    maySend: () => true,
    decide: async () => ({ ok: true, answers: { safe: { type: "yesno", yes: 0.99 } }, source: "fake", model: "fake", ms: 0, cached: false, usage: { inputTokens: 0, outputTokens: 0 } }),
  };
  const command: ApprovalRequest = { tool: "execute", title: "Run command", detail: "git status", options: request.options };
  assert.equal((await sink.approval(command)).optionId, "retry");
  assert.equal(host.threadDetail(id)?.items.some((item) => item.kind === "approval"), false);
  host.hookBackend.decide = async () => ({ ok: false, error: "disabled", message: "off", ms: 0 });
  const pending = sink.approval(command);
  await new Promise((resolve) => setImmediate(resolve));
  const item = host.threadDetail(id)?.items.find((item) => item.kind === "approval" && item.status === "pending");
  assert.ok(item && item.kind === "approval");
  assert.match(item.detail ?? "", /unavailable, disabled, or timed out/);
  host.resolveApproval(item.requestId, "deny");
  assert.equal((await pending).optionId, "deny");
});

test("Native Auto review checks junction targets rather than lexical workspace paths", async () => {
  const { id, thread, sink } = running("auto");
  thread.provider = "pi";
  assert.equal((await sink.approval({ ...request, humanOnly: false, paths: ["existing.txt"] })).optionId, "retry");
  const pending = sink.approval({ ...request, humanOnly: false, paths: ["node_modules/existing.txt"] });
  const item = host.threadDetail(id)?.items.find((item) => item.kind === "approval" && item.status === "pending");
  assert.ok(item && item.kind === "approval");
  host.resolveApproval(item.requestId, "deny");
  assert.equal((await pending).optionId, "deny");
});
