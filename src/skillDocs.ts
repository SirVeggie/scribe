import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The scribe skill in this repo is the one source for the page API and the rules for building
 * pages: SKILL.md holds the core, and the reference files beside it (PAGE-SCRIPTS.md, TEMPLATES.md, …)
 * the parts a task only sometimes needs. It lives outside the folders providers scan (.cursor,
 * .claude, .agents), so no provider loads a copy of its own: chats read it with skill_read and other
 * clients with scribe_docs, both from here, so the docs always match this daemon's version.
 * Its Page kit table is generated from public/kit.catalog.json by npm run gen:kit-docs.
 */
export const SKILL_DIR = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "skills", "scribe");

/** Most topics, files or sections one scribe_docs or skill_read call takes. */
export const MAX_DOC_PARTS = 8;

export type DocSection = { heading: string; level: number; text: string };

/** Drops the YAML front matter a skill file starts with. */
function body(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

/** A markdown file's # title, if it has one. */
function titleOf(markdown: string): string | undefined {
  return /^#\s+(.+?)\s*$/m.exec(body(markdown))?.[1];
}

/**
 * Splits markdown at its ## and ### headings. Each section runs to the next heading of the same
 * or a higher level, so a ## section includes its ### subsections. Headings inside fenced code
 * blocks are not headings.
 */
export function splitSections(markdown: string): { intro: string; sections: DocSection[] } {
  const lines = body(markdown).split(/\r?\n/);
  const starts: Array<{ line: number; level: number; heading: string }> = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    const match = !fenced && /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (match) {
      starts.push({ line: i, level: match[1].length, heading: match[2] });
    }
  });
  const intro = lines.slice(0, starts[0]?.line ?? lines.length).join("\n").trim();
  const sections = starts.map((start, i) => {
    const next = starts.slice(i + 1).find((later) => later.level <= start.level);
    const text = lines.slice(start.line, next?.line ?? lines.length).join("\n").trim();
    return { heading: start.heading, level: start.level, text };
  });
  return { intro, sections };
}

/**
 * A file's sections for a heading search: its ## and ### sections, plus the whole file as a level-1
 * section under its # title when it is a reference file (a title hit returns the file once).
 */
function searchable(markdown: string, whole: boolean): DocSection[] {
  const title = titleOf(markdown);
  const own = splitSections(markdown).sections;
  return whole && title ? [{ heading: title, level: 1, text: body(markdown) }, ...own] : own;
}

/** Topics, files or sections given as one string or a list: trimmed, without blanks or repeats. */
export function docParts(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  if (list.some((v) => typeof v !== "string")) throw new Error("Pass a string or a list of strings.");
  const parts = [...new Set((list as string[]).map((v) => v.trim()).filter(Boolean))];
  if (parts.length > MAX_DOC_PARTS) throw new Error(`At most ${MAX_DOC_PARTS} at once.`);
  return parts.length ? parts : undefined;
}

function readDoc(name: string): string | null {
  try {
    return fs.readFileSync(path.join(SKILL_DIR, name), "utf8");
  } catch {
    return null;
  }
}

/** The skill's markdown files other than SKILL.md, in name order. */
function listDocs(): string[] {
  try {
    return fs.readdirSync(SKILL_DIR).filter((name) => /\.md$/i.test(name) && name !== "SKILL.md").sort();
  } catch {
    return [];
  }
}

/** Joins the answers to several topics or files; an error only when every one failed. */
export function joinParts(parts: Array<{ label: string; text: string; error?: boolean }>): { text: string; error?: boolean } {
  if (parts.length === 1) return { text: parts[0].text, ...(parts[0].error ? { error: true } : {}) };
  return {
    text: parts.map((p) => `=== ${p.label} ===\n\n${p.text}`).join("\n\n"),
    ...(parts.every((p) => p.error) ? { error: true } : {}),
  };
}

/**
 * What scribe_docs returns. No topic: SKILL.md's intro and a table of contents of every file.
 * "all": every file. A file's name ("templates", "page-scripts.md"): that file. Otherwise the
 * sections in any file whose heading (or a reference file's title) contains topic,
 * case-insensitive, or an error listing the headings. A list of topics answers each in turn.
 */
