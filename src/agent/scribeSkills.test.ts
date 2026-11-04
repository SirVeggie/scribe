import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BUILTIN_SCRIBE, ScribeSkills, skillIndex } from "./scribeSkills.js";
import { threadInstructions } from "./prompt.js";
import { SKILL_DIR } from "../skillDocs.js";
import type { Thread } from "./types.js";

/** An in-memory stand-in for AgentDb's skill rows and settings. */
function memoryRows() {
  const rows = new Map<string, unknown>();
  const settings = new Map<string, unknown>();
  return {
    listSkillRows: <T>() => [...rows.values()] as T[],
    saveSkillRow: (id: string, row: unknown) => void rows.set(id, JSON.parse(JSON.stringify(row))),
    deleteSkillRow: (id: string) => void rows.delete(id),
    getSetting: <T>(key: string, fallback: T) => (settings.has(key) ? (settings.get(key) as T) : fallback),
    setSetting: (key: string, value: unknown) => void settings.set(key, value),
  };
}

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-skills-"));
  const builtin = path.join(root, "builtin");
  fs.mkdirSync(builtin, { recursive: true });
  fs.writeFileSync(path.join(builtin, "SKILL.md"), "---\nname: scribe\ndescription: Build Scribe pages.\n---\n\n# Scribe\n");
  const skills = new ScribeSkills(memoryRows(), path.join(root, "data"), builtin);
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  return { root, skills, write, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const pageThread = { scope: { kind: "global" as const, ref: null } };

test("a new skill is off until enabled or picked; the built-in is on", () => {
  const { skills, done } = sandbox();
  try {
    const made = skills.create("release-notes", "Write release notes.");
    assert.equal(made.enabled, false);
    assert.match(made.id, /^sk_/);
    assert.deepEqual(skills.effective(pageThread).map((s) => s.id), [BUILTIN_SCRIBE]);
    assert.deepEqual(skills.effective({ ...pageThread, skills: [made.id] }).map((s) => s.name), ["scribe", "release-notes"]);
    skills.setEnabled(made.id, true);
    skills.setEnabled(BUILTIN_SCRIBE, false);
    assert.deepEqual(skills.effective(pageThread).map((s) => s.name), ["release-notes"]);
    // No tools, no skills; no pages, no built-in.
    skills.setEnabled(BUILTIN_SCRIBE, true);
    assert.deepEqual(skills.effective({ ...pageThread, noTools: true }), []);
    assert.deepEqual(skills.effective({ scope: { kind: "workspace", ref: "C:/x" } }).map((s) => s.name), ["release-notes"]);
    assert.throws(() => skills.create("Bad Name", "x"), /lowercase/);
    assert.throws(() => skills.create("ok", "  "), /description/);
  } finally {
    done();
  }
});

test("skill_read stays inside the thread's skills and each skill's folder", () => {
  const { root, skills, write, done } = sandbox();
  try {
    const made = skills.create("notes", "Notes.");
    write(path.join(made.dir, "refs", "api.md"), "API");
    write(path.join(root, "secret.txt"), "secret");
    const thread = { ...pageThread, skills: [made.id] };
    const read = skills.read(thread, "notes");
    assert.match(read.text, /name: notes/);
    assert.deepEqual(read.files, ["refs/api.md"]);
    assert.equal(skills.read(thread, "notes", "refs/api.md").text, "API");
    assert.equal(skills.read(thread, made.id, "refs/api.md").text, "API");
    assert.throws(() => skills.read(thread, "notes", "../../secret.txt"), /inside the skill's folder/);
    assert.throws(() => skills.read(thread, "notes", path.join(root, "secret.txt")), /path inside/);
    assert.throws(() => skills.read(pageThread, "notes"), /No skill "notes"/);
    assert.match(skills.read(pageThread, "scribe").text, /Build Scribe pages/);
  } finally {
    done();
  }
});

test("skill_read returns the built-in skill whole, sections on request, and finds sections in its reference files", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-skills-"));
  try {
    const skills = new ScribeSkills(memoryRows(), data, SKILL_DIR);
    const whole = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
    const first = skills.read(pageThread, "scribe");
    assert.equal(first.text, whole);
    assert.ok(first.files?.includes("TEMPLATES.md") && first.files.includes("PAGE-SCRIPTS.md"));
    const forms = skills.read(pageThread, "scribe", undefined, "forms for a card");
    assert.match(forms.text, /^### Forms for a card/);
    assert.ok(!forms.text.includes("### Page components"));
    assert.equal(skills.read(pageThread, "scribe", undefined, "all").text, whole);
    assert.equal(skills.read(pageThread, "scribe", "TEMPLATES.md").text, fs.readFileSync(path.join(SKILL_DIR, "TEMPLATES.md"), "utf8"));
    // A section SKILL.md does not have comes from the reference file that has it.
    const runs = skills.read(pageThread, "scribe", undefined, "agent runs");
    assert.match(runs.text, /^\(from PAGE-AGENT\.md\)\n\n## Agent runs/);
    assert.throws(() => skills.read(pageThread, "scribe", undefined, "no such heading"), /No section matches[\s\S]*- Page kit/);
    // Lists read several files or sections in one call.
    const two = skills.read(pageThread, "scribe", ["PAGE-SCRIPTS.md", "PAGE-AGENT.md"]);
    assert.match(two.text, /^=== PAGE-SCRIPTS\.md ===\n\n# Page scripts[\s\S]*=== PAGE-AGENT\.md ===\n\n# Pages that use the agent/);
    assert.equal(two.file, "PAGE-SCRIPTS.md, PAGE-AGENT.md");
    const sections = skills.read(pageThread, "scribe", undefined, ["theme", "no such heading"]);
    assert.match(sections.text, /=== SKILL\.md § theme ===\n\n### Theme[\s\S]*=== SKILL\.md § no such heading ===\n\nNo section matches/);
    assert.throws(() => skills.read(pageThread, "scribe", ["NOPE.md", "GONE.md"]), /No NOPE\.md[\s\S]*No GONE\.md/);
    assert.throws(() => skills.read(pageThread, "scribe", Array.from({ length: 9 }, (_, i) => `f${i}.md`)), /At most 8/);
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("skill_read still cuts a long file to its opening sections and an outline (#918)", () => {
  const { skills, write, done } = sandbox();
  try {
    const made = skills.create("long", "Long.");
    const section = (n: number) => `## Part ${n}\n\n${"x".repeat(5000)}\n`;
    write(path.join(made.dir, "SKILL.md"), `---\nname: long\ndescription: Long.\n---\n\n# Long\n\n${Array.from({ length: 8 }, (_, i) => section(i + 1)).join("\n")}`);
    skills.setEnabled(made.id, true);
    const first = skills.read(pageThread, "long");
    assert.ok(first.text.length < 30_000, `first read is ${first.text.length} chars`);
    assert.match(first.text, /## Part 1/);
    assert.match(first.text, /- Part 8 \(\d+k chars\)/);
  } finally {
    done();
  }
});

test("remove, restore, purge; scan adopts folders and follows edits", () => {
  const { skills, write, done } = sandbox();
  try {
    const made = skills.create("tidy", "Tidy up.");
    skills.remove(made.id);
    assert.equal(fs.existsSync(made.dir), false);
    assert.deepEqual(skills.list({ trash: true }).map((s) => s.id), [made.id]);
    assert.ok(!skills.list().some((s) => s.id === made.id));
    const back = skills.restore(made.id);
    assert.equal(fs.existsSync(back.file), true);
    assert.throws(() => skills.purge(made.id), /Remove the skill first/);
    skills.remove(made.id);
    skills.purge(made.id);
    assert.equal(skills.list({ trash: true }).length, 0);

    // A folder put there by hand gets a row, off.
    write(path.join(skills.root, "handmade", "SKILL.md"), "---\nname: handmade\ndescription: By hand.\n---\n");
    skills.scan();
    const found = skills.list().find((s) => s.id === "handmade");
    assert.equal(found?.enabled, false);
    assert.equal(found?.description, "By hand.");
    // An edit's frontmatter reaches the row, with a new revision.
    fs.writeFileSync(found!.file, "---\nname: renamed\ndescription: Changed.\n---\n");
    skills.refresh("handmade");
    const after = skills.list().find((s) => s.id === "handmade");
    assert.equal(after?.name, "renamed");
    assert.equal(after?.revision, 2);
    assert.equal(skills.ownerOf(path.join(skills.root, "handmade", "SKILL.md")), "handmade");
    assert.equal(skills.ownerOf(path.join(skills.root, "..", "x")), null);
  } finally {
    done();
  }
});

test("import, copy, duplicate and export copy plain files only", () => {
  const { root, skills, write, done } = sandbox();
  try {
    const src = path.join(root, "outside", "lint");
    write(path.join(src, "SKILL.md"), "---\nname: lint\ndescription: Lint.\n---\n");
    write(path.join(src, "rules.md"), "rules");
    try {
      fs.symlinkSync(path.join(root, "outside"), path.join(src, "escape"), "junction");
    } catch {
      /* no link rights: the rest still runs */
    }
    const imported = skills.import(src);
    assert.equal(imported.provenance.kind, "imported");
    assert.equal(fs.existsSync(path.join(imported.dir, "rules.md")), true);
    assert.equal(fs.existsSync(path.join(imported.dir, "escape")), false);
    assert.throws(() => skills.import("relative/path"), /full path/);
    assert.throws(() => skills.import(path.join(root, "outside")), /No SKILL.md/);
    assert.throws(() => skills.import(imported.dir), /already one of Scribe's/);

    const copied = skills.copyFrom(path.join(skills.builtinDir, "SKILL.md"));
    assert.equal(copied.name, "scribe");
    assert.equal(copied.enabled, false);
    const dup = skills.duplicate(imported.id);
    assert.notEqual(dup.id, imported.id);
    assert.equal(dup.name, "lint");

    const out = path.join(root, "export");
    fs.mkdirSync(out);
    const { dir } = skills.export(imported.id, out);
    assert.equal(dir, path.join(out, "lint"));
    assert.equal(fs.readFileSync(path.join(dir, "rules.md"), "utf8"), "rules");
    assert.throws(() => skills.export(imported.id, out), /already a lint folder/);
  } finally {
    done();
  }
});

test("the instructions list the thread's skills and point the built-in at skill_read", () => {
  assert.equal(skillIndex([]), "");
  const index = skillIndex([
    { id: "a", name: "same", description: "One." },
    { id: "b", name: "same", description: "Two." },
  ]);
  assert.match(index, /same \(id: a\): One\./);
  assert.match(index, /skill_read/);
  const thread = { id: "th_x", provider: "claude", mode: "board", approval: "board", scope: { kind: "global", ref: null }, cwd: null, web: "on", title: "t" } as unknown as Thread;
  const withBuiltin = threadInstructions(thread, { skills: [{ id: BUILTIN_SCRIBE, name: "scribe", description: "Pages.", builtin: true }] });
  assert.match(withBuiltin, /read the scribe skill with skill_read first/);
  assert.doesNotMatch(withBuiltin, /without it, scribe_docs/);
  assert.match(withBuiltin, /<skills>\n- scribe: Pages\.\n<\/skills>/);
  const without = threadInstructions(thread, {});
  assert.match(without, /without it, scribe_docs/);
  assert.doesNotMatch(without, /<skills>/);
});
