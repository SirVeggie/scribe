import { isPlainObject, type AccessLevel, type AccessTarget, type FolderAccess, type PageAccess } from "./types.js";

/**
 * Which pages a chat's agent may reach (#269). A chat reaches the pages in its Scribe scope, pages
 * created from there (origin), and what it or its page/folder was granted; past that it asks. A page
 * or folder can be stricter (Ask always, Trusted only, Restricted; strictest up the tree wins), and a
 * page the user @mentioned in the chat is reachable whatever its level. The thread's approval level
 * (full access included) plays no part here: only the user's answer or @mention opens a stricter page.
 *
 * This decides for agents' requests. Page scripts are decided by frameReach (#660).
 */

/**
 * allow: read and change it. ask: its title shows, page_access can ask for it. request: not listed or
 * found by search, but a chat that knows its key or id can ask for it with page_access (a Trusted only
 * page for an untrusted model). hidden: as if it did not exist.
 */
export type Reach = "allow" | "ask" | "request" | "hidden";

/** A grant a chat holds for itself. mention: the user @mentioned it in the composer, which beats every level. */
export type ThreadPageGrant = AccessTarget & { mention?: true };

export type ReaderScope = { kind: "global" | "page" | "folder" | "workspace"; ref: string | null };

/** The chat asking: its Scribe scope, whether its model is trusted, and its own grants. */
export type PageReader = {
  /** The chat's thread id; pages it created itself are its own. Omitted for external MCP clients. */
  thread?: string;
  scope: ReaderScope;
  /** Homes the chat had before it followed a page it showed (#269): they still count as its scope. */
  formerScopes?: ReaderScope[];
  trusted: boolean;
  grants: ThreadPageGrant[];
};

/** The page as the decision needs it. */
export type AccessPage = {
  id: string;
  folderId?: string;
  agentHidden?: boolean;
  access?: PageAccess;
  /** Thread that created it (provenance.created.thread). */
  createdBy?: string;
};

/** Board lookups, from the store. */
export type AccessLookup = {
  /** The folder and its parents, innermost first; empty for the root. */
  folderChain(folderId: string | undefined | null): string[];
  folderAccess(folderId: string): FolderAccess | undefined;
  /** A page's folder, for an origin or grant that names a page; undefined when unknown. */
  pageFolder(pageId: string): string | undefined;
  pageAccess(pageId: string): PageAccess | undefined;
};

const LEVEL_ORDER: AccessLevel[] = ["public", "open", "ask", "trusted", "restricted"];

export function isAccessLevel(value: unknown): value is AccessLevel {
  return typeof value === "string" && (LEVEL_ORDER as string[]).includes(value);
}

export function stricterLevel(a: AccessLevel, b: AccessLevel): AccessLevel {
  return LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b;
}

/** The level the page itself sets, before its folders; undefined when it sets none. */
export function ownLevel(page: Pick<AccessPage, "agentHidden" | "access">): AccessLevel | undefined {
  return page.agentHidden ? "restricted" : page.access?.level;
}

/** Strictest set level among a folder and its parents (and start); undefined when none is set. */
function chainLevel(start: AccessLevel | undefined, folderId: string | null | undefined, lookup: AccessLookup): AccessLevel | undefined {
  let level = start;
  for (const id of lookup.folderChain(folderId)) {
    const set = lookup.folderAccess(id)?.level;
    if (set) level = level ? stricterLevel(level, set) : set;
  }
  return level;
}

/** The strictest level the page and its folders set; open (Normal) when none is set. */
export function effectiveLevel(page: AccessPage, lookup: AccessLookup): AccessLevel {
  return chainLevel(ownLevel(page), page.folderId, lookup) ?? "open";
}

/** Strictest level among a folder and its parents, for the folder settings to show what pages inherit. */
export function inheritedFolderLevel(folderId: string | null, lookup: AccessLookup): AccessLevel {
  return chainLevel(undefined, folderId, lookup) ?? "open";
}

/** Normal or Open: chats reach it through their scope and grants without the user (Open: every chat). */
export function isOpenLevel(level: AccessLevel): boolean {
  return level === "open" || level === "public";
}

/** Whether target names the page or a folder it is in. */
export function targetCovers(target: AccessTarget, page: Pick<AccessPage, "id" | "folderId">, lookup: AccessLookup): boolean {
  if (target.kind === "page") return target.id === page.id;
  return lookup.folderChain(page.folderId).includes(target.id);
}

/** Whether a page or folder (an origin) sits inside the chat's scope. */
function placeInScope(place: AccessTarget, scope: ReaderScope, lookup: AccessLookup): boolean {
  if (scope.kind === "global") return true;
  if (!scope.ref || scope.kind === "workspace") return false;
  if (scope.kind === "page") return place.kind === "page" && place.id === scope.ref;
  const folder = place.kind === "folder" ? place.id : lookup.pageFolder(place.id);
  return Boolean(folder && lookup.folderChain(folder).includes(scope.ref));
}

/** Grants held by the chat's home: its page and that page's folders, or its folder and the folders above. */
export function homeGrants(scope: ReaderScope, lookup: AccessLookup): AccessTarget[] {
  if (!scope.ref || (scope.kind !== "page" && scope.kind !== "folder")) return [];
  const out: AccessTarget[] = [];
  let folder: string | undefined = scope.ref;
  if (scope.kind === "page") {
    out.push(...(lookup.pageAccess(scope.ref)?.grants ?? []));
    folder = lookup.pageFolder(scope.ref);
  }
  for (const id of lookup.folderChain(folder)) out.push(...(lookup.folderAccess(id)?.grants ?? []));
  return out;
}

