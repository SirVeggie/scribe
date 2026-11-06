import crypto from "node:crypto";
import express, { Router } from "express";
import { categoryOf, parseAppearance, type Appearance, type PrefCategory } from "../appearance.js";
import { peerCall } from "./copy.js";
import { peerDeviceOf } from "./link.js";
import type { PeerService } from "./peers.js";

/**
 * Settings sync between paired devices (#1023, decisions in docs/device-sync-design-979.md).
 *
 * Every synced key has a record: its value and a logical clock (a counter and the device that set it).
 * A key without a record is a default, and any record beats it. Records compare by counter, then by
 * device id, never by wall time, so a device with a wrong clock can't make an old change win.
 *
 * A device that has not joined a group yet merges automatically on its first exchange, except for the
 * keys both sides set to different values: those wait for the user on the Choose setup screen. Once it
 * has joined, the newest record wins. A group device keeps its own value for such a key until the
 * newcomer chooses, so the newcomer is compared against the whole group.
 *
 * Category switches (`sync:<category>`) are records too and always sync: a category switched off stops
 * for the whole group. "This device keeps its own" is per device and never leaves it.
 *
 * A headless device stores and passes the records on, so devices that are rarely on at the same time
 * still meet, but applies none of them and sends none of its own.
 */

export const SYNC_CATEGORIES = ["appearance", "layout", "chat", "memories"] as const;
export type SyncCategory = (typeof SYNC_CATEGORIES)[number];

export type SyncRecord = { v: string; n: number; d: string };
export type ConflictRow = { key: string; category: PrefCategory; mine: string; theirs: string };
export type Pending = { from: { id: string; name: string }; rows: ConflictRow[]; theirs: Record<string, SyncRecord> };

export type SyncState = {
  /** The highest counter seen anywhere (a Lamport clock). */
  n: number;
  records: Record<string, SyncRecord>;
  /** This device is part of a group: newest wins from now on. */
  joined: boolean;
  /** Devices the user settled a Choose setup against: they take this device's values for those keys. */
  settled: string[];
  pending: Pending | null;
  /** Categories this device keeps to itself. */
  keepOwn: SyncCategory[];
};

export type SyncBody = { joined: boolean; settled: string[]; relay?: boolean; records: Record<string, SyncRecord> };

export type SyncView = {
  relay: boolean;
  joined: boolean;
  categories: { id: SyncCategory; on: boolean; keepOwn: boolean }[];
  pending: { from: { id: string; name: string }; rows: ConflictRow[] } | null;
};

export const switchKey = (category: SyncCategory) => `sync:${category}`;

export function emptyState(): SyncState {
  return { n: 0, records: {}, joined: false, settled: [], pending: null, keepOwn: [] };
}

function cleanRecord(raw: unknown): SyncRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { v, n, d } = raw as Record<string, unknown>;
  if (typeof v !== "string" || v.length > 8192 || typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || typeof d !== "string" || !d || d.length > 64) return undefined;
  return { v, n, d };
}

export function cleanState(raw: unknown): SyncState {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;
  const input = raw as Partial<SyncState>;
  const records: Record<string, SyncRecord> = {};
  for (const [key, value] of Object.entries(input.records ?? {})) {
    const rec = cleanRecord(value);
    if (rec && validKey(key, rec.v)) records[key] = rec;
  }
  return {
    n: typeof input.n === "number" && Number.isSafeInteger(input.n) ? input.n : 0,
    records,
    joined: input.joined === true,
    settled: Array.isArray(input.settled) ? input.settled.filter((id): id is string => typeof id === "string") : [],
    pending: input.pending && typeof input.pending === "object" && Array.isArray(input.pending.rows) ? input.pending : null,
    keepOwn: Array.isArray(input.keepOwn) ? input.keepOwn.filter((c): c is SyncCategory => (SYNC_CATEGORIES as readonly string[]).includes(c)) : [],
  };
}

/** Newer by counter, then by device id. */
export function newer(a: SyncRecord, b: SyncRecord): boolean {
  return a.n !== b.n ? a.n > b.n : a.d > b.d;
}

function keyCategory(key: string): SyncCategory | "switch" | undefined {
  if (key.startsWith("sync:")) return (SYNC_CATEGORIES as readonly string[]).includes(key.slice(5)) ? "switch" : undefined;
  return categoryOf(key);
}

