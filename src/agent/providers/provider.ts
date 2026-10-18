import type { EffectivePermissions } from "../effectivePermissions.js";
import type {
  ApprovalOption,
  ChatImage,
  ModelOption,
  ProviderId,
  ProviderStatus,
  QuestionSpec,
  SlashCommand,
  TaskInfo,
  Thread,
  ToolKind,
  ToolStatus,
  Usage,
} from "../types.js";
import type { ResolvedMcpServer } from "../mcpConfig.js";
import type { WebCall, WebImportance } from "../webAccess.js";

/** What the host hands a provider for one turn. */
export type TurnInput = {
  /** Text sent to the model, with context blocks already prepended. */
  text: string;
  images: ChatImage[];
  /** PDFs, for providers that read them natively (the prompt text already names them). */
  documents: ChatImage[];
  /** Extra system instructions for this thread (board context, link syntax). */
  instructions: string;
};

export type ToolStart = {
  toolId: string;
  name: string;
  tool: ToolKind;
  title: string;
  detail?: string;
  input?: unknown;
  paths?: string[];
  parentToolId?: string;
  status?: ToolStatus;
  /** This call asks the host first (SessionContext.toolGate) on a provider that holds only some calls. */
  held?: boolean;
};

export type ToolPatch = {
  title?: string;
  detail?: string;
  input?: unknown;
  status?: ToolStatus;
  output?: string;
  paths?: string[];
  exitCode?: number;
  /** Diff the provider reported; the host prefers its own before/after snapshot when it has one. */
  providerDiff?: Array<{ path: string; oldText: string | null; newText: string | null }>;
};

export type ApprovalRequest = {
  /** A native review denial needs an explicit human decision, even under Full or Edits. */
  humanOnly?: boolean;
  /** A call to this daemon's own board MCP server, identified by the provider (never by display title). */
  boardTool?: boolean;
  toolId?: string;
  tool: ToolKind;
  title: string;
  detail?: string;
  /** All file targets of an edit, delete or move; relative paths use the thread's cwd. */
  paths?: string[];
  options: ApprovalOption[];
};

export type ApprovalDecision = { optionId: string; note?: string };

/** A tool call a provider is about to run, for SessionContext.toolGate. */
export type ToolGateCall = { toolId?: string; name: string; tool: ToolKind; title?: string; detail?: string; input?: unknown; paths?: string[] };

export type ToolGateResult = { allowed: true } | { allowed: false; reason: string };

/** The result of one of Scribe's own tools, for SessionContext.scanResult. */
export type ToolScanCall = { toolId?: string; name: string; tool: ToolKind; title?: string; text: string };

export type QuestionRequest = { title?: string; questions: QuestionSpec[]; display?: "inline" | "dialog" };

export type QuestionAnswer = { answers: Record<string, string[]>; notes?: Record<string, string> } | { skipped: true; reason?: string };

/** The user's answer to a plan offered in the chat (#721). */
export type PlanDecision = { accepted: boolean; note?: string };

