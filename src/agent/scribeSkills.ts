import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../config.js";
import { SKILL_DIR, sectionedRead } from "../skillDocs.js";
import { estimateTokens, skillFrontmatter } from "./harness.js";
import { noPages, type Thread } from "./types.js";

/**
 * Scribe's own skills (#239): folders in dataDir/skills/<id> with a SKILL.md, plus a row of metadata
 * each in agent.sqlite. Every provider gets the ones a thread may use through the scribe MCP
 * (skill_read) and a short list in its instructions. The folder's frontmatter is the source of
 * truth for name and description; the row caches them and keeps what the files cannot (enabled,
 * where the skill came from, revision). The built-in scribe skill is a virtual row on SKILL_DIR.
 */

export const BUILTIN_SCRIBE = "builtin:scribe";
const BUILTIN_SETTING = "skills.builtin.scribe.enabled";

/** Longest file skill_read returns, and the most a copied or imported skill folder may hold. */
const MAX_READ_BYTES = 512 * 1024;
/** Longest markdown file skill_read returns whole; a longer one comes as its opening sections and an outline (#918). */
const READ_WHOLE_CHARS = 24_000;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_FILES = 2000;

export type Provenance = { kind: "new" } | { kind: "copied"; from: string } | { kind: "imported"; from: string } | { kind: "found" };

export type SkillRow = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  provenance: Provenance;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** In the trash (its folder moved to dataDir/skills-trash/<id>) since then. */
  removedAt?: number;
};

export type ScribeSkill = SkillRow & {
  builtin?: true;
  /** The skill's folder (in the trash for a removed one), and its SKILL.md. */
  dir: string;
  file: string;
  /** Its folder or SKILL.md is gone. */
  missing?: true;
  indexTokens: number;
  bodyTokens: number;
  /** Other files in the folder. */
  files: number;
};

type Rows = {
  listSkillRows<T>(): T[];
  saveSkillRow(id: string, row: unknown): void;
  deleteSkillRow(id: string): void;
  getSetting<T>(key: string, fallback: T): T;
  setSetting(key: string, value: unknown): void;
};

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** A frontmatter value on one line, quoted when YAML would read it as something else. */
function yamlLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return /^[A-Za-z0-9][^:#"'\\]*$/.test(line) ? line : JSON.stringify(line);
}

function cleanName(name: unknown): string {
  const id = typeof name === "string" ? name.trim() : "";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error("Use lowercase letters, digits, dash or underscore for the name.");
  return id;
}

/** Files below a folder, without following links. */
function walk(dir: string, limit = MAX_IMPORT_FILES + 1): Array<{ rel: string; size: number }> {
  const out: Array<{ rel: string; size: number }> = [];
  const visit = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (out.length >= limit) return;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push({ rel: path.relative(dir, full), size: fs.statSync(full).size });
    }
  };
  try {
    visit(dir);
  } catch {
    /* unreadable */
  }
  return out;
}

/**
 * Copy a skill folder as plain files. Links inside it are left out, so a skill cannot reach past its
 * own folder once it is Scribe's; the folder itself may be a link (a linked provider skill).
 */
function copyFolder(from: string, to: string): void {
  const real = fs.realpathSync(from);
  const files = walk(real);
  if (files.length > MAX_IMPORT_FILES) throw new Error(`That folder has more than ${MAX_IMPORT_FILES} files; a skill folder should be small.`);
  if (files.reduce((sum, f) => sum + f.size, 0) > MAX_IMPORT_BYTES) throw new Error("That folder is over 50 MB; a skill folder should be small.");
  fs.cpSync(real, to, { recursive: true, errorOnExist: true, force: false, filter: (src) => !fs.lstatSync(src).isSymbolicLink() });
}

