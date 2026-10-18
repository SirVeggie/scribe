import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiProvider, builtinTools, modelRateSnapshot, sourceModelCost, sourceProviderId, splitPiModel } from "./providers/pi.js";
import { migrateOpenaiPrefs, migrateOpenaiThread } from "./legacyOpenai.js";
import type { Prefs } from "./prefs.js";
import type { Thread } from "./types.js";
import { normalizeSource } from "./openaiSources.js";
import type { RunSink, SessionContext } from "./providers/provider.js";
import type { SessionBeforeCompactEvent, SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";

test("Native compaction delegates manual, threshold and overflow summaries without changing the retained boundary", async () => {
  const provider = new PiProvider();
  const thread = { id: "compact-test", provider: "pi", model: "native/chat", scope: { kind: "global", ref: null } } as Thread;
  const signal = new AbortController().signal;
  const prompts: string[] = [];
  const session = provider.createSession(thread, {
    summarizeContext: async (actual, prompt, actualSignal) => {
      assert.equal(actual, thread);
      assert.equal(actualSignal, signal);
      prompts.push(prompt);
      return "  Carry on with the pending edit.  ";
    },
  } as SessionContext) as unknown as { beforeCompact(event: SessionBeforeCompactEvent): Promise<SessionBeforeCompactResult>; dispose(): void };
  try {
    for (const reason of ["manual", "threshold", "overflow"] as const) {
      const event: SessionBeforeCompactEvent = {
        type: "session_before_compact", reason, willRetry: reason === "overflow", signal,
        branchEntries: [], customInstructions: "Keep the migration steps",
        preparation: {
          firstKeptEntryId: "retained-entry", tokensBefore: 90000, previousSummary: "Earlier decisions",
          messagesToSummarize: [{ role: "user", content: "Update src/example.ts", timestamp: 1 }],
          turnPrefixMessages: [{ role: "user", content: "Now fix the tests", timestamp: 2 }],
          isSplitTurn: true,
          fileOps: { read: new Set(["src/example.ts", "README.md"]), written: new Set(["new.ts"]), edited: new Set(["src/example.ts"]) },
          settings: { enabled: true, reserveTokens: 6000, keepRecentTokens: 10000 },
        },
      };
      const result = await session.beforeCompact(event);
      assert.equal(result.compaction?.firstKeptEntryId, "retained-entry");
      assert.equal(result.compaction?.tokensBefore, 90000);
      assert.match(result.compaction!.summary, /^Carry on with the pending edit\./);
      assert.match(result.compaction!.summary, /<modified-files>\nnew.ts\nsrc\/example.ts/);
      assert.deepEqual(result.compaction?.details, { readFiles: ["README.md"], modifiedFiles: ["new.ts", "src/example.ts"] });
      assert.match(prompts.at(-1)!, /Earlier decisions/);
      assert.match(prompts.at(-1)!, /Update src\/example.ts/);
      assert.match(prompts.at(-1)!, /Now fix the tests/);
      assert.match(prompts.at(-1)!, /Keep the migration steps/);
    }
    assert.equal(prompts.length, 3);
  } finally { session.dispose(); provider.dispose(); }
});

test("Native compaction cancels on empty, failed or aborted summaries", async () => {
  const provider = new PiProvider();
  const warnings: string[] = [];
  let complete = async () => "";
  const session = provider.createSession({ id: "compact-failure", scope: { kind: "global", ref: null } } as Thread, {
    summarizeContext: async () => complete(),
  } as unknown as SessionContext) as any;
  session.sink = { notice: (_level: string, text: string) => warnings.push(text) };
  const event = {
    signal: new AbortController().signal,
    preparation: { messagesToSummarize: [], settings: { reserveTokens: 6000 }, fileOps: { read: new Set(), written: new Set(), edited: new Set() } },
  };
  try {
    assert.deepEqual(await session.beforeCompact(event), { cancel: true });
    assert.match(warnings.at(-1)!, /empty summary/);
    complete = async () => { throw new Error("Summary model unavailable"); };
    assert.deepEqual(await session.beforeCompact(event), { cancel: true });
    assert.match(warnings.at(-1)!, /Summary model unavailable/);
    assert.deepEqual(await session.beforeCompact({ ...event, signal: AbortSignal.abort() }), { cancel: true });
    assert.equal(warnings.length, 2);
    const controller = new AbortController();
    event.signal = controller.signal;
    complete = async () => { controller.abort(); return "Late summary"; };
    assert.deepEqual(await session.beforeCompact(event), { cancel: true });
    assert.equal(warnings.length, 2);
  } finally { session.sink = null; session.dispose(); provider.dispose(); }
});

test("Native Auto review sends every command and edit to host approval", async () => {
  const provider = new PiProvider();
  const session = provider.createSession({ id: "review-test", provider: "pi", approval: "auto", mode: "code", cwd: process.cwd(), scope: { kind: "global", ref: null } } as Thread, {
    approval: async (_id, req) => { requests.push(req); return { optionId: "reject" }; },
  } as SessionContext) as unknown as { gate(event: unknown): Promise<{ block?: boolean } | undefined>; dispose(): void };
  const requests: import("./providers/provider.js").ApprovalRequest[] = [];
  try {
    for (const command of ["git status", "npm test", "git branch --edit-description", "echo ok\nrm -rf x"]) {
      assert.equal((await session.gate({ toolName: "bash", toolCallId: "command", input: { command } }))?.block, true);
      assert.equal(requests.at(-1)?.detail, command);
    }
    assert.equal((await session.gate({ toolName: "write", toolCallId: "write", input: { path: "file.txt", content: "x" } }))?.block, true);
    assert.deepEqual(requests.at(-1)?.paths, [path.join(process.cwd(), "file.txt")]);
  } finally { session.dispose(); provider.dispose(); }
});

test("openai threads and prefs move to Pi", () => {
  const thread = { provider: "openai", model: "lmstudio/qwen/qwen3-8b", nativeId: "resp_1" } as unknown as Thread;
  assert.equal(migrateOpenaiThread(thread), true);
  assert.equal(thread.provider, "pi");
  assert.equal(thread.model, "src-lmstudio/qwen/qwen3-8b");
  assert.equal(thread.nativeId, null);
  assert.equal(migrateOpenaiThread({ provider: "claude", model: "a/b", nativeId: "x" } as unknown as Thread), false);
  const saved = {
    provider: "openai",
    models: { openai: "or/gpt-5", claude: "default" },
    summarizer: { provider: "openai", model: "or/mini" },
    favoriteModels: ["openai:or/gpt-5", "claude:opus"],
  } as unknown as Partial<Prefs>;
  assert.deepEqual(migrateOpenaiPrefs(saved), {
    provider: "pi",
    models: { claude: "default", pi: "src-or/gpt-5" },
    summarizer: { provider: "pi", model: "src-or/mini" },
    favoriteModels: ["pi:src-or/gpt-5", "claude:opus"],
  });
  assert.deepEqual(migrateOpenaiPrefs({ provider: "claude" }), { provider: "claude" });
});

test("Native turn freezes rate snapshots, deduplicates messages and retains zero on continuation", async (t) => {
  const source = normalizeSource({ name: "A", baseUrl: "https://example.test/v1", pricing: { x: { mode: "custom", rates: { input: "1", output: "2" } } } }, undefined, new Set());
  const provider = new PiProvider(() => [source]);
  t.after(() => provider.dispose());
  const model = { provider: "src-a", id: "x", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } as any;
  provider.resolveModel = async () => model;
  const run = provider.createSession({ id: "test", nativeId: null, model: "src-a/x", mode: "code", scope: { kind: "global", ref: null } } as Thread, {} as SessionContext) as any;
  let latest: import("./types.js").Usage = {};
  let prompts = 0;
  const message = () => ({ role: "assistant", provider: "src-a", model: "x", timestamp: 100, stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 999 } } });
  const fake = {
    model,
    messages: [],
    setModel: async () => {},
    setThinkingLevel: () => {},
    clearQueue: () => {},
    prompt: async () => {
      prompts++;
      run.observePayload(model);
      const first = message();
      run.onEvent({ type: "message_end", message: first });
      run.onEvent({ type: "message_end", message: first });
      if (prompts === 1) {
        source.pricing!.x = { mode: "custom", rates: { input: "0", output: "0" }, updatedAt: 200 };
        // A distinct response with the same timestamp must still count.
        run.onEvent({ type: "message_end", message: message() });
      }
    },
  };
  run.ensureSession = async () => fake;
  const sink = { usage: (value: import("./types.js").Usage) => { latest = value; } } as RunSink;
  const input = { text: "Hi", instructions: "", images: [], documents: [] };
  assert.equal((await run.run(input, sink)).status, "done");
  assert.equal(latest.costUsd, 0.00004);
  assert.equal(latest.inputTokens, 20);
  assert.equal(latest.modelCalls, 2);
  assert.equal(latest.firstPromptTokens, 10);
  assert.equal(latest.costRecords?.length, 2);
  assert.equal(latest.costRecords?.[0].timing?.basis, "assistant-message");
  assert.equal(latest.costRecords?.[0].timing?.attempts, "unavailable");
  assert.ok(latest.costRecords?.[0].timing?.payloadObservedAt);
  assert.equal(latest.costRecords?.[1].timing?.payloadObservedAt, undefined);
  assert.equal(latest.costRecords?.[1].rate.rates?.input, "1");
  const saved = structuredClone(latest);
  assert.equal((await run.run(input, sink)).status, "done");
  assert.equal(latest.costUsd, 0);
  assert.equal(latest.estimatedCostUsd, 0);
  assert.equal(saved.costUsd, 0.00004);
  assert.equal(latest.costRecords?.length, 1);
  assert.equal(latest.modelCalls, 1);
  assert.equal(latest.firstPromptTokens, 10);
});

