import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import { claudeBillingSource, claudePlanSnapshot } from "./claudeUsage.js";
import {
  DEFAULT_ACCOUNT, accountScore, accountsRoot, cleanAccountsState, combineLimits, pickAccount, planLabel, planWeight,
  prepareProfile, readAccountProfile, removeProfile, swapLogin, type ClaudeAccount, type ClaudeAccountsState, type PickCandidate,
} from "./claudeAccounts.js";
import { livePlanLimits, nextRefreshAt } from "./planLimits.js";
import { isPlainRecord, type PlanLimits, type Thread } from "./types.js";

/** What the pool needs from Claude's provider: logins and usage reads per config folder. */
export type AccountProvider = {
  loginAccount(dir: string, signal?: AbortSignal): Promise<boolean>;
  accountStatus(dir: string): Promise<{ loggedIn: boolean } | null>;
  logoutAccount(id: string, dir: string): Promise<void>;
  fetchPlanUsage(dir?: string): Promise<unknown | null>;
  /** Whether the default login is signed in, as last checked; null when not checked yet. */
  signedIn(): boolean | null;
};

export type PoolDeps = {
  getSetting<T>(key: string, fallback: T): T;
  setSetting(key: string, value: unknown): void;
  provider: () => AccountProvider;
  dataDir: string;
  /** The default account's usage (the host's own Claude snapshot). */
  defaultLimits: () => PlanLimits | undefined;
  /** Claude chats running now on an account. */
  running: (account: string) => number;
  /** Accounts, their usage or the pick changed. */
  changed: () => void;
  /** No logins or usage reads (fake agents in tests). */
  offline?: boolean;
};

export type AccountView = {
  id: string;
  email?: string;
  plan?: string;
  weight: number;
  default: boolean;
  limits?: PlanLimits;
};

/** A chat's account sticks while its prompt cache can still be warm; after that it may move. */
const STICKY_MS = 60 * 60 * 1000;
const MIN_FETCH_GAP_MS = 60_000;

/**
 * Several Claude subscriptions (#452): the added accounts, which one each new chat runs on, and their
 * usage. With no added account it stays out of the way: chats run on the default login as before.
 */
export class ClaudeAccountPool {
  private state: ClaudeAccountsState;
  private limits: Record<string, PlanLimits>;
  private fetchedAt = new Map<string, number>();
  private timers = new Map<string, NodeJS.Timeout>();
  private fetching = new Map<string, Promise<void>>();
  /** An account being signed in: its id until the browser sign-in ends. */
  adding: string | null = null;
  private addAbort: AbortController | null = null;
  /** What went wrong with the last sign-in, for the accounts popup. */
  lastError: string | null = null;

  constructor(private deps: PoolDeps) {
    this.state = cleanAccountsState(deps.getSetting("claudeAccounts", null));
    const saved = deps.getSetting<Record<string, PlanLimits>>("claudeAccountLimits", {});
    this.limits = Object.fromEntries(Object.entries(saved).filter(([id]) => this.state.accounts.some((a) => a.id === id)));
    if (!deps.offline) {
      for (const a of this.state.accounts) this.schedule(a.id, 5_000);
      this.sweepFolders();
    }
  }

  /** Folders of sign-ins that never finished (the daemon stopped meanwhile). */
  private sweepFolders(): void {
    const root = accountsRoot(this.deps.dataDir);
    try {
      for (const name of fs.readdirSync(root)) {
        if (/^acc_[0-9a-f]+$/.test(name) && !this.state.accounts.some((a) => a.id === name)) removeProfile(path.join(root, name));
      }
    } catch {
      /* no folder yet */
    }
  }

  /** True once an account has been added: chats are then spread over several. */
  multi(): boolean {
    return this.state.accounts.length > 0;
  }

  get use(): string {
    return this.state.use;
  }

  private account(id: string | undefined): ClaudeAccount | null {
    return id ? this.state.accounts.find((a) => a.id === id) ?? null : null;
  }

  private valid(id: string | undefined): id is string {
    return id === DEFAULT_ACCOUNT ? this.deps.provider().signedIn() !== false : Boolean(this.account(id));
  }

