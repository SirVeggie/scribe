import { isPlainRecord, type PlanLimits } from "./types.js";

export const LIMIT_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly (Opus)",
  seven_day_sonnet: "Weekly (Sonnet)",
  seven_day_overage_included: "Weekly (with extra usage)",
  seven_day_oauth_apps: "Weekly (apps)",
  overage: "Extra usage",
};

const USAGE_WINDOW_IDS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "seven_day_oauth_apps"] as const;

function limitLabel(id: string): string {
  return LIMIT_LABELS[id] ?? id.replaceAll("_", " ");
}

/** Unix seconds, unix ms, or ISO 8601 → epoch ms. */
export function parseResetsAt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

function pushWindow(windows: PlanLimits["windows"], id: string, utilization: number, resetsAt?: number): void {
  windows.push({ id, label: limitLabel(id), utilization: Math.max(0, utilization), ...(resetsAt ? { resetsAt } : {}) });
}

/** Claude's rate_limit_event payload (utilization 0–1, resetsAt unix seconds). */
export function planLimitsFromRateLimitInfo(info: unknown, now: number, prev?: PlanLimits): PlanLimits | null {
  if (!isPlainRecord(info)) return null;
  const windows: PlanLimits["windows"] = [];
  const add = (id: string, raw: unknown) => {
    if (!isPlainRecord(raw) || typeof raw.utilization !== "number") return;
    pushWindow(windows, id, raw.utilization, parseResetsAt(raw.resetsAt));
  };
  if (isPlainRecord(info.unifiedWindows)) {
    for (const [id, raw] of Object.entries(info.unifiedWindows)) add(id, raw);
  } else if (typeof info.rateLimitType === "string") {
    add(info.rateLimitType, info);
  }
  return {
    at: windows.length ? now : prev?.at ?? now,
    ...(typeof info.status === "string" ? { status: info.status } : {}),
    windows: windows.length ? windows : prev?.windows ?? [],
    ...(prev?.extraUsage ? { extraUsage: prev.extraUsage } : {}),
    ...(prev?.billingSource ? { billingSource: prev.billingSource } : {}),
    ...(typeof info.isUsingOverage === "boolean" ? { overage: info.isUsingOverage, overageAt: now } : {}),
  };
}

function usageUtilization(raw: number): number {
  return Math.max(0, Math.min(1, raw / 100));
}

/** Codex quota reads replace the snapshot; rolling notifications merge only supplied values. */
export function planLimitsFromCodexRateLimits(report: unknown, now: number, prev?: PlanLimits, rolling = false): PlanLimits | null {
  if (!isPlainRecord(report)) return null;
  const multi = isPlainRecord(report.rateLimitsByLimitId) ? report.rateLimitsByLimitId : null;
  const single = isPlainRecord(report.rateLimits) ? report.rateLimits : null;
  if (!multi && !single) return null;
  const windows = rolling ? [...(prev?.windows ?? [])] : [];
  const buckets = rolling ? [...(prev?.buckets ?? [])] : [];
  const rows = multi ? Object.entries(multi) : [[typeof single?.limitId === "string" ? single.limitId : "codex", single]] as const;
  for (const [key, raw] of rows) {
    if (!isPlainRecord(raw)) continue;
    const id = typeof raw.limitId === "string" ? raw.limitId : key;
    const old = buckets.find((b) => b.id === id);
    const label = typeof raw.limitName === "string" && raw.limitName ? raw.limitName : old?.label ?? (id === "codex" ? "Codex" : id);
    const bucket = { ...old, id, label,
      ...(typeof raw.planType === "string" ? { planType: raw.planType } : {}),
      ...(isPlainRecord(raw.credits) ? { credits: { hasCredits: raw.credits.hasCredits === true, unlimited: raw.credits.unlimited === true,
        ...(typeof raw.credits.balance === "string" ? { balance: raw.credits.balance } : {}) } } : {}),
    };
    const index = buckets.findIndex((b) => b.id === id);
    if (index < 0) buckets.push(bucket); else buckets[index] = bucket;
    for (const slot of ["primary", "secondary"] as const) {
      const w = raw[slot];
      if (!isPlainRecord(w) || typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) continue;
      const mins = typeof w.windowDurationMins === "number" ? w.windowDurationMins : null;
      const oldWindow = windows.find((x) => x.id === `codex:${id}:${slot}`);
      const duration = mins === 300 ? "5-hour" : mins === 10080 ? "Weekly" : mins ? `${mins}-minute` : slot === "primary" ? "Primary" : "Secondary";
      const resetsAt = parseResetsAt(w.resetsAt) ?? (rolling ? oldWindow?.resetsAt : undefined);
      const window = { id: `codex:${id}:${slot}`, label: rolling && mins == null && oldWindow ? oldWindow.label : id === "codex" && label === "Codex" ? duration : `${label} · ${duration}`, utilization: usageUtilization(w.usedPercent), ...(resetsAt ? { resetsAt } : {}) };
      const wi = windows.findIndex((x) => x.id === window.id);
      if (wi < 0) windows.push(window); else windows[wi] = window;
    }
  }
  // A live quota notification supersedes a failed background probe. It still
  // cannot grant recovery permission, which requires a fresh full read.
  return { at: now, source: "codex", availability: "available", windows, buckets,
    ordinaryUsageAllowed: rolling ? prev?.ordinaryUsageAllowed ?? null : typeof report.ordinaryUsageAllowed === "boolean" ? report.ordinaryUsageAllowed : null,
    ...(rolling ? prev?.permissionAt ? { permissionAt: prev.permissionAt } : {} : { permissionAt: now }),
  };
}

