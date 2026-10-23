import fs from "node:fs";

/** The catalog describes implemented kit features; plugin components stay in their manifests. */
export type KitEntry = {
  id: string;
  write: string;
  gives: string;
  example: string;
  classes?: string[];
  attributes?: string[];
  properties?: string[];
  hooks?: Array<{ file: string; text: string }>;
};
export type KitCatalog = {
  entries: KitEntry[];
  internal: Array<{ class: string; why: string }>;
};

export const KIT_CATALOG_URL = new URL("../public/kit.catalog.json", import.meta.url);
export const KIT_DOCS_START = "<!-- kit-catalog:start -->";
export const KIT_DOCS_END = "<!-- kit-catalog:end -->";

export function readKitCatalog(): KitCatalog {
  return JSON.parse(fs.readFileSync(KIT_CATALOG_URL, "utf8"));
}

// Escape pipes even in code spans: Markdown table parsers split them before parsing inline code.
function cell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}
function code(value: string): string {
  const fence = "`".repeat(Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  return `${fence} ${cell(value)} ${fence}`;
}

export function renderKitDocs(catalog: KitCatalog): string {
  return [
    "| Write | Gives | Example |",
    "|---|---|---|",
    ...catalog.entries.map((entry) => `| ${code(entry.write)} | ${cell(entry.gives)} | ${code(entry.example)} |`),
  ].join("\n");
}

/** Used by the generator and drift test. Fails closed if the skill loses its generated block. */
export function updateKitDocs(markdown: string, catalog: KitCatalog): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const start = normalized.indexOf(KIT_DOCS_START);
  const end = normalized.indexOf(KIT_DOCS_END);
  if (start < 0 || end < start || normalized.indexOf(KIT_DOCS_START, start + 1) >= 0 || normalized.indexOf(KIT_DOCS_END, end + 1) >= 0) {
    throw new Error("Expected exactly one ordered pair of kit-catalog markers in SKILL.md");
  }
  return normalized.slice(0, start + KIT_DOCS_START.length) + "\n" + renderKitDocs(catalog) + "\n" + normalized.slice(end);
}
