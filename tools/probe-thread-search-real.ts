/**
 * Read-only probe for #602: how much of the real agent history is searchable message text, and how fast
 * the current JSON LIKE scan, a text-only table and an in-memory scan answer on it. Opens the database
 * read-only and prints only counts, sizes and timings, never message text.
 * Usage: npx tsx tools/probe-thread-search-real.ts [path to agent.sqlite]
 */
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { matchMessages, searchWords } from "../src/agent/threadSearch.js";
const file = process.argv[2] ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share"), "scribe", "agent.sqlite");
const src = new DatabaseSync(file, { readOnly: true });
let t = performance.now();
const rows = src.prepare(`SELECT thread_id threadId, seq, json_extract(data,'$.text') text FROM items WHERE json_extract(data,'$.kind') IN ('user','text') AND json_extract(data,'$.dropped') IS NOT 1 AND json_extract(data,'$.parentToolId') IS NULL ORDER BY thread_id, seq`).all() as any[];
const loadMs = performance.now() - t;
const total = src.prepare("SELECT COUNT(*) n, SUM(LENGTH(data)) bytes FROM items").get();
const textBytes = rows.reduce((n, r) => n + (typeof r.text === "string" ? Buffer.byteLength(r.text) : 0), 0);
console.log({ items: total, searchable: { messages: rows.length, threads: new Set(rows.map((r) => r.threadId)).size, textBytes } });
const like = (w: string) => { const s = performance.now(); src.prepare(`SELECT thread_id, json_extract(data,'$.text') FROM items WHERE data LIKE ? AND json_extract(data,'$.kind') IN ('user','text') AND json_extract(data,'$.dropped') IS NOT 1 AND json_extract(data,'$.parentToolId') IS NULL ORDER BY thread_id, seq`).all(`%${w}%`); return Math.round(performance.now() - s); };
for (const w of ["missingneedle", "x", "project"]) console.log(`current JSON LIKE scan, ${w}:`, like(w), "ms");
const mem = new DatabaseSync(":memory:");
mem.exec("CREATE TABLE st (thread_id TEXT, seq INT, text TEXT, lower TEXT)");
const ins = mem.prepare("INSERT INTO st VALUES (?,?,?,?)");
t = performance.now(); mem.exec("BEGIN"); for (const r of rows) if (typeof r.text === "string") ins.run(r.threadId, r.seq, r.text, r.text.toLowerCase()); mem.exec("COMMIT");
const buildMs = performance.now() - t;
const lowered = rows.filter(r => typeof r.text === "string").map(r => ({ threadId: r.threadId, text: r.text, lower: r.text.toLowerCase() }));
const med = (f: () => void) => { const a: number[] = []; for (let i = 0; i < 9; i++) { const s = performance.now(); f(); a.push(performance.now() - s); } a.sort((x, y) => x - y); return +a[4].toFixed(2); };
console.log({ loadMs: Math.round(loadMs), buildMs: Math.round(buildMs), heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576) });
for (const q of ["missingneedle", "x", "h2", "project", "llama.cpp h2o", "x llama.cpp", "the search worker"]) {
  const words = searchWords(q);
  const sql = med(() => { const pats = words.map(w => `%${w}%`); matchMessages(mem.prepare(`SELECT thread_id threadId, text FROM st WHERE ${pats.map(() => "instr(lower, ?) > 0").join(" OR ")} ORDER BY thread_id, seq`).iterate(...words) as any, words); });
  const js = med(() => matchMessages(lowered.filter(r => words.some(w => r.lower.includes(w))), words));
  console.log(q.padEnd(20), "projectedSQL", sql, "ms   inMemory", js, "ms");
}
