import { isPlainRecord } from "./types.js";
import { normalizePrices, type ModelPrice } from "./pricing.js";

/**
 * OpenAI-compatible endpoints the user added (OpenAI, OpenRouter, LM Studio, Ollama, vLLM, …).
 * Each one is a source of models for the native harness (provider id "pi"); a model id there is
 * "src-<source id>/<model id>". Stored in agent.sqlite on this PC. The API key never leaves the daemon:
 * the board only sees whether one is set.
 */
export type OpenAISource = {
  id: string;
  name: string;
  /** Up to and including the version path, e.g. https://api.openai.com/v1 or http://localhost:1234/v1. */
  baseUrl: string;
  apiKey?: string;
  /** Model ids to offer. Empty: ask the endpoint (GET /models). */
  models: string[];
  /** Offer reasoning levels (sent as reasoning_effort). */
  reasoning?: boolean;
  /** Exact model IDs; absence means Automatic. */
  pricing?: Record<string, ModelPrice>;
  /** The user trusts this source with Trusted only pages (#269). Off unless set. */
  trusted?: boolean;
};

/** What the board UI gets: no key, only whether there is one. */
export type OpenAISourceView = Omit<OpenAISource, "apiKey"> & { hasKey: boolean };

export function sourceView(source: OpenAISource): OpenAISourceView {
  const { apiKey, ...rest } = source;
  return { ...rest, hasKey: Boolean(apiKey) };
}

export function slugId(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "source";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/**
 * A source from the board's form. `previous` is the stored one being edited: its id stays, and its
 * key stays unless the form sends a new one (apiKey: "" clears it).
 */
export function normalizeSource(input: unknown, previous: OpenAISource | undefined, taken: Set<string>): OpenAISource {
  const body = isPlainRecord(input) ? input : {};
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : previous?.name ?? "";
  if (!name) throw new Error("A source needs a name");
  const rawUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : previous?.baseUrl ?? "";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Base URL must be a full URL, e.g. https://api.openai.com/v1");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL must be http or https");
  const baseUrl = url.toString().replace(/\/+$/, "");
  const models = Array.isArray(body.models)
    ? [...new Set(body.models.map((m) => String(m).trim()).filter(Boolean))].slice(0, 200)
    : typeof body.models === "string"
      ? [...new Set(body.models.split(/[\n,]/).map((m) => m.trim()).filter(Boolean))].slice(0, 200)
      : previous?.models ?? [];
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : previous?.apiKey ?? "";
  const reasoning = typeof body.reasoning === "boolean" ? body.reasoning : previous?.reasoning ?? false;
  const trusted = typeof body.trusted === "boolean" ? body.trusted : previous?.trusted ?? false;
  const endpointChanged = previous && baseUrl !== previous.baseUrl;
  if (endpointChanged && Object.keys(previous.pricing ?? {}).length && body.pricing === undefined) throw new Error("Endpoint changed: reconfirm or clear model prices");
  const pricing = body.pricing === undefined ? previous?.pricing : normalizePrices(body.pricing, endpointChanged ? {} : previous?.pricing);
  if (endpointChanged && Object.keys(pricing ?? {}).length && body.pricingConfirmed !== true) throw new Error("Confirm that model prices apply to the changed endpoint");
  return {
    id: previous?.id ?? slugId(name, taken),
    name,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    models,
    ...(reasoning ? { reasoning: true } : {}),
    ...(trusted ? { trusted: true } : {}),
    ...(pricing && Object.keys(pricing).length ? { pricing } : {}),
  };
}

/** "<source id>/<model id>" → its parts. Model ids may contain slashes themselves (OpenRouter). */
export function splitModelId(id: string): { source: string; model: string } | null {
  const at = id.indexOf("/");
  if (at <= 0 || at === id.length - 1) return null;
  return { source: id.slice(0, at), model: id.slice(at + 1) };
}

export function authHeaders(source: OpenAISource): Record<string, string> {
  return source.apiKey ? { Authorization: `Bearer ${source.apiKey}` } : {};
}

export type SourceModelInfo = { id: string; contextWindow?: number };

const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined);

/**
 * The context window a /models entry reports, under whichever name its server uses: the loaded
 * length before the model's maximum (LM Studio), vLLM's max_model_len, OpenRouter's
 * context_length, Groq's context_window, llama.cpp's trained length.
 */
export function entryContextWindow(entry: Record<string, unknown>): number | undefined {
  const meta = isPlainRecord(entry.meta) ? entry.meta : {};
  const topProvider = isPlainRecord(entry.top_provider) ? entry.top_provider : {};
  return (
    positive(entry.loaded_context_length) ??
    positive(entry.max_model_len) ??
    positive(entry.context_length) ??
    positive(entry.context_window) ??
    positive(topProvider.context_length) ??
    positive(entry.max_context_length) ??
    positive(meta.n_ctx) ??
    positive(meta.n_ctx_train)
  );
}

/** llama.cpp's server answers /props with the context it was started with (-c), which /models leaves out. */
async function llamaCppContext(source: OpenAISource, timeoutMs: number): Promise<number | undefined> {
  const url = new URL(source.baseUrl);
  url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/+$/, "") + "/props";
  try {
    const res = await fetch(url, { headers: authHeaders(source), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as unknown;
    if (!isPlainRecord(body)) return undefined;
    const settings = isPlainRecord(body.default_generation_settings) ? body.default_generation_settings : {};
    return positive(settings.n_ctx) ?? positive(body.n_ctx);
  } catch {
    return undefined;
  }
}

/** The endpoint's own model list (GET /models) with the context window each entry reports. */
export async function fetchModelInfo(source: OpenAISource, timeoutMs = 8000): Promise<SourceModelInfo[]> {
  const res = await fetch(`${source.baseUrl}/models`, { headers: authHeaders(source), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${source.name}: GET /models failed (${res.status})`);
  const body = (await res.json()) as unknown;
  const data = isPlainRecord(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
  const models = data
    .map((m): SourceModelInfo | null => {
      if (typeof m === "string") return m ? { id: m } : null;
      if (!isPlainRecord(m) || typeof m.id !== "string" || !m.id) return null;
      const contextWindow = entryContextWindow(m);
      return { id: m.id, ...(contextWindow ? { contextWindow } : {}) };
    })
    .filter((m): m is SourceModelInfo => m !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  // A llama.cpp server (its entries carry meta) serves one model; its -c beats the trained length.
  const llamaCpp = data.length === 1 && isPlainRecord(data[0]) && isPlainRecord(data[0].meta);
  const served = llamaCpp ? await llamaCppContext(source, timeoutMs) : undefined;
  return served ? models.map((m) => ({ ...m, contextWindow: served })) : models;
}