export function skillDocs(
  topic?: string | string[],
  read: (name: string) => string | null = readDoc,
  list: () => string[] = listDocs
): { text: string; error?: boolean } {
  const skill = read("SKILL.md");
  if (skill == null) {
    return { text: `The scribe skill is missing from ${SKILL_DIR}; this Scribe install has no docs to serve.`, error: true };
  }
  const files = list().flatMap((name) => {
    const text = read(name);
    return text == null ? [] : [{ name, text }];
  });
  const contents = [
    outline(splitSections(skill).sections),
    ...files.map((f) => {
      const title = titleOf(f.text);
      const heads = outline(splitSections(f.text).sections.filter((s) => s.level === 2));
      return `\n${f.name}${title ? `: ${title}` : ""}${heads ? `\n${heads}` : ""}`;
    }),
  ].join("\n");
  const one = (query: string): { label: string; text: string; error?: boolean } => {
    const q = query.toLowerCase();
    if (q === "all") return { label: query, text: [body(skill), ...files.map((f) => body(f.text))].join("\n\n") };
    const named = files.find((f) => f.name.toLowerCase() === q || f.name.toLowerCase() === `${q}.md`);
    if (named) return { label: named.name, text: body(named.text) };
    const hits = matchSections([...searchable(skill, false), ...files.flatMap((f) => searchable(f.text, true))], q);
    if (!hits.length) return { label: query, text: `No section matches "${query}". Headings:\n\nSKILL.md\n${contents}`, error: true };
    return { label: query, text: hits.map((section) => section.text).join("\n\n") };
  };
  const topics = docParts(topic);
  if (!topics) {
    const { intro } = splitSections(skill);
    return {
      text: `${intro}\n\n## Contents\n\nCall scribe_docs with topic set to a heading (or part of one), a file's name ("page-scripts", "templates"), a list of those, or "all" for everything.\n\nSKILL.md\n${contents}`,
    };
  }
  return joinParts(topics.map(one));
}

function outline(sections: DocSection[], sizes = false): string {
  const size = (s: DocSection) => (sizes ? ` (${Math.max(1, Math.round(s.text.length / 1000))}k chars)` : "");
  return sections.map((s) => `${s.level === 3 ? "  " : ""}- ${s.heading}${size(s)}`).join("\n");
}

/** The sections whose heading contains query (lowercase); a hit inside a higher-level hit is already in that section's text. */
function matchSections(sections: DocSection[], query: string): DocSection[] {
  const hits = sections.filter((section) => section.heading.toLowerCase().includes(query));
  return hits.filter((hit) => !hits.some((other) => other !== hit && other.level < hit.level && other.text.includes(hit.text)));
}

/**
 * skill_read's search of a skill's other markdown files, for a section the file asked for does not
 * have: the matching sections (or whole files, by # title), each labelled with its file.
 */
export function sectionsElsewhere(files: Array<{ name: string; text: string }>, section: string): string | undefined {
  const query = section.trim().toLowerCase();
  const found = files.flatMap((f) => matchSections(searchable(f.text, true), query).map((s) => `(from ${f.name})\n\n${s.text}`));
  return found.length ? found.join("\n\n") : undefined;
}

/**
 * skill_read on a markdown file (#918). With section: the sections whose heading contains it, or
 * "all" for the whole file. Without: the whole file when it fits in budget characters; a longer
 * one returns its opening ## sections that fit and an outline of the rest, since a whole large
 * skill overflows some clients' tool-result limit (Claude Code saves it to a file instead).
 */
export function sectionedRead(markdown: string, section: string | undefined, budget: number): { text: string; error?: boolean } {
  const query = (section ?? "").trim().toLowerCase();
  if (query === "all" || (!query && markdown.length <= budget)) return { text: markdown };
  const { intro, sections } = splitSections(markdown);
  if (query) {
    const hits = matchSections(sections, query);
    if (hits.length) return { text: hits.map((s) => s.text).join("\n\n") };
    return { text: sections.length ? `No section matches "${section}". Headings:\n\n${outline(sections)}` : "This file has no ## or ### headings; omit section to read it.", error: true };
  }
  const shown = [intro];
  let used = intro.length;
  let next = 0;
  for (; next < sections.length; next++) {
    const s = sections[next];
    if (s.level !== 2) continue;
    if (used + s.text.length > budget) break;
    shown.push(s.text);
    used += s.text.length + 2;
  }
  const rest = sections.slice(next);
  if (!rest.length) return { text: shown.join("\n\n") };
  return {
    text: `${shown.join("\n\n")}\n\n---\nThis file is long (${Math.round(markdown.length / 1000)}k chars), so the rest is listed by heading. Read the sections your task needs with skill_read section set to a heading (or part of one); a ## section includes its ### ones.\n\n${outline(rest, true)}`,
  };
}
