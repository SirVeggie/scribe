import type { ApprovalPolicy, ProviderId, Thread, ThreadCustomMode, WebAccess } from "./types.js";
import { APPROVALS, isPlainRecord, minApproval, parseApproval } from "./types.js";
import { parseWebAccess } from "./webAccess.js";

/**
 * Custom modes (#271): a saved preset with a highest approval rung (#719). The rung keeps its own
 * behaviour (sandbox, folder rule); the custom mode only takes things away from it (tool groups,
 * MCP servers), adds instructions, and sets the rung (at most its highest), plan first and web a
 * thread starts with.
 *
 * A thread keeps a copy of what its mode takes away (Thread.custom), so providers and the prompt read
 * it from the thread, and a deleted mode leaves its threads as limited as they were.
 */

/** A group of tools a custom mode can turn off. Each provider maps it onto its own tools. */
export type ModeCapability = "edit" | "shell" | "web" | "subagents" | "helpers" | "browser" | "threads";

export const MODE_CAPABILITIES: ModeCapability[] = ["edit", "shell", "web", "subagents", "helpers", "browser", "threads"];

const MAX_MODES = 40;
const MAX_INSTRUCTIONS = 8000;

export type CustomMode = {
  /** "cm_…": never a built-in mode's id. */
  id: string;
  name: string;
  description?: string;
  /** The highest rung a thread in this mode may use. Older modes named a built-in mode here; cleanCustomModes reads them as rungs. */
  base: ApprovalPolicy;
  /** Threads start planning first (older modes based on Plan). */
  plan?: boolean;
  /** Tool groups the mode turns off. */
  off: ModeCapability[];
  /** The user's MCP servers (Agent settings) the mode keeps: every one its base mode gets, none, or the named ones. */
  mcp: "all" | "none" | string[];
  /** Added to the thread's instructions. */
  instructions: string;
  /** Rung (at most base) and web a thread gets when the mode is picked; the user can still change them on the thread. */
  approval?: ApprovalPolicy;
  web?: WebAccess;
};

function cleanMcp(value: unknown): CustomMode["mcp"] {
  if (value === "none") return "none";
  if (!Array.isArray(value)) return "all";
  return [...new Set(value.filter((name): name is string => typeof name === "string" && name.trim().length > 0).map((name) => name.trim()))].slice(0, 100);
}

function cleanOff(value: unknown): ModeCapability[] {
  if (!Array.isArray(value)) return [];
  return MODE_CAPABILITIES.filter((cap) => value.includes(cap));
}

/** The highest rung of a saved mode. Older modes were built on a mode: Code and Plan allow every rung, Ask and Pages the Board rung. */
function cleanBase(value: unknown): { base: ApprovalPolicy; plan?: true } {
  if (APPROVALS.includes(value as ApprovalPolicy)) return { base: value as ApprovalPolicy };
  if (value === "ask" || value === "board") return { base: "board" };
  return value === "plan" ? { base: "full", plan: true } : { base: "full" };
}

/** Drop malformed modes from saved preferences and API patches; ids stay unique. */
export function cleanCustomModes(value: unknown): CustomMode[] {
  if (!Array.isArray(value)) return [];
  const modes: CustomMode[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isPlainRecord(raw)) continue;
    const id = typeof raw.id === "string" && /^cm_[a-z0-9]{4,24}$/.test(raw.id) ? raw.id : null;
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 40) : "";
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const description = typeof raw.description === "string" ? raw.description.trim().slice(0, 200) : "";
    const web = parseWebAccess(raw.web);
    const { base, plan } = cleanBase(raw.base);
    const approval = parseApproval(raw.approval);
    modes.push({
      id,
      name,
      ...(description ? { description } : {}),
      base,
      ...(plan || raw.plan === true ? { plan: true } : {}),
      off: cleanOff(raw.off),
      mcp: cleanMcp(raw.mcp),
      instructions: typeof raw.instructions === "string" ? raw.instructions.slice(0, MAX_INSTRUCTIONS) : "",
      ...(approval ? { approval: minApproval(approval, base) } : {}),
      ...(web ? { web } : {}),
    });
    if (modes.length >= MAX_MODES) break;
  }
  return modes;
}

/** The copy of a mode a thread carries. */
export function threadCustom(mode: CustomMode): ThreadCustomMode {
  return { id: mode.id, name: mode.name, max: mode.base, off: [...mode.off], mcp: Array.isArray(mode.mcp) ? [...mode.mcp] : mode.mcp, instructions: mode.instructions };
}

/** The highest rung the thread's custom mode allows; every rung without one. */
export function modeMax(thread: Limited): ApprovalPolicy {
  return thread.custom?.max ?? "full";
}

type Limited = Pick<Thread, "custom">;

/** Whether the thread's custom mode turns this tool group off. */
export function modeOff(thread: Limited, capability: ModeCapability): boolean {
  return thread.custom?.off.includes(capability) ?? false;
}

