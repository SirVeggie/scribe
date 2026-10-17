// Profiles the Scribe UI in a headless Chromium against a scratch daemon (see prepare-data.mjs).
//
//   node tools/perf/profile.mjs --base http://127.0.0.1:4791 --out perf.json [--thread th_…] [--thread2 th_…]
//        [--board t_…] [--only load,idle,board,thread,stream,type,list] [--profiles dir] [--fx off]
//        [--shields off] [--trace]
//
// --trace also records a Chrome trace per scenario and reports where the renderer's main thread
// spent its time by kind of work (Layout, Paint, UpdateLayoutTree, FunctionCall, …): what a CPU
// profile lumps together as "(program)". With --profiles the raw trace is kept as a .trace.json.
//
// --fx off turns Scribe's UI effects (title bar shader, aurora edge) off first, to see what they
// cost. --shields off starts Brave without its cosmetic filtering, which otherwise scans the DOM.
//
// Each scenario reports wall time, the renderer's main-thread time (CDP Performance.getMetrics
// deltas: task, script, layout, style), long tasks, DOM size, CPU time per browser process, and
// the functions with the most self time from a CPU profile. --profiles also writes each profile
// as a .cpuprofile file that Chrome DevTools (Performance → Load profile) opens.
//
// stream sends a message, so never point this at a daemon without SCRIBE_FAKE_AGENTS=1.
import fs from "node:fs";
import path from "node:path";
import { launch } from "./launch.mjs";

const args = Object.fromEntries(process.argv.slice(2).join(" ").split(/\s*--/).filter(Boolean).map((part) => {
  const [key, ...rest] = part.trim().split(/\s+/);
  return [key, rest.join(" ") || true];
}));
const base = String(args.base || "http://127.0.0.1:4791");
const only = args.only ? new Set(String(args.only).split(",")) : null;
const wants = (name) => !only || only.has(name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// The daemon treats requests without this token as an anonymous agent.
function localToken() {
  const home = process.env.SCRIBE_HOME || path.join(process.env.LOCALAPPDATA || process.env.HOME || process.cwd(), "scribe");
  try { return fs.readFileSync(path.join(home, "local-token"), "utf8").trim(); } catch { return ""; }
}
const token = localToken();

const health = await (await fetch(`${base}/api/health`)).json();
if (new URL(base).port === "4747" && !args.live) {
  throw new Error("Refusing to profile the live daemon on 4747. Use a scratch daemon (tools/perf/prepare-data.mjs).");
}

const launchArgs = ["--enable-precise-memory-info"];
if (args.shields === "off") launchArgs.push("--disable-features=BraveAdblockCosmeticFiltering");
const { browser, name: browserName } = await launch({ args: launchArgs });
const results = { base, browser: `${browserName} ${browser.version()}`, daemon: health.version, at: new Date().toISOString(), fx: args.fx === "off" ? "off" : "default", shields: args.shields === "off" ? "off" : "default", scenarios: {} };
const system = await browser.newBrowserCDPSession();

/** CPU seconds per browser process type (browser, renderer, gpu, utility). */
async function processCpu() {
  const { processInfo } = await system.send("SystemInfo.getProcessInfo");
  const out = {};
  for (const p of processInfo) out[p.type] = (out[p.type] || 0) + p.cpuTime;
  return out;
}

function summarize(profile, top = 12) {
  const self = new Map();
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const deltas = profile.timeDeltas || [];
  let total = 0;
  profile.samples.forEach((id, i) => {
    const node = byId.get(id);
    const dt = (deltas[i] || 0) / 1000;
    const frame = node.callFrame;
    if (frame.functionName === "(idle)" || frame.functionName === "(program)" && false) return;
    total += dt;
    const file = frame.url ? frame.url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "") : "";
    const key = `${frame.functionName || "(anonymous)"} ${file}${frame.lineNumber >= 0 && file ? `:${frame.lineNumber + 1}` : ""}`.trim();
    self.set(key, (self.get(key) || 0) + dt);
  });
  return {
    sampledMs: round(total),
    top: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([fn, ms]) => ({ fn, ms: round(ms) })),
  };
}

