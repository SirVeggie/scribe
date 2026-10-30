import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import { parseImport, type BoardExportFile, type ParsedImport } from "../boardExport.js";
import { identify } from "../callers.js";
import { shellOrigin } from "../contentOrigin.js";
import { declaredPlugins } from "../plugins/manifest.js";
import { unzip, type PackageFiles } from "../plugins/package.js";
import type { Tab } from "../types.js";
import { deviceDir } from "./identity.js";
import { peerDeviceOf } from "./link.js";
import type { PeerService } from "./peers.js";

/**
 * Copy pages, templates and plugins to another device (#907). The device that owns them pushes: it
 * exports a bundle like a file export, with every blob (page images, saved page assets, plugin
 * archives) replaced by its SHA-256. The target says which hashes it lacks, only those travel, and
 * then the bundle goes over and is imported like a file import (key clashes get a suffix, templates
 * are matched by content). Each page records `provenance.copiedFrom`; it is an independent fork.
 * Plugins wait on the target, uninstalled, until the user reviews them there.
 *
 * "Copy to this device" in another device's UI is the same push: that UI talks to its own daemon,
 * which pushes to the device the user is viewing from.
 */

export const COPY_FORMAT = "scribe-copy";
export const COPY_VERSION = 1;

/** What to copy, in the owning device's ids. Templates by id, plugins by id. */
export type CopySelection = { pages?: string[]; folders?: string[]; templates?: string[]; plugins?: string[] };

type BundlePlugin = { id: string; name: string; version: string; hash: string };
type CopyBundle = { format: typeof COPY_FORMAT; version: number; file: BoardExportFile | null; plugins: BundlePlugin[] };

export type CopyResult = {
  device: { id: string; name: string };
  pages: number;
  templatesCreated: number;
  templatesReused: number;
  /** Plugins that now wait for review on the target. */
  plugins: { id: string; name: string; version: string }[];
  /** Plugins the target already had with the same code. */
  pluginsPresent: string[];
  /** Blob bytes sent, and those the target already held. */
  sent: number;
  skipped: number;
};

export type PendingPlugin = { id: string; name: string; version: string; hash: string; from: { id: string; name: string }; at: number };

export type CopyHost = {
  exportFile(scope: { templateId?: string; pageIds?: string[]; folderIds?: string[] }): BoardExportFile;
  importBoard(parsed: ParsedImport): { tabs: Tab[]; templatesCreated: number; templatesReused: number };
  revision(key: string): number | undefined;
  /** An installed plugin's name, version and code hash, or undefined. */
  plugin(id: string): { name: string; version: string; hash: string } | undefined;
  exportPlugin(id: string): Buffer;
  /** Validates a package (throws when it is not a usable plugin); `same` when that code is installed. */
  previewPlugin(files: PackageFiles, detailed?: boolean): { same: boolean; manifest: { id: string; name: string; version: string } };
  /** A copy came in: tell this device's board. */
  received(event: { from: { id: string; name: string }; pages: number; templates: number; plugins: number }): void;
};

const REQUEST_MS = 120_000;
const BLOB_KEEP_MS = 7 * 24 * 3600_000;
const MAX_BLOB = "90mb";
const MAX_BUNDLE = "64mb";
const HASH = /^[0-9a-f]{64}$/;

const sha256 = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");

// --- sending ---

