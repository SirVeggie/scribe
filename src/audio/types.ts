import type { OpenAISource } from "../agent/openaiSources.js";

/** Experimental live transcription: "native" uses the server's own stream (Moonshine's /v1/stream WebSocket), "window" re-sends the recording in pause-cut pieces to any upload endpoint. */
export type SttStreaming = "native" | "window";
/** speechModel is read only to move an early text-to-speech setup into ttsSources. */
export type SttSource = { id: string; name: string; source?: string; model: string; language?: string; streaming?: SttStreaming; speechModel?: string; custom?: { baseUrl: string; apiKey?: string } };
/**
 * A text-to-speech source (Phase D): linked to a model source or a custom endpoint, like SttSource.
 * model empty: the server's loaded model. stream: send the non-standard stream: true so audio arrives while it is generated.
 */
export type TtsSource = { id: string; name: string; source?: string; model?: string; voice?: string; speed?: number; stream?: boolean; custom?: { baseUrl: string; apiKey?: string } };
/** source: a ttsSources id or BROWSER_SPEECH (the shell's speechSynthesis); unset is off. voice and speed are This browser's. */
export type TtsSettings = { source?: string; voice?: string; speed?: number };
export const BROWSER_SPEECH = "__browser__";
export type AudioSettings = {
  sources: SttSource[];
  defaultSource?: string;
  stt: { source?: string; model: string; language?: string; custom?: { baseUrl: string; apiKey?: string } };
  ttsSources: TtsSource[];
  tts: TtsSettings;
  input: { sendAfterDictation: boolean; pushToTalk: boolean; livePreview: boolean };
  /** Notification sounds (phase C): off until the user turns them on. */
  output: AudioOutput;
};
export const AUDIO_CUES = ["thread-finish", "thread-ask"] as const;
export type AudioCue = typeof AUDIO_CUES[number];
/** volume is the master; speechVolume scales text-to-speech under it (#1011). */
export type AudioOutput = { sounds: boolean; volume: number; speechVolume: number; cues: Record<AudioCue, boolean> };
export type AudioErrorKind = "no_source" | "invalid_audio" | "too_large" | "timeout" | "network" | "auth" | "rate_limit" | "engine" | "permission" | "format";
export type AudioResult = { ok: true; text: string } | { ok: false; error: AudioErrorKind; message: string; retryable?: boolean };
export type SttRequest = { source: OpenAISource; model: string; audio: Blob; language?: string; prompt?: string; signal: AbortSignal };
export interface SttEngine { transcribe(request: SttRequest): Promise<AudioResult> }
export type AudioDayUsage = { day: string; calls: number; failed: number; bytes: number; speechCalls?: number; speechFailed?: number; chars?: number };
export type TtsRequest = { source: OpenAISource; model?: string; text: string; voice: string; speed: number; stream?: boolean; signal: AbortSignal };
export type TtsVoice = { id: string; name?: string };
export type TtsVoices = { ok: true; voices: TtsVoice[]; default?: string; listed: boolean };
export type TtsFailure = { ok: false; error: AudioErrorKind; message: string; retryable?: boolean };
export type TtsResult = { ok: true; type: string; body: ReadableStream<Uint8Array> } | TtsFailure;
export interface TtsEngine {
  speak(request: TtsRequest): Promise<TtsResult>;
  /** The server's own voice list (GET /audio/voices?model=); listed: false when it has none, so callers offer the OpenAI names. */
  voices?(request: { source: OpenAISource; model?: string; signal: AbortSignal }): Promise<TtsVoices | TtsFailure>;
}
