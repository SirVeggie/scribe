import type { ThreadSchedule } from "./types.js";

/**
 * Scheduled continuations (#1064): an agent sends itself, or a helper it started, a message at a
 * later time with thread_schedule ("finish this, then update the app after 18:30"). The thread keeps
 * one schedule; the chat shows it in a banner until it is sent, sent early or cancelled.
 */

/** How far ahead a continuation may be scheduled. */
export const MAX_SCHEDULE_MS = 366 * 24 * 60 * 60 * 1000;
export const MAX_SCHEDULE_MESSAGE = 4000;

/**
 * When to send: inMinutes from now, or at as an ISO date-time (no offset: the machine's local time)
 * or a local "HH:MM" (today, or tomorrow once that time has passed). Throws a message for the agent.
 */
export function scheduleTime(opts: { at?: string; inMinutes?: number }, now = Date.now()): number {
  let when: number;
  if (typeof opts.inMinutes === "number") {
    if (!Number.isFinite(opts.inMinutes) || opts.inMinutes <= 0) throw new Error("inMinutes must be a positive number.");
    when = now + Math.round(opts.inMinutes * 60_000);
  } else if (opts.at?.trim()) {
    const at = opts.at.trim();
    const clock = /^(\d{1,2}):(\d{2})$/.exec(at);
    if (clock) {
      const [h, m] = [Number(clock[1]), Number(clock[2])];
      if (h > 23 || m > 59) throw new Error(`Not a time of day: ${at}`);
      const day = new Date(now);
      day.setHours(h, m, 0, 0);
      if (day.getTime() <= now) day.setDate(day.getDate() + 1);
      when = day.getTime();
    } else {
      when = Date.parse(at.replace(" ", "T"));
      if (!Number.isFinite(when)) throw new Error(`Not a date and time: ${at}. Use an ISO date-time such as 2026-11-08T18:30, a time of day such as 18:30, or inMinutes.`);
      if (when <= now) throw new Error(`${at} has already passed (it is now ${localStamp(now)}).`);
    }
  } else {
    throw new Error("Pass at or inMinutes.");
  }
  if (when - now > MAX_SCHEDULE_MS) throw new Error("Schedule it at most a year ahead.");
  return when;
}

/** A local date and time the agent and the user can both read, e.g. "Sun 8 Nov 2026, 18:30". */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).replace(/,/g, "");
  return `${day}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The message the thread gets when its schedule comes due (or the user sends it early). */
export function schedulePrompt(schedule: ThreadSchedule, now = Date.now(), early = false): string {
  const when = early
    ? `The user sent your scheduled continuation early (it was set for ${localStamp(schedule.at)}; it is now ${localStamp(now)}).`
    : `It is now ${localStamp(now)}: the time ${schedule.by ? "the agent that started you" : "you"} scheduled with thread_schedule.`;
  return schedule.message ? `${when}\n\n${schedule.message}` : `${when} Go on with the task.`;
}
