import { isPlainRecord, type ClaudeBillingSource, type PlanLimits, type Usage } from "./types.js";
import { planLimitsFromUsageReport } from "./planLimits.js";

export function claudePlanSnapshot(report: unknown, source: ClaudeBillingSource, now = Date.now(), previous?: PlanLimits): PlanLimits {
  const parsed = planLimitsFromUsageReport(report, now);
  // A failed/empty probe is not evidence that the last observation vanished.
  // Only reuse it for the same billing source; an explicit non-subscription report clears it.
  if (!parsed && !(isPlainRecord(report) && report.rate_limits_available === false) && previous &&
      previous.availability === "available" &&
      JSON.stringify(Object.entries(source).sort()) === JSON.stringify(Object.entries(previous.billingSource ?? {}).sort())) return previous;
  return { ...(parsed ?? { at: now, windows: [], availability: "unavailable" as const,
    detail: isPlainRecord(report) && report.rate_limits_available === false ? "Subscription quota does not apply to this query" : "Claude quota unavailable" }),
    ...(parsed ? { availability: "available" as const } : {}), source: "claude" as const, billingSource: source };
}

/** Copy only documented metadata. Never inspect environment variables or credential stores. */
export function claudeBillingSource(raw: unknown): ClaudeBillingSource {
  if (!isPlainRecord(raw)) return {};
  return Object.fromEntries(["apiProvider", "email", "organization", "subscriptionType", "tokenSource", "apiKeySource"]
    .filter((key) => typeof raw[key] === "string" && raw[key]).map((key) => [key, raw[key]]));
}

const fields = { inputTokens: "inputTokens", outputTokens: "outputTokens", cacheReadTokens: "cacheReadInputTokens",
  cacheWriteTokens: "cacheCreationInputTokens", reasoningTokens: "thinkingTokens" } as const;
type Totals = { models: Record<string, Record<string, unknown>>; cost?: number };
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
function totals(models: unknown, cost: unknown): Totals | undefined {
  if (!isPlainRecord(models) || !Object.values(models).every(isPlainRecord)) return undefined;
  return { models: models as Totals["models"], ...(finite(cost) ? { cost } : {}) };
}

/** SDK totals include subagents and restored history. A missing resume baseline is unknown, not zero. */
export class ClaudeUsageDelta {
  private previous?: Totals;
  baseline(report: unknown): void {
    const session = isPlainRecord(report) && isPlainRecord(report.session) ? report.session : null;
    this.previous = session ? totals(session.model_usage, session.total_cost_usd) : undefined;
  }
  result(result: Record<string, unknown>): Usage {
    const next = totals(result.modelUsage, result.total_cost_usd);
    if (!next) return { costPartial: true };
    const failed = result.subtype !== "success" || result.is_error === true;
    // Startup/crash errors can zero every counter without resetting the saved session.
    if (failed && !next.cost && !Object.values(next.models).some((m) => Object.values(fields).some((key) => finite(m[key]) && m[key] > 0))) return { costPartial: true };
    const previous = this.previous;
    if (!previous) {
      this.previous = next;
      return { costPartial: true };
    }
    const reset = (next.cost !== undefined && previous.cost !== undefined && next.cost < previous.cost) ||
      Object.entries(next.models).some(([model, row]) => Object.values(fields).some((key) =>
        finite(row[key]) && finite(previous.models[model]?.[key]) && row[key] < (previous.models[model][key] as number)));
    if (failed && reset) return { costPartial: true };
    this.previous = next;
    const out: Usage = { costPartial: false };
    for (const [field, key] of Object.entries(fields) as Array<[keyof typeof fields, string]>) {
      let sum = 0;
      for (const [model, row] of Object.entries(next.models)) {
        const value = row[key];
        const before = previous.models[model]?.[key];
        if (finite(value)) sum += !reset && finite(before) ? value - before : value;
      }
      out[field] = sum;
    }
    const windows = Object.values(next.models).map((m) => m.contextWindow).filter(finite);
    if (windows.length) out.contextWindow = Math.max(...windows);
    if (next.cost !== undefined && previous.cost !== undefined) {
      const delta = reset ? next.cost : next.cost - previous.cost;
      out.costUsd = delta;
      out.estimatedCostUsd = delta;
    } else out.costPartial = true;
    return out;
  }
}
