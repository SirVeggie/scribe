import type { EffectivePermissions } from "./effectivePermissions.js";
import type { PageRunView } from "./pageRuns.js";
/** Agent chat: threads, turns, and the display transcript shared by every provider. */

import type { GrantRow } from "./grants.js";
import type { WebAccess, WebGrants } from "./webAccess.js";
import type { ThreadGrants } from "./threadAccess.js";
import type { ThreadPageGrant } from "../pageAccess.js";
import type { BrowserView } from "../browser.js";

export type { WebAccess };

export type ProviderId = "claude" | "cursor" | "codex" | "pi";

export function isProviderId(value: unknown): value is ProviderId {
  return value === "claude" || value === "cursor" || value === "codex" || value === "pi";
}

/**
 * How the provider runs the thread, derived from its approval rung (#719): "board" for the Read-only
 * and Board rungs (reads files in its workspace, no edits or shell), "code" for the others.
 * settleAccess keeps the two in step. Planning is a turn flag (#721), not a mode.
 */
export type ThreadMode = "code" | "board";

/**
 * Mode values older threads, worker settings and scribe.agent.start may still send: "ask" means
 * "board", and "plan" means "code" with a plan turn first (wantsPlan).
 */
export type ModeInput = ThreadMode | "ask" | "plan";

/** A mode from stored data or an API, with "ask" read as "board" and "plan" as "code". Null when it is none of them. */
export function parseMode(value: unknown): ThreadMode | null {
  if (value === "ask") return "board";
  if (value === "plan") return "code";
  return value === "code" || value === "board" ? value : null;
}

/** The old "plan" mode (plan first): the thread's next turn is a plan turn (#721). */
export function wantsPlan(mode: unknown): boolean {
  return mode === "plan";
}

/** A thread's copy of its custom mode (customModes.ts): the tool groups it turns off, the MCP servers it keeps, and its instructions. */
export type ThreadCustomMode = {
  id: string;
  name: string;
  /** The highest rung the mode allows (#719). Copies made before that have none: every rung. */
  max?: ApprovalPolicy;
  off: import("./customModes.js").ModeCapability[];
  mcp: "all" | "none" | string[];
  instructions: string;
};

/**
 * The thread's rung on the access ladder (#719), lowest first. readonly: read files and pages.
 * board: also write pages. edits: also edit files, workspace edits accepted, commands ask. auto: the
 * auto-review classifier answers. full: everything without asking. The workspace decides the folder
 * and the scope the pages; the rung decides how much may change.
 */
export type ApprovalPolicy = "readonly" | "board" | "edits" | "auto" | "full";

export const APPROVALS: ApprovalPolicy[] = ["readonly", "board", "edits", "auto", "full"];

/** The rungs' names in the pickers (APPROVALS in public/agent.js). */
export const APPROVAL_LABEL: Record<ApprovalPolicy, string> = { readonly: "Read-only", board: "Board", edits: "Edits", auto: "Auto review", full: "Full access" };

/** A rung from stored data or an API. The old "ask" (ask before every edit) is now Edits. Null when it is none of them. */
export function parseApproval(value: unknown): ApprovalPolicy | null {
  if (value === "ask") return "edits";
  return APPROVALS.includes(value as ApprovalPolicy) ? (value as ApprovalPolicy) : null;
}

/** Position on the ladder: 0 for readonly up to 4 for full. */
export function approvalRank(approval: ApprovalPolicy): number {
  return APPROVALS.indexOf(approval);
}

/** The lower of two rungs. */
export function minApproval(a: ApprovalPolicy, b: ApprovalPolicy): ApprovalPolicy {
  return approvalRank(a) <= approvalRank(b) ? a : b;
}

/** Read-only and Board: no file edits or shell; the provider runs the thread in board mode. */
export function readsOnly(approval: ApprovalPolicy): boolean {
  return approval === "readonly" || approval === "board";
}

/**
 * A stored or requested mode and approval as one access setting (#719): the rung decides, and the
 * mode follows it. Old values migrate: ask and board modes become the Board rung (Read-only stays),
 * a code or plan thread on a reading rung becomes a board thread, a plan thread on an editing rung
 * a code thread, and the old "ask" approval is Edits.
 */
export function settleAccess(mode: unknown, approval: unknown): { mode: ThreadMode; approval: ApprovalPolicy } {
  const m = parseMode(mode) ?? "code";
  const a = parseApproval(approval) ?? "edits";
  if (m === "board") return { mode: "board", approval: a === "readonly" ? "readonly" : "board" };
  return readsOnly(a) ? { mode: "board", approval: a } : { mode: "code", approval: a };
}

