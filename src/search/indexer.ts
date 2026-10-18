import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHUNKER_VERSION, analyzePage, type ImageRef, type SearchDeclaration, type TextChunk } from "./chunker.js";
import type { Embedder } from "./embedder.js";
import type { Tab } from "../types.js";

export type IndexedChunk = { tab_id: string; chunk_key: string; kind: string; anchor: string | null; heading_id: string | null; label: string; snippet: string; hash: string; owner: string | null };
type Row = IndexedChunk & { vec: Uint8Array };
/** An image a page holds. `ref` is what the page writes to show it (`pa_…` or `asset:<name>`); `hash` changes with the bytes. */
export type ImageAsset = { ref: string; name: string; hash: string; read(): Uint8Array | undefined };
export type IndexSource = { pages(): Tab[]; get(id: string): Tab | undefined; folder(tab: Tab): string | null; declaration(tab: Tab): SearchDeclaration | undefined; assets?(tab: Tab): ImageAsset[] };
export type ScoredHit = IndexedChunk & { score: number };
/** An image row, with the text chunk it sits on (its card, item or section) when that is indexed. */
export type ImageHit = ScoredHit & { ownerRow: IndexedChunk | null };
const WIDTH = 768;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const BLENDED_CUTOFF = 0.04;

export function rankVectors(rows: IndexedChunk[], vectors: Float32Array, query: Float32Array, scope: "pages" | "chunks", visible: (id: string) => boolean, limit = 8, cutoff = true): ScoredHit[] {
  const groups = new Map<string, ScoredHit[]>();
  rows.forEach((row, index) => {
    if (row.kind === "image" || !visible(row.tab_id)) return;
    let score = 0;
    for (let d = 0; d < WIDTH; d++) score += vectors[index * WIDTH + d] * query[d];
    if (!Number.isFinite(score)) return;
    const group = groups.get(row.tab_id) ?? [];
    group.push({ ...row, score }); groups.set(row.tab_id, group);
  });
  const hits: ScoredHit[] = [];
  for (const group of groups.values()) {
    const page = group.find(r => r.kind === "page");
    const chunks = group.filter(r => r.kind !== "page").sort((a, b) => b.score - a.score);
    if (scope === "chunks") hits.push(...(chunks.length ? chunks.slice(0, 3) : page ? [page] : []));
    else if (page) {
      const best = chunks[0] ?? page, second = chunks[1] ?? best;
      hits.push({ ...best, score: 0.5 * page.score + 0.3 * best.score + 0.2 * second.score });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.tab_id.localeCompare(b.tab_id) || a.chunk_key.localeCompare(b.chunk_key));
  return hits.filter(hit => !cutoff || hit.score >= (hits[0]?.score ?? 0) - 0.08).slice(0, limit);
}

/**
 * Image rows. An image scores `weight × image + (1 − weight) × owner's text chunk` (the page's vector when the
 * owner has none). Text queries use 0 and rank by the owner's text only. An image
 * query uses 1 and compares pictures only. Text and blended scores use a narrower cut-off.
 */
export function rankImages(rows: IndexedChunk[], vectors: Float32Array, query: Float32Array, weight: number, visible: (id: string) => boolean, limit = 8, cutoff = true): ImageHit[] {
  const dot = (index: number) => { let score = 0; for (let d = 0; d < WIDTH; d++) score += vectors[index * WIDTH + d] * query[d]; return score; };
  const text = new Map<string, number>();
  rows.forEach((row, index) => { if (row.kind !== "image") text.set(`${row.tab_id}\n${row.chunk_key}`, index); });
  const hits: ImageHit[] = [];
  rows.forEach((row, index) => {
    if (row.kind !== "image" || !visible(row.tab_id)) return;
    const owner = text.get(`${row.tab_id}\n${row.owner}`) ?? text.get(`${row.tab_id}\npage`);
    const image = dot(index);
    const score = weight < 1 && owner !== undefined ? weight * image + (1 - weight) * dot(owner) : image;
    if (Number.isFinite(score)) hits.push({ ...row, score, ownerRow: owner === undefined ? null : rows[owner] });
  });
  hits.sort((a, b) => b.score - a.score || a.tab_id.localeCompare(b.tab_id) || a.chunk_key.localeCompare(b.chunk_key));
  return hits.filter(hit => !cutoff || hit.score >= hits[0].score - (weight < 1 ? BLENDED_CUTOFF : 0.08)).slice(0, limit);
}

/** Derived storage and a single worker: never retain a library's text or embeddings in a batch. */
export class SearchIndex {
  private db?: DatabaseSync;
  private queue = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private running?: Promise<void>;
  private stopped = false;
  private enabled = false;
  private generation = 0;
  private rows: IndexedChunk[] = [];
  private vectors = new Float32Array();
  private dirty = true;
  private queries = new Map<string, Float32Array>();
  private error: string | null = null;
  /** Pages with images still to embed. They wait for the page queue, and for searches to stop. */
  private imagePages = new Set<string>();
  /** Images that could not be read or embedded. Not tried again until search is switched on again. */
  private imageSkips = new Set<string>();
  private imageFails = 0;
  private imageError: string | null = null;
  private lastQuery = 0;
  /** Bumped whenever the loaded vectors change, so cached About answers know they are stale. */
  private rowsVersion = 0;
  /** Library lens About answers (#260) by phrase, for the vectors they were ranked on. */
  private abouts = new Map<string, { version: number; ids: string[] }>();
  constructor(private root: string | (() => string), private source: IndexSource, private embedder: Embedder, private debounceMs = 5000, private imageIdleMs = 3000) {}
  start(model: string, dtype: string): void {
    if (this.stopped) return;
    if (!this.db) {
      const root = typeof this.root === "function" ? this.root() : this.root;
      fs.mkdirSync(root, { recursive: true });
      this.db = new DatabaseSync(path.join(root, "search.sqlite"));
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, tab_id TEXT NOT NULL, chunk_key TEXT NOT NULL, kind TEXT NOT NULL, anchor TEXT, heading_id TEXT, label TEXT NOT NULL, snippet TEXT NOT NULL, hash TEXT NOT NULL, vec BLOB NOT NULL, UNIQUE(tab_id, chunk_key));
        CREATE INDEX IF NOT EXISTS idx_chunks_tab ON chunks(tab_id);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      // An image row names the text chunk it sits on. Indexes from before images have no such column.
      if (!(this.db.prepare("PRAGMA table_info(chunks)").all() as { name: string }[]).some(c => c.name === "owner")) this.db.exec("ALTER TABLE chunks ADD COLUMN owner TEXT");
    }
    const signature = JSON.stringify([model, dtype, CHUNKER_VERSION]);
    const prior = this.db.prepare("SELECT value FROM meta WHERE key='signature'").get() as { value: string } | undefined;
    if (prior?.value !== signature) {
      this.generation++; this.db.exec("DELETE FROM chunks; DELETE FROM meta;"); this.queries.clear(); this.dirty = true;
      const save = this.db.prepare("INSERT INTO meta(key,value) VALUES (?,?)");
      for (const [key, value] of Object.entries({ signature, model, dtype, chunker: CHUNKER_VERSION })) save.run(key, value);
    }
    const wasEnabled = this.enabled; this.enabled = true;
    if (!wasEnabled || prior?.value !== signature) {
      this.imageSkips.clear(); this.imageFails = 0; this.imageError = null;
      const pages = this.source.pages().sort((a, b) => Math.max(b.updatedAt, b.stateUpdatedAt) - Math.max(a.updatedAt, a.stateUpdatedAt));
      const ids = new Set(pages.map(p => p.id));
      for (const row of this.db.prepare("SELECT DISTINCT tab_id FROM chunks").all() as { tab_id: string }[]) if (!ids.has(row.tab_id)) this.remove(row.tab_id);
      for (const page of pages) this.queue.add(page.id);
    }
    this.kick();
  }
  pause(): void { this.enabled = false; this.generation++; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
  schedule(id: string): void {
    if (!this.enabled || this.stopped) return;
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => { this.timers.delete(id); this.queue.add(id); this.kick(); }, this.debounceMs);
    timer.unref(); this.timers.set(id, timer);
  }
  remove(id: string): void {
    clearTimeout(this.timers.get(id)); this.timers.delete(id); this.queue.delete(id); this.imagePages.delete(id);
    this.db?.prepare("DELETE FROM chunks WHERE tab_id=?").run(id); this.dirty = true;
    this.db?.prepare("DELETE FROM meta WHERE key=?").run(`page:${id}`);
  }
  private kick(): void {
    if (this.running || !this.enabled || this.stopped) return;
    this.running = this.drain().finally(() => { this.running = undefined; if ((this.queue.size || this.imagesWaiting()) && this.enabled && !this.stopped && !this.error) this.kick(); });
  }
  private async drain(): Promise<void> {
    this.error = null;
    while (this.enabled && !this.stopped) {
      if (this.queue.size) {
        const id = this.queue.values().next().value!; this.queue.delete(id);
        try { await this.indexPage(id); }
        catch (err) { this.error = (err as Error).message; this.queue.add(id); break; }
      } else if (this.imagesWaiting()) await this.indexImage(this.imagePages.values().next().value!);
      else break;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  private imagesWaiting(): boolean { return this.imagePages.size > 0 && this.imageFails < 3; }
  /** The page's image assets that its text refers to, each with the chunk that owns it. */
  private images(tab: Tab, refs: ImageRef[]): (ImageAsset & ImageRef)[] {
    const assets = refs.length ? this.source.assets?.(tab) ?? [] : [];
    const byRef = new Map(refs.map(r => [r.ref, r]));
    return assets.flatMap(asset => { const ref = byRef.get(asset.ref); return ref ? [{ ...asset, ...ref }] : []; });
  }
  /** Drops vectors of images the page no longer shows, follows a moved owner, and queues what is not embedded yet. */
  private syncImages(id: string, wanted: (ImageAsset & ImageRef)[]): void {
    const db = this.db!;
    const byKey = new Map(wanted.map(w => [`image:${w.ref}`, w]));
    const have = new Set<string>();
    for (const row of db.prepare("SELECT chunk_key,hash,owner,label,snippet FROM chunks WHERE tab_id=? AND kind='image'").all(id) as { chunk_key: string; hash: string; owner: string | null; label: string; snippet: string }[]) {
      const w = byKey.get(row.chunk_key);
      if (!w || w.hash !== row.hash) { db.prepare("DELETE FROM chunks WHERE tab_id=? AND chunk_key=?").run(id, row.chunk_key); this.dirty = true; continue; }
      have.add(row.chunk_key);
      if (w.owner !== row.owner || w.label !== row.label || w.name !== row.snippet) {
        db.prepare("UPDATE chunks SET owner=?,label=?,snippet=? WHERE tab_id=? AND chunk_key=?").run(w.owner, w.label, w.name, id, row.chunk_key); this.dirty = true;
      }
    }
    if (wanted.some(w => !have.has(`image:${w.ref}`) && !this.imageSkips.has(`${id}\n${w.ref}\n${w.hash}`))) this.imagePages.add(id);
    else this.imagePages.delete(id);
  }
  /** One image per step, so a page change or a search never waits behind more than one. */
  private async indexImage(id: string): Promise<void> {
    const tab = this.source.get(id);
    if (!tab) { this.remove(id); return; }
    const generation = this.generation;
    const have = new Set((this.db!.prepare("SELECT chunk_key FROM chunks WHERE tab_id=? AND kind='image'").all(id) as { chunk_key: string }[]).map(r => r.chunk_key));
    const skip = (w: ImageAsset) => `${id}\n${w.ref}\n${w.hash}`;
    const next = this.images(tab, analyzePage(tab, this.source.folder(tab), this.source.declaration(tab)).images).find(w => !have.has(`image:${w.ref}`) && !this.imageSkips.has(skip(w)));
    if (!next) { this.imagePages.delete(id); return; }
    while (Date.now() - this.lastQuery < this.imageIdleMs) {
      await new Promise(resolve => setTimeout(resolve, Math.min(250, this.imageIdleMs)));
      if (!this.enabled || this.stopped || this.queue.size) return;
    }
    try {
      const bytes = next.read();
      if (!bytes?.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image is missing or too large");
      const vec = await this.embedder.embedImage(bytes);
      if (vec.length !== WIDTH || !vec.every(Number.isFinite)) throw new Error("Invalid image vector");
      if (!this.enabled || this.stopped || generation !== this.generation || !this.source.get(id)) return;
      this.db!.prepare("INSERT OR REPLACE INTO chunks(tab_id,chunk_key,kind,anchor,heading_id,label,snippet,hash,vec,owner) VALUES (?,?,'image',?,NULL,?,?,?,?,?)")
        .run(id, `image:${next.ref}`, next.ref, next.label, next.name, next.hash, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), next.owner);
      this.dirty = true; this.imageFails = 0; this.imageError = null;
    } catch (err) {
      if (!this.enabled || this.stopped || generation !== this.generation) return;
      // One unreadable image is skipped; several failures in a row mean the encoder itself is not working.
      this.imageSkips.add(skip(next)); this.imageFails++; this.imageError = (err as Error).message;
    }
  }
  async idle(): Promise<void> { while (this.running) await this.running; }
  private chunks(tab: Tab): TextChunk[] { return analyzePage(tab, this.source.folder(tab), this.source.declaration(tab)).chunks; }
  private async indexPage(id: string): Promise<void> {
    const tab = this.source.get(id);
    if (!tab) { this.remove(id); return; }
    const generation = this.generation;
    const { chunks, images } = analyzePage(tab, this.source.folder(tab), this.source.declaration(tab));
    this.syncImages(id, this.images(tab, images));
    const identity = (cs: TextChunk[]) => JSON.stringify(cs.map(c => [c.key, c.hash, c.label, c.headingId]));
    const snapshot = identity(chunks);
    const prior = this.db!.prepare("SELECT value FROM meta WHERE key=?").get(`page:${id}`) as { value: string } | undefined;
    if (prior?.value === snapshot) return;
    const old = new Map((this.db!.prepare("SELECT chunk_key,hash FROM chunks WHERE tab_id=? AND kind<>'image'").all(id) as { chunk_key: string; hash: string }[]).map(r => [r.chunk_key, r.hash]));
    const changed = chunks.filter(c => old.get(c.key) !== c.hash);
    // IPC batches are bounded; temporary vectors cover only this page's changed chunks.
    const pending = new Map<string, Float32Array>();
    for (let from = 0; from < changed.length; from += 32) {
      if (!this.enabled || this.stopped || generation !== this.generation) return;
      const batch = changed.slice(from, from + 32);
      const vectors = await this.embedder.embedDocuments(batch.map(c => ({ title: c.title, text: c.text })));
      if (vectors.length !== batch.length || vectors.some(v => v.length !== WIDTH || !v.every(Number.isFinite))) throw new Error("Invalid search vector dimensions");
      batch.forEach((c, i) => pending.set(c.key, vectors[i]));
    }
    if (!this.enabled || this.stopped || generation !== this.generation) return;
    const latest = this.source.get(id);
    if (!latest) { this.remove(id); return; }
    if (snapshot !== identity(this.chunks(latest))) { this.queue.add(id); return; }
    const db = this.db!;
    const put = db.prepare("INSERT INTO chunks(tab_id,chunk_key,kind,anchor,heading_id,label,snippet,hash,vec) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tab_id,chunk_key) DO UPDATE SET kind=excluded.kind,anchor=excluded.anchor,heading_id=excluded.heading_id,label=excluded.label,snippet=excluded.snippet,hash=excluded.hash,vec=excluded.vec");
    db.exec("BEGIN");
    try {
      const keys = new Set(chunks.map(c => c.key));
      for (const key of old.keys()) if (!keys.has(key)) db.prepare("DELETE FROM chunks WHERE tab_id=? AND chunk_key=?").run(id, key);
      for (const chunk of chunks) {
        const vec = pending.get(chunk.key);
        if (vec) put.run(id, chunk.key, chunk.kind, chunk.anchor, chunk.headingId ?? null, chunk.label, chunk.snippet, chunk.hash, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
        else db.prepare("UPDATE chunks SET label=?,snippet=?,heading_id=? WHERE tab_id=? AND chunk_key=?").run(chunk.label, chunk.snippet, chunk.headingId ?? null, id, chunk.key);
      }
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run(`page:${id}`, snapshot);
      db.exec("COMMIT"); this.dirty = true;
    } catch (err) { db.exec("ROLLBACK"); throw err; }
  }
  private loadVectors(): void {
    if (!this.dirty || !this.db) return;
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    const vectors = new Float32Array(count * WIDTH), rows: IndexedChunk[] = [];
    for (const row of this.db.prepare("SELECT * FROM chunks ORDER BY id").iterate() as Iterable<Row>) {
      if (row.vec.byteLength !== WIDTH * 4) continue;
      const { vec, ...meta } = row;
      const copy = Uint8Array.from(vec);
      vectors.set(new Float32Array(copy.buffer), rows.length * WIDTH); rows.push(meta);
    }
    this.rows = rows; this.vectors = vectors; this.dirty = false; this.rowsVersion++;
  }
  /** The query's vector: text through the 50-entry cache, an image through the vision encoder. */
  private async queryVector(q: string | Uint8Array): Promise<Float32Array> {
    if (!this.enabled || this.stopped) throw new Error("Semantic search is unavailable");
    const generation = this.generation;
    this.lastQuery = Date.now();
    let vec = typeof q === "string" ? this.queries.get(q) : undefined;
    if (!vec) {
      vec = typeof q === "string" ? await this.embedder.embedQuery(q) : await this.embedder.embedImage(q);
      if (vec.length !== WIDTH || !vec.every(Number.isFinite)) throw new Error("Invalid query vector");
      if (!this.enabled || this.stopped || generation !== this.generation) throw new Error("Search settings changed");
    }
    this.lastQuery = Date.now();
    if (typeof q === "string") {
      this.queries.delete(q); this.queries.set(q, vec);
      if (this.queries.size > 50) this.queries.delete(this.queries.keys().next().value!);
    }
    this.loadVectors();
    return vec;
  }
  async query(q: string, scope: "pages" | "chunks", visible: (id: string) => boolean, limit = 8, cutoff = true): Promise<ScoredHit[]> {
    const vec = await this.queryVector(q);
    return rankVectors(this.rows, this.vectors, vec, scope, visible, limit, cutoff);
  }
  /**
   * Every page about a phrase, for a Library lens (#260): the pages within the usual cut-off of the
   * best match. Kept per phrase until the index changes, so a lens redrawn on every edit elsewhere
   * does not rank the whole Library again.
   */
  async aboutPages(q: string): Promise<string[]> {
    const vec = await this.queryVector(q);
    const cached = this.abouts.get(q);
    if (cached?.version === this.rowsVersion) return cached.ids;
    const ids = rankVectors(this.rows, this.vectors, vec, "pages", () => true, Number.MAX_SAFE_INTEGER).map(hit => hit.tab_id);
    this.abouts.delete(q); this.abouts.set(q, { version: this.rowsVersion, ids });
    if (this.abouts.size > 50) this.abouts.delete(this.abouts.keys().next().value!);
    return ids;
  }
  /** Images for a text query (their owner's text only) or like the given image's bytes (image only). */
  async queryImages(q: string | Uint8Array, visible: (id: string) => boolean, limit = 8, cutoff = true, weight = typeof q === "string" ? 0 : 1): Promise<ImageHit[]> {
    const vec = await this.queryVector(q);
    return rankImages(this.rows, this.vectors, vec, weight, visible, limit, cutoff);
  }
  status() {
    const pages = this.source.pages();
    const indexed = this.db ? (this.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'page:%'").get() as { n: number }).n : 0;
    const count = (where: string) => this.db ? (this.db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE ${where}`).get() as { n: number }).n : 0;
    return { enabled: this.enabled, indexing: !!this.running, indexedPages: indexed, totalPages: pages.length, chunks: count("kind<>'image'"), pendingPages: this.queue.size + this.timers.size, error: this.error, images: count("kind='image'"), pendingImagePages: this.imagePages.size, imageError: this.imageError };
  }
  fail(error: unknown): void { this.pause(); this.error = error instanceof Error ? error.message : String(error); }
  async close(): Promise<void> { this.pause(); this.stopped = true; await this.idle(); this.db?.close(); this.db = undefined; }
}