function validKey(key: string, value: string): boolean {
  const category = keyCategory(key);
  if (!category) return false;
  if (category === "switch") return value === "0" || value === "1";
  try {
    parseAppearance({ [key]: value });
    return true;
  } catch {
    return false;
  }
}

/** Whether a category syncs in the group: its switch record, else on (memories: this device's old switch). */
export function groupOn(state: SyncState, category: SyncCategory, memoryDefault = true): boolean {
  const rec = state.records[switchKey(category)];
  return rec ? rec.v === "1" : category === "memories" ? memoryDefault : true;
}

function flows(state: SyncState, key: string, memoryDefault: boolean): boolean {
  const category = keyCategory(key);
  if (!category) return false;
  if (category === "switch") return true;
  return groupOn(state, category, memoryDefault) && !state.keepOwn.includes(category);
}

/** What this device sends: the switches, and the records of the categories that sync here. */
export function outgoingBody(state: SyncState, relay: boolean, memoryDefault = true): SyncBody {
  const records: Record<string, SyncRecord> = {};
  for (const [key, rec] of Object.entries(state.records)) {
    // While a Choose setup waits, this device's side of those keys is not settled: hold it back.
    if (state.pending?.rows.some((row) => row.key === key)) continue;
    if (relay || flows(state, key, memoryDefault)) records[key] = rec;
  }
  return { joined: relay || state.joined, settled: state.settled, ...(relay ? { relay: true } : {}), records };
}

/**
 * Merge a device's records into this device's state. Returns the new state and the keys whose value
 * changed here (to apply to the preferences); conflicts at a first join go to `pending` instead.
 */
export function mergeBody(
  state: SyncState,
  body: SyncBody,
  self: string,
  from: { id: string; name: string },
  opts: { relay?: boolean; memoryDefault?: boolean } = {},
): { state: SyncState; changed: string[] } {
  const relay = opts.relay === true;
  const memoryDefault = opts.memoryDefault ?? true;
  const next: SyncState = { ...state, records: { ...state.records }, settled: [...state.settled] };
  const changed: string[] = [];
  const joined = relay || state.joined;
  const theirJoined = body.joined === true;
  const settledHere = Array.isArray(body.settled) && body.settled.includes(self);
  const incoming = Object.entries(body.records ?? {}).flatMap(([key, raw]) => {
    const rec = cleanRecord(raw);
    return rec && validKey(key, rec.v) ? [[key, rec] as const] : [];
  });
  for (const [, rec] of incoming) next.n = Math.max(next.n, rec.n);
  // Switches first: a category switched on or off in the same message decides what flows.
  incoming.sort(([a], [b]) => Number(b.startsWith("sync:")) - Number(a.startsWith("sync:")));
  const conflicts: ConflictRow[] = [];
  const theirs: Record<string, SyncRecord> = {};
  for (const [key, rec] of incoming) {
    if (!relay && !flows(next, key, memoryDefault)) continue;
    const mine = next.records[key];
    let take = false;
    if (!mine) take = true;
    else if (mine.v === rec.v) {
      if (newer(rec, mine)) next.records[key] = rec;
      continue;
    } else if (key.startsWith("sync:") || (joined && theirJoined)) take = newer(rec, mine);
    else if (!joined && theirJoined && settledHere) take = true;
    else if (!joined) {
      const category = categoryOf(key);
      if (category) {
        conflicts.push({ key, category, mine: mine.v, theirs: rec.v });
        theirs[key] = rec;
      }
    }
    // A group device keeps its own value until the newcomer chooses.
    if (take) {
      next.records[key] = rec;
      changed.push(key);
    }
  }
  if (!joined) {
    if (conflicts.length) next.pending = { from, rows: conflicts, theirs };
    else if (!next.pending || next.pending.from.id === from.id) {
      next.pending = null;
      next.joined = true;
    }
  }
  return { state: next, changed };
}

