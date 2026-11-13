import type { ApiSpend, PlanLimits, PlanWindow } from "./types.js";

/**
 * provider_usage for agents (#1065): the plan meters the chat and board show, compact. Each call
 * also gives each window's change since the chat's previous call, so an agent can snapshot, work,
 * and see what the work cost (account-wide: other chats and apps count too).
 */

export type UsageWindowView = {
  id: string;
  label: string;
  /** Percent of the window used, 0–100. */
  percent: number;
  resetsAt?: string;
  /** Time left until resetsAt, e.g. "1h 51m". */
  resetsIn?: string;
  expired?: true;
  /** At the current pace (planPace.ts). */
  runsOutAt?: string;
  /** At the current pace the window lasts until its reset. */
  lastsUntilReset?: true;
  /** Percentage points since the previous call in this chat. */
  change?: number;
  /** The window reset since the previous call, so change is left out. */
  reset?: true;
};

type ReadingView = {
  at: string;
  ageSeconds: number;
  windows: UsageWindowView[];
  status?: string;
  overage?: boolean;
  availability?: string;
  detail?: string;
};

export type AccountUsageView = Partial<ReadingView> & {
  id: string;
  email?: string;
  plan?: string;
  /** The account the next Claude chat starts on. */
  next?: true;
  /** The account the calling chat runs on. */
  thisChat?: true;
  windows: UsageWindowView[];
};

/** One reading, or with several Claude accounts (#452) each account's own and no combined figure (#1081). */
export type ProviderUsageView = Partial<ReadingView> & {
  nextAccount?: string;
  thisChatAccount?: string;
  accounts?: AccountUsageView[];
};

export type UsageView = {
  providers: Record<string, ProviderUsageView>;
  /** Today's cost of Native chats per pay-per-use API. */
  spend?: Record<string, { costUsd: number; balance?: unknown }>;
  /** When this chat last called it: the time the changes are measured from. */
  since?: string;
};

type Limits = Partial<Record<string, PlanLimits>>;

const iso = (ms: number) => new Date(ms).toISOString();
const round = (n: number) => Math.round(n * 10) / 10;

function span(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function windowsView(windows: PlanWindow[], prev: PlanWindow[] | undefined, now: number): UsageWindowView[] {
  return windows.map((w) => {
    const out: UsageWindowView = { id: w.id, label: w.label, percent: round(w.utilization * 100) };
    if (w.resetsAt) out.resetsAt = iso(w.resetsAt);
    if (w.resetsAt && w.resetsAt > now) out.resetsIn = span(w.resetsAt - now);
    if (w.expired) out.expired = true;
    if (w.pace?.runsOutAt) out.runsOutAt = iso(w.pace.runsOutAt);
    if (w.pace?.lasts) out.lastsUntilReset = true;
    const before = prev?.find((p) => p.id === w.id);
    if (before) {
      // A reset moves resetsAt on by a whole window; small drift is the same window.
      if (before.resetsAt && w.resetsAt && Math.abs(w.resetsAt - before.resetsAt) > 5 * 60_000) out.reset = true;
      else out.change = round((w.utilization - before.utilization) * 100);
    }
    return out;
  });
}

function readingView(l: PlanLimits, prev: PlanLimits | undefined, now: number): ReadingView {
  const view: ReadingView = { at: iso(l.at), ageSeconds: Math.max(0, Math.round((now - l.at) / 1000)), windows: windowsView(l.windows, prev?.windows, now) };
  if (l.status) view.status = l.status;
  if (l.overage) view.overage = true;
  if (l.availability && l.availability !== "available") view.availability = l.availability;
  if (l.detail) view.detail = l.detail;
  return view;
}

/** thisChatAccount: the Claude account the calling chat runs on, when it is a Claude chat. */
export function usageView(limits: Limits, spend: Record<string, ApiSpend>, now: number, prev?: { at: number; limits: Limits }, only?: string, thisChatAccount?: string): UsageView {
  const providers: Record<string, ProviderUsageView> = {};
  for (const [provider, l] of Object.entries(limits)) {
    if (!l || (only && provider !== only)) continue;
    const before = prev?.limits[provider];
    if (!l.accounts?.length) {
      providers[provider] = readingView(l, before, now);
      continue;
    }
    // Several accounts: each one's own reading; the meters' combined average would hide which one has room.
    const view: ProviderUsageView = {};
    if (l.nextAccount) view.nextAccount = l.nextAccount;
    if (thisChatAccount) view.thisChatAccount = thisChatAccount;
    view.accounts = l.accounts.map((a) => {
      const old = before?.accounts?.find((x) => x.id === a.id)?.limits;
      return { id: a.id, ...(a.email ? { email: a.email } : {}), ...(a.plan ? { plan: a.plan } : {}),
        ...(l.nextAccount === a.id ? { next: true as const } : {}),
        ...(thisChatAccount === a.id ? { thisChat: true as const } : {}),
        ...(a.limits ? readingView(a.limits, old, now) : { windows: [] }) };
    });
    providers[provider] = view;
  }
  const out: UsageView = { providers };
  if ((!only || only === "pi") && Object.keys(spend).length) {
    out.spend = Object.fromEntries(Object.entries(spend).map(([api, s]) => [api, { costUsd: s.costUsd, ...(s.balance ? { balance: s.balance } : {}) }]));
  }
  if (prev) out.since = iso(prev.at);
  return out;
}
