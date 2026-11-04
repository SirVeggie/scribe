import { authHeaders } from "../agent/openaiSources.js";
import type { SttEngine, TtsEngine } from "./types.js";

export const openAiEngine: SttEngine = {
  async transcribe({ source, model, audio, language, prompt, signal }) {
    const form = new FormData();
    const type = audio.type.split(";")[0];
    const ext = ({ "audio/wav": "wav", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/flac": "flac" } as Record<string, string>)[type] ?? "webm";
    form.append("file", audio, `recording.${ext}`);
    form.append("model", model);
    if (language) form.append("language", language);
    if (prompt) form.append("prompt", prompt);
    const res = await fetch(`${source.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, { method: "POST", headers: authHeaders(source), body: form, signal });
    if (!res.ok) {
      // llama.cpp's server reads only WAV/MP3/FLAC and answers other formats with 400.
      if ((res.status === 400 || res.status === 415) && !["wav", "mp3", "flac"].includes(ext))
        return { ok: false, error: "format", message: `This source cannot read ${ext} audio (${res.status}).` };
      if (res.status === 404) return { ok: false, error: "engine", message: "No transcription endpoint at this URL (404). OpenAI-compatible URLs usually end in /v1." };
      const error = res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate_limit" : "engine";
      // Never relay upstream bodies: they can contain credentials or endpoint details.
      return { ok: false, error, message: `Speech-to-text request failed (${res.status}).`, retryable: res.status === 429 || res.status >= 500 };
    }
    const body = await res.json() as { text?: unknown };
    // Qwen3-ASR on llama.cpp returns its raw "language English<asr_text>…" output.
    return typeof body.text === "string" ? { ok: true, text: body.text.replace(/^[^<]*<asr_text>/, "").trim() } : { ok: false, error: "engine", message: "Speech-to-text returned no transcript." };
  },
};

/** The OpenAI endpoint takes at most this many characters per request; the shell splits longer text. */
export const MAX_SPEECH_CHARS = 4096;
/** OpenAI's voices; offered when a server has no voice list of its own. */
export const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];
const failed = (status: number, what: string) => {
  const error = status === 401 || status === 403 ? "auth" as const : status === 429 ? "rate_limit" as const : "engine" as const;
  // Never relay upstream bodies: they can contain credentials or endpoint details.
  return { ok: false as const, error, message: `${what} failed (${status}).`, retryable: status === 429 || status >= 500 };
};
export const openAiTts: TtsEngine = {
  async speak({ source, model, text, voice, speed, stream, signal }) {
    const res = await fetch(`${source.baseUrl.replace(/\/+$/, "")}/audio/speech`, { method: "POST", signal,
      headers: { ...authHeaders(source), "Content-Type": "application/json" },
      // No model: the server's loaded one. stream is not OpenAI's: servers that know it send audio while it is generated.
      body: JSON.stringify({ ...(model ? { model } : {}), input: text, voice, speed, response_format: "mp3", ...(stream ? { stream: true } : {}) }) });
    if (!res.ok || !res.body) {
      void res.body?.cancel().catch(() => {});
      if (res.status === 404) return { ok: false, error: "engine", message: "No text-to-speech endpoint at this URL (404). OpenAI-compatible URLs usually end in /v1." };
      return failed(res.status, "Text-to-speech request");
    }
    const type = (res.headers.get("content-type") || "audio/mpeg").split(";")[0].trim();
    if (!type.startsWith("audio/") && type !== "application/octet-stream") {
      void res.body.cancel().catch(() => {});
      return { ok: false, error: "engine", message: "Text-to-speech returned no audio." };
    }
    return { ok: true, type: type.startsWith("audio/") ? type : "audio/mpeg", body: res.body };
  },
  async voices({ source, model, signal }) {
    const url = new URL(`${source.baseUrl.replace(/\/+$/, "")}/audio/voices`);
    if (model) url.searchParams.set("model", model);
    const res = await fetch(url, { headers: authHeaders(source), signal });
    // OpenAI and most servers have no voice list.
    if (res.status === 404 || res.status === 405) { void res.body?.cancel().catch(() => {}); return { ok: true, voices: OPENAI_VOICES.map(id => ({ id })), listed: false }; }
    if (!res.ok) { void res.body?.cancel().catch(() => {}); return failed(res.status, "Listing voices"); }
    const body = await res.json().catch(() => null) as { voices?: unknown; default?: unknown } | null;
    const list = Array.isArray(body?.voices) ? body.voices : Array.isArray(body) ? body : null;
    if (!list) return { ok: true, voices: OPENAI_VOICES.map(id => ({ id })), listed: false };
    const voices = list.map(v => typeof v === "string" ? { id: v }
      : v && typeof v === "object" ? { id: String((v as Record<string, unknown>).id ?? (v as Record<string, unknown>).voice_id ?? (v as Record<string, unknown>).name ?? ""),
        ...(typeof (v as Record<string, unknown>).name === "string" ? { name: (v as Record<string, string>).name } : {}) } : { id: "" })
      .filter(v => v.id).slice(0, 500);
    return { ok: true, voices, listed: true, ...(typeof body?.default === "string" ? { default: body.default } : {}) };
  },
};
