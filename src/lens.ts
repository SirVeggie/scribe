/**
 * Library lenses (#260): a space's filter over the Library. A lens is a view only: it never grants
 * or blocks agent access. The board evaluates it (public/lens.js); the daemon only stores it on the
 * space and answers the About condition from the semantic index.
 */

export type LensAgeBasis = "activity" | "edited" | "created" | "closed";
export type LensKind = "template" | "file" | "plain";
export type LensAccess = "public" | "open" | "ask" | "trusted" | "restricted";
export type LensFlag = "pinned" | "unread" | "chats";

export type LensCondition = { not?: boolean } & (
  /** Inside the space's home folder. */
  | { type: "home" }
  | { type: "folder"; folders: string[] }
  /** Made while the space was active, or by a chat started in it. "this" is the lens's own space. */
  | { type: "madeIn"; spaces: string[] }
  | { type: "madeBy"; by: "me" | "agent" }
  /** Made by a chat on this page, or on this folder or one inside it (the page's access origin). */
  | { type: "madeFrom"; target: { kind: "page" | "folder"; id: string } }
  /** The page's workspace is this folder or inside it. */
  | { type: "workspace"; path: string }
  | { type: "age"; basis: LensAgeBasis; days: number }
  | { type: "kind"; kinds: LensKind[] }
  /** Semantic: pages about this phrase (needs semantic search). */
  | { type: "about"; text: string }
  | { type: "access"; levels: LensAccess[] }
  | { type: "flag"; flag: LensFlag }
);

export type Lens = {
  on: boolean;
  match: "all" | "any";
  conditions: LensCondition[];
};

export const LENS_CONDITIONS_MAX = 12;
const IDS_MAX = 50;
const TEXT_MAX = 200;
const AGE_BASES: LensAgeBasis[] = ["activity", "edited", "created", "closed"];
const KINDS: LensKind[] = ["template", "file", "plain"];
const ACCESS: LensAccess[] = ["public", "open", "ask", "trusted", "restricted"];
const FLAGS: LensFlag[] = ["pinned", "unread", "chats"];

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out = new Set<string>();
  for (const id of value) {
    if (typeof id === "string" && id.trim() && out.size < IDS_MAX) {
      out.add(id.trim().slice(0, TEXT_MAX));
    }
  }
  return [...out];
}

function picks<T extends string>(value: unknown, allowed: T[]): T[] {
  return Array.isArray(value) ? allowed.filter((item) => value.includes(item)) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX) : "";
}

/** One condition, or null when it is malformed or would match nothing by construction. */
export function normalizeCondition(raw: unknown): LensCondition | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const not = item.not === true ? { not: true } : {};
  switch (item.type) {
    case "home":
      return { type: "home", ...not };
    case "folder": {
      const folders = ids(item.folders);
      return folders.length ? { type: "folder", folders, ...not } : null;
    }
    case "madeIn": {
      const spaces = ids(item.spaces);
      return spaces.length ? { type: "madeIn", spaces, ...not } : null;
    }
    case "madeBy":
      return item.by === "me" || item.by === "agent" ? { type: "madeBy", by: item.by, ...not } : null;
    case "madeFrom": {
      const target = item.target as Record<string, unknown> | undefined;
      const kind = target?.kind;
      const id = text(target?.id);
      return (kind === "page" || kind === "folder") && id ? { type: "madeFrom", target: { kind, id }, ...not } : null;
    }
    case "workspace": {
      const path = text(item.path);
      return path ? { type: "workspace", path, ...not } : null;
    }
    case "age": {
      const days = Number(item.days);
      const basis = AGE_BASES.includes(item.basis as LensAgeBasis) ? (item.basis as LensAgeBasis) : "activity";
      return Number.isFinite(days) && days > 0 ? { type: "age", basis, days: Math.min(Math.round(days * 100) / 100, 36500), ...not } : null;
    }
    case "kind": {
      const kinds = picks(item.kinds, KINDS);
      return kinds.length ? { type: "kind", kinds, ...not } : null;
    }
    case "about": {
      const phrase = text(item.text);
      return phrase ? { type: "about", text: phrase, ...not } : null;
    }
    case "access": {
      const levels = picks(item.levels, ACCESS);
      return levels.length ? { type: "access", levels, ...not } : null;
    }
    case "flag":
      return FLAGS.includes(item.flag as LensFlag) ? { type: "flag", flag: item.flag as LensFlag, ...not } : null;
    default:
      return null;
  }
}

/** A stored or posted lens; undefined when there is nothing worth keeping. */
export function normalizeLens(raw: unknown): Lens | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const item = raw as Record<string, unknown>;
  const conditions: LensCondition[] = [];
  for (const entry of Array.isArray(item.conditions) ? item.conditions : []) {
    const condition = normalizeCondition(entry);
    if (condition && conditions.length < LENS_CONDITIONS_MAX) {
      conditions.push(condition);
    }
  }
  return { on: item.on === true, match: item.match === "any" ? "any" : "all", conditions };
}
