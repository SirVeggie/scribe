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
  expired?: true;
  /** At the current pace (planPace.ts). */
  runsOutAt?: string;
  /** Percentage points since the previous call in this chat. */
  change?: number;
  /** The window reset since the previous call, so change is left out. */
  reset?: true;
};

export type ProviderUsageView = {
  at: string;
  ageSeconds: number;
  windows: UsageWindowView[];
  status?: string;
  overage?: boolean;
  availability?: string;
  detail?: string;
  accounts?: Array<{ id: string; email?: string; plan?: string; current?: true; at?: string; windows: UsageWindowView[] }>;
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

function windowsView(windows: PlanWindow[], prev: PlanWindow[] | undefined): UsageWindowView[] {
  return windows.map((w) => {
    const out: UsageWindowView = { id: w.id, label: w.label, percent: round(w.utilization * 100) };
    if (w.resetsAt) out.resetsAt = iso(w.resetsAt);
    if (w.expired) out.expired = true;
    if (w.pace?.runsOutAt) out.runsOutAt = iso(w.pace.runsOutAt);
    const before = prev?.find((p) => p.id === w.id);
    if (before) {
      // A reset moves resetsAt on by a whole window; small drift is the same window.
      if (before.resetsAt && w.resetsAt && Math.abs(w.resetsAt - before.resetsAt) > 5 * 60_000) out.reset = true;
      else out.change = round((w.utilization - before.utilization) * 100);
    }
    return out;
  });
}

export function usageView(limits: Limits, spend: Record<string, ApiSpend>, now: number, prev?: { at: number; limits: Limits }, only?: string): UsageView {
  const providers: Record<string, ProviderUsageView> = {};
  for (const [provider, l] of Object.entries(limits)) {
    if (!l || (only && provider !== only)) continue;
    const before = prev?.limits[provider];
    const view: ProviderUsageView = { at: iso(l.at), ageSeconds: Math.max(0, Math.round((now - l.at) / 1000)), windows: windowsView(l.windows, before?.windows) };
    if (l.status) view.status = l.status;
    if (l.overage) view.overage = true;
    if (l.availability && l.availability !== "available") view.availability = l.availability;
    if (l.detail) view.detail = l.detail;
    if (l.accounts?.length) {
      view.accounts = l.accounts.map((a) => {
        const old = before?.accounts?.find((x) => x.id === a.id)?.limits?.windows;
        return { id: a.id, ...(a.email ? { email: a.email } : {}), ...(a.plan ? { plan: a.plan } : {}),
          ...(l.nextAccount === a.id ? { current: true as const } : {}),
          ...(a.limits ? { at: iso(a.limits.at) } : {}), windows: windowsView(a.limits?.windows ?? [], old) };
      });
    }
    providers[provider] = view;
  }
  const out: UsageView = { providers };
  if ((!only || only === "pi") && Object.keys(spend).length) {
    out.spend = Object.fromEntries(Object.entries(spend).map(([api, s]) => [api, { costUsd: s.costUsd, ...(s.balance ? { balance: s.balance } : {}) }]));
  }
  if (prev) out.since = iso(prev.at);
  return out;
}
