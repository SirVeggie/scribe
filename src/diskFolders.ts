import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { safeFileName, samePath, skippedDirName } from "./filePages.js";
import { log } from "./log.js";

/**
 * Library folders on disk (#707): a folder can stand for a disk folder (Folder.disk), its
 * subfolders inherit `<parent>\<name>`, new files are created there, a file page moved into one
 * moves its file, and the disk folders are watched so files added outside Scribe get pages.
 */

/** Where new files go and what deleting a file page does, kept in the board's meta table. */
export type FileSettings = {
  /** Folder for new files when the target Library folder has no disk location. */
  defaultLocation?: string;
  /** Deleting a file page: ask each time (unset), always move the file to the Recycle Bin, or keep it. */
  deleteFiles?: "trash" | "keep";
};

export function normalizeFileSettings(raw: unknown): FileSettings {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: FileSettings = {};
  if (typeof input.defaultLocation === "string" && input.defaultLocation.trim()) {
    out.defaultLocation = path.resolve(input.defaultLocation.trim());
  }
  if (input.deleteFiles === "trash" || input.deleteFiles === "keep") {
    out.deleteFiles = input.deleteFiles;
  }
  return out;
}

/** A new file needs a disk folder and neither the Library folder nor the default gives one. */
export class NeedsLocationError extends Error {
  readonly needsLocation = true;
  constructor() {
    super("Choose where new files go");
  }
}

/** A file of that name is already in the disk folder a page is moved into. */
export class FileExistsError extends Error {
  readonly exists = true;
  constructor(readonly target: string) {
    super(`${path.basename(target)} is already in ${path.dirname(target)}`);
  }
}

/** Another Library folder already stands for that disk folder (a file has one page). */
export class DiskLinkTakenError extends Error {
  constructor(readonly folderId: string, folderName: string) {
    super(`The Library folder ${folderName} is already on that disk folder`);
  }
}

export function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `child` is `parent` or inside it. */
export function within(parent: string, child: string): boolean {
  // path.relative ignores case on Windows, like samePath.
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/** `name.ext` in dir, or `name 2.ext`, `name 3.ext`… when taken. */
export function uniqueFileName(dir: string, name: string): string {
  const clean = safeFileName(name);
  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  for (let n = 1; n < 10_000; n++) {
    const candidate = path.join(dir, n === 1 ? clean : `${stem} ${n}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`no free file name for ${clean} in ${dir}`);
}

/** Create an empty file that must not exist yet (and its folder, when needed). */
export function createEmptyFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "", { flag: "wx" });
}

/** Move a file, across drives too (rename fails there with EXDEV). The target must not exist. */
export function moveFile(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to) && !samePath(from, to)) {
    throw new FileExistsError(to);
  }
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(from);
  }
}

/** Move a file to the Recycle Bin (Windows) or the desktop's trash; rejects when that is not possible. */
export function recycleFile(file: string): Promise<void> {
  const run = (cmd: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile(cmd, args, { windowsHide: true, timeout: 30_000 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim() || "could not move the file to the trash"));
        else resolve();
      });
    });
  if (!fs.existsSync(file)) return Promise.resolve();
  if (process.platform === "win32") {
    // The path goes in through the environment, so no quoting reaches the script.
    const script = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:SCRIBE_RECYCLE, 'OnlyErrorDialogs', 'SendToRecycleBin')";
    return new Promise<void>((resolve, reject) => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30_000, env: { ...process.env, SCRIBE_RECYCLE: file } }, (err, _stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim() || "could not move the file to the Recycle Bin"));
        else resolve();
      });
    });
  }
  if (process.platform === "darwin") {
    return run("osascript", ["-e", `tell application "Finder" to delete POSIX file ${JSON.stringify(file)}`]);
  }
  return run("gio", ["trash", file]);
}

/**
 * The disk folders worth one recursive watcher each: every folder's own link, minus the ones that
 * equal or sit under another (those share its watcher), and minus ones that are not there.
 */
export function watchRoots(paths: string[]): string[] {
  const unique: string[] = [];
  for (const raw of paths) {
    const p = path.resolve(raw);
    if (!unique.some((u) => samePath(u, p))) unique.push(p);
  }
  unique.sort((a, b) => a.length - b.length);
  const roots: string[] = [];
  for (const p of unique) {
    if (!roots.some((root) => within(root, p))) roots.push(p);
  }
  return roots;
}

/** Whether a changed path, relative to its watch root, is one Library pages skip (hidden, dependencies). */
export function skippedRelative(rel: string): boolean {
  return rel.split(/[\\/]+/).some((part) => part.startsWith(".") || skippedDirName(part));
}

export type DiskChangeSink = {
  /** The disk folders to watch (each folder's own link). */
  diskLinks(): string[];
  /** Paths that changed under a watch root, batched. */
  diskChanged(paths: string[]): void;
  /** A root's watcher started (again): bring the Library up to date with what is on disk. */
  reconcileDisk(root: string): void;
};

const BATCH_MS = 300;

/** One recursive fs.watch per watch root; changes reach the store in batches (#707). */
export class DiskWatcher {
  private watchers = new Map<string, fs.FSWatcher>();
  private failed = new Set<string>();
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly sink: DiskChangeSink) {}

  /** Roots whose watcher failed: the Library shows them as not watched (Rescan still works). */
  failedRoots(): string[] {
    return [...this.failed];
  }

  /** Recompute the roots soon (the folder links changed). */
  syncSoon(): void {
    if (this.stopped || this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.sync();
    }, 50);
    this.syncTimer.unref?.();
  }

  sync(): void {
    if (this.stopped) return;
    const roots = watchRoots(this.sink.diskLinks()).filter(isDir);
    for (const [root, watcher] of this.watchers) {
      if (!roots.some((r) => samePath(r, root))) {
        watcher.close();
        this.watchers.delete(root);
      }
    }
    for (const root of [...this.failed]) {
      if (!roots.some((r) => samePath(r, root))) this.failed.delete(root);
    }
    for (const root of roots) {
      if ([...this.watchers.keys()].some((r) => samePath(r, root)) || this.failed.has(root)) continue;
      this.start(root);
    }
  }

  private start(root: string): void {
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, name) => {
        if (!name) return;
        const rel = String(name);
        if (skippedRelative(rel)) return;
        this.pending.add(path.join(root, rel));
        this.schedule();
      });
    } catch (err) {
      this.fail(root, err);
      return;
    }
    watcher.on("error", (err) => {
      watcher.close();
      this.watchers.delete(root);
      this.fail(root, err);
    });
    this.watchers.set(root, watcher);
    this.failed.delete(root);
    try {
      this.sink.reconcileDisk(root);
    } catch (err) {
      log(`disk folder scan failed for ${root}: ${(err as Error).message}`);
    }
  }

  private fail(root: string, err: unknown): void {
    this.failed.add(root);
    log(`not watching ${root}: ${(err as Error)?.message ?? err}`);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), BATCH_MS);
    this.timer.unref?.();
  }

  /** Hand the pending batch to the store now (tests, shutdown). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.size) return;
    const batch = [...this.pending];
    this.pending.clear();
    try {
      this.sink.diskChanged(batch);
    } catch (err) {
      log(`disk change handling failed: ${(err as Error).message}`);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}
