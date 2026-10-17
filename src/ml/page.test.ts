import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import type { PermissionGrant } from "../pagePermissions.js";
import { fakeAdapter } from "./adapters/fake.js";
import { PAGE_CALLS_PER_HOUR, PAGE_CALLS_PER_MINUTE, PAGE_MAX_STATE_CHARS, PageMl } from "./page.js";
import { mlRouter } from "./routes.js";
import { MlService } from "./service.js";
import { defaultSettings, type MlStore } from "./settings.js";
import type { MlDayUsage, MlSettings } from "./types.js";

function memoryStore(change: (settings: MlSettings) => void = () => {}): MlStore {
  let settings = defaultSettings();
  settings.sources = [{ id: "jev", name: "Jev", baseUrl: "https://api.typesafe.ai", apiKey: "sk-secret", model: "jev-latest" }];
  settings.defaultSource = "jev";
  change(settings);
  let usage: MlDayUsage | null = null;
  return {
    read: () => structuredClone(settings),
    write: (next) => {
      settings = structuredClone(next);
    },
    readUsage: () => usage,
    writeUsage: (next) => {
      usage = { ...next };
    },
  };
}

const grant = (value: PermissionGrant["value"]) => new Map<string, PermissionGrant>([["ml.decide", { value, updatedAt: 1 }]]);
const allowed = grant("allow");
const questions = { bug: { type: "yesno", instructions: "Is this a bug report?" } };

function setup(change?: (settings: MlSettings) => void) {
  const adapter = fakeAdapter();
  const clock = { now: 1_000_000 };
  const service = new MlService({ store: memoryStore(change), adapter, log: () => {}, now: () => clock.now });
  return { adapter, clock, service, ml: new PageMl({ service, now: () => clock.now }) };
}

test("a page gets answers only with the ml.decide permission, and never the source", async () => {
  const { adapter, ml } = setup();
  for (const grants of [new Map<string, PermissionGrant>(), grant("ask"), grant("deny")]) {
    const refused = await ml.decide("t_1", grants, { state: "The app crashes on start", questions });
    assert.deepEqual([refused.ok, refused.ok ? "" : refused.error, refused.ok ? "" : refused.permission], [false, "denied", "ml.decide"]);
  }
  assert.equal(adapter.calls.length, 0);

  adapter.answers.bug = { type: "yesno", yes: 0.9 };
  const result = await ml.decide("t_1", allowed, { state: { title: "The app crashes on start" }, questions });
  assert.deepEqual(result, { ok: true, answers: { bug: { type: "yesno", yes: 0.9 } }, cached: false, ms: 0 });
  assert.ok(!JSON.stringify(result).includes("jev"), "the result names no source or model");
  assert.equal((await ml.decide("t_1", allowed, { state: { title: "The app crashes on start" }, questions })).ok && adapter.calls.length, 1);

  const invalid = await ml.decide("t_1", allowed, { state: "text", questions: {} });
  assert.equal(!invalid.ok && invalid.error, "invalid_request");
});

test("capabilities say whether a decide would go through, and why not", () => {
  const { ml } = setup();
  const open = ml.capabilities(allowed);
  assert.deepEqual([open.available, open.reason, open.permission], [true, undefined, "allow"]);
  assert.deepEqual(open.types, ["yesno", "choice", "score"]);
  assert.deepEqual(open.limits, { stateChars: PAGE_MAX_STATE_CHARS, questions: 32, perMinute: PAGE_CALLS_PER_MINUTE, perHour: PAGE_CALLS_PER_HOUR });
  const asking = ml.capabilities(new Map());
  assert.deepEqual([asking.available, asking.reason, asking.permission], [false, "denied", "ask"]);
  assert.equal(setup((s) => (s.features.pages = false)).ml.capabilities(allowed).reason, "disabled");
  assert.equal(setup((s) => (s.sources = [])).ml.capabilities(allowed).reason, "no_source");
});

test("the Pages switch and a missing source refuse a page's call", async () => {
  const off = await setup((s) => (s.features.pages = false)).ml.decide("t_1", allowed, { state: "text", questions });
  assert.equal(!off.ok && off.error, "disabled");
  const none = await setup((s) => (s.sources = [])).ml.decide("t_1", allowed, { state: "text", questions });
  assert.equal(!none.ok && none.error, "no_source");
});