class Probe {
  constructor(session, label) {
    this.session = session;
    this.label = label;
  }
  static async on(context, target, label) {
    const session = await context.newCDPSession(target);
    await session.send("Performance.enable");
    await session.send("Profiler.enable");
    await session.send("Profiler.setSamplingInterval", { interval: 200 });
    return new Probe(session, label);
  }
  async metrics() {
    const { metrics } = await this.session.send("Performance.getMetrics");
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  }
  async start() {
    this.before = await this.metrics();
    await this.session.send("Profiler.start");
  }
  async stop(name) {
    const { profile } = await this.session.send("Profiler.stop");
    const after = await this.metrics();
    // Nodes counts detached ones too until they are collected, so collect before reading it.
    await this.session.send("HeapProfiler.collectGarbage").catch(() => {});
    const collected = await this.metrics();
    const ms = (key) => round((after[key] - this.before[key]) * 1000);
    if (args.profiles) {
      fs.mkdirSync(String(args.profiles), { recursive: true });
      fs.writeFileSync(path.join(String(args.profiles), `${name}-${this.label}.cpuprofile`), JSON.stringify(profile));
    }
    return {
      taskMs: ms("TaskDuration"),
      scriptMs: ms("ScriptDuration"),
      layoutMs: ms("LayoutDuration"),
      styleMs: ms("RecalcStyleDuration"),
      layouts: after.LayoutCount - this.before.LayoutCount,
      styleRecalcs: after.RecalcStyleCount - this.before.RecalcStyleCount,
      nodes: collected.Nodes,
      nodesBeforeGc: after.Nodes,
      listeners: collected.JSEventListeners,
      heapMb: round(collected.JSHeapUsedSize / 1048576),
      profile: summarize(profile),
    };
  }
}

/** Long tasks and paints, collected in every frame from its first script on. */
const INIT = `(() => {
  if (window.__perf) return;
  const perf = (window.__perf = { long: [], paints: {}, lcp: 0 });
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) perf.long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((list) => { for (const e of list.getEntries()) perf.paints[e.name] = Math.round(e.startTime); }).observe({ type: "paint", buffered: true });
    new PerformanceObserver((list) => { for (const e of list.getEntries()) perf.lcp = Math.round(e.startTime); }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}
})();`;

async function longTasks(target, sinceMs) {
  const all = await target.evaluate(() => window.__perf?.long ?? []).catch(() => []);
  const mine = all.filter(([start]) => start >= sinceMs);
  return { count: mine.length, totalMs: mine.reduce((sum, [, d]) => sum + d, 0), maxMs: mine.reduce((max, [, d]) => Math.max(max, d), 0) };
}

const now = (target) => target.evaluate(() => performance.now());
/** Two frames on: the work a change queued has been laid out and painted. */
const settle = (target) => target.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))));

async function newShell() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(INIT);
  if (args.fx === "off") {
    await context.addInitScript(() => {
      try {
        localStorage.setItem("scribe.uiEffects", "0");
        localStorage.setItem("scribe.chromeFx", "off");
        localStorage.setItem("scribe.auroraEdge", "0");
        localStorage.setItem("scribe.auroraIdle", "0");
      } catch {}
    });
  }
  const page = await context.newPage();
  const ws = { frames: 0, bytes: 0, types: {} };
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      const text = typeof payload === "string" ? payload : "";
      const type = /"type":"([a-z_]+)"/.exec(text.slice(0, 200))?.[1] ?? "other";
      ws.frames += 1;
      ws.bytes += payload.length;
      const slot = (ws.types[type] ??= { n: 0, bytes: 0 });
      slot.n += 1;
      slot.bytes += payload.length;
      page.emit("scribe-ws", { type, text });
    });
  });
  return { context, page, ws };
}