/**
 * The rung a plan turn runs at (#721): Board, capped by the thread's own rung. Files stay read-only
 * and, from Board up, the agent can show the plan as a page.
 */
export function planAccess(thread: { approval: ApprovalPolicy }): { mode: ThreadMode; approval: ApprovalPolicy } {
  return { mode: "board", approval: minApproval("board", thread.approval) };
}

/**
 * A thread's access after a patch that may still name a mode (old pickers, worker settings,
 * scribe.agent.start). A rung decides on its own; "board" (or "ask") without one moves to the Board
 * rung (Read-only stays); "code" or "plan" on a reading rung moves to `editRung`, the provider's
 * default for workspace threads. `max` caps the rung (a custom mode's highest rung).
 */
export function changeAccess(
  current: { mode: ThreadMode; approval: ApprovalPolicy },
  patch: { mode?: unknown; approval?: unknown },
  editRung: ApprovalPolicy,
  max: ApprovalPolicy = "full"
): { mode: ThreadMode; approval: ApprovalPolicy } {
  const mode = patch.mode === undefined || patch.mode === null ? null : parseMode(patch.mode);
  const asked = patch.approval === undefined || patch.approval === null ? null : parseApproval(patch.approval);
  let approval = asked ?? current.approval;
  if (mode === "board") {
    approval = asked && readsOnly(asked) ? asked : current.approval === "readonly" ? "readonly" : "board";
  } else if (mode) {
    if (!asked && readsOnly(approval)) approval = readsOnly(editRung) ? "edits" : editRung;
  }
  return settleAccess("code", minApproval(approval, max));
}

export type ScopeKind = "global" | "workspace" | "folder" | "page";

/**
 * What a thread belongs to in Scribe. "workspace" is a thread with no Scribe scope (app scope None):
 * it is only tied to its workspace folder (ref, in step with cwd) or, with a null ref, to nothing,
 * and gets no page tools.
 */
export type ThreadScope = {
  kind: ScopeKind;
  /** Page id, folder id, or absolute workspace path. Null for global, and for a workspace scope with no workspace. */
  ref: string | null;
};

/** App scope None: the thread gets no Scribe page tools. */
export function noPages(scope: ThreadScope): boolean {
  return scope.kind === "workspace";
}

/** A Pages thread with a workspace reads and searches files there; it still gets no edits or shell (#718). */
export function pagesReadsFiles(thread: { mode: ThreadMode; cwd?: string | null }): boolean {
  return thread.mode === "board" && Boolean(thread.cwd);
}