/** The user's answers on Choose setup: per key, keep this device's value or take the other's. */
export function resolvePending(state: SyncState, self: string, choices: Record<string, "mine" | "theirs">): { state: SyncState; changed: string[]; stamped: string[] } {
  const pending = state.pending;
  if (!pending) throw new Error("Nothing to choose");
  const next: SyncState = { ...state, records: { ...state.records }, settled: [...state.settled] };
  const changed: string[] = [];
  const stamped: string[] = [];
  for (const row of pending.rows) {
    const choice = choices[row.key];
    if (choice !== "mine" && choice !== "theirs") throw new Error(`Choose a value for ${row.key}`);
    const theirs = pending.theirs[row.key];
    if (choice === "theirs" && theirs) {
      next.records[row.key] = theirs;
      changed.push(row.key);
    } else if (next.records[row.key]) {
      // Stamp it newer than anything seen, so the group takes it once this device has joined.
      next.n += 1;
      next.records[row.key] = { ...next.records[row.key], n: next.n, d: self };
      stamped.push(row.key);
    }
  }
  next.pending = null;
  next.joined = true;
  if (!next.settled.includes(pending.from.id)) next.settled.push(pending.from.id);
  return { state: next, changed, stamped };
}

/** Bring the records up to date with this device's preferences: changed or new values get a fresh stamp. */
export function stampLocal(state: SyncState, self: string, settings: Appearance, keys: string[]): SyncState {
  let next = state;
  for (const key of keys) {
    if (!categoryOf(key)) continue;
    const value = settings[key];
    const rec = next.records[key];
    if (value === undefined || rec?.v === value) continue;
    if (next === state) next = { ...state, records: { ...state.records } };
    next.n += 1;
    next.records[key] = { v: value, n: next.n, d: self };
  }
  return next;
}

export type SettingsSyncHost = {
  self(): { id: string; name: string };
  /** A headless device: store and pass on only. */
  relay(): boolean;
  read(): SyncState;
  write(state: SyncState): void;
  /** This device's preferences. */
  settings(): Appearance;
  /** Write values that came from another device: present keys set, absent ones removed. */
  apply(patch: Appearance, keys: string[]): void;
  /** The memory switch before it moved to the Sync page (#978): the default for the Memories category. */
  memoryDefault(): boolean;
  /** The Sync view changed (a choice waits, a switch flipped). */
  changed(view: SyncView): void;
};

const SYNC_MS = 5 * 60_000;
const SOON_MS = 1500;

export class SettingsSync {
  private acked = new Map<string, string>();
  private running: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private soon: NodeJS.Timeout | undefined;

  constructor(private readonly peers: PeerService, private readonly host: SettingsSyncHost, private readonly log: (line: string) => void = () => {}) {}

