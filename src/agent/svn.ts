import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { unifiedDiff } from "./textDiff.js";
import type { FileChange } from "./types.js";

/**
 * Subversion working copies: the changes against the checked-out base (BASE), which svn keeps
 * locally, so nothing here talks to the server.
 */

/** Files larger than this are listed but not read or compared. */
export const MAX_SVN_FILE_BYTES = 4 * 1024 * 1024;
/** Unversioned folders can hold build output: list at most this many files from them. */
const MAX_UNVERSIONED_FILES = 2000;

export function svn(args: string[], cwd: string, options: { timeoutMs?: number; encoding?: "utf8" | "buffer" } = {}): Promise<{ stdout: Buffer | string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      "svn",
      ["--non-interactive", ...args],
      { cwd, windowsHide: true, timeout: options.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024, encoding: options.encoding === "buffer" ? "buffer" : "utf8" },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as unknown as { code: number }).code : 1) : 0;
        resolve({ stdout, stderr: String(stderr ?? ""), code });
      }
    );
  });
}

const rootCache = new Map<string, { root: string | null; at: number }>();

/** The root of the svn working copy holding `cwd` (the folder with .svn), or null. */
export function findSvnRoot(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const cached = rootCache.get(cwd);
  if (cached && Date.now() - cached.at < 60_000) return cached.root;
  let root: string | null = null;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    try {
      if (fs.statSync(path.join(dir, ".svn")).isDirectory()) {
        root = dir;
        break;
      }
    } catch {
      // keep looking up
    }
    if (path.dirname(dir) === dir) break;
  }
  rootCache.set(cwd, { root, at: Date.now() });
  return root;
}

/** unversioned: not under version control (svn status "?"), as opposed to added. */
export type SvnEntry = { path: string; status: "A" | "M" | "D"; unversioned?: boolean };

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENTITIES[e.toLowerCase()]);

/** Statuses from `svn status --xml`, by path relative to `dir`. */
export function parseSvnStatus(xml: string): Array<{ path: string; item: string; kind?: string }> {
  const out: Array<{ path: string; item: string }> = [];
  for (const m of xml.matchAll(/<entry\s+path="([^"]*)"\s*>\s*<wc-status\b([^>]*)>/g)) {
    const item = /\bitem="([^"]*)"/.exec(m[2])?.[1] ?? "";
    out.push({ path: unescapeXml(m[1]).replaceAll("\\", "/"), item });
  }
  return out;
}

/**
 * Changed files under `dir` (paths relative to it, with /): modified, added, deleted and
 * unversioned ones. With `walk`, the files inside unversioned folders are listed one by one;
 * without it, an unversioned folder is one entry. Ignored files are left out.
 * Null when svn could not run.
 */
export async function svnChangedFiles(dir: string, options: { walk?: boolean } = {}): Promise<SvnEntry[] | null> {
  const res = await svn(["status", "--xml", "."], dir, { timeoutMs: 60_000 });
  if (res.code !== 0) return null;
  const entries: SvnEntry[] = [];
  let unversioned = 0;
  for (const { path: rel, item } of parseSvnStatus(String(res.stdout))) {
    if (!rel || rel === ".") continue;
    const abs = path.join(dir, rel);
    if (item === "unversioned") {
      let stat: fs.Stats | null = null;
      try { stat = fs.statSync(abs); } catch { /* gone since */ }
      if (stat?.isDirectory() && options.walk !== false) {
        for (const file of walk(abs, MAX_UNVERSIONED_FILES - unversioned)) {
          entries.push({ path: path.relative(dir, file).replaceAll("\\", "/"), status: "A", unversioned: true });
          unversioned += 1;
        }
      } else if (stat) entries.push({ path: rel, status: "A", unversioned: true });
    } else if (item === "added") {
      // An added folder's own files are listed by svn.
      if (!isDir(abs)) entries.push({ path: rel, status: "A" });
    } else if (item === "deleted" || item === "missing") {
      // A deleted folder is listed too; svnWorkingChanges drops it, as it has no base content.
      if (!isDir(abs)) entries.push({ path: rel, status: "D" });
    } else if (item === "modified" || item === "replaced" || item === "conflicted") {
      if (!isDir(abs)) entries.push({ path: rel, status: "M" });
    }
  }
  return entries;
}

function isDir(file: string): boolean {
  try { return fs.statSync(file).isDirectory(); } catch { return false; }
}

function* walk(dir: string, limit: number): Generator<string> {
  if (limit <= 0) return;
  const stack = [dir];
  let n = 0;
  while (stack.length) {
    const current = stack.pop()!;
    let list: fs.Dirent[] = [];
    try { list = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of list) {
      if (entry.name === ".svn" || entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        yield full;
        if (++n >= limit) return;
      }
    }
  }
}

/** A file's checked-out base content (BASE), or null when svn has none (added or unversioned). */
export async function svnBase(dir: string, rel: string): Promise<Buffer | null> {
  // A trailing @ keeps svn from reading an @ in the name as a revision.
  const res = await svn(["cat", "-r", "BASE", `${rel}@`], dir, { timeoutMs: 20_000, encoding: "buffer" });
  return res.code === 0 ? (res.stdout as Buffer) : null;
}