export type Thread = {
  id: string;
  title: string;
  /** The user renamed it; provider title suggestions are ignored. */
  titleLocked: boolean;
  provider: ProviderId;
  model: string;
  /** Reasoning level (Claude effort, Cursor thought_level option). Null means the model default. */
  effort: string | null;
  /** Extra model parameters, e.g. Cursor's { fast: "false", context: "300k" }. */
  modelParams: Record<string, string>;
  mode: ThreadMode;
  /** The custom mode picked for the thread (customModes.ts): what it takes away from `mode`, as of when it was picked or last edited. */
  custom?: ThreadCustomMode;
  approval: ApprovalPolicy;
  /** The next user turn is a plan turn (#721): set when a thread starts in the old plan mode, cleared by that turn. */
  planNext?: boolean;
  /** Web search and fetch tools: any site, the allowlist in prefs only, or none. */
  web: WebAccess;
  /** Web access the user granted this thread beyond its web setting (a web request answered with a domain or the thread). */
  webGrants?: WebGrants;
  /** Other threads the user let this one read (thread_list, thread_read), by scope. */
  threadGrants?: ThreadGrants;
  /** Pages and folders this thread may reach outside its scope (#269): a page_access answer, a previous home, or the user's @mention. */
  pageGrants?: ThreadPageGrant[];
  /** Scopes the thread had before it followed a page it showed: they keep counting for page access (#269). */
  formerScopes?: ThreadScope[];
  /**
   * Read a Trusted only or Restricted page without the user @mentioning it (#269). Its transcript then
   * counts as trusted content: untrusted models and helpers need the user's say-so to see it.
   */
  tainted?: boolean;
  /**
   * No tools at all (#729): no MCP servers (Scribe's own included) and no built-in file, shell or web
   * tools, for one-off chats a page starts (OCR, classify, rewrite). Set when the thread is made and
   * never changed; the thread stays Read-only, web off, with no workspace.
   */
  noTools?: true;
  /** A helper another thread's agent started with agent_run: that thread's id. It works on that agent's briefs, not the user's messages. */
  helperOf?: string;
  /** The user let this thread's agent start helpers (agent_run) without asking again: Allow for this thread, or a board worker set to use helpers unasked. */
  helpersAllowed?: boolean;
  scope: ThreadScope;
  /** Working directory for file and shell tools. While the thread has an open worktree, a folder inside it. */
  cwd: string | null;
  /** Work in a git worktree of its own. The worktree is made on the first message. */
  useWorktree?: boolean;
  worktree?: ThreadWorktree | null;
  /** Provider session id used to resume. */
  nativeId: string | null;
  /**
   * Set by a rewind until the next turn ends. at: the provider transcript entry the next turn
   * continues from (Claude forks its session there); null starts a fresh session. recap: the kept
   * conversation, sent ahead of the next message when the provider cannot fork. migrated: not a
   * rewind but a Cursor thread moving off its old ACP session (same recap, other wording).
   */
  rewind?: { at: string | null; recap?: string; migrated?: boolean };
  /**
   * Made by forking another thread, until its first turn ends. The first turn continues the other
   * thread's provider session when it can (same provider and folder, and the provider forks), or
   * starts fresh with a summary of that conversation.
   */
  fork?: ThreadFork;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  /** Last user message or finished turn; drives list order. */
  activityAt: number;
  /**
   * What the user typed in the composer and left unsent. A thread with a draft and no turns is a
   * draft thread (the list marks it with a pen). Attached files stay in the window that has them.
   */
  draft?: ComposerDraft | null;
  /** Detection off: Scribe's hooks (Agent settings, Hooks) neither watch nor hold anything in this thread. */
  hooksOff?: boolean;
};

export type ComposerDraft = { text: string; context?: ContextChip[] };

export type ThreadFork = {
  /** The thread it was forked from, as it was then. */
  from: string;
  title: string;
  provider: ProviderId;
  cwd: string | null;
  /** That thread's provider session and where in it the fork continues; null when it cannot. */
  nativeId: string | null;
  at: string | null;
  /** Finished turns it had; with more than two, the ones between the first and last are summarized. */
  turns: number;
};

/** A git worktree the board made for a thread, on a branch of its own. */
export type ThreadWorktree = {
  /** The folder the user picked, in the main checkout. The thread goes back to it when the worktree closes. */
  home: string;
  /** Top level of the main checkout. */
  repo: string;
  /** Top level of the worktree. */
  path: string;
  branch: string;
  /** Branch the worktree started from; null when the main checkout was on a detached HEAD. */
  base: string | null;
  baseCommit: string;
  /** Repo-relative folders linked in from the main checkout (node_modules and the like). */
  links: string[];
  createdAt: number;
  /** As of the last turn: commits not in the base yet, and uncommitted changes. */
  ahead?: number;
  dirty?: boolean;
  /** expired: closed by Scribe after days without a turn while it held no changes; the next message opens one again. */
  closed?: { how: "merged" | "left" | "removed" | "expired"; at: number };
};

/** A worktree that holds changes but has had no turn for days, for the stale worktrees list (#686). */
export type StaleWorktree = {
  threadId: string;
  title: string;
  home: string;
  repo: string;
  path: string;
  branch: string;
  base: string | null;
  ahead: number;
  dirty: boolean;
  /** When a turn last ran in it, or when it was made. */
  usedAt: number;
};

export type RunStatus = "idle" | "running" | "waiting";

/** How much of a subscription's usage windows is used, as the provider last reported it. */
export type PlanLimits = {
  /** Active-query metadata; never credential values or proof of a particular credit balance. */
  billingSource?: ClaudeBillingSource;
  extraUsage?: { at?: number; enabled?: boolean; usedCredits?: number; monthlyLimit?: number; currency?: string };
  overageAt?: number;
  /** Background window-start activity; never a provider quota or proof of a reset. */
  windowStart?: { reset?: number; attempted?: number; result?: string };
  /** When the provider reported it. */
  at: number;
  /** "allowed", "allowed_warning" or "rejected" (Claude). */
  status?: string;
  /** expired: resetsAt has passed and the provider has not reported the next window yet. */
  windows: Array<{ id: string; label: string; utilization: number; resetsAt?: number; expired?: true }>;
  /** Requests are being billed as extra usage beyond the plan. */
  overage?: boolean;
  /** Identifies snapshots whose observed percentages must survive a passed reset. */
  source?: "codex" | "claude";
  availability?: "available" | "unavailable" | "authentication_required";
  detail?: string;
  ordinaryUsageAllowed?: boolean | null;
  permissionAt?: number;
  buckets?: Array<{ id: string; label: string; planType?: string; credits?: { hasCredits: boolean; unlimited: boolean; balance?: string } }>;
};

