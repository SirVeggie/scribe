import type { OpenAISource } from "../agent/openaiSources.js";
import { randomUUID } from "node:crypto";
import { MAX_SPEECH_CHARS, OPENAI_VOICES, listModels, modelInfo, openAiEngine, openAiTts, type AudioModel, type AudioModels } from "./engine.js";
import { fileStore, normalizeSettings, normalizeSpeed, normalizeTtsSource, type AudioStore } from "./settings.js";
import { BROWSER_SPEECH, type AudioResult, type SttEngine, type SttSource, type AudioSettings, type AudioOutput, type TtsEngine, type TtsFailure, type TtsResult, type TtsSource, type TtsVoices } from "./types.js";
import type { StreamTarget } from "./stream.js";

const wavKey = (source: OpenAISource, model: string) => `${source.baseUrl} ${model}`;
type Endpoint = { source?: string; custom?: { baseUrl: string; apiKey?: string } };
const keyView = <T extends Endpoint>({ custom, ...rest }: T) => ({ ...rest, ...(custom ? { custom: { baseUrl: custom.baseUrl, hasKey: Boolean(custom.apiKey) } } : {}) });
/** Voice lists are cached: asking a server for one can load that model (several seconds). */
const VOICES_TTL_MS = 10 * 60_000;
/** Listing models loads nothing, so the list can be fresher. */
const MODELS_TTL_MS = 60_000;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export class AudioService {
  private store: AudioStore;
  private engine: SttEngine;
  private tts: TtsEngine;
  private sources: () => OpenAISource[];
  private timeoutMs: number;
  /** Sources that rejected compressed audio this run; the shell sends them WAV. Not saved, so a fixed server is found again after a restart. */
  private wavOnly = new Set<string>();
  /** Open windows get sound settings over /ws, so a change in one applies in all. */
  private onOutput?: (output: AudioOutput) => void;
  private voiceCache = new Map<string, { at: number; result: TtsVoices }>();
  private modelCache = new Map<string, { at: number; result: AudioModels }>();
  private listModels: typeof listModels;
  private modelInfo: typeof modelInfo;
  private guideCache = new Map<string, { at: number; result: { ok: true; model: AudioModel } }>();
  constructor(options: { sources: () => OpenAISource[]; store?: AudioStore; engine?: SttEngine; tts?: TtsEngine; timeoutMs?: number; onOutput?: (output: AudioOutput) => void; listModels?: typeof listModels; modelInfo?: typeof modelInfo }) {
    this.listModels = options.listModels ?? listModels; this.modelInfo = options.modelInfo ?? modelInfo;
    this.store = options.store ?? fileStore(); this.engine = options.engine ?? openAiEngine; this.tts = options.tts ?? openAiTts; this.onOutput = options.onOutput;
    this.sources = options.sources; this.timeoutMs = options.timeoutMs ?? 60_000;
  }
  view() {
    const settings = this.store.read(), selected = this.selected(settings), source = this.source(selected);
    const { custom, ...stt } = settings.stt;
    const sources = this.sources().map(({ id, name, baseUrl }) => ({ id, name, baseUrl }));
    const profiles = this.profiles(settings).map(keyView);
    return { stt: { ...stt, ...(custom ? { custom: { baseUrl: custom.baseUrl, hasKey: Boolean(custom.apiKey) } } : {}) },
      input: settings.input, output: settings.output, profiles, defaultSource: settings.defaultSource || (settings.stt.source ? "__legacy__" : undefined),
      sources, available: Boolean(source), tts: settings.tts, ttsSources: settings.ttsSources.map(keyView), speech: this.speechMode(settings), streaming: source ? (selected as Partial<SttSource>).streaming : undefined, wav: Boolean(source && this.wavOnly.has(wavKey(source, selected.model))), usage: this.usage() };
  }
  private profiles(settings: AudioSettings): SttSource[] {
    return [...(settings.stt.source ? [{ ...settings.stt, id: "__legacy__", name: "Speech-to-text" }] : []), ...settings.sources];
  }
  private selected(settings: AudioSettings) {
    return settings.defaultSource ? this.profiles(settings).find(s => s.id === settings.defaultSource) ?? { model: "whisper-1" } : settings.stt;
  }
  /** How text is read aloud now: by the daemon's source, by the shell's speechSynthesis, or not at all. */
  private speechMode(settings: AudioSettings): "source" | "browser" | undefined {
    if (settings.tts.source === BROWSER_SPEECH) return "browser";
    const profile = settings.ttsSources.find(s => s.id === settings.tts.source);
    return profile && this.source(profile) ? "source" : undefined;
  }
  /** Checks a linked source or a custom URL in place; old is the saved copy whose key it may keep. */
  private checkEndpoint(profile: Endpoint, old: Endpoint | undefined, body: Endpoint) {
    if (profile.source === "__custom__") {
      let url: URL;
      try { url = new URL(profile.custom?.baseUrl || ""); } catch { throw new Error("Enter a full URL, e.g. https://api.openai.com/v1."); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP or HTTPS URL without credentials.");
      profile.custom!.baseUrl = url.toString().replace(/\/+$/, "");
      // A saved credential belongs to its original host.
      if (old?.custom?.baseUrl && new URL(old.custom.baseUrl).origin !== url.origin && !Object.hasOwn(body.custom || {}, "apiKey")) profile.custom!.apiKey = "";
    } else {
      if (!this.sources().some(s => s.id === profile.source)) throw new Error("Choose an existing OpenAI source.");
      delete profile.custom;
    }
  }
  saveTtsSource(value: unknown, id?: string) {
    const settings = this.store.read(), old = id ? settings.ttsSources.find(s => s.id === id) : undefined;
    if (id && !old) throw new Error("Text-to-speech source not found.");
    const body = (value ?? {}) as Partial<TtsSource>;
    const profile = normalizeTtsSource({ ...old, ...body, id: id || randomUUID(), custom: body.custom ? { ...old?.custom, ...body.custom } : old?.custom });
    if (!profile.name) throw new Error("Enter a source name.");
    this.checkEndpoint(profile, old, body);
    settings.ttsSources = old ? settings.ttsSources.map(s => s.id === profile.id ? profile : s) : [...settings.ttsSources, profile];
    // The first source a user adds is the one pages use, unless they chose This browser.
    settings.tts.source ||= profile.id;
    this.store.write(settings); return this.view();
  }
  removeTtsSource(id: string) {
    const settings = this.store.read();
    if (!settings.ttsSources.some(s => s.id === id)) throw new Error("Text-to-speech source not found.");
    settings.ttsSources = settings.ttsSources.filter(s => s.id !== id);
    if (settings.tts.source === id) settings.tts.source = settings.ttsSources[0]?.id;
    if (!settings.tts.source) delete settings.tts.source;
    this.store.write(settings); return this.view();
  }
  saveSource(value: unknown, id?: string) {
    const settings = this.store.read(), profiles = this.profiles(settings);
    const old = id ? profiles.find(s => s.id === id) : undefined;
    if (id && !old) throw new Error("Speech-to-text source not found.");
    const body = value as Partial<SttSource>;
    const profile = normalizeSettings({ sources: [{ ...old, ...body, id: id || randomUUID(),
      custom: body?.custom ? { ...old?.custom, ...body.custom } : old?.custom }] }).sources[0];
    if (!profile.name) throw new Error("Enter a source name.");
    this.checkEndpoint(profile, old, body);
    settings.sources = old ? profiles.map(s => s.id === profile.id ? profile : s) : [...profiles, profile];
    settings.defaultSource ||= settings.stt.source ? "__legacy__" : profile.id;
    settings.stt = { model: "whisper-1" };
    this.store.write(settings); return this.view();
  }
  removeSource(id: string) {
    const settings = this.store.read(), profiles = this.profiles(settings);
    if (!profiles.some(s => s.id === id)) throw new Error("Speech-to-text source not found.");
    settings.sources = profiles.filter(s => s.id !== id);
    const selected = settings.defaultSource || (settings.stt.source ? "__legacy__" : undefined);
    settings.defaultSource = selected === id ? settings.sources[0]?.id : selected;
    settings.stt = { model: "whisper-1" };
    this.store.write(settings); return this.view();
  }
  private source(stt: Endpoint): OpenAISource | undefined {
    if (stt.source !== "__custom__") return this.sources().find(s => s.id === stt.source);
    if (!stt.custom?.baseUrl) return undefined;
    return { id: "custom", name: "Custom", ...stt.custom, models: [] };
  }
  update(value: unknown) {
    const body = value as { stt?: { custom?: { baseUrl?: string; apiKey?: string } }; input?: object; output?: Partial<AudioOutput> } | null;
    const old = this.store.read();
    const next = normalizeSettings({ stt: { ...old.stt, ...body?.stt,
      ...(body?.stt?.custom ? { custom: { ...old.stt.custom, ...body.stt.custom } } : {}) }, input: { ...old.input, ...body?.input },
      output: { ...old.output, ...body?.output, cues: { ...old.output.cues, ...body?.output?.cues } },
      sources: old.sources, defaultSource: (body as Partial<AudioSettings>)?.defaultSource ?? old.defaultSource,
      ttsSources: old.ttsSources, tts: { ...old.tts, ...(body as Partial<AudioSettings>)?.tts } });
    if (next.tts.source && next.tts.source !== BROWSER_SPEECH && !next.ttsSources.some(s => s.id === next.tts.source))
      throw new Error("Choose an existing text-to-speech source.");
    if (next.defaultSource && !this.profiles(next).some(s => s.id === next.defaultSource)) throw new Error("Choose an existing speech-to-text source.");
    if (next.stt.custom?.baseUrl) {
      let url: URL;
      try { url = new URL(next.stt.custom.baseUrl); } catch { throw new Error("Enter a full speech-to-text URL."); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP or HTTPS URL without credentials.");
      next.stt.custom.baseUrl = url.toString().replace(/\/+$/, "");
    }
    if (next.stt.source && next.stt.source !== "__custom__" && !this.sources().some(s => s.id === next.stt.source)) throw new Error("Choose an existing OpenAI source.");
    this.store.write(next);
    if (body?.output) this.onOutput?.(next.output);
    return this.view();
  }
  /**
   * Where a live recording goes (#832): the default source's own stream, or a sliding window over its upload endpoint.
   * force (a page's listen({ live: true }), #1002) streams with live transcription off too: any upload endpoint takes the window.
   */
  streamTarget(force = false): StreamTarget | AudioResult {
    const settings = this.store.read(), selected = this.selected(settings) as SttSource, source = this.source(selected);
    if (!source) return { ok: false, error: "no_source", message: "Choose a speech-to-text source in Settings → Audio." };
    if (selected.streaming === "native") return { mode: "native", source };
    if (selected.streaming === "window" || force) return { mode: "window", transcribe: wav => this.transcribe(wav, { sourceId: selected.id }) };
    return { ok: false, error: "engine", message: "Live transcription is off for this source." };
  }
  recordUsage(bytes: number, ok: boolean) {
    const usage = this.usage(); usage.calls++; usage.bytes += bytes; if (!ok) usage.failed++;
    this.store.writeUsage(usage);
  }
  usage() {
    const day = new Date().toISOString().slice(0, 10), saved = this.store.readUsage();
    return saved?.day === day ? { speechCalls: 0, speechFailed: 0, chars: 0, ...saved } : { day, calls: 0, failed: 0, bytes: 0, speechCalls: 0, speechFailed: 0, chars: 0 };
  }
  private recordSpeech(chars: number, ok: boolean) {
    const usage = this.usage(); usage.speechCalls++; usage.chars += chars; if (!ok) usage.speechFailed++;
    this.store.writeUsage(usage);
  }
  /**
   * Text to an audio stream through the text-to-speech source (Phase D). One request takes at most
   * MAX_SPEECH_CHARS; the shell splits longer text. The timeout covers the wait for the response;
   * signal (the client going away) aborts the request and the stream.
   */
  async speak(text: unknown, options: { voice?: unknown; speed?: unknown; model?: unknown; sourceId?: string; signal?: AbortSignal } = {}): Promise<TtsResult> {
    const fail = (error: TtsFailure["error"], message: string): TtsFailure => ({ ok: false, error, message });
    try {
      if (typeof text !== "string" || !text.trim()) return fail("invalid_audio", "Give the text to read aloud.");
      if (text.length > MAX_SPEECH_CHARS) return fail("too_large", `Text to read aloud must be at most ${MAX_SPEECH_CHARS} characters per request.`);
      const settings = this.store.read();
      const id = options.sourceId ?? settings.tts.source;
      if (id === BROWSER_SPEECH) return fail("no_source", "This browser reads text aloud in the board, not through Scribe.");
      const profile = settings.ttsSources.find(s => s.id === id), source = profile && this.source(profile);
      if (!profile || !source) return fail("no_source", "Choose a text-to-speech source in Settings → Audio.");
      const voice = (typeof options.voice === "string" && options.voice.trim().slice(0, 200)) || profile.voice || "alloy";
      const speed = options.speed === undefined ? profile.speed ?? 1 : normalizeSpeed(options.speed) ?? 1;
      // A model given by the caller wins; "" asks for the server's loaded model.
      const model = typeof options.model === "string" ? options.model.trim().slice(0, 200) || undefined : profile.model;
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (options.signal?.aborted) return fail("network", "Reading aloud was stopped.");
      options.signal?.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
      const timeout = new Promise<TtsResult>(resolve => { timer = setTimeout(() => {
        timedOut = true; controller.abort(); resolve(fail("timeout", "Text-to-speech timed out."));
      }, this.timeoutMs); });
      const run = async (): Promise<TtsResult> => {
        for (let attempt = 0; ; attempt++) {
          const result = await this.tts.speak({ source, model, text, voice, speed, stream: profile.stream, signal: controller.signal });
          if (attempt || result.ok || controller.signal.aborted || !(result.error === "rate_limit" || result.retryable)) return result;
          await new Promise(resolve => setTimeout(resolve, 300));
          if (controller.signal.aborted) return fail("timeout", "Text-to-speech timed out.");
        }
      };
      let result: TtsResult;
      try { result = await Promise.race([run(), timeout]); }
      catch { result = timedOut ? fail("timeout", "Text-to-speech timed out.")
        : controller.signal.aborted ? fail("network", "Reading aloud was stopped.") : fail("network", "Cannot reach the text-to-speech source."); }
      finally { clearTimeout(timer); }
      if (!result.ok) options.signal?.removeEventListener("abort", abort);
      this.recordSpeech(text.length, result.ok);
      return result;
    } catch { return fail("engine", "Text-to-speech is unavailable."); }
  }
  /**
   * Voices for a text-to-speech source: the saved one by id, the chosen one, or a draft from the
   * editor (which may reuse the saved key of the source it edits). Cached per URL and model.
   */
  async voices(draft: unknown = {}): Promise<TtsVoices | TtsFailure> {
    const fail = (error: TtsFailure["error"], message: string): TtsFailure => ({ ok: false, error, message });
    const body = (draft ?? {}) as Partial<TtsSource> & { id?: string };
    const found = this.draftEndpoint(body, "tts");
    if (!found.ok) return fail("no_source", found.message);
    const { source } = found;
    // The section's model picker asks before saving: its model wins over the saved one.
    const model = typeof body.model === "string" ? body.model.trim() : (found.profile as TtsSource).model;
    const key = `${source.baseUrl}\n${model ?? ""}\n${source.apiKey ?? ""}`, cached = this.voiceCache.get(key);
    if (cached && Date.now() - cached.at < VOICES_TTL_MS) return cached.result;
    if (!this.tts.voices) return { ok: true, voices: OPENAI_VOICES.map(id => ({ id })), listed: false };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(this.timeoutMs, 30_000));
    try {
      const result = await this.tts.voices({ source, model: model || undefined, signal: controller.signal });
      if (result.ok) this.voiceCache.set(key, { at: Date.now(), result });
      return result;
    } catch { return fail(controller.signal.aborted ? "timeout" : "network", controller.signal.aborted ? "Listing voices timed out." : "Cannot reach the text-to-speech source."); }
    finally { clearTimeout(timer); }
  }
  /**
   * The source a voices or models request is about: a saved one by id (else the chosen one), or the
   * editor's unsaved draft. An empty key field keeps the saved key, but only for the host it was saved for.
   */
  private draftEndpoint(body: Endpoint & { id?: string }, kind: "tts" | "stt"): { ok: true; profile: Endpoint; source: OpenAISource } | { ok: false; message: string } {
    const settings = this.store.read();
    const list: (Endpoint & { id: string })[] = kind === "tts" ? settings.ttsSources : this.profiles(settings);
    const saved = list.find(s => s.id === (body.id || (kind === "tts" ? settings.tts.source : settings.defaultSource)));
    let profile: Endpoint | undefined = saved;
    if (body.source) {
      profile = { source: String(body.source).slice(0, 100),
        ...(body.custom ? { custom: { baseUrl: String(body.custom.baseUrl ?? "").trim().slice(0, 2000), apiKey: body.custom.apiKey || saved?.custom?.apiKey } } : {}) };
      const typed = body.custom?.apiKey ? body : { ...body, custom: body.custom && { baseUrl: body.custom.baseUrl } };
      try { this.checkEndpoint(profile, saved, typed); } catch (err) { return { ok: false, message: (err as Error).message }; }
    }
    const source = profile && this.source(profile);
    return profile && source ? { ok: true, profile, source }
      : { ok: false, message: `Choose a ${kind === "tts" ? "text-to-speech" : "speech-to-text"} source in Settings → Audio.` };
  }
  /**
   * The models a source offers (GET …/models), for the model pickers. Audio servers flag each one
   * (default, loaded, streaming); a plain OpenAI list is cut down to the speech or transcription models.
   */
  async models(draft: unknown = {}): Promise<AudioModels | TtsFailure> {
    const body = (draft ?? {}) as Endpoint & { id?: string; kind?: string };
    const kind = body.kind === "stt" ? "stt" : "tts";
    const found = this.draftEndpoint(body, kind);
    if (!found.ok) return { ok: false, error: "no_source", message: found.message };
    const key = `${kind}\n${found.source.baseUrl}\n${found.source.apiKey ?? ""}`, cached = this.modelCache.get(key);
    if (cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.result;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await this.listModels(found.source, controller.signal);
      if (!result.ok) return result;
      const pattern = kind === "tts" ? /tts|speech|voice|kokoro|piper|chatterbox|xtts|bark/i : /whisper|transcri|stt|asr|moonshine|parakeet|canary|voxtral/i;
      const fitting = result.flagged ? result.models : result.models.filter(m => pattern.test(m.id));
      const out: AudioModels = { ...result, models: fitting.length ? fitting : result.models };
      this.modelCache.set(key, { at: Date.now(), result: out });
      return out;
    } catch { return { ok: false, error: controller.signal.aborted ? "timeout" : "network", message: controller.signal.aborted ? "Listing models timed out." : "Cannot reach the source." }; }
    finally { clearTimeout(timer); }
  }
  /**
   * One model with its guide (GET …/models/{id}): what it supports and how to write text for it.
   * { kind, id (the source), model }; no model means the chosen one, else the server's default.
   */
  async modelGuide(draft: unknown = {}): Promise<{ ok: true; model: AudioModel } | TtsFailure> {
    const body = (draft ?? {}) as Endpoint & { id?: string; kind?: string; model?: unknown };
    const kind = body.kind === "stt" ? "stt" : "tts";
    const found = this.draftEndpoint(body, kind);
    if (!found.ok) return { ok: false, error: "no_source", message: found.message };
    let id = typeof body.model === "string" ? body.model.trim().slice(0, 200) : (found.profile as { model?: string }).model ?? "";
    if (!id) {
      const list = await this.models({ ...body, kind });
      id = list.ok ? list.models.find(m => m.default)?.id ?? "" : "";
      if (!id) return { ok: false, error: "engine", message: "This source names no model to describe." };
    }
    const key = [kind, found.source.baseUrl, found.source.apiKey ?? "", id].join("\n"), cached = this.guideCache.get(key);
    if (cached && Date.now() - cached.at < VOICES_TTL_MS) return cached.result;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await this.modelInfo(found.source, id, controller.signal);
      if (result.ok) this.guideCache.set(key, { at: Date.now(), result });
      return result;
    } catch { return { ok: false, error: controller.signal.aborted ? "timeout" : "network", message: controller.signal.aborted ? "Reading the model timed out." : "Cannot reach the source." }; }
    finally { clearTimeout(timer); }
  }
  async transcribe(audio: Blob, options: { language?: string; prompt?: string; sourceId?: string } = {}): Promise<AudioResult> {
    try {
      if (!audio.size || !audio.type.startsWith("audio/")) return { ok: false, error: "invalid_audio", message: "Record or upload an audio clip." };
      if (audio.size > MAX_AUDIO_BYTES) return { ok: false, error: "too_large", message: "Audio must be under 25 MB." };
      const settings = this.store.read(), selected = options.sourceId ? this.profiles(settings).find(s => s.id === options.sourceId) : this.selected(settings);
      const source = selected && this.source(selected);
      if (!source) return { ok: false, error: "no_source", message: "Choose a speech-to-text source in Settings → Audio." };
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<AudioResult>(resolve => { timer = setTimeout(() => {
        controller.abort(); resolve({ ok: false, error: "timeout", message: "Speech-to-text timed out. Try a shorter recording." });
      }, this.timeoutMs); });
      const run = async (): Promise<AudioResult> => {
        for (let attempt = 0; ; attempt++) {
          const result = await this.engine.transcribe({ source, model: selected!.model, audio,
            language: options.language || selected!.language, prompt: options.prompt, signal: controller.signal });
          if (attempt || result.ok || controller.signal.aborted || !(result.error === "rate_limit" || result.retryable)) return result;
          await new Promise(resolve => setTimeout(resolve, 300));
          if (controller.signal.aborted) return { ok: false, error: "timeout", message: "Speech-to-text timed out." };
        }
      };
      let result: AudioResult;
      try { result = await Promise.race([run(), timeout]); }
      catch { result = { ok: false, error: controller.signal.aborted ? "timeout" : "network", message: controller.signal.aborted ? "Speech-to-text timed out." : "Cannot reach the speech-to-text source." }; }
      finally { clearTimeout(timer); }
      if (!result.ok && result.error === "format") this.wavOnly.add(wavKey(source, selected!.model));
      this.recordUsage(audio.size, result.ok);
      return result;
    } catch { return { ok: false, error: "engine", message: "Speech-to-text is unavailable." }; }
  }
}