/** Only a fresh, full read after the failed turn can authorize automatic Codex recovery. */
export function codexUsageRecoveryAllowed(limits: PlanLimits | undefined, endedAt: number, now = Date.now()): boolean {
  return limits?.availability === "available" && limits.ordinaryUsageAllowed === true &&
    typeof limits.permissionAt === "number" && limits.permissionAt >= endedAt && now - limits.permissionAt < 5 * 60 * 1000;
}

function windowFromUsage(id: string, raw: unknown): PlanLimits["windows"][number] | null {
  if (!isPlainRecord(raw) || typeof raw.utilization !== "number") return null;
  const resetsAt = parseResetsAt(raw.resets_at ?? raw.resetsAt);
  return { id, label: limitLabel(id), utilization: usageUtilization(raw.utilization), ...(resetsAt ? { resetsAt } : {}) };
}

/**
 * Structured /usage (get_usage) rate_limits: utilization 0–100, resets_at ISO or unix.
 * Null when plan limits do not apply or the body has no windows.
 */
export function planLimitsFromUsageReport(report: unknown, now: number): PlanLimits | null {
  if (!isPlainRecord(report) || report.rate_limits_available === false) return null;
  const limits = report.rate_limits;
  if (!isPlainRecord(limits)) return null;
  const windows: PlanLimits["windows"] = [];
  for (const id of USAGE_WINDOW_IDS) {
    const w = windowFromUsage(id, limits[id]);
    if (w) windows.push(w);
  }
  if (Array.isArray(limits.model_scoped)) {
    for (const raw of limits.model_scoped) {
      if (!isPlainRecord(raw) || typeof raw.display_name !== "string" || typeof raw.utilization !== "number") continue;
      const id = `model:${raw.display_name}`;
      if (windows.some((w) => w.id === id || w.label === raw.display_name)) continue;
      const resetsAt = parseResetsAt(raw.resets_at ?? raw.resetsAt);
      windows.push({ id, label: raw.display_name, utilization: usageUtilization(raw.utilization), ...(resetsAt ? { resetsAt } : {}) });
    }
  }
  const extra = isPlainRecord(limits.extra_usage) ? limits.extra_usage : null;
  if (extra && typeof extra.utilization === "number" && Number.isFinite(extra.utilization)) {
    const w = windowFromUsage("overage", extra);
    if (w) windows.push(w);
  }
  if (!windows.length && !extra) return null;
  return {
    at: now,
    windows,
    ...(extra ? { extraUsage: {
      at: now,
      ...(typeof extra.is_enabled === "boolean" ? { enabled: extra.is_enabled } : {}),
      ...(typeof extra.used_credits === "number" && Number.isFinite(extra.used_credits) && extra.used_credits >= 0 ? { usedCredits: extra.used_credits } : {}),
      ...(typeof extra.monthly_limit === "number" && Number.isFinite(extra.monthly_limit) && extra.monthly_limit >= 0 ? { monthlyLimit: extra.monthly_limit } : {}),
      ...(typeof extra.currency === "string" ? { currency: extra.currency } : {}),
    } } : {}),
  };
}

/**
 * Flag passed resets as expired and display zero until the next report (except Codex).
 * The old reset stays as reported:
 * a new window starts on first use, so nothing is projected until the provider reports again.
 */
export function applyExpiredWindows(limits: PlanLimits, now = Date.now()): PlanLimits {
  if (limits.source === "codex") return limits;
  let changed = false;
  const windows = limits.windows.map((w) => {
    if (!w.resetsAt || w.resetsAt > now || (w.expired && w.utilization === 0)) return w;
    changed = true;
    return { ...w, utilization: 0, expired: true as const };
  });
  // A rejection ends with the reset of the windows that caused it: once none is still full.
  const staleRejection = limits.status === "rejected" && windows.some((w) => w.expired) &&
    !windows.some((w) => !w.expired && w.id !== "overage" && w.utilization >= 1);
  if (!changed && !staleRejection) return limits;
  const out = { ...limits, windows };
  if (staleRejection) delete out.status;
  return out;
}

