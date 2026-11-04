/**
 * Did loading Scribe's rarely used tools on demand (src/toolLoading.ts) change how chats go?
 * Reads the agent database read-only (the daemon keeps running) and compares turns by
 * Turn.toolLoading, per provider and mode: first-call prompt size, model calls, failed turns and
 * tools, tool searches and calls to the deferred tools. The same table is in Agent settings,
 * Harness, Stats ("Tool loading").
 *
 *   npx tsx tools/tool-loading-report.ts [days=30] [--json]
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir } from "../src/config.js";
import { harnessStats } from "../src/agent/harness.js";

const args = process.argv.slice(2);
const days = Number(args.find((a) => /^\d+$/.test(a)) ?? 30);
const db = new DatabaseSync(path.join(dataDir(), "agent.sqlite"), { readOnly: true });
const rows = (sql: string, ...params: string[]) => (db.prepare(sql).all(...params) as Array<{ data: string }>).map((r) => JSON.parse(r.data));
const stats = harnessStats(
  rows("SELECT data FROM threads"),
  (id) => rows("SELECT data FROM turns WHERE thread_id = ? ORDER BY seq", id),
  (id) => rows("SELECT data FROM items WHERE thread_id = ? ORDER BY seq", id),
  Date.now() - days * 864e5,
  rows("SELECT data FROM thread_stats")
);
db.close();

if (args.includes("--json")) {
  console.log(JSON.stringify(stats.toolLoading, null, 2));
  process.exit(0);
}
const pct = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : "-");
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
console.log(`Last ${days} days, ${stats.threads} chats. Tool loading "all" = every tool up front.\n`);
console.log(["provider", "mode", "loading", "from", "to", "turns", "1st call", "(n)", "calls/turn", "turns failed", "tools failed", "searches", "rare calls", "rare failed", "turn"].join("\t"));
for (const r of stats.toolLoading) {
  console.log([
    r.provider, r.mode, r.loading, day(r.first), day(r.last), r.turns,
    r.firstPromptMedian ?? "-", r.firstTurns, r.modelCallsPerTurn ?? "-",
    pct(r.errorTurns, r.turns), pct(r.toolErrors, r.toolCalls),
    `${r.searches}${r.searchErrors ? ` (${r.searchErrors} failed)` : ""}`, r.deferredCalls, pct(r.deferredErrors, r.deferredCalls),
    r.medianMs ? `${(r.medianMs / 1000).toFixed(1)}s` : "-",
  ].join("\t"));
}