export async function sendCopy(peers: PeerService, host: CopyHost, target: string, selection: CopySelection): Promise<CopyResult> {
  if (target === peers.identity.id) throw new Error("That is this device.");
  const name = peers.nameOf(target);
  if (!name) throw new Error("No paired device with that id.");
  if (!peers.linkTo(target)) throw new Error(`${name} is offline.`);

  const blobs = new Map<string, Buffer>();
  const file = exportSelection(host, selection);
  if (file) {
    const at = Date.now();
    for (const page of file.pages) {
      page.provenance = {
        // Thread ids mean nothing on the other device; keep who made it by title only.
        ...(page.provenance?.created ? { created: { at: page.provenance.created.at, ...(page.provenance.created.title ? { title: page.provenance.created.title } : {}) } } : {}),
        ...(page.provenance?.changed ? { changed: { at: page.provenance.changed.at, ...(page.provenance.changed.title ? { title: page.provenance.changed.title } : {}) } } : {}),
        copiedFrom: { device: peers.identity.id, name: peers.identity.name, key: page.key, revision: host.revision(page.key) ?? 0, at },
      };
      for (const asset of [...page.assets, ...(page.pageAssets ?? [])] as Array<{ data?: string; hash?: string }>) {
        const data = Buffer.from(asset.data ?? "", "base64");
        const hash = sha256(data);
        blobs.set(hash, data);
        delete asset.data;
        asset.hash = hash;
      }
    }
  }

  // Plugins: the ones asked for, and the ones the pages and templates use.
  const wanted = new Set(selection.plugins ?? []);
  for (const item of [...(file?.pages ?? []), ...(file?.templates ?? [])]) for (const id of declaredPlugins(item.html)) wanted.add(id);
  const local = [...wanted].flatMap((id) => {
    const plugin = host.plugin(id);
    if (!plugin && selection.plugins?.includes(id)) throw new Error(`Plugin not found: ${id}`);
    return plugin ? [{ id, ...plugin }] : [];
  });
  if (!file && !local.length) throw new Error("Nothing to copy.");

  // Each plugin goes as its archive, unless the target has that code already.
  const archives = new Map(local.map((plugin) => {
    const archive = host.exportPlugin(plugin.id);
    return [plugin.id, { archive, hash: sha256(archive) }] as const;
  }));
  const check = await call<{ missing: string[]; present: string[] }>(peers, target, "POST", "/api/copy/incoming/check", {
    hashes: [...new Set([...blobs.keys(), ...[...archives.values()].map((a) => a.hash)])],
    plugins: local.map(({ id, hash }) => ({ id, hash })),
  });
  const present = new Set(Array.isArray(check.present) ? check.present : []);
  const missing = new Set(Array.isArray(check.missing) ? check.missing : []);
  const plugins: BundlePlugin[] = [];
  for (const plugin of local) {
    if (present.has(plugin.id)) continue;
    const { archive, hash } = archives.get(plugin.id)!;
    blobs.set(hash, archive);
    plugins.push({ id: plugin.id, name: plugin.name, version: plugin.version, hash });
  }

  let sent = 0;
  let skipped = 0;
  for (const [hash, data] of blobs) {
    if (!missing.has(hash)) {
      skipped += data.length;
      continue;
    }
    await call(peers, target, "PUT", `/api/copy/incoming/blobs/${hash}`, data);
    sent += data.length;
  }

  const bundle: CopyBundle = { format: COPY_FORMAT, version: COPY_VERSION, file, plugins };
  const result = await call<Omit<CopyResult, "device" | "sent" | "skipped" | "pluginsPresent">>(peers, target, "POST", "/api/copy/incoming", bundle);
  return { ...result, device: { id: target, name }, pluginsPresent: [...present], sent, skipped };
}

function exportSelection(host: CopyHost, selection: CopySelection): BoardExportFile | null {
  const pages = selection.pages ?? [];
  const folders = selection.folders ?? [];
  const files: BoardExportFile[] = [];
  if (pages.length || folders.length) files.push(host.exportFile({ pageIds: pages, folderIds: folders }));
  for (const id of selection.templates ?? []) files.push(host.exportFile({ templateId: id }));
  if (!files.length) return null;
  const [first, ...rest] = files;
  for (const other of rest) {
    for (const template of other.templates) if (!first.templates.some((t) => t.id === template.id)) first.templates.push(template);
  }
  return first;
}

async function call<T = unknown>(peers: PeerService, target: string, method: string, url: string, body: unknown): Promise<T> {
  const raw = Buffer.isBuffer(body);
  const payload = raw ? body : Buffer.from(JSON.stringify(body));
  const reply = await timed(peers.request(target, {
    method,
    path: url,
    headers: { host: "127.0.0.1", "content-type": raw ? "application/octet-stream" : "application/json", "content-length": String(payload.length) },
    body: payload,
  }));
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(reply.body.toString("utf8")) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (reply.status === 404 && !data.error) throw new Error(`${peers.nameOf(target) ?? "The device"} runs a Scribe without copying between devices: update it.`);
  if (reply.status >= 400) throw new Error(typeof data.error === "string" ? data.error : `The device answered ${reply.status}.`);
  return data as T;
}

function timed<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The device did not answer in time.")), REQUEST_MS);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

// --- receiving ---

/** Blobs that came in for copies, by hash, so a copy that is sent again (or retried) skips them. */
class BlobStore {
  constructor(private readonly dir: string) {}

  has(hash: string): boolean {
    const file = this.file(hash);
    if (!fs.existsSync(file)) return false;
    // Seen again: keep it another week.
    const now = new Date();
    try { fs.utimesSync(file, now, now); } catch { /* still there to read */ }
    return true;
  }

