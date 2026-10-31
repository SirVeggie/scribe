import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import express, { Router } from "express";
import type { BoardExportFile, BoardExportPage } from "../boardExport.js";
import { identify } from "../callers.js";
import { pageIdFromHost } from "../config.js";
import { shellOrigin } from "../contentOrigin.js";
import type { Template } from "../types.js";
import { peerCall, sendCopy, type CopyHost } from "./copy.js";
import { deviceDir } from "./identity.js";
import { peerDeviceOf } from "./link.js";
import type { MirrorHeld, PeerService } from "./peers.js";

/**
 * The offline mirror (#910). Each device pushes its catalog (spaces, folders, page metadata, templates)
 * and its mirrored pages in full (every page that is a tab in any space, plus the pages in folders marked
 * Mirrored) to one paired device that stays on. Nothing is merged: the mirror is a read-only copy.
 *
 * Changes are found by a manifest, not a change log: the owner hashes its catalog and a fingerprint per
 * mirrored page (revisions, asset counts, update time). When the hash matches what the mirror last
 * confirmed, a sync is one small request. Otherwise the mirror says which pages differ, drops the ones
 * that left, and only those pages travel, with their blobs by SHA-256 (only the ones it lacks). Every
 * step is idempotent, so a sync cut off by a disconnect simply runs again.
 *
 * While the owner is offline, other devices' gateways send its d-<device> hosts to the mirror holder,
 * which serves a read-only browser of the mirror; page scripts run, and writes are refused.
 */

export type MirrorCatalog = {
  spaces: Array<{ id: string; name: string; color: string; tabs: string[]; active?: boolean }>;
  folders: Array<{ id: string; parentId: string | null; name: string }>;
  pages: Array<{ id: string; key: string; title: string; folderId?: string; updatedAt: number; templateId?: string; kind?: "file" }>;
  templates: Array<{ id: string; key?: string; title: string; updatedAt: number }>;
};

/** What the owning device's store gives the mirror. */
export type MirrorSource = {
  catalog(): MirrorCatalog;
  /** The pages to mirror in full and a fingerprint of each that changes with its content. */
  pages(folders: string[]): Map<string, string>;
  exportPages(ids: string[]): BoardExportFile;
  /** Called on store changes, to sync soon instead of at the next timer. */
  onChange(listener: () => void): void;
};

export type MirrorSettings = { to: string | null; folders: string[] };

export type MirrorStatus = MirrorSettings & {
  /** The last time the target confirmed it matched, this session. */
  at?: number;
  pages?: number;
  error?: string;
  syncing?: boolean;
};

type MirrorPage = BoardExportPage & { id: string };

const SYNC_MS = 30_000;
const SOON_MS = 3_000;
/** A batch of pages per request, by JSON size. */
const BATCH_BYTES = 8 * 1024 * 1024;
const MAX_BLOB = "90mb";
const MAX_JSON = "64mb";
const HASH = /^[0-9a-f]{64}$/;

const sha256 = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");

// --- the owner: pushing ---

export class MirrorPusher {
  private settings: MirrorSettings;
  private acked = new Map<string, string>();
  private status: { at?: number; pages?: number; error?: string } = {};
  private running: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;
  private busy = false;
  private timer: NodeJS.Timeout | undefined;
  private soon: NodeJS.Timeout | undefined;

  constructor(private readonly peers: PeerService, private readonly source: MirrorSource, private readonly home: string) {
    this.settings = readSettings(this.file());
  }