test("a page's request size and rate are limited on their own", async () => {
  const { adapter, clock, ml } = setup();
  const big = await ml.decide("t_1", allowed, { state: "x".repeat(PAGE_MAX_STATE_CHARS + 1), questions });
  assert.equal(!big.ok && big.error, "input_too_large");
  const bigObject = await ml.decide("t_1", allowed, { state: { text: "x".repeat(PAGE_MAX_STATE_CHARS) }, questions });
  assert.equal(!bigObject.ok && bigObject.error, "input_too_large");
  assert.equal(adapter.calls.length, 0);

  for (let i = 0; i < PAGE_CALLS_PER_MINUTE; i += 1) {
    assert.equal((await ml.decide("t_1", allowed, { state: `card ${i}`, questions })).ok, true);
  }
  const limited = await ml.decide("t_1", allowed, { state: "one more", questions });
  assert.deepEqual([limited.ok, !limited.ok && limited.error, !limited.ok && limited.retryAfterMs], [false, "rate_limited", 60_000]);
  // Another page has its own count.
  assert.equal((await ml.decide("t_2", allowed, { state: "one more", questions })).ok, true);
  clock.now += 60_000;
  assert.equal((await ml.decide("t_1", allowed, { state: "one more", questions })).ok, true);

  // The hourly limit holds across minutes.
  let sent = PAGE_CALLS_PER_MINUTE + 1;
  while (sent < PAGE_CALLS_PER_HOUR) {
    clock.now += 60_000;
    for (let i = 0; i < PAGE_CALLS_PER_MINUTE && sent < PAGE_CALLS_PER_HOUR; i += 1, sent += 1) {
      assert.equal((await ml.decide("t_1", allowed, { state: `more ${sent}`, questions })).ok, true);
    }
  }
  clock.now += 60_000;
  const hourly = await ml.decide("t_1", allowed, { state: "past the hour's limit", questions });
  assert.equal(!hourly.ok && hourly.error, "rate_limited");
  assert.ok(!hourly.ok && (hourly.retryAfterMs ?? 0) > 60_000);
});

test("a page has two calls at the classifier at most", async () => {
  const { adapter, ml } = setup();
  adapter.delayMs = 30;
  const results = await Promise.all(["a", "b", "c"].map((state) => ml.decide("t_1", allowed, { state, questions })));
  assert.deepEqual(results.map((r) => (r.ok ? "ok" : r.error)), ["ok", "ok", "busy"]);
  assert.equal((await ml.decide("t_1", allowed, { state: "d", questions })).ok, true);
});

test("the page routes take the page from the URL, check its grants and keep agents out", async () => {
  const { service } = setup();
  const pages = new Map([["t_ok", allowed], ["t_ask", grant("ask")]]);
  const app = express();
  app.use(express.json());
  app.use("/api/ml", mlRouter(service, {
    grants: (id) => {
      const grants = pages.get(id);
      if (!grants) throw new Error(`tab not found: ${id}`);
      return grants;
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/ml/pages`;
  const post = async (page: string, body: unknown, headers: Record<string, string> = {}) => {
    // The board UI in a browser (#682): a headless caller with no credential is an anonymous agent.
    const res = await fetch(`${url}/${page}/decide`, { method: "POST", headers: { "Content-Type": "application/json", "sec-fetch-site": "same-origin", ...headers }, body: JSON.stringify(body) });
    const text = await res.text();
    assert.ok(!text.includes("sk-secret") && !text.includes("typesafe"), "the answer leaked the source");
    return { status: res.status, body: JSON.parse(text) };
  };
  try {
    const ok = await post("t_ok", { state: "The app crashes", questions });
    assert.deepEqual([ok.status, ok.body.ok, ok.body.answers.bug.type], [200, true, "yesno"]);
    const ask = await post("t_ask", { state: "The app crashes", questions });
    assert.deepEqual([ask.status, ask.body.ok, ask.body.error], [200, false, "denied"]);
    assert.equal((await post("t_missing", { state: "x", questions })).status, 404);
    assert.equal((await post("t_ok", { state: "x", questions }, { "x-scribe-client": "agent" })).status, 403);
    assert.equal((await post("t_ok", { state: "x", questions }, { origin: "https://evil.example" })).status, 403);
    const caps = await (await fetch(`${url}/t_ask/capabilities`, { headers: { "sec-fetch-site": "same-origin" } })).json();
    assert.deepEqual([caps.ok, caps.available, caps.permission], [true, false, "ask"]);
    assert.equal((await fetch(`${url}/t_ok/capabilities`, { headers: { "x-scribe-client": "agent" } })).status, 403);
  } finally {
    server.close();
  }
});
