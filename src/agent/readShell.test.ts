import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import type { ApprovalRequest, RunSink } from "./providers/provider.js";
import type { ApprovalPolicy } from "./types.js";

// Read-only and Board with a workspace run commands (#720): outside Codex's sandbox each one asks the
// user, also in a chat the user watches, and is refused after 15 minutes without an answer.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-read-shell-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

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

type Internals = {
  runs: Map<string, unknown>;
  turns: Map<string, unknown[]>;
  makeSink(threadId: string, run: unknown): RunSink;
};
const internals = () => host as unknown as Internals;

function sinkFor(approval: ApprovalPolicy, cwd: string | null): { threadId: string; sink: RunSink } {
  const thread = host.createThread({ provider: "claude", approval, cwd, scope: { kind: "global", ref: null } });
  const turn = { id: `tu_${thread.id}`, threadId: thread.id, seq: 1, status: "running", model: "m", effort: null, mode: thread.mode, startedAt: Date.now() };
  internals().turns.get(thread.id)?.push(turn);
  const run = { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), repo: null, cancelled: false, usage: {}, steer: null, hooks: { lastUser: "", dock: false, called: new Set(), gated: new Set(), approved: new Set(), waiting: new Map(), told: new Set(), earlyItem: null } };
  internals().runs.set(thread.id, run);
  return { threadId: thread.id, sink: internals().makeSink(thread.id, run) };
}

function pendingApprovals(threadId: string) {
  return (host.threadDetail(threadId)?.items ?? []).filter((it) => it.kind === "approval" && it.status === "pending");
}

async function shown(threadId: string) {
  for (let i = 0; i < 50 && !pendingApprovals(threadId).length; i += 1) await new Promise((r) => setImmediate(r));
  const [item] = pendingApprovals(threadId);
  assert.ok(item && item.kind === "approval");
  return item;
}

const options: ApprovalRequest["options"] = [
  { id: "allow", label: "Allow", kind: "allow_once" },
  { id: "deny", label: "Deny", kind: "reject_once" },
];
const command: ApprovalRequest = { toolId: "c1", tool: "execute", title: "Run command", detail: "git status", options };

test("a reading rung's command asks the user and is refused after 15 minutes", async () => {
  const { threadId, sink } = sinkFor("readonly", dir);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const decision = sink.approval(command);
    const item = await shown(threadId);
    assert.match(item.detail ?? "", /asks before every command/);
    assert.match(item.detail ?? "", /Refused if not answered by/);
    mock.timers.tick(15 * 60 * 1000);
    const answer = await decision;
    assert.equal(answer.optionId, "deny");
    assert.match(answer.note ?? "", /in time/);
    assert.equal(pendingApprovals(threadId).length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("an answered command runs on the Board rung", async () => {
  const { threadId, sink } = sinkFor("board", dir);
  const decision = sink.approval(command);
  const item = await shown(threadId);
  host.resolveApproval(item.requestId || item.id, "allow");
  assert.equal((await decision).optionId, "allow");
});

test("the reading rungs still refuse edits, and commands without a workspace", async () => {
  const edit = await sinkFor("board", dir).sink.approval({ toolId: "e1", tool: "edit", title: "Edit a.txt", paths: [path.join(dir, "a.txt")], options });
  assert.equal(edit.optionId, "deny");
  const noWorkspace = await sinkFor("readonly", null).sink.approval(command);
  assert.equal(noWorkspace.optionId, "deny");
  assert.match(noWorkspace.note ?? "", /no file or shell access/);
});
