import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "../config.js";
import { pageCheckoutDir } from "../pageCheckout.js";
import { threadFilesDir } from "./attachments.js";
import { accountsRoot } from "./claudeAccounts.js";
import { windowsSandbox } from "./codexMxc.js";
import { skillFolders } from "./harness.js";
import { pathInside, realTarget, threadCwd } from "./toolGrants.js";
import type { ProviderId, Thread } from "./types.js";

/**
 * Which files a thread may read and write (#898, design in docs/sandboxing-design-891.md). One policy
 * per thread, computed from its settings and grants, and one check (checkPath) that every host-side
 * file gate uses: Native's file tools, read_file, file search, page_open's file. The OS sandbox
 * (#899) enforces the same policy for shells.
 *
 * Order: protected paths beat every root and grant, then the worktree's links (read-only), then the
 * roots. A path outside the roots asks the user, who can allow its folder for the thread.
 */

export type AccessOp = "read" | "write";

export type AccessPolicy = {
  /** Where relative paths resolve; null when the thread has no workspace. */
  cwd: string | null;
  /** Code mode with Full access: the roots don't apply, protected paths still do. */
  full: boolean;
  writeRoots: string[];
  /** Write roots are read roots too. */
  readRoots: string[];
  /** Protected: never read or written through Scribe's gates, whatever the roots and grants say. */
  deny: string[];
  /** Folders inside a protected one that this thread may still use: its worktree, attachments, own account, skills. */
  denyExcept: string[];
  /** Credentials inside those folders, which no exception opens. */
  secrets: string[];
  /** Real targets of the worktree's links (node_modules in the main checkout): readable, never writable. */
  readOnly: string[];
};

export type PathCheck =
  | { verdict: "allow"; real: string }
  | { verdict: "ask"; real: string; reason: string }
  | { verdict: "deny"; real: string | null; reason: string };

type PolicyThread = Pick<Thread, "cwd" | "mode" | "approval"> & Partial<Pick<Thread, "id" | "worktree" | "provider" | "claudeAccount" | "toolGrants">>;

export type PolicyEnv = {
  /** The user's extra protected paths (prefs.protectedPaths). */
  protectedPaths?: string[];
  /** Where a thread without a workspace runs (the host's scratch folder); usable, though inside Scribe's data. */
  scratchDir?: string;
  home?: string;
  data?: string;
  /** The temp folder as a write root: for sandboxed shells (#899). Scribe's own file gates leave it out, so a write there asks. */
  tmp?: string;
};

/** Credentials and private data under the home folder, as relative paths (both separators work). */
const HOME_SECRETS = [
  ".ssh", ".gnupg", ".password-store", ".aws", ".azure", ".kube", ".docker/config.json",
  ".config/gcloud", "AppData/Roaming/gcloud",
  ".config/gh", "AppData/Roaming/GitHub CLI",
  ".npmrc", ".yarnrc", ".pypirc", ".netrc", "_netrc", ".git-credentials", ".config/git/credentials",
  ".claude/.credentials.json", ".claude.json", ".codex/auth.json",
  // Browser profiles: cookies, saved passwords and session tokens.
  "AppData/Local/Google/Chrome/User Data", "AppData/Local/Microsoft/Edge/User Data",
  "AppData/Local/BraveSoftware/Brave-Browser/User Data", "AppData/Roaming/Mozilla/Firefox", "AppData/Roaming/Opera Software",
  ".config/google-chrome", ".config/chromium", ".config/microsoft-edge", ".config/BraveSoftware", ".mozilla",
  "Library/Application Support/Google/Chrome", "Library/Application Support/Microsoft Edge",
  "Library/Application Support/BraveSoftware", "Library/Application Support/Firefox", "Library/Keychains", "Library/Cookies",
  // Windows' own credential and key stores.
  "AppData/Roaming/Microsoft/Credentials", "AppData/Local/Microsoft/Credentials", "AppData/Roaming/Microsoft/Protect",
];

/** A path in both forms a check can meet it in: as written (resolved) and through its links. */
function forms(p: string): string[] {
  const lexical = path.resolve(p);
  try {
    const real = fs.realpathSync.native(lexical);
    return real === lexical ? [lexical] : [lexical, real];
  } catch {
    return [lexical];
  }
}

