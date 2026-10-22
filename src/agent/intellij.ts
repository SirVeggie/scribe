import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { diffTrees } from "./git.js";

export type IntelliJSettings = { enabled: boolean; launcher: string };
export const DEFAULT_INTELLIJ: IntelliJSettings = { enabled: false, launcher: "" };
const run = promisify(execFile);

export function intellijSettings(value: unknown): IntelliJSettings {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { enabled: v.enabled === true, launcher: typeof v.launcher === "string" ? v.launcher.trim() : "" };
}

/** No command templates or shell: paths and position arguments remain literal. */
export function launchIntelliJ(launcher: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, args, { shell: false, windowsHide: true, detached: true, stdio: "ignore" });
    child.once("error", () => reject(new Error("Could not launch IntelliJ. Set its executable path in Settings → Integrations.")));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function intellijLauncher(configured: string): Promise<string> {
  if (configured) return configured;
  const executable = process.platform === "win32" ? "idea64.exe" : "idea";
  const candidates = (process.env.PATH || "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, executable));
  if (process.platform === "darwin") candidates.push("/Applications/IntelliJ IDEA.app/Contents/MacOS/idea", "/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea");
  if (process.platform === "win32") {
    const roots = [process.env.ProgramFiles && path.join(process.env.ProgramFiles, "JetBrains"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")].filter((v): v is string => !!v);
    for (const root of roots) {
      const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const dir of dirs.filter(d => d.isDirectory() && /intellij|idea/i.test(d.name)).sort((a, b) => b.name.localeCompare(a.name))) {
        candidates.push(path.join(root, dir.name, "bin", executable));
      }
    }
  }
  for (const candidate of candidates) {
    if (await fs.stat(candidate).then(s => s.isFile(), () => false)) return candidate;
  }
  throw new Error("IntelliJ launcher not found. Set its executable path in Settings → Integrations.");
}

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel);
}

export async function intellijFileArgs(repo: string, file: string, line: unknown, column: unknown): Promise<string[]> {
  const root = await fs.realpath(repo);
  const target = path.resolve(root, file);
  if (!inside(root, target)) throw new Error("Choose a file inside this workspace.");
  const real = await fs.realpath(target).catch(() => { throw new Error("This file no longer exists in the working copy."); });
  if (!inside(root, real) || !(await fs.stat(real)).isFile()) throw new Error("Choose a file inside this workspace.");
  const position = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : 1;
  return ["--line", String(position(line)), "--column", String(position(column)), target];
}

/** Compare complete blobs, never the possibly truncated patch shown in the chat. */
export async function intellijDiffArgs(repo: string, from: string, to: string, file: string, exportRoot = path.join(os.tmpdir(), "scribe-intellij")): Promise<string[]> {
  if (![from, to].every(id => /^[0-9a-f]{40,64}$/.test(id))) throw new Error("This diff has no saved snapshots to compare.");
  const change = (await diffTrees(repo, from, to)).find(f => f.path === file);
  if (!change) throw new Error("This file is not part of the selected diff.");
  const blob = async (tree: string, name: string) => {
    try {
      const result = await run("git", ["cat-file", "blob", `${tree}:${name}`], { cwd: repo, encoding: "buffer", windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
      return result.stdout;
    } catch { throw new Error("The saved file content is unavailable or too large to open in IntelliJ."); }
  };
  const [before, after] = await Promise.all([
    change.status === "A" ? Buffer.alloc(0) : blob(from, change.oldPath || file),
    change.status === "D" ? Buffer.alloc(0) : blob(to, file),
  ]);
  await fs.mkdir(exportRoot, { recursive: true });
  // Retain exports for a week: the launcher can exit while its diff stays open.
  const old = await fs.readdir(exportRoot, { withFileTypes: true });
  for (const entry of old.filter(e => e.isDirectory() && /^diff-[A-Za-z0-9]+$/.test(e.name))) {
    const dir = path.join(exportRoot, entry.name);
    const stat = await fs.lstat(dir).catch(() => null);
    if (stat && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs > 7 * 86400000) await fs.rm(dir, { recursive: true, force: true });
  }
  const dir = await fs.mkdtemp(path.join(exportRoot, "diff-"));
  const name = path.basename(file.replaceAll("\\", "/"));
  const left = path.join(dir, "before", name), right = path.join(dir, "after", name);
  await fs.mkdir(path.dirname(left));
  await fs.mkdir(path.dirname(right));
  await Promise.all([fs.writeFile(left, before), fs.writeFile(right, after)]);
  return ["diff", left, right];
}
