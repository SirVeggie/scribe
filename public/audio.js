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
    setOutput(view.output);
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
  async function captureLocal({ owner, maxMs = 300000, onLevel = () => {}, onState = () => {}, live = false, onFrame = () => {} } = {}) {
    if (active) throw Object.assign(new Error("The microphone is already recording."), { audioError: "busy" });
    if (!navigator.mediaDevices?.getUserMedia || (!live && !window.MediaRecorder)) throw new Error("Microphone recording is unavailable in this browser.");
    const token = { cancel: () => { token.cancelled = true; }, owner, cancelled: false };
    active = token;
    let stream, context, timer, frame, recorder, session, tap;
    const clean = () => {
      clearTimeout(timer); cancelAnimationFrame(frame);
      if (tap) { tap.port.onmessage = null; tap.port.close(); tap.disconnect(); }
      stream?.getTracks().forEach(track => track.stop());
      void context?.close().catch(() => {});
      if (active === token || active === session) active = null;
    };
    try {
      const id = device();
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true,
        autoGainControl: true, ...(id ? { deviceId: { exact: id } } : {}) } });
      if (token.cancelled) { clean(); throw new Error("Recording cancelled."); }
      if (live) {
        context = new (window.AudioContext || window.webkitAudioContext)();
        await context.audioWorklet.addModule("/audio-stream-worklet.js");
        if (token.cancelled) { clean(); throw new Error("Recording cancelled."); }
        tap = new AudioWorkletNode(context, "scribe-mic-capture");
        tap.port.onmessage = event => { if (session?.state === "recording" && event.data?.frame) onFrame(event.data.frame); };
        context.createMediaStreamSource(stream).connect(tap).connect(context.destination);
        await context.resume();
        if (token.cancelled) { clean(); throw new Error("Recording cancelled."); }
        let state = "recording", resolveEnd;
        const ended = new Promise(resolve => { resolveEnd = resolve; });
        session = { owner, ended, sampleRate: context.sampleRate, get state() { return state; },
          stop(reason = "stopped") {
            if (state === "recording") { state = "stopped"; clean(); onState(state); resolveEnd(reason); }
            return ended;
          },
          cancel(reason = "stopped") { return session.stop(reason); } };
        active = session;
        stream.getTracks().forEach(track => track.addEventListener("ended", () => session.stop("user")));
        tap.onprocessorerror = () => session.stop("user");
        onState("recording");
        timer = setTimeout(() => session.stop("max"), Math.min(300000, Math.max(1, maxMs)));
        return session;
      }
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
  /** 16 kHz mono 16-bit PCM in a WAV container. */
  function pcmWav(pcm, rate = 16000) {
    const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const text = (at, s) => [...s].forEach((ch, i) => out.setUint8(at + i, ch.charCodeAt(0)));
    text(0, "RIFF"); out.setUint32(4, 36 + pcm.length * 2, true); text(8, "WAVEfmt ");
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
    text(36, "data"); out.setUint32(40, pcm.length * 2, true);
    pcm.forEach((v, i) => out.setInt16(44 + i * 2, v, true));
    return new Blob([out], { type: "audio/wav" });
  }
  const toInt16 = floats => Int16Array.from(floats, v => Math.max(-1, Math.min(1, v)) * 0x7fff);
  /** 16 kHz mono PCM WAV, for sources (llama.cpp) that cannot decode MediaRecorder's WebM/Opus; about 8x larger. */
  async function toWav(blob) {
    if (/^audio\/(wav|x-wav|mpeg|flac)/.test(blob.type)) return blob;
    try {
      const audio = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(await blob.arrayBuffer());
      const pcm = new Float32Array(audio.length);
      for (let c = 0; c < audio.numberOfChannels; c++) audio.getChannelData(c).forEach((v, i) => { pcm[i] += v / audio.numberOfChannels; });
      return pcmWav(toInt16(pcm));
    } catch { return blob; }
  }
  async function transcribe(blob, opts = {}) {
    try {
      if (view?.wav) blob = await toWav(blob);
      const query = new URLSearchParams();
      if (opts.language) query.set("language", opts.language);
      if (opts.prompt) query.set("prompt", opts.prompt);
      const res = await fetch(`/api/audio/transcriptions?${query}`, { method: "POST", signal: opts.signal,
        headers: { "Content-Type": blob.type || "audio/webm", ...(opts.tabId ? { "x-scribe-tab": opts.tabId } : {}) }, body: blob });
      const result = await res.json();
      if (result.error !== "format") return result;
      // The source rejected the compressed clip; the daemon now reports it as WAV-only.
      const wav = await toWav(blob);
      if (wav === blob) return result;
      void refresh().catch(() => {});
      return transcribe(wav, opts);
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
  /** Streaming downsampler to 16 kHz: each output sample averages the input samples it covers. */
  function resampler(fromRate) {
    const ratio = fromRate / 16000;
    let carry = new Float32Array(0), pos = 0;
    return input => {
      const data = new Float32Array(carry.length + input.length); data.set(carry); data.set(input, carry.length);
      const out = [];
      while (pos + ratio <= data.length) {
        const a = Math.floor(pos), b = Math.floor(pos + ratio);
        let sum = 0; for (let i = a; i < b; i++) sum += data[i];
        out.push(b > a ? sum / (b - a) : data[a]); pos += ratio;
      }
      const keep = Math.floor(pos); carry = data.slice(keep); pos -= keep;
      return toInt16(out);
    };
  }
  /**
   * Live dictation (#832, experimental): 16 kHz PCM goes to the daemon while the user speaks, and
   * onText gets the text so far. If the stream fails, the recording is sent as one clip instead.
   * force streams even with the source's live transcription off (a sliding window over its uploads).
   */
  async function stream(opts = {}) {
    const chunks = [], preview = opts.preview !== false;
    let ws, wsDone, pending = [], pendingLength = 0, cancelled = false, resample;
    const reply = new Promise(resolve => { wsDone = resolve; });
    const sendPending = () => {
      if (!pendingLength || ws?.readyState !== WebSocket.OPEN) return;
      const joined = new Int16Array(pendingLength); let at = 0;
      pending.forEach(c => { joined.set(c, at); at += c.length; });
      ws.send(joined.buffer); pending = []; pendingLength = 0;
    };
    try {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/audio/stream?preview=${preview ? 1 : 0}${opts.force ? "&live=1" : ""}${opts.onSpeech ? `&speech=1&pause=${opts.pauseMs || 250}` : ""}${opts.tabId ? `&tab=${encodeURIComponent(opts.tabId)}` : ""}`);
      ws.binaryType = "arraybuffer";
      ws.onopen = sendPending;
      ws.onmessage = event => {
        let msg; try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === "text" && !cancelled) opts.onText?.(msg.text);
        else if (msg.type === "speech" && !cancelled) opts.onSpeech?.({ speaking: msg.speaking, at: msg.at, text: msg.text, final: msg.final });
        else if (msg.type === "done") wsDone(msg);
      };
      ws.onerror = ws.onclose = () => wsDone(failure("network", "The live transcription stream closed."));
    } catch { wsDone(failure("network", "Cannot open the live transcription stream.")); }
    let session;
    try {
      session = await capture({ ...opts, live: true, onFrame: buffer => {
        const floats = new Float32Array(buffer);
        let sum = 0; for (const v of floats) sum += v * v;
        opts.onLevel?.(Math.min(1, Math.sqrt(sum / floats.length) * 3));
        const pcm = (resample ||= resampler(floats.length * 50))(floats); // frames are 20 ms
        chunks.push(pcm); pending.push(pcm); pendingLength += pcm.length;
        // 100 ms per message; 40 ms with speech events, so the end of speech is heard sooner (#1001).
        if (pendingLength >= (opts.onSpeech ? 640 : 1600)) sendPending();
      } });
    } catch (err) { ws?.close(); throw err; }
    const ended = session.ended.then(async () => {
      if (cancelled) return failure("cancelled", "Dictation cancelled.");
      opts.onState?.("transcribing");
      sendPending();
      if (ws?.readyState === WebSocket.OPEN) ws.send("stop");
      let result = await Promise.race([reply, new Promise(resolve => setTimeout(() => resolve(failure("timeout", "Live transcription timed out.")), 60000))]);
      ws?.close();
      if (cancelled) return failure("cancelled", "Dictation cancelled.");
      if (!result.ok && !["no_source", "denied", "rate_limited"].includes(result.error) && chunks.length) {
        // The recording is still here: send it as one clip, as dictation without streaming does.
        const length = chunks.reduce((n, c) => n + c.length, 0), pcm = new Int16Array(length);
        let at = 0; chunks.forEach(c => { pcm.set(c, at); at += c.length; });
        result = await transcribe(pcmWav(pcm), opts);
      }
      return result.ok ? { ok: true, text: result.text } : result;
    });
    return { get state() { return session.state; }, ended,
      stop() { session.stop(); return ended; },
      cancel() { cancelled = true; ws?.close(); session.cancel(); } };
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
  /* ---------- output: one AudioContext, master volume, channels (#564) ---------- */
  // audio-cues.js loads first in the shell; cues stay silent without it.
  const rules = () => window.scribeAudioCues;
  const CHANNELS = ["cue", "page", "speech"];
  let output = { sounds: false, volume: 0.6, speechVolume: 1, cues: {} };
  const level = (v, fallback) => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
  let ctx = null, master = null;
  const channels = {}, decoded = new Map();
  function context() {
    if (ctx) return ctx;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    try {
      ctx = new Context(); master = ctx.createGain(); master.connect(ctx.destination);
      for (const name of CHANNELS) { channels[name] = ctx.createGain(); channels[name].connect(master); }
      master.gain.value = output.volume; channels.speech.gain.value = output.speechVolume;
    } catch { ctx = null; }
    return ctx;
  }
  /** Browsers start sound only after a gesture. Without one the context stays suspended and play() drops the sound. */
  async function running() {
    const audio = context();
    if (!audio) return false;
    if (audio.state === "running") return true;
    // Where autoplay is allowed (the desktop app), resume() succeeds without a gesture.
    await Promise.race([audio.resume().catch(() => {}), new Promise(resolve => setTimeout(resolve, 250))]);
    return audio.state === "running";
  }
  // Cues have no gesture of their own, so the first gesture in the shell starts the context for them.
  // Page sounds come with the page's own click, which also activates the shell.
  const GESTURES = ["pointerdown", "pointerup", "keydown", "touchend"];
  const unlock = () => {
    if (!output.sounds) return;
    const audio = context();
    audio?.resume().then(() => {
      if (audio.state === "running") GESTURES.forEach(type => window.removeEventListener(type, unlock, true));
    }).catch(() => {});
  };
  GESTURES.forEach(type => window.addEventListener(type, unlock, true));
  function setOutput(next) {
    if (!next || typeof next !== "object") return;
    output = { sounds: next.sounds === true, volume: level(next.volume, 0.6), speechVolume: level(next.speechVolume, 1), cues: { ...next.cues } };
    if (master) { master.gain.value = output.volume; channels.speech.gain.value = output.speechVolume; }
  }
  async function bufferFor(src) {
    if (typeof src === "string" && decoded.has(src)) return decoded.get(src);
    const bytes = src instanceof ArrayBuffer ? src.slice(0) : src instanceof Blob ? await src.arrayBuffer()
      : await (await fetch(src)).arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes);
    // Cues come back often; page sounds are usually one-off.
    if (typeof src === "string" && src.startsWith("/sounds/")) decoded.set(src, buffer);
    return buffer;
  }
  /**
   * Play a sound through the mixer. src: a URL, a Blob or an ArrayBuffer. Returns at once with
   * { stop(), ended }; ended resolves "ended", "stopped" or "failed" (dropped before a gesture counts as failed).
   */
  function play(src, { volume = 1, channel = "page" } = {}) {
    let node = null, stopped = false, done;
    const ended = new Promise(resolve => { done = resolve; });
    const finish = reason => { if (done) { done(reason); done = null; } };
    (async () => {
      try {
        if (!await running() || stopped) return finish(stopped ? "stopped" : "failed");
        const buffer = await bufferFor(src);
        if (stopped) return finish("stopped");
        const gain = ctx.createGain(); gain.gain.value = Math.min(1, Math.max(0, Number(volume) || 0));
        node = ctx.createBufferSource(); node.buffer = buffer;
        node.connect(gain).connect(channels[CHANNELS.includes(channel) ? channel : "page"]);
        node.onended = () => { gain.disconnect(); finish(stopped ? "stopped" : "ended"); };
        node.start();
      } catch { finish("failed"); }
    })();
    return { ended, stop() { stopped = true; try { node?.stop(); } catch { /* not started */ } finish("stopped"); } };
  }
  /**
   * Routes a media element (streamed speech) through a channel so the master volume applies.
   * Returns a function that undoes it, or null when the context cannot run yet: the element then plays on its own.
   */
  async function route(el, channel = "speech") {
    if (!await running()) return null;
    try {
      const node = ctx.createMediaElementSource(el);
      node.connect(channels[CHANNELS.includes(channel) ? channel : "page"]);
      return () => node.disconnect();
    } catch { return null; }
  }
  /* With several windows open, one plays a cue: the focused one, else the one open longest. */
  const self = { id: Math.random().toString(36).slice(2), since: Date.now(), focused: false };
  const peers = new Map();
  const bus = "BroadcastChannel" in window ? new BroadcastChannel("scribe-audio") : null;
  function announce() {
    self.focused = !document.hidden && document.hasFocus();
    bus?.postMessage({ id: self.id, since: self.since, focused: self.focused });
  }
  if (bus) {
    bus.onmessage = event => {
      const msg = event.data;
      if (!msg || typeof msg.id !== "string" || msg.id === self.id) return;
      if (msg.gone) peers.delete(msg.id);
      else peers.set(msg.id, { id: msg.id, since: Number(msg.since) || 0, focused: msg.focused === true, at: Date.now() });
      if (msg.hello) announce();
    };
    bus.postMessage({ id: self.id, since: self.since, focused: false, hello: true });
    setInterval(announce, 2000);
    ["focus", "blur"].forEach(type => window.addEventListener(type, announce));
    document.addEventListener("visibilitychange", announce);
    window.addEventListener("pagehide", () => bus.postMessage({ id: self.id, gone: true }));
  }
  let merge = null;
  /** Play a named cue if the settings allow it and this is the window that plays. Returns whether it tried. */
  function cue(name) {
    const cues = rules();
    if (!cues) return false;
    self.focused = !document.hidden && document.hasFocus();
    merge ||= cues.merger();
    if (!cues.cueEnabled(output, name) || !cues.elected(self, [...peers.values()], Date.now()) || !merge.admit(Date.now())) return false;
    play(`/sounds/${name}.wav`, { channel: "cue" });
    return true;
  }
  /** A thread finished (kind "finish") or started waiting on the user ("ask"); called by the toast manager. */
  function threadCue(t, kind, onScreen) {
    const name = rules()?.cueFor(t, kind, { watching: onScreen && !document.hidden && document.hasFocus() });
    return name ? cue(name) : false;
  }

  window.scribeAudio = { capture, transcribe, dictate, stream, resampler, available, refresh, settings: () => view,
    device, setDevice, insertAtCaret, cancel: owner => { if (!owner || active?.owner === owner) active?.cancel(); },
    play, route, cue, threadCue, setOutput, output: () => output };
  window.addEventListener("pagehide", () => active?.cancel());
  void refresh().catch(() => {});
})();
