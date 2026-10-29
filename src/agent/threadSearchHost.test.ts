import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// The host keeps its data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-thread-search-"));
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

test("message search sees text the host has not written to the database yet", () => {
  const thread = host.createThread({ title: "Untitled" });
  // Items are saved in batches; a search right after a message must not miss it.
  (host as unknown as { addItem(threadId: string, turnId: null, body: unknown): unknown }).addItem(thread.id, null, { kind: "user", text: "freshneedle arrived" });
  const hits = host.searchThreadMessages("freshneedle");
  assert.deepEqual(
    hits.map((hit) => hit.id),
    [thread.id]
  );
});
