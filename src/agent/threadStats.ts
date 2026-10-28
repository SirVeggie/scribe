import type { ApprovalPolicy, Item, ProviderId, ScopeKind, Thread, ThreadMode, ThreadUsage, ToolKind, Turn, Usage, WebAccess } from "./types.js";
import { estimateTokens } from "./harness.js";
import { sumThreadUsage } from "./usage.js";
import { threadOrigin } from "./usageHistory.js";

/** The server and tool of an MCP call. Claude names it mcp__server__tool; the others title it "Server: tool". */
export function mcpCall(item: { name: string; title: string }): { server: string; tool: string } | null {
  const named = /^mcp__(.+?)__(.+)$/.exec(item.name);
  if (named) return { server: named[1].toLowerCase(), tool: named[2] };
  const titled = /^([\w.-]+):\s+([\w.-]+)/.exec(item.title);
  if (!titled) return null;
  const server = titled[1].toLowerCase();
  // Older Cursor threads titled Scribe's server "Board".
  return { server: server === "board" ? "scribe" : server, tool: titled[2] };
}

/** A tool's name for the table: commands some providers name by their text fold into one row. */
function toolName(item: { name: string; tool: string }): string {
  if (item.name.startsWith("`")) return "(shell command)";
  if (/^mcp__/.test(item.name) || item.tool === "mcp") return "(MCP tool)";
  return item.name || item.tool;
}

/** Tool calls of one kind in one turn, without what they read or wrote. */
export type ToolUse = {
  turnId: string;
  name: string;
  tool: ToolKind;
  mcp?: { server: string; tool: string };
  skill?: string;
  calls: number;
  errors: number;
  inputChars: number;
  outputChars: number;
  /** Estimated per call, so totals match the harness view's. */
  outputTokens: number;
  ms: number;
};

/** One entry per tool call in a turn. */
export function toolUses(items: Item[]): ToolUse[] {
  const out: ToolUse[] = [];
  for (const item of items) {
    if (item.kind !== "tool" || !item.turnId) continue;
    const call = item.tool === "mcp" || /^mcp__/.test(item.name) ? mcpCall(item) : null;
    const skill = item.name === "Skill" && item.input && typeof item.input === "object" ? (item.input as { skill?: unknown }).skill : null;
    const output = item.output?.length ?? 0;
    out.push({
      turnId: item.turnId,
      name: toolName(item),
      tool: item.tool,
      ...(call ? { mcp: call } : {}),
      ...(typeof skill === "string" ? { skill } : {}),
      calls: 1,
      errors: item.status === "error" ? 1 : 0,
      inputChars: item.input === undefined ? 0 : (JSON.stringify(item.input) ?? "").length,
      outputChars: output,
      outputTokens: estimateTokens(output),
      ms: item.endedAt ? Math.max(0, item.endedAt - item.startedAt) : 0,
    });
  }
  return out;
}

/** The same calls, one entry per turn and kind of call. */
function packToolUses(uses: ToolUse[]): ToolUse[] {
  const byKey = new Map<string, ToolUse>();
  for (const use of uses) {
    const key = [use.turnId, use.name, use.tool, use.mcp?.server ?? "", use.mcp?.tool ?? "", use.skill ?? ""].join("\n");
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, { ...use });
      continue;
    }
    cur.calls += use.calls;
    cur.errors += use.errors;
    cur.inputChars += use.inputChars;
    cur.outputChars += use.outputChars;
    cur.outputTokens += use.outputTokens;
    cur.ms += use.ms;
  }
  return [...byKey.values()];
}

type Count = { count: number; chars: number };

/** A turn as the statistics keep it: when, with what, how it ended and what it cost. */
export type TurnStats = {
  id: string;
  seq: number;
  status: Turn["status"];
  model: string;
  effort: string | null;
  mode: ThreadMode;
  startedAt: number;
  endedAt?: number;
  usage?: Usage;
  reverted?: boolean;
  interrupted?: boolean;
  /** The turn failed on a plan usage limit. */
  limited?: boolean;
  files: number;
  added: number;
  removed: number;
};

/**
 * What stays of a thread deleted with its workspace: numbers, settings and dates only. No title,
 * messages, tool input or output, file names or page ids. The workspace folder and the thread ids
 * are kept so the numbers can still be grouped.
 */
