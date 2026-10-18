import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../config.js";
import type { AudioSettings, AudioDayUsage } from "./types.js";

export function normalizeSettings(value: unknown): AudioSettings {
  const body = value as Partial<AudioSettings> | null;
  const str = (v: unknown, max: number) => typeof v === "string" ? v.trim().slice(0, max) : "";
  const source = str(body?.stt?.source, 100), language = str(body?.stt?.language, 20);
  const custom = body?.stt?.custom;
  return { sources: Array.isArray(body?.sources) ? body.sources.map(s => ({
    id: str(s.id, 100), name: str(s.name, 200), source: str(s.source, 100),
    model: str(s.model, 200) || "whisper-1", language: str(s.language, 20),
    ...(s.custom ? { custom: { baseUrl: str(s.custom.baseUrl, 2000), apiKey: str(s.custom.apiKey, 4000) } } : {}),
  })) : [], defaultSource: str(body?.defaultSource, 100) || undefined,
    stt: { ...(source ? { source } : {}), model: str(body?.stt?.model, 200) || "whisper-1", ...(language ? { language } : {}),
    ...(custom ? { custom: { baseUrl: str(custom.baseUrl, 2000), apiKey: str(custom.apiKey, 4000) } } : {}) },
    input: { sendAfterDictation: body?.input?.sendAfterDictation === true, pushToTalk: body?.input?.pushToTalk !== false } };
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