export type ClaudeBillingSource = {
  apiProvider?: string;
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
};

/** Thread plus runtime fields the UI needs in lists. */
export type ThreadView = Thread & {
  /** Isolated to this query; never fall back to another thread's quota. */
  claudeLimits?: PlanLimits;
  effectivePermissions?: EffectivePermissions;
  status: RunStatus;
  /** True when the last turn finished and the user has not opened the thread. Never set on page-owned threads. */
  unread: boolean;
  queued: number;
  /** Subagents and commands still working in the background, after or beside the current turn. */
  background: number;
  stats: { turns: number; files: number; added: number; removed: number };
  /** Token totals across non-reverted turns. Missing until a turn has been recorded. */
  usage?: ThreadUsage;
  /** When the last finished turn ended. Missing until a turn has completed. */
  finishedAt?: number;
  /** A fork that has not run yet: how its first turn gets the earlier conversation, and which model summarizes it. */
  carry?: { how: "native" | "summary"; summarizer?: string };
  /** True while every user turn was sent by the page; a typed user message clears it. */
  fromPage: boolean;
  /** While waiting: the first question, approval or plan the user has not answered yet. */
  asking?: {
    kind: "approval" | "question" | "plan";
    /** Also the request id the answer goes to (POST /approvals/:id for approvals). */
    itemId: string;
    title: string;
    page?: { id: string; key: string; title: string };
    /** Questions: answered in a form dialog, which a toast click opens. */
    form?: boolean;
    /** Approvals: the command or path it is about, and the answers it offers. */
    detail?: string;
    options?: ApprovalOption[];
  };
  /** Running, waiting or unread threads: the live step and the latest agent message, for the activity flyout and toasts. */
  activity?: { line: string; lastText?: string };
  /** Permissions the user granted while it ran (web domains, readable threads), each revocable by key. Missing when none. */
  grants?: GrantRow[];
  /** While a page has handed the thread to Scribe to see through (pageRuns.ts), and once that run ended until the page releases it. */
  run?: PageRunView;
};

export type FileChange = {
  path: string;
  status: "A" | "M" | "D" | "R";
  added: number;
  removed: number;
  oldPath?: string;
  binary?: boolean;
};

export type Usage = {
  /** Observed main-thread model responses in this turn; excludes hidden retries and SDK subagents. Missing when unavailable. */
  modelCalls?: number;
  /** First main-thread response's prompt, including cached input exactly once. */
  firstPromptTokens?: number;
  billingSource?: ClaudeBillingSource;
  costRecords?: import("./pricing.js").CostRecord[];
  estimatedCostUsd?: number;
  reportedCostUsd?: number;
  costPartial?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  contextTokens?: number;
  contextWindow?: number;
  /** How much of each subscription window this turn used (0–1 of that window). Claude only. */
  plan?: Array<{ id: string; label: string; used: number }>;
};

/** Totals across a thread's turns (reverted turns omitted). Boards read this when a worker chat ends. */
export type ThreadUsage = {
  estimatedCostUsd?: number;
  reportedCostUsd?: number;
  turns: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  /** Normalized prompt tokens, including cached input exactly once. */
  promptTokens?: number;
  costPartial?: boolean;
  /** The main thread's original provider figures, before helpers are added. */
  main?: ThreadUsage;
  helpers?: ThreadUsage & { threads: number };
};

export type TurnStatus = "running" | "done" | "error" | "cancelled";

