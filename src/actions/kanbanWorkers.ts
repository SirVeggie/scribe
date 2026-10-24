import type { BoardState } from "../types.js";
import type { RunOutcome } from "../agent/pageRuns.js";
import { settleAccess, type ApprovalPolicy, type ThreadMode } from "../agent/types.js";
import {
  MAX_WORKER_LOG,
  STEP_LEASE_MS,
  cardPath,
  cardScheduled,
  cards,
  claimFrom,
  claimLinks,
  columnById,
  columns,
  continuationReadyOps,
  compactUsage,
  moveOps,
  returnColumn,
  roleColumn,
  workerList,
  workerLogEntries,
  workerMap,
  type Card,
  type Column,
  type Comment,
  type SoloRun,
  type UsageTotals,
  type Worker,
  type WorkerLogEntry,
} from "./kanban.js";
import { arr, newId, str, type ActionOutcome, type DriveContext, type DriveOutcome, type LaunchSettings, type PageLaunch, type PageRunInput, type ThreadRunInfo } from "./types.js";

/**
 * A Kanban board's agent workers, run by the daemon (#312): whether or not a window shows the board,
 * it wraps up a worker's chat once Scribe's run of it ended (merged, out of usage, failed), starts
 * the worker's next ready card, or waits for one. The page only shows it and takes the user's
 * clicks (start, stop, a one-card run). The step lease (settings.workers[id].step) is the one board
 * copies with older saved HTML take through worker_step, so the daemon and their windows never
 * both start a card. Keep the wording in step with the page's.
 */

const FOLDER_MODES = new Set(["code"]);
/** Cards one agent chat may take before the board starts a fresh one. */
const MAX_CARDS_PER_AGENT = 3;
/** How much of the card goes in a worker's prompt (a page's prompts are capped at 20000 characters). */
const CARD_PROMPT_TEXT_MAX = 6000;
const CARD_PROMPT_COMMENTS = 4;
const CARD_PROMPT_COMMENT_MAX = 1200;
const OTHER_CARDS_IN_PROMPT = 10;
/** Cards in a row whose chat fails before the worker pauses, since that points at the worker itself. */
const MAX_CHAT_FAILS = 3;
/** Ends the note on a card whose chat stopped before finishing it. */
const KEPT_NOTE = "Its chat and branch are kept: Continue that chat, or comment here to let the worker take the card again.";
const PRIORITIES = ["", "low", "medium", "high", "urgent"];

type Info = ThreadRunInfo;
type Settings = { workerInstructions?: unknown; maxWorkers?: unknown; maxWorkersPerProvider?: unknown; workerOrder?: unknown; workerLog?: unknown };

const settingsOf = (state: BoardState) => (state.settings && typeof state.settings === "object" ? (state.settings as Settings) : {});
const workerPath = (id: string) => `settings/workers/${id}`;
const sameName = (a: unknown, b: unknown) => str(a).trim().toLowerCase() === str(b).trim().toLowerCase();
const leased = (step: Worker["step"], now: number) => Boolean(step && Number(step.at) > now - STEP_LEASE_MS);

/** Worker ids in the Workers panel's order. */
function workerIds(state: BoardState): string[] {
  const ids = workerList(state).map(([id]) => id);
  const order = arr<string>(settingsOf(state).workerOrder);
  const ordered = order.filter((id, i) => ids.includes(id) && order.indexOf(id) === i);
  return ordered.concat(ids.filter((id) => !ordered.includes(id)));
}

function workerOf(state: BoardState, id: string): Worker | undefined {
  const w = workerMap(state)[id];
  return w && typeof w === "object" ? w : undefined;
}

/**
 * The worker's mode and rung (#719). Older worker settings named a mode beside the approval: code
 * with Ask first is Edits now, ask and board are the Board rung, and plan is code: workers have no
 * plan gate (#687), so plan turns are left to the chat.
 */
export function workerAccess(w: Worker): { mode: ThreadMode; approval: ApprovalPolicy } {
  return settleAccess(str(w.mode) || "code", str(w.approval) || "auto");
}

export function workerMode(w: Worker): string {
  return workerAccess(w).mode;
}

export function workerInstructions(state: BoardState, w: Worker): string {
  return [str(settingsOf(state).workerInstructions).trim(), str(w.instructions).trim()].filter(Boolean).join("\n\n");
}

/** Set up enough to start: a name, instructions, and a folder from Edits up. */
export function workerReady(state: BoardState, w: Worker): string | null {
  if (!str(w.name).trim()) return "needs a name";
  if (!workerInstructions(state, w)) return "needs instructions";
  if (FOLDER_MODES.has(workerMode(w)) && !str(w.cwd).trim()) return "needs a folder";
  return null;
}

/** The card's column; a card in no known column shows in the first one. */
function colOf(state: BoardState, c: Card): Column | undefined {
  return columnById(state, c.col) ?? columns(state)[0];
}

const isReady = (col: Column | undefined) => col?.role === "agent";
const liveCards = (state: BoardState) => cards(state).filter((c) => !c.archived);

/** The worker's cards in the agent (ready) columns, in board order. Paused inboxes are skipped. */
function workerCards(state: BoardState, w: Worker): Card[] {
  if (!str(w.name).trim()) return [];
  const cols = columns(state);
  const known = new Set(cols.map((c) => c.id));
  const out: Card[] = liveCards(state).filter((c) => {
    if (!c.continuation || !sameName(c.assignee, w.name) || !sameName(c.continuation.assignee, w.name)) return false;
    const origin = isReady(colOf(state, c)) ? colOf(state, c) : columnById(state, str(c.from));
    return isReady(origin) && !origin?.paused;
  });
  for (const col of cols) {
    if (!isReady(col) || col.paused) continue;
    for (const c of liveCards(state)) {
      const here = c.col === col.id || (!known.has(c.col) && cols[0]?.id === col.id);
      if (here && !c.continuation && sameName(c.assignee, w.name)) out.push(c);
    }
  }
  return out;
}