test("splitPiModel splits at the first slash; model ids keep theirs", () => {
  assert.deepEqual(splitPiModel("openrouter/anthropic/claude-sonnet-5"), { provider: "openrouter", model: "anthropic/claude-sonnet-5" });
  assert.deepEqual(splitPiModel(`${sourceProviderId("lmstudio")}/qwen3-coder`), { provider: "src-lmstudio", model: "qwen3-coder" });
  assert.equal(splitPiModel("default"), null);
  assert.equal(splitPiModel("x/"), null);
});

test("builtinTools: the reading rungs none (reads and asking commands with a workspace), Code all", () => {
  assert.deepEqual(builtinTools("board"), []);
  assert.ok(builtinTools("board", [], true).includes("bash") && builtinTools("board", [], true).includes("read"));
  assert.ok(!builtinTools("board", [], true).includes("edit") && !builtinTools("board", ["bash"], true).includes("bash"));
  assert.ok(builtinTools("code").includes("bash") && builtinTools("code").includes("write"));
});

test("DeepSeek source registration prices cached and uncached usage from the SDK catalog", async (t) => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-pi-cost-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: null, modelsStorePath: path.join(dir, "catalog.json"), refreshOnCreate: false });
  const source = { id: "ds", name: "My API", baseUrl: "https://api.deepseek.com/v1", apiKey: "test-key", models: ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "unknown"] };
  const provider = new PiProvider(() => [source]);
  provider.runtime = async () => runtime;
  t.after(() => provider.dispose());
  // Avoid availability checks for unrelated built-in credentials on the test machine.
  runtime.getAvailable = async () => runtime.getModels("src-ds").slice();
  const model = await provider.resolveModel("src-ds/deepseek-flash");
  assert.ok(model);
  const catalog = runtime.getModels("deepseek");
  const flash = catalog.find((m) => m.id === "deepseek-flash")!;
  assert.ok(flash.cost.input > 0);
  assert.deepEqual(model.cost, flash.cost);
  assert.deepEqual(runtime.getModel("src-ds", "deepseek-v4-pro")?.cost, catalog.find((m) => m.id === "deepseek-v4-pro")?.cost);
  assert.deepEqual(runtime.getModel("src-ds", "deepseek-v4-flash")?.cost, flash.cost);
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.deepEqual(runtime.getModel("src-ds", "unknown")?.cost, zero);
  for (const baseUrl of ["http://localhost:1234/v1", "https://proxy.example/v1", "https://api.deepseek.com.evil.test/v1", "https://api.deepseek.com/anthropic"]) {
    assert.deepEqual(sourceModelCost({ ...source, baseUrl }, "deepseek-flash", catalog), zero);
  }
  assert.deepEqual(sourceModelCost({ ...source, baseUrl: "https://api.deepseek.com" }, "deepseek-flash", catalog), flash.cost);
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    assert.equal(String(url), "https://api.deepseek.com/v1/chat/completions");
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100, completion_tokens: 50 } },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  const reply = await runtime.completeSimple(model, { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] });
  assert.equal(reply.stopReason, "stop", reply.errorMessage);
  assert.equal(reply.usage.input, 100);
  assert.equal(reply.usage.cacheRead, 900);
  assert.equal(reply.usage.output, 50);
  const expected = (100 * flash.cost.input + 900 * flash.cost.cacheRead + 50 * flash.cost.output) / 1_000_000;
  assert.ok(Math.abs(reply.usage.cost.total - expected) < 1e-12);
  // Override edits reach an already registered model without changing earlier snapshots.
  const original = provider.rateSnapshot(model);
  const pricedSource = source as typeof source & { pricing?: import("./openaiSources.js").OpenAISource["pricing"] };
  pricedSource.pricing = { "deepseek-flash": { mode: "custom", rates: { input: "0", output: "0" }, updatedAt: 100 } };
  const free = (await provider.resolveModel("src-ds/deepseek-flash"))!;
  assert.deepEqual(free.cost, zero);
  assert.equal(provider.rateSnapshot(free).origin, "custom");
  assert.equal(provider.rateSnapshot(free).rates?.cacheRead, undefined);
  assert.equal(original.origin, "catalog");
  assert.equal(original.rates?.input, String(flash.cost.input));
  pricedSource.pricing["deepseek-flash"] = { mode: "unknown" };
  assert.equal(provider.rateSnapshot((await provider.resolveModel("src-ds/deepseek-flash"))!).origin, "unknown");
  assert.equal(modelRateSnapshot(model, { ...source, baseUrl: "https://secret:password@api.deepseek.com/v1?key=hidden" }).endpoint, "https://api.deepseek.com/v1");
});

