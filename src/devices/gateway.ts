import http from "node:http";
import type net from "node:net";
import type { Duplex } from "node:stream";
import type express from "express";
import { identify } from "../callers.js";
import { CONTENT_HOST, PAGE_HOST_SUFFIX, gatewayHost } from "../config.js";
import { requestPort, sharedFile } from "../contentOrigin.js";
import { isEmbedLabel, type EmbedProxy } from "./embedProxy.js";
import { peerDeviceOf } from "./link.js";
import type { PeerService } from "./peers.js";

/**
 * The peer gateway (#905): this daemon serves another device's own UI on d-<device>.localhost, and its
 * pages on <label>.d-<device>.localhost, by forwarding HTTP and WebSocket upgrades over the peer link.
 * The remote daemon answers as it answers its own UI, building its URLs with the .d-<device>.localhost
 * suffix it reads from the forwarded Host. It trusts the link's device, not these headers, so the
 * checks here only keep other local callers (agents, websites, other origins) off the link.
 *
 * Only the person at this device's browser may go through: agents get no access to other devices yet.
 * When the other device runs the same Scribe VERSION, its UI files come from this device's own public/
 * folder and never cross the link; content-hashed (?v=) files from another version are cached here.
 */

/** Headers that only mean something to this daemon, or to one hop. */
const DROP = new Set([
  "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer",
  "x-scribe-local-token", "x-scribe-token", "x-scribe-thread", "x-scribe-client", "x-scribe-session", "x-scribe-agent",
  "x-scribe-device", "x-scribe-remote-agent",
]);

const CACHE_MAX_BYTES = 32 * 1024 * 1024;

type Cached = { status: number; headers: http.OutgoingHttpHeaders; body: Buffer };

export type Gateway = {
  /** Express middleware, first in line: takes gateway hosts and passes everything else on. */
  http: express.RequestHandler;
  /** Takes a WebSocket upgrade on a gateway host. False when it is not one. */
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean;
};

