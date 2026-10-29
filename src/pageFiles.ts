import fs from "node:fs";
import path from "node:path";
import { FILES_PERMISSION, checkPermission, isInside, type PermissionGrant } from "./pagePermissions.js";

/**
 * scribe.files (#882): a page's own code reads and saves files in folders the user approved for it,
 * each at Read, Write, or Read & write. Every path is checked twice: as given, and with links
 * resolved, so a link inside an approved folder cannot lead out of it.
 */

export type FileOp = "read" | "list" | "stat" | "write" | "delete";

/** What each operation needs: listing and stat are reads; deleting is a write. */
const NEEDS: Record<FileOp, "read" | "write"> = { read: "read", list: "read", stat: "read", write: "write", delete: "write" };

export class PageFileError extends Error {
  constructor(
    readonly code: "permission" | "denied" | "invalid_path" | "not_found" | "exists" | "is_directory" | "not_directory" | "too_large" | "not_empty",
    message: string
  ) {
    super(message);
  }
}

/** The path with its existing part's links resolved; the part that does not exist yet is kept as given. */
function realish(target: string): string {
  let existing = target;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * The absolute path a page may use for op, or a PageFileError: "permission" when the user has not
 * approved a folder for it yet (scribe.files.request asks), "denied" when they refused.
 */
export function resolvePageFile(grants: Map<string, PermissionGrant>, raw: unknown, op: FileOp): string {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0") || !path.isAbsolute(raw.trim())) {
    throw new PageFileError("invalid_path", "path must be an absolute path");
  }
  const target = path.resolve(raw.trim());
  const want = NEEDS[op];
  const result = checkPermission(grants, { perm: FILES_PERMISSION, folder: target, approval: want });
  if (result !== "allow") {
    throw new PageFileError(result === "deny" ? "denied" : "permission", `This page has no ${want} access to ${target}`);
  }
  const grant = grants.get(FILES_PERMISSION)!;
  const folders = grant.folders ?? [];
  const real = realish(target);
  const realGrants = new Map(grants).set(FILES_PERMISSION, { ...grant, folders: folders.map((folder) => ({ ...folder, path: realish(folder.path) })) });
  if (checkPermission(realGrants, { perm: FILES_PERMISSION, folder: real, approval: want }) !== "allow") {
    throw new PageFileError("denied", `${target} leads outside the approved folders`);
  }
  if (want === "write" && folders.some((folder) => isInside(folder.path, target))) {
    throw new PageFileError("invalid_path", "An approved folder itself cannot be written or deleted");
  }
  return real;
}

function statOf(file: string): fs.Stats {
  try {
    return fs.statSync(file);
  } catch {
    throw new PageFileError("not_found", `${file} does not exist`);
  }
}

export type FileEntry = { name: string; kind: "file" | "directory"; size: number; mtime: number };

function entryOf(name: string, stat: fs.Stats): FileEntry {
  return { name, kind: stat.isDirectory() ? "directory" : "file", size: stat.isDirectory() ? 0 : stat.size, mtime: Math.round(stat.mtimeMs) };
}

export function statPageFile(file: string): FileEntry {
  return entryOf(path.basename(file), statOf(file));
}

export function listPageFolder(dir: string): FileEntry[] {
  if (!statOf(dir).isDirectory()) throw new PageFileError("not_directory", `${dir} is not a folder`);
  const entries: FileEntry[] = [];
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    try {
      entries.push(entryOf(dirent.name, fs.statSync(path.join(dir, dirent.name))));
    } catch {
      // A broken link or a file removed meanwhile.
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function readPageFile(file: string, maxBytes: number): Buffer {
  const stat = statOf(file);
  if (stat.isDirectory()) throw new PageFileError("is_directory", `${file} is a folder`);
  if (stat.size > maxBytes) throw new PageFileError("too_large", `${file} is larger than ${maxBytes} bytes`);
  return fs.readFileSync(file);
}

/** Saves data, making missing folders on the way. overwrite: false refuses a file that is there; append adds to it. */
export function writePageFile(file: string, data: Buffer, opts: { append?: boolean; overwrite?: boolean } = {}): FileEntry {
  const existing = fs.existsSync(file) ? fs.statSync(file) : null;
  if (existing?.isDirectory()) throw new PageFileError("is_directory", `${file} is a folder`);
  if (existing && opts.overwrite === false && !opts.append) throw new PageFileError("exists", `${file} already exists`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (opts.append) fs.appendFileSync(file, data);
  else fs.writeFileSync(file, data);
  return statPageFile(file);
}

/** Deletes a file or an empty folder; a folder with files in it stays. */
export function deletePageFile(file: string): void {
  const stat = statOf(file);
  if (!stat.isDirectory()) {
    fs.unlinkSync(file);
    return;
  }
  try {
    fs.rmdirSync(file);
  } catch {
    throw new PageFileError("not_empty", `${file} is not empty`);
  }
}
