import type { Turn } from "./types.js";

/**
 * Agent runs: chats a page hands to Scribe to see through to the end (#285). The page decides what
 * to start and what an outcome means for its own data; Scribe owns the part every page would get
 * wrong on its own: waiting out a plan usage limit until the provider confirms it has reset and
 * sending the chat on, merging its worktree branch once it is done, and asking the agent to fix a
 * branch that won't merge. Because this lives in Scribe and not in a template's HTML, fixes reach
 * every page, customized copies included, and runs go on while no window shows the page.
 */

/** How long after a plan limit resets the chat is sent on, so the new usage is in. */
export const RESUME_DELAY_MS = 60 * 1000;
export const CAPACITY_RETRY_MS = 10 * 60 * 1000;
/** While the provider has not confirmed the reset: how soon to look again (this does not use up a try). */
export const RECOVERY_RECHECK_MS = 60 * 1000;
/** Limit waits in one run before it ends with outcome "limit". */
export const MAX_LIMIT_WAITS = 8;
/** Failed sends after a reset before the run ends; the first retry waits RESUME_RETRY_MS, doubling. */
export const MAX_RESUME_TRIES = 5;
export const RESUME_RETRY_MS = 60 * 1000;
const MAX_RESUME_BACKOFF_MS = 8 * 60 * 1000;
/** Times the agent is asked to fix a branch that won't merge before the run ends with "merge_failed". */
export const MAX_MERGE_FIXES = 2;
/** A run whose chat never ran a turn after it was handed over ends after this long. */
export const NO_TURN_MS = 10 * 60 * 1000;
/** Ended runs nobody released are dropped after this long. */
export const ENDED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_RESUME_PROMPT =
  "Your plan's usage limit has reset. Go on where you left off: check your task and the work you have done so far, then finish it as before.";
export const MERGE_FIX_PROMPT =
  "Rebase your branch onto the branch the worktree was made from (the one checked out in the main checkout; see git worktree list), resolve any conflicts keeping both sides' changes, run the checks, and commit, so the worktree is clean. Don't start other work. Then end your turn with a short summary; Scribe tries the merge again.";

export type RunOutcome = {
  /**
   * done: the agent's turn finished (and its branch merged, when asked). failed / cancelled: its
   * turn failed or was stopped. limit: it kept running out of plan usage. merge_failed: its branch
   * still won't merge (after the agent's fixes, when it could fix it).
   */
  kind: "done" | "failed" | "cancelled" | "limit" | "merge_failed";
  /** The turn's error, or why sending it on failed. */
  error?: string;
  /** done: whether a branch was merged. Missing when there was no worktree or merge was off. */
  merged?: boolean;
  /** Scribe's message about the merge, or why it failed. */
  message?: string;
  /** merge_failed: whether an agent could have fixed it (false: the main checkout's branch, a detached HEAD). */
  fixable?: boolean;
  /** done without a merge: the page's reason to keep the branch unmerged (a Kanban card the chat still holds). */
  held?: string;
};

export type PageRun = {
  threadId: string;
  pageId: string;
  /** The page's own label and data for the run, returned as given (e.g. { worker, card }). */
  tag?: string;
  data?: Record<string, unknown>;
  /** Merge the worktree branch when the agent is done. */
  merge: boolean;
  /** Sent when a plan usage limit has reset. */
  resumePrompt?: string;
  /** Only turns started at or after this count. */
  after: number;
  phase: "running" | "waiting" | "ended";
  wait?: { until: number; count: number; tries?: number; turn?: string; reason?: "capacity" };
  /** Times the agent was asked to fix the merge. */
  fixes: number;
  outcome?: RunOutcome;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};

/** What a page sees of a run: on its threads (scribe.agent), in agent_run events, and in action sweeps. */
export type PageRunView = Pick<PageRun, "phase" | "fixes" | "after" | "createdAt"> & {
  tag?: string;
  data?: Record<string, unknown>;
  merge: boolean;
  wait?: { until: number; count: number; reason?: "capacity" };
  outcome?: RunOutcome;
  endedAt?: number;
};

