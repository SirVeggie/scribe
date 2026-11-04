import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Turn } from "./types.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-missing-row-"));
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

// #985: another daemon deleted a running thread's row; the turn's save must not throw, and puts the row back.
test("saving a turn whose thread row went missing restores the row", () => {
  const thread = host.createThread({ provider: "pi", temporary: true });
  const db = (host as unknown as { db: { deleteThread(id: string): void; getThread(id: string): unknown; listTurns(id: string): Turn[] } }).db;
  db.deleteThread(thread.id);
  assert.equal(db.getThread(thread.id), null);
  const turn = { id: "tu_missing", threadId: thread.id, seq: 1, status: "done", startedAt: Date.now(), endedAt: Date.now() } as unknown as Turn;
  (host as unknown as { saveTurn(turn: Turn): void }).saveTurn(turn);
  assert.ok(db.getThread(thread.id));
  assert.equal(db.listTurns(thread.id).at(-1)?.id, "tu_missing");
});
