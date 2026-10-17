import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./config.js";

/**
 * File pages (#654): a page that shows a file on disk and saves it back. The page's template
 * (templates/builtin/file.html) asks the board for the file; these helpers read, classify, and
 * write it. The file a page may touch is the one on its tab (Tab.file), never one the page names.
 */

/**
 * How the page shows a file. code and text share the editor; code is highlighted. A pdf is drawn
 * with pdf.js: the browser's own PDF viewer refuses to run in a page's sandboxed frame.
 */
export type FileKind = "text" | "code" | "markdown" | "json" | "html" | "image" | "pdf" | "unsupported";

export type FileInfo = {
  path: string;
  name: string;
  kind: FileKind;
  /** highlight.js language hint for code (usually the extension). */
  lang?: string;
  size: number;
  mtime: number;
  /** The bytes were dropped in and live in Scribe's data folder. */
  copy?: boolean;
  /** Why the page cannot show it, for unsupported files. */
  reason?: string;
};

export type FileText = FileInfo & {
  text: string;
  /** The file's line ending, restored on save (the editor works in \n). */
  eol: "\n" | "\r\n";
  /** The file started with a UTF-8 byte order mark, kept on save. */
  bom: boolean;
};

/** Bigger text files are not opened: a textarea gets slow well before this. */
export const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_FILE_BYTES = 64 * 1024 * 1024;
/** Open folder: stop after this many files, so a drive root does not make thousands of pages. */
export const MAX_FOLDER_FILES = 1000;
const MAX_FOLDER_DEPTH = 16;
/** Folders not worth opening as pages: version control, dependencies, build caches. */
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "__pycache__", ".venv", "venv"]);

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};
const MARKDOWN = new Set(["md", "markdown", "mdx", "mkd"]);
const JSON_EXT = new Set(["json", "jsonc", "json5", "geojson", "webmanifest", "har"]);
const HTML_EXT = new Set(["html", "htm", "xhtml"]);
/** Extensions highlight.js knows (by name or alias) that are worth highlighting. */
const CODE_EXT: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  py: "python", pyw: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", cs: "csharp", swift: "swift",
  m: "objectivec", mm: "objectivec", php: "php", pl: "perl", pm: "perl", lua: "lua", r: "r", dart: "dart",
  scala: "scala", hs: "haskell", ex: "elixir", exs: "elixir", erl: "erlang", clj: "clojure", fs: "fsharp",
  ml: "ocaml", nim: "nim", nix: "nix", jl: "julia", groovy: "groovy", gradle: "gradle", zig: "plaintext",
  css: "css", scss: "scss", sass: "scss", less: "less",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ps1: "powershell", psm1: "powershell", psd1: "powershell",
  bat: "dos", cmd: "dos", sql: "sql", graphql: "graphql", gql: "graphql", proto: "protobuf",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", properties: "properties", env: "ini",
  xml: "xml", xsd: "xml", xsl: "xml", svgz: "xml", plist: "xml", csproj: "xml", vue: "xml", svelte: "xml",
  dockerfile: "dockerfile", makefile: "makefile", mk: "makefile", cmake: "cmake", diff: "diff", patch: "diff",
  tex: "latex", vim: "vim", glsl: "glsl", hlsl: "glsl", wgsl: "glsl",
};
/** Files known by name rather than extension. */
const CODE_NAMES: Record<string, string> = {
  dockerfile: "dockerfile", makefile: "makefile", "cmakelists.txt": "cmake", ".gitignore": "plaintext",
  ".bashrc": "bash", ".zshrc": "bash", ".profile": "bash", ".editorconfig": "ini", ".npmrc": "ini",
};

function extOf(file: string): string {
  const base = path.basename(file).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

/** The kind a file's name suggests; text files without a special kind are found by sniffing. */
export function kindByName(file: string): { kind: FileKind; lang?: string } {
  const ext = extOf(file);
  const base = path.basename(file).toLowerCase();
  if (IMAGE_TYPES[ext]) return { kind: "image" };
  if (ext === "pdf") return { kind: "pdf" };
  if (MARKDOWN.has(ext)) return { kind: "markdown", lang: "markdown" };
  if (JSON_EXT.has(ext)) return { kind: "json", lang: "json" };
  if (HTML_EXT.has(ext)) return { kind: "html", lang: "xml" };
  const lang = CODE_EXT[ext] ?? CODE_NAMES[base];
  if (lang) return { kind: "code", lang };
  return { kind: "text" };
}

export function imageType(file: string): string | undefined {
  return IMAGE_TYPES[extOf(file)];
}

export function isPdfFile(file: string): boolean {
  return extOf(file) === "pdf";
}

/** Whether bytes look like text: no NUL bytes, and they decode as UTF-8 (or UTF-16 with a BOM, which we do not edit). */
export function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 64 * 1024);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(trimPartialUtf8(sample, bytes.length > sample.length));
    return true;
  } catch {
    return false;
  }
}