  read(hash: string): Buffer | undefined {
    try {
      return fs.readFileSync(this.file(hash));
    } catch {
      return undefined;
    }
  }

  write(hash: string, data: Buffer): void {
    if (sha256(data) !== hash) throw new Error("The blob does not match its hash.");
    fs.mkdirSync(this.dir, { recursive: true });
    const temp = `${this.file(hash)}.${process.pid}.tmp`;
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, this.file(hash));
  }

  /** Drop blobs nothing asked for in a week, except the ones `keep` names (pending plugins). */
  prune(keep: Set<string>): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - BLOB_KEEP_MS;
    for (const name of names) {
      if (keep.has(name)) continue;
      const file = path.join(this.dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch {
        /* gone already */
      }
    }
  }

  private file(hash: string): string {
    return path.join(this.dir, hash);
  }
}

class PendingPlugins {
  constructor(private readonly file: string) {}

  list(): PendingPlugin[] {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      return Array.isArray(value) ? (value as PendingPlugin[]) : [];
    } catch {
      return [];
    }
  }

  add(entry: PendingPlugin): void {
    this.save([...this.list().filter((p) => p.id !== entry.id), entry]);
  }

  remove(id: string): boolean {
    const list = this.list();
    const next = list.filter((p) => p.id !== id);
    if (next.length !== list.length) this.save(next);
    return next.length !== list.length;
  }

  private save(list: PendingPlugin[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(list, null, 2));
    fs.renameSync(temp, this.file);
  }
}

/**
 * /api/copy: `POST /` copies to a paired device and `GET /targets` lists them (the board's UI, on
 * this device or through another device's gateway); `/incoming/*` takes a copy from a paired device
 * (link callers only); `/plugins` lists and dismisses plugins that wait for review here.
 */