export type RunInput = { tag?: unknown; data?: unknown; merge?: unknown; resumePrompt?: unknown; after?: unknown };

/** A run's page-facing note: logged as an agent_run event and passed to the page's action set. */
export type RunNote = {
  kind: "limit" | "resume" | "merge_fix" | "end";
  text: string;
  /** limit: when the plan limit resets. */
  resetsAt?: number;
};

export type RunDeps = {
  now(): number;
  /** The thread exists, has no running turn, nothing queued, and no restart resume pending. */
  idle(threadId: string): boolean;
  exists(threadId: string): boolean;
  lastTurn(threadId: string): Turn | undefined;
  /** Whether the provider confirmed the plan let the thread go again after the limit turn. */
  recoveryAllowed(threadId: string, turn: Turn): boolean;
  hasWorktree(threadId: string): boolean;
  /** The page's reason to keep the branch unmerged, from its template's actions; null to merge. */
  hold(run: PageRun): string | null | Promise<string | null>;
  /** Throws when the message could not be sent. */
  send(threadId: string, text: string): void;
  /** Merges and closes the worktree; resolves with Scribe's message, throws with why it didn't. */
  merge(threadId: string): Promise<string>;
  save(runs: PageRun[]): void;
  changed(run: PageRun, note?: RunNote): void;
};

export function runView(run: PageRun): PageRunView {
  return {
    phase: run.phase,
    fixes: run.fixes,
    after: run.after,
    createdAt: run.createdAt,
    merge: run.merge,
    ...(run.tag ? { tag: run.tag } : {}),
    ...(run.data ? { data: run.data } : {}),
    ...(run.phase === "waiting" && run.wait ? { wait: { until: run.wait.until, count: run.wait.count, ...(run.wait.reason ? { reason: run.wait.reason } : {}) } } : {}),
    ...(run.outcome ? { outcome: run.outcome } : {}),
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
  };
}

/** Whether an agent can sort out a failed merge in its worktree (not the main checkout's branch or a detached HEAD). */
export function agentCanFixMerge(why: string): boolean {
  return !/main checkout is on|detached HEAD/i.test(why);
}

function cleanData(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const text = JSON.stringify(value);
  if (text.length > 4000) throw new Error("run data is limited to 4000 characters of JSON");
  return JSON.parse(text) as Record<string, unknown>;
}

function turnText(turn: Turn): string {
  return turn.status === "error" ? `failed${turn.error ? `: ${turn.error}` : ""}` : "was stopped";
}

export class PageRuns {
  private runs = new Map<string, PageRun>();
  private busy = new Map<string, Promise<void>>();

  constructor(private deps: RunDeps, saved: PageRun[] = []) {
    for (const run of saved) {
      if (run && typeof run.threadId === "string" && typeof run.pageId === "string") this.runs.set(run.threadId, run);
    }
  }

  get(threadId: string): PageRun | undefined {
    return this.runs.get(threadId);
  }

  list(): PageRun[] {
    return [...this.runs.values()];
  }

