import { allowedGrants, scopeLabel, type AccessScope, type ScopeLookup } from "./threadAccess.js";
import type { Thread } from "./types.js";

/**
 * What the user granted a thread while it ran (web requests, thread access), as rows the chat
 * can list and take back one by one. key names the grant for a revoke.
 */
export type GrantRow = { kind: "web" | "threads" | "helpers" | "pages" | "plugins"; key: string; label: string };

type GrantThread = Pick<Thread, "cwd" | "worktree" | "scope" | "webGrants" | "threadGrants" | "helpersAllowed" | "pageGrants" | "pluginGrants">;

/** Names for page grants: a page's title, a folder's path. */
export type PageNames = { page(id: string): string | null; folder(id: string): string | null };

function scopeKey(scope: AccessScope): string {
  if (scope.kind === "all") return "threads:all";
  if (scope.kind === "workspace") return `threads:workspace:${scope.path}`;
  return `threads:${scope.kind}:${scope.id}`;
}

/** The thread's grants that are in effect: web first (any site, then domains), then readable thread scopes, then pages and folders (#269), then helper agents. */
export function grantRows(thread: GrantThread, lookup?: ScopeLookup, names?: PageNames): GrantRow[] {
  const rows: GrantRow[] = [];
  if (thread.webGrants?.all) rows.push({ kind: "web", key: "web:*", label: "Any website" });
  for (const domain of thread.webGrants?.domains ?? []) rows.push({ kind: "web", key: `web:${domain}`, label: domain });
  for (const scope of allowedGrants(thread, thread.threadGrants ?? [])) {
    const label = scopeLabel(scope, lookup);
    rows.push({ kind: "threads", key: scopeKey(scope), label: label.charAt(0).toUpperCase() + label.slice(1) });
  }
  for (const grant of thread.pageGrants ?? []) {
    const name = grant.kind === "page" ? names?.page(grant.id) : names?.folder(grant.id);
    const label = grant.kind === "page" ? `Page "${name ?? grant.id}"` : `Folder "${name ?? grant.id}"`;
    rows.push({ kind: "pages", key: `pages:${grant.kind}:${grant.id}`, label: grant.mention ? `${label} (mentioned)` : label });
  }
  if (thread.helpersAllowed) rows.push({ kind: "helpers", key: "helpers", label: "Start helpers without asking" });
  for(const id of thread.pluginGrants??[])rows.push({kind:"plugins",key:`plugins:${id}`,label:id});
  return rows;
}

/** The thread's grant fields without the one key names; null when nothing matches. */
export function revokeGrant(thread: GrantThread, key: string): Pick<Thread, "webGrants" | "threadGrants" | "helpersAllowed" | "pageGrants" | "pluginGrants"> | null {
  if(key.startsWith("plugins:")){
    const grants=thread.pluginGrants??[],kept=grants.filter(id=>`plugins:${id}`!==key);
    return kept.length===grants.length?null:{webGrants:thread.webGrants,threadGrants:thread.threadGrants,pluginGrants:kept};
  }
  if (key.startsWith("pages:")) {
    const grants = thread.pageGrants ?? [];
    const kept = grants.filter((g) => `pages:${g.kind}:${g.id}` !== key);
    return kept.length === grants.length ? null : { webGrants: thread.webGrants, threadGrants: thread.threadGrants, pageGrants: kept };
  }
  if (key === "helpers") {
    return thread.helpersAllowed ? { webGrants: thread.webGrants, threadGrants: thread.threadGrants, helpersAllowed: false } : null;
  }
  if (key === "web:*" && thread.webGrants?.all) {
    return { webGrants: { ...thread.webGrants, all: false }, threadGrants: thread.threadGrants };
  }
  if (key.startsWith("web:")) {
    const domain = key.slice(4);
    const domains = thread.webGrants?.domains ?? [];
    if (!domains.includes(domain)) return null;
    return { webGrants: { ...thread.webGrants, domains: domains.filter((d) => d !== domain) }, threadGrants: thread.threadGrants };
  }
  const scopes = thread.threadGrants ?? [];
  const kept = scopes.filter((s) => scopeKey(s) !== key);
  if (kept.length === scopes.length) return null;
  return { webGrants: thread.webGrants, threadGrants: kept };
}