export function peerGateway(peers: PeerService, options: {
  version: string;
  port: number;
  local: express.RequestHandler;
  /** This device's /api/devices routes, which answer on the gateway hosts too (#906). */
  devices?: express.RequestHandler;
  /** This device's embeds as another device shows them (#917): eh-/es- hosts that came over the link. */
  embeds?: EmbedProxy;
  /** Another device's hosts that came over a link: a mirror held here, shown read only (#910). */
  mirror?: (req: express.Request, res: express.Response, gateway: { device: string; label?: string }) => void;
}): Gateway {
  const cache = new Map<string, Cached>();
  let cacheBytes = 0;

  function remember(key: string, entry: Cached): void {
    if (entry.body.length > CACHE_MAX_BYTES / 8) return;
    // Oldest first: a Map keeps insertion order.
    while (cacheBytes + entry.body.length > CACHE_MAX_BYTES && cache.size) {
      const [oldest, value] = cache.entries().next().value!;
      cache.delete(oldest);
      cacheBytes -= value.body.length;
    }
    cache.set(key, entry);
    cacheBytes += entry.body.length;
  }

  /** The host this device's own UI uses for the same thing, for d-<this device> (the way back). */
  function selfHost(label: string | undefined): string {
    if (!label) return "127.0.0.1";
    return label === "c" ? CONTENT_HOST : `${label}${PAGE_HOST_SUFFIX}`;
  }

  /** Whether an Origin is one of the same device's gateway origins on this port. */
  function sameDeviceOrigin(origin: string, device: string): boolean {
    try {
      const url = new URL(origin);
      return url.protocol === "http:" && url.port === String(options.port) && gatewayHost(url.hostname)?.device === device;
    } catch {
      return false;
    }
  }

  function offline(res: express.Response, device: string, embed = false): void {
    const name = peers.nameOf(device);
    const text = name ? `${name} is not connected right now.` : "No paired device has that id.";
    if (embed) {
      // An embed frame in that device's UI (#917): the board around it already leads back.
      res.status(name ? 502 : 404).set("Cache-Control", "no-store").type("html")
        .send(`<!doctype html><meta charset="utf-8"><title>Embed</title><body style="font:14px system-ui;background:#1a1a1d;color:#e8e8ea;padding:40px"><p>${escapeHtml(text)} This embed runs there.</p></body>`);
      return;
    }
    res.status(name ? 502 : 404).set("Cache-Control", "no-store").type("html")
      .send(`<!doctype html><meta charset="utf-8"><title>Scribe</title><body style="font:14px system-ui;background:#1a1a1d;color:#e8e8ea;padding:40px"><p>${escapeHtml(text)}</p><p><a style="color:#c9c9d0" href="http://127.0.0.1:${options.port}/">Back to this device</a></p></body>`);
  }

  function forward(req: express.Request, res: express.Response, device: string, cacheKey?: string): void {
    let link = peers.linkTo(device);
    // Offline: the device that keeps its mirror answers instead, read only (#910). Not for embeds, which run on the owner.
    if (!link?.open && !isEmbedLabel(gatewayHost(req.hostname)?.label)) {
      const mirror = peers.mirrorOf(device);
      if (mirror) {
        link = peers.linkTo(mirror.holder);
        cacheKey = undefined;
      }
    }
    if (!link?.open) {
      offline(res, device, isEmbedLabel(gatewayHost(req.hostname)?.label));
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) if (!DROP.has(name) && value !== undefined) headers[name] = value;
    const proxied = http.request({
      method: req.method,
      path: req.originalUrl,
      headers,
      createConnection: () => link.openStream() as unknown as net.Socket,
    }, (remote) => {
      const out: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(remote.headers)) if (!DROP.has(name) && value !== undefined) out[name] = value;
      const status = remote.statusCode ?? 502;
      res.writeHead(status, out);
      const keep = cacheKey && status === 200 && /\bimmutable\b/.test(String(remote.headers["cache-control"] ?? ""));
      if (!keep) {
        remote.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      remote.on("data", (chunk: Buffer) => { chunks.push(chunk); res.write(chunk); });
      remote.on("end", () => {
        remember(cacheKey!, { status, headers: out, body: Buffer.concat(chunks) });
        res.end();
      });
    });
    proxied.on("error", () => {
      if (!res.headersSent) offline(res, device, isEmbedLabel(gatewayHost(req.hostname)?.label));
      else res.destroy();
    });
    res.on("close", () => { if (!res.writableFinished) proxied.destroy(); });
    req.pipe(proxied);
  }

  const handler: express.RequestHandler = (req, res, next) => {
    const gateway = gatewayHost(req.hostname);
    if (gateway && options.embeds && isEmbedLabel(gateway.label) && peerDeviceOf(req.socket)) {
      options.embeds.http(req, res, gateway.label!);
      return;
    }
    // Another device's host over a link: its mirror, if this device keeps one (#910).
    if (gateway && options.mirror && gateway.device !== peers.identity.id && peerDeviceOf(req.socket)) {
      options.mirror(req, res, gateway);
      return;
    }
    // Over a link these hosts are this daemon's own UI as the other device shows it (contentOriginGate).
    if (!gateway || peerDeviceOf(req.socket)) {
      next();
      return;
    }
    if (gateway.device === peers.identity.id) {
      // This device, named through its own gateway (a link from another device's UI): go home.
      res.redirect(302, `http://${selfHost(gateway.label)}:${options.port}${req.originalUrl}`);
      return;
    }
    // A browser on this device, and not a script on another origin than this device's views.
    const origin = req.get("origin");
    if (identify(req).viewer !== "user" || !req.get("sec-fetch-site") || (origin && origin !== "null" && !sameDeviceOrigin(origin, gateway.device))) {
      res.status(403).type("text").send("Only this device's browser may open another device.");
      return;
    }
    if (requestPort(req) !== String(options.port)) {
      res.status(403).type("text").send("Unknown host.");
      return;
    }
    // The device list is this device's, in every view (#906): the space selector lists every device, and
    // the way back home, from here. The routes see which device's UI asked.
    if (gateway.label === undefined && options.devices && (req.path === "/api/devices" || req.path.startsWith("/api/devices/"))) {
      res.locals.gatewayDevice = gateway.device;
      options.devices(req, res, () => res.status(404).json({ error: "Not found" }));
      return;
    }
    const read = req.method === "GET" || req.method === "HEAD";
    // The UI's own files: the board's static files, and the shared files every page origin loads.
    const uiFile = read && !isEmbedLabel(gateway.label) && (gateway.label === undefined || sharedFile(req)) && !req.path.startsWith("/api/") && !req.path.startsWith("/view/") && !req.path.startsWith("/blob/");
    if (uiFile && peers.versionOf(gateway.device) === options.version) {
      options.local(req, res, () => forward(req, res, gateway.device));
      return;
    }
    const cacheKey = uiFile && typeof req.query.v === "string" ? `${gateway.device}|${peers.versionOf(gateway.device)}|${req.originalUrl}` : undefined;
    const hit = cacheKey && req.method === "GET" ? cache.get(cacheKey) : undefined;
    if (hit) {
      res.writeHead(hit.status, hit.headers).end(hit.body);
      return;
    }
    forward(req, res, gateway.device, cacheKey);
  };

  function upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const host = req.headers.host ?? "";
    const gateway = gatewayHost(host.replace(/:\d+$/, ""));
    if (gateway && options.embeds && isEmbedLabel(gateway.label) && peerDeviceOf(req.socket)) {
      options.embeds.upgrade(req, socket, head, gateway.label!);
      return true;
    }
    if (!gateway || peerDeviceOf(req.socket)) return false;
    const refuse = (status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      return true;
    };
    // Only a page of the same device's view opens a socket through the gateway (the board's /ws, audio).
    const origin = req.headers.origin;
    if (gateway.device === peers.identity.id || !origin || !sameDeviceOrigin(origin, gateway.device) || !host.endsWith(`:${options.port}`)) return refuse("403 Forbidden");
    const link = peers.linkTo(gateway.device);
    if (!link?.open) return refuse("502 Bad Gateway");
    const stream = link.openStream();
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const lower = name.toLowerCase();
      if (lower !== "connection" && lower !== "upgrade" && DROP.has(lower)) continue;
      lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    stream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) stream.write(head);
    socket.pipe(stream).pipe(socket);
    const close = () => { socket.destroy(); stream.destroy(); };
    socket.on("error", close);
    stream.on("error", close);
    socket.on("close", () => stream.destroy());
    stream.on("close", () => socket.destroy());
    return true;
  }

  return { http: handler, upgrade };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}