/** The working copy's revision, for a title. */
export async function svnRevision(dir: string): Promise<string | null> {
  const res = await svn(["info", "--show-item", "revision", "."], dir, { timeoutMs: 10_000 });
  return res.code === 0 ? String(res.stdout).trim() || null : null;
}

export function readFileText(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SVN_FILE_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

const isBinary = (text: string | null) => !!text && text.includes("\0");

/** Runs `fn` over items, a few at a time (each svn cat is its own process). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const MAX_PATCH = 4 * 1024 * 1024;

/**
 * The working copy under `dir` against BASE: changed files with line counts, and one patch.
 * Unversioned files are not changes to the checkout (logs, build output, IDE files), so they
 * are only counted, as svn status lists them: a folder counts once.
 */
export async function svnWorkingChanges(dir: string): Promise<{ files: FileChange[]; patch: string; truncated: boolean; unversioned: number } | null> {
  const all = await svnChangedFiles(dir, { walk: false });
  if (!all) return null;
  const entries = all.filter((e) => !e.unversioned);
  const results = await mapLimit(entries, 6, async (entry) => {
    const base = entry.status === "A" ? null : await svnBase(dir, entry.path);
    if (entry.status === "D" && !base) return null;
    const before = base?.toString("utf8") ?? null;
    const after = entry.status === "D" ? null : readFileText(path.join(dir, entry.path));
    if (isBinary(before) || isBinary(after)) return { file: { path: entry.path, status: entry.status, added: 0, removed: 0, binary: true } as FileChange, patch: "" };
    const diff = unifiedDiff(before, after, entry.path);
    return { file: { path: entry.path, status: entry.status, added: diff.added, removed: diff.removed } as FileChange, patch: diff.patch };
  });
  const kept = results.filter((r): r is NonNullable<typeof r> => !!r && (!!r.patch || !!r.file.binary || r.file.status !== "M"));
  const files = kept.map((r) => r.file);
  let patch = kept.map((r) => r.patch).join("");
  const truncated = patch.length > MAX_PATCH;
  if (truncated) patch = patch.slice(0, MAX_PATCH);
  return { files, patch, truncated, unversioned: all.length - entries.length };
}

/** What was already changed in a working copy when a turn started. content is left out past the memory budget. */
export type SvnStart = { files: Map<string, { size: number; mtimeMs: number; missing?: boolean; unversioned?: boolean; content?: string | null }> };

/** Content kept from files that were already changed at the start of a turn, in total. */
const START_BUDGET = 32 * 1024 * 1024;

export async function svnStart(dir: string): Promise<SvnStart | null> {
  const entries = await svnChangedFiles(dir);
  if (!entries) return null;
  const files: SvnStart["files"] = new Map();
  let budget = START_BUDGET;
  for (const entry of entries) {
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(path.join(dir, entry.path)); } catch { /* deleted */ }
    if (!stat?.isFile()) {
      files.set(entry.path, { size: 0, mtimeMs: 0, missing: true, content: null });
      continue;
    }
    // Unversioned files that already exist (logs a server appends to) are not the turn's
    // changes, so only their presence is noted: a new one at the end was made in the turn.
    if (entry.unversioned) {
      files.set(entry.path, { size: stat.size, mtimeMs: stat.mtimeMs, unversioned: true });
      continue;
    }
    const keep = stat.size <= MAX_SVN_FILE_BYTES && stat.size <= budget;
    if (keep) budget -= stat.size;
    files.set(entry.path, { size: stat.size, mtimeMs: stat.mtimeMs, ...(keep ? { content: readFileText(path.join(dir, entry.path)) } : {}) });
  }
  return { files };
}

/**
 * The turn's own changes: files changed since svnStart, with their content then and now.
 * `known` (the tool calls' versions) stands in for a start content that was not kept.
 */
export async function svnEnd(dir: string, start: SvnStart, known: Map<string, { before: string | null; after: string | null }>): Promise<Map<string, { before: string | null; after: string | null }>> {
  const out = new Map<string, { before: string | null; after: string | null }>();
  const entries = await svnChangedFiles(dir);
  if (!entries) return out;
  const status = new Map(entries.map((e) => [e.path, e.status]));
  const paths = [...new Set([...start.files.keys(), ...status.keys()])];
  await mapLimit(paths, 6, async (rel) => {
    const abs = path.join(dir, rel);
    let now: fs.Stats | null = null;
    try { now = fs.statSync(abs); } catch { /* deleted */ }
    if (now && (!now.isFile() || now.size > MAX_SVN_FILE_BYTES)) return;
    const was = start.files.get(rel);
    let before: string | null;
    if (was) {
      if (was.missing ? !now : now && now.size === was.size && now.mtimeMs === was.mtimeMs) return;
      // An unversioned file from before the turn counts only when an edit tool wrote it.
      if (was.unversioned && !known.has(rel)) return;
      if (was.content !== undefined) before = was.content;
      else if (known.has(rel)) before = known.get(rel)!.before;
      else return;
    } else if (status.get(rel) === "A") {
      before = null;
    } else {
      // Unchanged when the turn started, so it was the base content.
      const base = await svnBase(dir, rel);
      if (!base) return;
      before = base.toString("utf8");
    }
    const after = now ? readFileText(abs) : null;
    if (before === after || isBinary(before) || isBinary(after)) return;
    out.set(rel, { before, after });
  });
  return out;
}
