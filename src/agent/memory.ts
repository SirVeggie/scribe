import crypto from "node:crypto";
import { workspaceKey } from "./prefs.js";
import { isProviderId, type Thread } from "./types.js";

/**
 * Shared agent memory (#104): short notes that every Scribe chat gets in its instructions, whatever
 * its provider, so a correction given to one agent reaches the next. A memory is global, belongs
 * to a workspace folder (and below it), is private to a provider (Native: a source), or both: a
 * provider's memory for one workspace. Agents save them with memory_save; the user
 * reads and edits them under Agent settings. Kept as one list under the "memories" setting.
 */
export type Memory = {
  id: string;
  scope: "global" | "workspace" | "provider";
  /** The workspace folder, for scope "workspace", and optionally for scope "provider" (#840). */
  workspace?: string;
  /** Owning provider; Native (pi) also requires its model source. */
  provider?: string;
  source?: string;
  /** A few words naming it, shown in the user's list (#826). Older memories may lack one. */
  title?: string;
  text: string;
  /** "user", or the provider of the agent that saved it. */
  by: string;
  /** The thread that saved it. */
  thread?: string;
  /** Kept on this device only; otherwise it syncs to paired devices (#978). */
  local?: true;
  createdAt: number;
  updatedAt: number;
};

export const MEMORY_MAX_CHARS = 1500;
export const MEMORY_TITLE_MAX_CHARS = 100;
export const MEMORY_MAX_COUNT = 300;
/** Room the memories may take in a thread's instructions; older ones beyond it are only counted. */
export const MEMORY_PROMPT_CHARS = 12_000;

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export type MemoryOwner = { provider: string; source?: string };

/** Native model ids start with their source, including src- for configured endpoints. */
export function memoryOwner(thread: Pick<Thread, "provider" | "model">): MemoryOwner {
  const slash = thread.model.indexOf("/");
  return { provider: thread.provider, ...(thread.provider === "pi" && slash > 0 && slash < thread.model.length - 1 ? { source: thread.model.slice(0, slash) } : {}) };
}

function validOwner(owner: MemoryOwner): boolean {
  return isProviderId(owner.provider) && (owner.provider !== "pi" || Boolean(owner.source?.trim()));
}

/** The saved list, without entries that do not parse. */
export function cleanMemories(raw: unknown): Memory[] {
  if (!Array.isArray(raw)) return [];
  const out: Memory[] = [];
  for (const m of raw) {
    if (!isRecord(m) || typeof m.id !== "string" || typeof m.text !== "string" || !m.text.trim()) continue;
    const workspace = (m.scope === "workspace" || m.scope === "provider") && typeof m.workspace === "string" && m.workspace ? m.workspace : null;
    const owner = { provider: typeof m.provider === "string" ? m.provider : "", ...(typeof m.source === "string" ? { source: m.source } : {}) };
    // Never widen a malformed private memory into a shared one.
    if (m.scope === "provider" && !validOwner(owner)) continue;
    const at = typeof m.updatedAt === "number" ? m.updatedAt : 0;
    out.push({
      id: m.id,
      scope: m.scope === "provider" ? "provider" : workspace ? "workspace" : "global",
      ...(m.scope === "provider" ? { provider: owner.provider, ...(owner.provider === "pi" ? { source: owner.source } : {}) } : {}),
      ...(workspace ? { workspace } : {}),
      ...(typeof m.title === "string" && m.title.trim() ? { title: m.title.trim() } : {}),
      text: m.text,
      by: typeof m.by === "string" && m.by ? m.by : "user",
      ...(typeof m.thread === "string" ? { thread: m.thread } : {}),
      ...(m.local === true ? { local: true as const } : {}),
      createdAt: typeof m.createdAt === "number" ? m.createdAt : at,
      updatedAt: at,
    });
  }
  return out;
}

/** Shared memories follow workspace scope; private ones require the matching provider/source. */
export function memoryApplies(memory: Memory, workspace: string | null, owner?: MemoryOwner): boolean {
  if (memory.scope === "provider" && !(owner && validOwner(owner) && memory.provider === owner.provider && (owner.provider !== "pi" || memory.source === owner.source))) return false;
  if (memory.scope === "global" || (memory.scope === "provider" && !memory.workspace)) return true;
  if (!workspace || !memory.workspace) return false;
  const at = workspaceKey(workspace);
  const home = workspaceKey(memory.workspace);
  return at === home || at.startsWith(`${home}/`);
}

