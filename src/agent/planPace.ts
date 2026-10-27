import type { PlanLimits, PlanWindow } from "./types.js";

/** Provider readings of one window since its reset was first reported. */
type Track = { resetsAt: number; samples: Array<{ at: number; u: number }> };
export type PaceState = Record<string, Track>;

const HOUR = 3600_000;
/** Resets reported a little apart are the same window (providers round them). */
const SAME_RESET_MS = 15 * 60_000;
const MAX_SAMPLES = 40;

/** The window's length, when known: Claude's ids, Codex's duration in the label. */
export function windowDurationMs(w: Pick<PlanWindow, "id" | "label">): number | undefined {
  if (w.id === "five_hour") return 5 * HOUR;
  if (w.id.startsWith("seven_day")) return 7 * 24 * HOUR;
  if (!w.id.startsWith("codex:")) return undefined;
  if (/(?:^| · )5-hour$/.test(w.label)) return 5 * HOUR;
  if (/(?:^| · )Weekly$/.test(w.label)) return 7 * 24 * HOUR;
  const mins = /(?:^| · )(\d+)-minute$/.exec(w.label);
  return mins ? Number(mins[1]) * 60_000 : undefined;
}

/** The pace looks back a fifth of the window (an hour of a 5-hour window) and needs a thirtieth of it to say anything. */
const lookback = (duration: number) => duration / 5;
const minSpan = (duration: number) => duration / 30;

/** Adds a fresh provider reading. Tracks restart when a window's reset moves on. */
export function trackPace(state: PaceState, provider: string, limits: PlanLimits, now = Date.now()): PaceState {
  if (limits.availability && limits.availability !== "available") return state;
  const out: PaceState = {};
  for (const [key, track] of Object.entries(state)) if (track.resetsAt > now) out[key] = track;
  for (const w of limits.windows) {
    const duration = windowDurationMs(w);
    if (!duration || !w.resetsAt || w.expired || w.resetsAt <= limits.at) continue;
    const key = `${provider}:${w.id}`;
    const old = out[key];
    const same = old && Math.abs(old.resetsAt - w.resetsAt) < SAME_RESET_MS;
    const samples = same ? old.samples.slice() : [];
    const last = samples[samples.length - 1];
    if (last && limits.at <= last.at) continue;
    samples.push({ at: limits.at, u: w.utilization });
    // Keep one reading older than the lookback as the rate's starting point.
    const from = limits.at - lookback(duration);
    while (samples.length > 2 && (samples[1].at <= from || samples.length > MAX_SAMPLES)) samples.shift();
    out[key] = { resetsAt: w.resetsAt, samples };
  }
  return out;
}

export type WindowPace = {
  /** The window's length: with resetsAt, where an even pace would be now. */
  durationMs: number;
  /** At the recent rate the window fills before its reset, at this time. */
  runsOutAt?: number;
  /** At the recent rate the window lasts until its reset. */
  lasts?: true;
};

/** Pace for a window, or undefined while there are too few readings (one reading, or just after a reset). */
export function windowPace(state: PaceState, provider: string, w: PlanWindow, now = Date.now()): WindowPace | undefined {
  const duration = windowDurationMs(w);
  if (!duration || !w.resetsAt || w.expired || w.resetsAt <= now) return undefined;
  const pace: WindowPace = { durationMs: duration };
  const track = state[`${provider}:${w.id}`];
  const samples = track && Math.abs(track.resetsAt - w.resetsAt) < SAME_RESET_MS ? track.samples : [];
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first && last && last.at - first.at >= minSpan(duration) && w.utilization < 1) {
    const rate = (last.u - first.u) / (last.at - first.at);
    const runsOutAt = rate > 0 ? last.at + (1 - last.u) / rate : Infinity;
    if (runsOutAt < w.resetsAt) pace.runsOutAt = Math.max(now, Math.round(runsOutAt));
    else pace.lasts = true;
  }
  return pace;
}

/** Limits with each window's pace attached. */
export function withPace(state: PaceState, provider: string, limits: PlanLimits, now = Date.now()): PlanLimits {
  let changed = false;
  const windows = limits.windows.map((w) => {
    const pace = windowPace(state, provider, w, now);
    if (!pace) return w;
    changed = true;
    return { ...w, pace };
  });
  return changed ? { ...limits, windows } : limits;
}