  /**
   * Hand a page's thread to Scribe. A new run replaces an earlier one on the same thread. after
   * defaults to now: hand it over before sending the message that starts its turn. after: 0 takes
   * the thread as it is, so an idle thread whose last turn is done is merged at once.
   */
  register(threadId: string, pageId: string, input: RunInput): PageRun {
    const now = this.deps.now();
    const prompt = typeof input.resumePrompt === "string" ? input.resumePrompt.trim().slice(0, 20000) : "";
    const tag = typeof input.tag === "string" ? input.tag.trim().slice(0, 200) : "";
    const data = cleanData(input.data);
    const after = typeof input.after === "number" && Number.isFinite(input.after) ? Math.max(0, input.after) : now;
    const run: PageRun = {
      threadId,
      pageId,
      ...(tag ? { tag } : {}),
      ...(data ? { data } : {}),
      merge: input.merge !== false,
      ...(prompt ? { resumePrompt: prompt } : {}),
      after,
      phase: "running",
      fixes: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(threadId, run);
    this.persist();
    this.deps.changed(run);
    void this.check(threadId);
    return run;
  }

  /** Scribe stops seeing the thread through, and forgets an ended run. The chat itself is left alone. */
  release(threadId: string): boolean {
    const run = this.runs.get(threadId);
    if (!run) return false;
    this.runs.delete(threadId);
    this.persist();
    this.deps.changed(run);
    return true;
  }

  /** Look at every unfinished run: limit waits that are due, chats that never started, ended runs to drop. */
  tick(): void {
    const now = this.deps.now();
    for (const run of this.list()) {
      if (run.phase === "ended") {
        if (now - (run.endedAt ?? run.updatedAt) > ENDED_TTL_MS) this.runs.delete(run.threadId);
        continue;
      }
      void this.check(run.threadId);
    }
  }

  /** Move a run on once its thread is idle. Safe to call any time; one check at a time per thread, then another for what changed meanwhile. */
  check(threadId: string): Promise<void> {
    const running = this.busy.get(threadId);
    if (running) return running.then(() => this.check(threadId));
    const run = this.runs.get(threadId);
    if (!run || run.phase === "ended") return Promise.resolve();
    const done = this.step(run)
      .catch((err) => this.end(run, { kind: "failed", error: (err as Error).message || String(err) }))
      .finally(() => this.busy.delete(threadId));
    this.busy.set(threadId, done);
    return done;
  }

  private async step(run: PageRun): Promise<void> {
    const { deps } = this;
    const now = deps.now();
    if (!deps.exists(run.threadId)) {
      this.end(run, { kind: "failed", error: "The chat was deleted." });
      return;
    }
    if (!deps.idle(run.threadId)) return;
    const turn = deps.lastTurn(run.threadId);

    if (run.phase === "waiting" && run.wait) {
      if (now < run.wait.until) return;
      const capacity = run.wait.reason === "capacity";
      if (!capacity && turn && !deps.recoveryAllowed(run.threadId, turn)) {
        // Not confirmed yet: look again soon, without using up a try.
        this.update(run, { wait: { ...run.wait, until: now + RECOVERY_RECHECK_MS } });
        return;
      }
      try {
        const prompt = run.resumePrompt || DEFAULT_RESUME_PROMPT;
        deps.send(run.threadId, capacity
          ? `Retrying after waiting for model capacity. ${prompt.replace("Your plan's usage limit has reset. ", "")}`
          : prompt);
      } catch (err) {
        const why = (err as Error).message || String(err);
        const tries = (run.wait.tries ?? 0) + 1;
        if (tries > MAX_RESUME_TRIES) {
          this.end(run, { kind: "failed", error: `Could not send the agent on after ${capacity ? "waiting for model capacity" : "its usage limit reset"}: ${why}` });
          return;
        }
        const backoff = Math.min(RESUME_RETRY_MS * 2 ** (tries - 1), MAX_RESUME_BACKOFF_MS);
        this.update(run, { wait: { ...run.wait, until: now + backoff, tries } }, { kind: "resume", text: `Could not resume yet (${why}); try ${tries} of ${MAX_RESUME_TRIES}` });
        return;
      }
      this.update(run, { phase: "running", after: now, wait: { until: 0, count: run.wait.count } }, { kind: "resume", text: capacity ? "Sent the agent on after waiting for model capacity" : "Sent the agent on after its usage limit reset" });
      return;
    }

    if (!turn || turn.startedAt < run.after) {
      if (now - run.after > NO_TURN_MS) this.end(run, { kind: "failed", error: "The chat never started a turn." });
      return;
    }

    const capacity = turn.status === "error" && /\bmodel\b[^\n.]*\bat capacity\b/i.test(turn.error ?? "");
    if (turn.status === "error" && (turn.limitResetsAt || capacity)) {
      if (run.wait?.turn === turn.id) return;
      const count = (run.wait?.count ?? 0) + 1;
      if (count > MAX_LIMIT_WAITS) {
        this.end(run, { kind: "limit", error: `The agent kept ${capacity ? "hitting model capacity" : "running out of plan usage"} (${MAX_LIMIT_WAITS} waits in a row).` });
        return;
      }
      if (capacity) {
        const until = now + CAPACITY_RETRY_MS;
        this.update(run, { phase: "waiting", wait: { until, count, turn: turn.id, reason: "capacity" } }, { kind: "limit", text: `Model is at capacity; retrying in 10 minutes (wait ${count} of ${MAX_LIMIT_WAITS})`, resetsAt: until });
        return;
      }
      const until = turn.limitResetsAt! + RESUME_DELAY_MS;
      this.update(run, { phase: "waiting", wait: { until, count, turn: turn.id } }, { kind: "limit", text: `Out of plan usage until ${new Date(turn.limitResetsAt!).toISOString()} (wait ${count} of ${MAX_LIMIT_WAITS})`, resetsAt: turn.limitResetsAt });
      return;
    }
    if (turn.status === "error" || turn.status === "cancelled") {
      this.end(run, { kind: turn.status === "error" ? "failed" : "cancelled", ...(turn.error ? { error: turn.error } : {}) }, `The agent's turn ${turnText(turn)}`);
      return;
    }
    if (turn.status !== "done") return;

    if (!run.merge || !deps.hasWorktree(run.threadId)) {
      this.end(run, { kind: "done" });
      return;
    }
    const held = await deps.hold(run);
    if (held) {
      this.end(run, { kind: "done", merged: false, held }, `Kept the branch unmerged: ${held}`);
      return;
    }
    let message: string;
    try {
      message = await deps.merge(run.threadId);
    } catch (err) {
      const why = (err as Error).message || String(err);
      const fixable = agentCanFixMerge(why);
      if (fixable && run.fixes < MAX_MERGE_FIXES) {
        // Taken before sending: the fix turn starts inside send, and a later time would make it
        // look older than the run, so it never counted and the run ended "never started a turn" (#319).
        const sentAt = deps.now();
        try {
          deps.send(run.threadId, `Scribe could not merge your branch: ${why}\n\n${MERGE_FIX_PROMPT}`);
        } catch (sendErr) {
          this.end(run, { kind: "merge_failed", message: why, fixable, error: (sendErr as Error).message });
          return;
        }
        const fixes = run.fixes + 1;
        this.update(run, { fixes, after: sentAt }, { kind: "merge_fix", text: `Asked the agent to fix the merge (${fixes} of ${MAX_MERGE_FIXES}): ${why}` });
        return;
      }
      this.end(run, { kind: "merge_failed", message: why, fixable });
      return;
    }
    this.end(run, { kind: "done", merged: true, message });
  }

  private update(run: PageRun, patch: Partial<PageRun>, note?: RunNote): void {
    Object.assign(run, patch, { updatedAt: this.deps.now() });
    this.persist();
    this.deps.changed(run, note);
  }

  private end(run: PageRun, outcome: RunOutcome, text?: string): void {
    if (!this.runs.has(run.threadId)) return;
    const now = this.deps.now();
    Object.assign(run, { phase: "ended", outcome, endedAt: now, updatedAt: now });
    this.persist();
    const say = text ?? (outcome.kind === "done"
      ? outcome.merged ? `Done; ${outcome.message ?? "merged"}` : "Done"
      : outcome.kind === "merge_failed" ? `Could not merge: ${outcome.message ?? ""}` : outcome.error ?? outcome.kind);
    this.deps.changed(run, { kind: "end", text: say });
  }

  private persist(): void {
    this.deps.save(this.list());
  }
}
