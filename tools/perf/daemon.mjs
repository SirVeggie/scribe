// Times the daemon's HTTP endpoints and, when the daemon was started with --inspect, takes a CPU
// profile of it while they run.
//
//   node tools/perf/daemon.mjs --base http://127.0.0.1:4791 [--inspect 9339] [--thread th_…] [--board t_…]
//        [--runs 20] [--profile daemon.cpuprofile]
//
// The board write test adds a card and comments on the board, so only run it on a scratch daemon.
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).join(" ").split(/\s*--/).filter(Boolean).map((part) => {
  const [key, ...rest] = part.trim().split(/\s+/);
  return [key, rest.join(" ") || true];
}));
const base = String(args.base || "http://127.0.0.1:4791");
if (new URL(base).port === "4747") throw new Error("Refusing to load-test the live daemon on 4747.");
const runs = Number(args.runs || 20);
const thread = String(args.thread || "th_65ebdd0c74d4");
const board = String(args.board || "t_d93be87b");
const round = (n) => Math.round(n * 10) / 10;

// The daemon treats requests without this token as an anonymous agent.
function localToken() {
  const home = process.env.SCRIBE_HOME || path.join(process.env.LOCALAPPDATA || process.env.HOME || process.cwd(), "scribe");
  try { return fs.readFileSync(path.join(home, "local-token"), "utf8").trim(); } catch { return ""; }
}
const token = localToken();

/** A minimal inspector client: enough to start and stop the profiler. */
async function inspector(port) {
  const [target] = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let next = 1;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg.result);
      waiting.delete(msg.id);
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => socket.close() };
}

function summarize(profile, top = 25) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children || []) parent.set(child, node.id);
  const key = (frame) => `${frame.functionName || "(anonymous)"} ${frame.url.replace(/^file:\/\/\/.*?\/(src|node_modules)\//, "$1/").replace(/^node:/, "node:")}${frame.lineNumber >= 0 && frame.url ? `:${frame.lineNumber + 1}` : ""}`.trim();
  const self = new Map();
  const inclusive = new Map();
  let busy = 0;
  let idle = 0;
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i] || 0) / 1000;
    if (byId.get(id).callFrame.functionName === "(idle)") return void (idle += dt);
    busy += dt;
    const k = key(byId.get(id).callFrame);
    self.set(k, (self.get(k) || 0) + dt);
    const seen = new Set();
    for (let cur = id; cur; cur = parent.get(cur)) {
      const name = key(byId.get(cur).callFrame);
      if (seen.has(name)) continue;
      seen.add(name);
      inclusive.set(name, (inclusive.get(name) || 0) + dt);
    }
  });
  const list = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([fn, ms]) => ({ fn, ms: round(ms) }));
  return { busyMs: round(busy), idleMs: round(idle), self: list(self), inclusive: list(inclusive) };
}

async function time(label, request, n = runs) {
  const times = [];
  let bytes = 0;
  let status = 0;
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    const res = await request(i);
    const body = await res.arrayBuffer();
    times.push(performance.now() - t0);
    bytes = body.byteLength;
    status = res.status;
  }
  times.sort((a, b) => a - b);
  const row = { label, status, kb: round(bytes / 1024), firstMs: undefined, medianMs: round(times[Math.floor(n / 2)]), p95Ms: round(times[Math.min(n - 1, Math.floor(n * 0.95))]), maxMs: round(times[n - 1]) };
  console.log(`${label.padEnd(44)} ${String(row.status).padStart(3)}  ${String(row.kb).padStart(8)} KB  median ${String(row.medianMs).padStart(7)} ms  p95 ${String(row.p95Ms).padStart(7)}  max ${String(row.maxMs).padStart(7)}`);
  return row;
}

const get = (path) => () => fetch(`${base}${path}`, { headers: { "x-scribe-local-token": token } });
const post = (path, body) => (i) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-scribe-local-token": token }, body: JSON.stringify(typeof body === "function" ? body(i) : body) });

const debug = args.inspect ? await inspector(Number(args.inspect)) : null;
if (debug) {
  await debug.send("Profiler.enable");
  await debug.send("Profiler.setSamplingInterval", { interval: 200 });
  await debug.send("Profiler.start");
}
const rows = [];
rows.push(await time("GET /api/health", get("/api/health")));
rows.push(await time("GET /api/tabs", get("/api/tabs")));
rows.push(await time("GET /api/library", get("/api/library")));
rows.push(await time("GET /api/search?q=kanban", get("/api/search?q=kanban")));
rows.push(await time("GET /api/agent/config", get("/api/agent/config")));
rows.push(await time("GET /api/agent/threads", get("/api/agent/threads")));
rows.push(await time(`GET /api/agent/threads/${thread}`, get(`/api/agent/threads/${thread}`)));
rows.push(await time(`GET /view/${board} (page HTML)`, () => fetch(`http://127.0.0.2:${new URL(base).port}/view/${board}`, { headers: { "x-scribe-local-token": token } })));
rows.push(await time(`GET /api/tabs/${board}/state`, get(`/api/tabs/${board}/state`)));
rows.push(await time(`POST action list (board)`, post(`/api/tabs/${board}/action`, { action: "list", args: {} })));
const made = await (await post(`/api/tabs/${board}/action`, { action: "create", args: { title: "perf probe card (daemon.mjs)" } })()).json();
const num = made?.result?.card?.num ?? made?.result?.num ?? made?.card?.num;
if (num) rows.push(await time(`POST action comment (board write)`, post(`/api/tabs/${board}/action`, (i) => ({ action: "comment", args: { card: num, text: `perf ${i}` } }))));
else console.log("board write skipped:", JSON.stringify(made).slice(0, 200));

const out = { base, runs, rows };
if (debug) {
  const { profile } = await debug.send("Profiler.stop");
  debug.close();
  out.profile = summarize(profile);
  if (args.profile) fs.writeFileSync(String(args.profile), JSON.stringify(profile));
  console.log(`\ndaemon busy ${out.profile.busyMs} ms, idle ${out.profile.idleMs} ms\n self time:`);
  for (const row of out.profile.self.slice(0, 16)) console.log(`  ${String(row.ms).padStart(8)}  ${row.fn}`);
  console.log(" inclusive:");
  for (const row of out.profile.inclusive.slice(0, 22)) console.log(`  ${String(row.ms).padStart(8)}  ${row.fn}`);
}
if (args.out) fs.writeFileSync(String(args.out), JSON.stringify(out, null, 2));
