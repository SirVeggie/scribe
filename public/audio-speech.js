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

  let current = null;
  const once = (target, name) => new Promise(resolve => target.addEventListener(name, resolve, { once: true }));

  /** Plays one /api/audio/speech response; with MediaSource it starts before the download ends. */
  async function playResponse(res, el, signal) {
    const type = (res.headers.get("content-type") || "audio/mpeg").split(";")[0];
    let url;
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

  async function speakSource(pieces, opts, signal) {
    const el = new Audio();
    el.preload = "auto";
    // The mixer's speech channel (#564), so the master volume applies.
    const unroute = await Promise.resolve(window.scribeAudio.route?.(el, "speech")).catch(() => null);
    try { return await playPieces(pieces, opts, signal, el); } finally { unroute?.(); }
  }
  async function playPieces(pieces, opts, signal, el) {
    let next = fetchPiece(pieces[0], opts, signal);
    for (let i = 0; i < pieces.length; i++) {
      const got = await next;
      if (signal.aborted || got.stopped) return { ok: true, reason: "stopped" };
      if (!got.ok) return got;
      // The next piece downloads while this one plays.
      next = i + 1 < pieces.length ? fetchPiece(pieces[i + 1], opts, signal) : null;
      opts.onState?.({ state: "speaking", piece: i, pieces: pieces.length });
      const played = await playResponse(got.res, el, signal);
      if (!played.ok || played.reason === "stopped") {
        void next?.then(rest => rest.res?.body?.cancel().catch(() => {}));
        return played;
      }
    }
    return { ok: true, reason: "ended" };
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

  async function speakBrowser(text, opts, signal) {
    const synth = window.speechSynthesis;
    if (!synth || !window.SpeechSynthesisUtterance) return failure("no_source", "This browser cannot read text aloud.");
    const voice = opts.voice ? (await browserVoices()).find(v => v.name === opts.voice || v.voiceURI === opts.voice) : undefined;
    const pieces = splitSpeech(text, BROWSER_CHARS);
    for (let i = 0; i < pieces.length; i++) {
      if (signal.aborted) return { ok: true, reason: "stopped" };
      const utterance = new SpeechSynthesisUtterance(pieces[i]);
      if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
      utterance.rate = Math.min(4, Math.max(0.25, Number(opts.speed) || 1));
      opts.onState?.({ state: "speaking", piece: i, pieces: pieces.length });
      const result = await new Promise(resolve => {
        utterance.onend = () => resolve("ended");
        utterance.onerror = event => resolve(event.error === "interrupted" || event.error === "canceled" ? "stopped" : "error");
        signal.addEventListener("abort", () => resolve("stopped"), { once: true });
        synth.speak(utterance);
      });
      if (result === "stopped") return { ok: true, reason: "stopped" };
      if (result === "error") return failure("engine", "This browser could not read the text aloud.");
    }
    return { ok: true, reason: "ended" };
  }

  /**
   * Reads text aloud through the text-to-speech source in Settings → Audio, on the speech channel:
   * one speech at a time, so a new one stops the one before. Returns { stop(), ended } at once;
   * ended resolves to { ok: true, reason: "ended" | "stopped" } or a failure { ok: false, error, message }.
   */
  function speak(text, opts = {}) {
    current?.stop();
    const controller = new AbortController();
    const session = { stop() { controller.abort(); window.speechSynthesis?.cancel(); return session.ended; } };
    current = session;
    session.ended = (async () => {
      const view = window.scribeAudio.settings() || await window.scribeAudio.refresh().catch(() => null);
      // sourceId: Settings tests one source before it is chosen.
      const mode = opts.mode || (opts.sourceId ? (opts.sourceId === "__browser__" ? "browser" : "source") : view?.speech);
      const settings = view?.tts || {};
      const merged = { ...opts, voice: opts.voice ?? settings.voice, speed: opts.speed ?? settings.speed };
      if (!String(text ?? "").trim()) return failure("invalid_audio", "Give the text to read aloud.");
      if (mode === "browser") return speakBrowser(text, merged, controller.signal);
      if (mode !== "source") return failure("no_source", "Choose a text-to-speech source in Settings → Audio.");
      const pieces = splitSpeech(text, MAX_CHARS, FIRST_CHARS);
      if (!pieces.length) return failure("invalid_audio", "Give the text to read aloud.");
      // The daemon fills in the saved voice and speed.
      return speakSource(pieces, opts, controller.signal);
    })().catch(() => failure("engine", "Text-to-speech is unavailable.")).finally(() => { if (current === session) current = null; });
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
