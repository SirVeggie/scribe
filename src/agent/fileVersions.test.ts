import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
  const end = Date.now() + 30000;
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

test("a turn reverts from its saved versions without git, unless a file changed since", async () => {
  const work = path.join(dir, "plain");
  fs.mkdirSync(work, { recursive: true });
  const file = path.join(work, "A.java");
  fs.writeFileSync(file, "v1");
  const id = host.createThread({ provider: "codex", mode: "code", approval: "full", cwd: work, scope: { kind: "global", ref: null } }).id;
  turn = async (sink) => {
    edit(sink, "r1", file, "v2");
    edit(sink, "r2", path.join(work, "B.java"), "b");
    return { status: "done" };
  };
  host.send(id, { text: "Edit" });
  await idle(id);
  const [only] = (host as unknown as { loadTurns(id: string): Array<{ id: string }> }).loadTurns(id);
  fs.writeFileSync(file, "user");
  assert.match((await host.revertTurn(id, only.id)).error ?? "", /changed after this turn/);
  fs.writeFileSync(file, "v2");
  assert.deepEqual(await host.revertTurn(id, only.id), { ok: true });
  assert.equal(fs.readFileSync(file, "utf8"), "v1");
  assert.equal(fs.existsSync(path.join(work, "B.java")), false);
});

const hasSvn = (() => {
  try {
    execFileSync("svnadmin", ["--version", "--quiet"], { windowsHide: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("in an svn working copy, a turn's shell edits are caught and earlier user edits left out", { skip: !hasSvn && "svn is not installed" }, async () => {
  const repo = path.join(dir, "svn-repo");
  const wc = path.join(dir, "svn wc");
  execFileSync("svnadmin", ["create", repo], { windowsHide: true });
  execFileSync("svn", ["--non-interactive", "checkout", pathToFileURL(repo).href, wc], { windowsHide: true, stdio: "ignore" });
  fs.writeFileSync(path.join(wc, "a.txt"), "a1\n");
  fs.writeFileSync(path.join(wc, "b.txt"), "b1\n");
  execFileSync("svn", ["--non-interactive", "add", "a.txt", "b.txt"], { cwd: wc, windowsHide: true, stdio: "ignore" });
  execFileSync("svn", ["--non-interactive", "commit", "-m", "start"], { cwd: wc, windowsHide: true, stdio: "ignore" });
  fs.writeFileSync(path.join(wc, "b.txt"), "user\n");
  const id = host.createThread({ provider: "codex", mode: "code", approval: "full", cwd: wc, scope: { kind: "global", ref: null } }).id;
  turn = async () => {
    // As a shell command would: no edit tool reports these.
    fs.writeFileSync(path.join(wc, "a.txt"), "a1\nshell\n");
    fs.writeFileSync(path.join(wc, "gen.txt"), "generated\n");
    return { status: "done" };
  };
  host.send(id, { text: "Run the script" });
  await idle(id);
  const changes = await host.changes(id);
  assert.deepEqual(changes.files.map((f) => [f.path, f.status, f.added, f.removed]).sort(), [["a.txt", "M", 1, 0], ["gen.txt", "A", 1, 0]]);
  assert.match((await host.patch(id)).patch, /\+shell/);
  const [only] = (host as unknown as { loadTurns(id: string): Array<{ id: string }> }).loadTurns(id);
  assert.deepEqual(await host.revertTurn(id, only.id), { ok: true });
  assert.equal(fs.readFileSync(path.join(wc, "a.txt"), "utf8"), "a1\n");
  assert.equal(fs.existsSync(path.join(wc, "gen.txt")), false);
  assert.equal(fs.readFileSync(path.join(wc, "b.txt"), "utf8"), "user\n");
});
