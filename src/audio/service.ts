import type { OpenAISource } from "../agent/openaiSources.js";
import { randomUUID } from "node:crypto";
import { MAX_SPEECH_CHARS, openAiEngine, openAiTts } from "./engine.js";
import { fileStore, normalizeSettings, normalizeTts, type AudioStore } from "./settings.js";
import { BROWSER_SPEECH, type AudioResult, type SttEngine, type SttSource, type AudioSettings, type AudioOutput, type TtsEngine, type TtsFailure, type TtsResult } from "./types.js";
import type { StreamTarget } from "./stream.js";

const wavKey = (source: OpenAISource, model: string) => `${source.baseUrl} ${model}`;
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
  constructor(options: { sources: () => OpenAISource[]; store?: AudioStore; engine?: SttEngine; tts?: TtsEngine; timeoutMs?: number; onOutput?: (output: AudioOutput) => void }) {
    this.store = options.store ?? fileStore(); this.engine = options.engine ?? openAiEngine; this.tts = options.tts ?? openAiTts; this.onOutput = options.onOutput;
    this.sources = options.sources; this.timeoutMs = options.timeoutMs ?? 60_000;
  }
  view() {
    const settings = this.store.read(), selected = this.selected(settings), source = this.source(selected);
    const { custom, ...stt } = settings.stt;
    const sources = this.sources().map(({ id, name, baseUrl }) => ({ id, name, baseUrl }));
    const profiles = this.profiles(settings).map(({ custom, ...profile }) => ({ ...profile,
      ...(custom ? { custom: { baseUrl: custom.baseUrl, hasKey: Boolean(custom.apiKey) } } : {}) }));
    return { stt: { ...stt, ...(custom ? { custom: { baseUrl: custom.baseUrl, hasKey: Boolean(custom.apiKey) } } : {}) },
      input: settings.input, output: settings.output, profiles, defaultSource: settings.defaultSource || (settings.stt.source ? "__legacy__" : undefined),
      sources, available: Boolean(source), tts: settings.tts, speech: this.speechMode(settings), streaming: source ? (selected as Partial<SttSource>).streaming : undefined, wav: Boolean(source && this.wavOnly.has(wavKey(source, selected.model))), usage: this.usage() };
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
    const profile = this.profiles(settings).find(s => s.id === settings.tts.source);
    return profile?.speechModel && this.source(profile) ? "source" : undefined;
  }
  saveSource(value: unknown, id?: string) {
    const settings = this.store.read(), profiles = this.profiles(settings);
    const old = id ? profiles.find(s => s.id === id) : undefined;
    if (id && !old) throw new Error("Speech-to-text source not found.");
    const body = value as Partial<SttSource>;
    const profile = normalizeSettings({ sources: [{ ...old, ...body, id: id || randomUUID(),
      custom: body?.custom ? { ...old?.custom, ...body.custom } : old?.custom }] }).sources[0];
    if (!profile.name) throw new Error("Enter a source name.");
    if (profile.source === "__custom__") {
      let url: URL;
      try { url = new URL(profile.custom?.baseUrl || ""); } catch { throw new Error("Enter a full speech-to-text URL."); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP or HTTPS URL without credentials.");
      profile.custom!.baseUrl = url.toString().replace(/\/+$/, "");
      // A saved credential belongs to its original host.
      if (old?.custom?.baseUrl && new URL(old.custom.baseUrl).origin !== url.origin && !Object.hasOwn(body.custom || {}, "apiKey")) profile.custom!.apiKey = "";
    } else {
      if (!this.sources().some(s => s.id === profile.source)) throw new Error("Choose an existing OpenAI source.");
      delete profile.custom;
    }
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
    if (settings.tts.source === id) delete settings.tts.source;
    settings.stt = { model: "whisper-1" };
    this.store.write(settings); return this.view();
  }
  private source(stt: ReturnType<AudioStore["read"]>["stt"]): OpenAISource | undefined {
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
      tts: { ...old.tts, ...(body as Partial<AudioSettings>)?.tts } });
    if (next.tts.source && next.tts.source !== BROWSER_SPEECH && !this.profiles(next).some(s => s.id === next.tts.source && s.speechModel))
      throw new Error("Choose a source with a text-to-speech model.");
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
  /** Where a live recording goes (#832): the default source's own stream, or a sliding window over its upload endpoint. */
  streamTarget(): StreamTarget | AudioResult {
    const settings = this.store.read(), selected = this.selected(settings) as SttSource, source = this.source(selected);
    if (!source) return { ok: false, error: "no_source", message: "Choose a speech-to-text source in Settings → Audio." };
    if (selected.streaming === "native") return { mode: "native", source };
    if (selected.streaming === "window") return { mode: "window", transcribe: wav => this.transcribe(wav, { sourceId: selected.id }) };
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
  async speak(text: unknown, options: { voice?: unknown; speed?: unknown; sourceId?: string; signal?: AbortSignal } = {}): Promise<TtsResult> {
    const fail = (error: TtsFailure["error"], message: string): TtsFailure => ({ ok: false, error, message });
    try {
      if (typeof text !== "string" || !text.trim()) return fail("invalid_audio", "Give the text to read aloud.");
      if (text.length > MAX_SPEECH_CHARS) return fail("too_large", `Text to read aloud must be at most ${MAX_SPEECH_CHARS} characters per request.`);
      const settings = this.store.read();
      const id = options.sourceId ?? settings.tts.source;
      if (id === BROWSER_SPEECH) return fail("no_source", "This browser reads text aloud in the board, not through Scribe.");
      const profile = this.profiles(settings).find(s => s.id === id), source = profile?.speechModel ? this.source(profile) : undefined;
      if (!profile || !source) return fail("no_source", "Choose a text-to-speech source in Settings → Audio.");
      const tts = normalizeTts({ voice: options.voice ?? settings.tts.voice, speed: options.speed ?? settings.tts.speed });
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
          const result = await this.tts.speak({ source, model: profile.speechModel!, text, voice: tts.voice || "alloy", speed: tts.speed ?? 1, signal: controller.signal });
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
