import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { authHeaders, type OpenAISource } from "../agent/openaiSources.js";
import { shellOrigins } from "../config.js";
import type { AudioResult } from "./types.js";

/** Live dictation (#832). The shell sends 16 kHz mono 16-bit PCM; the daemon answers with the text so far. */
export const STREAM_RATE = 16000;
export const STREAM_PATH = "/api/audio/stream";
const MAX_STREAM_BYTES = STREAM_RATE * 2 * 310;

export interface SttStream {
  push(pcm: Int16Array): void;
  /** Transcribes what is left and resolves with the whole transcript. */
  finish(): Promise<AudioResult>;
  cancel(): void;
}

export function pcmToWav(pcm: Int16Array, rate = STREAM_RATE): Blob {
  const out = Buffer.alloc(44 + pcm.length * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + pcm.length * 2, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i], 44 + i * 2);
  return new Blob([out], { type: "audio/wav" });
}

const join = (parts: string[]) => parts.map(p => p.trim()).filter(Boolean).join(" ");

export type WindowOptions = {
  /** Show text so far: re-transcribe the open piece every `stepMs`. Off, only finished pieces are sent. */
  preview?: boolean;
  stepMs?: number;
  /** A pause this long ends a piece, once the piece is at least `minMs` long. */
  pauseMs?: number;
  minMs?: number;
  /** Without a pause, a piece is cut at its quietest point near this length. */
  maxMs?: number;
};

/**
 * Sliding window for sources that only take whole clips (Qwen3-ASR on llama.cpp, Whisper servers).
 * The recording is cut into pieces at pauses, so no word straddles a cut and pieces need no overlap.
 * Each finished piece is transcribed once while the user goes on speaking; on stop only the last
 * piece is left. The open piece is re-transcribed for the preview and settles when it is cut.
 */
export class WindowStream implements SttStream {
  private static FRAME = STREAM_RATE / 50; // 20 ms
  private pcm = new Int16Array(STREAM_RATE * 30);
  private length = 0;
  private levels: number[] = [];
  private floor = 0.002;
  private segStart = 0; // in frames
  private segSpeech = 0;
  private silentRun = 0;
  private lastPreview = 0;
  private finals: string[] = [];
  private pending: { index: number; from: number; to: number }[] = [];
  private partial = "";
  private busy = false;
  private failed: AudioResult | undefined;
  private cancelled = false;
  private idle: (() => void)[] = [];
  private opts: Required<WindowOptions>;

  constructor(private transcribe: (wav: Blob) => Promise<AudioResult>, private onText: (text: string) => void, opts: WindowOptions = {}) {
    this.opts = { preview: true, stepMs: 1500, pauseMs: 500, minMs: 1500, maxMs: 25000, ...opts };
  }

  private frames(ms: number) { return Math.round(ms / 20); }

  push(chunk: Int16Array) {
    if (this.cancelled || this.failed) return;
    if (this.length + chunk.length > this.pcm.length) {
      const grown = new Int16Array(Math.max(this.pcm.length * 2, this.length + chunk.length));
      grown.set(this.pcm.subarray(0, this.length)); this.pcm = grown;
    }
    this.pcm.set(chunk, this.length); this.length += chunk.length;
    const F = WindowStream.FRAME;
    while ((this.levels.length + 1) * F <= this.length) {
      const at = this.levels.length * F;
      let sum = 0;
      for (let i = at; i < at + F; i++) sum += (this.pcm[i] / 32768) ** 2;
      const rms = Math.sqrt(sum / F);
      this.levels.push(rms);
      // Noise floor follows the quietest frames and creeps up slowly (about 2x in 25 s), for a noisy room.
      this.floor = rms < this.floor ? Math.max(rms, 1e-4) : this.floor * 1.0005;
      if (rms > Math.max(0.006, this.floor * 3)) { this.segSpeech++; this.silentRun = 0; } else this.silentRun++;
      this.step();
    }
  }

