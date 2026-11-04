import fs from "node:fs";
import path from "node:path";
import { MAX_ASSET_BYTES, MAX_ASSETS_PER_TAB, MAX_ASSETS_TOTAL_BYTES, dataDir } from "./config.js";
import type { PreparedAsset, TabAsset } from "./types.js";

const ASSET_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
};

/** Images and sounds an agent may attach with page_show. */
const ASSET_KINDS = "png, jpg, gif, webp, svg, ico, avif, mp3, ogg, wav, m4a";
const isAssetMime = (type: string) => type.startsWith("image/") || type.startsWith("audio/");

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export type AssetInput = {
  path: string;
  name?: string;
};

export function parseAssetInputs(raw: unknown): AssetInput[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("assets must be an array of file paths");
  }
  if (raw.length > MAX_ASSETS_PER_TAB) {
    throw new Error(`too many assets (${raw.length}, max ${MAX_ASSETS_PER_TAB})`);
  }
  return raw.map((item, index) => parseOneAssetInput(item, index));
}

export function prepareAssets(inputs: AssetInput[]): PreparedAsset[] {
  const used = new Set<string>();
  const prepared: PreparedAsset[] = [];
  for (const input of inputs) {
    const asset = readAssetFile(input);
    const key = asset.name.toLowerCase();
    if (used.has(key)) {
      throw new Error(`duplicate asset name: ${asset.name}`);
    }
    used.add(key);
    prepared.push(asset);
  }
  return prepared;
}

export function readAssetFile(input: AssetInput): PreparedAsset {
  const resolved = path.resolve(input.path);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`asset not found: ${resolved}`);
  }
  if (!stat.isFile()) {
    throw new Error(`asset is not a file: ${resolved}`);
  }
  if (stat.size <= 0) {
    throw new Error(`asset is empty: ${resolved}`);
  }
  if (stat.size > MAX_ASSET_BYTES) {
    throw new Error(`asset is too large (${stat.size} bytes, max ${MAX_ASSET_BYTES}): ${resolved}`);
  }
  const name = sanitizeAssetName(input.name ?? path.basename(resolved));
  const mimeType = mimeForName(name);
  if (!mimeType) {
    throw new Error(`unsupported asset type "${path.extname(name) || name}" (${ASSET_KINDS})`);
  }
  return { name, mimeType, buffer: fs.readFileSync(resolved) };
}

export function sanitizeAssetName(value: string): string {
  const cleaned = path.basename(value.trim()).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!isSafeAssetName(cleaned)) {
    throw new Error(`invalid asset name: ${value}`);
  }
  if (cleaned.length <= 80) {
    return cleaned;
  }
  const ext = path.extname(cleaned);
  const stem = cleaned.slice(0, Math.max(1, 80 - ext.length));
  return `${stem}${ext}`;
}

export function isSafeAssetName(name: string): boolean {
  return SAFE_NAME.test(name) && !name.startsWith(".") && name.includes(".");
}

export function writePreparedAssets(tabId: string, current: TabAsset[], incoming: PreparedAsset[]): TabAsset[] {
  const replacing = new Set(incoming.map((item) => item.name.toLowerCase()));
  const kept = current.filter((asset) => !replacing.has(asset.name.toLowerCase()));
  if (kept.length + incoming.length > MAX_ASSETS_PER_TAB) {
    throw new Error(`too many assets (${kept.length + incoming.length}, max ${MAX_ASSETS_PER_TAB})`);
  }
  const nextBytes =
    kept.reduce((sum, asset) => sum + asset.bytes, 0) + incoming.reduce((sum, item) => sum + item.buffer.length, 0);
  if (nextBytes > MAX_ASSETS_TOTAL_BYTES) {
    throw new Error(`assets are too large (${nextBytes} bytes, max ${MAX_ASSETS_TOTAL_BYTES})`);
  }
  const dir = tabAssetsDir(tabId);
  fs.mkdirSync(dir, { recursive: true });
  const byName = new Map<string, TabAsset>();
  for (const asset of current) {
    byName.set(asset.name.toLowerCase(), asset);
  }
  for (const item of incoming) {
    fs.writeFileSync(path.join(dir, item.name), item.buffer);
    byName.set(item.name.toLowerCase(), {
      name: item.name,
      mimeType: item.mimeType,
      bytes: item.buffer.length,
    });
  }
  return [...byName.values()];
}

