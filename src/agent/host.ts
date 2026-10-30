import { limitComponentAction, type ComponentRate } from "../plugins/componentHost.js";
import type { EffectivePermissions } from "./effectivePermissions.js";
import type { LaunchSettings, PageRunInput, ThreadRunInfo } from "../actions/types.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, dataDir } from "../config.js";
import { browserControl, browserActivity, browserTurnEnded, browserUserMessage, closeThreadBrowser } from "../browser.js";
import { log } from "../log.js";
import type { ActionCaller } from "../actions/types.js";
import { store } from "../store.js";
import { waitForEvents } from "../wait.js";
import { isBlankPage, type AccessTarget, type PageEvent, type Tab } from "../types.js";
import { addTargets, effectiveLevel, pageKeysInText, pageReach, sameTarget, type AccessPage, type PageReader, type Reach, type ThreadPageGrant } from "../pageAccess.js";
import { deviceKeysInText, type RemoteAgent } from "../devices/agentAccess.js";
import { AgentDb } from "./db.js";
import { diffPatch, diffTrees, fileAtTree, findRepo, git, repoRelative, revertTrees, snapshotTree } from "./git.js";
import { syncDependencies } from "./deps.js";
import { commitAll, createWorktree, discardWorktree, dropBranchIfEmpty, headCommit, mergeWorktree, removeWorktree, reopenWorktree, resetHead, unlinkOrphanedWorktrees, worktreeProgress, worktreeRemaining, worktreeStatus, type WorktreeStatus } from "./worktree.js";
import { lastSeenPages, pageEditsBlock, pageEditsSince, rememberPages, writePageRefs, type PageSnapshot } from "./pageEdits.js";
import { cleanInstructionsOff, contextBlock, cursorScribeServers, freshContext, guidesBlock, implementText, pageKeysIn, planTurnNote, threadInstructions, type PageGuide, type ScopeInfo } from "./prompt.js";
import { plugins, pluginActions } from "../plugins/current.js";
import { componentStateAllowed } from "../plugins/manifest.js";
import { checkPermission } from "../pagePermissions.js";
import { PageProblems } from "../pageProblems.js";
import { probeComponent } from "../screenshot.js";
import { forgetGuides, guideSent, markGuideSent } from "../guideMemory.js";
import { filePath, filesBlock, removeFiles, removeThreadFiles, saveFiles } from "./attachments.js";
import { saveOutputImage } from "./outputImages.js";
import { readSnapshot, removeThreadSnapshots, saveSnapshot } from "./fileSnapshots.js";
import { findSvnRoot, svnEnd, svnStart, type SvnStart } from "./svn.js";
import { ClaudeProvider, type ContextMeasure } from "./providers/claude.js";
import { UsageWindowStarts, cleanWindowStarts, type WindowStartState } from "./usageWindowStarts.js";
import { CodexProvider, codexAccountId, fetchCodexPlanUsage } from "./providers/codex.js";
import { CursorProvider, isSdkAgentId } from "./providers/cursor.js";
import { FAKE_AGENTS, FakeProvider } from "./providers/fake.js";
import { PiProvider, type PiLoginView } from "./providers/pi.js";
import { HOOKS_FEATURE, HookPipeline, OBSERVE_DEADLINE_MS, earlyEnd, holdsAll, isGating, normalizeRules, ruleDetectors, toolCallText, verdict, clip as clipChunk, type Chunk, type Detector, type Finding, type HookDecide, type HookEvent, type HookRule } from "./hooks.js";
import { mlService } from "../ml/service.js";
import type { SendKind } from "../ml/types.js";
import { migrateOpenaiPrefs, migrateOpenaiThread } from "./legacyOpenai.js";
import { normalizeSource, sourceView, splitModelId, type OpenAISource, type OpenAISourceView } from "./openaiSources.js";
import type {
  AgentProvider,
  ApprovalDecision,
  ApprovalRequest,
  PlanDecision,
  ProviderSession,
  QuestionAnswer,
  QuestionRequest,
  RunSink,
  SessionContext,
  ToolGateCall,
  ToolScanCall,
  ToolGateResult,
  ToolPatch,
  ToolStart,
  TurnResult,
} from "./providers/provider.js";
import { unifiedDiff } from "./textDiff.js";
import { MAX_FORK_MESSAGE, MAX_FORK_MIDDLE, clip, forkBlock, summaryPrompt, type ForkMaterial } from "./fork.js";
import { trackPace, withPace, type PaceState } from "./planPace.js";
import { applyExpiredWindows, codexUsageRecoveryAllowed, livePlanLimits, nextRefreshAt, planLimitsFromCodexRateLimits, planLimitsFromCursorUsage, planLimitsFromRateLimitInfo, usageLimitResetsAt } from "./planLimits.js";
import { claudeBillingSource, claudePlanSnapshot } from "./claudeUsage.js";
import { ClaudeAccountPool, SWITCHED_ACCOUNT_PROMPT, mergeClaudeLimits, type AccountView } from "./claudeAccountPool.js";
import { DEFAULT_ACCOUNT } from "./claudeAccounts.js";
import { isPlainRecord } from "./types.js";
import { DEFAULT_RESUME_PROMPT, PageRuns, RESUME_DELAY_MS, runView, type PageRun, type RunInput } from "./pageRuns.js";
import { claudeOwnServers, mergedServers, readMcpFile, resolveServer, serverModes, serversForThread, threadWorkspace, writeMcpFile } from "./mcpConfig.js";
import { McpPermissions } from "./mcpPermissions.js";
import { threadStats, type ThreadStats } from "./threadStats.js";
import { threadOrigin, usageCsv, usageHistory, type UsageHistory, type UsageSource } from "./usageHistory.js";
import { turnLatency } from "./latency.js";
import { boardTools, discoverSkills, estimateTokens, harnessStats, instructionSections, ownContext, probeServer, seedTokens, skillFolders, type HarnessStats, type SkillInfo, type ToolList } from "./harness.js";
import { harnessDocs, parseHarnessOps, planHarnessChange, writeHarnessPlan } from "./harnessSetup.js";
import { findMoved, folderExists, folderId, moveClaudeProject, movePath, type KnownWorkspace } from "./workspaceMove.js";
import { cleanApprovals, cleanDisabledModes, cleanForkSummarizers, DEFAULT_PREFS, summaryChoice, modelChoice, prefsPatchFromChoices, seedForkSummarizers, seedModelSettings, settingPatch, workspaceKey, type Prefs, type ThreadPatch } from "./prefs.js";
import { ScribeSkills } from "./scribeSkills.js";
import { cleanCustomModes, modeKeepsServer, modeMax, modeOff, READ_SHELL_WAIT_MS, readShell, settleNoTools, threadCustom } from "./customModes.js";
import { pageOwned } from "./threadList.js";
import { activityKey, threadActivity } from "./activity.js";
import { sumThreadUsage, sumUsageTree } from "./usage.js";
import { likePatterns, matchMessages, messageSnippet, searchWords, type ThreadMessageHit } from "./threadSearch.js";
import { allowedGrants, canReadThread, grantScopes, isMessage, itemMatches, itemText, queryWords, requestableScopes, scopeLabel, scopesGranted, threadScopeLabel, type AccessScope, type ScopeLookup } from "./threadAccess.js";
import { grantRows, revokeGrant } from "./grants.js";
import { addToolGrants, cleanCommandAllowlist, grantAllows, grantFor, grantOptions, pathInside, realTarget, threadCwd, withGrantOptions } from "./toolGrants.js";
import { cleanMemories, memoriesFor, memoryApplies, memoryOwner, memoryPlace, saveMemory, type Memory } from "./memory.js";
import { WEB_IMPORTANCE_WAIT_MS, parseWebImportance, cleanAllowlist, cleanSearxngUrl, grantWeb, parseWebAccess, webCallAllowed, webCallDomains, webPassCovers, type WebCall, type WebImportance } from "./webAccess.js";
import type {
  AgentEvent,
  ApprovalOption,
  ApprovalPolicy,
  ChatFile,
  ChatImage,
  ContextChip,
  FileChange,
  FileRef,
  Item,
  ItemBody,
  ModelOption,
  PlanLimits,
  ProviderId,
  ProviderStatus,
  RunStatus,
  SlashCommand,
  Thread,
  ThreadMode,
  ThreadScope,
  ThreadView,
  ThreadWorktree,
  StaleWorktree,
  TaskInfo,
  Turn,
  Usage,
} from "./types.js";
import { APPROVAL_LABEL, APPROVALS, approvalRank, changeAccess, isProviderId, minApproval, type ModeInput, noPages, pagesReadsFiles, parseApproval, parseMode, planAccess, readsOnly, settleAccess, wantsPlan } from "./types.js";
import { PAGE_INTENT_NOTE, pageIntentDetectors } from "./pageIntent.js";
import { reviewNativeCommand } from "./nativeReview.js";
import { cleanProtectedPaths, policyFor, type PolicyEnv } from "./access.js";
import { blockSummary, resetSandbox, sandboxed, sandboxNet, type SandboxBlock, type SandboxHooks } from "./sandbox.js";
import { injectionDetectors } from "./injection.js";

import { parseComponentInput, componentJson, componentString, componentText, componentLink, type ComponentAnswer, type ComponentItem, type ComponentInput } from "./componentTool.js";
export type { Prefs } from "./prefs.js";
export { workspaceKey } from "./prefs.js";

const FLUSH_MS = 700;
/** Cursor's usage comes from a private API call, so refresh it at most this often (after turns). */
const CURSOR_USAGE_TTL_MS = 10 * 60 * 1000;
/** How often to check Claude usage again while a window has reset but no new one is reported. */
const EXPIRED_USAGE_RETRY_MS = 60 * 60 * 1000;
/** Characters of earlier conversation sent after a rewind to a provider that cannot fork. */
const MAX_RECAP = 24_000;
/** Providers drop the saved sessions no thread uses a few minutes after start, then every few hours. */
const PRUNE_FIRST_MS = 5 * 60 * 1000;
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
/** A worktree no turn has used this long is closed when it holds no changes, else listed as stale (#686). */
const WORKTREE_IDLE_MS = 2 * 24 * 60 * 60 * 1000;
const WORKTREE_SWEEP_FIRST_MS = 10 * 60 * 1000;
const WORKTREE_SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;
/** Stale worktrees are brought up at most this often. */
const WORKTREE_REMIND_MS = 24 * 60 * 60 * 1000;
const DELTA_MS = 50;
/**
 * How long a result of one of Scribe's own tools is held for the classifier before the agent gets it
 * unscanned (fail open). Longer than a tool call's budget: a result is scanned in several windows.
 */
const SCAN_HOLD_MS = 2500;

/**
 * Where a provider cannot hold a call (Codex, Cursor), a hook's ask or block waits this long for the
 * call's approval request to turn up, which it can answer, before it falls back to stopping the turn.
 */
const HOOK_GRACE_MS = 400;

/** In a thread nobody watches (a board worker, its helpers), a hook's ask is refused after this long, as a useful web request is. */
const HOOK_ASK_WAIT_MS = WEB_IMPORTANCE_WAIT_MS.useful ?? 15 * 60 * 1000;
const HOOK_ASK_TIMEOUT = "Nobody answered the hook's approval in time, so the call was not run. Leave it out, and mention it in your result.";
const READ_SHELL_TIMEOUT = "Nobody answered in time, so the command was not run. Carry on without it, and mention what you could not check.";

/** The approval's line saying when an unanswered request is refused. */
function refusedBy(waitMs: number): string {
  return `Refused if not answered by ${new Date(Date.now() + waitMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}; the agent then goes on without it.`;
}

/** `signal`, also aborted after `waitMs` (null: never), for a wait nobody may answer. */
function withDeadline(waitMs: number | null, signal?: AbortSignal): { signal?: AbortSignal; timedOut: () => boolean; done: () => void } {
  if (waitMs === null) return { signal, timedOut: () => false, done: () => {} };
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  if (signal?.aborted) abort.abort();
  else signal?.addEventListener("abort", onAbort);
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    abort.abort();
  }, waitMs);
  timer.unref?.();
  return {
    signal: abort.signal,
    timedOut: () => late,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** At most this often, a running thread is sent again because its live step changed. */
const ACTIVITY_MS = 1000;
const MAX_TOOL_OUTPUT = 20_000;
/** How much of a tool's output the tool_result hooks read; past it they get its head and tail. */
const MAX_HOOK_OUTPUT = 200_000;
const MAX_TOOL_DIFF = 200_000;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** How long an "Allow once" from web_request waits for the call it allowed. */
const WEB_PASS_MS = 10 * 60 * 1000;

/** The thread's worktree while it is open. */
export function openWorktree(thread: Thread): ThreadWorktree | null {
  return thread.worktree && !thread.worktree.closed ? thread.worktree : null;
}

/** Threads on an editing rung in a workspace can have a worktree; Read-only and Board never edit files. */
/** Helpers one thread may have working at once. */
/** How long a tainted thread's request for an untrusted helper waits for the user before it is denied (#269). */
const TAINTED_HELPER_WAIT_MS = 15 * 60_000;
const MAX_HELPERS = 10;

function wantsWorktree(thread: Thread): boolean {
  return Boolean(thread.useWorktree && thread.cwd && thread.mode === "code" && !openWorktree(thread));
}

/** Folderless threads run in Scribe's scratch folder. */
function workspaceFolderError(thread: Thread): string | null {
  if (!thread.cwd) return null;
  try {
    if (!fs.statSync(thread.cwd).isDirectory()) return `Not a folder: ${thread.cwd}`;
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return `Folder not found: ${thread.cwd}`;
    return `Cannot access folder: ${thread.cwd}: ${(err as Error).message}`;
  }
}

type Pending =
  | { kind: "browser_handoff"; threadId: string; itemId: string; resolve: (a: string[]) => void; reject: (err: Error) => void }
  | { kind: "approval"; threadId: string; itemId: string; resolve: (d: ApprovalDecision) => void; reject: (err: Error) => void }
  | { kind: "question"; threadId: string; itemId: string; resolve: (a: QuestionAnswer) => void; reject: (err: Error) => void }
  | { kind: "component"; threadId: string; itemId: string; resolve: (a: ComponentAnswer) => void; reject: (err: Error) => void };

function approvalFor(prefs: Prefs, provider: ProviderId): ApprovalPolicy {
  return prefs.approvals[provider] ?? prefs.approval;
}

function snapshotWindows(limits?: PlanLimits): PlanLimits["windows"] {
  return (limits?.windows ?? []).map((w) => ({ ...w }));
}

/** How much of each window this turn used, from the snapshot taken when it started. */
function planUsed(before: PlanLimits["windows"], after: PlanLimits["windows"]): NonNullable<Usage["plan"]> {
  return after
    .map((w) => {
      const prev = before.find((x) => x.id === w.id);
      const used = prev ? Math.max(0, w.utilization - prev.utilization) : 0;
      return { id: w.id, label: w.label, used };
    })
    .filter((w) => w.used >= 0.0005);
}

type QueuedMessage = {
  itemId?: string;
  edit?: { token: string; steer: boolean; withdrawal?: Promise<boolean> };
  text: string;
  images: ChatImage[];
  /** Attached files other than images. */
  files: ChatFile[];
  /** Where the images and files were saved, in the same order. */
  saved: { images: FileRef[]; files: FileRef[] };
  context: ContextChip[];
  from?: "page" | "component" | "scribe" | "agent" | "hook";
  /** A Kanban card the board sent this about (a comment on it, or Continue). */
  card?: CardRef;
  /** Typed into the floating chat over a page (pageIntent.ts). */
  dock?: boolean;
  /** A plan turn (#721): /plan, the composer's Plan chip, or a thread started in the old plan mode. */
  plan?: boolean;
};

/** The Kanban card a board message is about: its number and the board page it is on. */
/** reply: the key of the form page whose scribe.reply sent this (#320), posted on the card as the user's comment. */
export type CardRef = { num: number; title?: string; board: string; boardKey?: string; resume?: boolean; reply?: string };

/** Where a board message about a card came from; the host words it, so a page cannot pass one off as the user's. */
function cardOrigin(card: CardRef): string {
  const board = card.board ? `the Kanban board "${card.board}"${card.boardKey ? ` (${card.boardKey})` : ""}` : "its Kanban board";
  const name = `card #${card.num}${card.title ? ` "${card.title}"` : ""}`;
  const why = card.reply
    ? `The user answered ${card.reply} about ${name} of ${board}, which you worked on. Their answer is posted on the card as a comment; the board sent this, not the user in this chat.`
    : card.resume
    ? `The user pressed Continue on ${name} of ${board}, which you worked on before. The board sent this, not the user in this chat.`
    : `A new comment on ${name} of ${board}, which you are working on. The board passed it on: it was posted on the card, not typed in this chat. Take it into account in your work on the card, and answer it on the card if it asks something.`;
  return `<context>\n${why}\n</context>\n\n`;
}

/** How many restarts in a row may cut off a thread's turns before Scribe stops sending it on (a turn that crashes Scribe would loop). */
const MAX_RESUMES = 3;

/** The turns at the end that a restart cut off, in a row. */
function interruptedRun(turns: Turn[]): number {
  let n = 0;
  for (let i = turns.length - 1; i >= 0 && turns[i].interrupted; i--) n++;
  return n;
}

/** Added to the note of a thread whose helpers were cut off with it: the agent_run calls that waited for them are gone. */
function helperResumeNote(helpers: Thread[]): string {
  const list = helpers.map((t) => `${t.id} (${t.title})`).join(", ");
  return ` The agent_run ${helpers.length === 1 ? "call" : "calls"} you were waiting on ${helpers.length === 1 ? "is" : "are"} gone too, but ${helpers.length === 1 ? "that helper was" : "those helpers were"} sent on with ${helpers.length === 1 ? "its" : "their"} task: ${list}. To get a helper's report, call agent_run with its thread and no task: it waits for the helper to finish and returns what it did. Do not start a new helper for the same work.`;
}

const RESUME_NOTE =
  "Scribe restarted while you were working, and your last turn was cut off. Anything you were waiting on in it (a question, an approval, a background command) is gone. Check where you left off (files, git status, the pages or card you were working on) and go on from there to finish the task. If you were waiting for the user's answer, ask again.";

/** The notes a plan page sent with its accept or reject event (#721), from the event's data or else the page's state. */
function planNotes(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const notes = (value as { notes?: unknown }).notes;
  return typeof notes === "string" && notes.trim() ? notes.trim().slice(0, 4000) : undefined;
}

/** What a thread reads at the start of the turn after the workspace change it asked for with thread_update. */
function workspaceNote(cwd: string): string {
  return `The workspace is now ${cwd}, as you asked with thread_update. Commands run there and relative paths start there. Go on with the task.`;
}

/** The note for a helper: it works on another agent's brief, so what it still needs goes into its report, not to the user. */
const HELPER_RESUME_NOTE =
  "Scribe restarted while you were working, and your last turn was cut off. Anything you were waiting on in it (an approval, a background command) is gone. Check where you left off (files, git status, the pages you were working on) and go on from there to finish the brief you were given. You work for another agent, which gets your final reply as your report: do not ask the user about the task. If you cannot finish without an answer, say what you need in that reply.";

/** What the model reads for a message: where it came from, its context chips, the guides of the pages it brings up, its files, then the text. */
function promptText(msg: QueuedMessage, thread: Thread, guides: string, pageEdits = ""): string {
  const origin = msg.card
    ? cardOrigin(msg.card)
    : msg.from === "page"
      ? "<context>\nSent by the code of the Scribe page this thread belongs to (scribe.agent), not typed by the user.\n</context>\n\n"
      : msg.from === "component"
        ? "<context>\nSent by an inline component after a user interaction. The text was generated by the component's code.\n</context>\n\n"
      : msg.from === "scribe"
        ? "<context>\nSent by Scribe itself, not typed by the user.\n</context>\n\n"
        : msg.from === "hook"
          ? "<context>\nSent by one of the user's Scribe hooks, which matched something in this turn. Not typed by the user just now.\n</context>\n\n"
        : msg.from === "agent"
          ? "<context>\nA brief from the agent this helper thread works for, not typed by the user. Your final reply goes back to that agent.\n</context>\n\n"
          : msg.dock && !noPages(thread.scope)
            ? `<context>\n${PAGE_INTENT_NOTE}\n</context>\n\n`
            : "";
  const text = msg.card && !msg.card.resume ? `<card_comment>\n${msg.text}\n</card_comment>` : msg.text;
  const files = filesBlock(msg.files, msg.saved.files, { nativePdf: thread.provider === "claude", canReadFiles: thread.mode !== "board" || pagesReadsFiles(thread) });
  const recap = !thread.rewind?.recap
    ? ""
    : thread.rewind.migrated
      ? `<earlier_conversation>\nThis conversation moved to a new session, so you don't have its history. This is what was said so far, for context:\n\n${thread.rewind.recap}\n</earlier_conversation>\n\n`
      : `<earlier_conversation>\nThe user rewound this conversation and started a new session. This is what was said before the point they went back to, for context:\n\n${thread.rewind.recap}\n</earlier_conversation>\n\n`;
  return recap + origin + pageEdits + contextBlock(msg.context) + guides + files + text;
}

function editsInsideWorkspace(t: Thread, paths: string[] | undefined): boolean {
  const cwd = threadCwd(t);
  if (!cwd || !paths?.length) return false;
  try {
    const root = fs.realpathSync.native(cwd);
    return paths.every((file) => {
      const target = realTarget(cwd, file);
      return target !== null && pathInside(root, target);
    });
  } catch {
    // Missing roots, permissions errors and unresolvable links must never grant an edit.
    return false;
  }
}

/**
 * Approvals the thread's settings answer without asking: Scribe's own board tools, Pages mode's
 * refusals, and the "full" and "edits" approval levels. Null when the user has to decide.
 * Codex Auto-review runs in the native app-server, before this callback. Do not
 * turn "auto" into an unconditional host grant; any fallback request still asks.
 */
function autoApproval(t: Thread | undefined, req: ApprovalRequest): Promise<ApprovalDecision> | null {
  const allow = req.options.find((o) => o.kind === "allow_once") ?? req.options.find((o) => o.kind === "allow_always");
  const reject = req.options.find((o) => o.kind === "reject_once") ?? req.options.find((o) => o.kind === "reject_always");
  if (t?.noTools) {
    // A thread without tools (#729): anything a provider still offers is refused, never asked.
    const note = "This thread has no tools. Answer from the conversation alone.";
    return reject ? Promise.resolve({ optionId: reject.id, note }) : Promise.reject(new Error(note));
  }
  if (req.boardTool && allow) {
    return Promise.resolve({ optionId: allow.id });
  }
  if (t?.mode === "board" && req.tool !== "mcp" && req.tool !== "fetch" && req.tool !== "todo" && !(pagesReadsFiles(t) && (req.tool === "read" || req.tool === "search")) && !(req.tool === "execute" && readShell(t))) {
    // The Read-only and Board rungs never edit files; with a workspace they read there, and only Codex runs commands (#733).
    const note = pagesReadsFiles(t) ? `The ${APPROVAL_LABEL[t.approval]} rung reads files, but does not edit them or run commands.` : `The ${APPROVAL_LABEL[t.approval]} rung has no file or shell access.`;
    if (reject) return Promise.resolve({ optionId: reject.id, note });
    return Promise.reject(new Error(note));
  }
  if (req.humanOnly) return null;
  if (t?.approval === "full" && allow) {
    return Promise.resolve({ optionId: allow.id });
  }
  if ((t?.approval === "edits" || (t?.provider === "pi" && t.approval === "auto")) && allow && (req.tool === "edit" || req.tool === "delete" || req.tool === "move") && editsInsideWorkspace(t, req.paths)) {
    return Promise.resolve({ optionId: allow.id });
  }
  return null;
}

/** A gating verdict as the approval flow uses it: what to do, and the line that tells the user or agent why. */
function hookSays(strongest: ReturnType<typeof verdict>): { kind: "block" | "ask"; reason: string } | null {
  if (!strongest) return null;
  const { finding } = strongest;
  if (finding.action.kind === "block") return { kind: "block", reason: finding.action.reason };
  return { kind: "ask", reason: finding.reason ? `Hook (${finding.label}): ${finding.reason}` : `A hook (${finding.label}) wants your approval for this call.` };
}

/** PDFs, for providers that read them as documents beside the text that names them. */
function pdfs(msg: QueuedMessage): ChatFile[] {
  return msg.files.filter((file) => file.mimeType === "application/pdf");
}

/** A saved file as the transcript keeps it: without its local path. */
function fileEntry(ref: FileRef): FileRef {
  return { id: ref.id, name: ref.name, mimeType: ref.mimeType, size: ref.size };
}

/** Saved hook rules; ones an older or hand-edited file got wrong are dropped, not thrown on. */
function savedRules(value: unknown): HookRule[] {
  try {
    return normalizeRules(value);
  } catch {
    return [];
  }
}

function userBody(msg: QueuedMessage): Extract<ItemBody, { kind: "user" }> {
  return {
    kind: "user",
    text: msg.text,
    ...(msg.saved.images.length ? { images: msg.saved.images.map(fileEntry) } : {}),
    ...(msg.saved.files.length ? { files: msg.saved.files.map(fileEntry) } : {}),
    ...(msg.context.length ? { context: msg.context } : {}),
    ...(msg.from ? { from: msg.from } : {}),
    ...(msg.dock ? { dock: true } : {}),
    ...(msg.plan ? { plan: true } : {}),
    ...(msg.card ? { card: { num: msg.card.num, ...(msg.card.title ? { title: msg.card.title } : {}), ...(msg.card.resume ? { resume: true } : {}), ...(msg.card.reply ? { reply: msg.card.reply } : {}) } } : {}),
  };
}

type RunState = {
  turn: Turn;
  /** The turn's sink, for asks that come from Scribe's own tools (a read outside the roots, #898). */
  sink?: RunSink;
  /** A plan turn's answer on its plan page (#721): accept starts the implementation turn after it. */
  plan?: { accepted: boolean; notes?: string; page: string };
  /** Actual Native source after model resolution, including default/fallback models. */
  memoryOwner?: ReturnType<typeof memoryOwner>;
  textItem: Item | null;
  reasoningItem: Item | null;
  tools: Map<string, Item>;
  /** Last known content per absolute path this turn, for per-tool diffs. */
  known: Map<string, string | null>;
  /** Without git: each changed file's content before its first and after its last edit this turn, by display path. */
  versions: Map<string, { before: string | null; after: string | null }>;
  /** An svn working copy: what was already changed when the turn started, to find the turn's own edits (shell ones too). */
  svn?: SvnStart;
  repo: string | null;
  cancelled: boolean;
  usage: Usage;
  /** For the turn's latency (latency.ts): prompt sent, first output, waits on the user. */
  clock?: { sentAt?: number; firstAt?: number; waits: Array<[number, number | undefined]> };
  /** A queued message handed to this turn with steer, until the agent takes it in. */
  steer: { id: string; msg: QueuedMessage; itemId: string | undefined } | null;
  /** A workspace the agent asked for with thread_update and the user allowed: the thread moves there when the turn ends. */
  workspace?: { cwd: string; continue: boolean };
  hooks: {
    /** The user's message this turn answers, as context for classifier questions. */
    lastUser: string;
    /** That message came from the floating chat (Chunk.dock). */
    dock: boolean;
    /** Tool calls whose tool_call event has fired. */
    called: Set<string>;
    /** Tool calls a gate held (toolGate), so their approval request is not gated a second time. */
    gated: Set<string>;
    /** Tool calls the user approved because a hook asked: their own approval request does not ask again. */
    approved: Set<string>;
    /** Seen on a provider that could not hold them: an ask or block waiting for the call's approval request. */
    waiting: Map<string, { found: Finding[]; timer: NodeJS.Timeout }>;
    /** Detectors that already told the agent something this turn. */
    told: Set<string>;
    /** The text block whose opening has been through the early hook. */
    earlyItem: string | null;
    /** Why the turn is suspect (Chunk.suspect), once something it read looked like a prompt injection. */
    suspect: string | null;
    /** A long tool output as the provider gave it (head and tail past MAX_HOOK_OUTPUT), where the transcript item keeps only its head. */
    outputs?: Map<string, string>;
  };
  /** Stops the summary a fork's first turn waits for. */
  abort?: AbortController;
};

/** What page_ask hands back to the agent. */
export type PageAskResult =
  | { answered: true; page: { id: string; key: string }; events: PageEvent[]; cursor: number; state: unknown; stateRevision: number }
  | { answered: false; page: { id: string; key: string }; cursor: number; closed: boolean; deleted: boolean; timedOut: boolean }
  | { skipped: true; note?: string; page: { id: string; key: string } }
  | { cancelled: true; page: { id: string; key: string } };

/** A workspace folder that is gone, and the folder Scribe thinks it became (same file id), if any. */
export type MissingWorkspace = { path: string; threads: number; found: string | null; dismissed: boolean };

/** plan: send it as a plan turn (#721), or false to drop a thread's planNext; text starting with /plan is one too. */
export type SendInput = { text: string; images?: ChatImage[]; files?: ChatFile[]; context?: ContextChip[]; from?: "page" | "component" | "scribe" | "agent" | "hook"; card?: CardRef; dock?: boolean; plan?: boolean };

export class AgentHost {
  readonly db: AgentDb;
  private providers: Record<ProviderId, AgentProvider>;
  /** With SCRIBE_FAKE_AGENTS=1: what runs every provider's threads, so tests start no real agent. */
  private fakes: Record<ProviderId, AgentProvider> | null = null;
  private threads = new Map<string, Thread>();
  private sessions = new Map<string, ProviderSession>();
  private effectivePermissions = new Map<string, EffectivePermissions>();
  /** Threads already told that the sandbox could not start (#899): said once. */
  private sandboxMissingSaid = new Set<string>();
  private runs = new Map<string, RunState>();
  private status = new Map<string, RunStatus>();
  private unread = new Set<string>();
  private queues = new Map<string, QueuedMessage[]>();
  private items = new Map<string, Item[]>();
  private turns = new Map<string, Turn[]>();
  private seq = new Map<string, number>();
  private dirty = new Map<string, Item>();
  private pending = new Map<string, Pending>();
  private browserHandoffs = new Set<string>();
  private componentWrites = new Map<string, { at: number; count: number }>();
  /** "Allow once" answers to web_request, per thread, until a web call uses them. */
  private webPasses = new Map<string, Array<{ call: WebCall; at: number }>>();
  /** agent_run calls waiting for a helper thread to go idle. */
  private turnWaiters = new Map<string, Array<() => void>>();
  private commandCache = new Map<string, SlashCommand[]>();
  private deltaBuf = new Map<string, { threadId: string; text: string }>();
  private deltaTimer: NodeJS.Timeout | null = null;
  /** Per thread: the activity last sent with it, and a pending resend after a live step changed. */
  private activitySent = new Map<string, string>();
  private activityTimers = new Map<string, NodeJS.Timeout>();
  private flushTimer: NodeJS.Timeout | null = null;
  /** Threads whose turn a restart cut off, until resumeInterrupted sends them on. They count as running meanwhile. */
  private resuming = new Set<string>();
  private ctx: SessionContext;
  /** Chats pages handed over to be seen through: limit waits, resumes, merges (#285). */
  private pageRuns: PageRuns;
  private pageRunTimer: NodeJS.Timeout | null = null;
  /** User threads queued to go on once their usage limit resets (#78): thread id → its usage_limit item. */
  private limitResumes = new Map<string, string>();
  /** Last turn that should receive the next plan-usage report for its provider. Survives the run ending. */
  private limitTurn: { provider: ProviderId; threadId: string; turnId: string; before: PlanLimits["windows"] } | null = null;
  /** Detectors beside the user's rules (hooks.ts). Features built on hooks add theirs here. */
  readonly detectors: Detector[] = [...pageIntentDetectors(), ...injectionDetectors()];
  private ruleDetectors: Detector[] | null = null;
  /** The decision service hooks ask; tests put a fake in its place. */
  hookBackend: { decide: HookDecide; maySend(kind: SendKind): boolean } = {
    decide: (state, questions, options) => mlService().decide(state, questions, options),
    maySend: (kind) => mlService().maySend(kind),
  };
  private hooks = new HookPipeline({
    detectors: () => this.hookDetectors(),
    decide: (state, questions, options) => this.hookBackend.decide(state, questions, options),
    maySend: (kind) => this.hookBackend.maySend(kind),
    log,
  });

  /** Scribe's own skills (#239). */
  readonly scribeSkills: ScribeSkills;

  constructor(private emit: (event: AgentEvent) => void, private readCodexUsage: () => Promise<unknown> = fetchCodexPlanUsage) {
    this.db = new AgentDb();
    this.scribeSkills = new ScribeSkills(this.db);
    try {
      this.scribeSkills.scan();
    } catch (err) {
      log(`skills scan failed: ${(err as Error).message}`);
    }
    this.providers = { claude: new ClaudeProvider(), cursor: new CursorProvider(), codex: new CodexProvider(), pi: new PiProvider(() => this.modelSources(), () => void this.models("pi", true).catch(() => undefined)) };
    if (FAKE_AGENTS) {
      const deps = {
        runAction: (page: string, name: string, args: Record<string, unknown>, caller: ActionCaller) => store.runAction(page, name, args, caller, (id) => this.runInfo(id)).result,
        runInfo: (id: string) => this.runInfo(id),
        runHelper: (id: string, opts: { title: string; task: string; provider: string; signal: AbortSignal }) => this.runHelper(id, opts),
        delayMs: Number(process.env.SCRIBE_FAKE_AGENT_DELAY) || undefined,
      };
      this.fakes = { claude: new FakeProvider("claude", "Claude", deps), cursor: new FakeProvider("cursor", "Cursor", deps), codex: new FakeProvider("codex", "Codex", deps), pi: new FakeProvider("pi", "Native", deps) };
      log("SCRIBE_FAKE_AGENTS=1: chats run fake agents (no model, tools or MCP)");
    }
    const claudeModels = this.db.getSetting<ModelOption[]>("models.claude", []);
    (this.providers.claude as ClaudeProvider).setModelCache(claudeModels);
    (this.providers.cursor as CursorProvider).setModelCache(this.db.getSetting<ModelOption[]>("models.cursor", []));
    (this.providers.codex as CodexProvider).setModelCache(this.db.getSetting<ModelOption[]>("models.codex", []));
    for (const thread of this.db.listThreads()) {
      if (migrateOpenaiThread(thread)) this.db.saveThread(thread);
      this.threads.set(thread.id, thread);
      // A turn cannot survive a daemon restart: mark leftovers as cancelled, and send the thread on once Scribe is up.
      const turns = this.db.listTurns(thread.id);
      for (const turn of turns) {
        if (turn.status === "running") {
          turn.status = "cancelled";
          turn.interrupted = true;
          turn.endedAt = turn.endedAt ?? Date.now();
          this.db.saveTurn(turn);
        }
      }
      if (turns.at(-1)?.interrupted && interruptedRun(turns) <= MAX_RESUMES) this.resuming.add(thread.id);
    }
    try { new McpPermissions().pruneThreads(this.threads.keys()); }
    catch (err) { log(`Pruning MCP permissions failed: ${(err as Error).message}`); }
    // Worktrees left behind by a crash or a lost thread: cut their node_modules links, so removing them by hand is safe.
    const openWorktrees = [...this.threads.values()].flatMap((t) => openWorktree(t)?.path ?? []);
    for (const link of unlinkOrphanedWorktrees(openWorktrees)) log(`Unlinked ${link} from a worktree no thread uses`);
    const scratchDir = path.join(dataDir(), "agent", "scratch");
    fs.mkdirSync(scratchDir, { recursive: true });
    const entry = fileURLToPath(new URL("../index.js", import.meta.url));
    const env: Record<string, string> = { SCRIBE_PORT: String(PORT) };
    if (process.env.SCRIBE_HOME) env.SCRIBE_HOME = process.env.SCRIBE_HOME;
    this.ctx = {
      summarizeContext: (thread, prompt, signal) => this.summarizeContext(thread, prompt, signal),
      boardMcp: { command: process.execPath, args: [entry], env },
      scratchDir,
      accessEnv: () => this.accessEnv(),
      sandbox: (threadId, cwd) => this.sandboxHooks(threadId, cwd),
      // Page workers run unattended; helpers do not hand anything in themselves.
      isWorker: (id) => !this.threads.get(id)?.helperOf && this.unattended(id),
      workerTools: (id) => {
        const thread = this.threads.get(id);
        const page = thread?.scope.kind === "page" && thread.scope.ref ? store.get(thread.scope.ref) : undefined;
        return page && store.drives(page) ? { boardActions: true, reports: true } : {};
      },
      permissions: (id, policy) => {
        const thread = this.threads.get(id);
        if (!thread) return;
        this.effectivePermissions.set(id, { ...policy });
        this.emit({ type: "agent_thread", thread: this.view(thread) });
      },
      webAllowlist: () => this.prefs().webAllowlist,
      webSearchUrl: () => this.prefs().searxngUrl,
      claudeHooks: () => this.prefs().claudeHooks,
      mcpServers: (thread) => serversForThread(thread),
      // Not for board workers: nobody watches their threads to approve commands.
      cursorHostShell: (threadId) => this.prefs().cursorHostShell && !this.unattended(threadId),
      limits: (provider, info) => this.recordLimits(provider, info),
      claudeEnv: (thread) => this.claudePool.env(thread.claudeAccount),
      claudeLimits: (threadId, limits) => {
        if (this.closed) return;
        const account = this.threads.get(threadId)?.claudeAccount;
        if (account && account !== DEFAULT_ACCOUNT) {
          // An added account's reading (#452): its own meter, never the default account's.
          this.claudeThreadLimits.set(threadId, limits);
          this.db.setSetting("claudeThreadLimits", Object.fromEntries(this.claudeThreadLimits));
          this.claudePool.record(account, limits);
          this.emitThread(threadId);
          return;
        }
        const previous = this.claudeThreadLimits.get(threadId);
        if (limits.availability === "unavailable" && limits.detail === "Claude quota unavailable" && previous) {
          limits = claudePlanSnapshot(null, limits.billingSource ?? {}, limits.at, previous);
        }
        this.claudeThreadLimits.set(threadId, limits);
        this.db.setSetting("claudeThreadLimits", Object.fromEntries(this.claudeThreadLimits));
        this.recordClaudeLimits(limits);
        this.emitThread(threadId);
        if (limits.availability === "available" && !this.fakes) void this.refreshClaudeUsage();
      },
      task: (threadId, toolId, patch) => this.patchTask(threadId, toolId, patch),
      followUp: (threadId, id) => this.followUp(threadId, id),
      approval: (threadId, req) => this.approveBetweenTurns(threadId, req),
      webRequest: (threadId, call, opts) => this.requestWeb(threadId, call, opts),
      toolGate: (threadId, call, signal) => this.toolGate(threadId, call, signal),
      scanResult: (threadId, call) => this.scanResult(threadId, call),
    };
    this.planLimits = this.db.getSetting<Partial<Record<ProviderId, PlanLimits>>>("limits", {});
    // Keep source-tagged observations across restarts, without reviving legacy unscoped meters.
    if (this.planLimits.claude?.source !== "claude") delete this.planLimits.claude;
    this.planPace = this.db.getSetting<PaceState>("limitPace", {});
    this.claudeThreadLimits = new Map(Object.entries(this.db.getSetting<Record<string, PlanLimits>>("claudeThreadLimits", {}))
      .filter(([id]) => this.threads.get(id)?.provider === "claude"));
    this.usageWindowStarts = new UsageWindowStarts({
      now: () => Date.now(),
      enabled: () => ({ claude: !this.loggingOut.has("claude") && this.prefs().usageWindowStarts.claude,
        codex: !this.loggingOut.has("codex") && this.prefs().usageWindowStarts.codex }),
      running: (provider) => [...this.runs.keys(), ...this.resuming].some((id) => this.threads.get(id)?.provider === provider),
      read: async (provider) => {
        if (this.closed || this.fakes || this.loggingOut.has(provider)) return null;
        const generation = this.authGenerations.get(provider);
        if (provider === "codex") {
          const parsed = planLimitsFromCodexRateLimits(await this.readCodexUsage(), Date.now());
          if (this.closed || this.loggingOut.has(provider) || generation !== this.authGenerations.get(provider)) return null;
          if (parsed) this.commitLimits(provider, parsed, false);
          return parsed;
        }
        const beforeRead = this.planLimits.claude;
        const report = await (this.providers.claude as ClaudeProvider).fetchPlanUsage();
        if (this.closed || this.loggingOut.has(provider) || generation !== this.authGenerations.get(provider)) return null;
        if (this.planLimits.claude !== beforeRead) return null;
        const parsed = this.claudeUsageSnapshot(report);
        if (parsed.availability === "available" || beforeRead?.availability !== "available") this.commitLimits(provider, applyExpiredWindows(parsed), false);
        return parsed;
      },
      start: async (provider, signal) => {
        if (provider === "claude") await (this.providers.claude as ClaudeProvider).startUsageWindow(signal);
        else await (this.providers.codex as CodexProvider).startUsageWindow(signal);
      },
      save: (state) => {
        if (this.closed) return;
        this.db.setSetting("usageWindowStarts", state);
        this.emit({ type: "agent_limits", limits: this.liveLimits() });
      },
    }, this.db.getSetting<WindowStartState>("usageWindowStarts", {}));
    // Older versions kept fresher observations on individual threads only.
    this.claudePool = new ClaudeAccountPool({
      getSetting: (key, fallback) => this.db.getSetting(key, fallback),
      setSetting: (key, value) => this.db.setSetting(key, value),
      provider: () => this.providers.claude as ClaudeProvider,
      dataDir: dataDir(),
      defaultLimits: () => this.planLimits.claude,
      running: (account) => [...new Set([...this.runs.keys(), ...this.resuming])].filter((id) => {
        const thread = this.threads.get(id);
        return thread?.provider === "claude" && (thread.claudeAccount ?? DEFAULT_ACCOUNT) === account;
      }).length,
      changed: () => {
        if (!this.closed) this.emit({ type: "agent_limits", limits: this.liveLimits() });
      },
      offline: Boolean(this.fakes),
    });
    for (const [id, limits] of [...this.claudeThreadLimits].sort((a, b) => a[1].at - b[1].at)) {
      const account = this.threads.get(id)?.claudeAccount;
      if (!account || account === DEFAULT_ACCOUNT) this.recordClaudeLimits(limits);
    }
    if (!this.fakes) {
      this.usageWindowTimer = setInterval(() => void this.usageWindowStarts.tick(), 30_000);
      this.usageWindowTimer.unref?.();
    }
    this.pageRuns = new PageRuns(
      {
        now: () => Date.now(),
        exists: (id) => this.threads.has(id),
        idle: (id) => this.threads.has(id) && !this.runs.has(id) && !this.resuming.has(id) && (this.status.get(id) ?? "idle") === "idle" && !this.queues.get(id)?.length,
        lastTurn: (id) => this.db.listTurns(id).at(-1),
        switchAccount: (id) => this.switchClaudeAccount(id),
        recoveryAllowed: (id, turn) => {
          if (this.threads.get(id)?.provider !== "codex") return true;
          const allowed = codexUsageRecoveryAllowed(this.planLimits.codex, turn.endedAt ?? turn.startedAt);
          if (!allowed) void this.refreshCodexUsage();
          return allowed;
        },
        hasWorktree: (id) => Boolean(this.threads.get(id) && openWorktree(this.threads.get(id)!)),
        hold: (run) => {
          const tab=store.get(run.pageId);
          return tab && pluginActions?.binding(tab)?pluginActions.runHold(tab,run.threadId):store.runHold(run.pageId,run.threadId);
        },
        send: (id, text) => void this.send(id, { text, from: "page" }),
        merge: async (id) => (await this.finishWorktree(id, "merge")).message,
        save: (runs) => this.db.setSetting("pageRuns", runs),
        changed: (run, note) => {
          this.emitThread(run.threadId);
          if (note) {
            const tab=store.get(run.pageId);
            if(tab && pluginActions?.binding(tab))void pluginActions.runEvent(tab,{...note,thread:run.threadId,run:runView(run)}).catch(error=>log("Plugin run event failed",String(error)));
            else store.runEvent(run.pageId,run.threadId,runView(run),note);
          }
        },
      },
      this.db.getSetting<PageRun[]>("pageRuns", [])
    );
    this.limitResumes = new Map(Object.entries(this.db.getSetting<Record<string, string>>("limitResumes", {})));
    this.pageRunTimer = setInterval(() => {
      this.pageRuns.tick();
      this.checkLimitResumes();
    }, 30_000);
    this.pageRunTimer.unref?.();
    this.scheduleClaudeUsageRefresh();
    if (!this.fakes) {
      this.codexUsageTimer = setTimeout(() => void this.refreshCodexUsage(), 1000);
      this.codexUsageTimer.unref?.();
    }
    this.pruneTimer = setTimeout(() => this.pruneSessions(), PRUNE_FIRST_MS);
    this.pruneTimer.unref?.();
    this.worktreeTimer = setTimeout(() => this.sweepWorktrees(), WORKTREE_SWEEP_FIRST_MS);
    this.worktreeTimer.unref?.();
    this.unusedPages = new Set(this.db.getSetting<string[]>("unusedPages", []));
    store.on("tab_closed", this.onPageClosed);
    store.on("tab_upserted", this.onPageUpserted);
    this.scheduleUnusedPageCleanup();
    this.noteWorkspaces(this.workspaceFolders().values());
  }

  private unusedPages = new Set<string>();
  private unusedPageCleanupScheduled = false;

  private onPageClosed = (id: string): void => {
    const tab = store.get(id);
    if (!tab || !isBlankPage(tab) || tab.provenance) return;
    this.unusedPages.add(id);
    this.cleanupUnusedPages();
  };

  private onPageUpserted = (tab: { id: string }): void => {
    // Reopening cancels the request, including if this tab is later parked in another space.
    if (!store.isClosed(tab.id) && this.unusedPages.delete(tab.id)) {
      this.db.setSetting("unusedPages", [...this.unusedPages]);
    }
  };

  private scheduleUnusedPageCleanup(): void {
    if (this.closed || !this.unusedPages.size || this.unusedPageCleanupScheduled) return;
    this.unusedPageCleanupScheduled = true;
    // A completed turn may start its queued/carried message in the same stack.
    queueMicrotask(() => {
      this.unusedPageCleanupScheduled = false;
      if (!this.closed) this.cleanupUnusedPages();
    });
  }

  private cleanupUnusedPages(): void {
    const openInSpaces = new Set(store.spacesView().spaces.flatMap((space) => space.tabs.map((tab) => tab.id)));
    for (const id of this.unusedPages) {
      const tab = store.get(id);
      if (!tab || !store.isClosed(id) || openInSpaces.has(id) || !isBlankPage(tab) || tab.provenance) {
        this.unusedPages.delete(id);
        continue;
      }
      const busy = [...this.threads.values()].some((thread) => {
        const run = this.runs.get(thread.id);
        const belongs = (thread.scope.kind === "page" && thread.scope.ref === id) || run?.turn.page?.id === id;
        return belongs && (run || this.resuming.has(thread.id) || (this.status.get(thread.id) ?? "idle") !== "idle"
          || this.queues.get(thread.id)?.length || this.backgroundTasks(thread.id));
      });
      if (!busy) {
        // Use the normal Trash path, retaining both undo and the chat transcript.
        store.deletePermanent(id);
        this.unusedPages.delete(id);
      }
    }
    this.db.setSetting("unusedPages", [...this.unusedPages]);
  }

  private pruneTimer: NodeJS.Timeout | null = null;

  /** Let providers drop saved sessions of deleted and rewound threads (#214), then again every few hours. */
  private pruneSessions(): void {
    const keep = new Set<string>();
    for (const t of this.threads.values()) {
      if (t.nativeId) keep.add(t.nativeId);
      if (t.fork?.nativeId) keep.add(t.fork.nativeId);
    }
    void (async () => {
      for (const provider of Object.values(this.providers)) {
        await provider.prune?.(keep).catch((err) => log(`Pruning ${provider.label} sessions failed: ${(err as Error).message}`));
      }
    })().finally(() => {
      if (this.closed) return;
      this.pruneTimer = setTimeout(() => this.pruneSessions(), PRUNE_EVERY_MS);
      this.pruneTimer.unref?.();
    });
  }

  private planLimits: Partial<Record<ProviderId, PlanLimits>> = {};
  /** Recent provider readings per window, for the burn rate. */
  private planPace: PaceState = {};
  private claudeThreadLimits = new Map<string, PlanLimits>();
  /** Several Claude subscriptions (#452): added accounts, the pick for each chat, their usage. */
  private claudePool!: ClaudeAccountPool;

  private claudeUsageSnapshot(value: unknown): PlanLimits {
    if (!isPlainRecord(value) && this.planLimits.claude) return this.planLimits.claude;
    const wrapper = isPlainRecord(value) ? value : {};
    return claudePlanSnapshot(wrapper.report, claudeBillingSource(wrapper.billingSource), Date.now(), this.planLimits.claude);
  }
  private usageWindowStarts: UsageWindowStarts;
  private usageWindowTimer: NodeJS.Timeout | null = null;
  private usageTimer: NodeJS.Timeout | null = null;
  private usageFetch: Promise<void> | null = null;
  private lastUsageFetchAt = 0;
  private cursorUsageFetchAt = 0;
  private codexUsageTimer: NodeJS.Timeout | null = null;
  private codexUsageFetch: Promise<void> | null = null;
  private codexUsageFetchAt = 0;
  private loggingOut = new Set<ProviderId>();
  private authGenerations = new Map<ProviderId, number>();
  private closed = false;

  /** Shared provider usage for every meter. Claude/Cursor windows display zero after reset. */
  limits(): Partial<Record<ProviderId, PlanLimits>> {
    return this.liveLimits();
  }

  private liveLimits(): Partial<Record<ProviderId, PlanLimits>> {
    let out = this.planLimits;
    for (const [provider, limits] of Object.entries(this.planLimits) as Array<[ProviderId, PlanLimits]>) {
      const live = livePlanLimits(limits);
      const paced = withPace(this.planPace, provider, live);
      if (paced !== limits) out = { ...out, [provider]: paced };
    }
    for (const provider of ["claude", "codex"] as const) {
      const entry = this.usageWindowStarts?.view(provider);
      if (out[provider] && entry) out = { ...out, [provider]: { ...out[provider]!, windowStart: entry } };
    }
    // Several Claude accounts (#452): one meter, their plan-weighted average, with each account's own.
    const combined = this.claudePool?.combined();
    if (combined) out = { ...out, claude: { ...combined, ...(out.claude?.windowStart ? { windowStart: out.claude.windowStart } : {}) } };
    return out;
  }

  /** After a Cursor turn, pull its plan usage, at most once per CURSOR_USAGE_TTL_MS. */
  private refreshCursorUsage(): void {
    if (this.closed || this.fakes || this.loggingOut.has("cursor") || Date.now() - this.cursorUsageFetchAt < CURSOR_USAGE_TTL_MS) return;
    this.cursorUsageFetchAt = Date.now();
    const generation = this.authGenerations.get("cursor");
    void (this.providers.cursor as CursorProvider).fetchPlanUsage().then((resp) => {
      if (this.closed || this.loggingOut.has("cursor") || generation !== this.authGenerations.get("cursor") || !resp) return;
      const parsed = planLimitsFromCursorUsage(resp, Date.now());
      if (parsed) this.commitLimits("cursor", parsed, false);
    });
  }

  private recordLimits(provider: ProviderId, info: unknown): void {
    const next = provider === "codex" ? planLimitsFromCodexRateLimits(info, Date.now(), this.planLimits.codex, true)
      : planLimitsFromRateLimitInfo(info, Date.now(), this.planLimits[provider]);
    if (!next) return;
    if (provider === "claude" || provider === "codex") {
      // Sparse notifications may inherit locally projected Claude windows.
      // Scheduling accepts only timestamps actually present in this report.
      const reported = provider === "claude" ? planLimitsFromRateLimitInfo(info, Date.now()) :
        planLimitsFromCodexRateLimits(info, Date.now());
      if (reported) this.usageWindowStarts.observe(provider, reported);
    }
    this.commitLimits(provider, next, true);
    if (provider === "codex") void this.refreshCodexUsage();
  }

  /** Publish live query readings to the same persisted snapshot used by board and chat meters. */
  private recordClaudeLimits(next: PlanLimits): void {
    const merged = mergeClaudeLimits(this.planLimits.claude, next);
    if (!merged) return;
    if (merged.fresh) this.usageWindowStarts.observe("claude", next);
    this.commitLimits("claude", merged.limits, false);
  }

  /** Poll without a model turn, including after a reset or a rolling notification. */
  private refreshCodexUsage(): Promise<void> {
    if (this.closed || this.fakes || this.loggingOut.has("codex")) return Promise.resolve();
    if (this.codexUsageFetch) return this.codexUsageFetch;
    if (Date.now() - this.codexUsageFetchAt < 60_000) return Promise.resolve();
    this.codexUsageFetchAt = Date.now();
    if (this.codexUsageTimer) clearTimeout(this.codexUsageTimer);
    const beforeRead = this.planLimits.codex;
    this.codexUsageFetch = (async () => {
      try {
        const report = await this.readCodexUsage();
        if (this.closed) return;
        const parsed = planLimitsFromCodexRateLimits(report, Date.now());
        if (!parsed) throw new Error("Invalid Codex quota response");
        this.usageWindowStarts.observe("codex", parsed);
        this.commitLimits("codex", parsed, false);
      } catch (error) {
        if (this.closed) return;
        // A session reported quota while the background read was in flight.
        // Keep that newer evidence rather than replacing it with a probe error.
        if (this.planLimits.codex !== beforeRead && this.planLimits.codex?.availability === "available") return;
        const auth = /authentication required|unauthorized|401|expired|refresh.token|not logged|sign.in/i.test((error as Error).message);
        this.commitLimits("codex", { at: Date.now(), source: "codex", windows: [], ordinaryUsageAllowed: null,
          availability: auth ? "authentication_required" : "unavailable",
          detail: auth ? "Codex login is missing or expired. Log in again in Agent settings." : "Codex subscription quota is unavailable. It requires a ChatGPT login and a reachable app-server.",
        }, false);
      }
    })().finally(() => {
      this.codexUsageFetch = null;
      if (this.closed) return;
      const reset = nextRefreshAt(this.planLimits.codex);
      const delay = reset == null ? 5 * 60_000 : Math.min(5 * 60_000, Math.max(60_000, reset - Date.now() + 2000));
      this.codexUsageTimer = setTimeout(() => void this.refreshCodexUsage(), delay);
      this.codexUsageTimer.unref?.();
    });
    return this.codexUsageFetch;
  }

  private commitLimits(provider: ProviderId, next: PlanLimits, fromTurn: boolean): void {
    this.planLimits = { ...this.planLimits, [provider]: next };
    this.db.setSetting("limits", this.planLimits);
    const pace = trackPace(this.planPace, provider, next);
    if (pace !== this.planPace) {
      this.planPace = pace;
      this.db.setSetting("limitPace", pace);
    }
    this.emit({ type: "agent_limits", limits: this.liveLimits() });
    if (fromTurn) this.applyPlanCost(provider, next);
    if (provider === "claude") this.scheduleClaudeUsageRefresh();
  }

  /** After a window resets, pull plan usage from Claude without sending a model message. */
  private scheduleClaudeUsageRefresh(): void {
    if (this.usageTimer) {
      clearTimeout(this.usageTimer);
      this.usageTimer = null;
    }
    if (this.closed) return;
    const limits = this.planLimits.claude;
    const at = nextRefreshAt(limits);
    // A passed reset is not a new window; check again now and then until Claude reports one.
    const waiting = limits?.windows.some((w) => w.expired) ? EXPIRED_USAGE_RETRY_MS : null;
    if (at == null && waiting == null) return;
    const delay = Math.min(at == null ? Infinity : Math.max(0, at - Date.now() + 2000), waiting ?? Infinity);
    this.usageTimer = setTimeout(() => void this.refreshClaudeUsage(), Math.min(delay, 7 * 24 * 60 * 60 * 1000));
    this.usageTimer.unref?.();
  }

  private claudeTurnRunning(): boolean {
    for (const [id] of this.runs) {
      if (this.threads.get(id)?.provider === "claude") return true;
    }
    return false;
  }

  private refreshClaudeUsage(): Promise<void> {
    if (this.usageFetch) return this.usageFetch;
    this.usageFetch = this.doRefreshClaudeUsage().finally(() => {
      this.usageFetch = null;
    });
    return this.usageFetch;
  }

  private async doRefreshClaudeUsage(): Promise<void> {
    if (this.closed || this.loggingOut.has("claude")) return;
    if (this.usageTimer) {
      clearTimeout(this.usageTimer);
      this.usageTimer = null;
    }
    const sinceFetch = Date.now() - this.lastUsageFetchAt;
    // Prefer an idle moment, but continuous worker turns must not starve the board's account meter.
    if (this.claudeTurnRunning() && sinceFetch < 5 * 60_000) {
      this.usageTimer = setTimeout(() => void this.refreshClaudeUsage(), Math.min(30_000, 5 * 60_000 - sinceFetch));
      this.usageTimer.unref?.();
      return;
    }
    if (sinceFetch < 60_000) {
      // Keep the pending request: scheduling only by window reset could postpone it for hours.
      this.usageTimer = setTimeout(() => void this.refreshClaudeUsage(), 60_000 - sinceFetch);
      this.usageTimer.unref?.();
      return;
    }
    const prev = this.planLimits.claude;
    if (prev) {
      const overlaid = applyExpiredWindows(prev);
      if (overlaid !== prev) this.commitLimits("claude", overlaid, false);
    }
    this.lastUsageFetchAt = Date.now();
    const beforeRead = this.planLimits.claude;
    try {
      const report = await (this.providers.claude as ClaudeProvider).fetchPlanUsage();
      if (this.closed) return;
      if (this.planLimits.claude !== beforeRead) return;
      const parsed = this.claudeUsageSnapshot(report);
      if (parsed) this.usageWindowStarts.observe("claude", parsed);
      if (parsed && (parsed.availability === "available" || beforeRead?.availability !== "available")) this.commitLimits("claude", applyExpiredWindows(parsed), false);
    } catch {
      if (this.closed) return;
      // Retain the observation (and its timestamp) when the background probe fails.
      if (!this.planLimits.claude) this.commitLimits("claude", claudePlanSnapshot(null, {}), false);
    }
    this.scheduleClaudeUsageRefresh();
  }

  /** Attach this report's window deltas to the turn that was running when it started. */
  private applyPlanCost(provider: ProviderId, next: PlanLimits): void {
    // Account-wide quota movement includes other apps and cannot price a Claude turn.
    if (provider === "claude") return;
    const slot = this.limitTurn;
    if (!slot || slot.provider !== provider || !slot.before.length) return;
    const plan = planUsed(slot.before, next.windows);
    if (!plan.length) return;
    const turn = this.loadTurns(slot.threadId).find((t) => t.id === slot.turnId);
    if (!turn) return;
    const usage = { ...(this.runs.get(slot.threadId)?.usage ?? turn.usage ?? {}), plan };
    const run = this.runs.get(slot.threadId);
    if (run && run.turn.id === slot.turnId) {
      run.usage = usage;
      run.turn.usage = usage;
    }
    turn.usage = usage;
    this.saveTurn(turn);
  }

  dispose(): void {
    this.closed = true;
    this.usageWindowStarts.dispose();
    this.claudePool.dispose();
    if (this.usageWindowTimer) clearInterval(this.usageWindowTimer);
    store.off("tab_closed", this.onPageClosed);
    store.off("tab_upserted", this.onPageUpserted);
    if (this.codexUsageTimer) clearTimeout(this.codexUsageTimer);
    if (this.pageRunTimer) clearInterval(this.pageRunTimer);
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    if (this.worktreeTimer) clearTimeout(this.worktreeTimer);
    if (this.usageTimer) {
      clearTimeout(this.usageTimer);
      this.usageTimer = null;
    }
    this.flushNow();
    for (const session of this.sessions.values()) session.dispose();
    for (const provider of Object.values(this.providers)) provider.dispose();
    void resetSandbox();
    this.db.close();
  }

  // ---------- prefs, providers, models ----------

  prefs(): Prefs {
    const saved = migrateOpenaiPrefs(this.db.getSetting<Partial<Prefs>>("prefs", {}));
    return {
      ...DEFAULT_PREFS,
      ...saved,
      usageWindowStarts: cleanWindowStarts(saved.usageWindowStarts),
      models: { ...DEFAULT_PREFS.models, ...saved.models },
      modelParams: { ...DEFAULT_PREFS.modelParams, ...saved.modelParams },
      modelSettings: seedModelSettings(saved),
      forkSummarizers: seedForkSummarizers(saved),
      // Older prefs kept "ask" (ask before every edit), now Edits, and could default to the Ask or Pages mode (#719).
      ...cleanApprovals(saved),
      // Older prefs kept web as a boolean.
      web: parseWebAccess(saved.web) ?? DEFAULT_PREFS.web,
      webAllowlist: Array.isArray(saved.webAllowlist) ? cleanAllowlist(saved.webAllowlist) : DEFAULT_PREFS.webAllowlist,
      commandAllowlist: cleanCommandAllowlist(saved.commandAllowlist),
      protectedPaths: cleanProtectedPaths(saved.protectedPaths),
      searxngUrl: cleanSearxngUrl(saved.searxngUrl),
      claudeHooks: saved.claudeHooks === true,
      cursorHostShell: saved.cursorHostShell === true,
      helpers: saved.helpers !== false,
      memory: saved.memory !== false,
      instructionsOff: cleanInstructionsOff(saved.instructionsOff),
      hookRules: savedRules(saved.hookRules),
      disabledModes: cleanDisabledModes(saved.disabledModes),
      customModes: cleanCustomModes(saved.customModes),
      customMode: typeof saved.customMode === "string" ? saved.customMode : null,
      hiddenWorkspaces: Array.isArray(saved.hiddenWorkspaces) ? saved.hiddenWorkspaces.filter((dir) => typeof dir === "string") : [],
    };
  }

  setPrefs(patch: Partial<Prefs>): Prefs {
    const next = { ...this.prefs(), ...patch };
    next.usageWindowStarts = cleanWindowStarts(patch.usageWindowStarts ?? next.usageWindowStarts);
    if (patch.forkSummarizers !== undefined) next.forkSummarizers = { ...this.prefs().forkSummarizers, ...cleanForkSummarizers(patch.forkSummarizers) };
    next.web = parseWebAccess(patch.web) ?? this.prefs().web;
    // null puts back the starting list.
    if (patch.claudeHooks !== undefined) next.claudeHooks = patch.claudeHooks === true;
    if (patch.cursorHostShell !== undefined) next.cursorHostShell = patch.cursorHostShell === true;
    if (patch.helpers !== undefined) next.helpers = patch.helpers === true;
    if (patch.memory !== undefined) next.memory = patch.memory !== false;
    if (patch.instructionsOff !== undefined) next.instructionsOff = cleanInstructionsOff(patch.instructionsOff);
    if (patch.hookRules !== undefined) {
      next.hookRules = normalizeRules(patch.hookRules);
      this.ruleDetectors = null;
    }
    if (patch.disabledModes !== undefined) next.disabledModes = cleanDisabledModes(patch.disabledModes);
    if (patch.customModes !== undefined) next.customModes = cleanCustomModes(patch.customModes);
    if (!next.customModes.some((mode) => mode.id === next.customMode)) next.customMode = null;
    if (patch.searxngUrl !== undefined) {
      next.searxngUrl = cleanSearxngUrl(patch.searxngUrl);
      if (patch.searxngUrl && !next.searxngUrl) throw new Error("The SearXNG address must be an http(s) URL.");
    }
    if (patch.webAllowlist !== undefined) next.webAllowlist = patch.webAllowlist === null ? DEFAULT_PREFS.webAllowlist : cleanAllowlist(patch.webAllowlist);
    if (patch.commandAllowlist !== undefined) next.commandAllowlist = cleanCommandAllowlist(patch.commandAllowlist);
    if (patch.protectedPaths !== undefined) next.protectedPaths = cleanProtectedPaths(patch.protectedPaths);
    this.db.setSetting("prefs", next);
    if (patch.usageWindowStarts !== undefined) this.usageWindowStarts.settingsChanged();
    if (patch.customModes !== undefined) this.refreshCustomModes(next);
    return next;
  }

  /**
   * An edited custom mode applies to the threads in it at once. A deleted one leaves its threads as
   * they are: taking limits away is the user's call, by picking another mode there.
   */
  private refreshCustomModes(prefs: Prefs): void {
    for (const thread of this.threads.values()) {
      const mode = thread.custom && prefs.customModes.find((m) => m.id === thread.custom!.id);
      if (!mode) continue;
      const custom = threadCustom(mode);
      if (JSON.stringify(custom) === JSON.stringify(thread.custom)) continue;
      thread.custom = custom;
      Object.assign(thread, changeAccess(thread, {}, approvalFor(prefs, thread.provider), custom.max));
      if (modeOff(thread, "web")) thread.web = "off";
      thread.updatedAt = Date.now();
      this.db.saveThread(thread);
      this.effectivePermissions.delete(thread.id);
      this.sessions.get(thread.id)?.update(this.sessionThread(thread));
      this.emit({ type: "agent_thread", thread: this.view(thread) });
    }
  }

  // ---------- Native harness model sources ----------

  /** OpenAI-compatible endpoints for the native harness (Pi). Kept under the setting the old openai provider used. */
  modelSources(): OpenAISource[] {
    return this.db.getSetting<OpenAISource[]>("openai.sources", []);
  }

  /** The sources as the board sees them: never the API keys. */
  modelSourceViews(): OpenAISourceView[] {
    return this.modelSources().map(sourceView);
  }

  /** Add a source (no id) or change one. The key stays unless the form sends a new one. */
  saveModelSource(id: string | null, body: unknown): OpenAISourceView {
    const sources = this.modelSources();
    const previous = id ? sources.find((s) => s.id === id) : undefined;
    if (id && !previous) throw new Error(`source not found: ${id}`);
    const source = normalizeSource(body, previous, new Set(sources.map((s) => s.id)));
    const next = previous ? sources.map((s) => (s.id === id ? source : s)) : [...sources, source];
    this.db.setSetting("openai.sources", next);
    (this.providers.pi as PiProvider).invalidate();
    return sourceView(source);
  }

  deleteModelSource(id: string): void {
    const sources = this.modelSources();
    if (!sources.some((s) => s.id === id)) throw new Error(`source not found: ${id}`);
    this.db.setSetting("openai.sources", sources.filter((s) => s.id !== id));
    (this.providers.pi as PiProvider).invalidate();
  }

  /** Start Cursor's browser login; resolves with the login URL. */
  cursorLogin(): Promise<{ url: string | null }> {
    this.checkLoggingOut("cursor");
    return (this.providers.cursor as CursorProvider).startLogin();
  }

  /** Start Codex's ChatGPT login (`codex login`); resolves with the login URL when the CLI prints one. */
  codexLogin(): Promise<{ url: string | null }> {
    this.checkLoggingOut("codex");
    return (this.providers.codex as CodexProvider).startLogin(() => {
      this.codexUsageFetchAt = 0;
      void this.refreshCodexUsage();
    });
  }

  /** Native's subscription logins (Pi's OAuth) and their state. */
  piLogins(): Promise<PiLoginView[]> {
    return (this.providers.pi as PiProvider).logins();
  }

  piLogin(id: string): Promise<PiLoginView> {
    return (this.providers.pi as PiProvider).startLogin(id);
  }

  piLoginAnswer(id: string, value: string): void {
    (this.providers.pi as PiProvider).answerLogin(id, value);
  }

  piLoginCancel(id: string): void {
    (this.providers.pi as PiProvider).cancelLogin(id);
  }

  piLogout(id: string): Promise<void> {
    return (this.providers.pi as PiProvider).logout(id);
  }

  /**
   * Native models whose plan windows are another provider's: the ChatGPT (Codex) login's, when it is
   * the same ChatGPT account Codex is logged in to, since the windows belong to the account.
   */
  nativePlans(): Record<string, ProviderId> {
    const pi = this.providers.pi;
    const account = pi instanceof PiProvider ? pi.codexAccountId() : null;
    return account && account === codexAccountId() ? { "openai-codex": "codex" } : {};
  }

  /** The provider whose plan windows a thread uses: its own, or Codex's for a Native thread on the same ChatGPT account. */
  private planProvider(thread: Pick<Thread, "provider" | "model">): ProviderId {
    if (thread.provider !== "pi" || !thread.model?.startsWith("openai-codex/")) return thread.provider;
    return this.nativePlans()["openai-codex"] ?? thread.provider;
  }

  /** Start Claude Code's sign-in (`claude auth login`), which opens the browser itself. */
  claudeLogin(): Promise<{ url: string | null }> {
    this.checkLoggingOut("claude");
    return (this.providers.claude as ClaudeProvider).startLogin();
  }

  /** Forget a provider's shared login once its chats are idle. */
  async providerLogout(id: "claude" | "codex" | "cursor"): Promise<void> {
    if (this.loggingOut.has(id)) throw new Error("Log out is already in progress.");
    for (const thread of this.threads.values()) {
      if (thread.provider === id && (this.runs.has(thread.id) || this.resuming.has(thread.id) ||
          (this.status.get(thread.id) ?? "idle") !== "idle" || this.queues.get(thread.id)?.length || this.backgroundTasks(thread.id))) {
        throw new Error(`Finish or stop ${this.providers[id].label} chats before logging out.`);
      }
    }
    this.loggingOut.add(id);
    this.authGenerations.set(id, (this.authGenerations.get(id) ?? 0) + 1);
    try {
      // Let account probes finish before removing credentials or their cached readings.
      await Promise.allSettled([id === "codex" ? this.codexUsageFetch : id === "claude" ? this.usageFetch : null]);
      for (const [threadId, session] of this.sessions) {
        if (this.threads.get(threadId)?.provider !== id) continue;
        session.dispose();
        this.sessions.delete(threadId);
      }
      await (this.providers[id] as ClaudeProvider | CodexProvider | CursorProvider).logout();
      if (id === "claude" || id === "codex") this.usageWindowStarts.reset(id);
      if (id === "claude") {
        this.claudeThreadLimits.clear();
        this.db.setSetting("claudeThreadLimits", {});
      }
      this.db.setSetting(`models.${id}`, []);
      delete this.planLimits[id];
      this.planPace = Object.fromEntries(Object.entries(this.planPace).filter(([key]) => !key.startsWith(`${id}:`)));
      this.db.setSetting("limits", this.planLimits);
      this.db.setSetting("limitPace", this.planPace);
      if (id === "codex") {
        if (this.codexUsageTimer) clearTimeout(this.codexUsageTimer);
        this.codexUsageTimer = null;
        this.codexUsageFetchAt = 0;
      } else if (id === "claude") {
        if (this.usageTimer) clearTimeout(this.usageTimer);
        this.usageTimer = null;
        this.lastUsageFetchAt = 0;
      } else this.cursorUsageFetchAt = 0;
      this.emit({ type: "agent_limits", limits: this.liveLimits() });
    } finally {
      this.loggingOut.delete(id);
    }
  }

  async providerStatus(): Promise<ProviderStatus[]> {
    const list = await Promise.all(Object.values(this.fakes ?? this.providers).map((provider) => provider.status()));
    if (!this.claudePool?.multi()) return list;
    const accounts = this.claudePool.list().length;
    // Added accounts keep Claude usable while the default login is signed out.
    return list.map((p) => p.id !== "claude" ? p : { ...p, accounts, ...(accounts && !p.available ? { available: true, detail: `${accounts} account${accounts === 1 ? "" : "s"}` } : {}) });
  }

  /** Pick the Claude account a chat's next session runs on (#452) and keep it on the thread. */
  private assignClaudeAccount(thread: Thread): void {
    if (thread.provider !== "claude") return;
    const turns = this.loadTurns(thread.id);
    const ended = turns.filter((t) => t.status !== "running" && t.endedAt).map((t) => t.endedAt!);
    // The last turn hit a usage limit (also from before a restart): that account is full until the reset.
    const last = turns.at(-1);
    if (last?.limitResetsAt) this.claudePool.limited(thread.claudeAccount, last.limitResetsAt);
    const account = this.claudePool.resolve(thread, ended.length ? Math.max(...ended) : null);
    if (account === thread.claudeAccount) return;
    const stored = this.threads.get(thread.id);
    for (const t of new Set([thread, stored])) {
      if (!t) continue;
      if (account) t.claudeAccount = account;
      else delete t.claudeAccount;
    }
    this.db.saveThread(stored ?? thread);
  }

  /** Claude's accounts for the settings popup (#452): each with its plan and usage, and which one new chats use. */
  claudeAccounts(): { accounts: AccountView[]; use: string; adding: boolean; error: string | null } {
    return { accounts: this.claudePool.list(), use: this.claudePool.use, adding: Boolean(this.claudePool.adding), error: this.claudePool.lastError };
  }

  /** Sign another Claude account in, in its own config folder; the browser opens for it. */
  addClaudeAccount(): void {
    this.checkLoggingOut("claude");
    this.claudePool.add();
  }

  /** Stop a Claude account sign-in still waiting for the browser. */
  cancelClaudeAccount(): void {
    this.claudePool.cancelAdd();
  }

  /** Log a Claude account out. The default one is Claude Code's own login (the CLI's too). */
  async removeClaudeAccount(id: string): Promise<void> {
    if (id === DEFAULT_ACCOUNT) return this.providerLogout("claude");
    this.closeAccountSessions([id], "Finish or stop the chats on this account before logging it out.");
    await this.claudePool.remove(id);
  }

  /** Close idle sessions on these Claude accounts; refuse while a chat on one is busy. */
  private closeAccountSessions(accounts: string[], busy: string): void {
    const on = (thread: Thread | undefined) => thread?.provider === "claude" && accounts.includes(thread.claudeAccount ?? DEFAULT_ACCOUNT);
    for (const thread of this.threads.values()) {
      if (!on(thread)) continue;
      if (this.runs.has(thread.id) || this.resuming.has(thread.id) || (this.status.get(thread.id) ?? "idle") !== "idle" || this.queues.get(thread.id)?.length || this.backgroundTasks(thread.id)) {
        throw new Error(busy);
      }
    }
    for (const [threadId, session] of this.sessions) {
      if (!on(this.threads.get(threadId))) continue;
      session.dispose();
      this.sessions.delete(threadId);
    }
  }

  /**
   * Make an added Claude account the one Claude Code itself (the CLI) is signed in with: it trades
   * logins with the default folder. Chats follow their account to its new folder.
   */
  setClaudeCodeAccount(id: string): void {
    if (id === DEFAULT_ACCOUNT) return;
    this.checkLoggingOut("claude");
    if (!this.claudePool.isAccount(id)) throw new Error("No such Claude account.");
    this.closeAccountSessions([DEFAULT_ACCOUNT, id], "Finish or stop the Claude chats on these accounts before switching.");
    const theirs = this.claudePool.swapWithDefault(id, this.planLimits.claude);
    (this.providers.claude as ClaudeProvider).loginSwapped();
    for (const thread of this.threads.values()) {
      if (thread.provider !== "claude") continue;
      const now = thread.claudeAccount ?? DEFAULT_ACCOUNT;
      if (now !== id && now !== DEFAULT_ACCOUNT) continue;
      thread.claudeAccount = now === id ? DEFAULT_ACCOUNT : id;
      this.db.saveThread(thread);
    }
    this.usageWindowStarts.reset("claude");
    this.planPace = Object.fromEntries(Object.entries(this.planPace).filter(([key]) => !key.startsWith("claude:")));
    this.db.setSetting("limitPace", this.planPace);
    if (theirs) this.commitLimits("claude", theirs, false);
    else {
      delete this.planLimits.claude;
      this.db.setSetting("limits", this.planLimits);
      this.emit({ type: "agent_limits", limits: this.liveLimits() });
    }
    void this.refreshClaudeUsage();
  }

  /** "distribute", or the one account every Claude chat uses until changed. */
  setClaudeAccountUse(use: string): void {
    this.claudePool.setUse(use);
  }

  /** The provider that runs a thread: the real one, or its fake under SCRIBE_FAKE_AGENTS=1. */
  private agent(id: ProviderId): AgentProvider {
    this.checkLoggingOut(id);
    return this.fakes?.[id] ?? this.providers[id];
  }

  private checkLoggingOut(id: ProviderId): void {
    if (this.loggingOut.has(id)) throw new Error("Wait for log out to finish before using this provider.");
  }

  async models(provider: ProviderId, refresh = false): Promise<ModelOption[]> {
    const models = await this.agent(provider).models(refresh);
    if (models.length) this.db.setSetting(`models.${provider}`, models);
    return models.length ? models : this.db.getSetting<ModelOption[]>(`models.${provider}`, []);
  }

  cachedModels(provider: ProviderId): ModelOption[] {
    return this.db.getSetting<ModelOption[]>(`models.${provider}`, []);
  }

  // ---------- threads ----------

  mcpGrants() {
    const permissions = new McpPermissions();
    permissions.pruneThreads(this.threads.keys());
    const file = readMcpFile();
    const layers = [{ path: "global", mcpServers: file.mcpServers }, ...Object.values(file.workspaces)];
    const servers = layers.flatMap((layer) => Object.entries(layer.mcpServers).flatMap(([name, server]) => resolveServer(name, layer.path, server) ?? []));
    return { grants: permissions.list(servers).map((grant) => ({ ...grant, threadTitle: grant.thread ? this.threads.get(grant.thread)?.title : undefined })) };
  }

  listThreads(): ThreadView[] {
    return [...this.threads.values()].sort((a, b) => b.activityAt - a.activityAt).map((thread) => this.view(thread));
  }

  /** Whether a thread is still working, and how its last turn ended. Pages use it to release claims. */
  runInfo(id: string): ThreadRunInfo {
    const thread = this.threads.get(id);
    if (!thread) return { exists: false };
    const status = this.status.get(id) ?? "idle";
    const turns = this.db.listTurns(id);
    const last = turns.at(-1);
    const usage = this.threadUsage(id);
    const outputAt = this.runs.get(id)?.turn.outputAt ?? last?.outputAt;
    const recovery = thread.provider === "codex" && last?.limitResetsAt
      ? codexUsageRecoveryAllowed(this.planLimits.codex, last.endedAt ?? last.startedAt) : undefined;
    if (recovery === false) void this.refreshCodexUsage();
    const asking = status === "waiting" ? this.asking(id) : undefined;
    const run = this.pageRuns.get(id);
    return {
      exists: true,
      ...(run ? { run: runView(run) } : {}),
      running: status !== "idle" || this.resuming.has(id),
      title: thread.title,
      ...(outputAt !== undefined ? { outputAt } : {}),
      ...(asking && asking.kind !== "limit" ? { asking: { kind: asking.kind, title: asking.title, ...(asking.page ? { page: { key: asking.page.key, title: asking.page.title } } : {}) } } : {}),
      ...(last ? { lastTurn: { status: last.status, ...(last.endedAt ? { endedAt: last.endedAt } : {}), ...(last.error ? { error: last.error } : {}), ...(last.limitResetsAt ? { limitResetsAt: last.limitResetsAt } : {}), ...(recovery !== undefined ? { usageRecoveryAllowed: recovery } : {}) } } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  /**
   * A page hands one of its threads to Scribe to see through (scribe.agent.start's run option, or
   * scribe.agent.watch): see pageRuns.ts. Only threads a page started can be handed over.
   */
  watchPageThread(id: string, input: RunInput): ThreadView {
    const thread = this.requireThread(id);
    if (thread.scope?.kind !== "page" || !thread.scope.ref) throw new Error("Only a page's own threads can be handed over as a run.");
    // One-card Run (including older saved boards) starts a fresh chat. Capture the previous
    // holder before worker_claim replaces card.thread, so its unfinished work isn't stranded.
    if (wantsWorktree(thread) && !thread.worktree && !thread.retryWorktreeFrom && !this.loadTurns(id).length &&
        typeof input.tag === "string" && /^(worker|solo):/.test(input.tag) && isPlainRecord(input.data) && !input.data.ask) {
      const page = store.get(thread.scope.ref);
      const cardNum = input.data.card;
      const card = page && store.drives(page) && Array.isArray(page.state.cards)
        ? page.state.cards.find((c) => isPlainRecord(c) && c.num === cardNum) : undefined;
      const previous = isPlainRecord(card) && typeof card.thread === "string" ? this.threads.get(card.thread) : undefined;
      const wt = previous && openWorktree(previous);
      if (previous && previous.id !== id && previous.scope.kind === "page" && previous.scope.ref === thread.scope.ref &&
          wt && thread.cwd && workspaceKey(wt.home) === workspaceKey(thread.cwd)) {
        thread.retryWorktreeFrom = previous.id;
        this.db.saveThread(thread);
      }
    }
    this.pageRuns.register(id, thread.scope.ref, input);
    return this.view(this.requireThread(id));
  }

  /** Scribe stops seeing the thread through (and forgets an ended run); the chat is left as it is. */
  releasePageThread(id: string): ThreadView {
    this.pageRuns.release(id);
    return this.view(this.requireThread(id));
  }

  /**
   * Start a chat for a page's own agents without a window (a Kanban board's next worker card, #312):
   * what scribe.agent.start with a run does, with the board's fixed defaults for what the worker
   * leaves out. The caller checked the page's permissions. Resolves with the thread id; throws with
   * a message for the board's worker log.
   */
  async launchPageThread(pageId: string, prompt: string, s: LaunchSettings, run: PageRunInput, resumeThread?: string, validate?: () => void | Promise<void>): Promise<string> {
    if (run.data?.continuation) {
      // Persisted runs make retries idempotent, including after a daemon restart.
      for (const t of this.threads.values()) {
        if (t.scope.kind !== "page" || t.scope.ref !== pageId) continue;
        const info = this.runInfo(t.id);
        if (info.exists && info.run?.data?.continuation === run.data.continuation) return t.id;
      }
    }
    const previous = resumeThread ? this.threads.get(resumeThread) : undefined;
    if (previous && !previous.archived && previous.scope.kind === "page" && previous.scope.ref === pageId) {
      const info = this.runInfo(previous.id);
      if (info.exists && (info.running || (info.run && info.run.phase !== "ended"))) throw new Error("The card's previous chat is still busy.");
      if (this.closed) throw new Error("Scribe is shutting down.");
      await validate?.();
      this.watchPageThread(previous.id, { ...run, after: Date.now() });
      try {
        this.send(previous.id, { text: prompt, from: "page" });
      } catch (err) {
        this.releasePageThread(previous.id);
        throw err;
      }
      if (s.show === "dock" || s.show === "sidebar") this.emit({ type: "agent_page_show", threadId: previous.id, pageId, where: s.show });
      return previous.id;
    }
    const setup = (what: string) => new Error(`Check the worker's setup: ${what}.`);
    const status = await this.providerStatus();
    const available = status.filter((x) => x.available).map((x) => x.id);
    let provider: ProviderId | undefined;
    if (s.provider) {
      if (!isProviderId(s.provider)) throw setup(`unknown provider ${s.provider}`);
      if (!available.includes(s.provider)) throw setup(`${status.find((x) => x.id === s.provider)?.label ?? s.provider} is not available`);
      provider = s.provider;
    } else {
      provider = (["cursor", "codex", "claude", "pi"] as ProviderId[]).find((id) => available.includes(id)) ?? available[0];
    }
    if (!provider) throw new Error("No agent provider is available.");
    // The rung decides (#719); a mode is still accepted: code + Ask first is Edits, ask and board are Board, plan plans the first turn (#721).
    // A template action's "readonly" names the rung.
    const legacy = s.mode === "readonly" ? undefined : s.mode;
    if (legacy && !parseMode(legacy)) throw setup(`unknown mode ${s.mode}`);
    if (s.approval && !parseApproval(s.approval)) throw setup(`unknown approval ${s.approval}`);
    const picked = s.customMode ? this.prefs().customModes.find((m) => m.id === s.customMode) : undefined;
    // A custom mode that is gone is refused: starting without its limits would be worse.
    if (s.customMode && !picked) throw setup("its custom mode is gone");
    const asked = s.mode === "readonly" ? "readonly" : parseApproval(s.approval);
    const access = changeAccess(
      { mode: "board", approval: "board" },
      { mode: legacy || (asked && !readsOnly(asked) ? "code" : undefined), approval: asked ?? (parseMode(legacy) && parseMode(legacy) !== "board" ? "auto" : undefined) },
      "auto",
      picked?.base
    );
    const { mode, approval } = access;
    const model = s.model || (provider === "cursor" ? "composer-2.5" : "default");
    const models = await this.models(provider).catch(() => [] as ModelOption[]);
    const info = models.find((m) => m.id === model);
    if (model !== "default" && models.length && !info) throw setup(`unknown model ${model}`);
    if (s.effort && info?.efforts.length && !info.efforts.some((e) => e.id === s.effort)) throw setup(`${model} has no effort "${s.effort}"`);
    // Read-only and Board keep a folder they are given, to read files there (#718).
    const folder = mode === "code";
    if (folder && !s.cwd) throw setup("it needs a folder");
    if (this.closed) throw new Error("Scribe is shutting down.");
    await validate?.();
    const thread = this.createThread(
      {
        provider,
        model,
        effort: s.effort || null,
        modelParams: { ...s.modelParams },
        mode,
        ...(s.customMode ? { customMode: s.customMode } : {}),
        approval,
        web: parseWebAccess(s.web) ?? "off",
        cwd: s.cwd || null,
        useWorktree: folder && s.worktree === true,
        ...(wantsPlan(legacy) ? { planNext: true } : {}),
        title: s.title,
        scope: { kind: "page", ref: pageId },
        ...(s.helpers ? { helpersAllowed: true } : {}),
        ...(s.skills?.length ? { skills: s.skills } : {}),
      },
      { remember: false }
    );
    // Handed over before its first message, so Scribe sees its first turn through.
    this.watchPageThread(thread.id, { ...run, after: Date.now() });
    this.send(thread.id, { text: prompt, from: "page" });
    if (s.show === "dock" || s.show === "sidebar") this.emit({ type: "agent_page_show", threadId: thread.id, pageId, where: s.show });
    return thread.id;
  }

  /**
   * Send on the threads whose turn the last restart cut off: a note from Scribe starts a turn in the
   * same session, and messages that were queued behind the cut-off turn queue again behind it (ones
   * with attachments stay in the transcript as not sent). Call once Scribe is listening, so the
   * agents' MCP servers can reach it.
   */
  resumeInterrupted(): string[] {
    const resumed: string[] = [];
    const all = [...this.resuming];
    for (const threadId of all) {
      this.resuming.delete(threadId);
      if (!this.threads.has(threadId) || this.runs.has(threadId)) continue;
      const leftovers = this.loadItems(threadId).filter((item): item is Item & { kind: "user" } => item.kind === "user" && item.turnId === null && !item.dropped);
      try {
        // Its helpers that were cut off with it go on too; it can ask for their reports again.
        const helpers = all.flatMap((id) => {
          const t = this.threads.get(id);
          return t && t.helperOf === threadId && !t.archived ? [t] : [];
        });
        const note = this.threads.get(threadId)?.helperOf ? HELPER_RESUME_NOTE : RESUME_NOTE + (helpers.length ? helperResumeNote(helpers) : "");
        this.send(threadId, { text: note, from: "scribe" });
      } catch (err) {
        log(`Could not resume thread ${threadId} after the restart: ${(err as Error).message}`);
        this.addItem(threadId, null, { kind: "notice", level: "error", text: `Scribe restarted during this thread's turn and could not send it on: ${(err as Error).message}` });
        this.emitThread(threadId);
        continue;
      }
      resumed.push(threadId);
      const queue: QueuedMessage[] = [];
      for (const item of leftovers) {
        delete item.steer;
        delete item.editing;
        if (item.images?.length || item.files?.length) {
          item.dropped = true;
        } else {
          queue.push({
            itemId: item.id,
            text: item.text,
            images: [],
            files: [],
            saved: { images: [], files: [] },
            context: item.context ?? [],
            ...(item.from ? { from: item.from } : {}),
            // The board's name went with the message, not the transcript: the agent finds the board from the card.
            ...(item.card ? { card: { ...item.card, board: "" } } : {}),
          });
        }
        this.touch(item);
      }
      if (queue.length) this.queues.set(threadId, queue);
      if (leftovers.length) this.emitThread(threadId);
    }
    if (resumed.length) log(`Resumed ${resumed.length} thread(s) whose turn a restart cut off`);
    return resumed;
  }

  getThread(id: string): Thread | null {
    return this.threads.get(id) ?? null;
  }

  threadDetail(id: string): { thread: ThreadView; turns: Turn[]; items: Item[] } | null {
    const thread = this.threads.get(id);
    if (!thread) return null;
    return { thread: this.view(thread), turns: this.loadTurns(id), items: this.loadItems(id) };
  }

  // ---------- harness view (#456) ----------

  /** Startup context for the composer, including a draft that has not sent its first message. */
  async contextSeed(input: ThreadPatch & { scope?: ThreadScope }, id?: string) {
    const thread = id ? { ...this.requireThread(id), ...input } : this.draftThread(input);
    const instructions = threadInstructions(thread, this.scopeInfo(thread));
    const tools = await boardTools(this.ctx.boardMcp, thread.provider, !noPages(thread.scope));
    const own = ownContext(thread, { claudeHooks: this.prefs().claudeHooks });
    return {
      tokens: seedTokens(thread.provider, estimateTokens(instructions.length), tools, own.files),
      window: this.db.getSetting<number>(`contextWindow:${thread.provider}:${thread.model}`, 0),
    };
  }

  /** Token and tool totals over the stored threads; days limits it to turns started in that many days. */
  harnessStats(days: number | null): HarnessStats {
    const since = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
    return harnessStats([...this.threads.values()], (id) => this.loadTurns(id), (id) => this.loadItems(id), since, this.db.listThreadStats());
  }

  /** Every stored thread's turns with where they ran, for the usage history (#867); deleted threads' kept numbers included. */
  private usageSources(): UsageSource[] {
    return [
      ...[...this.threads.values()].map((thread): UsageSource => ({
        id: thread.id,
        title: thread.title,
        ...(thread.helperOf ? { helperOf: thread.helperOf } : {}),
        provider: thread.provider,
        workspace: this.threadFolder(thread),
        origin: threadOrigin(this.loadItems(thread.id), thread.scope.kind === "page" ? thread.scope.ref : null),
        turns: this.loadTurns(thread.id),
      })),
      ...this.db.listThreadStats().map((kept): UsageSource => ({
        id: kept.id,
        ...(kept.helperOf ? { helperOf: kept.helperOf } : {}),
        provider: kept.provider,
        workspace: kept.workspace,
        origin: { ...(kept.worker ? { worker: kept.worker } : {}), ...(kept.card ? { card: kept.card } : {}) },
        turns: kept.turns,
      })),
    ];
  }

  /** Tokens and cost over time by provider, model, workspace and worker, and the threads and cards that cost the most. */
  usageHistory(days: number | null): UsageHistory {
    const since = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
    const board = (id: string) => store.get(id);
    const cardOf = (id: string, num: number) => {
      const cards = board(id)?.state?.cards;
      const card = Array.isArray(cards) ? cards.find((c) => isPlainRecord(c) && c.num === num) : undefined;
      return isPlainRecord(card) && typeof card.title === "string" ? card.title : undefined;
    };
    return usageHistory(this.usageSources(), since, (id) => board(id)?.title, cardOf);
  }

  /** The same turns as CSV, one line each. */
  usageCsv(days: number | null): string {
    return usageCsv(this.usageSources(), days ? Date.now() - days * 24 * 60 * 60 * 1000 : null);
  }

  /** What a new thread with these settings starts with: Scribe's instructions, its tools, the user's MCP servers, and what the provider adds itself. */
  async harnessContext(input: Partial<Thread> & { scope?: ThreadScope }) {
    const thread = this.draftThread(input);
    const text = threadInstructions(thread, this.scopeInfo(thread));
    const workspace = threadWorkspace(thread);
    const active = new Map(serversForThread(thread).map((server) => [server.name, server]));
    const servers = mergedServers(readMcpFile(), workspace).map(({ name, layer, server }) => ({
      name,
      layer,
      target: server.url ?? [server.command, ...(server.args ?? [])].join(" "),
      approve: server.approve ?? "ask",
      modes: serverModes(server),
      enabled: server.enabled !== false,
      // Per-tool Allow / Disable (#824), counted on the harness row.
      ...(server.tools ? { tools: server.tools } : {}),
      // In Scribe's own list, so the view can change it.
      editable: true,
      active: active.has(name),
      ...(active.has(name) ? {} : { why: server.enabled === false ? "Turned off" : !modeKeepsServer(thread, name) ? `Left out by the ${thread.custom?.name} mode` : `Not given to ${thread.mode === "board" ? "Pages" : thread.mode} threads` }),
    }));
    // Keeper inherited from Claude Code's config: in no Scribe layer, but the thread gets it.
    for (const server of active.values()) {
      if (!servers.some((row) => row.name === server.name)) {
        servers.push({ name: server.name, layer: server.layer, target: server.url ?? [server.command, ...server.args].join(" "), approve: server.approve, modes: ["code"], enabled: true, editable: false, active: true });
      }
    }
    const leftOut = thread.provider === "claude" ? claudeOwnServers(workspace).filter((name) => !active.has(name)) : [];
    const duplicates = thread.provider === "cursor" && thread.mode !== "board" ? cursorScribeServers() : [];
    return {
      thread: { provider: thread.provider, model: thread.model, mode: thread.mode, cwd: thread.cwd, scope: thread.scope, web: thread.web },
      instructions: { chars: text.length, tokens: estimateTokens(text.length), text, sections: instructionSections(text) },
      scribeTools: await boardTools(this.ctx.boardMcp, thread.provider, !noPages(thread.scope)),
      servers,
      leftOut,
      duplicates,
      own: ownContext(thread, { claudeHooks: this.prefs().claudeHooks }),
      memories: this.prefs().memory ? memoriesFor(this.memories(), this.memoryWorkspace(thread), memoryOwner(thread)).length : 0,
    };
  }

  /** Start one of the user's MCP servers to list its tools and what their schemas cost. */
  harnessProbe(name: string, cwd: string | null): Promise<ToolList> {
    const entry = mergedServers(readMcpFile(), cwd).find((row) => row.name === name);
    const server = entry ? resolveServer(entry.name, entry.layer, entry.server) : serversForThread({ cwd, mode: "code" }).find((row) => row.name === name);
    if (!server) throw new Error(`MCP server not found: ${name}`);
    return probeServer(server, cwd ?? this.ctx.scratchDir);
  }

  /** Claude Code's own count of a new thread's starting context, with Scribe's setup or as plain Claude Code. */
  harnessMeasure(input: Partial<Thread> & { scope?: ThreadScope }, plain: boolean): Promise<ContextMeasure> {
    const thread = this.draftThread({ ...input, provider: "claude" });
    const error = workspaceFolderError(thread);
    if (error) throw new Error(error);
    return (this.providers.claude as ClaudeProvider).measureContext(thread, threadInstructions(thread, this.scopeInfo(thread)), this.ctx, plain);
  }

  skills(cwd: string | null): { skills: SkillInfo[]; folders: ReturnType<typeof skillFolders> } {
    return { skills: discoverSkills(cwd), folders: skillFolders(cwd) };
  }

  /** Start a thread's provider session ahead of a message. Nothing happens while it runs. */
  async warm(id: string): Promise<void> {
    const thread = this.requireThread(id);
    if (this.runs.has(id) || thread.archived) return;
    if (workspaceFolderError(thread)) return;
    // Its session is set up on the first turn, from the thread it was forked from.
    if (thread.fork) return;
    // The session would start in the main checkout and restart once the worktree is made.
    if (wantsWorktree(thread)) return;
    this.assignClaudeAccount(thread);
    const session = this.session(thread);
    session.update(this.sessionThread(thread));
    await session.warm(threadInstructions(thread, this.scopeInfo(thread)));
  }

  /** Warm a spare session for a thread the user is about to start with these settings. */
  warmDraft(input: Partial<Thread> & { scope?: ThreadScope }): void {
    const draft = this.draftThread(input);
    if (workspaceFolderError(draft)) return;
    if (wantsWorktree(draft)) return;
    if (draft.provider === "claude") draft.claudeAccount = this.claudePool.peek();
    this.agent(draft.provider).prewarm(draft, threadInstructions(draft, this.scopeInfo(draft)), this.ctx);
  }

  /** remember: false for threads a page starts (board workers), so they leave the user's defaults alone. */
  createThread(input: ThreadPatch & { scope?: ThreadScope; noTools?: boolean }, { remember = true }: { remember?: boolean } = {}): ThreadView {
    const thread = this.draftThread(input);
    // Prewarm starts MCP with the draft's id. Reuse it so claims from that process map to this thread.
    // A draft thread (saved unsent) leaves the spare for the thread the user goes on to start.
    const spareId = input.draft ? null : this.agent(thread.provider).spareThreadId?.(thread, this.ctx);
    // The spare is taken on the first message; a second thread made before that gets its own id.
    // createSession also refuses that spare: its MCP still reports this id.
    if (spareId && !this.threads.has(spareId)) thread.id = spareId;
    if (input.draft) thread.draft = input.draft;
    if (input.helpersAllowed && !thread.noTools) thread.helpersAllowed = true;
    if (input.skills?.length && !thread.noTools) thread.skills = [...new Set(input.skills)];
    const space = this.startSpace(thread.scope);
    if (space) thread.space = space;
    // A New page becomes a real page once it has a thread, even one that has not sent anything.
    if (thread.scope.kind === "page" && thread.scope.ref) store.promoteDraft(thread.scope.ref);
    this.threads.set(thread.id, thread);
    this.items.set(thread.id, []);
    this.turns.set(thread.id, []);
    this.seq.set(thread.id, 0);
    this.db.saveThread(thread);
    if (thread.cwd) this.noteWorkspaces([thread.cwd]);
    if (remember) this.rememberChoices(thread, settingPatch(thread));
    const view = this.view(thread);
    this.emit({ type: "agent_thread", thread: view });
    return view;
  }

  /** Persist a draft's visible settings as the defaults for the next new thread. */
  rememberDraft(input: ThreadPatch & { scope?: ThreadScope }): Prefs {
    const thread = this.draftThread(input);
    this.rememberChoices(thread, settingPatch(thread));
    return this.prefs();
  }

  /** A thread with defaults filled in, not stored. createThread and warmDraft agree on it, so a warmed spare matches. */
  private draftThread(input: ThreadPatch & { scope?: ThreadScope; noTools?: boolean }): Thread {
    const prefs = this.prefs();
    const provider = input.provider ?? prefs.provider;
    const scope: ThreadScope = input.scope ?? { kind: "global", ref: null };
    const scopeKey = scope.kind === "global" ? "global" : `${scope.kind}:${scope.ref}`;
    const cwd =
      input.cwd !== undefined
        ? input.cwd
        : scope.kind === "workspace"
          ? scope.ref
          : scope.kind === "page" && scope.ref
            ? this.pageWorkspace(scope.ref)
            : prefs.scopeWorkspaces[scopeKey] ?? prefs.recentWorkspaces[0] ?? null;
    const model = input.model ?? prefs.models[provider] ?? "default";
    const choice = modelChoice(prefs, provider, model);
    const scoped = scope.kind === "page" || scope.kind === "folder";
    // A custom mode named for the thread, else the last one picked when nothing says which mode.
    const customId = input.customMode !== undefined ? input.customMode : input.mode === undefined && !scoped ? prefs.customMode : null;
    const picked = input.custom ? undefined : prefs.customModes.find((mode) => mode.id === customId);
    const custom = input.custom ?? (picked ? threadCustom(picked) : undefined);
    // Page and folder threads start on Board, others on the provider's last rung (#719).
    const editRung = approvalFor(prefs, provider);
    const access = changeAccess(
      scoped ? { mode: "board", approval: "board" } : settleAccess("code", editRung),
      { mode: input.mode, approval: input.approval ?? picked?.approval },
      editRung,
      custom?.max
    );
    const now = Date.now();
    const thread: Thread = {
      id: `th_${crypto.randomBytes(6).toString("hex")}`,
      title: input.title?.trim() || "New thread",
      titleLocked: Boolean(input.title?.trim()),
      provider,
      model,
      effort: input.effort !== undefined ? input.effort : choice.effort,
      modelParams: input.modelParams ?? choice.modelParams,
      ...access,
      ...(custom ? { custom } : {}),
      // A custom mode that plans first, or the old plan mode: the first message is a plan turn (#721).
      ...(input.planNext || (!input.custom && picked?.plan) ? { planNext: true } : {}),
      // A mode without web tools keeps web off whatever the thread's setting says.
      web: custom?.off.includes("web") ? "off" : input.web ?? picked?.web ?? prefs.web,
      scope,
      cwd: cwd ?? null,
      useWorktree: input.useWorktree ?? (cwd ? prefs.worktrees[workspaceKey(cwd)] ?? false : false),
      nativeId: null,
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
      activityAt: now,
    };
    if (input.noTools) {
      thread.noTools = true;
      settleNoTools(thread);
    }
    return thread;
  }

  /**
   * The space a new thread is started in (#260): the active one, except for a chat on a page that is
   * not in the active space's strip (a board's worker while the user is elsewhere), which belongs to
   * the space the page was made in.
   */
  private startSpace(scope: ThreadScope): string | undefined {
    if (scope.kind === "page" && scope.ref && !store.isOpen(scope.ref)) {
      const madeIn = store.get(scope.ref)?.madeIn;
      if (madeIn) return madeIn;
    }
    return store.activeSpaceId();
  }

  /** Workspace a new thread on this page should start in: the page's own, else none. */
  private pageWorkspace(pageId: string): string | null {
    return (store.get(pageId) ?? store.getDraft(pageId))?.workspace ?? null;
  }

  updateThread(id: string, patch: ThreadPatch): ThreadView {
    const thread = this.requireThread(id);
    const next: Thread = { ...thread };
    if (typeof patch.title === "string" && patch.title.trim()) {
      next.title = patch.title.trim().slice(0, 200);
      next.titleLocked = true;
    }
    if (patch.provider && patch.provider !== thread.provider) {
      if (this.loadTurns(id).length) {
        throw new Error("A thread keeps its provider once it has messages. Start a new thread to switch.");
      }
      next.provider = patch.provider;
      const prefs = this.prefs();
      next.model = patch.model ?? prefs.models[patch.provider] ?? "default";
      // Another provider's last rung, unless the thread reads only (a page thread on Board stays there).
      if (!readsOnly(next.approval)) next.approval = approvalFor(prefs, patch.provider);
      next.nativeId = null;
      this.sessions.get(id)?.dispose();
      this.sessions.delete(id);
      forgetGuides(id);
    }
    if (typeof patch.model === "string") next.model = patch.model;
    // The old plan mode from an older client: the next message is a plan turn (#721).
    if (patch.planNext === true) next.planNext = true;
    if (next.provider !== thread.provider || next.model !== thread.model) {
      // A new model starts with the effort and params last picked for it.
      const choice = modelChoice(this.prefs(), next.provider, next.model);
      next.effort = choice.effort;
      next.modelParams = choice.modelParams;
    }
    if (patch.effort !== undefined) next.effort = patch.effort;
    if (patch.modelParams && typeof patch.modelParams === "object") next.modelParams = { ...next.modelParams, ...patch.modelParams };
    let accessPatch: { mode?: unknown; approval?: unknown } = { mode: patch.mode, approval: patch.approval };
    if (patch.customMode === null) delete next.custom;
    else if (patch.customMode) {
      const mode = this.prefs().customModes.find((m) => m.id === patch.customMode);
      if (!mode) throw new Error("That custom mode no longer exists.");
      next.custom = threadCustom(mode);
      accessPatch = { mode: patch.mode, approval: patch.approval ?? mode.approval };
      if (mode.plan) next.planNext = true;
      if (mode.web) next.web = mode.web;
    }
    // The rung decides, capped by a custom mode's highest rung; a mode from an older client still works (#719).
    Object.assign(next, changeAccess(next, accessPatch, approvalFor(this.prefs(), next.provider), modeMax(next)));
    if (patch.web) next.web = patch.web;
    if (modeOff(next, "web")) next.web = "off";
    if (patch.cwd !== undefined) {
      const cwd = patch.cwd ? path.normalize(patch.cwd) : null;
      if (cwd !== thread.cwd && this.runs.has(id)) throw new Error("Stop the running turn before changing the workspace.");
      if (cwd !== thread.cwd && openWorktree(thread)) throw new Error("This thread works in its own worktree. Merge or leave it before changing the workspace.");
      next.cwd = cwd;
      if (cwd !== thread.cwd && thread.worktree?.closed) {
        delete next.worktree;
        next.useWorktree = false;
        next.nativeId = null;
        this.sessions.get(id)?.dispose();
        this.sessions.delete(id);
        forgetGuides(id);
      }
    }
    if (typeof patch.useWorktree === "boolean" && patch.useWorktree !== Boolean(thread.useWorktree)) {
      if (openWorktree(thread)) throw new Error("This thread already has a worktree. Merge or leave it from the branch menu.");
      if (this.loadTurns(id).length) throw new Error("A worktree can only be turned on before the first message. Start a new thread to use one.");
      next.useWorktree = patch.useWorktree;
    }
    if (patch.scope) {
      // The user picking a scope sets what the chat reaches; homes it followed pages from no longer count.
      if (JSON.stringify(patch.scope) !== JSON.stringify(thread.scope)) delete next.formerScopes;
      next.scope = patch.scope;
    }
    if (patch.scope?.kind === "page" && patch.scope.ref) store.promoteDraft(patch.scope.ref, { activate: false });
    if (typeof patch.pinned === "boolean") next.pinned = patch.pinned;
    if (typeof patch.archived === "boolean") next.archived = patch.archived;
    if (typeof patch.hooksOff === "boolean") {
      if (patch.hooksOff) next.hooksOff = true;
      else delete next.hooksOff;
    }
    if (Array.isArray(patch.skills)) {
      if (patch.skills.length) next.skills = [...new Set(patch.skills)];
      else delete next.skills;
    }
    if (patch.draft !== undefined) next.draft = patch.draft;
    // A thread without tools keeps none, whatever the pickers asked for (#729).
    settleNoTools(next);
    // An archived thread is done with its agent browser.
    const browserPage = store.browserPage(id);
    if (browserPage && next.title !== thread.title) store.update(browserPage.id, { title: next.title, activate: false });
    if (next.archived && !thread.archived) void closeThreadBrowser(id);
    if (next.provider !== thread.provider || next.mode !== thread.mode || next.custom !== thread.custom || next.approval !== thread.approval || next.cwd !== thread.cwd || next.web !== thread.web || JSON.stringify(next.scope) !== JSON.stringify(thread.scope)) this.effectivePermissions.delete(id);
    next.updatedAt = Date.now();
    this.threads.set(id, next);
    this.db.saveThread(next);
    this.sessions.get(id)?.update(this.sessionThread(next));
    if (next.cwd && next.cwd !== thread.cwd) this.noteWorkspaces([next.cwd]);
    this.rememberChoices(next, patch);
    const view = this.view(next);
    this.emit({ type: "agent_thread", thread: view });
    // Its helpers sit under it in the thread list: they are archived and brought back with it.
    if (next.archived !== thread.archived) {
      for (const t of [...this.threads.values()]) {
        if (t.helperOf === id && t.archived !== next.archived) this.updateThread(t.id, { archived: next.archived });
      }
    }
    return view;
  }

  /**
   * Bind this chat to a page it just opened for the user, so the floating dock stays with the
   * conversation. Board-owned threads (a page started them) stay on that page.
   */
  followToPage(threadId: string, pageId: string): boolean {
    const thread = this.threads.get(threadId);
    if (!thread || thread.archived) return false;
    if (!store.get(pageId)) return false;
    if (pageOwned(this.loadItems(threadId))) return false;
    if (thread.scope.kind === "page" && thread.scope.ref === pageId) return false;
    // The page it came from still counts for page access, so following a report does not cut it off (#269).
    const former = [...(thread.formerScopes ?? [])];
    if (thread.scope.kind !== "workspace" && !former.some((s) => s.kind === thread.scope.kind && s.ref === thread.scope.ref)) former.push({ ...thread.scope });
    this.updateThread(threadId, { scope: { kind: "page", ref: pageId } });
    const moved = this.threads.get(threadId);
    if (moved && former.length) {
      moved.formerScopes = former.slice(-20);
      this.db.saveThread(moved);
    }
    return true;
  }

  /** What access.ts needs from the user's settings. */
  accessEnv(): PolicyEnv {
    return { protectedPaths: this.prefs().protectedPaths, scratchDir: this.ctx.scratchDir };
  }

  /**
   * A read by Scribe's own tools (read_file, file search, page_open's file) outside the thread's read
   * roots (#898): asked like a provider's read, so the user can allow its folder for the thread. A
   * folder grant made earlier answers it. Refused when no turn is running.
   */
  async requestFileRead(threadId: string, tool: "read" | "search", real: string, reason: string): Promise<boolean> {
    const sink = this.runs.get(threadId)?.sink;
    if (!sink) return false;
    const req: ApprovalRequest = {
      tool,
      access: "read",
      paths: [real],
      title: `${tool === "search" ? "Search" : "Read"} outside the workspace: ${real}`,
      detail: reason,
      options: [
        { id: "allow", label: "Allow once", kind: "allow_once" },
        { id: "reject", label: "Deny", kind: "reject_once" },
      ],
    };
    try {
      return (await sink.approval(req)).optionId === "allow";
    } catch {
      return false;
    }
  }

  /** The OS sandbox for a thread's shell commands (#899), or null where it does not apply. Read per command, so grants count at once. */
  private sandboxHooks(threadId: string, cwd: string): SandboxHooks | null {
    const initial = this.threads.get(threadId);
    if (!initial || !sandboxed(initial)) return null;
    return {
      spec: () => {
        const t = this.threads.get(threadId);
        if (!t || !sandboxed(t)) return null;
        return { policy: policyFor({ ...t, cwd }, { ...this.accessEnv(), tmp: os.tmpdir() }), net: sandboxNet(t, this.prefs().webAllowlist, PORT) };
      },
      blocked: (command, blocks, signal) => this.sandboxBlocked(threadId, command, blocks, signal),
      missing: (reason) => {
        if (this.sandboxMissingSaid.has(threadId)) return;
        this.sandboxMissingSaid.add(threadId);
        log(`Sandbox unavailable for ${threadId}: ${reason}`);
        const run = this.runs.get(threadId);
        if (run) this.closeBlocks(run);
        this.addItem(threadId, run?.turn.id ?? null, { kind: "notice", level: "warn", text: `Sandbox not enforced: ${reason}. This thread's commands run without it.` });
      },
    };
  }

  /**
   * What the sandbox refused a command (#899): one chat row. Where a grant would let it through and
   * someone is watching, the row offers "Allow … for this thread" and the agent waits for the answer;
   * otherwise it is a notice. The agent gets a short reason either way. The agent_sandbox event carries
   * the blocks for the warning triggers (#893).
   */
  async sandboxBlocked(threadId: string, command: string, blocks: SandboxBlock[], signal?: AbortSignal): Promise<string> {
    const run = this.runs.get(threadId);
    this.emit({ type: "agent_sandbox", threadId, turnId: run?.turn.id ?? null, command: command.slice(0, 2000), blocks });
    const summary = blockSummary(blocks);
    if (!run) return summary;
    const what = (b: SandboxBlock) => (b.op === "network" ? `connect to ${b.target}` : `${b.op} to ${b.target}`);
    const title = `Sandbox blocked: ${what(blocks[0])}${blocks.length > 1 ? ` (+${blocks.length - 1} more)` : ""}`.slice(0, 300);
    const detail = [command.length > 500 ? `${command.slice(0, 500)}…` : command, ...blocks.slice(1, 10).map(what)].join("\n");
    const grants = blocks.flatMap((b) => (b.grant ? [b.grant] : []));
    this.closeBlocks(run);
    if (!grants.length || this.unattended(threadId)) {
      this.addItem(threadId, run.turn.id, { kind: "notice", level: "warn", text: `${title}\n${detail}` });
      return grants.length
        ? `${summary} Nobody can allow it in this unattended run: keep to the workspace, or say what you needed.`
        : `${summary} Protected paths and private addresses stay blocked, whatever is granted.`;
    }
    const one = grants.length === 1 ? grants[0] : null;
    const label = one ? `Allow ${one.kind === "folder" ? one.path : one.host} for this thread` : "Allow these for this thread";
    const item = this.addItem(threadId, run.turn.id, {
      kind: "approval",
      requestId: "",
      tool: "execute",
      title,
      detail,
      options: [
        { id: "allow", label, kind: "allow_always" },
        { id: "keep", label: "Keep blocked", kind: "reject_once" },
      ],
      status: "pending",
    });
    let decision: ApprovalDecision;
    try {
      decision = await this.waitPending<ApprovalDecision>(threadId, run, "approval", item.id, signal);
    } catch {
      return summary;
    }
    if (decision.optionId !== "allow") return `${summary} The user kept it blocked${decision.note ? `: ${decision.note}` : ""}. Work around it, or say what you needed.`;
    const t = this.threads.get(threadId);
    if (t) {
      const folders = grants.flatMap((g) => (g.kind === "folder" ? [{ kind: "folder" as const, path: g.path, access: "write" as const }] : []));
      const hosts = grants.flatMap((g) => (g.kind === "host" ? [g.host] : []));
      if (folders.length) t.toolGrants = addToolGrants(t.toolGrants, folders);
      if (hosts.length) t.webGrants = { ...t.webGrants, domains: cleanAllowlist([...(t.webGrants?.domains ?? []), ...hosts]) };
      this.db.saveThread(t);
      this.emitThread(threadId);
    }
    return `${summary} The user allowed it for this thread: run the command again.`;
  }

  /** Keep what one of Scribe's lasting tool options granted (#743): on the thread, or on the command allowlist. */
  recordToolGrant(threadId: string, req: ApprovalRequest, optionId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    const grant = grantFor(thread, req, optionId);
    if (!grant) return;
    if ("allowlist" in grant) {
      const list = this.prefs().commandAllowlist;
      if (!list.includes(grant.allowlist)) this.setPrefs({ commandAllowlist: [...list, grant.allowlist] });
      return;
    }
    thread.toolGrants = addToolGrants(thread.toolGrants, grant.grants);
    this.db.saveThread(thread);
    this.emitThread(threadId);
  }

  /** Take back a permission the user granted the thread (a web domain, any website, a readable thread scope, or starting helpers unasked). key comes from the view's grants. */
  revokeGrant(id: string, key: string): ThreadView {
    const thread = this.requireThread(id);
    const next = revokeGrant(thread, key);
    if (!next) throw new Error("This thread has no such permission.");
    thread.webGrants = next.webGrants;
    thread.threadGrants = next.threadGrants;
    if (next.pageGrants) thread.pageGrants = next.pageGrants;
    if(next.pluginGrants)thread.pluginGrants=next.pluginGrants;
    if (next.toolGrants) thread.toolGrants = next.toolGrants;
    if (next.helpersAllowed === false) delete thread.helpersAllowed;
    if (next.harnessAllowed === false) delete thread.harnessAllowed;
    this.db.saveThread(thread);
    this.sessions.get(id)?.update(this.sessionThread(thread));
    const view = this.view(thread);
    this.emit({ type: "agent_thread", thread: view });
    return view;
  }

  /** Model, effort, mode, and workspace picks become the defaults for new threads. */
  private rememberChoices(thread: Thread, patch: ThreadPatch): void {
    const next = prefsPatchFromChoices(this.prefs(), thread, patch);
    if (Object.keys(next).length) this.setPrefs(next);
  }

  async deleteThread(id: string): Promise<void> {
    const thread = this.requireThread(id);
    await this.cancel(id);
    this.sessions.get(id)?.dispose();
    this.sessions.delete(id);
    forgetGuides(id);
    void closeThreadBrowser(id);
    for (let held; (held = this.worktreeClosing(id)); ) await held.catch(() => {});
    const wt = openWorktree(this.threads.get(id) ?? thread);
    // A fork shares its worktree: the folder stays while another thread still works in it.
    if (wt && !this.sharers(id, wt).length) {
      // The folder goes; any work stays on the branch, so deleting a thread never loses it.
      await this.holdWorktree(wt.path, async () => {
        await commitAll(wt, `WIP: ${thread.title}`);
        await removeWorktree(wt);
        await dropBranchIfEmpty(wt);
      }).catch((err) => log(`Removing the worktree of ${id} failed: ${(err as Error).message}`));
    }
    this.threads.delete(id);
    if (this.claudeThreadLimits.delete(id)) this.db.setSetting("claudeThreadLimits", Object.fromEntries(this.claudeThreadLimits));
    this.effectivePermissions.delete(id);
    this.pageRuns.release(id);
    this.items.delete(id);
    this.turns.delete(id);
    this.queues.delete(id);
    this.unread.delete(id);
    for (const [key, item] of this.dirty) {
      if (item.threadId === id) this.dirty.delete(key);
    }
    this.db.deleteThread(id);
    try { new McpPermissions().pruneThreads(this.threads.keys()); }
    catch (err) { log(`Pruning MCP permissions failed: ${(err as Error).message}`); }
    this.db.deleteSetting(`fork:${id}`);
    try {
      removeThreadFiles(id);
      removeThreadSnapshots(id);
    } catch (err) {
      log(`Removing the files of ${id} failed: ${(err as Error).message}`);
    }
    this.emit({ type: "agent_thread_deleted", id });
    // Its helpers go with it.
    for (const t of [...this.threads.values()]) {
      if (t.helperOf === id) await this.deleteThread(t.id);
    }
    this.scheduleUnusedPageCleanup();
  }

  interact(id: string): void {
    const thread = this.requireThread(id);
    thread.interactedAt = Date.now();
    this.db.saveThread(thread);
    this.emit({ type: "agent_thread", thread: this.view(thread) });
  }

  /** The thread an approval or question waits in, so answering it counts as the user's interaction. */
  pendingThreadId(requestId: string): string | undefined {
    return this.pending.get(requestId)?.threadId;
  }

  markRead(id: string): void {
    if (this.unread.delete(id)) {
      const thread = this.threads.get(id);
      if (thread) this.emit({ type: "agent_thread", thread: this.view(thread) });
    }
  }

  async commands(id: string): Promise<SlashCommand[]> {
    const thread = this.requireThread(id);
    const session = this.sessions.get(id);
    if (session) {
      const list = await session.commands();
      if (list.length) {
        this.rememberCommands(thread.provider, list);
        return list;
      }
    }
    return this.providerCommands(thread.provider);
  }

  /** The last slash command list a provider reported, kept across restarts for new threads. */
  providerCommands(provider: ProviderId): SlashCommand[] {
    let list = this.commandCache.get(provider);
    if (!list) {
      list = this.db.getSetting<SlashCommand[]>(`commands.${provider}`, []);
      this.commandCache.set(provider, list);
    }
    return list;
  }

  /**
   * The message as typed, when the user typed one of the provider's slash commands (/compact, /model).
   * The provider only runs a command that starts the message, so it goes without the context, guides
   * and files that promptText puts before the text; a guide left out here goes with the next message.
   * Null for any other message.
   */
  private commandText(thread: Thread, msg: QueuedMessage): string | null {
    if (msg.from || msg.card || thread.rewind?.recap) return null;
    const name = /^\/([\w:.-]+)(?=\s|$)/.exec(msg.text)?.[1];
    if (!name || !this.providerCommands(thread.provider).some((cmd) => cmd.name === name)) return null;
    return msg.text;
  }

  private rememberCommands(provider: ProviderId, list: SlashCommand[]): void {
    const prev = this.commandCache.get(provider);
    this.commandCache.set(provider, list);
    if (JSON.stringify(prev) !== JSON.stringify(list)) this.db.setSetting(`commands.${provider}`, list);
  }

  private requireThread(id: string): Thread {
    const thread = this.threads.get(id);
    if (!thread) throw new Error(`thread not found: ${id}`);
    return thread;
  }

  private view(thread: Thread): ThreadView {
    const turns = this.loadTurns(thread.id);
    const files = new Set<string>();
    let added = 0;
    let removed = 0;
    let finishedAt: number | undefined;
    for (const turn of turns) {
      if (turn.endedAt) finishedAt = turn.endedAt;
      if (turn.reverted) continue;
      for (const file of turn.files ?? []) {
        files.add(file.path);
        added += file.added;
        removed += file.removed;
      }
    }
    const items = this.loadItems(thread.id);
    const fromPage = pageOwned(items);
    const asking = this.asking(thread.id);
    const status = this.status.get(thread.id) ?? "idle";
    const unread = this.unread.has(thread.id) && !fromPage;
    const activity = threadActivity(items, status, unread, this.helperLookup);
    if (activity) this.activitySent.set(thread.id, activityKey(activity));
    else this.activitySent.delete(thread.id);
    const grants = grantRows(thread, this.scopeLookup(), { page: (id) => store.get(id)?.title ?? null, folder: (id) => store.folderPath(id) });
    const usage = sumThreadUsage(turns);
    const pageRun = this.pageRuns.get(thread.id);
    return {
      ...thread,
      ...(thread.provider === "claude" ? { claudeLimits: this.liveLimits().claude ?? claudePlanSnapshot(null, {}) } : {}),
      ...(this.effectivePermissions.has(thread.id) ? { effectivePermissions: this.effectivePermissions.get(thread.id) } : {}),
      status,
      unread,
      queued: this.queues.get(thread.id)?.length ?? 0,
      background: this.backgroundTasks(thread.id),
      stats: { turns: turns.length, files: files.size, added, removed },
      fromPage,
      ...(usage ? { usage } : {}),
      ...(finishedAt ? { finishedAt } : {}),
      ...(thread.fork ? { carry: this.forkCarry(thread, thread.fork) } : {}),
      ...(asking ? { asking } : {}),
      ...(activity ? { activity } : {}),
      ...(grants.length ? { grants } : {}),
      ...(pageRun ? { run: runView(pageRun) } : {}),
    };
  }

  /** The helper thread an agent_run step names in its caller's activity line. */
  private helperLookup = (id: string) => (id ? this.threads.get(id) : undefined);

  private threadUsage(id: string) {
    return sumUsageTree(id, this.threads.values(), (threadId) => {
      const turns = this.loadTurns(threadId);
      const live = this.runs.get(threadId);
      return live ? turns.map((t) => t.id === live.turn.id ? { ...live.turn, usage: live.usage } : t) : turns;
    });
  }

  /** A running thread's live step changed: send the thread again, at most every ACTIVITY_MS. */
  private activityChanged(threadId: string): void {
    if (this.activityTimers.has(threadId) || (this.status.get(threadId) ?? "idle") === "idle") return;
    const timer = setTimeout(() => {
      this.activityTimers.delete(threadId);
      const thread = this.threads.get(threadId);
      if (!thread) return;
      const status = this.status.get(threadId) ?? "idle";
      const activity = threadActivity(this.loadItems(threadId), status, false, this.helperLookup);
      if (activity && activityKey(activity) !== this.activitySent.get(threadId)) this.emitThread(threadId);
    }, ACTIVITY_MS);
    timer.unref?.();
    this.activityTimers.set(threadId, timer);
  }

  /** The thread's oldest unanswered interaction, for the tab strip, Library and palette. */
  private asking(threadId: string): ThreadView["asking"] {
    for (const pending of this.pending.values()) {
      if (pending.threadId !== threadId) continue;
      const item = this.loadItems(threadId).find((it) => it.id === pending.itemId);
      if (!item) continue;
      if (item.kind === "browser_handoff") return { kind: "question", itemId: item.id, title: item.message };
      if (item.kind === "component") return { kind: "question", itemId: item.id, title: item.title || "Component" };
      if (item.kind === "approval") {
        return { kind: "approval", itemId: item.id, title: item.title, ...(item.detail ? { detail: item.detail } : {}), options: item.options };
      }
      if (item.kind === "question") {
        const title = item.title || item.questions[0]?.prompt || item.page?.title || "Question";
        return { kind: "question", itemId: item.id, title, ...(item.page ? { page: item.page } : {}), ...(item.display === "dialog" ? { form: true } : {}) };
      }
    }
    if (this.runs.has(threadId)) return undefined;
    const last = [...this.loadItems(threadId)].reverse().find((it) => it.kind !== "notice");
    if (last?.kind === "plan" && last.status === "pending") return { kind: "plan", itemId: last.id, title: last.title || "Plan to review" };
    if (last?.kind === "usage_limit" && last.status === "pending") return { kind: "limit", itemId: last.id, title: "Usage limit hit", resetsAt: last.resetsAt, ...(last.switchTo ? { switchTo: last.switchTo } : {}) };
    return undefined;
  }

  private emitThread(id: string): void {
    const thread = this.threads.get(id);
    if (thread) {
      const page = store.browserPage(id);
      if (page && page.title !== thread.title) store.update(page.id, { title: thread.title, activate: false });
      this.emit({ type: "agent_thread", thread: this.view(thread) });
    }
    this.scheduleUnusedPageCleanup();
  }

  private loadItems(id: string): Item[] {
    let items = this.items.get(id);
    if (!items) {
      items = this.db.listItems(id);
      this.items.set(id, items);
      this.seq.set(id, items.length ? items[items.length - 1].seq : 0);
      // Loaded once per daemon run, before any session exists: tasks still marked running died with the last one.
      const stale = items.filter((item) => item.kind === "tool" && item.task?.status === "running");
      for (const item of stale) {
        if (item.kind === "tool" && item.task) item.task = { ...item.task, status: "stopped", summary: "Stopped: Scribe restarted", endedAt: item.task.endedAt ?? Date.now() };
      }
      if (stale.length) this.db.saveItems(stale);
      const expired = items.filter((item): item is ComponentItem => item.kind === "component" && item.status === "pending");
      for (const item of expired) item.status = "expired";
      if (expired.length) this.db.saveItems(expired);
      const handoffs = items.filter(item => item.kind === "browser_handoff" && item.status === "pending");
      for (const item of handoffs) if (item.kind === "browser_handoff") item.status = "cancelled";
      if (handoffs.length) this.db.saveItems(handoffs);
    }
    return items;
  }

  private loadTurns(id: string): Turn[] {
    let turns = this.turns.get(id);
    if (!turns) {
      turns = this.db.listTurns(id);
      this.turns.set(id, turns);
    }
    return turns;
  }

  private scopeInfo(thread: Thread): ScopeInfo {
    const info = this.scopePages(thread);
    if(plugins && !noPages(thread.scope)) {
      const key=`pluginCatalog:${thread.id}`;
      let catalog=this.db.getSetting<ScopeInfo["plugins"]|null>(key,null);
      if(catalog===null){catalog=plugins.list().filter(p=>p.enabled).map(({id,summary})=>({id,summary,components:Object.entries(plugins!.get(id).manifest.components??{}).map(([name,c])=>({name,description:c.description}))}));this.db.setSetting(key,catalog);}
      info.plugins=catalog;
    }
    if (this.prefs().searxngUrl) info.webSearch = true;
    try {
      const skills = this.scribeSkills.effective(thread);
      if (skills.length) info.skills = skills.map(({ id, name, description, builtin }) => ({ id, name, description, ...(builtin ? { builtin } : {}) }));
    } catch (err) {
      log(`skills for ${thread.id}: ${(err as Error).message}`);
    }
    if (this.prefs().instructionsOff.length) info.instructionsOff = this.prefs().instructionsOff;
    if (this.prefs().helpers && !thread.helperOf && !modeOff(thread, "helpers")) info.helpers = true;
    if (this.prefs().memory) info.memories = memoriesFor(this.memories(), this.memoryWorkspace(thread), this.runs.get(thread.id)?.memoryOwner ?? memoryOwner(thread));
    if (thread.provider === "claude") {
      const have = new Set(serversForThread(thread).map((s) => s.name));
      const leftOut = claudeOwnServers(threadWorkspace(thread)).filter((name) => !have.has(name));
      if (leftOut.length) info.mcpLeftOut = leftOut;
    }
    return info;
  }

  private scopePages(thread: Thread): ScopeInfo {
    if (thread.scope.kind === "page" && thread.scope.ref) {
      // A warmed spare for a New page sees the draft; the thread that takes it makes the page real.
      const tab = store.get(thread.scope.ref, "agent") ?? store.getDraft(thread.scope.ref);
      if (!tab) return { page: null };
      return {
        page: { id: tab.id, key: tab.key, title: tab.title, folder: store.folderPath(tab.folderId), ...(isBlankPage(tab) ? { blank: true } : {}) },
        folderInstructions: store.folderInstructionsFor(tab.folderId ?? null),
      };
    }
    if (thread.scope.kind === "folder" && thread.scope.ref) {
      const folderPath = store.folderPath(thread.scope.ref);
      if (!folderPath) return { folder: null };
      return {
        folder: { id: thread.scope.ref, path: folderPath },
        folderInstructions: store.folderInstructionsFor(thread.scope.ref),
      };
    }
    return {};
  }

  /**
   * The agent guides for the pages a message brings up: the thread's own page, page chips, and
   * scribe: keys in the text. A guide goes in once per conversation (the MCP checks the same
   * memory, so its tool results skip it too); after that a chip or link only names it.
   */
  private pageGuides(thread: Thread, msg: QueuedMessage): string {
    const ids: Array<{ ref: string; own?: boolean }> = [];
    if (thread.scope.kind === "page" && thread.scope.ref) ids.push({ ref: thread.scope.ref, own: true });
    for (const chip of msg.context) {
      if (chip.kind === "page") ids.push({ ref: chip.id });
      // A selection names the page it came from.
      else if (chip.kind === "selection" && chip.source) for (const key of pageKeysIn(chip.source).slice(0, 1)) ids.push({ ref: key });
    }
    // Pasted text can hold many keys; a few is what "look at this page" looks like.
    for (const key of pageKeysIn(msg.text).slice(0, 8)) ids.push({ ref: key });
    const pages: PageGuide[] = [];
    const seen = new Set<string>();
    for (const { ref, own } of ids) {
      const tab = store.get(ref, "agent");
      if (!tab?.templateId || seen.has(tab.id)) continue;
      seen.add(tab.id);
      const guide = store.templateGuide(tab.templateId);
      if (!guide) continue;
      const given = guideSent(thread.id, guide);
      // The thread's own page is named in its instructions; it only needs the guide the first time.
      if (given && own) continue;
      pages.push({ key: tab.key, guide, given });
    }
    for (const page of pages) markGuideSent(thread.id, page.guide);
    return guidesBlock(pages);
  }

  /**
   * When a watched page changed since this thread last saw it, a short note so the next turn
   * re-reads instead of overwriting the user's edit.
   */
  private pageEditPrefix(thread: Thread, currentTurnId: string): string {
    const prior = this.loadTurns(thread.id).filter((t) => t.id !== currentTurnId);
    const seen = lastSeenPages(prior);
    if (!seen.length) return "";
    return pageEditsBlock(pageEditsSince(seen, this.pageSnapshots(seen.map((page) => page.id))));
  }

  private pageSnapshots(refs: string[]): PageSnapshot[] {
    const out: PageSnapshot[] = [];
    const ids = new Set<string>();
    for (const ref of refs) {
      const tab = store.get(ref, "agent");
      if (!tab || ids.has(tab.id)) continue;
      ids.add(tab.id);
      out.push({ id: tab.id, key: tab.key, title: tab.title, revision: tab.revision, stateRevision: tab.stateRevision });
    }
    return out;
  }

  /** Record the thread's page, attached pages, and pages this turn wrote, as of now. */
  private rememberTurnPages(thread: Thread, msg: QueuedMessage | null, turn: Turn, extraRefs: string[]): void {
    const prior = this.loadTurns(thread.id).filter((t) => t.id !== turn.id);
    const watch = [...extraRefs];
    if (thread.scope.kind === "page" && thread.scope.ref) watch.push(thread.scope.ref);
    if (msg) {
      for (const chip of msg.context) {
        if (chip.kind === "page") watch.push(chip.id);
      }
    }
    watch.push(...writePageRefs(this.loadItems(thread.id).filter((item) => item.turnId === turn.id)));
    const seen = rememberPages(this.pageSnapshots(watch), this.pageSnapshots(lastSeenPages(prior).map((page) => page.id)));
    if (seen.length) turn.seenPages = seen;
    else delete turn.seenPages;
  }

  // ---------- items ----------

  private addItem(threadId: string, turnId: string | null, body: ItemBody): Item {
    if (!this.threads.has(threadId)) {
      // A turn still finishing after its thread was deleted: nothing to store or show.
      return { id: "", threadId, turnId, seq: 0, createdAt: Date.now(), ...body } as Item;
    }
    const items = this.loadItems(threadId);
    const seq = (this.seq.get(threadId) ?? 0) + 1;
    this.seq.set(threadId, seq);
    const id = `it_${crypto.randomBytes(6).toString("hex")}`;
    const item = { id, threadId, turnId, seq, createdAt: Date.now(), ...body } as Item;
    // Interactions are answered by their item id.
    if ("requestId" in item && item.requestId === "") item.requestId = id;
    items.push(item);
    this.touch(item);
    return item;
  }

  /** Marks an item changed: broadcast now, save on the next flush. */
  private touch(item: Item): void {
    if (!this.threads.has(item.threadId)) return;
    this.flushDelta(item.id);
    this.dirty.set(item.id, item);
    this.emit({ type: "agent_item", item });
    this.scheduleFlush();
    if (item.kind === "tool" || item.kind === "text" || item.kind === "reasoning") this.activityChanged(item.threadId);
  }

  private appendText(item: Item & { text: string }, delta: string): void {
    item.text += delta;
    this.dirty.set(item.id, item);
    const buf = this.deltaBuf.get(item.id);
    if (buf) buf.text += delta;
    else this.deltaBuf.set(item.id, { threadId: item.threadId, text: delta });
    if (item.kind === "text") this.activityChanged(item.threadId);
    if (!this.deltaTimer) {
      this.deltaTimer = setTimeout(() => this.flushDeltas(), DELTA_MS);
    }
    this.scheduleFlush();
  }

  private flushDelta(itemId: string): void {
    const buf = this.deltaBuf.get(itemId);
    if (!buf) return;
    this.deltaBuf.delete(itemId);
    this.emit({ type: "agent_delta", threadId: buf.threadId, itemId, append: buf.text });
  }

  private flushDeltas(): void {
    this.deltaTimer = null;
    for (const itemId of [...this.deltaBuf.keys()]) this.flushDelta(itemId);
  }

  private scheduleFlush(): void {
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushNow(), FLUSH_MS);
    }
  }

  private flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const items = [...this.dirty.values()].filter((item) => this.threads.has(item.threadId));
    this.dirty.clear();
    try {
      this.db.saveItems(items);
    } catch (err) {
      log(`Agent item save failed: ${(err as Error).message}`);
    }
  }

  private saveTurn(turn: Turn): void {
    if (!this.threads.has(turn.threadId)) return;
    this.db.saveTurn(turn);
    this.emit({ type: "agent_turn", turn });
  }

  private setStatus(threadId: string, status: RunStatus): void {
    if ((this.status.get(threadId) ?? "idle") === status) return;
    this.status.set(threadId, status);
    this.emitThread(threadId);
  }

  // ---------- running ----------

  /** Pages, folders and files this thread has already been told about. */
  private knownContext(threadId: string, thread: Thread): ContextChip[] {
    const already: ContextChip[] = [];
    if (thread.scope.kind === "page" && thread.scope.ref) {
      already.push({ kind: "page", id: thread.scope.ref, key: "", title: "" });
    }
    for (const item of this.loadItems(threadId)) {
      if (item.kind === "user" && !item.dropped && item.context?.length) already.push(...item.context);
    }
    return already;
  }

  send(threadId: string, input: SendInput): { queued: boolean; item: Item } {
    const thread = this.requireThread(threadId);
    // Also protects existing boards whose saved HTML predates the worker recovery check.
    if ((input.from === "page" || input.from === "component") && !input.card?.resume && thread.provider === "codex" && !this.runs.has(threadId)) {
      const last = this.db.listTurns(threadId).at(-1);
      if (last?.limitResetsAt && !codexUsageRecoveryAllowed(this.planLimits.codex, last.endedAt ?? last.startedAt)) {
        void this.refreshCodexUsage();
        throw new Error("Codex has not confirmed that included usage is available again. Waiting for a fresh quota read.");
      }
    }
    let text = input.text.trim();
    // "/plan <task>" marks a plan turn (#721), whoever sends it.
    const slash = /^\/plan(?:\s+|$)/.exec(text);
    if (slash) text = text.slice(slash[0].length).trim();
    if (!text && !input.images?.length && !input.files?.length) throw new Error("Empty message");
    if (!input.from) { browserUserMessage(threadId); this.handBackBrowser(threadId); }
    // A thread started in the old plan mode plans on its first message; Scribe's own notes and hooks don't use that up.
    const ownNote = input.from === "scribe" || input.from === "hook";
    const plan = slash ? true : input.plan ?? (ownNote ? false : Boolean(thread.planNext));
    if (thread.planNext && (!ownNote || input.plan !== undefined)) {
      delete thread.planNext;
      this.db.saveThread(thread);
      this.emitThread(threadId);
    }
    // Only the person's composer may authorize a tag; page/agent/hook messages cannot grant access.
    const tagged: Extract<ContextChip, { kind: "thread" }>[] = [];
    const supplied = (input.context ?? []).flatMap((chip): ContextChip[] => {
      if (chip.kind !== "thread") return [chip];
      const target = !input.from && typeof chip.id === "string" ? this.threads.get(chip.id) : null;
      if (!target || target.id === threadId) return [];
      const canonical = { kind: "thread" as const, id: target.id, title: target.title };
      tagged.push(canonical);
      return [canonical];
    });
    const context = freshContext(supplied, this.knownContext(threadId, thread).filter((chip) => chip.kind !== "thread"));
    const wt = openWorktree(thread);
    // A closure removing it lets the message wait: its turn opens a worktree again (#736).
    if (wt && !fs.existsSync(wt.path) && !this.worktreeClosing(threadId)) {
      throw new Error(`This thread's worktree is gone (${wt.path}). Use Leave branch in the branch menu to go back to the main checkout; the branch ${wt.branch} keeps its commits.`);
    }
    const images = input.images ?? [];
    const files = input.files ?? [];
    const msg: QueuedMessage = {
      text,
      images,
      files,
      saved: { images: saveFiles(threadId, images), files: saveFiles(threadId, files) },
      context,
      ...(input.from ? { from: input.from } : {}),
      ...(input.card ? { card: input.card } : {}),
      ...(input.dock && !input.from ? { dock: true } : {}),
      ...(plan ? { plan: true } : {}),
    };
    if (tagged.length) {
      thread.threadGrants = grantScopes(thread.threadGrants, tagged.map((chip) => ({ kind: "thread" as const, id: chip.id })));
      this.db.saveThread(thread);
      this.emitThread(threadId);
    }
    // A page or folder the user @mentions is theirs to show: the thread reaches it whatever its access level (#269).
    if (!input.from) {
      const mentioned = supplied.flatMap((chip): ThreadPageGrant[] =>
        chip.kind === "page" && typeof chip.id === "string" && store.get(chip.id) ? [{ kind: "page", id: store.get(chip.id)!.id, mention: true }]
        : chip.kind === "folder" && typeof chip.id === "string" && store.folderPath(chip.id) ? [{ kind: "folder", id: chip.id, mention: true }]
        : []);
      // A page key the user writes or pastes without @ lets the thread read it, not change it (#818).
      // Only Normal or Open pages: pageReach ignores read grants for stricter ones.
      const named = input.card ? [] : pageKeysInText(text).flatMap((key): ThreadPageGrant[] => {
        const tab = store.get(key);
        return tab ? [{ kind: "page", id: tab.id, read: true }] : [];
      });
      this.grantPages(threadId, [...mentioned, ...named]);
      // The same for a page on another device (scribe:@laptop/notes, #911): that device resolves the key.
      const remote = input.card ? [] : deviceKeysInText(text);
      if (remote.length) {
        const have = thread.deviceKeys ?? [];
        const next = [...have, ...remote.filter((r) => !have.some((h) => h.device === r.device && h.key === r.key))].slice(-200);
        if (next.length !== have.length) {
          thread.deviceKeys = next;
          this.db.saveThread(thread);
        }
      }
    }
    if (!input.from && thread.draft) {
      // The user sent what they had left in the composer.
      thread.draft = null;
      this.db.saveThread(thread);
    }
    if (this.runs.has(threadId) || this.queues.get(threadId)?.length) {
      const queue = this.queues.get(threadId) ?? [];
      queue.push(msg);
      this.queues.set(threadId, queue);
      const item = this.addItem(threadId, null, userBody(msg));
      msg.itemId = item.id;
      this.emitThread(threadId);
      this.drainQueue(threadId);
      return { queued: true, item };
    }
    const item = this.addItem(threadId, null, userBody(msg));
    void this.runTurn(threadId, msg, item);
    return { queued: false, item };
  }

  /** Queued messages that have not run yet, oldest first, in the same order as the queue. */
  private queuedItems(threadId: string): Item[] {
    return this.loadItems(threadId).filter((item) => item.kind === "user" && item.turnId === null && !item.dropped && !item.steer);
  }

  /**
   * Hand the first queued message to the running turn, which takes it in at its next step. When a
   * steered message is already waiting, or the provider cannot steer, send it now instead.
   */
  async steer(threadId: string, itemId?: string): Promise<{ steered: boolean }> {
    const run = this.runs.get(threadId);
    const session = this.sessions.get(threadId);
    if (!run) throw new Error("No turn is running");
    if (itemId) {
      const waiting = this.loadItems(threadId).find((it) => it.id === itemId && it.kind === "user" && it.steer === "waiting");
      if (waiting) {
        await this.sendNow(threadId);
        return { steered: false };
      }
      if (!this.preferQueued(threadId, itemId)) throw new Error("That message is not queued");
    }
    if (run.steer || !session?.steer) {
      await this.sendNow(threadId);
      return { steered: false };
    }
    const queue = this.queues.get(threadId);
    if (!queue?.length) throw new Error("Nothing is queued");
    if (!this.steerFirst(threadId)) throw new Error("Finish editing the queued message first");
    return { steered: true };
  }

  /**
   * A Kanban card's board sends a comment to the thread working on the card, or Continue to the one
   * that worked on it before. A comment goes into the running turn (steered in, or queued behind it
   * when the provider cannot steer) and is not sent when the thread is idle: the board offers
   * Continue instead. Continue sends the host's own note telling the agent to read the card again.
   */
  cardMessage(threadId: string, card: CardRef, text: string): { delivered: "steered" | "queued" | "started" | null; deferred?: boolean } {
    const thread = this.threads.get(threadId);
    const page = thread?.scope.kind === "page" && thread.scope.ref ? store.get(thread.scope.ref) : undefined;
    if (card.resume && page && store.drives(page)) {
      // Covers older saved board HTML too: it must not start the chat and claim
      // the card before the daemon checks its current worker conditions.
      store.runAction(page.id, "continue", { card: card.num }, { by: "user" }, (id) => this.runInfo(id));
      return { delivered: null, deferred: true };
    }
    if (!card.resume) {
      if (!this.runs.has(threadId)) return { delivered: null };
      if (!text.trim()) throw new Error("Empty comment");
    }
    const body = card.resume && card.reply
      ? `Continue the work on card #${card.num} with the user's answer: it is the card's newest comment. Get the card again and read it before you go on. The board has claimed it for you again and moved it to the working column, so don't claim it; finish it when you are done.`
      : card.resume
      ? `Continue the work on card #${card.num}. Its description, checklist, or comments may have changed since you last worked on it: get the card again and read it in full before you go on. The board has claimed it for you again and moved it to the working column, so don't claim it; finish it when you are done.`
      : text;
    const { queued } = this.send(threadId, { text: body, from: "page", card });
    if (!queued) return { delivered: "started" };
    // Steer only when it is the one queued message: steering takes the queue's first.
    if (!card.resume && this.queues.get(threadId)?.length === 1 && this.steerFirst(threadId)) return { delivered: "steered" };
    return { delivered: "queued" };
  }

  /** Put this queued item first so steer / send-now acts on it. */
  private preferQueued(threadId: string, itemId: string): boolean {
    const queue = this.queues.get(threadId);
    const i = queue?.findIndex((msg) => msg.itemId === itemId) ?? -1;
    if (i < 0 || !queue || i >= queue.length) return false;
    if (queue.slice(0, i + 1).some((msg) => msg.edit)) throw new Error("Finish editing the queued message first");
    if (i > 0) {
      const [msg] = queue.splice(i, 1);
      queue.unshift(msg);
    }
    return true;
  }

  /** Hand the first queued message to the running turn. False when there is nothing to hand, or the provider cannot take it now. */
  private steerFirst(threadId: string): boolean {
    const run = this.runs.get(threadId);
    const queue = this.queues.get(threadId);
    const session = this.sessions.get(threadId);
    if (!run || run.steer || !session?.steer || !queue?.length) return false;
    if (queue[0].edit) return false;
    const msg = queue.shift()!;
    if (!queue.length) this.queues.delete(threadId);
    const item = this.loadItems(threadId).find((it) => it.id === msg.itemId);
    const thread = this.requireThread(threadId);
    const id = session.steer({ text: this.commandText(thread, msg) ?? promptText(msg, thread, this.pageGuides(thread, msg)), images: msg.images, documents: pdfs(msg) });
    run.steer = { id, msg, itemId: item?.id };
    if (item && item.kind === "user") {
      item.steer = "waiting";
      this.touch(item);
    }
    this.emitThread(threadId);
    if (item) this.hookPrompt(threadId, run, msg, item);
    return true;
  }

  private pendingMessage(threadId: string, itemId?: string): QueuedMessage {
    const queue = this.queues.get(threadId) ?? [];
    const waiting = this.runs.get(threadId)?.steer;
    const msg = itemId
      ? queue.find((msg) => msg.itemId === itemId) ?? (waiting?.itemId === itemId ? waiting.msg : undefined)
      : queue[queue.length - 1] ?? waiting?.msg;
    if (!msg) throw new Error("That message is no longer pending");
    return msg;
  }

  /** Hold before awaiting withdrawal so turn completion cannot drain this message meanwhile. */
  async beginQueuedEdit(threadId: string, itemId: string, recover = false): Promise<{ token: string }> {
    const msg = this.pendingMessage(threadId, itemId);
    if (msg.edit) {
      if (!recover || msg.edit.withdrawal) throw new Error("That message is already being edited");
      // A reloaded view can reopen a stranded edit; stale popup tokens cannot save or release it.
      msg.edit.token = crypto.randomBytes(12).toString("hex");
      return { token: msg.edit.token };
    }
    const run = this.runs.get(threadId);
    const waiting = run?.steer;
    const wasSteered = waiting?.msg === msg;
    const token = crypto.randomBytes(12).toString("hex");
    msg.edit = { token, steer: wasSteered };
    if (wasSteered && waiting) {
      msg.edit.withdrawal = this.sessions.get(threadId)?.withdrawSteer?.(waiting.id).catch(() => false) ?? Promise.resolve(false);
      const withdrawn = await msg.edit.withdrawal;
      if (!withdrawn) {
        delete msg.edit;
        this.drainQueue(threadId);
        throw new Error("That message has already been handed to the agent");
      }
      if (run?.steer === waiting) {
        run.steer = null;
        const queue = this.queues.get(threadId) ?? [];
        queue.unshift(msg);
        this.queues.set(threadId, queue);
      }
      delete msg.edit?.withdrawal;
    }
    const item = this.loadItems(threadId).find((it) => it.id === itemId);
    if (!item || item.kind !== "user" || item.turnId || item.dropped) {
      delete msg.edit;
      throw new Error("That message is no longer pending");
    }
    delete item.steer;
    item.editing = true;
    this.touch(item);
    this.emitThread(threadId);
    return { token };
  }

  finishQueuedEdit(threadId: string, itemId: string, token: string, text?: string): void {
    const msg = this.pendingMessage(threadId, itemId);
    if (!msg.edit || msg.edit.token !== token) throw new Error("That edit is no longer active");
    if (text !== undefined && !text.trim() && !msg.images.length && !msg.files.length) throw new Error("Empty message");
    const steer = msg.edit.steer;
    const item = this.loadItems(threadId).find((it) => it.id === itemId);
    if (text !== undefined) msg.text = text;
    delete msg.edit;
    if (item?.kind === "user") {
      item.text = msg.text;
      delete item.editing;
      this.touch(item);
    }
    if (steer && this.queues.get(threadId)?.[0] === msg) this.steerFirst(threadId);
    this.emitThread(threadId);
    this.drainQueue(threadId);
  }

  async withdraw(threadId: string, itemId?: string): Promise<{ text: string; images: ChatImage[]; files: ChatFile[]; context: ContextChip[] }> {
    const msg = this.pendingMessage(threadId, itemId);
    const id = msg.itemId;
    if (!id) throw new Error("That message is no longer pending");
    await this.beginQueuedEdit(threadId, id);
    const queue = this.queues.get(threadId);
    const at = queue?.indexOf(msg) ?? -1;
    if (at < 0 || !queue) throw new Error("That message is no longer pending");
    queue.splice(at, 1);
    if (!queue.length) this.queues.delete(threadId);
    const item = this.loadItems(threadId).find((it) => it.id === id);
    if (item) this.removeItem(item);
    this.forgetFiles(threadId, msg);
    this.emitThread(threadId);
    this.drainQueue(threadId);
    return { text: msg.text, images: msg.images, files: msg.files, context: msg.context };
  }

  /** Never pass an edited head of the queue, even when the preceding turn has ended. */
  private drainQueue(threadId: string): void {
    if (this.runs.has(threadId) || !this.threads.has(threadId)) return;
    const queue = this.queues.get(threadId);
    if (!queue?.length || queue[0].edit) return;
    const next = queue.shift()!;
    if (!queue.length) this.queues.delete(threadId);
    const item = this.loadItems(threadId).find((it) => it.id === next.itemId);
    void this.runTurn(threadId, next, item ?? this.addItem(threadId, null, userBody(next)));
  }

  /** A withdrawn message's saved files: the composer has them again and saves them anew on send. */
  private forgetFiles(threadId: string, msg: QueuedMessage): void {
    try {
      removeFiles(threadId, [...msg.saved.images, ...msg.saved.files].map((ref) => ref.id));
    } catch (err) {
      log(`Removing withdrawn files failed: ${(err as Error).message}`);
    }
  }

  private removeItem(item: Item): void {
    const items = this.loadItems(item.threadId);
    const at = items.indexOf(item);
    if (at >= 0) items.splice(at, 1);
    this.dirty.delete(item.id);
    this.deltaBuf.delete(item.id);
    this.db.deleteItem(item.id);
    this.emit({ type: "agent_item_deleted", threadId: item.threadId, id: item.id });
  }

  /**
   * Stop the running turn and run the waiting steered message, or else the first queued one, as the
   * next turn. Unlike cancel, the rest of the queue stays.
   */
  async sendNow(threadId: string, itemId?: string): Promise<void> {
    const run = this.runs.get(threadId);
    if (itemId) {
      const waiting = this.loadItems(threadId).find((it) => it.kind === "user" && it.steer === "waiting");
      if (waiting) {
        if (waiting.id !== itemId) return;
      } else if (!this.preferQueued(threadId, itemId)) return;
    }
    if (this.queues.get(threadId)?.[0]?.edit) throw new Error("Finish editing the queued message first");
    if (!run) { this.drainQueue(threadId); return; }
    if (!run.steer && !this.queues.get(threadId)?.length) return;
    await this.cancel(threadId, { keepQueue: true });
  }

  /**
   * A background agent asked for approval between turns. The thread's own rules still apply; past
   * those, nobody is there to answer, so it is refused with a note the agent can act on.
   */
  private approveBetweenTurns(threadId: string, req: ApprovalRequest): Promise<ApprovalDecision> {
    const t = this.threads.get(threadId);
    const auto = autoApproval(t, req);
    if (auto) return auto;
    const allow = req.options.find((o) => o.kind === "allow_once");
    if (t && allow && grantAllows(t, req, this.prefs().commandAllowlist)) return Promise.resolve({ optionId: allow.id });
    const reject = req.options.find((o) => o.kind === "reject_once") ?? req.options.find((o) => o.kind === "reject_always");
    const note = "The user was not asked: this ran in the background after the turn ended. Leave it out, and mention it in your result.";
    return reject ? Promise.resolve({ optionId: reject.id, note }) : Promise.reject(new Error(note));
  }

  /**
   * A web call the thread's web setting does not cover (off, or off the limited allowlist): ask the
   * user to allow it once, for its domain or for the rest of the thread. In a board worker's thread
   * nobody may be watching, so an unanswered request is refused after its importance's wait and the
   * agent carries on without it.
   */
  async requestWeb(threadId: string, call: WebCall, opts: { importance?: WebImportance; reason?: string; signal?: AbortSignal } = {}): Promise<{ allowed: boolean; message?: string }> {
    const thread = this.threads.get(threadId);
    if (!thread) return { allowed: false, message: "Unknown thread." };
    if (modeOff(thread, "web")) return { allowed: false, message: `This thread's mode (${thread.custom?.name}) has no web access. Carry on without it.` };
    if (webCallAllowed(call, thread.web, this.prefs().webAllowlist, thread.webGrants)) return { allowed: true };
    if (this.takeWebPass(threadId, call)) return { allowed: true };
    const run = this.runs.get(threadId);
    if (!run) return { allowed: false, message: "Web access is off for this thread, and with no turn running the user cannot be asked. Carry on without it." };
    const importance = opts.importance ?? "useful";
    const waitMs = this.unattended(threadId) ? WEB_IMPORTANCE_WAIT_MS[importance] : null;
    const domains = webCallDomains(call);
    const title = call.kind === "fetch" ? `Web access: fetch ${call.url}` : `Web access: search${call.query ? ` “${call.query}”` : ""}${domains.length ? ` on ${domains.join(", ")}` : ""}`;
    const detail = [
      `Web access for this thread is ${thread.web === "limited" ? "limited to the allowlist" : "off"}. Importance: ${importance}.`,
      opts.reason?.trim(),
      waitMs !== null ? `Refused if not answered by ${new Date(Date.now() + waitMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}; the agent then goes on without it.` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    const options: ApprovalOption[] = [
      { id: "once", label: "Allow once", kind: "allow_once" },
      ...(domains.length ? [{ id: "domain", label: domains.length === 1 ? `Allow ${domains[0]} for this thread` : "Allow these domains for this thread", kind: "allow_always" as const }] : []),
      { id: "session", label: "Allow all websites for this thread", kind: "allow_always" },
      { id: "deny", label: "Deny", kind: "reject_once" },
    ];
    this.closeBlocks(run);
    const item = this.addItem(threadId, run.turn.id, { kind: "approval", requestId: "", tool: "fetch", title: title.slice(0, 300), detail, options, status: "pending" });
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    opts.signal?.addEventListener("abort", onAbort);
    let timedOut = false;
    const timer =
      waitMs === null
        ? null
        : setTimeout(() => {
            timedOut = true;
            abort.abort();
          }, waitMs);
    try {
      const decision = await this.waitPending<ApprovalDecision>(threadId, run, "approval", item.id, abort.signal);
      if (decision.optionId === "deny") return { allowed: false, message: decision.note ? `The user denied this web request: ${decision.note}` : "The user denied this web request. Carry on without it." };
      if (decision.optionId === "domain" || decision.optionId === "session") {
        const t = this.threads.get(threadId);
        if (t) {
          t.webGrants = grantWeb(t.webGrants, decision.optionId, call);
          this.db.saveThread(t);
          this.emitThread(threadId);
        }
      }
      return { allowed: true };
    } catch {
      return {
        allowed: false,
        message: timedOut ? "Nobody answered the web request in time. Carry on without web access and do what you can; mention what you could not check." : "The web request was cancelled.",
      };
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * web_request from the thread's MCP: ask ahead of the call, with the agent's importance and reason.
   * "Allow once" leaves a pass the next matching web call uses up.
   */
  async preRequestWeb(threadId: string, call: WebCall, opts: { importance?: WebImportance; reason?: string; signal?: AbortSignal }): Promise<{ allowed: boolean; message: string }> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("web_request only works in Scribe chat threads.");
    if (modeOff(thread, "web")) return { allowed: false, message: `This thread's mode (${thread.custom?.name}) has no web access. Carry on without it.` };
    if (webCallAllowed(call, thread.web, this.prefs().webAllowlist, thread.webGrants)) return { allowed: true, message: "Already allowed: make the call." };
    const result = await this.requestWeb(threadId, call, opts);
    if (!result.allowed) return { allowed: false, message: result.message ?? "Not allowed." };
    const t = this.threads.get(threadId);
    if (t && !webCallAllowed(call, t.web, this.prefs().webAllowlist, t.webGrants)) {
      const passes = (this.webPasses.get(threadId) ?? []).filter((p) => Date.now() - p.at < WEB_PASS_MS);
      passes.push({ call, at: Date.now() });
      this.webPasses.set(threadId, passes);
      return { allowed: true, message: `Allowed once: make the ${call.kind === "fetch" ? "fetch" : "search"} now.` };
    }
    return { allowed: true, message: "Allowed: make the call." };
  }

  /** The store's folder and page lookups, for thread access scopes. */
  private scopeLookup(): ScopeLookup {
    return {
      pageFolder: (id) => store.get(id, "agent")?.folderId ?? null,
      folderInside: (folderId, rootId) => store.folderInside(folderId, rootId),
      pageTitle: (id) => store.get(id, "agent")?.title ?? null,
      folderPath: (id) => store.folderPath(id),
      threadTitle: (id) => this.threads.get(id)?.title ?? null,
    };
  }

  // ---------- page access (#269) ----------

  /** Whether a model comes from a source the user trusts with Trusted only pages. Only native sources can be trusted. */
  modelTrusted(provider: ProviderId, model: string): boolean {
    if (provider !== "pi") return false;
    const source = splitModelId(model)?.source;
    const id = source?.startsWith("src-") ? source.slice(4) : null;
    return Boolean(id && this.modelSources().find((s) => s.id === id)?.trusted);
  }

  /** A thread is trusted when its model is, and a helper no more than the thread that started it. */
  threadTrusted(thread: Thread): boolean {
    const seen = new Set<string>();
    for (let t: Thread | undefined = thread; t && !seen.has(t.id); t = t.helperOf ? this.threads.get(t.helperOf) : undefined) {
      seen.add(t.id);
      if (!this.modelTrusted(t.provider, t.model)) return false;
    }
    return true;
  }

  /** What a thread's agent may reach among pages; null for an unknown thread. A helper shares its parent's grants. */
  pageReader(threadId: string): PageReader | null {
    const thread = this.threads.get(threadId);
    if (!thread) return null;
    const parent = thread.helperOf ? this.threads.get(thread.helperOf) : undefined;
    let links: string[] | undefined;
    return {
      thread: thread.id,
      scope: thread.scope,
      ...(thread.formerScopes?.length ? { formerScopes: thread.formerScopes } : {}),
      trusted: this.threadTrusted(thread),
      grants: addTargets<ThreadPageGrant>(thread.pageGrants, parent?.pageGrants ?? []),
      readLinks: () => (links ??= store.heldLinkPages(parent ? [thread.id, parent.id] : [thread.id])),
    };
  }

  /**
   * A thread's agent reached a page. Trusted only or Restricted content it reached without the user's
   * @mention taints the thread and the threads it reports to: their transcripts now hold that content.
   */
  notePageReached(threadId: string, tab: Tab): void {
    const lookup = store.accessLookup();
    const level = effectiveLevel(tab, lookup);
    if (level !== "trusted" && level !== "restricted") return;
    const seen = new Set<string>();
    for (let t = this.threads.get(threadId); t && !seen.has(t.id); t = t.helperOf ? this.threads.get(t.helperOf) : undefined) {
      seen.add(t.id);
      if (t.id === threadId && (t.pageGrants ?? []).some((g) => g.mention && (g.kind === "page" ? g.id === tab.id : lookup.folderChain(tab.folderId).includes(g.id)))) return;
      if (t.tainted) continue;
      t.tainted = true;
      this.db.saveThread(t);
      this.emitThread(t.id);
    }
  }

  private reachOf(threadId: string, tab: Tab): Reach {
    const reader = this.pageReader(threadId);
    return reader ? pageReach(reader, this.accessPage(tab), store.accessLookup()) : "hidden";
  }

  /**
   * A page as page access judges it. Pages made before origins were recorded take the home of the
   * thread that created them: its first home if it followed pages since, so a board worker's old
   * reports stay reachable from its board.
   */
  accessPage(tab: Tab): AccessPage {
    const createdBy = tab.provenance?.created?.thread;
    if (tab.access?.origin || !createdBy) return { ...tab, createdBy };
    const creator = this.threads.get(createdBy);
    const home = creator?.formerScopes?.[0] ?? creator?.scope;
    const origin: AccessTarget | undefined = home?.ref && (home.kind === "page" || home.kind === "folder") && home.ref !== tab.id ? { kind: home.kind, id: home.ref } : undefined;
    return { ...tab, createdBy, ...(origin ? { access: { ...(tab.access ?? {}), origin } } : {}) };
  }

  /** A page or folder as the user reads it on the access card. */
  private targetName(target: AccessTarget): string {
    if (target.kind === "folder") return `folder “${store.folderPath(target.id) ?? target.id}”`;
    return `“${store.get(target.id)?.title || target.id}”`;
  }

  /** Plugin consent is cancellable, bounded for unattended work, and never grants a page access. */
  async requestPluginApproval(threadId: string, title: string, detail: string, allowThread: boolean, plugin?: string, opts:{signal?:AbortSignal;importance?:WebImportance;sourceUrl?:string}={}): Promise<{allowed:boolean}> {
    const thread = this.threads.get(threadId), run = this.runs.get(threadId);
    if (!thread || !run) return {allowed:false};
    const grants = thread.pluginGrants??[];
    if (allowThread && plugin && grants.includes(plugin)) return {allowed:true};
    this.closeBlocks(run);
    const options: ApprovalOption[] = [
      {id:"allow",label:"Allow once",kind:"allow_once"},
      ...(allowThread ? [{id:"thread",label:"Allow for this thread",kind:"allow_always" as const}] : []),
      {id:"deny",label:"Deny",kind:"reject_once"},
    ];
    const waitMs=this.unattended(threadId)?WEB_IMPORTANCE_WAIT_MS[opts.importance??"useful"]:null;
    const deadline=waitMs===null?"":`\nRefused if not answered by ${new Date(Date.now()+waitMs).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}.`;
    const item = this.addItem(threadId,run.turn.id,{kind:"approval",requestId:"",tool:"other",title,detail:detail+deadline,options,status:"pending",...(opts.sourceUrl?{sourceUrl:opts.sourceUrl}:{})});
    const abort=new AbortController(),onAbort=()=>abort.abort();opts.signal?.addEventListener("abort",onAbort);if(opts.signal?.aborted)abort.abort();
    const timer=waitMs===null?null:setTimeout(()=>abort.abort(),waitMs);
    try {
      const decision=await this.waitPending<ApprovalDecision>(threadId,run,"approval",item.id,abort.signal);
      if(decision.optionId==="thread" && allowThread && plugin){thread.pluginGrants=[...new Set([...grants,plugin])];this.db.saveThread(thread);this.emitThread(threadId);}
      return {allowed:decision.optionId==="allow" || (allowThread && decision.optionId==="thread")};
    } catch {return {allowed:false};}finally{if(timer)clearTimeout(timer);opts.signal?.removeEventListener("abort",onAbort);}
  }

  /**
   * Ask to reach an out-of-scope page or folder. Thread-only grants last for this chat; Always
   * grants its home page/folder access. Ask-always or untrusted requests offer thread-only access.
   * Restricted pages require the user's mention. Full access does not bypass these choices.
   */
  async requestPageAccess(
    threadId: string,
    opts: { page: string; folder?: boolean; importance?: WebImportance; reason?: string; signal?: AbortSignal }
  ): Promise<{ allowed: boolean; message: string }> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("page_access only works in Scribe chat threads.");
    const tab = store.get(opts.page);
    const reach = tab ? this.reachOf(threadId, tab) : "hidden";
    if (!tab || reach === "hidden") return { allowed: false, message: `tab not found: ${opts.page}` };
    const lookup = store.accessLookup();
    const level = effectiveLevel(tab, lookup);
    const target: AccessTarget = opts.folder && tab.folderId ? { kind: "folder", id: tab.folderId } : { kind: "page", id: tab.id };
    if (reach === "allow" && target.kind === "page") return { allowed: true, message: "Already allowed." };
    const run = this.runs.get(threadId);
    if (!run) return { allowed: false, message: "With no turn running the user cannot be asked." };
    const importance = opts.importance ?? "useful";
    const waitMs = this.unattended(threadId) ? WEB_IMPORTANCE_WAIT_MS[importance] : null;
    const home: AccessTarget | null = thread.scope.ref && (thread.scope.kind === "page" || thread.scope.kind === "folder") ? { kind: thread.scope.kind, id: thread.scope.ref } : null;
    const homeName = home ? (home.kind === "page" ? store.get(home.id)?.title || "this page" : store.folderPath(home.id) ?? "this folder") : null;
    const untrusted = reach === "request";
    const always = Boolean(home && homeName && level !== "ask" && !untrusted && !sameTarget(home, target));
    const options: ApprovalOption[] = [
      { id: "thread", label: "Allow for this thread", kind: "allow_once" },
      ...(always ? [{ id: "always", label: `Always allow for ${homeName}`, description: `Every chat on ${homeName} can reach it without asking.`, kind: "allow_always" as const }] : []),
      { id: "deny", label: "Deny", kind: "reject_once" },
    ];
    const what = this.targetName(target);
    const detail = [
      `The agent asks to read and change ${what}, outside this chat's Scribe access. Importance: ${importance}.`,
      level === "ask" ? "That page asks every chat, so it can only be allowed for this thread." : undefined,
      untrusted ? "It is Trusted only and this chat's model is not trusted, so it can only be allowed for this thread." : undefined,
      opts.reason?.trim(),
      waitMs !== null ? `Refused if not answered by ${new Date(Date.now() + waitMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}; the agent then goes on without it.` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    this.closeBlocks(run);
    const item = this.addItem(threadId, run.turn.id, { kind: "approval", requestId: "", tool: "read", title: `Page access: ${what}`.slice(0, 300), detail, options, status: "pending" });
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    opts.signal?.addEventListener("abort", onAbort);
    let timedOut = false;
    const timer = waitMs === null ? null : setTimeout(() => { timedOut = true; abort.abort(); }, waitMs);
    try {
      const decision = await this.waitPending<ApprovalDecision>(threadId, run, "approval", item.id, abort.signal);
      if (decision.optionId === "deny") return { allowed: false, message: decision.note ? `The user denied access to ${what}: ${decision.note}` : `The user denied access to ${what}. Carry on without it.` };
      if (decision.optionId === "always" && home) store.changeAccessGrants(home, { add: [target] });
      else this.grantPages(threadId, [target]);
      return { allowed: true, message: `Allowed: ${what}. Make the call again.` };
    } catch {
      return { allowed: false, message: timedOut ? "Nobody answered in time. Carry on without that page." : "The request was cancelled." };
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  // ---------- other devices (#911) ----------

  /**
   * The chat as another device sees its calls: whether its model is trusted, its rung, and what the
   * user let it reach there. A helper uses its parent's grants, as it does here. A chat with no page
   * tools (a workspace helper) reaches no pages there either.
   */
  remoteAgentFor(threadId: string, device: string, writtenFor: (token: string) => boolean): RemoteAgent | string {
    const thread = this.threads.get(threadId);
    if (!thread || thread.noTools) return "Only Scribe chats on this device can reach other devices.";
    const parent = thread.helperOf ? this.threads.get(thread.helperOf) : undefined;
    const keys = [...(thread.deviceKeys ?? []), ...(parent?.deviceKeys ?? [])].filter((k) => writtenFor(k.device)).map((k) => k.key);
    return {
      thread: thread.id,
      title: thread.title,
      trusted: this.threadTrusted(thread),
      ...(thread.tainted ? { tainted: true } : {}),
      ...(thread.scope.kind === "workspace" ? { noPages: true } : {}),
      rung: thread.approval,
      grants: addTargets<ThreadPageGrant>(thread.deviceGrants?.[device], parent?.deviceGrants?.[device] ?? []),
      keys: [...new Set(keys)],
    };
  }

  /** The chat read Trusted only or Restricted content on another device: it and the chats it reports to are tainted. */
  taintThread(threadId: string): void {
    const seen = new Set<string>();
    for (let t = this.threads.get(threadId); t && !seen.has(t.id); t = t.helperOf ? this.threads.get(t.helperOf) : undefined) {
      seen.add(t.id);
      if (t.tainted) continue;
      t.tainted = true;
      this.db.saveThread(t);
      this.emitThread(t.id);
    }
  }

  /**
   * Ask in the chat (its running turn) and wait for the answer; a board worker's chat waits only as
   * long as importance says. "timeout" when nobody answered in time, "cancelled" when the call went away.
   */
  private async askInChat(threadId: string, ask: { title: string; detail: string; tool: "read" | "task" | "other"; options: ApprovalOption[] }, importance: WebImportance, signal?: AbortSignal): Promise<ApprovalDecision | "timeout" | "cancelled" | "idle"> {
    const run = this.runs.get(threadId);
    if (!run) return "idle";
    const waitMs = this.unattended(threadId) ? WEB_IMPORTANCE_WAIT_MS[importance] : null;
    const deadline = waitMs === null ? "" : `\nRefused if not answered by ${new Date(Date.now() + waitMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}; the agent then goes on without it.`;
    this.closeBlocks(run);
    const item = this.addItem(threadId, run.turn.id, { kind: "approval", requestId: "", tool: ask.tool, title: ask.title.slice(0, 300), detail: ask.detail + deadline, options: ask.options, status: "pending" });
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort);
    let timedOut = false;
    const timer = waitMs === null ? null : setTimeout(() => { timedOut = true; abort.abort(); }, waitMs);
    try {
      return await this.waitPending<ApprovalDecision>(threadId, run, "approval", item.id, abort.signal);
    } catch {
      return timedOut ? "timeout" : "cancelled";
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * page_access for a page on another device: asked in this chat, like one here. The grant is the
   * chat's own (for this thread); that device applies its page levels to it on every call.
   */
  async requestDevicePageAccess(
    threadId: string,
    device: { id: string; name: string },
    page: { id: string; key: string; title: string; folderId?: string; folder?: string | null; reach: string },
    opts: { folder?: boolean; importance?: string; reason?: string; signal?: AbortSignal }
  ): Promise<{ allowed: boolean; message: string }> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("page_access only works in Scribe chat threads.");
    const folder = opts.folder && page.folderId;
    if (page.reach === "allow" && !folder) return { allowed: true, message: "Already allowed." };
    const target: ThreadPageGrant = folder ? { kind: "folder", id: page.folderId! } : { kind: "page", id: page.id };
    const what = folder ? `folder “${page.folder ?? page.folderId}” on ${device.name}` : `“${page.title}” on ${device.name}`;
    const importance = parseWebImportance(opts.importance) ?? "useful";
    const answer = await this.askInChat(threadId, {
      tool: "read",
      title: `Page access: ${what}`,
      detail: [
        `The agent asks to read and change ${what}. ${device.name}'s own settings still decide whether agents from here may change its pages, and its page levels apply.`,
        page.reach === "request" ? "It is Trusted only and this chat's model is not trusted." : undefined,
        `Importance: ${importance}.`,
        opts.reason?.trim(),
      ].filter(Boolean).join("\n"),
      options: [
        { id: "thread", label: "Allow for this thread", kind: "allow_once" },
        { id: "deny", label: "Deny", kind: "reject_once" },
      ],
    }, importance, opts.signal);
    if (answer === "idle") return { allowed: false, message: "With no turn running the user cannot be asked." };
    if (answer === "timeout") return { allowed: false, message: "Nobody answered in time. Carry on without that page." };
    if (answer === "cancelled") return { allowed: false, message: "The request was cancelled." };
    if (answer.optionId !== "thread") return { allowed: false, message: answer.note ? `The user denied access to ${what}: ${answer.note}` : `The user denied access to ${what}. Carry on without it.` };
    const t = this.threads.get(threadId);
    if (t) {
      t.deviceGrants = { ...(t.deviceGrants ?? {}), [device.id]: addTargets<ThreadPageGrant>(t.deviceGrants?.[device.id], [target]).slice(-200) };
      this.db.saveThread(t);
      this.emitThread(threadId);
    }
    return { allowed: true, message: `Allowed: ${what}. Make the call again.` };
  }

  /**
   * agent_run on another device: the rung its helper gets (this chat's or lower, never above Auto
   * review), asked in this chat once per device and folder. A later helper there at that rung or
   * lower goes ahead. Throws when the user says no.
   */
  async deviceHelperAccess(threadId: string, device: { id: string; name: string }, folder: string, requested: string | undefined, signal?: AbortSignal): Promise<ApprovalPolicy> {
    const thread = this.helperParent(threadId);
    const wanted = requested === undefined ? thread.approval : parseApproval(requested);
    if (!wanted) throw new Error(`Unknown helper access "${requested}". Choose: ${APPROVALS.slice(0, approvalRank(thread.approval) + 1).join(", ")}.`);
    if (approvalRank(wanted) > approvalRank(thread.approval)) throw new Error(`A helper may not exceed this thread's ${thread.approval} rung.`);
    const rung = minApproval(wanted, "auto");
    const same = (a: string) => a.replace(/[\\/]+$/, "").toLowerCase() === folder.replace(/[\\/]+$/, "").toLowerCase();
    const held = (thread.deviceHelpers ?? []).find((h) => h.device === device.id && same(h.folder));
    if (held && approvalRank(held.rung) >= approvalRank(rung)) return rung;
    const edits = approvalRank(rung) >= approvalRank("edits");
    const answer = await this.askInChat(threadId, {
      tool: "task",
      title: `Run helpers on ${device.name} in ${folder}`,
      detail: [
        `Helpers this chat starts there work in that folder with ${APPROVAL_LABEL[rung]} access${edits ? ", so they can change its files" : ""}, on ${device.name}'s own accounts. Their approvals show on ${device.name} and as toasts on the device you are using.`,
        "Asked once for this thread: later helpers there at this access or lower start without asking.",
      ].join("\n"),
      options: [
        { id: "thread", label: "Allow for this thread", kind: "allow_always" },
        { id: "deny", label: "Deny", kind: "reject_once" },
      ],
    }, "necessary", signal);
    if (answer === "idle") throw new Error("With no turn running the user cannot be asked.");
    if (answer === "timeout" || answer === "cancelled") throw new Error("cancelled");
    if (answer.optionId !== "thread") throw new Error(answer.note ? `The user declined: ${answer.note}` : `The user declined helpers on ${device.name} in ${folder}. Do the task another way.`);
    const t = this.threads.get(threadId);
    if (t) {
      t.deviceHelpers = [...(t.deviceHelpers ?? []).filter((h) => !(h.device === device.id && same(h.folder))), { device: device.id, folder, rung }].slice(-50);
      this.db.saveThread(t);
    }
    return rung;
  }

  /**
   * agent_run from a chat on another device (#911): a helper here, in a folder this device already
   * has chats in, never in a worktree, at the rung that device's user allowed (at most Auto review).
   * It is a thread of this device's (its approvals show here and as toasts there); the chat on the
   * other device follows it up and waits for its report through the same call.
   */
  async runRemoteHelper(
    from: { device: string; name: string; agent: RemoteAgent },
    opts: { title?: string; task: string; provider?: string; model?: string; effort?: string; access?: string; cwd?: string; thread?: string; background?: boolean; stop?: boolean; signal?: AbortSignal }
  ): Promise<Record<string, unknown>> {
    if (!this.prefs().helpers) throw new Error("Helper agents are turned off on that device (Agent settings, Helper agents).");
    const task = opts.task.trim();
    if (opts.signal?.aborted) throw new Error("cancelled");
    if (opts.stop && (!opts.thread || task)) throw new Error("Stopping a helper requires thread and no task.");
    if (!task && !opts.thread) throw new Error("task is required: a brief the helper can work from on its own.");
    const mine = (t: Thread) => t.remoteParent?.device === from.device && t.remoteParent.thread === from.agent.thread;
    let helper: Thread;
    if (opts.thread) {
      const existing = this.threads.get(opts.thread);
      if (!existing || !mine(existing)) throw new Error(`No helper ${opts.thread} of this chat on that device. Leave thread out to start a new one.`);
      if (opts.stop) await this.cancel(existing.id);
      if (!task && !this.loadTurns(existing.id).length) throw new Error("That helper has not run yet. Pass a task.");
      if (existing.archived) throw new Error("That helper thread is archived. Leave thread out to start a new one.");
      if (task && from.agent.tainted && !this.modelTrusted(existing.provider, existing.model)) throw new Error("This chat read Trusted only content, so it can't brief that helper's untrusted model.");
      helper = existing;
    } else {
      const title = opts.title?.replace(/\s+/g, " ").trim();
      if (!title) throw new Error("title is required for a new helper: a short name describing its task.");
      const dir = opts.cwd ? [...this.workspaceFolders().values()].find((d) => workspaceKey(d) === workspaceKey(opts.cwd!)) : undefined;
      if (!dir) throw new Error(`${opts.cwd ?? "That folder"} is not a folder this device has chats in. Pick one of its workspace folders.`);
      const rung = minApproval(minApproval(parseApproval(opts.access) ?? "readonly", parseApproval(from.agent.rung) ?? "readonly"), "auto");
      if (!opts.provider || !isProviderId(opts.provider)) throw new Error(`provider is required: one of ${Object.keys(this.providers).join(", ")}. agent_models with device lists that device's models.`);
      const provider = opts.provider;
      const status = (await this.providerStatus()).find((s) => s.id === provider);
      if (!status?.available) throw new Error(`${status?.label ?? provider} is not available there${status?.detail ? `: ${status.detail}` : "."}`);
      const model = await this.helperModel(provider, opts.model);
      if (opts.effort && model && !model.efforts.some((e) => e.id === opts.effort)) {
        throw new Error(model.efforts.length ? `${model.id} has no effort "${opts.effort}". Its efforts: ${model.efforts.map((e) => e.id).join(", ")}.` : `${model.id} has no effort setting; leave effort out.`);
      }
      if (from.agent.tainted && !this.modelTrusted(provider, model?.id ?? this.prefs().models[provider] ?? "default")) throw new Error("This chat read Trusted only content, so its helpers there need a trusted model.");
      const busy = [...this.threads.values()].filter((t) => mine(t) && (this.runs.has(t.id) || this.queues.get(t.id)?.length)).length;
      if (busy >= MAX_HELPERS) throw new Error(`This chat already has ${busy} helpers working there. Wait for one to finish.`);
      const draft = this.draftThread({
        title: `Helper (${from.name}): ${title.slice(0, 200)}`,
        provider,
        ...(model ? { model: model.id } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...settleAccess("code", rung),
        web: "off",
        scope: { kind: "workspace", ref: dir },
        cwd: dir,
        useWorktree: false,
      });
      draft.remoteParent = { device: from.device, name: from.name, thread: from.agent.thread };
      this.threads.set(draft.id, draft);
      this.items.set(draft.id, []);
      this.turns.set(draft.id, []);
      this.seq.set(draft.id, 0);
      this.db.saveThread(draft);
      this.emit({ type: "agent_thread", thread: this.view(draft) });
      helper = draft;
    }
    if (opts.signal?.aborted) throw new Error("cancelled");
    return this.helperTurn(helper, task, opts);
  }

  /** Grant pages or folders to a thread for the rest of the thread. */
  private grantPages(threadId: string, targets: ThreadPageGrant[]): void {
    const t = this.threads.get(threadId);
    if (!t || !targets.length) return;
    const next = addTargets<ThreadPageGrant>(t.pageGrants, targets);
    if (JSON.stringify(next) === JSON.stringify(t.pageGrants ?? [])) return;
    t.pageGrants = next;
    this.db.saveThread(t);
    this.sessions.get(threadId)?.update(this.sessionThread(t));
    this.emitThread(threadId);
  }

  /**
   * Ask the user to let a thread read other threads in its scopes (its workspace, its page or folder;
   * any thread for a global thread). Grants last for the rest of the thread; only narrows the ask to
   * some of those scopes. Like web requests, a board worker's chat stops waiting after the importance's wait.
   */
  async requestThreadAccess(
    threadId: string,
    opts: { only?: Array<AccessScope["kind"]>; thread?: string; importance?: WebImportance; reason?: string; signal?: AbortSignal } = {}
  ): Promise<{ allowed: boolean; message: string; scopes: string[] }> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Reading other threads only works in Scribe chat threads.");
    const lookup = this.scopeLookup();
    const labels = (scopes: AccessScope[]) => scopes.map((s) => scopeLabel(s, lookup));
    const granted = () => {
      const t = this.threads.get(threadId) ?? thread;
      return allowedGrants(t, t.threadGrants ?? []);
    };
    let want = requestableScopes(thread);
    const global = want.some((s) => s.kind === "all");
    if (opts.thread) {
      // One thread, e.g. a search hit outside this thread's scopes: the user decides on it alone.
      const target = this.threads.get(opts.thread);
      if (!target || target.id === threadId) return { allowed: false, message: `No other thread ${opts.thread}.`, scopes: labels(granted()) };
      if (canReadThread({ ...thread, threadGrants: granted() }, target, lookup)) return { allowed: true, message: "Already allowed.", scopes: labels(granted()) };
      want = [{ kind: "thread", id: target.id }];
    } else if (opts.only?.length) {
      // A global thread already searches and reads everything once it has "all".
      const only = global && opts.only.includes("search") ? [...opts.only, "all" as const] : opts.only;
      want = want.filter((s) => only.includes(s.kind));
      if (!global && only.includes("search")) want.push({ kind: "search" });
    }
    if (!want.length) return { allowed: false, message: "This thread has no such scope to ask for: it can ask for its workspace, its page or folder, search (titles of matching threads anywhere), one thread by id, or (a global thread) all threads.", scopes: labels(granted()) };
    if (scopesGranted(granted(), want)) return { allowed: true, message: "Already allowed.", scopes: labels(granted()) };
    const run = this.runs.get(threadId);
    if (!run) return { allowed: false, message: "With no turn running the user cannot be asked.", scopes: labels(granted()) };
    const importance = opts.importance ?? "useful";
    const waitMs = this.unattended(threadId) ? WEB_IMPORTANCE_WAIT_MS[importance] : null;
    const reading = want.filter((s) => s.kind !== "search");
    const detail = [
      reading.length ? `The agent asks to read the transcripts of other threads: ${labels(reading).join("; ")}.` : "",
      want.some((s) => s.kind === "search")
        ? "The agent asks to search all threads. For threads outside the scopes it may read, it sees only the title, folder and date of a match, not the transcript."
        : "",
      `Importance: ${importance}.`,
      opts.reason?.trim(),
      waitMs !== null ? `Refused if not answered by ${new Date(Date.now() + waitMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}; the agent then goes on without it.` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    const short: Record<AccessScope["kind"], string> = { workspace: "workspace", page: "page", folder: "folder", thread: "thread", search: "search (titles only)", all: "all threads" };
    const options: ApprovalOption[] = [
      { id: "all", label: want.length === 1 ? "Allow for this thread" : "Allow all of these", kind: "allow_always" },
      ...(want.length > 1 ? want.map((s, i) => ({ id: `s${i}`, label: `Only ${short[s.kind]}`, kind: "allow_always" as const })) : []),
      { id: "deny", label: "Deny", kind: "reject_once" },
    ];
    this.closeBlocks(run);
    const title = want.length === 1 && want[0].kind === "search" ? "Search all threads (titles only outside this thread's scopes)" : `Read other threads: ${labels(want).join("; ")}`;
    const item = this.addItem(threadId, run.turn.id, { kind: "approval", requestId: "", tool: "read", title: title.slice(0, 300), detail, options, status: "pending" });
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    opts.signal?.addEventListener("abort", onAbort);
    let timedOut = false;
    const timer =
      waitMs === null
        ? null
        : setTimeout(() => {
            timedOut = true;
            abort.abort();
          }, waitMs);
    try {
      const decision = await this.waitPending<ApprovalDecision>(threadId, run, "approval", item.id, abort.signal);
      if (decision.optionId === "deny") {
        return { allowed: false, message: decision.note ? `The user denied reading other threads: ${decision.note}` : "The user denied reading other threads. Carry on without them.", scopes: labels(granted()) };
      }
      const picked = decision.optionId === "all" ? want : want.filter((_, i) => decision.optionId === `s${i}`);
      const t = this.threads.get(threadId);
      if (t) {
        t.threadGrants = grantScopes(t.threadGrants, picked);
        this.db.saveThread(t);
        this.emitThread(threadId);
      }
      return { allowed: true, message: `Allowed: ${labels(picked).join("; ")}.`, scopes: labels(granted()) };
    } catch {
      return {
        allowed: false,
        message: timedOut ? "Nobody answered in time. Carry on without reading other threads." : "The request was cancelled.",
        scopes: labels(granted()),
      };
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * thread_update from the thread's MCP (#577): the agent renames its thread, or asks to move its
   * workspace to the folder the work moved to. Each field answers with a line of its own, so a
   * refused workspace does not hide a changed title.
   */
  async threadUpdateOp(
    threadId: string,
    opts: { title?: string; workspace?: string; reason?: string; continue?: boolean; signal?: AbortSignal }
  ): Promise<{ title?: string; workspace?: string }> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("thread_update only works in Scribe chat threads.");
    if (!opts.title && !opts.workspace) throw new Error("Pass title, workspace or both.");
    const out: { title?: string; workspace?: string } = {};
    if (opts.title) {
      const title = opts.title.replace(/\s+/g, " ").trim().slice(0, 120);
      if (thread.titleLocked) out.title = `Not changed: the user named this thread “${thread.title}”.`;
      else if (!title) out.title = "Not changed: the title is empty.";
      else {
        if (title !== thread.title) {
          thread.title = title;
          this.db.saveThread(thread);
          this.emitThread(threadId);
        }
        out.title = `The thread is now titled “${title}”.`;
      }
    }
    if (opts.workspace) out.workspace = await this.requestWorkspace(threadId, opts.workspace, opts);
    return out;
  }

  /**
   * The workspace half of thread_update. A new workspace widens what the approval level lets through,
   * so the user allows it (Full access aside). It waits for the turn's end: the provider's process,
   * and the relative paths of the calls it still makes, belong to the old folder until then.
   */
  private async requestWorkspace(threadId: string, folder: string, opts: { reason?: string; continue?: boolean; signal?: AbortSignal }): Promise<string> {
    const thread = this.requireThread(threadId);
    if (thread.helperOf) return "Not changed: a helper thread works in the workspace of the agent that started it.";
    const wt = openWorktree(thread);
    if (wt) return `Not changed: this thread works in a git worktree of its own (${wt.path}), which stays its workspace until the user merges or leaves it.`;
    if (!path.isAbsolute(folder)) return "Not changed: workspace must be an absolute folder path.";
    const cwd = path.resolve(folder);
    try {
      if (!fs.statSync(cwd).isDirectory()) return `Not changed: ${cwd} is not a folder.`;
    } catch {
      return `Not changed: folder not found: ${cwd}`;
    }
    if (thread.cwd && workspaceKey(thread.cwd) === workspaceKey(cwd)) return "That folder already is this thread's workspace.";
    const run = this.runs.get(threadId);
    if (!run) return "Not changed: with no turn running the user cannot be asked.";
    const goOn = opts.continue !== false;
    if (thread.approval !== "full") {
      const waitMs = this.unattended(threadId) ? WEB_IMPORTANCE_WAIT_MS.useful : null;
      const detail = [
        `The agent asks to move this thread's workspace${thread.cwd ? ` from ${thread.cwd}` : ""} to ${cwd}, from its next turn on. ${thread.mode === "board" ? `It can then read and search files there (${APPROVAL_LABEL[thread.approval]} rung: no edits; commands it runs there are read-only).` : "Commands then run there, and this thread's approval level covers that folder instead."}`,
        opts.reason?.trim(),
        waitMs !== null ? `Refused if not answered by ${new Date(Date.now() + waitMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}; the agent then goes on without it.` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
      const options: ApprovalOption[] = [
        { id: "allow", label: "Change workspace", kind: "allow_once" },
        { id: "deny", label: "Deny", kind: "reject_once" },
      ];
      this.closeBlocks(run);
      const item = this.addItem(threadId, run.turn.id, { kind: "approval", requestId: "", tool: "other", title: `Change workspace to ${cwd}`.slice(0, 300), detail, options, status: "pending" });
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      opts.signal?.addEventListener("abort", onAbort);
      let timedOut = false;
      const timer =
        waitMs === null
          ? null
          : setTimeout(() => {
              timedOut = true;
              abort.abort();
            }, waitMs);
      try {
        const decision = await this.waitPending<ApprovalDecision>(threadId, run, "approval", item.id, abort.signal);
        if (decision.optionId !== "allow") {
          return decision.note ? `Not changed: the user denied the workspace change: ${decision.note}` : "Not changed: the user denied the workspace change. Carry on in the current workspace.";
        }
      } catch {
        return timedOut ? "Not changed: nobody answered in time. Carry on in the current workspace." : "Not changed: the request was cancelled.";
      } finally {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      }
    }
    if (this.runs.get(threadId) !== run) return "Not changed: the turn that asked has ended.";
    run.workspace = { cwd, continue: goOn };
    return `Allowed. The workspace changes to ${cwd} when this turn ends; until then commands and relative paths still use ${thread.cwd ?? "the current folder"}. End your turn now${goOn ? ": Scribe then starts your next turn in the new folder" : ""}.`;
  }

  /** Move the thread to the workspace its ended turn asked for. A workspace-scoped thread's scope follows, as when the user picks a folder. */
  private applyWorkspace(threadId: string, turnId: string, cwd: string): boolean {
    try {
      const thread = this.requireThread(threadId);
      this.updateThread(threadId, { cwd, ...(thread.scope.kind === "workspace" ? { scope: { kind: "workspace" as const, ref: cwd } } : {}) });
      this.addItem(threadId, turnId, { kind: "notice", level: "info", text: `Workspace changed to ${cwd}.` });
      return true;
    } catch (err) {
      this.addItem(threadId, turnId, { kind: "notice", level: "error", text: `Could not change the workspace to ${cwd}: ${(err as Error).message}` });
      return false;
    }
  }

  /** A thread's items without caching them, so a search over many threads does not keep them all in memory. */
  private peekItems(threadId: string): Item[] {
    return this.items.get(threadId) ?? this.db.listItems(threadId);
  }

  /** A thread's turns, from the cache when loaded, else straight from the database. */
  private peekTurns(threadId: string): Turn[] {
    return this.turns.get(threadId) ?? this.db.listTurns(threadId);
  }

  /** The thread menu's search: the threads whose messages mention words of q, with which words and a snippet. */
  searchThreadMessages(q: unknown): ThreadMessageHit[] {
    const words = searchWords(q);
    // Items are saved in batches; without this, a refresh right after a message would miss its text.
    if (words.length) this.flushNow();
    return matchMessages(this.db.searchMessages(words), words);
  }

  /** Threads reader may read, asking for access first when it has none yet. */
  private async readableThreads(
    readerId: string,
    opts: { search?: boolean; importance?: WebImportance; signal?: AbortSignal }
  ): Promise<{ reader: Thread; threads: Thread[]; lookup: ScopeLookup }> {
    let reader = this.threads.get(readerId);
    if (!reader) throw new Error("Reading other threads only works in Scribe chat threads.");
    if (!allowedGrants(reader, reader.threadGrants ?? []).some((s) => s.kind !== "search")) {
      // A search everywhere asks for this thread's scopes and the search in one question.
      const only = opts.search ? [...requestableScopes(reader).map((s) => s.kind), "search" as const] : undefined;
      const asked = await this.requestThreadAccess(readerId, { only, importance: opts.importance, signal: opts.signal });
      if (!asked.allowed) throw new Error(asked.message);
      reader = this.threads.get(readerId) ?? reader;
    }
    const lookup = this.scopeLookup();
    // A tainted transcript holds trusted content (#269): an untrusted reader only gets it from the user's #tag.
    const trusted = this.threadTrusted(reader);
    const tagged = (t: Thread) => (reader.threadGrants ?? []).some((s) => s.kind === "thread" && s.id === t.id);
    const threads = [...this.threads.values()].filter((t) => canReadThread(reader, t, lookup) && (!t.tainted || trusted || tagged(t)));
    return { reader, threads, lookup };
  }

  private threadStatus(t: Thread, turns: Turn[]): string {
    return this.runs.has(t.id) ? "running" : turns.at(-1)?.status ?? "new";
  }

  /**
   * thread_list: threads this one may read, newest first. q searches titles and transcripts: threads
   * whose title or messages match come before those that match only in tool calls and output.
   * everywhere also searches threads outside the reader's scopes (with the user's search grant), but
   * shows only their titles, folders and dates. Rows are short unless details asks for more.
   */
  async listReadableThreads(
    readerId: string,
    opts: {
      q?: string;
      limit?: number;
      archived?: boolean;
      everywhere?: boolean;
      messages?: boolean;
      details?: boolean;
      importance?: WebImportance;
      signal?: AbortSignal;
    } = {}
  ): Promise<{ scopes: string[]; threads: Array<Record<string, unknown>>; more: number; note?: string }> {
    const words = queryWords(opts.q);
    const everywhere = Boolean(opts.everywhere && words.length);
    let { reader, threads, lookup } = await this.readableThreads(readerId, { ...opts, search: everywhere });
    const notes: string[] = [];
    if (opts.everywhere && !words.length) notes.push("everywhere needs q: without it only readable threads are listed.");
    const grants = () => allowedGrants(reader, reader.threadGrants ?? []);
    let searchAll = everywhere && grants().some((s) => s.kind === "search" || s.kind === "all");
    if (everywhere && !searchAll) {
      const asked = await this.requestThreadAccess(readerId, { only: ["search"], importance: opts.importance, signal: opts.signal });
      reader = this.threads.get(readerId) ?? reader;
      searchAll = asked.allowed && grants().some((s) => s.kind === "search");
      if (!searchAll) notes.push(`Searched only the threads you may read: ${asked.message}`);
    }
    const readable = new Set(threads.map((t) => t.id));
    const trusted = this.threadTrusted(reader);
    // Outside threads show their title only; a tainted one's title stays hidden from an untrusted reader too (#269).
    const outsidePool = searchAll ? [...this.threads.values()].filter((t) => t.id !== readerId && !readable.has(t.id) && (trusted || !t.tainted)) : [];
    const pool = [...threads, ...outsidePool].filter((t) => opts.archived || !t.archived);
    const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 20)));
    if (words.length) this.flushNow();
    // messages: the message text table answers alone. Otherwise read transcripts only of threads
    // with an item that mentions every word.
    const messageHits = new Map<string, { count: number; text: string }>();
    if (words.length && opts.messages) {
      for (const row of this.db.messagesMentioning(words)) {
        const lower = row.text.toLowerCase();
        if (!words.every((w) => lower.includes(w))) continue;
        const hit = messageHits.get(row.threadId);
        if (hit) hit.count += 1;
        else messageHits.set(row.threadId, { count: 1, text: row.text });
      }
    }
    const mentioned = words.length && !opts.messages ? this.db.threadsMentioning(words.map(likePatterns)) : null;

    type Found = { t: Thread; rank: number; hits?: Record<string, unknown>; match?: string };
    const found: Found[] = [];
    for (const t of pool) {
      if (!words.length) {
        found.push({ t, rank: 0 });
        continue;
      }
      const titleHit = words.every((w) => t.title.toLowerCase().includes(w));
      let messages = 0;
      let other = 0;
      let first: Item | undefined;
      let firstText: string | undefined;
      const messageHit = messageHits.get(t.id);
      if (messageHit) {
        messages = messageHit.count;
        firstText = messageHit.text;
      } else if (mentioned?.has(t.id)) {
        let firstOther: Item | undefined;
        for (const it of this.peekItems(t.id)) {
          if (!itemMatches(it, words)) continue;
          if (isMessage(it)) {
            messages += 1;
            first ??= it;
          } else if (!opts.messages) {
            other += 1;
            firstOther ??= it;
          }
        }
        first ??= firstOther;
      }
      if (!titleHit && !messages && !other) continue;
      const hits = { ...(titleHit ? { title: true } : {}), ...(messages ? { messages } : {}), ...(other ? { other } : {}) };
      firstText ??= first && (isMessage(first) ? (first as { text: string }).text : itemText(first) ?? undefined);
      const text = firstText && readable.has(t.id) && opts.details ? firstText : null;
      found.push({ t, rank: titleHit || messages ? 0 : 1, hits, ...(text ? { match: messageSnippet(text, words[0], 200) } : {}) });
    }
    found.sort((a, b) => a.rank - b.rank || b.t.activityAt - a.t.activityAt);

    const rows = found.slice(0, limit).map(({ t, hits, match }): Record<string, unknown> => {
      const outside = !readable.has(t.id);
      const workspace = t.worktree?.home ?? t.cwd;
      const turns = this.peekTurns(t.id);
      const wt = t.worktree;
      return {
        id: t.id,
        title: t.title,
        ...(workspace ? { workspace } : {}),
        ...(t.scope.kind === "page" || t.scope.kind === "folder" ? { scope: threadScopeLabel(t, lookup) } : {}),
        activityAt: `${new Date(t.activityAt).toISOString().slice(0, 16)}Z`,
        ...(outside ? { outside: true } : { status: this.threadStatus(t, turns) }),
        ...(hits ? { hits } : {}),
        ...(t.archived ? { archived: true } : {}),
        ...(opts.details && !outside
          ? {
              provider: t.provider,
              model: t.model,
              mode: t.mode,
              ...(wt ? { branch: wt.branch, ...(wt.closed ? { worktree: wt.closed.how } : {}) } : {}),
              turns: turns.length,
              createdAt: new Date(t.createdAt).toISOString(),
            }
          : {}),
        ...(match ? { match } : {}),
      };
    });
    if (rows.some((r) => r.outside)) {
      notes.push("Rows with outside: true are outside the threads you may read: you see only their title, folder and date. thread_access with thread: <id> asks the user to let you read one.");
    }
    return {
      scopes: grants().map((s) => scopeLabel(s, lookup)),
      threads: rows,
      more: Math.max(0, found.length - limit),
      ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  }

  /**
   * thread_read: one readable thread's transcript as compact text. Without from, the last limit
   * items; q keeps items that mention every word; kinds keeps only those item kinds (user, text, tool, …).
   */
  async readOtherThread(
    readerId: string,
    opts: { thread: string; from?: number; limit?: number; q?: string; kinds?: string[]; full?: boolean; importance?: WebImportance; signal?: AbortSignal }
  ): Promise<Record<string, unknown>> {
    const { threads, lookup } = await this.readableThreads(readerId, opts);
    const target = threads.find((t) => t.id === opts.thread);
    if (!target) {
      const outside = this.threads.has(opts.thread) && opts.thread !== readerId;
      throw new Error(outside ? "That thread is outside the scopes this thread may read; thread_access asks for the rest of its scopes." : `No readable thread ${opts.thread}. thread_list shows the ones you can read.`);
    }
    const self = this.threads.get(readerId);
    if (target.tainted && self && !self.tainted) {
      self.tainted = true;
      this.db.saveThread(self);
      this.emitThread(readerId);
    }
    const words = queryWords(opts.q);
    const kinds = opts.kinds?.length ? new Set(opts.kinds) : null;
    const pool = this.peekItems(target.id).filter((it) => (!kinds || kinds.has(it.kind)) && itemMatches(it, words) && itemText(it) !== null);
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 40)));
    const start = opts.from !== undefined ? pool.findIndex((it) => it.seq >= opts.from!) : Math.max(0, pool.length - limit);
    const page = start < 0 ? [] : pool.slice(start, start + limit);
    const turns = this.peekTurns(target.id);
    const turnNo = new Map(turns.map((t, i) => [t.id, i + 1]));
    const wt = target.worktree;
    return {
      thread: {
        id: target.id,
        title: target.title,
        provider: target.provider,
        model: target.model,
        scope: threadScopeLabel(target, lookup),
        ...(target.cwd ? { cwd: target.cwd } : {}),
        ...(wt ? { branch: wt.branch, base: wt.base, ...(wt.closed ? { worktree: wt.closed.how } : {}) } : {}),
        status: this.threadStatus(target, turns),
        turns: turns.length,
      },
      total: pool.length,
      items: page.map((it) => ({
        seq: it.seq,
        ...(it.turnId && turnNo.has(it.turnId) ? { turn: turnNo.get(it.turnId) } : {}),
        at: new Date(it.createdAt).toISOString(),
        text: itemText(it, { full: opts.full }),
      })),
      ...(start > 0 && page.length ? { earlier: { from: pool[Math.max(0, start - limit)].seq } } : {}),
      ...(start >= 0 && start + limit < pool.length ? { later: { from: pool[start + limit].seq } } : {}),
    };
  }

  // ---------- shared memory (#104) ----------

  /** Every saved memory. */
  memories(): Memory[] {
    return cleanMemories(this.db.getSetting<unknown>("memories", []));
  }

  /** Targets for the user's memory editor, without fetching models or credentials. */
  memoryTargets(): Array<{ provider: string; source?: string; label: string }> {
    const sources = new Map(this.modelSources().map((s) => [`src-${s.id}`, s.name]));
    const models = [...this.cachedModels("pi").map((m) => m.id), this.prefs().models.pi, ...[...this.threads.values()].filter((t) => t.provider === "pi").map((t) => t.model)];
    for (const model of models.filter((m): m is string => Boolean(m))) {
      const owner = memoryOwner({ provider: "pi", model });
      if (owner.source && !sources.has(owner.source)) sources.set(owner.source, owner.source);
    }
    for (const m of this.memories()) if (m.provider === "pi" && m.source && !sources.has(m.source)) sources.set(m.source, m.source);
    return [
      { provider: "claude", label: "Claude" }, { provider: "cursor", label: "Cursor" }, { provider: "codex", label: "Codex" },
      ...[...sources].map(([source, label]) => ({ provider: "pi", source, label: `Native: ${label}` })),
    ];
  }

  /** The folder a thread's workspace memories belong to: its workspace, or the main checkout for a worktree. */
  private memoryWorkspace(thread: Thread): string | null {
    return thread.worktree?.home ?? thread.cwd ?? (thread.scope.kind === "workspace" ? thread.scope.ref : null);
  }

  /** Add a memory or change one, from Agent settings. */
  saveUserMemory(id: string | null, body: unknown): Memory {
    const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const workspace = typeof input.workspace === "string" && input.workspace.trim() ? input.workspace.trim() : null;
    if (workspace && !path.isAbsolute(workspace)) throw new Error("The workspace must be an absolute folder path.");
    const saved = saveMemory(this.memories(), { ...(id ? { id } : {}), ...(typeof input.title === "string" ? { title: input.title } : {}), text: typeof input.text === "string" ? input.text : "", scope: input.scope === "provider" ? "provider" : workspace ? "workspace" : "global", workspace, provider: typeof input.provider === "string" ? input.provider : undefined, source: typeof input.source === "string" ? input.source : undefined, by: "user" });
    this.db.setSetting("memories", saved.memories);
    return saved.memory;
  }

  deleteMemory(id: string): void {
    const all = this.memories();
    if (!all.some((m) => m.id === id)) throw new Error(`memory not found: ${id}`);
    this.db.setSetting("memories", all.filter((m) => m.id !== id));
  }

  /**
   * memory_list, memory_save and memory_delete from a chat's MCP. A chat sees and changes the global
   * memories, those of its own workspace and its own provider/source; each change leaves a note in the chat, so the user sees
   * what their agents keep.
   */
  memoryOp(threadId: string, op: string, body: Record<string, unknown>): Record<string, unknown> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Memory only works in Scribe chat threads.");
    if (!this.prefs().memory) throw new Error("Shared memory is turned off in Agent settings. Carry on without it.");
    const workspace = this.memoryWorkspace(thread);
    const owner = this.runs.get(threadId)?.memoryOwner ?? memoryOwner(thread);
    const all = this.memories();
    const row = (m: Memory) => ({ id: m.id, scope: m.scope, ...(m.workspace ? { workspace: m.workspace } : {}), ...(m.provider ? { provider: m.provider } : {}), ...(m.source ? { source: m.source } : {}), ...(m.title ? { title: m.title } : {}), text: m.text, by: m.by, updatedAt: new Date(m.updatedAt).toISOString() });
    const note = (text: string) => {
      const run = this.runs.get(threadId);
      if (run) this.closeBlocks(run);
      this.addItem(threadId, run?.turn.id ?? null, { kind: "notice", level: "info", text });
    };
    if (op === "list") {
      const words = queryWords(body.q);
      const memories = memoriesFor(all, workspace, owner).filter((m) => words.every((w) => `${m.title ?? ""} ${m.text}`.toLowerCase().includes(w)));
      return { ...(workspace ? { workspace } : {}), memories: memories.map(row) };
    }
    if (op === "save") {
      const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined;
      const old = id ? all.find((m) => m.id === id) : undefined;
      if (old && !memoryApplies(old, workspace, owner)) throw new Error(`Memory ${id} belongs to another workspace or provider/source.`);
      if (body.scope !== undefined && !["global", "workspace", "provider"].includes(String(body.scope))) throw new Error("Memory scope must be global, workspace or provider.");
      const scope = body.scope === "provider" ? "provider" : body.scope === "global" ? "global" : body.scope === "workspace" || workspace ? "workspace" : "global";
      if (scope === "workspace" && !workspace && !old) throw new Error("This thread has no workspace folder. Use global or provider scope.");
      // A change keeps the memory where it is (a parent workspace's stays the parent's) unless scope says otherwise.
      const keep = old && typeof body.scope !== "string" ? old : null;
      const title = typeof body.title === "string" && body.title.trim() ? body.title : undefined;
      if (!title && !old?.title) throw new Error("Give the memory a title: a few words naming it (the user's list shows only titles).");
      const saved = saveMemory(all, {
        ...(id ? { id } : {}),
        ...(title ? { title } : {}),
        text: typeof body.text === "string" ? body.text : "",
        scope: keep ? keep.scope : scope,
        // An agent's provider memory covers its provider everywhere; only the user ties one to a workspace too.
        workspace: keep ? keep.workspace : scope === "workspace" ? workspace : null,
        // Ownership comes from the authenticated thread, never tool arguments.
        provider: owner.provider,
        source: owner.source,
        by: thread.provider,
        thread: threadId,
      });
      this.db.setSetting("memories", saved.memories);
      note(`${saved.created ? "Saved a memory" : "Updated a memory"} (${memoryPlace(saved.memory)}): ${saved.memory.title ? `${saved.memory.title}. ` : ""}${saved.memory.text}`);
      return { saved: row(saved.memory), created: saved.created, note: "Chats get it in their instructions from their next message. The user can edit or remove it under Agent settings, Memories." };
    }
    if (op === "delete") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      const old = all.find((m) => m.id === id);
      if (!old || !memoryApplies(old, workspace, owner)) throw new Error(`No memory ${id || "(no id)"} in this thread's scopes. memory_list shows them.`);
      this.db.setSetting("memories", all.filter((m) => m.id !== id));
      note(`Deleted a memory: ${old.text}`);
      return { deleted: id };
    }
    throw new Error(`unknown op: ${op}`);
  }

  /** Nobody is watching this chat: a page (board worker) runs it, or it is a helper of such a chat. */
  private unattended(threadId: string): boolean {
    if (pageOwned(this.loadItems(threadId))) return true;
    const parent = this.threads.get(threadId)?.helperOf;
    return Boolean(parent && this.threads.has(parent) && pageOwned(this.loadItems(parent)));
  }

  // ---------- helper agents ----------

  /** agent_models: the providers and models agent_run can use. */
  async helperModels(threadId: string | null, provider?: string): Promise<{ providers: Array<Record<string, unknown>> }> {
    // null: a chat on another device asks what this one has (#911).
    if (threadId) this.helperParent(threadId);
    else if (!this.prefs().helpers) throw new Error("Helper agents are turned off on that device (Agent settings, Helper agents).");
    if (provider !== undefined && !isProviderId(provider)) throw new Error(`Unknown provider ${provider}. Providers: ${Object.keys(this.providers).join(", ")}.`);
    const status = await this.providerStatus();
    const rows: Array<Record<string, unknown>> = [];
    for (const s of status) {
      if (provider && s.id !== provider) continue;
      if (!s.available) {
        if (provider) rows.push({ provider: s.id, label: s.label, available: false, ...(s.detail ? { detail: s.detail } : {}) });
        continue;
      }
      const models = await this.models(s.id).catch(() => []);
      rows.push({
        provider: s.id,
        label: s.label,
        models: models.map((m) => ({ id: m.id, ...(m.label !== m.id ? { label: m.label } : {}), ...(m.efforts.length ? { efforts: m.efforts.map((e) => e.id) } : {}) })),
      });
    }
    return { providers: rows };
  }

  /** The thread an agent_run or agent_models call came from, when it may start helpers. */
  private helperParent(threadId: string): Thread {
    const parent = this.threads.get(threadId);
    if (!parent) throw new Error("Helper agents only work in Scribe chat threads.");
    if (parent.helperOf) throw new Error("A helper cannot start helpers of its own. Do the task yourself.");
    if (!this.prefs().helpers) throw new Error("Helper agents are turned off (Agent settings, Helper agents). Do the work yourself, and tell the user if they asked for a helper.");
    return parent;
  }

  /** The model a helper call names, by id or label; the error lists what there is. */
  private async helperModel(provider: ProviderId, want: string | undefined): Promise<ModelOption | null> {
    const models = await this.models(provider);
    if (!want) return null;
    const q = want.trim().toLowerCase();
    const exact = models.find((m) => m.id === want) ?? models.find((m) => m.id.toLowerCase() === q || m.label.toLowerCase() === q);
    if (exact) return exact;
    const partial = models.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
    if (partial.length === 1) return partial[0];
    const list = (partial.length ? partial : models).slice(0, 40).map((m) => m.id);
    throw new Error(`${partial.length ? `"${want}" matches several ${provider} models` : `No ${provider} model "${want}"`}. Pick one of: ${list.join(", ")}.`);
  }

  /** Ask the user before a thread starts a helper, unless it has full access or they allowed helpers for the thread. */
  private async approveHelper(parent: Thread, what: string, task: string, access: { mode: ThreadMode; approval: ApprovalPolicy }, signal?: AbortSignal): Promise<void> {
    if (parent.approval === "full" || parent.helpersAllowed) return;
    const run = this.runs.get(parent.id);
    if (!run) throw new Error("With no turn running the user cannot be asked to allow a helper.");
    const options: ApprovalOption[] = [
      { id: "once", label: "Allow once", kind: "allow_once" },
      { id: "thread", label: "Allow for this thread", kind: "allow_always" },
      { id: "deny", label: "Deny", kind: "reject_once" },
    ];
    this.closeBlocks(run);
    const detail = `The agent wants to hand this task to ${what}. It works in this thread's workspace on the ${APPROVAL_LABEL[access.approval]} rung with this thread's web setting.\n\n${clip(task, 2000)}`;
    const item = this.addItem(parent.id, run.turn.id, { kind: "approval", requestId: "", tool: "task", title: `Start a helper agent: ${what}`.slice(0, 300), detail, options, status: "pending" });
    let decision: ApprovalDecision;
    try {
      decision = await this.waitPending<ApprovalDecision>(parent.id, run, "approval", item.id, signal);
    } catch {
      throw new Error("The request to start a helper was cancelled.");
    }
    if (decision.optionId === "deny") throw new Error(decision.note ? `The user denied the helper: ${decision.note}` : "The user denied the helper. Do the work yourself.");
    if (decision.optionId === "thread") {
      const t = this.threads.get(parent.id);
      if (t) {
        t.helpersAllowed = true;
        this.db.saveThread(t);
      }
    }
  }

  /** harness_docs (#79): how Scribe's harness works and what is set for this thread's workspace. */
  harnessDocs(threadId: string): string {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("harness_docs only works in Scribe chat threads.");
    const { rules, classifier } = this.hookSettings();
    return harnessDocs({ mcp: readMcpFile(), hookRules: rules, classifier }, { workspace: threadWorkspace(thread) });
  }

  /**
   * harness_change (#79): change the user's MCP servers, hook rules, skills or instruction files.
   * The user approves it in a violet card, whatever the thread's approval rung, unless they allowed
   * it for the thread. Everything is checked before the card shows and before anything is written.
   */
  async harnessChange(threadId: string, input: unknown, signal?: AbortSignal): Promise<{ applied: string[]; note: string }> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("harness_change only works in Scribe chat threads.");
    if (thread.helperOf) throw new Error("A helper cannot change the agent setup. Say in your report what should change.");
    const ops = parseHarnessOps(input);
    const roots = { workspace: threadWorkspace(thread) };
    const reason = isPlainRecord(input) && typeof input.reason === "string" ? input.reason.trim().slice(0, 1000) : "";
    const read = () => {
      const { error, ...mcp } = readMcpFile();
      if (error && ops.some((op) => op.op.startsWith("mcp_"))) throw new Error(`Scribe's mcp.json does not parse, so it is left alone: ${error}`);
      return { mcp, hookRules: this.prefs().hookRules };
    };
    const plan = planHarnessChange(ops, read(), roots);
    if (!thread.harnessAllowed) {
      const run = this.runs.get(thread.id);
      if (!run) throw new Error("With no turn running the user cannot be asked to allow a setup change.");
      const options: ApprovalOption[] = [
        { id: "once", label: "Allow once", kind: "allow_once" },
        { id: "thread", label: "Allow for this thread", kind: "allow_always", description: "This chat may change MCP servers, hook rules, skills and instruction files without asking again. Take it back under the thread's permissions." },
        { id: "deny", label: "Deny", kind: "reject_once" },
      ];
      this.closeBlocks(run);
      const detail = `${reason ? `${reason}\n\n` : ""}${plan.lines.map((l) => `• ${l}`).join("\n")}\n\nThis changes Scribe's agent setup for every thread, from each thread's next session.`;
      const item = this.addItem(thread.id, run.turn.id, { kind: "approval", requestId: "", tool: "other", tone: "harness", title: `Change the agent setup (${plan.lines.length} change${plan.lines.length === 1 ? "" : "s"})`, detail: clip(detail, 6000), options, status: "pending" });
      let decision: ApprovalDecision;
      try {
        decision = await this.waitPending<ApprovalDecision>(thread.id, run, "approval", item.id, signal);
      } catch {
        throw new Error("The request to change the agent setup was cancelled.");
      }
      if (decision.optionId === "deny") throw new Error(decision.note ? `The user denied the setup change: ${decision.note}` : "The user denied the setup change. Leave it as it is, or ask them what they want.");
      if (decision.optionId === "thread") {
        const t = this.threads.get(thread.id);
        if (t) {
          t.harnessAllowed = true;
          this.db.saveThread(t);
          this.emit({ type: "agent_thread", thread: this.view(t) });
        }
      }
    }
    // Planned again on what is there now, in case the setup changed while the user was deciding.
    const final = planHarnessChange(ops, read(), roots);
    writeHarnessPlan(final, roots);
    if (final.mcp) writeMcpFile(final.mcp);
    if (final.hookRules) this.setPrefs({ hookRules: final.hookRules });
    return { applied: final.lines, note: "Saved. Threads get the new setup from their next session; this turn keeps the tools it started with." };
  }

  /**
   * A tainted thread (#269) handing work to an untrusted model: its brief can carry trusted content,
   * so the user says yes each time, whatever the approval level. Nobody answering denies it after
   * TAINTED_HELPER_WAIT_MS, so a board worker does not wait for ever.
   */
  private async approveTaintedHelper(parent: Thread, what: string, signal?: AbortSignal): Promise<void> {
    const run = this.runs.get(parent.id);
    if (!run) throw new Error("This thread has read Trusted only content, and with no turn running the user cannot be asked to share it with an untrusted helper. Do the work yourself.");
    const options: ApprovalOption[] = [
      { id: "allow", label: "Allow once", kind: "allow_once" },
      { id: "deny", label: "Deny", kind: "reject_once" },
    ];
    this.closeBlocks(run);
    const until = new Date(Date.now() + TAINTED_HELPER_WAIT_MS).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const detail = `This thread has read Trusted only or Restricted pages. ${what} is not a trusted model, and the brief may carry that content to it.\nRefused if not answered by ${until}.`;
    const item = this.addItem(parent.id, run.turn.id, { kind: "approval", requestId: "", tool: "task", title: `Untrusted helper: ${what}`.slice(0, 300), detail, options, status: "pending" });
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, TAINTED_HELPER_WAIT_MS);
    let decision: ApprovalDecision;
    try {
      decision = await this.waitPending<ApprovalDecision>(parent.id, run, "approval", item.id, abort.signal);
    } catch {
      throw new Error(timedOut ? "Nobody allowed sharing this thread's trusted content with an untrusted helper in time. Do the work yourself, or use a trusted model." : "The request to start a helper was cancelled.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (decision.optionId === "deny") throw new Error(decision.note ? `The user kept trusted content from the untrusted helper: ${decision.note}` : "The user kept this thread's trusted content from the untrusted helper. Do the work yourself, or use a trusted model.");
  }

  /**
   * A helper's rung (#719): its parent's, or a lower one it asks for. The old mode names still work:
   * code keeps the parent's rung, and ask, board and plan (investigate without edits) are the Board rung.
   */
  private helperAccess(parent: Thread, requested: string | undefined): { mode: ThreadMode; approval: ApprovalPolicy } {
    if (requested === undefined) return { mode: parent.mode, approval: parent.approval };
    const mode = wantsPlan(requested) ? "board" : parseMode(requested);
    const rung = parseApproval(requested) && requested !== "ask" ? parseApproval(requested)! : mode === "board" ? minApproval("board", parent.approval) : mode ? parent.approval : null;
    const below = APPROVALS.slice(0, approvalRank(parent.approval) + 1);
    if (!rung) throw new Error(`Unknown helper access "${requested}". Choose: ${below.join(", ")}.`);
    if (approvalRank(rung) > approvalRank(parent.approval)) throw new Error(`A helper may not exceed this thread's ${parent.approval} rung. Choose: ${below.join(", ")}.`);
    return settleAccess("code", rung);
  }

  /**
   * agent_run from a thread's MCP: hand a task to a helper thread on another provider or model, wait
   * for its turn to end and return its final reply. The helper works in the caller's folder (an open
   * worktree is shared) with the same or a lower mode, and its approval and web setting. thread sends a follow-up to a helper
   * this thread started earlier (steered into its turn while it still works, #786); with no task it only waits for that helper's turn (one a restart cut
   * off and sent on) and returns its report.
   */
  async runHelper(
    threadId: string,
    opts: { title?: string; task: string; provider?: string; model?: string; effort?: string; mode?: string; thread?: string; background?: boolean; stop?: boolean; signal?: AbortSignal }
  ): Promise<Record<string, unknown>> {
    const parent = this.helperParent(threadId);
    const task = opts.task.trim();
    if (opts.signal?.aborted) throw new Error("cancelled");
    if (opts.stop && (!opts.thread || task)) throw new Error("Stopping a helper requires thread and no task.");
    if (!task && !opts.thread) throw new Error("task is required: a brief the helper can work from on its own.");
    let helper: Thread;
    if (opts.thread) {
      const existing = this.threads.get(opts.thread);
      if (!existing || existing.helperOf !== threadId) throw new Error(`No helper ${opts.thread} of this thread. Leave thread out to start a new one.`);
      if (opts.stop) await this.cancel(existing.id);
      if (!task && !this.loadTurns(existing.id).length) throw new Error("That helper has not run yet. Pass a task.");
      if (existing.archived) throw new Error("That helper thread is archived. Leave thread out to start a new one.");
      if (task && this.threads.get(threadId)?.tainted && !this.modelTrusted(existing.provider, existing.model)) await this.approveTaintedHelper(parent, existing.title.replace(/^Helper: /, ""), opts.signal);
      helper = existing;
    } else {
      const title = opts.title?.replace(/\s+/g, " ").trim();
      if (!title) throw new Error("title is required for a new helper: a short name describing its task.");
      const access = this.helperAccess(parent, opts.mode);
      if (!opts.provider || !isProviderId(opts.provider)) throw new Error(`provider is required: one of ${Object.keys(this.providers).join(", ")}. agent_models lists their models.`);
      const provider = opts.provider;
      const status = (await this.providerStatus()).find((s) => s.id === provider);
      if (!status?.available) throw new Error(`${status?.label ?? provider} is not available${status?.detail ? `: ${status.detail}` : "."}`);
      const model = await this.helperModel(provider, opts.model);
      if (opts.effort && model && !model.efforts.some((e) => e.id === opts.effort)) {
        throw new Error(model.efforts.length ? `${model.id} has no effort "${opts.effort}". Its efforts: ${model.efforts.map((e) => e.id).join(", ")}.` : `${model.id} has no effort setting; leave effort out.`);
      }
      const busy = [...this.threads.values()].filter((t) => t.helperOf === threadId && this.runs.has(t.id)).length;
      if (busy >= MAX_HELPERS) throw new Error(`This thread already has ${busy} helpers working. Wait for one to finish.`);
      const what = `${status.label}${model ? ` (${model.label})` : ""}`;
      if (parent.tainted && !this.modelTrusted(provider, model?.id ?? this.prefs().models[provider] ?? "default")) await this.approveTaintedHelper(parent, what, opts.signal);
      await this.approveHelper(parent, what, task, access, opts.signal);
      if (opts.signal?.aborted) throw new Error("cancelled");
      // Other calls can have started while this one waited for approval.
      if ([...this.threads.values()].filter((t) => t.helperOf === threadId && (this.runs.has(t.id) || this.queues.get(t.id)?.length || this.resuming.has(t.id))).length >= MAX_HELPERS) {
        throw new Error(`This thread already has ${MAX_HELPERS} helpers working. Wait for one to finish.`);
      }
      // The folder can have changed while the user was asked (a worktree made or closed).
      const now = this.requireThread(threadId);
      const wt = openWorktree(now);
      const draft = this.draftThread({
        title: `Helper: ${title.slice(0, 200)}`,
        provider,
        ...(model ? { model: model.id } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        // Recheck the boundary: the parent's rung may have changed while approval was pending.
        ...this.helperAccess(now, opts.mode),
        // A helper is held to what its parent's mode takes away.
        ...(now.custom ? { custom: now.custom } : {}),
        web: now.web,
        // A helper for files and commands gets no page tools; one of a Pages thread works on the same pages.
        // In a worktree the workspace is still the user's folder, or each worktree would list as a workspace of its own (#544).
        scope: now.mode === "board" ? now.scope : { kind: "workspace", ref: wt?.home ?? now.cwd },
        cwd: now.cwd,
        useWorktree: Boolean(wt),
      });
      draft.helperOf = threadId;
      if (wt) draft.worktree = { ...wt };
      this.threads.set(draft.id, draft);
      this.items.set(draft.id, []);
      this.turns.set(draft.id, []);
      this.seq.set(draft.id, 0);
      this.db.saveThread(draft);
      this.emit({ type: "agent_thread", thread: this.view(draft) });
      helper = draft;
    }
    if (opts.signal?.aborted) throw new Error("cancelled");
    this.linkHelperCall(threadId, helper.id, task);
    return this.helperTurn(helper, task, opts);
  }

  /** Send a helper its brief (or follow-up), and return its report: at once in the background, else when its turn ends. */
  private async helperTurn(helper: Thread, task: string, opts: { thread?: string; background?: boolean; signal?: AbortSignal }): Promise<Record<string, unknown>> {
    // A follow-up to a helper still at work steers it: into its running turn when the provider can
    // take it, else queued to run right after that turn. Either way the report is the one after it.
    let sent = false;
    if (task && opts.thread && (this.runs.has(helper.id) || this.queues.get(helper.id)?.length || this.resuming.has(helper.id))) {
      this.send(helper.id, { text: task, from: "agent" });
      sent = true;
      const steered = this.queues.get(helper.id)?.length === 1 && this.steerFirst(helper.id);
      if (opts.background) {
        return { thread: helper.id, provider: helper.provider, model: helper.model, status: steered ? "steered" : "queued", note: `${steered ? "The message went into the helper's running turn." : "The helper takes the message right after its current turn."} Call agent_run with this thread and no task to wait for its report.` };
      }
    }
    if (task && opts.background) {
      this.send(helper.id, { text: task, from: "agent" });
      return { thread: helper.id, provider: helper.provider, model: helper.model, status: "running", note: "The helper is working in the background. Continue other work or start independent helpers. Call agent_run with this thread and no task to wait for its report before using its work." };
    }
    // With no task the helper's last turn is the report: wait only while it is still at it.
    if (task || this.runs.has(helper.id) || this.queues.get(helper.id)?.length || this.resuming.has(helper.id)) {
      let finish!: () => void;
      let abortWait!: () => void;
      const done = new Promise<void>((resolve, reject) => {
        finish = resolve;
        abortWait = () => reject(new Error("cancelled"));
        const list = this.turnWaiters.get(helper.id) ?? [];
        list.push(resolve);
        this.turnWaiters.set(helper.id, list);
      });
      // A tool connection going away (including message steering) ends only the wait.
      // Explicit Stop cancels helpers through cancel(parent), independently of this signal.
      opts.signal?.addEventListener("abort", abortWait);
      try {
        if (task && !sent) this.send(helper.id, { text: task, from: "agent" });
        if (opts.signal?.aborted) abortWait();
        await done;
      } finally {
        opts.signal?.removeEventListener("abort", abortWait);
        const remaining = (this.turnWaiters.get(helper.id) ?? []).filter((waiter) => waiter !== finish);
        if (remaining.length) this.turnWaiters.set(helper.id, remaining);
        else this.turnWaiters.delete(helper.id);
      }
    }
    const turn = this.loadTurns(helper.id).at(-1);
    if (!turn) throw new Error("The helper did not run.");
    const items = this.loadItems(helper.id);
    const { reply } = this.turnText(items, turn, false);
    const files = (turn.files ?? []).map((f) => `${f.status} ${f.path}`);
    const latest = this.threads.get(helper.id) ?? helper;
    const incomplete = turn.status === "error" || turn.status === "cancelled";
    // A failed helper can leave useful edits and a progress message, without having finished its brief.
    // Keep this bounded and omit raw tool inputs/outputs: the parent needs activity, not another transcript.
    const recentTools = incomplete ? items.filter((item): item is Item & { kind: "tool" } => item.kind === "tool" && item.turnId === turn.id && !item.parentToolId).slice(-5).map((item) => ({
      name: item.name.slice(0, 200),
      title: item.title.slice(0, 300),
      status: item.status,
    })) : [];
    return {
      thread: helper.id,
      provider: latest.provider,
      model: turn.model,
      status: turn.status,
      usage: this.threadUsage(helper.id),
      ...(turn.error ? { error: turn.error } : {}),
      ...(incomplete ? { partialReply: true, recentTools } : {}),
      reply: reply || (turn.status === "done" ? "(The helper ended its turn without a final message. Check its changes yourself.)" : ""),
      ...(files.length ? { files } : {}),
      ...(turn.usage?.inputTokens !== undefined || turn.usage?.outputTokens !== undefined ? { tokens: { input: turn.usage.inputTokens ?? 0, output: turn.usage.outputTokens ?? 0 } } : {}),
      note: (incomplete ? "The helper stopped before completing its turn. Its reply may be a progress message; any listed file changes remain in the shared workspace and do not prove the task is complete. " : "") +
        (latest.provider === "cursor" && turn.error?.includes("repeated resume attempts made no progress") ? "Cursor's SDK stopped after repeated interrupted resumes without saving a checkpoint. File edits and tool activity can still have occurred. " : "") +
        "Check this work yourself before you rely on it. To send the same helper a follow-up, pass thread.",
    };
  }

  /**
   * Note the helper thread on the caller's agent_run tool call, so the chat shows the helper's
   * progress on that call. The call reaches Scribe over HTTP without its tool id: it is the caller's
   * oldest agent_run still running with this task (or naming this thread) and no helper yet.
   */
  private linkHelperCall(threadId: string, helperId: string, task: string): void {
    const turnId = this.runs.get(threadId)?.turn.id;
    if (!turnId) return;
    const open = this.loadItems(threadId).filter(
      (item): item is Item & { kind: "tool" } =>
        item.kind === "tool" && item.turnId === turnId && !item.helper && (item.status === "running" || item.status === "pending") && (/agent_run$/.test(item.name) || /agent_run$/.test(item.title))
    );
    const input = (item: Item & { kind: "tool" }) => (item.input && typeof item.input === "object" ? (item.input as Record<string, unknown>) : {});
    const call =
      open.find((item) => input(item).thread === helperId) ??
      open.find((item) => task && typeof input(item).task === "string" && (input(item).task as string).trim() === task) ??
      (open.length === 1 ? open[0] : undefined);
    if (!call) return;
    call.helper = helperId;
    this.touch(call);
  }

  /** Use up an "Allow once" pass from web_request that covers this call. */
  private takeWebPass(threadId: string, call: WebCall): boolean {
    const passes = (this.webPasses.get(threadId) ?? []).filter((p) => Date.now() - p.at < WEB_PASS_MS);
    const index = passes.findIndex((p) => webPassCovers(p.call, call));
    if (index >= 0) passes.splice(index, 1);
    if (passes.length) this.webPasses.set(threadId, passes);
    else this.webPasses.delete(threadId);
    return index >= 0;
  }

  /** A subagent or background command changed; its tool item can be from an earlier turn. */
  private patchTask(threadId: string, toolId: string, patch: Partial<TaskInfo>): void {
    if (!this.threads.has(threadId)) return;
    const items = this.loadItems(threadId);
    let item: Item | undefined;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "tool" && it.toolId === toolId) {
        item = it;
        break;
      }
    }
    if (!item || item.kind !== "tool") return;
    // A finished task stays finished: late progress frames do not bring it back.
    if (item.task && item.task.status !== "running" && patch.status === undefined) return;
    item.task = { id: "", type: "agent", status: "running", ...item.task, ...patch };
    this.touch(item);
    this.emitThread(threadId);
  }

  /** Background tasks still working in this thread. */
  backgroundTasks(threadId: string): number {
    const items = this.items.get(threadId);
    if (!items) return 0;
    return items.filter((it) => it.kind === "tool" && it.task?.status === "running" && (it.task.background || it.turnId !== this.runs.get(threadId)?.turn.id)).length;
  }

  private taskItem(threadId: string, itemId: string): Item & { kind: "tool" } {
    const item = this.loadItems(threadId).find((it) => it.id === itemId);
    if (!item || item.kind !== "tool" || !item.task) throw new Error("Task not found");
    return item;
  }

  async stopTask(threadId: string, itemId: string): Promise<void> {
    const item = this.taskItem(threadId, itemId);
    if (item.task!.status !== "running") return;
    const session = this.sessions.get(threadId);
    if (!session?.stopTask) throw new Error("This agent cannot stop a single task");
    await session.stopTask(item.task!.id);
  }

  async backgroundTask(threadId: string, itemId: string): Promise<{ moved: boolean }> {
    const item = this.taskItem(threadId, itemId);
    const session = this.sessions.get(threadId);
    if (!session?.backgroundTask) throw new Error("This agent cannot move a task to the background");
    return { moved: await session.backgroundTask(item.toolId) };
  }

  /**
   * The agent started a turn of its own (a background agent finished and it reacts). Runs it as a
   * turn with no user message, unless one of the user's is running or about to.
   */
  private followUp(threadId: string, id: string): boolean {
    if (!this.threads.has(threadId) || this.runs.has(threadId) || this.queues.get(threadId)?.length) return false;
    void this.runTurn(threadId, null, null, { adopt: id });
    return true;
  }

  async cancel(threadId: string, { keepQueue = false }: { keepQueue?: boolean } = {}): Promise<void> {
    const run = this.runs.get(threadId);
    if (!keepQueue && run?.steer) {
      this.sessions.get(threadId)?.dropSteer?.(run.steer.id);
      const item = run.steer.itemId ? this.loadItems(threadId).find((it) => it.id === run.steer!.itemId) : undefined;
      if (item && item.kind === "user") {
        delete item.steer;
        item.dropped = true;
        this.touch(item);
      }
      run.steer = null;
      this.emitThread(threadId);
    }
    if (!keepQueue && this.queues.delete(threadId)) {
      // Stop drops queued messages; they stay in the transcript as not sent.
      for (const item of this.queuedItems(threadId)) {
        if (item.kind === "user") {
          item.dropped = true;
          delete item.editing;
          this.touch(item);
        }
      }
      this.emitThread(threadId);
    }
    // Steering starts another parent turn; helpers keep working for that turn.
    if (!keepQueue) {
      for (const t of this.threads.values()) {
        if (t.helperOf === threadId && (this.runs.has(t.id) || this.queues.get(t.id)?.length || this.resuming.has(t.id))) void this.cancel(t.id);
      }
    }
    if (!run) return;
    run.cancelled = true;
    run.abort?.abort();
    for (const [id, pending] of this.pending) {
      if (pending.threadId === threadId) {
        this.pending.delete(id);
        pending.reject(new Error("cancelled"));
        this.expireInteraction(pending);
      }
    }
    await this.sessions.get(threadId)?.cancel();
  }

  /**
   * The thread as its provider session sees it: during a plan turn (#721) it runs at planAccess, so
   * files stay read-only whatever the thread's rung.
   */
  private sessionThread(thread: Thread): Thread {
    return this.runs.get(thread.id)?.turn.plan ? { ...thread, ...planAccess(thread) } : thread;
  }

  private session(thread: Thread): ProviderSession {
    let session = this.sessions.get(thread.id);
    if (!session) {
      session = this.agent(thread.provider).createSession(this.sessionThread(thread), this.ctx);
      this.sessions.set(thread.id, session);
    }
    return session;
  }

  /** Run one turn. Without msg and userItem it is a turn the agent started itself (see followUp). */
  private async runTurn(threadId: string, msg: QueuedMessage | null, userItem: Item | null, opts?: { adopt?: string }): Promise<void> {
    let thread = this.requireThread(threadId);
    const turns = this.loadTurns(threadId);
    const turn: Turn = {
      id: `tu_${crypto.randomBytes(6).toString("hex")}`,
      threadId,
      seq: turns.length + 1,
      status: "running",
      model: thread.model,
      effort: thread.effort,
      mode: msg?.plan ? planAccess(thread).mode : thread.mode,
      ...(msg?.plan ? { plan: true } : {}),
      startedAt: Date.now(),
    };
    turns.push(turn);
    this.settleLimitCards(threadId);
    if (userItem) {
      userItem.turnId = turn.id;
      if (userItem.kind === "user") delete userItem.steer;
      this.touch(userItem);
    } else {
      this.addItem(threadId, turn.id, { kind: "notice", level: "info", text: "A background task finished; the agent picked it up." });
    }
    const run: RunState = { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), versions: new Map(), repo: null, cancelled: false, usage: {}, clock: { waits: [] }, steer: null, hooks: { lastUser: msg?.text ?? "", dock: Boolean(msg?.dock), called: new Set(), gated: new Set(), approved: new Set(), waiting: new Map(), told: new Set(), earlyItem: null, suspect: null } };
    this.runs.set(threadId, run);
    this.status.set(threadId, "running");
    this.limitTurn = { provider: thread.provider, threadId, turnId: turn.id, before: snapshotWindows(this.planLimits[thread.provider]) };
    thread.activityAt = Date.now();
    if (msg && !thread.titleLocked && thread.title === "New thread") {
      thread.title = titleFrom(msg.text);
    }
    this.db.saveThread(thread);
    this.saveTurn(turn);
    this.emitThread(threadId);
    // A steered message that became this turn went through its prompt hook when it was steered.
    if (msg && userItem && !opts?.adopt) this.hookPrompt(threadId, run, msg, userItem);

    // Checkpoint the page this turn is about, so an agent edit to it can be reverted.
    const pageId = thread.scope.kind === "page" && thread.scope.ref ? thread.scope.ref : msg?.context.find((c) => c.kind === "page")?.id;
    const pageTab = pageId ? store.get(pageId, "agent") : undefined;
    if (pageTab && !pageTab.templateId) {
      turn.page = { id: pageTab.id, title: pageTab.title, before: pageTab.revision };
      this.db.setSetting(`checkpoint:${turn.id}`, { html: pageTab.html, revision: pageTab.revision });
    }

    // A Merge or cleanup may be removing the thread's worktree: wait for it, then go on from the
    // thread as it left it (closed, so a worktree opens again below, or still open if it failed).
    if (this.worktreeClosing(threadId)) {
      for (let held; (held = this.worktreeClosing(threadId)); ) await held.catch(() => {});
      thread = this.threads.get(threadId) ?? thread;
    }
    let setupError = workspaceFolderError(thread);
    if (thread.cwd && !setupError && !openWorktree(thread)) this.noteWorkspaces([thread.cwd]);
    let reopened = "";
    if (wantsWorktree(thread) && !run.cancelled && !setupError) {
      try {
        ({ thread, reopened } = await this.makeWorktree(threadId, turn.id));
      } catch (err) {
        setupError = `Could not make the worktree: ${(err as Error).message}`;
      }
      setupError ??= workspaceFolderError(thread);
    }

    const worktree = openWorktree(thread);
    if (thread.mode !== "board" && thread.cwd && !setupError) {
      run.repo = await findRepo(thread.cwd);
      if (!run.repo && findSvnRoot(thread.cwd)) run.svn = (await svnStart(thread.cwd)) ?? undefined;
      if (run.repo) {
        turn.repo = run.repo;
        turn.beforeTree = (await snapshotTree(run.repo)) ?? undefined;
        if (worktree) turn.beforeHead = (await headCommit(run.repo)) ?? undefined;
      }
    }

    let earlier = "";
    if (thread.fork && msg && !run.cancelled && !setupError) {
      try {
        earlier = await this.startFork(thread, thread.fork, run);
        thread = this.requireThread(threadId);
      } catch (err) {
        if (!run.cancelled) setupError = `Could not carry over the earlier thread: ${(err as Error).message}`;
      }
    }

    if (msg && thread.nativeId && !thread.rewind && !setupError && !(await this.canResume(thread))) {
      thread = this.startOverWithRecap(thread, turn.id);
    }

    const sink = this.makeSink(threadId, run);
    run.sink = sink;
    let result: TurnResult = setupError ? { status: "error", error: setupError } : { status: "cancelled" };
    // Stop can arrive while the snapshot above runs, before the provider has anything to cancel.
    if (!run.cancelled && !setupError) {
      try {
        // The fake Native provider (SCRIBE_FAKE_AGENTS) has no models to look up.
        const pi = this.agent("pi") as Partial<PiProvider>;
        if (thread.provider === "pi" && this.prefs().memory && pi.resolveModel) {
          const model = await pi.resolveModel(thread.model);
          run.memoryOwner = { provider: "pi", ...(model ? { source: model.provider } : {}) };
        }
        // Stop can also arrive while the model is looked up.
        if (!run.cancelled) {
          this.assignClaudeAccount(thread);
          const live = this.sessionThread(thread);
          const session = this.session(thread);
          session.update(live);
          const pageEdits = this.pageEditPrefix(thread, turn.id);
          const planNote = msg?.plan ? planTurnNote(live) : "";
          // A note the agent must read comes before the text, so the message is then not sent as a command.
          const command = msg && !earlier && !reopened && !planNote ? this.commandText(thread, msg) : null;
          (run.clock ??= { waits: [] }).sentAt = Date.now();
          result = await session.run(
            {
              text: command ?? (msg ? earlier + reopened + planNote + promptText(msg, thread, this.pageGuides(thread, msg), pageEdits) : reopened + pageEdits),
              images: msg?.images ?? [],
              documents: msg ? pdfs(msg) : [],
              instructions: threadInstructions(live, this.scopeInfo(thread)),
            },
            sink,
            opts
          );
        }
      } catch (err) {
        result = { status: "error", error: (err as Error).message };
      }
    }
    if (run.cancelled && result.status !== "error") result = { status: "cancelled", next: result.next };
    // An edit's withdrawal must settle before deciding whether to adopt or requeue a steer.
    await run.steer?.msg.edit?.withdrawal;
    // A host shut down mid-turn (daemon exit) has closed its database: the turn is resumed on the next start.
    if (this.closed) return;
    // A steered message the turn did not take in: the provider runs it next (adopted below), or it lost it and it goes back to the front of the queue.
    const carried = run.steer && result.next === run.steer.id ? run.steer : null;
    if (run.steer && !carried) {
      const queue = this.queues.get(threadId) ?? [];
      queue.unshift(run.steer.msg);
      this.queues.set(threadId, queue);
      const item = run.steer.itemId ? this.loadItems(threadId).find((it) => it.id === run.steer!.itemId) : undefined;
      if (item && item.kind === "user") {
        delete item.steer;
        this.touch(item);
      }
    }
    run.steer = null;

    this.closeBlocks(run);
    for (const waiting of run.hooks.waiting.values()) clearTimeout(waiting.timer);
    run.hooks.waiting.clear();
    browserTurnEnded(threadId);
    this.observe(threadId, run, "turn_end", () => ({
      text: clipChunk(this.loadItems(threadId).filter((it) => it.turnId === turn.id && it.kind === "text" && !it.parentToolId).map((it) => (it as { text: string }).text).join("\n\n")),
    }));
    for (const item of run.tools.values()) {
      if (item.kind === "tool" && (item.status === "running" || item.status === "pending")) {
        item.status = result.status === "done" ? "done" : "error";
        item.endedAt = Date.now();
        this.touch(item);
      }
    }
    for (const [id, pending] of this.pending) {
      if (pending.threadId === threadId) {
        this.pending.delete(id);
        pending.reject(new Error("turn ended"));
        this.expireInteraction(pending);
      }
    }
    // Providers can report the terminal error both as a live notice and as
    // the turn result. Keep the failure metadata without repeating its notice.
    if (result.error && !this.loadItems(threadId).some((item) =>
      item.turnId === turn.id && item.kind === "notice" && item.level === "error" && item.text === result.error)) {
      this.addItem(threadId, turn.id, { kind: "notice", level: "error", text: result.error });
    }

    if (run.repo && turn.beforeTree) {
      turn.afterTree = (await snapshotTree(run.repo)) ?? undefined;
      if (turn.afterTree) {
        turn.files = await diffTrees(run.repo, turn.beforeTree, turn.afterTree).catch(() => []);
      }
      if (turn.beforeHead) turn.afterHead = (await headCommit(run.repo)) ?? undefined;
    } else {
      const cwd = this.threads.get(threadId)?.cwd;
      if (run.svn && cwd) {
        // Edits from shell commands too: whatever svn sees changed since the turn started.
        for (const [file, version] of await svnEnd(cwd, run.svn, run.versions)) run.versions.set(file, version);
      }
      turn.files = this.versionFiles(run);
      const snapshots = this.saveVersions(threadId, run);
      if (snapshots) turn.snapshots = snapshots;
    }
    if (this.closed) return;
    if (turn.page) {
      const tab = store.get(turn.page.id, "agent");
      if (tab && tab.revision !== turn.page.before) {
        turn.page.after = tab.revision;
        turn.page.title = tab.title;
      } else {
        delete turn.page;
        this.db.deleteSetting(`checkpoint:${turn.id}`);
      }
    }
    this.rememberTurnPages(thread, msg, turn, pageId ? [pageId] : []);
    turn.status = result.status;
    turn.endedAt = Date.now();
    const rewound = this.threads.get(threadId);
    if (rewound?.rewind && result.status !== "cancelled" && !setupError) {
      delete rewound.rewind;
      this.db.saveThread(rewound);
    }
    if (rewound?.fork && result.status !== "cancelled" && !setupError) {
      delete rewound.fork;
      this.db.deleteSetting(`fork:${threadId}`);
      this.db.saveThread(rewound);
    }
    const latency = turnLatency({
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      waits: [],
      ...run.clock,
      tools: [...run.tools.values()].flatMap((item): Array<[number, number | undefined]> => item.kind === "tool" && !item.parentToolId ? [[item.startedAt, item.endedAt]] : []),
    });
    if (latency) run.usage = { ...run.usage, latency };
    turn.usage = run.usage;
    if (result.error) turn.error = result.error;
    if (thread.provider === "cursor") this.refreshCursorUsage();
    const plan = this.planProvider(thread);
    if (plan === "codex") void this.refreshCodexUsage();
    if (result.status === "error") {
      const resetsAt = usageLimitResetsAt(result.error, thread.provider === "claude" ? this.claudeThreadLimits.get(threadId) : this.planLimits[plan], turn.startedAt, turn.endedAt);
      if (resetsAt) turn.limitResetsAt = resetsAt;
    }
    this.saveTurn(turn);
    this.flushNow();
    this.runs.delete(threadId);
    this.status.set(threadId, "idle");
    const latest = this.threads.get(threadId);
    const latestWt = latest ? openWorktree(latest) : null;
    if (latest && latestWt) {
      const progress = await worktreeProgress(latestWt).catch(() => null);
      if (progress) latest.worktree = { ...latestWt, ...progress };
    }
    if (latest) {
      latest.activityAt = Date.now();
      this.db.saveThread(latest);
      // A helper reports to the agent that started it, not to the user.
      if (!pageOwned(this.loadItems(threadId)) && !latest.helperOf) this.unread.add(threadId);
    }
    const implement = turn.plan && result.status === "done" && latest ? this.endPlanTurn(threadId, turn, run) : null;
    if (turn.limitResetsAt && latest?.provider === "claude") this.claudePool.limited(latest.claudeAccount, turn.limitResetsAt);
    // Page runs wait out the limit themselves; a user's own thread asks whether to go on after the reset.
    if (turn.limitResetsAt && latest && !latest.helperOf && !this.pageRuns.get(threadId) && !pageOwned(this.loadItems(threadId))) {
      const switchTo = latest.provider === "claude" ? this.claudePool.alternative(latest.claudeAccount) : null;
      this.addItem(threadId, turn.id, { kind: "usage_limit", resetsAt: turn.limitResetsAt, status: "pending", ...(switchTo ? { switchTo } : {}) });
    }
    this.emitThread(threadId);
    const moved = run.workspace && latest ? this.applyWorkspace(threadId, turn.id, run.workspace.cwd) : false;

    if (carried && latest) {
      const item = carried.itemId ? this.loadItems(threadId).find((it) => it.id === carried.itemId) : undefined;
      void this.runTurn(threadId, carried.msg, item ?? this.addItem(threadId, null, { kind: "user", text: carried.msg.text }), { adopt: carried.id });
      return;
    }
    // The user accepted the plan on its page: implement it at the thread's own rung.
    if (implement) {
      void this.runTurn(threadId, implement, this.addItem(threadId, null, userBody(implement)));
      return;
    }
    // The agent ended its turn to get the new folder: send it on. Queued messages wait behind the
    // note, since the move is part of the task they were queued after (a steered one ran above).
    if (moved && run.workspace?.continue && result.status === "done") {
      const note: QueuedMessage = { text: workspaceNote(run.workspace.cwd), images: [], files: [], saved: { images: [], files: [] }, context: [], from: "scribe" };
      void this.runTurn(threadId, note, this.addItem(threadId, null, userBody(note)));
      return;
    }
    this.drainQueue(threadId);
    if (!this.runs.has(threadId)) {
      for (const done of this.turnWaiters.get(threadId) ?? []) done();
      this.turnWaiters.delete(threadId);
    }
    void this.pageRuns.check(threadId);
  }

  /** Keeps the turn's file versions on disk, so a diff tool can compare them without git. */
  private saveVersions(threadId: string, run: RunState): Turn["snapshots"] {
    const saved: NonNullable<Turn["snapshots"]> = {};
    for (const [file, version] of run.versions) {
      try {
        const before = saveSnapshot(threadId, version.before);
        const after = saveSnapshot(threadId, version.after);
        if (before !== undefined && after !== undefined) saved[file] = { before, after };
      } catch (err) {
        log(`Saving file versions for ${threadId} failed: ${(err as Error).message}`);
      }
    }
    return Object.keys(saved).length ? saved : undefined;
  }

  /**
   * Full before and after content of one file over a turn, or the whole thread, from the versions
   * saved without git. Null when none were saved for it.
   */
  fileVersions(threadId: string, file: string, turnId?: string): { before: Buffer; after: Buffer; existed: { before: boolean; after: boolean } } | null {
    const running = this.runs.get(threadId);
    let before: string | null | undefined, after: string | null | undefined;
    for (const turn of this.loadTurns(threadId).filter((t) => !turnId || t.id === turnId)) {
      const saved = turn.snapshots?.[file];
      const current = running?.turn.id === turn.id ? running.versions.get(file) : undefined;
      if (current) {
        if (before === undefined) before = saveSnapshot(threadId, current.before);
        after = saveSnapshot(threadId, current.after);
      } else if (saved) {
        if (before === undefined) before = saved.before;
        after = saved.after;
      }
    }
    if (before === undefined || after === undefined) return null;
    const a = readSnapshot(threadId, before), b = readSnapshot(threadId, after);
    return a && b ? { before: a, after: b, existed: { before: before !== null, after: after !== null } } : null;
  }

  /** Files changed in the turn: from the saved versions where there are some, else from the tool calls. */
  private versionFiles(run: RunState): FileChange[] {
    const files: FileChange[] = [];
    for (const [file, { before, after }] of run.versions) {
      if (before === after) continue;
      const diff = unifiedDiff(before, after, file);
      files.push({ path: file, status: before === null ? "A" : after === null ? "D" : "M", added: diff.added, removed: diff.removed });
    }
    const seen = new Set(files.map((f) => f.path));
    return [...files, ...this.toolFiles(run).filter((f) => !seen.has(f.path))];
  }

  /**
   * Without git: each file's change over a turn or the whole thread, from the saved versions
   * (first before, last after). Files without saved versions are not in it.
   */
  private snapshotChanges(threadId: string, turnId?: string): Map<string, { file: FileChange; patch: string }> {
    const paths = new Set<string>();
    const running = this.runs.get(threadId);
    for (const turn of this.loadTurns(threadId).filter((t) => !turnId || t.id === turnId)) {
      for (const file of Object.keys(turn.snapshots ?? {})) paths.add(file);
      if (running?.turn.id === turn.id) for (const file of running.versions.keys()) paths.add(file);
    }
    const out = new Map<string, { file: FileChange; patch: string }>();
    for (const file of paths) {
      const versions = this.fileVersions(threadId, file, turnId);
      if (!versions) continue;
      const before = versions.existed.before ? versions.before.toString("utf8") : null;
      const after = versions.existed.after ? versions.after.toString("utf8") : null;
      if (before === after) continue;
      const diff = unifiedDiff(before, after, file);
      out.set(file, { file: { path: file, status: before === null ? "A" : after === null ? "D" : "M", added: diff.added, removed: diff.removed }, patch: diff.patch });
    }
    return out;
  }

  private toolFiles(run: RunState): FileChange[] {
    const byPath = new Map<string, FileChange>();
    for (const item of run.tools.values()) {
      if (item.kind !== "tool" || !item.files) continue;
      for (const file of item.files) {
        const prev = byPath.get(file.path);
        byPath.set(file.path, {
          path: file.path,
          status: prev?.status === "A" ? "A" : file.status ?? "M",
          added: (prev?.added ?? 0) + file.added,
          removed: (prev?.removed ?? 0) + file.removed,
        });
      }
    }
    return [...byPath.values()];
  }

  private closeBlocks(run: RunState): void {
    if (run.reasoningItem && run.reasoningItem.kind === "reasoning" && !run.reasoningItem.endedAt) {
      run.reasoningItem.endedAt = Date.now();
      this.touch(run.reasoningItem);
    }
    const closed = [run.reasoningItem, run.textItem];
    run.reasoningItem = null;
    if (run.textItem) this.flushDelta(run.textItem.id);
    run.textItem = null;
    for (const item of closed) if (item) this.hookBlock(run, item);
  }

  private expireInteraction(pending: Pending): void {
    const item = this.loadItems(pending.threadId).find((it) => it.id === pending.itemId);
    if (!item) return;
    if (item.kind === "browser_handoff" && item.status === "pending") { item.status = "cancelled"; this.touch(item); }
    if ((item.kind === "approval" || item.kind === "question" || item.kind === "component") && item.status === "pending") {
      item.status = "expired";
      this.touch(item);
    }
  }

  /** Wait for the user to answer an interaction item; the thread shows as waiting meanwhile. */
  private waitPending<T>(threadId: string, run: RunState, kind: Pending["kind"], itemId: string, signal?: AbortSignal): Promise<T> {
    const wait: [number, number | undefined] = [Date.now(), undefined];
    (run.clock ??= { waits: [] }).waits.push(wait);
    return new Promise<T>((resolve, reject) => {
      const requestId = itemId;
      this.pending.set(requestId, { kind, threadId, itemId, resolve: resolve as never, reject } as Pending);
      if (this.status.get(threadId) === "waiting") this.emitThread(threadId);
      else this.setStatus(threadId, "waiting");
      const onAbort = () => {
        const pending = this.pending.get(requestId);
        if (pending) {
          this.pending.delete(requestId);
          this.expireInteraction(pending);
          reject(new Error("aborted"));
        }
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort);
    }).finally(() => {
      wait[1] = Date.now();
      if (this.runs.get(threadId) !== run) return;
      if (![...this.pending.values()].some((p) => p.threadId === threadId)) this.setStatus(threadId, "running");
      else this.emitThread(threadId);
    });
  }

  /**
   * page_ask: show a page as a question in the thread's running turn and wait until the page logs
   * one of `events` (its submit), the user skips it in the chat, or the turn ends. Returns what the
   * agent needs to carry on, including the page's state after the answer.
   */
  async askPage(threadId: string, opts: { page: string; prompt?: string; events: string[]; after?: number; timeoutMs: number; signal: AbortSignal }): Promise<PageAskResult> {
    const run = this.runs.get(threadId);
    if (!run) throw new Error("page_ask only works while this chat thread has a turn running.");
    const tab = store.get(opts.page, "agent");
    if (!tab) throw new Error(`tab not found: ${opts.page}`);
    const after = typeof opts.after === "number" && opts.after >= 0 ? Math.floor(opts.after) : tab.eventSeq;
    this.closeBlocks(run);
    const item = this.addItem(threadId, run.turn.id, {
      kind: "question",
      requestId: "",
      ...(opts.prompt ? { title: opts.prompt.slice(0, 300) } : {}),
      questions: [],
      page: { id: tab.id, key: tab.key, title: tab.title },
      status: "pending",
    });
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, opts.signal]);
    const chat = this.waitPending<QuestionAnswer>(threadId, run, "question", item.id, signal);
    chat.catch(() => {});
    const page = waitForEvents({ idOrKey: tab.id, names: opts.events, after, timeoutMs: opts.timeoutMs, viewer: "agent", abort: signal });
    try {
      const first = await Promise.race([chat.then((answer) => ({ answer }) as const), page.then((wait) => ({ wait }) as const)]);
      if ("answer" in first) {
        const reason = "skipped" in first.answer ? first.answer.reason : undefined;
        return { skipped: true, ...(reason ? { note: reason } : {}), page: { id: tab.id, key: tab.key } };
      }
      const wait = first.wait;
      const base = { page: { id: wait.id, key: wait.key }, cursor: wait.cursor };
      if (!wait.events.length) {
        // Closed, deleted, timed out, or the call was cancelled; the abort below expires the card.
        return { ...base, answered: false, closed: wait.closed, deleted: wait.deleted, timedOut: wait.timedOut && !opts.signal.aborted };
      }
      if (this.pending.has(item.id)) this.resolveQuestion(item.id, { answers: {} });
      const last = wait.events[wait.events.length - 1];
      if (item.kind === "question") {
        item.event = last.name;
        this.touch(item);
      }
      const now = store.get(tab.id, "agent");
      if (run.turn.plan && (last.name === "accept" || last.name === "reject")) {
        const notes = planNotes(last.data) ?? planNotes(now?.state);
        run.plan = { accepted: last.name === "accept", ...(notes ? { notes } : {}), page: tab.key };
      }
      return { ...base, answered: true, events: wait.events, stateRevision: now?.stateRevision ?? wait.stateRevision, state: now?.state ?? null };
    } catch {
      return { cancelled: true, page: { id: tab.id, key: tab.key } };
    } finally {
      stop.abort();
    }
  }

  /** Give the user the browser and keep the turn waiting until they hand it back. */
  async handoffBrowser(threadId: string, message: string, signal: AbortSignal): Promise<string[]> {
    const run = this.runs.get(threadId);
    if (!run) throw new Error("browser_control handoff needs a running turn.");
    if (!message.trim()) throw new Error("handoff requires message");
    if (this.browserHandoffs.has(threadId)) throw new Error("A browser handoff is already pending");
    this.browserHandoffs.add(threadId);
    let item: Item | undefined;
    try {
      this.closeBlocks(run);
      await browserControl(threadId, "user", message);
      if (signal.aborted || this.runs.get(threadId) !== run) throw new Error("aborted");
      item = this.addItem(threadId, run.turn.id, { kind: "browser_handoff", message, status: "pending" });
      return await this.waitPending<string[]>(threadId, run, "browser_handoff", item.id, signal);
    } finally {
      this.browserHandoffs.delete(threadId);
      if (item?.kind === "browser_handoff" && item.status === "pending") { item.status = "cancelled"; this.touch(item); }
      if (!item || (item.kind === "browser_handoff" && item.status === "cancelled")) browserUserMessage(threadId);
    }
  }

  handBackBrowser(threadId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.threadId !== threadId || pending.kind !== "browser_handoff") continue;
      const activity = browserActivity(threadId);
      const item = this.loadItems(threadId).find(it => it.id === pending.itemId);
      if (item?.kind === "browser_handoff") { item.status = "done"; item.activity = activity; this.touch(item); }
      this.pending.delete(id);
      pending.resolve(activity);
    }
  }

  /** ask_user: Scribe's own question card in the thread's running turn, whatever the provider. */
  async askQuestions(threadId: string, req: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer> {
    const run = this.runs.get(threadId);
    if (!run) throw new Error("ask_user only works while this chat thread has a turn running.");
    this.closeBlocks(run);
    const item = this.addItem(threadId, run.turn.id, {
      kind: "question",
      requestId: "",
      ...(req.title ? { title: req.title } : {}),
      questions: req.questions,
      ...(req.display ? { display: req.display } : {}),
      status: "pending",
    });
    return this.waitPending<QuestionAnswer>(threadId, run, "question", item.id, signal);
  }

  /** settings_show: the settings dialogs' own rows as a card in the thread's running turn. */
  showSettings(threadId: string, ids: string[], title?: string): void {
    const run = this.runs.get(threadId);
    if (!run) throw new Error("settings_show only works while this chat thread has a turn running.");
    this.closeBlocks(run);
    this.addItem(threadId, run.turn.id, { kind: "settings", ids, ...(title ? { title } : {}) });
  }

  componentItem(threadId: string, itemId: string): ComponentItem {
    this.requireThread(threadId);
    const item = this.loadItems(threadId).find(it => it.id === itemId);
    if (!item || item.kind !== "component") throw new Error("Component not found.");
    return item;
  }
  readonly componentProblems = new PageProblems();
  activeTurnId(threadId: string): string | undefined { return this.runs.get(threadId)?.turn.id; }

  componentView(threadId: string, itemId: string) {
    const item = this.componentItem(threadId, itemId);
    if (!item.plugin) return { ...item, available: true };
    try {
      const current = this.componentPlugin(threadId, itemId);
      return { ...item, available: true, pluginName: current.name, height: current.definition.height, hash: current.hash };
    } catch (error) { return { ...item, available: false, reason: (error as Error).message }; }
  }

  componentPlugin(threadId: string, itemId: string) {
    const item = this.componentItem(threadId, itemId), thread = this.requireThread(threadId);
    if (noPages(thread.scope)) throw new Error("Plugin components need page access.");
    if (!item.plugin || !item.component || !plugins) throw new Error("Plugin component is unavailable.");
    const permission = thread.scope.kind === "page" && thread.scope.ref
      ? checkPermission(store.pagePermissions(thread.scope.ref), { perm: `plugin.${item.plugin}` }) : "ask";
    if (permission === "deny") throw new Error("This page denies the plugin.");
    return { ...plugins.component(item.plugin, item.component, item.props), plugin: item.plugin, thread, permission };
  }

  private componentCallRates = new Map<string, ComponentRate>();
  async componentPluginAction(threadId: string, itemId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let rate = this.componentCallRates.get(itemId);
    if (!rate) {
      if (this.componentCallRates.size >= 500) {
        const idle = [...this.componentCallRates].find(([, value]) => !value.active);
        if (!idle) throw new Error("Too many active components.");
        this.componentCallRates.delete(idle[0]);
      }
      rate = { at: Date.now(), count: 0, active: 0 }; this.componentCallRates.set(itemId, rate);
    }
    return limitComponentAction(rate, () => this.performComponentPluginAction(threadId, itemId, input, signal));
  }

  private async performComponentPluginAction(threadId: string, itemId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const current = this.componentPlugin(threadId, itemId), { definition, plugin, thread, permission } = current;
    const initialApproval = thread.approval;
    const op = input.op, key = String(input.key ?? ""), method = String(input.method ?? "");
    let needsConsent = true;
    if (op === "call") {
      if (!definition.methods.includes(method)) throw new Error("Component method is not declared.");
      const def = plugins!.get(plugin).manifest.methods[method];
      if (!def?.agent) throw new Error("Method is not agent-callable.");
      if (thread.approval === "readonly" && def.agent !== "read") throw new Error("Method requires Board or higher access.");
      needsConsent = def.agent === "ask";
    } else if (op === "state") {
      if (!key || key.length > 200 || !componentStateAllowed(definition.state, key)) throw new Error("Component state key is not declared.");
    } else if (op === "listen") {
      if (!definition.events.length && !definition.state.length) throw new Error("Component has no live declarations.");
    } else if (op === "subscribe") {
      if (!definition.events.includes(String(input.event))) throw new Error("Component event is not declared.");
    } else throw new Error("Unknown plugin component operation.");
    if (needsConsent && permission !== "allow" && thread.approval !== "full" && !thread.pluginGrants?.includes(plugin)) {
      if (!(await this.requestPluginApproval(threadId, `Use ${current.name}`, op === "call" ? method : key || String(input.event), true, plugin, { signal })).allowed) throw new Error("Plugin access denied. Allow the plugin on this page or for this thread.");
    }
    // Approval can outlive an update, disable or permission change.
    const latest = this.componentPlugin(threadId, itemId);
    if (signal?.aborted) throw new Error("Component request cancelled.");
    if (latest.hash !== current.hash || latest.thread.approval !== initialApproval || latest.permission !== permission) throw new Error("Plugin or thread changed; retry the operation.");
    if (op === "call") return plugins!.call(plugin, method, componentJson(input.args ?? {}), { kind: "agent", thread: threadId, ...(thread.scope.kind === "page" && thread.scope.ref ? { page: thread.scope.ref } : {}) });
    if (op === "state") return plugins!.database.get(plugin, key);
    return { ok: true };
  }

  async showComponent(threadId: string, input: ComponentInput, signal?: AbortSignal): Promise<unknown> {
    const spec = parseComponentInput(input);
    const run = this.runs.get(threadId);
    if (!run) throw new Error("component_show only works while this chat thread has a turn running.");
    if (spec.plugin) {
      const thread = this.requireThread(threadId);
      if (noPages(thread.scope) || !plugins) throw new Error("Plugin components need page access.");
      if (thread.scope.kind === "page" && thread.scope.ref && checkPermission(store.pagePermissions(thread.scope.ref), { perm: `plugin.${spec.plugin}` }) === "deny") throw new Error("This page denies the plugin.");
      plugins.component(spec.plugin, spec.component!, spec.props);
    }
    this.closeBlocks(run);
    const item = this.addItem(threadId, run.turn.id, { kind: "component", ...spec, wait: spec.wait === true, status: spec.wait ? "pending" : "shown" });
    const answer = spec.wait ? this.waitPending<ComponentAnswer>(threadId, run, "component", item.id, signal) : undefined;
    // Register the wait immediately so a fast click cannot race the bounded diagnostic pass.
    if (answer) void answer.catch(() => {});
    const problems = spec.plugin ? await this.componentProblems.collect(item.id, 0, async captureSignal => {
      const current = this.componentPlugin(threadId, item.id);
      const report = await probeComponent({ ...item, html: current.html } as ComponentItem, captureSignal);
      const boot = this.componentProblems.boot(item.id, 0);
      if (boot && report && typeof report === "object") this.componentProblems.report(item.id, { ...report, token: boot.token });
    }) : [];
    if (!answer) return { shown: true, itemId: item.id, text: spec.fallback ?? spec.title ?? "Component shown in chat.", ...(problems.length ? { problems } : {}) };
    const result = await answer;
    return problems.length ? { ...result, problems } : result;
  }

  updateComponent(threadId: string, itemId: string, change: Record<string, unknown>): { ok: true; link?: string } {
    const item = this.componentItem(threadId, itemId);
    if (change.action === "problems") { this.componentProblems.report(itemId, change.report); return { ok: true }; }
    if (change.action === "open") return { ok: true, link: componentLink(change.link) };
    if (change.action === "local" || change.action === "summary") {
      let rate = this.componentWrites.get(itemId);
      if (!rate || Date.now() - rate.at >= 1000) {
        rate = { at: Date.now(), count: 0 };
        this.componentWrites.delete(itemId);
        this.componentWrites.set(itemId, rate);
        if (this.componentWrites.size > 500) this.componentWrites.delete(this.componentWrites.keys().next().value!);
      }
      if (++rate.count > 10) throw new Error("Component updates are too frequent; coalesce view state updates.");
    }
    if (change.action === "local") {
      const local = componentJson(change.local);
      if (!local || typeof local !== "object" || Array.isArray(local)) throw new Error("local must be an object.");
      item.local = local as Record<string, unknown>;
    } else if (change.action === "summary") {
      item.summary = componentString(change.summary, "summary", 8000);
    } else if (change.action === "reply" || change.action === "skip") {
      if (item.wait) {
        const pending = this.pending.get(itemId);
        if (!pending || pending.kind !== "component" || item.status !== "pending") throw new Error("This component is no longer waiting.");
        const skip = change.action === "skip";
        const summary = skip ? "" : componentString(change.summary, "summary", 8000);
        const data = skip ? null : componentJson(change.data);
        this.pending.delete(itemId);
        item.status = skip ? "skipped" : "answered";
        if (!skip) item.summary = summary;
        this.touch(item);
        pending.resolve(skip ? { skipped: true } : { answered: true, data, summary });
        return { ok: true };
      }
      if (change.action === "skip") throw new Error("This component is not waiting.");
      const summary = componentString(change.summary, "summary", 8000).trim();
      if (!summary) throw new Error("A summary is required to send a component reply.");
      componentJson(change.data);
      item.summary = summary;
      this.send(threadId, { text: summary, from: "component" });
    } else throw new Error("Unknown component action.");
    this.touch(item);
    return { ok: true };
  }

  private makeSink(threadId: string, run: RunState): RunSink {
    const turnId = run.turn.id;
    const host = this;
    const thread = () => host.threads.get(threadId);
    const waitFor = <T>(kind: Pending["kind"], itemId: string, signal?: AbortSignal): Promise<T> => host.waitPending<T>(threadId, run, kind, itemId, signal);

    return {
      images(sourceId, images, parentToolId) {
        if (!thread() || !images.length) return;
        host.closeBlocks(run);
        const refs: FileRef[] = [];
        if (images.length > 10) host.addItem(threadId, turnId, { kind: "notice", level: "warn", text: "Only the first 10 images from this result were saved." });
        for (const image of images.slice(0, 10)) {
          try { refs.push(saveOutputImage(threadId, image)); }
          catch (err) { host.addItem(threadId, turnId, { kind: "notice", level: "warn", text: `Could not save agent image: ${(err as Error).message}` }); }
        }
        if (!refs.length) return;
        run.turn.outputAt = Date.now();
        const previous = host.loadItems(threadId).find((it) => it.turnId === turnId && it.kind === "images" && it.sourceId === sourceId);
        if (previous?.kind === "images") {
          previous.images = refs;
          host.touch(previous);
        } else {
          const tool = run.tools.get(sourceId);
          const parent = parentToolId ?? (tool?.kind === "tool" ? tool.parentToolId : undefined);
          host.addItem(threadId, turnId, { kind: "images", sourceId, images: refs, ...(parent ? { parentToolId: parent } : {}) });
        }
      },
      nativeId(id) {
        const t = thread();
        if (t && t.nativeId !== id) {
          t.nativeId = id;
          host.db.saveThread(t);
        }
      },
      text(delta, parentToolId) {
        if (!delta) return;
        run.turn.outputAt = Date.now();
        if (!parentToolId) (run.clock ??= { waits: [] }).firstAt ??= run.turn.outputAt;
        if (parentToolId) {
          // A subagent's message, whole: one nested item each, shown under the tool call that started it.
          if (run.tools.has(parentToolId)) host.hookBlock(run, host.addItem(threadId, turnId, { kind: "text", text: delta, parentToolId }));
          return;
        }
        if (run.reasoningItem) {
          const closed = run.reasoningItem;
          if (closed.kind === "reasoning") closed.endedAt = Date.now();
          host.touch(closed);
          run.reasoningItem = null;
          host.hookBlock(run, closed);
        }
        if (!run.textItem) {
          run.textItem = host.addItem(threadId, turnId, { kind: "text", text: "" });
        }
        host.appendText(run.textItem as Item & { text: string }, delta);
        host.hookEarly(run, run.textItem as Item & { text: string });
      },
      reasoning(delta, parentToolId) {
        if (!delta) return;
        run.turn.outputAt = Date.now();
        if (!parentToolId) (run.clock ??= { waits: [] }).firstAt ??= run.turn.outputAt;
        if (parentToolId) {
          const now = Date.now();
          if (run.tools.has(parentToolId)) host.hookBlock(run, host.addItem(threadId, turnId, { kind: "reasoning", text: delta, startedAt: now, endedAt: now, parentToolId }));
          return;
        }
        if (run.textItem) {
          const closed = run.textItem;
          host.flushDelta(closed.id);
          run.textItem = null;
          host.hookBlock(run, closed);
        }
        if (!run.reasoningItem) {
          run.reasoningItem = host.addItem(threadId, turnId, { kind: "reasoning", text: "", startedAt: Date.now() });
        }
        host.appendText(run.reasoningItem as Item & { text: string }, delta);
      },
      breakBlock() {
        host.closeBlocks(run);
      },
      checkpoint(id) {
        run.turn.nativeEnd = id;
      },
      toolStart(tool: ToolStart) {
        if (run.tools.has(tool.toolId)) return;
        run.turn.outputAt = Date.now();
        if (!tool.parentToolId) (run.clock ??= { waits: [] }).firstAt ??= run.turn.outputAt;
        host.closeBlocks(run);
        const item = host.addItem(threadId, turnId, {
          kind: "tool",
          toolId: tool.toolId,
          name: tool.name,
          tool: tool.tool,
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          ...(tool.input !== undefined ? { input: tool.input } : {}),
          ...(tool.paths ? { paths: tool.paths } : {}),
          ...(tool.parentToolId ? { parentToolId: tool.parentToolId } : {}),
          status: tool.status ?? "pending",
          startedAt: Date.now(),
        });
        run.tools.set(tool.toolId, item);
        if (tool.held) run.hooks.gated.add(tool.toolId);
        if (tool.paths && (tool.tool === "edit" || tool.tool === "delete")) {
          for (const file of tool.paths) void host.rememberBefore(run, thread(), file);
        }
        // "pending" is a call still being written (Claude streams the input); its hook waits for the whole call.
        if (item.kind === "tool" && item.status !== "pending") host.hookToolCall(run, item);
      },
      toolUpdate(toolId: string, patch: ToolPatch) {
        const item = run.tools.get(toolId);
        if (!item || item.kind !== "tool") return;
        if (patch.title) item.title = patch.title;
        if (patch.detail) item.detail = patch.detail;
        if (patch.input !== undefined) item.input = patch.input;
        if (patch.paths) {
          item.paths = patch.paths;
          if (item.tool === "edit" || item.tool === "delete") {
            for (const file of patch.paths) void host.rememberBefore(run, thread(), file);
          }
        }
        if (patch.output !== undefined) {
          item.output = patch.output.length > MAX_TOOL_OUTPUT ? `${patch.output.slice(0, MAX_TOOL_OUTPUT)}\n…` : patch.output;
          // The hooks read more than is stored, so an injection late in a long result is seen too.
          if (patch.output.length > MAX_TOOL_OUTPUT) (run.hooks.outputs ??= new Map()).set(toolId, clipChunk(patch.output, MAX_HOOK_OUTPUT));
          else run.hooks.outputs?.delete(toolId);
        }
        if (patch.exitCode !== undefined) item.exitCode = patch.exitCode;
        const finished = patch.status === "done" || patch.status === "error";
        if (patch.status) item.status = patch.status;
        if (finished) item.endedAt = Date.now();
        host.touch(item);
        if (patch.status) host.hookToolCall(run, item);
        if (finished) host.hookToolResult(run, item);
        if (finished && (item.tool === "edit" || item.tool === "delete" || item.tool === "move") && item.paths?.length) {
          void host.computeToolDiff(run, thread(), item, patch.providerDiff);
        } else if (patch.providerDiff?.length && finished) {
          void host.computeToolDiff(run, thread(), item, patch.providerDiff);
        }
      },
      async beforeWrite(_toolId, file) {
        await host.rememberBefore(run, thread(), file, true);
      },
      approval(req: ApprovalRequest, signal) {
        const decide = async (req: ApprovalRequest, wait: AbortSignal | undefined = signal): Promise<ApprovalDecision> => {
          const t = thread();
          const auto = autoApproval(t, req);
          if (auto) return auto;
          const allow = req.options.find((o) => o.kind === "allow_once");
          if (req.toolId && run.hooks.approved.has(req.toolId)) {
            // The user approved this very call a moment ago, when the hook asked.
            if (allow) return Promise.resolve({ optionId: allow.id });
          }
          // A file, folder or command the user already allowed for this thread, or a command on their allowlist (#743).
          if (t && allow && grantAllows(t, req, host.prefs().commandAllowlist)) return { optionId: allow.id };
          if (t?.provider === "pi" && t.approval === "auto" && req.tool === "execute" && !req.humanOnly && allow) {
            const workspace = t.worktree?.path ?? t.cwd;
            const review = await reviewNativeCommand(
              (state, questions, options) => host.hookBackend.decide(state, questions, options),
              req.detail ?? "", workspace, run.hooks.lastUser,
            );
            if (run.cancelled || wait?.aborted || host.runs.get(threadId) !== run) throw new Error("Auto review cancelled.");
            // Recheck after the asynchronous review: settings may have changed while it waited.
            const current = thread();
            if (review.allowed && current?.provider === "pi" && current.approval === "auto" && (current.worktree?.path ?? current.cwd) === workspace) {
              return { optionId: allow.id };
            }
            req = { ...req, detail: [req.detail, review.reason].filter(Boolean).join("\n\n") };
          }
          const extra = t && allow ? grantOptions(t, req) : [];
          const item = host.addItem(threadId, turnId, {
            kind: "approval",
            requestId: "",
            ...(req.toolId ? { toolId: req.toolId } : {}),
            tool: req.tool,
            title: req.title,
            ...(req.detail ? { detail: req.detail } : {}),
            options: withGrantOptions(req.options, extra),
            status: "pending",
          });
          const decision = await waitFor<ApprovalDecision>("approval", item.id, wait);
          // One of Scribe's lasting options: keep the grant, and answer the provider with its own allow.
          if (allow && extra.some((o) => o.id === decision.optionId)) {
            host.recordToolGrant(threadId, req, decision.optionId);
            return { optionId: allow.id };
          }
          return decision;
        };
        /** Ask, refused with `timeout` once `waitMs` passes unanswered (null: wait for the user). */
        const decideBy = (asked: ApprovalRequest, reason: string | undefined, waitMs: number | null, timeout: string): Promise<ApprovalDecision> => {
          asked = { ...asked, detail: [asked.detail, reason, waitMs !== null ? refusedBy(waitMs) : ""].filter(Boolean).join("\n\n") };
          const deadline = withDeadline(waitMs, signal);
          return decide(asked, deadline.signal)
            .catch((err: unknown) => {
              if (!deadline.timedOut()) throw err;
              const reject = req.options.find((o) => o.kind === "reject_once") ?? req.options.find((o) => o.kind === "reject_always");
              if (!reject) throw new Error(timeout);
              return { optionId: reject.id, note: timeout };
            })
            .finally(deadline.done);
        };
        // Read-only and Board run commands outside any sandbox here: each one asks, and an unanswered one is refused (#720).
        const t = thread();
        const readCommand = req.tool === "execute" && t !== undefined && readShell(t);
        const plain = (): Promise<ApprovalDecision> =>
          readCommand ? decideBy(req, `The ${APPROVAL_LABEL[t!.approval]} rung asks before every command; allow only ones that change nothing.`, READ_SHELL_WAIT_MS, READ_SHELL_TIMEOUT) : decide(req);
        // A hook can only tighten this: deny the call, or have the user decide whatever the approval level.
        const gate = host.approvalGate(threadId, run, req);
        if (!gate) return plain();
        return gate.then((hook) => {
          if (hook?.kind === "block") {
            const reject = req.options.find((o) => o.kind === "reject_once") ?? req.options.find((o) => o.kind === "reject_always");
            if (!reject) throw new Error(hook.reason);
            return { optionId: reject.id, note: hook.reason };
          }
          if (hook?.kind !== "ask") return plain();
          // Nobody may be watching a worker's thread: its ask is refused once the wait is up.
          if (readCommand) return decideBy({ ...req, humanOnly: true }, hook.reason, READ_SHELL_WAIT_MS, READ_SHELL_TIMEOUT);
          return decideBy({ ...req, humanOnly: true }, hook.reason, host.unattended(threadId) ? HOOK_ASK_WAIT_MS : null, HOOK_ASK_TIMEOUT);
        });
      },
      question(req: QuestionRequest, signal) {
        const item = host.addItem(threadId, turnId, { kind: "question", requestId: "", ...(req.title ? { title: req.title } : {}), questions: req.questions, ...(req.display ? { display: req.display } : {}), status: "pending" });
        return waitFor<QuestionAnswer>("question", item.id, signal);
      },
      todos(todos) {
        const existing = [...host.loadItems(threadId)].reverse().find((item) => item.turnId === turnId && item.kind === "todos");
        if (existing && existing.kind === "todos") {
          existing.todos = todos;
          host.touch(existing);
        } else {
          host.closeBlocks(run);
          host.addItem(threadId, turnId, { kind: "todos", todos });
        }
      },
      usage(usage) {
        const t = thread();
        if (t && usage.contextWindow && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0) {
          const key = `contextWindow:${t.provider}:${run.turn.model}`;
          if (host.db.getSetting(key, 0) !== usage.contextWindow) host.db.setSetting(key, usage.contextWindow);
        }
        run.usage = { ...run.usage, ...Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined)) };
        run.turn.usage = run.usage;
        host.emit({ type: "agent_turn", turn: run.turn });
      },
      notice(level, text) {
        host.closeBlocks(run);
        host.addItem(threadId, turnId, { kind: "notice", level, text });
      },
      commands(list) {
        const t = thread();
        if (t && list.length) host.rememberCommands(t.provider, list);
      },
      title(title) {
        const t = thread();
        if (t && !t.titleLocked && title && title !== t.title) {
          t.title = title.slice(0, 120);
          host.db.saveThread(t);
          host.emitThread(threadId);
        }
      },
      steered(steerId) {
        if (run.steer?.id !== steerId) return;
        const itemId = run.steer.itemId;
        run.steer = null;
        const item = itemId ? host.loadItems(threadId).find((it) => it.id === itemId) : undefined;
        if (item && item.kind === "user") {
          // It now belongs to this turn, at the point the agent read it.
          host.closeBlocks(run);
          const seq = (host.seq.get(threadId) ?? 0) + 1;
          host.seq.set(threadId, seq);
          item.seq = seq;
          const items = host.loadItems(threadId);
          items.splice(items.indexOf(item), 1);
          items.push(item);
          item.turnId = turnId;
          item.steer = "folded";
          host.touch(item);
        }
        host.emitThread(threadId);
      },
    };
  }

  // ---------- hooks (hooks.ts) ----------

  private hookDetectors(): Detector[] {
    this.ruleDetectors ??= ruleDetectors(this.prefs().hookRules);
    return this.detectors.length ? [...this.detectors, ...this.ruleDetectors] : this.ruleDetectors;
  }

  /** The user's hook rules, and whether a classifier is there for the ones that ask it. */
  hookSettings(): { rules: HookRule[]; classifier: boolean } {
    const view = mlService().view();
    return { rules: this.prefs().hookRules, classifier: view.sources.length > 0 && view.features.some((feature) => feature.id === HOOKS_FEATURE && feature.on) };
  }

  private hookChunk(thread: Thread, run: RunState | undefined, event: HookEvent, part: Pick<Chunk, "text"> & Partial<Chunk>): Chunk {
    const lastUser = run?.hooks.lastUser;
    return {
      event,
      threadId: thread.id,
      turnId: run?.turn.id ?? null,
      provider: thread.provider,
      mode: thread.mode,
      worker: this.unattended(thread.id),
      ...(lastUser ? { lastUser } : {}),
      ...(run?.hooks.dock ? { dock: true } : {}),
      ...(run?.hooks.suspect ? { suspect: run.hooks.suspect } : {}),
      ...(thread.cwd ? { cwd: thread.cwd } : {}),
      ...part,
    };
  }

  /**
   * An observing hook: rules run now, classifier questions in the background, and nothing here
   * waits, so the stream is never delayed. `part` is only built when some detector watches the event.
   */
  private observe(threadId: string, run: RunState, event: HookEvent, part: () => Pick<Chunk, "text"> & Partial<Chunk>): void {
    const thread = this.threads.get(threadId);
    if (!thread || thread.hooksOff || this.hooks.idle(event, false, Boolean(run.hooks.suspect))) return;
    const chunk = this.hookChunk(thread, run, event, part());
    if (!chunk.text.trim()) return;
    const { found, open } = this.hooks.rules(chunk);
    this.applyFindings(chunk, run, found, false);
    if (open.length) void this.hooks.classify(chunk, open, OBSERVE_DEADLINE_MS).then((late) => this.applyFindings(chunk, run, late, true));
  }

  private hookPrompt(threadId: string, run: RunState, msg: QueuedMessage, item: Item): void {
    // A hook's own note to the agent is not a prompt to detect on, or one rule could feed itself.
    if (msg.from === "hook" || !msg.text) return;
    // Only what was typed or sent: not the page context or memory blocks Scribe adds around it.
    // A message steered into the turn says where it was typed itself.
    this.observe(threadId, run, "prompt", () => ({ text: clipChunk(msg.text), itemId: item.id, dock: Boolean(msg.dock), ...this.openPage(threadId, msg) }));
  }

  /** The page a floating-chat message is typed over: the classifier's context for the page-intent question. */
  private openPage(threadId: string, msg: QueuedMessage): { page?: string } {
    const thread = this.threads.get(threadId);
    const title = msg.dock && thread ? this.scopeInfo(thread).page?.title : "";
    return title ? { page: title.slice(0, 200) } : {};
  }

  /** A text or thinking block closed. */
  private hookBlock(run: RunState, item: Item): void {
    if (item.kind !== "text" && item.kind !== "reasoning") return;
    this.observe(item.threadId, run, item.kind, () => ({ text: clipChunk(item.text), itemId: item.id }));
  }

  /** A text block's opening, once: "I'll build you a page for that" comes first. */
  private hookEarly(run: RunState, item: Item & { text: string }): void {
    if (run.hooks.earlyItem === item.id || !this.hooks.early()) return;
    const end = earlyEnd(item.text);
    if (end === null) return;
    run.hooks.earlyItem = item.id;
    this.observe(item.threadId, run, "text", () => ({ text: item.text.slice(0, end), itemId: item.id, early: true }));
  }

  private hookToolCall(run: RunState, item: Item): void {
    if (item.kind !== "tool" || run.hooks.called.has(item.toolId)) return;
    run.hooks.called.add(item.toolId);
    this.observe(item.threadId, run, "tool_call", () => ({
      text: toolCallText(item),
      itemId: item.id,
      tool: { toolId: item.toolId, name: item.name, kind: item.tool, title: item.title, ...(item.paths ? { paths: item.paths } : {}), ...(item.input !== undefined ? { input: item.input } : {}) },
    }));
  }

  private hookToolResult(run: RunState, item: Item): void {
    if (item.kind !== "tool") return;
    const output = run.hooks.outputs?.get(item.toolId) ?? item.output;
    run.hooks.outputs?.delete(item.toolId);
    this.observe(item.threadId, run, "tool_result", () => ({
      text: output ? clipChunk(output) : "",
      ...(output ? { full: output } : {}),
      itemId: item.id,
      tool: { toolId: item.toolId, name: item.name, kind: item.tool, title: item.title, ...(item.paths ? { paths: item.paths } : {}) },
    }));
  }

  /**
   * A result of one of Scribe's own tools, before the agent gets it (SessionContext.scanResult, and
   * POST /api/tool-scan for the MCP's tools). The detectors that read held results get SCAN_HOLD_MS:
   * what they would tell the agent comes back as a note to put in front of the result. A slower
   * answer is applied when it arrives, like one on an observed result, and a classifier that is
   * down leaves the result as it is (fail open).
   */
  async scanResult(threadId: string, call: ToolScanCall): Promise<string | null> {
    const thread = this.threads.get(threadId);
    const run = this.runs.get(threadId);
    if (!thread || !run || thread.hooksOff || !call.text.trim()) return null;
    // The MCP does not know the id the stream shows its call under: the newest running call of that tool is it.
    const item = call.toolId
      ? run.tools.get(call.toolId)
      : [...run.tools.values()].reverse().find((it) => it.kind === "tool" && it.status !== "done" && it.status !== "error" && (it.name.endsWith(call.name) || it.title.includes(call.name)));
    const chunk = this.hookChunk(thread, run, "tool_result", {
      text: clipChunk(call.text),
      full: call.text,
      held: true,
      ...(item ? { itemId: item.id } : {}),
      tool: { ...(call.toolId ? { toolId: call.toolId } : {}), name: call.name, kind: call.tool, ...(call.title ? { title: call.title } : {}) },
    });
    const { found, open } = this.hooks.rules(chunk);
    const asked = open.length ? this.hooks.classify(chunk, open, OBSERVE_DEADLINE_MS) : Promise.resolve([]);
    let timer: NodeJS.Timeout | undefined;
    const slow = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SCAN_HOLD_MS);
    });
    const answered = await Promise.race([asked, slow]);
    clearTimeout(timer);
    if (!answered) void asked.then((late) => this.applyFindings(chunk, run, late, true));
    const all = [...found, ...(answered ?? [])];
    const notes: string[] = [];
    for (const finding of all) {
      if (finding.action.kind !== "context" || run.hooks.told.has(finding.detector)) continue;
      // It goes with the result, so it is not steered into the turn as well.
      run.hooks.told.add(finding.detector);
      notes.push(finding.action.text);
    }
    this.applyFindings(chunk, run, all.filter((finding) => finding.action.kind !== "context"), false);
    return notes.length ? notes.join("\n\n") : null;
  }

  private flagItem(threadId: string, itemId: string | undefined, finding: Finding): void {
    const item = itemId ? this.loadItems(threadId).find((it) => it.id === itemId) : undefined;
    const action = finding.action.kind;
    if (!item || (action !== "flag" && action !== "ask" && action !== "block")) return;
    if (item.flags?.some((flag) => flag.id === finding.detector && flag.action === action)) return;
    const label = (finding.action.kind === "flag" && finding.action.label) || finding.label;
    const reason = finding.action.kind === "block" ? finding.action.reason : finding.reason;
    item.flags = [...(item.flags ?? []), { id: finding.detector, label, action, ...(reason ? { reason } : {}) }];
    this.touch(item);
  }

  /** What an observing hook's findings do. `late`: a classifier answer that came after the chunk went by. */
  private applyFindings(chunk: Chunk, run: RunState, found: Finding[], late: boolean): void {
    if (!found.length || !this.threads.has(chunk.threadId)) return;
    const live = this.runs.get(chunk.threadId) === run;
    for (const finding of found) {
      const action = finding.action;
      if (action.kind === "signal") {
        this.emit({
          type: "agent_intent",
          threadId: chunk.threadId,
          turnId: chunk.turnId,
          ...(chunk.itemId ? { itemId: chunk.itemId } : {}),
          name: action.name,
          ...(action.stage ? { stage: action.stage } : {}),
          ...(action.title ? { title: action.title } : {}),
          detector: finding.detector,
          event: chunk.event,
          ...(chunk.early ? { early: true } : {}),
          ...(finding.confidence !== undefined ? { confidence: finding.confidence } : {}),
        });
      } else if (action.kind === "context") {
        // Once per detector and turn: a rule that matches every tool call must not flood the agent.
        if (!live || run.hooks.told.has(finding.detector)) continue;
        run.hooks.told.add(finding.detector);
        this.tellAgent(chunk.threadId, action.text);
      } else if (action.kind === "suspect") {
        if (live) run.hooks.suspect ??= action.reason;
      } else {
        this.flagItem(chunk.threadId, chunk.itemId, finding);
      }
    }
    const strongest = verdict(found);
    if (!strongest || !live) return;
    const toolId = chunk.event === "tool_call" ? chunk.tool?.toolId : undefined;
    if (chunk.event === "tool_call" && chunk.tool) {
      const thread = this.threads.get(chunk.threadId)!;
      // Held elsewhere: by the provider's gate, or for Scribe's own tools where the daemon runs them (toolGate either way).
      if (holdsAll(thread.provider) || (toolId && run.hooks.gated.has(toolId))) return;
      // A classifier answer this late found the call already running: its flag is all that is left.
      if (late) return;
      if (toolId) {
        // Codex and Cursor report a call first and ask about it after, when they ask at all.
        const timer = setTimeout(() => {
          if (run.hooks.waiting.delete(toolId) && this.runs.get(chunk.threadId) === run) this.unheld(chunk, run, strongest);
        }, HOOK_GRACE_MS);
        timer.unref?.();
        run.hooks.waiting.set(toolId, { found, timer });
        return;
      }
    }
    this.unheld(chunk, run, strongest);
  }

  /** An ask or block on something that cannot be held: the strongest action left is stopping the turn. */
  private unheld(chunk: Chunk, run: RunState, strongest: NonNullable<ReturnType<typeof verdict>>): void {
    const name = chunk.tool?.title || chunk.tool?.name;
    const what = chunk.event === "tool_call" ? `the call ${name}` : chunk.event === "tool_result" ? `the result of ${name}` : chunk.event === "prompt" ? "this message" : "the agent's output";
    if (strongest.kind === "block") {
      // A finished turn has nothing left to stop.
      if (chunk.event === "turn_end") return;
      const reason = strongest.finding.action.kind === "block" ? strongest.finding.action.reason : "";
      this.closeBlocks(run);
      const unheld = chunk.event === "tool_call" ? ", which this provider does not let Scribe hold before it runs" : "";
      this.addItem(chunk.threadId, run.turn.id, { kind: "notice", level: "warn", text: `A hook (${strongest.finding.label}) stopped the turn on ${what}${unheld}. ${reason}`.trim() });
      void this.cancel(chunk.threadId, { keepQueue: true });
    } else if (chunk.event === "tool_call") {
      this.addItem(chunk.threadId, run.turn.id, { kind: "notice", level: "warn", text: `A hook (${strongest.finding.label}) wanted your approval for ${what}, but this provider does not let Scribe hold it: it ran without asking.` });
    }
  }

  /** The context action: the hook's note goes into the running turn as a steered message, or right after it. */
  private tellAgent(threadId: string, text: string): void {
    if (!this.runs.has(threadId)) return;
    try {
      const { queued } = this.send(threadId, { text, from: "hook" });
      if (queued && this.queues.get(threadId)?.length === 1) this.steerFirst(threadId);
    } catch (err) {
      log(`Hook context for ${threadId} was not sent: ${(err as Error).message}`);
    }
  }

  /**
   * A hook's say on a tool call that came as an approval request (Codex's own, Cursor's host shell,
   * a bridged MCP server). Null, at once, when no hook watches tool calls or a gate already held this
   * call, so an approval is then answered or shown as before, without a tick in between.
   */
  private approvalGate(threadId: string, run: RunState, req: ApprovalRequest): Promise<{ kind: "block" | "ask"; reason: string } | null> | null {
    const thread = this.threads.get(threadId);
    if (!thread || thread.hooksOff || this.hooks.idle("tool_call", true, Boolean(run.hooks?.suspect))) return null;
    // Scribe's board tools are held where the daemon runs them (toolGate).
    if (req.boardTool || holdsAll(thread.provider) || (req.toolId && run.hooks.gated.has(req.toolId))) return null;
    return this.heldApproval(thread, run, req);
  }

  private async heldApproval(thread: Thread, run: RunState, req: ApprovalRequest): Promise<{ kind: "block" | "ask"; reason: string } | null> {
    const threadId = thread.id;
    const waiting = req.toolId ? run.hooks.waiting.get(req.toolId) : undefined;
    const item = req.toolId ? run.tools.get(req.toolId) : undefined;
    let found: Finding[];
    if (waiting) {
      clearTimeout(waiting.timer);
      run.hooks.waiting.delete(req.toolId!);
      found = waiting.found;
    } else {
      const chunk = this.hookChunk(thread, run, "tool_call", {
        text: item?.kind === "tool" ? toolCallText(item) : toolCallText({ name: req.title, detail: req.detail, paths: req.paths }),
        ...(item ? { itemId: item.id } : {}),
        tool: { ...(req.toolId ? { toolId: req.toolId } : {}), name: item?.kind === "tool" ? item.name : req.title, kind: req.tool, title: req.title },
      });
      found = (await this.hooks.evaluate(chunk)).filter(isGating);
      for (const finding of found) this.flagItem(threadId, item?.id, finding);
    }
    if (req.toolId) run.hooks.gated.add(req.toolId);
    return hookSays(verdict(found));
  }

  /**
   * "Ask the host before this tool call" (SessionContext.toolGate, and POST /hooks/gate for Scribe's
   * own tools). Holds the call for the gating hooks: rules at once, the classifier within its budget,
   * and on a timeout or a failing backend the call goes ahead (fail open). A block denies it; an ask
   * waits for the user, whatever the thread's approval level.
   */
  async toolGate(threadId: string, call: ToolGateCall, signal?: AbortSignal): Promise<ToolGateResult> {
    const thread = this.threads.get(threadId);
    if (thread?.noTools) return { allowed: false, reason: "This thread has no tools. Answer from the conversation alone." };
    const run = this.runs.get(threadId);
    if (!thread || thread.hooksOff || this.hooks.idle("tool_call", true, Boolean(run?.hooks.suspect))) return { allowed: true };
    if (call.toolId) run?.hooks.gated.add(call.toolId);
    const waiting = call.toolId ? run?.hooks.waiting.get(call.toolId) : undefined;
    if (waiting) {
      clearTimeout(waiting.timer);
      run!.hooks.waiting.delete(call.toolId!);
    }
    const item = call.toolId ? run?.tools.get(call.toolId) : undefined;
    const chunk = this.hookChunk(thread, run, "tool_call", {
      text: toolCallText(call),
      ...(item ? { itemId: item.id } : {}),
      tool: { ...(call.toolId ? { toolId: call.toolId } : {}), name: call.name, kind: call.tool, ...(call.title ? { title: call.title } : {}), ...(call.paths ? { paths: call.paths } : {}) },
    });
    const found = (await this.hooks.evaluate(chunk)).filter(isGating);
    const says = hookSays(verdict(found));
    if (!says) return { allowed: true };
    for (const finding of found) this.flagItem(threadId, item?.id, finding);
    if (says.kind === "block") return { allowed: false, reason: says.reason };
    if (!run || this.runs.get(threadId) !== run) {
      return { allowed: false, reason: `${says.reason} With no turn running the user cannot be asked, so it was not run. Leave it out, and mention it in your result.` };
    }
    this.closeBlocks(run);
    const title = (call.title || call.name).slice(0, 300);
    const waitMs = this.unattended(threadId) ? HOOK_ASK_WAIT_MS : null;
    const detail = [call.detail ?? toolCallText({ name: "", input: call.input }), says.reason, waitMs !== null ? refusedBy(waitMs) : ""].filter(Boolean).join("\n\n");
    const approval = this.addItem(threadId, run.turn.id, {
      kind: "approval",
      requestId: "",
      ...(call.toolId ? { toolId: call.toolId } : {}),
      tool: call.tool,
      title,
      ...(detail ? { detail } : {}),
      options: [
        { id: "allow", label: "Allow once", kind: "allow_once" },
        { id: "deny", label: "Deny", kind: "reject_once" },
      ],
      status: "pending",
    });
    const deadline = withDeadline(waitMs, signal);
    try {
      const decision = await this.waitPending<ApprovalDecision>(threadId, run, "approval", approval.id, deadline.signal);
      if (decision.optionId !== "allow") return { allowed: false, reason: decision.note ? `The user denied this call: ${decision.note}` : "The user denied this call." };
      if (call.toolId) run.hooks.approved.add(call.toolId);
      return { allowed: true };
    } catch {
      return { allowed: false, reason: deadline.timedOut() ? HOOK_ASK_TIMEOUT : "The approval was cancelled." };
    } finally {
      deadline.done();
    }
  }

  private resolvePath(thread: Thread | undefined, file: string): string {
    const base = thread?.cwd || this.ctx.scratchDir;
    return path.resolve(base, file);
  }

  /** Remember a file's content before a tool writes it. `fresh` (from a pre-tool hook) always re-reads. */
  private async rememberBefore(run: RunState, thread: Thread | undefined, file: string, fresh = false): Promise<void> {
    const abs = this.resolvePath(thread, file);
    if (!fresh && run.known.has(abs)) return;
    if (!fresh && run.repo && run.turn.beforeTree) {
      const rel = repoRelative(run.repo, abs);
      if (rel) {
        run.known.set(abs, await fileAtTree(run.repo, run.turn.beforeTree, rel));
        return;
      }
    }
    run.known.set(abs, readText(abs));
  }

  private async computeToolDiff(
    run: RunState,
    thread: Thread | undefined,
    item: Item,
    providerDiff?: Array<{ path: string; oldText: string | null; newText: string | null }>
  ): Promise<void> {
    if (item.kind !== "tool") return;
    const paths = new Set([...(item.paths ?? []), ...(providerDiff?.map((d) => d.path) ?? [])]);
    const files: NonNullable<typeof item.files> = [];
    const patches: string[] = [];
    for (const file of paths) {
      const abs = this.resolvePath(thread, file);
      const reported = providerDiff?.find((d) => this.resolvePath(thread, d.path) === abs);
      let before: string | null | undefined = run.known.get(abs);
      if (before === undefined && run.repo && run.turn.beforeTree) {
        const rel = repoRelative(run.repo, abs);
        if (rel) before = await fileAtTree(run.repo, run.turn.beforeTree, rel);
      }
      if (before === undefined) before = reported ? reported.oldText : null;
      const after = fs.existsSync(abs) ? readText(abs) : reported?.newText ?? null;
      run.known.set(abs, after);
      const display = run.repo ? repoRelative(run.repo, abs) ?? abs : thread?.cwd ? path.relative(thread.cwd, abs).replaceAll("\\", "/") : abs;
      const diff = unifiedDiff(before, after, display);
      if (!diff.patch) continue;
      if (!run.repo) run.versions.set(display, { before: run.versions.has(display) ? run.versions.get(display)!.before : before, after });
      files.push({ path: display, added: diff.added, removed: diff.removed, status: before === null ? "A" : after === null ? "D" : "M" });
      patches.push(diff.patch);
    }
    if (!files.length) return;
    item.files = files;
    const patch = patches.join("");
    item.diff = patch.length > MAX_TOOL_DIFF ? `${patch.slice(0, MAX_TOOL_DIFF)}\n… (diff truncated)\n` : patch;
    this.touch(item);
  }

  // ---------- interactions ----------

  resolveApproval(requestId: string, optionId: string, note?: string): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.kind !== "approval") throw new Error("This approval is no longer waiting.");
    this.pending.delete(requestId);
    const item = this.loadItems(pending.threadId).find((it) => it.id === pending.itemId);
    if (item && item.kind === "approval") {
      item.status = "resolved";
      item.decision = optionId;
      if (note) item.note = note;
      this.touch(item);
    }
    pending.resolve({ optionId, note });
  }

  resolveQuestion(requestId: string, answer: QuestionAnswer): void {
    const pending = this.pending.get(requestId);
    if (pending?.kind === "component" && "skipped" in answer) {
      this.updateComponent(pending.threadId, pending.itemId, { action: "skip" });
      return;
    }
    if (!pending || pending.kind !== "question") throw new Error("This question is no longer waiting.");
    this.pending.delete(requestId);
    const item = this.loadItems(pending.threadId).find((it) => it.id === pending.itemId);
    if (item && item.kind === "question") {
      if ("skipped" in answer) {
        item.status = "skipped";
      } else {
        item.status = "answered";
        item.answers = answer.answers;
        if (answer.notes) item.notes = answer.notes;
      }
      this.touch(item);
    }
    pending.resolve(answer);
  }

  /**
   * The user's answer to a plan in the chat (#721, a plan turn that could not show a page). Accept
   * sends "Implement the plan" at the thread's own rung; changes with a note send a new plan turn.
   */
  resolvePlan(threadId: string, itemId: string, decision: PlanDecision): void {
    this.requireThread(threadId);
    const item = this.loadItems(threadId).find((it) => it.id === itemId);
    if (!item || item.kind !== "plan" || item.status !== "pending") throw new Error("This plan is no longer waiting.");
    item.status = decision.accepted ? "accepted" : "rejected";
    const note = decision.note?.trim();
    if (note) item.note = note;
    this.touch(item);
    if (decision.accepted) this.send(threadId, { text: implementText(note), from: "scribe", plan: false });
    else if (note) this.send(threadId, { text: `The user wants changes to the plan: ${note}`, from: "scribe", plan: true });
    else this.emitThread(threadId);
  }

  /**
   * The user's answer to a usage limit card (#78). Continue queues the thread to go on once the
   * limit resets (right away when it already has); dismiss leaves it, also after a Continue.
   */
  resolveUsageLimit(threadId: string, itemId: string, go: boolean, account?: string): void {
    const thread = this.requireThread(threadId);
    const item = this.loadItems(threadId).find((it) => it.id === itemId);
    if (!item || item.kind !== "usage_limit" || (item.status !== "pending" && !(item.status === "queued" && !go))) {
      throw new Error("This usage limit is no longer waiting.");
    }
    if (go && account) {
      // Another Claude account has room (#452): go on there now. The chat stays on it from here.
      if (thread.provider !== "claude" || !this.claudePool.isAccount(account)) throw new Error("That Claude account is no longer signed in.");
      thread.claudeAccount = account;
      this.db.saveThread(thread);
      item.status = "resumed";
      item.switched = this.claudePool.label(account);
      this.touch(item);
      this.limitResumes.delete(threadId);
      this.saveLimitResumes();
      this.send(threadId, { text: SWITCHED_ACCOUNT_PROMPT, from: "scribe" });
      return;
    }
    item.status = go ? "queued" : "dismissed";
    this.touch(item);
    if (go) this.limitResumes.set(threadId, itemId);
    else this.limitResumes.delete(threadId);
    this.saveLimitResumes();
    this.emitThread(threadId);
    if (go) this.checkLimitResumes();
  }

  /**
   * A page run's chat hit its Claude account's usage limit (#920): move it to another account with
   * room, shown in the chat as a limit card that went on there. Returns that account's label, or
   * null when there is none (one account, pinned, or all full).
   */
  private switchClaudeAccount(threadId: string): string | null {
    const thread = this.threads.get(threadId);
    if (thread?.provider !== "claude") return null;
    const to = this.claudePool.alternative(thread.claudeAccount);
    if (!to) return null;
    thread.claudeAccount = to.account;
    this.db.saveThread(thread);
    const turn = this.loadTurns(threadId).at(-1);
    this.addItem(threadId, turn?.id ?? null, { kind: "usage_limit", resetsAt: turn?.limitResetsAt ?? Date.now(), status: "resumed", switched: to.label });
    return to.label;
  }

  private saveLimitResumes(): void {
    this.db.setSetting("limitResumes", Object.fromEntries(this.limitResumes));
  }

  /** A new turn started: limit cards still open are past (the thread went on without them). */
  private settleLimitCards(threadId: string): void {
    for (const item of this.loadItems(threadId)) {
      if (item.kind !== "usage_limit" || (item.status !== "pending" && item.status !== "queued")) continue;
      item.status = "expired";
      this.touch(item);
    }
    if (this.limitResumes.delete(threadId)) this.saveLimitResumes();
  }

  /** Send queued threads on once their limit has reset and they are idle (#78). */
  private checkLimitResumes(): void {
    const now = Date.now();
    for (const [threadId, itemId] of [...this.limitResumes]) {
      const thread = this.threads.get(threadId);
      const item = thread ? this.loadItems(threadId).find((it) => it.id === itemId) : undefined;
      if (!thread || item?.kind !== "usage_limit" || item.status !== "queued") {
        this.limitResumes.delete(threadId);
        this.saveLimitResumes();
        continue;
      }
      if (now < item.resetsAt + RESUME_DELAY_MS) continue;
      if (this.runs.has(threadId) || this.resuming.has(threadId) || (this.status.get(threadId) ?? "idle") !== "idle" || this.queues.get(threadId)?.length) continue;
      if (thread.provider === "codex") {
        const last = this.db.listTurns(threadId).at(-1);
        if (last && !codexUsageRecoveryAllowed(this.planLimits.codex, last.endedAt ?? last.startedAt)) {
          void this.refreshCodexUsage();
          continue;
        }
      }
      item.status = "resumed";
      this.touch(item);
      this.limitResumes.delete(threadId);
      this.saveLimitResumes();
      try {
        this.send(threadId, { text: DEFAULT_RESUME_PROMPT, from: "scribe" });
      } catch (err) {
        // Try again on the next check.
        item.status = "queued";
        this.touch(item);
        this.limitResumes.set(threadId, itemId);
        this.saveLimitResumes();
        log(`Resuming ${threadId} after its usage limit failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * A plan turn ended (#721). Accepted on its page: the implementation turn to send next. With no
   * answer from a plan page, its last message is the plan, offered in the chat to accept or change.
   */
  private endPlanTurn(threadId: string, turn: Turn, run: RunState): QueuedMessage | null {
    if (run.plan?.accepted) {
      return { text: implementText(run.plan.notes, run.plan.page), images: [], files: [], saved: { images: [], files: [] }, context: [], from: "scribe" };
    }
    if (run.plan) return null;
    const last = [...this.loadItems(threadId)].reverse().find((it) => it.turnId === turn.id && it.kind === "text" && !it.parentToolId);
    if (last?.kind !== "text" || !last.text.trim()) return null;
    const plan = last as unknown as Record<string, unknown>;
    Object.assign(plan, { kind: "plan", requestId: last.id, title: "Plan", status: "pending" });
    this.touch(last);
    return null;
  }

  // ---------- worktrees ----------

  /**
   * Make the thread's worktree and move the thread into it. Runs at the start of its first turn, and
   * of the next turn after its branch was merged. reopened is a note for the agent in that case.
   */
  private async makeWorktree(threadId: string, turnId: string): Promise<{ thread: Thread; reopened: string }> {
    const home = this.requireThread(threadId).cwd!;
    const repo = await findRepo(home);
    let thread = this.requireThread(threadId);
    if (thread.retryWorktreeFrom) {
      const previous = this.threads.get(thread.retryWorktreeFrom);
      const wt = previous && openWorktree(previous);
      if (previous && wt) {
        if (previous.scope.kind !== "page" || previous.scope.ref !== thread.scope.ref ||
            workspaceKey(wt.home) !== workspaceKey(home) || !repo || workspaceKey(wt.repo) !== workspaceKey(repo)) {
          throw new Error(`The earlier chat's worktree at ${wt.path} belongs to a different workspace. Its work is kept there.`);
        }
        const idle = () => {
          for (const owner of [previous, ...this.sharers(previous.id, wt)]) {
            if (owner.id === threadId) continue;
            const info = this.runInfo(owner.id);
            if (info.exists && (info.running || (info.run && info.run.phase !== "ended"))) {
              throw new Error(`The earlier worktree at ${wt.path} is still in use by “${owner.title}”. Retry once that chat is idle.`);
            }
          }
        };
        idle();
        const status = await worktreeStatus(wt);
        if (!status.exists) throw new Error(`The earlier worktree at ${wt.path} is missing. Check that worktree before retrying.`);
        // Git yields: a helper or the earlier chat may have started or closed the worktree meanwhile.
        idle();
        if (openWorktree(this.requireThread(previous.id))?.path !== wt.path) {
          throw new Error(`The earlier worktree at ${wt.path} changed while preparing the retry. Retry again.`);
        }
        thread = { ...this.requireThread(threadId), worktree: { ...wt, ahead: status.ahead, dirty: Boolean(status.dirty.length) }, cwd: path.join(wt.path, path.relative(wt.repo, wt.home)) };
        delete thread.retryWorktreeFrom;
        this.threads.set(threadId, thread);
        this.db.saveThread(thread);
        const files = status.dirty.slice(0, 20).map((file) => `- ${file}`).join("\n");
        const note = `Reusing the earlier chat's worktree at ${wt.path}, on branch ${wt.branch}, with ${status.ahead} unmerged commit(s) and ${status.dirty.length} uncommitted file(s).`;
        this.addItem(threadId, turnId, { kind: "notice", level: "info", text: note });
        this.emitThread(threadId);
        return { thread, reopened: `<context>\n${note}\nThis is work left by the earlier attempt on this card. Inspect git status and the diff, keep the changes that are still needed, and continue from them. Read the card again before editing.${files ? `\nUncommitted files:\n${files}${status.dirty.length > 20 ? "\n(additional files omitted; see git status)" : ""}` : ""}\n</context>\n\n` };
      }
      // The previous branch was merged or deliberately closed before this turn started.
      delete thread.retryWorktreeFrom;
      this.db.saveThread(thread);
    }
    if (!repo) {
      thread = { ...thread, useWorktree: false };
      this.threads.set(threadId, thread);
      this.db.saveThread(thread);
      this.addItem(threadId, turnId, { kind: "notice", level: "info", text: "This folder is not in a git repository, so the thread works in it directly." });
      this.emitThread(threadId);
      return { thread, reopened: "" };
    }
    // A merged thread goes on in a worktree again, in the same folder when it can so its session resumes there.
    // An expired one (closed while it held nothing, #686) opens again the same way.
    const how = thread.worktree?.closed?.how;
    const merged = how === "merged" || how === "expired" ? thread.worktree : null;
    const made = merged ? await reopenWorktree(merged, thread.title) : { ...(await createWorktree(home, repo, thread.title)), sameFolder: false };
    // Re-read: settings can change while git runs.
    thread = { ...this.requireThread(threadId), worktree: made.worktree, cwd: made.cwd };
    if (merged && thread.nativeId && !made.sameFolder) {
      // The session belongs to the old folder: start a new one with a recap, as after a rewind.
      const kept = this.loadTurns(threadId).filter((t) => t.id !== turnId && t.status !== "running");
      const recap = kept.length ? this.recap(this.loadItems(threadId), kept) : "";
      thread = { ...thread, nativeId: null, ...(recap ? { rewind: { at: null, recap, migrated: true } } : {}) };
    }
    this.threads.set(threadId, thread);
    this.db.saveThread(thread);
    const from = made.worktree.base ?? made.worktree.baseCommit.slice(0, 8);
    this.addItem(threadId, turnId, {
      kind: "notice",
      level: "info",
      text: `${merged ? "New worktree" : "Worktree"} on ${made.worktree.branch}, from ${from}${merged ? " as it is now" : ""}.`,
    });
    for (const note of made.notes) this.addItem(threadId, turnId, { kind: "notice", level: "warn", text: note });
    this.emitThread(threadId);
    const reopened = merged
      ? `<context>\n${how === "expired" ? `This thread's worktree on branch ${merged.branch} held no changes and was removed after days without a turn.` : `Your earlier work on branch ${merged.branch} was merged into ${from}, and its worktree was removed.`} This thread now works in a new worktree${made.sameFolder ? " in the same folder" : ` at ${made.worktree.path}`}, on branch ${made.worktree.branch} from ${from} as it is now, which may hold other work merged since. Files may have changed since you last read them: read them again before you edit them.\n</context>\n\n`
      : "";
    return { thread, reopened };
  }

  async worktreeInfo(threadId: string): Promise<{ worktree: ThreadWorktree | null; status: WorktreeStatus | null }> {
    const thread = this.requireThread(threadId);
    const wt = openWorktree(thread);
    return { worktree: thread.worktree ?? null, status: wt ? await worktreeStatus(wt) : null };
  }

  /**
   * Merge the worktree's branch into its base, or leave the branch for later. Either way the folder
   * goes. A merged thread keeps its session, and its next message opens a worktree again from the
   * base as it is then (in the same folder when it can, where the session resumes). A left one goes
   * back to the main checkout with a new session.
   */
  async finishWorktree(threadId: string, how: "merge" | "leave" | "discard"): Promise<{ ok: true; message: string }> {
    // Another closure of this folder (a fork's Merge, a cleanup) goes first; this one then sees what it left.
    for (let held; (held = this.worktreeClosing(threadId)); ) await held.catch(() => {});
    if (this.runs.has(threadId)) throw new Error("Stop the running turn first.");
    const thread = this.requireThread(threadId);
    const wt = openWorktree(thread);
    if (!wt) throw new Error("This thread has no open worktree.");
    const busy = this.sharers(threadId, wt).find((t) => this.runs.has(t.id));
    if (busy) throw new Error(`“${busy.title}” works in this worktree too and is running. Stop it first.`);
    const message = await this.holdWorktree(wt.path, () => this.closeWorktree(thread, wt, how));
    if (how === "merge") await this.closeLandedWorktrees(wt.repo).catch((err) => log(`Checking other landed worktrees failed: ${(err as Error).message}`));
    return { ok: true, message };
  }

  /** Folders a closure is removing, by workspaceKey: turns and other closures of the folder wait for it (#736). */
  private worktreeClosures = new Map<string, Promise<unknown>>();

  /**
   * The closure removing the thread's open worktree right now, if any. Callers wait in a loop and
   * check the thread right after it, with no await in between, so nothing slips in before they act.
   */
  private worktreeClosing(threadId: string): Promise<unknown> | undefined {
    const thread = this.threads.get(threadId);
    const wt = thread && openWorktree(thread);
    return wt ? this.worktreeClosures.get(workspaceKey(wt.path)) : undefined;
  }

  /** Close the folder holding its lock. Call it right after the checks that allow the closure. */
  private holdWorktree<T>(dir: string, close: () => Promise<T>): Promise<T> {
    const key = workspaceKey(dir);
    if (this.worktreeClosures.has(key)) return Promise.reject(new Error("This worktree is already being closed."));
    const done = close().finally(() => this.worktreeClosures.delete(key));
    this.worktreeClosures.set(key, done);
    return done;
  }

  private async closeWorktree(thread: Thread, wt: ThreadWorktree, how: "merge" | "leave" | "discard"): Promise<string> {
    const threadId = thread.id;
    const sharers = this.sharers(threadId, wt);
    let message: string;
    if (how === "merge") {
      const { commits, base } = await mergeWorktree(wt);
      message = commits
        ? `Merged ${commits} commit${commits === 1 ? "" : "s"} from ${wt.branch} into ${base}.`
        : `${wt.branch} had no new commits, so there was nothing to merge.`;
      // Worktrees link the main checkout's node_modules, so a merged dependency change has to be installed there.
      if (commits) {
        const synced = await syncDependencies(wt.repo).catch((err) => `Checking node_modules after the merge failed: ${(err as Error).message}`);
        if (synced) message += ` ${synced}`;
      }
    } else if (how === "leave") {
      const committed = await commitAll(wt, `WIP: ${thread.title}`);
      message = `Left the work on branch ${wt.branch}${committed ? "; its uncommitted changes were committed there as WIP" : ""}.`;
    } else {
      message = `Discarded the work on branch ${wt.branch}.`;
    }
    // The provider process runs in the worktree folder; Windows will not remove a folder in use.
    for (const id of [threadId, ...sharers.map((t) => t.id)]) {
      this.sessions.get(id)?.dispose();
      this.sessions.delete(id);
      forgetGuides(id);
    }
    let cleanupWarning = "";
    try {
      if (how === "discard") {
        const deleted = await discardWorktree(wt);
        if (!deleted) message += ` The branch could not be deleted and remains in the repository.`;
      } else await removeWorktree(wt);
      if (how === "merge") await dropBranchIfEmpty(wt);
    } catch (err) {
      if (how !== "merge") throw err;
      // The merge has landed. Close the worktree even if cleanup fails, otherwise
      // the board asks the agent to rebase in a folder Git may already have removed.
      cleanupWarning = `Worktree cleanup failed: ${(err as Error).message}`;
      log(`${threadId}: ${cleanupWarning}`);
      message += ` ${cleanupWarning}`;
    }
    // Agent sessions are tied to their folder. Forks that shared the worktree can't all reopen its
    // folder, so only the thread itself keeps its session; the others start over in the main checkout.
    const closed = { how: how === "merge" ? ("merged" as const) : ("left" as const), at: Date.now() };
    // Again: a fork or helper made while Git worked shares the folder too.
    for (const id of [threadId, ...this.sharers(threadId, wt).map((t) => t.id)]) {
      const reopen = how === "merge" && id === threadId;
      const cur = this.requireThread(id);
      const next: Thread = {
        ...cur,
        cwd: wt.home,
        useWorktree: reopen,
        worktree: { ...wt, ahead: 0, dirty: false, closed: reopen ? closed : { ...closed, how: "left" } },
        nativeId: reopen ? cur.nativeId : null,
        updatedAt: Date.now(),
      };
      this.threads.set(id, next);
      this.db.saveThread(next);
      const by = id === threadId ? "" : ` (from “${thread.title}”, which shared it)`;
      // A merged thread goes on as before (the next message opens a new worktree); say only what changes.
      const after = reopen ? "" : " The next message starts a new agent session in the folder.";
      this.addItem(id, null, { kind: "notice", level: cleanupWarning ? "warn" : "info", text: `${message}${by}${cleanupWarning ? "" : " Worktree removed."}${after}` });
      this.emitThread(id);
    }
    this.flushNow();
    return message;
  }

  /** Other threads with the same worktree open: forks share it. */
  private sharers(threadId: string, wt: ThreadWorktree): Thread[] {
    const key = workspaceKey(wt.path);
    return [...this.threads.values()].filter((t) => t.id !== threadId && openWorktree(t) && workspaceKey(openWorktree(t)!.path) === key);
  }

  private worktreeTimer: NodeJS.Timeout | null = null;

  /** When a turn last ran in the thread's worktree, or when it was made. */
  private worktreeUsedAt(thread: Thread, wt: ThreadWorktree): number {
    const last = this.db.listTurns(thread.id).at(-1);
    return Math.max(wt.createdAt, last?.endedAt ?? last?.startedAt ?? 0);
  }

  /**
   * Open worktrees no turn has used for WORKTREE_IDLE_MS, with their changes now: one entry per
   * folder (forks and helpers share it), under the thread that used it last. Leaves out a worktree
   * while any of its threads is busy, queued or held by a page run (a board worker's).
   */
  private async idleWorktrees(minIdleMs = WORKTREE_IDLE_MS, repo?: string): Promise<Array<{ thread: Thread; wt: ThreadWorktree; usedAt: number; ahead: number; dirty: boolean }>> {
    const now = Date.now();
    const groups = new Map<string, Thread[]>();
    for (const thread of this.threads.values()) {
      const wt = openWorktree(thread);
      if (wt && (!repo || workspaceKey(wt.repo) === workspaceKey(repo))) groups.set(workspaceKey(wt.path), [...(groups.get(workspaceKey(wt.path)) ?? []), thread]);
    }
    const out = [];
    for (const threads of groups.values()) {
      const busy = threads.some((t) => {
        const run = this.pageRuns.get(t.id);
        return this.runs.has(t.id) || this.resuming.has(t.id) || (this.status.get(t.id) ?? "idle") !== "idle" || this.queues.get(t.id)?.length || (run && run.phase !== "ended");
      });
      if (busy) continue;
      const used = threads.map((t) => ({ t, at: this.worktreeUsedAt(t, openWorktree(t)!) })).sort((a, b) => b.at - a.at);
      const usedAt = used[0].at;
      // A helper's turns count, but the worktree is listed and kept under a thread of the user's.
      const owner = (used.find((u) => !u.t.helperOf) ?? used[0]).t;
      const wt = openWorktree(owner)!;
      if (now - usedAt < minIdleMs || !fs.existsSync(wt.path)) continue;
      const progress = await worktreeRemaining(wt).catch(() => null);
      if (progress) out.push({ thread: owner, wt, usedAt, ...progress });
    }
    return out;
  }

  /** Close idle worktrees that hold no changes; the next message to their thread opens one again (#686). */
  private sweepWorktrees(): void {
    void (async () => {
      for (const { thread, wt, ahead, dirty } of await this.idleWorktrees()) {
        if (ahead || dirty || this.closed) continue;
        await this.expireWorktree(thread.id, wt).catch((err) => log(`${thread.id}: closing its unused worktree failed: ${(err as Error).message}`));
      }
    })()
      .catch((err) => log(`Worktree sweep failed: ${(err as Error).message}`))
      .finally(() => {
        if (this.closed) return;
        this.worktreeTimer = setTimeout(() => this.sweepWorktrees(), WORKTREE_SWEEP_EVERY_MS);
        this.worktreeTimer.unref?.();
      });
  }

  /** A merge can land another thread's patches too; close that folder without waiting days. */
  private async closeLandedWorktrees(repo: string): Promise<void> {
    for (const { thread, wt, ahead, dirty } of await this.idleWorktrees(0, repo)) {
      if (ahead || dirty || this.closed) continue;
      // Leave newly opened, unused worktrees available for their first turn.
      const status = await worktreeStatus(wt);
      if ((await headCommit(wt.path)) === wt.baseCommit && !status.dirty.length) continue;
      await this.expireWorktree(thread.id, wt, true).catch((err) => log(`${thread.id}: closing its landed worktree failed: ${(err as Error).message}`));
    }
  }

  private async expireWorktree(threadId: string, wt: ThreadWorktree, landed = false): Promise<void> {
    // Another closure of the folder goes first; the Git check runs again after it, on what it left.
    let remaining: { ahead: number; dirty: boolean };
    do {
      for (let held; (held = this.worktreeClosing(threadId)); ) await held.catch(() => {});
      // The same worktree, not one a turn has opened again in its folder since.
      const open = this.threads.has(threadId) ? openWorktree(this.threads.get(threadId)!) : null;
      if (!open || open.path !== wt.path || open.createdAt !== wt.createdAt) return;
      remaining = await worktreeRemaining(wt);
    } while (this.worktreeClosing(threadId));
    const ids = [threadId, ...this.sharers(threadId, wt).map((t) => t.id)];
    // Git checks yield: a message or helper may have started since the sweep collected this folder.
    if (remaining.ahead || remaining.dirty || ids.some((id) => {
      const run = this.pageRuns.get(id);
      return this.runs.has(id) || this.resuming.has(id) || (this.status.get(id) ?? "idle") !== "idle" || this.queues.get(id)?.length || (run && run.phase !== "ended");
    })) return;
    await this.holdWorktree(wt.path, () => this.removeIdleWorktree(threadId, wt, ids, landed));
  }

  private async removeIdleWorktree(threadId: string, wt: ThreadWorktree, ids: string[], landed: boolean): Promise<void> {
    // The provider process runs in the folder; Windows will not remove a folder in use.
    for (const id of ids) {
      this.sessions.get(id)?.dispose();
      this.sessions.delete(id);
      forgetGuides(id);
    }
    await removeWorktree(wt);
    await dropBranchIfEmpty(wt);
    const days = Math.round(WORKTREE_IDLE_MS / 86_400_000);
    const at = Date.now();
    // Again: a fork or helper made while Git worked shares the folder too.
    for (const id of new Set([...ids, ...this.sharers(threadId, wt).map((t) => t.id)])) {
      const cur = this.threads.get(id);
      if (!cur || openWorktree(cur)?.path !== wt.path) continue;
      // Like a merge: the thread keeps its session and its next message reopens the same folder where it
      // can. Forks and helpers that shared it go back to the main checkout in fresh sessions.
      const own = id === threadId;
      const next: Thread = {
        ...cur,
        cwd: wt.home,
        useWorktree: own,
        worktree: { ...wt, ahead: 0, dirty: false, closed: { how: own ? (landed ? "merged" : "expired") : "left", at } },
        nativeId: own ? cur.nativeId : null,
      };
      this.threads.set(id, next);
      this.db.saveThread(next);
      const after = own ? "The next message opens a new one." : "The next message starts a new agent session in the folder.";
      const reason = landed ? "its changes already landed on its base" : `it held no changes absent from its base and had no turns for ${days} days`;
      this.addItem(id, null, { kind: "notice", level: "info", text: `Removed the worktree on ${wt.branch}: ${reason}. ${after}` });
      this.emitThread(id);
    }
    this.flushNow();
    log(`${threadId}: removed its unused worktree ${wt.path}`);
  }

  /**
   * Idle worktrees that hold changes, for the stale worktrees list. remind is true at most once per
   * WORKTREE_REMIND_MS while there are any, so only one window brings them up each day.
   */
  async staleWorktrees(remind = false): Promise<{ worktrees: StaleWorktree[]; remind: boolean }> {
    const worktrees = (await this.idleWorktrees())
      .filter((w) => w.ahead || w.dirty)
      .map(({ thread, wt, usedAt, ahead, dirty }) => ({ threadId: thread.id, title: thread.title, home: wt.home, repo: wt.repo, path: wt.path, branch: wt.branch, base: wt.base, ahead, dirty, usedAt }))
      .sort((a, b) => a.usedAt - b.usedAt);
    let due = false;
    if (remind && worktrees.length) {
      const last = this.db.getSetting<number>("worktreeRemindAt", 0);
      due = Date.now() - last >= WORKTREE_REMIND_MS;
      if (due) this.db.setSetting("worktreeRemindAt", Date.now());
    }
    return { worktrees, remind: due };
  }

  // ---------- hidden and deleted workspaces (#507) ----------

  /**
   * Hide a workspace folder from the thread list and the workspace menus, or show it again. A hidden
   * one also leaves the recent workspaces, so new threads stop starting in it.
   */
  setWorkspaceHidden(dir: string, hidden: boolean): Prefs {
    if (!path.isAbsolute(dir)) throw new Error("path must be an absolute path");
    const key = workspaceKey(dir);
    const prefs = this.prefs();
    const rest = prefs.hiddenWorkspaces.filter((d) => workspaceKey(d) !== key);
    if (!hidden) return this.setPrefs({ hiddenWorkspaces: rest });
    return this.setPrefs({
      hiddenWorkspaces: [...rest, dir],
      recentWorkspaces: prefs.recentWorkspaces.filter((d) => workspaceKey(d) !== key),
    });
  }

  /** The threads that belong to a workspace folder, with the helpers they started. */
  private workspaceThreads(dir: string): Thread[] {
    const key = workspaceKey(dir);
    const out = new Map<string, Thread>();
    for (const thread of this.threads.values()) {
      const folder = this.threadFolder(thread);
      if (folder && workspaceKey(folder) === key) out.set(thread.id, thread);
    }
    // deleteThread takes a thread's helpers with it, wherever they worked.
    for (let grew = true; grew; ) {
      grew = false;
      for (const thread of this.threads.values()) {
        if (thread.helperOf && out.has(thread.helperOf) && !out.has(thread.id)) {
          out.set(thread.id, thread);
          grew = true;
        }
      }
    }
    return [...out.values()];
  }

  /**
   * Delete every thread of a workspace folder for good. Each thread's numbers are kept first
   * (threadStats.ts), so usage history survives; the folder on disk is not touched.
   */
  async deleteWorkspace(dir: string): Promise<{ threads: number; prefs: Prefs }> {
    if (!path.isAbsolute(dir)) throw new Error("path must be an absolute path");
    const key = workspaceKey(dir);
    const threads = this.workspaceThreads(dir);
    const now = Date.now();
    for (const thread of threads) {
      const folder = this.threadFolder(thread);
      this.db.saveThreadStats(threadStats(thread, this.loadTurns(thread.id), this.loadItems(thread.id), folder ?? dir, now));
    }
    for (const thread of threads) {
      // A helper is gone once the thread that started it is.
      if (this.threads.has(thread.id)) await this.deleteThread(thread.id);
    }
    const prefs = this.prefs();
    const saved = this.setPrefs({
      hiddenWorkspaces: prefs.hiddenWorkspaces.filter((d) => workspaceKey(d) !== key),
      recentWorkspaces: prefs.recentWorkspaces.filter((d) => workspaceKey(d) !== key),
      scopeWorkspaces: Object.fromEntries(Object.entries(prefs.scopeWorkspaces).filter(([, d]) => workspaceKey(d) !== key)),
      worktrees: Object.fromEntries(Object.entries(prefs.worktrees).filter(([k]) => k !== key)),
    });
    return { threads: threads.length, prefs: saved };
  }

  /** What is kept of the threads deleted with their workspace. */
  deletedThreadStats(): ThreadStats[] {
    return this.db.listThreadStats();
  }

  // ---------- moved workspace folders (#338) ----------

  /** The folder in the user's checkout a thread belongs to (not its worktree). */
  threadFolder(thread: Thread): string | null {
    return openWorktree(thread)?.home ?? thread.cwd ?? (thread.scope.kind === "workspace" ? thread.scope.ref : null);
  }

  /** Every folder threads and prefs point at, by workspaceKey. */
  workspaceFolders(): Map<string, string> {
    const prefs = this.prefs();
    const out = new Map<string, string>();
    for (const dir of [...[...this.threads.values()].map((t) => this.threadFolder(t)), ...prefs.recentWorkspaces, ...Object.values(prefs.scopeWorkspaces), ...store.pageWorkspaces()]) {
      if (dir && path.isAbsolute(dir) && !out.has(workspaceKey(dir))) out.set(workspaceKey(dir), dir);
    }
    return out;
  }

  /** Save the file id of each of these folders that exists, so it can be found again after a rename. */
  private noteWorkspaces(dirs: Iterable<string>): void {
    const known = this.db.getSetting<Record<string, KnownWorkspace>>("workspaceIds", {});
    let changed = false;
    for (const dir of dirs) {
      const id = folderId(dir);
      const key = workspaceKey(dir);
      if (!id || (known[key]?.ino === id.ino && known[key]?.dev === id.dev)) continue;
      known[key] = { path: dir, ...id };
      changed = true;
    }
    if (changed) this.db.setSetting("workspaceIds", known);
  }

  /**
   * Workspace folders that are gone. found is the folder with the same file id, when the folder was
   * renamed or moved on its drive; path and found are then the part of the path that changed, so a
   * renamed parent of several workspaces is one entry.
   */
  missingWorkspaces(): MissingWorkspace[] {
    const folders = this.workspaceFolders();
    this.noteWorkspaces(folders.values());
    const known = this.db.getSetting<Record<string, KnownWorkspace>>("workspaceIds", {});
    const dismissed = new Set(this.db.getSetting<string[]>("workspaceMovesDismissed", []));
    const parents = [...new Set([...folders.values()].filter(folderExists).map((dir) => path.dirname(dir)))];
    const out = new Map<string, MissingWorkspace>();
    for (const [key, dir] of folders) {
      if (folderExists(dir)) continue;
      let from = path.normalize(dir);
      let found = known[key] ? findMoved(known[key], parents) : null;
      while (found && path.basename(from) === path.basename(found) && path.dirname(from) !== from && !folderExists(path.dirname(from))) {
        from = path.dirname(from);
        found = path.dirname(found);
      }
      if (out.has(workspaceKey(from))) continue;
      const threads = [...this.threads.values()].filter((t) => movePath(this.threadFolder(t) ?? "", from, from) !== null).length;
      if (!found && !threads) continue;
      out.set(workspaceKey(from), { path: from, threads, found, dismissed: dismissed.has(workspaceKey(from)) });
    }
    return [...out.values()];
  }

  /** Stop offering the detected new place of a missing folder. */
  dismissWorkspaceMove(dir: string): void {
    const list = this.db.getSetting<string[]>("workspaceMovesDismissed", []);
    if (!list.includes(workspaceKey(dir))) this.db.setSetting("workspaceMovesDismissed", [...list, workspaceKey(dir)].slice(-200));
  }

  /**
   * The folder `from` is now `to`: rewrite every path Scribe keeps to it or into it (threads, their
   * worktrees and grants, prefs, MCP layers, page workspaces and folder grants, Kanban worker folders), repair the
   * git links of open worktrees, and move Claude Code's sessions so Claude threads resume.
   */
  async relocateWorkspace(fromRaw: string, toRaw: string, opts: { claudeSessions?: boolean } = {}): Promise<{ threads: number; notes: string[]; prefs: Prefs }> {
    if (!path.isAbsolute(fromRaw) || !path.isAbsolute(toRaw)) throw new Error("from and to must be absolute paths");
    const from = path.resolve(fromRaw);
    const to = path.resolve(toRaw);
    if (workspaceKey(from) === workspaceKey(to)) throw new Error("That is the same folder.");
    if (!folderExists(to)) throw new Error(`Folder not found: ${to}`);
    if (folderExists(from)) throw new Error(`${from} still exists, so its threads still work there.`);
    const move = (dir: string | null | undefined): string | null => (dir ? movePath(dir, from, to) : null);
    const lower = (dir: string): string => (process.platform === "win32" ? dir.toLowerCase() : dir);

    const changed: Thread[] = [];
    const claudeDirs = new Map<string, string>([[from, to]]);
    const repairs = new Map<string, string>();
    for (const thread of this.threads.values()) {
      const next: Thread = { ...thread };
      const cwd = move(thread.cwd);
      if (cwd) {
        next.cwd = cwd;
        if (thread.provider === "claude") claudeDirs.set(thread.cwd!, cwd);
      }
      if (thread.scope.kind === "workspace" && move(thread.scope.ref)) next.scope = { ...thread.scope, ref: move(thread.scope.ref) };
      if (thread.fork && move(thread.fork.cwd)) next.fork = { ...thread.fork, cwd: move(thread.fork.cwd) };
      const wt = thread.worktree;
      if (wt && (move(wt.home) || move(wt.repo))) {
        next.worktree = { ...wt, home: move(wt.home) ?? wt.home, repo: move(wt.repo) ?? wt.repo };
        if (!wt.closed && move(wt.repo)) repairs.set(wt.path, next.worktree.repo);
      }
      if (thread.threadGrants?.some((scope) => scope.kind === "workspace" && move(scope.path))) {
        next.threadGrants = thread.threadGrants.map((scope) => (scope.kind === "workspace" && move(scope.path) ? { ...scope, path: lower(move(scope.path)!) } : scope));
      }
      if (JSON.stringify(next) !== JSON.stringify(thread)) changed.push(next);
    }
    const busy = changed.find((t) => this.runs.has(t.id));
    if (busy) throw new Error(`Stop the running turn in “${busy.title}” first.`);

    const notes: string[] = [];
    if (opts.claudeSessions !== false) {
      let moved = 0;
      for (const [oldDir, newDir] of claudeDirs) {
        try {
          moved += moveClaudeProject(oldDir, newDir);
        } catch (err) {
          notes.push(`Claude's sessions for ${oldDir} could not be moved: ${(err as Error).message}`);
        }
      }
      if (moved) notes.push(`Moved Claude's sessions and memory (${moved} file${moved === 1 ? "" : "s"}).`);
    }
    for (const next of changed) {
      next.updatedAt = Date.now();
      this.threads.set(next.id, next);
      this.db.saveThread(next);
      this.effectivePermissions.delete(next.id);
      this.sessions.get(next.id)?.update(this.sessionThread(next));
    }

    const prefs = this.prefs();
    const recent = new Map<string, string>();
    for (const dir of prefs.recentWorkspaces.map((d) => move(d) ?? d)) if (!recent.has(workspaceKey(dir))) recent.set(workspaceKey(dir), dir);
    const saved = this.setPrefs({
      recentWorkspaces: [...recent.values()],
      scopeWorkspaces: Object.fromEntries(Object.entries(prefs.scopeWorkspaces).map(([k, dir]) => [k, move(dir) ?? dir])),
      worktrees: Object.fromEntries(Object.entries(prefs.worktrees).map(([k, on]) => [move(k) ? workspaceKey(move(k)!) : k, on])),
      hiddenWorkspaces: prefs.hiddenWorkspaces.map((dir) => move(dir) ?? dir),
    });
    const memories = this.memories();
    if (memories.some((m) => move(m.workspace))) this.db.setSetting("memories", memories.map((m) => (move(m.workspace) ? { ...m, workspace: move(m.workspace)! } : m)));
    const known = this.db.getSetting<Record<string, KnownWorkspace>>("workspaceIds", {});
    this.db.setSetting("workspaceIds", Object.fromEntries(Object.entries(known).filter(([key]) => !move(key))));
    this.db.setSetting("workspaceMovesDismissed", this.db.getSetting<string[]>("workspaceMovesDismissed", []).filter((key) => !move(key)));
    this.noteWorkspaces(this.workspaceFolders().values());

    const { error, ...mcp } = readMcpFile();
    const layers = Object.values(mcp.workspaces);
    if (error) {
      if (layers.length) notes.push(`MCP servers were left alone: the config file does not parse (${error}).`);
    } else if (layers.some((layer) => move(layer.path))) {
      const workspaces: typeof mcp.workspaces = {};
      for (const layer of layers) {
        const dir = move(layer.path) ?? layer.path;
        workspaces[workspaceKey(dir)] = { ...layer, path: dir };
      }
      writeMcpFile({ mcpServers: mcp.mcpServers, workspaces });
    }
    try {
      store.moveWorkspacePaths(move);
    } catch (err) {
      notes.push(`Page folder grants and worker folders were not all updated: ${(err as Error).message}`);
    }
    for (const [wtPath, repo] of repairs) {
      const res = await git(["worktree", "repair", wtPath], repo);
      if (res.code !== 0) notes.push(`git worktree repair failed for ${wtPath}: ${res.stderr.trim() || "unknown error"}`);
    }
    for (const next of changed) this.emitThread(next.id);
    log(`Workspace ${from} is now ${to}: ${changed.length} thread${changed.length === 1 ? "" : "s"} updated`);
    return { threads: changed.length, notes, prefs: saved };
  }

  // ---------- changes ----------

  /** Files changed by one turn, or by the whole thread when turnId is omitted. */
  async changes(threadId: string, turnId?: string): Promise<{ repo: string | null; from?: string; to?: string; files: FileChange[] }> {
    let turns = this.loadTurns(threadId).filter((turn) => !turnId || turn.id === turnId);
    if (!turns.length) return { repo: null, files: [] };
    // The running turn has no after snapshot yet: take one now, so its changes so far show.
    const running = this.runs.get(threadId)?.turn;
    const live = running && turns.find((turn) => turn.id === running.id && turn.repo && turn.beforeTree && !turn.afterTree);
    if (live) {
      const afterTree = await snapshotTree(live.repo!);
      if (afterTree) {
        const files = await diffTrees(live.repo!, live.beforeTree!, afterTree).catch(() => []);
        turns = turns.map((turn) => (turn === live ? { ...turn, afterTree, files } : turn));
      }
    }
    // Worktree snapshots live in the shared object database. Read them through the
    // main checkout, which survives Merge/Leave and idle cleanup. Keep turn.repo
    // unchanged: reverting a turn must still target the folder where it ran.
    const wt = this.threads.get(threadId)?.worktree;
    const withTrees = turns.filter((turn) => turn.repo && turn.beforeTree && turn.afterTree).map((turn) =>
      wt && workspaceKey(turn.repo!) === workspaceKey(wt.path) ? { ...turn, repo: wt.repo } : turn);
    if (withTrees.length && withTrees.every((turn) => turn.repo === withTrees[0].repo)) {
      const first = withTrees[0];
      const last = withTrees[withTrees.length - 1];
      const files = turnId ? first.files ?? [] : await diffTrees(first.repo!, first.beforeTree!, last.afterTree!);
      return { repo: first.repo!, from: first.beforeTree, to: last.afterTree, files };
    }
    const byPath = new Map<string, FileChange>();
    const saved = this.snapshotChanges(threadId, turnId);
    for (const turn of turns) {
      for (const file of turn.files ?? []) {
        if (saved.has(file.path)) continue;
        const prev = byPath.get(file.path);
        byPath.set(file.path, { ...file, added: (prev?.added ?? 0) + file.added, removed: (prev?.removed ?? 0) + file.removed });
      }
    }
    return { repo: null, files: [...[...saved.values()].map((c) => c.file), ...byPath.values()] };
  }

  /** Patch for a turn or thread; without git, the per-tool diffs recorded during the turns. */
  async patch(threadId: string, turnId?: string, file?: string): Promise<{ patch: string; truncated: boolean }> {
    const info = await this.changes(threadId, turnId);
    if (info.repo && info.from && info.to) {
      return diffPatch(info.repo, info.from, info.to, file ? [file] : []);
    }
    // Saved versions give each file's whole change; per-tool diffs cover the files without them.
    const saved = this.snapshotChanges(threadId, turnId);
    const turnIds = new Set(this.loadTurns(threadId).filter((turn) => !turnId || turn.id === turnId).map((turn) => turn.id));
    const patches = [...saved.values()].filter((c) => !file || c.file.path === file).map((c) => c.patch);
    patches.push(...this.loadItems(threadId)
      .filter((item) => item.kind === "tool" && item.turnId && turnIds.has(item.turnId) && item.diff)
      .filter((item) => item.kind === "tool" && !(item.files ?? []).some((f) => saved.has(f.path)))
      .filter((item) => !file || (item.kind === "tool" && item.files?.some((f) => f.path === file)))
      .map((item) => (item.kind === "tool" ? item.diff ?? "" : "")));
    return { patch: patches.join(""), truncated: false };
  }

  /** Put the turn's page back to its HTML from before the turn. */
  revertPage(threadId: string, turnId: string): { ok: boolean; error?: string } {
    const turn = this.loadTurns(threadId).find((t) => t.id === turnId);
    if (!turn?.page?.after) return { ok: false, error: "This turn did not change a page." };
    const saved = this.db.getSetting<{ html: string; revision: number } | null>(`checkpoint:${turn.id}`, null);
    if (!saved) return { ok: false, error: "The checkpoint for this page is gone." };
    try {
      store.update(turn.page.id, { html: saved.html, viewer: "user" });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    turn.page.reverted = true;
    this.saveTurn(turn);
    this.addItem(threadId, turn.id, { kind: "notice", level: "info", text: `Reverted “${turn.page.title}” to how it was before turn ${turn.seq}.` });
    this.flushNow();
    return { ok: true };
  }

  /**
   * Take the thread back to just before a message of the user's: later turns leave the transcript,
   * their file and page changes are undone (unless keepChanges), and the provider continues from
   * the turn before it. Returns the message, so the chat can edit it or send it again.
   */
  async rewind(threadId: string, itemId: string, opts: { keepChanges?: boolean } = {}): Promise<{ text: string; images: ChatImage[]; files: ChatFile[]; context: ContextChip[] }> {
    const thread = this.requireThread(threadId);
    if (this.runs.has(threadId) || this.queues.get(threadId)?.length) throw new Error("Stop the running turn first.");
    if (this.backgroundTasks(threadId)) throw new Error("Background tasks are still running in this thread. Stop them first.");
    const items = this.loadItems(threadId);
    const user = items.find((it) => it.id === itemId);
    if (!user || user.kind !== "user") throw new Error("Message not found");
    const turns = this.loadTurns(threadId);
    const from = turns.find((t) => t.id === user.turnId);
    if (!from) throw new Error("This message has not run yet.");
    const dropped = turns.filter((t) => t.seq >= from.seq);
    const kept = turns.filter((t) => t.seq < from.seq);

    if (!opts.keepChanges) {
      // Newest first, so each revert applies on top of the state the next one left.
      for (const turn of [...dropped].reverse()) {
        if (turn.reverted || !turn.files?.length || !(turn.beforeTree || turn.snapshots)) continue;
        const result = await this.revertTurn(threadId, turn.id);
        if (!result.ok) throw new Error(`Could not undo the file changes of turn ${turn.seq}: ${result.error ?? "unknown error"}. Turns after it were undone; nothing was removed from the chat.`);
      }
      const page = dropped.find((t) => t.page?.after && !t.page.reverted);
      if (page) {
        const result = this.revertPage(threadId, page.id);
        if (!result.ok) throw new Error(`Could not restore the page: ${result.error ?? "unknown error"}`);
      }
    }

    // What the message carried, read back before its files go.
    const savedFiles = (refs: Array<{ id?: string; name: string; mimeType: string }> | undefined): ChatFile[] =>
      (refs ?? []).flatMap((ref) => {
        const full = ref.id ? filePath(threadId, ref.id) : null;
        if (!full) return [];
        try {
          return [{ name: ref.name, mimeType: ref.mimeType, data: fs.readFileSync(full).toString("base64") }];
        } catch {
          return [];
        }
      });
    const message = { text: user.text, images: savedFiles(user.images), files: savedFiles(user.files), context: user.context ?? [] };

    // Where the provider continues from: its transcript at the end of the last kept turn.
    const last = kept.at(-1);
    const forks = this.agent(thread.provider).forks === true;
    const at = forks && last?.nativeEnd ? last.nativeEnd : null;
    const recap = kept.length && !at ? this.recap(items, kept) : "";
    this.sessions.get(threadId)?.dispose();
    this.sessions.delete(threadId);
    forgetGuides(threadId);
    thread.rewind = { at, ...(recap ? { recap } : {}) };
    if (!at) thread.nativeId = null;

    const droppedIds = new Set(dropped.map((t) => t.id));
    const gone = items.filter((it) => it.turnId && droppedIds.has(it.turnId));
    const keptImages = new Set(items.filter((it) => !gone.includes(it) && it.kind === "images").flatMap((it) => it.kind === "images" ? it.images.map((f) => f.id) : []));
    for (const item of gone) {
      if (item.kind === "user") removeFiles(threadId, [...(item.images ?? []), ...(item.files ?? [])].flatMap((f) => (f.id ? [f.id] : [])));
      if (item.kind === "images") removeFiles(threadId, item.images.filter((f) => !keptImages.has(f.id)).map((f) => f.id));
      this.removeItem(item);
    }
    for (const turn of dropped) {
      turns.splice(turns.indexOf(turn), 1);
      this.db.deleteTurn(turn.id);
      this.db.deleteSetting(`checkpoint:${turn.id}`);
      this.emit({ type: "agent_turn_deleted", threadId, id: turn.id });
    }
    thread.activityAt = Date.now();
    this.db.saveThread(thread);
    this.flushNow();
    this.emitThread(threadId);
    return message;
  }

  /** Whether the provider can still resume the thread's session; on doubt, let it try. */
  private async canResume(thread: Thread): Promise<boolean> {
    if (!thread.nativeId) return true;
    try {
      return (await this.agent(thread.provider).resumable?.(thread.nativeId)) ?? true;
    } catch (err) {
      log(`Checking the session of ${thread.id} failed: ${(err as Error).message}`);
      return true;
    }
  }

  /**
   * A session the provider cannot resume (a Cursor thread's old ACP session id, or an agent whose
   * checkpoints were pruned after days idle): the turn starts a new one with a recap of the
   * conversation, like a rewind to the end.
   */
  private startOverWithRecap(thread: Thread, turnId: string): Thread {
    // Stopped and failed turns count too: the user's message in them is still part of the conversation.
    const kept = this.loadTurns(thread.id).filter((t) => t.id !== turnId && t.status !== "running");
    const recap = kept.length ? this.recap(this.loadItems(thread.id), kept) : "";
    const next: Thread = { ...thread, nativeId: null, ...(recap ? { rewind: { at: null, recap, migrated: true } } : {}) };
    this.threads.set(thread.id, next);
    this.db.saveThread(next);
    if (thread.provider === "cursor" && isSdkAgentId(thread.nativeId)) {
      const text = recap
        ? "Cursor could not reopen this thread's agent (its saved context is gone), so this turn starts a new agent with a recap of the conversation."
        : "Cursor could not reopen this thread's agent (its saved context is gone), so this turn starts a new agent.";
      this.addItem(thread.id, turnId, { kind: "notice", level: "info", text });
    }
    return next;
  }

  /** The kept conversation in short, for a provider that starts over after a rewind: each message and the reply to it. */
  private recap(items: Item[], kept: Turn[]): string {
    const parts: string[] = [];
    for (const turn of kept) {
      const ofTurn = items.filter((it) => it.turnId === turn.id && !("parentToolId" in it && it.parentToolId));
      const asked = ofTurn.filter((it) => it.kind === "user").map((it) => (it.kind === "user" ? it.text : "")).join("\n\n");
      const texts = ofTurn.flatMap(it => it.kind === "text" ? [it.text] : it.kind === "component" ? [componentText(it)] : []);
      const reply = texts.at(-1) ?? "";
      const stopped = turn.status === "cancelled" ? " (stopped before it finished)" : turn.status === "error" ? " (failed before it finished)" : "";
      if (asked) parts.push(`User: ${asked}`);
      if (reply || stopped) parts.push(`You${stopped}: ${reply || "(no reply)"}`);
    }
    const text = parts.join("\n\n");
    // The latest part matters most; keep the prompt a sensible size.
    return text.length > MAX_RECAP ? `…${text.slice(-MAX_RECAP)}` : text;
  }

  // ---------- forks ----------

  /**
   * A new thread that goes on from this one's finished turns, with the same settings and folder (an
   * open worktree is shared). Its first turn continues this thread's provider session when it can,
   * or starts fresh with a summary; the provider can still be changed until then.
   */
  fork(threadId: string, to: { provider?: ProviderId; model?: string; mode?: ModeInput } = {}): ThreadView {
    const source = this.requireThread(threadId);
    const turns = this.loadTurns(threadId).filter((t) => t.status !== "running");
    if (!turns.length) throw new Error("This thread has no finished turns to fork from.");
    const items = this.loadItems(threadId);
    const last = turns.at(-1)!;
    const wt = openWorktree(source);
    const thread = this.draftThread({
      title: `${source.title} (fork)`,
      provider: source.provider,
      model: source.model,
      effort: source.effort,
      modelParams: source.modelParams,
      mode: source.mode,
      ...(source.custom ? { custom: source.custom } : {}),
      approval: source.approval,
      web: source.web,
      scope: source.scope,
      cwd: source.cwd,
      useWorktree: Boolean(wt),
    });
    if (wt) thread.worktree = { ...wt };
    if (source.skills?.length) thread.skills = [...source.skills];
    if (to.provider && to.provider !== source.provider) {
      // The other provider's own last-used settings, as when a new thread switches provider.
      const prefs = this.prefs();
      thread.provider = to.provider;
      thread.model = to.model ?? prefs.models[to.provider] ?? "default";
      thread.effort = prefs.efforts[to.provider] ?? null;
      thread.modelParams = prefs.modelParams[to.provider] ?? {};
      if (!readsOnly(thread.approval)) thread.approval = approvalFor(prefs, to.provider);
    } else if (to.model) {
      thread.model = to.model;
    }
    Object.assign(thread, changeAccess(thread, { mode: to.mode }, approvalFor(this.prefs(), thread.provider), modeMax(thread)));
    // A merged thread's session belongs to its removed worktree folder, not the folder a fork starts in.
    const native = this.agent(source.provider).forks === true && source.nativeId && last.nativeEnd && !source.worktree?.closed;
    thread.fork = {
      from: source.id,
      title: source.title,
      provider: source.provider,
      cwd: source.cwd,
      nativeId: native ? source.nativeId : null,
      at: native ? last.nativeEnd! : null,
      turns: turns.length,
    };
    const firstAsked = this.turnText(items, turns[0], false);
    const lastTurn = turns.length > 1 ? this.turnText(items, last, false) : null;
    const material: ForkMaterial = {
      first: clip(firstAsked.asked, MAX_FORK_MESSAGE),
      middle: turns
        .slice(1, -1)
        .map((turn) => this.turnText(items, turn, true).text)
        .join("\n\n"),
      last: lastTurn ? clip(lastTurn.asked, MAX_FORK_MESSAGE) : "",
      reply: clip((lastTurn ?? firstAsked).reply, MAX_FORK_MESSAGE),
    };
    this.threads.set(thread.id, thread);
    this.items.set(thread.id, []);
    this.turns.set(thread.id, []);
    this.seq.set(thread.id, 0);
    this.db.setSetting(`fork:${thread.id}`, material);
    this.db.saveThread(thread);
    const view = this.view(thread);
    this.emit({ type: "agent_thread", thread: view });
    return view;
  }

  /** One turn as text: what the user asked and the final reply, or (full) every reply, tool and changed file in order. */
  private turnText(items: Item[], turn: Turn, full: boolean): { asked: string; reply: string; text: string } {
    const ofTurn = items.filter((it) => it.turnId === turn.id && !("parentToolId" in it && it.parentToolId));
    const asked = ofTurn.flatMap((it) => (it.kind === "user" ? [it.text] : [])).join("\n\n");
    const texts = ofTurn.flatMap((it) => (it.kind === "text" ? [it.text] : it.kind === "component" ? [componentText(it)] : []));
    const reply = texts.at(-1) ?? "";
    if (!full) return { asked, reply, text: "" };
    const lines: string[] = [];
    for (const it of ofTurn) {
      if (it.kind === "user") lines.push(`User: ${it.text}`);
      else if (it.kind === "text") lines.push(`Agent: ${it.text}`);
      else if (it.kind === "component") lines.push(`[component] ${componentText(it)}`);
      else if (it.kind === "tool") lines.push(`[tool: ${it.title}${it.status === "error" ? " (failed)" : ""}]`);
      else if (it.kind === "plan") lines.push(`[plan, ${it.status}]\n${it.text}`);
    }
    const files = turn.reverted ? [] : (turn.files ?? []).map((f) => f.path);
    if (files.length) lines.push(`[files changed: ${files.join(", ")}]`);
    return { asked, reply, text: lines.join("\n") };
  }

  /** Whether a fork's first turn can continue the other thread's own provider session. */
  private forksNatively(thread: Thread, fork: NonNullable<Thread["fork"]>): boolean {
    return Boolean(fork.nativeId && fork.at && thread.provider === fork.provider && this.agent(thread.provider).forks && (thread.cwd ?? null) === (fork.cwd ?? null));
  }

  private forkCarry(thread: Thread, fork: NonNullable<Thread["fork"]>): ThreadView["carry"] {
    if (this.forksNatively(thread, fork)) return { how: "native" };
    return { how: "summary", ...(fork.turns > 2 ? { summarizer: this.summarizerLabel(thread) } : {}) };
  }

  private summarizerLabel(thread: Thread): string {
    const { provider, model } = summaryChoice(this.prefs(), thread);
    const label = this.cachedModels(provider).find((m) => m.id === model)?.label ?? model;
    return `${label} (${this.providers[provider].label})`;
  }

  /** Context compaction follows the thread's summary choice, including cross-provider selections. */
  private async summarizeContext(thread: Thread, prompt: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const { provider, model } = summaryChoice(this.prefs(), thread);
    const text = await this.agent(provider).complete(prompt, model, signal);
    signal.throwIfAborted();
    return text;
  }

  /** Utility completion uses the shared summary choices, falling back when usage runs out. */
  async summarize(prompt: string, signal?: AbortSignal): Promise<{ text: string; model: string }> {
    const prefs = this.prefs();
    const primary = summaryChoice(prefs, prefs.summarizer);
    const choices = [primary, ...(["cursor", "claude", "codex", "pi"] as const)
      .filter((provider) => provider !== primary.provider)
      .map((provider) => summaryChoice(prefs, { provider, model: prefs.models[provider] || "default" }))];
    let lastError: unknown = new Error("No utility agent is available.");
    for (const { provider, model } of choices) {
      signal?.throwIfAborted();
      const agent = this.agent(provider);
      if (!(await agent.status()).available) continue;
      signal?.throwIfAborted();
      const limits = this.liveLimits()[provider];
      if (limits?.ordinaryUsageAllowed === false || limits?.status === "rejected" ||
          (provider === "claude" && !limits?.overage && limits?.windows.some((w) =>
            ["five_hour", "seven_day"].includes(w.id) && w.utilization >= 1))) continue;
      const startedAt = Date.now();
      try {
        const text = await agent.complete(prompt, model, signal);
        signal?.throwIfAborted();
        const label = this.cachedModels(provider).find((m) => m.id === model)?.label ?? model;
        return { text, model: label };
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (usageLimitResetsAt(message, this.liveLimits()[provider], startedAt, Date.now()) === undefined &&
            !/rate.?limit|quota.*exceed|insufficient.quota|resource.exhausted|\b429\b/i.test(message)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  /**
   * Set up a fork's first turn: point the session at the other thread's session, or build the
   * earlier conversation to send ahead of the message, summarizing its middle turns.
   */
  private async startFork(thread: Thread, fork: NonNullable<Thread["fork"]>, run: RunState): Promise<string> {
    const threadId = thread.id;
    if (this.forksNatively(thread, fork)) {
      this.sessions.get(threadId)?.dispose();
      this.sessions.delete(threadId);
      const next: Thread = { ...thread, nativeId: fork.nativeId, rewind: { at: fork.at } };
      this.threads.set(threadId, next);
      this.db.saveThread(next);
      return "";
    }
    // A fresh session, wherever this thread had one going.
    if (thread.nativeId) {
      this.sessions.get(threadId)?.dispose();
      this.sessions.delete(threadId);
      const next: Thread = { ...thread, nativeId: null };
      this.threads.set(threadId, next);
      this.db.saveThread(next);
    }
    const material = this.db.getSetting<ForkMaterial | null>(`fork:${threadId}`, null);
    if (!material) return "";
    if (material.middle && !material.summary) {
      const { provider, model } = summaryChoice(this.prefs(), thread);
      const label = this.summarizerLabel(thread);
      const notice = this.addItem(threadId, run.turn.id, { kind: "notice", level: "info", text: `Summarizing “${fork.title}” with ${label}…` });
      run.abort = new AbortController();
      try {
        const middle = material.middle.length > MAX_FORK_MIDDLE ? `…${material.middle.slice(-MAX_FORK_MIDDLE)}` : material.middle;
        const summary = (await this.agent(provider).complete(summaryPrompt(middle), model, run.abort.signal)).trim();
        if (!summary) throw new Error("the summary came back empty");
        material.summary = summary;
        this.db.setSetting(`fork:${threadId}`, material);
        if (notice.kind === "notice") notice.text = `Summarized “${fork.title}” with ${label}.`;
      } catch (err) {
        if (run.cancelled) throw err;
        if (notice.kind === "notice") {
          notice.level = "warn";
          notice.text = `Summarizing with ${label} failed (${(err as Error).message}), so the turns in between go along as they were, cut to the latest part.`;
        }
      } finally {
        run.abort = undefined;
        this.touch(notice);
        this.flushNow();
      }
    }
    return forkBlock(fork.title, this.providers[fork.provider].label, material);
  }

  /** Without git: put back each file's saved version from before the turn, if none changed since. */
  private revertVersions(threadId: string, turn: Turn): { ok: boolean; error?: string } {
    const cwd = this.threads.get(threadId)?.cwd;
    const saved = turn.snapshots ?? {};
    if (!cwd) return { ok: false, error: "This thread has no workspace folder." };
    const missing = (turn.files ?? []).filter((f) => !saved[f.path]).map((f) => f.path);
    if (missing.length) return { ok: false, error: `No saved versions for ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}, so this turn cannot be reverted automatically.` };
    const plan: Array<{ abs: string; before: Buffer | null }> = [];
    for (const [file, version] of Object.entries(saved)) {
      const abs = path.resolve(cwd, file);
      const after = readSnapshot(threadId, version.after);
      const before = version.before === null ? null : readSnapshot(threadId, version.before);
      if (!after || (version.before !== null && !before)) return { ok: false, error: `The saved versions of ${file} are gone.` };
      let current: Buffer | null = null;
      try { current = fs.readFileSync(abs); } catch { /* deleted */ }
      const same = version.after === null ? current === null : current !== null && current.equals(after);
      if (!same) return { ok: false, error: `${file} changed after this turn, so the revert does not apply cleanly.` };
      plan.push({ abs, before });
    }
    try {
      for (const { abs, before } of plan) {
        if (before === null) fs.rmSync(abs, { force: true });
        else {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, before);
        }
      }
    } catch (err) {
      return { ok: false, error: `Reverting failed part way: ${(err as Error).message}` };
    }
    turn.reverted = true;
    this.saveTurn(turn);
    this.addItem(threadId, turn.id, { kind: "notice", level: "info", text: `Reverted the changes from turn ${turn.seq}.` });
    this.flushNow();
    this.emitThread(threadId);
    return { ok: true };
  }

  async revertTurn(threadId: string, turnId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.runs.has(threadId)) return { ok: false, error: "Stop the running turn first." };
    const turn = this.loadTurns(threadId).find((t) => t.id === turnId);
    if (!turn) return { ok: false, error: "Turn not found" };
    if (!turn.repo && turn.snapshots) return this.revertVersions(threadId, turn);
    if (!turn.repo || !turn.beforeTree || !turn.afterTree) return { ok: false, error: "This turn has no git snapshot, so it cannot be reverted automatically." };
    // In a worktree the agent commits as it goes: move the branch back too, but only if nothing was committed after this turn.
    const moveHead = turn.beforeHead && turn.afterHead && turn.beforeHead !== turn.afterHead;
    if (moveHead && (await headCommit(turn.repo)) !== turn.afterHead) {
      return { ok: false, error: "The branch has commits from after this turn. Revert the later turns first." };
    }
    const result = await revertTrees(turn.repo, turn.beforeTree, turn.afterTree);
    if (result.ok && moveHead) {
      const reset = await resetHead(turn.repo, turn.beforeHead!);
      if (!reset.ok) return { ok: false, error: `The files were reverted, but moving the branch back failed: ${reset.error}` };
    }
    if (result.ok) {
      turn.reverted = true;
      this.saveTurn(turn);
      this.addItem(threadId, turn.id, { kind: "notice", level: "info", text: `Reverted the changes from turn ${turn.seq}.` });
      this.flushNow();
      this.emitThread(threadId);
    }
    return result;
  }
}

function readText(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "New thread";
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}