/** A sample cut mid-file may end inside a multi-byte character; drop that tail before decoding. */
function trimPartialUtf8(sample: Buffer, cut: boolean): Buffer {
  if (!cut) return sample;
  let end = sample.length;
  for (let back = 1; back <= 3 && end - back >= 0; back++) {
    const byte = sample[end - back];
    if ((byte & 0xc0) === 0x80) continue;
    if (byte >= 0xc0) end -= back;
    break;
  }
  return sample.subarray(0, end);
}

function statFile(file: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`file not found: ${file}`);
  }
  if (!stat.isFile()) {
    throw new Error(`not a file: ${file}`);
  }
  return stat;
}

function baseInfo(file: string, stat: fs.Stats, copy?: boolean): Omit<FileInfo, "kind"> {
  return { path: file, name: path.basename(file), size: stat.size, mtime: Math.floor(stat.mtimeMs), ...(copy ? { copy: true } : {}) };
}

/** Read a file for its page: text kinds with their text, images, PDFs, and unsupported files with just their info. */
export function readFileForPage(file: string, copy?: boolean): FileText | FileInfo {
  const stat = statFile(file);
  const info = baseInfo(file, stat, copy);
  const named = kindByName(file);
  if (named.kind === "image") {
    if (stat.size > MAX_IMAGE_FILE_BYTES) {
      return { ...info, kind: "unsupported", reason: `The image is too large to show (${formatBytes(stat.size)}).` };
    }
    return { ...info, kind: "image" };
  }
  if (named.kind === "pdf") {
    if (stat.size > MAX_IMAGE_FILE_BYTES) {
      return { ...info, kind: "unsupported", reason: `The PDF is too large to show (${formatBytes(stat.size)}).` };
    }
    return { ...info, kind: "pdf" };
  }
  if (stat.size > MAX_TEXT_FILE_BYTES) {
    return { ...info, kind: "unsupported", reason: `The file is too large to open (${formatBytes(stat.size)}, at most ${formatBytes(MAX_TEXT_FILE_BYTES)}).` };
  }
  const bytes = fs.readFileSync(file);
  if (!looksLikeText(bytes)) {
    return { ...info, kind: "unsupported", reason: "Viewing this kind of file is not supported." };
  }
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const raw = bytes.subarray(bom ? 3 : 0).toString("utf8");
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  const lf = (raw.match(/\n/g) ?? []).length - crlf;
  const eol = crlf > lf ? "\r\n" : "\n";
  return { ...info, ...named, text: raw.replace(/\r\n/g, "\n"), eol, bom };
}

/**
 * The image a markdown file links to with src: a path relative to the file's folder, an absolute
 * path, or a file: URL, without its ?query or #hash. Null when it is a web URL or not an image.
 */
