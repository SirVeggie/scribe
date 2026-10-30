import { EventEmitter } from "node:events";
import http from "node:http";
import type net from "node:net";
import type express from "express";
import type { PeerService } from "./peers.js";

/**
 * "Needs you" across devices (#906): each daemon lists its own chats that wait on the user (an
 * approval, a question, a plan) at /api/devices/asks, as a server-sent event stream. The local daemon
 * keeps one such stream open to every online paired device, so the board can show their asks as
 * toasts on whichever device the user is at.
 */

export type Ask = { thread: string; title: string; kind: "approval" | "question" | "plan"; text: string; detail?: string };
export type DeviceAsk = Ask & { device: string; name: string };

type ThreadLike = { id: string; title: string; status: string; helperOf?: string; asking?: { kind: string; title?: string; detail?: string } };

/** The chats on this device that wait on the user. Usage limits are not asks: nothing to answer remotely. */
export function asksOf(threads: ThreadLike[]): Ask[] {
  const out: Ask[] = [];
  for (const t of threads) {
    const kind = t.asking?.kind;
    if (t.status !== "waiting" || (kind !== "approval" && kind !== "question" && kind !== "plan")) continue;
    out.push({ thread: t.id, title: t.title, kind, text: (t.asking!.title || "").slice(0, 300), ...(t.asking!.detail ? { detail: t.asking!.detail.slice(0, 300) } : {}) });
  }
  return out;
}

/** Writes an SSE stream of a value, sending it again whenever it changes. */
export function sseStream(req: express.Request, res: express.Response, value: () => unknown, source: EventEmitter): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  let last = "";
  const push = () => {
    const json = JSON.stringify(value());
    if (json === last) return;
    last = json;
    res.write(`data: ${json}\n\n`);
  };
  push();
  // A comment now and then keeps proxies and the link from treating the stream as idle.
  const keep = setInterval(() => res.write(": keep\n\n"), 25_000);
  keep.unref?.();
  source.on("change", push);
  req.on("close", () => {
    clearInterval(keep);
    source.off("change", push);
  });
}

/** This device's own asks, changing as its chats start and stop waiting. */
export class AskSource extends EventEmitter {
  private current: Ask[] = [];
  private signature = "[]";
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly threads: () => ThreadLike[]) {
    super();
    this.setMaxListeners(0);
  }

  get asks(): Ask[] {
    return this.current;
  }

  /** A thread changed: look again shortly (thread updates come in bursts). */
  touch(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const next = asksOf(this.threads());
      const signature = JSON.stringify(next);
      if (signature === this.signature) return;
      this.current = next;
      this.signature = signature;
      this.emit("change");
    }, 200);
    this.timer.unref?.();
  }

  refresh(): void {
    this.current = asksOf(this.threads());
    this.signature = JSON.stringify(this.current);
  }
}

/** One /api/devices/asks stream per online paired device. */
export class AskWatcher extends EventEmitter {
  private readonly remote = new Map<string, Ask[]>();
  private readonly streams = new Map<string, http.ClientRequest>();
  /** Devices whose Scribe has no asks stream (an older version), until their link comes back. */
  private readonly unsupported = new Set<string>();
  private stopped = false;

  constructor(private readonly peers: PeerService) {
    super();
    this.setMaxListeners(0);
    peers.on("change", () => this.sync());
    this.sync();
  }

  /** Every paired device's asks but the one named (the device whose own UI is showing them already). */
  asks(except?: string): DeviceAsk[] {
    const out: DeviceAsk[] = [];
    for (const [device, asks] of this.remote) {
      if (device === except) continue;
      const name = this.peers.nameOf(device) ?? "Device";
      for (const ask of asks) out.push({ ...ask, device, name });
    }
    return out;
  }

  stop(): void {
    this.stopped = true;
    for (const req of this.streams.values()) req.destroy();
    this.streams.clear();
  }

  private sync(): void {
    if (this.stopped) return;
    const online = new Set(this.peers.view().peers.filter((peer) => peer.online).map((peer) => peer.id));
    for (const [device, req] of this.streams) {
      if (!online.has(device)) {
        this.streams.delete(device);
        req.destroy();
      }
    }
    for (const device of [...this.remote.keys()]) if (!online.has(device) && !this.streams.has(device)) this.drop(device);
    for (const device of this.unsupported) if (!online.has(device)) this.unsupported.delete(device);
    for (const device of online) if (!this.streams.has(device) && !this.unsupported.has(device)) this.open(device);
  }

  private drop(device: string): void {
    if (this.remote.delete(device)) this.emit("change");
  }

  private open(device: string): void {
    const link = this.peers.linkTo(device);
    if (!link?.open) return;
    const req = http.request({
      method: "GET",
      path: "/api/devices/asks",
      headers: { host: "127.0.0.1", accept: "text/event-stream" },
      createConnection: () => link.openStream() as unknown as net.Socket,
    }, (res) => {
      if (res.statusCode !== 200) {
        // An older Scribe on the other side: no asks from it, and no retrying until its link comes back.
        this.unsupported.add(device);
        res.resume();
        return;
      }
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (!data) continue;
          try {
            const parsed = JSON.parse(data) as { asks?: Ask[] };
            this.remote.set(device, Array.isArray(parsed.asks) ? parsed.asks : []);
            this.emit("change");
          } catch {
            /* a broken frame: wait for the next one */
          }
        }
      });
      res.on("close", () => this.closed(device, req));
    });
    req.on("error", () => this.closed(device, req));
    req.end();
    this.streams.set(device, req);
  }

  private closed(device: string, req: http.ClientRequest): void {
    if (this.streams.get(device) !== req) return;
    this.streams.delete(device);
    this.drop(device);
    // Still linked (the stream alone broke): try again in a while; a new link syncs at once.
    const retry = setTimeout(() => this.sync(), 10_000);
    retry.unref?.();
  }
}