  private step() {
    const now = this.levels.length, segLen = now - this.segStart;
    if (!this.segSpeech && this.silentRun >= this.frames(1000)) {
      // Leading silence: drop it so it is never sent (silence makes Whisper-like models invent text).
      this.segStart = now - this.frames(200); this.lastPreview = now; return;
    }
    if (this.segSpeech >= this.frames(200) && this.silentRun >= this.frames(this.opts.pauseMs) && segLen >= this.frames(this.opts.minMs)) {
      this.cut(now - Math.floor(this.silentRun / 2)); return;
    }
    if (segLen >= this.frames(this.opts.maxMs)) {
      let best = now - 1;
      for (let i = now - this.frames(3000); i < now; i++) if (this.levels[i] <= this.levels[best]) best = i;
      this.cut(best); return;
    }
    if (this.opts.preview && this.segSpeech >= this.frames(200) && !this.busy && !this.pending.length && now - this.lastPreview >= this.frames(this.opts.stepMs)) {
      this.lastPreview = now;
      void this.run({ index: -1, from: this.segStart, to: now });
    }
  }

  private cut(at: number) {
    if (this.segSpeech >= this.frames(200)) {
      this.pending.push({ index: this.finals.length, from: this.segStart, to: at });
      this.finals.push("");
    }
    this.segStart = at; this.segSpeech = 0; this.lastPreview = this.levels.length;
    this.silentRun = Math.min(this.silentRun, this.levels.length - at);
    this.partial = "";
    this.pump();
  }

  private pump() {
    if (this.busy || this.cancelled) return;
    const job = this.pending.shift();
    if (job) { void this.run(job); return; }
    this.idle.splice(0).forEach(resolve => resolve());
  }

  private async run(job: { index: number; from: number; to: number }) {
    this.busy = true;
    const F = WindowStream.FRAME, start = this.segStart;
    const result = await this.transcribe(pcmToWav(this.pcm.slice(job.from * F, job.to * F)));
    this.busy = false;
    if (this.cancelled) return;
    if (job.index >= 0) {
      if (result.ok) this.finals[job.index] = result.text;
      else this.failed ??= result;
    } else if (result.ok && start === this.segStart) this.partial = result.text;
    if (!this.failed) this.onText(join([...this.finals, this.partial]));
    this.pump();
  }

  async finish(): Promise<AudioResult> {
    const end = Math.ceil(this.length / WindowStream.FRAME);
    while (this.levels.length < end) this.levels.push(0);
    if (this.segSpeech) { this.segSpeech = Math.max(this.segSpeech, this.frames(200)); this.cut(end); }
    if (this.busy || this.pending.length) await new Promise<void>(resolve => this.idle.push(resolve));
    return this.failed ?? { ok: true, text: join(this.finals) };
  }

  cancel() { this.cancelled = true; this.pending = []; this.idle.splice(0).forEach(resolve => resolve()); }
}

/** The server's own stream: Moonshine's `/v1/stream` WebSocket (lines with partial and final text). */
export class NativeStream implements SttStream {
  private socket: WebSocket;
  private queue: Buffer[] = [];
  private ready = false;
  private stopping = false;
  private lines = new Map<bigint, string>();
  private failure: AudioResult | undefined;
  private ended: Promise<void>;
  private end!: () => void;

