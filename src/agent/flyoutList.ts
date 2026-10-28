/**
 * Hover list on the island orb and the top-bar agent button, in three sections:
 * Active (running), Waiting (needs the user) and Recent (finished or drafted in the last hour).
 */

/** Recent keeps a short window so the list stays clean. */
export const FLYOUT_RECENT_MS = 60 * 60 * 1000;
/** Active and Waiting are not capped. */
export const FLYOUT_RECENT_CAP = 5;

export type FlyoutThread = {
  id: string;
  status: string;
  unread?: boolean;
  fromPage?: boolean;
  archived?: boolean;
  pinned?: boolean;
  /** An idle thread whose usage limit card still waits for an answer (#78): listed under Waiting. */
  limit?: boolean;
  /** Last user message or finished turn. */
  activityAt: number;
  /** Last edit of an unsent draft with content, or 0. */
  draftAt?: number;
};

export type FlyoutSections<T extends FlyoutThread = FlyoutThread> = { active: T[]; waiting: T[]; recent: T[] };

function rank(t: FlyoutThread): number {
  return (t.pinned ? 1e15 : 0) + t.activityAt;
}

/** When an idle thread last counted for Recent: a finished turn (not page chats) or a draft edit. */
export function recentAt(t: FlyoutThread): number {
  return Math.max(t.fromPage ? 0 : t.activityAt, t.draftAt || 0);
}

/**
 * Newest first in each section. Recent takes idle threads with an unseen reply (any age) or
 * activity in the window; unseen ones come first, then the cap applies.
 */
export function flyoutSections<T extends FlyoutThread>(
  threads: T[],
  opts: { now: number; recentMs?: number; recentCap?: number }
): FlyoutSections<T> {
  const recentMs = opts.recentMs ?? FLYOUT_RECENT_MS;
  const recentCap = opts.recentCap ?? FLYOUT_RECENT_CAP;
  const all = threads.filter((t) => !t.archived).sort((a, b) => rank(b) - rank(a));
  const unseen = (t: T) => Boolean(t.unread) && !t.fromPage;
  const recent = all
    .filter((t) => t.status === "idle" && !t.limit && (unseen(t) || opts.now - recentAt(t) < recentMs))
    .sort((a, b) => Number(unseen(b)) - Number(unseen(a)) || recentAt(b) - recentAt(a))
    .slice(0, recentCap);
  return {
    active: all.filter((t) => t.status === "running"),
    waiting: all.filter((t) => t.status === "waiting" || (t.status === "idle" && t.limit)),
    recent,
  };
}