test("Pi payload/response hooks bracket a logical call but do not expose transport retries", async (t) => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-pi-timing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: null, modelsStorePath: path.join(dir, "catalog.json"), refreshOnCreate: false });
  const provider = new PiProvider(() => [{ id: "timing", name: "Timing", baseUrl: "https://api.deepseek.com/v1", apiKey: "test-key", models: ["deepseek-flash"] }]);
  provider.runtime = async () => runtime;
  t.after(() => provider.dispose());
  runtime.getAvailable = async () => runtime.getModels("src-timing").slice();
  const model = (await provider.resolveModel("src-timing/deepseek-flash"))!;
  const events: string[] = [];
  t.mock.method(globalThis, "fetch", async () => {
    events.push("fetch");
    if (events.filter((v) => v === "fetch").length === 1) return new Response('{"error":{"message":"retry"}}', { status: 500, headers: { "Content-Type": "application/json", "retry-after-ms": "1" } });
    const chunk = { choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  });
  const reply = await runtime.completeSimple(model, { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] }, {
    maxRetries: 1,
    onPayload: () => { events.push("payload"); },
    onResponse: () => { events.push("response"); },
  });
  assert.equal(reply.stopReason, "stop", reply.errorMessage);
  assert.deepEqual(events, ["payload", "fetch", "fetch", "response"]);
});