/** Callbacks a provider uses to report a run. All of them are cheap and synchronous except the ones that wait on the user. */
export type RunSink = {
  nativeId(id: string): void;
  text(delta: string, parentToolId?: string): void;
  reasoning(delta: string, parentToolId?: string): void;
  /** Ends the current text or reasoning block so the next delta starts a new one. */
  breakBlock(): void;
  toolStart(tool: ToolStart): void;
  toolUpdate(toolId: string, patch: ToolPatch): void;
  /** Called by a provider right before a tool writes `path` (Claude's PreToolUse hook), so the host can keep the old content. */
  beforeWrite(toolId: string, path: string): Promise<void>;
  approval(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
  question(req: QuestionRequest, signal?: AbortSignal): Promise<QuestionAnswer>;
  todos(todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>): void;
  usage(usage: Usage): void;
  notice(level: "info" | "warn" | "error", text: string): void;
  commands(commands: SlashCommand[]): void;
  title(title: string): void;
  /** A message handed to `steer` reached the model inside this turn. */
  steered?(steerId: string): void;
  /** The provider's latest transcript entry in this turn (Claude's chain uuid), where a later rewind can fork. */
  checkpoint?(id: string): void;
};

export type TurnResult = {
  status: "done" | "error" | "cancelled";
  error?: string;
  /** A steered message the turn ended without taking in; the provider runs it as its own turn next, which the host adopts. */
  next?: string;
};

/** A message for a turn that is already running. */
export type SteerInput = { text: string; images: ChatImage[]; documents: ChatImage[] };

/** One live conversation with a provider, bound to a thread. */
export interface ProviderSession {
  /**
   * Start the process and session and apply the thread's settings ahead of a turn, so sending is
   * fast. Safe to call repeatedly; errors are logged, not thrown.
   */
  warm(instructions: string): Promise<void>;
  /**
   * Run one turn. With `adopt`, the turn is the steered message the previous turn reported as
   * `next`: the provider already has it (Claude), or sends it now as this turn (Cursor).
   */
  run(input: TurnInput, sink: RunSink, opts?: { adopt?: string }): Promise<TurnResult>;
  /**
   * Hand a message to the running turn, which takes it in at its next step (between tool calls).
   * Returns an id that `RunSink.steered` or `TurnResult.next` reports back. Providers that cannot
   * steer leave this out.
   */
  steer?(input: SteerInput): string;
  /** Withdraw a steered message that has not reached the model yet, so it never runs. */
  dropSteer?(steerId: string): void;
  /** Take a steered message back for editing. Resolves false when it already reached the model. */
  withdrawSteer?(steerId: string): Promise<boolean>;
  cancel(): Promise<void>;
  /** Stop one subagent or background command, by the id in its tool item's task. */
  stopTask?(taskId: string): Promise<void>;
  /** Move a running foreground subagent or command (by the tool call that started it) to the background, so the turn goes on. */
  backgroundTask?(toolId: string): Promise<boolean>;
  /** The thread's settings changed; apply them live or restart before the next turn. */
  update(thread: Thread): void;
  commands(): Promise<SlashCommand[]>;
  dispose(): void;
}

export type SessionContext = {
  /** Scribe-managed context summaries, using this thread provider's Summary models choice. */
  summarizeContext?(thread: Thread, prompt: string, signal: AbortSignal): Promise<string>;
  /** Whether this is an unattended page worker, checked at the start of every turn. */
  isWorker?(threadId: string): boolean;
  /** Observed provider policy, including warmed sessions before their first turn. */
  permissions?(threadId: string, policy: EffectivePermissions): void;
  /** The daemon's own board MCP command, so the agent's board tools reach this board. */
  boardMcp: { command: string; args: string[]; env: Record<string, string> };
  /** Scratch working directory for threads without a workspace. */
  scratchDir: string;
  /** Domains a thread with limited web access may reach. Read on each call, so edits apply at once. */
  webAllowlist(): string[];
  /** The SearXNG instance web_search goes through (Agent settings), or "" for no web_search tool. Read when a session opens. */
  webSearchUrl?(): string;
  /** Whether Claude threads run the hooks from Claude Code's settings files and plugins. Read when a session starts. */
  claudeHooks?(): boolean;
  /** Whether Scribe runs this Cursor thread's shell commands itself, asking first (experimental; off for board workers). Read when a session opens its agent. */
  cursorHostShell?(threadId: string): boolean;
  /** The user's MCP servers (Agent settings) this thread gets, for its mode and workspace. Read when a session opens. */
  mcpServers?(thread: Thread): ResolvedMcpServer[];
  /** The provider reported plan usage (Claude's rate_limit_event), in its own shape. */
  limits?(provider: ProviderId, info: unknown): void;
  claudeLimits?(threadId: string, limits: import("../types.js").PlanLimits): void;
  /**
   * A task started by a tool call changed: a subagent or background command. It can arrive between
   * turns (a background agent still working), so it names the thread instead of going through a run.
   */
  task?(threadId: string, toolId: string, patch: Partial<TaskInfo>): void;
  /**
   * The agent started a turn on its own, between the user's turns (a background agent finished and
   * the agent reacts to it). The host runs it like a steered message: run() with { adopt: id }.
   * Returns false when the host cannot take it now; the provider then drops what it buffered.
   */
  followUp?(threadId: string, id: string): boolean;
  /**
   * "Ask the host before this tool call": Scribe's hooks (hooks.ts) may deny it, or have the user
   * approve it first whatever the thread's approval level. It never grants anything: an allowed call
   * still goes through the provider's own permission check. Providers call it where their SDK lets
   * them hold a call (Claude's PreToolUse, Pi's tool_call, Cursor's custom tools).
   */
  toolGate?(threadId: string, call: ToolGateCall, signal?: AbortSignal): Promise<ToolGateResult>;
  /**
   * "Look at this result before the agent gets it": for tools Scribe runs itself (web_fetch,
   * web_search). A note to put in front of the result when a hook has something to tell the agent
   * about it, else null. Never throws.
   */
  scanResult?(threadId: string, call: ToolScanCall): Promise<string | null>;
  /** A tool approval with no turn running (a background agent at work): the thread's own rules, or a refusal. */
  approval?(threadId: string, req: ApprovalRequest): Promise<ApprovalDecision>;
  /**
   * A web call the thread's web setting does not cover: allowed at once when the user granted it
   * earlier, else the user is asked (see AgentHost.requestWeb). message says why it was refused.
   */
  webRequest?(threadId: string, call: WebCall, opts?: { importance?: WebImportance; reason?: string; signal?: AbortSignal }): Promise<{ allowed: boolean; message?: string }>;
};

export interface AgentProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Can continue a conversation from an earlier point (Thread.rewind.at); others get a fresh session and a recap. */
  readonly forks?: boolean;
  status(): Promise<ProviderStatus>;
  models(refresh?: boolean): Promise<ModelOption[]>;
  /** One answer to one prompt, with no tools and no saved session (the summary a fork carries over). */
  complete(prompt: string, model: string, signal?: AbortSignal): Promise<string>;
  createSession(thread: Thread, ctx: SessionContext): ProviderSession;
  /** Warm a spare session for a thread that does not exist yet; createSession adopts it when the settings and thread id match. */
  prewarm(draft: Thread, instructions: string, ctx: SessionContext): void;
  /** Thread id a matching spare's MCP was started with, so createThread can keep claims pointing at a real thread. */
  spareThreadId?(thread: Thread, ctx: SessionContext): string | null;
  /** False when a saved session (nativeId) can no longer be resumed, so the next turn starts over with a recap. */
  resumable?(nativeId: string): Promise<boolean>;
  /** Delete saved sessions no thread refers to any more (keep: every nativeId threads still hold). */
  prune?(keep: ReadonlySet<string>): Promise<void>;
  dispose(): void;
}

