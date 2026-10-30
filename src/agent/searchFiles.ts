import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { scopedReadResolver, READ_FILE_MAX_BYTES, type ReadOptions, type ReadScope } from "./readFile.js";

type SearchInput = { path?: unknown; glob?: unknown; includeHidden?: unknown; offset?: unknown; limit?: unknown;
  pattern?: unknown; fixedStrings?: unknown; ignoreCase?: unknown };

/** Codex ships rg on every supported platform; don't depend on the daemon's PATH. */
export function ripgrepPath(): string {
  const require = createRequire(import.meta.url);
  const platform = process.platform === "android" ? "linux" : process.platform;
  const suffix = platform === "win32" ? "pc-windows-msvc" : platform === "darwin" ? "apple-darwin" : "unknown-linux-musl";
  const triple = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${suffix}`;
  let root: string;
  try { root = path.dirname(require.resolve(`@openai/codex-${platform}-${process.arch}/package.json`)); }
  catch { root = path.dirname(path.dirname(require.resolve("@openai/codex/bin/codex.js"))); }
  return path.join(root, "vendor", triple, "codex-path", platform === "win32" ? "rg.exe" : "rg");
}

function rg(args: string[], cwd: string, onLine?: (line: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ripgrepPath(), args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", stderr = "", stopped = false;
    let problem: Error | null = null;
    const stop = (err?: Error) => { stopped = true; problem = err ?? null; child.kill(); };
    const timer = setTimeout(() => stop(new Error("File search timed out; narrow path/glob.")), 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => { stderr = (stderr + text).slice(0, 4000); });
    child.stdout.on("data", (text: string) => {
      if (stopped) return;
      output += text;
      if (output.length > 4 * 1024 * 1024) { stop(new Error("Search output is too large; narrow path/glob/pattern.")); return; }
      if (onLine) {
        let newline: number;
        while ((newline = output.indexOf("\n")) >= 0) {
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          try { if (line && !onLine(line)) { stop(); return; } }
          catch (err) { stop(err as Error); return; }
        }
      }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (problem) reject(problem);
      else if (!stopped && code !== 0 && code !== 1) reject(new Error(`File search failed: ${stderr.trim() || `exit ${code}`}`));
      else resolve(output);
    });
  });
}

/** Enumerate only checked paths. Never ask rg to follow a directory link on its own. */
export async function searchScopedFiles(thread: ReadScope | null, input: SearchInput, grep: boolean, opts: ReadOptions = {}) {
  const resolve = await scopedReadResolver(thread, opts);
  const start = await resolve(input.path ?? ".");
  const offset = input.offset ?? 1, limit = input.limit ?? 200;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 1 || offset > 10_000) throw new Error("offset must be between 1 and 10000.");
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be between 1 and 1000.");
  if (input.glob !== undefined && (typeof input.glob !== "string" || !input.glob || input.glob.length > 1000)) throw new Error("glob must be a nonempty glob of at most 1000 characters.");
  for (const key of ["includeHidden", "fixedStrings", "ignoreCase"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error(`${key} must be a boolean.`);
  }
  if (grep && (typeof input.pattern !== "string" || !input.pattern || input.pattern.length > 1000)) throw new Error("pattern must be nonempty and at most 1000 characters.");
  const files: string[] = [], seen = new Set<string>();
  const deadline = Date.now() + 30_000;
  let entries = 0, skipped = 0;
  const walk = async (target: string, explicit = false): Promise<void> => {
    if (++entries > 20_000 || Date.now() > deadline) throw new Error("Search scope is too large; narrow path to a subfolder.");
    let checked: Awaited<ReturnType<typeof resolve>>;
    try { checked = await resolve(target, explicit); }
    catch (err) {
      if (!explicit && /File read denied|ENOENT|ENOTDIR/.test((err as Error).message)) { skipped++; return; }
      throw err;
    }
    const stat = await fs.stat(checked.real);
    if (stat.isDirectory()) {
      if (seen.has(checked.real)) return;
      seen.add(checked.real);
      for (const name of (await fs.readdir(checked.real)).sort()) {
        if (name === ".git" || name === "node_modules" || (!input.includeHidden && name.startsWith("."))) continue;
        await walk(path.join(target, name));
      }
    } else if (stat.isFile() && (!grep || stat.size <= READ_FILE_MAX_BYTES)) files.push(target);
    else skipped++;
  };
  await walk(start.target, true);
  const cwd = (await fs.stat(start.real)).isDirectory() ? start.target : path.dirname(start.target);
  const candidates = files.filter(file => {
    if (!input.glob) return true;
    const glob = input.glob as string;
    const negate = glob.startsWith("!");
    const pattern = negate ? glob.slice(1) : glob;
    const relative = path.relative(cwd, file).split(path.sep).join("/");
    const matches = path.posix.matchesGlob(pattern.includes("/") ? relative : path.basename(file), pattern);
    return negate ? !matches : matches;
  });
  const rows: unknown[] = [];
  let chars = 0, count = 0, truncated = false;
  const take = (row: unknown) => {
    count++;
    if (count < offset) return true;
    const size = JSON.stringify(row).length;
    if (rows.length >= limit || chars + size > 32_000) { truncated = true; return false; }
    rows.push(row); chars += size;
    return true;
  };
  if (!grep) {
    for (const file of candidates) {
      await resolve(file, false);
      if (!take({ path: file })) break;
    }
  } else {
    for (let i = 0; i < candidates.length; i += 40) {
      if (Date.now() > deadline) throw new Error("Search timed out; narrow path to a subfolder.");
      // Recheck just before passing individual files to rg, including links retargeted during traversal.
      const batch: string[] = [];
      for (const file of candidates.slice(i, i + 40)) { await resolve(file, false); batch.push(path.relative(cwd, file)); }
      await rg(["--no-config", "--json", "--sort", "path", "--hidden", "--no-ignore", "--max-count", String(offset + limit),
        ...(input.fixedStrings ? ["--fixed-strings"] : []), ...(input.ignoreCase ? ["--ignore-case"] : []),
        "--regexp", input.pattern as string, "--", ...batch], cwd, (line) => {
        const event = JSON.parse(line);
        if (event.type !== "match" || typeof event.data.path.text !== "string" || typeof event.data.lines.text !== "string") return true;
        return take({ path: path.resolve(cwd, event.data.path.text), line: event.data.line_number,
          text: event.data.lines.text.replace(/[\r\n]+$/, "").slice(0, 2000) });
      });
      if (truncated) break;
    }
  }
  return { path: start.target, offset, results: rows, truncated, nextOffset: truncated ? offset + rows.length : null,
    skipped, note: "Recursive search skips .git and node_modules unless targeted directly; hidden entries require includeHidden. Ignores are otherwise disabled. Binary files are skipped by grep. Narrow path/glob for large searches." };
}