  /** The environment a session on this account starts with. Refreshes the folder's shared files first. */
  env(id: string | undefined): Record<string, string> {
    const acc = this.account(id);
    if (!acc?.dir) return {};
    try {
      prepareProfile(acc.dir);
    } catch (err) {
      log(`Claude account folder ${acc.dir}: ${(err as Error).message}`);
    }
    return { CLAUDE_CONFIG_DIR: acc.dir };
  }

  /** Every account with its plan and live usage, default first. */
  list(): AccountView[] {
    const base = readAccountProfile(null);
    const rows: AccountView[] = [];
    if (this.deps.provider().signedIn() !== false) {
      const limits = this.deps.defaultLimits();
      rows.push({ id: DEFAULT_ACCOUNT, default: true, weight: planWeight(base), ...(base.email ? { email: base.email } : {}),
        ...(planLabel(base) ? { plan: planLabel(base) } : {}), ...(limits ? { limits: livePlanLimits(limits) } : {}) });
    }
    for (const a of this.state.accounts) {
      const limits = this.limits[a.id];
      rows.push({ id: a.id, default: false, weight: planWeight(a), ...(a.email ? { email: a.email } : {}),
        ...(planLabel(a) ? { plan: planLabel(a) } : {}), ...(limits ? { limits: livePlanLimits(limits) } : {}) });
    }
    return rows;
  }

  label(id: string | undefined): string {
    const row = this.list().find((r) => r.id === (id ?? DEFAULT_ACCOUNT));
    return row?.email ?? (id === DEFAULT_ACCOUNT || !id ? "the default account" : "another account");
  }

  /** The default account's live usage averaged with the added ones', and the next chat's pick; null with only one account. */
  combined(): PlanLimits | null {
    if (!this.multi()) return null;
    const out = combineLimits(this.list().map((r) => ({ id: r.id, weight: r.weight, ...(r.email ? { email: r.email } : {}), ...(r.plan ? { plan: r.plan } : {}),
      ...(r.limits ? { limits: r.limits } : {}) })));
    const next = out && this.peek();
    return out && next ? { ...out, nextAccount: next } : out;
  }

  private candidates(exclude?: string): PickCandidate[] {
    return this.list().filter((r) => r.id !== exclude).map((r) => ({ id: r.id, weight: r.weight, running: this.deps.running(r.id),
      lastPickedAt: this.state.picked[r.id], ...(r.limits ? { limits: r.limits } : {}) }));
  }

  /**
   * The account a chat's next session runs on. One account: none (the default, as before). Pinned:
   * that one. A chat keeps its account while its cache may be warm, and otherwise gets the pick.
   */
  resolve(thread: Pick<Thread, "claudeAccount">, idleSince: number | null, now = Date.now()): string | undefined {
    if (!this.multi()) return undefined;
    if (this.state.use !== "distribute" && this.valid(this.state.use)) return this.state.use;
    const current = thread.claudeAccount;
    if (this.valid(current) && (idleSince == null || now - idleSince < STICKY_MS)) return current;
    const picked = pickAccount(this.candidates(), now) ?? DEFAULT_ACCOUNT;
    if (picked !== current) {
      this.state.picked = { ...this.state.picked, [picked]: now };
      this.save();
    }
    return picked;
  }

  /** The pick for a chat about to start, without counting it as picked (spare sessions). */
  peek(now = Date.now()): string | undefined {
    if (!this.multi()) return undefined;
    if (this.state.use !== "distribute" && this.valid(this.state.use)) return this.state.use;
    return pickAccount(this.candidates(), now) ?? DEFAULT_ACCOUNT;
  }

  /** Another account with room now, for a chat whose account hit its limit; null when none or pinned. */
  alternative(current: string | undefined, now = Date.now()): { account: string; label: string } | null {
    if (!this.multi() || this.state.use !== "distribute") return null;
    const open = this.candidates(current ?? DEFAULT_ACCOUNT).filter((c) => accountScore(c, now) !== null);
    const id = pickAccount(open, now);
    return id ? { account: id, label: this.label(id) } : null;
  }

  isAccount(id: string): boolean {
    return this.valid(id);
  }

  setUse(use: string): void {
    if (use !== "distribute" && !this.valid(use)) throw new Error("No such Claude account.");
    this.state.use = use;
    this.save();
    this.deps.changed();
  }

