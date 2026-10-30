import fs from "node:fs/promises";
import path from "node:path";
import type { Thread } from "./types.js";
import { checkPath, policyFor, type PolicyEnv } from "./access.js";
import { pathInside } from "./toolGrants.js";

export const READ_FILE_MAX_BYTES = 64 * 1024 * 1024;
export const READ_FILE_MAX_CHARS = 32_000;
/** Longer lines (minified code, logs) are cut, as Claude Code's read does, instead of refusing the page. */
export const READ_FILE_MAX_LINE_CHARS = 2_000;
export type ReadScope = Pick<Thread, "cwd" | "mode" | "approval"> & Partial<Pick<Thread, "id" | "worktree" | "provider" | "claudeAccount" | "toolGrants">>;

export type ReadOptions = {
  env?: PolicyEnv;
  /** Ask the user about a read outside the thread's read roots (real path, why); true when they allowed it. Without it such a read is refused. */
  ask?: (real: string, reason: string) => Promise<boolean>;
};

/**
 * Host-side gate: MCP tools run outside any provider sandbox. Never trust a caller-supplied scope.
 * The thread's access policy (access.ts) decides; explicit=false (entries a search walks into) never asks.
 */
export async function scopedReadResolver(thread: ReadScope | null, opts: ReadOptions = {}) {
  if (!thread || (thread.mode === "board" && !thread.cwd)) throw new Error("File reads are unavailable in this thread's mode.");
  const policy = policyFor(thread, opts.env);
  // Folders the user allowed once for this call: a search goes on into them without asking again.
  const allowedOnce: string[] = [];
  return async (inputPath: unknown, explicit = true) => {
    if (typeof inputPath !== "string" || !inputPath.trim() || inputPath.includes("\0")) throw new Error("path must be a nonempty local file path.");
    if (!policy.cwd && !path.isAbsolute(inputPath)) throw new Error("No workspace is available for this relative file read.");
    const target = path.resolve(policy.cwd ?? process.cwd(), inputPath);
    const check = checkPath(policy, inputPath, "read");
    if (check.verdict === "deny") throw new Error(`File read denied: ${check.reason}`);
    if (check.verdict === "ask" && !allowedOnce.some((root) => pathInside(root, check.real))) {
      if (!(explicit && opts.ask && (await opts.ask(check.real, check.reason)))) {
        throw new Error(`File read denied: ${check.reason}${explicit && opts.ask ? " The user did not allow it." : ""}`);
      }
      allowedOnce.push(check.real);
    }
    // Missing files fail here, as before the policy.
    const real = await fs.realpath(target);
    return { target, real };
  };
}

export async function readScopedFile(thread: ReadScope | null, input: { path?: unknown; offset?: unknown; limit?: unknown }, opts: ReadOptions = {}) {
  const resolve = await scopedReadResolver(thread, opts);
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
