import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { normalizeTabAssets } from "./assets.js";
import type { PageAssetDraft, PageAssetMeta } from "./pageAssets.js";
import { ensureFolderInstructionsColumn, ensurePageAssetSchema, ensurePageLocalSchema, ensurePagePermissionSchema, ensureProvenanceColumn, ensureReplyToColumn, ensureTemplateSchema, ensureWorkspaceColumn, ensureFileColumn, ensureTempColumn, ensureAccessColumns, migrateV1ToLibrarySchema, migrateV2ToV3 } from "./dbMigrate.js";
import { parseSearchDeclaration } from "./search/chunker.js";
import { normalizeFolderAccess, normalizePageAccess } from "./pageAccess.js";
import { normalizeEvents } from "./events.js";
import { FOLDERS_TABLE_SQL, TABS_TABLE_SQL } from "./schema.js";
import {
  isPlainObject,
  normalizeProvenance,
  normalizeFileBinding,
  normalizeReplyTo,
  type BoardState,
  type Folder,
  type Tab,
  type PageEvent,
  type Template,
  type TemplateBinding,
} from "./types.js";

export const SCHEMA_VERSION = 3;

export type TabStatus = "open" | "closed" | "deleted";

export type StoredTab = {
  tab: Tab;
  status: TabStatus;
  deletedAt?: number;
  deletedBatch?: string;
};

export type StoredFolder = {
  folder: Folder;
  deletedAt?: number;
  deletedBatch?: string;
};

type FolderRow = {
  id: string;
  description: string;
  instructions: string;
  parent_id: string | null;
  name: string;
  pos: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  deleted_batch: string | null;
  access: string | null;
};

type TemplateRow = {
  id: string;
  key: string;
  title: string;
  description: string;
  html: string;
  fields: string;
  title_template: string | null;
  initial_state: string;
  state_version: number;
  created_at: number;
  updated_at: number;
  builtin_key: string | null;
  builtin_fingerprint: string | null;
  guide: string | null;
  agent_actions: string | null;
  search: string | null;
  pin: number | null;
};

type PageAssetRow = {
  id: string;
  tab_id: string;
  name: string;
  mime_type: string;
  bytes: number;
  created_at: number;
  orphaned_at: number | null;
};

const PAGE_ASSET_COLUMNS = "id, tab_id, name, mime_type, bytes, created_at, orphaned_at";

type BindingRow = {
  tab_id: string;
  template_id: string;
  values_json: string;
  state_version: number;
  compatible: number;
  reason: string | null;
};

type TabRow = {
  id: string;
  key: string;
  title: string;
  html: string;
  state: string;
  pinned: number;
  status: string;
  strip_seq: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  deleted_at: number | null;
  revision: number;
  state_revision: number;
  state_updated_at: number;
  event_seq: number;
  events: string | null;
  assets: string;
  agent_hidden: number;
  folder_instructions: number;
  folder_id: string | null;
  lib_pos: number;
  deleted_batch: string | null;
  user_title_at: number | null;
  provenance: string | null;
  reply_to: string | null;
  workspace: string | null;
  file: string | null;
  temp: number;
  access: string | null;
};

type LegacyPersisted = {
  activeId?: string | null;
  tabs?: LegacyTab[];
  archive?: Array<{ tab?: LegacyTab; index?: number }>;
  deleted?: Array<{ tab?: LegacyTab; index?: number; deletedAt?: number }>;
};

