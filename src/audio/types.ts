import type { OpenAISource } from "../agent/openaiSources.js";

/** Experimental live transcription: "native" uses the server's own stream (Memorize's /audio/transcriptions/stream WebSocket), "window" re-sends the recording in pause-cut pieces to any upload endpoint. */
export type SttStreaming = "native" | "window";
/** The user's values for each model's published settings (#1085), keyed by model id ("" is the server's default). */
export type ModelSettings = Record<string, Record<string, unknown>>;
/** model "": the server's default. speechModel is read only to move an early text-to-speech setup into ttsSources. */
export type SttSource = { id: string; name: string; source?: string; model: string; language?: string; streaming?: SttStreaming; speechModel?: string; custom?: { baseUrl: string; apiKey?: string }; modelSettings?: ModelSettings };
/**
 * A text-to-speech source (Phase D): linked to a model source or a custom endpoint, like SttSource.
 * model empty: the server's loaded model. stream: send the non-standard stream: true so audio arrives while it is generated.
 */
export type TtsSource = { id: string; name: string; source?: string; model?: string; voice?: string; speed?: number; stream?: boolean; custom?: { baseUrl: string; apiKey?: string }; modelSettings?: ModelSettings };
/** source: a ttsSources id or BROWSER_SPEECH (the shell's speechSynthesis); unset is off. voice and speed are This browser's. */
export type TtsSettings = { source?: string; voice?: string; speed?: number };
export const BROWSER_SPEECH = "__browser__";
export type AudioSettings = {
  sources: SttSource[];
  defaultSource?: string;
  stt: { source?: string; model: string; language?: string; custom?: { baseUrl: string; apiKey?: string } };
  ttsSources: TtsSource[];
  tts: TtsSettings;
  input: { sendAfterDictation: boolean; pushToTalk: boolean; livePreview: boolean; /** Spoken at the end, then a pause, sends the dictation (#1060). */ sendKeyword?: string };
  /** Notification sounds (phase C): off until the user turns them on. */
  output: AudioOutput;
};
export const AUDIO_CUES = ["thread-finish", "thread-ask"] as const;
export type AudioCue = typeof AUDIO_CUES[number];
/** volume is the master; speechVolume scales text-to-speech under it (#1011). */
export type AudioOutput = { sounds: boolean; volume: number; speechVolume: number; cues: Record<AudioCue, boolean> };
/** busy: the server has no room right now (503); setting: the server refused a model setting. */
export type AudioErrorKind = "no_source" | "invalid_audio" | "too_large" | "timeout" | "network" | "auth" | "rate_limit" | "engine" | "permission" | "format" | "busy" | "setting";
/** retryAfter: seconds the server asked to wait. setting: the refused setting's name (nested: "steering.pace"). */
export type AudioFailure = { ok: false; error: AudioErrorKind; message: string; retryable?: boolean; retryAfter?: number; setting?: string };
export type AudioResult = { ok: true; text: string } | AudioFailure;
/** model "": the server's default. settings: the model's own fields, sent next to the file. */
export type SttRequest = { source: OpenAISource; model: string; audio: Blob; language?: string; prompt?: string; settings?: Record<string, unknown>; signal: AbortSignal };
export interface SttEngine { transcribe(request: SttRequest): Promise<AudioResult> }
export type AudioDayUsage = { day: string; calls: number; failed: number; bytes: number; speechCalls?: number; speechFailed?: number; chars?: number };
/** settings: the model's own fields, sent next to input and voice. */
export type TtsRequest = { source: OpenAISource; model?: string; text: string; voice: string; speed: number; stream?: boolean; settings?: Record<string, unknown>; signal: AbortSignal };
export type TtsVoice = { id: string; name?: string };
export type TtsVoices = { ok: true; voices: TtsVoice[]; default?: string; listed: boolean };
export type TtsFailure = AudioFailure;
export type TtsResult = { ok: true; type: string; body: ReadableStream<Uint8Array> } | TtsFailure;
export interface TtsEngine {
  speak(request: TtsRequest): Promise<TtsResult>;
  /** The server's own voice list (GET /audio/voices?model=); listed: false when it has none, so callers offer the OpenAI names. */
  voices?(request: { source: OpenAISource; model?: string; signal: AbortSignal }): Promise<TtsVoices | TtsFailure>;
}
