import type { OpenAISource } from "../agent/openaiSources.js";

export type SttSource = { id: string; name: string; source?: string; model: string; language?: string; custom?: { baseUrl: string; apiKey?: string } };
export type AudioSettings = {
  sources: SttSource[];
  defaultSource?: string;
  stt: { source?: string; model: string; language?: string; custom?: { baseUrl: string; apiKey?: string } };
  input: { sendAfterDictation: boolean; pushToTalk: boolean };
};
export type AudioErrorKind = "no_source" | "invalid_audio" | "too_large" | "timeout" | "network" | "auth" | "rate_limit" | "engine" | "permission" | "format";
export type AudioResult = { ok: true; text: string } | { ok: false; error: AudioErrorKind; message: string; retryable?: boolean };
export type SttRequest = { source: OpenAISource; model: string; audio: Blob; language?: string; prompt?: string; signal: AbortSignal };
export interface SttEngine { transcribe(request: SttRequest): Promise<AudioResult> }
export type AudioDayUsage = { day: string; calls: number; failed: number; bytes: number };
