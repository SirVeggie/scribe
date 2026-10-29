import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileChange } from "./types.js";

/** Git helpers for turn snapshots and diffs. Snapshots use a temp index, so the user's index and refs are never touched. */

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_PATCH_BYTES = 4 * 1024 * 1024;

/** error: why git gave no exit code of its own (a timeout, or it could not start). */
export type GitResult = { stdout: string; stderr: string; code: number; error?: string };

export function git(args: string[], cwd: string, options: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; maxBuffer?: number } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      ["-c", "core.quotepath=off", "-c", "core.safecrlf=false", ...args],
      {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...options.env },
        windowsHide: true,
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const exited = !err || typeof (err as { code?: unknown }).code === "number";
        const code = err ? (exited ? (err as unknown as { code: number }).code : 1) : 0;
        const error = exited ? undefined : (err as { killed?: boolean }).killed ? `git timed out after ${options.timeoutMs ?? 30_000} ms` : err!.message;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code, ...(error ? { error } : {}) });
      }
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

const repoCache = new Map<string, { repo: string | null; at: number }>();

/** Top level of the repository containing `cwd`, or null. */
export async function findRepo(cwd: string | null | undefined): Promise<string | null> {
  if (!cwd || !fs.existsSync(cwd)) {
    return null;
  }
  const cached = repoCache.get(cwd);
  if (cached && Date.now() - cached.at < 60_000) {
    return cached.repo;
  }
  const res = await git(["rev-parse", "--show-toplevel"], cwd, { timeoutMs: 5000 });
  const repo = res.code === 0 ? path.normalize(res.stdout.trim()) : null;
  repoCache.set(cwd, { repo, at: Date.now() });
  return repo;
}

/** The working copy as a tree object, including untracked files that are not ignored. */
export async function snapshotTree(repo: string): Promise<string | null> {
  const indexPath = await git(["rev-parse", "--git-path", "index"], repo, { timeoutMs: 5000 });
  const realIndex = indexPath.code === 0 ? path.resolve(repo, indexPath.stdout.trim()) : null;
  const tmp = path.join(os.tmpdir(), `scribe-index-${crypto.randomBytes(6).toString("hex")}`);
  try {
    if (realIndex && fs.existsSync(realIndex)) {
      fs.copyFileSync(realIndex, tmp);
    }
    const env = { GIT_INDEX_FILE: tmp };
    const add = await git(["add", "-A", "--", "."], repo, { env, timeoutMs: 60_000 });
    if (add.code !== 0) {
      return null;
    }
    const tree = await git(["write-tree"], repo, { env, timeoutMs: 30_000 });
    return tree.code === 0 ? tree.stdout.trim() : null;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Windows can still hold the file for a moment; it is a small temp file.
    }
  }
}

export async function headTree(repo: string, rev = "HEAD"): Promise<string> {
  const res = await git(["rev-parse", "--verify", "--quiet", `${rev}^{tree}`], repo, { timeoutMs: 5000 });
  return res.code === 0 && res.stdout.trim() ? res.stdout.trim() : EMPTY_TREE;
}

export async function branchName(repo: string): Promise<string | null> {
  const res = await git(["rev-parse", "--abbrev-ref", "HEAD"], repo, { timeoutMs: 5000 });
  return res.code === 0 ? res.stdout.trim() : null;
}