const SPARE_TTL_MS = 10 * 60 * 1000;
const MAX_SPARES = 3;

/** Warmed sessions for threads not created yet, keyed by what a session cannot change later (cwd, mode, ...). */
export class SparePool<S extends { dispose(): void; scribeThreadId(): string }> {
  private spares = new Map<string, { session: S; timer: NodeJS.Timeout }>();

  get(key: string): S | null {
    return this.spares.get(key)?.session ?? null;
  }

  /**
   * Take the spare for `key`. With `threadId`, only if that session was warmed for that thread
   * (its MCP already started with that id); otherwise leave it for the thread that matches.
   */
  take(key: string, threadId?: string): S | null {
    const entry = this.spares.get(key);
    if (!entry) return null;
    if (threadId !== undefined && entry.session.scribeThreadId() !== threadId) return null;
    clearTimeout(entry.timer);
    this.spares.delete(key);
    return entry.session;
  }

  put(key: string, session: S): void {
    this.take(key)?.dispose();
    while (this.spares.size >= MAX_SPARES) {
      const oldest = this.spares.keys().next().value as string;
      this.take(oldest)?.dispose();
    }
    const timer = setTimeout(() => this.take(key)?.dispose(), SPARE_TTL_MS);
    timer.unref?.();
    this.spares.set(key, { session, timer });
  }

  dispose(): void {
    for (const key of [...this.spares.keys()]) this.take(key)?.dispose();
  }
}
