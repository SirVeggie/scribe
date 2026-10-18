import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { threadInstructions } from "./prompt.js";
import type { RunSink, TurnInput, TurnResult } from "./providers/provider.js";
import type { ApprovalPolicy, Thread } from "./types.js";

// The host keeps its data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-thread-update-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;
const a = path.join(dir, "a");
const b = path.join(dir, "b");
fs.mkdirSync(a);
fs.mkdirSync(b);

/** What each turn of the stub provider was sent, with the workspace its session had then. */
const turns: Array<{ id: string; cwd: string | null; text: string }> = [];
/** What the next turn does in place of a model: its thread_update call. */
let act: ((threadId: string) => Promise<unknown>) | null = null;

type Internals = { providers: Record<string, unknown>; runs: Map<string, unknown> };

before(() => {
  store.load();
  host = new AgentHost(() => {});
  (host as unknown as Internals).providers.pi = {
    id: "pi",
    label: "Native",
    status: async () => ({ id: "pi", label: "Native", available: true }),
    models: async () => [{ id: "local/m", label: "M", provider: "pi", efforts: [], params: [] }],
    complete: async () => "",
    resolveModel: async () => null,
    prewarm: () => {},
    dispose: () => {},
    createSession: (thread: Thread) => {
      let current = thread;
      return {
        warm: async () => {},
        update: (next: Thread) => {
          current = next;
        },
        commands: async () => [],
        dispose: () => {},
        cancel: async () => {},
        run: async (input: TurnInput, sink: RunSink): Promise<TurnResult> => {
          turns.push({ id: current.id, cwd: current.cwd, text: input.text });
          const step = act;
          act = null;
          if (step) sink.text(JSON.stringify(await step(current.id)));
          return { status: "done" };
        },
      };
    },
  };
});

after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  host.dispose();
  store.closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // left for the OS to clean up
  }
});

function thread(approval: ApprovalPolicy = "ask", extra: Record<string, unknown> = {}): string {
  return host.createThread({ provider: "pi", mode: "code", approval, cwd: a, scope: { kind: "workspace", ref: a }, ...extra }).id;
}

const view = (id: string) => host.threadDetail(id)!;

async function idle(id: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    if (!(host as unknown as Internals).runs.has(id)) {
      // A continuation starts in the same tick as the turn's end; give it one more look.
      await new Promise((r) => setTimeout(r, 20));
      if (!(host as unknown as Internals).runs.has(id)) return;
    }
  }
  throw new Error("the turn did not end");
}

async function answer(id: string, optionId: string) {
  const pending = () => view(id).items.filter((it) => it.kind === "approval" && it.status === "pending");
  for (let i = 0; i < 200 && !pending().length; i += 1) await new Promise((r) => setTimeout(r, 5));
  const [item] = pending();
  assert.ok(item && item.kind === "approval");
  host.resolveApproval(item.requestId || item.id, optionId);
  return item;
}

const mine = (id: string) => turns.filter((t) => t.id === id);

test("thread_update renames the thread, but not one the user named", async () => {
  const id = thread();
  assert.deepEqual(await host.threadUpdateOp(id, { title: "  Fix the\n login   redirect " }), { title: "The thread is now titled “Fix the login redirect”." });
  assert.equal(view(id).thread.title, "Fix the login redirect");
  // The agent's own title is not locked: it can rename again.
  await host.threadUpdateOp(id, { title: "Session cookies" });
  assert.equal(view(id).thread.title, "Session cookies");

  host.updateThread(id, { title: "Mine" });
  const kept = await host.threadUpdateOp(id, { title: "Something else" });
  assert.match(kept.title!, /^Not changed: the user named this thread/);
  assert.equal(view(id).thread.title, "Mine");
  await assert.rejects(host.threadUpdateOp(id, {}), /Pass title, workspace or both/);
});