type LegacyTab = Partial<Tab> & { id?: string; html?: string; archivedAt?: number };

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
${TABS_TABLE_SQL}
${FOLDERS_TABLE_SQL}
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL,
  fields TEXT NOT NULL,
  title_template TEXT,
  initial_state TEXT NOT NULL DEFAULT '{}',
  state_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  builtin_key TEXT,
  builtin_fingerprint TEXT,
  guide TEXT,
  agent_actions TEXT,
  search TEXT,
  pin INTEGER
);
CREATE TABLE IF NOT EXISTS template_bindings (
  tab_id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  values_json TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  compatible INTEGER NOT NULL DEFAULT 1,
  reason TEXT
);
`;

const UPSERT_SQL = `
INSERT INTO tabs (
  id, key, title, html, state, pinned, status, strip_seq,
  created_at, updated_at, closed_at, deleted_at,
  revision, state_revision, state_updated_at, event_seq, events, assets, agent_hidden,
  folder_instructions, folder_id, lib_pos, deleted_batch, user_title_at, provenance, reply_to, workspace, file, temp, access
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
)
ON CONFLICT(id) DO UPDATE SET
  key = excluded.key,
  title = excluded.title,
  html = excluded.html,
  state = excluded.state,
  pinned = excluded.pinned,
  status = excluded.status,
  strip_seq = excluded.strip_seq,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  closed_at = excluded.closed_at,
  deleted_at = excluded.deleted_at,
  revision = excluded.revision,
  state_revision = excluded.state_revision,
  state_updated_at = excluded.state_updated_at,
  event_seq = excluded.event_seq,
  events = excluded.events,
  assets = excluded.assets,
  agent_hidden = excluded.agent_hidden,
  folder_instructions = excluded.folder_instructions,
  folder_id = excluded.folder_id,
  lib_pos = excluded.lib_pos,
  deleted_batch = excluded.deleted_batch,
  user_title_at = excluded.user_title_at,
  provenance = excluded.provenance,
  reply_to = excluded.reply_to,
  workspace = excluded.workspace,
  file = excluded.file,
  temp = excluded.temp,
  access = excluded.access
`;

const INSERT_FOLDER_SQL = `
INSERT INTO folders (id, parent_id, name, pos, created_at, updated_at, deleted_at, deleted_batch, description, instructions, access)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPSERT_TEMPLATE_SQL = `
INSERT INTO templates (
  id, key, title, description, html, fields, title_template, initial_state,
  state_version, created_at, updated_at, builtin_key, builtin_fingerprint, guide, agent_actions, search, pin
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  key = excluded.key,
  title = excluded.title,
  description = excluded.description,
  html = excluded.html,
  fields = excluded.fields,
  title_template = excluded.title_template,
  initial_state = excluded.initial_state,
  state_version = excluded.state_version,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  builtin_key = excluded.builtin_key,
  builtin_fingerprint = excluded.builtin_fingerprint,
  guide = excluded.guide,
  agent_actions = excluded.agent_actions,
  search = excluded.search,
  pin = excluded.pin
`;

const UPSERT_BINDING_SQL = `
INSERT INTO template_bindings (
  tab_id, template_id, values_json, state_version, compatible, reason
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(tab_id) DO UPDATE SET
  template_id = excluded.template_id,
  values_json = excluded.values_json,
  state_version = excluded.state_version,
  compatible = excluded.compatible,
  reason = excluded.reason
`;

export class BoardDb {
  private upsertStmt;
  private parkStripStmt;
  private deleteStmt;
  private metaStmt;
  private upsertTemplateStmt;
  private deleteTemplateStmt;
  private upsertBindingStmt;
  private deleteBindingStmt;
  private clearBindingsStmt;
  private insertFolderStmt;
  private clearFoldersStmt;

  constructor(private readonly db: DatabaseSync) {
    this.upsertStmt = db.prepare(UPSERT_SQL);
    // Parks the key too: ids are unique and can't start with a NUL, so the parked key is free.
    this.parkStripStmt = db.prepare("UPDATE tabs SET strip_seq = ?, key = char(0) || id WHERE id = ?");
    this.deleteStmt = db.prepare("DELETE FROM tabs WHERE id = ?");
    this.metaStmt = db.prepare(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
    );
    this.upsertTemplateStmt = db.prepare(UPSERT_TEMPLATE_SQL);
    this.deleteTemplateStmt = db.prepare("DELETE FROM templates WHERE id = ?");
    this.upsertBindingStmt = db.prepare(UPSERT_BINDING_SQL);
    this.deleteBindingStmt = db.prepare("DELETE FROM template_bindings WHERE tab_id = ?");
    this.clearBindingsStmt = db.prepare("DELETE FROM template_bindings");
    this.insertFolderStmt = db.prepare(INSERT_FOLDER_SQL);
    this.clearFoldersStmt = db.prepare("DELETE FROM folders");
  }

