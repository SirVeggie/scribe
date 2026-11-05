import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { authHeaders, type OpenAISource } from "../agent/openaiSources.js";
import { shellOrigin } from "../contentOrigin.js";
import type { SpeechTarget } from "./service.js";
import type { TtsFailure } from "./types.js";

/**
 * Text-to-speech input streaming. The shell sends text as it arrives and gets the audio back on one
 * socket. Sources with a `/stream` WebSocket next to `/audio/speech` take the text as it is and cut
 * it themselves. A plain OpenAI-compatible server has no such socket: the shell is told `fallback`
 * and reads the text in sentence pieces over POST /speech as before.
 *
 * Shell → daemon (JSON): { type: "text", text }, { type: "end" }, { type: "cancel" }.
 * Daemon → shell: { type: "ready" } | { type: "fallback" } first, then { type: "start", format },
 * the audio as binary frames, and { type: "done", ok, ... } last.
 */
export const SPEECH_STREAM_PATH = "/api/audio/speech-stream";
export const MAX_STREAM_SPEECH_CHARS = 100_000;
const CONNECT_MS = 5_000;

type Gate = { ok: boolean; error?: string; permission?: string; charge?: (chars: number) => boolean };
export type SpeechStreamDeps = {
  target(options: { sourceId?: string; model?: unknown; voice?: unknown; speed?: unknown }): SpeechTarget | TtsFailure;
  /** Characters read and whether the turn worked, for the daily usage. */
  record(chars: number, ok: boolean): void;
  /** A page's speech passes audio.speak and its rate limits; charge() takes its text from the hourly budget. */
  pageGate?(tab: string): Gate;
};

/** wss://…/v1/stream for a source at https://…/v1. The key goes in the header and as ?token= (browsers cannot set headers). */
export function streamUrl(source: OpenAISource): string {
  const url = new URL(`${source.baseUrl.replace(/\/+$/, "")}/stream`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (source.apiKey) url.searchParams.set("token", source.apiKey);
  return url.toString();
}

export function speechStreamServer(deps: SpeechStreamDeps) {
  /** Sources whose server answered the socket with an HTTP status: plain OpenAI ones. Found again after a restart. */
  const noStream = new Set<string>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  wss.on("connection", (client: WebSocket, req: http.IncomingMessage) => {
    const send = (msg: object) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg)); };
    let finished = false;
    const finish = (msg: object) => { if (finished) return; finished = true; send({ type: "done", ...msg }); client.close(); };
    const params = new URL(req.url || "/", "http://x").searchParams;
    const tab = params.get("tab");
    const gate: Gate = tab ? deps.pageGate?.(tab) ?? { ok: false, error: "denied", permission: "audio.speak" } : { ok: true };
    if (!gate.ok) { const { charge: _, ...failure } = gate; finish(failure); return; }
    const speed = params.get("speed");
    const target = deps.target({ sourceId: params.get("source") || undefined, voice: params.get("voice") ?? undefined,
      model: params.get("model") ?? undefined, speed: speed === null ? undefined : Number(speed) });
    if (!target.ok) { finish(target); return; }
    const key = target.source.baseUrl;
    const fallback = () => { if (finished) return; finished = true; send({ type: "fallback" }); client.close(); };
    if (noStream.has(key)) { fallback(); return; }

    const upstream = new WebSocket(streamUrl(target.source), { headers: authHeaders(target.source), handshakeTimeout: CONNECT_MS });
    let ready = false, chars = 0, turnError = "";
    const queued: string[] = [];
    const relay = (msg: object) => {
      const text = JSON.stringify(msg);
      if (ready) upstream.send(text); else queued.push(text);
    };
    const end = (msg: { ok: boolean; [key: string]: unknown }) => {
      if (finished) return;
      deps.record(chars, msg.ok);
      finish(msg);
      try { upstream.close(); } catch { /* not open yet */ }
    };
    upstream.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume(); upstream.terminate();
      if (status === 401 || status === 403) end({ ok: false, error: "auth", message: `The text-to-speech server refused the stream (${status}). Check the API key.` });
      else { noStream.add(key); fallback(); }
    });
    // Before ready the server may simply not stream; POST /speech then reports a real outage itself.
    upstream.on("error", () => { if (!ready) fallback(); else end({ ok: false, error: "network", message: "Cannot reach the text-to-speech stream." }); });
    upstream.on("close", () => { if (!ready) fallback(); else end({ ok: false, error: "network", message: "The text-to-speech stream closed early." }); });
    upstream.on("message", (raw: RawData, binary: boolean) => {
      if (binary) {
        if (client.readyState === WebSocket.OPEN) client.send(Array.isArray(raw) ? Buffer.concat(raw) : raw as Buffer, { binary: true });
        return;
      }
      let msg: { type?: string; turn?: number; message?: string; format?: string; sample_rate?: number; cancelled?: boolean; error?: boolean };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === "ready" && !ready) {
        // No model: the server's loaded one. Mp3 so the shell's MediaSource player takes it as it arrives.
        upstream.send(JSON.stringify({ type: "config", ...(target.model ? { model: target.model } : {}), voice: target.voice, speed: target.speed, response_format: "mp3" }));
        ready = true;
        queued.splice(0).forEach(text => upstream.send(text));
        send({ type: "ready" });
      } else if (msg.type === "start") send({ type: "start", format: msg.format || "mp3", ...(msg.sample_rate ? { sampleRate: msg.sample_rate } : {}) });
      else if (msg.type === "error" && msg.turn !== undefined) turnError = String(msg.message || "").slice(0, 300);
      else if (msg.type === "done") {
        if (msg.error) end({ ok: false, error: "engine", message: turnError ? `Text-to-speech failed: ${turnError}` : "Text-to-speech failed." });
        else end({ ok: true, ...(msg.cancelled ? { reason: "stopped" } : {}) });
      }
    });

    client.on("message", (raw: RawData, binary: boolean) => {
      if (binary || finished) return;
      let msg: { type?: string; text?: unknown };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === "text" && typeof msg.text === "string" && msg.text) {
        chars += msg.text.length;
        if (chars > MAX_STREAM_SPEECH_CHARS || (gate.charge && !gate.charge(msg.text.length))) {
          relay({ type: "cancel" });
          end(chars > MAX_STREAM_SPEECH_CHARS
            ? { ok: false, error: "too_large", message: `Text to read aloud must be at most ${MAX_STREAM_SPEECH_CHARS} characters.` }
            : { ok: false, error: "rate_limited" });
          return;
        }
        relay({ type: "text", text: msg.text });
      } else if (msg.type === "end") relay({ type: "end" });
      else if (msg.type === "cancel") relay({ type: "cancel" });
    });
    client.on("close", () => {
      if (finished) return;
      finished = true;
      if (ready) { try { upstream.send(JSON.stringify({ type: "cancel" })); } catch { /* closing */ } deps.record(chars, true); }
      try { upstream.close(); } catch { upstream.terminate(); }
    });
  });
  return {
    /** Takes the upgrade when it is for the speech stream path. Only the board's own UI may open it. */
    handle(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
      if (new URL(req.url || "/", "http://x").pathname !== SPEECH_STREAM_PATH) return false;
      const origin = req.headers.origin;
      if (!origin || !shellOrigin(req, origin)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return true;
      }
      wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
      return true;
    },
    close() { wss.close(); },
  };
}
