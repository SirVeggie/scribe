import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPlainRecord, type PlanLimits } from "./types.js";

/**
 * Several Claude subscriptions at once (#452). Account "default" is Claude Code's own login
 * (~/.claude, shared with the CLI). Each added account is a Claude Code config folder of its own
 * (CLAUDE_CONFIG_DIR) that links the default folder's transcripts, skills and settings, so a chat
 * resumes on any account and behaves the same on each.
 */

export const DEFAULT_ACCOUNT = "default";

export type ClaudeAccount = {
  id: string;
  /** Its Claude Code config folder; null for the default account. */
  dir: string | null;
  email?: string;
  orgName?: string;
  /** organizationType, e.g. "claude_pro" or "claude_max". */
  plan?: string;
  /** organizationRateLimitTier, e.g. "default_claude_max_5x". */
  tier?: string;
  addedAt: number;
};

/** Saved in Scribe's settings: the added accounts (not the default) and which account new chats use. */
export type ClaudeAccountsState = {
  accounts: ClaudeAccount[];
  /** "distribute", or an account id: every chat uses only that account. */
  use: string;
  /** When each account was last picked for a chat, for round-robin among equals. */
  picked: Record<string, number>;
};

export function emptyAccountsState(): ClaudeAccountsState {
  return { accounts: [], use: "distribute", picked: {} };
}

export function cleanAccountsState(raw: unknown): ClaudeAccountsState {
  if (!isPlainRecord(raw)) return emptyAccountsState();
  const accounts = Array.isArray(raw.accounts) ? raw.accounts.filter((a): a is ClaudeAccount =>
    isPlainRecord(a) && typeof a.id === "string" && a.id !== DEFAULT_ACCOUNT && typeof a.dir === "string") : [];
  const use = typeof raw.use === "string" && (raw.use === DEFAULT_ACCOUNT || accounts.some((a) => a.id === raw.use)) ? raw.use : "distribute";
  const picked = isPlainRecord(raw.picked) ? Object.fromEntries(Object.entries(raw.picked).filter(([, v]) => typeof v === "number")) as Record<string, number> : {};
  return { accounts, use, picked };
}

/** Claude Code's own config folder: CLAUDE_CONFIG_DIR when the daemon has one, else ~/.claude. */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
}

/** Where Claude Code keeps its account file (.claude.json) for a config folder. */
function accountFile(dir: string | null, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (dir) return path.join(dir, ".claude.json");
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home, ".claude.json");
}

/** The signed-in account's profile from .claude.json (oauthAccount); never its credentials. */
export function readAccountProfile(dir: string | null, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Pick<ClaudeAccount, "email" | "orgName" | "plan" | "tier"> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(accountFile(dir, env, home), "utf8"));
    const acc = isPlainRecord(raw) && isPlainRecord(raw.oauthAccount) ? raw.oauthAccount : null;
    if (!acc) return {};
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const out = { email: str(acc.emailAddress), orgName: str(acc.organizationName), plan: str(acc.organizationType), tier: str(acc.organizationRateLimitTier) ?? str(acc.userRateLimitTier) };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v)) as Pick<ClaudeAccount, "email" | "orgName" | "plan" | "tier">;
  } catch {
    return {};
  }
}

/** How much usage a plan holds next to Pro: Max 5x counts 5, Max 20x counts 20. */
export function planWeight(account: Pick<ClaudeAccount, "plan" | "tier">): number {
  const text = `${account.tier ?? ""} ${account.plan ?? ""}`.toLowerCase();
  if (/20x/.test(text)) return 20;
  if (/5x|max/.test(text)) return 5;
  return 1;
}

/** A short plan name for the UI: "Pro", "Max 5x", "Max 20x". */
export function planLabel(account: Pick<ClaudeAccount, "plan" | "tier">): string | undefined {
  const text = `${account.tier ?? ""} ${account.plan ?? ""}`.toLowerCase();
  if (/20x/.test(text)) return "Max 20x";
  if (/5x/.test(text)) return "Max 5x";
  if (/max/.test(text)) return "Max";
  if (/pro/.test(text)) return "Pro";
  if (/team/.test(text)) return "Team";
  if (/enterprise/.test(text)) return "Enterprise";
  return undefined;
}

/** Folders shared with the default account; the first two are made there when missing, so resume and rewind work across accounts. */
const SHARED_DIRS = ["projects", "file-history", "todos", "plans", "skills", "agents", "commands", "plugins"];
const ALWAYS_SHARED = new Set(["projects", "file-history"]);
/** Files copied from the default account before each session, so settings and memory match. */
const SHARED_FILES = ["settings.json", "CLAUDE.md"];

