import { createHash } from "node:crypto";
import { htmlToText, pageText as extractPageText, stateToText as words, ignoredStateField as ignored, type PageTextSource } from "../pageText.js";
import { collectPageAssetRefs } from "../pageAssets.js";
import { vault } from "../vault.js";

export const CHUNKER_VERSION = "3";
export type SearchDeclaration = { records: SearchRecord[] };
export type SearchRecord = { path: string; skip?: Record<string, unknown>; title: string; text: string[]; anchor: string; label?: string; context?: "page" | "record" };
/** An asset a page shows: a page asset id (`pa_…`) or `asset:<name>`, with the key of the text chunk it sits on. */
export type ImageRef = { ref: string; owner: string; label: string };
export type TextChunk = { key: string; kind: "page" | "section" | "record"; anchor: string | null; headingId?: string; label: string; title: string; text: string; snippet: string; hash: string };

export function parseSearchDeclaration(raw: unknown): SearchDeclaration | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = raw as SearchDeclaration;
  const field = /^[a-zA-Z_][\w]*(?:\[\])?(?:\.[a-zA-Z_][\w]*(?:\[\])?)*$/;
  if (!value || !Array.isArray(value.records) || value.records.length > 32) throw new Error("search.records must be an array (max 32)");
  for (const record of value.records) {
    if (!record || ![record.path, record.title, record.anchor, ...record.text ?? []].every(p => typeof p === "string" && field.test(p)) || !Array.isArray(record.text)) throw new Error("Invalid search record fields");
    if (record.label !== undefined && typeof record.label !== "string") throw new Error("search record label must be a string");
    if (record.context !== undefined && record.context !== "page" && record.context !== "record") throw new Error("search record context must be page or record");
    if (record.skip !== undefined && (!record.skip || typeof record.skip !== "object" || Array.isArray(record.skip))) throw new Error("search record skip must be an object");
  }
  return structuredClone(value);
}

