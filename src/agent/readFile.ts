import fs from "node:fs/promises";
import path from "node:path";
import { threadFilesDir } from "./attachments.js";
import type { Thread } from "./types.js";
import { skillFolders } from "./harness.js";
import { pageCheckoutDir } from "../pageCheckout.js";

export const READ_FILE_MAX_BYTES = 64 * 1024 * 1024;
export const READ_FILE_MAX_CHARS = 32_000;
/** Longer lines (minified code, logs) are cut, as Claude Code's read does, instead of refusing the page. */
export const READ_FILE_MAX_LINE_CHARS = 2_000;
export type ReadScope = Pick<Thread, "cwd" | "mode" | "approval"> & Partial<Pick<Thread, "id" | "worktree" | "provider">>;

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

async function existingRealPath(root: string): Promise<string | null> {
  try { return await fs.realpath(root); }
  catch (err) {
    if (["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) return null;
    throw err;
  }
}

async function readRoots(thread: ReadScope): Promise<Array<{ lexical: string; real: string }>> {
  const roots: Array<{ lexical: string; real: string }> = [];
  const add = async (root: string) => {
    const real = await existingRealPath(root);
    if (real) roots.push({ lexical: path.resolve(root), real });
  };
  if (thread.cwd) await add(thread.cwd);
  if (thread.id) await add(threadFilesDir(thread.id));
  if (thread.id && thread.mode === "code") await add(pageCheckoutDir(thread.id));
  // Skills are loaded from files on demand, including user/provider folders outside the workspace.
  // Grant the skills subtree only; credentials and settings next to it remain outside the scope.
  for (const folder of skillFolders(thread.cwd)) {
    if (!thread.provider || folder.providers.includes(thread.provider)) await add(folder.dir);
  }
  const wt = thread.worktree;
  if (wt && !wt.closed) {
    for (const rel of wt.links) {
      if (!rel || path.isAbsolute(rel)) continue;
      const link = path.resolve(wt.path, rel);
      const source = path.resolve(wt.repo, rel);
      if (!inside(path.resolve(wt.path), link) || !inside(path.resolve(wt.repo), source)) continue;
      const [real, expected] = await Promise.all([existingRealPath(link), existingRealPath(source)]);
      // A recorded link cannot grant an arbitrary destination after being retargeted.
      if (real && expected && path.relative(expected, real) === "") roots.push({ lexical: link, real });
    }
  }
  return roots;
}

/** Host-side gate: MCP tools run outside Codex's shell sandbox. Never trust a caller-supplied scope. */
export async function scopedReadResolver(thread: ReadScope | null) {
  if (!thread || (thread.mode === "board" && !thread.cwd)) throw new Error("File reads are unavailable in this thread's mode.");
  const full = thread.mode === "code" && thread.approval === "full";
  const roots = full ? [] : await readRoots(thread);
  return async (inputPath: unknown) => {
    if (typeof inputPath !== "string" || !inputPath.trim() || inputPath.includes("\0")) throw new Error("path must be a nonempty local file path.");
    if (!thread.cwd && !path.isAbsolute(inputPath)) throw new Error("No workspace is available for this relative file read.");
    const target = path.resolve(thread.cwd ?? process.cwd(), inputPath);
    const matching = roots.filter((root) => inside(root.lexical, target) || inside(root.real, target));
    if (!full && !matching.length) throw new Error("File read denied: path is outside the workspace scope and this thread's read roots.");
    const real = await fs.realpath(target);
    if (!full && !matching.some((root) => inside(root.real, real))) throw new Error("File read denied: link target is outside this thread's read roots.");
    return { target, real };
  };
}

export async function readScopedFile(thread: ReadScope | null, input: { path?: unknown; offset?: unknown; limit?: unknown }) {
  const resolve = await scopedReadResolver(thread);
  const { target, real } = await resolve(input.path);
  const offset = input.offset ?? 1;
  const limit = input.limit ?? 200;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 1) throw new Error("offset must be a positive line number.");
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be between 1 and 1000 lines.");
  const page = new LinePage(offset, limit);
  const stat = await fs.stat(real);
  if (stat.isDirectory()) {
    // Listing a folder saves the model a shell call just to find the file it wants.
    const entries = (await fs.readdir(real, { withFileTypes: true }))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => a.localeCompare(b));
    for (const entry of entries) page.line(entry, entry.length);
    return page.result(target, "directory");
  }
  if (!stat.isFile()) throw new Error("File reads require a regular text file or a folder.");
  if (stat.size > READ_FILE_MAX_BYTES) throw new Error("Text file exceeds the 64 MiB read limit.");
  const handle = await fs.open(real, "r");
  try {
    // Streamed, so a large file's page never holds the whole file, and a long line keeps only its shown part.
    let encoding = "utf-8";
    let decoder = new TextDecoder(encoding, { fatal: true });
    const chunk = Buffer.alloc(64 * 1024);
    let used = 0;
    let line = "";
    let length = 0;
    let pendingCR = false;
    const take = (part: string) => {
      length += part.length;
      if (page.wants() && line.length < READ_FILE_MAX_LINE_CHARS) line += part.slice(0, READ_FILE_MAX_LINE_CHARS - line.length);
    };
    const end = () => {
      page.line(line, length);
      line = "";
      length = 0;
    };
    const feed = (text: string) => {
      let i = 0;
      if (pendingCR) {
        pendingCR = false;
        if (text[0] === "\n") i = 1;
      }
      const breaks = /\r|\n/g;
      while (i < text.length) {
        breaks.lastIndex = i;
        const match = breaks.exec(text);
        if (!match) {
          take(text.slice(i));
          break;
        }
        take(text.slice(i, match.index));
        end();
        i = match.index + 1;
        if (text[match.index] === "\r") {
          if (i === text.length) pendingCR = true;
          else if (text[i] === "\n") i++;
        }
      }
    };
    const decode = (bytes?: Buffer) => {
      try { return bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode(); }
      catch { throw new Error(`File contains invalid ${encoding.toUpperCase()} text.`); }
    };
    while (used <= READ_FILE_MAX_BYTES) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      if (used === 0 && bytesRead >= 2) {
        encoding = chunk[0] === 0xff && chunk[1] === 0xfe ? "utf-16le"
          : chunk[0] === 0xfe && chunk[1] === 0xff ? "utf-16be" : "utf-8";
        decoder = new TextDecoder(encoding, { fatal: true });
      }
      used += bytesRead;
      const bytes = chunk.subarray(0, bytesRead);
      const nul = bytes.indexOf(0);
      if (encoding === "utf-8" && nul !== -1) throw new Error(`NUL byte at byte offset ${used - bytesRead + nul} (zero-based); the file may be binary or use another encoding. read_file accepts UTF-8 or BOM-marked UTF-16 text without NUL characters.`);
      const text = decode(bytes);
      if (text.includes("\0")) throw new Error(`NUL character in ${encoding.toUpperCase()} text; the file may be binary.`);
      feed(text);
    }
    if (used > READ_FILE_MAX_BYTES) throw new Error("File grew past the 64 MiB read limit during the read; retry.");
    feed(decode());
    if (length) end();
    return { ...page.result(target, "file"), encoding };
  } finally { await handle.close(); }
}