  /** A turn on an added account reported usage. Older or empty readings are left out. */
  record(id: string, next: PlanLimits): void {
    if (!this.account(id)) return;
    const merged = mergeClaudeLimits(this.limits[id], next);
    if (!merged) return;
    this.commit(id, merged.limits);
  }

  private commit(id: string, limits: PlanLimits): void {
    this.limits = { ...this.limits, [id]: limits };
    this.deps.setSetting("claudeAccountLimits", this.limits);
    this.schedule(id);
    this.deps.changed();
  }

  /** Read an added account's usage without a model message, at most once a minute. */
  refresh(id: string): Promise<void> {
    const acc = this.account(id);
    if (!acc?.dir || this.deps.offline) return Promise.resolve();
    const running = this.fetching.get(id);
    if (running) return running;
    const since = Date.now() - (this.fetchedAt.get(id) ?? 0);
    if (since < MIN_FETCH_GAP_MS) {
      this.schedule(id, MIN_FETCH_GAP_MS - since);
      return Promise.resolve();
    }
    this.fetchedAt.set(id, Date.now());
    const dir = acc.dir;
    const job = (async () => {
      const before = this.limits[id];
      const value = await this.deps.provider().fetchPlanUsage(dir).catch(() => null);
      if (!this.account(id) || this.limits[id] !== before) return;
      const wrapper = isPlainRecord(value) ? value : {};
      const parsed = claudePlanSnapshot(wrapper.report, claudeBillingSource(wrapper.billingSource), Date.now(), before);
      if (parsed.availability === "available" || before?.availability !== "available") this.commit(id, parsed);
    })().finally(() => {
      this.fetching.delete(id);
      this.schedule(id);
    });
    this.fetching.set(id, job);
    return job;
  }

  /** Read again when a window resets (or after delay). */
  private schedule(id: string, delay?: number): void {
    if (this.deps.offline) return;
    const old = this.timers.get(id);
    if (old) clearTimeout(old);
    this.timers.delete(id);
    const at = nextRefreshAt(this.limits[id]);
    const wait = delay ?? (at == null ? null : Math.max(MIN_FETCH_GAP_MS, at - Date.now() + 2000));
    if (wait == null) return;
    const timer = setTimeout(() => void this.refresh(id), Math.min(wait, 7 * 24 * 60 * 60 * 1000));
    timer.unref?.();
    this.timers.set(id, timer);
  }

  /**
   * Start the browser sign-in for another account. It joins the list once signed in. Closing the
   * browser does not end Claude Code's sign-in, so adding again replaces one still waiting.
   */
  add(): void {
    this.cancelAdd();
    const abort = new AbortController();
    this.addAbort = abort;
    const id = `acc_${crypto.randomBytes(5).toString("hex")}`;
    const dir = path.join(accountsRoot(this.deps.dataDir), id);
    prepareProfile(dir);
    this.adding = id;
    this.lastError = null;
    this.deps.changed();
    const provider = this.deps.provider();
    void provider.loginAccount(dir, abort.signal)
      .then(async (ok) => {
        const status = ok && !abort.signal.aborted ? await provider.accountStatus(dir) : null;
        if (!status?.loggedIn) {
          if (!abort.signal.aborted) this.lastError = "The sign-in did not finish.";
          removeProfile(dir);
          return;
        }
        const profile = readAccountProfile(dir);
        const known = [readAccountProfile(null).email, ...this.state.accounts.map((a) => a.email)].filter(Boolean);
        if (profile.email && known.includes(profile.email)) {
          // Only the folder goes: logging this copy out could end the other login's session too.
          this.lastError = `${profile.email} is already signed in. Sign in with another Claude account.`;
          removeProfile(dir);
          return;
        }
        this.state.accounts = [...this.state.accounts, { id, dir, ...profile, addedAt: Date.now() }];
        this.save();
        void this.refresh(id);
      })
      .catch((err) => {
        this.lastError = (err as Error).message;
        try {
          removeProfile(dir);
        } catch {
          /* leave it */
        }
      })
      .finally(() => {
        if (this.adding !== id) return;
        this.adding = null;
        this.addAbort = null;
        this.deps.changed();
      });
  }

  /** Stop a sign-in still waiting for the browser. */
  cancelAdd(): void {
    if (!this.addAbort) return;
    this.addAbort.abort();
    this.addAbort = null;
    this.adding = null;
    this.lastError = null;
    this.deps.changed();
  }

