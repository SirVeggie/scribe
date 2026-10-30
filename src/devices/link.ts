import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import type tls from "node:tls";

/**
 * One peer link (#904): a TLS socket to a paired device carrying control messages and any number of
 * byte streams. Each stream is a plain Duplex; the receiving daemon hands it to its HTTP server as a
 * connection, so HTTP requests and WebSocket upgrades both ride on it with no handshake of their own.
 *
 * A frame is [type u8][stream u32][length u32][payload]. The side that dialed opens odd streams, the
 * other even ones. When both hellos list the "flow" feature (#910), each stream has a credit window:
 * a sender stops at WINDOW_BYTES unacknowledged bytes and the reader grants more as it consumes, so a
 * slow stream (a mirror push, a relayed link) never holds up the others. With an older device, a
 * stream that is not being read pauses the whole socket until it is.
 */

export const PROTOCOL = 1;
/** What this device's links can do, sent in the hello; the protocol stays 1 so older devices still talk. */
export const FEATURES = ["flow", "relay", "mirror"];
export const WINDOW_BYTES = 256 * 1024;
const GRANT_STEP = 64 * 1024;
export const HEARTBEAT_MS = 15_000;
/** No frame for this long and the link is taken for dead. */
export const DEAD_MS = 45_000;
const MAX_FRAME = 64 * 1024;
const MAX_CONTROL = 1024 * 1024;

const CONTROL = 0;
const OPEN = 1;
const DATA = 2;
const END = 3;
const RESET = 4;
const WINDOW = 5;

export type Control = { type: string; [key: string]: unknown };

/** Streams that arrived over a link, by the device at the other end: what callers.ts reads. */
const streamDevices = new WeakMap<object, string>();

export function peerDeviceOf(socket: object | undefined | null): string | undefined {
  return socket ? streamDevices.get(socket) : undefined;
}

export class LinkStream extends Duplex {
  /** Shims for the bits of net.Socket that Node's HTTP server calls. */
  remoteAddress = "peer";
  remotePort = 0;
  encrypted = true;
  private waiting: (() => void) | null = null;
  private ended = false;
  /** Flow control: bytes the other side still takes, what waits for more, and what we owe it. */
  private credit = WINDOW_BYTES;
  private readonly outbox: Array<{ chunk: Buffer; callback: (error?: Error | null) => void }> = [];
  private owed = 0;
  private held = 0;

  constructor(private readonly link: Link, readonly id: number) {
    super({ allowHalfOpen: true });
    this.on("finish", () => {
      if (this.ended) this.destroy();
    });
  }

  setTimeout(_ms?: number, callback?: () => void): this {
    if (callback) this.once("timeout", callback);
    return this;
  }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  destroySoon(): void { this.end(); }

  _read(): void {
    const resume = this.waiting;
    this.waiting = null;
    resume?.();
    if (this.held) {
      const bytes = this.held;
      this.held = 0;
      this.grant(bytes);
    }
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.link.flow) {
      this.link.sendData(this.id, chunk, callback);
      return;
    }
    this.outbox.push({ chunk, callback });
    this.pump();
  }

  /** The other side read some: send what waited for room. */
  more(bytes: number): void {
    this.credit += bytes;
    this.pump();
  }

  private pump(): void {
    while (this.outbox.length && this.credit > 0 && this.link.open) {
      const head = this.outbox[0];
      const size = Math.min(this.credit, head.chunk.length, MAX_FRAME);
      const last = size === head.chunk.length;
      this.credit -= size;
      this.link.sendFrame(DATA, this.id, head.chunk.subarray(0, size), last ? head.callback : undefined);
      if (last) this.outbox.shift();
      else head.chunk = head.chunk.subarray(size);
    }
  }

  /** Tell the sender it may send this many more bytes, in steps so small reads don't each cost a frame. */
  private grant(bytes: number): void {
    this.owed += bytes;
    if (this.owed < GRANT_STEP) return;
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(this.owed);
    this.owed = 0;
    this.link.sendFrame(WINDOW, this.id, payload);
  }

  _final(callback: (error?: Error | null) => void): void {
    this.link.sendFrame(END, this.id);
    callback();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.ended || !this.writableFinished) this.link.sendFrame(RESET, this.id);
    this.link.forget(this.id);
    callback(error);
  }

  /** From the link: data for this stream. Returns a resume callback when the reader is full. */
  receive(chunk: Buffer, pause: () => () => void): void {
    if (this.link.flow) {
      // Granted back once the reader has room: what sits in our buffer counts against the sender.
      if (this.push(chunk)) this.grant(chunk.length);
      else this.held += chunk.length;
      return;
    }
    if (!this.push(chunk) && !this.waiting) this.waiting = pause();
  }

  remoteEnd(): void {
    this.ended = true;
    this.push(null);
    if (this.writableFinished) this.destroy();
  }
}

export class Link extends EventEmitter {
  private readonly streams = new Map<number, LinkStream>();
  private nextId: number;
  private buffer: Buffer = Buffer.alloc(0);
  private lastSeen = Date.now();
  private timer: NodeJS.Timeout;
  private pauses = 0;
  private closed = false;
  rtt: number | undefined;
  /** Per-stream credit windows: on once the other side's hello lists "flow". */
  flow = false;
  /** The other side's features, from its hello. */
  features: string[] = [];
  /** The device this link runs through when it is relayed (#910); unset for a direct link. */
  via?: string;

