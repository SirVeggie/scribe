import { authHeaders, type OpenAISource } from "../agent/openaiSources.js";
import { log } from "../log.js";
import type { SttEngine, TtsEngine } from "./types.js";

/** The start of an error body, with the source's key, bearer tokens and sk- style keys taken out. */
export function redactUpstream(text: string, apiKey?: string): string {
  let out = text.slice(0, 2000);
  if (apiKey) out = out.split(apiKey).join("[key]");
  out = out.replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [key]").replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, "[key]");
  return out.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
}
/** Logs a failed upstream answer: the host only (URLs can carry keys in the query), the status and the redacted body. */
async function logUpstream(res: Response, source: OpenAISource, what: string): Promise<void> {
  const body = await res.text().catch(() => "");
  let host = "";
  try { host = new URL(source.baseUrl).host; } catch { /* a bad URL fails before here */ }
  log(`audio: ${what} failed (${res.status}) at ${host}`, redactUpstream(body, source.apiKey) || undefined);
}

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
      // Never relay upstream bodies: they can contain credentials or endpoint details. daemon.log gets a redacted copy.
      await logUpstream(res, source, `speech-to-text (model ${model}, ${ext})`);
      // llama.cpp's server reads only WAV/MP3/FLAC and answers other formats with 400.
      if ((res.status === 400 || res.status === 415) && !["wav", "mp3", "flac"].includes(ext))
        return { ok: false, error: "format", message: `This source cannot read ${ext} audio (${res.status}).` };
      if (res.status === 404) return { ok: false, error: "engine", message: "No transcription endpoint at this URL (404). OpenAI-compatible URLs usually end in /v1." };
      if (res.status === 400 || res.status === 415 || res.status === 422)
        return { ok: false, error: "engine", message: `The source could not read the audio or the model name "${model}" (${res.status}). Details are in daemon.log.` };
      if (res.status === 401 || res.status === 403) return { ok: false, error: "auth", message: `The source refused the API key (${res.status}).`, retryable: false };
      const error = res.status === 429 ? "rate_limit" : "engine";
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

/** One entry of a server's GET /models, with the audio server's extra flags when it sends them. */
/**
 * One entry of a server's GET /models, with the audio server's extras when it sends them:
 * flags (default, loaded, streaming "sentence" | "native"), a one-line description, features
 * (languages, speed, tags, options…), the tags a model understands, and whether it has a guide.
 */
export type AudioModel = { id: string; default?: boolean; loaded?: boolean; streaming?: string; aliases?: string[];
  description?: string; features?: Record<string, unknown>; tags?: Record<string, unknown>; hasGuide?: boolean; guide?: string };
export type AudioModels = { ok: true; models: AudioModel[]; flagged: boolean };
type ListFailure = { ok: false; error: "auth" | "rate_limit" | "engine"; message: string };
/** Plain JSON only, and not too much of it: server data passed on to pages and Settings. */
function jsonValue(value: unknown, budget = 8000): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try { const text = JSON.stringify(value); return text.length <= budget ? JSON.parse(text) : undefined; } catch { return undefined; }
}
function readModel(m: unknown): AudioModel | null {
  const entry = (typeof m === "string" ? { id: m } : m) as Record<string, unknown> | null;
  if (!entry || typeof entry.id !== "string" || !entry.id) return null;
  const yes = (v: unknown) => v === true || v === "yes" || v === "true";
  const streaming = typeof entry.streaming === "string" && entry.streaming !== "none" ? entry.streaming : entry.streaming === true ? "sentence" : undefined;
  const features = jsonValue(entry.features), tags = jsonValue(entry.tags);
  return { id: entry.id.slice(0, 200), ...(yes(entry.default) ? { default: true } : {}), ...(yes(entry.loaded) ? { loaded: true } : {}),
    ...(streaming ? { streaming: streaming.slice(0, 40) } : {}),
    ...(Array.isArray(entry.aliases) ? { aliases: entry.aliases.filter((a): a is string => typeof a === "string").slice(0, 20) } : {}),
    ...(typeof entry.description === "string" && entry.description.trim() ? { description: entry.description.trim().slice(0, 2000) } : {}),
    ...(features ? { features } : {}), ...(tags ? { tags } : {}),
    ...(yes(entry.has_guide) ? { hasGuide: true } : {}),
    ...(typeof entry.guide === "string" && entry.guide.trim() ? { guide: entry.guide.slice(0, 100_000) } : {}) };
}
/**
 * GET {baseUrl}/models: the OpenAI model list. flagged says it carries the audio server's flags.
 * Listing loads nothing.
 */
export async function listModels(source: OpenAISource, signal: AbortSignal): Promise<AudioModels | ListFailure> {
  const res = await fetch(`${source.baseUrl.replace(/\/+$/, "")}/models`, { headers: authHeaders(source), signal });
  if (!res.ok) { void res.body?.cancel().catch(() => {}); return failed(res.status, "Listing models"); }
  const body = await res.json().catch(() => null) as { data?: unknown } | null;
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  let flagged = false;
  const models = list.flatMap(m => {
    const model = readModel(m);
    if (model && m && typeof m === "object" && ["default", "loaded", "streaming", "description", "features"].some(k => k in m)) flagged = true;
    return model ? [model] : [];
  }).slice(0, 1000);
  // The full guide comes from GET /models/{id}; the list only says one exists.
  return { ok: true, models: models.map(({ guide: _guide, ...m }) => m), flagged };
}
/** GET {baseUrl}/models/{id}: one model with its Markdown guide (what it supports and how to use it well). Loads nothing. */
export async function modelInfo(source: OpenAISource, id: string, signal: AbortSignal): Promise<{ ok: true; model: AudioModel } | ListFailure> {
  const res = await fetch(`${source.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(id)}`, { headers: authHeaders(source), signal });
  if (res.status === 404) { void res.body?.cancel().catch(() => {}); return { ok: false, error: "engine", message: `This server does not know the model ${id}.` }; }
  if (!res.ok) { void res.body?.cancel().catch(() => {}); return failed(res.status, "Reading the model"); }
  const model = readModel(await res.json().catch(() => null));
  return model ? { ok: true, model } : { ok: false, error: "engine", message: "The server sent no model details." };
}
