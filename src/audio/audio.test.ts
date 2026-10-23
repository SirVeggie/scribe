import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import type { OpenAISource } from "../agent/openaiSources.js";
import { shellOrigins } from "../config.js";
import { audioRouter } from "./routes.js";
import { PageAudio } from "./page.js";
import type { PermissionGrant } from "../pagePermissions.js";
import { AudioService, MAX_AUDIO_BYTES } from "./service.js";
import { fileStore, memoryStore } from "./settings.js";
import { openAiEngine } from "./engine.js";
import type { AudioResult, SttEngine, SttRequest } from "./types.js";

const source: OpenAISource = { id: "test", name: "Test", baseUrl: "https://stt.invalid/v1", apiKey: "secret-key", models: [] };
const clip = () => new Blob(["sound"], { type: "audio/webm;codecs=opus" });
test("multiple speech sources retain credentials and settings while default, testing and removal select the right API", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-audio-sources-"));
  try {
    const calls: SttRequest[] = [];
    const service = new AudioService({ sources: () => [source], store: fileStore(() => root),
      engine: { async transcribe(req) { calls.push(req); return { ok: true, text: req.model }; } } });
    let view = service.saveSource({ name: "Local", source: "__custom__", custom: { baseUrl: "http://localhost:1234/v1", apiKey: "local-secret" }, model: "local-model", language: "fi" });
    const local = view.defaultSource!;
    view = service.saveSource({ name: "Hosted", source: "test", model: "hosted-model", language: "en" });
    const hosted = view.profiles.find(s => s.name === "Hosted")!.id;
    assert.equal(view.profiles.length, 2); assert.equal(view.defaultSource, local);
    assert.ok(!JSON.stringify(view).includes("local-secret"));
    await service.transcribe(clip());
    assert.equal(calls.at(-1)!.model, "local-model"); assert.equal(calls.at(-1)!.language, "fi");
    service.update({ defaultSource: hosted });
    await service.transcribe(clip());
    assert.equal(calls.at(-1)!.source.id, "test"); assert.equal(calls.at(-1)!.model, "hosted-model");
    await service.transcribe(clip(), { sourceId: local });
    assert.equal(calls.at(-1)!.source.apiKey, "local-secret"); assert.equal(service.view().defaultSource, hosted);
    service.saveSource({ name: "Renamed" }, local);
    assert.equal(new AudioService({ sources: () => [source], store: fileStore(() => root) }).view().defaultSource, hosted);
    assert.throws(() => service.update({ defaultSource: "missing" }), /existing/);
    service.removeSource(hosted);
    assert.equal(service.view().defaultSource, local);
    service.saveSource({ custom: { baseUrl: "https://another.invalid/v1" } }, local);
    assert.equal(service.view().profiles[0].custom?.hasKey, false);
    service.removeSource(local); assert.equal(service.view().available, false);
    assert.equal((await service.transcribe(clip(), { sourceId: "missing" }) as any).error, "no_source");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("an existing custom configuration is preserved when adding and editing named sources", async () => {
  const calls: SttRequest[] = [];
  const service = new AudioService({ sources: () => [], store: memoryStore({ stt: { source: "__custom__", model: "old-model",
    custom: { baseUrl: "https://old.invalid/v1", apiKey: "old-secret" } } }),
    engine: { async transcribe(req) { calls.push(req); return { ok: true, text: "Words" }; } } });
  assert.equal(service.view().profiles[0].id, "__legacy__");
  service.saveSource({ name: "New", source: "__custom__", custom: { baseUrl: "http://localhost/v1" } });
  assert.equal(service.view().profiles.length, 2);
  await service.transcribe(clip()); assert.equal(calls[0].source.apiKey, "old-secret"); assert.equal(calls[0].model, "old-model");
  service.saveSource({ name: "Old renamed" }, "__legacy__");
  assert.equal(service.view().profiles.find(s => s.id === "__legacy__")!.name, "Old renamed");
});
test("custom speech source works independently and keeps its key private across edits", async () => {
  let request: SttRequest | undefined;
  const service = new AudioService({ sources: () => [], store: memoryStore(), engine: { async transcribe(req) {
    request = req; return { ok: true, text: "Custom transcript" };
  } } });
  const view = service.update({ stt: { source: "__custom__", custom: { baseUrl: "https://speech.invalid/v1/", apiKey: "private-key" } } });
  assert.equal(view.available, true);
  assert.equal(view.stt.custom?.hasKey, true);
  assert.ok(!JSON.stringify(view).includes("private-key"));
  service.update({ stt: { custom: { baseUrl: "http://localhost:1234/v1" }, model: "local-stt" } });
  assert.equal((await service.transcribe(clip())).ok, true);
  assert.equal(request?.source.apiKey, "private-key");
  assert.equal(request?.source.baseUrl, "http://localhost:1234/v1");
  assert.equal(request?.model, "local-stt");
  service.update({ stt: { custom: { apiKey: "" } } });
  assert.equal(service.view().stt.custom?.hasKey, false);
  assert.throws(() => service.update({ stt: { custom: { baseUrl: "file:///tmp/audio" } } }));
});
function setup(results: Array<AudioResult | Error> = [{ ok: true, text: "Hello" }]) {
  const calls: SttRequest[] = [];
  const engine: SttEngine = { async transcribe(req) { calls.push(req); const result = results.shift() ?? { ok: true, text: "Hello" }; if (result instanceof Error) throw result; return result; } };
  let sources = [source];
  const service = new AudioService({ sources: () => sources, store: memoryStore({ stt: { source: source.id, language: "fi" } }), engine });
  return { service, calls, removeSource: () => { sources = []; } };
}
test("source lookup stays live, keys stay private, empty/oversized/non-audio inputs never reach the engine", async () => {
  const { service, calls, removeSource } = setup();
  assert.ok(!JSON.stringify(service.view()).includes("secret-key"));
  assert.equal((await service.transcribe(new Blob([]))).ok, false);
  assert.deepEqual(await service.transcribe(new Blob(["x"], { type: "text/plain" })), { ok: false, error: "invalid_audio", message: "Record or upload an audio clip." });
  assert.equal((await service.transcribe(new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)], { type: "audio/wav" })) as any).error, "too_large");
  assert.equal(calls.length, 0);
  assert.deepEqual(await service.transcribe(clip(), { prompt: "Names" }), { ok: true, text: "Hello" });
  assert.equal(calls[0].source.apiKey, source.apiKey); assert.equal(calls[0].language, "fi"); assert.equal(calls[0].prompt, "Names");
  assert.equal(service.usage().calls, 1);
  removeSource(); assert.equal(service.view().available, false);
  assert.equal((await service.transcribe(clip()) as any).error, "no_source");
});
test("settings and usage survive reopening; settings do not contain source credentials", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-audio-"));
  try {
    const service = new AudioService({ sources: () => [source], store: fileStore(() => root), engine: { async transcribe() { return { ok: true, text: "Words" }; } } });
    service.update({ stt: { source: "test", model: "speech-model", language: "en" }, input: { sendAfterDictation: true, pushToTalk: false } });
    await service.transcribe(clip());
    const reopened = new AudioService({ sources: () => [source], store: fileStore(() => root) });
    assert.equal(reopened.view().stt.model, "speech-model"); assert.equal(reopened.view().input.sendAfterDictation, true);
    assert.equal(reopened.view().input.pushToTalk, false);
    assert.equal(reopened.usage().calls, 1);
    assert.ok(!fs.readFileSync(path.join(root, "audio-settings.json"), "utf8").includes("secret-key"));
    reopened.update({ input: { sendAfterDictation: false } }); assert.equal(reopened.view().stt.language, "en");
    assert.throws(() => reopened.update({ stt: { source: "missing" } }), /existing/);
    assert.equal(reopened.update({ stt: { source: "", language: "" } }).available, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("one retry for 429 and 5xx, none for auth or malformed output; failures never throw", async () => {
  for (const error of ["rate_limit", "engine"] as const) {
    const { service, calls } = setup([{ ok: false, error, message: "unavailable", retryable: true }, { ok: false, error, message: "still unavailable", retryable: true }]);
    assert.equal((await service.transcribe(clip())).ok, false); assert.equal(calls.length, 2); assert.equal(service.usage().failed, 1);
  }
  const auth = setup([{ ok: false, error: "auth", message: "Bad key" }]);
  assert.equal((await auth.service.transcribe(clip()) as any).error, "auth"); assert.equal(auth.calls.length, 1);
  const network = setup([new Error("secret-key must never escape")]);
  assert.equal((await network.service.transcribe(clip()) as any).error, "network");
  const engine = setup([{ ok: false, error: "engine", message: "bad output" }]);
  await engine.service.transcribe(clip()); assert.equal(engine.calls.length, 1);
});
test("a source that rejects compressed audio is reported as WAV-only, without a retry", async () => {
  const { service, calls } = setup([{ ok: false, error: "format", message: "cannot read webm" }]);
  assert.equal(service.view().wav, false);
  assert.equal((await service.transcribe(clip()) as any).error, "format"); assert.equal(calls.length, 1);
  assert.equal(service.view().wav, true);
});
test("deadline also bounds a fake engine that ignores abort", async () => {
  let signal: AbortSignal | undefined;
  const service = new AudioService({ sources: () => [source], store: memoryStore({ stt: { source: "test" } }), timeoutMs: 10,
    engine: { transcribe: req => { signal = req.signal; return new Promise(() => {}); } } });
  assert.equal((await service.transcribe(clip()) as any).error, "timeout"); assert.equal(signal?.aborted, true);
});
test("OpenAI adapter uploads multipart with daemon-only auth and maps response errors", async () => {
  const app = express(); const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  let status = 200, content = "", text = "Words";
  app.post("/v1/audio/transcriptions", express.raw({ type: () => true }), (req, res) => {
    assert.equal(req.get("authorization"), "Bearer secret-key"); content = req.body.toString();
    res.status(status).json(status === 200 ? { text } : { error: { message: "secret-key" } });
  });
  try {
    const request = { source: { ...source, baseUrl }, model: "whisper-1", audio: clip(), language: "en", prompt: "Names", signal: AbortSignal.timeout(2000) };
    assert.deepEqual(await openAiEngine.transcribe(request), { ok: true, text: "Words" });
    assert.match(content, /name="file"; filename="recording.webm"/); assert.match(content, /name="model"/); assert.match(content, /whisper-1/); assert.match(content, /name="language"/); assert.match(content, /Names/);
    text = "language English<asr_text>Scribe audio test.";
    assert.deepEqual(await openAiEngine.transcribe(request), { ok: true, text: "Scribe audio test." }, "Qwen3-ASR's language tag is dropped");
    text = "Words";
    for (const [code, error, retryable] of [[401, "auth", false], [429, "rate_limit", true], [503, "engine", true], [400, "format", undefined]] as const) {
      status = code; const result = await openAiEngine.transcribe(request);
      assert.equal((result as any).error, error); assert.equal((result as any).retryable, retryable); assert.ok(!JSON.stringify(result).includes("secret-key"));
    }
    status = 400;
    assert.equal((await openAiEngine.transcribe({ ...request, audio: new Blob(["sound"], { type: "audio/wav" }) }) as any).error, "engine", "a rejected WAV is not a format problem");
  } finally { server.close(); }
});
test("routes reject page origins, form uploads, oversize bytes, and ungranted tab headers; settings round trip", async () => {
  const { service, calls } = setup(); const app = express(); app.use("/api/audio", audioRouter(service));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/audio`;
  try {
    const request = (route: string, body: BodyInit, headers: Record<string, string> = {}) => fetch(base + route, { method: "POST", body, headers: { "Content-Type": "audio/webm", ...headers } });
    assert.equal((await request("/transcriptions", "sound", { Origin: "http://127.0.0.2:4747" })).status, 403);
    assert.equal((await request("/transcriptions", "sound", { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await request("/transcriptions", "sound", { "x-scribe-tab": "page" })).status, 403);
    assert.equal((await request("/transcriptions", new Uint8Array(MAX_AUDIO_BYTES + 1))).status, 413);
    assert.equal(calls.length, 0);
    const result = await request("/transcriptions?language=en&prompt=Names", "sound", { Origin: shellOrigins()[0] });
    assert.deepEqual(await result.json(), { ok: true, text: "Hello" }); assert.equal(calls[0].language, "en");
    const saved = await fetch(base + "/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: { sendAfterDictation: true } }) });
    assert.equal(saved.status, 200); assert.equal((await (await fetch(base + "/settings")).json()).input.sendAfterDictation, true);
    const tested = await request("/test", "{}", { "Content-Type": "application/json" });
    assert.equal((await tested.json()).ok, true); assert.equal(calls[1].audio.type, "audio/wav");
  } finally { server.close(); }
});
test("page transcription requires an allow grant and limits calls per page", async () => {
  let now = 0;
  const grants = new Map<string, PermissionGrant>();
  const gate = new PageAudio(() => grants, () => now);
  for (const value of ["ask", "deny"] as const) {
    grants.set("audio.transcribe", { value, updatedAt: 1 });
    assert.deepEqual(gate.check("page"), { ok: false, error: "denied", permission: "audio.transcribe" });
  }
  grants.set("audio.transcribe", { value: "allow", updatedAt: 1 });
  for (let i = 0; i < 6; i++) assert.equal(gate.check("page").ok, true);
  assert.equal(gate.check("page").error, "rate_limited");
  assert.equal(gate.check("other").ok, true);
  now = 60000;
  assert.equal(gate.check("page").ok, true);
  const { service, calls } = setup();
  const app = express(); app.use("/api/audio", audioRouter(service, gate));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as any).port}/api/audio/transcriptions`;
    // The board UI in a browser (#682): a headless caller with no credential is an anonymous agent.
    const upload = () => fetch(base, { method: "POST", body: "sound", headers: { "Content-Type": "audio/webm", "x-scribe-tab": "page", "sec-fetch-site": "same-origin" } });
    grants.set("audio.transcribe", { value: "deny", updatedAt: 2 });
    assert.equal((await (await upload()).json()).error, "denied");
    assert.equal(calls.length, 0);
    grants.set("audio.transcribe", { value: "allow", updatedAt: 3 });
    assert.equal((await (await upload()).json()).ok, true);
    assert.equal(calls.length, 1);
  } finally { server.close(); }
});