function values(value: unknown, path: string): unknown[] {
  let current = [value];
  for (const segment of path.split(".")) {
    const array = segment.endsWith("[]");
    const key = segment.replace(/\[\]$/, "");
    current = current.flatMap(v => {
      const item = v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
      return array ? Array.isArray(item) ? item : [] : [item];
    });
  }
  return current;
}
/** Sentence-aware bounded inputs. Only length splits repeat the last sentence. */
export function splitText(text: string): string[] {
  let rest = text.trim();
  const parts: string[] = [];
  while (rest.length > 2000) {
    const ends = [...rest.slice(0, 2000).matchAll(/[.!?](?:\s+|$)/g)].map(m => m.index! + m[0].trimEnd().length).filter(n => n >= 700);
    let end = ends.sort((a, b) => Math.abs(a - 1400) - Math.abs(b - 1400))[0];
    if (!end) end = rest.lastIndexOf(" ", 1400) > 700 ? rest.lastIndexOf(" ", 1400) : 1400;
    const part = rest.slice(0, end).trim();
    parts.push(part);
    const sentences = part.match(/[^.!?]+[.!?](?:\s+|$)/g);
    const overlap = sentences?.at(-1)?.trim() ?? "";
    rest = (overlap.length <= 400 ? overlap + " " : "") + rest.slice(end).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

const assetRefs = (text: string): string[] => [...collectPageAssetRefs(text), ...new Set([...text.matchAll(/\basset:[A-Za-z0-9._-]+/g)].map(m => m[0]))];

export function chunkPage(tab: PageTextSource, folder: string | null = null, declaration?: SearchDeclaration): TextChunk[] {
  return analyzePage(tab, folder, declaration).chunks;
}

/** A page's text chunks, and the assets it refers to with the chunk each one belongs to (its card, item or section). */
export function analyzePage(tab: PageTextSource, folder: string | null = null, declaration?: SearchDeclaration): { chunks: TextChunk[]; images: ImageRef[] } {
  const out: TextChunk[] = [];
  const images = new Map<string, ImageRef>();
  const own = (text: string, owner: string | undefined, label: string) => {
    for (const ref of assetRefs(text)) if (!images.has(ref)) images.set(ref, owner ? { ref, owner, label } : { ref, owner: "page", label: tab.title });
  };
  const add = (kind: TextChunk["kind"], key: string, anchor: string | null, label: string, title: string, text: string, headingId?: string) => {
    // Protected values (#1045) stay out of the index, so a semantic query can't find a page by one.
    const protectedData = vault();
    label = protectedData.redact(label);
    title = protectedData.redact(title);
    text = protectedData.redact(text);
    if (!text.trim()) return;
    out.push({ kind, key, anchor, label, title, text, headingId, snippet: text.replace(/\s+/g, " ").slice(0, 200), hash: createHash("sha256").update(JSON.stringify([title, text])).digest("hex") });
  };
  const records: { path: string; value: Record<string, unknown>; spec: SearchRecord }[] = [];
  if (declaration) {
    for (const spec of declaration.records) for (const list of values(tab.state, spec.path)) if (Array.isArray(list)) for (const value of list) {
      if (value && typeof value === "object" && !Object.entries(spec.skip ?? {}).some(([key, wanted]) => values(value, key)[0] === wanted)) records.push({ path: spec.path, value, spec });
    }
  } else {
    const walk = (value: unknown, path: string) => {
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === "object" && typeof item.id === "string") records.push({ path, value: item, spec: { path, title: typeof item.title === "string" ? "title" : "text", text: [], anchor: "id" } });
      } else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) if (!ignored.test(key)) walk(item, path ? `${path}.${key}` : key);
    };
    walk(tab.state, "");
  }
  const html = tab.html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const extracted = extractPageText(tab);
  const visible = extracted.content;
  const titles = records.map(r => words(values(r.value, r.spec.title)[0])).filter(Boolean).join("\n");
  const pageText = declaration ? titles : [visible, extracted.data].filter(Boolean).join("\n");
  // Empty pages rank for everything, so they are skipped. A declared list with one short item is still a page.
  const empty = declaration ? !records.some(r => words(r.value)) : pageText.length < 40 && records.every(r => words(r.value).length < 40);
  add("page", "page", null, tab.title, tab.title, `Folder: ${folder ?? "/"}.\n${pageText.slice(0, 3000)}`);
  for (const { path, value, spec } of records) {
    const anchor = String(values(value, spec.anchor)[0] ?? "");
    if (!anchor) continue;
    const first = out.length;
    const title = words(values(value, spec.title)[0]);
    const label = spec.label?.replace(/\{([\w.]+)\}/g, (_, key) => String(values(value, key)[0] ?? "")) ?? title;
    const text = spec.text.length ? spec.text.flatMap(p => values(value, p)).map(words).filter(Boolean).join("\n") : words(value);
    const context = title && spec.context !== "page" ? `${tab.title} › ${title}` : tab.title;
    // Description/checklist and comments split independently so editing comments preserves the description vector.
    const groups = text.length > 2000 && spec.text.includes("comments[].text")
      ? [spec.text.filter(p => p !== "comments[].text").flatMap(p => values(value, p)).map(words).join("\n"), values(value, "comments[].text").map(words).join("\n")]
      : [text || title];
    groups.forEach((group, g) => splitText(group).forEach((part, i) => add("record", `record:${path}:${anchor}:${g}:${i}`, anchor, label, context, part)));
    own(JSON.stringify(value), out[first]?.key, label);
  }
  if (!declaration) {
    const headings = [...html.matchAll(/<h([1-4])\b([^>]*)>([\s\S]*?)<\/h\1>/gi)];
    const slice = (from: number, to: number | undefined) => { const part = html.slice(from, to ?? html.length); return { text: htmlToText(part), refs: assetRefs(part) }; };
    const sections = [{ ...slice(0, headings[0]?.index), label: tab.title, anchor: "0", headingId: undefined as string | undefined }, ...headings.map((m, i) => ({ ...slice(m.index! + m[0].length, headings[i + 1]?.index), label: htmlToText(m[3]), anchor: String(i + 1), headingId: m[2].match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1] }))].filter(s => s.text);
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].text.length >= 200) continue;
      const j = i + 1 < sections.length ? i + 1 : i - 1;
      const small = (sections[i].label !== tab.title ? sections[i].label + ": " : "") + sections[i].text;
      if (j < 0 || small.length + sections[j].text.length + 1 > 1400) continue;
      sections[j].text = i < j ? small + " " + sections[j].text : sections[j].text + " " + small;
      sections[j].refs.push(...sections[i].refs);
      sections.splice(i, 1); i--;
    }
    for (const s of sections) {
      splitText(s.text).forEach((part, i) => add("section", `section:${s.anchor}:${i}`, s.anchor, s.label, `${tab.title} › ${s.label}`, part, s.headingId));
      own(s.refs.join(" "), `section:${s.anchor}:0`, s.label);
    }
  }
  // Anything else the page shows (its own markup, state outside the records) belongs to the page.
  own(tab.html + JSON.stringify(tab.state ?? null), undefined, tab.title);
  return { chunks: empty ? [] : out, images: [...images.values()] };
}
