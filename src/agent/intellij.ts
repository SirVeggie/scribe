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
  // Without a project, IntelliJ opens the file in whichever window was focused last. If that
  // project does not contain the file, it shows as a non-project file: full path, tinted tab,
  // plain highlighting. Naming the file's IntelliJ project first opens (or focuses) that one.
  const project = await intellijProject(root, path.dirname(target));
  return [...(project ? [project] : []), "--line", String(position(line)), "--column", String(position(column)), target];
}

/**
 * The IntelliJ project for a file: folders with an .idea from dir up to the workspace root.
 * A nested module can have its own .idea (trunk\1_Code\11_Source inside trunk), so prefer
 * one IntelliJ has open (the deepest, if several), else the outermost.
 */
export async function intellijProject(root: string, dir: string, open?: Set<string>): Promise<string | null> {
  const found: string[] = [];
  for (let current = dir; ; current = path.dirname(current)) {
    if (await fs.stat(path.join(current, ".idea")).then(s => s.isDirectory(), () => false)) found.push(current);
    if (!inside(root, current)) break;
  }
  if (!found.length) return null;
  const opened = open ?? await openIntelliJProjects();
  return found.find(p => opened.has(projectKey(p))) ?? found[found.length - 1];
}

const projectKey = (p: string) => {
  const normal = path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin" ? normal.toLowerCase() : normal;
};

/** IntelliJ's own config folders (one per product and version). */
function jetbrainsConfigRoot(): string | null {
  if (process.platform === "win32") return process.env.APPDATA ? path.join(process.env.APPDATA, "JetBrains") : null;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "JetBrains");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "JetBrains");
}

/** Projects IntelliJ has open, from each installed version's recentProjects.xml. */
export async function openIntelliJProjects(configRoot = jetbrainsConfigRoot()): Promise<Set<string>> {
  const open = new Set<string>();
  if (!configRoot) return open;
  const products = await fs.readdir(configRoot, { withFileTypes: true }).catch(() => []);
  for (const product of products.filter(d => d.isDirectory())) {
    const xml = await fs.readFile(path.join(configRoot, product.name, "options", "recentProjects.xml"), "utf8").catch(() => "");
    for (const m of xml.matchAll(/<entry key="([^"]+)">\s*<value>\s*<RecentProjectMetaInfo\b([^>]*)>/g)) {
      if (!/\bopened="true"/.test(m[2])) continue;
      open.add(projectKey(m[1].replace("$USER_HOME$", os.homedir()).replaceAll("&amp;", "&")));
    }
  }
  return open;
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
  return intellijExportDiff(file, before, after, exportRoot);
}

/** Writes both versions to temporary files named like the original, for IntelliJ's diff command. */
export async function intellijExportDiff(file: string, before: Buffer, after: Buffer, exportRoot = path.join(os.tmpdir(), "scribe-intellij")): Promise<string[]> {
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
