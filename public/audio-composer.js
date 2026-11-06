(() => {
  "use strict";
  // Silence after the send keyword before it sends (#1060), so the word inside a sentence does not.
  const KEYWORD_PAUSE_MS = 1000;
  window.scribeAudio.bindComposer = view => {
    let session = null, owner = null, state = "idle", epoch = 0, started = 0, level = 0, timer;
    let held = false, releasePending = false;
    const paint = () => {
      const button = view.bar.querySelector(".ag-mic"); if (!button) return;
      button.hidden = state === "idle" && !window.scribeAudio.available().stt;
      const label = state === "recording" ? "Stop dictation (Esc cancels)" : state === "transcribing" ? "Transcribing…" : state === "starting" ? "Opening microphone…" : "Dictate (Ctrl+Shift+Space)";
      button.dataset.state = state; button.dataset.tooltip = label; button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", String(state === "recording"));
      button.disabled = state === "starting" || state === "transcribing";
      button.style.setProperty("--mic-level", level);
      const cancelButton = view.bar.querySelector(".ag-mic-cancel"); if (cancelButton) cancelButton.hidden = state === "idle";
      button.querySelector(".ag-mic-status").textContent = state === "recording" ? `${Math.floor((Date.now() - started) / 1000)}s` : state === "transcribing" ? "…" : "";
    };
    // Text so far while a streaming source transcribes (#832); replaced by the final text on stop.
    const live = text => {
      const box = view.dictationLive; if (!box) return;
      box.textContent = text || ""; box.hidden = !text;
    };
    const keyup = event => { if (held && (event.code === "Space" || event.key === "Control" || event.key === "Shift")) { held = false; stop(); } };
    const escape = event => { if (event.key === "Escape" && state !== "idle") { event.preventDefault(); event.stopImmediatePropagation(); cancel(); view.focus(); } };
    const blur = () => { if (held) cancel(); };
    const clear = () => {
      clearInterval(timer); timer = null; session = null; live(""); owner = null; state = "idle"; level = 0; held = false; releasePending = false;
      window.removeEventListener("keyup", keyup, true); window.removeEventListener("keydown", escape, true); window.removeEventListener("blur", blur);
      paint();
    };
    const cancel = () => { epoch++; held = false; releasePending = false; session?.cancel(); if (owner) window.scribeAudio.cancel(owner); clear(); };
    const stop = () => { if (state === "starting") { releasePending = true; return; } if (session && state === "recording") void session.stop(); };
    async function start() {
      if (state !== "idle") return;
      const current = ++epoch; owner = { kind: "chat", threadId: view.threadId };
      window.addEventListener("keyup", keyup, true); window.addEventListener("keydown", escape, true); window.addEventListener("blur", blur);
      state = "starting"; paint();
      timer = setInterval(() => { if (!view.visible()) cancel(); else paint(); }, 100);
      try {
        const settings = await window.scribeAudio.refresh();
        if (current !== epoch) return;
        if (!settings.available) { clear(); window.scribeApp?.openSettings?.("Audio"); return; }
        started = Date.now();
        // A send keyword (#1060) needs speech events, so it streams even with the source's live transcription off.
        const keyword = settings.input.sendKeyword || "", listen = Boolean(keyword && window.AudioWorkletNode && window.WebSocket);
        const streaming = Boolean(settings.streaming) || listen, preview = Boolean(settings.streaming) && settings.input.livePreview !== false;
        let heard = false;
        const next = await window.scribeAudio[streaming ? "stream" : "dictate"]({ owner, preview, force: listen && !settings.streaming,
          ...(listen ? { pauseMs: KEYWORD_PAUSE_MS, onSpeech: speech => {
            if (current === epoch && speech.final && window.scribeAudio.stripSendKeyword(speech.text, keyword) !== null) { heard = true; stop(); }
          } } : {}),
          onText: text => { if (current === epoch && preview) live(text); },
          onLevel: v => { level = v; },
          onState: nextState => { if (current !== epoch) return; if (nextState === "recording" || nextState === "transcribing") { state = nextState; paint(); } },
        });
        if (current !== epoch) { next.cancel(); return; }
        session = next;
        if (releasePending) { releasePending = false; stop(); }
        const result = await next.ended;
        if (current !== epoch) return;
        clear();
        if (!result.ok) { window.scribeAudio.notice(result.message); return; }
        // Stopping by hand right after the keyword counts as its pause too.
        const stripped = keyword ? window.scribeAudio.stripSendKeyword(result.text, keyword) : null;
        const text = stripped ?? result.text, input = view.input;
        const inserted = window.scribeAudio.insertAtCaret(input.value, input.selectionStart, input.selectionEnd, text);
        input.value = inserted.value; input.setSelectionRange(inserted.caret, inserted.caret);
        input.dispatchEvent(new Event("input", { bubbles: true })); view.focus();
        const byKeyword = stripped !== null || heard;
        if (byKeyword ? input.value.trim() : result.text.trim() && settings.input.sendAfterDictation) view.send();
      } catch (err) { if (current === epoch) { clear(); window.scribeAudio.notice(err.message); } }
    }
    const toggle = () => { if (state === "recording") stop(); else if (state === "idle") void start(); };
    view.input.addEventListener("keydown", event => {
      if (event.code !== "Space" || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || window.scribeAudio.settings()?.input.pushToTalk === false) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat && !held && state === "idle") { held = true; void start(); }
    }, true);
    return { toggle, cancel, paint };
  };
})();