  constructor(readonly socket: tls.TLSSocket, readonly dialer: boolean, readonly device?: string) {
    super();
    this.nextId = dialer ? 1 : 2;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("close", () => this.shut());
    socket.on("error", () => this.shut());
    this.timer = setInterval(() => {
      if (Date.now() - this.lastSeen > DEAD_MS) this.close();
      else this.control({ type: "ping", t: Date.now() });
    }, HEARTBEAT_MS);
    this.timer.unref();
  }

  get open(): boolean {
    return !this.closed;
  }

  control(message: Control): void {
    this.sendFrame(CONTROL, 0, Buffer.from(JSON.stringify(message)));
  }

  /** A new outgoing stream (the caller writes an HTTP request into it, or pipes a local socket). */
  openStream(): LinkStream {
    if (this.closed) throw new Error("The link is closed");
    const id = this.nextId;
    this.nextId += 2;
    const stream = new LinkStream(this, id);
    this.streams.set(id, stream);
    this.sendFrame(OPEN, id);
    return stream;
  }

  /** Measure the round trip now, instead of waiting for the next heartbeat. */
  ping(): void {
    this.control({ type: "ping", t: Date.now() });
  }

  close(): void {
    if (this.closed) return;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.shut();
  }

  sendFrame(type: number, stream: number, payload: Buffer = Buffer.alloc(0), callback?: (error?: Error | null) => void): void {
    if (this.closed) {
      callback?.(new Error("The link is closed"));
      return;
    }
    const head = Buffer.alloc(9);
    head.writeUInt8(type, 0);
    head.writeUInt32BE(stream, 1);
    head.writeUInt32BE(payload.length, 5);
    const ok = this.socket.write(Buffer.concat([head, payload]));
    if (!callback) return;
    if (ok) callback();
    else this.socket.once("drain", () => callback());
  }

  sendData(stream: number, chunk: Buffer, callback: (error?: Error | null) => void): void {
    if (chunk.length <= MAX_FRAME) {
      this.sendFrame(DATA, stream, chunk, callback);
      return;
    }
    for (let i = 0; i < chunk.length; i += MAX_FRAME) {
      const last = i + MAX_FRAME >= chunk.length;
      this.sendFrame(DATA, stream, chunk.subarray(i, i + MAX_FRAME), last ? callback : undefined);
    }
  }

  forget(id: number): void {
    this.streams.delete(id);
  }

  private onData(chunk: Buffer): void {
    this.lastSeen = Date.now();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 9 && !this.closed) {
      const type = this.buffer.readUInt8(0);
      const id = this.buffer.readUInt32BE(1);
      const length = this.buffer.readUInt32BE(5);
      if (length > (type === CONTROL ? MAX_CONTROL : MAX_FRAME)) {
        this.close();
        return;
      }
      if (this.buffer.length < 9 + length) return;
      const payload = this.buffer.subarray(9, 9 + length);
      this.buffer = this.buffer.subarray(9 + length);
      this.onFrame(type, id, payload);
    }
  }

  private onFrame(type: number, id: number, payload: Buffer): void {
    if (type === CONTROL) {
      let message: Control;
      try {
        message = JSON.parse(payload.toString("utf8")) as Control;
      } catch {
        return;
      }
      if (!message || typeof message.type !== "string") return;
      // Before anything else is read: the frames after a hello may already use flow control.
      if ((message.type === "hello" || message.type === "paired" || message.type === "pair") && Array.isArray(message.features)) {
        this.features = message.features.filter((f): f is string => typeof f === "string").slice(0, 32);
        this.flow = this.features.includes("flow");
      }
      if (message.type === "ping") this.control({ type: "pong", t: message.t });
      else if (message.type === "pong" && typeof message.t === "number") {
        this.rtt = Math.max(0, Date.now() - message.t);
        this.emit("rtt", this.rtt);
      } else this.emit("control", message);
      return;
    }
    if (type === OPEN) {
      // The other side opens streams of its own parity only.
      if (id % 2 === (this.dialer ? 1 : 0) || this.streams.has(id) || !this.device) {
        this.sendFrame(RESET, id);
        return;
      }
      const stream = new LinkStream(this, id);
      streamDevices.set(stream, this.device);
      this.streams.set(id, stream);
      this.emit("stream", stream);
      return;
    }
    const stream = this.streams.get(id);
    if (!stream) return;
    if (type === DATA) stream.receive(Buffer.from(payload), () => this.pause());
    else if (type === WINDOW) {
      if (payload.length === 4) stream.more(payload.readUInt32BE(0));
    }
    else if (type === END) stream.remoteEnd();
    else if (type === RESET) {
      this.streams.delete(id);
      stream.destroy();
    }
  }

  private pause(): () => void {
    if (this.pauses++ === 0) this.socket.pause();
    return () => {
      if (--this.pauses === 0) this.socket.resume();
    };
  }

  private shut(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const stream of this.streams.values()) stream.destroy();
    this.streams.clear();
    this.emit("close");
  }
}
