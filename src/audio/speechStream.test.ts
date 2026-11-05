import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import type { OpenAISource } from "../agent/openaiSources.js";
import { shellOrigins } from "../config.js";
import { PageAudio, SPEECH_LIMITS } from "./page.js";
import { AudioService } from "./service.js";
import { memoryStore } from "./settings.js";
import { SPEECH_STREAM_PATH, speechStreamServer, streamUrl } from "./speechStream.js";

/** A server with the audio gateway's /tts/v1/stream socket; plain: no socket (404), like an OpenAI-compatible server. */
async function fakeGateway(opts: { plain?: boolean; fail?: boolean } = {}) {
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  const seen: { url: string; auth?: string; messages: any[] }[] = [];
  let upgrades = 0;
  server.on("upgrade", (req, socket, head) => {
    upgrades++;
    if (opts.plain || !req.url?.startsWith("/tts/v1/stream")) { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
    if (new URL(req.url, "http://x").searchParams.get("token") !== "gw-key") { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const conn = { url: req.url!, auth: req.headers.authorization, messages: [] as any[] };
      seen.push(conn);
      ws.send(JSON.stringify({ type: "ready" }));
      let text = "";
      ws.on("message", raw => {
        const msg = JSON.parse(String(raw));
        conn.messages.push(msg);
        if (msg.type === "text") text += msg.text;
        if (msg.type === "cancel") ws.send(JSON.stringify({ type: "done", turn: 1, cancelled: true }));
        if (msg.type === "end") {
          if (opts.fail) { ws.send(JSON.stringify({ type: "error", turn: 1, message: "model crashed" })); ws.send(JSON.stringify({ type: "done", turn: 1, error: true })); return; }
          ws.send(JSON.stringify({ type: "start", turn: 1, model: "kokoro", format: "mp3", sample_rate: 24000 }));
          ws.send(Buffer.from(`audio:${text}`));
          ws.send(JSON.stringify({ type: "done", turn: 1 }));
        }
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/tts/v1`, seen, upgrades: () => upgrades,
    close: () => { wss.close(); server.closeAllConnections(); server.close(); } };
}

async function daemon(baseUrl: string, apiKey = "gw-key", pageAudio?: PageAudio) {
  const source: OpenAISource = { id: "gw", name: "Gateway", baseUrl, apiKey, models: [] };
  const service = new AudioService({ sources: () => [source], store: memoryStore() });
  service.saveTtsSource({ name: "Gateway", source: "gw", model: "kokoro-clean", voice: "af_heart" });
  const recorded: [number, boolean][] = [];
  const streams = speechStreamServer({ target: o => service.speechTarget(o), record: (chars, ok) => recorded.push([chars, ok]),
    pageGate: pageAudio ? tab => pageAudio.openSpeechStream(tab) : undefined });
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => { if (!streams.handle(req, socket, head)) socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${SPEECH_STREAM_PATH}`;
  /** Opens the shell's socket, sends parts once ready, and collects what comes back. */
  const run = (parts: object[], query = "") => new Promise<{ messages: any[]; audio: string }>(resolve => {
    const ws = new WebSocket(url + query, { origin: shellOrigins()[0] });
    const messages: any[] = [];
    let audio = "";
    ws.on("message", (raw, binary) => {
      if (binary) { audio += String(raw); return; }
      const msg = JSON.parse(String(raw));
      messages.push(msg);
      if (msg.type === "ready") parts.forEach(p => ws.send(JSON.stringify(p)));
    });
    ws.on("close", () => resolve({ messages, audio }));
  });
  return { url, run, recorded, close: () => { streams.close(); server.closeAllConnections(); server.close(); } };
}

test("streamUrl puts the stream next to /audio/speech with the key as a token", () => {
  assert.equal(streamUrl({ id: "a", name: "A", baseUrl: "https://audio.example.org/tts/v1/", apiKey: "k y", models: [] }), "wss://audio.example.org/tts/v1/stream?token=k+y");
  assert.equal(streamUrl({ id: "a", name: "A", baseUrl: "http://127.0.0.1:8000/v1", models: [] }), "ws://127.0.0.1:8000/v1/stream");
});

test("speech stream relays text as it arrives to the gateway and its audio back", async () => {
  const gw = await fakeGateway();
  const d = await daemon(gw.url);
  try {
    const { messages, audio } = await d.run([{ type: "text", text: "Hel" }, { type: "text", text: "lo there" }, { type: "end" }], "?speed=1.5");
    assert.deepEqual(messages.map(m => m.type), ["ready", "start", "done"]);
    assert.equal(messages[1].format, "mp3"); assert.deepEqual(messages[2], { type: "done", ok: true });
    assert.equal(audio, "audio:Hello there");
    const conn = gw.seen[0];
    assert.equal(conn.auth, "Bearer gw-key");
    assert.deepEqual(conn.messages[0], { type: "config", model: "kokoro-clean", voice: "af_heart", speed: 1.5, response_format: "mp3" });
    assert.deepEqual(conn.messages.slice(1).map(m => m.text ?? m.type), ["Hel", "lo there", "end"], "tokens go as they are, unsplit");
    assert.deepEqual(d.recorded, [[11, true]]);
  } finally { d.close(); gw.close(); }
});

test("speech stream reports a failed turn, a cancel, and a refused key", async () => {
  const failing = await fakeGateway({ fail: true });
  const d = await daemon(failing.url);
  try {
    const failed = await d.run([{ type: "text", text: "Hi." }, { type: "end" }]);
    assert.deepEqual(failed.messages.at(-1), { type: "done", ok: false, error: "engine", message: "Text-to-speech failed: model crashed" });
    const cancelled = await d.run([{ type: "text", text: "Hi." }, { type: "cancel" }]);
    assert.deepEqual(cancelled.messages.at(-1), { type: "done", ok: true, reason: "stopped" });
  } finally { d.close(); failing.close(); }
  const gw = await fakeGateway();
  const wrong = await daemon(gw.url, "wrong");
  try {
    const refused = await wrong.run([]);
    assert.equal(refused.messages[0].error, "auth");
  } finally { wrong.close(); gw.close(); }
});

test("a server without the socket gets fallback, and is not asked again", async () => {
  const plain = await fakeGateway({ plain: true });
  const d = await daemon(plain.url);
  try {
    assert.deepEqual((await d.run([])).messages, [{ type: "fallback" }]);
    assert.deepEqual((await d.run([])).messages, [{ type: "fallback" }]);
    assert.equal(plain.upgrades(), 1);
  } finally { d.close(); plain.close(); }
});

test("a page's streamed speech passes audio.speak and charges its text to the hourly budget", async () => {
  const gw = await fakeGateway();
  const grants = new Map([["audio.speak", { value: "allow" as const, updatedAt: 1 }]]);
  const pageAudio = new PageAudio(id => id === "t_ok" ? grants : new Map());
  const d = await daemon(gw.url, "gw-key", pageAudio);
  try {
    assert.equal((await d.run([], "?tab=t_no")).messages[0].error, "denied");
    const big = "x".repeat(SPEECH_LIMITS.charsPerHour - 10);
    const ok = await d.run([{ type: "text", text: big }, { type: "end" }], "?tab=t_ok");
    assert.equal(ok.messages.at(-1).ok, true);
    const over = await d.run([{ type: "text", text: "more than ten" }, { type: "end" }], "?tab=t_ok");
    assert.deepEqual(over.messages.at(-1), { type: "done", ok: false, error: "rate_limited" });
  } finally { d.close(); gw.close(); }
  const origin = await new Promise<number>(resolve => {
    void (async () => {
      const g = await fakeGateway(); const dd = await daemon(g.url);
      const ws = new WebSocket(dd.url, { origin: "http://evil.example" });
      ws.on("unexpected-response", (_req, res) => { resolve(res.statusCode ?? 0); dd.close(); g.close(); });
      ws.on("open", () => { resolve(101); dd.close(); g.close(); });
    })();
  });
  assert.equal(origin, 403);
});
