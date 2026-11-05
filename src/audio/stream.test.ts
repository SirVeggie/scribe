import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import type { OpenAISource } from "../agent/openaiSources.js";
import { shellOrigins } from "../config.js";
import { AudioService } from "./service.js";
import { memoryStore } from "./settings.js";
import { NativeStream, STREAM_PATH, SpeechDetector, WindowStream, audioStreamServer, pcmToWav, type SpeechEvent } from "./stream.js";
import type { AudioResult } from "./types.js";

const RATE = 16000;
const tone = (ms: number) => Int16Array.from({ length: RATE * ms / 1000 }, (_, i) => Math.round(Math.sin(i / 5) * 9000));
const quiet = (ms: number) => new Int16Array(RATE * ms / 1000);
/** Feeds audio in 100 ms chunks, as the shell does. */
function feed(stream: { push(pcm: Int16Array): void }, ...parts: Int16Array[]) {
  for (const part of parts) for (let i = 0; i < part.length; i += 1600) stream.push(part.slice(i, i + 1600));
}
const seconds = async (wav: Blob) => (wav.size - 44) / 2 / RATE;

test("pcmToWav writes a 16 kHz mono 16-bit header", async () => {
  const wav = Buffer.from(await pcmToWav(Int16Array.from([1, -1, 300])).arrayBuffer());
  assert.equal(wav.toString("ascii", 0, 4), "RIFF"); assert.equal(wav.toString("ascii", 8, 15), "WAVEfmt");
  assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(40), 6);
  assert.equal(wav.readInt16LE(48), 300);
});

test("sliding window cuts at pauses, skips silence and only sends the last piece at stop", async () => {
  const sent: number[] = [];
  let n = 0;
  const stream = new WindowStream(async wav => { sent.push(await seconds(wav)); return { ok: true, text: `piece${++n}` }; }, () => {}, { preview: false });
  feed(stream, quiet(2000), tone(2000), quiet(800), tone(1500));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent.length, 1, "the first piece is sent while the user is still speaking");
  assert.ok(sent[0] >= 2 && sent[0] < 3, `first piece is the speech up to the pause (${sent[0]} s), not the leading silence`);
  assert.deepEqual(await stream.finish(), { ok: true, text: "piece1 piece2" });
  assert.equal(sent.length, 2);

  const silent = new WindowStream(async () => { throw new Error("silence must not be sent"); }, () => {});
  feed(silent, quiet(5000));
  assert.deepEqual(await silent.finish(), { ok: true, text: "" });
});

test("sliding window cuts long speech without pauses and reports a failed piece", async () => {
  const sent: number[] = [];
  const stream = new WindowStream(async wav => { sent.push(await seconds(wav)); return { ok: true, text: "x" }; }, () => {}, { preview: false, maxMs: 10000 });
  feed(stream, tone(25000));
  const result = await stream.finish();
  assert.equal(result.ok, true); assert.equal(sent.length, 3);
  assert.ok(sent.every(s => s <= 10.02), `pieces stay under the maximum: ${sent}`);
  assert.ok(Math.abs(sent.reduce((a, b) => a + b) - 25) < 0.05, "no audio is lost or repeated at the cuts");

  const failing = new WindowStream(async () => ({ ok: false, error: "engine", message: "down" }), () => {}, { preview: false });
  feed(failing, tone(1000));
  assert.equal((await failing.finish()).ok, false);
});

