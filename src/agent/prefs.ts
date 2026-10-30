import path from "node:path";
import type { ApprovalPolicy, ProviderId, Thread, ThreadMode, ThreadScope, WebAccess } from "./types.js";
import { APPROVALS, parseApproval, readsOnly } from "./types.js";
import type { HookRule } from "./hooks.js";
import type { CustomMode } from "./customModes.js";
import { DEFAULT_WEB_ALLOWLIST } from "./webAccess.js";
import type { WindowStarts } from "./usageWindowStarts.js";

export type ModelChoice = { effort: string | null; modelParams: Record<string, string> };

/** Last-used chat settings. New threads and drafts start from these. */
export type Prefs = {
  usageWindowStarts: WindowStarts;
  provider: ProviderId;
  models: Partial<Record<ProviderId, string>>;
  efforts: Partial<Record<ProviderId, string | null>>;
  modelParams: Partial<Record<ProviderId, Record<string, string>>>;
  /**
   * Last effort and model params (fast, context) per model, keyed "provider:modelId". Switching to a
   * model brings back its own; efforts and modelParams above are the last used per provider.
   */
  modelSettings: Record<string, ModelChoice>;
  /** Approval rungs skipped by the cycle hotkey; still available in the access picker. Older prefs listed modes, which are dropped. */
  disabledModes: ApprovalPolicy[];
  /** The user's own modes (customModes.ts), shown under the built-in ones. */
  customModes: CustomMode[];
  /** The custom mode last picked, by id; new threads start in it. Null after a built-in mode was picked. */
  customMode: string | null;
  approval: ApprovalPolicy;
  /** Last approval rung per provider for workspace threads (page and folder threads start on Board). `approval` is the most recently used, and the fallback. */
  approvals: Partial<Record<ProviderId, ApprovalPolicy>>;
  web: WebAccess;
  /** Domains a thread with limited web access may search and fetch (subdomains included). */
  webAllowlist: string[];
  /** Commands (their first words) Scribe runs without asking in every thread: Native's and Cursor's host shell (#743). */
  commandAllowlist: string[];
  /** Extra files and folders no agent may read or write through Scribe's gates, beside the built-in ones (access.ts, #898). */
  protectedPaths: string[];
  /** A SearXNG instance (base URL) that gives Pi threads, and Cursor threads without full web, a web_search tool. "" for none. */
  searxngUrl: string;
  /**
   * Run the hooks in Claude Code's settings files and plugins in Claude threads. Off by default: a
   * fail-closed hook meant for the user's own terminal sessions can deny every tool call here.
   */
  claudeHooks: boolean;
  /**
   * Experimental: Cursor threads set to Ask or Edits run shell commands through Scribe, which asks
   * first, instead of Cursor's own shell under Auto-review. Board workers keep Cursor's shell.
   */
  cursorHostShell: boolean;
  /**
   * Agents may hand tasks to a helper agent on another provider or model (agent_run), when told to.
   * On by default; a helper spends that provider's quota.
   */
  helpers: boolean;
  /** Chats get the shared memories in their instructions, and the memory tools to keep them (see memory.ts). */
  memory: boolean;
  /** Optional app instructions (APP_INSTRUCTIONS in prompt.ts) left out of new chats' instructions. */
  instructionsOff: string[];
  /** The user's own hooks (hooks.ts): a pattern, the event it watches, and what happens on a match. */
  hookRules: HookRule[];
  recentWorkspaces: string[];
  /**
   * Workspace folders the user hid: the thread list and the workspace menus leave them out (a search
   * still finds their threads). Starting a thread in one by its path shows it again.
   */
  hiddenWorkspaces: string[];
  /**
   * Last workspace used for a folder scope ("folder:<id>"), so new threads there start in it.
   * Still recorded for pages; new page threads take the latest AI reply on that page instead.
   */
  scopeWorkspaces: Record<string, string>;
  /** Starred models as "provider:modelId", in the order they were starred. Ctrl+' cycles them. */
  favoriteModels: string[];
  /** Last worktree choice per workspace (see workspaceKey), the default for new threads there. */
  worktrees: Record<string, boolean>;
  /** Main utility agent (palette AI search); retains the original setting key and saved choice. */
  summarizer: { provider: ProviderId; model: string };
  /** Summary choice per chat provider. Legacy strings refer to that provider; null uses the chat model. */
  forkSummarizers: Partial<Record<ProviderId, string | { provider: ProviderId; model: string } | null>>;
};

