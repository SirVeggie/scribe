import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type TaskStatus = "running" | "done" | "failed" | "stopped" | "interrupted";
export type TaskCaller = { kind: "page" | "agent" | "system"; page?: string; thread?: string };
export type PluginTask = {
  id: string; plugin: string; title: string; status: TaskStatus;
  progress?: { text?: string; pct?: number }; lines: string[];
  result?: unknown; error?: string;
  caller: TaskCaller["kind"]; thread?: string; page?: string;
  startedAt: number; updatedAt: number; endedAt?: number; stopRequested?: boolean;
};
/** What clients see: the record plus stale (running, but no update for STALE_MS). */
export type TaskView = PluginTask & { stale: boolean };

/** A running task with no progress for this long shows as stale. It is not stopped. */
export const STALE_MS = 5 * 60_000;
const LINES = 20, LINE_CHARS = 500, TEXT_CHARS = 300, RESULT_BYTES = 32 * 1024, KEEP = 50, RUNNING = 32, EMIT_MS = 400;
const clip = (value: unknown, max: number) => String(value ?? "").slice(0, max);

/**
 * Plugin tasks (ctx.task): their records in the plugin database, so finished ones stay readable and
 * ones a restart cut off show as interrupted. Changes go out as the plugin's "task" event, throttled.
 */