test("an allowed workspace change applies when the turn ends, and Scribe sends the thread on there", async () => {
  const id = thread("ask");
  let during: string | null = null;
  let reply: unknown;
  act = async (threadId) => {
    reply = await host.threadUpdateOp(threadId, { workspace: b, reason: "The fix is in b." });
    during = view(threadId).thread.cwd;
    return reply;
  };
  host.send(id, { text: "fix it in b" });
  const item = await answer(id, "allow");
  assert.equal(item.kind === "approval" && item.title, `Change workspace to ${b}`);
  assert.match(item.kind === "approval" ? item.detail ?? "" : "", /The fix is in b\./);
  await idle(id);
  assert.match((reply as { workspace: string }).workspace, /^Allowed\. The workspace changes to .* when this turn ends/);
  // The running turn keeps its folder.
  assert.equal(during, a);
  const now = view(id).thread;
  assert.equal(now.cwd, b);
  assert.deepEqual(now.scope, { kind: "workspace", ref: b });
  const ran = mine(id);
  assert.equal(ran.length, 2);
  assert.equal(ran[0].cwd, a);
  assert.equal(ran[1].cwd, b);
  assert.match(ran[1].text, /Sent by Scribe itself[\s\S]*The workspace is now /);
  assert.ok(view(id).items.some((it) => it.kind === "notice" && it.text === `Workspace changed to ${b}.`));
});

test("a denied workspace change leaves the thread where it is", async () => {
  const id = thread("edits");
  let reply: unknown;
  act = async (threadId) => (reply = await host.threadUpdateOp(threadId, { workspace: b }));
  host.send(id, { text: "go" });
  await answer(id, "deny");
  await idle(id);
  assert.match((reply as { workspace: string }).workspace, /^Not changed: the user denied/);
  assert.equal(view(id).thread.cwd, a);
  assert.equal(mine(id).length, 1);
});

test("Full access is not asked, and continue false ends with the change", async () => {
  const id = thread("full");
  act = (threadId) => host.threadUpdateOp(threadId, { workspace: b + path.sep, continue: false });
  host.send(id, { text: "go" });
  await idle(id);
  assert.equal(view(id).items.filter((it) => it.kind === "approval").length, 0);
  assert.equal(view(id).thread.cwd, b);
  assert.equal(mine(id).length, 1);
});

test("a queued message waits behind Scribe's note, so the agent finishes the task it moved for first", async () => {
  const id = thread("full");
  act = async (threadId) => {
    const reply = await host.threadUpdateOp(threadId, { workspace: b });
    host.send(threadId, { text: "and then this" });
    return reply;
  };
  host.send(id, { text: "go" });
  await idle(id);
  const ran = mine(id);
  assert.equal(ran.length, 3);
  assert.equal(ran[1].cwd, b);
  assert.match(ran[1].text, /The workspace is now /);
  assert.match(ran[2].text, /and then this$/);
  assert.equal(ran[2].cwd, b);
});

test("with continue false the queued message runs next, in the new folder", async () => {
  const id = thread("full");
  act = async (threadId) => {
    const reply = await host.threadUpdateOp(threadId, { workspace: b, continue: false });
    host.send(threadId, { text: "and then this" });
    return reply;
  };
  host.send(id, { text: "go" });
  await idle(id);
  const ran = mine(id);
  assert.equal(ran.length, 2);
  assert.equal(ran[1].cwd, b);
  assert.match(ran[1].text, /and then this$/);
});

test("workspaces that cannot change say why", async () => {
  const id = thread("full");
  assert.match((await host.threadUpdateOp(id, { workspace: "relative/dir" })).workspace!, /absolute folder path/);
  assert.match((await host.threadUpdateOp(id, { workspace: path.join(dir, "missing") })).workspace!, /folder not found/);
  assert.match((await host.threadUpdateOp(id, { workspace: a })).workspace!, /already is this thread's workspace/);
  assert.match((await host.threadUpdateOp(id, { workspace: b })).workspace!, /no turn running/);
  const pages = host.createThread({ provider: "pi", mode: "board", approval: "full", cwd: null, scope: { kind: "global", ref: null } }).id;
  assert.deepEqual(await host.threadUpdateOp(pages, { title: "Notes", workspace: b }), { title: "The thread is now titled “Notes”.", workspace: "Not changed: with no turn running the user cannot be asked." });
});

test("a thread's instructions name thread_update; Pages threads only for the title", () => {
  const base = { id: "t", provider: "claude", mode: "code", cwd: a, scope: { kind: "global", ref: null }, web: "on" } as unknown as Thread;
  assert.match(threadInstructions(base, {}), /thread_update \(title\)[\s\S]*thread_update \(workspace\)/);
  const pages = threadInstructions({ ...base, mode: "board", cwd: null }, {});
  assert.match(pages, /thread_update \(title\)/);
  assert.doesNotMatch(pages, /thread_update \(workspace\)/);
});