/** Whether a worker would take the card now: not held, not blocked unanswered, not waiting on unfinished cards. */
function cardTakeable(state: BoardState, c: Card, now = Date.now()): boolean {
  if (cardScheduled(c, now)) return false;
  if (c.claim && !c.claim.stale) return false;
  if (!c.continuation && c.status?.kind === "blocked") {
    const last = arr<Comment>(c.comments).at(-1);
    if (!last || last.by !== "user") return false;
  }
  return !arr<string>(c.blockedBy).some((id) => {
    const b = cards(state).find((x) => x.id === id);
    const role = b ? colOf(state, b)?.role : undefined;
    return Boolean(b && !b.archived && role !== "done" && role !== "review");
  });
}

/** The worker's next card: its first takeable one in the ready columns, except the ones in skip. */
export function nextCard(state: BoardState, w: Worker, skip: ReadonlySet<string> = new Set(), now = Date.now()): Card | null {
  return workerCards(state, w).find((c) => !skip.has(c.id) && cardTakeable(state, c, now)) ?? null;
}

/**
 * Count chats and launch leases separately, including this worker's parallel one-card runs.
 * An additional launch also counts its own worker's active thread; its lease is the candidate slot.
 */
function atLimit(state: BoardState, id: string, now: number, defaultProvider = "", ownThread = false): boolean {
  const max = Math.min(99, Math.max(0, Math.floor(Number(settingsOf(state).maxWorkers) || 0)));
  const value = settingsOf(state).maxWorkersPerProvider;
  const perProvider = value == null ? 1 : Math.min(99, Math.max(0, Math.floor(Number(value) || 0)));
  const busy: string[] = [];
  for (const [other, w] of workerList(state)) {
    const provider = str(w.provider) || defaultProvider;
    if ((other !== id || ownThread) && w.run && w.threadId) busy.push(provider);
    if (other !== id && w.run && leased(w.step, now)) busy.push(provider);
    for (const entry of Object.values(w.solo ?? {})) if (entry && typeof entry === "object") busy.push(provider);
  }
  const provider = str(workerOf(state, id)?.provider) || defaultProvider;
  return Boolean((max && busy.length >= max) || (perProvider && busy.filter((p) => p === provider).length >= perProvider));
}

function clip(text: unknown, max: number): string {
  const t = str(text).trim();
  return t.length > max ? `${t.slice(0, max)}… (cut; get the card for the rest)` : t;
}

/** The card as the agent would get it, so its first call needn't be get: fields, checklist, the last few comments. */
function cardBrief(state: BoardState, c: Card): string {
  const lines = [`Your card: #${c.num} ${c.title}`];
  const names = arr<string>(c.labels).map((id) => arr<{ id: string; name: string }>(state.labels).find((l) => l?.id === id)?.name).filter(Boolean);
  const meta: string[] = [];
  if (names.length) meta.push(`labels: ${names.join(", ")}`);
  if (Number(c.priority) > 0) meta.push(`priority: ${PRIORITIES[Number(c.priority)] || c.priority}`);
  if (c.due) meta.push(`due: ${c.due}`);
  if (meta.length) lines.push(meta.join(" · "));
  lines.push("", "Description:", clip(c.description, CARD_PROMPT_TEXT_MAX) || "(none)");
  const checklist = arr<{ text?: string; done?: boolean }>(c.checklist);
  if (checklist.length) {
    lines.push("", "Checklist:");
    for (const it of checklist) lines.push(`- [${it?.done ? "x" : " "}] ${str(it?.text)}`);
  }
  const comments = arr<Comment>(c.comments);
  if (comments.length) {
    const shown = comments.slice(-CARD_PROMPT_COMMENTS);
    lines.push("", `Comments${comments.length > shown.length ? ` (last ${shown.length} of ${comments.length})` : ""}:`);
    for (const cm of shown) lines.push(`- ${cm.by || "user"}: ${clip(cm.text, CARD_PROMPT_COMMENT_MAX).replace(/\n/g, "\n  ")}`);
  }
  const images = arr(c.images).length;
  if (images) lines.push("", `The card has ${images} image${images === 1 ? "" : "s"}; get the card to see ${images === 1 ? "it" : "them"}.`);
  return lines.join("\n");
}

