import { randomBytes } from "node:crypto";
import { normalizeLens, type Lens } from "./lens.js";

/**
 * Spaces: named sets of tabs. The active space is the live tab strip; every other space keeps the
 * strip it had when the user left it (tab order, pins, the focused tab). Switching closes the
 * current strip into its space and opens the target's tabs. Pages stay shared: one page can be a
 * tab in several spaces, and a page that left every space is just a closed page in the Library.
 */

export type SpaceTab = { id: string; pinned: boolean };

export type Space = {
  id: string;
  name: string;
  /** One of SPACE_COLORS. */
  color: string;
  /** Strip order, pinned first. Stale for the active space: the live strip is its truth. */
  tabs: SpaceTab[];
  activeId: string | null;
  createdAt: number;
  /** When the user last switched to or away from it. */
  usedAt: number;
  /**
   * The space's home folder (#260): pages made in the space, by the user or by a chat started in
   * it, go there when no folder is given, and the lens shows it by default. Omitted for none.
   */
  home?: string;
  /** The space's Library lens (#260). Omitted until the user sets one up. */
  lens?: Lens;
};

export type DeletedSpace = { space: Space; index: number; deletedAt: number };

export type SpacesData = {
  list: Space[];
  /** Null until the user first uses spaces: then the current strip becomes the first space. */
  activeId: string | null;
  /** Newest last. Undo brings back the last one. */
  deleted: DeletedSpace[];
};

/** How a space looks to the UI. */
export type SpaceView = Space & { active: boolean };

export type SpacesView = {
  spaces: SpaceView[];
  activeId: string | null;
  /** Deleted spaces that undo can bring back, newest first. */
  deleted: Array<{ id: string; name: string; color: string; tabs: number; deletedAt: number }>;
};

export const SPACE_COLORS = ["slate", "blue", "teal", "green", "amber", "orange", "red", "pink", "violet"] as const;
export const SPACE_NAME_MAX = 60;
/** Undo keeps this many deleted spaces. */
export const SPACE_UNDO_MAX = 10;
const SPACE_TABS_MAX = 2000;

export function emptySpaces(): SpacesData {
  return { list: [], activeId: null, deleted: [] };
}

export function newSpaceId(): string {
  return "s_" + randomBytes(4).toString("hex");
}

export function cleanSpaceName(name: unknown, fallback: string): string {
  const text = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, SPACE_NAME_MAX) : "";
  return text || fallback;
}

export function isSpaceColor(color: unknown): color is string {
  return typeof color === "string" && (SPACE_COLORS as readonly string[]).includes(color);
}

/** The first color no space uses yet, so a new space looks different from the others. */
export function nextSpaceColor(list: Space[]): string {
  const used = new Set(list.map((space) => space.color));
  return SPACE_COLORS.find((color) => !used.has(color)) ?? SPACE_COLORS[list.length % SPACE_COLORS.length];
}

/** "Space 2", "Space 3", … whichever is free. */
export function nextSpaceName(list: Space[]): string {
  const names = new Set(list.map((space) => space.name.toLowerCase()));
  for (let n = list.length + 1; ; n++) {
    const name = `Space ${n}`;
    if (!names.has(name.toLowerCase())) {
      return name;
    }
  }
}

function normalizeSpace(raw: unknown): Space | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id) {
    return null;
  }
  const seen = new Set<string>();
  const tabs: SpaceTab[] = [];
  for (const entry of Array.isArray(item.tabs) ? item.tabs : []) {
    const id = typeof entry === "string" ? entry : (entry as { id?: unknown })?.id;
    if (typeof id !== "string" || !id || seen.has(id) || tabs.length >= SPACE_TABS_MAX) {
      continue;
    }
    seen.add(id);
    tabs.push({ id, pinned: Boolean((entry as { pinned?: unknown })?.pinned) });
  }
  const now = Date.now();
  const lens = normalizeLens(item.lens);
  return {
    id: item.id,
    name: cleanSpaceName(item.name, "Space"),
    color: isSpaceColor(item.color) ? item.color : SPACE_COLORS[0],
    tabs,
    activeId: typeof item.activeId === "string" && seen.has(item.activeId) ? item.activeId : null,
    createdAt: typeof item.createdAt === "number" ? item.createdAt : now,
    usedAt: typeof item.usedAt === "number" ? item.usedAt : now,
    ...(typeof item.home === "string" && item.home ? { home: item.home } : {}),
    ...(lens ? { lens } : {}),
  };
}

/** Parse the stored JSON; anything malformed is dropped rather than failing the load. */
export function parseSpaces(json: string | undefined | null): SpacesData {
  if (!json) {
    return emptySpaces();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return emptySpaces();
  }
  const data = raw as Partial<Record<keyof SpacesData, unknown>>;
  const list: Space[] = [];
  const ids = new Set<string>();
  for (const item of Array.isArray(data?.list) ? data.list : []) {
    const space = normalizeSpace(item);
    if (space && !ids.has(space.id)) {
      ids.add(space.id);
      list.push(space);
    }
  }
  const deleted: DeletedSpace[] = [];
  for (const item of Array.isArray(data?.deleted) ? data.deleted : []) {
    const entry = item as Partial<DeletedSpace> | null;
    const space = normalizeSpace(entry?.space);
    if (space && !ids.has(space.id)) {
      ids.add(space.id);
      deleted.push({
        space,
        index: typeof entry?.index === "number" ? entry.index : list.length,
        deletedAt: typeof entry?.deletedAt === "number" ? entry.deletedAt : Date.now(),
      });
    }
  }
  const activeId = typeof data?.activeId === "string" && list.some((space) => space.id === data.activeId) ? data.activeId : null;
  return { list, activeId: list.length ? (activeId ?? list[0].id) : null, deleted: deleted.slice(-SPACE_UNDO_MAX) };
}
