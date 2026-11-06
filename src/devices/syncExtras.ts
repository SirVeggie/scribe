import { normalizeSource as normalizeModelSource, type OpenAISource } from "../agent/openaiSources.js";
import { cleanCommandAllowlist } from "../agent/toolGrants.js";
import { cleanAllowlist, DEFAULT_WEB_ALLOWLIST } from "../agent/webAccess.js";
import { normalizeSettings as normalizeAudio, normalizeTtsSource } from "../audio/settings.js";
import type { SttSource, TtsSource } from "../audio/types.js";
import { normalizeSource as normalizeMlSource } from "../ml/settings.js";
import type { MlSource } from "../ml/types.js";

/**
 * The opt-in sync categories that are lists rather than single preferences (#1024): sources and their
 * keys, and the allowlists. Each list item is its own record, so two devices that each added one keep
 * both. A record's value "" means the item is gone.
 *
 *   src:<kind>:<id>     a source without its key, as canonical JSON (kind: model, ml, stt, tts)
 *   srckey:<kind>:<id>  that source's API key (only with Include keys)
 *   allow:web:<domain>  "1" on the web allowlist
 *   allow:cmd:<command> "1" on the command allowlist
 *
 * Sources on this computer (a loopback address, or a speech source that uses one) stay local: they are
 * never sent, and a record from another device with the same id leaves them alone.
 */

export type ExtraCategory = "sources" | "keys" | "allowlists";
export const SOURCE_KINDS = ["model", "ml", "stt", "tts"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** What this device has now, for stamping: the values, the defaults (a key equal to its default needs no record) and keys to leave alone. */
export type ExtrasSnapshot = { values: Record<string, string>; defaults: Record<string, string>; local: Set<string> };

export type SourceLists = { model: OpenAISource[]; ml: MlSource[]; stt: SttSource[]; tts: TtsSource[] };
export type Allowlists = { web: string[]; cmd: string[] };

export function extraCategory(key: string): ExtraCategory | undefined {
  if (key.startsWith("src:")) return parseSourceKey(key) ? "sources" : undefined;
  if (key.startsWith("srckey:")) return parseSourceKey(key) ? "keys" : undefined;
  if (key.startsWith("allow:web:") || key.startsWith("allow:cmd:")) return "allowlists";
  return undefined;
}

export function parseSourceKey(key: string): { kind: SourceKind; id: string } | undefined {
  const match = /^(?:src|srckey):(model|ml|stt|tts):(.{1,100})$/s.exec(key);
  return match ? { kind: match[1] as SourceKind, id: match[2] } : undefined;
}

const sourceKey = (kind: SourceKind, id: string) => `src:${kind}:${id}`;
const keyKey = (kind: SourceKind, id: string) => `srckey:${kind}:${id}`;

export function isLoopback(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || /^127\./.test(host);
}

const origin = (url: string | undefined) => {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
};

// ---- canonical forms: the same object always gives the same JSON, so a value applied here is not stamped again ----

function canonModel(raw: unknown): OpenAISource {
  const input = raw as OpenAISource;
  if (!input || typeof input.id !== "string" || !input.id) throw new Error("A source needs an id");
  const clean = normalizeModelSource({ ...input, apiKey: undefined, pricingConfirmed: true }, undefined, new Set());
  delete clean.apiKey;
  return { ...clean, id: input.id };
}

function canonMl(raw: unknown): MlSource {
  const input = raw as MlSource;
  if (!input || typeof input.id !== "string" || !input.id) throw new Error("A source needs an id");
  const clean = normalizeMlSource({ ...input, apiKey: undefined }, undefined, new Set());
  delete clean.apiKey;
  return { ...clean, id: input.id };
}

function withoutCustomKey<T extends { custom?: { baseUrl: string; apiKey?: string } }>(source: T): T {
  if (source.custom) source.custom = { baseUrl: source.custom.baseUrl };
  return source;
}

function canonStt(raw: unknown): SttSource {
  const source = normalizeAudio({ sources: [raw] }).sources[0];
  if (!source?.id || !source.name) throw new Error("A speech source needs an id and a name");
  return withoutCustomKey(source);
}

function canonTts(raw: unknown): TtsSource {
  const source = normalizeTtsSource(raw);
  if (!source.id || !source.name) throw new Error("A speech source needs an id and a name");
  return withoutCustomKey(source);
}

const CANON: Record<SourceKind, (raw: unknown) => { id: string }> = { model: canonModel, ml: canonMl, stt: canonStt, tts: canonTts };

/** The endpoint a source calls itself, when it has one of its own (a speech source may use a model source). */
function ownUrl(kind: SourceKind, source: Record<string, unknown>): string | undefined {
  if (kind === "model" || kind === "ml") return source.baseUrl as string;
  const custom = source.custom as { baseUrl?: string } | undefined;
  return source.source === "__custom__" ? custom?.baseUrl : undefined;
}

function sourceApiKey(kind: SourceKind, source: Record<string, unknown>): string {
  const key = kind === "model" || kind === "ml" ? source.apiKey : (source.custom as { apiKey?: string } | undefined)?.apiKey;
  return typeof key === "string" ? key : "";
}

/** Whether a source stays on this device: its own endpoint is loopback, or it is a speech source on a loopback model source. */
function isLocalSource(kind: SourceKind, source: Record<string, unknown>, models: OpenAISource[]): boolean {
  if (isLoopback(ownUrl(kind, source))) return true;
  if ((kind === "stt" || kind === "tts") && source.source !== "__custom__") {
    return isLoopback(models.find((m) => m.id === source.source)?.baseUrl);
  }
  return false;
}

export function validExtra(key: string, value: string): boolean {
  const category = extraCategory(key);
  if (!category) return false;
  if (category === "allowlists") {
    if (value !== "" && value !== "1") return false;
    const entry = key.slice("allow:web:".length);
    return key.startsWith("allow:web:") ? cleanAllowlist([entry])[0] === entry : cleanCommandAllowlist([entry])[0] === entry;
  }
  if (category === "keys") return value.length <= 4000;
  if (value === "") return true;
  const { kind, id } = parseSourceKey(key)!;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const clean = CANON[kind](parsed) as unknown as Record<string, unknown>;
    // A loopback endpoint means nothing on another device.
    return clean.id === id && !isLoopback(ownUrl(kind, clean));
  } catch {
    return false;
  }
}

