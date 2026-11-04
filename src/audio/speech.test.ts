import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import express from "express";
import type { OpenAISource } from "../agent/openaiSources.js";
import type { PermissionGrant } from "../pagePermissions.js";
import { audioRouter } from "./routes.js";
import { PageAudio, SPEECH_LIMITS } from "./page.js";
import { AudioService } from "./service.js";
import { memoryStore } from "./settings.js";
import { MAX_SPEECH_CHARS, openAiTts } from "./engine.js";
import type { TtsEngine, TtsRequest, TtsResult } from "./types.js";

const source: OpenAISource = { id: "openai", name: "OpenAI", baseUrl: "https://tts.invalid/v1", apiKey: "secret-key", models: [] };
const audioStream = (bytes = "mp3-bytes") => new Blob([bytes]).stream();

function setup(engine?: (req: TtsRequest) => Promise<TtsResult>, timeoutMs?: number) {
  const calls: TtsRequest[] = [];
  const tts: TtsEngine = { async speak(req) { calls.push(req); return engine ? engine(req) : { ok: true, type: "audio/mpeg", body: audioStream() }; } };
  const service = new AudioService({ sources: () => [source], store: memoryStore(), tts, timeoutMs });
  const view = service.saveSource({ name: "Hosted", source: "openai", model: "whisper-1", speechModel: "tts-1" });
  const id = view.profiles[0].id;
  service.update({ tts: { source: id } });
  return { service, calls, id };
}

function splitSpeech(): (text: string, max?: number, first?: number) => string[] {
  const window: any = { scribeAudio: {}, addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(new URL("../../public/audio-speech.js", import.meta.url), "utf8"), { window });
  return window.scribeAudio.splitSpeech;
}

test("splitSpeech cuts at sentence ends, keeps every piece under the limit and drops empty pieces", () => {
  const split = splitSpeech();
  assert.deepEqual([...split("One. Two! Three?", 10)], ["One. Two!", "Three?"]);
  assert.deepEqual([...split("Short. Second sentence here.", 100, 8)], ["Short.", "Second sentence here."]);
  assert.deepEqual([...split("Line one\nLine two", 10)], ["Line one", "Line two"]);
  assert.deepEqual([...split("  ... !! ")], []);
  assert.deepEqual([...split("")], []);
  const long = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ") + ".";
  const pieces = split(long, 4096);
  assert.ok(pieces.length > 1 && pieces.every(p => p.length <= 4096));
  assert.equal(pieces.join(" "), long);
  const text = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  const packed = split(text, 4096, 300);
  assert.ok(packed[0].length <= 300 && packed.slice(1).every(p => p.length <= 4096));
  assert.ok(packed.every(p => p.endsWith(".")));
  assert.equal(packed.join(" "), text);
});

test("speak uses the chosen source's speech model, voice and speed and counts characters", async () => {
  const { service, calls, id } = setup();
  const result = await service.speak("Hello there.");
  assert.equal(result.ok, true);
  assert.equal(calls[0].model, "tts-1"); assert.equal(calls[0].voice, "alloy"); assert.equal(calls[0].speed, 1);
  assert.equal(calls[0].source.apiKey, "secret-key");
  service.update({ tts: { voice: "nova", speed: 9 } });
  assert.deepEqual(service.view().tts, { source: id, voice: "nova", speed: 4 });
  await service.speak("Hi.", { voice: "echo" });
  assert.equal(calls[1].voice, "echo"); assert.equal(calls[1].speed, 4);
  const usage = service.view().usage;
  assert.equal(usage.chars, "Hello there.".length + 3); assert.equal(usage.speechCalls, 2); assert.equal(usage.calls, 0);
  assert.equal(service.view().speech, "source");
});