export const DEFAULT_PREFS: Prefs = {
  usageWindowStarts: { claude: false, codex: false },
  provider: "cursor",
  models: { cursor: "composer-2.5", claude: "default", codex: "default" },
  efforts: {},
  modelParams: { cursor: { fast: "false" } },
  modelSettings: {},
  disabledModes: [],
  customModes: [],
  customMode: null,
  approval: "edits",
  approvals: {},
  web: "on",
  webAllowlist: DEFAULT_WEB_ALLOWLIST,
  commandAllowlist: [],
  protectedPaths: [],
  searxngUrl: "",
  claudeHooks: false,
  cursorHostShell: false,
  helpers: true,
  memory: true,
  instructionsOff: [],
  hookRules: [],
  recentWorkspaces: [],
  hiddenWorkspaces: [],
  scopeWorkspaces: {},
  favoriteModels: [],
  worktrees: {},
  summarizer: { provider: "claude", model: "haiku" },
  forkSummarizers: {},
};

/** Keep the old explicit choice only for its own provider; other destinations use their chat model. */
export function seedForkSummarizers(saved: Partial<Prefs>): Prefs["forkSummarizers"] {
  if (saved.forkSummarizers) return cleanForkSummarizers(saved.forkSummarizers);
  return saved.summarizer ? cleanForkSummarizers({ [saved.summarizer.provider]: saved.summarizer.model }) : {};
}

export function cleanForkSummarizers(value: unknown): Prefs["forkSummarizers"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([provider, model]) =>
    ["claude", "codex", "cursor", "pi"].includes(provider) && (model === null || (typeof model === "string" && model.trim().length > 0) ||
      (typeof model === "object" && model !== null && "provider" in model && "model" in model &&
        ["claude", "codex", "cursor", "pi"].includes(String(model.provider)) && typeof model.model === "string" && model.model.trim().length > 0))
  ));
}

export function forkSummaryModel(prefs: Prefs, thread: Pick<Thread, "provider" | "model">): string {
  return summaryChoice(prefs, thread).model;
}

export function summaryChoice(prefs: Prefs, thread: Pick<Thread, "provider" | "model">): { provider: ProviderId; model: string } {
  const choice = prefs.forkSummarizers[thread.provider];
  return typeof choice === "object" && choice ? choice : { provider: thread.provider, model: choice || thread.model };
}

/** Ignore malformed ids, and the mode ids older prefs kept, in saved preferences and API patches. */
export function cleanDisabledModes(value: unknown): ApprovalPolicy[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is ApprovalPolicy => APPROVALS.includes(id)))];
}

/** Saved approval prefs with the old "ask" read as Edits and unknown values dropped. */
export function cleanApprovals(saved: Partial<Prefs>): Pick<Prefs, "approval" | "approvals"> {
  const approvals: Prefs["approvals"] = {};
  for (const [id, value] of Object.entries(saved.approvals ?? {})) {
    const approval = parseApproval(value);
    if (approval && ["claude", "cursor", "codex", "pi"].includes(id)) approvals[id as ProviderId] = approval;
  }
  return { approval: parseApproval(saved.approval) ?? DEFAULT_PREFS.approval, approvals };
}

