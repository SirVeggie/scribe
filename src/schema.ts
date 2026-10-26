export const TABS_TABLE_SQL = `
CREATE TABLE tabs (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  html TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('open','closed','deleted')),
  strip_seq INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  deleted_at INTEGER,
  revision INTEGER NOT NULL,
  state_revision INTEGER NOT NULL,
  state_updated_at INTEGER NOT NULL DEFAULT 0,
  event_seq INTEGER NOT NULL DEFAULT 0,
  events TEXT NOT NULL DEFAULT '[]',
  assets TEXT NOT NULL DEFAULT '[]',
  agent_hidden INTEGER NOT NULL DEFAULT 0,
  folder_instructions INTEGER NOT NULL DEFAULT 0,
  folder_id TEXT,
  lib_pos REAL NOT NULL DEFAULT 0,
  deleted_batch TEXT,
  user_title_at INTEGER,
  provenance TEXT,
  reply_to TEXT,
  workspace TEXT,
  file TEXT,
  browser TEXT,
  temp INTEGER NOT NULL DEFAULT 0,
  access TEXT,
  made_in TEXT
);
CREATE INDEX idx_tabs_status_closed ON tabs(status, closed_at DESC);
CREATE INDEX idx_tabs_status_deleted ON tabs(status, deleted_at DESC);
`;

/** The schema 2 tabs table, kept so a schema 1 board can still migrate through 2 to 3. */
export const TABS_TABLE_V2_SQL = `
CREATE TABLE tabs (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  html TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('open','closed','deleted')),
  strip_seq INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  deleted_at INTEGER,
  revision INTEGER NOT NULL,
  state_revision INTEGER NOT NULL,
  state_updated_at INTEGER NOT NULL DEFAULT 0,
  signal_revision INTEGER NOT NULL DEFAULT 0,
  signal TEXT,
  assets TEXT NOT NULL DEFAULT '[]',
  agent_hidden INTEGER NOT NULL DEFAULT 0,
  folder_id TEXT,
  lib_pos REAL NOT NULL DEFAULT 0,
  deleted_batch TEXT,
  user_title_at INTEGER
);
CREATE INDEX idx_tabs_status_closed ON tabs(status, closed_at DESC);
CREATE INDEX idx_tabs_status_deleted ON tabs(status, deleted_at DESC);
`;

export const FOLDERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  pos REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_batch TEXT,
  access TEXT,
  disk TEXT
);
`;

/**
 * Blobs saved by page code. Rows go with their page through the foreign key, so a
 * permanent delete of a `tabs` row removes them in the same statement. The tabs upsert
 * must stay `ON CONFLICT DO UPDATE` (never `REPLACE`), which would cascade on every save.
 */
export const PAGE_ASSETS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS page_assets (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  orphaned_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_page_assets_tab ON page_assets(tab_id);
`;

/** Per-viewer page state (scribe.local): one row per page and viewer (the desktop app, a browser). */
export const PAGE_LOCAL_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS page_local (
  tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  viewer TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tab_id, viewer)
);
`;

/** Page permissions the user granted (tab menu → Permissions…). Kept on this PC: never exported. */
export const PAGE_PERMISSIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS page_permissions (
  tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  perm TEXT NOT NULL,
  value TEXT NOT NULL,
  data TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tab_id, perm)
);
`;
