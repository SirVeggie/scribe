import type { OpenAISource } from "../agent/openaiSources.js";
import { randomUUID } from "node:crypto";
import { openAiEngine } from "./engine.js";
import { fileStore, normalizeSettings, type AudioStore } from "./settings.js";
import type { AudioResult, SttEngine, SttSource, AudioSettings } from "./types.js";

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export class AudioService {
  private store: AudioStore;
  private engine: SttEngine;
  private sources: () => OpenAISource[];
  private timeoutMs: number;
  constructor(options: { sources: () => OpenAISource[]; store?: AudioStore; engine?: SttEngine; timeoutMs?: number }) {
    this.store = options.store ?? fileStore(); this.engine = options.engine ?? openAiEngine;
    this.sources = options.sources; this.timeoutMs = options.timeoutMs ?? 60_000;
  }
  view() {
    const settings = this.store.read();
    const { custom, ...stt } = settings.stt;
    const sources = this.sources().map(({ id, name }) => ({ id, name }));
    const profiles = this.profiles(settings).map(({ custom, ...profile }) => ({ ...profile,
      ...(custom ? { custom: { baseUrl: custom.baseUrl, hasKey: Boolean(custom.apiKey) } } : {}) }));
    return { stt: { ...stt, ...(custom ? { custom: { baseUrl: custom.baseUrl, hasKey: Boolean(custom.apiKey) } } : {}) },
      input: settings.input, profiles, defaultSource: settings.defaultSource || (settings.stt.source ? "__legacy__" : undefined),
      sources, available: Boolean(this.source(this.selected(settings))), usage: this.usage() };
  }
  private profiles(settings: AudioSettings): SttSource[] {
    return [...(settings.stt.source ? [{ ...settings.stt, id: "__legacy__", name: "Speech-to-text" }] : []), ...settings.sources];
  }
  private selected(settings: AudioSettings) {
    return settings.defaultSource ? this.profiles(settings).find(s => s.id === settings.defaultSource) ?? { model: "whisper-1" } : settings.stt;
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
    settings.stt = { model: "whisper-1" };
    this.store.write(settings); return this.view();
  }
  private source(stt: ReturnType<AudioStore["read"]>["stt"]): OpenAISource | undefined {
    if (stt.source !== "__custom__") return this.sources().find(s => s.id === stt.source);
    if (!stt.custom?.baseUrl) return undefined;
    return { id: "custom", name: "Custom", ...stt.custom, models: [] };
  }
  update(value: unknown) {
    const body = value as { stt?: { custom?: { baseUrl?: string; apiKey?: string } }; input?: object } | null;
    const old = this.store.read();
    const next = normalizeSettings({ stt: { ...old.stt, ...body?.stt,
      ...(body?.stt?.custom ? { custom: { ...old.stt.custom, ...body.stt.custom } } : {}) }, input: { ...old.input, ...body?.input },
      sources: old.sources, defaultSource: (body as Partial<AudioSettings>)?.defaultSource ?? old.defaultSource });
    if (next.defaultSource && !this.profiles(next).some(s => s.id === next.defaultSource)) throw new Error("Choose an existing speech-to-text source.");
    if (next.stt.custom?.baseUrl) {
      let url: URL;
      try { url = new URL(next.stt.custom.baseUrl); } catch { throw new Error("Enter a full speech-to-text URL."); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP or HTTPS URL without credentials.");
      next.stt.custom.baseUrl = url.toString().replace(/\/+$/, "");
    }
    if (next.stt.source && next.stt.source !== "__custom__" && !this.sources().some(s => s.id === next.stt.source)) throw new Error("Choose an existing OpenAI source.");
    this.store.write(next); return this.view();
  }
  usage() {
    const day = new Date().toISOString().slice(0, 10), saved = this.store.readUsage();
    return saved?.day === day ? saved : { day, calls: 0, failed: 0, bytes: 0 };
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
      const usage = this.usage(); usage.calls++; usage.bytes += audio.size; if (!result.ok) usage.failed++;
      this.store.writeUsage(usage);
      return result;
    } catch { return { ok: false, error: "engine", message: "Speech-to-text is unavailable." }; }
  }
}