/** Same as dirKey in public/agent.js, which looks up these keys for new threads. */
export function workspaceKey(dir: string): string {
  return dir.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

export function modelKey(provider: ProviderId, model: string): string {
  return `${provider}:${model}`;
}

/** The effort and params a thread switching to this model starts with: its last ones, else the model's defaults. */
export function modelChoice(prefs: Prefs, provider: ProviderId, model: string): ModelChoice {
  const saved = prefs.modelSettings[modelKey(provider, model)];
  if (saved) return { effort: saved.effort ?? null, modelParams: { ...(saved.modelParams || {}) } };
  return { effort: null, modelParams: { ...(DEFAULT_PREFS.modelParams[provider] || {}) } };
}

/** Prefs saved before modelSettings existed: each provider's last model keeps the effort and params it had. */
export function seedModelSettings(saved: Partial<Prefs>): Prefs["modelSettings"] {
  if (saved.modelSettings) return saved.modelSettings;
  const seeded: Prefs["modelSettings"] = {};
  for (const [provider, model] of Object.entries(saved.models || {}) as [ProviderId, string][]) {
    if (!model) continue;
    seeded[modelKey(provider, model)] = { effort: saved.efforts?.[provider] ?? null, modelParams: { ...(saved.modelParams?.[provider] || {}) } };
  }
  return seeded;
}

/** A change to a thread's settings. customMode picks one of the user's modes by id (null: back to the plain built-in mode). */
export type ThreadPatch = Partial<Thread> & { customMode?: string | null };

type ChoiceThread = {
  provider: ProviderId;
  model: string;
  effort: string | null;
  modelParams: Record<string, string>;
  mode: ThreadMode;
  custom?: Thread["custom"];
  approval: ApprovalPolicy;
  web: WebAccess;
  scope: ThreadScope;
  cwd: string | null;
  useWorktree?: boolean;
};

/** Every setting a new thread should inherit, for rememberChoices. */
export function settingPatch(thread: ChoiceThread): ThreadPatch {
  return {
    provider: thread.provider,
    model: thread.model,
    effort: thread.effort,
    modelParams: thread.modelParams,
    mode: thread.mode,
    approval: thread.approval,
    web: thread.web,
    ...(thread.cwd ? { cwd: thread.cwd } : {}),
    ...(typeof thread.useWorktree === "boolean" ? { useWorktree: thread.useWorktree } : {}),
  };
}

/**
 * Prefs keys to write so the next new thread matches `thread`, given which fields `patch` changed.
 * Empty object means nothing to store.
 */
export function prefsPatchFromChoices(prefs: Prefs, thread: ChoiceThread, patch: ThreadPatch): Partial<Prefs> {
  const next: Partial<Prefs> = {};
  if (patch.model || patch.provider) {
    next.provider = thread.provider;
    next.models = { ...prefs.models, [thread.provider]: thread.model };
  }
  if (patch.effort !== undefined) next.efforts = { ...prefs.efforts, [thread.provider]: thread.effort };
  if (patch.modelParams) next.modelParams = { ...prefs.modelParams, [thread.provider]: thread.modelParams };
  if (patch.model || patch.provider || patch.effort !== undefined || patch.modelParams) {
    next.modelSettings = {
      ...prefs.modelSettings,
      [modelKey(thread.provider, thread.model)]: { effort: thread.effort, modelParams: { ...thread.modelParams } },
    };
  }
  const scoped = thread.scope.kind === "page" || thread.scope.kind === "folder";
  if ((patch.mode || patch.customMode !== undefined) && !scoped) {
    next.customMode = thread.custom?.id ?? null;
  }
  // Page and folder threads start on Board whatever was picked last: only a workspace rung, or an editing one, is kept.
  if ((patch.approval || patch.mode) && (!scoped || !readsOnly(thread.approval))) {
    next.approval = thread.approval;
    const seeded: Prefs["approvals"] = { ...prefs.approvals };
    for (const id of ["claude", "cursor", "codex", "pi"] as const) {
      if (seeded[id] === undefined) seeded[id] = prefs.approval;
    }
    seeded[thread.provider] = thread.approval;
    next.approvals = seeded;
  }
  if (patch.web) next.web = thread.web;
  if (patch.cwd && thread.cwd) {
    const cwd = path.normalize(thread.cwd);
    next.recentWorkspaces = [thread.cwd, ...prefs.recentWorkspaces.filter((dir) => path.normalize(dir) !== cwd)].slice(0, 12);
    const key = workspaceKey(thread.cwd);
    if (prefs.hiddenWorkspaces.some((dir) => workspaceKey(dir) === key)) {
      next.hiddenWorkspaces = prefs.hiddenWorkspaces.filter((dir) => workspaceKey(dir) !== key);
    }
    if (thread.scope.kind === "page" || thread.scope.kind === "folder") {
      next.scopeWorkspaces = { ...prefs.scopeWorkspaces, [`${thread.scope.kind}:${thread.scope.ref}`]: thread.cwd };
    }
  }
  if (typeof patch.useWorktree === "boolean" && thread.cwd) {
    next.worktrees = { ...prefs.worktrees, [workspaceKey(thread.cwd)]: patch.useWorktree };
  }
  return next;
}
