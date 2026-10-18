import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "../config.js";
import { log } from "../log.js";
import { syncDependencies } from "./deps.js";
import { git, snapshotTree } from "./git.js";
import { claudeDir } from "./permissions.js";
import type { ThreadWorktree } from "./types.js";

/**
 * Board-managed git worktrees: one per thread, on its own branch, outside the repo. The providers
 * only see a cwd, so turn snapshots, revert and resume work the same as in the main checkout.
 */

const DEFAULT_LINKS = ["node_modules"];
// Paths under %LOCALAPPDATA% plus a deep tree can pass Windows' 260-character limit.
const LONG = ["-c", "core.longpaths=true"];

export function worktreesDir(): string {
  return path.join(dataDir(), "worktrees");
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "thread";
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  const res = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo, { timeoutMs: 5000 });
  return res.code === 0;
}

export async function headCommit(dir: string): Promise<string | null> {
  const res = await git(["rev-parse", "--verify", "--quiet", "HEAD"], dir, { timeoutMs: 5000 });
  return res.code === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

async function currentBranch(dir: string): Promise<string | null> {
  const res = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], dir, { timeoutMs: 5000 });
  return res.code === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

/** Changed or untracked files, from `git status --porcelain`. */
async function dirtyFiles(dir: string): Promise<string[]> {
  const res = await git(["status", "--porcelain", "-z", "--untracked-files=normal"], dir, { timeoutMs: 30_000 });
  if (res.code !== 0) throw new Error(`Could not read worktree status: ${res.stderr.trim()}`);
  return res.stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3));
}

