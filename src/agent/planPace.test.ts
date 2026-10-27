import assert from "node:assert/strict";
import test from "node:test";
import { trackPace, windowDurationMs, windowPace, withPace, type PaceState } from "./planPace.js";
import type { PlanLimits } from "./types.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 28, 10);
const reset = T0 + 4 * HOUR; // a 5-hour window that started an hour before T0

const claude = (at: number, u: number, resetsAt = reset): PlanLimits =>
  ({ at, source: "claude", windows: [{ id: "five_hour", label: "5-hour", utilization: u, resetsAt }] });

function feed(readings: Array<[number, number]>, resetsAt = reset): PaceState {
  let state: PaceState = {};
  for (const [at, u] of readings) state = trackPace(state, "claude", claude(at, u, resetsAt), at);
  return state;
}

test("window lengths come from Claude ids and Codex labels", () => {
  assert.equal(windowDurationMs({ id: "five_hour", label: "5-hour" }), 5 * HOUR);
  assert.equal(windowDurationMs({ id: "seven_day_opus", label: "Weekly (Opus)" }), 7 * 24 * HOUR);
  assert.equal(windowDurationMs({ id: "codex:codex:primary", label: "5-hour" }), 5 * HOUR);
  assert.equal(windowDurationMs({ id: "codex:x:secondary", label: "Spark · Weekly" }), 7 * 24 * HOUR);
  assert.equal(windowDurationMs({ id: "codex:codex:primary", label: "90-minute" }), 90 * MIN);
  assert.equal(windowDurationMs({ id: "cursor_included", label: "Included" }), undefined);
});

test("a single reading gives no projection, only the window length", () => {
  const state = feed([[T0, 0.3]]);
  const pace = windowPace(state, "claude", claude(T0, 0.3).windows[0], T0);
  assert.deepEqual(pace, { durationMs: 5 * HOUR });
});

test("a fast burn runs out before the reset", () => {
  // 10% in 30 minutes: the remaining 60% lasts 3 hours, before the reset at T0+4h.
  const state = feed([[T0, 0.3], [T0 + 30 * MIN, 0.4]]);
  const now = T0 + 30 * MIN;
  const pace = windowPace(state, "claude", claude(now, 0.4).windows[0], now);
  assert.equal(pace?.runsOutAt, now + 3 * HOUR);
  const faster = feed([[T0, 0.3], [T0 + 30 * MIN, 0.6]]);
  assert.equal(windowPace(faster, "claude", claude(now, 0.6).windows[0], now)?.runsOutAt, now + 40 * MIN);
});

test("a slow or flat burn lasts until the reset", () => {
  const state = feed([[T0, 0.3], [T0 + 30 * MIN, 0.32]]);
  const now = T0 + 30 * MIN;
  assert.equal(windowPace(state, "claude", claude(now, 0.32).windows[0], now)?.lasts, true);
  const flat = feed([[T0, 0.3], [T0 + 30 * MIN, 0.3]]);
  assert.equal(windowPace(flat, "claude", claude(now, 0.3).windows[0], now)?.lasts, true);
});

test("readings too close together give no projection", () => {
  const state = feed([[T0, 0.3], [T0 + 5 * MIN, 0.5]]);
  const pace = windowPace(state, "claude", claude(T0 + 5 * MIN, 0.5).windows[0], T0 + 5 * MIN);
  assert.equal(pace?.runsOutAt, undefined);
  assert.equal(pace?.lasts, undefined);
});

test("a new window starts a new track", () => {
  const next = reset + 5 * HOUR;
  let state = feed([[T0, 0.3], [T0 + 30 * MIN, 0.9]]);
  const after = reset + MIN;
  state = trackPace(state, "claude", claude(after, 0.01, next), after);
  assert.deepEqual(state["claude:five_hour"].samples, [{ at: after, u: 0.01 }]);
  assert.equal(windowPace(state, "claude", claude(after, 0.01, next).windows[0], after)?.runsOutAt, undefined);
});

test("the rate looks back about an hour of a 5-hour window", () => {
  // A heavy first hour, then a quiet one: the recent rate is the quiet one.
  const state = feed([[T0, 0.1], [T0 + 30 * MIN, 0.4], [T0 + HOUR, 0.6], [T0 + 90 * MIN, 0.61], [T0 + 2 * HOUR, 0.62]]);
  assert.deepEqual(state["claude:five_hour"].samples.map((s) => s.u), [0.6, 0.61, 0.62]);
  const now = T0 + 2 * HOUR;
  assert.equal(windowPace(state, "claude", claude(now, 0.62).windows[0], now)?.lasts, true);
});

test("duplicate and unavailable reports are not readings", () => {
  let state = feed([[T0, 0.3]]);
  state = trackPace(state, "claude", claude(T0, 0.3), T0 + MIN);
  state = trackPace(state, "claude", { ...claude(T0 + HOUR, 0.9), availability: "unavailable" }, T0 + HOUR);
  assert.equal(state["claude:five_hour"].samples.length, 1);
});

test("withPace leaves windows without a known length alone", () => {
  const limits: PlanLimits = { at: T0, windows: [{ id: "cursor_included", label: "Included", utilization: 0.2, resetsAt: reset }] };
  assert.equal(withPace({}, "cursor", limits, T0), limits);
});