test("sliding window preview shows the open piece after the settled ones", async () => {
  const texts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let n = 0;
  const stream = new WindowStream(async wav => { const s = await seconds(wav); if (!n++) await gate; return { ok: true, text: s > 1.5 ? "long" : "short" }; }, t => texts.push(t), { stepMs: 1000 });
  feed(stream, tone(1200));
  release(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(texts, ["short"]);
  feed(stream, tone(2000));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(texts.at(-1), "long");
  assert.deepEqual(await stream.finish(), { ok: true, text: "long" });
});

/** A server that speaks Moonshine's /v1/stream protocol. */
async function fakeMoonshine(onHeaders: (h: http.IncomingHttpHeaders) => boolean) {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  let bytes = 0;
  server.on("upgrade", (req, socket, head) => {
    if (!onHeaders(req.headers) || !req.url?.startsWith("/v1/stream?rate=16000")) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.send(JSON.stringify({ type: "ready", sample_rate: 16000 }));
      ws.on("message", (raw, binary) => {
        if (binary) { bytes += (raw as Buffer).length; ws.send(`{"type":"partial","id":14094740708869578077,"text":"hel"}`); return; }
        if (String(raw) === "stop") {
          // Real ids are 64-bit: as JSON numbers these two would be equal.
          ws.send(`{"type":"final","id":14094740708869578077,"text":"hello"}`);
          ws.send(`{"type":"final","id":14094740708869578076,"text":"Oh,"}`);
          ws.send(JSON.stringify({ type: "done" }));
        }
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bytes: () => bytes, close: () => { wss.close(); server.closeAllConnections(); server.close(); } };
}

test("native stream speaks Moonshine's protocol with the key in a header", async () => {
  const fake = await fakeMoonshine(h => h.authorization === "Bearer moon-key");
  try {
    const source: OpenAISource = { id: "m", name: "M", baseUrl: fake.url, apiKey: "moon-key", models: [] };
    const texts: string[] = [];
    const stream = new NativeStream(source, t => texts.push(t));
    stream.push(tone(100)); // queued until the server is ready
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(await stream.finish(), { ok: true, text: "Oh, hello" });
    assert.equal(fake.bytes(), 3200); assert.equal(texts[0], "hel");

    const refused = new NativeStream({ ...source, apiKey: "wrong" }, () => {});
    refused.push(tone(100));
    const result = await refused.finish() as Extract<AudioResult, { ok: false }>;
    assert.equal(result.error, "auth");
  } finally { fake.close(); }
});

test("the stream socket is for the board UI only and runs the default source's mode", async () => {
  const service = new AudioService({ sources: () => [], store: memoryStore(),
    engine: { async transcribe() { return { ok: true, text: "windowed" }; } } });
  service.saveSource({ name: "Qwen", source: "__custom__", custom: { baseUrl: "http://127.0.0.1:9/v1" }, model: "q", streaming: "window" });
  assert.equal(service.view().streaming, "window");
  const streams = audioStreamServer(() => service.streamTarget(), () => {});
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => { if (!streams.handle(req, socket, head)) socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${STREAM_PATH}`;
  try {
    const status = await new Promise<number>(resolve => {
      const ws = new WebSocket(url, { origin: "http://evil.example" });
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)); ws.on("open", () => resolve(101));
    });
    assert.equal(status, 403);
    const ws = new WebSocket(url, { origin: shellOrigins()[0] });
    const messages: any[] = [];
    const done = new Promise<any>(resolve => ws.on("message", raw => { const m = JSON.parse(String(raw)); messages.push(m); if (m.type === "done") resolve(m); }));
    await new Promise(resolve => ws.on("open", resolve));
    const speech = tone(1500);
    ws.send(Buffer.from(speech.buffer)); ws.send("stop");
    assert.deepEqual(await done, { type: "done", ok: true, text: "windowed" });
    assert.equal(messages[0].type, "ready"); assert.equal(messages[0].mode, "window");
    ws.close();
  } finally { streams.close(); server.closeAllConnections(); server.close(); }
});

test("a page's live listen passes the page gate before the stream opens", async () => {
  const service = new AudioService({ sources: () => [], store: memoryStore(),
    engine: { async transcribe() { return { ok: true, text: "page" }; } } });
  service.saveSource({ name: "Qwen", source: "__custom__", custom: { baseUrl: "http://127.0.0.1:9/v1" }, model: "q", streaming: "window" });
  const tabs: string[] = [];
  const streams = audioStreamServer(() => service.streamTarget(), () => {},
    tab => { tabs.push(tab); return tab === "t_ok" ? { ok: true } : { ok: false, error: "rate_limited" }; });
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => { if (!streams.handle(req, socket, head)) socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${STREAM_PATH}`;
  const run = (query: string, audio = true) => new Promise<any>(resolve => {
    const ws = new WebSocket(base + query, { origin: shellOrigins()[0] });
    ws.on("message", raw => {
      const m = JSON.parse(String(raw));
      if (m.type === "ready" && audio) { ws.send(Buffer.from(tone(1500).buffer)); ws.send("stop"); }
      if (m.type === "done") { ws.close(); resolve(m); }
    });
  });
  try {
    assert.deepEqual(await run("?tab=t_busy"), { type: "done", ok: false, error: "rate_limited" });
    assert.deepEqual(await run("?tab=t_ok"), { type: "done", ok: true, text: "page" });
    assert.deepEqual(tabs, ["t_busy", "t_ok"]);
    const ungated = audioStreamServer(() => service.streamTarget(), () => {});
    server.removeAllListeners("upgrade");
    server.on("upgrade", (req, socket, head) => { if (!ungated.handle(req, socket, head)) socket.destroy(); });
    const denied = await run("?tab=t_ok");
    assert.equal(denied.error, "denied");
    ungated.close();
  } finally { streams.close(); server.closeAllConnections(); server.close(); }
});

test("listen({ live: true }) streams over a window with live transcription off, and the page gate counts the session once", async () => {
  let calls = 0;
  const service = new AudioService({ sources: () => [], store: memoryStore(),
    engine: { async transcribe() { return { ok: true, text: `p${++calls}` }; } } });
  service.saveSource({ name: "Whisper", source: "__custom__", custom: { baseUrl: "http://127.0.0.1:9/v1" }, model: "w" });
  assert.equal(service.view().streaming, undefined);
  assert.equal((service.streamTarget() as Extract<AudioResult, { ok: false }>).error, "engine");
  assert.equal((service.streamTarget(true) as { mode: string }).mode, "window");
  let gated = 0;
  const streams = audioStreamServer(force => service.streamTarget(force), () => {}, () => { gated++; return { ok: true }; });
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => { if (!streams.handle(req, socket, head)) socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${STREAM_PATH}`;
  const run = (query: string) => new Promise<any[]>(resolve => {
    const ws = new WebSocket(base + query, { origin: shellOrigins()[0] }), messages: any[] = [];
    ws.on("message", raw => {
      const m = JSON.parse(String(raw)); messages.push(m);
      if (m.type === "ready") {
        for (const part of [tone(2000), quiet(800), tone(2000), quiet(800), tone(1500)]) for (let i = 0; i < part.length; i += 1600) ws.send(Buffer.from(part.slice(i, i + 1600).buffer));
        ws.send("stop");
      }
      if (m.type === "done") { ws.close(); resolve(messages); }
    });
  });
  try {
    const off = await run("?tab=t_page");
    assert.equal(off.at(-1).error, "engine");
    const live = await run("?tab=t_page&live=1&preview=0");
    assert.equal(live[0].mode, "window");
    assert.ok(live.some(m => m.type === "text"), "text arrives while the user speaks");
    assert.equal(live.at(-1).ok, true);
    assert.ok(calls >= 3, `the window sent ${calls} pieces`);
    assert.equal(gated, 2, "one gate check per session, not per piece");
  } finally { streams.close(); server.closeAllConnections(); server.close(); }
});

test("speech detector reports start and end from the level, quickly after silence", () => {
  const events: SpeechEvent[] = [];
  const detector = new SpeechDetector(e => events.push(e), 250);
  feed(detector, quiet(500), tone(1000), quiet(200));
  assert.deepEqual(events, [{ speaking: true, at: 500 }], "a 200 ms gap is not the end");
  feed(detector, tone(500), quiet(400));
  assert.deepEqual(events.slice(1), [{ speaking: false, at: 2200 }]);
  // Fed in 20 ms steps: the end comes as soon as 250 ms of silence are in.
  const exact: number[] = [];
  const fine = new SpeechDetector(e => { if (!e.speaking) exact.push(fed); }, 250);
  let fed = 0;
  for (const part of [tone(600), quiet(600)]) for (let i = 0; i < part.length; i += 320) { fed += 20; fine.push(part.slice(i, i + 320)); }
  assert.deepEqual(exact, [860], "13 silent frames after 600 ms of speech");
});

test("sliding window settles the open piece at the end of speech", async () => {
  const sent: number[] = [];
  const stream = new WindowStream(async wav => { const s = await seconds(wav); sent.push(s); return { ok: true, text: `said ${s.toFixed(1)}` }; }, () => {}, { preview: false });
  feed(stream, tone(800), quiet(300));
  assert.equal(await stream.settle(), "said 1.1", "a short piece is previewed, not cut");
  feed(stream, tone(1500), quiet(300));
  assert.equal(await stream.settle(), "said 2.8", "the open piece, now long, is cut at the pause and transcribed once");
  assert.equal(sent.length, 2);
  feed(stream, quiet(300));
  assert.equal(await stream.settle(), "said 2.8", "nothing new: settled at once");
  assert.deepEqual(await stream.finish(), { ok: true, text: "said 2.8" });
});

test("the stream socket sends speech events with a settled final in window mode", async () => {
  const service = new AudioService({ sources: () => [], store: memoryStore(),
    engine: { async transcribe() { return { ok: true, text: "hello there" }; } } });
  service.saveSource({ name: "Qwen", source: "__custom__", custom: { baseUrl: "http://127.0.0.1:9/v1" }, model: "q", streaming: "window" });
  const streams = audioStreamServer(() => service.streamTarget(), () => {});
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => { if (!streams.handle(req, socket, head)) socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}${STREAM_PATH}?speech=1&pause=200`, { origin: shellOrigins()[0] });
    const speech: any[] = [];
    const final = new Promise<void>(resolve => ws.on("message", raw => {
      const m = JSON.parse(String(raw));
      if (m.type === "speech") { speech.push(m); if (m.final) resolve(); }
    }));
    await new Promise(resolve => ws.on("open", resolve));
    for (const part of [tone(1000), quiet(300)]) for (let i = 0; i < part.length; i += 1600) ws.send(Buffer.from(part.slice(i, i + 1600).buffer));
    await final;
    assert.deepEqual(speech.map(m => [m.speaking, m.final ?? null]), [[true, null], [false, false], [false, true]]);
    assert.equal(speech[1].at, 1000); assert.equal(speech[2].text, "hello there");
    ws.close();
  } finally { streams.close(); server.closeAllConnections(); server.close(); }
});

test("native stream settles when Moonshine finishes the line, or after a grace when it heard nothing", async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
    ws.send(JSON.stringify({ type: "ready" }));
    let n = 0;
    ws.on("message", (_raw, binary) => {
      if (!binary) return;
      n++;
      if (n === 1) ws.send(`{"type":"partial","id":7,"text":"good"}`);
      if (n === 3) ws.send(`{"type":"final","id":7,"text":"Good morning."}`);
    });
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const source: OpenAISource = { id: "m", name: "M", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, models: [] };
    const stream = new NativeStream(source, () => {});
    stream.heard();
    stream.push(tone(100)); await new Promise(resolve => setTimeout(resolve, 50));
    let settled: string | undefined;
    void stream.settle(5000).then(t => { settled = t; });
    stream.push(tone(100)); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settled, undefined, "the line is still open");
    stream.push(quiet(100)); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settled, "Good morning.");
    stream.heard();
    const started = Date.now();
    assert.equal(await stream.settle(100), "Good morning.", "no new line: the grace settles it");
    assert.ok(Date.now() - started >= 90);
    stream.cancel();
  } finally { wss.close(); server.closeAllConnections(); server.close(); }
});