export class PluginTasks {
  private live = new Map<string, PluginTask>();
  private timers = new Map<string, NodeJS.Timeout>();
  private waiters = new Map<string, Set<() => void>>();
  constructor(private db: DatabaseSync, private emit: (plugin: string, task: TaskView) => void, private now = () => Date.now()) {
    db.exec("CREATE TABLE IF NOT EXISTS plugin_tasks (id TEXT PRIMARY KEY, plugin TEXT NOT NULL, started INTEGER NOT NULL, record TEXT NOT NULL)");
    // Nothing is running after a restart.
    for (const row of db.prepare("SELECT record FROM plugin_tasks").all()) {
      const task = JSON.parse(String(row.record)) as PluginTask;
      if (task.status === "running") this.end(task, "interrupted", { error: "Scribe restarted while the task was running" });
    }
  }
  view(task: PluginTask): TaskView { return { ...task, stale: task.status === "running" && this.now() - task.updatedAt > STALE_MS }; }
  get(id: string): TaskView | undefined {
    const task = this.live.get(id) ?? this.read(id);
    return task && this.view(task);
  }
  private read(id: string): PluginTask | undefined {
    const row = this.db.prepare("SELECT record FROM plugin_tasks WHERE id=?").get(id);
    return row ? JSON.parse(String(row.record)) : undefined;
  }
  /** Newest first. */
  list(filter: { plugin?: string; thread?: string; limit?: number } = {}): TaskView[] {
    const where = filter.plugin ? "WHERE plugin=?" : "", args = filter.plugin ? [filter.plugin] : [];
    const rows = this.db.prepare(`SELECT id,record FROM plugin_tasks ${where} ORDER BY started DESC`).all(...args);
    return rows.map(row => this.live.get(String(row.id)) ?? JSON.parse(String(row.record)) as PluginTask)
      .filter(task => !filter.thread || task.thread === filter.thread).slice(0, filter.limit ?? KEEP).map(task => this.view(task));
  }
  start(plugin: string, title: string, caller: TaskCaller): TaskView {
    if ([...this.live.values()].filter(task => task.plugin === plugin).length >= RUNNING) throw new Error("Plugin has too many running tasks");
    const at = this.now();
    const task: PluginTask = { id: `task_${randomUUID().slice(0, 12)}`, plugin, title: clip(title, 200) || "Task", status: "running", lines: [], caller: caller.kind, ...(caller.thread ? { thread: caller.thread } : {}), ...(caller.page ? { page: caller.page } : {}), startedAt: at, updatedAt: at };
    this.live.set(task.id, task);
    this.save(task); this.prune(plugin); this.emit(plugin, this.view(task));
    return this.view(task);
  }
  private running(plugin: string, id: string): PluginTask {
    const task = this.live.get(id);
    if (!task || task.plugin !== plugin) throw new Error("Task is not running");
    return task;
  }
  progress(plugin: string, id: string, update: { text?: unknown; pct?: unknown }): void {
    const task = this.running(plugin, id), pct = Number(update.pct);
    task.progress = { ...(update.text != null ? { text: clip(update.text, TEXT_CHARS) } : task.progress?.text ? { text: task.progress.text } : {}), ...(update.pct != null && Number.isFinite(pct) ? { pct: Math.max(0, Math.min(100, Math.round(pct * 10) / 10)) } : {}) };
    this.touch(task);
  }
  log(plugin: string, id: string, line: unknown): void {
    const task = this.running(plugin, id);
    task.lines.push(clip(line, LINE_CHARS)); if (task.lines.length > LINES) task.lines.splice(0, task.lines.length - LINES);
    this.touch(task);
  }
  finish(plugin: string, id: string, outcome: { result?: unknown; error?: unknown }): void {
    const task = this.running(plugin, id);
    if (outcome.error !== undefined) { this.end(task, task.stopRequested ? "stopped" : "failed", { error: clip(outcome.error, 2000) }); return; }
    const json = JSON.stringify(outcome.result ?? null);
    if (Buffer.byteLength(json) > RESULT_BYTES) { this.end(task, "failed", { error: "Task result exceeds 32 KiB" }); return; }
    this.end(task, task.stopRequested && outcome.result === undefined ? "stopped" : "done", { result: JSON.parse(json) });
  }
  /** Asks the plugin to stop (its t.signal aborts). The task ends when the plugin calls done or fail. */
  requestStop(plugin: string, id: string): TaskView {
    const task = this.running(plugin, id);
    task.stopRequested = true; this.touch(task, true);
    return this.view(task);
  }
  /** The backend stopped: whatever it was running is cut off. */
  interrupt(plugin: string, reason = "The plugin backend stopped"): void {
    for (const task of [...this.live.values()]) if (task.plugin === plugin) this.end(task, task.stopRequested ? "stopped" : "interrupted", { error: reason });
  }
  remove(plugin: string): void {
    for (const task of [...this.live.values()]) if (task.plugin === plugin) { this.live.delete(task.id); this.wake(task.id); }
    this.db.prepare("DELETE FROM plugin_tasks WHERE plugin=?").run(plugin);
  }
  /** Resolves once the task has ended, or after ms, or when signal aborts. */
  async wait(id: string, ms: number, signal?: AbortSignal): Promise<{ task?: TaskView; timedOut: boolean }> {
    if (!this.live.has(id) || ms <= 0) return { task: this.get(id), timedOut: this.live.has(id) };
    let ended = false;
    await new Promise<void>(resolve => {
      const set = this.waiters.get(id) ?? new Set<() => void>(); this.waiters.set(id, set);
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); set.delete(wake); if (!set.size) this.waiters.delete(id); resolve(); };
      const wake = () => { ended = true; done(); };
      const timer = setTimeout(done, ms);
      set.add(wake); signal?.addEventListener("abort", done, { once: true });
    });
    return { task: this.get(id), timedOut: !ended };
  }
  private wake(id: string): void { for (const fn of [...this.waiters.get(id) ?? []]) fn(); }
  private touch(task: PluginTask, now = false): void {
    task.updatedAt = this.now();
    if (now) { this.flush(task.id); return; }
    if (!this.timers.has(task.id)) this.timers.set(task.id, setTimeout(() => this.flush(task.id), EMIT_MS));
  }
  private flush(id: string): void {
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    const task = this.live.get(id); if (!task) return;
    this.save(task); this.emit(task.plugin, this.view(task));
  }
  private end(task: PluginTask, status: TaskStatus, outcome: { result?: unknown; error?: string }): void {
    clearTimeout(this.timers.get(task.id)); this.timers.delete(task.id); this.live.delete(task.id);
    Object.assign(task, { status, endedAt: this.now(), updatedAt: this.now() }, outcome.error !== undefined ? { error: outcome.error } : {}, "result" in outcome ? { result: outcome.result } : {});
    this.save(task); this.emit(task.plugin, this.view(task)); this.wake(task.id);
  }
  private save(task: PluginTask): void {
    try { this.db.prepare("INSERT OR REPLACE INTO plugin_tasks VALUES (?,?,?,?)").run(task.id, task.plugin, task.startedAt, JSON.stringify(task)); }
    catch { /* The database closes during shutdown; the record then stays as last saved. */ }
  }
  /** Keeps the newest KEEP finished tasks of a plugin. */
  private prune(plugin: string): void {
    this.db.prepare(`DELETE FROM plugin_tasks WHERE plugin=? AND json_extract(record,'$.status')!='running' AND id NOT IN (SELECT id FROM plugin_tasks WHERE plugin=? ORDER BY started DESC LIMIT ${KEEP})`).run(plugin, plugin);
  }
}
