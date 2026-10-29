import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir } from "../config.js";
import type { ThreadStats } from "./threadStats.js";
import type { Item, Thread, Turn } from "./types.js";
import { textLikePatterns } from "./threadSearch.js";
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
 * Whether a stored item is searchable message text: the user's messages and the agent's own replies,
 * not dropped and not a subagent's. Keep in sync with searchableMessageText in public/agent.js.
 * The triggers below are stored in the database, so changing this needs them dropped and made again.
 */
function searchable(data: string): string {
  return `json_extract(${data}, '$.kind') IN ('user', 'text') AND json_extract(${data}, '$.dropped') IS NOT 1
    AND json_extract(${data}, '$.parentToolId') IS NULL AND json_type(${data}, '$.text') = 'text'`;
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
CREATE TABLE IF NOT EXISTS message_text (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_text_thread ON message_text(thread_id, seq);
CREATE TRIGGER IF NOT EXISTS items_message_text_insert AFTER INSERT ON items BEGIN
  INSERT INTO message_text (item_id, thread_id, seq, text)
    SELECT NEW.id, NEW.thread_id, NEW.seq, json_extract(NEW.data, '$.text') WHERE ${searchable("NEW.data")};
END;
CREATE TRIGGER IF NOT EXISTS items_message_text_update AFTER UPDATE ON items BEGIN
  DELETE FROM message_text WHERE item_id = OLD.id;
  INSERT INTO message_text (item_id, thread_id, seq, text)
    SELECT NEW.id, NEW.thread_id, NEW.seq, json_extract(NEW.data, '$.text') WHERE ${searchable("NEW.data")};
END;
`;

/** Bump to rebuild message_text from items on the next open (after changing what counts as searchable). */
const MESSAGE_TEXT_VERSION = "1";

export const AGENT_SCHEMA_VERSION = 1;

export class AgentDb {
  private db: DatabaseSync;

  constructor(file = path.join(dataDir(), "agent.sqlite")) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
    this.db.exec(CREATE_SQL);
    this.db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('schema', ?)").run(String(AGENT_SCHEMA_VERSION));
    this.fillMessageText();
  }

  /**
   * Fill message_text from items once (for databases from before it, or after MESSAGE_TEXT_VERSION changes).
   * After that, the triggers on items keep it current, whichever daemon version writes.
   */
  private fillMessageText(): void {
    const row = this.db.prepare("SELECT v FROM meta WHERE k = 'message_text'").get() as { v: string } | undefined;
    if (row?.v === MESSAGE_TEXT_VERSION) return;
    this.db.exec("BEGIN");
    try {
      this.db.exec(`DELETE FROM message_text;
        INSERT INTO message_text (item_id, thread_id, seq, text)
          SELECT id, thread_id, seq, json_extract(data, '$.text') FROM items WHERE ${searchable("data")};`);
      this.db.prepare("INSERT INTO meta (k, v) VALUES ('message_text', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(MESSAGE_TEXT_VERSION);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
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
   * Searchable messages (see searchable) that mention any of the lowercase words, oldest first within a
   * thread. LIKE folds ASCII case only, so the caller checks the text again.
   */
  *searchMessages(words: string[]): IterableIterator<{ threadId: string; text: string }> {
    const patterns = words.flatMap(textLikePatterns);
    if (!patterns.length) return;
    yield* this.db
      .prepare(
        `SELECT thread_id AS threadId, text FROM message_text
         WHERE ${patterns.map(() => "text LIKE ? ESCAPE '!'").join(" OR ")}
         ORDER BY thread_id, seq`
      )
      .iterate(...patterns) as IterableIterator<{ threadId: string; text: string }>;
  }

  /** Searchable messages that mention every one of the lowercase words, oldest first within a thread. */
  *messagesMentioning(words: string[]): IterableIterator<{ threadId: string; text: string }> {
    if (!words.length) return;
    const groups = words.map(textLikePatterns);
    const where = groups.map((g) => `(${g.map(() => "text LIKE ? ESCAPE '!'").join(" OR ")})`).join(" AND ");
    yield* this.db
      .prepare(`SELECT thread_id AS threadId, text FROM message_text WHERE ${where} ORDER BY thread_id, seq`)
      .iterate(...groups.flat()) as IterableIterator<{ threadId: string; text: string }>;
  }

  /**
   * Threads with an item whose stored JSON holds every word, for thread_list's search to read only
   * those. words holds one list of LIKE patterns per word (its case variants), from likePatterns.
   */
  threadsMentioning(words: string[][]): Set<string> {
    const groups = words.filter((w) => w.length);
    if (!groups.length) return new Set();
    const where = groups.map((g) => `(${g.map(() => "data LIKE ? ESCAPE '!'").join(" OR ")})`).join(" AND ");
    const rows = this.db.prepare(`SELECT DISTINCT thread_id AS threadId FROM items WHERE ${where}`).all(...groups.flat()) as Array<{ threadId: string }>;
    return new Set(rows.map((r) => r.threadId));
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