// ---- sources ----

export function snapshotSources(lists: SourceLists): ExtrasSnapshot {
  const values: Record<string, string> = {};
  const local = new Set<string>();
  for (const kind of SOURCE_KINDS) {
    for (const source of lists[kind] as unknown as Array<Record<string, unknown>>) {
      const id = source.id as string;
      if (!id) continue;
      if (isLocalSource(kind, source, lists.model)) {
        local.add(sourceKey(kind, id));
        local.add(keyKey(kind, id));
        continue;
      }
      try {
        values[sourceKey(kind, id)] = JSON.stringify(CANON[kind](source));
      } catch {
        continue;
      }
      const apiKey = sourceApiKey(kind, source);
      if (apiKey) values[keyKey(kind, id)] = apiKey;
    }
  }
  return { values, defaults: {}, local };
}

/**
 * Apply source records from another device. `patch` holds the changed keys ("" removes); `keyFor` is the
 * synced key for a source when keys sync here (undefined: keep this device's own, if the endpoint stayed).
 * Returns the kinds that changed.
 */
export function applySources(lists: SourceLists, patch: Record<string, string>, keyFor: (kind: SourceKind, id: string) => string | undefined): SourceKind[] {
  const changed = new Set<SourceKind>();
  for (const [key, value] of Object.entries(patch)) {
    if (!key.startsWith("src:")) continue;
    const parsed = parseSourceKey(key);
    if (!parsed) continue;
    const { kind, id } = parsed;
    const list = lists[kind] as unknown as Array<Record<string, unknown>>;
    const index = list.findIndex((s) => s.id === id);
    const previous = index >= 0 ? list[index] : undefined;
    if (previous && isLocalSource(kind, previous, lists.model)) continue;
    if (value === "") {
      if (index >= 0) {
        list.splice(index, 1);
        changed.add(kind);
      }
      continue;
    }
    let next: Record<string, unknown>;
    try {
      next = CANON[kind](JSON.parse(value)) as unknown as Record<string, unknown>;
    } catch {
      continue;
    }
    // A saved key belongs to the endpoint it was entered for.
    const synced = keyFor(kind, id);
    const own = previous && origin(ownUrl(kind, previous)) === origin(ownUrl(kind, next)) ? sourceApiKey(kind, previous) : "";
    setApiKey(kind, next, synced ?? own);
    if (index >= 0) list[index] = next;
    else list.push(next);
    changed.add(kind);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!key.startsWith("srckey:")) continue;
    const parsed = parseSourceKey(key);
    if (!parsed || Object.hasOwn(patch, sourceKey(parsed.kind, parsed.id))) continue;
    const source = (lists[parsed.kind] as unknown as Array<Record<string, unknown>>).find((s) => s.id === parsed.id);
    if (!source || isLocalSource(parsed.kind, source, lists.model) || sourceApiKey(parsed.kind, source) === value) continue;
    setApiKey(parsed.kind, source, value);
    changed.add(parsed.kind);
  }
  return [...changed];
}