/** The first message of a worker's chat on card c. Matches the page's workerPrompt. */
export function workerPrompt(state: BoardState, page: { id: string; title: string }, w: Worker, c: Card, solo = false): string {
  const name = str(w.name).trim() || "Agent";
  const brief = cardBrief(state, c);
  const lines = [
    `You are the agent worker "${name}" on the Kanban board "${page.title || "Kanban board"}" (Scribe page id ${page.id}). You take the cards in the board's agent (ready) columns that are assigned to "${name}".`,
    "",
    "The user's instructions:",
    workerInstructions(state, w),
    "",
    brief,
    "",
    "How to work:",
    `- Use the board with the scribe MCP: page_action with id "${page.id}". The board's agent guide comes with this message (or with your first page_action result); follow it.`,
    `- The board has claimed your card for you under "${name}" and moved it to the working column, so don't claim it. The card is above as it was when this chat started; get it only to see its images or older comments. Do the work, then finish it. If you need the user's input, release it with status { kind: "blocked", text } and a note saying what you need, instead of waiting for an answer.`,
    "- Keep tool use and checking in proportion to the change. For a small CSS or copy change, the card's mockup or one quick look is enough: don't build test pages, re-read files you've already read, or read skills the card doesn't need (this guide covers the board).",
  ];
  if (FOLDER_MODES.has(workerMode(w)) && w.worktree) {
    lines.push("- You work in a git worktree, on a branch of your own. Commit your work before you end your turn. When your turn ends, the board rebases your branch onto the one it came from and merges it, and the next agent starts from there; if that hits conflicts, it asks you to sort them out.");
  }
  if (solo) {
    lines.push("- This is a one-off run for this card only. Don't take other cards; when it is finished, end your turn.");
  } else if (w.context === "fresh") {
    lines.push("- Work on this card only, then end your turn. The board starts a fresh agent for the next card.");
  } else {
    const others = workerCards(state, w).filter((o) => o.id !== c.id && cardTakeable(state, o));
    if (!others.length) {
      lines.push("- No other cards wait for you right now, so when it is finished, end your turn. The board starts a fresh agent for any card that comes in.");
    } else {
      const listed = others.slice(0, OTHER_CARDS_IN_PROMPT).map((o) => `#${o.num} ${str(o.title).slice(0, 80)}`).join("; ");
      lines.push(`- Your other ready cards when this chat started: ${listed}${others.length > OTHER_CARDS_IN_PROMPT ? `; and ${others.length - OTHER_CARDS_IN_PROMPT} more` : ""}.`);
      lines.push(`- When it is finished, if one of those is closely related to the work you just did, so that what you know now saves real effort, take it next in this turn: claim it yourself with assignee ${JSON.stringify(name)} (no need to list first; claim refuses a card someone else took, and refuses any card once the user has asked you to stop: then end your turn), then get it. Up to ${MAX_CARDS_PER_AGENT} cards in all. Otherwise end your turn: the board starts a fresh agent with a clean context for the next card, which costs less than carrying this conversation along.`);
    }
  }
  lines.push("- Don't wait for new cards; the board does that. End your turn with a short summary.");
  const prompt = lines.join("\n");
  // Long instructions plus a long card would pass the cap: name the card only, and the agent gets it.
  return prompt.length > 19000 ? prompt.replace(brief, () => `Your card: #${c.num} ${c.title} (too long to include here: get it first)`) : prompt;
}

/** The chat's settings from the worker's. Provider and model left out follow the board's fixed defaults (see AgentHost.launchPageThread). */
export function workerSettings(w: Worker, c: Card): LaunchSettings {
  const { mode, approval } = workerAccess(w);
  const folder = FOLDER_MODES.has(mode);
  const modelParams: Record<string, string> = {};
  const fast = str(w.fast);
  modelParams.fast = fast || "false";
  return {
    title: `${str(w.name).trim() || "Agent"} · #${c.num} ${c.title}`.slice(0, 120),
    mode,
    ...(str(w.provider) ? { provider: str(w.provider) } : {}),
    ...(str(w.model) ? { model: str(w.model) } : {}),
    ...(str(w.effort) ? { effort: str(w.effort) } : {}),
    ...(str(w.customMode) ? { customMode: str(w.customMode) } : {}),
    ...(str(w.show) ? { show: str(w.show) } : {}),
    web: str(w.web) || "off",
    approval,
    modelParams,
    ...(folder ? { cwd: str(w.cwd).trim(), ...(w.worktree ? { worktree: true } : {}) } : {}),
    helpers: w.helpers !== false,
  };
}

/**
 * What Scribe tells a chat once its limit resets. While it waited, another chat (a Continue, the
 * user) may have taken or finished its card, so a plain "go on" could redo or overwrite that work.
 */
function resumeText(cardNum: number | undefined): string {
  const which = cardNum ? `card #${cardNum}` : "your card";
  return `Your plan's usage limit has reset. Before you go on, get ${which} again, since it may have changed while you waited. If another chat took it over or finished it, don't redo or overwrite that work and don't claim it again: only commit your own changes that are still needed (or leave the worktree clean), rebase as before, and end your turn. If it was released back to an agent column, claim it again and go on only if the work is still needed. Otherwise go on where you left off and finish it as before.`;
}

/** What Scribe needs to see a worker's chat through: whose it is, and what to say after a usage limit. */
export function workerRun(w: Worker, id: string, cardNum: number | undefined, solo: boolean, after?: number): PageRunInput {
  const data: Record<string, unknown> = { worker: id };
  if (cardNum) data.card = Number(cardNum);
  if (solo) data.solo = true;
  return { tag: `${solo ? "solo:" : "worker:"}${id}`, data, merge: FOLDER_MODES.has(workerMode(w)), resumePrompt: resumeText(cardNum), ...(after !== undefined ? { after } : {}) };
}

// ---------- ops ----------