  static open(sqlitePath: string, jsonPath: string): BoardDb {
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const existed = fs.existsSync(sqlitePath);
    if (existed) {
      return openWithRetry(sqlitePath, () => BoardDb.openExisting(sqlitePath));
    }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(sqlitePath);
      configure(db);
      db.exec(CREATE_SQL);
      ensureTemplateSchema(db);
      ensurePageAssetSchema(db);
      ensurePageLocalSchema(db);
      ensurePagePermissionSchema(db);
      ensureFolderInstructionsColumn(db);
      ensureProvenanceColumn(db);
      ensureReplyToColumn(db);
      ensureWorkspaceColumn(db);
      ensureFileColumn(db);
      ensureTempColumn(db);
      ensureAccessColumns(db);
      db.prepare("INSERT INTO meta (k, v) VALUES (?, ?)").run("schema", String(SCHEMA_VERSION));
      const board = new BoardDb(db);
      if (fs.existsSync(jsonPath)) {
        board.importLegacyJson(jsonPath);
        renameLegacy(jsonPath);
      }
      return board;
    } catch (err) {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      if (!existed) {
        removeSqlite(sqlitePath);
      }
      throw err;
    }
  }

  readAppearance(): Record<string, string> {
    const row = this.db.prepare("SELECT v FROM meta WHERE k = ?").get("appearance") as { v: string } | undefined;
    return row ? JSON.parse(row.v) : {};
  }

  writeAppearance(settings: Record<string, string>): void {
    this.metaStmt.run("appearance", JSON.stringify(settings));
  }

  load(): {
    activeId: string | null;
    /** The spaces JSON from meta, if any (src/spaces.ts parses it). */
    spaces: string | null;
    rows: StoredTab[];
    folders: StoredFolder[];
    templates: Template[];
    bindings: TemplateBinding[];
  } {
    const active = this.db.prepare("SELECT v FROM meta WHERE k = ?").get("active_id") as
      | { v: string }
      | undefined;
    const spaces = this.db.prepare("SELECT v FROM meta WHERE k = ?").get("spaces") as { v: string } | undefined;
    const rows = this.db.prepare("SELECT * FROM tabs").all() as TabRow[];
    const folders = (this.db.prepare("SELECT * FROM folders").all() as FolderRow[]).map(rowToFolder);
    const templates = (this.db.prepare("SELECT * FROM templates").all() as TemplateRow[]).map(rowToTemplate);
    const bindings = (this.db.prepare("SELECT * FROM template_bindings").all() as BindingRow[]).map(rowToBinding);
    return {
      activeId: active?.v ?? null,
      spaces: spaces?.v ?? null,
      rows: rows.map(rowToStored),
      folders,
      templates,
      bindings,
    };
  }

  save(input: {
    activeId: string | null;
    upserts: StoredTab[];
    removedIds: string[];
    /** Replaces every folder row when present. */
    folders?: StoredFolder[];
    templates?: Template[];
    removedTemplateIds?: string[];
    bindings?: TemplateBinding[];
    replaceBindings?: boolean;
    /** The spaces JSON; written when present. */
    spaces?: string;
  }): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of input.removedIds) {
        this.deleteStmt.run(id);
        this.deleteBindingStmt.run(id);
      }
      // UNIQUE(strip_seq) and UNIQUE(key) are checked per statement, so handing a
      // seq or key from one row to another would fail if we wrote the final values
      // directly. Park dirty rows on unused values first, then apply the real ones.
      this.parkDirtyStripSeqs(input.upserts);
      for (const row of input.upserts) {
        this.upsertStmt.run(...storedToParams(row));
      }
      if (input.folders) {
        this.clearFoldersStmt.run();
        for (const stored of input.folders) {
          this.insertFolderStmt.run(...folderToParams(stored));
        }
      }
      for (const id of input.removedTemplateIds ?? []) {
        this.deleteTemplateStmt.run(id);
      }
      for (const template of input.templates ?? []) {
        this.upsertTemplateStmt.run(...templateToParams(template));
      }
      if (input.replaceBindings) {
        this.clearBindingsStmt.run();
        for (const binding of input.bindings ?? []) {
          this.upsertBindingStmt.run(...bindingToParams(binding));
        }
      }
      this.metaStmt.run("active_id", input.activeId ?? "");
      if (input.spaces !== undefined) {
        this.metaStmt.run("spaces", input.spaces);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  /** New assets start orphaned at their creation time, so an upload the page never references is swept too. */
  readLocal(tabId: string, viewer: string): string | undefined {
    const row = this.db.prepare("SELECT state FROM page_local WHERE tab_id = ? AND viewer = ?").get(tabId, viewer) as
      | { state: string }
      | undefined;
    return row?.state;
  }

  /** The most recently written viewer local for this page, if any. */
  readLatestLocal(tabId: string): string | undefined {
    const row = this.db
      .prepare("SELECT state FROM page_local WHERE tab_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(tabId) as { state: string } | undefined;
    return row?.state;
  }

  writeLocal(tabId: string, viewer: string, state: string | null): void {
    if (state === null) {
      this.db.prepare("DELETE FROM page_local WHERE tab_id = ? AND viewer = ?").run(tabId, viewer);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO page_local (tab_id, viewer, state, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(tab_id, viewer) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at"
      )
      .run(tabId, viewer, state, Date.now());
  }

  readPermissions(tabId: string): Array<{ perm: string; value: string; data: string | null; updatedAt: number }> {
    const rows = this.db.prepare("SELECT perm, value, data, updated_at FROM page_permissions WHERE tab_id = ?").all(tabId) as Array<{
      perm: string;
      value: string;
      data: string | null;
      updated_at: number;
    }>;
    return rows.map((row) => ({ perm: row.perm, value: row.value, data: row.data, updatedAt: row.updated_at }));
  }

  /** null value removes the grant, so the permission is back at its default. */
  writePermission(tabId: string, perm: string, value: string | null, data: string | null, updatedAt: number): void {
    if (value === null) {
      this.db.prepare("DELETE FROM page_permissions WHERE tab_id = ? AND perm = ?").run(tabId, perm);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO page_permissions (tab_id, perm, value, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tab_id, perm) DO UPDATE SET value = excluded.value, data = excluded.data, updated_at = excluded.updated_at"
      )
      .run(tabId, perm, value, data, updatedAt);
  }

  insertPageAssets(tabId: string, assets: PageAssetDraft[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO page_assets (${PAGE_ASSET_COLUMNS}, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.transaction(() => {
      for (const asset of assets) {
        stmt.run(asset.id, tabId, asset.name, asset.mimeType, asset.data.length, asset.createdAt, asset.createdAt, asset.data);
      }
    });
  }

  readPageAsset(id: string): { meta: PageAssetMeta; data: Buffer } | undefined {
    const row = this.db.prepare(`SELECT ${PAGE_ASSET_COLUMNS}, data FROM page_assets WHERE id = ?`).get(id) as
      | (PageAssetRow & { data: Uint8Array })
      | undefined;
    return row ? { meta: rowToPageAsset(row), data: toBuffer(row.data) } : undefined;
  }

  listPageAssets(tabId: string): PageAssetMeta[] {
    const rows = this.db
      .prepare(`SELECT ${PAGE_ASSET_COLUMNS} FROM page_assets WHERE tab_id = ? ORDER BY created_at, id`)
      .all(tabId) as PageAssetRow[];
    return rows.map(rowToPageAsset);
  }

  readPageAssetDrafts(tabId: string): PageAssetDraft[] {
    const rows = this.db
      .prepare(`SELECT id, name, mime_type, created_at, data FROM page_assets WHERE tab_id = ? ORDER BY created_at, id`)
      .all(tabId) as Array<{ id: string; name: string; mime_type: string; created_at: number; data: Uint8Array }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      mimeType: row.mime_type,
      createdAt: row.created_at,
      data: toBuffer(row.data),
    }));
  }

  pageAssetExists(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS x FROM page_assets WHERE id = ?").get(id));
  }

  deletePageAsset(tabId: string, id: string): boolean {
    const result = this.db.prepare("DELETE FROM page_assets WHERE tab_id = ? AND id = ?").run(tabId, id);
    return Number(result.changes) > 0;
  }

  /** Count and bytes per page that has any assets. */
  pageAssetTotals(): Map<string, { count: number; bytes: number }> {
    const rows = this.db
      .prepare("SELECT tab_id, COUNT(*) AS count, SUM(bytes) AS bytes FROM page_assets GROUP BY tab_id")
      .all() as Array<{ tab_id: string; count: number; bytes: number }>;
    return new Map(rows.map((row) => [row.tab_id, { count: Number(row.count), bytes: Number(row.bytes) || 0 }]));
  }

  pageAssetTotal(tabId: string): { count: number; bytes: number } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count, SUM(bytes) AS bytes FROM page_assets WHERE tab_id = ?")
      .get(tabId) as { count: number; bytes: number | null };
    return { count: Number(row.count), bytes: Number(row.bytes) || 0 };
  }

  /**
   * Marks a page's assets referenced or orphaned and deletes those orphaned for longer than
   * `graceMs`. `nextExpiry` is when the next remaining orphan runs out of grace.
   */
  reconcilePageAssets(
    tabId: string,
    refs: Set<string>,
    now: number,
    graceMs: number
  ): { deleted: number; nextExpiry: number | null } {
    const rows = this.db
      .prepare("SELECT id, orphaned_at FROM page_assets WHERE tab_id = ?")
      .all(tabId) as Array<{ id: string; orphaned_at: number | null }>;
    let deleted = 0;
    let nextExpiry: number | null = null;
    const mark = this.db.prepare("UPDATE page_assets SET orphaned_at = ? WHERE id = ?");
    const drop = this.db.prepare("DELETE FROM page_assets WHERE id = ?");
    this.transaction(() => {
      for (const row of rows) {
        if (refs.has(row.id)) {
          if (row.orphaned_at !== null) {
            mark.run(null, row.id);
          }
          continue;
        }
        if (row.orphaned_at === null) {
          mark.run(now, row.id);
          nextExpiry = Math.min(nextExpiry ?? Infinity, now + graceMs);
        } else if (row.orphaned_at + graceMs <= now) {
          drop.run(row.id);
          deleted += 1;
        } else {
          nextExpiry = Math.min(nextExpiry ?? Infinity, row.orphaned_at + graceMs);
        }
      }
    });
    return { deleted, nextExpiry };
  }

  /** Assets whose page row is gone. The foreign key should make this impossible; this is the safety net. */
  deleteDanglingPageAssets(): number {
    const result = this.db.prepare("DELETE FROM page_assets WHERE tab_id NOT IN (SELECT id FROM tabs)").run();
    return Number(result.changes);
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  private parkDirtyStripSeqs(upserts: StoredTab[]): void {
    if (!upserts.length) {
      return;
    }
    const row = this.db.prepare("SELECT MIN(strip_seq) AS m FROM tabs").get() as { m: number | null } | undefined;
    let park = Math.min(-1, (typeof row?.m === "number" ? row.m : 0) - 1);
    for (const stored of upserts) {
      this.parkStripStmt.run(park, stored.tab.id);
      park -= 1;
    }
  }

  private importLegacyJson(jsonPath: string): void {
    let parsed: LegacyPersisted;
    try {
      parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as LegacyPersisted;
    } catch (err) {
      throw new Error(`Failed to migrate ${jsonPath}: ${String(err)}`);
    }
    const rows = legacyToStored(parsed);
    const active =
      parsed.activeId && rows.some((row) => row.status === "open" && row.tab.id === parsed.activeId)
        ? parsed.activeId
        : (rows.find((row) => row.status === "open")?.tab.id ?? null);
    this.save({ activeId: active, upserts: rows, removedIds: [] });
  }

  private static openExisting(sqlitePath: string): BoardDb {
    const db = new DatabaseSync(sqlitePath);
    try {
      configure(db);
      const row = db.prepare("SELECT v FROM meta WHERE k = ?").get("schema") as { v: string } | undefined;
      const version = Number(row?.v);
      if (!Number.isInteger(version)) {
        throw new Error(`scribe.sqlite is missing a schema version (${sqlitePath})`);
      }
      if (version > SCHEMA_VERSION) {
        throw new Error(`scribe.sqlite schema ${version} is newer than this daemon (${SCHEMA_VERSION})`);
      }
      if (version === 1) {
        migrateV1ToLibrarySchema(db);
      }
      if (version <= 2) {
        migrateV2ToV3(db);
      }
      ensureTemplateSchema(db);
      ensurePageAssetSchema(db);
      ensurePageLocalSchema(db);
      ensurePagePermissionSchema(db);
      ensureFolderInstructionsColumn(db);
      ensureProvenanceColumn(db);
      ensureReplyToColumn(db);
      ensureWorkspaceColumn(db);
      ensureFileColumn(db);
      ensureTempColumn(db);
      ensureAccessColumns(db);
      return new BoardDb(db);
    } catch (err) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}

function configure(db: DatabaseSync): void {
  // Set first, so the pragmas below wait on a lock instead of failing at once.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
}

const OPEN_ATTEMPTS = 6;
const OPEN_RETRY_MS = 300;

/**
 * A daemon restarted right after the old one stopped can find the old process still letting go
 * of scribe.sqlite (and its -wal/-shm files on Windows), so opening fails with SQLITE_IOERR or
 * SQLITE_BUSY. Waits a little and tries again before giving up.
 */
function openWithRetry<T>(sqlitePath: string, open: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return open();
    } catch (err) {
      if (attempt >= OPEN_ATTEMPTS || !isTransientOpenError(err)) {
        throw err;
      }
      console.warn(
        `[scribe] ${path.basename(sqlitePath)} is busy (${String((err as Error).message ?? err)}); ` +
          `waiting for the previous daemon to let go (attempt ${attempt}/${OPEN_ATTEMPTS - 1})`
      );
      sleepSync(OPEN_RETRY_MS * attempt);
    }
  }
}