  /**
   * Make an added account Claude Code's own login (#452): it trades sign-ins with the default folder,
   * which the Claude Code CLI uses. The ids keep their folders, so their profiles, the pinned account
   * and pick times trade places too. Returns the added account's usage, which now belongs to the
   * default; the default's goes to the added one. The caller checks that no chat runs on either.
   */
  swapWithDefault(id: string, defaultLimits: PlanLimits | undefined): PlanLimits | undefined {
    const acc = this.account(id);
    if (!acc?.dir) throw new Error("No such Claude account.");
    const before = readAccountProfile(null);
    swapLogin(acc.dir);
    const { email: _e, orgName: _o, plan: _p, tier: _t, ...rest } = acc;
    const next: ClaudeAccount = { ...rest, ...before };
    this.state.accounts = this.state.accounts.map((a) => (a.id === id ? next : a));
    const trade = (value: string) => (value === id ? DEFAULT_ACCOUNT : value === DEFAULT_ACCOUNT ? id : value);
    this.state.use = trade(this.state.use);
    this.state.picked = Object.fromEntries(Object.entries(this.state.picked).map(([k, v]) => [trade(k), v]));
    const theirs = this.limits[id];
    const { [id]: _old, ...others } = this.limits;
    this.limits = defaultLimits ? { ...others, [id]: defaultLimits } : others;
    this.deps.setSetting("claudeAccountLimits", this.limits);
    this.save();
    this.schedule(id, MIN_FETCH_GAP_MS);
    this.deps.changed();
    return theirs;
  }

  /** Log an added account out and forget it. The caller checks that no chat runs on it. */
  async remove(id: string): Promise<void> {
    const acc = this.account(id);
    if (!acc?.dir) throw new Error("No such Claude account.");
    await this.deps.provider().logoutAccount(id, acc.dir).catch((err) => log(`Claude account log out: ${(err as Error).message}`));
    removeProfile(acc.dir);
    this.state.accounts = this.state.accounts.filter((a) => a.id !== id);
    if (this.state.use === id) this.state.use = "distribute";
    const { [id]: _gone, ...rest } = this.state.picked;
    this.state.picked = rest;
    const { [id]: _limits, ...left } = this.limits;
    this.limits = left;
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.deps.setSetting("claudeAccountLimits", this.limits);
    this.save();
    this.deps.changed();
  }

  private save(): void {
    this.deps.setSetting("claudeAccounts", this.state);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

/**
 * A new Claude usage reading on top of the last: windows it names replace theirs, newer extra usage
 * and overage win. Null when it says nothing (not a subscription reading, or an older one).
 */
export function mergeClaudeLimits(previous: PlanLimits | undefined, next: PlanLimits): { limits: PlanLimits; fresh: boolean } | null {
  // Empty/API-only reports cannot erase a known subscription quota, nor can an old query replay.
  if (next.availability !== "available") return null;
  if (previous && next.at < previous.at) {
    // Overage-only events retain the query's old window timestamp.
    if ((next.overageAt ?? 0) > Math.max(previous.at, previous.overageAt ?? 0)) {
      return { limits: { ...previous, overage: next.overage, overageAt: next.overageAt }, fresh: false };
    }
    return null;
  }
  const windows = new Map((previous?.windows ?? []).map((w) => [w.id, w]));
  for (const window of next.windows) windows.set(window.id, window);
  const merged = { ...previous, ...next, windows: [...windows.values()] };
  // Rate-limit events always carry a status; a newer reading without one is a full /usage read.
  if (next.status === undefined) delete merged.status;
  if ((previous?.extraUsage?.at ?? 0) > (next.extraUsage?.at ?? 0)) merged.extraUsage = previous?.extraUsage;
  if ((previous?.overageAt ?? 0) > (next.overageAt ?? 0)) {
    merged.overage = previous?.overage;
    merged.overageAt = previous?.overageAt;
  }
  return { limits: merged, fresh: true };
}

/** What a chat is told when it goes on with another account after a usage limit. */
export const SWITCHED_ACCOUNT_PROMPT = "A usage limit stopped your last turn, so this chat now goes on with another Claude account. Go on where you left off: check your task and the work you have done so far, then finish it as before.";
