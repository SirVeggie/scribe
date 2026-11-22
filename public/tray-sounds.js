/* Plays the thread cues (#564) while the desktop app's board window is let go in the tray: the
   finish and ask sounds agent.js's toasts play, from the thread list instead of the board's socket. */
(() => {
  "use strict";
  const POLL_MS = 2000;
  const SETTINGS_MS = 30000;
  const seen = new Map();
  let settingsAt = Date.now();

  /** Keep in sync with waitingAsk in agent.js. */
  function waitingAsk(t) {
    if (!t.asking) return null;
    return t.status === "waiting" || (t.asking.kind === "limit" && t.status === "idle") ? t.asking : null;
  }

  async function poll() {
    try {
      if (Date.now() - settingsAt > SETTINGS_MS) {
        settingsAt = Date.now();
        await window.scribeAudio.refresh().catch(() => {});
      }
      const res = await fetch("/api/agent/threads");
      if (res.ok) {
        const { threads } = await res.json();
        for (const t of threads) {
          if (t.help) continue;
          const prev = seen.get(t.id);
          const ask = waitingAsk(t)?.itemId || null;
          seen.set(t.id, { ask, finishedAt: t.finishedAt || 0 });
          // Threads seen for the first time (the list loading) make no sound.
          if (prev && ask && prev.ask !== ask) window.scribeAudio.threadCue(t, "ask", false);
          else if (prev && t.status === "idle" && t.finishedAt && prev.finishedAt !== t.finishedAt) window.scribeAudio.threadCue(t, "finish", false);
        }
      }
    } catch {
      /* the daemon is restarting: try again */
    }
    setTimeout(poll, POLL_MS);
  }
  void poll();
})();
