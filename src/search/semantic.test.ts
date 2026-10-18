import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { analyzePage, chunkPage, parseSearchDeclaration, splitText, type SearchDeclaration } from "./chunker.js";
import { SearchIndex, rankVectors, type ImageAsset, type IndexedChunk, type IndexSource } from "./indexer.js";
import { loadBuiltinTemplates } from "../builtinTemplates.js";
import { BoardStore } from "../store.js";
import { parseImport, serializeExport } from "../boardExport.js";
import type { Embedder, EmbedDocument } from "./embedder.js";
import type { Tab } from "../types.js";

const builtins = loadBuiltinTemplates();
const kanban = builtins.find(t => t.key === "kanban")!.search!;
const todo = builtins.find(t => t.key === "todo-list")!.search!;
const vector = (value = 1) => { const v = new Float32Array(768); v[0] = value; return v; };
function page(id: string, state: Tab["state"] = {}, html = "<h1 id='one'>Heading</h1><p>" + "Useful visible information. ".repeat(20) + "</p>"): Tab {
  return { id, key: `scribe:${id}`, title: id, state, html, updatedAt: 1, stateUpdatedAt: 1 } as Tab;
}
class StubEmbedder implements Embedder {
  calls: EmbedDocument[][] = [];
  queries = 0;
  async embedDocuments(items: EmbedDocument[]): Promise<Float32Array[]> { this.calls.push(items); return items.map(() => vector()); }
  async embedQuery(_query: string) { this.queries++; return vector(); }
  async embedImage(_bytes: Uint8Array) { return vector(); }
}
function fixture(pages: Tab[], declaration?: SearchDeclaration, embedder = new StubEmbedder()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-semantic-"));
  const tabs = new Map(pages.map(p => [p.id, p]));
  const source: IndexSource = { pages: () => [...tabs.values()], get: (id: string) => tabs.get(id), folder: () => "Apps", declaration: () => declaration };
  const index = new SearchIndex(root, source, embedder, 10, 0);
  const cleanup = async () => { await index.close(); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, tabs, source, index, embedder, cleanup };
}

test("heading sections strip scripts, merge small neighbours and keep heading anchors", () => {
  const p = page("Document", {}, "<script><h1>Secret</h1>secret script</script><style>secret style</style><h2 id='intro'>Intro</h2><p>Brief introduction.</p><h3 id='detail'>Details</h3><p>" + "Visible information. ".repeat(20) + "</p>");
  const cs = chunkPage(p);
  assert.equal(cs.filter(c => c.kind === "section").length, 1);
  const s = cs.find(c => c.kind === "section")!;
  assert.equal(s.headingId, "detail"); assert.match(s.text, /Brief introduction.*Visible information/s);
  assert.ok(cs.every(c => !/secret/i.test(c.text)));
  assert.equal(chunkPage(page("New page", {}, "<p>Hi</p>")).length, 0);
});

test("length splits have a hard cap and repeat the last sentence without losing content", () => {
  const text = Array.from({ length: 200 }, (_, i) => `Sentence ${i} contains useful information.`).join(" ");
  const parts = splitText(text);
  assert.ok(parts.length > 2); assert.ok(parts.every(p => p.length <= 2000));
  for (let i = 1; i < parts.length; i++) {
    const sentence = parts[i - 1].match(/[^.!?]+[.!?]/g)!.at(-1)!.trim();
    assert.ok(parts[i].startsWith(sentence));
  }
  for (let i = 0; i < 200; i++) assert.ok(parts.some(p => p.includes(`Sentence ${i} contains`)));
  assert.ok(splitText("x".repeat(10000)).every(p => p.length <= 2000));
});

