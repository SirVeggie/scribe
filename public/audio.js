/* Shared shell microphone capture and speech-to-text. Credentials stay in the daemon. */
(() => {
  "use strict";
  let active = null;
  let view = null;
  const failure = (error, message) => ({ ok: false, error, message });
  async function refresh() {
    const res = await fetch("/api/audio/settings");
    if (!res.ok) throw new Error("Cannot read Audio settings. Restart Scribe after updating.");
    view = await res.json();
    document.querySelectorAll(".ag-mic").forEach(button => {
      button.hidden = !view.available && (!button.dataset.state || button.dataset.state === "idle");
    });
    return view;
  }
  function available() {
    return { mic: !!navigator.mediaDevices?.getUserMedia && !!window.MediaRecorder,
      stt: !!view?.available, reason: view?.available ? undefined : "Choose a speech-to-text source in Settings → Audio." };
  }
  function device() { try { return localStorage.getItem("scribe.audio.device") || ""; } catch { return ""; } }
  function setDevice(id) { try { localStorage.setItem("scribe.audio.device", id); } catch { /* browser storage disabled */ } }
  async function capture(opts = {}) {
    // Web Locks share the device reservation across the shell's windows, including pending prompts.
    if (!navigator.locks) return captureLocal(opts);
    return new Promise((resolve, reject) => {
      navigator.locks.request("scribe-microphone", { ifAvailable: true }, async lock => {
        if (!lock) { reject(Object.assign(new Error("The microphone is already recording."), { audioError: "busy" })); return; }
        try { const session = await captureLocal(opts); resolve(session); await session.ended.catch(() => {}); }
        catch (err) { reject(err); }
      }).catch(reject);
    });
  }
  async function captureLocal({ owner, maxMs = 300000, onLevel = () => {}, onState = () => {} } = {}) {
    if (active) throw Object.assign(new Error("The microphone is already recording."), { audioError: "busy" });
    if (!available().mic) throw new Error("Microphone recording is unavailable in this browser.");
    const token = { cancel: () => { token.cancelled = true; }, owner, cancelled: false };
    active = token;
    let stream, context, timer, frame, recorder, session;
    const clean = () => {
      clearTimeout(timer); cancelAnimationFrame(frame);
      stream?.getTracks().forEach(track => track.stop());
      void context?.close().catch(() => {});
      if (active === token || active === session) active = null;
    };
    try {
      const id = device();
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true,
        autoGainControl: true, ...(id ? { deviceId: { exact: id } } : {}) } });
      if (token.cancelled) { clean(); throw new Error("Recording cancelled."); }
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32000 });
      const chunks = [];
      let state = "recording", settled = false, resolveEnd, rejectEnd;
      const ended = new Promise((resolve, reject) => { resolveEnd = resolve; rejectEnd = reject; });
      // cancel() can be used without a consumer waiting for stop().
      ended.catch(() => {});
      const finish = () => {
        if (settled) return;
        settled = true; clean();
        if (state === "cancelled") rejectEnd(new Error("Recording cancelled."));
        else { state = "stopped"; onState(state); resolveEnd(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" })); }
      };
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = finish;
      recorder.onerror = () => { state = "cancelled"; finish(); };
      session = { owner, ended, get state() { return state; },
        stop() { if (state === "recording") { state = "stopping"; if (recorder.state !== "inactive") recorder.stop(); clean(); } return ended; },
        cancel() { if (settled) return; state = "cancelled"; onState(state); clean(); if (recorder.state !== "inactive") recorder.stop(); else finish(); } };
      active = session;
      // Metering is optional; a missing AudioContext must not prevent recording.
      try {
        context = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = context.createAnalyser(); analyser.fftSize = 256;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        let last = 0;
        const meter = time => {
          if (time - last > 66) { last = time; analyser.getByteTimeDomainData(samples);
            onLevel(Math.min(1, Math.sqrt(samples.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) / samples.length) * 3)); }
          frame = requestAnimationFrame(meter);
        };
        frame = requestAnimationFrame(meter);
      } catch { /* capture still works without a meter */ }
      recorder.start(1000);
      onState("recording");
      timer = setTimeout(() => { void session.stop(); }, Math.min(300000, Math.max(1, maxMs)));
      return session;
    } catch (err) {
      clean();
      const message = err.name === "NotAllowedError" || err.name === "SecurityError" ? "Microphone blocked for this site. Allow it in your browser’s site permissions."
        : err.name === "NotFoundError" || err.name === "OverconstrainedError" ? "No microphone found. Check the device selected in Settings → Audio."
        : err.name === "NotReadableError" ? "Cannot open the microphone. Check whether another app is using it." : err.message;
      throw Object.assign(new Error(message), { audioError: err.audioError || (err.name === "NotAllowedError" || err.name === "SecurityError" ? "denied" : "no_mic") });
    }
  }
  async function transcribe(blob, opts = {}) {
    try {
      const query = new URLSearchParams();
      if (opts.language) query.set("language", opts.language);
      if (opts.prompt) query.set("prompt", opts.prompt);
      const res = await fetch(`/api/audio/transcriptions?${query}`, { method: "POST", signal: opts.signal,
        headers: { "Content-Type": blob.type || "audio/webm", ...(opts.tabId ? { "x-scribe-tab": opts.tabId } : {}) }, body: blob });
      return await res.json();
    } catch (err) { return failure("network", err.name === "AbortError" ? "Dictation cancelled." : "Cannot reach speech-to-text."); }
  }
  async function dictate(opts = {}) {
    const session = await capture(opts);
    const controller = new AbortController();
    const ended = session.ended.then(blob => {
      opts.onState?.("transcribing");
      return transcribe(blob, { ...opts, signal: controller.signal });
    }).catch(() => failure("cancelled", "Dictation cancelled."));
    return { get state() { return session.state; }, ended,
      stop() { session.stop(); return ended; }, cancel() { controller.abort(); session.cancel(); } };
  }
  /** Pure caret insertion; punctuation and existing whitespace do not get an extra space. */
  function insertAtCaret(value, start, end, transcript) {
    const text = transcript.trim();
    if (!text) return { value, caret: end };
    const before = value.slice(0, start), after = value.slice(end);
    const left = before && !/[\s([{]$/.test(before) && !/^[,.;:!?)}\]]/.test(text) ? " " : "";
    const right = after && !/^[\s,.;:!?)}\]]/.test(after) && !/[\s([{]$/.test(text) ? " " : "";
    return { value: before + left + text + right + after, caret: before.length + left.length + text.length + right.length };
  }
  window.scribeAudio = { capture, transcribe, dictate, available, refresh, settings: () => view,
    device, setDevice, insertAtCaret, cancel: owner => { if (!owner || active?.owner === owner) active?.cancel(); } };
  window.addEventListener("pagehide", () => active?.cancel());
  void refresh().catch(() => {});
})();
