import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir } from "../config.js";
import type { ThreadStats } from "./threadStats.js";
import type { Item, Thread, Turn } from "./types.js";
import { settleAccess } from "./types.js";
import { parseWebAccess } from "./webAccess.js";

/** A stored thread. Older ones kept web as a boolean, and a mode beside their approval (#719). */
function readThread(data: string): Thread {
  const thread = JSON.parse(data) as Thread;
  thread.web = parseWebAccess(thread.web) ?? "on";
  Object.assign(thread, settleAccess(thread.mode, thread.approval));
  return thread;
}

/**
 * Agent chat data lives in its own file next to scribe.sqlite, so the board schema is untouched.
 * Rows keep their payload as JSON; the columns are only what queries need. See docs/migrations.md.
 */
const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  activity_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_thread ON turns(thread_id, seq);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_thread ON items(thread_id, seq);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS thread_stats (
  id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL,
  workspace TEXT,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, data TEXT NOT NULL);
`;

export const AGENT_SCHEMA_VERSION = 1;

export class AgentDb {
  private db: DatabaseSync;

  constructor(file = path.join(dataDir(), "agent.sqlite")) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
    this.db.exec(CREATE_SQL);
    this.db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('schema', ?)").run(String(AGENT_SCHEMA_VERSION));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  listThreads(): Thread[] {
    const rows = this.db.prepare("SELECT data FROM threads ORDER BY activity_at DESC").all() as Array<{ data: string }>;
    return rows.map((row) => readThread(row.data));
  }

  getThread(id: string): Thread | null {
    const row = this.db.prepare("SELECT data FROM threads WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? readThread(row.data) : null;
  }

  saveThread(thread: Thread): void {
    this.db
      .prepare(
        `INSERT INTO threads (id, activity_at, archived, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET activity_at = excluded.activity_at, archived = excluded.archived, data = excluded.data`
      )
      .run(thread.id, thread.activityAt, thread.archived ? 1 : 0, JSON.stringify(thread));
  }

  deleteThread(id: string): void {
    this.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
  }

  /** What is kept of a thread deleted with its workspace (threadStats.ts): numbers only. */
  saveThreadStats(stats: ThreadStats): void {
    this.db
      .prepare(
        `INSERT INTO thread_stats (id, deleted_at, workspace, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at, workspace = excluded.workspace, data = excluded.data`
      )
      .run(stats.id, stats.deletedAt, stats.workspace, JSON.stringify(stats));
  }

  listThreadStats(): ThreadStats[] {
    const rows = this.db.prepare("SELECT data FROM thread_stats ORDER BY deleted_at").all() as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as ThreadStats);
  }

  listTurns(threadId: string): Turn[] {
    const rows = this.db.prepare("SELECT data FROM turns WHERE thread_id = ? ORDER BY seq").all(threadId) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as Turn);
  }

  saveTurn(turn: Turn): void {
    this.db
      .prepare(
        `INSERT INTO turns (id, thread_id, seq, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`
      )
      .run(turn.id, turn.threadId, turn.seq, JSON.stringify(turn));
  }

  deleteTurn(id: string): void {
    this.db.prepare("DELETE FROM turns WHERE id = ?").run(id);
  }

  listItems(threadId: string): Item[] {
    const rows = this.db.prepare("SELECT data FROM items WHERE thread_id = ? ORDER BY seq").all(threadId) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as Item);
  }

  /**
   * The user's messages and the agent's own replies (not a subagent's) whose stored JSON matches any of the
   * LIKE patterns, oldest first within a thread. The patterns narrow the scan; the caller checks the text.
   */
  *searchMessages(patterns: string[]): IterableIterator<{ threadId: string; text: string }> {
    if (!patterns.length) return;
    const rows = this.db
      .prepare(
        `SELECT thread_id AS threadId, json_extract(data, '$.text') AS text FROM items
         WHERE (${patterns.map(() => "data LIKE ? ESCAPE '!'").join(" OR ")})
           AND json_extract(data, '$.kind') IN ('user', 'text')
           AND json_extract(data, '$.dropped') IS NOT 1
           AND json_extract(data, '$.parentToolId') IS NULL
         ORDER BY thread_id, seq`
      )
      .iterate(...patterns) as IterableIterator<{ threadId: string; text: unknown }>;
    for (const row of rows) {
      if (typeof row.text === "string") yield { threadId: row.threadId, text: row.text };
    }
  }

  saveItems(items: Item[]): void {
    if (!items.length) {
      return;
    }
    const stmt = this.db.prepare(
      `INSERT INTO items (id, thread_id, seq, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, data = excluded.data`
    );
    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        stmt.run(item.id, item.threadId, item.seq, JSON.stringify(item));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  deleteItem(id: string): void {
    this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
  }

  maxItemSeq(threadId: string): number {
    const row = this.db.prepare("SELECT MAX(seq) AS m FROM items WHERE thread_id = ?").get(threadId) as { m: number | null };
    return row.m ?? 0;
  }

  /** Scribe skills' metadata (scribeSkills.ts); their files live in dataDir/skills. */
  listSkillRows<T>(): T[] {
    const rows = this.db.prepare("SELECT data FROM skills ORDER BY id").all() as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as T);
  }

  saveSkillRow(id: string, row: unknown): void {
    this.db.prepare("INSERT INTO skills (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(id, JSON.stringify(row));
  }

  deleteSkillRow(id: string): void {
    this.db.prepare("DELETE FROM skills WHERE id = ?").run(id);
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT v FROM settings WHERE k = ?").get(key) as { v: string } | undefined;
    if (!row) {
      return fallback;
    }
    try {
      return JSON.parse(row.v) as T;
    } catch {
      return fallback;
    }
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE k = ?").run(key);
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(key, JSON.stringify(value));
  }
}