test("template declarations index cards and todos with stable identities and clean page summaries", () => {
  const state = { cards: [
    { id: "c_a", num: 12, title: "Task", description: "Deep searchable description ".repeat(5), checklist: [{ text: "Check things" }], comments: [{ text: "A comment" }], images: [{ data: "asset:secret.png" }], color: "#abcdef" },
    { num: 13, title: "Archived secret", description: "Archived information", archived: true },
  ], settings: { workerLog: ["internal secret"] } };
  const cs = chunkPage(page("Board", state), "Apps", kanban);
  const record = cs.find(c => c.kind === "record")!;
  assert.equal(record.anchor, "12"); assert.equal(record.label, "#12 Task");
  assert.equal(record.title, "Board › Task"); assert.match(record.text, /Check things\nA comment/);
  assert.ok(cs.every(c => !/secret|abcdef/.test(c.text)));
  assert.equal(cs.find(c => c.kind === "page")!.text, "Folder: Apps.\nTask");
  const changed = chunkPage(page("Board", { ...state, cards: state.cards.map((c, i) => i === 0 ? { ...c, description: "Changed description" } : c) }), "Apps", kanban);
  assert.equal(cs[0].hash, changed[0].hash); assert.equal(record.key, changed[1].key); assert.notEqual(record.hash, changed[1].hash);
  const list = chunkPage(page("List", { todos: [{ id: "t_a", text: "Get groceries", description: "Buy plenty of vegetables for the whole week" }] }), null, todo);
  assert.equal(list[1].anchor, "t_a"); assert.equal(list[1].title, "List"); assert.match(list[1].text, /vegetables/);
  // A one-item list is short but not empty; a list with no items is.
  assert.deepEqual(chunkPage(page("Shopping list", { todos: [{ id: "t_a", text: "eggs" }] }), null, todo).map(c => c.kind), ["page", "record"]);
  assert.equal(chunkPage(page("Shopping list", { todos: [] }), null, todo).length, 0);
});

test("long cards separate comments, all content remains bounded and searchable", () => {
  const cs = chunkPage(page("Board", { cards: [{ num: 12, title: "Task", description: "Description sentence. ".repeat(150), comments: [{ text: "Comment sentence. ".repeat(150) }] }] }), null, kanban);
  const records = cs.filter(c => c.kind === "record");
  assert.ok(records.length > 2); assert.ok(records.every(c => c.text.length <= 2000));
  assert.ok(records.some(c => c.text.includes("Description"))); assert.ok(records.some(c => c.text.includes("Comment")));
  assert.ok(records.every(c => !(c.text.includes("Description") && c.text.includes("Comment"))));
});

test("generic fallback traverses arrays with ids and drops machine fields", () => {
  const cs = chunkPage(page("Generic", { settings: { notes: "secret" }, data: { entries: [{ id: "i_a", title: "A useful record", description: "Detailed relevant information".repeat(5), url: "https://secret.test", color: "#abcdef", images: [{ data: "asset:secret" }] }] } }));
  const r = cs.find(c => c.kind === "record")!;
  assert.equal(r.anchor, "i_a"); assert.ok(cs.every(c => !/secret|abcdef|i_a/.test(c.text)));
  assert.throws(() => parseSearchDeclaration({ records: [{ path: "cards", title: "title", text: "description", anchor: "id" }] }));
});

test("incremental indexing re-embeds only one edited card; restart reuses stored vectors", async () => {
  const p = page("Board", { cards: [{ num: 1, title: "One", description: "Description one ".repeat(10) }, { num: 2, title: "Two", description: "Description two ".repeat(10) }] });
  const f = fixture([p], kanban);
  let reopened: SearchIndex | undefined;
  try {
    assert.equal(fs.existsSync(path.join(f.root, "search.sqlite")), false);
    f.index.start("model", "q8"); await f.index.idle();
    assert.equal(f.embedder.calls.flat().length, 3);
    f.embedder.calls = [];
    (p.state.cards as { description: string }[])[0].description = "New card description";
    f.index.schedule(p.id); f.index.schedule(p.id); await delay(25); await f.index.idle();
    assert.equal(f.embedder.calls.flat().length, 1);
    assert.equal(f.embedder.calls[0][0].text, "New card description");
    assert.equal(f.index.status().indexedPages, 1);
    await f.index.close(); f.embedder.calls = [];
    reopened = new SearchIndex(f.root, f.source, f.embedder);
    reopened.start("model", "q8"); await reopened.idle();
    assert.equal(f.embedder.calls.length, 0);
    const db = new DatabaseSync(path.join(f.root, "search.sqlite"), { readOnly: true });
    assert.equal((db.prepare("SELECT length(vec) AS n FROM chunks LIMIT 1").get() as { n: number }).n, 3072); db.close();
    reopened.start("different model", "q8"); await reopened.idle();
    assert.equal(f.embedder.calls.flat().length, 3);
    f.tabs.delete(p.id); reopened.remove(p.id);
    assert.equal(reopened.status().chunks, 0); assert.equal(reopened.status().indexedPages, 0);
  } finally { await reopened?.close(); await f.cleanup(); }
});

