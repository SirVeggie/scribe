import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Thread } from "./types.js";
import type { TurnResult } from "./providers/provider.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-workspace-folder-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
const hosts: InstanceType<typeof AgentHost>[] = [];
before(() => store.load());
after(() => {
  for (const host of hosts) host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(run: () => Promise<TurnResult> = async () => ({ status: "done" })) {
  const host = new AgentHost(() => {});
  hosts.push(host);
  let sessions = 0;
  let runs = 0;
  let prewarms = 0;
  const provider = (host as unknown as { providers: Record<string, { createSession: () => unknown; prewarm: () => void }> }).providers.pi;
  provider.prewarm = () => { prewarms++; };
  provider.createSession = () => {
    sessions++;
    return {
      update() {}, warm: async () => {}, dispose() {}, cancel: async () => {},
      run: async () => { runs++; return run(); },
    };
  };
  const thread = (patch: Partial<Thread> = {}) => host.createThread({
    provider: "pi", mode: "code", cwd: null, scope: { kind: "global", ref: null }, ...patch,
  }, { remember: false });
  return { host, thread, counts: () => ({ sessions, runs, prewarms }) };
}

async function settled(host: InstanceType<typeof AgentHost>, id: string, turns = 1) {
  for (let i = 0; i < 100; i++) {
    const detail = host.threadDetail(id)!;
    if (detail.turns.length === turns && detail.thread.status === "idle") return detail;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Turn did not settle");
}

test("a deleted worker folder fails clearly before creating a session or worktree, and can be replaced", async () => {
  const f = fixture();
  const cwd = fs.mkdtempSync(path.join(dir, "deleted-"));
  const t = f.thread({ cwd, useWorktree: true });
  fs.rmdirSync(cwd);
  await f.host.warm(t.id);
  f.host.warmDraft({ provider: "pi", mode: "code", cwd });
  f.host.send(t.id, { text: "Work on the card", from: "page", card: { num: 339, title: "Fix folder" } });
  const detail = await settled(f.host, t.id);
  assert.equal(detail.turns[0].error, `Folder not found: ${cwd}`);
  assert.equal(detail.turns[0].status, "error");
  assert.equal(detail.thread.useWorktree, true);
  assert.equal(detail.thread.worktree, undefined);
  assert.ok(detail.items.some((it) => it.kind === "notice" && it.level === "error" && it.text === `Folder not found: ${cwd}`));
  assert.deepEqual(f.counts(), { sessions: 0, runs: 0, prewarms: 0 });

  f.host.updateThread(t.id, { cwd: dir });
  f.host.send(t.id, { text: "Try again" });
  assert.equal((await settled(f.host, t.id, 2)).turns[1].status, "done");
  assert.equal(f.counts().runs, 1);
});

test("a file at the saved folder path cannot start a provider", async () => {
  const f = fixture();
  const cwd = path.join(dir, "file.txt");
  fs.writeFileSync(cwd, "file");
  const t = f.thread({ cwd, mode: "plan" });
  f.host.send(t.id, { text: "Plan the work" });
  assert.equal((await settled(f.host, t.id)).turns[0].error, `Not a folder: ${cwd}`);
  assert.equal(f.counts().sessions, 0);
});

test("Pages mode checks its folder like Code (#718), and folderless threads use scratch", async () => {
  const f = fixture();
  for (const patch of [{ mode: "board" as const, cwd: null }, { cwd: null }]) {
    const t = f.thread(patch);
    f.host.send(t.id, { text: "Work" });
    assert.equal((await settled(f.host, t.id)).turns[0].status, "done");
  }
  const missing = path.join(dir, "missing");
  const pages = f.thread({ mode: "board", cwd: missing });
  f.host.send(pages.id, { text: "Work" });
  assert.equal((await settled(f.host, pages.id)).turns[0].error, `Folder not found: ${missing}`);
  assert.equal(f.counts().runs, 2);
});

test("queued turns recheck the folder even when a provider session already exists", async () => {
  let finish!: (result: TurnResult) => void;
  const f = fixture(() => new Promise((resolve) => { finish = resolve; }));
  const cwd = fs.mkdtempSync(path.join(dir, "queued-"));
  const t = f.thread({ cwd });
  f.host.send(t.id, { text: "First" });
  for (let i = 0; i < 100 && !finish; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(finish);
  f.host.send(t.id, { text: "Next" });
  fs.rmdirSync(cwd);
  finish({ status: "done" });
  const detail = await settled(f.host, t.id, 2);
  assert.equal(detail.turns[1].error, `Folder not found: ${cwd}`);
  assert.equal(f.counts().runs, 1);
});

test("a folder setup failure keeps the recap for the next attempt", async () => {
  const f = fixture();
  const t = f.thread({ cwd: path.join(dir, "gone") });
  f.host.db.saveThread({ ...t, rewind: { at: null, recap: "Earlier work" } });
  f.host.dispose();
  hosts.splice(hosts.indexOf(f.host), 1);
  const resumed = fixture();
  resumed.host.send(t.id, { text: "Continue" });
  assert.equal((await settled(resumed.host, t.id)).thread.rewind?.recap, "Earlier work");
});
