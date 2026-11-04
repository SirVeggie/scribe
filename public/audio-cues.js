/* Rules for notification cues (#564), kept pure so src/audio/cues.test.ts can run them. */
(function (root) {
  "use strict";
  const MERGE_MS = 1500;
  /** A peer window that has not said anything for this long is gone. */
  const PEER_STALE_MS = 6000;

  /**
   * The cue a thread event plays, or null. Only user-level threads: not helpers, board workers'
   * chats or page chats (both are fromPage). Not while the user looks at that thread in a focused window.
   */
  function cueFor(t, kind, { watching = false } = {}) {
    if (!t || t.archived || t.fromPage || t.helperOf || watching) return null;
    return kind === "finish" ? "thread-finish" : kind === "ask" ? "thread-ask" : null;
  }

  /** Whether the settings let this cue sound. */
  function cueEnabled(output, name) {
    return Boolean(output?.sounds && output.volume > 0 && output.cues?.[name] !== false);
  }

  /** Cues within MERGE_MS of the last one that played merge into it. */
  function merger(ms = MERGE_MS) {
    let last = -Infinity;
    return { admit(now) { if (now - last < ms) return false; last = now; return true; } };
  }

  /**
   * Which window plays: the focused one; with none focused, the one open longest (lowest since,
   * then lowest id). peers: [{ id, since, focused, at }] from the other windows' heartbeats.
   */
  function elected(self, peers, now) {
    if (self.focused) return true;
    const live = peers.filter(p => p.id !== self.id && now - p.at < PEER_STALE_MS);
    if (live.some(p => p.focused)) return false;
    return live.every(p => self.since < p.since || (self.since === p.since && self.id < p.id));
  }

  root.scribeAudioCues = { cueFor, cueEnabled, merger, elected, MERGE_MS, PEER_STALE_MS };
})(typeof window !== "undefined" ? window : globalThis);