async function loadShell(page) {
  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction(() => window.scribeChat && window.scribeApp, null, { timeout: 15000 });
  await page.waitForLoadState("networkidle").catch(() => {});
}

/** Self time per kind of timeline event on the renderer main thread that did the most work. */
function summarizeTrace(buffer) {
  const events = JSON.parse(buffer.toString("utf8")).traceEvents || [];
  const mains = new Set(events.filter((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`));
  const perThread = new Map();
  for (const e of events) {
    if (e.ph !== "X" || !e.dur || !mains.has(`${e.pid}:${e.tid}`) || !String(e.cat).includes("devtools.timeline")) continue;
    if (!perThread.has(`${e.pid}:${e.tid}`)) perThread.set(`${e.pid}:${e.tid}`, []);
    perThread.get(`${e.pid}:${e.tid}`).push(e);
  }
  let best = null;
  for (const list of perThread.values()) {
    list.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const self = {};
    const counts = {};
    const stack = [];
    let total = 0;
    for (const e of list) {
      while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= e.ts) stack.pop();
      const parent = stack.at(-1);
      if (parent) self[parent.name] -= e.dur / 1000;
      else total += e.dur / 1000;
      self[e.name] = (self[e.name] || 0) + e.dur / 1000;
      counts[e.name] = (counts[e.name] || 0) + 1;
      stack.push(e);
    }
    if (!best || total > best.total) best = { total, self, counts };
  }
  if (!best) return null;
  return {
    totalMs: round(best.total),
    byKind: Object.entries(best.self).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([kind, ms]) => ({ kind, ms: round(ms), n: best.counts[kind] })),
  };
}

/** Run one step under the probes and report it. */
async function measure(name, page, probes, step, { frame } = {}) {
  const cpu0 = await processCpu();
  const t0 = await now(page);
  if (args.trace) await browser.startTracing(page, { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink.user_timing"] });
  for (const probe of probes) await probe.start();
  const wall0 = Date.now();
  const extra = (await step()) || {};
  const wallMs = Date.now() - wall0;
  const out = { wallMs, ...extra };
  if (args.trace) {
    const buffer = await browser.stopTracing();
    out.trace = summarizeTrace(buffer);
    if (args.profiles) {
      fs.mkdirSync(String(args.profiles), { recursive: true });
      fs.writeFileSync(path.join(String(args.profiles), `${name}.trace.json`), buffer);
    }
  }
  for (const probe of probes) out[probe.label] = await probe.stop(name);
  out.longTasks = await longTasks(page, t0);
  if (frame) out.frameLongTasks = await longTasks(frame, 0);
  const cpu1 = await processCpu();
  out.processCpuMs = Object.fromEntries(Object.keys(cpu1).map((type) => [type, round((cpu1[type] - (cpu0[type] || 0)) * 1000)]));
  results.scenarios[name] = out;
  const main = out.shell;
  console.log(`${name.padEnd(28)} wall ${String(wallMs).padStart(6)} ms  task ${String(main?.taskMs).padStart(7)}  script ${String(main?.scriptMs).padStart(7)}  layout ${String(main?.layoutMs).padStart(6)}  style ${String(main?.styleMs).padStart(6)}  long ${out.longTasks.count}/${out.longTasks.maxMs}ms  nodes ${main?.nodes}`);
  return out;
}

// ---- cold load -------------------------------------------------------------------------------
if (wants("load")) {
  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    const { context, page, ws } = await newShell();
    const requests = [];
    page.on("response", (res) => requests.push({ url: res.url().replace(base, ""), bytes: Number(res.headers()["content-length"] || 0), encoding: res.headers()["content-encoding"] || "", cache: res.headers()["cache-control"] || "" }));
    const probe = await Probe.on(context, page, "shell");
    await probe.start();
    const wall0 = Date.now();
    await loadShell(page);
    const wallMs = Date.now() - wall0;
    const shell = await probe.stop(`load-${i}`);
    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      return { domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd), loadMs: Math.round(nav.loadEventEnd), fcpMs: window.__perf.paints["first-contentful-paint"], lcpMs: window.__perf.lcp, threads: document.querySelectorAll("*").length };
    });
    const counts = {};
    for (const r of requests) counts[r.url] = (counts[r.url] || 0) + 1;
    runs.push({
      wallMs,
      ...timing,
      shell,
      longTasks: await longTasks(page, 0),
      requests: requests.length,
      bytes: requests.reduce((sum, r) => sum + r.bytes, 0),
      scriptBytes: requests.filter((r) => /\.js(\?|$)/.test(r.url)).reduce((sum, r) => sum + r.bytes, 0),
      compressed: requests.filter((r) => r.encoding && r.url.startsWith("/")).length,
      duplicates: Object.entries(counts).filter(([, n]) => n > 1).map(([url, n]) => ({ url, n, bytes: requests.find((r) => r.url === url).bytes })),
      ws: { ...ws },
    });
    await context.close();
  }
  runs.sort((a, b) => a.wallMs - b.wallMs);
  results.scenarios.load = { runs: runs.map((r) => ({ wallMs: r.wallMs, domContentLoadedMs: r.domContentLoadedMs, loadMs: r.loadMs, fcpMs: r.fcpMs, taskMs: r.shell.taskMs, scriptMs: r.shell.scriptMs })), median: runs[1] };
  const m = runs[1];
  console.log(`load (median of 3)           wall ${m.wallMs} ms  DCL ${m.domContentLoadedMs}  load ${m.loadMs}  FCP ${m.fcpMs}  script ${m.shell.scriptMs}  requests ${m.requests}  ${round(m.bytes / 1024)} KB  dup ${m.duplicates.length}`);
}

// ---- one long-lived shell for the rest ---------------------------------------------------------
const { context, page, ws } = await newShell();
await loadShell(page);
const shell = await Probe.on(context, page, "shell");
const threads = await (await fetch(`${base}/api/agent/threads`, { headers: { "x-scribe-local-token": token } })).json();
const tabs = await (await fetch(`${base}/api/tabs`, { headers: { "x-scribe-local-token": token } })).json();
results.data = { threads: threads.threads.length, openTabs: tabs.tabs?.length };

async function idle(name, seconds = 10) {
  await sleep(1500);
  await measure(name, page, [shell], async () => {
    await sleep(seconds * 1000);
    return { seconds };
  });
}

if (wants("idle")) {
  await page.evaluate(() => window.scribeApp && (location.hash = ""));
  await idle("idle-start-tab");
}

// ---- kanban board ------------------------------------------------------------------------------
const boardId = String(args.board || "t_d93be87b");
const boardFrame = () => page.frames().find((f) => f.url().includes(`/view/${boardId}`));
if (wants("board")) {
  await measure("board-open", page, [shell], async () => {
    await page.evaluate((id) => (location.hash = `#${id}`), boardId);
    await page.waitForFunction((id) => [...document.querySelectorAll("iframe")].some((f) => f.src.includes(id)), boardId);
    const frame = await (async () => {
      for (let i = 0; i < 200; i += 1) {
        const f = boardFrame();
        if (f) return f;
        await sleep(25);
      }
    })();
    await frame.waitForLoadState("load");
    await frame.waitForFunction(() => document.querySelectorAll(".card").length > 0, null, { timeout: 20000 }).catch(() => {});
    await settle(frame);
    return frame.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      return { frame: { htmlKb: Math.round(nav.encodedBodySize / 1024), responseMs: Math.round(nav.responseEnd), domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd), loadMs: Math.round(nav.loadEventEnd), fcpMs: window.__perf?.paints["first-contentful-paint"], nodes: document.querySelectorAll("*").length, cards: document.querySelectorAll(".card").length, longTasks: window.__perf?.long.length, longMs: window.__perf?.long.reduce((s, e) => s + e[1], 0) } };
    });
  });
  const frame = boardFrame();
  if (frame) {
    const inner = await Probe.on(context, frame, "frame").catch(() => null);
    if (inner) {
      // A change another client makes: the whole board state comes back over the socket.
      const card = await (await fetch(`${base}/api/tabs/${boardId}/action`, { method: "POST", headers: { "content-type": "application/json", "x-scribe-local-token": token }, body: JSON.stringify({ action: "create", args: { title: "perf probe card" } }) })).json().catch(() => null);
      const num = card?.result?.card?.num ?? card?.card?.num ?? card?.result?.num;
      results.scenarios["board-probe-card"] = { num, raw: num ? undefined : JSON.stringify(card).slice(0, 300) };
      if (num) {
        const before = { ...ws.types };
        await measure("board-remote-update-x10", page, [shell, inner], async () => {
          for (let i = 0; i < 10; i += 1) {
            await fetch(`${base}/api/tabs/${boardId}/action`, { method: "POST", headers: { "content-type": "application/json", "x-scribe-local-token": token }, body: JSON.stringify({ action: "comment", args: { card: num, text: `perf ${i}` } }) });
            await sleep(150);
          }
          await settle(frame);
          const sent = {};
          for (const [type, slot] of Object.entries(ws.types)) {
            const was = before[type] || { n: 0, bytes: 0 };
            if (slot.n > was.n) sent[type] = { n: slot.n - was.n, kb: round((slot.bytes - was.bytes) / 1024) };
          }
          return { socket: sent };
        });
      }
      await sleep(1000);
      await measure("idle-board", page, [shell, inner], async () => {
        await sleep(10000);
        return { seconds: 10 };
      });
    }
  }
}

