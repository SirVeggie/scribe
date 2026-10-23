import { authHeaders } from "../agent/openaiSources.js";
import type { SttEngine } from "./types.js";

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