/** Soonest reset not yet handled, including ones already due. Null when none are known. */
export function nextRefreshAt(limits: PlanLimits | undefined): number | null {
  if (!limits) return null;
  const times = limits.windows.filter((w) => !w.expired).map((w) => w.resetsAt).filter((t): t is number => typeof t === "number");
  if (!times.length) return null;
  return Math.min(...times);
}

/** Claude's wording when a plan limit stops a turn, including "You've hit your session limit · resets 9am". */
const LIMIT_ERROR = /usage limit|limit reached|hit your( usage| session)? limit|out of (extra )?usage/i;
/** How long to wait before trying again when a limit stopped a turn but no reset time is known. */
export const UNKNOWN_RESET_RETRY_MS = 30 * 60 * 1000;

/**
 * When a turn that a plan usage limit stopped may go again, or undefined when the turn failed for
 * another reason. Uses the reset the error names, else the soonest exhausted window's (plan usage
 * the turn itself reported as rejected counts as the sign too), else a retry a while later.
 */
export function usageLimitResetsAt(error: string | undefined, limits: PlanLimits | undefined, turnStartedAt: number, endedAt: number): number | undefined {
  const text = error ?? "";
  const stamp = /limit reached\|(\d{9,13})/i.exec(text);
  if (stamp) return parseResetsAt(Number(stamp[1]));
  const rejected = (limits?.status === "rejected" || limits?.ordinaryUsageAllowed === false) && limits.at >= turnStartedAt;
  if (!rejected && !LIMIT_ERROR.test(text)) return undefined;
  const ahead = (limits?.windows ?? []).filter((w) => typeof w.resetsAt === "number" && w.resetsAt > endedAt);
  const full = ahead.filter((w) => w.utilization >= 1);
  const times = (full.length ? full : ahead).map((w) => w.resetsAt as number);
  return times.length ? Math.min(...times) : endedAt + UNKNOWN_RESET_RETRY_MS;
}

export function livePlanLimits(limits: PlanLimits, now = Date.now()): PlanLimits {
  return applyExpiredWindows(limits, now);
}

/** Cursor windows: the plan's included pool, split into first-party (Auto) and API models, and on-demand spend. */
export const CURSOR_WINDOW_LABELS: Record<string, string> = {
  cursor_included: "Included",
  cursor_auto: "Auto",
  cursor_api: "API",
  cursor_on_demand: "On-demand",
};

function num(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw))) return Number(raw);
  return undefined;
}

/**
 * Cursor's DashboardService.GetCurrentPeriodUsage response in Connect JSON (camelCase, int64 as
 * strings): percents are 0–100, billingCycleEnd is epoch ms. Null when it has no plan usage.
 */
export function planLimitsFromCursorUsage(resp: unknown, now: number): PlanLimits | null {
  if (!isPlainRecord(resp) || !isPlainRecord(resp.planUsage)) return null;
  const plan = resp.planUsage;
  const end = num(resp.billingCycleEnd);
  const resetsAt = end && end > 0 ? parseResetsAt(end) : undefined;
  const windows: PlanLimits["windows"] = [];
  const add = (id: string, percent: number | undefined) => {
    if (percent === undefined) return;
    windows.push({ id, label: CURSOR_WINDOW_LABELS[id], utilization: Math.max(0, percent / 100), ...(resetsAt ? { resetsAt } : {}) });
  };
  const limit = num(plan.limit) ?? 0;
  const included = num(plan.includedSpend) ?? 0;
  add("cursor_included", num(plan.totalPercentUsed) ?? (limit > 0 ? (included / limit) * 100 : undefined));
  add("cursor_auto", num(plan.autoPercentUsed));
  add("cursor_api", num(plan.apiPercentUsed));
  const spend = isPlainRecord(resp.spendLimitUsage) ? resp.spendLimitUsage : null;
  if (spend) {
    const individual = num(spend.individualLimit) ?? 0;
    const pooled = num(spend.pooledLimit) ?? 0;
    if (individual > 0) add("cursor_on_demand", ((num(spend.individualUsed) ?? 0) / individual) * 100);
    else if (pooled > 0) add("cursor_on_demand", ((num(spend.pooledUsed) ?? 0) / pooled) * 100);
  }
  if (!windows.length) return null;
  const onDemand = windows.find((w) => w.id === "cursor_on_demand");
  return { at: now, windows, ...(onDemand && onDemand.utilization > 0 ? { overage: true } : {}) };
}