/** What the chat may do with the page. */
export function pageReach(reader: PageReader, page: AccessPage, lookup: AccessLookup): Reach {
  if (reader.scope.kind === "workspace") return "hidden";
  if (reader.grants.some((g) => g.mention && targetCovers(g, page, lookup))) return "allow";
  const level = effectiveLevel(page, lookup);
  // Open to all agents (#723): reference pages such as a style guide, for any chat with Scribe access.
  if (level === "public") return "allow";
  const scopes = [reader.scope, ...(reader.formerScopes ?? [])].filter((s) => s.kind !== "workspace");
  const ownPage = scopes.some((s) => s.kind === "page" && s.ref === page.id);
  if (level === "restricted") return ownPage ? "allow" : "hidden";
  const threadGranted = reader.grants.some((g) => targetCovers(g, page, lookup));
  // Untrusted: only the user's answer for this thread opens it, never its home's grants or origin.
  if (level === "trusted" && !reader.trusted) return threadGranted ? "allow" : "request";
  if (ownPage) return "allow";
  if (level === "ask") return threadGranted ? "allow" : "ask";
  if (threadGranted) return "allow";
  if (reader.thread && page.createdBy === reader.thread) return "allow";
  const origin = page.access?.origin;
  for (const scope of scopes) {
    if (placeInScope({ kind: "page", id: page.id }, scope, lookup)) return "allow";
    if (origin && placeInScope(origin, scope, lookup)) return "allow";
    if (homeGrants(scope, lookup).some((g) => targetCovers(g, page, lookup))) return "allow";
  }
  return "ask";
}

/**
 * Whether a page's own script, on its own origin, may reach another page (#660): its own page, and
 * Normal or Open pages its page or folders were granted (the grants its chats inherit). Ask always,
 * Trusted only and Restricted pages need a chat's own grant or the user, so no page script reaches them.
 */
export function frameReach(fromPageId: string, page: AccessPage, lookup: AccessLookup): boolean {
  if (page.id === fromPageId) return true;
  if (!isOpenLevel(effectiveLevel(page, lookup))) return false;
  return homeGrants({ kind: "page", ref: fromPageId }, lookup).some((g) => targetCovers(g, page, lookup));
}

/** Why a page is out of reach, for the agent. */
export function reachMessage(reach: Reach, page: { key: string; title: string }): string {
  // #723: a worker took "outside" for a refusal; say that page_access asks and how long it can block.
  const ask = "Ask the user for it with page_access (key, reason, importance), then try again. A board worker's chat waits for the answer only as long as importance says, then goes on without it.";
  if (reach === "ask") return `${page.key} ("${page.title}") is outside this chat's Scribe access. ${ask}`;
  // No title: the caller knew the key, and that is all it learns.
  if (reach === "request") return `${page.key} is outside this chat's Scribe access. ${ask}`;
  return `tab not found: ${page.key}`;
}

export function sameTarget(a: AccessTarget, b: AccessTarget): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export function addTargets<T extends AccessTarget>(list: T[] | undefined, add: T[]): T[] {
  const out = [...(list ?? [])];
  for (const target of add) {
    const at = out.findIndex((t) => sameTarget(t, target));
    if (at < 0) out.push(target);
    // A mention outranks a plain grant for the same target.
    else if ((target as ThreadPageGrant).mention && !(out[at] as ThreadPageGrant).mention) out[at] = target;
  }
  return out;
}

export function normalizeTarget(value: unknown): AccessTarget | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.kind !== "page" && value.kind !== "folder") return undefined;
  if (typeof value.id !== "string" || !value.id.trim()) return undefined;
  return { kind: value.kind, id: value.id.trim().slice(0, 80) };
}

function normalizeTargets(value: unknown): AccessTarget[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = addTargets<AccessTarget>([], value.map(normalizeTarget).filter((t): t is AccessTarget => Boolean(t))).slice(0, 200);
  return out.length ? out : undefined;
}

export function normalizePageAccess(value: unknown): PageAccess | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: PageAccess = {};
  if (value.level === "public" || value.level === "open" || value.level === "ask" || value.level === "trusted") out.level = value.level;
  const origin = normalizeTarget(value.origin);
  if (origin) out.origin = origin;
  const grants = normalizeTargets(value.grants);
  if (grants) out.grants = grants;
  return Object.keys(out).length ? out : undefined;
}

export function normalizeFolderAccess(value: unknown): FolderAccess | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: FolderAccess = {};
  if (isAccessLevel(value.level)) out.level = value.level;
  const grants = normalizeTargets(value.grants);
  if (grants) out.grants = grants;
  return Object.keys(out).length ? out : undefined;
}

export function normalizeThreadPageGrants(value: unknown): ThreadPageGrant[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ThreadPageGrant[] = [];
  for (const raw of value) {
    const target = normalizeTarget(raw);
    if (target) out.push(isPlainObject(raw) && raw.mention === true ? { ...target, mention: true } : target);
  }
  return out.length ? addTargets<ThreadPageGrant>([], out) : undefined;
}
