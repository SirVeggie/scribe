import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../config.js";
import { AUDIO_CUES, type AudioSettings, type AudioDayUsage, type AudioOutput, type TtsSettings, type TtsSource } from "./types.js";

export function normalizeOutput(value: unknown): AudioOutput {
  const body = value as Partial<AudioOutput> | null;
  const volume = Number(body?.volume);
  return { sounds: body?.sounds === true, volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.6,
    cues: Object.fromEntries(AUDIO_CUES.map(cue => [cue, body?.cues?.[cue] !== false])) as AudioOutput["cues"] };
}

export function normalizeSettings(value: unknown): AudioSettings {
  const body = value as Partial<AudioSettings> | null;
  const str = (v: unknown, max: number) => typeof v === "string" ? v.trim().slice(0, max) : "";
  const source = str(body?.stt?.source, 100), language = str(body?.stt?.language, 20);
  const custom = body?.stt?.custom;
  return { sources: Array.isArray(body?.sources) ? body.sources.map(s => ({
    id: str(s.id, 100), name: str(s.name, 200), source: str(s.source, 100),
    model: str(s.model, 200) || "whisper-1", language: str(s.language, 20),
    ...(s.streaming === "native" || s.streaming === "window" ? { streaming: s.streaming } : {}),
    ...(s.custom ? { custom: { baseUrl: str(s.custom.baseUrl, 2000), apiKey: str(s.custom.apiKey, 4000) } } : {}),
  })) : [], defaultSource: str(body?.defaultSource, 100) || undefined,
    stt: { ...(source ? { source } : {}), model: str(body?.stt?.model, 200) || "whisper-1", ...(language ? { language } : {}),
    ...(custom ? { custom: { baseUrl: str(custom.baseUrl, 2000), apiKey: str(custom.apiKey, 4000) } } : {}) },
    ...speechSources(body),
    input: { sendAfterDictation: body?.input?.sendAfterDictation === true, pushToTalk: body?.input?.pushToTalk !== false,
      livePreview: body?.input?.livePreview !== false }, output: normalizeOutput(body?.output) };
}
/** Speed as the OpenAI endpoint takes it: 0.25 to 4, 1 is normal (left out). */
export function normalizeSpeed(value: unknown): number | undefined {
  const speed = typeof value === "number" && Number.isFinite(value) ? Math.min(4, Math.max(0.25, Math.round(value * 100) / 100)) : 1;
  return speed === 1 ? undefined : speed;
}
export function normalizeTts(value: unknown): TtsSettings {
  const body = value as Partial<TtsSettings> | null | undefined;
  const source = typeof body?.source === "string" ? body.source.trim().slice(0, 100) : "";
  const voice = typeof body?.voice === "string" ? body.voice.trim().slice(0, 200) : "";
  const speed = normalizeSpeed(body?.speed);
  return { ...(source ? { source } : {}), ...(voice ? { voice } : {}), ...(speed ? { speed } : {}) };
}
export function normalizeTtsSource(value: unknown): TtsSource {
  const s = value as Partial<TtsSource> | null;
  const str = (v: unknown, max: number) => typeof v === "string" ? v.trim().slice(0, max) : "";
  const model = str(s?.model, 200), voice = str(s?.voice, 200), speed = normalizeSpeed(s?.speed);
  return { id: str(s?.id, 100), name: str(s?.name, 200), source: str(s?.source, 100),
    ...(model ? { model } : {}), ...(voice ? { voice } : {}), ...(speed ? { speed } : {}), ...(s?.stream === true ? { stream: true } : {}),
    ...(s?.custom ? { custom: { baseUrl: str(s.custom.baseUrl, 2000), apiKey: str(s.custom.apiKey, 4000) } } : {}) };
}
/**
 * Text-to-speech sources and the choice between them. The first build kept a speech model on
 * speech-to-text sources (speechModel); those become their own text-to-speech sources here, with
 * the same id, so the saved choice keeps pointing at them.
 */
function speechSources(body: Partial<AudioSettings> | null): Pick<AudioSettings, "ttsSources" | "tts"> {
  let tts = normalizeTts(body?.tts);
  if (Array.isArray(body?.ttsSources)) return { ttsSources: body.ttsSources.map(normalizeTtsSource), tts };
  const early = (Array.isArray(body?.sources) ? body.sources : []).filter(s => typeof s?.speechModel === "string" && s.speechModel.trim());
  const ttsSources = early.map(s => normalizeTtsSource({ id: s.id, name: s.name, source: s.source, model: s.speechModel, custom: s.custom,
    ...(s.id === tts.source ? { voice: tts.voice, speed: tts.speed } : {}) }));
  if (ttsSources.some(s => s.id === tts.source)) tts = { source: tts.source };
  return { ttsSources, tts };
}
export interface AudioStore {
  read(): AudioSettings;
  write(value: AudioSettings): void;
  readUsage(): AudioDayUsage | null;
  writeUsage(value: AudioDayUsage): void;
}
export function fileStore(root: () => string = dataDir): AudioStore {
  const read = (name: string) => { try { return JSON.parse(fs.readFileSync(path.join(root(), name), "utf8")); } catch { return null; } };
  const write = (name: string, value: unknown) => {
    fs.mkdirSync(root(), { recursive: true });
    const file = path.join(root(), name);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  };
  return { read: () => normalizeSettings(read("audio-settings.json")), write: v => write("audio-settings.json", v),
    readUsage: () => read("audio-usage.json"), writeUsage: v => write("audio-usage.json", v) };
}
export function memoryStore(initial?: unknown): AudioStore {
  let settings = normalizeSettings(initial), usage: AudioDayUsage | null = null;
  return { read: () => structuredClone(settings), write: v => { settings = structuredClone(v); },
    readUsage: () => usage && { ...usage }, writeUsage: v => { usage = { ...v }; } };
}