  start(): void {
    this.timer = setInterval(() => void this.sync(), SYNC_MS);
    this.timer.unref();
    this.source.onChange(() => this.nudge());
    // The target came online (or its link changed): sync now.
    let online = false;
    this.peers.on("change", () => {
      const now = !!this.settings.to && !!this.peers.linkTo(this.settings.to);
      if (now && !online) this.nudge(0);
      online = now;
    });
    this.nudge(0);
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.soon);
  }

  view(): MirrorStatus {
    return { ...this.settings, ...this.status, ...(this.busy ? { syncing: true } : {}) };
  }

  /** Settings → Devices ("Mirror to") and the folder menu ("Mirrored"). */
  update(body: unknown): MirrorStatus {
    const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const next = { ...this.settings };
    if ("to" in input) {
      const to = input.to;
      if (to !== null && (typeof to !== "string" || !this.peers.nameOf(to))) throw new Error("Choose a paired device to mirror to.");
      next.to = to as string | null;
    }
    if (Array.isArray(input.folders)) next.folders = [...new Set(input.folders.filter((f): f is string => typeof f === "string" && !!f))].slice(0, 500);
    if (typeof input.folder === "string" && typeof input.mirrored === "boolean") {
      next.folders = input.mirrored ? [...new Set([...next.folders, input.folder])] : next.folders.filter((f) => f !== input.folder);
    }
    if (next.to !== this.settings.to) this.status = {};
    this.settings = next;
    writeJson(this.file(), next);
    this.nudge(0);
    return this.view();
  }

  /** Sync soon: changes come in bursts (a page being typed in), so they fold into one sync. */
  nudge(ms = SOON_MS): void {
    clearTimeout(this.soon);
    this.soon = setTimeout(() => void this.sync(), ms);
    this.soon.unref();
  }

  /** One sync to the target, if it is online. Calls during a sync share one more run after it. */
  sync(): Promise<void> {
    if (this.queued) return this.queued;
    const next = this.running.then(() => {
      this.queued = null;
      this.busy = true;
      return this.run();
    }).catch((err) => {
      this.status = { ...this.status, error: (err as Error).message };
    }).finally(() => {
      this.busy = false;
    });
    this.queued = next;
    this.running = next;
    return next;
  }

  private async run(): Promise<void> {
    const to = this.settings.to;
    if (!to || !this.peers.linkTo(to) || !this.peers.supports(to, "mirror")) return;
    const catalog = this.source.catalog();
    const pages = this.source.pages(this.settings.folders);
    const fingerprints = Object.fromEntries([...pages].sort(([a], [b]) => a.localeCompare(b)));
    const digest = sha256(JSON.stringify({ catalog, fingerprints }));
    const call = <T>(method: string, url: string, body: unknown) => peerCall<T>(this.peers, to, method, url, body);
    if (this.acked.get(to) === digest) {
      const check = await call<{ same?: boolean }>("POST", "/api/mirror/incoming/sync", { digest });
      if (check.same) {
        this.status = { at: Date.now(), pages: pages.size };
        return;
      }
    }
    const reply = await call<{ need?: string[] }>("POST", "/api/mirror/incoming/sync", { digest, name: this.peers.identity.name, catalog, fingerprints });
    const need = (Array.isArray(reply.need) ? reply.need : []).filter((id) => pages.has(id));
    // Pages go in batches of about BATCH_BYTES, each with only the blobs the mirror lacks.
    let batch: Array<{ id: string; fp: string; page: BoardExportPage }> = [];
    let templates = new Map<string, Template>();
    let blobs = new Map<string, Buffer>();
    let bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const check = await call<{ missing?: string[] }>("POST", "/api/mirror/incoming/check", { hashes: [...blobs.keys()] });
      for (const hash of Array.isArray(check.missing) ? check.missing : []) {
        const data = blobs.get(hash);
        if (data) await call("PUT", `/api/mirror/incoming/blobs/${hash}`, data);
      }
      await call("POST", "/api/mirror/incoming/pages", { pages: batch, templates: [...templates.values()] });
      batch = [];
      templates = new Map();
      blobs = new Map();
      bytes = 0;
    };
    for (const id of need) {
      let file: BoardExportFile;
      try {
        file = this.source.exportPages([id]);
      } catch {
        continue; // gone since the manifest was made: the next sync drops it
      }
      const page = file.pages[0];
      if (!page) continue;
      for (const asset of [...page.assets, ...(page.pageAssets ?? [])] as Array<{ data?: string; hash?: string }>) {
        const data = Buffer.from(asset.data ?? "", "base64");
        const hash = sha256(data);
        blobs.set(hash, data);
        bytes += data.length;
        delete asset.data;
        asset.hash = hash;
      }
      for (const template of file.templates) templates.set(template.id, template);
      batch.push({ id, fp: pages.get(id)!, page });
      bytes += page.html.length + JSON.stringify(page.state ?? {}).length;
      if (bytes > BATCH_BYTES) await flush();
    }
    await flush();
    await call("POST", "/api/mirror/incoming/done", { digest });
    this.acked.set(to, digest);
    this.status = { at: Date.now(), pages: pages.size };
  }

  private file(): string {
    return path.join(deviceDir(this.home), "mirror.json");
  }
}