/** SQLITE_BUSY (5), SQLITE_LOCKED (6), SQLITE_IOERR (10) and their extended codes. */
export function isTransientOpenError(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  if (typeof code === "number") {
    const primary = code & 0xff;
    return primary === 5 || primary === 6 || primary === 10;
  }
  return /disk I\/O error|database is locked|database table is locked/i.test(String((err as Error)?.message ?? ""));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A deleted page keeps closedAt when it was closed, so undo knows whether to reopen its tab. */
function storedToParams(row: StoredTab): SQLInputValue[] {
  const { tab, status, deletedAt, deletedBatch } = row;
  const closedAt = status === "open" ? null : (tab.closedAt ?? (status === "closed" ? tab.updatedAt : null));
  return [
    tab.id,
    tab.key,
    tab.title,
    tab.html,
    JSON.stringify(tab.state ?? {}),
    tab.pinned ? 1 : 0,
    status,
    tab.stripSeq,
    tab.createdAt,
    tab.updatedAt,
    closedAt,
    status === "deleted" ? (deletedAt ?? tab.updatedAt) : null,
    tab.revision,
    tab.stateRevision,
    tab.stateUpdatedAt,
    tab.eventSeq,
    JSON.stringify(tab.events ?? []),
    JSON.stringify(tab.assets ?? []),
    tab.agentHidden ? 1 : 0,
    0, // Retired page instruction flag; column retained for older databases.
    tab.folderId ?? null,
    tab.libPos,
    status === "deleted" ? (deletedBatch ?? null) : null,
    tab.userTitleAt ?? null,
    tab.provenance ? JSON.stringify(tab.provenance) : null,
    tab.replyTo ? JSON.stringify(tab.replyTo) : null,
    tab.workspace ?? null,
    tab.file ? JSON.stringify(tab.file) : null,
    tab.temp ? 1 : 0,
    tab.access ? JSON.stringify(tab.access) : null,
  ];
}

function folderToParams(stored: StoredFolder): SQLInputValue[] {
  const { folder, deletedAt, deletedBatch } = stored;
  return [
    folder.id,
    folder.parentId,
    folder.name,
    folder.pos,
    folder.createdAt,
    folder.updatedAt,
    deletedAt ?? null,
    deletedAt !== undefined ? (deletedBatch ?? null) : null,
    folder.description ?? "",
    folder.instructions ?? "",
    folder.access ? JSON.stringify(folder.access) : null,
  ];
}

function folderAccessOf(raw: string | null | undefined): { access?: Folder["access"] } {
  if (!raw) return {};
  try {
    const access = normalizeFolderAccess(JSON.parse(raw) as unknown);
    return access ? { access } : {};
  } catch {
    return {};
  }
}

function rowToFolder(row: FolderRow): StoredFolder {
  return {
    folder: {
      id: row.id,
      parentId: row.parent_id ?? null,
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      ...(row.instructions ? { instructions: row.instructions } : {}),
      pos: Number(row.pos) || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...folderAccessOf(row.access),
    },
    ...(row.deleted_at !== null ? { deletedAt: row.deleted_at } : {}),
    ...(row.deleted_batch ? { deletedBatch: row.deleted_batch } : {}),
  };
}

function rowToStored(row: TabRow): StoredTab {
  if (row.status !== "open" && row.status !== "closed" && row.status !== "deleted") {
    throw new Error(`invalid tab status: ${row.status}`);
  }
  let state: BoardState = {};
  try {
    const parsed = JSON.parse(row.state) as unknown;
    if (isPlainObject(parsed)) {
      state = parsed;
    }
  } catch {
    state = {};
  }
  let events: PageEvent[] = [];
  try {
    events = normalizeEvents(row.events ? JSON.parse(row.events) : []);
  } catch {
    events = [];
  }
  let assets: Tab["assets"] = [];
  try {
    assets = normalizeTabAssets(JSON.parse(row.assets) as Tab["assets"]);
  } catch {
    assets = [];
  }
  const tab: Tab = {
    id: row.id,
    key: row.key,
    title: row.title,
    html: row.html,
    pinned: Boolean(row.pinned),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    libPos: Number(row.lib_pos) || 0,
    stripSeq: row.strip_seq,
    revision: row.revision,
    state,
    stateRevision: row.state_revision,
    stateUpdatedAt: row.state_updated_at,
    eventSeq: row.event_seq,
    events,
    assets,
  };
  if (row.agent_hidden) {
    tab.agentHidden = true;
  }
  if (row.temp) {
    tab.temp = true;
  }
  if (row.folder_id) {
    tab.folderId = row.folder_id;
  }
  if (row.user_title_at) {
    tab.userTitleAt = row.user_title_at;
  }
  if (row.provenance) {
    try {
      const provenance = normalizeProvenance(JSON.parse(row.provenance) as unknown);
      if (provenance) {
        tab.provenance = provenance;
      }
    } catch {
      /* ignore */
    }
  }
  if (row.reply_to) {
    try {
      const replyTo = normalizeReplyTo(JSON.parse(row.reply_to) as unknown);
      if (replyTo) {
        tab.replyTo = replyTo;
      }
    } catch {
      /* ignore */
    }
  }
  if (row.workspace) {
    tab.workspace = row.workspace;
  }
  if (row.access) {
    try {
      const access = normalizePageAccess(JSON.parse(row.access) as unknown);
      if (access) {
        tab.access = access;
      }
    } catch {
      /* ignore */
    }
  }
  if (row.file) {
    try {
      const file = normalizeFileBinding(JSON.parse(row.file) as unknown);
      if (file) {
        tab.file = file;
      }
    } catch {
      /* ignore */
    }
  }
  if (row.status === "closed") {
    tab.closedAt = row.closed_at ?? row.updated_at;
  } else if (row.status === "deleted" && row.closed_at) {
    tab.closedAt = row.closed_at;
  }
  return {
    tab,
    status: row.status,
    ...(row.status === "deleted"
      ? { deletedAt: row.deleted_at ?? row.updated_at, ...(row.deleted_batch ? { deletedBatch: row.deleted_batch } : {}) }
      : {}),
  };
}

export function legacyToStored(parsed: LegacyPersisted): StoredTab[] {
  const rows: StoredTab[] = [];
  let seq = 0;
  const seen = new Set<string>();
  for (const raw of parsed.tabs ?? []) {
    const tab = coerceLegacyTab(raw, ++seq);
    if (!tab || seen.has(tab.id)) {
      continue;
    }
    seen.add(tab.id);
    delete tab.closedAt;
    rows.push({ tab, status: "open" });
  }
  for (const entry of parsed.archive ?? []) {
    const tab = coerceLegacyTab(entry.tab, ++seq);
    if (!tab || seen.has(tab.id)) {
      continue;
    }
    seen.add(tab.id);
    tab.closedAt = typeof entry.tab?.archivedAt === "number" ? entry.tab.archivedAt : tab.updatedAt;
    rows.push({ tab, status: "closed" });
  }
  for (const entry of parsed.deleted ?? []) {
    const tab = coerceLegacyTab(entry.tab, ++seq);
    if (!tab || seen.has(tab.id)) {
      continue;
    }
    seen.add(tab.id);
    delete tab.closedAt;
    rows.push({
      tab,
      status: "deleted",
      deletedAt: typeof entry.deletedAt === "number" ? entry.deletedAt : tab.updatedAt,
    });
  }
  return rows;
}

function coerceLegacyTab(raw: LegacyTab | undefined, seq: number): Tab | undefined {
  if (!raw?.id || !raw.html) {
    return undefined;
  }
  return {
    id: raw.id,
    key: typeof raw.key === "string" && raw.key ? raw.key : raw.id,
    title: typeof raw.title === "string" && raw.title ? raw.title : "page",
    html: raw.html,
    pinned: Boolean(raw.pinned),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
    libPos: seq,
    stripSeq: seq,
    revision: typeof raw.revision === "number" ? raw.revision : 1,
    state: isPlainObject(raw.state) ? raw.state : {},
    stateRevision: typeof raw.stateRevision === "number" ? raw.stateRevision : 0,
    stateUpdatedAt: typeof raw.stateUpdatedAt === "number" ? raw.stateUpdatedAt : 0,
    eventSeq: 0,
    events: [],
    assets: normalizeTabAssets(raw.assets),
  };
}

function renameLegacy(jsonPath: string): void {
  const bak = jsonPath + ".bak";
  try {
    if (fs.existsSync(bak)) {
      fs.unlinkSync(bak);
    }
    fs.renameSync(jsonPath, bak);
  } catch {
    /* keep state.json if rename fails; sqlite is already the source of truth */
  }
}

function templateToParams(template: Template): SQLInputValue[] {
  return [
    template.id,
    template.key,
    template.title,
    template.description,
    template.html,
    JSON.stringify(template.fields),
    template.titleTemplate ?? null,
    JSON.stringify(template.initialState ?? {}),
    template.stateVersion,
    template.createdAt,
    template.updatedAt,
    template.source?.builtin ?? null,
    template.source?.fingerprint ?? null,
    template.guide ?? null,
    template.agentActions ? JSON.stringify(template.agentActions) : null,
    template.search ? JSON.stringify(template.search) : null,
    template.pin === false ? 0 : null,
  ];
}

function bindingToParams(binding: TemplateBinding): SQLInputValue[] {
  return [
    binding.tabId,
    binding.templateId,
    JSON.stringify(binding.values ?? {}),
    binding.stateVersion,
    binding.compatible ? 1 : 0,
    binding.reason ?? null,
  ];
}

function rowToTemplate(row: TemplateRow): Template {
  let fields: Template["fields"] = [];
  try {
    const parsed = JSON.parse(row.fields) as unknown;
    if (Array.isArray(parsed)) {
      fields = parsed as Template["fields"];
    }
  } catch {
    fields = [];
  }
  let initialState: Template["initialState"];
  try {
    const parsed = JSON.parse(row.initial_state) as unknown;
    if (isPlainObject(parsed) && Object.keys(parsed).length) {
      initialState = parsed;
    }
  } catch {
    initialState = undefined;
  }
  let agentActions: Template["agentActions"];
  let search: Template["search"];
  try { search = row.search ? parseSearchDeclaration(JSON.parse(row.search)) : undefined; }
  catch { search = undefined; }
  try {
    const parsed = row.agent_actions ? (JSON.parse(row.agent_actions) as unknown) : undefined;
    if (Array.isArray(parsed) && parsed.length) {
      agentActions = parsed as Template["agentActions"];
    }
  } catch {
    agentActions = undefined;
  }
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    description: row.description ?? "",
    html: row.html,
    fields,
    ...(row.title_template ? { titleTemplate: row.title_template } : {}),
    ...(initialState ? { initialState } : {}),
    stateVersion: row.state_version || 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.builtin_key ? { source: { builtin: row.builtin_key, fingerprint: row.builtin_fingerprint ?? "" } } : {}),
    ...(row.guide ? { guide: row.guide } : {}),
    ...(agentActions ? { agentActions } : {}),
    ...(search ? { search } : {}),
    ...(row.pin === 0 ? { pin: false as const } : {}),
  };
}

function rowToBinding(row: BindingRow): TemplateBinding {
  let values: TemplateBinding["values"] = {};
  try {
    const parsed = JSON.parse(row.values_json) as unknown;
    if (isPlainObject(parsed)) {
      values = parsed as TemplateBinding["values"];
    }
  } catch {
    values = {};
  }
  return {
    tabId: row.tab_id,
    templateId: row.template_id,
    values,
    stateVersion: row.state_version,
    compatible: row.compatible !== 0,
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

function rowToPageAsset(row: PageAssetRow): PageAssetMeta {
  return {
    id: row.id,
    tabId: row.tab_id,
    name: row.name,
    mimeType: row.mime_type,
    bytes: Number(row.bytes),
    createdAt: row.created_at,
    ...(row.orphaned_at !== null ? { orphanedAt: row.orphaned_at } : {}),
  };
}

function toBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function removeSqlite(sqlitePath: string): void {
  for (const extra of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(sqlitePath + extra);
    } catch {
      /* ignore */
    }
  }
}