function fmtTokens(value: number): string {
  const n = Math.round(Number(value) || 0);
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? String(Math.round(m)) : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1000) return `${n >= 10000 ? String(Math.round(n / 1000)) : (n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** The usage suffix on a log line, as the page writes it. */
function formatUsage(u: UsageTotals): string {
  const parts: string[] = [];
  const input = u.promptTokens !== undefined ? u.promptTokens : (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
  if (input) parts.push(`${fmtTokens(input)} in`);
  if (u.outputTokens) parts.push(`${fmtTokens(u.outputTokens)} out`);
  if (u.turns) parts.push(`${u.turns} ${u.turns === 1 ? "round" : "rounds"}`);
  if (u.costUsd !== undefined) parts.push(`$${u.costUsd.toFixed(2)}${u.costPartial ? " partial" : ""}`);
  const h = u.helpers;
  if (h) parts.push(`helpers: ${h.threads || 0}, ${fmtTokens(h.inputTokens || 0)} in, ${fmtTokens(h.outputTokens || 0)} out${h.costUsd !== undefined ? `, $${h.costUsd.toFixed(2)}${h.costPartial ? " partial" : ""}` : ""}`);
  return parts.join(" · ");
}

type LogExtra = { card?: number; thread?: string; usage?: UsageTotals };

/** One plan of ops on the board, built up step by step; log lines are kept in order and trimmed once. */
class Plan {
  ops: unknown[] = [];
  private lines: WorkerLogEntry[] = [];
  constructor(private state: BoardState, private now: number) {}

  patchWorker(id: string, value: Record<string, unknown>): void {
    this.ops.push({ op: "merge", path: workerPath(id), value });
  }

  /** A line in settings.workerLog; with usage, the chat's totals go on the card too. */
  log(id: string | null, kind: string, text: string, extra: LogExtra = {}): void {
    const w = id ? workerOf(this.state, id) : undefined;
    const usage = compactUsage(extra.usage);
    let line = text;
    const suffix = usage ? formatUsage(usage) : "";
    if (suffix && !line.includes(suffix)) line = `${line} · ${suffix}`;
    this.lines.push({
      id: newId("lg"),
      at: this.now,
      kind,
      text: line.slice(0, 500),
      ...(id ? { workerId: id } : {}),
      ...(w?.name ? { worker: str(w.name) } : {}),
      ...(extra.card ? { card: extra.card } : {}),
      ...(extra.thread ? { thread: extra.thread } : {}),
      ...(usage ? { usage } : {}),
    });
    if (usage) this.cardUsage(extra.card, extra.thread, usage);
  }

  /** Last worker chat's totals on the card (and any other card that chat claimed). */
  cardUsage(cardNum: number | undefined, threadId: string | undefined, usage: UsageTotals | undefined): void {
    const compact = compactUsage(usage);
    if (!compact) return;
    const value = { ...compact, at: this.now, ...(threadId ? { thread: threadId } : {}) };
    const seen = new Set<string>();
    for (const c of cards(this.state)) {
      if (seen.has(c.id) || !((cardNum && c.num === cardNum) || (threadId && c.thread === threadId))) continue;
      seen.add(c.id);
      this.ops.push({ op: "merge", path: cardPath(c), value: { usage: value } });
    }
  }

  outcome(launch?: PageLaunch): DriveOutcome {
    const ops = [...this.ops];
    if (this.lines.length) {
      const list = workerLogEntries(this.state);
      if (!Array.isArray(settingsOf(this.state).workerLog)) ops.push({ op: "set", path: "settings/workerLog", value: this.lines.slice(-MAX_WORKER_LOG) });
      else {
        for (const line of this.lines) ops.push({ op: "insert", path: "settings/workerLog", value: line });
        for (const old of list.slice(0, Math.max(0, list.length + this.lines.length - MAX_WORKER_LOG))) {
          if (old.id) ops.push({ op: "remove", path: `settings/workerLog/${old.id}` });
        }
      }
    }
    return { ops, result: null, ...(launch ? { launch } : {}) };
  }

  get empty(): boolean {
    return !this.ops.length && !this.lines.length;
  }

  /**
   * Leave cards blocked with why in a comment by the worker: claims are dropped, and a card outside
   * a ready column goes back to its own, on top. A worker skips a blocked card until the user answers
   * on it, so it goes on with its other cards. Logs it under threadId unless quiet.
   */
  blockCards(id: string, ids: string[], why: string, statusText: string, threadId: string | undefined, quiet: boolean, usage?: UsageTotals): { ids: string[]; nums: number[]; list: string; backTo: Column | null } {
    const by = str(workerOf(this.state, id)?.name).trim();
    const moved: Card[] = [];
    const targets = new Map<Column, Card[]>();
    let backTo: Column | null = null;
    for (const c of cards(this.state)) {
      if (!ids.includes(c.id) || c.archived) continue;
      const at = colOf(this.state, c);
      const target = isReady(at) ? at : returnColumn(this.state, c);
      if (!target) continue;
      moved.push(c);
      targets.set(target, [...(targets.get(target) ?? []), c]);
      if (target !== at) backTo ??= target;
      this.ops.push({ op: "merge", path: cardPath(c), value: { claim: null, status: { kind: "blocked", text: statusText } } });
      this.ops.push({ op: "insert", path: `${cardPath(c)}/comments`, value: { id: newId("cm"), by: by || str(c.assignee).trim() || "agent", at: this.now, text: why } });
      this.ops.push(...moveOps(this.state, c, target, this.now));
    }
    // Keep each column's cards together: the moved ones go to the top of their column, in their order.
    for (const [col, mine] of targets) {
      const anchor = cards(this.state).find((c) => c.col === col.id && !mine.includes(c));
      if (anchor) for (const c of mine) this.ops.push({ op: "move", path: cardPath(c), before: `id=${anchor.id}` });
    }
    const nums = moved.map((c) => c.num);
    const list = nums.map((n) => `#${n}`).join(", ");
    if (!quiet) this.log(id, "blocked", `${list ? `Left ${list} blocked: ` : ""}${why}`, { card: nums[0], thread: threadId, usage });
    else this.cardUsage(nums[0], threadId, usage);
    return { ids: moved.map((c) => c.id), nums, list, backTo };
  }

  /**
   * A chat ended without finishing: block the cards it still holds, and the ones the sweep already
   * released from it on a failed turn. A card the agent released itself keeps its own note.
   */
  blockChatCards(id: string, threadId: string, why: string, statusText: string, usage?: UsageTotals) {
    const ids = liveCards(this.state).filter((c) => {
      if (c.thread !== threadId) return false;
      if (c.claim && !c.claim.stale) return c.claim.thread === threadId;
      return isReady(colOf(this.state, c)) && c.status?.kind === "blocked" && /^The (agent's turn|chat thread)/.test(str(c.status.text));
    }).map((c) => c.id);
    return this.blockCards(id, ids, why, statusText, threadId, false, usage);
  }

  /** The cards a chat finished (review or done), whose work waits on its branch's merge. */
  unmergedCards(threadId: string): string[] {
    return liveCards(this.state).filter((c) => {
      const role = colOf(this.state, c)?.role;
      return c.thread === threadId && !(c.claim && !c.claim.stale) && (role === "review" || role === "done");
    }).map((c) => c.id);
  }

  /** A branch the agent couldn't get to merge: the cards its chat finished go back to their ready column, blocked. */
  mergeFailed(id: string, threadId: string, why: string, usage?: UsageTotals) {
    return this.blockCards(id, this.unmergedCards(threadId), `The board could not merge this card's branch, so its work isn't in yet: ${why} Sort it out from its chat's branch menu, then move the card on.`, "Branch didn't merge", threadId, false, usage);
  }

  /** Keep a chat with the worker's one-card runs, so it is wrapped up like one. */
  addSolo(id: string, threadId: string, entry: SoloRun): void {
    const solo = workerOf(this.state, id)?.solo;
    if (solo && typeof solo === "object") this.ops.push({ op: "merge", path: `${workerPath(id)}/solo`, value: { [threadId]: entry } });
    else this.patchWorker(id, { solo: { [threadId]: entry } });
  }

  forgetSolo(id: string, threadId: string): void {
    const left = Object.keys(workerOf(this.state, id)?.solo ?? {}).filter((k) => k !== threadId);
    if (!left.length) this.patchWorker(id, { solo: null });
    else this.ops.push({ op: "merge", path: `${workerPath(id)}/solo`, value: { [threadId]: null } });
  }

  /** Stop the worker, with the reason when it paused. Without clearThread, the next start merges its last chat first. */
  endRun(id: string, error: string | null, clearThread: boolean, usage?: UsageTotals): void {
    const w = workerOf(this.state, id);
    const stopping = w?.stop && Object.values(w.solo ?? {}).some((entry) => entry?.queued);
    const patch: Record<string, unknown> = { run: null, step: null, stop: stopping || null, error, merge: null, wait: null, fix: null };
    if (clearThread) patch.threadId = null;
    else if (w?.threadId) patch.merge = w.threadId;
    this.patchWorker(id, patch);
    const extra = { card: w?.run?.card, thread: w?.threadId, usage };
    if (error) this.log(id, "pause", error, extra);
    else this.log(id, "stop", "Stopped", extra);
  }

  /** One more card whose chat failed. A few in a row point at the worker itself, so it pauses then. Returns whether to go on. */
  chatFailed(id: string, why: string, usage?: UsageTotals): boolean {
    const fails = (Number(workerOf(this.state, id)?.fails) || 0) + 1;
    if (fails < MAX_CHAT_FAILS) {
      this.patchWorker(id, { fails });
      return true;
    }
    this.endRun(id, `${MAX_CHAT_FAILS} cards in a row didn't get done (${why}), so the worker paused: check its setup. Those cards are blocked with the reason; press ▶ to go on.`, true, usage);
    this.patchWorker(id, { fails: null });
    return false;
  }

  /** The branch merged after a pause: send the cards it sent back on to review (or done) again. */
  restoreMergeCards(id: string): void {
    const ids = arr<string>(workerOf(this.state, id)?.mergeCards);
    if (!ids.length) return;
    const target = roleColumn(this.state, "review") ?? roleColumn(this.state, "done");
    for (const c of cards(this.state)) {
      if (!target || !ids.includes(c.id) || !isReady(columnById(this.state, c.col)) || (c.claim && !c.claim.stale)) continue;
      this.ops.push({ op: "merge", path: cardPath(c), value: { status: null } });
      this.ops.push(...moveOps(this.state, c, target, this.now));
    }
    this.patchWorker(id, { mergeCards: null });
  }
}