test("newest-first backfill, bounded batches, deletion and resumable failed pages", async () => {
  const many = Array.from({ length: 90 }, (_, num) => ({ num, title: `Task ${num}`, description: "Useful description. ".repeat(150) }));
  const older = page("Older", { cards: many }), newer = page("Newer", { cards: [{ num: 1, title: "Latest task", description: "Latest useful information. ".repeat(10) }] });
  newer.updatedAt = 10;
  const embedder = new StubEmbedder(); let fail = true;
  const attempts: EmbedDocument[][] = [];
  const original = embedder.embedDocuments.bind(embedder);
  embedder.embedDocuments = async items => { attempts.push(items); if (fail) { fail = false; throw new Error("Temporary failure"); } return original(items); };
  const f = fixture([older, newer], kanban, embedder);
  try {
    f.index.start("model", "q8"); await f.index.idle(); assert.equal(f.index.status().error, "Temporary failure");
    assert.equal(attempts[0][0].title, "Newer");
    f.index.start("model", "q8"); await f.index.idle();
    assert.ok(embedder.calls.every(items => items.length <= 32 && items.every(i => i.text.length <= 3020)));
    assert.equal(f.index.status().indexedPages, 2); assert.equal(f.index.status().error, null);
    (older.state.cards as unknown[]).pop(); f.index.schedule(older.id); await delay(25); await f.index.idle();
    const hits = await f.index.query("query", "chunks", id => id === newer.id);
    assert.ok(hits.length); assert.ok(hits.every(h => h.tab_id === newer.id));
    await f.index.query("query", "chunks", () => true); assert.equal(embedder.queries, 1);
    for (let i = 0; i < 50; i++) await f.index.query(`other${i}`, "pages", () => true);
    await f.index.query("query", "pages", () => true); assert.equal(embedder.queries, 52);
    f.index.pause(); await assert.rejects(f.index.query("query", "pages", () => true), /unavailable/);
  } finally { await f.cleanup(); }
});

test("deleted or changed pages cannot commit stale embeddings", async () => {
  const p = page("Page"); const embedder = new StubEmbedder();
  let resolve!: (vectors: Float32Array[]) => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  embedder.embedDocuments = async items => { entered(); return new Promise<Float32Array[]>(r => { resolve = r; }); };
  const f = fixture([p], undefined, embedder);
  try {
    f.index.start("model", "q8"); await started;
    f.tabs.delete(p.id); f.index.remove(p.id); resolve([vector(), vector()]); await f.index.idle();
    assert.equal(f.index.status().chunks, 0);
  } finally { await f.cleanup(); }
});

test("ranking blends page and best two chunks, limits content per page and applies cutoff after viewer filtering", () => {
  const rows: IndexedChunk[] = [];
  const vs: number[] = [];
  const add = (tab: string, kind: string, score: number) => { rows.push({ tab_id: tab, kind, chunk_key: `${tab}:${rows.length}`, anchor: null, heading_id: null, label: kind, snippet: "text", hash: "hash", owner: null }); vs.push(...vector(score)); };
  add("hidden", "page", 1); add("A", "page", 0.8); add("A", "section", 0.9); add("A", "record", 0.7); add("A", "section", 0.65); add("A", "section", 0.64);
  add("B", "page", 0.83); add("B", "record", 0.85); add("C", "page", 0.4);
  const ranked = rankVectors(rows, Float32Array.from(vs), vector(), "pages", id => id !== "hidden");
  assert.deepEqual(ranked.map(h => h.tab_id), ["B", "A"]);
  assert.ok(Math.abs(ranked[0].score - 0.84) < 0.00001); assert.ok(Math.abs(ranked[1].score - 0.81) < 0.00001);
  const chunks = rankVectors(rows, Float32Array.from(vs), vector(), "chunks", () => true, 100, false);
  assert.equal(chunks.filter(h => h.tab_id === "A").length, 3);
});