/** Existing folders as real paths; missing ones are dropped (they grant nothing). */
function existing(p: string): string | null {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

function uniq(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const key = process.platform === "win32" ? p.toLowerCase() : p;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inAny(roots: string[], target: string): boolean {
  return roots.some((root) => pathInside(root, target));
}

/** The real targets of a worktree's recorded links, when they still point where they should. */
function linkTargets(wt: NonNullable<Thread["worktree"]>): string[] {
  const out: string[] = [];
  for (const rel of wt.links) {
    if (!rel || path.isAbsolute(rel)) continue;
    const link = path.resolve(wt.path, rel);
    const source = path.resolve(wt.repo, rel);
    if (!pathInside(path.resolve(wt.path), link) || !pathInside(path.resolve(wt.repo), source)) continue;
    const real = existing(link);
    const expected = existing(source);
    // A recorded link cannot grant an arbitrary destination after being retargeted.
    if (real && expected && path.relative(expected, real) === "") out.push(real);
  }
  return out;
}

/** The thread's access policy. Reads the filesystem only to resolve links; keeps no state. */
export function policyFor(thread: PolicyThread, env: PolicyEnv = {}): AccessPolicy {
  const home = env.home ?? os.homedir();
  const data = env.data ?? dataDir();
  const cwd = threadCwd(thread);
  const wt = thread.worktree && !thread.worktree.closed ? thread.worktree : null;
  const realCwd = cwd ? existing(cwd) : null;

  const grants = (thread.toolGrants ?? []).filter((g) => g.kind !== "command") as Array<{ kind: "file" | "folder"; path: string; access: "read" | "write" }>;
  const links = wt ? linkTargets(wt) : [];
  const writeRoots = [
    realCwd,
    env.tmp ? existing(env.tmp) : null,
    // Commits write the main repository's git folder.
    wt ? existing(path.join(wt.repo, ".git")) : null,
    ...grants.filter((g) => g.access === "write").map((g) => g.path),
  ].filter((p): p is string => Boolean(p));

  const own = thread.provider === "claude" && thread.claudeAccount && thread.claudeAccount !== "default" && /^[\w-]+$/.test(thread.claudeAccount)
    ? path.join(accountsRoot(data), thread.claudeAccount) : null;
  const skills = skillFolders(thread.cwd, home, data).filter((f) => !thread.provider || f.providers.includes(thread.provider)).map((f) => f.dir);
  const attachments = thread.id ? threadFilesDir(thread.id) : null;
  const checkout = thread.id && thread.mode === "code" ? pageCheckoutDir(thread.id) : null;
  const readExtra = [
    ...links,
    attachments,
    checkout,
    // Skills are loaded from files on demand, including user/provider folders outside the workspace.
    ...skills,
    own,
    ...grants.map((g) => g.path),
  ].filter((p): p is string => Boolean(p)).map(existing).filter((p): p is string => Boolean(p));

  // Scribe's data folder holds the local token, the databases, every thread's worktree and attachments
  // and every account's login. The thread keeps its own parts of it.
  // Its workspace there is one of Scribe's worktrees, or the scratch folder of a thread without one.
  const cwdIsScribes = Boolean(cwd && (pathInside(path.join(path.resolve(data), "worktrees"), path.resolve(cwd)) && path.resolve(cwd) !== path.join(path.resolve(data), "worktrees")
    || (env.scratchDir && path.resolve(cwd) === path.resolve(env.scratchDir))));
  const denyExcept = [cwdIsScribes ? cwd : null, attachments, checkout, own, ...skills].filter((p): p is string => Boolean(p));
  const userPaths = (env.protectedPaths ?? []).filter((p) => path.isAbsolute(p));
  return {
    cwd,
    full: thread.mode === "code" && thread.approval === "full",
    writeRoots: uniq(writeRoots),
    readRoots: uniq([...writeRoots, ...readExtra]),
    // Other threads' page checkouts are in the temp folder.
    deny: uniq([data, path.resolve(pageCheckoutDir(""), "..", ".."), ...HOME_SECRETS.map((rel) => path.join(home, rel)), ...userPaths].flatMap(forms)),
    denyExcept: uniq(denyExcept.flatMap(forms)),
    secrets: uniq([own ? path.join(own, ".credentials.json") : null, own ? path.join(own, ".claude.json") : null].filter((p): p is string => Boolean(p)).flatMap(forms)),
    readOnly: uniq(links),
  };
}

/** An existing path without '..' resolves in one call; anything else goes part by part (realTarget). */
function fastReal(lexical: string, file: string): string | null {
  if (file.split(/[\\/]/).includes("..")) return null;
  if (process.platform === "win32" && /^[a-z]:($|[^\\/])/i.test(file)) return null;
  try { return fs.realpathSync.native(lexical); } catch { return null; }
}

/**
 * Whether the thread may read or write this path: allow, ask the user, or deny. Resolves each link
 * and junction before '..', so neither hides an escape; a path that cannot be resolved is denied.
 */
export function checkPath(policy: AccessPolicy, file: string, op: AccessOp): PathCheck {
  if (typeof file !== "string" || !file.trim() || file.includes("\0")) return { verdict: "deny", real: null, reason: "Not a usable file path." };
  if (!policy.cwd && !path.isAbsolute(file)) return { verdict: "deny", real: null, reason: "No workspace is available for a relative path." };
  const base = policy.cwd ?? path.parse(file).root;
  const lexical = path.resolve(base, file);
  const real = fastReal(lexical, file) ?? realTarget(base, file);
  if (!real) return { verdict: "deny", real: null, reason: `Cannot resolve ${file} (a broken link, or a drive-relative path).` };
  const protectedForm = (p: string) => inAny(policy.secrets, p) || (inAny(policy.deny, p) && !inAny(policy.denyExcept, p));
  if (protectedForm(real) || protectedForm(lexical)) {
    return { verdict: "deny", real, reason: `${real} is protected: Scribe never lets agents ${op} it, even with a grant. The user can do it themselves.` };
  }
  if (op === "write" && inAny(policy.readOnly, real)) {
    return { verdict: "deny", real, reason: `${real} is linked into this worktree from the main checkout: read it, but don't change it from here.` };
  }
  if (policy.full || inAny(op === "write" ? policy.writeRoots : policy.readRoots, real)) return { verdict: "allow", real };
  const where = op === "write" ? "the workspace and this thread's write folders" : "the workspace and this thread's read folders";
  // Through a link inside the workspace (a junction to elsewhere), say so: the path alone looks inside.
  if (inAny(op === "write" ? policy.writeRoots : policy.readRoots, lexical)) return { verdict: "ask", real, reason: `${file} goes through a link: its link target ${real} is outside ${where}.` };
  return { verdict: "ask", real, reason: `${real} is outside ${where}.` };
}

/** How each rule is enforced for a provider, for the effective-permissions view (#277). */
export type Enforcement = "os" | "scribe" | "approval" | "none";

export function effective(provider: ProviderId, platform: NodeJS.Platform = process.platform): Array<{ surface: string; enforced: Enforcement }> {
  // The OS sandbox for the shells Scribe spawns (#899); Windows waits for #900.
  const shell: Enforcement = platform === "linux" ? "os" : "approval";
  const rows: Array<{ surface: string; enforced: Enforcement }> = [
    { surface: "Scribe's read_file, file search and page_open", enforced: "scribe" },
  ];
  if (provider === "pi") rows.push({ surface: "Native read, edit and write", enforced: "scribe" }, { surface: "Native shell", enforced: shell });
  // Codex's own sandbox: MXC on Windows denies protected reads (#916); the unelevated fallback can't.
  const codexReads: Enforcement = windowsSandbox(platform) === "mxc" ? "os" : "none";
  if (provider === "codex") rows.push({ surface: "Codex shell and edits (writes)", enforced: "os" }, { surface: "Codex reads", enforced: codexReads });
  if (provider === "claude") rows.push({ surface: "Claude file tools", enforced: "approval" }, { surface: "Claude shell", enforced: shell });
  if (provider === "cursor") rows.push({ surface: "Cursor built-in file tools", enforced: "none" }, { surface: "Cursor host shell", enforced: shell });
  return rows;
}

/** The user's protected paths: absolute, one line, no duplicates. */
export function cleanProtectedPaths(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const p = raw.trim();
    if (!p || p.length > 1000 || /[\r\n\0]/.test(p) || !path.isAbsolute(p)) continue;
    out.add(path.resolve(p));
  }
  return [...out].slice(0, 200);
}
