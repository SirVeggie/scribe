import type { OpenAISource } from "../agent/openaiSources.js";

/** Experimental live transcription: "native" uses the server's own stream (Moonshine's /v1/stream WebSocket), "window" re-sends the recording in pause-cut pieces to any upload endpoint. */
export type SttStreaming = "native" | "window";
/** speechModel set: the source can also read text aloud (Phase D). */
export type SttSource = { id: string; name: string; source?: string; model: string; language?: string; streaming?: SttStreaming; speechModel?: string; custom?: { baseUrl: string; apiKey?: string } };
/** Text-to-speech: source is a profile id or BROWSER_SPEECH (the shell's speechSynthesis); unset is off. */
export type TtsSettings = { source?: string; voice?: string; speed?: number };
export const BROWSER_SPEECH = "__browser__";
export type AudioSettings = {
  sources: SttSource[];
  defaultSource?: string;
  stt: { source?: string; model: string; language?: string; custom?: { baseUrl: string; apiKey?: string } };
  tts: TtsSettings;
  input: { sendAfterDictation: boolean; pushToTalk: boolean; livePreview: boolean };
  /** Notification sounds (phase C): off until the user turns them on. */
  output: AudioOutput;
};
export const AUDIO_CUES = ["thread-finish", "thread-ask"] as const;
export type AudioCue = typeof AUDIO_CUES[number];
export type AudioOutput = { sounds: boolean; volume: number; cues: Record<AudioCue, boolean> };
export type AudioErrorKind = "no_source" | "invalid_audio" | "too_large" | "timeout" | "network" | "auth" | "rate_limit" | "engine" | "permission" | "format";
export type AudioResult = { ok: true; text: string } | { ok: false; error: AudioErrorKind; message: string; retryable?: boolean };
export type SttRequest = { source: OpenAISource; model: string; audio: Blob; language?: string; prompt?: string; signal: AbortSignal };
export interface SttEngine { transcribe(request: SttRequest): Promise<AudioResult> }
export type AudioDayUsage = { day: string; calls: number; failed: number; bytes: number; speechCalls?: number; speechFailed?: number; chars?: number };
export type TtsRequest = { source: OpenAISource; model: string; text: string; voice: string; speed: number; signal: AbortSignal };
export type TtsFailure = { ok: false; error: AudioErrorKind; message: string; retryable?: boolean };
export type TtsResult = { ok: true; type: string; body: ReadableStream<Uint8Array> } | TtsFailure;
export interface TtsEngine { speak(request: TtsRequest): Promise<TtsResult> }