// ---------- steps ----------

/**
 * The worker's last chat ended (its run's outcome): pause on a run that kept hitting its usage limit
 * or a merge no agent can fix; block the cards of a failed turn or a card it didn't finish; else go
 * on. Scribe has merged the branch already when it could. Returns whether to go on, and the cards it blocked.
 */
function wrapUp(plan: Plan, state: BoardState, id: string, w: Worker, threadId: string, info: Info, ctx: DriveContext): { go: boolean; blocked: string[] } {
  const run = info.exists ? info.run : undefined;
  const out: RunOutcome | undefined = run?.outcome;
  // The chat is gone: nothing to wrap up.
  if (!out || !info.exists) return { go: true, blocked: [] };
  const usage = compactUsage(info.usage);
  const card = w.run?.card;
  let go = true;
  let blocked: string[] = [];
  if (out.kind === "limit") {
    plan.endRun(id, `${str(out.error)} Its chat is kept; press ▶ to go on with the next card.`, true, usage);
    go = false;
  } else if (out.kind === "failed" || out.kind === "cancelled") {
    const how = out.kind === "failed" ? `failed${out.error ? `: ${out.error}` : ""}` : "was stopped";
    if (Number(run?.fixes) > 0) {
      // Its card is finished; only the branch is left, and it stays unmerged in its chat.
      blocked = plan.mergeFailed(id, threadId, `the agent's turn to fix it ${how}.`, usage).ids;
    } else {
      blocked = plan.blockChatCards(id, threadId, `The agent's turn ${how} before it finished this card. ${KEPT_NOTE}`, out.kind === "failed" ? "Agent turn failed" : "Agent turn stopped", usage).ids;
      go = plan.chatFailed(id, `the last agent's turn ${how}`, usage);
    }
  } else if (out.kind === "merge_failed") {
    if (out.fixable) {
      blocked = plan.mergeFailed(id, threadId, str(out.message), usage).ids;
    } else {
      // The main checkout's branch, a detached HEAD: the next merge would fail too.
      const r = plan.blockCards(id, plan.unmergedCards(threadId), `The board could not merge this card's branch, so its work isn't in yet: ${str(out.message)}`, "Branch didn't merge", threadId, true, usage);
      const which = r.list ? `the branch of ${r.list}` : "the agent's branch";
      const back = r.list && r.backTo ? ` ${r.list} ${r.nums.length === 1 ? "is" : "are"} back in ${r.backTo.title}.` : "";
      plan.endRun(id, `Could not merge ${which}: ${str(out.message)}${back} Sort it out from its chat's branch menu, or press ▶ to try again.`, false, usage);
      if (r.ids.length) plan.patchWorker(id, { mergeCards: r.ids });
      blocked = r.ids;
      go = false;
    }
  } else {
    const held = liveCards(state).filter((c) => c.claim && !c.claim.stale && c.claim.thread === threadId);
    const given = card ? cards(state).find((c) => c.num === card) : undefined;
    if (held.length) {
      // Scribe kept its branch unmerged; the chat keeps it.
      blocked = plan.blockChatCards(id, threadId, `The agent ended its turn without finishing this card. ${KEPT_NOTE}`, "Agent didn't finish", usage).ids;
      go = plan.chatFailed(id, `the last agent ended without finishing #${held[0].num}`, usage);
    } else if (given && isReady(columnById(state, given.col)) && (Number(given.movedAt) || 0) <= (Number(w.run?.startedAt) || 0)) {
      blocked = plan.blockCards(id, [given.id], "The agent's chat ended without taking this card. Comment here to let the worker try again.", "Agent didn't take it", threadId, false, usage).ids;
      go = plan.chatFailed(id, `the last agent didn't take #${given.num}`, usage);
    } else {
      if (w.fails) plan.patchWorker(id, { fails: null });
      if (out.merged) plan.restoreMergeCards(id);
      // Scribe merged it; the line carries the chat's token totals.
      plan.log(id, out.merged ? "merge" : "done", out.merged ? (card ? `Merged #${card}` : "Merged the agent's branch") : card ? `Finished #${card}` : "Finished the agent's chat", { card, thread: threadId, usage });
    }
  }
  ctx.release(threadId);
  return { go, blocked };
}

