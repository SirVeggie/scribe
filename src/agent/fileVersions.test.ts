import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { RunSink, TurnInput, TurnResult } from "./providers/provider.js";
import type { Thread } from "./types.js";

// Workspaces without git (an SVN checkout) keep each edited file's versions, so IntelliJ can diff them.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-versions-"));
process.env.SCRIBE_HOME = path.join(dir, "home");
process.env.SCRIBE_FAKE_AGENTS = "1";
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;
let turn: (sink: RunSink) => Promise<TurnResult> = async () => ({ status: "done" });
const internals = () => host as unknown as { fakes: Record<string, unknown>; runs: Map<string, unknown>; queues: Map<string, unknown[]> };

before(() => {
  store.load();
  host = new AgentHost(() => {});
  internals().fakes.codex = {
    id: "codex",
    label: "Codex",
    status: async () => ({ id: "codex", label: "Codex", available: true }),
    models: async () => [],
    complete: async () => "",
    prewarm: () => {},
    dispose: () => {},
    createSession: (_thread: Thread) => ({
      warm: async () => {},
      update: () => {},
      commands: async () => [],
      dispose: () => {},
      cancel: async () => {},
      run: (_input: TurnInput, sink: RunSink) => turn(sink),
    }),
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

async function idle(id: string): Promise<void> {
  const end = Date.now() + 5000;
  while (internals().runs.has(id) || internals().queues.get(id)?.length) {
    if (Date.now() > end) throw new Error("Timed out waiting for the turn to end");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function edit(sink: RunSink, toolId: string, file: string, text: string): void {
  sink.toolStart({ toolId, name: "Edit", tool: "edit", title: `Edit ${file}`, paths: [file] });
  fs.writeFileSync(file, text);
  sink.toolUpdate(toolId, { status: "done", paths: [file] });
}

test("edits without git keep the first before and the last after of each file, per turn and thread", async () => {
  const work = path.join(dir, "svn checkout");
  fs.mkdirSync(path.join(work, "src"), { recursive: true });
  const file = path.join(work, "src", "A.java");
  fs.writeFileSync(file, "v1");
  const id = host.createThread({ provider: "codex", mode: "code", approval: "full", cwd: work, scope: { kind: "global", ref: null } }).id;
  turn = async (sink) => {
    edit(sink, "t1", file, "v2");
    edit(sink, "t2", file, "v3");
    return { status: "done" };
  };
  host.send(id, { text: "First" });
  await idle(id);
  turn = async (sink) => {
    edit(sink, "t3", file, "v4");
    edit(sink, "t4", path.join(work, "New.java"), "new");
    return { status: "done" };
  };
  host.send(id, { text: "Second" });
  await idle(id);

  const text = (v: { before: Buffer; after: Buffer } | null) => v && [v.before.toString(), v.after.toString()];
  assert.deepEqual(text(host.fileVersions(id, "src/A.java")), ["v1", "v4"]);
  const turns = (await host.changes(id)).files.map((f) => f.path).sort();
  assert.deepEqual(turns, ["New.java", "src/A.java"]);
  const [first, second] = (host as unknown as { loadTurns(id: string): Array<{ id: string }> }).loadTurns(id);
  assert.deepEqual(text(host.fileVersions(id, "src/A.java", first.id)), ["v1", "v3"]);
  assert.deepEqual(text(host.fileVersions(id, "src/A.java", second.id)), ["v3", "v4"]);
  assert.deepEqual(text(host.fileVersions(id, "New.java")), ["", "new"]);
  assert.equal(host.fileVersions(id, "Other.java"), null);

  await host.deleteThread(id);
  assert.equal(fs.existsSync(path.join(process.env.SCRIBE_HOME!, "agent", "file-snapshots", id)), false);
});