function setApiKey(kind: SourceKind, source: Record<string, unknown>, key: string): void {
  if (kind === "model" || kind === "ml") {
    if (key) source.apiKey = key;
    else delete source.apiKey;
    return;
  }
  const custom = source.custom as { baseUrl: string; apiKey?: string } | undefined;
  if (custom) source.custom = { baseUrl: custom.baseUrl, apiKey: key };
}

// ---- allowlists ----

export function snapshotAllowlists(lists: Allowlists): ExtrasSnapshot {
  const values: Record<string, string> = {};
  const defaults: Record<string, string> = {};
  for (const domain of lists.web) values[`allow:web:${domain}`] = "1";
  for (const command of lists.cmd) values[`allow:cmd:${command}`] = "1";
  // The starting web allowlist is a default: it needs no record unless the user removed an entry.
  for (const domain of DEFAULT_WEB_ALLOWLIST) defaults[`allow:web:${domain}`] = "1";
  return { values, defaults, local: new Set() };
}

/** Apply allowlist records; returns the lists that changed. */
export function applyAllowlists(lists: Allowlists, patch: Record<string, string>): Array<keyof Allowlists> {
  const changed = new Set<keyof Allowlists>();
  for (const [key, value] of Object.entries(patch)) {
    const which: keyof Allowlists | undefined = key.startsWith("allow:web:") ? "web" : key.startsWith("allow:cmd:") ? "cmd" : undefined;
    if (!which) continue;
    const entry = key.slice("allow:web:".length);
    const has = lists[which].includes(entry);
    if (value === "1" && !has) lists[which].push(entry);
    else if (value === "" && has) lists[which] = lists[which].filter((e) => e !== entry);
    else continue;
    changed.add(which);
  }
  return [...changed];
}

export function mergeSnapshots(...parts: ExtrasSnapshot[]): ExtrasSnapshot {
  const out: ExtrasSnapshot = { values: {}, defaults: {}, local: new Set() };
  for (const part of parts) {
    Object.assign(out.values, part.values);
    Object.assign(out.defaults, part.defaults);
    for (const key of part.local) out.local.add(key);
  }
  return out;
}

/** A row on Choose setup: a readable name and values, never a key. */
export function describeExtra(key: string, mine: string, theirs: string): { label: string; mine: string; theirs: string } {
  const KIND_LABELS: Record<SourceKind, string> = { model: "Model source", ml: "Classifier source", stt: "Speech-to-text source", tts: "Text-to-speech source" };
  if (key.startsWith("allow:")) {
    const label = `${key.startsWith("allow:web:") ? "Web allowlist" : "Command allowlist"}: ${key.slice("allow:web:".length)}`;
    const shown = (v: string) => (v === "1" ? "Allowed" : "Not allowed");
    return { label, mine: shown(mine), theirs: shown(theirs) };
  }
  const parsed = parseSourceKey(key);
  if (!parsed) return { label: key, mine, theirs };
  const read = (v: string) => {
    try {
      return v ? (JSON.parse(v) as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  if (key.startsWith("srckey:")) {
    const hint = (v: string) => (v ? `Key …${v.slice(-4)}` : "No key");
    return { label: `API key: ${parsed.id}`, mine: hint(mine), theirs: hint(theirs) };
  }
  const a = read(mine);
  const b = read(theirs);
  const name = (b?.name ?? a?.name ?? parsed.id) as string;
  const where = (s: Record<string, unknown> | undefined) => (s ? ownUrl(parsed.kind, s) ?? `Uses ${String(s.source)}` : "Removed");
  return { label: `${KIND_LABELS[parsed.kind]}: ${name}`, mine: where(a), theirs: where(b) };
}
