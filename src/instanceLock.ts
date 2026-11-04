import fs from "node:fs";
import path from "node:path";

/**
 * One daemon per data folder (#985). A second daemon on the same home used to open agent.sqlite and run the
 * startup cleanup (deleting temporary and Help chats, cancelling running turns) before failing to listen, which
 * broke the running daemon's chats. The daemon takes this lock before it touches any data.
 */

type LockInfo = { pid: number; port?: number; at: number };

export type LockResult = { ok: true; release: () => void } | { ok: false; owner: LockInfo };

/** A lock whose owner is alive but never got its port up this long is from a reused process id. */
const STALE_MS = 2 * 60_000;

export function lockFile(dir: string): string {
  return path.join(dir, "daemon.lock");
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(file: string): LockInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8")) as LockInfo;
    return Number.isInteger(info.pid) ? info : null;
  } catch {
    return null;
  }
}

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export type LockOptions = {
  port?: number;
  /** Whether a daemon answers on the owner's port: a live owner that answers is never stale. */
  answers?: (port: number) => Promise<boolean>;
  /** How long to wait for a live owner that does not answer (one stopping or starting) to let go. */
  waitMs?: number;
  now?: () => number;
};

/** Takes the data folder's daemon lock, or reports the live daemon that holds it. */
export async function acquireInstanceLock(dir: string, options: LockOptions = {}): Promise<LockResult> {
  const file = lockFile(dir);
  const now = options.now ?? Date.now;
  const deadline = now() + (options.waitMs ?? 15_000);
  fs.mkdirSync(dir, { recursive: true });
  for (;;) {
    const mine: LockInfo = { pid: process.pid, ...(options.port ? { port: options.port } : {}), at: now() };
    try {
      fs.writeFileSync(file, JSON.stringify(mine), { flag: "wx" });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (readLock(file)?.pid === process.pid) fs.rmSync(file, { force: true });
      };
      process.once("exit", release);
      return { ok: true, release };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const owner = readLock(file);
    // An empty file is one being written right now.
    if (!owner && now() < deadline && Date.now() - mtime(file) < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    // A lock the same process took before (a restart in place) is this daemon's.
    if (owner && owner.pid !== process.pid && alive(owner.pid)) {
      if (owner.port && options.answers && (await options.answers(owner.port))) return { ok: false, owner };
      if (now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (now() - owner.at < STALE_MS) return { ok: false, owner };
    }
    // A crashed owner, a reused process id or a torn file: take the lock over, unless someone just did.
    const again = readLock(file);
    if (again && owner && (again.pid !== owner.pid || again.at !== owner.at)) continue;
    fs.rmSync(file, { force: true });
  }
}
