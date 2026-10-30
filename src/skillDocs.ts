import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The scribe skill in this repo is the one source for the page API and the rules for building
 * pages. The scribe_docs tool serves it from here, so clients without the skill (or with an old
 * copy) read the docs that match this daemon's version.
 * Its Page kit table is generated from public/kit.catalog.json by npm run gen:kit-docs;
 * keep serving the committed skill so installed skills and this tool see identical docs.
 */
export const SKILL_DIR = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", ".cursor", "skills", "scribe");

export type DocSection = { heading: string; level: number; text: string };

/** Drops the YAML front matter a skill file starts with. */
function body(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
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

function readDoc(name: string): string | null {
  try {
    return fs.readFileSync(path.join(SKILL_DIR, name), "utf8");
  } catch {
    return null;
  }
}

/**
 * What scribe_docs returns. No topic: the skill's intro and its table of contents. "all": the
 * whole skill. "templates": TEMPLATES.md. Otherwise the sections whose heading contains topic
 * (case-insensitive), or an error listing the headings.
 */
export function skillDocs(topic?: string, read: (name: string) => string | null = readDoc): { text: string; error?: boolean } {
  const skill = read("SKILL.md");
  if (skill == null) {
    return { text: `The scribe skill is missing from ${SKILL_DIR}; this Scribe install has no docs to serve.`, error: true };
  }
  const query = (topic ?? "").trim().toLowerCase();
  if (query === "all") {
    return { text: body(skill) };
  }
  if (query === "templates") {
    const templates = read("TEMPLATES.md");
    return templates == null ? { text: "TEMPLATES.md is missing from the scribe skill.", error: true } : { text: body(templates) };
  }
  if(query==="plugins"){
    const plugins=read("PLUGINS.md");return plugins===null?{text:"PLUGINS.md is missing from the scribe skill.",error:true}:{text:body(plugins)};
  }
  const { intro, sections } = splitSections(skill);
  const contents = outline(sections);
  if (!query) {
    return {
      text: `${intro}\n\n## Contents\n\nCall scribe_docs with topic set to a heading (or part of one) to read that section, "templates" for working with Scribe templates, or "all" for everything.\n\n${contents}`,
    };
  }
  const outer = matchSections(sections, query);
  if (!outer.length) {
    return { text: `No section matches "${topic}". Headings:\n\n${contents}`, error: true };
  }
  return { text: outer.map((section) => section.text).join("\n\n") };
}

function outline(sections: DocSection[], sizes = false): string {
  const size = (s: DocSection) => (sizes ? ` (${Math.max(1, Math.round(s.text.length / 1000))}k chars)` : "");
  return sections.map((s) => `${s.level === 3 ? "  " : ""}- ${s.heading}${size(s)}`).join("\n");
}

/** The sections whose heading contains query (lowercase); a ### hit inside a ## hit is already in that section's text. */
function matchSections(sections: DocSection[], query: string): DocSection[] {
  const hits = sections.filter((section) => section.heading.toLowerCase().includes(query));
  return hits.filter((hit) => !hits.some((other) => other !== hit && other.level < hit.level && other.text.includes(hit.text)));
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