export type ThreadStats = {
  id: string;
  /** The thread this one was a helper of. */
  helperOf?: string;
  workspace: string | null;
  scope: ScopeKind;
  provider: ProviderId;
  model: string;
  effort: string | null;
  modelParams: Record<string, string>;
  mode: ThreadMode;
  approval: ApprovalPolicy;
  web: WebAccess;
  worktree: boolean;
  forked: boolean;
  /** Every user message came from a page (a board worker's chat). */
  fromPage: boolean;
  /** The board worker that ran it and the board and card number it worked (usageHistory.ts); no card title. */
  worker?: string;
  card?: { board: string; num: number };
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  activityAt: number;
  deletedAt: number;
  /** Totals over its turns (reverted ones left out). */
  usage?: ThreadUsage;
  turns: TurnStats[];
  tools: ToolUse[];
  messages: {
    /** Typed by the user. */
    user: Count;
    /** Sent by a page, by Scribe, or by the agent a helper works for. */
    sent: Count;
    text: Count;
    reasoning: Count & { ms: number };
    plans: Count;
    attachments: { count: number; bytes: number };
    approvals: number;
    questions: number;
    todos: number;
    notices: number;
  };
};

export function threadStats(thread: Thread, turns: Turn[], items: Item[], workspace: string | null, deletedAt: number): ThreadStats {
  const messages: ThreadStats["messages"] = {
    user: { count: 0, chars: 0 },
    sent: { count: 0, chars: 0 },
    text: { count: 0, chars: 0 },
    reasoning: { count: 0, chars: 0, ms: 0 },
    plans: { count: 0, chars: 0 },
    attachments: { count: 0, bytes: 0 },
    approvals: 0,
    questions: 0,
    todos: 0,
    notices: 0,
  };
  const add = (into: Count, text: string) => {
    into.count += 1;
    into.chars += text.length;
  };
  for (const item of items) {
    if (item.kind === "user") {
      if (item.dropped) continue;
      add(item.from ? messages.sent : messages.user, item.text);
      for (const file of [...(item.images ?? []), ...(item.files ?? [])]) {
        messages.attachments.count += 1;
        messages.attachments.bytes += file.size ?? 0;
      }
    } else if (item.kind === "text") add(messages.text, item.text);
    else if (item.kind === "component") add(messages.text, item.summary ?? item.fallback ?? item.title ?? "Interactive component");
    else if (item.kind === "reasoning") {
      add(messages.reasoning, item.text);
      if (item.endedAt) messages.reasoning.ms += Math.max(0, item.endedAt - item.startedAt);
    } else if (item.kind === "plan") add(messages.plans, item.text);
    else if (item.kind === "approval") messages.approvals += 1;
    else if (item.kind === "question") messages.questions += 1;
    else if (item.kind === "todos") messages.todos += 1;
    else if (item.kind === "notice") messages.notices += 1;
  }
  const usage = sumThreadUsage(turns);
  const origin = threadOrigin(items, thread.scope.kind === "page" ? thread.scope.ref : null);
  return {
    id: thread.id,
    ...(thread.helperOf ? { helperOf: thread.helperOf } : {}),
    workspace,
    scope: thread.scope.kind,
    provider: thread.provider,
    model: thread.model,
    effort: thread.effort,
    modelParams: { ...thread.modelParams },
    mode: thread.mode,
    approval: thread.approval,
    web: thread.web,
    worktree: Boolean(thread.worktree),
    forked: Boolean(thread.fork),
    fromPage: messages.sent.count > 0 && messages.user.count === 0,
    ...(origin.worker ? { worker: origin.worker } : {}),
    ...(origin.card ? { card: { board: origin.card.board, num: origin.card.num } } : {}),
    pinned: thread.pinned,
    archived: thread.archived,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    activityAt: thread.activityAt,
    deletedAt,
    ...(usage ? { usage } : {}),
    turns: turns.map((turn) => ({
      id: turn.id,
      seq: turn.seq,
      status: turn.status,
      model: turn.model,
      effort: turn.effort,
      mode: turn.mode,
      startedAt: turn.startedAt,
      ...(turn.endedAt ? { endedAt: turn.endedAt } : {}),
      ...(turn.usage ? { usage: turn.usage } : {}),
      ...(turn.reverted ? { reverted: true } : {}),
      ...(turn.interrupted ? { interrupted: true } : {}),
      ...(turn.limitResetsAt ? { limited: true } : {}),
      files: turn.files?.length ?? 0,
      added: (turn.files ?? []).reduce((n, file) => n + file.added, 0),
      removed: (turn.files ?? []).reduce((n, file) => n + file.removed, 0),
    })),
    tools: packToolUses(toolUses(items)),
    messages,
  };
}