test("speak fails with typed errors and never reaches the engine for bad input", async () => {
  const { service, calls } = setup();
  assert.equal((await service.speak("")).ok, false);
  assert.equal((await service.speak(42)).ok, false);
  const big = await service.speak("a".repeat(MAX_SPEECH_CHARS + 1));
  assert.equal(!big.ok && big.error, "too_large");
  assert.equal(calls.length, 0);
  service.update({ tts: { source: "__browser__" } });
  assert.equal(service.view().speech, "browser");
  const browser = await service.speak("Hi.");
  assert.equal(!browser.ok && browser.error, "no_source");
  service.update({ tts: { source: "" } });
  const off = await service.speak("Hi.");
  assert.equal(!off.ok && off.error, "no_source");
  assert.equal(service.view().speech, undefined);
  assert.equal(calls.length, 0);
});

test("speech settings only accept sources with a speech model, and removing the source turns speech off", () => {
  const { service, id } = setup();
  const plain = service.saveSource({ name: "STT only", source: "openai", model: "whisper-1" }).profiles.find(p => p.name === "STT only")!;
  assert.throws(() => service.update({ tts: { source: plain.id } }), /text-to-speech model/);
  assert.throws(() => service.update({ tts: { source: "missing" } }), /text-to-speech model/);
  service.update({ input: { sendAfterDictation: true } });
  assert.equal(service.view().tts.source, id, "other settings keep the speech choice");
  service.removeSource(id);
  assert.equal(service.view().tts.source, undefined);
  assert.equal(service.view().speech, undefined);
});

test("speak retries once on a rate limit and times out a source that never answers", async () => {
  let n = 0;
  const limited = setup(async () => (++n === 1 ? { ok: false, error: "rate_limit", message: "429", retryable: true } : { ok: true, type: "audio/mpeg", body: audioStream() }));
  assert.equal((await limited.service.speak("Hi.")).ok, true); assert.equal(limited.calls.length, 2);
  const auth = setup(async () => ({ ok: false, error: "auth", message: "401" }));
  const failed = await auth.service.speak("Hi.");
  assert.equal(!failed.ok && failed.error, "auth"); assert.equal(auth.calls.length, 1);
  assert.equal(auth.service.view().usage.speechFailed, 1);
  const slow = setup(req => new Promise(resolve => req.signal.addEventListener("abort", () => resolve({ ok: false, error: "network", message: "aborted" }))), 20);
  const timedOut = await slow.service.speak("Hi.");
  assert.equal(!timedOut.ok && timedOut.error, "timeout");
});

test("the OpenAI engine posts JSON to /audio/speech and maps failures without relaying the body", async () => {
  const realFetch = globalThis.fetch;
  const seen: { url: string; init: RequestInit }[] = [];
  let reply = () => new Response("mp3", { status: 200, headers: { "content-type": "audio/mpeg" } });
  globalThis.fetch = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return reply(); }) as typeof fetch;
  try {
    const req = { source: { ...source, baseUrl: "https://tts.invalid/v1/" }, model: "tts-1", text: "Hi.", voice: "nova", speed: 1.5, signal: new AbortController().signal };
    const ok = await openAiTts.speak(req);
    assert.equal(ok.ok, true);
    assert.equal(seen[0].url, "https://tts.invalid/v1/audio/speech");
    assert.deepEqual(JSON.parse(seen[0].init.body as string), { model: "tts-1", input: "Hi.", voice: "nova", speed: 1.5, response_format: "mp3" });
    assert.equal((seen[0].init.headers as Record<string, string>).Authorization, "Bearer secret-key");
    reply = () => new Response("secret upstream detail", { status: 401 });
    const auth = await openAiTts.speak(req);
    assert.equal(!auth.ok && auth.error, "auth"); assert.ok(!JSON.stringify(auth).includes("upstream"));
    reply = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const notAudio = await openAiTts.speak(req);
    assert.equal(!notAudio.ok && notAudio.error, "engine");
  } finally { globalThis.fetch = realFetch; }
});