export function readStoredAsset(tabId: string, name: string): Buffer | undefined {
  if (!isSafeAssetName(name)) {
    return undefined;
  }
  const file = path.join(tabAssetsDir(tabId), name);
  try {
    return fs.readFileSync(file);
  } catch {
    return undefined;
  }
}

export function readPreparedAssets(tabId: string, metas: TabAsset[]): PreparedAsset[] {
  const out: PreparedAsset[] = [];
  for (const meta of metas) {
    const buffer = readStoredAsset(tabId, meta.name);
    if (!buffer) {
      continue;
    }
    out.push({ name: meta.name, mimeType: meta.mimeType, buffer });
  }
  return out;
}

export function prepareAssetFromBuffer(name: string, mimeType: string, buffer: Buffer): PreparedAsset {
  const safe = sanitizeAssetName(name);
  const expected = mimeForName(safe);
  if (!expected) {
    throw new Error(`unsupported asset type "${path.extname(safe) || safe}" (${ASSET_KINDS})`);
  }
  if (typeof mimeType !== "string" || !isAssetMime(mimeType)) {
    throw new Error(`invalid asset mime type: ${mimeType}`);
  }
  if (buffer.length <= 0) {
    throw new Error(`asset is empty: ${safe}`);
  }
  if (buffer.length > MAX_ASSET_BYTES) {
    throw new Error(`asset is too large (${buffer.length} bytes, max ${MAX_ASSET_BYTES}): ${safe}`);
  }
  return { name: safe, mimeType: expected, buffer };
}

export function deleteTabAssets(tabId: string): void {
  fs.rmSync(tabAssetsDir(tabId), { recursive: true, force: true });
}

export function cleanupOrphanAssets(keepIds: Iterable<string>): void {
  const root = assetsRoot();
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
  const keep = new Set(keepIds);
  for (const name of entries) {
    if (!keep.has(name)) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  }
}

export function rewriteAssetRefs(html: string, tabId: string): string {
  return html
    .replace(/(src|href)=(["'])asset:([A-Za-z0-9._-]+)\2/gi, (_match, attr: string, quote: string, name: string) => {
      return `${attr}=${quote}${assetUrl(tabId, name)}${quote}`;
    })
    .replace(/url\(\s*(["']?)asset:([A-Za-z0-9._-]+)\1\s*\)/gi, (_match, quote: string, name: string) => {
      return `url(${quote}${assetUrl(tabId, name)}${quote})`;
    });
}

export function assetUrl(tabId: string, name: string): string {
  return `/view/${encodeURIComponent(tabId)}/asset/${encodeURIComponent(name)}`;
}

export function normalizeTabAssets(value: unknown): TabAsset[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as { name?: unknown; mimeType?: unknown; bytes?: unknown };
    if (typeof record.name !== "string" || !isSafeAssetName(record.name)) {
      return [];
    }
    if (typeof record.mimeType !== "string" || !isAssetMime(record.mimeType)) {
      return [];
    }
    if (typeof record.bytes !== "number" || !Number.isFinite(record.bytes) || record.bytes < 0) {
      return [];
    }
    return [{ name: record.name, mimeType: record.mimeType, bytes: record.bytes }];
  });
}

function parseOneAssetInput(item: unknown, index: number): AssetInput {
  if (typeof item === "string") {
    if (!item.trim()) {
      throw new Error(`assets[${index}] is empty`);
    }
    return { path: item };
  }
  if (item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string") {
    const pathValue = (item as { path: string }).path;
    const name = (item as { name?: unknown }).name;
    if (!pathValue.trim()) {
      throw new Error(`assets[${index}].path is empty`);
    }
    if (name !== undefined && typeof name !== "string") {
      throw new Error(`assets[${index}].name must be a string`);
    }
    return { path: pathValue, name: typeof name === "string" ? name : undefined };
  }
  throw new Error(`assets[${index}] must be a path string or { path, name? }`);
}

function mimeForName(name: string): string | undefined {
  return ASSET_MIME[path.extname(name).toLowerCase()];
}

function assetsRoot(): string {
  return path.join(dataDir(), "assets");
}

function tabAssetsDir(tabId: string): string {
  if (!/^t_[a-f0-9]+$/i.test(tabId)) {
    throw new Error(`invalid tab id: ${tabId}`);
  }
  return path.join(assetsRoot(), tabId);
}