/** One page of numbered lines: offset..limit within the output cap, while every line is still counted. */
class LinePage {
  private selected: string[] = [];
  private chars = 0;
  private clipped = 0;
  private lineNo = 1;
  private next: number | null = null;
  constructor(private offset: number, private limit: number) {}

  /** Whether the line being read will be shown, so a reader keeps its text. */
  wants(): boolean {
    return this.lineNo >= this.offset && this.next === null && this.selected.length < this.limit;
  }

  /** text is at most READ_FILE_MAX_LINE_CHARS of a line that is length characters long. */
  line(text: string, length: number): void {
    if (this.lineNo >= this.offset && this.next === null) {
      if (this.selected.length >= this.limit) this.next = this.lineNo;
      else {
        const over = length - READ_FILE_MAX_LINE_CHARS;
        const numbered = `${this.lineNo}\t${over > 0 ? `${text.slice(0, READ_FILE_MAX_LINE_CHARS)}… [${over} more characters]` : text}`;
        if (this.selected.length && this.chars + numbered.length + 1 > READ_FILE_MAX_CHARS) this.next = this.lineNo;
        else {
          if (over > 0) this.clipped++;
          this.selected.push(numbered);
          this.chars += numbered.length + 1;
        }
      }
    }
    this.lineNo++;
  }

  result(target: string, kind: "file" | "directory") {
    const truncated = this.next !== null;
    const notes = [truncated ? `Continue with offset: ${this.next}.` : kind === "file" ? "End of file." : "End of listing."];
    if (this.clipped) notes.push(`${this.clipped} line(s) were cut at ${READ_FILE_MAX_LINE_CHARS} characters.`);
    return { path: target, kind, offset: this.offset, linesReturned: this.selected.length, totalLines: this.lineNo - 1,
      truncated, nextOffset: this.next, content: this.selected.join("\n"), note: notes.join(" ") };
  }
}
