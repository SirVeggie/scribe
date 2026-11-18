import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpenAISource } from "../agent/openaiSources.js";
import { listModels, openAiEngine, openAiTts } from "./engine.js";
import { normalizeModelSettings, pickSettings } from "./modelSettings.js";
import { AudioService } from "./service.js";
import { memoryStore } from "./settings.js";
import type { SttRequest, TtsRequest } from "./types.js";

const memorize: OpenAISource = { id: "memorize", name: "Memorize", baseUrl: "http://localhost:6366/v1", apiKey: "secret-key", models: [] };
const schema = { type: "object", properties: {
  temperature: { type: "number", default: 0.8, "x-control": "slider" },
  steering: { type: "object", properties: { pace: { type: "number" } } },
  seed: { type: "integer", "x-in": ["request"] },
  rate: { type: "integer", "x-in": ["stream"], "x-hidden": true } } };

test("settings that apply where they are sent: a stream takes only what its schema allows there", () => {
  const values = { temperature: 0.5, seed: 3, rate: 8000, gone: 1 };
  assert.deepEqual(pickSettings(schema, values, "request"), { temperature: 0.5, seed: 3 });
  assert.deepEqual(pickSettings(schema, values, "stream"), { temperature: 0.5, rate: 8000 });
  assert.deepEqual(pickSettings(undefined, values, "request"), values, "no schema: a POST takes them all");
  assert.deepEqual(pickSettings(undefined, values, "stream"), {}, "and a stream none");
  assert.deepEqual(normalizeModelSettings({ kokoro: { speed: 1.2, model: "x", input: "y" }, empty: {}, bad: [1] }), { kokoro: { speed: 1.2 } }, "names a request sets itself are never saved");
});

test("a model list keeps type and settings, and the pickers on a combined /v1 show only their type", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
    { id: "gemma", type: "llm", context_length: 65536 }, { id: "kokoro", type: "tts", default: true, settings: schema },
    { id: "moonshine-medium", type: "stt", default: true }, { id: "qwen-asr-0.6b", type: "stt" }] }));
  const listed = await listModels(memorize, AbortSignal.timeout(1000));
  assert.ok(listed.ok && listed.flagged);
  assert.deepEqual(listed.ok && listed.models.find(m => m.id === "kokoro"), { id: "kokoro", type: "tts", default: true, settings: schema });
  const service = new AudioService({ sources: () => [memorize], store: memoryStore() });
  service.saveTtsSource({ name: "Speech", source: "memorize" });
  service.saveSource({ name: "Dictation", source: "memorize", model: "" });
  const ids = async (kind: string) => { const r = await service.models({ kind }); return r.ok ? r.models.map(m => m.id) : r; };
  assert.deepEqual(await ids("tts"), ["kokoro"]);
  assert.deepEqual(await ids("stt"), ["moonshine-medium", "qwen-asr-0.6b"]);
});

test("each source keeps settings per model and sends them under their own names", async () => {
  const stt: SttRequest[] = [], tts: TtsRequest[] = [];
  const service = new AudioService({ sources: () => [memorize], store: memoryStore(),
    engine: { async transcribe(r) { stt.push(r); return { ok: true, text: "ok" }; } },
    tts: { async speak(r) { tts.push(r); return { ok: false, error: "engine", message: "stop here" }; } } });
  service.saveSource({ name: "Qwen", source: "memorize", model: "qwen-asr-0.6b", language: "de",
    settingsFor: { model: "qwen-asr-0.6b", values: { language: "fi", prompt: "Scribe, Memorize", temperature: 0 } } });
  const id = service.view().profiles[0].id;
  service.saveSource({ settingsFor: { model: "moonshine-medium", values: { rate: 8000 } } }, id);
  assert.deepEqual(Object.keys(service.view().profiles[0].modelSettings!), ["qwen-asr-0.6b", "moonshine-medium"]);
  await service.transcribe(new Blob(["x"], { type: "audio/wav" }));
  assert.equal(stt[0].language, "fi", "the model's language over the source's old one");
  assert.equal(stt[0].prompt, "Scribe, Memorize");
  assert.deepEqual(stt[0].settings, { temperature: 0 });
  await service.transcribe(new Blob(["x"], { type: "audio/wav" }), { language: "en", prompt: "Mine" });
  assert.equal(stt[1].language, "en"); assert.equal(stt[1].prompt, "Mine", "a caller's language and prompt win");
  service.saveSource({ settingsFor: { model: "qwen-asr-0.6b", values: null } }, id);
  assert.deepEqual(Object.keys(service.view().profiles[0].modelSettings!), ["moonshine-medium"], "empty values drop the model");

  service.saveTtsSource({ name: "Speech", source: "memorize", model: "zonos3-mini", speed: 1.5,
    settingsFor: { model: "zonos3-mini", values: { speed: 1.1, steering: { happy: 3 } } } });
  await service.speak("Hello");
  assert.equal(tts[0].speed, 1.1, "the model's speed over the source's old one");
  assert.deepEqual(tts[0].settings, { steering: { happy: 3 } });
  await service.speak("Hello", { speed: 0.8, model: "kokoro" });
  assert.equal(tts[1].speed, 0.8); assert.deepEqual(tts[1].settings, {}, "another model has its own settings");
});

test("the engines send settings as form or JSON fields, and word refusals, busy servers and keys the server refuses", async (t) => {
  const bodies: (FormData | string)[] = [];
  let answer: () => Response = () => Response.json({ text: "Words" });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => { bodies.push(init.body as FormData | string); return answer(); });
  const audio = new Blob(["x"], { type: "audio/wav" }), signal = AbortSignal.timeout(1000);
  assert.deepEqual(await openAiEngine.transcribe({ source: memorize, model: "", audio, language: "fi", settings: { temperature: 0, opts: { a: 1 } }, signal }), { ok: true, text: "Words" });
  const form = bodies[0] as FormData;
  assert.equal(form.get("model"), null, "no model: the server's default");
  assert.equal(form.get("language"), "fi"); assert.equal(form.get("temperature"), "0"); assert.equal(form.get("opts"), '{"a":1}');

  answer = () => new Response(JSON.stringify({ detail: "Speed (speed) must be between 0.5 and 2, not 3" }), { status: 400, headers: { "X-Memorize-Setting": "speed", "Content-Type": "application/json" } });
  const tts = { source: memorize, model: "kokoro", text: "Hi", voice: "af_heart", speed: 3, settings: { steering: { pace: 1 } }, signal };
  assert.deepEqual(await openAiTts.speak(tts), { ok: false, error: "setting", setting: "speed", retryable: false, message: "Speed (speed) must be between 0.5 and 2, not 3" });
  assert.deepEqual(JSON.parse(bodies[1] as string), { steering: { pace: 1 }, model: "kokoro", input: "Hi", voice: "af_heart", speed: 3, response_format: "mp3" });
  answer = () => new Response("{}", { status: 503, headers: { "Retry-After": "12" } });
  assert.deepEqual(await openAiTts.speak(tts), { ok: false, error: "busy", retryable: false, retryAfter: 12, message: "The model server is busy, try again in 12 s." });
  answer = () => new Response("{}", { status: 403 });
  assert.match((await openAiEngine.transcribe({ source: memorize, model: "qwen-asr-0.6b", audio, signal }) as { message: string }).message, /may not use the model qwen-asr-0\.6b/);
});