test("custom template search persists, exports, imports and falls back to a built-in's declaration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-search-template-"));
  const prev = process.env.SCRIBE_HOME; process.env.SCRIBE_HOME = root;
  const store = new BoardStore(), reopened = new BoardStore();
  try {
    store.load();
    const { template } = store.upsertTemplate({ title: "Custom", html: "<p>Custom</p>", search: kanban });
    const tab = store.openFromTemplate(template.id, {}).tab;
    assert.deepEqual(store.searchDeclaration(tab), kanban);
    const imported = parseImport(serializeExport(store.exportFile({ id: tab.id })));
    assert.deepEqual(imported.templates![0].search, kanban);
    const copy = store.copyBuiltinTemplate("kanban").template;
    delete copy.search;
    const board = store.openFromTemplate(copy.id, { title: "Board" }).tab;
    assert.deepEqual(store.searchDeclaration(board), kanban);
    store.closeDb(); reopened.load();
    assert.deepEqual(reopened.getTemplate(template.id)!.search, kanban);
  } finally { store.closeDb(); reopened.closeDb(); if (prev === undefined) delete process.env.SCRIBE_HOME; else process.env.SCRIBE_HOME = prev; fs.rmSync(root, { recursive: true, force: true }); }
});

const PA = (n: number) => `pa_${String(n).padStart(24, "0")}`;
/** A stub whose vectors point along one axis per input, so scores are easy to predict. */
class AxisEmbedder extends StubEmbedder {
  images: number[] = [];
  async embedDocuments(items: EmbedDocument[]) { this.calls.push(items); return items.map(i => axis(/shot/i.test(i.title ?? "") ? 1 : 2)); }
  async embedQuery(q: string) { const v = axis(0, 0.6); v[1] = 0.8; return q === "shot" ? v : axis(2); }
  async embedImage(bytes: Uint8Array) { this.images.push(bytes[0]); if (bytes[0] === 99) throw new Error("Cannot decode"); return axis(bytes[0] < 10 ? 0 : 3); }
}
const axis = (d: number, value = 1) => { const v = new Float32Array(768); v[d] = value; return v; };

test("images belong to the card, item or section that shows them, else to the page", () => {
  const board = analyzePage(page("Board", { cards: [
    { num: 1, title: "With shot", description: "Has a picture", images: [{ id: "im_a", data: `/blob/${PA(1)}` }] },
    { num: 2, title: "", description: "", images: [{ data: `/blob/${PA(2)}` }] },
  ], banner: `/blob/${PA(3)}` }), "Apps", kanban);
  assert.deepEqual(board.images, [
    { ref: PA(1), owner: "record:cards:1:0:0", label: "#1 With shot" },
    { ref: PA(2), owner: "page", label: "Board" },
    { ref: PA(3), owner: "page", label: "Board" },
  ]);
  const doc = analyzePage(page("Doc", {}, `<p><img src="asset:top.png"></p><h2>Setup</h2><p>${"Install the thing. ".repeat(20)}<img src="asset:setup.png"></p><h2>Tiny</h2><p>Short.<img src="/blob/${PA(4)}"></p>`));
  assert.deepEqual(doc.images.map(i => [i.ref, i.owner, i.label]), [[PA(4), "section:1:0", "Setup"], ["asset:setup.png", "section:1:0", "Setup"], ["asset:top.png", "page", "Doc"]]);
  // A page with no text still reports its images, so they can be found by how they look.
  assert.deepEqual(analyzePage(page("Empty", {}, `<img src="asset:a.png">`)), { chunks: [], images: [{ ref: "asset:a.png", owner: "page", label: "Empty" }] });
});

