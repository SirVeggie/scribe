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

/** title: undefined keeps the saved one; "" clears it. */
export type MemoryInput = { id?: string; title?: string; text: string; scope: Memory["scope"]; workspace?: string | null; provider?: string; source?: string; by: string; thread?: string };

/**
 * Add a memory, or replace the text (and scope) of the one with input.id. Returns the new list and
 * the saved memory. A text that is already saved in the same scope updates that memory instead.
 */
export function saveMemory(memories: Memory[], input: MemoryInput, now = Date.now()): { memories: Memory[]; memory: Memory; created: boolean } {
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
    const { workspace: _old, provider: _provider, source: _source, title: oldTitle, ...rest } = existing;
    const kept = title === undefined ? oldTitle : title;
    const memory: Memory = { ...rest, ...place, ...(kept ? { title: kept } : {}), text, by: input.by, ...(input.thread ? { thread: input.thread } : {}), updatedAt: now };
    return { memories: memories.map((m) => (m.id === memory.id ? memory : m)), memory, created: false };
  }
  if (memories.length >= MEMORY_MAX_COUNT) throw new Error(`There are already ${MEMORY_MAX_COUNT} memories. Delete or merge some first.`);
  const memory: Memory = { id: `m_${crypto.randomBytes(4).toString("hex")}`, ...place, ...(title ? { title } : {}), text, by: input.by, ...(input.thread ? { thread: input.thread } : {}), createdAt: now, updatedAt: now };
  return { memories: [...memories, memory], memory, created: true };
}

/** Where a memory applies, in words: "all chats", "chats in C:\repo", "only codex chats in C:\repo". */
export function memoryPlace(m: Memory): string {
  const where = m.workspace ? ` in ${m.workspace}` : "";
  return m.scope === "provider" ? `only ${m.provider}${m.source ? `/${m.source}` : ""} chats${where}` : m.scope === "global" ? "all chats" : `chats${where}`;
}

/** The memories as the block a thread's instructions carry, newest first, within the room they may take. */
export function memoryBlock(memories: Memory[], max = MEMORY_PROMPT_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  let left = 0;
  for (const m of memories) {
    const line = `- [${m.id}] (${m.scope === "provider" ? `provider: ${m.provider}${m.source ? `/${m.source}` : ""}${m.workspace ? ", workspace" : ""}` : m.scope}) ${m.title ? `${m.title.replaceAll("</memories>", "</ memories>")}: ` : ""}${m.text.replaceAll("</memories>", "</ memories>").replace(/\n+/g, "\n  ")}`;
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