/** Whether the thread's custom mode keeps this MCP server of the user's. */
export function modeKeepsServer(thread: Limited, name: string): boolean {
  const mcp = thread.custom?.mcp ?? "all";
  return mcp === "all" || (mcp !== "none" && mcp.includes(name));
}

type Rung = Limited & { approval?: ApprovalPolicy };

/** What of a custom mode (and the Read-only rung's page tools) a provider session cannot change while it runs; part of every restart and spare key. */
export function customKey(thread: Rung): string {
  return (thread.custom?.off.join(",") ?? "") + (thread.approval === "readonly" ? ";readonly" : "");
}

/**
 * Tool groups of Scribe's own MCP server the thread does not get, for SCRIBE_TOOLS_OFF: the ones its
 * custom mode turns off, and on the Read-only rung the page writes ("pagewrite", #719).
 */
export function scribeToolsOff(thread: Rung): Record<string, string> {
  const off: string[] = (["helpers", "browser", "threads"] as const).filter((cap) => modeOff(thread, cap));
  if (thread.approval === "readonly") off.push("pagewrite");
  return off.length ? { SCRIBE_TOOLS_OFF: off.join(",") } : {};
}

const CLAUDE_TOOLS: Partial<Record<ModeCapability, string[]>> = {
  edit: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
  shell: ["Bash", "PowerShell", "BashOutput", "KillShell", "Monitor"],
  web: ["WebSearch", "WebFetch"],
  subagents: ["Agent", "Task"],
};

/** Claude Code tools the thread's mode takes away (disallowedTools). */
export function claudeToolsOff(thread: Limited): string[] {
  return MODE_CAPABILITIES.flatMap((cap) => (modeOff(thread, cap) ? CLAUDE_TOOLS[cap] ?? [] : []));
}

const CURSOR_TOOLS: Partial<Record<ModeCapability, string[]>> = {
  edit: ["edit", "delete", "applyAgentDiff"],
  shell: ["shell", "await"],
  web: ["webSearch", "webFetch", "fetch", "xSearch"],
  subagents: ["task"],
};

/** Cursor SDK tools the thread's mode takes away. */
export function cursorToolsOff(thread: Limited): string[] {
  return MODE_CAPABILITIES.flatMap((cap) => (modeOff(thread, cap) ? CURSOR_TOOLS[cap] ?? [] : []));
}

const PI_TOOLS: Partial<Record<ModeCapability, string[]>> = { edit: ["edit", "write"], shell: ["bash"] };

/** Pi's built-in tools the thread's mode takes away. */
export function piToolsOff(thread: Limited): string[] {
  return MODE_CAPABILITIES.flatMap((cap) => (modeOff(thread, cap) ? PI_TOOLS[cap] ?? [] : []));
}

/**
 * Codex has no per-tool switch: its shell both runs commands and edits. A mode without edits or
 * without the shell gets the read-only sandbox, the nearest setting that is not looser.
 */
export function codexReadOnly(thread: Limited): boolean {
  return modeOff(thread, "edit") || modeOff(thread, "shell");
}

/**
 * What a provider cannot do exactly as the mode asks, for the mode editor: the note says what the
 * thread gets instead. Empty when the provider follows the mode as written.
 */
export function providerNotes(mode: Pick<CustomMode, "off">, provider: ProviderId): string[] {
  const off = (cap: ModeCapability) => mode.off.includes(cap);
  const notes: string[] = [];
  if (provider === "codex") {
    if (off("edit") !== off("shell")) notes.push(`Codex cannot turn off ${off("edit") ? "edits" : "the shell"} alone: the thread runs in its read-only sandbox, where commands can read but not write.`);
    else if (off("edit")) notes.push("Codex keeps its shell for reading: the thread runs in its read-only sandbox.");
  } else if (off("edit") && !off("shell")) {
    notes.push("Shell commands can still change files.");
  }
  if (off("subagents") && (provider === "codex" || provider === "pi")) notes.push(`${provider === "codex" ? "Codex" : "Native"} has no subagents to turn off.`);
  return notes;
}

/** Appended to the thread's instructions: what the mode took away, and the user's own text. */
export function customInstructions(thread: Limited): string[] {
  const custom = thread.custom;
  if (!custom) return [];
  const gone: string[] = [];
  if (custom.off.includes("edit")) gone.push("file editing");
  if (custom.off.includes("shell")) gone.push("shell commands");
  if (custom.off.includes("web")) gone.push("web search and fetch");
  if (custom.off.includes("subagents")) gone.push("subagents");
  if (custom.off.includes("helpers")) gone.push("helper agents");
  if (custom.off.includes("browser")) gone.push("the browser tools");
  if (custom.off.includes("threads")) gone.push("reading other threads");
  const lines = ["", `Custom mode: ${custom.name}.${gone.length ? ` Turned off in this mode: ${gone.join(", ")}. Do not try to work around that; say so when a task needs one of them.` : ""}`];
  if (custom.instructions.trim()) lines.push(custom.instructions.trim());
  return lines;
}
