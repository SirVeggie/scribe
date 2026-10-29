import path from "node:path";
import { isPlainObject } from "./types.js";

/**
 * What a page's own code may do beyond reading and writing its state. The user grants these per
 * page (tab menu → Permissions…), and the grants stay on this PC: they are not part of a page's
 * HTML, state, or export. Ids are namespaced ("agent.*", "ml.*"); plugins will add theirs ("plugin.<id>").
 */
export type PermissionValue = "allow" | "deny" | "ask";

/** Approval policies a page may ask for, least to most permissive (same ids as agent threads). */
/** The approval rungs (#719), lowest first. Older grants and requests said "ask" (Ask first), read as Edits. */
export const APPROVAL_RANK = ["readonly", "board", "edits", "auto", "full"] as const;
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
  /** A per-folder permission's own levels instead of the approval rungs, and what the level is called. */
  levels?: { id: string; label: string }[];
  levelName?: string;
};

/** What a page may do in a folder approved for scribe.files (#882): write only saves without seeing what is there. */
export const FILE_ACCESS = ["read", "write", "readwrite"] as const;
export type FileAccess = (typeof FILE_ACCESS)[number];
export const FILES_PERMISSION = "files";

export const PAGE_PERMISSIONS: PermissionDef[] = [
  {
    id: "audio.microphone", label: "Use the microphone",
    detail: "Record after a click while this page is visible. Scribe shows a recording indicator and stop control.",
    default: "ask", risky: true,
  },
  {
    id: "audio.microphoneStream", label: "Stream the live microphone to this page",
    detail: "The page receives every microphone sample while it runs, not just a clip at the end. Scribe shows a recording indicator and stop control.",
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
    detail: "Start chats in folders you approve: from Edits up they read and change files and run commands there, Read-only and Board read files.",
    default: "ask",
    risky: true,
    perFolder: true,
  },
  {
    id: FILES_PERMISSION,
    label: "Files in folders you approve",
    detail: "Its own code reads or saves files there, for example generated images or a log. Nothing outside those folders.",
    default: "ask",
    risky: true,
    perFolder: true,
    levelName: "Access",
    levels: [
      { id: "read", label: "Read" },
      { id: "write", label: "Write" },
      { id: "readwrite", label: "Read & write" },
    ],
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

/** approval is the folder's level: an approval rung, or one of the permission's own levels (files: read, write, readwrite). */
export type FolderGrant = { path: string; approval: string };

/**
 * One stored grant. folders only for permissions granted per folder, whose value is ask or deny.
 * keep: the user chose to keep a risky grant when an agent rewrites the page (#895).
 */
export type PermissionGrant = { value: PermissionValue; folders?: FolderGrant[]; keep?: boolean; updatedAt: number };

export type PermissionView = PermissionDef & { value: PermissionValue; folders?: FolderGrant[]; keep?: boolean; updatedAt?: number };

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

/** A grant's or request's rung, with the older "ask" read as Edits; null when it is none. */
export function parsePageApproval(value: unknown): PageApproval | null {
  return value === "ask" ? "edits" : isApproval(value) ? value : null;
}

/** A folder level for def: one of its own levels, or an approval rung; null when it is none. */
function parseLevel(def: PermissionDef | undefined, value: unknown): string | null {
  if (def?.levels) return def.levels.some((level) => level.id === value) ? (value as string) : null;
  return parsePageApproval(value);
}

/** Whether a folder granted at `granted` covers a request for `want` (files: read & write covers both). */
function covers(def: PermissionDef, granted: string, want: string): boolean {
  if (def.levels) return granted === want || (def.id === FILES_PERMISSION && granted === "readwrite");
  return APPROVAL_RANK.indexOf(granted as PageApproval) >= APPROVAL_RANK.indexOf(want as PageApproval);
}

/** Folder grants from untrusted input: absolute paths, normalized, one per path (the last wins). */
export function normalizeFolders(value: unknown, def?: PermissionDef): FolderGrant[] {
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
    byKey.set(folderKey(folder), { path: folder, approval: parseLevel(def, item.approval) ?? def?.levels?.[0].id ?? "readonly" });
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
      ...(grant?.keep ? { keep: true } : {}),
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
  const want = parseLevel(def, need.approval) ?? def.levels?.[0].id ?? "readonly";
  const covered = (grant?.folders ?? []).some(
    (folder) => isInside(need.folder as string, folder.path) && covers(def, folder.approval, want)
  );
  return covered ? "allow" : "ask";
}

function folderKey(folder: string): string {
  const resolved = path.resolve(folder);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(folderKey(parent), folderKey(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
