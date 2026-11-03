import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import { git } from "../agent/git.js";
import { cleanMemories, mergeMemories, type Memory, type MemoryTombstone } from "../agent/memory.js";
import { workspaceKey } from "../agent/prefs.js";
import { peerCall } from "./copy.js";
import { peerDeviceOf } from "./link.js";
import type { PeerService } from "./peers.js";

/**
 * Memory sync between paired devices (#978). Each device sends its memories (all but the ones kept on
 * this device only) and its tombstones to every online paired device, which merges them as a set
 * (mergeMemories) and answers with its own, so one exchange brings both up to date. A change here
 * sends again, and a device that took something new passes it on to its other peers.
 *
 * Workspace memories travel by repository, not by path: the sender names the repository (its root
 * commits and origin URL) and the folder inside it, and the receiver puts them under its own clone of
 * that repository. A device without that repository leaves them out; folders outside git stay here.
 */

/** A memory on the wire: no thread (it means nothing elsewhere), and the repository instead of a path. */
export type WireMemory = Omit<Memory, "workspace" | "thread" | "local"> & { repo?: { id: string; path: string } };
export type MemorySyncBody = { memories: WireMemory[]; tombstones: MemoryTombstone[] };

export type MemorySyncHost = {
  enabled(): boolean;
  memories(): Memory[];
  tombstones(): MemoryTombstone[];
  replace(memories: Memory[], tombstones: MemoryTombstone[]): void;
  /** Folders this device works in, to find its clones of a repository. */
  folders(): string[];
  onChange(listener: () => void): void;
};

const SYNC_MS = 5 * 60_000;
const SOON_MS = 2000;
const REPO_CACHE_MS = 10 * 60_000;
const MAX_JSON = "4mb";

type Repo = { id: string; top: string; main: boolean };

/** An origin URL without protocol, user, port-colon or .git, so SSH and HTTPS clones match. */
export function normalizeRemote(url: string): string {
  let s = url.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z+]+:\/\//, "").replace(/^[^@/]+@/, "");
  // scp style: host:path
  s = s.replace(/^([^/:]+):(?!\d+\/)/, "$1/");
  s = s.replace(/^([^/:]+):\d+\//, "$1/");
  return s.replace(/\\/g, "/").replace(/\.git\/?$/, "").replace(/\/+$/, "");
}

/** Same root commits and origin: the same project, wherever it is checked out. */
export function repoIdentity(roots: string[], remote: string): string {
  return crypto.createHash("sha256").update(`${[...roots].sort().join(",")}\n${normalizeRemote(remote)}`).digest("hex").slice(0, 32);
}

const repoCache = new Map<string, { at: number; repo: Promise<Repo | null> }>();