export type Turn = {
  id: string;
  threadId: string;
  seq: number;
  status: TurnStatus;
  model: string;
  effort: string | null;
  mode: ThreadMode;
  /** A plan turn (#721): it ran at planAccess, to propose a plan without changing files. */
  plan?: boolean;
  startedAt: number;
  endedAt?: number;
  /** Latest model output in this turn; lets boards recognize even a short completed turn. */
  outputAt?: number;
  /** Git tree of the working copy before and after the turn (temp index, untracked included). */
  repo?: string;
  beforeTree?: string;
  afterTree?: string;
  /** HEAD before and after, for worktree turns, so a revert also undoes the turn's commits. */
  beforeHead?: string;
  afterHead?: string;
  files?: FileChange[];
  usage?: Usage;
  error?: string;
  /** Scribe stopped (or crashed) while this turn ran; the next start sends the thread on. */
  interrupted?: boolean;
  /** The turn failed on a plan usage limit: when the plan should let it go again. */
  limitResetsAt?: number;
  reverted?: boolean;
  /** This turn's last entry in the provider's own transcript (Claude's chain uuid): where a rewind to after this turn forks. */
  nativeEnd?: string;
  /** The board page this turn could edit, by HTML revision before and after. The old HTML is kept as a checkpoint. */
  page?: { id: string; title: string; before: number; after?: number; reverted?: boolean };
  /**
   * Pages this thread last knew, as of the end of this turn (the thread's page and pages it wrote).
   * The next turn compares live revisions and warns the agent if the user edited one in between.
   */
  seenPages?: Array<{ id: string; key: string; title: string; revision: number; stateRevision: number }>;
};

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "fetch" | "think" | "mcp" | "task" | "todo" | "other";

export type ToolStatus = "pending" | "running" | "done" | "error";

export type ApprovalOption = {
  id: string;
  label: string;
  description?: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
};

export type QuestionSpec = {
  id: string;
  prompt: string;
  header?: string;
  /** Absent for choices (what the providers' own question tools send). ask_user adds the others. */
  type?: "text" | "number" | "scale";
  multi: boolean;
  options: Array<{ id: string; label: string; description?: string }>;
  optional?: boolean;
  placeholder?: string;
  /** Text: a multi-line answer. */
  long?: boolean;
  /** Number bounds, or a scale's ends (whole steps). */
  min?: number;
  max?: number;
  minLabel?: string;
  maxLabel?: string;
};

/** A file sent with a message, as base64. Images go to the model as images; other files see attachments.ts. */
export type ChatFile = { name: string; mimeType: string; data: string };
export type ChatImage = ChatFile;
/** A sent file as the transcript keeps it: saved under the data folder, served by id. */
export type FileRef = { id: string; name: string; mimeType: string; size: number; path?: string };

export type ContextChip =
  | { kind: "thread"; id: string; title: string }
  | { kind: "page"; id: string; key: string; title: string }
  | { kind: "folder"; id: string; path: string }
  | { kind: "file"; path: string }
  | { kind: "selection"; text: string; source?: string };

/** A provider task (Claude's subagents and background commands), as the tool that started it shows it. */
export type TaskInfo = {
  id: string;
  /** "agent" for subagents, "command" for background shell commands, or the provider's own type. */
  type: string;
  status: "running" | "done" | "error" | "stopped";
  /** Runs without blocking the turn; it may still be working after the turn ends. */
  background?: boolean;
  /** One line on what it is doing now, or how it ended. */
  summary?: string;
  lastTool?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  endedAt?: number;
};

/** A hook's mark on a transcript item (hooks.ts): which detector matched, and what it did about it. */
export type ItemFlag = { id: string; label: string; action: "flag" | "ask" | "block"; reason?: string };

type ItemBase = {
  id: string;
  threadId: string;
  turnId: string | null;
  seq: number;
  createdAt: number;
  flags?: ItemFlag[];
};