// ---- chat threads ------------------------------------------------------------------------------
const bySize = threads.threads.filter((t) => !t.archived);
const threadId = String(args.thread || "th_65ebdd0c74d4");
const thread2 = String(args.thread2 || "th_3ad3e5e5237d");
const view = "#agent-pane";

/** Resolves once the chat pane has gone quiet for 300 ms, with the time of its last change. */
const paneQuiet = () => page.evaluate(() => new Promise((resolve) => {
  const pane = document.querySelector("#agent-pane");
  const start = performance.now();
  let last = start;
  let changes = 0;
  const observer = new MutationObserver((list) => { last = performance.now(); changes += list.length; });
  observer.observe(pane, { childList: true, subtree: true, characterData: true });
  const check = () => {
    if (performance.now() - last < 300) return void setTimeout(check, 50);
    observer.disconnect();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve({ renderedMs: Math.round(last - start), changes })));
  };
  setTimeout(check, 50);
}));

async function openThread(id) {
  let fetched = null;
  const onResponse = (res) => {
    if (new URL(res.url()).pathname === `/api/agent/threads/${id}`) fetched = { ms: Date.now() - t0, kb: round(Number(res.headers()["content-length"] || 0) / 1024) };
  };
  page.on("response", onResponse);
  const t0 = Date.now();
  const quiet = paneQuiet();
  await page.evaluate((thread) => window.scribeChat.openThread(thread), id);
  const { renderedMs, changes } = await quiet;
  page.off("response", onResponse);
  return {
    renderedMs,
    changes,
    fetchMs: fetched?.ms ?? 0,
    detailKb: fetched?.kb ?? 0,
    transcript: await page.evaluate(() => {
      const root = document.querySelector("#agent-pane .ag-transcript");
      const count = (sel) => root.querySelectorAll(sel).length;
      const hidden = [...root.querySelectorAll(".ag-tool-body, .ag-reason-body, .ag-group-body")].filter((el) => el.offsetParent === null);
      return { nodes: count("*"), turns: count(".ag-turn"), tools: count(".ag-tool"), diffLines: count(".ag-dl"), hiddenBodies: hidden.length, nodesInHiddenBodies: hidden.reduce((sum, el) => sum + el.querySelectorAll("*").length, 0), scrollHeight: root.scrollHeight };
    }),
  };
}

