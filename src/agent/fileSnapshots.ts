import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../config.js";

/**
 * File versions for workspaces without git (an SVN checkout, a plain folder), so their
 * changes can still be compared in an external diff tool. Stored per thread, by content hash.
 */

/** Larger files are left out: agents rarely edit them and the copies would grow fast. */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

function threadDir(threadId: string): string {
  return path.join(dataDir(), "agent", "file-snapshots", threadId.replace(/[^\w-]/g, "_"));
}

/** Saves content and returns its id, or null when the file did not exist. Undefined when too large to keep. */
export function saveSnapshot(threadId: string, content: string | null): string | null | undefined {
  if (content === null) return null;
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_SNAPSHOT_BYTES) return undefined;
  const id = crypto.createHash("sha256").update(bytes).digest("hex");
  const dir = threadDir(threadId);
  const file = path.join(dir, id);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  return id;
}

export function readSnapshot(threadId: string, id: string | null): Buffer | null {
  if (id === null) return Buffer.alloc(0);
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  try {
    return fs.readFileSync(path.join(threadDir(threadId), id));
  } catch {
    return null;
  }
}

export function removeThreadSnapshots(threadId: string): void {
  fs.rmSync(threadDir(threadId), { recursive: true, force: true });
}