export type ItemBody =
  | {
      kind: "user";
      text: string;
      /** id and size are missing on messages from before files were saved. */
      images?: Array<{ name: string; mimeType: string; id?: string; size?: number }>;
      files?: FileRef[];
      context?: ContextChip[];
      /** Queued, then dropped by Stop. */
      dropped?: boolean;
      /** Sent into a running turn: "waiting" until the agent takes it in, then "folded" (it belongs to that turn). */
      steer?: "waiting" | "folded";
      /** Temporarily held in the queue while an editing popup is open. */
      editing?: boolean;
      /** Sent by the code of the thread's page (board.agent), by Scribe itself (going on after a restart), by the agent this helper thread works for, or by a hook's context action; not typed by the user. */
      from?: "page" | "scribe" | "agent" | "hook";
      /** Typed into the floating chat over a page. Kept so tools/replay-page-intent.ts can measure on those turns alone. */
      dock?: boolean;
      /** Sent by a Kanban board about one of its cards: a comment on it, or Continue (resume). */
      card?: { num: number; title?: string; resume?: boolean; reply?: string };
      /** Sent as a plan turn (#721: /plan or the composer's Plan chip). */
      plan?: boolean;
    }
  | { kind: "text"; text: string; parentToolId?: string }
  | { kind: "reasoning"; text: string; startedAt: number; endedAt?: number; parentToolId?: string }
  | {
      kind: "tool";
      toolId: string;
      name: string;
      tool: ToolKind;
      title: string;
      detail?: string;
      input?: unknown;
      status: ToolStatus;
      output?: string;
      paths?: string[];
      files?: Array<{ path: string; added: number; removed: number; status?: "A" | "M" | "D" }>;
      diff?: string;
      exitCode?: number;
      parentToolId?: string;
      /** A subagent or background command this tool started; it can outlive the tool call and the turn. */
      task?: TaskInfo;
      /** An agent_run call: the helper thread it started or sent on, so the chat can show that thread's progress on the call. */
      helper?: string;
      startedAt: number;
      endedAt?: number;
    }
  | {
      kind: "approval";
      requestId: string;
      toolId?: string;
      tool: ToolKind;
      title: string;
      detail?: string;
      options: ApprovalOption[];
      status: "pending" | "resolved" | "expired";
      decision?: string;
      note?: string;
    }
  | {
      kind: "question";
      requestId: string;
      title?: string;
      questions: QuestionSpec[];
      /** dialog: a banner in the chat opens the questions as a form (ask_user with many questions). */
      display?: "inline" | "dialog";
      status: "pending" | "answered" | "skipped" | "expired";
      answers?: Record<string, string[]>;
      notes?: Record<string, string>;
      /** Asked with a page (page_ask): the user answers on the page; its event resumes the turn. */
      page?: { id: string; key: string; title: string };
      /** The page event that answered it. */
      event?: string;
    }
  | {
      kind: "plan";
      requestId?: string;
      title?: string;
      text: string;
      status: "pending" | "accepted" | "rejected" | "shown";
      note?: string;
    }
  /** settings_show: rows of Scribe's settings dialogs, shown in the chat to change there (ids from the client's settings index). */
  | { kind: "settings"; ids: string[]; title?: string }
  | { kind: "todos"; todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string };

export type Item = ItemBase & ItemBody;

export type AgentEvent =
  | { type: "agent_thread"; thread: ThreadView }
  | { type: "agent_thread_deleted"; id: string }
  | { type: "agent_item"; item: Item }
  | { type: "agent_item_deleted"; threadId: string; id: string }
  | { type: "agent_limits"; limits: Partial<Record<ProviderId, PlanLimits>> }
  | { type: "agent_delta"; threadId: string; itemId: string; append: string }
  | { type: "agent_turn"; turn: Turn }
  | { type: "agent_turn_deleted"; threadId: string; id: string }
  /**
   * A hook's signal action: a detector matched a chunk of the turn (hooks.ts). The agent is unaffected.
   * Page-creation intent (pageIntent.ts) is name "page_create" with stage "hint" or "confirmed", and the new page's title when the agent gave one.
   */
  | { type: "agent_intent"; threadId: string; turnId: string | null; itemId?: string; name: string; stage?: string; title?: string; detector: string; event: string; early?: boolean; confidence?: number }
  /** The thread's agent browser opened, navigated, or closed (view null). */
  | { type: "agent_browser"; threadId: string; view: BrowserView | null }
  /** A chat the daemon started for a page (a Kanban worker's card) that asks to be shown: windows showing that page open it there. */
  | { type: "agent_page_show"; threadId: string; pageId: string; where: "dock" | "sidebar" };

export type ModelOption = {
  id: string;
  label: string;
  provider: ProviderId;
  description?: string;
  /** Reasoning levels; empty when the model has no control. */
  efforts: Array<{ id: string; label: string }>;
  defaultEffort?: string | null;
  /** Provider parameter id the effort maps onto (Cursor: effort, reasoning_effort, reasoning, thinking). */
  effortParam?: string;
  /** Other selectable parameters (Cursor: fast, context, thinking). */
  params: Array<{ id: string; label: string; description?: string; options: Array<{ id: string; label: string }>; default: string }>;
};

export type SlashCommand = { name: string; description?: string; hint?: string };

export type ProviderStatus = {
  id: ProviderId;
  label: string;
  available: boolean;
  detail?: string;
  /** Not logged in, and the provider can start a browser login (Cursor, Codex). */
  login?: boolean;
};

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
