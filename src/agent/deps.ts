import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";

/**
 * Worktrees link node_modules from the main checkout, and nothing else installs packages when a
 * merged branch (or a hand-made commit) changes package-lock.json. These helpers notice that the
 * installed packages lag behind the lockfile and run an additive `npm install` in the main checkout.
 */

type LockEntry = { version?: string; optional?: boolean; peer?: boolean; link?: boolean; os?: unknown; cpu?: unknown };
type Lock = { packages?: Record<string, LockEntry> };

function readLock(file: string): Lock | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Lock;
  } catch {
    return null;
  }
}

/**
 * Packages package-lock.json wants that node_modules lacks or has at another version, as
 * "name@version" (or "name: missing"). Null when there is nothing to compare: no npm lockfile,
 * no node_modules, or a lockfile without a packages map (npm 6).
 */
export function dependencyDrift(repo: string): string[] | null {
  const lock = readLock(path.join(repo, "package-lock.json"));
  if (!lock?.packages || !fs.existsSync(path.join(repo, "node_modules"))) return null;
  // npm 7+ writes this hidden lockfile on every install; without it the folder was damaged or hand-made.
  const installed = readLock(path.join(repo, "node_modules", ".package-lock.json"))?.packages;
  if (!installed) return ["node_modules/.package-lock.json: missing"];
  const drift: string[] = [];
  for (const [key, want] of Object.entries(lock.packages)) {
    if (!key.startsWith("node_modules/") || want.link) continue;
    // Optional and platform-specific packages are left out on machines they do not fit.
    if (want.optional || want.peer || want.os || want.cpu) continue;
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    const have = installed[key];
    if (!have) drift.push(`${name}: missing`);
    else if (want.version && have.version && want.version !== have.version) drift.push(`${name}@${want.version} (installed ${have.version})`);
  }
  return drift;
}

function runNpmInstall(repo: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // npm is a .cmd on Windows, which execFile only runs through a shell. The arguments are fixed.
    execFile(
      "npm",
      // --no-save: only bring node_modules up to the lockfile. Rewriting package-lock.json (npm
      // drops or adds "peer" flags) left the main checkout dirty, and that blocks the next merge (#817).
      ["install", "--no-save", "--no-audit", "--no-fund"],
      { cwd: repo, shell: process.platform === "win32", windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout ?? ""}${stderr ?? ""}`.trim() })
    );
  });
}

let installing: Promise<string | null> | null = null;

/**
 * Bring the main checkout's node_modules up to its package-lock.json. Plain `npm install`, never
 * `npm ci`: the live daemon may run from this folder, so it only adds and updates packages. Returns
 * a line for the thread, or null when nothing needed doing.
 */
export function syncDependencies(repo: string): Promise<string | null> {
  if (installing) return installing.then(() => syncDependencies(repo));
  const drift = dependencyDrift(repo);
  if (!drift?.length) return Promise.resolve(null);
  const shown = drift.slice(0, 5).join(", ") + (drift.length > 5 ? `, and ${drift.length - 5} more` : "");
  log(`node_modules in ${repo} is behind package-lock.json (${shown}); running npm install`);
  installing = runNpmInstall(repo)
    .then(({ ok, output }) => {
      const left = dependencyDrift(repo) ?? [];
      if (ok && !left.length) return `node_modules in ${repo} was behind package-lock.json (${shown}), so Scribe ran npm install there.`;
      log(`npm install in ${repo} ${ok ? "left packages out" : "failed"}: ${output.split("\n").slice(-6).join(" ")}`);
      const tail = output.split("\n").filter(Boolean).slice(-3).join(" ");
      return `node_modules in ${repo} is behind package-lock.json (${shown}) and npm install there ${ok ? "did not fix it" : "failed"}${tail ? `: ${tail}` : ""}. Run npm install in ${repo}; until then builds and type checks can fail on those packages.`;
    })
    .finally(() => {
      installing = null;
    });
  return installing;
}