export function copyRouter(peers: PeerService, host: CopyHost, home: string): Router {
  const router = Router();
  const blobs = new BlobStore(path.join(deviceDir(home), "blobs"));
  const pending = new PendingPlugins(path.join(deviceDir(home), "pending-plugins.json"));
  const fail = (res: express.Response, err: unknown, status = 400) => res.status(status).json({ error: (err as Error).message });

  // Copies from a paired device: only over the link, which says who sent them.
  const incoming = Router();
  incoming.use((req, res, next) => {
    if (!peerDeviceOf(req.socket)) {
      res.status(403).json({ error: "Copies come from paired devices" });
      return;
    }
    next();
  });
  incoming.post("/check", express.json(), (req, res) => {
    const hashes = Array.isArray(req.body?.hashes) ? (req.body.hashes as unknown[]).filter((h): h is string => typeof h === "string" && HASH.test(h)) : [];
    const plugins = Array.isArray(req.body?.plugins) ? (req.body.plugins as Array<{ id?: unknown; hash?: unknown }>) : [];
    res.json({
      missing: hashes.filter((hash) => !blobs.has(hash)),
      present: plugins.filter((p) => typeof p.id === "string" && host.plugin(p.id)?.hash === p.hash).map((p) => p.id as string),
    });
  });
  incoming.put("/blobs/:hash", express.raw({ type: "application/octet-stream", limit: MAX_BLOB }), (req, res) => {
    try {
      if (!HASH.test(req.params.hash) || !Buffer.isBuffer(req.body)) throw new Error("Send a blob under its SHA-256.");
      blobs.write(req.params.hash, req.body);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
  incoming.post("/", express.json({ limit: MAX_BUNDLE }), async (req, res) => {
    try {
      const fromId = peerDeviceOf(req.socket)!;
      const from = { id: fromId, name: peers.nameOf(fromId) ?? fromId };
      const result = await receive(req.body as CopyBundle, from);
      res.status(201).json(result);
    } catch (err) {
      fail(res, err);
    }
  });

  async function receive(bundle: CopyBundle, from: { id: string; name: string }) {
    if (!bundle || bundle.format !== COPY_FORMAT) throw new Error("Not a copy from a Scribe device.");
    if (bundle.version !== COPY_VERSION) throw new Error(`Copy version ${String(bundle.version)} is not supported here: update this device.`);
    const blob = (hash: unknown): Buffer => {
      const data = typeof hash === "string" && HASH.test(hash) ? blobs.read(hash) : undefined;
      if (!data) throw new Error("A part of the copy did not arrive. Copy again.");
      return data;
    };
    // Check the plugins first, so a broken one doesn't leave half a copy behind.
    const plugins: PendingPlugin[] = [];
    for (const plugin of Array.isArray(bundle.plugins) ? bundle.plugins : []) {
      const files = await unzip(blob(plugin.hash));
      const preview = host.previewPlugin(files);
      if (preview.manifest.id !== plugin.id) throw new Error("A plugin in the copy names another id.");
      if (preview.same) continue;
      plugins.push({ id: preview.manifest.id, name: preview.manifest.name, version: preview.manifest.version, hash: plugin.hash, from, at: Date.now() });
    }
    let imported = { tabs: [] as Tab[], templatesCreated: 0, templatesReused: 0 };
    const file = bundle.file;
    if (file && (file.pages?.length || file.templates?.length)) {
      for (const page of Array.isArray(file.pages) ? file.pages : []) {
        for (const asset of [...(page.assets ?? []), ...(page.pageAssets ?? [])] as Array<{ data?: string; hash?: string }>) {
          asset.data = blob(asset.hash).toString("base64");
          delete asset.hash;
        }
      }
      const parsed = parseImport(JSON.stringify(file), "copy.json");
      // The link says who sent it; the bundle only says which page and revision.
      for (const [index, page] of parsed.pages.entries()) {
        const source = file.pages[index]?.provenance?.copiedFrom;
        page.provenance = {
          ...(page.provenance ?? {}),
          copiedFrom: { device: from.id, name: from.name, key: source?.key ?? page.key ?? "", revision: source?.revision ?? 0, at: Date.now() },
        };
        delete page.closedAt;
        page.pinned = false;
      }
      imported = host.importBoard(parsed);
    }
    for (const plugin of plugins) pending.add(plugin);
    blobs.prune(new Set(pending.list().map((p) => p.hash)));
    host.received({ from, pages: imported.tabs.length, templates: imported.templatesCreated, plugins: plugins.length });
    return {
      pages: imported.tabs.length,
      templatesCreated: imported.templatesCreated,
      templatesReused: imported.templatesReused,
      plugins: plugins.map(({ id, name, version }) => ({ id, name, version })),
    };
  }

  router.use("/incoming", incoming);

  // The rest is the user's: agents get no cross-device access in v1, and changes come from the board.
  router.use((req, res, next) => {
    if (identify(req).viewer === "agent") {
      res.status(403).json({ error: "Only the board UI copies between devices" });
      return;
    }
    const origin = req.get("origin");
    if (req.method !== "GET" && origin && !shellOrigin(req, origin)) {
      res.status(403).json({ error: "Copies can only be made from the board" });
      return;
    }
    next();
  });
  // Where this device can copy to. `viewer`: the device whose browser shows this UI, for "Copy to this device".
  router.get("/targets", (req, res) => {
    const view = peers.view();
    res.set("Cache-Control", "no-store").json({
      self: { id: view.self.id, name: view.self.name },
      viewer: identify(req).device ?? null,
      devices: view.peers.map((peer) => ({ id: peer.id, name: peer.name, online: peer.online })),
    });
  });
  router.post("/", express.json(), async (req, res) => {
    const ids = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v) : undefined);
    try {
      if (typeof req.body?.device !== "string") throw new Error("Choose a device to copy to.");
      res.json(await sendCopy(peers, host, req.body.device, {
        pages: ids(req.body.pages),
        folders: ids(req.body.folders),
        templates: ids(req.body.templates),
        plugins: ids(req.body.plugins),
      }));
    } catch (err) {
      fail(res, err);
    }
  });
  router.get("/plugins", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ plugins: pending.list().map(({ hash: _hash, ...rest }) => rest) });
  });
  // One waiting plugin, for the install review: its preview and archive.
  router.get("/plugins/:id", async (req, res) => {
    try {
      const entry = pending.list().find((p) => p.id === req.params.id);
      if (!entry) return fail(res, new Error("No plugin with that id is waiting."), 404);
      const archive = blobs.read(entry.hash);
      if (!archive) {
        pending.remove(entry.id);
        return fail(res, new Error("The copied plugin is gone. Copy it again."), 410);
      }
      res.json({ ...entry, preview: host.previewPlugin(await unzip(archive), true), archive: archive.toString("base64") });
    } catch (err) {
      fail(res, err);
    }
  });
  router.delete("/plugins/:id", (req, res) => {
    pending.remove(req.params.id);
    res.json({ ok: true });
  });
  return router;
}