function moveFolder(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch {
    // Another drive: copy it over, then delete the original.
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

export class ScribeSkills {
  readonly root: string;
  readonly trash: string;
  readonly builtinDir: string;

  constructor(
    private rows: Rows,
    data = dataDir(),
    builtinDir = SKILL_DIR
  ) {
    this.root = path.join(data, "skills");
    this.trash = path.join(data, "skills-trash");
    this.builtinDir = builtinDir;
  }

  private all(): SkillRow[] {
    return this.rows.listSkillRows<SkillRow>();
  }

  private row(id: string): SkillRow {
    const row = this.all().find((r) => r.id === id);
    if (!row) throw new Error(id === BUILTIN_SCRIBE ? "The built-in skill cannot be changed here." : `Skill not found: ${id}`);
    return row;
  }

  dirOf(row: Pick<SkillRow, "id" | "removedAt">): string {
    return path.join(row.removedAt ? this.trash : this.root, row.id);
  }

  /** The Scribe skill (not the built-in) whose folder holds this file, if any. */
  ownerOf(file: string): string | null {
    const abs = path.resolve(file);
    if (!inside(this.root, abs)) return null;
    const id = path.relative(this.root, abs).split(path.sep)[0];
    return this.all().some((r) => r.id === id && !r.removedAt) ? id : null;
  }

  /** A file of the built-in skill: shown, never written. */
  isBuiltinFile(file: string): boolean {
    return inside(path.resolve(this.builtinDir), path.resolve(file));
  }

  /**
   * Bring the table in line with the folders: a folder without a row (put there by hand) gets one,
   * off; a row's name and description follow its SKILL.md. Run at startup.
   */
  scan(): void {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      /* no skills yet */
    }
    const known = new Map(this.all().map((r) => [r.id, r]));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const row = known.get(entry.name);
      if (row && !row.removedAt) this.refresh(row.id, false);
      else if (!row && fs.existsSync(path.join(this.root, entry.name, "SKILL.md"))) {
        const now = Date.now();
        this.save({ id: entry.name, name: entry.name, description: "", enabled: false, provenance: { kind: "found" }, revision: 1, createdAt: now, updatedAt: now });
        this.refresh(entry.name, false);
      }
    }
  }

  private save(row: SkillRow): void {
    this.rows.saveSkillRow(row.id, row);
  }

  /** Re-read a skill's frontmatter into its row; bump the revision when a file was saved. */
  refresh(id: string, edited = true): void {
    const row = this.row(id);
    let text = "";
    try {
      text = fs.readFileSync(path.join(this.dirOf(row), "SKILL.md"), "utf8");
    } catch {
      return;
    }
    const meta = skillFrontmatter(text);
    const next = { ...row, name: meta.name ?? row.name, description: meta.description ?? "" };
    if (edited) Object.assign(next, { revision: row.revision + 1, updatedAt: Date.now() });
    if (edited || next.name !== row.name || next.description !== row.description) this.save(next);
  }

  private builtinEnabled(): boolean {
    return this.rows.getSetting<boolean>(BUILTIN_SETTING, true) !== false;
  }

  private describe(row: SkillRow, dir: string, builtin = false): ScribeSkill {
    const file = path.join(dir, "SKILL.md");
    let text: string | null = null;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      /* missing */
    }
    return {
      ...row,
      ...(builtin ? { builtin: true as const } : {}),
      dir,
      file,
      ...(text == null ? { missing: true as const } : {}),
      indexTokens: estimateTokens(row.name.length + row.description.length),
      bodyTokens: estimateTokens(text?.length ?? 0),
      files: text == null ? 0 : Math.max(0, walk(dir, 500).length - 1),
    };
  }

  /** The built-in scribe skill, as the row it would have. */
  builtin(): ScribeSkill {
    let meta: { name?: string; description?: string } = {};
    try {
      meta = skillFrontmatter(fs.readFileSync(path.join(this.builtinDir, "SKILL.md"), "utf8"));
    } catch {
      /* missing */
    }
    const row: SkillRow = {
      id: BUILTIN_SCRIBE,
      name: meta.name ?? "scribe",
      description: meta.description ?? "",
      enabled: this.builtinEnabled(),
      provenance: { kind: "new" },
      revision: 1,
      createdAt: 0,
      updatedAt: 0,
    };
    return this.describe(row, this.builtinDir, true);
  }

  /** Every skill, built-in first; removed ones only with trash. */
  list(opts: { trash?: boolean } = {}): ScribeSkill[] {
    const rows = this.all()
      .filter((r) => Boolean(r.removedAt) === Boolean(opts.trash))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map((r) => this.describe(r, this.dirOf(r)));
    return opts.trash ? rows : [this.builtin(), ...rows];
  }

  private newId(): string {
    return `sk_${crypto.randomBytes(5).toString("hex")}`;
  }

  /** A new skill with a starting SKILL.md, off until the user enables or picks it. */
  create(name: unknown, description: unknown): ScribeSkill {
    const id = cleanName(name);
    const summary = typeof description === "string" ? description.replace(/\s+/g, " ").trim() : "";
    if (!summary) throw new Error("Say when an agent should use the skill: every chat it is given gets this description.");
    const row = this.add({ kind: "new" }, (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: ${yamlLine(summary)}\n---\n\n# ${id}\n\nWrite here what the agent should do when it uses this skill.\n`);
    });
    return this.describe(row, this.dirOf(row));
  }

  private add(provenance: Provenance, fill: (dir: string) => void): SkillRow {
    const id = this.newId();
    const dir = path.join(this.root, id);
    fs.mkdirSync(this.root, { recursive: true });
    try {
      fill(dir);
      if (!fs.existsSync(path.join(dir, "SKILL.md"))) throw new Error("A skill folder needs a SKILL.md at its top.");
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    const meta = skillFrontmatter(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
    const now = Date.now();
    const row: SkillRow = { id, name: meta.name ?? id, description: meta.description ?? "", enabled: false, provenance, revision: 1, createdAt: now, updatedAt: now };
    this.save(row);
    return row;
  }

  /** A skill folder from anywhere (a provider skill, the built-in, a folder the user picked), copied in. */
  private copyIn(from: string, provenance: Provenance): ScribeSkill {
    const src = path.resolve(from);
    if (!fs.existsSync(path.join(src, "SKILL.md"))) throw new Error(`No SKILL.md in ${src}.`);
    if (src === path.resolve(this.root) || inside(this.root, src) || inside(this.trash, src)) throw new Error("That folder is already one of Scribe's skills; use Duplicate.");
    const row = this.add(provenance, (dir) => copyFolder(src, dir));
    return this.describe(row, this.dirOf(row));
  }

  /** Copy to Scribe: a provider or workspace skill (its SKILL.md), or the built-in. */
  copyFrom(skillFile: string): ScribeSkill {
    if (path.basename(skillFile) !== "SKILL.md") throw new Error("Not a skill's SKILL.md.");
    return this.copyIn(path.dirname(skillFile), { kind: "copied", from: path.dirname(skillFile) });
  }

  /** Import folder: a skill folder on disk (with SKILL.md at its top). */
  import(folder: unknown): ScribeSkill {
    if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error("Give the skill folder's full path.");
    if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Folder not found: ${folder}`);
    return this.copyIn(folder, { kind: "imported", from: path.resolve(folder) });
  }

  duplicate(id: string): ScribeSkill {
    if (id === BUILTIN_SCRIBE) return this.copyFrom(path.join(this.builtinDir, "SKILL.md"));
    const row = this.row(id);
    if (row.removedAt) throw new Error("Restore the skill first.");
    const copy = this.add({ kind: "copied", from: `scribe:${id}` }, (dir) => copyFolder(this.dirOf(row), dir));
    return this.describe(copy, this.dirOf(copy));
  }

  /** Export folder: the skill's folder copied to <into>/<name>. Returns that folder. */
  export(id: string, into: unknown): { dir: string } {
    if (typeof into !== "string" || !path.isAbsolute(into)) throw new Error("Give the full path of the folder to export into.");
    if (!fs.statSync(into, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Folder not found: ${into}`);
    const skill = id === BUILTIN_SCRIBE ? this.builtin() : this.describe(this.row(id), this.dirOf(this.row(id)));
    const name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(skill.name) ? skill.name : skill.id.replace(/[^A-Za-z0-9_-]/g, "-");
    const dir = path.join(path.resolve(into), name);
    if (fs.existsSync(dir)) throw new Error(`There is already a ${name} folder in ${into}.`);
    if (inside(this.root, dir) || inside(this.trash, dir)) throw new Error("Export to a folder outside Scribe's own skills.");
    copyFolder(skill.dir, dir);
    return { dir };
  }

  setEnabled(id: string, enabled: boolean): void {
    if (id === BUILTIN_SCRIBE) {
      this.rows.setSetting(BUILTIN_SETTING, enabled);
      return;
    }
    const row = this.row(id);
    if (row.enabled !== enabled) this.save({ ...row, enabled, updatedAt: Date.now() });
  }

  /** To the trash: the folder moves out of the skills folder and the row is kept to restore it. */
  remove(id: string): void {
    const row = this.row(id);
    if (row.removedAt) return;
    const from = this.dirOf(row);
    const next = { ...row, removedAt: Date.now() };
    if (fs.existsSync(from)) moveFolder(from, this.dirOf(next));
    this.save(next);
  }

  restore(id: string): ScribeSkill {
    const row = this.row(id);
    if (!row.removedAt) return this.describe(row, this.dirOf(row));
    const from = this.dirOf(row);
    const next: SkillRow = { ...row };
    delete next.removedAt;
    if (fs.existsSync(this.dirOf(next))) throw new Error(`A folder named ${id} is already in ${this.root}.`);
    if (fs.existsSync(from)) moveFolder(from, this.dirOf(next));
    this.save(next);
    return this.describe(next, this.dirOf(next));
  }

  /** Delete for good, from the trash only. */
  purge(id: string): void {
    const row = this.row(id);
    if (!row.removedAt) throw new Error("Remove the skill first; only skills in the trash are deleted.");
    fs.rmSync(this.dirOf(row), { recursive: true, force: true });
    this.rows.deleteSkillRow(id);
  }

  /**
   * What a thread may use: skills enabled for every chat, plus the ones picked for it (a worker's
   * picks are copied onto its threads). Threads without tools get none, and the built-in (which is
   * about pages) is left out where there are no pages.
   */
  effective(thread: Pick<Thread, "noTools" | "scope"> & { skills?: string[] }): ScribeSkill[] {
    if (thread.noTools) return [];
    const picks = new Set(thread.skills ?? []);
    return this.list().filter((s) => !s.missing && (s.enabled || picks.has(s.id)) && !(s.builtin && noPages(thread.scope)));
  }

  /**
   * skill_read: a skill's SKILL.md (with the list of its other files), or one of its files, for a
   * skill this thread may use. The file must resolve inside the skill's folder, links included.
   * A long markdown file, or one read with section, goes through sectionedRead.
   */
  read(thread: Parameters<ScribeSkills["effective"]>[0], name: unknown, file?: unknown, section?: unknown): { skill: string; file: string; text: string; files?: string[]; truncated?: boolean } {
    if (typeof name !== "string" || !name.trim()) throw new Error("name is required");
    const skills = this.effective(thread);
    const want = name.trim();
    const skill = skills.find((s) => s.id === want) ?? skills.find((s) => s.name === want) ?? skills.find((s) => s.name.toLowerCase() === want.toLowerCase());
    if (!skill) {
      const names = skills.map((s) => s.name);
      throw new Error(names.length ? `No skill "${want}" in this chat. Its skills: ${names.join(", ")}.` : "This chat has no Scribe skills.");
    }
    const rel = typeof file === "string" && file.trim() ? file.trim() : "SKILL.md";
    if (path.isAbsolute(rel)) throw new Error("file is a path inside the skill's folder, like references/api.md.");
    const base = fs.realpathSync(skill.dir);
    const target = path.resolve(skill.dir, rel);
    if (!inside(path.resolve(skill.dir), target)) throw new Error("file must be inside the skill's folder.");
    let real: string;
    try {
      real = fs.realpathSync(target);
    } catch {
      throw new Error(`No ${rel} in the ${skill.name} skill.`);
    }
    if (!inside(base, real)) throw new Error("file must be inside the skill's folder.");
    const stat = fs.statSync(real);
    const part = typeof section === "string" && section.trim() ? section.trim() : undefined;
    if (stat.isDirectory()) {
      if (part) throw new Error("section reads a markdown file's headings, not a folder.");
      const files = walk(real, 200).map((f) => f.rel.split(path.sep).join("/"));
      return { skill: skill.name, file: rel, text: files.length ? files.join("\n") : "(empty folder)" };
    }
    const buffer = fs.readFileSync(real);
    const truncated = buffer.length > MAX_READ_BYTES;
    let text = buffer.subarray(0, MAX_READ_BYTES).toString("utf8");
    if (part || /\.md$/i.test(rel)) {
      const sectioned = sectionedRead(text, part, READ_WHOLE_CHARS);
      if (sectioned.error) throw new Error(sectioned.text);
      text = sectioned.text;
    }
    const out: { skill: string; file: string; text: string; files?: string[]; truncated?: boolean } = { skill: skill.name, file: rel, text, ...(truncated ? { truncated } : {}) };
    if (rel === "SKILL.md" && !part) {
      const others = walk(base, 200)
        .map((f) => f.rel.split(path.sep).join("/"))
        .filter((f) => f !== "SKILL.md");
      if (others.length) out.files = others;
    }
    return out;
  }
}

/** The list of a thread's skills in its instructions. Empty when it has none. */
export function skillIndex(skills: Array<Pick<ScribeSkill, "id" | "name" | "description">>): string {
  if (!skills.length) return "";
  const counts = new Map<string, number>();
  for (const s of skills) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  const lines = skills.map((s) => {
    // Two skills with one name: the id tells them apart for skill_read.
    const name = (counts.get(s.name) ?? 0) > 1 ? `${s.name} (id: ${s.id})` : s.name;
    return `- ${name}: ${s.description.replace(/\s+/g, " ").trim() || "(no description)"}`;
  });
  return [
    "Skills: Scribe gives this chat the skills below (Scribe's own, apart from any skills your provider loads). Before a task one of them covers, read it with skill_read (name) and follow it; skill_read with file reads its other files.",
    "<skills>",
    ...lines,
    "</skills>",
  ].join("\n");
}
