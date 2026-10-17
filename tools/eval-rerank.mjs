// Compares the vector ranking of search by meaning with the classifier's check of it (#520), on the
// running Scribe: its index, its default classifier source and its switches. Not a unit test.
//
//   npm run eval:rerank -- [--file tools/semantic-search-proto/queries.json] [--url http://127.0.0.1:4747] [--limit 8] [--verbose]
//
// Needs Search by meaning on, a classifier source, and "Check results with the classifier" on
// (Settings → Search). The file is a JSON array of { q, want: "<page key>", card?: <number> }:
// the page (or the card on it) the query should find. Each query is searched twice, with rerank=0
// and without, so its text and the start of its closest results go to the classifier source.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const file = option("--file", new URL("./semantic-search-proto/queries.json", import.meta.url));
const url = option("--url", `http://127.0.0.1:${process.env.SCRIBE_PORT || 4747}`).replace(/\/+$/, "");
const limit = Number(option("--limit", "8"));
const verbose = args.includes("--verbose");
const queries = JSON.parse(fs.readFileSync(file, "utf8"));

// The daemon treats requests without this token as an anonymous agent.
function localToken() {
  const home = process.env.SCRIBE_HOME || path.join(process.env.LOCALAPPDATA || process.env.HOME || process.cwd(), "scribe");
  try { return fs.readFileSync(path.join(home, "local-token"), "utf8").trim(); } catch { return ""; }
}
const token = localToken();

async function search(query, rerank) {
  const params = new URLSearchParams({ q: query.q, scope: query.card ? "chunks" : "pages", limit: String(limit) });
  if (!rerank) params.set("rerank", "0");
  const started = Date.now();
  const res = await fetch(`${url}/api/search/semantic?${params}`, { headers: { "x-scribe-local-token": token } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Search failed (${res.status}): ${body.error || "no answer"}. Is Search by meaning on in the Scribe at ${url}?`);
  return { hits: body.hits, info: body.rerank, ms: Date.now() - started };
}
const fits = (query, hit) => hit.key === query.want && (!query.card || (hit.kind === "record" && hit.anchor === String(query.card)));
const rank = (query, hits) => hits.findIndex(hit => fits(query, hit)) + 1;
const show = r => r ? String(r) : "–";
const percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;

const rows = [];
for (const query of queries) {
  // The plain search first, so the query's vector is cached and the second time is the classifier's.
  const before = await search(query, false);
  const after = await search(query, true);
  if (!after.info) throw new Error("The search was not checked. Add a classifier source, and switch on Check results with the classifier (Settings → Search) and Tool results (Classifier, what may be sent).");
  const row = { q: query.q, before: rank(query, before.hits), after: rank(query, after.hits), shown: [before.hits.length, after.hits.length], info: after.info, ms: after.ms - before.ms };
  rows.push(row);
  const mark = row.after && (!row.before || row.after < row.before) ? "BETTER" : row.before && (!row.after || row.after > row.before) ? "WORSE " : "same  ";
  console.log(`${mark} rank ${show(row.before)} → ${show(row.after)}  shown ${row.shown[0]} → ${row.shown[1]}  ${row.info.applied ? `${row.info.ms} ms${row.info.cached ? " (cached)" : ""}` : `not applied: ${row.info.reason}`}  ${query.q}`);
  if (verbose) {
    const line = hit => `${fits(query, hit) ? "*" : " "} ${hit.title}${hit.kind === "page" ? "" : ` › ${hit.label}`}`;
    console.log(`     before: ${before.hits.map(line).join(" | ")}\n     after:  ${after.hits.map(line).join(" | ")}`);
  }
}

const applied = rows.filter(r => r.info.applied);
const summary = which => ({
  top1: rows.filter(r => r[which] === 1).length,
  top3: rows.filter(r => r[which] && r[which] <= 3).length,
  found: rows.filter(r => r[which]).length,
  mrr: Number((rows.reduce((sum, r) => sum + (r[which] ? 1 / r[which] : 0), 0) / rows.length).toFixed(3)),
  // Results shown that are not the wanted one: what the check is meant to cut.
  others: rows.reduce((sum, r) => sum + r.shown[which === "before" ? 0 : 1] - (r[which] ? 1 : 0), 0),
});
const times = applied.filter(r => !r.info.cached).map(r => r.info.ms).sort((a, b) => a - b);
console.log(JSON.stringify({
  queries: rows.length,
  before: summary("before"),
  after: summary("after"),
  better: rows.filter(r => r.after && (!r.before || r.after < r.before)).length,
  worse: rows.filter(r => r.before && (!r.after || r.after > r.before)).length,
  wantedDropped: rows.filter(r => r.before && !r.after).length,
  notApplied: Object.fromEntries([...new Set(rows.filter(r => !r.info.applied).map(r => r.info.reason))].map(reason => [reason, rows.filter(r => !r.info.applied && r.info.reason === reason).length])),
  classifierMs: { median: percentile(times, 0.5), p95: percentile(times, 0.95), max: times.at(-1) ?? 0 },
}, null, 2));