/** Applicable memories, newest first. Without an owner, private memories are omitted. */
export function memoriesFor(memories: Memory[], workspace: string | null, owner?: MemoryOwner): Memory[] {
  return memories.filter((m) => memoryApplies(m, workspace, owner)).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** title: undefined keeps the saved one; "" clears it. local: undefined keeps the saved one. */
export type MemoryInput = { id?: string; title?: string; text: string; scope: Memory["scope"]; workspace?: string | null; provider?: string; source?: string; local?: boolean; by: string; thread?: string };

/**
 * Add a memory, or replace the text (and scope) of the one with input.id. Returns the new list and
 * the saved memory. A text that is already saved in the same scope updates that memory instead.
 * A synced memory made local gets a new id, and `retired` names the old one, so the other devices
 * delete their copy without deleting this one (#978).
 */
export function saveMemory(memories: Memory[], input: MemoryInput, now = Date.now()): { memories: Memory[]; memory: Memory; created: boolean; retired?: string } {
  const text = input.text.replace(/\r\n/g, "\n").trim();
  if (!text) throw new Error("A memory needs text.");
  if (text.length > MEMORY_MAX_CHARS) throw new Error(`A memory is at most ${MEMORY_MAX_CHARS} characters (this one has ${text.length}). Keep it to one fact, or split it.`);
  const title = input.title === undefined ? undefined : input.title.replace(/\s+/g, " ").trim();
  if (title && title.length > MEMORY_TITLE_MAX_CHARS) throw new Error(`A memory's title is at most ${MEMORY_TITLE_MAX_CHARS} characters: a few words naming it.`);
  if (input.scope === "workspace" && !input.workspace) throw new Error("A workspace memory needs a workspace folder.");
  if (input.scope === "provider" && !validOwner({ provider: input.provider ?? "", source: input.source })) throw new Error("A provider memory needs a provider and, for Native, a specific source. Pick a Native model first.");
  const place = input.scope === "provider"
    ? { scope: "provider" as const, provider: input.provider!, ...(input.provider === "pi" ? { source: input.source! } : {}), ...(input.workspace ? { workspace: input.workspace } : {}) }
    : input.scope === "workspace" ? { scope: "workspace" as const, workspace: input.workspace! } : { scope: "global" as const };
  const samePlace = (m: Memory) => m.scope === place.scope && (place.scope === "global" || (place.scope === "provider" ? m.provider === place.provider && m.source === place.source : true) && workspaceKey(m.workspace ?? "") === workspaceKey(("workspace" in place && place.workspace) || ""));
  let existing = input.id ? memories.find((m) => m.id === input.id) : undefined;
  if (input.id && !existing) throw new Error(`No memory ${input.id}.`);
  existing ??= memories.find((m) => samePlace(m) && m.text === text);
  if (existing) {
    const { workspace: _old, provider: _provider, source: _source, title: oldTitle, local: wasLocal, ...rest } = existing;
    const kept = title === undefined ? oldTitle : title;
    const local = input.local ?? wasLocal === true;
    const retire = local && !wasLocal;
    const memory: Memory = { ...rest, ...(retire ? { id: newMemoryId() } : {}), ...place, ...(kept ? { title: kept } : {}), text, by: input.by, ...(input.thread ? { thread: input.thread } : {}), ...(local ? { local: true as const } : {}), updatedAt: now };
    return { memories: memories.map((m) => (m.id === existing.id ? memory : m)), memory, created: false, ...(retire ? { retired: existing.id } : {}) };
  }
  if (memories.length >= MEMORY_MAX_COUNT) throw new Error(`There are already ${MEMORY_MAX_COUNT} memories. Delete or merge some first.`);
  const memory: Memory = { id: newMemoryId(), ...place, ...(title ? { title } : {}), text, by: input.by, ...(input.thread ? { thread: input.thread } : {}), ...(input.local ? { local: true as const } : {}), createdAt: now, updatedAt: now };
  return { memories: [...memories, memory], memory, created: true };
}

const newMemoryId = () => `m_${crypto.randomBytes(4).toString("hex")}`;

/** Where a memory applies, in words: "all chats", "chats in C:\repo", "only codex chats in C:\repo". */
export function memoryPlace(m: Memory): string {
  const where = m.workspace ? ` in ${m.workspace}` : "";
  const place = m.scope === "provider" ? `only ${m.provider}${m.source ? `/${m.source}` : ""} chats${where}` : m.scope === "global" ? "all chats" : `chats${where}`;
  return m.local ? `${place}, this device only` : place;
}

/** The memories as the block a thread's instructions carry, newest first, within the room they may take. */
export function memoryBlock(memories: Memory[], max = MEMORY_PROMPT_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  let left = 0;
  for (const m of memories) {
    const line = `- [${m.id}] (${m.scope === "provider" ? `provider: ${m.provider}${m.source ? `/${m.source}` : ""}${m.workspace ? ", workspace" : ""}` : m.scope}${m.local ? ", this device" : ""}) ${m.title ? `${m.title.replaceAll("</memories>", "</ memories>")}: ` : ""}${m.text.replaceAll("</memories>", "</ memories>").replace(/\n+/g, "\n  ")}`;
    if (lines.length && used + line.length > max) {
      left += 1;
      continue;
    }
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) return "<memories>\nNone saved yet.\n</memories>";
  if (left) lines.push(`(${left} older ${left === 1 ? "memory is" : "memories are"} not shown; memory_list has them.)`);
  return `<memories>\n${lines.join("\n")}\n</memories>`;
}

// ---------- sync between paired devices (#978) ----------

/** A deleted memory, kept so a paired device that still has it deletes it too instead of sending it back. */
export type MemoryTombstone = { id: string; at: number };

const TOMBSTONE_MAX = 2000;
const TOMBSTONE_KEEP_MS = 180 * 24 * 3600_000;

export function cleanTombstones(raw: unknown, now = Date.now()): MemoryTombstone[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, number>();
  for (const t of raw) {
    if (!isRecord(t) || typeof t.id !== "string" || !t.id || typeof t.at !== "number" || !Number.isFinite(t.at)) continue;
    if (now - t.at > TOMBSTONE_KEEP_MS) continue;
    out.set(t.id, Math.max(out.get(t.id) ?? 0, t.at));
  }
  return [...out].map(([id, at]) => ({ id, at })).sort((a, b) => b.at - a.at).slice(0, TOMBSTONE_MAX);
}

/**
 * Merge a paired device's memories into this device's, as a set: by id, the later edit wins, and a
 * tombstone at or after a memory's last edit deletes it. Local-only memories are never replaced or
 * deleted from outside. `incoming` already has this device's workspace paths (or lacks the ones it
 * cannot place). Nothing changes when both sides already match, so a sync settles after one round.
 */
export function mergeMemories(local: Memory[], tombstones: MemoryTombstone[], incoming: Memory[], incomingTombstones: MemoryTombstone[], now = Date.now()): { memories: Memory[]; tombstones: MemoryTombstone[]; changed: boolean } {
  const dead = new Map(tombstones.map((t) => [t.id, t.at]));
  let changed = false;
  for (const t of cleanTombstones(incomingTombstones, now)) {
    if ((dead.get(t.id) ?? -1) >= t.at) continue;
    dead.set(t.id, t.at);
    changed = true;
  }
  const byId = new Map(local.map((m) => [m.id, m]));
  for (const m of incoming) {
    if (m.local || (dead.get(m.id) ?? -1) >= m.updatedAt) continue;
    const mine = byId.get(m.id);
    if (mine && (mine.local || mine.updatedAt >= m.updatedAt)) continue;
    const { thread: _thread, ...rest } = m;
    byId.set(m.id, rest);
    changed = true;
  }
  for (const [id, m] of byId) {
    if (m.local || (dead.get(id) ?? -1) < m.updatedAt) continue;
    byId.delete(id);
    changed = true;
  }
  return { memories: [...byId.values()], tombstones: cleanTombstones([...dead].map(([id, at]) => ({ id, at })), now), changed };
}
