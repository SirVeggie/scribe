import type { Tab } from "./types.js";
import { vault } from "./vault.js";

export function normalizeSearchText(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
}

// State contains both user content and bookkeeping. Keep the latter out of search.
export const ignoredStateField = /^(?:id|num|col|color|colour|settings|workerLog|images|assets|claim|thread|usage|status|blockedBy|from|cover|createdAt|updatedAt|movedAt|doneAt)$/i;

export function stateToText(value: unknown): string {
  const out: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (item: unknown): void => {
    if (typeof item === "string") {
      if (/^(?:asset|data|https?):|^#[\da-f]{3,8}$|^[a-z]{1,4}_[a-z0-9]+$/i.test(item)) return;
      const text = item.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
      if (text) out.push(text);
    } else if (item && typeof item === "object" && !seen.has(item)) {
      seen.add(item);
      if (Array.isArray(item)) item.forEach(walk);
      else for (const [key, child] of Object.entries(item)) if (!ignoredStateField.test(key)) walk(child);
    }
  };
  walk(value);
  return out.join("\n");
}

export type PageTextSource = Pick<Tab, "title" | "html" | "state"> & Partial<Pick<Tab, "key" | "revision" | "stateRevision">>;
type PageText = Readonly<{
  title: string;
  key: string;
  content: string;
  data: string;
  normalizedTitle: string;
  normalizedKey: string;
  normalizedContent: string;
  normalizedData: string;
  hay: string;
}>;
type CacheEntry = { revision: number; stateRevision: number; html: string; state: unknown; title: string; vault: number; text: PageText };
const cache = new WeakMap<PageTextSource, CacheEntry>();

/**
 * Shared by palette, library and semantic search. Revisions cover in-place state edits.
 * Protected values (#1045) are left out, so no query can find a page by one.
 */
export function pageText(tab: PageTextSource): PageText {
  const old = cache.get(tab);
  const protectedData = vault();
  if (old && old.revision === tab.revision && old.stateRevision === tab.stateRevision && old.vault === protectedData.version &&
      old.html === tab.html && old.state === tab.state && old.title === tab.title && old.text.key === (tab.key ?? "")) return old.text;
  const content = protectedData.redact(htmlToText(tab.html));
  const data = protectedData.redact(stateToText(tab.state));
  const title = protectedData.redact(tab.title);
  const normalizedTitle = normalizeSearchText(title);
  const normalizedKey = normalizeSearchText(tab.key ?? "");
  const normalizedContent = normalizeSearchText(content);
  const normalizedData = normalizeSearchText(data);
  const text = Object.freeze({ title, key: tab.key ?? "", content, data,
    normalizedTitle, normalizedKey, normalizedContent, normalizedData,
    hay: `${normalizedTitle} ${normalizedKey} ${normalizedContent} ${normalizedData}` });
  // Partial sources without revision counters cannot safely cache in-place edits.
  if (tab.revision !== undefined && tab.stateRevision !== undefined) {
    cache.set(tab, { revision: tab.revision, stateRevision: tab.stateRevision, html: tab.html, state: tab.state, title: tab.title, vault: protectedData.version, text });
  }
  return text;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&#39;|&apos;|&lsquo;|&rsquo;/gi, "'")
    .replace(/&mdash;|&ndash;/gi, "-")
    .replace(/&hellip;/gi, "...")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