test("page speech needs audio.speak and is limited per page by requests and characters", async () => {
  let now = 0;
  const grants = new Map<string, PermissionGrant>();
  const gate = new PageAudio(() => grants, () => now);
  assert.deepEqual(gate.checkSpeech("page", 10), { ok: false, error: "denied", permission: "audio.speak" });
  grants.set("audio.transcribe", { value: "allow", updatedAt: 1 });
  assert.equal(gate.checkSpeech("page", 10).ok, false, "the transcription grant does not cover speech");
  grants.set("audio.speak", { value: "allow", updatedAt: 1 });
  for (let i = 0; i < SPEECH_LIMITS.perMinute; i++) assert.equal(gate.checkSpeech("page", 10).ok, true);
  assert.equal(gate.checkSpeech("page", 10).ok, false);
  now = 60000;
  assert.equal(gate.checkSpeech("page", SPEECH_LIMITS.charsPerHour).ok, false, "characters per hour");
  assert.equal(gate.checkSpeech("page", 10).ok, true);
  assert.equal(gate.checkSpeech("other", 4000).ok, true);

  const { service, calls } = setup();
  const app = express(); app.use("/api/audio", audioRouter(service, gate));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as any).port}/api/audio/speech`;
    const post = (body: unknown, headers: Record<string, string> = {}) => fetch(base, { method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "sec-fetch-site": "same-origin", ...headers } });
    const shell = await post({ text: "Hello." });
    assert.equal(shell.status, 200); assert.equal(shell.headers.get("content-type"), "audio/mpeg");
    assert.equal(await shell.text(), "mp3-bytes");
    grants.set("audio.speak", { value: "ask", updatedAt: 2 });
    const denied = await post({ text: "Hello." }, { "x-scribe-tab": "page" });
    assert.equal(denied.status, 403); assert.equal((await denied.json()).permission, "audio.speak");
    assert.equal(calls.length, 1);
    grants.set("audio.speak", { value: "allow", updatedAt: 3 });
    now = 3600000 * 2;
    assert.equal((await post({ text: "Hello.", sourceId: "ignored" }, { "x-scribe-tab": "page" })).status, 200);
    assert.equal((await post({ text: "" })).status, 400);
    assert.equal((await post({ text: "a".repeat(MAX_SPEECH_CHARS + 1) })).status, 413);
    const wrongType = await fetch(base, { method: "POST", body: "Hello.", headers: { "Content-Type": "text/plain" } });
    assert.equal(wrongType.status, 415);
  } finally { server.close(); }
});

test("scribeAudio.speak plays the pieces in order through the speech channel and stops on request", async () => {
  const { launchChromium } = await import("../chromium.js");
  const browser = await launchChromium({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"], purpose: "Speech playback test" });
  try {
    const page = await browser.newPage();
    const wav = fs.readFileSync(new URL("../../public/audio-test.wav", import.meta.url));
    const texts: string[] = [];
    await page.route("http://audio.test/**", route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (path === "/api/audio/speech") { texts.push(req.postDataJSON().text); return route.fulfill({ body: wav, headers: { "content-type": "audio/wav" } }); }
      if (path === "/api/audio/settings") return route.fulfill({ json: { speech: "source", tts: {}, output: { sounds: false, volume: 0.6, cues: {} } } });
      return route.fulfill({ body: "<!doctype html><title>t</title>", headers: { "content-type": "text/html" } });
    });
    await page.goto("http://audio.test/");
    for (const name of ["audio.js", "audio-speech.js"]) await page.addScriptTag({ content: fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8") });
    // A string, so tsx's __name helper does not reach the page.
    const result = await page.evaluate(`(async () => {
      const audio = window.scribeAudio;
      await audio.refresh();
      let routed = 0; const route = audio.route;
      audio.route = (el, channel) => { if (channel === "speech") routed++; return route(el, channel); };
      const states = [];
      const long = "First sentence here. " + "Another sentence follows. ".repeat(20);
      const done = await audio.speak(long, { onState: s => states.push(s.piece) }).ended;
      const end = await audio.speak("One more sentence.").stop();
      return { done, states, routed, end };
    })()`) as any;
    assert.deepEqual(result.done, { ok: true, reason: "ended" });
    assert.deepEqual(result.states, [0, 1]);
    assert.ok(texts[0].length <= 300 && texts[0].startsWith("First sentence here."));
    assert.equal(result.routed, 2);
    assert.equal(result.end.reason, "stopped");
  } finally { await browser.close(); }
});
