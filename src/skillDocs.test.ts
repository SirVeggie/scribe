import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BOARD_BRIDGE_JS } from "./bridge.js";
import { SKILL_DIR, skillDocs, splitSections } from "./skillDocs.js";
import { PAGE_THEME, wrapHtml } from "./wrapHtml.js";

/** Top-level keys of the object literal that starts at `start` in the bridge source. */
function objectKeys(start: string): string[] {
  const at = BOARD_BRIDGE_JS.indexOf(start);
  assert.ok(at >= 0, `bridge has no "${start}"`);
  const keys: string[] = [];
  let depth = 0;
  for (const line of BOARD_BRIDGE_JS.slice(at + start.length - 1).split("\n")) {
    const key = depth === 1 && /^\s*(?:get\s+)?([a-zA-Z]+)\s*[(:]/.exec(line);
    if (key) {
      keys.push(key[1]);
    }
    for (const ch of line) {
      depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    }
    if (depth === 0) {
      break;
    }
  }
  return keys;
}

test("the scribe skill documents the page wrapper theme", () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  const wrapped = wrapHtml("Theme", "<p>Hi</p>");
  assert.match(wrapped, /color-scheme:\s*dark/);
  assert.match(skill, /dark theme/);
  for (const name of Object.keys(PAGE_THEME)) {
    assert.ok(wrapped.includes(`${name}:`), `wrapper defines ${name}`);
    assert.ok(skill.includes(name), `document ${name} in skills/scribe/SKILL.md`);
  }
  const docs = skillDocs("theme");
  assert.equal(docs.error, undefined);
  assert.match(docs.text, /^### Theme/);
  assert.match(docs.text, /--text/);
});

test("the scribe skill documents every member of window.scribe", () => {
  const docs = fs.readdirSync(SKILL_DIR).filter((name) => name.endsWith(".md")).map((name) => fs.readFileSync(path.join(SKILL_DIR, name), "utf8")).join("\n");
  const apis: Array<[prefix: string, start: string]> = [
    ["scribe.", "window.scribe = {"],
    ["scribe.agent.", "var agent = {"],
    ["scribe.permissions.", "var permissions = {"],
    ["scribe.ml.", "var ml = {"],
    ["scribe.audio.", "var audio = {"],
  ];
  for (const [prefix, start] of apis) {
    const keys = objectKeys(start);
    assert.ok(keys.length > 1, `found no keys in ${start}`);
    const missing = keys.filter((key) => !docs.includes(prefix + key));
    assert.deepEqual(missing, [], `document these in skills/scribe: ${missing.map((key) => prefix + key).join(", ")}`);
  }
  assert.ok(objectKeys("window.scribe = {").includes("preview"));
});

const SAMPLE = `---
name: scribe
---

# Scribe

Intro text.

## Show

Show it.

### Patch

Patch it.

\`\`\`md
## Not a heading
\`\`\`

## Wait

Wait for it.
`;

test("splitSections nests ### in ## and skips fenced headings", () => {
  const { intro, sections } = splitSections(SAMPLE);
  assert.equal(intro, "# Scribe\n\nIntro text.");
  assert.deepEqual(
    sections.map((section) => section.heading),
    ["Show", "Patch", "Wait"]
  );
  assert.match(sections[0].text, /Patch it\.[\s\S]*## Not a heading/);
  assert.doesNotMatch(sections[0].text, /Wait for it/);
});

const TEMPLATES = "# Templates\n\nNote.\n\n## Tools\n\nUse them.";
const AGENT = "# Pages that use the agent\n\nStart chats.\n\n## Agent runs\n\nRun them.";

test("skillDocs serves contents, sections in every file, files by name, lists and all", () => {
  const files: Record<string, string> = { "SKILL.md": SAMPLE, "TEMPLATES.md": TEMPLATES, "PAGE-AGENT.md": AGENT };
  const read = (name: string) => files[name] ?? null;
  const list = () => ["PAGE-AGENT.md", "TEMPLATES.md"];
  const contents = skillDocs(undefined, read, list);
  assert.match(contents.text, /Intro text\.[\s\S]*- Show\n {2}- Patch\n- Wait/);
  assert.match(contents.text, /PAGE-AGENT\.md: Pages that use the agent\n- Agent runs/);
  assert.match(contents.text, /TEMPLATES\.md: Templates\n- Tools/);
  assert.equal(skillDocs("patch", read, list).text, "### Patch\n\nPatch it.\n\n```md\n## Not a heading\n```");
  // "Show" holds "Patch", so a query matching both returns the section once.
  assert.equal(skillDocs("h", read, list).text.match(/Patch it/g)?.length, 1);
  // A heading in a reference file, and a reference file by its # title (once, with its sections).
  assert.equal(skillDocs("tools", read, list).text, "## Tools\n\nUse them.");
  assert.equal(skillDocs("pages that use", read, list).text, AGENT);
  assert.equal(skillDocs("agent", read, list).text.match(/Run them/g)?.length, 1);
  // A file by name, with or without .md.
  assert.equal(skillDocs("templates", read, list).text, TEMPLATES);
  assert.equal(skillDocs("page-agent.md", read, list).text, AGENT);
  const all = skillDocs("all", read, list).text;
  assert.ok(all.startsWith("# Scribe") && all.includes("Use them.") && all.includes("Run them."));
  // A list answers each topic in turn, and fails only when every one does.
  const both = skillDocs(["wait", "tools"], read, list);
  assert.equal(both.error, undefined);
  assert.equal(both.text, "=== wait ===\n\n## Wait\n\nWait for it.\n\n=== tools ===\n\n## Tools\n\nUse them.");
  assert.equal(skillDocs(["wait", "nope"], read, list).error, undefined);
  assert.equal(skillDocs(["nope", "nada"], read, list).error, true);
  assert.equal(skillDocs("nope", read, list).error, true);
  assert.equal(skillDocs(undefined, () => null, list).error, true);
});

test("skillDocs reads the repo's skill and its reference files", () => {
  const docs = skillDocs("Interactive pages");
  assert.equal(docs.error, undefined);
  assert.match(docs.text, /^## Interactive pages/);
  assert.match(skillDocs("page-scripts").text, /^# Page scripts/);
  assert.match(skillDocs().text, /PAGE-AGENT\.md: Pages that use the agent/);
});

test("SKILL.md fits skill_read's whole-file limit and indexes every reference file", () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  assert.ok(skill.length <= 24_000, `SKILL.md is ${skill.length} chars; skill_read returns 24,000 whole. Move detail into a reference file.`);
  for (const name of fs.readdirSync(SKILL_DIR).filter((f) => f.endsWith(".md") && f !== "SKILL.md")) {
    assert.ok(skill.includes(`\`${name}\``), `list ${name} in SKILL.md's table of reference files`);
    assert.match(fs.readFileSync(path.join(SKILL_DIR, name), "utf8"), /Builds on `SKILL\.md`/, `${name} should point back at SKILL.md`);
  }
});
