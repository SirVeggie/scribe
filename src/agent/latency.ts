import type { TurnLatency } from "./types.js";

/** What the host saw of a turn's timing, for any provider. */
export type TurnClock = {
  startedAt: number;
  /** When the prompt went to the provider, after Scribe's setup. */
  sentAt?: number;
  /** The first main-thread text, thinking or tool call. */
  firstAt?: number;
  endedAt: number;
  /** Main-thread tool calls, start to end (open ones end with the turn). */
  tools: Array<[number, number | undefined]>;
  /** Waits on the user: approvals and questions. */
  waits: Array<[number, number | undefined]>;
};

/** Length of the union of intervals clipped to [from, to], so parallel calls are not counted twice. */
function covered(spans: Array<[number, number | undefined]>, from: number, to: number): number {
  const clipped = spans
    .map(([a, b]): [number, number] => [Math.max(from, a), Math.min(to, b ?? to)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of clipped) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

/**
 * One turn's latency. Model time is what is left of the provider's part once tool calls and waits
 * on the user are taken out, so it includes the provider's own overhead and any retries it hides.
 */
export function turnLatency(clock: TurnClock): TurnLatency | undefined {
  const { startedAt, endedAt } = clock;
  if (!(endedAt >= startedAt)) return undefined;
  const sent = clock.sentAt !== undefined && clock.sentAt >= startedAt && clock.sentAt <= endedAt ? clock.sentAt : undefined;
  const from = sent ?? startedAt;
  const waitMs = covered(clock.waits, from, endedAt);
  const busy = covered([...clock.tools, ...clock.waits], from, endedAt);
  const toolMs = busy - waitMs;
  return {
    totalMs: endedAt - startedAt,
    ...(sent !== undefined ? { setupMs: sent - startedAt } : {}),
    ...(sent !== undefined && clock.firstAt !== undefined && clock.firstAt >= sent ? { firstMs: clock.firstAt - sent } : {}),
    toolMs,
    waitMs,
    modelMs: Math.max(0, endedAt - from - busy),
  };
}

export type LatencySummary = { samples: number; median: number; p90: number };

/** Median and p90 (nearest rank) of a set of durations, or undefined when there are none. */
export function summarize(values: number[]): LatencySummary | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  return { samples: sorted.length, median: rank(0.5), p90: rank(0.9) };
}
