import type { PageRunView } from "../agent/pageRuns.js";
import type { BoardState } from "../types.js";
import {
  ActionError,
  arr,
  newId,
  str,
  type ActionContext,
  type ActionOutcome,
  type ActionSet,
  type InboundReply,
  type ReplyOutcome,
  type RunEvent,
  type SweepContext,
  type ThreadRunInfo,
} from "./types.js";
import { applyStateOps } from "../stateOps.js";
import { claimOps, driveWorkers, workerLaunched, workerReady, workerStartOps } from "./kanbanWorkers.js";

/** Rules the Kanban page follows too: done time, column order, card numbers, claims. Keep them in step. */

export type Column = { id: string; title: string; role?: string; wip?: number; paused?: boolean };
type Label = { id: string; name: string; color?: string };
/** `by` is `"user"` for the person, the assignee/worker name for an agent, or `"agent"` on older comments. */
export type Comment = { id: string; by: string; at: number; text: string };
export type Status = { kind: string; text: string };
/** waiting: set while the holder's turn waits on the user; keeps the status to put back after. */
export type Claim = { holder: string; session?: string; thread?: string; at: number; seenAt?: number; stale?: boolean; from?: string; waiting?: { status: Status | null } };
export type Card = {
  id: string;
  num: number;
  col: string;
  title: string;
  description?: string;
  labels?: string[];
  priority?: number;
  due?: string;
  assignee?: string;
  threadAssignee?: string;
  checklist?: Array<{ id: string; text: string; done: boolean }>;
  comments?: Comment[];
  images?: unknown[];
  blockedBy?: string[];
  status?: Status;
  claim?: Claim;
  /** Last in-app agent thread that claimed the card; kept after the claim ends. */
  thread?: string;
  /** Last worker chat's token totals (set by the page when that chat ends). */
  usage?: UsageTotals & {
    at?: number;
    thread?: string;
  };
  /** Last agent column this card entered; sweep/release/changes return it there. */
  from?: string;
  archived?: boolean;
  createdAt?: number;
  /** Original creator, independent of later assignments and claims. */
  createdBy?: string;
  createdThread?: string;
  movedAt?: number;
  doneAt?: number;
};

/** A thread that ended this long ago, or an MCP session quiet this long, no longer holds its card. */
const THREAD_STALE_MS = 30 * 60 * 1000;
const SESSION_STALE_MS = 60 * 60 * 1000;
const STATUS_KINDS = ["working", "blocked", "info"];

export const columns = (state: BoardState) => arr<Column>(state.columns);
const labels = (state: BoardState) => arr<Label>(state.labels);
export const cards = (state: BoardState) => arr<Card>(state.cards);
export const cardPath = (card: Card) => `cards/id=${card.id}`;

/** The blocked status a card shows while its agent waits on the user. */
function waitingText(asking: NonNullable<Extract<ThreadRunInfo, { exists: true }>["asking"]>): string {
  if (asking.kind === "approval") return `Waiting for your approval: ${asking.title}`;
  if (asking.kind === "plan") return "Waiting for you to review the plan";
  const what = asking.page ? asking.page.title || asking.page.key : asking.title;
  return `Waiting for your answer: ${what}`.slice(0, 300);
}

/** A one-card run from the card menu (`settings.workers[id].solo[threadId]`). */
export type SoloRun = {
  card?: number;
  at?: number;
  /** A Continue's run: only a turn started since then counts. */
  after?: number;
  wait?: { until?: number; count?: number; tries?: number };
  step?: { token: string; at: number };
};

/** An agent worker, set up on the page in settings.workers by its id. It takes the ready cards assigned to its name. */
export type Worker = {
  name?: string;
  instructions?: string;
  /** "fresh": one card per chat. */
  context?: string;
  provider?: string;
  model?: string;
  effort?: string;
  /** "true" | "false", or a provider's own fast setting. */
  fast?: string;
  mode?: string;
  customMode?: string;
  cwd?: string;
  approval?: string;
  worktree?: boolean;
  web?: string;
  show?: string;
  helpers?: boolean;
  threadId?: string;
  stop?: boolean;
  run?: { since?: number; card?: number; startedAt?: number } | null;
  step?: { token: string; at: number } | null;
  /** The chat whose branch didn't merge when the worker paused; the next start merges it first. */
  merge?: string | null;
  error?: string | null;
  fails?: number | null;
  /** Cards a merge pause sent back to their ready column; they go on to review once it merges. */
  mergeCards?: string[] | null;
  solo?: Record<string, SoloRun | null | undefined>;
};

/** How long a page holds a worker's step before another window may take over: covers a permission prompt. */
export const STEP_LEASE_MS = 15 * 60 * 1000;
/** Newest lines kept in `settings.workerLog` (the page trims; this caps a read). */
export const MAX_WORKER_LOG = 200;
const DEFAULT_LOG_LIMIT = 80;

const USAGE_KEYS = ["turns", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "costUsd", "estimatedCostUsd", "reportedCostUsd", "promptTokens", "threads"] as const;

export type UsageTotals = {
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  estimatedCostUsd?: number;
  reportedCostUsd?: number;
  promptTokens?: number;
  threads?: number;
  costPartial?: boolean;
  main?: UsageTotals;
  helpers?: UsageTotals;
};

export function compactUsage(value: unknown, breakdown = true): UsageTotals | undefined {
  if (!value || typeof value !== "object") return undefined;
  const src = value as Record<string, unknown>;
  const out: UsageTotals = {};
  for (const key of USAGE_KEYS) {
    const n = Number(src[key]);
    if (Number.isFinite(n) && (n > 0 || n === 0 && src[key] !== undefined && ["promptTokens", "costUsd", "estimatedCostUsd", "reportedCostUsd"].includes(key))) out[key] = n;
  }
  if (src.costPartial === true) out.costPartial = true;
  if (breakdown) for (const key of ["main", "helpers"] as const) {
    const part = compactUsage(src[key], false);
    if (part) out[key] = part;
  }
  return Object.keys(out).length ? out : undefined;
}

function cardUsage(value: unknown): (UsageTotals & { at?: number; thread?: string }) | undefined {
  const usage = compactUsage(value);
  if (!usage) return undefined;
  const src = value as { at?: unknown; thread?: unknown };
  const at = Number(src.at);
  const thread = str(src.thread);
  return { ...usage, ...(Number.isFinite(at) && at > 0 ? { at } : {}), ...(thread ? { thread } : {}) };
}

/** One line in the board's worker log: starts, pauses, merges, usage-limit waits. */
export type WorkerLogEntry = {
  id?: string;
  at?: number;
  kind?: string;
  text?: string;
  worker?: string;
  workerId?: string;
  card?: number;
  thread?: string;
  usage?: UsageTotals;
};

export function workerLogEntries(state: BoardState): WorkerLogEntry[] {
  const settings = state.settings as { workerLog?: unknown } | undefined;
  return arr<WorkerLogEntry>(settings?.workerLog).filter((e) => Boolean(e) && typeof e === "object");
}