  constructor(source: OpenAISource, private onText: (text: string) => void, private timeoutMs = 30_000) {
    this.ended = new Promise(resolve => { this.end = resolve; });
    const url = `${source.baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/stream?rate=${STREAM_RATE}`;
    this.socket = new WebSocket(url, { headers: authHeaders(source), handshakeTimeout: 10_000 });
    this.socket.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      this.fail(status === 401 || status === 403 ? { ok: false, error: "auth", message: `The speech-to-text server refused the stream (${status}). Check the API key.` }
        : { ok: false, error: "engine", message: `This source has no live stream endpoint (${status}). Set its streaming to Sliding window or Off.` });
      res.resume(); this.socket.terminate();
    });
    this.socket.on("error", () => this.fail({ ok: false, error: "network", message: "Cannot reach the speech-to-text stream." }));
    this.socket.on("close", () => this.fail({ ok: false, error: "network", message: "The speech-to-text stream closed early." }));
    this.socket.on("message", (raw, binary) => {
      if (binary) return;
      let msg: { type?: string; text?: string };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      // Moonshine's line ids are 64-bit and lose precision as JSON numbers, so they are read from the raw text.
      const id = /"id"\s*:\s*"?(\d+)/.exec(String(raw))?.[1];
      if (msg.type === "ready") {
        this.ready = true;
        this.queue.splice(0).forEach(b => this.socket.send(b));
        if (this.stopping) this.socket.send("stop");
      } else if ((msg.type === "partial" || msg.type === "final") && id) {
        this.lines.set(BigInt(id), typeof msg.text === "string" ? msg.text : "");
        this.onText(this.text());
      } else if (msg.type === "done") this.end();
    });
  }

  private text() { return join([...this.lines.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(e => e[1])); }

  private fail(result: AudioResult) { this.failure ??= result; this.end(); }

  push(pcm: Int16Array) {
    if (this.failure || this.stopping) return;
    const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    if (this.ready) this.socket.send(bytes); else this.queue.push(Buffer.from(bytes));
  }

  async finish(): Promise<AudioResult> {
    this.stopping = true;
    if (this.ready && !this.failure) this.socket.send("stop");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([this.ended.then(() => false), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), this.timeoutMs); })]);
    clearTimeout(timer);
    const result: AudioResult = timedOut ? { ok: false, error: "timeout", message: "The speech-to-text stream did not finish in time." }
      : this.failure ?? { ok: true, text: this.text() };
    this.cancel();
    return result;
  }

  cancel() {
    this.fail({ ok: false, error: "network", message: "Stream closed." });
    this.socket.removeAllListeners("message");
    try { this.socket.close(); } catch { /* not open yet */ }
  }
}

export type StreamTarget = { mode: "native"; source: OpenAISource } | { mode: "window"; transcribe: (wav: Blob) => Promise<AudioResult> };

/** Shell-only WebSocket that proxies a recording to the chosen stream mode; keys never reach the shell. */
export function audioStreamServer(target: () => StreamTarget | AudioResult, usage: (bytes: number, ok: boolean) => void,
  /** A page's live listen (#841) passes the same permission and rate-limit gate as its uploads. */
  pageGate?: (tab: string) => { ok: boolean; error?: string; permission?: string }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  wss.on("connection", (client: WebSocket, req: http.IncomingMessage) => {
    const send = (msg: object) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg)); };
    const params = new URL(req.url || "/", "http://x").searchParams;
    const preview = params.get("preview") !== "0", tab = params.get("tab");
    const gate = tab ? pageGate?.(tab) ?? { ok: false, error: "denied", permission: "audio.transcribe" } : { ok: true };
    if (!gate.ok) { send({ type: "done", ...gate }); client.close(); return; }
    const chosen = target();
    if ("ok" in chosen) { send({ type: "done", ...chosen }); client.close(); return; }
    let latest = "", bytes = 0, stopped = false;
    const onText = (text: string) => { if (text !== latest && !stopped) { latest = text; send({ type: "text", text }); } };
    const session: SttStream = chosen.mode === "native" ? new NativeStream(chosen.source, onText) : new WindowStream(chosen.transcribe, onText, { preview });
    send({ type: "ready", mode: chosen.mode, rate: STREAM_RATE });
    client.on("message", async (raw: RawData, binary: boolean) => {
      if (stopped) return;
      if (binary) {
        const buf = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
        if (bytes + buf.length > MAX_STREAM_BYTES || buf.length % 2) return;
        bytes += buf.length;
        // Copy into an aligned buffer: a Buffer's offset into its pool can be odd.
        session.push(new Int16Array(new Uint8Array(buf).buffer));
        return;
      }
      if (String(raw) !== "stop") return;
      stopped = true;
      const result = await session.finish();
      if (chosen.mode === "native") usage(bytes, result.ok);
      send({ type: "done", ...result });
      client.close();
    });
    client.on("close", () => { if (!stopped) { stopped = true; session.cancel(); } });
  });
  return {
    /** Takes the upgrade when it is for the stream path. Only the board's own UI may open it. */
    handle(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
      if (new URL(req.url || "/", "http://x").pathname !== STREAM_PATH) return false;
      const origin = req.headers.origin;
      if (!origin || !shellOrigins().includes(origin)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return true;
      }
      wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
      return true;
    },
    close() { wss.close(); },
  };
}
