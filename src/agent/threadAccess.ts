import path from "node:path";
import type { Item, Thread } from "./types.js";

/**
 * Reading other threads (thread_list, thread_read). A thread can only ask for threads in its own
 * scopes: its workspace (the folder it works in) and its app scope (its page, or its folder with the
 * pages and folders inside it). A global thread can ask for any thread. Nothing is readable until
 * the user grants it; grants last for the rest of the thread. A user tag grants one specific
 * thread independently of these scopes.
 */
export type AccessScope = { kind: "workspace"; path: string } | { kind: "page"; id: string } | { kind: "folder"; id: string } | { kind: "thread"; id: string } | { kind: "all" };

/** What the user let a thread read. */
export type ThreadGrants = AccessScope[];

/** Board lookups the scope checks need; the host passes the store's. */
export type ScopeLookup = {
  /** Folder a page is in; null at the Library root or for an unknown page. */
  pageFolder(pageId: string): string | null;
  /** Whether folderId is rootId or inside it. */
  folderInside(folderId: string, rootId: string): boolean;
  pageTitle?(pageId: string): string | null;
  folderPath?(folderId: string): string | null;
  threadTitle?(threadId: string): string | null;
};

const cleanPath = (p: string): string => {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

/** The folder a thread works in. A worktree thread counts as its home folder in the main checkout, so its siblings share it. */
export function threadWorkspace(thread: Pick<Thread, "cwd" | "worktree" | "scope">): string | null {
  const dir = thread.worktree?.home ?? thread.cwd ?? (thread.scope.kind === "workspace" ? thread.scope.ref : null);
  return dir ? cleanPath(dir) : null;
}

function within(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function sameScope(a: AccessScope, b: AccessScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "all") return true;
  if (a.kind === "workspace") return a.path === (b as { path: string }).path;
  return a.id === (b as { id: string }).id;
}

/** The scopes a thread may ask to read: its workspace and its page or folder, or everything for a global thread. */
export function requestableScopes(thread: Pick<Thread, "cwd" | "worktree" | "scope">): AccessScope[] {
  const out: AccessScope[] = [];
  const workspace = threadWorkspace(thread);
  if (workspace) out.push({ kind: "workspace", path: workspace });
  if (thread.scope.kind === "page" && thread.scope.ref) out.push({ kind: "page", id: thread.scope.ref });
  if (thread.scope.kind === "folder" && thread.scope.ref) out.push({ kind: "folder", id: thread.scope.ref });
  if (thread.scope.kind === "global") out.push({ kind: "all" });
  return out;
}

/** Whether a scope covers a thread. */
export function scopeCovers(scope: AccessScope, target: Pick<Thread, "cwd" | "worktree" | "scope"> & { id?: string }, lookup: ScopeLookup): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "thread") return target.id === scope.id;
  if (scope.kind === "workspace") {
    const workspace = threadWorkspace(target);
    return Boolean(workspace && within(workspace, scope.path));
  }
  if (scope.kind === "page") return target.scope.kind === "page" && target.scope.ref === scope.id;
  if (target.scope.kind === "folder" && target.scope.ref) return lookup.folderInside(target.scope.ref, scope.id);
  if (target.scope.kind === "page" && target.scope.ref) {
    const folder = lookup.pageFolder(target.scope.ref);
    return Boolean(folder && lookup.folderInside(folder, scope.id));
  }
  return false;
}

/** Whether reader may read target now: it is not itself, and an effective grant covers it. */
export function canReadThread(reader: Pick<Thread, "id" | "cwd" | "worktree" | "scope" | "threadGrants">, target: Pick<Thread, "id" | "cwd" | "worktree" | "scope">, lookup: ScopeLookup): boolean {
  if (reader.id === target.id) return false;
  return allowedGrants(reader, reader.threadGrants ?? []).some((scope) => scopeCovers(scope, target, lookup));
}

/**
 * Keep only grants the thread could ask for (its scopes may have changed since, e.g. a new workspace).
 * A global thread can be granted any workspace, page or folder, since "all" covers them.
 * Explicit thread tags remain granted independently of the reader's current workspace or page.
 */
export function allowedGrants(thread: Pick<Thread, "cwd" | "worktree" | "scope">, grants: AccessScope[]): AccessScope[] {
  const asked = requestableScopes(thread);
  const global = asked.some((s) => s.kind === "all");
  const out: AccessScope[] = [];
  for (const scope of grants) {
    if (scope.kind !== "thread" && !global && !asked.some((s) => sameScope(s, scope))) continue;
    if (!out.some((s) => sameScope(s, scope))) out.push(scope);
  }
  return out;
}

