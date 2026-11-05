/* Text-to-speech in the shell (Phase D): scribeAudio.speak and scribeAudio.voices. Credentials stay in the daemon. */
(() => {
  "use strict";
  const MAX_CHARS = 4096;
  // Short first piece so speech starts quickly; later pieces download while the one before plays.
  const FIRST_CHARS = 300;
  // Chrome stops long utterances of network voices after about 15 s.
  const BROWSER_CHARS = 250;
  const KOKORO_LANGS = { a: "US", b: "UK", e: "Spanish", f: "French", h: "Hindi", i: "Italian", j: "Japanese", p: "Portuguese", z: "Chinese" };
  /** A readable name for a voice id: Kokoro's "af_heart" is "Heart (US, female)"; OpenAI's "nova" is "Nova". */
  function voiceName(id) {
    const kokoro = /^([abefhijpz])([fm])_([a-z0-9_]+)$/i.exec(id);
    const title = word => word.replace(/_/g, " ").replace(/\b\w/g, ch => ch.toUpperCase());
    if (kokoro) return `${title(kokoro[3])} (${KOKORO_LANGS[kokoro[1].toLowerCase()]}, ${kokoro[2].toLowerCase() === "f" ? "female" : "male"})`;
    return title(id);
  }
  const failure = (error, message) => ({ ok: false, error, message });
  /** Master volume times speech volume (#1011), for audio the mixer cannot route: browser voices, or before a gesture. */
  const speechLevel = () => { const out = window.scribeAudio?.output?.() || {}; return (out.volume ?? 1) * (out.speechVolume ?? 1); };
  const routeSpeech = async el => {
    const unroute = await Promise.resolve(window.scribeAudio.route?.(el, "speech")).catch(() => null);
    if (!unroute) el.volume = Math.min(1, Math.max(0, speechLevel()));
    return unroute;
  };

  /** Splits text at sentence ends into pieces of at most max characters (the first at most first); a sentence longer than max is cut at a comma or space. */
  function splitSpeech(text, max = MAX_CHARS, first = max) {
    const sentences = String(text ?? "").replace(/\r\n?/g, "\n").match(/[^.!?…。！？\n]+(?:[.!?…。！？]+["'”’)\]]*|\n+|$)\s*|[.!?…。！？\n]+\s*/g) || [];
    const parts = [];
    for (let sentence of sentences) {
      sentence = sentence.replace(/\s+/g, " ");
      while (sentence.length > max) {
        const cut = Math.max(sentence.lastIndexOf(", ", max - 1) + 1, sentence.lastIndexOf(" ", max));
        const at = cut > max / 2 ? cut : max;
        parts.push(sentence.slice(0, at)); sentence = sentence.slice(at);
      }
      parts.push(sentence);
    }
    const pieces = [];
    let current = "";
    for (const part of parts) {
      const limit = pieces.length ? max : Math.min(first, max);
      if (current && (current + part).trim().length > limit) { pieces.push(current.trim()); current = ""; }
      current += part;
    }
    if (current.trim()) pieces.push(current.trim());
    return pieces.filter(piece => /[\p{L}\p{N}]/u.test(piece));
  }

  // Where appended text may be read: after . ! ? … and a space, after 。！？, or at a newline.
  const SENTENCE_END = /[.!?…]+["'”’)\]]*\s+|[。！？]+["'”’)\]]*\s*|\n+/g;
  /**
   * Text waiting to be read aloud, a piece at a time (max characters, the first at most first).
   * Appended text is ready once its sentence ends, all of it once closed; take() waits for the
   * next piece and gives null when everything is read or the signal aborts.
   */
  function speechQueue() {
    let pending = "", ready = "", closed = false, taken = 0, wake = null;
    const settle = () => { const w = wake; wake = null; w?.(); };
    const add = text => { if (text) ready = ready ? `${ready} ${text}` : text; };
    const split = () => splitSpeech(ready, queue.max, taken ? queue.max : queue.first);
    const queue = {
      max: MAX_CHARS, first: MAX_CHARS,
      append(text) {
        if (closed) return false;
        pending += String(text ?? "");
        let end = 0;
        for (const m of pending.matchAll(SENTENCE_END)) end = m.index + m[0].length;
        // A long run without a sentence end goes at a space.
        while (pending.length - end > queue.max) { const cut = pending.lastIndexOf(" ", end + queue.max); end = cut > end ? cut + 1 : end + queue.max; }
        if (end) { add(pending.slice(0, end)); pending = pending.slice(end); settle(); }
        return true;
      },
      close() { if (closed) return; closed = true; add(pending); pending = ""; settle(); },
      /** Pieces taken or ready so far (all of them once closed). */
      count: () => taken + split().length,
      async take(signal) {
        for (;;) {
          if (signal.aborted) return null;
          const pieces = split();
          if (pieces.length) { ready = pieces.slice(1).join(" "); taken++; return pieces[0]; }
          ready = "";
          if (closed) return null;
          await new Promise(resolve => { wake = resolve; signal.addEventListener("abort", resolve, { once: true }); });
        }
      },
    };
    return queue;
  }

  let current = null;
  const once = (target, name) => new Promise(resolve => target.addEventListener(name, resolve, { once: true }));

  /**
   * Plays one /api/audio/speech response; with MediaSource it starts before the download ends.
   * onPlaying runs when sound actually starts, not when the response does: a streaming server
   * answers (and the gateway sends start) before it has generated any audio.
   */
  async function playResponse(res, el, signal, onPlaying) {
    const type = (res.headers.get("content-type") || "audio/mpeg").split(";")[0];
    let url;
    const playing = () => onPlaying?.();
    el.addEventListener("playing", playing, { once: true });
    try {
      if (window.MediaSource?.isTypeSupported?.(type) && res.body) {
        const media = new MediaSource(); url = URL.createObjectURL(media); el.src = url;
        await once(media, "sourceopen");
        const buffer = media.addSourceBuffer(type), reader = res.body.getReader();
        let started = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (signal.aborted) { void reader.cancel().catch(() => {}); return { ok: true, reason: "stopped" }; }
          if (done) break;
          buffer.appendBuffer(value); await once(buffer, "updateend");
          if (!started) { started = true; await el.play(); }
        }
        if (media.readyState === "open") media.endOfStream();
        if (!started) await el.play();
      } else {
        url = URL.createObjectURL(await res.blob()); el.src = url;
        if (signal.aborted) return { ok: true, reason: "stopped" };
        await el.play();
      }
      const reason = await new Promise(resolve => {
        el.onended = () => resolve("ended");
        el.onerror = () => resolve("error");
        signal.addEventListener("abort", () => resolve("stopped"), { once: true });
      });
      return reason === "error" ? failure("format", "Cannot play the speech audio.") : { ok: true, reason };
    } catch (err) {
      if (signal.aborted) return { ok: true, reason: "stopped" };
      return err?.name === "NotAllowedError" ? failure("blocked", "The browser blocked audio playback. Click in Scribe and try again.")
        : failure("format", "Cannot play the speech audio.");
    } finally {
      el.removeEventListener("playing", playing);
      el.pause(); el.removeAttribute("src"); el.load?.();
      if (url) URL.revokeObjectURL(url);
    }
  }

  async function fetchPiece(text, opts, signal) {
    try {
      const res = await fetch("/api/audio/speech", { method: "POST", signal,
        headers: { "Content-Type": "application/json", ...(opts.tabId ? { "x-scribe-tab": opts.tabId } : {}) },
        body: JSON.stringify({ text, voice: opts.voice, speed: opts.speed, ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
          ...(typeof opts.model === "string" ? { model: opts.model } : {}) }) });
      if (res.ok && !(res.headers.get("content-type") || "").includes("json")) return { ok: true, res };
      const result = await res.json().catch(() => null);
      return result && result.ok === false ? result : failure("engine", "Text-to-speech is unavailable.");
    } catch { return signal.aborted ? { ok: true, stopped: true } : failure("network", "Cannot reach text-to-speech."); }
  }

  async function speakSource(queue, opts, signal) {
    const el = new Audio();
    el.preload = "auto";
    // The mixer's speech channel (#564), so the master and speech volumes apply.
    const unroute = await routeSpeech(el);
    try { return await playPieces(queue, opts, signal, el); } finally { unroute?.(); }
  }
  /** What was read: spoken is the pieces played to the end; partial the one a stop cut off. */
  const heard = (result, spoken, partial) => ({ ...result, spoken: spoken.join(" "), ...(partial && result.reason === "stopped" ? { partial } : {}) });
  async function playPieces(queue, opts, signal, el) {
    const spoken = [];
    const fetchNext = async () => {
      const text = await queue.take(signal);
      return text === null ? null : { text, got: await fetchPiece(text, opts, signal) };
    };
    let next = fetchNext();
    for (let i = 0; ; i++) {
      const item = await next;
      if (signal.aborted || item?.got.stopped) return heard({ ok: true, reason: "stopped" }, spoken);
      if (!item) return heard({ ok: true, reason: "ended" }, spoken);
      if (!item.got.ok) return heard(item.got, spoken);
      // The next piece downloads while this one plays; text appended meanwhile waits for the one after.
      next = fetchNext();
      const played = await playResponse(item.got.res, el, signal,
        () => opts.onState?.({ state: "speaking", piece: i, pieces: queue.count(), text: item.text, spoken: spoken.join(" ") }));
      if (!played.ok || played.reason === "stopped") {
        void next.then(rest => rest?.got.res?.body?.cancel().catch(() => {}));
        return heard(played, spoken, item.text);
      }
      spoken.push(item.text);
    }
  }

  /** Text a speech was given, held until it knows where it goes (pipe): the source's stream as it is, or the sentence queue. */
  function textInput() {
    let parts = [], closed = false, target = null;
    return {
      append(text) {
        if (closed) return false;
        text = String(text ?? "");
        if (text) target ? target.append(text) : parts.push(text);
        return true;
      },
      close() { if (closed) return; closed = true; target?.close(); },
      pipe(next) { target = next; parts.splice(0).forEach(part => next.append(part)); if (closed) next.close(); },
    };
  }

  /**
   * The daemon's speech stream (/api/audio/speech-stream). Resolves { ws } once the source's own stream is ready,
   * { fallback: true } for a server without one (plain OpenAI-compatible), { stopped: true }, or a failure.
   */
  function openStream(opts, signal) {
    return new Promise(resolve => {
      let ws;
      try {
        const url = new URL("/api/audio/speech-stream", location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const params = { tab: opts.tabId, source: opts.sourceId, voice: opts.voice, speed: opts.speed, model: typeof opts.model === "string" ? opts.model : undefined };
        for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
      } catch { resolve({ fallback: true }); return; }
      const settle = result => {
        ws.onmessage = ws.onclose = ws.onerror = null;
        signal.removeEventListener("abort", abort);
        if (!result.ws) try { ws.close(); } catch { /* closed */ }
        resolve(result);
      };
      const abort = () => settle({ stopped: true });
      signal.addEventListener("abort", abort, { once: true });
      ws.onmessage = event => {
        if (typeof event.data !== "string") return;
        let msg; try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === "ready") settle({ ws });
        else if (msg.type === "fallback") settle({ fallback: true });
        else if (msg.type === "done") { const { type: _, ...result } = msg; settle(result.ok === false ? result : { fallback: true }); }
      };
      // An older daemon without the socket: read in pieces.
      ws.onerror = ws.onclose = () => settle({ fallback: true });
    });
  }

  /** Reads text through the source's own stream: text goes out as it arrives, the server cuts it and sends one audio stream back. */
  async function speakStream(ws, input, opts, signal) {
    const el = new Audio();
    el.preload = "auto";
    const unroute = await routeSpeech(el);
    try { return await playStream(ws, input, opts, signal, el); } finally { unroute?.(); try { ws.close(); } catch { /* closed */ } }
  }
  const STREAM_TYPES = { mp3: "audio/mpeg", opus: "audio/ogg", aac: "audio/aac", flac: "audio/flac", wav: "audio/wav" };
  async function playStream(ws, input, opts, signal, el) {
    let sent = "", audio = null, gotStart, gotDone;
    const send = msg => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
    const started = new Promise(resolve => { gotStart = resolve; });
    const done = new Promise(resolve => { gotDone = resolve; });
    const close = () => { try { audio?.close(); } catch { /* closed or cancelled */ } };
    ws.onmessage = event => {
      if (typeof event.data !== "string") { try { audio?.enqueue(new Uint8Array(event.data)); } catch { /* cancelled */ } return; }
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "start" && !audio) {
        const body = new ReadableStream({ start(controller) { audio = controller; } });
        gotStart(new Response(body, { headers: { "content-type": STREAM_TYPES[msg.format] || "audio/mpeg" } }));
      } else if (msg.type === "done") { close(); const { type: _, ...result } = msg; gotDone(result); gotStart(null); }
    };
    ws.onclose = () => { close(); gotDone(failure("network", "The text-to-speech stream closed early.")); gotStart(null); };
    signal.addEventListener("abort", () => { send({ type: "cancel" }); gotStart(null); }, { once: true });
    input.pipe({ append(text) { sent += text; send({ type: "text", text }); return true; }, close() { send({ type: "end" }); } });
    const res = await started;
    const text = () => sent.replace(/\s+/g, " ").trim();
    if (signal.aborted) return heard({ ok: true, reason: "stopped" }, [], text());
    if (!res) { const result = await done; return result.ok === false ? result : heard({ ok: true, reason: "ended" }, []); }
    const played = await playResponse(res, el, signal, () => opts.onState?.({ state: "speaking", piece: 0, pieces: 1, text: text(), spoken: "" }));
    // Only the whole text is known: a stop reports what was sent as partial.
    if (!played.ok || played.reason === "stopped") { send({ type: "cancel" }); return heard(played, [], text()); }
    const result = await done;
    return result.ok === false ? result : heard({ ok: true, reason: "ended" }, [text()]);
  }

  async function browserVoices() {
    const synth = window.speechSynthesis;
    if (!synth) return [];
    let list = synth.getVoices();
    if (!list.length) {
      await Promise.race([once(synth, "voiceschanged"), new Promise(resolve => setTimeout(resolve, 1000))]);
      list = synth.getVoices();
    }
    return list;
  }

  async function speakBrowser(queue, opts, signal) {
    const synth = window.speechSynthesis;
    if (!synth || !window.SpeechSynthesisUtterance) return failure("no_source", "This browser cannot read text aloud.");
    const voice = opts.voice ? (await browserVoices()).find(v => v.name === opts.voice || v.voiceURI === opts.voice) : undefined;
    const spoken = [];
    for (let i = 0; ; i++) {
      const text = await queue.take(signal);
      if (signal.aborted) return heard({ ok: true, reason: "stopped" }, spoken);
      if (text === null) return heard({ ok: true, reason: "ended" }, spoken);
      const utterance = new SpeechSynthesisUtterance(text);
      if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
      utterance.rate = Math.min(4, Math.max(0.25, Number(opts.speed) || 1));
      utterance.volume = Math.min(1, Math.max(0, speechLevel()));
      utterance.onstart = () => opts.onState?.({ state: "speaking", piece: i, pieces: queue.count(), text, spoken: spoken.join(" ") });
      const result = await new Promise(resolve => {
        utterance.onend = () => resolve("ended");
        utterance.onerror = event => resolve(event.error === "interrupted" || event.error === "canceled" ? "stopped" : "error");
        signal.addEventListener("abort", () => resolve("stopped"), { once: true });
        synth.speak(utterance);
      });
      if (result === "stopped") return heard({ ok: true, reason: "stopped" }, spoken, text);
      if (result === "error") return heard(failure("engine", "This browser could not read the text aloud."), spoken);
      spoken.push(text);
    }
  }

  /**
   * Reads text aloud through the text-to-speech source in Settings → Audio, on the speech channel:
   * one speech at a time, so a new one stops the one before. Returns { stop(), ended } at once;
   * ended resolves to { ok: true, reason: "ended" | "stopped", spoken, partial? } or a failure { ok: false, error, message }.
   * opts.stream: no text up front; session.append(text) adds text as it arrives and session.end() says
   * there is no more. A source with its own stream (/stream WebSocket) gets the text as it arrives and cuts it
   * itself; others read each piece once its sentence ends, and stopping drops what was not fetched yet.
   */
  function speak(text, opts = {}) {
    current?.stop();
    const controller = new AbortController(), input = textInput(), queue = speechQueue();
    const session = { stop() { input.close(); queue.close(); controller.abort(); window.speechSynthesis?.cancel(); return session.ended; } };
    if (opts.stream) Object.assign(session, { append: more => input.append(more), end: () => input.close() });
    else if (!splitSpeech(text).length) { session.ended = Promise.resolve(failure("invalid_audio", "Give the text to read aloud.")); return session; }
    else { input.append(text); input.close(); }
    current = session;
    session.ended = (async () => {
      const view = window.scribeAudio.settings() || await window.scribeAudio.refresh().catch(() => null);
      // sourceId: Settings tests one source before it is chosen.
      const mode = opts.mode || (opts.sourceId ? (opts.sourceId === "__browser__" ? "browser" : "source") : view?.speech);
      const settings = view?.tts || {};
      const merged = { ...opts, voice: opts.voice ?? settings.voice, speed: opts.speed ?? settings.speed };
      if (mode === "browser") { queue.max = queue.first = BROWSER_CHARS; input.pipe(queue); return speakBrowser(queue, merged, controller.signal); }
      if (mode !== "source") return failure("no_source", "Choose a text-to-speech source in Settings → Audio.");
      // The daemon fills in the saved voice and speed. A server with its own stream takes the text as it is.
      const stream = await openStream(opts, controller.signal);
      if (stream.stopped) return heard({ ok: true, reason: "stopped" }, []);
      if (stream.ws) return speakStream(stream.ws, input, opts, controller.signal);
      if (!stream.fallback) return stream;
      queue.first = FIRST_CHARS; input.pipe(queue);
      return speakSource(queue, opts, controller.signal);
    })().catch(() => failure("engine", "Text-to-speech is unavailable.")).finally(() => { input.close(); queue.close(); if (current === session) current = null; });
    return session;
  }

  /**
   * Voices for the chosen text-to-speech source: the browser's own, or the server's list
   * (GET …/audio/voices, through the daemon). Servers without a list get the OpenAI names (listed: false).
   * opts.source: "browser", or a source to ask about: { id } for a saved one, or the editor's draft.
   */
  async function voices(opts = {}) {
    // A source id from sources(): This browser's, or a saved source's (with an optional model).
    if (typeof opts.source === "string" && opts.source !== "browser")
      opts = { ...opts, source: opts.source === "__browser__" ? "browser" : { id: opts.source, ...(typeof opts.model === "string" ? { model: opts.model } : {}) } };
    let mode = opts.source === "browser" ? "browser" : opts.source ? "source" : undefined;
    if (!mode) mode = (await window.scribeAudio.refresh().catch(() => window.scribeAudio.settings()))?.speech;
    if (mode === "browser")
      return { ok: true, source: "browser", listed: true, voices: (await browserVoices()).map(v => ({ id: v.name, name: v.name, lang: v.lang })) };
    if (mode !== "source") return failure("no_source", "Choose a text-to-speech source in Settings → Audio.");
    try {
      const res = await fetch("/api/audio/voices", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(typeof opts.source === "object" ? opts.source : {}) });
      const result = await res.json();
      if (!result.ok) return result;
      return { ok: true, source: "source", listed: result.listed, ...(result.default ? { default: result.default } : {}),
        voices: result.voices.map(v => ({ id: v.id, name: v.name || voiceName(v.id) })) };
    } catch { return failure("network", "Cannot reach text-to-speech."); }
  }

  /** The text-to-speech choices: This browser, then the user's sources; default is the one Settings picked (null: off). */
  async function sources() {
    const view = await window.scribeAudio.refresh().catch(() => window.scribeAudio.settings());
    if (!view) return failure("unavailable", "Cannot read Audio settings.");
    return { ok: true, default: view.tts?.source || null, sources: [
      ...(window.speechSynthesis ? [{ id: "__browser__", name: "This browser", kind: "browser" }] : []),
      ...(view.ttsSources || []).map(s => ({ id: s.id, name: s.name, kind: "server", ...(s.model ? { model: s.model } : {}) }))] };
  }
  /** A source's models (GET …/models through the daemon). This browser has none. */
  async function models(opts = {}) {
    const view = window.scribeAudio.settings() || await window.scribeAudio.refresh().catch(() => null);
    const id = typeof opts.source === "string" && opts.source ? opts.source : view?.tts?.source;
    if (!id) return failure("no_source", "Choose a text-to-speech source in Settings → Audio.");
    if (id === "__browser__") return { ok: true, source: id, models: [] };
    try {
      const res = await fetch("/api/audio/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "tts", id }) });
      const result = await res.json();
      return result.ok ? { ok: true, source: id, models: result.models } : result;
    } catch { return failure("network", "Cannot reach text-to-speech."); }
  }

  /** One model with its Markdown guide (GET …/models/{id}); no model: the source's saved one, else the server's default. */
  async function model(opts = {}) {
    const view = window.scribeAudio.settings() || await window.scribeAudio.refresh().catch(() => null);
    const id = typeof opts.source === "string" && opts.source ? opts.source : view?.tts?.source;
    if (!id) return failure("no_source", "Choose a text-to-speech source in Settings → Audio.");
    if (id === "__browser__") return failure("no_model", "This browser has no models.");
    try {
      const res = await fetch("/api/audio/model-info", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "tts", id, ...(typeof opts.model === "string" ? { model: opts.model } : {}) }) });
      return await res.json();
    } catch { return failure("network", "Cannot reach text-to-speech."); }
  }

  Object.assign(window.scribeAudio, { speak, voices, speechSources: sources, models, model, voiceName, splitSpeech, stopSpeech: () => current?.stop() });
  window.addEventListener("pagehide", () => current?.stop());
})();
