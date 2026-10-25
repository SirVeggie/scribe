import fs from "node:fs";
import path from "node:path";
import type { ApprovalOption, ProviderId, Thread, ToolGrant } from "./types.js";
import type { ApprovalRequest } from "./providers/provider.js";

/**
 * Scribe's own lasting answers to tool asks (#743), for every provider: a file or a folder the
 * thread may read or edit without asking again, and commands it may run (by their first words, or
 * all of them). The host adds these options to an ask, keeps the grant on the thread, and answers
 * later asks it covers with the provider's own "allow once". Commands can also go on the user's
 * allowlist (prefs.commandAllowlist), which every thread uses.
 */

/** Option ids the host adds; the provider never sees them. */
export const GRANT_OPTION = {
  file: "scribe:file",
  folder: "scribe:folder",
  readFolder: "scribe:read-folder",
  command: "scribe:command",
  allCommands: "scribe:all-commands",
  alwaysCommand: "scribe:always-command",
} as const;

/** Providers whose commands Scribe runs itself (Native's tools, Cursor's host shell): only their asks get command grants. */
const SCRIBE_SHELLS: ProviderId[] = ["pi", "cursor"];

/** Operators that chain, pipe, redirect or substitute: a command with any of them is never matched by its first words. */
const CONTROL = /[;&|`<>\r\n]|\$\(/;

/** Resolve new file targets through their nearest existing parent, including junctions. */
function writeRealPath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // A dangling link is not a new file: its destination is unknown, so ask the user.
    try { fs.lstatSync(target); throw new Error("Unresolved file link"); }
    catch (statErr) { if ((statErr as NodeJS.ErrnoException).code !== "ENOENT") throw statErr; }
    const parent = path.dirname(target);
    if (parent === target) throw err;
    return path.join(writeRealPath(parent), path.basename(target));
  }
}

/**
 * A file target as its real path, resolving each link before '..' so lexical normalization cannot
 * hide an escape. Null when it cannot be resolved; that never grants anything.
 */
export function realTarget(cwd: string, file: string): string | null {
  if (typeof file !== "string" || !file.trim() || file.includes("\0")) return null;
  // Drive-relative Windows paths depend on process state, not the thread's cwd.
  if (process.platform === "win32" && /^[a-z]:($|[^\\/])/i.test(file)) return null;
  try {
    const inputRoot = path.parse(file).root;
    let target = fs.realpathSync.native(inputRoot ? path.resolve(cwd, inputRoot) : cwd);
    for (const part of file.slice(inputRoot.length).split(process.platform === "win32" ? /[\\/]/ : /\//)) {
      if (!part || part === ".") continue;
      target = part === ".." ? path.dirname(target) : writeRealPath(path.join(target, part));
    }
    return target;
  } catch {
    return null;
  }
}

/** Whether target is root or inside it (both real paths). */
export function pathInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** What an ask needs on its paths: write for edits, deletes and moves, read for reads and searches. */
function accessFor(req: ApprovalRequest): "read" | "write" | null {
  if (req.access) return req.access;
  if (req.tool === "edit" || req.tool === "delete" || req.tool === "move") return "write";
  if (req.tool === "read" || req.tool === "search") return "read";
  return null;
}

/** The folder the thread works in: its open worktree, else its workspace. */
export function threadCwd(t: Pick<Thread, "worktree" | "cwd">): string | null {
  return t.worktree && !t.worktree.closed ? t.worktree.path : t.cwd;
}

/** The ask's paths as real paths; null when it has none or one does not resolve. */
function targets(t: Thread, req: ApprovalRequest): string[] | null {
  const cwd = threadCwd(t);
  if (!cwd || !req.paths?.length) return null;
  const out: string[] = [];
  for (const file of req.paths) {
    const real = realTarget(cwd, file);
    if (!real) return null;
    out.push(real);
  }
  return out;
}

function words(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * The words a command grant names: the program, and its subcommand when the second word is a plain
 * word ("git status", "npm test", "ls"). Null for a chained, piped or redirected command, which only
 * "all commands" covers.
 */
export function commandKey(command: string): string | null {
  if (!command.trim() || CONTROL.test(command)) return null;
  const [first, second] = words(command);
  if (!first || !/^[\w.:\\/~+-]+$/.test(first)) return null;
  return second && /^[a-z][\w-]*$/i.test(second) ? `${first} ${second}` : first;
}

/** Whether a command grant (its words; "" for every command) covers this command. */
export function commandAllowed(key: string, command: string): boolean {
  if (key === "") return true;
  if (!command.trim() || CONTROL.test(command)) return false;
  const want = words(key);
  const have = words(command);
  return want.length <= have.length && want.every((word, i) => (process.platform === "win32" ? word.toLowerCase() === have[i].toLowerCase() : word === have[i]));
}

/** Whether Scribe's grants answer this ask without the user: the thread's own, or the command allowlist. */
export function grantAllows(t: Thread, req: ApprovalRequest, allowlist: string[]): boolean {
  if (req.humanOnly || req.boardTool || t.noTools) return false;
  const access = accessFor(req);
  if (access) {
    const files = (t.toolGrants ?? []).filter((g): g is Extract<ToolGrant, { kind: "file" | "folder" }> => g.kind !== "command" && (access === "read" || g.access === "write"));
    if (!files.length) return false;
    const real = targets(t, req);
    return Boolean(real?.every((target) => files.some((g) => (g.kind === "file" ? samePath(g.path, target) : pathInside(g.path, target)))));
  }
  if (req.tool === "execute" && SCRIBE_SHELLS.includes(t.provider) && typeof req.command === "string") {
    const command = req.command;
    return (t.toolGrants ?? []).some((g) => g.kind === "command" && commandAllowed(g.key, command)) || allowlist.some((key) => commandAllowed(key, command));
  }
  return false;
}

function shortDir(dir: string, cwd: string | null): string {
  if (cwd) {
    try {
      const root = fs.realpathSync.native(cwd);
      if (pathInside(root, dir)) return path.relative(root, dir) || path.basename(dir) || dir;
    } catch { /* show it whole */ }
  }
  return dir;
}

/** The folder a folder grant names: the deepest folder holding every target (a target that is a folder counts as itself). */
function commonFolder(real: string[]): string | null {
  const dirs = real.map((target) => {
    try { if (fs.statSync(target).isDirectory()) return target; } catch { /* a new file */ }
    return path.dirname(target);
  });
  let dir = dirs[0];
  while (!dirs.every((d) => pathInside(dir, d))) {
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  // A drive or filesystem root is not offered: that is everything.
  return path.dirname(dir) === dir ? null : dir;
}

/** The lasting options Scribe adds to an ask, between the provider's allow and deny options. */
export function grantOptions(t: Thread, req: ApprovalRequest): ApprovalOption[] {
  if (req.humanOnly || req.boardTool || t.noTools || !req.options.some((o) => o.kind === "allow_once")) return [];
  const access = accessFor(req);
  if (access) {
    const real = targets(t, req);
    if (!real) return [];
    const folder = commonFolder(real);
    const name = folder ? shortDir(folder, threadCwd(t)) : null;
    if (access === "read") {
      return folder ? [{ id: GRANT_OPTION.readFolder, label: `Allow reading ${name} for this thread`, description: folder, kind: "allow_always" }] : [];
    }
    return [
      { id: GRANT_OPTION.file, label: real.length === 1 ? "Allow this file for this thread" : "Allow these files for this thread", kind: "allow_always" },
      ...(folder ? [{ id: GRANT_OPTION.folder, label: `Allow edits in ${name} for this thread`, description: folder, kind: "allow_always" as const }] : []),
    ];
  }
  if (req.tool === "execute" && SCRIBE_SHELLS.includes(t.provider) && typeof req.command === "string") {
    const key = commandKey(req.command);
    return [
      ...(key ? [{ id: GRANT_OPTION.command, label: `Allow “${key}” for this thread`, kind: "allow_always" as const }] : []),
      { id: GRANT_OPTION.allCommands, label: "Allow all commands for this thread", kind: "allow_always" },
      ...(key ? [{ id: GRANT_OPTION.alwaysCommand, label: `Always allow “${key}”`, description: "In every thread. Remove it under Allowlists.", kind: "allow_always" as const }] : []),
    ];
  }
  return [];
}

/** An ask's options with Scribe's grant options added after the provider's allow options. */
export function withGrantOptions(options: ApprovalOption[], extra: ApprovalOption[]): ApprovalOption[] {
  if (!extra.length) return options;
  const at = options.findIndex((o) => o.kind.startsWith("reject"));
  return at < 0 ? [...options, ...extra] : [...options.slice(0, at), ...extra, ...options.slice(at)];
}

/** What picking one of Scribe's grant options records: grants for the thread, or a command for the allowlist. */
export function grantFor(t: Thread, req: ApprovalRequest, optionId: string): { grants: ToolGrant[] } | { allowlist: string } | null {
  if (optionId === GRANT_OPTION.file || optionId === GRANT_OPTION.folder || optionId === GRANT_OPTION.readFolder) {
    const real = targets(t, req);
    if (!real) return null;
    if (optionId === GRANT_OPTION.file) return { grants: real.map((p) => ({ kind: "file", path: p, access: "write" })) };
    const folder = commonFolder(real);
    return folder ? { grants: [{ kind: "folder", path: folder, access: optionId === GRANT_OPTION.folder ? "write" : "read" }] } : null;
  }
  if (typeof req.command !== "string") return null;
  if (optionId === GRANT_OPTION.allCommands) return { grants: [{ kind: "command", key: "" }] };
  const key = commandKey(req.command);
  if (!key) return null;
  if (optionId === GRANT_OPTION.command) return { grants: [{ kind: "command", key }] };
  if (optionId === GRANT_OPTION.alwaysCommand) return { allowlist: key };
  return null;
}

/** A grant's key, for the thread's permissions menu and a revoke. */
export function toolGrantKey(g: ToolGrant): string {
  return g.kind === "command" ? `tools:command:${g.key}` : `tools:${g.kind}:${g.access}:${g.path}`;
}

/** A grant as the permissions menu lists it. */
export function toolGrantLabel(g: ToolGrant): string {
  if (g.kind === "command") return g.key ? `Run “${g.key}”` : "Run any command";
  if (g.kind === "file") return `Edit ${g.path}`;
  return g.access === "write" ? `Edit in ${g.path}` : `Read in ${g.path}`;
}

/** The thread's grants with new ones added; one already covered is not added twice. */
export function addToolGrants(existing: ToolGrant[] | undefined, added: ToolGrant[]): ToolGrant[] {
  const out = [...(existing ?? [])];
  for (const g of added) if (!out.some((x) => toolGrantKey(x) === toolGrantKey(g))) out.push(g);
  return out.slice(-200);
}

/** Commands for the allowlist: trimmed, one line, no chaining operators, no duplicates. */
export function cleanCommandAllowlist(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const key = words(raw).join(" ");
    if (!key || key.length > 200 || CONTROL.test(key)) continue;
    out.add(key);
  }
  return [...out].slice(0, 500);
}
