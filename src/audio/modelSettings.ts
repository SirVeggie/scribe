/**
 * Model settings (#1085): a speech model may publish `settings`, a JSON Schema object whose
 * properties are request fields (Memorize). Settings saves the user's values per source and model;
 * they go out under their own names: TTS as JSON fields or stream config, STT as form fields or
 * stream query parameters. `x-in` says where a setting applies: ["request"], ["stream"] or both.
 */
export type SettingsSchema = { properties?: Record<string, Record<string, unknown>> };
export type SettingValues = Record<string, unknown>;

/** Names a TTS or STT request sets itself; a model setting never replaces them. */
export const RESERVED = new Set(["model", "input", "voice", "response_format", "stream", "file", "type", "text", "token"]);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The saved values for one model: plain JSON, a bounded size. */
export function normalizeValues(value: unknown, budget = 8000): SettingValues | undefined {
  if (!isRecord(value)) return undefined;
  const out: SettingValues = {};
  for (const [key, v] of Object.entries(value)) if (key && key.length <= 100 && !RESERVED.has(key) && v !== undefined) out[key] = v;
  try { const text = JSON.stringify(out); return text.length <= budget && text !== "{}" ? JSON.parse(text) : undefined; } catch { return undefined; }
}

/** { [model]: values } as saved on a source; "" is the server's default model. */
export function normalizeModelSettings(value: unknown): Record<string, SettingValues> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, SettingValues> = {};
  for (const [model, values] of Object.entries(value).slice(0, 50)) {
    const clean = normalizeValues(values);
    if (clean && model.length <= 200) out[model] = clean;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The values that apply where they are sent. Without a schema (a server that publishes none), a POST
 * takes them all and a stream none: a stream refuses names it does not know.
 */
export function pickSettings(schema: unknown, values: SettingValues | undefined, where: "request" | "stream"): SettingValues {
  if (!values) return {};
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties as Record<string, unknown> : null;
  if (!properties) return where === "request" ? { ...values } : {};
  return Object.fromEntries(Object.entries(values).filter(([key]) => {
    const prop = properties[key];
    if (!isRecord(prop)) return false;
    const places = prop["x-in"];
    return !Array.isArray(places) || places.includes(where);
  }));
}

/** A source's saved values with one model's replaced: { model, values }; empty values drop the model. */
export function setModelValues(current: Record<string, SettingValues> | undefined, change: unknown): Record<string, SettingValues> | undefined {
  if (!isRecord(change) || typeof change.model !== "string") return current;
  const model = change.model.trim().slice(0, 200), values = normalizeValues(change.values), next = { ...current };
  if (values) next[model] = values; else delete next[model];
  return Object.keys(next).length ? next : undefined;
}

/** A value as a form field or query parameter: strings stay, objects become JSON. */
export function fieldText(value: unknown): string {
  return value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
}
