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
import { memoryStore, normalizeSettings } from "./settings.js";
import { MAX_SPEECH_CHARS, listModels, modelInfo, openAiTts, type AudioModels } from "./engine.js";
import type { TtsEngine, TtsRequest, TtsResult } from "./types.js";

const source: OpenAISource = { id: "openai", name: "OpenAI", baseUrl: "https://tts.invalid/v1", apiKey: "secret-key", models: [] };
const audioStream = (bytes = "mp3-bytes") => new Blob([bytes]).stream();

function setup(engine?: (req: TtsRequest) => Promise<TtsResult>, timeoutMs?: number, voices?: TtsEngine["voices"]) {
  const calls: TtsRequest[] = [];
  const tts: TtsEngine = { async speak(req) { calls.push(req); return engine ? engine(req) : { ok: true, type: "audio/mpeg", body: audioStream() }; }, voices };
  const service = new AudioService({ sources: () => [source], store: memoryStore(), tts, timeoutMs });
  const view = service.saveTtsSource({ name: "Hosted", source: "openai", model: "tts-1" });
  return { service, calls, id: view.ttsSources[0].id };
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

test("speak uses the chosen source's model, voice, speed and streaming and counts characters", async () => {
  const { service, calls, id } = setup();
  assert.equal(service.view().tts.source, id, "the first source added is the one pages use");
  const result = await service.speak("Hello there.");
  assert.equal(result.ok, true);
  assert.equal(calls[0].model, "tts-1"); assert.equal(calls[0].voice, "alloy"); assert.equal(calls[0].speed, 1); assert.equal(calls[0].stream, undefined);
  assert.equal(calls[0].source.apiKey, "secret-key");
  service.saveTtsSource({ voice: "af_heart", speed: 9, stream: true, model: "" }, id);
  const saved = service.view().ttsSources[0];
  assert.equal(saved.voice, "af_heart"); assert.equal(saved.speed, 4); assert.equal(saved.stream, true); assert.equal(saved.model, undefined);
  await service.speak("Hi.", { voice: "echo" });
  assert.equal(calls[1].voice, "echo"); assert.equal(calls[1].speed, 4); assert.equal(calls[1].stream, true); assert.equal(calls[1].model, undefined);
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
  service.update({ tts: { source: "__browser__", voice: "Kate", speed: 1.5 } });
  assert.equal(service.view().speech, "browser");
  assert.deepEqual(service.view().tts, { source: "__browser__", voice: "Kate", speed: 1.5 });
  const browser = await service.speak("Hi.");
  assert.equal(!browser.ok && browser.error, "no_source");
  service.update({ tts: { source: "" } });
  const off = await service.speak("Hi.");
  assert.equal(!off.ok && off.error, "no_source");
  assert.equal(service.view().speech, undefined);
  assert.equal(calls.length, 0);
});

test("text-to-speech sources are their own list: separate from speech-to-text, keys hidden, removal moves the choice", () => {
  const { service, id } = setup();
  const stt = service.saveSource({ name: "STT", source: "openai", model: "whisper-1" }).profiles[0];
  assert.throws(() => service.update({ tts: { source: stt.id } }), /existing text-to-speech/);
  assert.throws(() => service.update({ tts: { source: "missing" } }), /existing text-to-speech/);
  assert.equal(service.view().ttsSources.length, 1);
  const local = service.saveTtsSource({ name: "Kokoro", source: "__custom__", custom: { baseUrl: "https://audio.invalid/tts/v1/", apiKey: "tts-secret" } })
    .ttsSources.find(s => s.name === "Kokoro")!;
  assert.equal(local.custom?.baseUrl, "https://audio.invalid/tts/v1"); assert.equal(local.custom?.hasKey, true);
  assert.ok(!JSON.stringify(service.view()).includes("tts-secret"));
  assert.throws(() => service.saveTtsSource({ name: "Bad", source: "__custom__", custom: { baseUrl: "ftp://x" } }), /HTTP/);
  assert.throws(() => service.saveTtsSource({ name: "", source: "openai" }), /name/);
  service.update({ input: { sendAfterDictation: true } });
  assert.equal(service.view().tts.source, id, "other settings keep the speech choice");
  service.removeSource(stt.id);
  assert.equal(service.view().tts.source, id, "speech-to-text sources do not touch text-to-speech");
  service.removeTtsSource(id);
  assert.equal(service.view().tts.source, local.id);
  service.removeTtsSource(local.id);
  assert.equal(service.view().tts.source, undefined); assert.equal(service.view().speech, undefined);
});

test("a speech model saved on a speech-to-text source by the first build becomes its own text-to-speech source", () => {
  const settings = normalizeSettings({ sources: [{ id: "a", name: "Hosted", source: "openai", model: "whisper-1", speechModel: "tts-1" }, { id: "b", name: "STT", source: "openai", model: "whisper-1" }],
    tts: { source: "a", voice: "nova", speed: 1.25 } });
  assert.deepEqual(settings.ttsSources, [{ id: "a", name: "Hosted", source: "openai", model: "tts-1", voice: "nova", speed: 1.25 }]);
  assert.deepEqual(settings.tts, { source: "a" });
  assert.equal(settings.sources[0].speechModel, undefined);
  assert.deepEqual(normalizeSettings({ ttsSources: [], sources: [{ id: "a", name: "x", speechModel: "tts-1" }] }).ttsSources, [], "only once");
});

test("voices come from the server's list, are cached, fall back to OpenAI's names, and drafts keep a saved key only on its host", async () => {
  const asked: { url: string; key?: string; model?: string }[] = [];
  const voices: TtsEngine["voices"] = async ({ source: s, model }) => {
    asked.push({ url: s.baseUrl, key: s.apiKey, model });
    return s.baseUrl.includes("plain") ? { ok: true, voices: [{ id: "alloy" }], listed: false } : { ok: true, voices: [{ id: "af_heart" }, { id: "bm_george" }], default: "af_heart", listed: true };
  };
  const { service } = setup(undefined, undefined, voices);
  const kokoro = service.saveTtsSource({ name: "Kokoro", source: "__custom__", model: "kokoro", custom: { baseUrl: "https://audio.invalid/tts/v1", apiKey: "k" } })
    .ttsSources.find(s => s.name === "Kokoro")!;
  const listed = await service.voices({ id: kokoro.id });
  assert.ok(listed.ok && listed.listed && listed.default === "af_heart" && listed.voices.length === 2);
  await service.voices({ id: kokoro.id });
  assert.equal(asked.length, 1, "cached");
  assert.equal(asked[0].model, "kokoro"); assert.equal(asked[0].key, "k");
  await service.voices({ id: kokoro.id, source: "__custom__", model: "kokoro-cpu", custom: { baseUrl: "https://audio.invalid/tts/v1" } });
  assert.equal(asked.at(-1)!.key, "k", "an empty key field keeps the saved key on the same host");
  await service.voices({ id: kokoro.id, source: "__custom__", model: "kokoro", custom: { baseUrl: "https://elsewhere.invalid/v1" } });
  assert.equal(asked.at(-1)!.key, "", "never sent to another host");
  const draft = await service.voices({ source: "__custom__", custom: { baseUrl: "not a url" } });
  assert.equal(!draft.ok && draft.error, "no_source");
  const plain = await service.voices({ source: "__custom__", custom: { baseUrl: "https://plain.invalid/v1" } });
  assert.ok(plain.ok && !plain.listed);
  const none = new AudioService({ sources: () => [source], store: memoryStore() });
  assert.equal((await none.voices({})).ok, false);
});

test("the OpenAI engine posts JSON to /audio/speech, sends stream only when asked, reads voice lists, and maps failures without relaying the body", async () => {
  const realFetch = globalThis.fetch;
  const seen: { url: string; init?: RequestInit }[] = [];
  let reply = () => new Response("mp3", { status: 200, headers: { "content-type": "audio/mpeg" } });
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => { seen.push({ url: String(url), init }); return reply(); }) as typeof fetch;
  try {
    const req = { source: { ...source, baseUrl: "https://tts.invalid/v1/" }, model: "tts-1", text: "Hi.", voice: "nova", speed: 1.5, signal: new AbortController().signal };
    const ok = await openAiTts.speak(req);
    assert.equal(ok.ok, true);
    assert.equal(seen[0].url, "https://tts.invalid/v1/audio/speech");
    assert.deepEqual(JSON.parse(seen[0].init!.body as string), { model: "tts-1", input: "Hi.", voice: "nova", speed: 1.5, response_format: "mp3" });
    assert.equal((seen[0].init!.headers as Record<string, string>).Authorization, "Bearer secret-key");
    await openAiTts.speak({ ...req, model: undefined, stream: true });
    assert.deepEqual(JSON.parse(seen[1].init!.body as string), { input: "Hi.", voice: "nova", speed: 1.5, response_format: "mp3", stream: true });
    reply = () => new Response("secret upstream detail", { status: 401 });
    const auth = await openAiTts.speak(req);
    assert.equal(!auth.ok && auth.error, "auth"); assert.ok(!JSON.stringify(auth).includes("upstream"));
    reply = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const notAudio = await openAiTts.speak(req);
    assert.equal(!notAudio.ok && notAudio.error, "engine");
    reply = () => Response.json({ voices: ["af_heart", { id: "bm_george", name: "George" }], default: "af_heart" });
    const list = await openAiTts.voices!({ source: req.source, model: "kokoro", signal: req.signal });
    assert.equal(seen.at(-1)!.url, "https://tts.invalid/v1/audio/voices?model=kokoro");
    assert.deepEqual(list, { ok: true, voices: [{ id: "af_heart" }, { id: "bm_george", name: "George" }], listed: true, default: "af_heart" });
    reply = () => new Response("not found", { status: 404 });
    const missing = await openAiTts.voices!({ source: req.source, signal: req.signal });
    assert.ok(missing.ok && !missing.listed && missing.voices.some(v => v.id === "alloy"));
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

  const { service, calls, id } = setup();
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
    // Pages may pick any of the user's sources and a model.
    const picked = await post({ text: "Hello.", sourceId: id, model: "tts-1-hd", voice: "nova" }, { "x-scribe-tab": "page" });
    assert.equal(picked.status, 200); await picked.arrayBuffer();
    assert.equal(calls.at(-1)!.model, "tts-1-hd"); assert.equal(calls.at(-1)!.voice, "nova");
    assert.equal((await post({ text: "Hello.", sourceId: "missing" }, { "x-scribe-tab": "page" })).status, 409);
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
    assert.equal(result.done.ok, true); assert.equal(result.done.reason, "ended");
    assert.equal(result.done.spoken, `${texts[0]} ${texts[1]}`, "spoken is every piece played");
    assert.deepEqual(result.states, [0, 1]);
    assert.ok(texts[0].length <= 300 && texts[0].startsWith("First sentence here."));
    assert.equal(result.routed, 1, "a speech stopped while it connects never reaches the speech channel");
    assert.equal(result.end.reason, "stopped");

    texts.length = 0;
    const streamed = await page.evaluate(`(async () => {
      const audio = window.scribeAudio, states = [];
      const s = audio.speak(null, { stream: true, onState: st => states.push({ piece: st.piece, text: st.text, spoken: st.spoken }) });
      s.append("Hello th"); s.append("ere, friend. Sec");
      await new Promise(r => setTimeout(r, 50));
      s.append("ond one.\\nThird without an end");
      s.end();
      const appendAfterEnd = s.append("Too late.");
      const done = await s.ended;
      // A stop while the first piece plays drops text that was never fetched.
      const t = audio.speak(null, { stream: true });
      t.append("Only this. ");
      await new Promise(r => setTimeout(r, 30));
      const stopped = await t.stop();
      const afterStop = t.append("Never read. ");
      return { states, done, appendAfterEnd, stopped, afterStop };
    })()`) as any;
    // Text that is ready together goes in one piece.
    assert.deepEqual(texts, ["Hello there, friend.", "Second one. Third without an end", "Only this."]);
    assert.deepEqual(streamed.states.map((s: any) => s.text), texts.slice(0, 2));
    assert.equal(streamed.states[1].spoken, "Hello there, friend.");
    assert.equal(streamed.done.reason, "ended"); assert.equal(streamed.done.spoken, "Hello there, friend. Second one. Third without an end");
    assert.equal(streamed.appendAfterEnd, false); assert.equal(streamed.afterStop, false);
    assert.equal(streamed.stopped.reason, "stopped"); assert.equal(streamed.stopped.spoken, ""); assert.equal(streamed.stopped.partial, "Only this.");
  } finally { await browser.close(); }
});

