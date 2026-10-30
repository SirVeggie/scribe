import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccessPolicy } from "./access.js";
import { pathInside } from "./toolGrants.js";

/**
 * Codex's MXC sandbox on Windows (#916, probes in docs/sandboxing-windows-probes-900.md). The
 * unelevated sandbox Scribe used before can't deny reads, and its "network off" only sets proxy
 * variables that Node's fetch ignores, so a sandboxed command could read Scribe's local-token and
 * call the daemon as the user. MXC denies reads by path and, with the network off, loopback too.
 *
 * MXC only takes permission profiles, so a thread gets three named profiles (reading, writing,
 * writing with the network) and each turn selects one by id. They deny the thread's protected paths
 * from the access policy (#898). The data folder is denied around the thread's own parts, entry by
 * entry, not as a whole: its worktree lives under it, and Node lstat's every parent of a script.
 */

export type WindowsSandbox = "mxc" | "unelevated";

export const MXC_PROFILES = { read: "scribe-read", write: "scribe-write", web: "scribe-web", full: ":danger-full-access" } as const;

let detected: WindowsSandbox | null = null;
let detecting: Promise<WindowsSandbox> | null = null;

function forced(): WindowsSandbox | null {
  const value = process.env.SCRIBE_CODEX_SANDBOX?.trim().toLowerCase();
  return value === "mxc" || value === "unelevated" ? value : null;
}

/** The engine found so far: null until the first check finishes (and off Windows). */
export function windowsSandbox(platform: NodeJS.Platform = process.platform): WindowsSandbox | null {
  if (platform !== "win32") return null;
  return forced() ?? detected;
}

/**
 * Whether MXC runs here: Codex's documented check (`echo MXC_OK` under `:workspace`), once per daemon.
 * Windows 10 and older 11 builds fall back to unelevated.
 */
export function detectWindowsSandbox(cli: string, env: Record<string, string>): Promise<WindowsSandbox> {
  const force = forced();
  if (force) return Promise.resolve(force);
  if (detected) return Promise.resolve(detected);
  detecting ??= new Promise<WindowsSandbox>((resolve) => {
    let out = "";
    const child = spawn(process.execPath, [cli, "sandbox", "-c", "windows.sandbox=mxc", "--permission-profile", ":workspace", "--", "cmd.exe", "/d", "/c", "echo MXC_OK"],
      { cwd: os.homedir(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => { clearTimeout(timer); resolve("unelevated"); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 && out.includes("MXC_OK") ? "mxc" : "unelevated"); });
  }).then((engine) => (detected = engine));
  return detecting;
}

/** Tests: forget the check. */
export function resetWindowsSandbox(engine: WindowsSandbox | null = null): void {
  detected = engine;
  detecting = null;
}

const CODEX_OWN = ["tmp", ".sandbox", ".sandbox-bin", ".sandbox-secrets", ".sandbox_migration", "cap_sid"];

function key(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/**
 * What to deny for one protected folder that holds paths the thread keeps: its other entries, and
 * inside an entry that holds a kept path, that entry's other entries, and so on. Entries are listed
 * now; one made later is not covered (worktrees and attachments of later threads, never secrets).
 */
function around(root: string, keep: string[], out: string[]): void {
  if (keep.some((k) => pathInside(k, root))) return;
  if (!keep.some((k) => pathInside(root, k))) {
    out.push(root);
    return;
  }
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return; }
  for (const name of names) around(path.join(root, name), keep, out);
}

/**
 * The paths a thread's profiles deny: the policy's protected paths and secrets, the data folder's
 * around the thread's own parts. Only paths that exist: MXC refuses to start a command when a denied
 * path's folder is missing (a missing file in an existing folder is fine).
 */
export function mxcDenyPaths(policy: AccessPolicy, codexHome: string): string[] {
  // Codex's own sandbox setup and the command-name aliases it puts on PATH live in its home.
  const keep = [...policy.denyExcept, ...CODEX_OWN.map((name) => path.join(codexHome, name))];
  if (policy.cwd) keep.push(policy.cwd);
  const out: string[] = [];
  for (const root of policy.deny) if (fs.existsSync(root)) around(root, keep, out);
  for (const secret of policy.secrets) if (fs.existsSync(secret)) out.push(secret);
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = key(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Codex config for a thread under MXC: the engine and its three profiles. */
export function mxcConfig(deny: string[], gitDir: string | null): Record<string, unknown> {
  const filesystem = Object.fromEntries(deny.map((p) => [p.replace(/\\/g, "/"), "deny"]));
  // Commits write the main repository's git folder.
  const roots = gitDir ? { workspace_roots: { [gitDir.replace(/\\/g, "/")]: true } } : {};
  return {
    "windows.sandbox": "mxc",
    permissions: {
      [MXC_PROFILES.read]: { extends: ":read-only", network: { enabled: false }, filesystem },
      [MXC_PROFILES.write]: { extends: ":workspace", ...roots, network: { enabled: false }, filesystem },
      [MXC_PROFILES.web]: { extends: ":workspace", ...roots, network: { enabled: true }, filesystem },
    },
  };
}

/** Which of the thread's profiles a sandbox mode selects. */
export function mxcProfile(sandbox: "read-only" | "workspace-write" | "danger-full-access", network: boolean): string {
  if (sandbox === "danger-full-access") return MXC_PROFILES.full;
  if (sandbox === "read-only") return MXC_PROFILES.read;
  return network ? MXC_PROFILES.web : MXC_PROFILES.write;
}

/** The sandbox mode a reported profile id stands for, for the effective-permissions view. */
export function profileSandbox(id: string): string | null {
  if (id === MXC_PROFILES.read || id === ":read-only") return "read-only";
  if (id === MXC_PROFILES.write || id === MXC_PROFILES.web || id === ":workspace") return "workspace-write";
  if (id === MXC_PROFILES.full) return "danger-full-access";
  return null;
}