  start(): void {
    // Values saved before sync existed (or while the daemon was older) become this device's records.
    if (!this.host.relay()) this.localChange(Object.keys(this.host.settings()), false);
    this.timer = setInterval(() => this.nudge(0), SYNC_MS);
    this.timer.unref();
    let online = new Set<string>();
    this.peers.on("change", () => {
      const now = new Set(this.peers.view().peers.filter((p) => p.online).map((p) => p.id));
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

  /** Whether a category syncs on this device (the group's switch, and not kept to itself). */
  enabled(category: SyncCategory): boolean {
    const state = this.host.read();
    return groupOn(state, category, this.host.memoryDefault()) && (this.host.relay() || !state.keepOwn.includes(category));
  }

  view(): SyncView {
    const state = this.host.read();
    const memoryDefault = this.host.memoryDefault();
    return {
      relay: this.host.relay(),
      joined: this.host.relay() || state.joined,
      categories: SYNC_CATEGORIES.map((id) => ({ id, on: groupOn(state, id, memoryDefault), keepOwn: state.keepOwn.includes(id) })),
      pending: state.pending ? { from: state.pending.from, rows: state.pending.rows } : null,
    };
  }

  /** The user changed preferences here. */
  localChange(keys: string[], send = true): void {
    if (this.host.relay() || !keys.length) return;
    const state = this.host.read();
    const next = stampLocal(state, this.host.self().id, this.host.settings(), keys);
    if (next === state) return;
    this.host.write(next);
    if (send) this.nudge();
  }

  /** The group switch for a category. */
  setCategory(category: SyncCategory, on: boolean): SyncView {
    const state = this.host.read();
    const next = { ...state, n: state.n + 1, records: { ...state.records } };
    next.records[switchKey(category)] = { v: on ? "1" : "0", n: next.n, d: this.host.self().id };
    this.host.write(next);
    this.acked.clear();
    this.nudge(0);
    return this.emit();
  }

  setKeepOwn(category: SyncCategory, keep: boolean): SyncView {
    const state = this.host.read();
    const keepOwn = state.keepOwn.filter((c) => c !== category);
    if (keep) keepOwn.push(category);
    this.host.write({ ...state, keepOwn });
    this.acked.clear();
    this.nudge(0);
    return this.emit();
  }

  resolve(choices: Record<string, "mine" | "theirs">): SyncView {
    const self = this.host.self().id;
    const result = resolvePending(this.host.read(), self, choices);
    this.host.write(result.state);
    this.applyKeys(result.state, result.changed);
    this.acked.clear();
    this.nudge(0);
    return this.emit();
  }

  private emit(): SyncView {
    const view = this.view();
    this.host.changed(view);
    return view;
  }

  private applyKeys(state: SyncState, keys: string[]): void {
    if (this.host.relay()) return;
    const patch: Appearance = {};
    const prefKeys = keys.filter((key) => categoryOf(key));
    for (const key of prefKeys) patch[key] = state.records[key].v;
    if (prefKeys.length) this.host.apply(patch, prefKeys);
  }

  private body(): SyncBody {
    return outgoingBody(this.host.read(), this.host.relay(), this.host.memoryDefault());
  }

  /** Merge a device's body; true when anything here changed. */
  take(from: { id: string; name: string }, body: SyncBody): boolean {
    const before = this.host.read();
    const result = mergeBody(before, body, this.host.self().id, from, { relay: this.host.relay(), memoryDefault: this.host.memoryDefault() });
    const changed = JSON.stringify(result.state) !== JSON.stringify(before);
    if (!changed) return false;
    this.host.write(result.state);
    this.applyKeys(result.state, result.changed);
    const viewChanged = JSON.stringify(before.pending) !== JSON.stringify(result.state.pending) || before.joined !== result.state.joined ||
      SYNC_CATEGORIES.some((c) => before.records[switchKey(c)]?.v !== result.state.records[switchKey(c)]?.v);
    if (viewChanged) this.emit();
    // Pass it on to the other devices.
    this.nudge();
    return true;
  }

  sync(): Promise<void> {
    this.running = this.running.then(() => this.round()).catch((err) => this.log(`settings sync failed: ${(err as Error).message}`));
    return this.running;
  }

  private async round(): Promise<void> {
    const targets = this.peers.view().peers.filter((p) => p.online);
    for (const peer of targets) {
      const body = this.body();
      const digest = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
      if (this.acked.get(peer.id) === digest) continue;
      try {
        const reply = await peerCall<SyncBody>(this.peers, peer.id, "POST", "/api/settings-sync", body);
        this.acked.set(peer.id, digest);
        this.take({ id: peer.id, name: peer.name }, reply);
      } catch (err) {
        this.acked.delete(peer.id);
        this.log(`settings sync with ${peer.name}: ${(err as Error).message}`);
      }
    }
  }

  /** POST /api/settings-sync from a paired device; the rest is this device's Sync page. */
  router(): Router {
    const router = Router();
    router.post("/", express.json({ limit: "2mb" }), (req, res) => {
      const device = peerDeviceOf(req.socket);
      if (!device) {
        res.status(403).json({ error: "Settings sync is for paired devices" });
        return;
      }
      try {
        this.take({ id: device, name: this.peers.nameOf(device) ?? device }, req.body as SyncBody);
        res.json(this.body());
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    });
    router.get("/status", (_req, res) => res.json(this.view()));
    router.put("/category", express.json(), (req, res) => {
      const { category, on, keepOwn } = (req.body ?? {}) as { category?: string; on?: unknown; keepOwn?: unknown };
      if (!(SYNC_CATEGORIES as readonly string[]).includes(category ?? "")) {
        res.status(400).json({ error: "Unknown category" });
        return;
      }
      const id = category as SyncCategory;
      let view = this.view();
      if (typeof on === "boolean") view = this.setCategory(id, on);
      if (typeof keepOwn === "boolean") view = this.setKeepOwn(id, keepOwn);
      res.json(view);
    });
    router.post("/resolve", express.json(), (req, res) => {
      try {
        res.json(this.resolve((req.body?.choices ?? {}) as Record<string, "mine" | "theirs">));
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    });
    return router;
  }
}