test("scribeAudio.speak sends text as it arrives to a source with its own stream, and plays its audio", async () => {
  const { launchChromium } = await import("../chromium.js");
  const browser = await launchChromium({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"], purpose: "Speech stream test" });
  try {
    const page = await browser.newPage();
    const wav = fs.readFileSync(new URL("../../public/audio-test.wav", import.meta.url));
    const posted: string[] = [], sockets: { url: string; messages: any[] }[] = [];
    await page.route("http://audio.test/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/audio/speech") { posted.push(route.request().postDataJSON().text); return route.fulfill({ body: wav, headers: { "content-type": "audio/wav" } }); }
      if (path === "/api/audio/settings") return route.fulfill({ json: { speech: "source", tts: {}, output: { sounds: false, volume: 0.6, cues: {} } } });
      return route.fulfill({ body: "<!doctype html><title>t</title>", headers: { "content-type": "text/html" } });
    });
    let plain = false;
    await page.routeWebSocket(/\/api\/audio\/speech-stream/, ws => {
      const conn = { url: ws.url(), messages: [] as any[] };
      sockets.push(conn);
      if (plain) { ws.send(JSON.stringify({ type: "fallback" })); ws.close(); return; }
      ws.send(JSON.stringify({ type: "ready" }));
      ws.onMessage(raw => {
        const msg = JSON.parse(String(raw));
        conn.messages.push(msg);
        if (msg.type === "end") {
          // start comes at once; the audio only once the model has made some, as with a slow model.
          ws.send(JSON.stringify({ type: "start", format: "wav" }));
          setTimeout(() => { ws.send(wav); ws.send(JSON.stringify({ type: "done", ok: true })); }, 600);
        }
      });
    });
    await page.goto("http://audio.test/");
    for (const name of ["audio.js", "audio-speech.js"]) await page.addScriptTag({ content: fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8") });
    const run = `(async () => {
      const audio = window.scribeAudio, states = [];
      await audio.refresh();
      let endAt = 0, heardAt = 0;
      const s = audio.speak(null, { stream: true, voice: "af_heart", onState: st => { states.push(st.text); heardAt ||= performance.now(); } });
      s.append("Hel"); s.append("lo th");
      await new Promise(r => setTimeout(r, 50));
      s.append("ere"); s.end(); endAt = performance.now();
      return { done: await s.ended, states, wait: heardAt - endAt };
    })()`;
    const streamed = await page.evaluate(run) as any;
    assert.equal(streamed.done.ok, true); assert.equal(streamed.done.reason, "ended"); assert.equal(streamed.done.spoken, "Hello there");
    assert.ok(streamed.wait >= 550, `speaking is reported when sound starts, not at start (${streamed.wait} ms)`);
    assert.deepEqual(sockets[0].messages.map(m => m.text ?? m.type), ["Hel", "lo th", "ere", "end"], "the text goes unsplit, as it arrived");
    assert.match(sockets[0].url, /voice=af_heart/);
    assert.deepEqual(posted, [], "nothing went over POST /speech");

    plain = true;
    const fallback = await page.evaluate(run) as any;
    assert.equal(fallback.done.reason, "ended"); assert.deepEqual(posted, ["Hello there"], "a plain server gets sentence pieces");
  } finally { await browser.close(); }
});

test("model lists keep an audio server's flagged list, cut a plain OpenAI list to speech or transcription models, and are cached", async () => {
  let calls = 0;
  const lists: Record<string, AudioModels> = {
    "https://tts.invalid/v1": { ok: true, flagged: false, models: ["gpt-4o", "tts-1", "gpt-4o-mini-tts", "whisper-1", "dall-e-3"].map(id => ({ id })) },
    "https://audio.invalid/tts/v1": { ok: true, flagged: true, models: [{ id: "kokoro", default: true, loaded: true, streaming: "sentence" }, { id: "chatterbox-nano", streaming: "native" }] },
  };
  const service = new AudioService({ sources: () => [source], store: memoryStore(), listModels: async s => { calls++; return lists[s.baseUrl]; } });
  const openai = service.saveTtsSource({ name: "OpenAI", source: "openai" }).ttsSources[0].id;
  const tts = await service.models({ kind: "tts", id: openai });
  assert.deepEqual(tts.ok && tts.models.map(m => m.id), ["tts-1", "gpt-4o-mini-tts"]);
  const stt = await service.models({ kind: "stt", source: "openai" });
  assert.deepEqual(stt.ok && stt.models.map(m => m.id), ["whisper-1"]);
  const audio = await service.models({ kind: "tts", source: "__custom__", custom: { baseUrl: "https://audio.invalid/tts/v1" } });
  assert.ok(audio.ok && audio.flagged && audio.models[1].streaming === "native");
  const before = calls;
  await service.models({ kind: "tts", id: openai });
  assert.equal(calls, before, "cached");
  assert.equal((await service.models({ kind: "tts", source: "__custom__", custom: { baseUrl: "nope" } })).ok, false);
});

test("listModels reads OpenAI's list and the audio server's flags", async () => {
  const realFetch = globalThis.fetch;
  let url = "";
  globalThis.fetch = (async (u: string | URL) => { url = String(u); return Response.json({ object: "list", data: [
    { id: "kokoro", object: "model", default: true, loaded: "yes", streaming: "sentence", aliases: ["k"] },
    { id: "chatterbox-nano", default: false, loaded: false, streaming: "native" }, { id: "old", streaming: "none" }, { nope: 1 }] }); }) as typeof fetch;
  try {
    const result = await listModels({ ...source, baseUrl: "https://audio.invalid/tts/v1/" }, new AbortController().signal);
    assert.equal(url, "https://audio.invalid/tts/v1/models");
    assert.deepEqual(result, { ok: true, flagged: true, models: [{ id: "kokoro", default: true, loaded: true, streaming: "sentence", aliases: ["k"] },
      { id: "chatterbox-nano", streaming: "native" }, { id: "old" }] });
  } finally { globalThis.fetch = realFetch; }
});

test("speak takes a source and model from the caller; an empty model asks for the server's loaded one", async () => {
  const { service, calls } = setup();
  const other = service.saveTtsSource({ name: "Kokoro", source: "__custom__", model: "kokoro", voice: "af_heart", custom: { baseUrl: "https://audio.invalid/tts/v1" } })
    .ttsSources.find(s => s.name === "Kokoro")!.id;
  await service.speak("Hi.", { sourceId: other });
  assert.equal(calls.at(-1)!.source.baseUrl, "https://audio.invalid/tts/v1"); assert.equal(calls.at(-1)!.model, "kokoro"); assert.equal(calls.at(-1)!.voice, "af_heart");
  await service.speak("Hi.", { sourceId: other, model: "chatterbox-nano" });
  assert.equal(calls.at(-1)!.model, "chatterbox-nano");
  await service.speak("Hi.", { sourceId: other, model: "" });
  assert.equal(calls.at(-1)!.model, undefined);
  await service.speak("Hi.");
  assert.equal(calls.at(-1)!.model, "tts-1", "without a source it is the Settings choice");
});

test("model details: the list keeps description, features and tags; GET /models/{id} adds the guide; the service resolves the default and caches", async () => {
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  const entry = { id: "chatterbox-nano", aliases: ["nano"], description: "Expressive, small.", default: false, loaded: false, streaming: "sentence",
    features: { languages: ["en"], tags: true, options: ["temperature"] }, tags: { style: ["happy"], sound: ["laugh"], reset: "normal" }, has_guide: true };
  globalThis.fetch = (async (u: string | URL) => {
    urls.push(String(u));
    if (String(u).endsWith("/models")) return Response.json({ data: [{ ...entry, guide: "not in lists" }] });
    if (String(u).endsWith("/models/chatterbox-nano")) return Response.json({ ...entry, guide: "# Chatterbox\nUse [laugh]." });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  try {
    const list = await listModels({ ...source, baseUrl: "https://audio.invalid/tts/v1" }, new AbortController().signal);
    assert.ok(list.ok);
    assert.deepEqual(list.models[0], { id: "chatterbox-nano", streaming: "sentence", aliases: ["nano"], description: "Expressive, small.",
      features: entry.features, tags: entry.tags, hasGuide: true });
    const one = await modelInfo({ ...source, baseUrl: "https://audio.invalid/tts/v1" }, "chatterbox-nano", new AbortController().signal);
    assert.ok(one.ok && one.model.guide === "# Chatterbox\nUse [laugh].");
    assert.equal((await modelInfo({ ...source, baseUrl: "https://audio.invalid/tts/v1" }, "missing", new AbortController().signal)).ok, false);
  } finally { globalThis.fetch = realFetch; }

  const asked: string[] = [];
  const service = new AudioService({ sources: () => [source], store: memoryStore(),
    listModels: async () => ({ ok: true, flagged: true, models: [{ id: "kokoro", default: true }, { id: "chatterbox-nano" }] }),
    modelInfo: async (_s, id) => { asked.push(id); return { ok: true, model: { id, guide: `Guide for ${id}` } }; } });
  const id = service.saveTtsSource({ name: "Audio", source: "openai" }).ttsSources[0].id;
  const fallback = await service.modelGuide({ kind: "tts", id });
  assert.ok(fallback.ok && fallback.model.guide === "Guide for kokoro", "no saved model: the server's default");
  service.saveTtsSource({ model: "chatterbox-nano" }, id);
  assert.ok((await service.modelGuide({ kind: "tts", id })).ok);
  await service.modelGuide({ kind: "tts", id, model: "chatterbox-nano" });
  assert.deepEqual(asked, ["kokoro", "chatterbox-nano"], "cached per model");
  assert.equal((await service.modelGuide({ kind: "tts", id: "missing" })).ok, false);
});
