import path from "node:path";
import { isPlainObject } from "./types.js";

/**
 * What a page's own code may do beyond reading and writing its state. The user grants these per
 * page (tab menu → Permissions…), and the grants stay on this PC: they are not part of a page's
 * HTML, state, or export. Ids are namespaced ("agent.*", "ml.*"); plugins will add theirs ("plugin.<id>").
 */
export type PermissionValue = "allow" | "deny" | "ask";

/** Approval policies a page may ask for, least to most permissive (same ids as agent threads). */
export const APPROVAL_RANK = ["ask", "edits", "auto", "full"] as const;
export type PageApproval = (typeof APPROVAL_RANK)[number];

export type PermissionDef = {
  id: string;
  label: string;
  detail: string;
  /** What a page gets before the user chose anything. */
  default: PermissionValue;
  /** Reset to the default when an agent rewrites the page's code (or its template's). */
  risky: boolean;
  /** Granted per folder (with the most permissive approval allowed there) instead of as a whole. */
  perFolder?: boolean;
};

export const PAGE_PERMISSIONS: PermissionDef[] = [
  {
    id: "audio.microphone", label: "Use the microphone",
    detail: "Record after a click while this page is visible. Scribe shows a recording indicator and stop control.",
    default: "ask", risky: true,
  },
  {
    id: "audio.transcribe", label: "Turn speech into text",
    detail: "Send audio to the speech-to-text source in Settings. With a hosted source, the audio leaves this PC.",
    default: "ask", risky: false,
  },
  {
    id: "agent.chat",
    label: "Agent chats when you click",
    detail: "Start and continue its own agent chats after you click or press a key on the page. Pages mode with no folder only: no files or shell.",
    default: "allow",
    risky: false,
  },
  {
    id: "agent.unattended",
    label: "Agent chats without a click",
    detail: "Start, message, and stop its agent chats from its own code, for example when a card moves, while the page is loaded.",
    default: "ask",
    risky: true,
  },
  {
    id: "agent.workspace",
    label: "Agents with file and shell access",
    detail: "Start chats in folders you approve: Code and Plan read and change files and run commands there, Pages reads files.",
    default: "ask",
    risky: true,
    perFolder: true,
  },
  {
    id: "ml.decide",
    label: "Ask the classifier",
    detail: "Send text from this page to the classifier set up in Settings, for example a card's title and description to suggest its labels. With a hosted source, that text leaves this PC.",
    default: "ask",
    // The page can only send what it already holds, to the source the user chose, within its limits.
    risky: false,
  },
];

export type FolderGrant = { path: string; approval: PageApproval };

/** One stored grant. folders only for permissions granted per folder, whose value is ask or deny. */
export type PermissionGrant = { value: PermissionValue; folders?: FolderGrant[]; updatedAt: number };

export type PermissionView = PermissionDef & { value: PermissionValue; folders?: FolderGrant[]; updatedAt?: number };

/** What a request needs: the permission, plus the folder and approval for per-folder ones. */
export type PermissionNeed = { perm: string; folder?: string; approval?: string };

export function permissionDef(id: string): PermissionDef | undefined {
  return PAGE_PERMISSIONS.find((def) => def.id === id);
}

export function isPermissionValue(value: unknown): value is PermissionValue {
  return value === "allow" || value === "deny" || value === "ask";
}

export function isApproval(value: unknown): value is PageApproval {
  return typeof value === "string" && (APPROVAL_RANK as readonly string[]).includes(value);
}

/** Folder grants from untrusted input: absolute paths, normalized, one per path (the last wins). */
export function normalizeFolders(value: unknown): FolderGrant[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const byKey = new Map<string, FolderGrant>();
  for (const item of value) {
    if (!isPlainObject(item) || typeof item.path !== "string" || !item.path.trim()) {
      continue;
    }
    const raw = item.path.trim();
    if (!path.isAbsolute(raw)) {
      continue;
    }
    const folder = path.resolve(raw);
    byKey.set(folderKey(folder), { path: folder, approval: isApproval(item.approval) ? item.approval : "ask" });
  }
  return [...byKey.values()];
}

/** Every permission with its current value, defaults filled in. */
export function permissionViews(grants: Map<string, PermissionGrant>): PermissionView[] {
  return PAGE_PERMISSIONS.map((def) => {
    const grant = grants.get(def.id);
    return {
      ...def,
      value: grant?.value ?? def.default,
      ...(def.perFolder ? { folders: grant?.folders ?? [] } : {}),
      ...(grant ? { updatedAt: grant.updatedAt } : {}),
    };
  });
}

/**
 * allow, deny, or ask (the user has not decided for this request yet). A per-folder permission
 * has no blanket allow: it allows a folder inside one the user approved, at that folder's approval
 * or a stricter one, and asks about the rest unless it is set to deny.
 */
export function checkPermission(grants: Map<string, PermissionGrant>, need: PermissionNeed): PermissionValue {
  const def = permissionDef(need.perm);
  if (!def) {
    return "deny";
  }
  const grant = grants.get(def.id);
  const value = grant?.value ?? def.default;
  if (value === "deny" || !def.perFolder) {
    return value;
  }
  if (!need.folder || !path.isAbsolute(need.folder)) {
    return "deny";
  }
  const want = APPROVAL_RANK.indexOf(isApproval(need.approval) ? need.approval : "ask");
  const covered = (grant?.folders ?? []).some(
    (folder) => isInside(need.folder as string, folder.path) && APPROVAL_RANK.indexOf(folder.approval) >= want
  );
  return covered ? "allow" : "ask";
}

function folderKey(folder: string): string {
  const resolved = path.resolve(folder);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(folderKey(parent), folderKey(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