/** The repository a folder is in, or null outside git (or a repository without commits). */
export function repoOf(folder: string): Promise<Repo | null> {
  const key = workspaceKey(folder);
  const cached = repoCache.get(key);
  if (cached && Date.now() - cached.at < REPO_CACHE_MS) return cached.repo;
  const repo = (async (): Promise<Repo | null> => {
    if (!fs.existsSync(folder)) return null;
    const dirs = await git(["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], folder, { timeoutMs: 10_000 });
    if (dirs.code !== 0) return null;
    const [top, gitDir, common] = dirs.stdout.split(/\r?\n/);
    if (!top) return null;
    const roots = await git(["rev-list", "--max-parents=0", "HEAD"], top, { timeoutMs: 20_000 });
    const ids = roots.code === 0 ? roots.stdout.split(/\s+/).filter(Boolean) : [];
    if (!ids.length) return null;
    const remote = await git(["config", "--get", "remote.origin.url"], top, { timeoutMs: 10_000 });
    // --git-common-dir may be relative to the folder git ran in.
    const main = !common || path.resolve(folder, common) === path.resolve(gitDir ?? "");
    return { id: repoIdentity(ids, remote.code === 0 ? remote.stdout : ""), top: path.normalize(top), main };
  })();
  repoCache.set(key, { at: Date.now(), repo });
  return repo;
}

/** A folder inside a repository, as a path the other device can join to its own clone. */
function inside(repo: Repo, folder: string): string | null {
  const rel = path.relative(repo.top, folder);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** This device's memories as it sends them. */
export async function outgoing(memories: Memory[], tombstones: MemoryTombstone[], repoFor: (folder: string) => Promise<Repo | null> = repoOf): Promise<MemorySyncBody> {
  const out: WireMemory[] = [];
  for (const m of memories) {
    if (m.local) continue;
    const { workspace, thread: _thread, local: _local, ...rest } = m;
    if (!workspace) {
      out.push(rest);
      continue;
    }
    const repo = await repoFor(workspace);
    const rel = repo && inside(repo, workspace);
    if (repo && rel !== null) out.push({ ...rest, repo: { id: repo.id, path: rel } });
  }
  return { memories: out, tombstones };
}

/** A device's memories with this device's folders; the ones whose repository is not here are left out. */
export async function incoming(body: unknown, folders: string[], repoFor: (folder: string) => Promise<Repo | null> = repoOf): Promise<{ memories: Memory[]; tombstones: MemoryTombstone[] }> {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const list = Array.isArray(input.memories) ? input.memories : [];
  const wanted = new Set(list.flatMap((m) => (m && typeof m === "object" && typeof (m as WireMemory).repo?.id === "string" ? [(m as WireMemory).repo!.id] : [])));
  // Each repository's checkout here: the main one over a worktree, then the first found.
  const tops = new Map<string, Repo>();
  if (wanted.size) {
    for (const repo of await Promise.all(folders.map((f) => repoFor(f).catch(() => null)))) {
      if (!repo || !wanted.has(repo.id)) continue;
      const seen = tops.get(repo.id);
      if (!seen || (!seen.main && repo.main)) tops.set(repo.id, repo);
    }
  }
  const placed: unknown[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const { repo, local: _local, thread: _thread, workspace: _workspace, ...m } = raw as WireMemory & { local?: unknown; thread?: unknown; workspace?: unknown };
    if (!repo) {
      if (m.scope === "workspace") continue;
      placed.push(m);
      continue;
    }
    const top = typeof repo.id === "string" ? tops.get(repo.id)?.top : undefined;
    const rel = typeof repo.path === "string" ? repo.path : "";
    if (!top || rel.split("/").includes("..")) continue;
    placed.push({ ...m, workspace: rel ? path.join(top, ...rel.split("/")) : top });
  }
  return { memories: cleanMemories(placed), tombstones: Array.isArray(input.tombstones) ? (input.tombstones as MemoryTombstone[]) : [] };
}

export class MemorySync {
  /** Per device, the digest of what it last took from here without error. */
  private acked = new Map<string, string>();
  private running: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private soon: NodeJS.Timeout | undefined;

  constructor(private readonly peers: PeerService, private readonly host: MemorySyncHost, private readonly log: (line: string) => void = () => {}) {}

  start(): void {
    this.timer = setInterval(() => this.nudge(0), SYNC_MS);
    this.timer.unref();
    this.host.onChange(() => this.nudge());
    let online = new Set<string>();
    this.peers.on("change", () => {
      const now = new Set(this.peers.view().peers.filter((p) => p.online).map((p) => p.id));
      // A device that came back may have missed changes: send to it again.
      if ([...now].some((id) => !online.has(id))) {
        for (const id of now) if (!online.has(id)) this.acked.delete(id);
        this.nudge(0);
      }
      online = now;
    });
    this.nudge(0);
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.soon);
  }

  nudge(ms = SOON_MS): void {
    clearTimeout(this.soon);
    this.soon = setTimeout(() => void this.sync(), ms);
    this.soon.unref();
  }

  /** One round with every online device; rounds never overlap. */
  sync(): Promise<void> {
    this.running = this.running.then(() => this.round()).catch((err) => this.log(`memory sync failed: ${(err as Error).message}`));
    return this.running;
  }

  private async round(): Promise<void> {
    if (!this.host.enabled()) return;
    const targets = this.peers.view().peers.filter((p) => p.online);
    if (!targets.length) return;
    const body = await outgoing(this.host.memories(), this.host.tombstones());
    const digest = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
    for (const peer of targets) {
      if (this.acked.get(peer.id) === digest) continue;
      try {
        const reply = await peerCall<MemorySyncBody & { off?: boolean }>(this.peers, peer.id, "POST", "/api/memory-sync", body);
        this.acked.set(peer.id, digest);
        if (!reply.off) await this.take(reply);
      } catch (err) {
        // Tried again on the next timer, a change, or when it reconnects.
        this.acked.delete(peer.id);
        this.log(`memory sync with ${peer.name}: ${(err as Error).message}`);
      }
    }
  }

  /** Merge a device's memories in; true when anything here changed. */
  async take(body: unknown): Promise<boolean> {
    const theirs = await incoming(body, this.folders());
    // Read and write in one step, after the awaits, so a save meanwhile is not lost.
    const merged = mergeMemories(this.host.memories(), this.host.tombstones(), theirs.memories, theirs.tombstones);
    if (merged.changed) this.host.replace(merged.memories, merged.tombstones);
    return merged.changed;
  }

  private folders(): string[] {
    const out = new Map<string, string>();
    for (const dir of [...this.host.folders(), ...this.host.memories().flatMap((m) => (m.workspace ? [m.workspace] : []))]) if (path.isAbsolute(dir)) out.set(workspaceKey(dir), dir);
    return [...out.values()];
  }

  /** POST /api/memory-sync from a paired device: merge, then answer with this device's memories. */
  router(): Router {
    const router = Router();
    router.post("/", express.json({ limit: MAX_JSON }), async (req, res) => {
      if (!peerDeviceOf(req.socket)) {
        res.status(403).json({ error: "Memory sync is for paired devices" });
        return;
      }
      if (!this.host.enabled()) {
        res.json({ off: true });
        return;
      }
      try {
        await this.take(req.body);
        res.json(await outgoing(this.host.memories(), this.host.tombstones()));
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    });
    return router;
  }
}
