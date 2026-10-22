import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The scribe skill in this repo is the one source for the page API and the rules for building
 * pages. The scribe_docs tool serves it from here, so clients without the skill (or with an old
 * copy) read the docs that match this daemon's version.
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
  const contents = sections.map((section) => `${section.level === 3 ? "  " : ""}- ${section.heading}`).join("\n");
  if (!query) {
    return {
      text: `${intro}\n\n## Contents\n\nCall scribe_docs with topic set to a heading (or part of one) to read that section, "templates" for working with Scribe templates, or "all" for everything.\n\n${contents}`,
    };
  }
  const hits = sections.filter((section) => section.heading.toLowerCase().includes(query));
  // A ### hit inside a ## hit is already in that section's text.
  const outer = hits.filter((hit) => !hits.some((other) => other !== hit && other.level < hit.level && other.text.includes(hit.text)));
  if (!outer.length) {
    return { text: `No section matches "${topic}". Headings:\n\n${contents}`, error: true };
  }
  return { text: outer.map((section) => section.text).join("\n\n") };
}
