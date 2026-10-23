import assert from "node:assert/strict";
import { test } from "node:test";
import { entryContextWindow, fetchModelInfo, normalizeSource, sourceView, splitModelId } from "./openaiSources.js";

test("a new source gets a slug id, a clean URL and a model list", () => {
  const source = normalizeSource({ name: "Open Router", baseUrl: "https://openrouter.ai/api/v1/", apiKey: " sk-1 ", models: "a/b\n c , a/b" }, undefined, new Set(["open-router"]));
  assert.deepEqual(source, { id: "open-router-2", name: "Open Router", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-1", models: ["a/b", "c"] });
  assert.deepEqual(sourceView(source), { id: "open-router-2", name: "Open Router", baseUrl: "https://openrouter.ai/api/v1", models: ["a/b", "c"], hasKey: true });
  assert.throws(() => normalizeSource({ name: "x", baseUrl: "ftp://host" }, undefined, new Set()), /http or https/);
  assert.throws(() => normalizeSource({ name: "x", baseUrl: "not a url" }, undefined, new Set()), /full URL/);
  assert.throws(() => normalizeSource({ baseUrl: "http://localhost:1234/v1" }, undefined, new Set()), /name/);
});

test("editing keeps the id and the key unless a new key is sent", () => {
  const before = normalizeSource({ name: "Local", baseUrl: "http://localhost:1234/v1", apiKey: "k", reasoning: true }, undefined, new Set());
  const renamed = normalizeSource({ name: "LM Studio" }, before, new Set([before.id]));
  assert.equal(renamed.id, before.id);
  assert.equal(renamed.apiKey, "k");
  assert.equal(renamed.reasoning, true);
  assert.equal(normalizeSource({ apiKey: "" }, before, new Set()).apiKey, undefined);
});

test("model ids split at the first slash, so provider model ids keep theirs", () => {
  assert.deepEqual(splitModelId("openrouter/anthropic/claude-sonnet"), { source: "openrouter", model: "anthropic/claude-sonnet" });
  assert.equal(splitModelId("default"), null);
  assert.equal(splitModelId("/x"), null);
});

test("a model list reports each server's context window", async (t) => {
  assert.equal(entryContextWindow({ id: "a", max_model_len: 32768 }), 32768);
  assert.equal(entryContextWindow({ id: "a", context_length: 1_000_000 }), 1_000_000);
  assert.equal(entryContextWindow({ id: "a", loaded_context_length: 32768, max_context_length: 131072 }), 32768);
  assert.equal(entryContextWindow({ id: "a", object: "model" }), undefined);
  const source = { id: "local", name: "Local", baseUrl: "http://localhost:8080/v1", models: [] };
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    urls.push(String(url));
    if (String(url).endsWith("/props")) return Response.json({ default_generation_settings: { n_ctx: 32768 } });
    return Response.json({ data: [{ id: "qwen", meta: { n_ctx_train: 262144 } }] });
  });
  // llama.cpp: the context it was started with, not the trained one.
  assert.deepEqual(await fetchModelInfo(source), [{ id: "qwen", contextWindow: 32768 }]);
  assert.deepEqual(urls, ["http://localhost:8080/v1/models", "http://localhost:8080/props"]);
});
