import { store, type BoardStore } from "./store.js";
import { visibleTo, type PageEvent, type Tab, type Viewer } from "./types.js";

export type WaitResult = {
  /** Matching events after the cursor, oldest first. Empty when the wait ended another way. */
  events: PageEvent[];
  /** Pass as `after` to the next wait. Covers every event seen, matching or not. */
  cursor: number;
  /** Events between the cursor and the oldest one still kept were dropped from the log. */
  missed: boolean;
  timedOut: boolean;
  /** The page was deleted (or hidden from the agent). */
  deleted: boolean;
  /** The page's tab was closed; the page is still in the Library. */
  closed: boolean;
  id: string;
  key: string;
  stateRevision: number;
};

/** True when the event's name is wanted and, if `where` is set, every field matches `data`. */
export function eventMatches(
  event: PageEvent,
  names: string[],
  where?: Record<string, string | number | boolean>
): boolean {
  if (names.length && !names.includes(event.name)) {
    return false;
  }
  if (!where) {
    return true;
  }
  const data = event.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return false;
  }
  const rec = data as Record<string, unknown>;
  return Object.entries(where).every(
    ([field, want]) => rec[field] !== undefined && rec[field] !== null && String(rec[field]) === String(want)
  );
}

/**
 * Resolve with the events after `after` whose name is in `names` (any name when empty).
 * `where` further requires those fields on event `data` (compared as text).
 * Without `after`, only events logged from now on count.
 */
export function waitForEvents(opts: {
  idOrKey: string;
  names: string[];
  after?: number;
  timeoutMs: number;
  viewer: Viewer;
  abort?: AbortSignal;
  where?: Record<string, string | number | boolean>;
  store?: BoardStore;
}): Promise<WaitResult> {
  const db = opts.store ?? store;
  const initial = db.get(opts.idOrKey, opts.viewer);
  if (!initial) {
    return Promise.reject(new Error(`tab not found: ${opts.idOrKey}`));
  }
  const tabId = initial.id;
  const after = typeof opts.after === "number" && opts.after >= 0 ? Math.floor(opts.after) : initial.eventSeq;

  return new Promise((resolve) => {
    let settled = false;
    let last: Tab = initial;
    // Only a close during the wait ends it: a page already closed (a background, Library-only form)
    // can still be opened and answered (#1082).
    let closed = false;

    const finish = (result: WaitResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const check = (timedOut: boolean) => {
      const current = db.get(tabId);
      if (!current || !visibleTo(current, opts.viewer)) {
        finish({ ...result(last, []), deleted: true });
        return;
      }
      last = current;
      const matching = current.events.filter((event) => event.seq > after && eventMatches(event, opts.names, opts.where));
      if (matching.length) {
        finish(result(current, matching));
        return;
      }
      if (closed && db.isClosed(tabId)) {
        finish({ ...result(current, []), closed: true });
        return;
      }
      if (timedOut) {
        finish({ ...result(current, []), timedOut: true });
      }
    };

    const onEvent = (tabOrId: Tab | string) => {
      const id = typeof tabOrId === "string" ? tabOrId : tabOrId.id;
      if (id === tabId) {
        check(false);
      }
    };
    const onClosed = (id: string) => {
      if (id === tabId) {
        closed = true;
        check(false);
      }
    };
    const onAbort = () => check(true);
    const timer = setTimeout(() => check(true), opts.timeoutMs);

    db.on("tab_event", onEvent);
    db.on("tab_deleted", onEvent);
    db.on("tab_closed", onClosed);
    if (opts.abort) {
      if (opts.abort.aborted) {
        onAbort();
      } else {
        opts.abort.addEventListener("abort", onAbort);
      }
    }

    check(false);

    function cleanup() {
      clearTimeout(timer);
      db.off("tab_event", onEvent);
      db.off("tab_deleted", onEvent);
      db.off("tab_closed", onClosed);
      opts.abort?.removeEventListener("abort", onAbort);
    }
  });

  function result(tab: Tab, events: PageEvent[]): WaitResult {
    const oldest = tab.events[0]?.seq;
    return {
      events: events.map((event) => ({ ...event })),
      // Non-matching events are consumed too, so the next wait doesn't look at them again.
      cursor: Math.max(after, tab.eventSeq),
      missed: oldest !== undefined && after < oldest - 1,
      timedOut: false,
      deleted: false,
      closed: false,
      id: tab.id,
      key: tab.key,
      stateRevision: tab.stateRevision,
    };
  }
}