function compactLog(e: WorkerLogEntry): Record<string, unknown> {
  const card = Number(e.card);
  const usage = compactUsage(e.usage);
  return {
    at: Number(e.at) || 0,
    kind: str(e.kind) || "info",
    text: str(e.text),
    ...(str(e.worker) ? { worker: str(e.worker) } : {}),
    ...(str(e.workerId) ? { workerId: str(e.workerId) } : {}),
    ...(Number.isFinite(card) && card > 0 ? { card } : {}),
    ...(str(e.thread) ? { thread: str(e.thread) } : {}),
    ...(usage ? { usage } : {}),
  };
}

export function workerMap(state: BoardState): Record<string, Worker> {
  const settings = state.settings as { workers?: Record<string, Worker> } | undefined;
  const all = settings?.workers;
  return all && typeof all === "object" ? all : {};
}

/** The workers as [id, worker] pairs, skipping broken entries. */
export function workerList(state: BoardState): Array<[string, Worker]> {
  return Object.entries(workerMap(state)).filter((e): e is [string, Worker] => Boolean(e[1]) && typeof e[1] === "object");
}

/** A worker by id, else by name. */
export function findWorker(state: BoardState, ref: unknown): [string, Worker] {
  const text = str(ref).trim();
  const list = workerList(state);
  const found = list.find(([id]) => id === text) ?? list.find(([, w]) => str(w.name).trim().toLowerCase() === text.toLowerCase());
  if (!found) throw new ActionError(`no agent worker "${text}"`);
  return found;
}

/** Title, description, comments, checklist, status, assignee, and card number for `list` q. */
function searchHay(c: Card): string {
  const comments = arr<Comment>(c.comments)
    .map((cm) => str(cm.text))
    .join("\n");
  const checks = arr<unknown>(c.checklist)
    .map((it) => (typeof it === "string" ? it : str((it as { text?: string } | null)?.text)))
    .join("\n");
  const status = c.status ? str(c.status.text) : "";
  return `#${c.num} ${c.num} ${str(c.title)}\n${str(c.description)}\n${comments}\n${checks}\n${status}\n${str(c.assignee)}`.toLowerCase();
}

