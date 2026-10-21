import { DatabaseSync } from "node:sqlite";
import type { PluginManifest } from "./manifest.js";

export type PluginRecord = { manifest: PluginManifest; enabled: boolean; keepAlive: boolean; hash: string; settings: Record<string, unknown>; installedAt: number };
export class PluginDatabase {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS plugins (id TEXT PRIMARY KEY, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS plugin_state (plugin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(plugin,key)); CREATE TABLE IF NOT EXISTS plugin_options (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  list(): PluginRecord[] { return this.db.prepare("SELECT record FROM plugins ORDER BY id").all().map(r => JSON.parse(String(r.record))); }
  save(record: PluginRecord): void { this.db.prepare("INSERT OR REPLACE INTO plugins VALUES (?,?)").run(record.manifest.id, JSON.stringify(record)); }
  remove(id: string): void { this.db.prepare("DELETE FROM plugins WHERE id=?").run(id); this.db.prepare("DELETE FROM plugin_state WHERE plugin=?").run(id); }
  get(plugin: string, key: string): { value: unknown; revision: number } {
    const row = this.db.prepare("SELECT value,revision FROM plugin_state WHERE plugin=? AND key=?").get(plugin, key);
    return row ? { value: JSON.parse(String(row.value)), revision: Number(row.revision) } : { value: null, revision: 0 };
  }
  set(plugin: string, key: string, value: unknown): { value: unknown; revision: number } {
    if (!key || key.length > 200) throw new Error("State key must have 1–200 characters");
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json) > 4 * 1024 ** 2) throw new Error("State value must be JSON under 4 MiB");
    this.db.prepare("INSERT INTO plugin_state VALUES (?,?,?,1) ON CONFLICT(plugin,key) DO UPDATE SET value=excluded.value, revision=revision+1").run(plugin, key, json);
    return this.get(plugin, key);
  }
  state(plugin: string): Record<string, unknown> { return Object.fromEntries(this.db.prepare("SELECT key,value FROM plugin_state WHERE plugin=?").all(plugin).map(r => [String(r.key), JSON.parse(String(r.value))])); }
  enabled(): boolean { return this.db.prepare("SELECT value FROM plugin_options WHERE key='enabled'").get()?.value !== "false"; }
  enable(value: boolean): void { this.db.prepare("INSERT OR REPLACE INTO plugin_options VALUES ('enabled',?)").run(String(value)); }
  close(): void { this.db.close(); }
}