/** Files that differ between two trees, with line counts. */
export async function diffTrees(repo: string, from: string, to: string): Promise<FileChange[]> {
  if (from === to) {
    return [];
  }
  const [numstat, names] = await Promise.all([
    git(["diff", "--no-ext-diff", "--no-color", "-M", "--numstat", "-z", from, to], repo),
    git(["diff", "--no-ext-diff", "--no-color", "-M", "--name-status", "-z", from, to], repo),
  ]);
  for (const result of [numstat, names]) {
    if (result.code !== 0) throw new Error(`Could not compare saved changes: ${result.error || result.stderr.trim() || "git diff failed"}`);
  }
  const counts = new Map<string, { added: number; removed: number; binary: boolean }>();
  const parts = numstat.stdout.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry) continue;
    const [addedRaw, removedRaw, rest] = entry.split("\t");
    let file = rest;
    if (rest === "") {
      // Rename: old and new paths follow as separate fields.
      i += 2;
      file = parts[i];
    }
    if (file === undefined) continue;
    const binary = addedRaw === "-";
    counts.set(file, { added: binary ? 0 : Number(addedRaw) || 0, removed: binary ? 0 : Number(removedRaw) || 0, binary });
  }
  const changes: FileChange[] = [];
  const fields = names.stdout.split("\0");
  for (let i = 0; i < fields.length; ) {
    const code = fields[i];
    if (!code) {
      i += 1;
      continue;
    }
    const kind = code[0];
    if (kind === "R" || kind === "C") {
      const oldPath = fields[i + 1];
      const newPath = fields[i + 2];
      const c = counts.get(newPath);
      changes.push({ path: newPath, oldPath, status: "R", added: c?.added ?? 0, removed: c?.removed ?? 0, ...(c?.binary ? { binary: true } : {}) });
      i += 3;
      continue;
    }
    const file = fields[i + 1];
    const c = counts.get(file);
    changes.push({
      path: file,
      status: kind === "A" ? "A" : kind === "D" ? "D" : "M",
      added: c?.added ?? 0,
      removed: c?.removed ?? 0,
      ...(c?.binary ? { binary: true } : {}),
    });
    i += 2;
  }
  return changes;
}

/** Unified patch between two trees, optionally for some paths only. Large patches are cut off. */
export async function diffPatch(repo: string, from: string, to: string, paths: string[] = []): Promise<{ patch: string; truncated: boolean }> {
  const res = await git(["diff", "--no-ext-diff", "--no-color", "-M", from, to, "--", ...paths], repo);
  if (res.code !== 0) throw new Error(`Could not read saved changes: ${res.error || res.stderr.trim() || "git diff failed"}`);
  if (res.stdout.length > MAX_PATCH_BYTES) {
    return { patch: res.stdout.slice(0, MAX_PATCH_BYTES), truncated: true };
  }
  return { patch: res.stdout, truncated: false };
}

/** A file's content in a tree, or null if it is not there. */
export async function fileAtTree(repo: string, tree: string, file: string): Promise<string | null> {
  const rel = file.replaceAll("\\", "/");
  const res = await git(["cat-file", "blob", `${tree}:${rel}`], repo, { timeoutMs: 10_000 });
  return res.code === 0 ? res.stdout : null;
}

/** Working copy against HEAD (or another commit), untracked files included. */
export async function workingChanges(repo: string, base = "HEAD"): Promise<{ head: string; tree: string; files: FileChange[]; branch: string | null } | null> {
  const [head, tree, branch] = await Promise.all([headTree(repo, base), snapshotTree(repo), branchName(repo)]);
  if (!tree) {
    return null;
  }
  return { head, tree, files: await diffTrees(repo, head, tree), branch };
}

/** Undo a turn: apply the reverse of from→to onto the working copy. Checks first so a conflict changes nothing. */
export async function revertTrees(repo: string, from: string, to: string): Promise<{ ok: boolean; error?: string }> {
  const reverse = await git(["diff", "--no-ext-diff", "--no-color", "--binary", to, from], repo);
  if (!reverse.stdout.trim()) {
    return { ok: true };
  }
  const check = await git(["apply", "--check", "--whitespace=nowarn", "-"], repo, { input: reverse.stdout });
  if (check.code !== 0) {
    return { ok: false, error: check.stderr.trim() || "The files changed since this turn, so the revert does not apply cleanly." };
  }
  const apply = await git(["apply", "--whitespace=nowarn", "-"], repo, { input: reverse.stdout });
  return apply.code === 0 ? { ok: true } : { ok: false, error: apply.stderr.trim() };
}

/** Path relative to the repo, with forward slashes, or null when outside it. */
export function repoRelative(repo: string, file: string): string | null {
  const abs = path.resolve(repo, file);
  const rel = path.relative(repo, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return rel.replaceAll("\\", "/");
}