export function accountsRoot(data: string): string {
  return path.join(data, "agent", "claude-accounts");
}

/** Make or refresh an added account's folder: links to the shared folders, fresh copies of the shared files. */
export function prepareProfile(dir: string, base = defaultConfigDir()): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of SHARED_DIRS) {
    const from = path.join(base, name);
    const to = path.join(dir, name);
    if (exists(to)) continue;
    if (!fs.existsSync(from)) {
      if (!ALWAYS_SHARED.has(name)) continue;
      fs.mkdirSync(from, { recursive: true });
    }
    try {
      fs.symlinkSync(from, to, "junction");
    } catch {
      /* the account works without it; only that folder stays separate */
    }
  }
  for (const name of SHARED_FILES) {
    const from = path.join(base, name);
    const to = path.join(dir, name);
    try {
      const src = fs.statSync(from);
      const dst = fs.existsSync(to) ? fs.statSync(to) : null;
      if (!dst || dst.mtimeMs !== src.mtimeMs || dst.size !== src.size) {
        fs.copyFileSync(from, to);
        fs.utimesSync(to, src.atime, src.mtime);
      }
    } catch {
      /* no such file in the default account */
    }
  }
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Delete an added account's folder. Links go first, so nothing is deleted through them. */
export function removeProfile(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (!fs.lstatSync(p).isSymbolicLink()) continue;
    try {
      fs.unlinkSync(p);
    } catch {
      fs.rmdirSync(p);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------- picking an account for a chat ---------- */

export type PickCandidate = {
  id: string;
  weight: number;
  limits?: PlanLimits;
  /** Claude chats running on it now. */
  running: number;
  lastPickedAt?: number;
  /** A chat on it hit the usage limit, which resets then: full until that time, whatever its last reading says. */
  limitedUntil?: number;
};

/** At or above this share of the 5-hour or weekly window, an account takes no new chats while another has room. */
const FULL = 0.95;
/** Rough share of a Pro 5-hour window one running chat may still use; a Max account's share is smaller. */
const CHAT_FIVE_HOUR_COST = 0.15;
/** 5-hour headroom (after running chats) above which it does not matter. */
const ROOMY = 0.4;
/** Scores this close count as equal: then fewest running chats, then round-robin. */
const TIE = 0.1;

function windowUse(limits: PlanLimits | undefined, id: string, now: number): { used: number; resetsAt?: number } {
  const w = limits?.windows.find((x) => x.id === id);
  if (!w || (w.resetsAt && w.resetsAt <= now)) return { used: 0 };
  return { used: w.utilization, resetsAt: w.resetsAt };
}

/**
 * How much an account should get the next chat. Weekly headroom left unused at the reset is lost,
 * so headroom per hour until the weekly reset ranks it (in Pro units, so a Max account's larger
 * allowance counts). Running chats eat into the 5-hour window; once the headroom they leave gets
 * low, the account counts for less. Null: full now.
 */
export function accountScore(c: PickCandidate, now: number): number | null {
  const five = windowUse(c.limits, "five_hour", now);
  const week = windowUse(c.limits, "seven_day", now);
  if (c.limitedUntil && c.limitedUntil > now) return null;
  if (five.used >= FULL || week.used >= FULL) return null;
  const hours = week.resetsAt ? Math.max(1, (week.resetsAt - now) / 3_600_000) : 168;
  const urgency = ((1 - week.used) * c.weight) / hours;
  const fiveLeft = 1 - five.used - (c.running * CHAT_FIVE_HOUR_COST) / c.weight;
  const pressure = fiveLeft >= ROOMY ? 1 : Math.max(0.02, fiveLeft / ROOMY);
  return urgency * pressure;
}

/** When a full account has room again: the soonest reset of the windows that fill it. */
function freeAt(c: PickCandidate, now: number): number {
  const times = ["five_hour", "seven_day"].map((id) => windowUse(c.limits, id, now)).filter((w) => w.used >= FULL).map((w) => w.resetsAt ?? Infinity);
  if (c.limitedUntil && c.limitedUntil > now) times.push(c.limitedUntil);
  return times.length ? Math.max(...times) : now;
}

/** The account for a new chat; when all are full, the one that frees up soonest. */
export function pickAccount(candidates: PickCandidate[], now: number): string | null {
  if (!candidates.length) return null;
  const scored = candidates.map((c) => ({ c, score: accountScore(c, now) }));
  const open = scored.filter((s): s is { c: PickCandidate; score: number } => s.score !== null);
  if (!open.length) return [...candidates].sort((a, b) => freeAt(a, now) - freeAt(b, now))[0].id;
  const best = Math.max(...open.map((s) => s.score));
  const near = open.filter((s) => s.score >= best * (1 - TIE));
  near.sort((a, b) => a.c.running - b.c.running || (a.c.lastPickedAt ?? 0) - (b.c.lastPickedAt ?? 0) || b.score - a.score);
  return near[0].c.id;
}

/* ---------- one meter for several accounts ---------- */

export type AccountLimitsRow = {
  id: string;
  email?: string;
  plan?: string;
  weight: number;
  limits?: PlanLimits;
};

/**
 * The accounts' windows as one: each window's use averaged by plan size (a Max 5x account counts
 * five times a Pro one), resetting when the soonest of them does. The 5-hour window is weighted by
 * each account's weekly headroom too (#894): an account whose week is nearly used up has little of
 * its 5-hour window left to give, however empty that looks. Accounts that have not reported a
 * window are left out of its average. The rows go along for the per-account breakdown.
 */
export function combineLimits(rows: AccountLimitsRow[], now = Date.now()): PlanLimits | null {
  const reported = rows.filter((r) => r.limits?.availability === "available" && r.limits.windows.length);
  if (!reported.length) return null;
  const ids: string[] = [];
  for (const r of reported) for (const w of r.limits!.windows) if (!ids.includes(w.id)) ids.push(w.id);
  const headroom = (r: AccountLimitsRow) => Math.min(1, Math.max(0, 1 - windowUse(r.limits, "seven_day", now).used));
  // Every week used up: the plain plan weights, so the meter still says something.
  const byWeek = reported.some((r) => headroom(r) > 0);
  const windows: PlanLimits["windows"] = [];
  for (const id of ids) {
    let sum = 0;
    let weight = 0;
    let label = id;
    const resets: number[] = [];
    for (const r of reported) {
      const w = r.limits!.windows.find((x) => x.id === id);
      if (!w) continue;
      label = w.label;
      const live = w.resetsAt && w.resetsAt <= now ? 0 : w.utilization;
      const share = id === "five_hour" && byWeek ? r.weight * headroom(r) : r.weight;
      if (!share) continue;
      sum += live * share;
      weight += share;
      if (w.resetsAt && w.resetsAt > now) resets.push(w.resetsAt);
    }
    if (!weight) continue;
    windows.push({ id, label, utilization: sum / weight, ...(resets.length ? { resetsAt: Math.min(...resets) } : {}) });
  }
  const all = reported.map((r) => r.limits!);
  return {
    at: Math.max(...all.map((l) => l.at)),
    source: "claude",
    availability: "available",
    windows,
    ...(all.every((l) => l.status === "rejected") ? { status: "rejected" } : {}),
    ...(all.some((l) => l.overage) ? { overage: true } : {}),
    accounts: rows.map((r) => ({ id: r.id, ...(r.email ? { email: r.email } : {}), ...(r.plan ? { plan: r.plan } : {}), weight: r.weight,
      ...(r.limits ? { limits: r.limits } : {}) })),
  };
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.scribe-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Give Claude Code's own login (the default folder, which the CLI uses) the added account's sign-in
 * and the added folder the default's (#452): the stored credentials and the account entry in each
 * .claude.json trade places; everything else in both stays. Needs the logins stored as files.
 */
export function swapLogin(dir: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): void {
  const base = defaultConfigDir(env, home);
  const credA = path.join(base, ".credentials.json");
  const credB = path.join(dir, ".credentials.json");
  if (!fs.existsSync(credA) || !fs.existsSync(credB)) throw new Error("Claude Code keeps one of these logins outside its folder (a system keychain), so Scribe cannot switch it.");
  const fileA = accountFile(null, env, home);
  const fileB = accountFile(dir, env, home);
  const read = (file: string): Record<string, unknown> => {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isPlainRecord(raw)) throw new Error(`${file} is not a JSON object.`);
    return raw;
  };
  const jsonA = read(fileA);
  const jsonB = read(fileB);
  const secretA = fs.readFileSync(credA, "utf8");
  const secretB = fs.readFileSync(credB, "utf8");
  const accountA = jsonA.oauthAccount;
  const accountB = jsonB.oauthAccount;
  writeAtomic(credA, secretB);
  writeAtomic(credB, secretA);
  if (accountB === undefined) delete jsonA.oauthAccount; else jsonA.oauthAccount = accountB;
  if (accountA === undefined) delete jsonB.oauthAccount; else jsonB.oauthAccount = accountA;
  writeAtomic(fileA, `${JSON.stringify(jsonA, null, 2)}\n`);
  writeAtomic(fileB, `${JSON.stringify(jsonB, null, 2)}\n`);
}
