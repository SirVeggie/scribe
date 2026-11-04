import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../config.js";
import { AUDIO_CUES, type AudioSettings, type AudioDayUsage, type AudioOutput, type TtsSettings } from "./types.js";

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
    ...(str(s.speechModel, 200) ? { speechModel: str(s.speechModel, 200) } : {}),
    ...(s.custom ? { custom: { baseUrl: str(s.custom.baseUrl, 2000), apiKey: str(s.custom.apiKey, 4000) } } : {}),
  })) : [], defaultSource: str(body?.defaultSource, 100) || undefined,
    stt: { ...(source ? { source } : {}), model: str(body?.stt?.model, 200) || "whisper-1", ...(language ? { language } : {}),
    ...(custom ? { custom: { baseUrl: str(custom.baseUrl, 2000), apiKey: str(custom.apiKey, 4000) } } : {}) },
    tts: normalizeTts(body?.tts),
    input: { sendAfterDictation: body?.input?.sendAfterDictation === true, pushToTalk: body?.input?.pushToTalk !== false,
      livePreview: body?.input?.livePreview !== false }, output: normalizeOutput(body?.output) };
}
/** Speed as the OpenAI endpoint takes it: 0.25 to 4, 1 is normal. */
export function normalizeTts(value: unknown): TtsSettings {
  const body = value as Partial<TtsSettings> | null | undefined;
  const source = typeof body?.source === "string" ? body.source.trim().slice(0, 100) : "";
  const voice = typeof body?.voice === "string" ? body.voice.trim().slice(0, 200) : "";
  const speed = typeof body?.speed === "number" && Number.isFinite(body.speed) ? Math.min(4, Math.max(0.25, Math.round(body.speed * 100) / 100)) : 1;
  return { ...(source ? { source } : {}), ...(voice ? { voice } : {}), ...(speed !== 1 ? { speed } : {}) };
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
