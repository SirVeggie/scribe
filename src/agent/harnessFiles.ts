import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "../config.js";
import { skillFolders } from "./harness.js";

/**
 * What the agent harness view may change on disk (#495): the skills in the folders the providers
 * read, and the instruction files they load into every session. Nothing outside those is touched.
 */

const MAX_TEXT_CHARS = 1_000_000;

type Roots = { workspace: string | null; home?: string; data?: string };

function inside(root: string, file: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const same = (a: string, b: string) => path.relative(path.resolve(a), path.resolve(b)) === "";

/** Files a provider reads into every session by itself, whether or not they exist yet. */
export function instructionFiles(workspace: string | null, home = os.homedir()): string[] {
  const files = [path.join(home, ".claude", "CLAUDE.md")];
  if (workspace) {
    files.push(
      path.join(workspace, "CLAUDE.md"),
      path.join(workspace, "CLAUDE.local.md"),
      path.join(workspace, ".claude", "CLAUDE.md"),
      path.join(workspace, "AGENTS.md"),
      path.join(workspace, ".cursorrules")
    );
  }
  return files;
}

/** "skill" for a file in one of the skill folders, "instructions" for an instruction file, null for anything else. */
export function editableKind(file: string, { workspace, home = os.homedir(), data = dataDir() }: Roots): "skill" | "instructions" | null {
  if (!path.isAbsolute(file)) return null;
  if (instructionFiles(workspace, home).some((known) => same(known, file))) return "instructions";
  // A skill's file sits in the skill's own folder or below it, never loose in the folder of skills.
  if (skillFolders(workspace, home, data).some((folder) => inside(folder.dir, path.dirname(file)))) return "skill";
  return null;
}

function requireEditable(file: string, roots: Roots): "skill" | "instructions" {
  const kind = editableKind(file, roots);
  if (!kind) throw new Error("Scribe only changes skills and instruction files here.");
  return kind;
}

/** A text file small enough to edit in the view. */
export function readSmallText(file: string): string {
  const text = fs.readFileSync(file, "utf8");
  if (text.length > MAX_TEXT_CHARS) throw new Error("This file is too large to edit here.");
  return text;
}

export function readHarnessFile(file: string, roots: Roots): { path: string; kind: "skill" | "instructions"; text: string } {
  const kind = requireEditable(file, roots);
  const text = fs.readFileSync(file, "utf8");
  if (text.length > MAX_TEXT_CHARS) throw new Error("This file is too large to edit here.");
  return { path: file, kind, text };
}

export function writeHarnessFile(file: string, text: string, roots: Roots): { path: string } {
  requireEditable(file, roots);
  if (typeof text !== "string") throw new Error("text is required");
  if (text.length > MAX_TEXT_CHARS) throw new Error("This text is too large to save here.");
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  fs.writeFileSync(file, text);
  return { path: file };
}

function skillRoot(folder: string, roots: Roots): string {
  const root = skillFolders(roots.workspace, roots.home ?? os.homedir(), roots.data ?? dataDir()).find((known) => same(known.dir, folder));
  if (!root) throw new Error("Not one of the folders the providers read skills from.");
  return root.dir;
}

/** The folder of the skill whose SKILL.md this is. */
function skillDir(file: string, roots: Roots): string {
  const dir = path.dirname(file);
  if (path.basename(file) !== "SKILL.md") throw new Error("Not a skill's SKILL.md.");
  skillRoot(path.dirname(dir), roots);
  if (!fs.existsSync(file)) throw new Error(`Skill not found: ${file}`);
  return dir;
}

/** A frontmatter value on one line, quoted when YAML would read it as something else. */
function yamlLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return /^[A-Za-z0-9][^:#"'\\]*$/.test(line) ? line : JSON.stringify(line);
}

/** A new skill with a starting SKILL.md. Returns that file. */
export function createSkill(folder: string, name: string, description: string, roots: Roots): { file: string } {
  const root = skillRoot(folder, roots);
  const id = typeof name === "string" ? name.trim() : "";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error("Use lowercase letters, digits, dash or underscore for the name.");
  const summary = typeof description === "string" ? description.replace(/\s+/g, " ").trim() : "";
  if (!summary) throw new Error("Say when an agent should use the skill: every chat is sent this description.");
  const dir = path.join(root, id);
  if (fs.existsSync(dir)) throw new Error(`There is already a ${id} folder in ${root}.`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, `---\nname: ${id}\ndescription: ${yamlLine(summary)}\n---\n\n# ${id}\n\nWrite here what the agent should do when it uses this skill.\n`);
  return { file };
}

/** The whole skill folder, copied into another provider's folder of skills. Returns the copy's SKILL.md. */
export function copySkill(file: string, folder: string, roots: Roots): { file: string } {
  const from = skillDir(file, roots);
  const root = skillRoot(folder, roots);
  const to = path.join(root, path.basename(from));
  if (fs.existsSync(to)) throw new Error(`There is already a ${path.basename(from)} folder in ${root}.`);
  fs.mkdirSync(root, { recursive: true });
  // Follows a linked skill folder, so the copy is real files either way.
  fs.cpSync(fs.realpathSync(from), to, { recursive: true, errorOnExist: true });
  return { file: path.join(to, "SKILL.md") };
}

/**
 * Take a skill away from its provider. The folder is moved into Scribe's data folder rather than
 * deleted; a linked folder only loses the link, and what it points at stays as it is.
 */
export function removeSkill(file: string, roots: Roots): { kept: string | null } {
  const dir = skillDir(file, roots);
  if (fs.lstatSync(dir).isSymbolicLink()) {
    try {
      fs.unlinkSync(dir);
    } catch {
      // A Windows junction is removed as a folder.
      fs.rmdirSync(dir);
    }
    return { kept: null };
  }
  const trash = path.join(roots.data ?? dataDir(), "agent", "removed-skills");
  fs.mkdirSync(trash, { recursive: true });
  const kept = path.join(trash, `${path.basename(dir)}-${Date.now()}`);
  try {
    fs.renameSync(dir, kept);
  } catch {
    // Another drive: copy it over, then delete the original.
    fs.cpSync(dir, kept, { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { kept };
}