if (wants("thread")) {
  if (!bySize.some((t) => t.id === threadId)) throw new Error(`No thread ${threadId} on ${base}; pass --thread`);
  await measure("thread-open-first", page, [shell], () => openThread(threadId));
  await measure("thread-switch-other", page, [shell], () => openThread(thread2));
  await measure("thread-switch-back", page, [shell], () => openThread(threadId));
  // Ten more switches: does the DOM or the heap keep growing?
  await measure("thread-switch-x10", page, [shell], async () => {
    const times = [];
    for (let i = 0; i < 10; i += 1) times.push((await openThread(i % 2 ? threadId : thread2)).renderedMs);
    return { renderedMs: times };
  });
  await idle("idle-thread-open");
}

if (wants("list")) {
  await measure("thread-list-open", page, [shell], async () => {
    const toggled = await page.evaluate(() => {
      const button = [...document.querySelectorAll("#agent-pane .ag-icon-btn")].find((b) => /Threads/.test(b.getAttribute("data-tooltip") || b.title || b.getAttribute("aria-label") || ""));
      button?.click();
      return Boolean(button);
    });
    await settle(page);
    return { toggled, list: await page.evaluate(() => ({ nodes: document.querySelectorAll("#agent-pane .ag-list *").length, rows: document.querySelector("#agent-pane .ag-list")?.children.length ?? 0 })) };
  });
  await openThread(threadId);
}