test("images are embedded after the text, score with their owner's text, and leave the index with their asset", async () => {
  const p = page("Board", { cards: [
    { num: 1, title: "Shot card", description: "First", images: [{ data: `/blob/${PA(1)}` }] },
    { num: 2, title: "Other card", description: "Second", images: [{ data: `/blob/${PA(2)}` }, { data: `/blob/${PA(3)}` }, { data: `/blob/${PA(4)}` }] },
  ] });
  const embedder = new AxisEmbedder();
  const f = fixture([p], kanban, embedder);
  const bytes: Record<string, number> = { [PA(1)]: 20, [PA(2)]: 1, [PA(3)]: 99, [PA(4)]: 21 };
  const order: string[] = [];
  const documents = embedder.embedDocuments.bind(embedder), image = embedder.embedImage.bind(embedder);
  embedder.embedDocuments = async items => { order.push("text"); return documents(items); };
  embedder.embedImage = async b => { order.push("image"); return image(b); };
  const assets = (): ImageAsset[] => Object.keys(bytes).map(ref => ({ ref, name: `${ref.slice(-1)}.png`, hash: ref, read: () => Uint8Array.of(bytes[ref]) }));
  f.source.assets = assets;
  try {
    f.index.start("model", "q8"); await f.index.idle();
    assert.deepEqual(order, ["text", "image", "image", "image", "image"]);
    // The image that fails to decode is skipped; the others are indexed and text counts stay text only.
    assert.deepEqual([f.index.status().images, f.index.status().chunks, f.index.status().pendingImagePages, f.index.status().imageError], [3, 3, 0, null]);
    assert.equal((await f.index.query("shot", "chunks", () => true, 8, false)).some(h => h.kind === "image"), false);
    // Query: 0.6 along the image axis of #2's first picture, 0.8 along the text axis of card #1.
    const only = await f.index.queryImages("shot", () => true, 8, false, 1);
    assert.deepEqual(only.map(h => [h.anchor, +h.score.toFixed(2)]), [[PA(2), 0.6], [PA(1), 0], [PA(4), 0]]);
    const textOnly = await f.index.queryImages("shot", () => true, 8, false);
    assert.deepEqual(textOnly.map(h => [h.anchor, +h.score.toFixed(2), h.label, h.ownerRow?.anchor]), [[PA(1), 0.8, "#1 Shot card", "1"], [PA(2), 0, "#2 Other card", "2"], [PA(4), 0, "#2 Other card", "2"]]);
    assert.deepEqual((await f.index.queryImages("shot", () => true)).map(h => h.anchor), [PA(1)]);
    assert.equal((await f.index.queryImages("shot", () => false)).length, 0);
    // An image as the query compares pictures only.
    assert.deepEqual((await f.index.queryImages(Uint8Array.of(22), () => true)).map(h => h.anchor), [PA(1), PA(4)]);
    // Retitling the card moves the label without embedding the image again.
    const cards = p.state.cards as { title: string; images: unknown[] }[];
    cards[0].title = "Renamed shot"; order.length = 0;
    f.index.schedule(p.id); await delay(25); await f.index.idle();
    assert.deepEqual(order, ["text"]);
    assert.equal((await f.index.queryImages(Uint8Array.of(22), () => true))[0].label, "#1 Renamed shot");
    // Taking the image off its card removes its vector, and so does deleting the asset itself.
    cards[0].images = []; f.index.schedule(p.id); await delay(25); await f.index.idle();
    assert.deepEqual((await f.index.queryImages(Uint8Array.of(22), () => true)).map(h => h.anchor), [PA(4)]);
    delete bytes[PA(4)]; f.index.schedule(p.id); await delay(25); await f.index.idle();
    assert.equal(f.index.status().images, 1);
    f.tabs.delete(p.id); f.index.remove(p.id);
    assert.equal(f.index.status().images, 0);
  } finally { await f.cleanup(); }
});

test("an index from before images gains the owner column and keeps its vectors", async () => {
  const p = page("Doc", {}, `<h1>Heading</h1><p>${"Useful visible information. ".repeat(20)}<img src="asset:a.png"></p>`);
  const f = fixture([p]);
  try {
    const db = new DatabaseSync(path.join(f.root, "search.sqlite"));
    db.exec("CREATE TABLE chunks (id INTEGER PRIMARY KEY, tab_id TEXT NOT NULL, chunk_key TEXT NOT NULL, kind TEXT NOT NULL, anchor TEXT, heading_id TEXT, label TEXT NOT NULL, snippet TEXT NOT NULL, hash TEXT NOT NULL, vec BLOB NOT NULL, UNIQUE(tab_id, chunk_key))");
    db.close();
    f.source.assets = () => [{ ref: "asset:a.png", name: "a.png", hash: "h1", read: () => Uint8Array.of(1) }];
    f.index.start("model", "q8"); await f.index.idle();
    const hit = (await f.index.queryImages("anything", () => true))[0];
    assert.deepEqual([hit.kind, hit.anchor, hit.owner, hit.snippet, hit.ownerRow?.kind], ["image", "asset:a.png", "section:1:0", "a.png", "section"]);
  } finally { await f.cleanup(); }
});