export function linkedImagePath(file: string, src: string): string | null {
  let target = src.trim();
  if (!target || /^(?:https?|data|blob):/i.test(target) || target.startsWith("//")) return null;
  if (/^file:/i.test(target)) {
    try {
      target = fileURLToPath(target);
    } catch {
      return null;
    }
  } else {
    target = target.replace(/[?#].*$/, "");
    try {
      target = decodeURIComponent(target);
    } catch {
      /* a literal % */
    }
  }
  const resolved = path.isAbsolute(target) ? path.normalize(target) : path.resolve(path.dirname(file), target);
  return imageType(resolved) ? resolved : null;
}

/** An image's or PDF's bytes, for the viewer to draw. */
export function readFileBytes(file: string): { bytes: Buffer; type: string } {
  const type = imageType(file) ?? (isPdfFile(file) ? "application/pdf" : undefined);
  if (!type) throw new Error("not an image or PDF");
  const stat = statFile(file);
  if (stat.size > MAX_IMAGE_FILE_BYTES) throw new Error("file is too large");
  return { bytes: fs.readFileSync(file), type };
}

export class FileConflictError extends Error {
  constructor(readonly mtime: number) {
    super("The file changed on disk since it was opened");
  }
}

/**
 * Write a file page's text. expectedMtime: the version the page loaded; a newer one on disk is a
 * conflict unless force. Restores the file's line endings and byte order mark.
 */
export function writeFileText(
  file: string,
  text: string,
  opts: { expectedMtime?: number; force?: boolean; eol?: string; bom?: boolean; create?: boolean } = {}
): FileInfo {
  const exists = fs.existsSync(file);
  if (exists) {
    const stat = statFile(file);
    if (!opts.force && typeof opts.expectedMtime === "number" && Math.floor(stat.mtimeMs) !== opts.expectedMtime) {
      throw new FileConflictError(Math.floor(stat.mtimeMs));
    }
  } else if (!opts.create) {
    throw new Error(`file not found: ${file}`);
  } else if (!fs.existsSync(path.dirname(file))) {
    throw new Error(`folder not found: ${path.dirname(file)}`);
  }
  const body = opts.eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text;
  fs.writeFileSync(file, opts.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf8")]) : body, "utf8");
  const stat = fs.statSync(file);
  return { ...baseInfo(file, stat), ...kindByName(file) };
}

/** Where a dropped file's bytes live: Scribe's data folder, one folder per page so names never clash. */
export function copiesDir(tabId: string): string {
  if (!/^t_[a-f0-9]+$/.test(tabId)) throw new Error("bad page id");
  return path.join(dataDir(), "files", tabId);
}

export function safeFileName(name: string): string {
  const base = path.basename(String(name || "")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 180);
  return base && base !== "." && base !== ".." ? base : "file";
}

export function storeCopy(tabId: string, name: string, bytes: Buffer): string {
  const dir = copiesDir(tabId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safeFileName(name));
  fs.writeFileSync(file, bytes);
  return file;
}

export function removeCopies(tabId: string): void {
  try {
    fs.rmSync(copiesDir(tabId), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

export type FolderEntry = { kind: "dir"; name: string; path: string; children: FolderEntry[] } | { kind: "file"; name: string; path: string };

/**
 * A folder's tree for Open folder: subfolders and files, sorted, skipping hidden entries and
 * dependency or build folders. Stops at MAX_FOLDER_FILES files; truncated says so.
 */
export function scanFolder(root: string): { tree: FolderEntry & { kind: "dir" }; files: number; truncated: boolean } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    throw new Error(`folder not found: ${root}`);
  }
  if (!stat.isDirectory()) throw new Error(`not a folder: ${root}`);
  let files = 0;
  let truncated = false;
  const walk = (dir: string, depth: number): FolderEntry[] => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    const out: FolderEntry[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name.toLowerCase()) || depth >= MAX_FOLDER_DEPTH) continue;
        const children = walk(full, depth + 1);
        if (children.length) out.push({ kind: "dir", name: entry.name, path: full, children });
      } else if (entry.isFile()) {
        if (files >= MAX_FOLDER_FILES) {
          truncated = true;
          continue;
        }
        files += 1;
        out.push({ kind: "file", name: entry.name, path: full });
      }
    }
    return out;
  };
  const children = walk(root, 0);
  return { tree: { kind: "dir", name: path.basename(root) || root, path: root, children }, files, truncated };
}

/** Files and folders in one folder, for the Open file dialog. */
export function listFolder(dir: string): { path: string; parent: string; dirs: Array<{ name: string; path: string }>; files: Array<{ name: string; path: string; size: number }>; exists: boolean } {
  let abs = path.resolve(/^[A-Za-z]:$/.test(dir) ? `${dir}\\` : dir);
  // A file, or a file to be (Save as): its folder.
  if (!isDir(abs) && isDir(path.dirname(abs))) {
    abs = path.dirname(abs);
  }
  let entries: fs.Dirent[] = [];
  let exists = true;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    exists = false;
  }
  const sort = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("$"))
    .map((entry) => ({ name: entry.name, path: path.join(abs, entry.name) }))
    .sort(sort)
    .slice(0, 1000);
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const full = path.join(abs, entry.name);
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        /* unreadable */
      }
      return { name: entry.name, path: full, size };
    })
    .sort(sort)
    .slice(0, 2000);
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? "" : parent, dirs, files, exists };
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Same file, for finding a page that already has it open (Windows paths ignore case). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * What a file page stores as its HTML. The board never shows it (it serves the file viewer
 * instead); page_read and page_grep fetch the saved text through the page's file route.
 */
export function filePlaceholderHtml(name: string, file: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(name)}</title></head><body><p>File page: ${escapeHtml(file)}</p><p>Scribe shows and saves this file; read or edit the file itself.</p></body></html>`;
}

const viewerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "file-page.html");
let viewerCache: { mtime: number; html: string } | null = null;

/** The file viewer every file page runs (templates/file-page.html), reread when it changes. */
export function fileViewerHtml(): string {
  const mtime = fs.statSync(viewerPath).mtimeMs;
  if (!viewerCache || viewerCache.mtime !== mtime) {
    viewerCache = { mtime, html: fs.readFileSync(viewerPath, "utf8") };
  }
  return viewerCache.html;
}