function readSettings(file: string): MirrorSettings {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MirrorSettings>;
    return {
      to: typeof value.to === "string" ? value.to : null,
      folders: Array.isArray(value.folders) ? value.folders.filter((f): f is string => typeof f === "string") : [],
    };
  } catch {
    return { to: null, folders: [] };
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

// --- the holder: storing ---

/** The mirrors this device holds, one SQLite file for all of them, blobs by hash beside it. */
export class MirrorStore {
  private readonly db: DatabaseSync;
  private readonly blobs: string;
  private sweptAt = 0;

  constructor(home: string) {
    const dir = path.join(home, "mirror");
    fs.mkdirSync(dir, { recursive: true });
    this.blobs = path.join(dir, "blobs");
    this.db = new DatabaseSync(path.join(dir, "mirror.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, catalog TEXT NOT NULL DEFAULT '{}', digest TEXT, synced_at INTEGER, checked_at INTEGER);
      CREATE TABLE IF NOT EXISTS pages (device TEXT NOT NULL, id TEXT NOT NULL, fp TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (device, id));
      CREATE TABLE IF NOT EXISTS templates (device TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (device, id));
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Each device mirrored here and when it last matched (only complete syncs count). */
  held(): MirrorHeld[] {
    const rows = this.db.prepare("SELECT id, checked_at FROM devices WHERE checked_at IS NOT NULL ORDER BY id").all() as Array<{ id: string; checked_at: number }>;
    return rows.map((row) => ({ id: row.id, at: Number(row.checked_at) }));
  }

  device(id: string): { id: string; name: string; catalog: MirrorCatalog; at: number } | undefined {
    const row = this.db.prepare("SELECT id, name, catalog, checked_at FROM devices WHERE id = ? AND checked_at IS NOT NULL").get(id) as
      | { id: string; name: string; catalog: string; checked_at: number }
      | undefined;
    if (!row) return undefined;
    return { id: row.id, name: row.name, catalog: parseCatalog(row.catalog), at: Number(row.checked_at) };
  }

  /** The owner's hash matches: the mirror is still current. */
  check(device: string, digest: string): boolean {
    const row = this.db.prepare("SELECT digest FROM devices WHERE id = ?").get(device) as { digest: string | null } | undefined;
    if (!row || row.digest !== digest) return false;
    this.db.prepare("UPDATE devices SET checked_at = ? WHERE id = ?").run(Date.now(), device);
    return true;
  }

  /** A new catalog and manifest: drop the pages that left and say which ones differ. */
  begin(device: string, name: string, catalog: MirrorCatalog, fingerprints: Record<string, string>): string[] {
    const held = new Map(
      (this.db.prepare("SELECT id, fp FROM pages WHERE device = ?").all(device) as Array<{ id: string; fp: string }>).map((r) => [r.id, r.fp])
    );
    this.transaction(() => {
      this.db.prepare(
        "INSERT INTO devices (id, name, catalog) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, catalog = excluded.catalog"
      ).run(device, name, JSON.stringify(catalog));
      const drop = this.db.prepare("DELETE FROM pages WHERE device = ? AND id = ?");
      for (const id of held.keys()) if (!(id in fingerprints)) drop.run(device, id);
      const used = new Set(catalog.pages.map((p) => p.templateId).filter(Boolean));
      const templates = this.db.prepare("SELECT id FROM templates WHERE device = ?").all(device) as Array<{ id: string }>;
      for (const { id } of templates) if (!used.has(id)) this.db.prepare("DELETE FROM templates WHERE device = ? AND id = ?").run(device, id);
    });
    return Object.entries(fingerprints).filter(([id, fp]) => held.get(id) !== fp).map(([id]) => id);
  }

  putPages(device: string, pages: Array<{ id: string; fp: string; page: BoardExportPage }>, templates: Template[]): void {
    for (const { page } of pages) {
      for (const asset of [...(page.assets ?? []), ...(page.pageAssets ?? [])] as Array<{ hash?: string }>) {
        if (typeof asset.hash !== "string" || !this.hasBlob(asset.hash)) throw new Error("A part of the page did not arrive. Sync again.");
      }
    }
    this.transaction(() => {
      const put = this.db.prepare("INSERT INTO pages (device, id, fp, data) VALUES (?, ?, ?, ?) ON CONFLICT(device, id) DO UPDATE SET fp = excluded.fp, data = excluded.data");
      for (const { id, fp, page } of pages) put.run(device, id, fp, JSON.stringify({ ...page, id }));
      const template = this.db.prepare("INSERT INTO templates (device, id, data) VALUES (?, ?, ?) ON CONFLICT(device, id) DO UPDATE SET data = excluded.data");
      for (const t of templates) if (t && typeof t.id === "string") template.run(device, t.id, JSON.stringify(t));
    });
  }

  done(device: string, digest: string): void {
    const now = Date.now();
    this.db.prepare("UPDATE devices SET digest = ?, synced_at = ?, checked_at = ? WHERE id = ?").run(digest, now, now, device);
    if (now - this.sweptAt > 3600_000) this.sweep();
  }

  page(device: string, id: string): MirrorPage | undefined {
    const row = this.db.prepare("SELECT data FROM pages WHERE device = ? AND id = ?").get(device, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as MirrorPage) : undefined;
  }

  mirrored(device: string): Set<string> {
    return new Set((this.db.prepare("SELECT id FROM pages WHERE device = ?").all(device) as Array<{ id: string }>).map((r) => r.id));
  }

  template(device: string, id: string): Template | undefined {
    const row = this.db.prepare("SELECT data FROM templates WHERE device = ? AND id = ?").get(device, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Template) : undefined;
  }

  /** A device that is no longer paired: its mirror goes. */
  drop(device: string): void {
    this.transaction(() => {
      for (const table of ["pages", "templates"]) this.db.prepare(`DELETE FROM ${table} WHERE device = ?`).run(device);
      this.db.prepare("DELETE FROM devices WHERE id = ?").run(device);
    });
    this.sweep();
  }

  devices(): string[] {
    return (this.db.prepare("SELECT id FROM devices").all() as Array<{ id: string }>).map((r) => r.id);
  }

  hasBlob(hash: string): boolean {
    return HASH.test(hash) && fs.existsSync(path.join(this.blobs, hash));
  }

  readBlob(hash: string): Buffer | undefined {
    if (!HASH.test(hash)) return undefined;
    try {
      return fs.readFileSync(path.join(this.blobs, hash));
    } catch {
      return undefined;
    }
  }

  writeBlob(hash: string, data: Buffer): void {
    if (!HASH.test(hash) || sha256(data) !== hash) throw new Error("The blob does not match its hash.");
    fs.mkdirSync(this.blobs, { recursive: true });
    const file = path.join(this.blobs, hash);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, file);
  }

  /** Remove blobs no mirrored page names any more (an hour after the last sweep at most). */
  sweep(): void {
    this.sweptAt = Date.now();
    const used = new Set<string>();
    for (const { data } of this.db.prepare("SELECT data FROM pages").all() as Array<{ data: string }>) {
      for (const match of data.matchAll(/"hash":"([0-9a-f]{64})"/g)) used.add(match[1]);
    }
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.blobs);
    } catch {
      return;
    }
    // Blobs written in the last hour may belong to a sync still running.
    const cutoff = Date.now() - 3600_000;
    for (const name of names) {
      if (used.has(name)) continue;
      const file = path.join(this.blobs, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch {
        /* gone already */
      }
    }
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

function parseCatalog(text: string): MirrorCatalog {
  try {
    const value = JSON.parse(text) as Partial<MirrorCatalog>;
    return {
      spaces: Array.isArray(value.spaces) ? value.spaces : [],
      folders: Array.isArray(value.folders) ? value.folders : [],
      pages: Array.isArray(value.pages) ? value.pages : [],
      templates: Array.isArray(value.templates) ? value.templates : [],
    };
  } catch {
    return { spaces: [], folders: [], pages: [], templates: [] };
  }
}

function cleanCatalog(value: unknown): MirrorCatalog {
  return parseCatalog(JSON.stringify(value ?? {}));
}

// --- routes ---

/**
 * /api/mirror. `GET /` and `PUT /` are this device's mirror settings (the board UI). `/incoming/*` takes
 * syncs from paired devices, and `/of/:device/*` answers other paired devices about a mirror held here;
 * both only over a link.
 */
export function mirrorRouter(peers: PeerService, pusher: MirrorPusher, store: MirrorStore): Router {
  const router = Router();
  const fail = (res: express.Response, err: unknown, status = 400) => res.status(status).json({ error: (err as Error).message });
  const announce = () => peers.setMirrors(store.held());
  announce();
  // Drop the mirrors of devices that were unpaired.
  peers.on("change", () => {
    const paired = new Set(peers.view().peers.map((p) => p.id));
    let dropped = false;
    for (const id of store.devices()) {
      if (!paired.has(id)) {
        store.drop(id);
        dropped = true;
      }
    }
    if (dropped) announce();
  });

  const linked = Router();
  linked.use((req, res, next) => {
    if (!peerDeviceOf(req.socket)) {
      res.status(403).json({ error: "Mirrors are for paired devices" });
      return;
    }
    next();
  });
  linked.post("/incoming/sync", express.json({ limit: MAX_JSON }), (req, res) => {
    const from = peerDeviceOf(req.socket)!;
    const digest = typeof req.body?.digest === "string" ? req.body.digest : "";
    if (!req.body?.catalog) {
      const same = store.check(from, digest);
      if (same) announce();
      res.json({ same });
      return;
    }
    const fingerprints: Record<string, string> = {};
    for (const [id, fp] of Object.entries((req.body.fingerprints ?? {}) as Record<string, unknown>)) if (typeof fp === "string") fingerprints[id] = fp;
    res.json({ need: store.begin(from, peers.nameOf(from) ?? String(req.body.name ?? from), cleanCatalog(req.body.catalog), fingerprints) });
  });
  linked.post("/incoming/check", express.json(), (req, res) => {
    const hashes = Array.isArray(req.body?.hashes) ? (req.body.hashes as unknown[]).filter((h): h is string => typeof h === "string" && HASH.test(h)) : [];
    res.json({ missing: hashes.filter((hash) => !store.hasBlob(hash)) });
  });
  linked.put("/incoming/blobs/:hash", express.raw({ type: "application/octet-stream", limit: MAX_BLOB }), (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) throw new Error("Send a blob under its SHA-256.");
      store.writeBlob(req.params.hash, req.body);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
  linked.post("/incoming/pages", express.json({ limit: MAX_JSON }), (req, res) => {
    try {
      const pages = Array.isArray(req.body?.pages) ? (req.body.pages as Array<{ id: string; fp: string; page: BoardExportPage }>) : [];
      const ok = pages.filter((p) => p && typeof p.id === "string" && typeof p.fp === "string" && p.page && typeof p.page.html === "string");
      store.putPages(peerDeviceOf(req.socket)!, ok, Array.isArray(req.body?.templates) ? req.body.templates : []);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
  linked.post("/incoming/done", express.json(), (req, res) => {
    if (typeof req.body?.digest !== "string") return void fail(res, new Error("Send the digest."));
    store.done(peerDeviceOf(req.socket)!, req.body.digest);
    announce();
    res.json({ ok: true });
  });
  // Another paired device asks about a mirror held here: its space selector and its references.
  linked.get("/of/:device/spaces", (req, res) => {
    const mirror = store.device(req.params.device);
    if (!mirror) return void fail(res, new Error("No mirror of that device here."), 404);
    res.set("Cache-Control", "no-store").json({ at: mirror.at, spaces: mirror.catalog.spaces.map((s) => ({ id: s.id, name: s.name, color: s.color, tabs: s.tabs.length, active: !!s.active })) });
  });
  linked.post("/of/:device/describe", express.json(), (req, res) => {
    const mirror = store.device(req.params.device);
    if (!mirror) return void fail(res, new Error("No mirror of that device here."), 404);
    const refs = Array.isArray(req.body?.pages) ? (req.body.pages as unknown[]).filter((p): p is string => typeof p === "string").slice(0, 200) : [];
    const mirrored = store.mirrored(mirror.id);
    res.set("Cache-Control", "no-store").json({
      at: mirror.at,
      pages: Object.fromEntries(refs.map((ref) => {
        const key = ref.startsWith("scribe:") ? ref : `scribe:${ref}`;
        const page = mirror.catalog.pages.find((p) => p.id === ref || p.key === ref || p.key === key);
        return [ref, page ? { id: page.id, key: page.key, title: page.title, mirrored: mirrored.has(page.id) } : null];
      })),
      threads: {},
    });
  });
  router.use((req, res, next) => {
    if (req.path.startsWith("/incoming/") || req.path.startsWith("/of/")) linked(req, res, next);
    else next();
  });

  // This device's own settings: the board's.
  router.use((req, res, next) => {
    if (identify(req).viewer === "agent") return void res.status(403).json({ error: "Only the board UI sets up the mirror" });
    const origin = req.get("origin");
    if (req.method !== "GET" && origin && !shellOrigin(req, origin) && origin !== `http://${req.headers.host}`) {
      return void res.status(403).json({ error: "The mirror is set up from the board" });
    }
    next();
  });
  router.get("/", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ ...pusher.view(), held: store.held().map((m) => ({ ...m, name: peers.nameOf(m.id) ?? m.id })) });
  });
  router.put("/", express.json(), (req, res) => {
    try {
      res.json(pusher.update(req.body));
    } catch (err) {
      fail(res, err);
    }
  });
  router.post("/sync", (_req, res) => {
    void pusher.sync().then(() => res.json(pusher.view()));
  });
  return router;
}

// --- the read-only view ---

export type MirrorViewOptions = {
  /** This device's static UI files (the shared page files a mirrored page loads). */
  local: express.RequestHandler;
  /** A page's HTML with the page runtime, as /view/:id serves it. */
  render(tab: { id: string; key: string; title: string; html: string; state: unknown; stateRevision: number; revision: number; assets: Array<{ name: string; mimeType: string }>; templateId?: string }): string;
  /** CopyHost bits that don't depend on the pages: copies from a mirror carry no plugins. */
  received?: CopyHost["received"];
};

/**
 * Requests for another device's hosts that came over a link (#910): the viewing device's gateway sends
 * them here while that device is offline. d-<device> is the mirror browser; t-<page>.d-<device> runs a
 * mirrored page on its own origin, with GET answered from the mirror and every write refused.
 */
export function mirrorView(peers: PeerService, store: MirrorStore, options: MirrorViewOptions) {
  return (req: express.Request, res: express.Response, gateway: { device: string; label?: string }): void => {
    const mirror = store.device(gateway.device);
    const name = mirror?.name ?? peers.nameOf(gateway.device) ?? "That device";
    const readOnly = () => res.status(403).json({ error: `Read only: ${name} is offline, and this is ${peers.identity.name}'s copy of it.` });
    if (!mirror) {
      res.status(404).set("Cache-Control", "no-store").type("html")
        .send(`<!doctype html><meta charset="utf-8"><title>Scribe</title><body style="font:14px system-ui;background:#1a1a1d;color:#e8e8ea;padding:40px"><p>${escapeHtml(name)} is offline, and ${escapeHtml(peers.identity.name)} has no copy of it.</p></body>`);
      return;
    }
    const read = req.method === "GET" || req.method === "HEAD";
    if (gateway.label === undefined) {
      if (read && (req.path === "/" || req.path === "/index.html")) {
        res.set("Cache-Control", "no-store").type("html").send(browserHtml({
          device: { id: mirror.id, name },
          holder: peers.identity.name,
          at: mirror.at,
          catalog: mirror.catalog,
          mirrored: [...store.mirrored(mirror.id)],
        }));
        return;
      }
      if (req.method === "POST" && req.path === "/api/mirror-view/copy") {
        express.json()(req, res, async () => {
          try {
            const viewer = identify(req).device;
            if (!viewer) throw new Error("Copies go to the device you are viewing from.");
            const ids = Array.isArray(req.body?.pages) ? (req.body.pages as unknown[]).filter((p): p is string => typeof p === "string").slice(0, 500) : [];
            res.json(await copyFromMirror(peers, store, mirror.id, name, viewer, ids, options.received));
          } catch (err) {
            res.status(400).json({ error: (err as Error).message });
          }
        });
        return;
      }
      if (!read) return void readOnly();
      if (req.path.startsWith("/api/")) return void res.status(404).json({ error: "Not in the mirror" });
      options.local(req, res, () => res.status(404).type("text").send("Not found"));
      return;
    }
    const pageId = pageIdFromHost(req.hostname);
    const page = pageId ? store.page(mirror.id, pageId) : undefined;
    if (!read) return void readOnly();
    const view = /^\/view\/([^/]+)$/.exec(req.path);
    const asset = /^\/view\/([^/]+)\/asset\/([^/]+)$/.exec(req.path);
    const api = /^\/api\/tabs\/([^/]+)(\/.*)?$/.exec(req.path);
    const blob = /^\/blob\/([^/]+)$/.exec(req.path);
    if (view || asset || api) {
      const id = decodeURIComponent((view ?? asset ?? api)![1]);
      if (!page || id !== pageId) return void res.status(404).type("text").send("Not in the mirror");
      if (view) {
        res.set("Cache-Control", "no-store").type("html").send(options.render({
          id: page.id,
          key: page.key,
          title: page.title,
          html: page.html,
          state: page.state ?? {},
          stateRevision: 0,
          revision: 0,
          assets: (page.assets ?? []).map((a) => ({ name: a.name, mimeType: a.mimeType })),
          ...(page.template?.templateId ? { templateId: page.template.templateId } : {}),
        }));
        return;
      }
      if (asset) {
        const meta = (page.assets ?? []).find((a) => a.name === decodeURIComponent(asset[2])) as { mimeType: string; hash?: string } | undefined;
        const data = meta?.hash ? store.readBlob(meta.hash) : undefined;
        if (!meta || !data) return void res.status(404).type("text").send("asset not found");
        res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" }).type(meta.mimeType).send(data);
        return;
      }
      const rest = api![2] ?? "";
      if (rest === "/state") return void res.set("Cache-Control", "no-store").json({ state: page.state ?? {}, stateRevision: 0 });
      if (rest === "/assets") {
        const list = (page.pageAssets ?? []).map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, createdAt: a.createdAt, url: `/blob/${a.id}` }));
        return void res.json({ assets: list, usage: { count: list.length, bytes: 0, maxCount: 0, maxBytes: 0 } });
      }
      return void res.status(404).json({ error: "Not in the mirror" });
    }
    if (blob) {
      const meta = (page?.pageAssets ?? []).find((a) => a.id === blob[1]) as { mimeType: string; hash?: string } | undefined;
      const data = meta?.hash ? store.readBlob(meta.hash) : undefined;
      if (!meta || !data) return void res.status(404).type("text").send("asset not found");
      res.set({ "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
      if (meta.mimeType !== "application/pdf") res.set("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
      res.type(meta.mimeType).send(data);
      return;
    }
    if (req.path.startsWith("/api/")) return void res.status(404).json({ error: "Not in the mirror" });
    options.local(req, res, () => res.status(404).type("text").send("Not found"));
  };
}

/** Copy to this device, from a mirror: the same push as a copy from the owner, naming the owner. */
async function copyFromMirror(peers: PeerService, store: MirrorStore, device: string, name: string, target: string, ids: string[], received?: CopyHost["received"]) {
  const pages: BoardExportPage[] = [];
  const templates = new Map<string, Template>();
  for (const id of ids) {
    const page = store.page(device, id);
    if (!page) continue;
    const { id: _id, ...rest } = page;
    const copy = JSON.parse(JSON.stringify(rest)) as BoardExportPage;
    for (const asset of [...copy.assets, ...(copy.pageAssets ?? [])] as Array<{ data?: string; hash?: string }>) {
      const data = asset.hash ? store.readBlob(asset.hash) : undefined;
      if (!data) throw new Error("A part of the page is missing from the mirror.");
      asset.data = data.toString("base64");
      delete asset.hash;
    }
    if (copy.template?.templateId) {
      const template = store.template(device, copy.template.templateId);
      if (template) templates.set(template.id, template);
      else delete copy.template;
    }
    pages.push(copy);
  }
  if (!pages.length) throw new Error("None of those pages are in the mirror.");
  const file: BoardExportFile = { format: "scribe-export", version: 1, exportedAt: Date.now(), templates: [...templates.values()], pages };
  const host: CopyHost = {
    exportFile: () => JSON.parse(JSON.stringify(file)) as BoardExportFile,
    importBoard: () => { throw new Error("Not here"); },
    revision: () => 0,
    plugin: () => undefined,
    exportPlugin: () => { throw new Error("Copies from a mirror carry no plugins."); },
    previewPlugin: () => { throw new Error("Not here"); },
    received: received ?? (() => {}),
  };
  return sendCopy(peers, host, target, { pages: ids }, { id: device, name });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

/** The mirror browser: spaces and the Library on the left, the chosen page on the right, read only. */
function browserHtml(data: { device: { id: string; name: string }; holder: string; at: number; catalog: MirrorCatalog; mirrored: string[] }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.device.name)} · mirror</title>
<style>
:root{color-scheme:dark;--bg:#1a1a1d;--panel:#202024;--text:#e8e8ea;--muted:#8e8e96;--border:rgba(255,255,255,.08);--accent:#c49bd8}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font:13px Inter,"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);display:grid;grid-template-rows:auto 1fr;height:100vh}
header{display:flex;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid var(--border);background:var(--panel)}
.chip{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:7px;background:rgba(196,155,216,.14);color:var(--accent);white-space:nowrap}
.note{flex:1;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button,a.btn{font:inherit;color:var(--text);background:rgba(255,255,255,.06);border:1px solid var(--border);border-radius:7px;padding:4px 10px;cursor:pointer;text-decoration:none}
button:hover,a.btn:hover{background:rgba(255,255,255,.1)}button:disabled{opacity:.45;cursor:default}
main{display:grid;grid-template-columns:280px 1fr;min-height:0}
nav{overflow:auto;border-right:1px solid var(--border);padding:8px 6px}
nav h2{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:12px 8px 4px}
.row{display:flex;align-items:center;gap:7px;padding:4px 8px;border-radius:7px;cursor:pointer;white-space:nowrap;overflow:hidden}
.row:hover{background:rgba(255,255,255,.05)}.row.on{background:rgba(255,255,255,.09)}
.row .n{flex:1;overflow:hidden;text-overflow:ellipsis}.row .c{color:var(--muted);font-size:11px}
.row.dim{opacity:.5;cursor:default}.row.dim:hover{background:none}
.sw{width:9px;height:9px;border-radius:3px;flex:none}
.fold{color:var(--muted)}
.empty{display:grid;place-items:center;color:var(--muted);height:100%}
iframe{border:0;width:100%;height:100%;background:#fff0}
#toast{position:fixed;bottom:14px;right:14px;background:#2a2a2f;border:1px solid var(--border);border-radius:9px;padding:8px 12px;display:none}
</style></head><body>
<header>
  <span class="chip">◐ <span id="dev"></span> · mirror</span>
  <span class="note" id="note"></span>
  <button id="copy" disabled>Copy to this device</button>
  <a class="btn" id="back">Back to this device</a>
</header>
<main><nav id="nav"></nav><section id="view"><div class="empty">Pick a page.</div></section></main>
<div id="toast"></div>
<script>
const data=${jsonForScript(data)};
const colors={slate:"#94a3b8",blue:"#8fb3d9",teal:"#7cc4c0",green:"#9db8a4",amber:"#d9b66f",orange:"#d9966f",red:"#ff8a8a",pink:"#e59ac0",violet:"#c49bd8"};
const mirrored=new Set(data.mirrored);
const pages=new Map(data.catalog.pages.map(p=>[p.id,p]));
const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;};
function ago(at){const m=Math.round((Date.now()-at)/60000);if(m<1)return "just now";if(m<60)return m+" min ago";const h=Math.round(m/60);if(h<48)return h+" h ago";return Math.round(h/24)+" days ago";}
$("dev").textContent=data.device.name;
$("note").textContent=data.device.name+" is offline. Read-only copy from "+ago(data.at)+", kept on "+data.holder+".";
$("back").href="http://127.0.0.1:"+location.port+"/";
let current=null;
function open(id){
  const page=pages.get(id);if(!page||!mirrored.has(id))return;
  current=id;
  document.querySelectorAll(".row[data-id]").forEach(r=>r.classList.toggle("on",r.dataset.id===id));
  const label=/^t_[0-9a-f]+$/.test(id)?"t-"+id.slice(2):"x"+Array.from(new TextEncoder().encode(id),b=>b.toString(16).padStart(2,"0")).join("");
  const frame=el("iframe");frame.src=location.protocol+"//"+label+"."+location.host+"/view/"+encodeURIComponent(id);
  $("view").replaceChildren(frame);
  $("copy").disabled=false;
  document.title=page.title+" · "+data.device.name+" (mirror)";
  history.replaceState(null,"","?open="+encodeURIComponent(page.key));
}
function row(page){
  const r=el("div","row"+(mirrored.has(page.id)?"":" dim"));r.dataset.id=page.id;
  r.append(el("span","n",page.title||page.key));
  if(!mirrored.has(page.id)){r.append(el("span","c","catalog only"));r.title="Only its title is in the mirror.";}
  r.onclick=()=>open(page.id);
  return r;
}
const nav=$("nav");
if(data.catalog.spaces.length){
  nav.append(el("h2",null,"Spaces"));
  for(const space of data.catalog.spaces){
    const head=el("div","row");head.dataset.space=space.id;
    const sw=el("span","sw");sw.style.background=colors[space.color]||colors.slate;
    head.append(sw,el("span","n",space.name),el("span","c",String(space.tabs.length)));
    const list=el("div");list.style.paddingLeft="14px";
    for(const id of space.tabs){const p=pages.get(id);if(p)list.append(row(p));}
    head.onclick=()=>{list.hidden=!list.hidden;};
    nav.append(head,list);
  }
}
nav.append(el("h2",null,"Library"));
const children=new Map();
for(const f of data.catalog.folders){const k=f.parentId||"";if(!children.has(k))children.set(k,[]);children.get(k).push(f);}
const inFolder=new Map();
for(const p of data.catalog.pages){const k=p.folderId||"";if(!inFolder.has(k))inFolder.set(k,[]);inFolder.get(k).push(p);}
function tree(parent,depth,into){
  for(const f of children.get(parent)||[]){
    const head=el("div","row fold");head.style.paddingLeft=(8+depth*12)+"px";head.append(el("span","n","▸ "+f.name));
    const box=el("div");box.hidden=true;
    head.onclick=()=>{box.hidden=!box.hidden;head.firstChild.textContent=(box.hidden?"▸ ":"▾ ")+f.name;};
    into.append(head,box);
    tree(f.id,depth+1,box);
  }
  for(const p of (inFolder.get(parent)||[]).sort((a,b)=>a.title.localeCompare(b.title))){const r=row(p);r.style.paddingLeft=(8+depth*12)+"px";into.append(r);}
}
tree("",0,nav);
$("copy").onclick=async()=>{
  if(!current)return;
  $("copy").disabled=true;
  try{
    const res=await fetch("/api/mirror-view/copy",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pages:[current]})});
    const out=await res.json();
    toast(res.ok?"Copied to "+out.device.name+".":(out.error||"Could not copy."));
  }catch(err){toast(String(err));}
  $("copy").disabled=false;
};
function toast(text){const t=$("toast");t.textContent=text;t.style.display="block";clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.style.display="none",4000);}
const params=new URLSearchParams(location.search);
const want=params.get("open");
if(want){const key=want.split("#")[0];const p=data.catalog.pages.find(p=>p.key===key||p.key==="scribe:"+key||p.id===key);if(p)open(p.id);}
else if(params.get("space")){const head=document.querySelector('[data-space="'+CSS.escape(params.get("space"))+'"]');if(head)head.scrollIntoView();}
</script></body></html>`;
}

