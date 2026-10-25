(() => {
  "use strict";
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
        const streaming = Boolean(settings.streaming), preview = streaming && settings.input.livePreview !== false;
        const next = await window.scribeAudio[streaming ? "stream" : "dictate"]({ owner, preview,
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
        const input = view.input;
        const inserted = window.scribeAudio.insertAtCaret(input.value, input.selectionStart, input.selectionEnd, result.text);
        input.value = inserted.value; input.setSelectionRange(inserted.caret, inserted.caret);
        input.dispatchEvent(new Event("input", { bubbles: true })); view.focus();
        if (result.text.trim() && settings.input.sendAfterDictation) view.send();
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
