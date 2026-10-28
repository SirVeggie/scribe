import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { Item, AgentEvent } from "./types.js";
import type { RunSink } from "./providers/provider.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-output-images-"));
process.env.SCRIBE_HOME = dir;
const { outputImages, saveOutputImage } = await import("./outputImages.js");
const { filePath } = await import("./attachments.js");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("extracts mixed provider image content without treating ordinary text as images", () => {
  assert.deepEqual(outputImages([
    { type: "text", text: "before" }, { type: "image", data: png, mimeType: "image/png" },
    { type: "image", source: { type: "base64", data: png, media_type: "image/png" } },
    { type: "inputImage", imageUrl: `data:image/png;base64,${png}` },
    { image: { data: png, mimeType: "image/png" } }, { type: "text", text: "after" },
  ]), [{ data: png, mimeType: "image/png" }, { data: png, mimeType: "image/png" },
    { data: `data:image/png;base64,${png}` }, { data: png, mimeType: "image/png" }]);
});

test("copies temporary native files and deduplicates validated image bytes", () => {
  const temp = path.join(dir, "temporary.png");
  fs.writeFileSync(temp, Buffer.from(png, "base64"));
  const ref = saveOutputImage("thread", { path: temp });
  fs.unlinkSync(temp);
  assert.deepEqual(ref, saveOutputImage("thread", { data: `data:image/png;base64,${png}` }));
  assert.equal(fs.readFileSync(filePath("thread", ref.id)!).toString("base64"), png);
  assert.equal(JSON.stringify(ref).includes(png), false);
  assert.throws(() => saveOutputImage("thread", { data: Buffer.from("<svg onload='alert(1)'/>").toString("base64"), mimeType: "image/png" }));
  assert.throws(() => saveOutputImage("thread", { data: png, mimeType: "image/jpeg" }));
  assert.throws(() => saveOutputImage("thread", { data: "https://provider/temporary.png" }));
  assert.throws(() => saveOutputImage("thread", { data: "A".repeat(28 * 1024 * 1024) }), /20 MB/);
});

test("host emits saved references, preserves text/image order and reloads history", async () => {
  const { store } = await import("../store.js");
  const { AgentHost } = await import("./host.js");
  store.load();
  const events: AgentEvent[] = [];
  let host = new AgentHost((event) => {
    events.push(event);
    if (event.type === "agent_item" && event.item.kind === "images") {
      for (const image of event.item.images) assert.ok(filePath(event.item.threadId, image.id));
      assert.equal(JSON.stringify(event).includes(png), false);
    }
  });
  try {
    const thread = host.createThread({ provider: "codex", approval: "full", scope: { kind: "global", ref: null } });
    const turn = { id: "turn-image", threadId: thread.id, seq: 1, status: "done", model: "m", effort: null, mode: thread.mode, startedAt: Date.now() };
    const run = { turn, textItem: null, reasoningItem: null, tools: new Map(), hooks: { called: new Set(), gated: new Set(), approved: new Set(), waiting: new Map(), told: new Set(), earlyItem: null } };
    const internal = host as unknown as { makeSink(id: string, run: unknown): RunSink; flushNow(): void; db: { saveTurn(turn: unknown): void }; turns: Map<string, unknown[]>; addItem(id: string, turn: string, body: unknown): Item };
    internal.turns.get(thread.id)!.push(turn);
    internal.db.saveTurn(turn);
    internal.addItem(thread.id, turn.id, { kind: "user", text: "generate" });
    const sink = internal.makeSink(thread.id, run);
    sink.text("before");
    sink.images!("tool-1", [{ data: png }, { data: png }]);
    sink.images!("tool-1", [{ data: png }, { data: png }]);
    sink.text("after");
    const items = host.threadDetail(thread.id)!.items;
    assert.deepEqual(items.map((it) => it.kind), ["user", "text", "images", "text"]);
    const image = items.find((it) => it.kind === "images")!;
    assert.equal(image.kind === "images" && image.images.length, 2);
    internal.flushNow();
    host.dispose();
    host = new AgentHost(() => {});
    assert.deepEqual(host.threadDetail(thread.id)!.items, items);
    const user = items[0];
    await host.rewind(thread.id, user.id, { keepChanges: true });
    assert.equal(image.kind === "images" && filePath(thread.id, image.images[0].id), null);
    assert.ok(events.some((event) => event.type === "agent_item" && event.item.kind === "images"));
  } finally { host.dispose(); store.closeDb(); }
});