/** Folders to link in from the main checkout: Claude Code's worktree.symlinkDirectories, else node_modules. */
function linkList(repo: string): string[] {
  let list: string[] | null = null;
  for (const file of [path.join(claudeDir(), "settings.json"), path.join(repo, ".claude", "settings.json"), path.join(repo, ".claude", "settings.local.json")]) {
    try {
      const json = JSON.parse(fs.readFileSync(file, "utf8")) as { worktree?: { symlinkDirectories?: unknown } };
      const dirs = json.worktree?.symlinkDirectories;
      if (Array.isArray(dirs)) list = dirs.filter((d): d is string => typeof d === "string" && d.trim() !== "");
    } catch {
      /* missing or not JSON */
    }
  }
  return (list ?? DEFAULT_LINKS).map((d) => d.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")).filter((d) => d && !d.split("/").includes(".."));
}

/** Link folders from the main checkout. Junctions on Windows need no admin rights or Developer Mode. */
async function linkFolders(repo: string, worktree: string): Promise<string[]> {
  const linked: string[] = [];
  for (const rel of linkList(repo)) {
    const source = path.join(repo, rel);
    const target = path.join(worktree, rel);
    try {
      if (!fs.statSync(source).isDirectory() || fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
      linked.push(rel);
    } catch (err) {
      log(`Worktree link ${rel} failed: ${(err as Error).message}`);
    }
  }
  if (!linked.length) return linked;
  // Git sees a link as a file, so a "node_modules/" ignore rule does not cover it. Keep links out of status and snapshots.
  const shown = await git(["status", "--porcelain", "--untracked-files=normal", "--", ...linked], worktree, { timeoutMs: 30_000 });
  const missing = linked.filter((rel) => shown.stdout.split("\n").some((line) => line.slice(3).replace(/\/$/, "") === rel));
  if (missing.length) {
    const res = await git(["rev-parse", "--git-path", "info/exclude"], worktree, { timeoutMs: 5000 });
    if (res.code === 0) {
      const file = path.resolve(worktree, res.stdout.trim());
      const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const add = missing.map((rel) => `/${rel}`).filter((line) => !existing.split(/\r?\n/).includes(line));
      if (add.length) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${existing && !existing.endsWith("\n") ? "\n" : ""}# Linked into Scribe worktrees\n${add.join("\n")}\n`);
      }
    }
  }
  return linked;
}

export type CreatedWorktree = { worktree: ThreadWorktree; cwd: string; notes: string[] };

/** Make a worktree for a thread on a new branch from the main checkout's HEAD. `home` is the folder the user picked. */
export async function createWorktree(home: string, repo: string, title: string): Promise<CreatedWorktree> {
  const slug = slugify(title);
  const parent = path.join(worktreesDir(), `${slugify(path.basename(repo))}-${crypto.createHash("sha1").update(repo.toLowerCase()).digest("hex").slice(0, 6)}`);
  let branch = `agent/${slug}`;
  let dir = path.join(parent, slug);
  for (let n = 2; (await branchExists(repo, branch)) || fs.existsSync(dir); n += 1) {
    branch = `agent/${slug}-${n}`;
    dir = path.join(parent, `${slug}-${n}`);
  }
  return addWorktree(home, repo, branch, dir, false);
}

/**
 * Open a merged thread's worktree again for its next message: the same folder and branch name, from
 * the main checkout's HEAD now. Agent sessions are keyed by folder (Claude Code's are), so the same
 * folder lets the thread keep its session. sameFolder is false when that folder or branch is taken
 * by something not yet merged; the thread then gets a new worktree, like a first one.
 */
export async function reopenWorktree(old: ThreadWorktree, title: string): Promise<CreatedWorktree & { sameFolder: boolean }> {
  if (!fs.existsSync(old.path)) {
    const exists = await branchExists(old.repo, old.branch);
    // A branch the base already has (a merge whose empty branch wasn't dropped) can start over from HEAD.
    const merged = exists && (await git(["merge-base", "--is-ancestor", `refs/heads/${old.branch}`, "HEAD"], old.repo, { timeoutMs: 10_000 })).code === 0;
    if (!exists || merged) {
      return { ...(await addWorktree(old.home, old.repo, old.branch, old.path, exists)), sameFolder: true };
    }
  }
  return { ...(await createWorktree(old.home, old.repo, title)), sameFolder: false };
}

/** git worktree add on `branch` from the main checkout's HEAD (reset: the branch exists and starts over there), then link and note. */
async function addWorktree(home: string, repo: string, branch: string, dir: string, reset: boolean): Promise<CreatedWorktree> {
  const baseCommit = await headCommit(repo);
  if (!baseCommit) throw new Error("The repository has no commits yet, so there is nothing to branch a worktree from.");
  const base = await currentBranch(repo);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const add = await git([...LONG, "worktree", "add", reset ? "-B" : "-b", branch, dir, baseCommit], repo, { timeoutMs: 300_000 });
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`);
  const links = await linkFolders(repo, dir);
  const notes: string[] = [];
  if ((await dirtyFiles(repo)).length) {
    notes.push(`Uncommitted changes in the main checkout are not in the worktree; it starts from the last commit${base ? ` on ${base}` : ""}.`);
  }
  // The linked node_modules is the main checkout's, so it has to match the lockfile the worktree starts from.
  if (links.includes("node_modules")) {
    const synced = await syncDependencies(repo);
    if (synced) notes.push(synced);
  }
  const rel = path.relative(repo, home);
  const cwd = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? path.join(dir, rel) : dir;
  return {
    worktree: { home, repo, path: dir, branch, base, baseCommit, links, createdAt: Date.now() },
    cwd: fs.existsSync(cwd) ? cwd : dir,
    notes,
  };
}

export type WorktreeStatus = {
  exists: boolean;
  /** Uncommitted files in the worktree. */
  dirty: string[];
  /** Commits on the worktree branch with no equivalent patch on the current base. */
  ahead: number;
  /** The main checkout's branch, and whether merging can go ahead there. */
  mainBranch: string | null;
  mainDirty: number;
};

export async function worktreeStatus(wt: ThreadWorktree): Promise<WorktreeStatus> {
  const exists = fs.existsSync(wt.path);
  const [dirty, mainBranch, mainDirty] = await Promise.all([exists ? dirtyFiles(wt.path) : Promise.resolve([]), currentBranch(wt.repo), dirtyFiles(wt.repo)]);
  const ahead = (await branchExists(wt.repo, wt.branch)) ? await countAheadOf(wt) : 0;
  return { exists, dirty, ahead, mainBranch, mainDirty: mainDirty.length };
}

async function countAheadOf(wt: ThreadWorktree): Promise<number> {
  const from = wt.base && (await branchExists(wt.repo, wt.base)) ? wt.base : wt.baseCommit;
  // Keep unique merge commits: unlike git cherry (or --no-merges), this does not hide
  // changes introduced by a merge's conflict resolution.
  const res = await git(["rev-list", "--count", "--cherry-pick", "--right-only", `${from}...refs/heads/${wt.branch}`], wt.repo, { timeoutMs: 30_000 });
  const count = Number(res.stdout.trim());
  if (res.code !== 0 || !/^\d+$/.test(res.stdout.trim())) throw new Error(`Could not compare worktree commits: ${res.stderr.trim()}`);
  return count;
}

/** Commits and uncommitted changes, cheap enough to refresh after each turn. */
export async function worktreeProgress(wt: ThreadWorktree): Promise<{ ahead: number; dirty: boolean }> {
  if (!fs.existsSync(wt.path)) return { ahead: 0, dirty: false };
  const [ahead, dirty] = await Promise.all([countAheadOf(wt), dirtyFiles(wt.path)]);
  return { ahead, dirty: dirty.length > 0 };
}

/** Whether both the index and working copy's changes already exist in the committed base.
 * A private index keeps this independent of dirty files in the main checkout. Failed or
 * ambiguous checks keep the worktree; nothing is applied to either checkout's files/index.
 */
async function dirtyAlreadyLanded(wt: ThreadWorktree): Promise<boolean> {
  const base = wt.base ? `refs/heads/${wt.base}` : wt.baseCommit;
  const status = await git(["status", "--porcelain=v2", "-z", "--untracked-files=normal"], wt.path);
  // A tree snapshot cannot represent a submodule's uncommitted files.
  if (status.code !== 0 || status.stdout.split("\0").some((entry) => /^[12u] \S+ S/.test(entry))) return false;
  const staged = await git(["write-tree"], wt.path);
  const working = await snapshotTree(wt.path);
  if (staged.code !== 0 || !working) return false;
  const tmp = path.join(os.tmpdir(), `scribe-landed-${crypto.randomBytes(8).toString("hex")}`);
  const env = { GIT_INDEX_FILE: tmp };
  try {
    if ((await git(["read-tree", base], wt.repo, { env })).code !== 0) return false;
    for (const tree of new Set([staged.stdout.trim(), working])) {
      const patch = await git(["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "HEAD", tree], wt.path);
      if (patch.code !== 0) return false;
      if (!patch.stdout) continue;
      const check = await git(["apply", "--cached", "--reverse", "--check", "--whitespace=nowarn", "-"], wt.repo, { env, input: patch.stdout });
      if (check.code !== 0) return false;
    }
    return true;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Work still absent from the current base, for idle cleanup and its stale list. */
export async function worktreeRemaining(wt: ThreadWorktree): Promise<{ ahead: number; dirty: boolean }> {
  if ((await currentBranch(wt.path)) !== wt.branch) throw new Error("The worktree changed branches.");
  // Never clean up a paused rebase/merge, even when its current files appear to have landed.
  const dir = await git(["rev-parse", "--absolute-git-dir"], wt.path);
  if (dir.code !== 0 || !dir.stdout.trim()) throw new Error("Could not read the worktree's Git directory.");
  if (["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"].some((name) => fs.existsSync(path.join(dir.stdout.trim(), name)))) {
    throw new Error("The worktree has an unfinished Git operation.");
  }
  const progress = await worktreeProgress(wt);
  if (progress.dirty && await dirtyAlreadyLanded(wt)) progress.dirty = false;
  return progress;
}

/** Commit everything in the worktree so closing it loses nothing. Returns false when there was nothing to commit. */
export async function commitAll(wt: ThreadWorktree, message: string): Promise<boolean> {
  if (!fs.existsSync(wt.path) || !(await dirtyFiles(wt.path)).length) return false;
  const add = await git([...LONG, "add", "-A"], wt.path, { timeoutMs: 120_000 });
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const commit = await git(["commit", "--no-verify", "-q", "-m", message], wt.path, { timeoutMs: 60_000 });
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
  return true;
}

/** Remove the worktree folder. Links are cut first, so nothing in the main checkout is touched. */
export async function removeWorktree(wt: ThreadWorktree): Promise<void> {
  for (const rel of wt.links) {
    const link = path.join(wt.path, rel);
    try {
      if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
    } catch {
      /* already gone */
    }
  }
  if (fs.existsSync(wt.path)) {
    let last = "";
    // A provider process that just stopped can still hold the folder open on Windows for a moment.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const res = await git([...LONG, "worktree", "remove", "--force", wt.path], wt.repo, { timeoutMs: 120_000 });
      if (res.code === 0 || !fs.existsSync(wt.path)) break;
      last = res.stderr.trim();
      // Git may already have deregistered the worktree while a Windows process still
      // holds its empty folder open. Retrying Git cannot remove that leftover folder.
      if (last.includes("is not a working tree")) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (fs.existsSync(wt.path)) {
      try {
        fs.rmSync(wt.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch (err) {
        throw new Error(`Could not remove the worktree folder ${wt.path}: ${(err as Error).message}`);
      }
    }
  }
  await git(["worktree", "prune"], wt.repo, { timeoutMs: 30_000 });
}

/**
 * Cut the links in worktree folders no open thread uses. On Windows a plain `git worktree remove`
 * (or Explorer) deletes through a junction into the main checkout's node_modules, so a leftover
 * worktree must not keep one around for whoever cleans up by hand. Returns the links removed.
 */
export function unlinkOrphanedWorktrees(open: string[]): string[] {
  const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const inUse = new Set(open.map(norm));
  const cut: string[] = [];
  const list = (dir: string) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const repoDir of list(worktreesDir())) {
    if (!repoDir.isDirectory()) continue;
    for (const wtDir of list(path.join(worktreesDir(), repoDir.name))) {
      const dir = path.join(worktreesDir(), repoDir.name, wtDir.name);
      if (!wtDir.isDirectory() || inUse.has(norm(dir))) continue;
      for (const entry of list(dir)) {
        const link = path.join(dir, entry.name);
        try {
          if (!fs.lstatSync(link).isSymbolicLink()) continue;
          fs.unlinkSync(link);
          cut.push(link);
        } catch (err) {
          log(`Unlinking ${link} failed: ${(err as Error).message}`);
        }
      }
    }
  }
  return cut;
}

/** Discard a worktree, cutting shared links before removing its files and branch. */
export async function discardWorktree(wt: ThreadWorktree): Promise<boolean> {
  await removeWorktree(wt);
  if (!(await branchExists(wt.repo, wt.branch))) return true;
  const res = await git(["branch", "-D", wt.branch], wt.repo, { timeoutMs: 10_000 });
  return res.code === 0;
}

/** Delete the worktree's branch when it holds nothing the base does not. */
export async function dropBranchIfEmpty(wt: ThreadWorktree): Promise<boolean> {
  if (!(await branchExists(wt.repo, wt.branch)) || (await countAheadOf(wt)) > 0) return false;
  const res = await git(["branch", "-D", wt.branch], wt.repo, { timeoutMs: 10_000 });
  return res.code === 0;
}

/**
 * Rebase the worktree's branch onto its base when the base has moved on, so the merge is a fast-forward.
 * A rebase that stops on a conflict is aborted and the branch stays as it was; the merge then tries it.
 */
async function rebaseOntoBase(wt: ThreadWorktree, base: string): Promise<boolean> {
  if (!fs.existsSync(wt.path) || (await currentBranch(wt.path)) !== wt.branch) return false;
  const behind = await git(["rev-list", "--count", `HEAD..${base}`], wt.path, { timeoutMs: 10_000 });
  if (behind.code !== 0 || !(Number(behind.stdout.trim()) > 0)) return false;
  const res = await git([...LONG, "rebase", "--no-verify", base], wt.path, { timeoutMs: 120_000 });
  if (res.code === 0) return true;
  await git(["rebase", "--abort"], wt.path, { timeoutMs: 30_000 });
  return false;
}

/**
 * Merge the worktree's branch into its base in the main checkout, rebasing it onto the base first
 * when it can. Leaves everything as it was if the merge fails.
 */
export async function mergeWorktree(wt: ThreadWorktree): Promise<{ commits: number }> {
  if (!wt.base) throw new Error("The worktree was made from a detached HEAD, so there is no branch to merge into. Use Leave branch instead.");
  let status = await worktreeStatus(wt);
  if (status.dirty.length && !(await dirtyAlreadyLanded(wt))) {
    throw new Error(`The worktree has ${status.dirty.length} uncommitted file${status.dirty.length === 1 ? "" : "s"}. Ask the agent to commit them, or use Leave branch, which commits them for you.`);
  }
  if (status.mainBranch !== wt.base) {
    throw new Error(`The main checkout is on ${status.mainBranch ?? "a detached HEAD"}, not ${wt.base}. Switch it to ${wt.base} to merge.`);
  }
  if (!status.ahead) return { commits: 0 };
  if (await rebaseOntoBase(wt, wt.base)) {
    status = await worktreeStatus(wt);
    if (!status.ahead) return { commits: 0 };
  }
  const res = await git(["merge", "--no-edit", wt.branch], wt.repo, { timeoutMs: 120_000 });
  if (res.code !== 0) {
    const mergeHead = await git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], wt.repo, { timeoutMs: 5000 });
    if (mergeHead.code === 0) await git(["merge", "--abort"], wt.repo, { timeoutMs: 30_000 });
    throw new Error(`The merge did not go through, so nothing changed: ${(res.stdout + res.stderr).trim().split("\n").slice(-4).join(" ")}`);
  }
  return { commits: status.ahead };
}

/** Undo a worktree turn's commits: move the branch back to `head`, keeping the files as they are. */
export async function resetHead(dir: string, head: string): Promise<{ ok: boolean; error?: string }> {
  const res = await git(["reset", "--mixed", "-q", head], dir, { timeoutMs: 60_000 });
  return res.code === 0 ? { ok: true } : { ok: false, error: res.stderr.trim() || "git reset failed" };
}