/** A one-card run ended: a problem with it is its card's, not the worker's, so the card is blocked and the worker goes on. */
function finishSolo(plan: Plan, state: BoardState, id: string, threadId: string, entry: SoloRun, info: Info, ctx: DriveContext): void {
  const cardNum = entry.card;
  const run = info.exists ? info.run : undefined;
  const out = run?.outcome;
  const usage = info.exists ? compactUsage(info.usage) : undefined;
  const what = `${entry.queued ? "Run" : "One-card run"}${cardNum ? ` #${cardNum}` : ""}`;
  const extra = { card: cardNum, thread: threadId, usage };
  if (out?.kind === "limit") {
    plan.blockChatCards(id, threadId, `${str(out.error)} ${KEPT_NOTE}`, "Out of plan usage", usage);
  } else if (out && (out.kind === "failed" || out.kind === "cancelled")) {
    const how = out.kind === "failed" ? `failed${out.error ? `: ${out.error}` : ""}` : "was stopped";
    if (Number(run?.fixes) > 0) plan.mergeFailed(id, threadId, `the agent's turn to fix it ${how}.`, usage);
    else if (entry.queued) plan.blockChatCards(id, threadId, `The agent's turn ${how} before it finished this card. ${KEPT_NOTE}`, out.kind === "failed" ? "Agent turn failed" : "Agent turn stopped", usage);
    else plan.log(id, "solo", `${what}: the agent's turn ${how}. Its chat keeps its branch.`, extra);
  } else if (out?.kind === "merge_failed") {
    plan.mergeFailed(id, threadId, str(out.message), usage);
  } else if (out?.held) {
    if (entry.queued) plan.blockChatCards(id, threadId, `The agent ended its turn without finishing this card. ${KEPT_NOTE}`, "Agent didn't finish", usage);
    else plan.log(id, "solo", `${what} ended without finishing its card (${out.held}). Its chat keeps its branch.`, extra);
  } else if (out) {
    if (entry.queued) {
      if (liveCards(state).some((c) => c.claim && !c.claim.stale && c.claim.thread === threadId)) {
        plan.blockChatCards(id, threadId, `The agent ended its turn without finishing this card. ${KEPT_NOTE}`, "Agent didn't finish", usage);
      }
      const given = cards(state).find((c) => c.num === cardNum);
      if (given && isReady(colOf(state, given)) && (Number(given.movedAt) || 0) <= (Number(entry.at) || 0) && given.status?.kind !== "blocked") {
        plan.blockCards(id, [given.id], "The agent's chat ended without taking this card. Comment here to let the worker try again.", "Agent didn't take it", threadId, false, usage);
      }
    }
    plan.log(id, out.merged ? "merge" : "done", `${out.merged ? "Merged" : "Finished"}${entry.queued ? "" : " one-card run"}${cardNum ? ` #${cardNum}` : ""}`, extra);
  }
  if (out) ctx.release(threadId);
  plan.forgetSolo(id, threadId);
  const w = workerOf(state, id);
  if (w?.stop && !w.run && !Object.entries(w.solo ?? {}).some(([tid, run]) => tid !== threadId && run?.queued)) plan.patchWorker(id, { stop: null });
}

/** A chat Scribe isn't seeing through yet (one from before Scribe had runs, or whose run was lost): hand it over. */
function needsWatch(info: Info): boolean {
  return info.exists && !info.running && !info.run;
}

/** Wrap up the first one-card run whose run has ended (Scribe waited out limits and merged it already). */
function soloStep(state: BoardState, id: string, w: Worker, ctx: DriveContext): DriveOutcome | null {
  for (const [tid, entry] of Object.entries(w.solo ?? {})) {
    if (!entry || typeof entry !== "object") continue;
    const info = ctx.thread(tid);
    if (info.exists && info.running) continue;
    if (needsWatch(info) && ctx.watch(tid, workerRun(w, id, entry.card, true, Number(entry.after) || 0))) continue;
    if (info.exists && info.run && info.run.phase !== "ended") continue;
    if (leased(entry.step, ctx.now)) continue;
    const plan = new Plan(state, ctx.now);
    finishSolo(plan, state, id, tid, entry, info, ctx);
    return plan.outcome();
  }
  return null;
}

/** One step of a running worker: wrap up its last chat, then start the next card, wait, or stop. */
function workerStep(state: BoardState, id: string, w: Worker, ctx: DriveContext): DriveOutcome | null {
  if (!w.run || leased(w.step, ctx.now)) return null;
  const plan = new Plan(state, ctx.now);
  let skip = new Set<string>();
  let parallel = false;
  const threadId = str(w.threadId);
  if (threadId) {
    const info = ctx.thread(threadId);
    parallel = Boolean(info.exists && (info.running || (info.run && info.run.phase !== "ended")));
    if (!parallel && needsWatch(info) && ctx.watch(threadId, workerRun(w, id, w.run.card, false, 0))) {
      // A click went on from a merge pause: Scribe merges it again, asking the agent to fix it if it can.
      if (w.merge === threadId) {
        plan.patchWorker(id, { merge: null });
        return plan.outcome();
      }
      return null;
    }
    if (!parallel) {
      const wrapped = wrapUp(plan, state, id, w, threadId, info, ctx);
      if (!wrapped.go) return plan.outcome();
      skip = new Set(wrapped.blocked);
    }
  } else if (!w.stop && (!nextCard(state, w, undefined, ctx.now) || atLimit(state, id, ctx.now, ctx.defaultProvider))) {
    return null;
  }
  const since = Number(w.run.since) || ctx.now;
  if (w.stop) {
    if (parallel) return null;
    plan.endRun(id, str(w.error) || null, true);
    return plan.outcome();
  }
  const c = nextCard(state, w, skip, ctx.now);
  const previous = c?.continuation?.thread || (c?.thread && sameName(c.threadAssignee, w.name) ? c.thread : undefined);
  const previousInfo = previous ? ctx.thread(previous) : undefined;
  // Never start a second chat while the card's previous chat is still being seen through.
  if (previousInfo?.exists && (previousInfo.running || (previousInfo.run && previousInfo.run.phase !== "ended"))) {
    if (c?.continuation && previousInfo.run?.data?.continuation === c.continuation.id) {
      // Delivery was accepted before a crash or before its result reached the board.
      return workerLaunched(state, { prompt: "", settings: workerSettings(w, c), run: workerRun(w, id, c.num, parallel), ref: { worker: id, card: c.num, token: w.step?.token, continuation: c.continuation.id, since, parallel } }, { threadId: previous! }, ctx.now);
    }
    return plan.empty ? null : plan.outcome();
  }
  if (!c || atLimit(state, id, ctx.now, ctx.defaultProvider, parallel)) {
    if (parallel) return null;
    plan.patchWorker(id, { threadId: null, step: null, merge: null, wait: null, fix: null, run: { since } });
    plan.log(id, "wait", !c ? "Waiting for cards" : "Waiting for a free slot");
    return plan.outcome();
  }
  const settings = workerSettings(w, c);
  const denied = ctx.mayStart(settings);
  if (denied) {
    if (c.continuation) return plan.empty ? null : plan.outcome();
    if (parallel) {
      plan.patchWorker(id, { stop: true, error: denied });
      plan.log(id, "pause", denied);
    } else plan.endRun(id, denied, true);
    return plan.outcome();
  }
  const token = newId("st");
  plan.patchWorker(id, { step: { token, at: ctx.now }, ...(!parallel ? { threadId: null, merge: null, wait: null, fix: null } : {}) });
  return plan.outcome({
    ...(previousInfo?.exists ? { resumeThread: previous } : {}),
    prompt: previousInfo?.exists
      ? `Continue the work on card #${c.num}. Get the card again and read it in full, including all submitted answers, before you go on. Follow the current worker instructions below.\n\n${workerPrompt(state, ctx.page, w, c, parallel)}`
      : workerPrompt(state, ctx.page, w, c, parallel),
    settings,
    run: { ...workerRun(w, id, c.num, parallel), data: { ...workerRun(w, id, c.num, parallel).data, ...(c.continuation ? { continuation: c.continuation.id } : {}) } },
    ref: { worker: id, card: c.num, token, since, startedAt: ctx.now, parallel, defaultProvider: ctx.defaultProvider, ...(c.continuation ? { continuation: c.continuation.id } : {}) },
  });
}

/** The daemon's next step for the board's workers, or null when none has one to take. */
export function driveWorkers(state: BoardState, ctx: DriveContext): DriveOutcome | null {
  // Assignment changes and archiving cancel requests rather than reviving them later.
  const cancelled = cards(state).filter((c) => c.continuation && (c.archived || !sameName(c.assignee, c.continuation.assignee) || !workerList(state).some(([, w]) => sameName(w.name, c.assignee))));
  if (cancelled.length) return { ops: cancelled.map((c) => ({ op: "merge", path: cardPath(c), value: { continuation: null } })), result: null };
  const readyOps = cards(state).filter((c) => c.continuation).flatMap((c) => continuationReadyOps(state, c, ctx.now));
  if (readyOps.length) return { ops: readyOps, result: null };
  const idleClaim = cards(state).find((c) => {
    if (!c.continuation || !c.claim?.thread || c.claim.thread !== c.continuation.thread) return false;
    const info = ctx.thread(c.claim.thread);
    return !info.exists || (!info.running && (!info.run || info.run.phase === "ended"));
  });
  if (idleClaim) return { ops: [{ op: "merge", path: cardPath(idleClaim), value: { claim: null } }], result: null };
  const ids = workerIds(state);
  for (const id of ids) {
    const w = workerOf(state, id);
    const out = w && soloStep(state, id, w, ctx);
    if (out) return out;
  }
  for (const id of ids) {
    const w = workerOf(state, id);
    const out = w && workerStep(state, id, w, ctx);
    if (out) return out;
  }
  return null;
}

/** A pending dispatch must still own its lease and satisfy current board conditions. */
export function workerLaunchAllowed(state: BoardState, launch: PageLaunch, now: number): boolean {
  const c = cards(state).find((c) => c.num === launch.ref.card);
  if (c && cardScheduled(c, now)) return false;
  const w = workerOf(state, str(launch.ref.worker));
  return Boolean(w?.run && !w.stop && leased(w.step, now) && w.step?.token === launch.ref.token && c &&
    (!launch.ref.continuation || c.continuation?.id === launch.ref.continuation) && !c.archived &&
    workerCards(state, w).some((candidate) => candidate.id === c.id) &&
    cardTakeable(state, c, now) && !atLimit(state, str(launch.ref.worker), now, str(launch.ref.defaultProvider), launch.ref.parallel === true));
}

/** The claim worker_claim makes: the card held by the new chat under the worker's name, in the working column. */
export function claimOps(state: BoardState, card: Card, thread: string, name: string, now: number, text = "Agent starting"): unknown[] {
  const working = roleColumn(state, "working");
  const from = claimFrom(state, card);
  const links = claimLinks(card, thread);
  const ops: unknown[] = [
    { op: "test", path: `${cardPath(card)}/claim`, value: card.claim ?? null },
    {
      op: "merge",
      path: cardPath(card),
      value: {
        assignee: name,
        status: { kind: "working", text },
        claim: { holder: name, thread, at: now, seenAt: now, ...(from ? { from } : {}), ...(links.length ? { links } : {}) },
        thread,
        threadAssignee: name,
        ...(from ? { from } : {}),
      },
    },
  ];
  if (working) ops.push(...moveOps(state, card, working, now));
  return ops;
}

/** The chat a step launched started (or didn't): record it on the worker and claim its card for it. */
export function workerLaunched(state: BoardState, launch: PageLaunch, result: { threadId: string } | { error: string }, now: number): ActionOutcome | null {
  const id = str(launch.ref.worker);
  const w = workerOf(state, id);
  if (!w) return null;
  const plan = new Plan(state, now);
  const cardNum = Number(launch.ref.card) || undefined;
  const ours = w.step?.token === launch.ref.token;
  if ("error" in result) {
    if (ours && result.error.startsWith("Worker conditions changed")) {
      plan.patchWorker(id, { step: null });
      return plan.outcome();
    }
    // A worker stopped meanwhile keeps its state.
    if (ours && w.run) {
      if (launch.ref.parallel) {
        plan.patchWorker(id, { step: null, stop: true, error: result.error });
        plan.log(id, "pause", result.error, { card: cardNum });
      } else plan.endRun(id, result.error, true);
    }
    return plan.empty ? null : plan.outcome();
  }
  const threadId = result.threadId;
  const c = cardNum ? cards(state).find((x) => x.num === cardNum) : undefined;
  if (ours && w.run && !launch.ref.parallel) {
    plan.patchWorker(id, { threadId, step: null, merge: null, wait: null, fix: null, error: null, run: { since: Number(launch.ref.since) || now, card: cardNum, startedAt: Number(launch.ref.startedAt) || now } });
  } else {
    // Additional slots and chats accepted while stopping each keep their own one-card lifecycle.
    if (ours) plan.patchWorker(id, { step: null });
    plan.addSolo(id, threadId, { card: cardNum, at: now, ...(launch.ref.parallel && w.run ? { queued: true } : {}) });
  }
  const resumed = launch.resumeThread === threadId;
  plan.log(id, resumed ? "resume" : "launch", `${resumed ? "Continued" : "Started"} #${cardNum} ${str(c?.title).slice(0, 80)}`, { card: cardNum, thread: threadId });
  const name = str(w.name).trim() || str(c?.assignee).trim() || "agent";
  if (c && !(c.claim && !c.claim.stale && c.claim.thread !== threadId)) plan.ops.push(...claimOps(state, c, threadId, name, now));
  if (c?.continuation && c.continuation.id === launch.ref.continuation) {
    if (c.continuation.comment && arr<Comment>(c.comments).some((cm) => cm.id === c.continuation!.comment)) {
      plan.ops.push({ op: "merge", path: `${cardPath(c)}/comments/id=${c.continuation.comment}`, value: { followUp: "continued" } });
    }
    plan.ops.push({ op: "merge", path: cardPath(c), value: { continuation: null } });
  }
  return plan.outcome();
}

/** The user started the worker (its ▶): it runs, and the daemon's next step starts its first card. */
export function workerStartOps(state: BoardState, id: string, w: Worker, now: number): unknown[] {
  const plan = new Plan(state, now);
  plan.patchWorker(id, { run: { since: now }, stop: null, error: null, step: null });
  plan.log(id, "start", "Started");
  if (!w.merge || w.merge !== w.threadId) {
    if (!nextCard(state, w, undefined, now)) plan.log(id, "wait", "Waiting for cards");
    else if (atLimit(state, id, now)) plan.log(id, "wait", "Waiting for a free slot");
  }
  return plan.outcome().ops;
}