/** Add scopes to a thread's grants, without repeats. */
export function grantScopes(grants: ThreadGrants | undefined, scopes: AccessScope[]): ThreadGrants {
  const out = [...(grants ?? [])];
  for (const scope of scopes) if (!out.some((s) => sameScope(s, scope))) out.push(scope);
  return out;
}

/** Whether every scope in want is already granted. */
export function scopesGranted(grants: ThreadGrants | undefined, want: AccessScope[]): boolean {
  return want.every((scope) => (grants ?? []).some((s) => sameScope(s, scope)));
}

/** A scope as the user and the agent see it. */
export function scopeLabel(scope: AccessScope, lookup?: ScopeLookup): string {
  if (scope.kind === "all") return "all threads";
  if (scope.kind === "thread") return `thread "${lookup?.threadTitle?.(scope.id) ?? scope.id}"`;
  if (scope.kind === "workspace") return `threads in workspace ${scope.path}`;
  if (scope.kind === "page") return `threads on page "${lookup?.pageTitle?.(scope.id) ?? scope.id}"`;
  return `threads in folder "${lookup?.folderPath?.(scope.id) ?? scope.id}" (and its pages and subfolders)`;
}

/** The scope a thread belongs to, for list rows. */
export function threadScopeLabel(thread: Pick<Thread, "scope">, lookup?: ScopeLookup): string {
  const { kind, ref } = thread.scope;
  if (kind === "global") return "global";
  if (kind === "workspace") return ref ? `workspace ${ref}` : "none";
  if (!ref) return "global";
  if (kind === "page") return `page "${lookup?.pageTitle?.(ref) ?? ref}"`;
  if (kind === "folder") return `folder "${lookup?.folderPath?.(ref) ?? ref}"`;
  return `workspace ${ref}`;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text);

/** One transcript item as compact text for thread_read; null for items it skips. Long tool output is clipped unless full. */
export function itemText(item: Item, opts: { full?: boolean } = {}): string | null {
  const max = opts.full ? 20_000 : 1_500;
  switch (item.kind) {
    case "user": {
      if (item.dropped) return null;
      const who = item.from === "page" ? "user (sent by page)" : item.from === "component" ? "user (sent by component)" : item.from === "scribe" ? "scribe" : item.from === "hook" ? "scribe hook" : item.from === "agent" ? "agent that started this helper" : "user";
      return `[${who}] ${clip(item.text, max * 2)}`;
    }
    case "text":
      return `[agent${item.parentToolId ? " subagent" : ""}] ${clip(item.text, max * 4)}`;
    case "tool": {
      const head = `[tool ${item.name}${item.status === "error" ? " (error)" : ""}${item.exitCode !== undefined ? ` exit ${item.exitCode}` : ""}] ${item.title}`;
      const detail = item.detail && item.detail !== item.title ? `\n${clip(item.detail, max)}` : "";
      const output = item.output ? `\n--- output\n${clip(item.output, max)}` : "";
      return head + detail + output;
    }
    case "approval":
      return `[approval ${item.status}${item.decision ? `: ${item.decision}` : ""}] ${item.title}`;
    case "question": {
      const answers = item.answers ? ` → ${Object.values(item.answers).flat().join(", ")}` : "";
      return `[question ${item.status}] ${item.title ?? item.questions.map((q) => q.prompt).join(" / ")}${answers}`;
    }
    case "plan":
      return `[plan ${item.status}] ${clip(item.text, max * 2)}`;
    case "component":
      return `[component ${item.status}] ${clip(item.summary ?? item.fallback ?? item.title ?? "Interactive component", max * 2)}`;
    case "settings":
      return `[settings shown] ${item.ids.join(", ")}`;
    case "todos":
      return `[todos] ${item.todos.map((t) => `${t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : " "} ${t.content}`).join("; ")}`;
    case "notice":
      return `[notice ${item.level}] ${item.text}`;
    default:
      return null;
  }
}

/** Whether an item mentions every word of q (case-insensitive), in its text, tool title, detail or output. */
export function itemMatches(item: Item, words: string[]): boolean {
  if (!words.length) return true;
  let hay = "";
  if (item.kind === "user" || item.kind === "text" || item.kind === "plan" || item.kind === "notice") hay = item.text;
  else if (item.kind === "tool") hay = `${item.name} ${item.title} ${item.detail ?? ""} ${item.output ?? ""}`;
  else if (item.kind === "approval") hay = `${item.title} ${item.detail ?? ""}`;
  else if (item.kind === "question") hay = `${item.title ?? ""} ${item.questions.map((q) => q.prompt).join(" ")}`;
  else if (item.kind === "component") hay = `${item.title ?? ""} ${item.summary ?? item.fallback ?? ""}`;
  hay = hay.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function queryWords(q: unknown): string[] {
  return typeof q === "string" ? q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10) : [];
}