const composer = page.locator(`${view} textarea.ag-textarea`).first();

if (wants("type")) {
  await composer.click();
  await measure("composer-type-60-chars", page, [shell], async () => {
    const lat = await page.evaluate(() => {
      window.__keys = [];
      new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name === "keydown" || e.name === "input") window.__keys.push(Math.round(e.duration)); }).observe({ type: "event", durationThreshold: 16, buffered: false });
    });
    await page.keyboard.type("The quick brown fox jumps over the lazy dog, again and again.", { delay: 30 });
    await settle(page);
    const keys = await page.evaluate(() => window.__keys);
    return { slowEvents: keys.length, worstEventMs: Math.max(0, ...keys) };
  });
  await composer.fill("");
}

if (wants("stream")) {
  const steps = Number(args.steps || 30);
  const before = { ...Object.fromEntries(Object.entries(ws.types).map(([k, v]) => [k, { ...v }])) };
  await composer.click();
  await composer.fill(`[fake:stream=${steps}] [fake:delay=200] perf stream probe`);
  await measure(`stream-${steps}-steps`, page, [shell], async () => {
    let done;
    const finished = new Promise((resolve) => (done = resolve));
    let sawRunning = false;
    const onFrame = ({ type, text }) => {
      if (type !== "agent_thread" || !text.includes(threadId)) return;
      if (/"status":"running"/.test(text)) sawRunning = true;
      else if (sawRunning && /"status":"idle"/.test(text)) done();
    };
    page.on("scribe-ws", onFrame);
    const frames0 = await page.evaluate(() => {
      window.__frames = 0;
      const tick = () => { window.__frames += 1; window.__raf = requestAnimationFrame(tick); };
      tick();
    });
    await page.keyboard.press("Enter");
    await Promise.race([finished, sleep(90000)]);
    page.off("scribe-ws", onFrame);
    await settle(page);
    const frames = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__frames; });
    const sent = {};
    for (const [type, slot] of Object.entries(ws.types)) {
      const was = before[type] || { n: 0, bytes: 0 };
      if (slot.n > was.n) sent[type] = { n: slot.n - was.n, kb: round((slot.bytes - was.bytes) / 1024) };
    }
    return { sawRunning, frames, socket: sent };
  });
}

results.socketTotals = ws.types;
await context.close();
await browser.close();
if (args.out) fs.writeFileSync(String(args.out), JSON.stringify(results, null, 2));
console.log(args.out ? `\nWrote ${args.out}` : "");
