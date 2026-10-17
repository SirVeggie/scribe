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

/** The endpoint's own model list (GET /models), for sources that don't list theirs. */
export async function fetchModelIds(source: OpenAISource, timeoutMs = 8000): Promise<string[]> {
  const res = await fetch(`${source.baseUrl}/models`, { headers: authHeaders(source), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${source.name}: GET /models failed (${res.status})`);
  const body = (await res.json()) as unknown;
  const data = isPlainRecord(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
  return data
    .map((m) => (isPlainRecord(m) && typeof m.id === "string" ? m.id : typeof m === "string" ? m : ""))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}
