import type { PageRunView, RunNote } from "../agent/pageRuns.js";
import type { ThreadUsage } from "../agent/types.js";
import type { BoardState, TemplateValues } from "../types.js";

/** Who runs an action. Agents carry their MCP session, and the chat thread when Scribe started them. */
export type ActionCaller = {
  by: "user" | "agent";
  /** Short name for the holder of a claim, e.g. "Claude Code" or a thread title. */
  label?: string;
  /** In-app chat provider id (`claude` | `cursor` | `codex` | `pi`), when Scribe started the agent. */
  provider?: string;
  /** One MCP server process. Every call it makes counts as a sign of life for its claims. */
  session?: string;
  /** Scribe chat thread the agent runs in. */
  thread?: string;
};

export type ActionContext = {
  caller: ActionCaller;
  now: number;
  /** The page's template form values. */
  values: TemplateValues;
  /** How a chat thread is doing, when the daemon runs agents. */
  thread?(id: string): ThreadRunInfo;
};

export type ActionEvent = { name: string; data?: unknown };

export type ActionOutcome = {
  /** Applied strictly to the state the action read: all or nothing. */
  ops: unknown[];
  /** Returned to the caller. */
  result: unknown;
  /** Logged on the page after the ops. */
  events?: ActionEvent[];
};

export type ActionDef = {
  description: string;
  /** Argument summary for the guide and tool errors, e.g. "{ card, to, position? }". */
  args: string;
  run(state: BoardState, args: Record<string, unknown>, ctx: ActionContext): ActionOutcome;
};

/** How a chat thread is doing, for releasing claims of agents that stopped. */
export type ThreadRunInfo =
  | { exists: false }
  | {
      exists: true;
      running: boolean;
      title: string;
      /** Latest text, reasoning, or tool call received in the current or most recent turn. */
      outputAt?: number;
      lastTurn?: { status: string; endedAt?: number; error?: string; limitResetsAt?: number; usageRecoveryAllowed?: boolean };
      /** Token totals across the thread's non-reverted turns, so a board can log them when the chat ends. */
      usage?: ThreadUsage;
      /** While the page has handed the thread to Scribe as a run: its phase, limit wait, and outcome once ended. */
      run?: PageRunView;
      /** While the turn waits on the user: the question (a page_ask page too), approval or plan. */
      asking?: { kind: "approval" | "question" | "plan"; title: string; page?: { key: string; title: string } };
    };

export type SweepContext = {
  now: number;
  thread(id: string): ThreadRunInfo;
  /** Last request from an MCP session, if this daemon has seen one. */
  sessionSeenAt(session: string): number | undefined;
};

/** A page's scribe.reply, as its reply target's template gets it. */
export type InboundReply = {
  /** The page that replied. */
  from: { id: string; key: string; title: string };
  /** What on the target the reply is about, from the page's reply target (a Kanban card's number). */
  card?: number;
  /** One line from the page, e.g. "Picked option A". May be empty. */
  summary: string;
  /** The page's answers: field name to value. */
  data: Record<string, unknown>;
};

/**
 * What a reply handler wants passed on to an agent chat once its ops applied: a message into the
 * running turn of thread, or (resume) Continue for it. See AgentHost.cardMessage.
 */
export type ReplyDelivery = {
  thread: string;
  num: number;
  title: string;
  text: string;
  resume: boolean;
  /** Handler's own bookkeeping, handed back to replyDelivered as given. */
  ref?: Record<string, string>;
};

export type ReplyOutcome = ActionOutcome & { deliver?: ReplyDelivery };

export type ActionSet = {
  actions: Record<string, ActionDef>;
  /** Initialize a new page from its template state and parsed form values, before it is opened. */
  seed?(state: BoardState, values: TemplateValues): BoardState;
  /**
   * Another page's scribe.reply aimed at this page (its reply target). Without this hook the
   * target only gets a `reply` event. Runs as the user: the user's click sent it.
   */
  reply?(state: BoardState, reply: InboundReply, ctx: ActionContext): ReplyOutcome;
  /** How the reply's delivery went (null: not sent); ops to record it, e.g. on the comment. */
  replyDelivered?(state: BoardState, deliver: ReplyDelivery, delivered: "steered" | "queued" | "started" | null, ctx: ActionContext): ActionOutcome | null;
  /** Page keys linked from what these threads hold on the page (a board's claimed cards), which they may read (#762). */
  heldLinks?(state: BoardState, threads: string[]): string[];
  /** Periodic check, e.g. for claims whose agent stopped. Returns null when nothing changes. */
  sweep?(state: BoardState, ctx: SweepContext): ActionOutcome | null;
  /** A run of this page's (see agent/pageRuns.ts) is done and would merge: a reason to keep its branch unmerged, or null. */
  runHold?(state: BoardState, threadId: string): string | null;
  /** Scribe moved one of the page's runs on (a limit wait, a resume, a merge fix, its end), e.g. to log it on the page. */
  runEvent?(state: BoardState, event: RunEvent, now: number): ActionOutcome | null;
  /**
   * One step of the page's own agents (a Kanban board's workers), run by the daemon whether or not
   * a window shows the page: wrap up a chat whose run ended, start the next one, or wait. Called
   * again on the new state until it returns null.
   */
  drive?(state: BoardState, ctx: DriveContext): DriveOutcome | null;
  /** How a launch from drive went: ops to record the new chat (or why it didn't start). */
  launched?(state: BoardState, launch: PageLaunch, result: { threadId: string } | { error: string }, now: number): ActionOutcome | null;
  /** Rechecked immediately before dispatch, after asynchronous provider setup. */
  launchAllowed?(state: BoardState, launch: PageLaunch, now: number): boolean;
};

/** A new agent chat's settings, as a page's scribe.agent.start would pass them. */
export type LaunchSettings = {
  title: string;
  mode: string;
  provider?: string;
  model?: string;
  effort?: string;
  customMode?: string;
  show?: string;
  web: string;
  approval: string;
  modelParams: Record<string, string>;
  cwd?: string;
  worktree?: boolean;
  helpers: boolean;
  /** Scribe skill ids the worker picked, copied onto its thread. */
  skills?: string[];
};

/** What Scribe needs to see a page's chat through (see agent/pageRuns.ts RunInput). */
export type PageRunInput = { tag: string; data: Record<string, unknown>; merge: boolean; resumePrompt: string; after?: number };

/** A chat for the daemon to start for the page: handed back to launched with its result. */
export type PageLaunch = {
  /** Prefer this existing page chat; a deleted chat falls back to a fresh launch. */
  resumeThread?: string;
  prompt: string;
  settings: LaunchSettings;
  run: PageRunInput;
  /** The action set's own bookkeeping, returned as given. */
  ref: Record<string, unknown>;
};

export type DriveContext = SweepContext & {
  page: { id: string; title: string };
  /** Same available-provider default used when launching a board worker. */
  defaultProvider?: string;
  /** Why the page may not start this chat without a click (its permissions), or null. */
  mayStart(settings: LaunchSettings): string | null;
  /** Hand one of the page's chats to Scribe to see through; false when Scribe can't. */
  watch(threadId: string, run: PageRunInput): boolean;
  /** Scribe stops seeing the chat through and forgets its ended run. */
  release(threadId: string): void;
};

export type DriveOutcome = ActionOutcome & { launch?: PageLaunch };

export type RunEvent = RunNote & { thread: string; run: PageRunView };

export class ActionError extends Error {}

export function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function arr<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