function matchesQuery(c: Card, q: unknown): boolean {
  const words = str(q)
    .toLowerCase()
    .replace(/^#/, "")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return true;
  const hay = searchHay(c);
  return words.every((w) => hay.includes(w));
}

function findCard(state: BoardState, ref: unknown): Card {
  const text = str(ref).trim().replace(/^#/, "");
  if (!text) {
    throw new ActionError('args.card is required (card number or id). Put card inside args, e.g. {"action":"get","args":{"card":12}}.');
  }
  const list = cards(state);
  const found = /^\d+$/.test(text) ? list.find((c) => c.num === Number(text)) : list.find((c) => c.id === text);
  if (!found) {
    throw new ActionError(`no card ${/^\d+$/.test(text) ? "#" + text : text}`);
  }
  return found;
}

/** Columns matching a role (all of them), else one by id or title. */
function matchColumns(state: BoardState, ref: unknown): Column[] {
  const text = str(ref).trim();
  const cols = columns(state);
  const lower = text.toLowerCase();
  const byRole = cols.filter((c) => c.role === lower);
  if (byRole.length) return byRole;
  const one = cols.find((c) => c.id === text) ?? cols.find((c) => c.title.trim().toLowerCase() === lower);
  if (one) return [one];
  const known = cols.map((c) => (c.role ? `${c.title} (${c.role})` : c.title)).join(", ");
  throw new ActionError(`no column "${text}". Columns: ${known}`);
}

/** One column by role, id, or title. A shared role (two agent inboxes) is not a destination. */
function findColumn(state: BoardState, ref: unknown): Column {
  const found = matchColumns(state, ref);
  if (found.length > 1) {
    const names = found.map((c) => c.title).join(", ");
    throw new ActionError(`column "${str(ref).trim()}" matches more than one column: ${names}. Use a column id or title.`);
  }
  return found[0];
}

export function roleColumn(state: BoardState, role: string): Column | undefined {
  return columns(state).find((c) => c.role === role);
}

export function columnById(state: BoardState, id: string | undefined): Column | undefined {
  return id ? columns(state).find((c) => c.id === id) : undefined;
}

function inDoneColumn(state: BoardState, card: Card): boolean {
  return columnById(state, card.col)?.role === "done";
}

/** Left-to-right on the board; cards in the same column keep their current order. */
function byBoardOrder(state: BoardState, list: Card[]): Card[] {
  const index = new Map(columns(state).map((c, i) => [c.id, i]));
  return [...list].sort((a, b) => (index.get(a.col) ?? 9999) - (index.get(b.col) ?? 9999));
}

/** Agent column the card was in (or last came from) when this claim started. */
export function claimFrom(state: BoardState, card: Card): string | undefined {
  const current = columnById(state, card.col);
  if (current?.role === "agent") return current.id;
  return columnById(state, card.from)?.id ?? columnById(state, card.claim?.from)?.id;
}

export function soloRunOf(w: Worker, threadId: string): SoloRun | undefined {
  const run = w.solo?.[threadId];
  return run && typeof run === "object" ? run : undefined;
}

/**
 * Last turn of an idle thread, or null if it is gone. Throws while the agent is still working, or
 * while Scribe still sees its run through (a limit wait, a merge, a merge fix).
 */
function workerLastTurn(info: ThreadRunInfo | undefined): Extract<ThreadRunInfo, { exists: true }>["lastTurn"] | null {
  if (!info?.exists) return null;
  if (info.running || !info.lastTurn || info.lastTurn.status === "running") throw new ActionError("the agent is still working");
  if (info.run && info.run.phase !== "ended") throw new ActionError(info.run.phase === "waiting" ? "the agent waits for its usage limit to reset" : "Scribe is still seeing the agent through");
  const { status, endedAt, error, limitResetsAt, usageRecoveryAllowed } = info.lastTurn;
  return { status, ...(endedAt ? { endedAt } : {}), ...(error ? { error } : {}), ...(limitResetsAt ? { limitResetsAt } : {}), ...(usageRecoveryAllowed !== undefined ? { usageRecoveryAllowed } : {}) };
}

/** Thread token totals from runInfo, once workerLastTurn has confirmed the chat is idle. */
function workerUsage(info: ThreadRunInfo | undefined): UsageTotals | undefined {
  if (!info?.exists) return undefined;
  return compactUsage(info.usage);
}

function workerStepResult(info: ThreadRunInfo | undefined): { lastTurn: ReturnType<typeof workerLastTurn>; usage?: UsageTotals; run?: PageRunView } {
  const lastTurn = workerLastTurn(info);
  const usage = workerUsage(info);
  const run = info?.exists ? info.run : undefined;
  return { lastTurn, ...(usage ? { usage } : {}), ...(run ? { run } : {}) };
}

/**
 * The thread is a worker chat the board will send on after a plan limit resets: its own run, or a
 * one-card run from the card menu (`solo`).
 */
function workerWaits(state: BoardState, threadId: string): boolean {
  return workerList(state).some(([, w]) => (w.threadId === threadId && Boolean(w.run)) || Boolean(soloRunOf(w, threadId)));
}

export function resetTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** Where a stopped or released card goes: the inbox it came from, else the first agent column. */
export function returnColumn(state: BoardState, card: Card): Column | undefined {
  return columnById(state, card.claim?.from) ?? columnById(state, card.from) ?? roleColumn(state, "agent");
}

function labelIds(state: BoardState, refs: unknown): string[] {
  return arr(refs).map((ref) => {
    const text = str(ref).trim();
    const found = labels(state).find((l) => l.id === text || l.name.toLowerCase() === text.toLowerCase());
    if (!found) {
      throw new ActionError(`no label "${text}". Labels: ${labels(state).map((l) => l.name).join(", ") || "none"}`);
    }
    return found.id;
  });
}

/** Where a card lands in `cards` when it enters a column: on top, or after the column's last card. */
export function placement(state: BoardState, colId: string, top: boolean, except?: string): Record<string, unknown> {
  const inCol = cards(state).filter((c) => c.col === colId && c.id !== except);
  if (!inCol.length) {
    return { at: "end" };
  }
  return top ? { before: `id=${inCol[0].id}` } : { after: `id=${inCol[inCol.length - 1].id}` };
}

/** Ops that move a card into a column, with the page's timestamp rules. Defaults to the top. */
export function moveOps(state: BoardState, card: Card, col: Column, now: number, position?: unknown): unknown[] {
  const done = col.role === "done";
  const top = position === undefined || position === "top";
  const fields: Record<string, unknown> = {};
  if (card.col !== col.id) {
    fields.col = col.id;
    fields.movedAt = now;
  }
  if (col.role === "agent") fields.from = col.id;
  if (done && !card.doneAt) fields.doneAt = now;
  if (!done && card.doneAt) fields.doneAt = null;
  const ops: unknown[] = [];
  if (Object.keys(fields).length) ops.push({ op: "merge", path: cardPath(card), value: fields });
  if (card.col !== col.id || position !== undefined) {
    ops.push({ op: "move", path: cardPath(card), ...placement(state, col.id, top, card.id) });
  }
  return ops;
}

function summary(state: BoardState, card: Card) {
  const col = columns(state).find((c) => c.id === card.col);
  const comments = arr<Comment>(card.comments);
  const last = comments.at(-1);
  const usage = cardUsage(card.usage);
  return {
    num: card.num,
    id: card.id,
    title: card.title,
    column: col?.title ?? card.col,
    ...(col?.role ? { role: col.role } : {}),
    labels: arr<string>(card.labels).map((id) => labels(state).find((l) => l.id === id)?.name ?? id),
    ...(card.priority ? { priority: card.priority } : {}),
    ...(card.due ? { due: card.due } : {}),
    ...(card.assignee ? { assignee: card.assignee } : {}),
    ...(card.createdBy ? { createdBy: card.createdBy } : {}),
    ...(card.createdThread ? { createdThread: card.createdThread } : {}),
    ...(card.status ? { status: card.status } : {}),
    ...(card.claim ? { claim: { holder: card.claim.holder, at: card.claim.at, ...(card.claim.stale ? { stale: true } : {}) } } : {}),
    ...(arr(card.blockedBy).length
      ? { blockedBy: arr<string>(card.blockedBy).map((id) => cards(state).find((c) => c.id === id)?.num ?? id) }
      : {}),
    comments: comments.length,
    ...(last ? { lastComment: { by: last.by, at: last.at } } : {}),
    ...(card.archived ? { archived: true } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** The same text, give or take spacing and case: a summary that only repeats a comment. */
function sameText(a: string, b: string): boolean {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) === norm(b);
}

function isUserComment(by: string): boolean {
  return !str(by).trim() || str(by).trim().toLowerCase() === "user";
}

function commentOp(card: Card, by: string, text: string, now: number): unknown {
  return { op: "insert", path: `${cardPath(card)}/comments`, value: { id: newId("cm"), by, at: now, text } };
}

function checkStatus(value: unknown): { kind: string; text: string } | null {
  if (value === null) return null;
  const status = value as { kind?: unknown; text?: unknown };
  const kind = str(status?.kind || "working");
  if (!STATUS_KINDS.includes(kind)) {
    throw new ActionError(`status.kind must be one of ${STATUS_KINDS.join(", ")}`);
  }
  return { kind, text: str(status?.text) };
}

function claimFor(ctx: ActionContext, now: number, from?: string): Claim {
  const caller = ctx.caller;
  return {
    holder: caller.label || (caller.by === "agent" ? "agent" : "user"),
    ...(caller.session ? { session: caller.session } : {}),
    ...(caller.thread ? { thread: caller.thread } : {}),
    at: now,
    seenAt: now,
    ...(from ? { from } : {}),
  };
}

function sameHolder(claim: Claim, ctx: ActionContext): boolean {
  const caller = ctx.caller;
  if (claim.thread && caller.thread) return claim.thread === caller.thread;
  return Boolean(claim.session && claim.session === caller.session);
}

const PROVIDER_ASSIGNEE: Record<string, string> = { claude: "Claude", cursor: "Cursor", codex: "Codex" };

/** Who shows on the card: an explicit arg, else the MCP client name, else Claude/Cursor from the in-app thread. */
function claimAssignee(args: Record<string, unknown>, ctx: ActionContext): string {
  if (args.assignee !== undefined) {
    const name = str(args.assignee).trim().slice(0, 60);
    if (!name) throw new ActionError("assignee is empty");
    return name;
  }
  const label = ctx.caller.label?.trim() ?? "";
  if (label && label !== "agent" && !label.startsWith("Scribe chat:")) return label.slice(0, 60);
  return PROVIDER_ASSIGNEE[ctx.caller.provider ?? ""] || "agent";
}

/** Name stored on an agent's comment: the worker on this thread, else the card's assignee. */
function commentAuthor(state: BoardState, card: Pick<Card, "assignee">, ctx: ActionContext): string {
  if (ctx.caller.by !== "agent") return "user";
  const thread = str(ctx.caller.thread);
  if (thread) {
    for (const [, w] of workerList(state)) {
      const name = str(w.name).trim().slice(0, 60);
      if (!name) continue;
      if (str(w.threadId) === thread || soloRunOf(w, thread)) return name;
    }
  }
  const assignee = str(card.assignee).trim().slice(0, 60);
  if (assignee && assignee.toLowerCase() !== "agent") return assignee;
  return claimAssignee({}, ctx);
}

/** Longest reply comment; a longer one is cut and points to the form for the rest. */
const REPLY_TEXT_MAX = 4000;

function replyValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(replyValue).filter(Boolean).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

/**
 * A reply as the card's comment: a summary line with a peek link to the form, then the answers.
 * Short answers are a list; longer or multi-line ones get a quote each. The agent reads them with
 * the card, without reading the form's state.
 */
export function replyComment(reply: InboundReply): string {
  const link = `[[peek:${reply.from.key}]]`;
  const head = reply.summary ? `**Reply from ${link}:** ${reply.summary}` : `**Reply from ${link}**`;
  const short: string[] = [];
  const long: string[] = [];
  for (const [name, raw] of Object.entries(reply.data)) {
    const value = replyValue(raw);
    if (!value) continue;
    if (value.length <= 80 && !value.includes("\n")) short.push(`- **${name}:** ${value}`);
    else long.push(`**${name}:**\n${value.split(/\r?\n/).map((line) => `> ${line}`).join("\n")}`);
  }
  const text = [head, short.join("\n"), ...long].filter(Boolean).join("\n\n");
  if (text.length <= REPLY_TEXT_MAX) return text;
  return `${text.slice(0, REPLY_TEXT_MAX).trimEnd()}…\n\n_Cut short: the rest is on ${link}._`;
}

/** The name a chat works a card under: its worker's, else the card's assignee. */
function threadAssignee(state: BoardState, card: Card, thread: string): string {
  for (const [, w] of workerList(state)) {
    const name = str(w.name).trim().slice(0, 60);
    if (name && (str(w.threadId) === thread || soloRunOf(w, thread))) return name;
  }
  return str(card.assignee).trim().slice(0, 60) || "agent";
}

function cardEvent(state: BoardState, card: Card): Record<string, unknown> {
  const col = columnById(state, card.col);
  return { card: card.id, num: card.num, column: col?.title ?? null, columnId: card.col, ...(col?.role ? { role: col.role } : {}) };
}

/** A whole card for get: the summary's resolved names, with the comments themselves instead of their count. */
function fullCard(state: BoardState, card: Card): Record<string, unknown> {
  const { comments: _count, lastComment: _last, ...brief } = summary(state, card);
  return { ...card, ...brief, comments: arr<Comment>(card.comments), labelIds: arr(card.labels) };
}

const MAX_GET_CARDS = 30;
const MAX_BATCH = 100;

/** update's ops: field changes, then an optional comment and move, so a triage step is one call. */
function updateOps(state: BoardState, args: Record<string, unknown>, ctx: ActionContext): unknown[] {
  const card = findCard(state, args.card);
  const fields: Record<string, unknown> = {};
  if (args.title !== undefined) fields.title = str(args.title);
  if (args.description !== undefined) fields.description = str(args.description);
  if (args.labels !== undefined) fields.labels = labelIds(state, args.labels);
  if (args.priority !== undefined) fields.priority = Math.max(0, Math.min(4, Math.floor(Number(args.priority) || 0)));
  if (args.due !== undefined) fields.due = args.due === null ? null : str(args.due);
  if (args.assignee !== undefined) fields.assignee = args.assignee === null ? null : str(args.assignee);
  if (args.status !== undefined) fields.status = checkStatus(args.status);
  if (args.blockedBy !== undefined) fields.blockedBy = arr(args.blockedBy).map((ref) => findCard(state, ref).id);
  if (args.checklist !== undefined) {
    fields.checklist = arr(args.checklist).map((item) => {
      const entry = typeof item === "object" && item ? (item as { text?: unknown; done?: unknown }) : { text: item };
      return { id: newId("ck"), text: str(entry.text), done: Boolean(entry.done) };
    });
  }
  const comment = args.comment !== undefined ? str(args.comment).trim() : "";
  if (args.comment !== undefined && !comment) throw new ActionError("comment is empty");
  if (args.position !== undefined && args.position !== "top" && args.position !== "bottom") {
    throw new ActionError('position is "top" or "bottom"');
  }
  if (args.position !== undefined && args.to === undefined) throw new ActionError("position needs to");
  const col = args.to !== undefined ? findColumn(state, args.to) : undefined;
  if (!Object.keys(fields).length && !comment && !col) throw new ActionError("nothing to change");
  const ops: unknown[] = [];
  if (Object.keys(fields).length) ops.push({ op: "merge", path: cardPath(card), value: fields });
  if (comment) ops.push(commentOp(card, commentAuthor(state, { ...card, ...(fields as Partial<Card>) }, ctx), comment, ctx.now));
  if (col) ops.push(...moveOps(state, card, col, ctx.now, args.position));
  return ops;
}

/** Writes answer lean: the card's number and where it now is, not the whole row again. */
function updateResult(state: BoardState, args: Record<string, unknown>): { num: number; column: string } {
  const card = findCard(state, args.card);
  const col = args.to !== undefined ? findColumn(state, args.to) : columnById(state, card.col);
  return { num: card.num, column: col?.title ?? card.col };
}

export const kanbanActions: ActionSet = {
  seed(state, values) {
    // Match the page's ensureShape fallback for older boards. Never replace custom starting columns.
    if (columns(state).length) return state;
    const presets: Record<string, Array<[string, string?, number?]>> = {
      simple: [["To do"], ["Doing"], ["Done", "done"]],
      dev: [["Backlog"], ["Ready"], ["In progress", undefined, 3], ["Review"], ["Done", "done"]],
      agent: [["Inbox"], ["Ready for agent", "agent"], ["Agent working", "working"], ["Needs review", "review"], ["Done", "done"]],
    };
    const preset = Object.hasOwn(presets, str(values.preset)) ? presets[str(values.preset)] : presets.dev;
    state.columns = preset.map(([title, role, wip]) => ({
      id: newId("col"), title,
      ...(role ? { role } : {}),
      ...(wip ? { wip } : {}),
    }));
    if (!labels(state).length) {
      state.labels = [["Bug", "#ff6b7a"], ["Feature", "#6ea8ff"], ["Chore", "#8b95a8"]]
        .map(([name, color]) => ({ id: newId("lb"), name, color }));
    }
    return state;
  },
  actions: {
    list: {
      description:
        "Compact rows for the board's cards (no descriptions or comment text), plus the columns and the agent workers (stopRequested: true on one the user asked to stop). Filter by column (role for every column with that role, or id or title), label, assignee, or q (words in title, description, comments, or checklist). Rows follow board column order. With no column, done-role cards are omitted unless done: true (only that role) or q (search still finds them). Archived cards only with archived: true.",
      args: "{ column?, label?, assignee?, q?, archived?, done?, limit? }",
      run(state, args) {
        let list = cards(state).filter((c) => (args.archived ? c.archived : !c.archived));
        if (args.column !== undefined) {
          const ids = new Set(matchColumns(state, args.column).map((c) => c.id));
          list = list.filter((c) => ids.has(c.col));
        } else if (!args.archived) {
          if (args.done) {
            list = list.filter((c) => inDoneColumn(state, c));
          } else if (args.q === undefined) {
            list = list.filter((c) => !inDoneColumn(state, c));
          }
        }
        if (args.label !== undefined) {
          const [id] = labelIds(state, [args.label]);
          list = list.filter((c) => arr(c.labels).includes(id));
        }
        if (args.assignee !== undefined) {
          const who = str(args.assignee).trim().toLowerCase();
          list = list.filter((c) => str(c.assignee).trim().toLowerCase() === who);
        }
        if (args.q !== undefined) {
          list = list.filter((c) => matchesQuery(c, args.q));
        }
        list = byBoardOrder(state, list);
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 200;
        return {
          ops: [],
          result: {
            columns: columns(state).map((c) => ({
              id: c.id,
              title: c.title,
              ...(c.role ? { role: c.role } : {}),
              ...(c.paused ? { paused: true } : {}),
              cards: cards(state).filter((x) => x.col === c.id && !x.archived).length,
            })),
            ...(workerList(state).length
              ? {
                  workers: workerList(state).map(([id, w]) => ({
                    id,
                    name: str(w.name) || id,
                    ...(w.run ? { running: true } : {}),
                    ...(w.stop === true ? { stopRequested: true } : {}),
                  })),
                }
              : {}),
            cards: list.slice(0, limit).map((c) => summary(state, c)),
            ...(list.length > limit ? { more: list.length - limit } : {}),
          },
        };
      },
    },
    get: {
      description:
        `One card in full: description, checklist, comments, images (attached so you can see them), with column and label names resolved. cards: [12, 13, …] reads up to ${MAX_GET_CARDS} at once as { cards, missing? }.`,
      args: "{ card } | { cards: [num] }",
      run(state, args) {
        if (args.cards === undefined) return { ops: [], result: fullCard(state, findCard(state, args.card)) };
        const refs = arr(args.cards);
        if (!refs.length) throw new ActionError("cards is a list of card numbers");
        if (refs.length > MAX_GET_CARDS) throw new ActionError(`get reads up to ${MAX_GET_CARDS} cards at once`);
        const found: Record<string, unknown>[] = [];
        const missing: unknown[] = [];
        for (const ref of refs) {
          try {
            found.push(fullCard(state, findCard(state, ref)));
          } catch (err) {
            if (!(err instanceof ActionError)) throw err;
            missing.push(ref);
          }
        }
        return { ops: [], result: { cards: found, ...(missing.length ? { missing } : {}) } };
      },
    },
    logs: {
      description:
        "Recent worker log lines (starts, pauses, merges, usage-limit waits) so you can debug the board's run without Keeper process logs. Oldest first among the last `limit` (default 80, max 200). worker is a name or id; kind is start, stop, pause, launch, merge, merge_fix, blocked, limit, resume, wait, solo, or done; q matches text, worker, kind, or #card. End-of-chat lines include usage { turns, inputTokens, outputTokens } when the daemon reported them.",
      args: "{ worker?, kind?, q?, limit? }",
      run(state, args) {
        let list = workerLogEntries(state);
        if (args.worker !== undefined && str(args.worker).trim()) {
          const [workerId] = findWorker(state, args.worker);
          list = list.filter((e) => str(e.workerId) === workerId || str(e.worker).trim().toLowerCase() === str(args.worker).trim().toLowerCase());
        }
        if (args.kind !== undefined && str(args.kind).trim()) {
          const kind = str(args.kind).trim().toLowerCase();
          list = list.filter((e) => str(e.kind).toLowerCase() === kind);
        }
        if (args.q !== undefined && str(args.q).trim()) {
          const words = str(args.q)
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
          list = list.filter((e) => {
            const hay = `${str(e.text)} ${str(e.worker)} ${str(e.kind)} ${e.card ? "#" + e.card : ""}`.toLowerCase();
            return words.every((w) => hay.includes(w));
          });
        }
        list = [...list].sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0) || str(a.id).localeCompare(str(b.id)));
        const limit =
          typeof args.limit === "number" && args.limit > 0
            ? Math.min(Math.floor(args.limit), MAX_WORKER_LOG)
            : DEFAULT_LOG_LIMIT;
        const slice = list.slice(-limit);
        return {
          ops: [],
          result: {
            logs: slice.map(compactLog),
            total: list.length,
            ...(list.length > slice.length ? { more: list.length - slice.length } : {}),
          },
        };
      },
    },
    create: {
      description:
        "Add a card. column defaults to the first column. labels are names or ids. The card gets the next number; position top or bottom (default top).",
      args: "{ title, description?, column?, labels?, priority?, due?, checklist?: string[], position? }",
      run(state, args, ctx) {
        const title = str(args.title).trim();
        if (!title) throw new ActionError("title is required");
        const col = args.column !== undefined ? findColumn(state, args.column) : columns(state)[0];
        if (!col) throw new ActionError("the board has no columns yet; open it once so it can set them up");
        const now = ctx.now;
        const num = Math.max(1, Math.floor(Number(state.nextNum) || 1), ...cards(state).map((c) => c.num + 1));
        const card: Card = {
          id: newId("c"),
          num,
          col: col.id,
          title,
          description: str(args.description),
          labels: labelIds(state, args.labels),
          priority: Math.max(0, Math.min(4, Math.floor(Number(args.priority) || 0))),
          ...(args.due ? { due: str(args.due) } : {}),
          checklist: arr(args.checklist).map((text) => ({ id: newId("ck"), text: str(text), done: false })),
          comments: [],
          images: [],
          blockedBy: [],
          createdAt: now,
          createdBy: commentAuthor(state, {}, ctx),
          ...(ctx.caller.by === "agent" && ctx.caller.thread ? { createdThread: ctx.caller.thread } : {}),
          movedAt: now,
          ...(col.role === "agent" ? { from: col.id } : {}),
          ...(col.role === "done" ? { doneAt: now } : {}),
        };
        const top = args.position === undefined || args.position === "top";
        return {
          ops: [
            { op: "insert", path: "cards", value: card, ...placement(state, col.id, top) },
            { op: "set", path: "nextNum", value: num + 1 },
          ],
          result: { num, id: card.id },
        };
      },
    },
    update: {
      description:
        "Change a card's fields. labels (names or ids) and checklist replace the whole list; a checklist item is a string or { text, done }. status: { kind: working | blocked | info, text }, or null to clear it. comment adds a comment and to (with position) moves the card, in the same step. Returns { num, column }.",
      args: "{ card, title?, description?, labels?, priority?, due?, assignee?, checklist?, status?, blockedBy?, comment?, to?, position? }",
      run(state, args, ctx) {
        return { ops: updateOps(state, args, ctx), result: updateResult(state, args) };
      },
    },
    batch: {
      description:
        `Update several cards in one step: changes is a list of update args ({ card, …fields, comment?, to?, position? }), up to ${MAX_BATCH}. They apply in order, all or none. Returns { cards: [{ num, column }] }.`,
      args: "{ changes: [{ card, ...update args }] }",
      run(state, args, ctx) {
        const changes = arr<Record<string, unknown>>(args.changes);
        if (!changes.length) throw new ActionError("changes is a list of update args, each with card");
        if (changes.length > MAX_BATCH) throw new ActionError(`batch takes up to ${MAX_BATCH} changes at once`);
        const ops: unknown[] = [];
        const done: unknown[] = [];
        let current = state;
        changes.forEach((change, i) => {
          if (!change || typeof change !== "object" || Array.isArray(change)) throw new ActionError(`changes[${i}] is not an object`);
          try {
            const next = updateOps(current, change, ctx);
            done.push(updateResult(current, change));
            current = applyStateOps(current, next) as BoardState;
            ops.push(...next);
          } catch (err) {
            if (err instanceof ActionError) throw new ActionError(`changes[${i}] (card ${str(change.card)}): ${err.message}; nothing was changed`);
            throw err;
          }
        });
        return { ops, result: { cards: done } };
      },
    },
    comment: {
      description: "Add a comment to a card (markdown). Agent comments show as the assignee that posted them.",
      args: "{ card, text }",
      run(state, args, ctx) {
        const card = findCard(state, args.card);
        const text = str(args.text).trim();
        if (!text) throw new ActionError("text is required");
        return { ops: [commentOp(card, commentAuthor(state, card, ctx), text, ctx.now)], result: { num: card.num, comments: arr(card.comments).length + 1 } };
      },
    },
    move: {
      description:
        "Move a card to a column (unique role agent | working | review | done, a column id, or its title). Sets the move and done times. position top or bottom (default top).",
      args: "{ card, to, position? }",
      run(state, args, ctx) {
        const card = findCard(state, args.card);
        const col = findColumn(state, args.to);
        if (args.position !== undefined && args.position !== "top" && args.position !== "bottom") {
          throw new ActionError('position is "top" or "bottom"');
        }
        return { ops: moveOps(state, card, col, ctx.now, args.position), result: { num: card.num, column: col.title } };
      },
    },
    claim: {
      description:
        "Start work on a card: moves it to the working column, sets assignee (your name, or assignee if you pass one) and a working status, and records you as its holder. Refused while another live agent holds it, and for an agent worker's chat once the user asked that worker to stop. If your thread or session stops, Scribe releases the card for you.",
      args: "{ card, text?, assignee? }",
      run(state, args, ctx) {
        const card = findCard(state, args.card);
        if (card.claim && !card.claim.stale && !sameHolder(card.claim, ctx)) {
          throw new ActionError(`#${card.num} is held by ${card.claim.holder} since ${new Date(card.claim.at).toISOString()}`);
        }
        // A worker the user asked to stop takes no further card, so its agent needs no list to check.
        const thread = str(ctx.caller.thread);
        const stopping = thread && !(card.claim && card.claim.thread === thread) && workerList(state).find(([, w]) => w.stop === true && str(w.threadId) === thread);
        if (stopping) throw new ActionError(`The user asked the worker "${str(stopping[1].name)}" to stop after its card. Take no more cards; end your turn.`);
        const working = roleColumn(state, "working");
        const from = claimFrom(state, card);
        const ops: unknown[] = [
          // Another claim landing first makes this write fail as a whole.
          { op: "test", path: `${cardPath(card)}/claim`, value: card.claim ?? null },
          {
            op: "merge",
            path: cardPath(card),
            value: {
              assignee: claimAssignee(args, ctx),
              status: { kind: "working", text: str(args.text) || "Working on it" },
              claim: claimFor(ctx, ctx.now, from),
              ...(ctx.caller.thread ? { thread: ctx.caller.thread, threadAssignee: claimAssignee(args, ctx) } : {}),
              ...(from ? { from } : {}),
            },
          },
        ];
        if (working) ops.push(...moveOps(state, card, working, ctx.now));
        return { ops, result: { num: card.num, column: working?.title ?? null } };
      },
    },
    worker_claim: {
      description:
        "The board's own bookkeeping when it starts an agent chat on a card (a worker's run, a one-card run, or Continue); only the page calls it. Claims the card for that chat under the worker's name and moves it to the working column, so the agent doesn't spend a call on it.",
      args: "{ card, thread, assignee, text? }",
      run(state, args, ctx) {
        if (ctx.caller.by !== "user") throw new ActionError("worker_claim is for the board page itself");
        const card = findCard(state, args.card);
        const thread = str(args.thread).trim();
        if (!thread) throw new ActionError("thread is required");
        const name = str(args.assignee).trim().slice(0, 60);
        if (!name) throw new ActionError("assignee is required");
        if (card.claim && !card.claim.stale && card.claim.thread !== thread) {
          throw new ActionError(`#${card.num} is held by ${card.claim.holder} since ${new Date(card.claim.at).toISOString()}`);
        }
        const working = roleColumn(state, "working");
        return { ops: claimOps(state, card, thread, name, ctx.now, str(args.text) || undefined), result: { num: card.num, column: working?.title ?? null } };
      },
    },
    release: {
      description:
        "Give a card back without finishing it: clears your claim and status and moves it (default: the column it was claimed from). note adds a comment; status (e.g. { kind: \"blocked\", text }) stays on the card.",
      args: "{ card, to?, note?, status? }",
      run(state, args, ctx) {
        const card = findCard(state, args.card);
        const col = args.to !== undefined ? findColumn(state, args.to) : returnColumn(state, card);
        const ops: unknown[] = [{ op: "merge", path: cardPath(card), value: { claim: null, status: args.status !== undefined ? checkStatus(args.status) : null } }];
        if (str(args.note).trim()) ops.push(commentOp(card, commentAuthor(state, card, ctx), str(args.note).trim(), ctx.now));
        if (col) ops.push(...moveOps(state, card, col, ctx.now));
        return { ops, result: { num: card.num, column: col?.title ?? null } };
      },
    },
    finish: {
      description:
        "Hand in finished work: posts summary as the card's hand-in comment (so do not also comment the same wrap-up), clears status and claim, and moves the card to review (or done when the board has no review column). Leave summary out to make the comment you already posted since claiming the card the hand-in.",
      args: "{ card, summary?, to? }",
      run(state, args, ctx) {
        const card = findCard(state, args.card);
        const text = str(args.summary).trim();
        // The caller's own comment from this claim, if it wrote its wrap-up as a comment already.
        const since = card.claim && sameHolder(card.claim, ctx) ? card.claim.at : Infinity;
        const own = arr<Comment>(card.comments).filter((c) => !isUserComment(c.by) && c.at >= since).at(-1);
        if (!text && !own) {
          throw new ActionError(
            "summary is required: it is posted as the card's hand-in comment (what changed, what to check). If you already posted that as a comment since claiming the card, call finish without summary and that comment is the hand-in."
          );
        }
        const repeat = Boolean(text && own && sameText(text, own.text));
        const ops: unknown[] = [...(text && !repeat ? [commentOp(card, commentAuthor(state, card, ctx), text, ctx.now)] : []), { op: "merge", path: cardPath(card), value: { claim: null, status: null } }];
        const col = args.to !== undefined ? findColumn(state, args.to) : (roleColumn(state, "review") ?? roleColumn(state, "done"));
        if (col) ops.push(...moveOps(state, card, col, ctx.now));
        return { ops, result: { num: card.num, column: col?.title ?? null, ...(text && !repeat ? {} : { handIn: "your earlier comment" }) } };
      },
    },
    worker_start: {
      description:
        "The board's own bookkeeping when the user starts an agent worker; only the page calls it. Sets the worker running, so Scribe starts its next ready card, with or without a board window open.",
      args: "{ worker }",
      run(state, args, ctx) {
        if (ctx.caller.by !== "user") throw new ActionError("worker_start is for the board page itself");
        const [workerId, w] = findWorker(state, args.worker);
        if (w.run) throw new ActionError("the worker is already running");
        const why = workerReady(state, w);
        if (why) throw new ActionError(`the worker ${why}`);
        return { ops: workerStartOps(state, workerId, w, ctx.now), result: { ok: true } };
      },
    },
    worker_step: {
      description:
        "The board's own bookkeeping for its agent workers; only the page calls it. Takes a worker for one step (start, or move on from its thread once that thread is done), so two windows don't both start the next agent.",
      args: "{ worker, from, token, start? }",
      run(state, args, ctx) {
        if (ctx.caller.by !== "user") throw new ActionError("worker_step is for the board page itself");
        const [workerId, w] = findWorker(state, args.worker);
        const token = str(args.token).trim();
        if (!token) throw new ActionError("token is required");
        if ((str(args.from) || null) !== (str(w.threadId) || null)) throw new ActionError("the worker has moved on");
        if (args.start) {
          // The page only starts a worker that isn't running, so a lease left behind is a window that went away mid-step.
          if (w.run) throw new ActionError("the worker is already running");
        } else {
          if (!w.run) throw new ActionError("the worker is not running");
          if (w.step && w.step.token !== token && w.step.at > ctx.now - STEP_LEASE_MS) throw new ActionError("another window is on it");
        }
        const step = w.threadId && ctx.thread ? workerStepResult(ctx.thread(w.threadId)) : { lastTurn: null };
        const value: Record<string, unknown> = { step: { token, at: ctx.now } };
        if (args.start) Object.assign(value, { run: { since: ctx.now }, stop: null, error: null });
        return { ops: [{ op: "merge", path: `settings/workers/${workerId}`, value }], result: { ok: true, ...step } };
      },
    },
    worker_solo_step: {
      description:
        "The board's own bookkeeping for a one-card worker run (right-click Run, or Continue); only the page calls it. Takes that chat for one step (wrap up, or send it on after a plan limit), so two windows don't both send it on.",
      args: "{ worker, thread, token }",
      run(state, args, ctx) {
        if (ctx.caller.by !== "user") throw new ActionError("worker_solo_step is for the board page itself");
        const [workerId, w] = findWorker(state, args.worker);
        const threadId = str(args.thread).trim();
        const token = str(args.token).trim();
        if (!threadId) throw new ActionError("thread is required");
        if (!token) throw new ActionError("token is required");
        const run = soloRunOf(w, threadId);
        if (!run) throw new ActionError("that chat is not a one-card run of this worker");
        if (run.step && run.step.token !== token && run.step.at > ctx.now - STEP_LEASE_MS) throw new ActionError("another window is on it");
        const step = ctx.thread ? workerStepResult(ctx.thread(threadId)) : { lastTurn: null };
        return {
          ops: [{ op: "merge", path: `settings/workers/${workerId}/solo/${threadId}`, value: { step: { token, at: ctx.now } } }],
          result: { ok: true, ...step },
        };
      },
    },
  },

  /**
   * A form page's scribe.reply about one of the cards (#320): a comment by the user, sent on to the
   * card's chat like a comment from the board's own box. Into its running turn when it works on the
   * card; else Continue for the chat that holds or last worked on it, unless that chat waits on a
   * plan limit (its resume reads the card again anyway).
   */
  reply(state: BoardState, reply: InboundReply, ctx: ActionContext): ReplyOutcome {
    if (reply.card === undefined) throw new ActionError("This reply names no card");
    const card = findCard(state, reply.card);
    const text = replyComment(reply);
    const id = newId("cm");
    const comment = { id, by: "user", at: ctx.now, text };
    const ops: unknown[] = [{ op: "insert", path: `${cardPath(card)}/comments`, value: comment }];
    const events = [{ name: "comment", data: { ...cardEvent(state, card), reply: reply.from.key } }];
    const title = str(card.title).slice(0, 200);
    const holder = card.claim && !card.claim.stale ? str(card.claim.thread) : "";
    const holderInfo = holder ? ctx.thread?.(holder) : undefined;
    if (holder && holderInfo?.exists && holderInfo.running) {
      return { ops, result: { num: card.num }, events, deliver: { thread: holder, num: card.num, title, text, resume: false, ref: { card: card.id, comment: id } } };
    }
    // A form answer on a person's/unassigned card must not restart its old worker and claim it.
    // The page offers Ask using the default worker, just as it does for a typed comment.
    const assignedWorker = str(card.assignee).trim() && workerList(state).some(([, w]) => str(w.name).trim().toLowerCase() === str(card.assignee).trim().toLowerCase());
    if (!assignedWorker) {
      const defaultId = str((state.settings as { defaultWorker?: unknown } | undefined)?.defaultWorker);
      if (workerMap(state)[defaultId]) ops[0] = { op: "insert", path: `${cardPath(card)}/comments`, value: { ...comment, followUp: "offer" } };
      return { ops, result: { num: card.num }, events };
    }
    const last = holder || str(card.thread);
    const info = last ? ctx.thread?.(last) : undefined;
    if (last && info?.exists && !info.running && info.run?.phase !== "waiting") {
      return { ops, result: { num: card.num }, events, deliver: { thread: last, num: card.num, title, text, resume: true, ref: { card: card.id, comment: id } } };
    }
    // No chat to send it to: the board's Continue button, as for any comment, when there was one.
    if (last) ops[0] = { op: "insert", path: `${cardPath(card)}/comments`, value: { ...comment, followUp: "offer" } };
    return { ops, result: { num: card.num }, events };
  },
  replyDelivered(state, deliver, delivered, ctx) {
    const card = cards(state).find((c) => c.id === deliver.ref?.card);
    if (!card) return null;
    const i = arr<Comment>(card.comments).findIndex((cm) => cm.id === deliver.ref?.comment);
    const path = `${cardPath(card)}/comments/id=${deliver.ref?.comment}`;
    if (!delivered) {
      return i < 0 || !card.thread ? null : { ops: [{ op: "merge", path, value: { followUp: "offer" } }], result: null };
    }
    if (!deliver.resume) {
      return i < 0 ? null : { ops: [{ op: "merge", path, value: { sent: delivered === "steered" ? "steered" : "queued" } }], result: null };
    }
    // Continue: claim the card for that chat again, as the board's Continue button does.
    const ops: unknown[] = i < 0 ? [] : [{ op: "merge", path, value: { followUp: "continued" } }];
    if (!card.claim || card.claim.stale || card.claim.thread === deliver.thread) {
      const from = claimFrom(state, card);
      const name = threadAssignee(state, card, deliver.thread);
      ops.push({
        op: "merge",
        path: cardPath(card),
        value: {
          assignee: name,
          status: { kind: "working", text: "Agent continuing after a reply" },
          claim: { holder: name, thread: deliver.thread, at: ctx.now, seenAt: ctx.now, ...(from ? { from } : {}) },
          thread: deliver.thread,
          threadAssignee: name,
          ...(from ? { from } : {}),
        },
      });
      const working = roleColumn(state, "working");
      if (working && working.id !== card.col) ops.push(...moveOps(state, card, working, ctx.now));
    }
    return { ops, result: null };
  },
  sweep(state: BoardState, ctx: SweepContext): ActionOutcome | null {
    const ops: unknown[] = [];
    const events: ActionOutcome["events"] = [];
    for (const card of cards(state)) {
      const claim = card.claim;
      if (!claim || claim.stale) continue;
      let release: string | null = null;
      let stale: string | null = null;
      let waiting: string | null = null;
      let working = false;
      if (claim.thread) {
        const info = ctx.thread(claim.thread);
        working = info.exists && (info.running || info.lastTurn?.status === "done") && info.outputAt !== undefined && info.outputAt >= claim.at;
        if (info.exists && info.running && info.asking) {
          // A worker's turn asking the user (page_ask, a question, an approval) holds its column up: say so on the card.
          waiting = waitingText(info.asking);
        } else if (!info.exists) {
          // Prewarm starts MCP with a throwaway draft id; the real thread is created later.
          // That draft is not in AgentHost, so "missing thread" is not "agent gone" while the
          // MCP session is still calling.
          const seen = claim.session ? Math.max(ctx.sessionSeenAt(claim.session) ?? 0, claim.seenAt ?? claim.at) : 0;
          if (claim.session && seen >= ctx.now - SESSION_STALE_MS) {
            /* still live */
          } else {
            release = "The chat thread working on this card was deleted.";
          }
        } else if (!info.running && info.run?.phase === "waiting") {
          // Scribe sends the chat on once the provider confirms the limit reset; it ends the run if it can't.
          const resetsAt = info.lastTurn?.limitResetsAt ?? info.run.wait?.until ?? ctx.now;
          const text = `Out of plan usage. The worker goes on after the limit resets (${resetTime(resetsAt)}).`;
          if (card.status?.text !== text) ops.push({ op: "merge", path: cardPath(card), value: { status: { kind: "info", text } } });
        } else if (!info.running && info.lastTurn?.limitResetsAt && !info.run && workerWaits(state, claim.thread)) {
          // Boards whose saved HTML predates Scribe's runs wait out the limit themselves.
          // A plan limit stopped the turn; the worker goes on in the same chat once the limit resets.
          const resetsAt = info.lastTurn.limitResetsAt;
          if (resetsAt < ctx.now - THREAD_STALE_MS) {
            stale = "The agent ran out of plan usage, and its worker didn't pick it up again after the limit reset.";
          } else {
            const text = `Out of plan usage. The worker goes on after the limit resets (${resetTime(resetsAt)}).`;
            if (card.status?.text !== text) ops.push({ op: "merge", path: cardPath(card), value: { status: { kind: "info", text } } });
          }
        } else if (!info.running && info.lastTurn && (info.lastTurn.status === "error" || info.lastTurn.status === "cancelled")) {
          const how = info.lastTurn.status === "error" ? `failed${info.lastTurn.error ? `: ${info.lastTurn.error}` : ""}` : "was stopped";
          release = `The agent's turn ${how} before it finished this card.`;
        } else if (!info.running && (info.lastTurn?.endedAt ?? claim.at) < ctx.now - THREAD_STALE_MS) {
          stale = "The agent's thread stopped over 30 minutes ago without finishing this card.";
        }
      } else if (claim.session) {
        const seen = Math.max(ctx.sessionSeenAt(claim.session) ?? 0, claim.seenAt ?? claim.at);
        if (seen < ctx.now - SESSION_STALE_MS) {
          stale = "No word from the agent for over an hour. It may have stopped.";
        }
      }
      if (release) {
        ops.push({ op: "merge", path: cardPath(card), value: { claim: null, status: { kind: "blocked", text: release } } });
        const agentCol = returnColumn(state, card);
        if (agentCol) ops.push(...moveOps(state, card, agentCol, ctx.now));
        events.push({ name: "claim_lost", data: { card: card.id, num: card.num, reason: release } });
      } else if (stale) {
        ops.push({ op: "merge", path: cardPath(card), value: { claim: { ...claim, stale: true }, status: { kind: "blocked", text: stale } } });
        events.push({ name: "claim_stale", data: { card: card.id, num: card.num, reason: stale } });
      } else if (waiting) {
        if (card.status?.text !== waiting) {
          const before = claim.waiting ?? { status: card.status ?? null };
          ops.push({ op: "merge", path: cardPath(card), value: { status: { kind: "blocked", text: waiting }, claim: { ...claim, waiting: before } } });
        }
      } else if (claim.waiting) {
        // Answered: put back the status the card had, unless someone changed it meanwhile.
        const { waiting: was, ...rest } = claim;
        const ours = card.status?.kind === "blocked" && /^Waiting for (your|you to)/.test(card.status.text);
        const status = working && launchStatus(was.status) ? { kind: "working", text: "Agent working" } : was.status;
        ops.push({ op: "merge", path: cardPath(card), value: { claim: rest, ...(ours ? { status } : {}) } });
      } else if (working && launchStatus(card.status)) {
        ops.push({ op: "merge", path: cardPath(card), value: { status: { kind: "working", text: "Agent working" } } });
      }
    }
    return ops.length ? { ops, result: null, events } : null;
  },

  drive(state, ctx) {
    return driveWorkers(state, ctx);
  },
  launched(state, launch, result, now) {
    return workerLaunched(state, launch, result, now);
  },

  runHold(state: BoardState, threadId: string): string | null {
    const held = cards(state).filter((c) => !c.archived && c.claim && !c.claim.stale && c.claim.thread === threadId);
    return held.length ? `it still holds ${held.map((c) => `#${c.num}`).join(", ")}` : null;
  },

  runEvent(state: BoardState, event: RunEvent, now: number): ActionOutcome | null {
    // The worker log keeps what Scribe did for a worker's chat (limit waits, resumes, merge fixes); the page logs how it ended.
    const data = event.run.data ?? {};
    const workerId = str(data.worker);
    const w = workerId ? workerMap(state)[workerId] : undefined;
    if (!w || typeof w !== "object") return null;
    const card = Number(data.card) || undefined;
    const solo = data.solo === true;
    const what = data.ask === true ? `Ask${card ? ` #${card}` : ""}` : solo ? `One-card run${card ? ` #${card}` : ""}` : "";
    const kind: string = event.kind;
    let text: string;
    if (event.kind === "limit") {
      const wait = event.run.wait;
      text = `${what ? `${what} out` : "Out"} of plan usage until ${resetTime(event.resetsAt ?? wait?.until ?? now)}${wait ? ` (wait ${wait.count})` : ""}`;
    } else if (event.kind === "end") {
      // The board logs how the chat ended when it wraps it up, with the chat's token totals.
      return null;
    } else {
      text = what ? `${what}: ${event.text}` : event.text;
    }
    const entry: WorkerLogEntry = { id: newId("lg"), at: now, kind, text: text.slice(0, 500), workerId, ...(w.name ? { worker: w.name } : {}), ...(card ? { card } : {}), thread: event.thread };
    const list = workerLogEntries(state);
    const settings = state.settings as { workerLog?: unknown } | undefined;
    const ops: unknown[] = [];
    if (!Array.isArray(settings?.workerLog)) ops.push({ op: "set", path: "settings/workerLog", value: [entry] });
    else {
      ops.push({ op: "insert", path: "settings/workerLog", value: entry });
      for (const old of list.slice(0, Math.max(0, list.length - MAX_WORKER_LOG + 1))) {
        if (old.id) ops.push({ op: "remove", path: `settings/workerLog/${old.id}` });
      }
    }
    return { ops, result: null };
  },
};

/** Only replace statuses the board set for launch or a plan-limit wait. */
function launchStatus(status: Status | null | undefined): boolean {
  return status?.kind === "working" && status.text === "Agent starting"
    || status?.kind === "info" && /^Out of plan usage\. The worker goes on after the limit resets \(.+\)\.$/.test(status.text);
}
