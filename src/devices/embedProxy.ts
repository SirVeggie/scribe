import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type express from "express";

/**
 * Embeds of another device (#917). An embed page shows its site by pointing the tab frame at the URL,
 * so in another device's UI http://127.0.0.1:8188 would be the viewing device's own loopback. The UI
 * (public/app.js, embedProxyUrl) sends private targets to eh-<base32 of host:port>.d-<device>.localhost
 * instead (es- for https): one origin per target, like t- pages. The viewing device's gateway forwards
 * that host over the link like any other, and the device that owns the page proxies it to the target
 * here, rewriting Host, redirects and cookies, and dropping framing headers.
 *
 * Only link callers reach this (gateway.ts), only private targets qualify, and only the origins that one
 * of this device's embed pages names, so a site open in the viewing browser can't use it to reach this
 * device's network.
 */

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const LABEL = /^e([hs])-([a-z2-7]{1,60})$/;
/** Hop-by-hop headers, and Scribe's own. */
const HOP = new Set([
  "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer",
  "x-scribe-local-token", "x-scribe-token", "x-scribe-thread", "x-scribe-client", "x-scribe-session", "x-scribe-agent",
]);

export function isEmbedLabel(label: string | undefined): boolean {
  return Boolean(label && LABEL.test(label));
}

/** The host label for a target origin, or undefined when it is not a private http(s) one or too long for a label. */
export function embedLabel(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !isPrivateHost(url.hostname)) return undefined;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const bytes = Buffer.from(`${url.hostname}:${port}`, "utf8");
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += B32[(value << (5 - bits)) & 31];
  return out.length <= 60 ? `e${url.protocol === "https:" ? "s" : "h"}-${out}` : undefined;
}

/** The target origin a label names (http://127.0.0.1:8188), or undefined. */
export function embedTarget(label: string | undefined): URL | undefined {
  const match = LABEL.exec(label ?? "");
  if (!match) return undefined;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of match[2]) {
    value = ((value << 5) | B32.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  try {
    const url = new URL(`${match[1] === "s" ? "https" : "http"}://${Buffer.from(bytes).toString("utf8")}`);
    return isPrivateHost(url.hostname) && url.pathname === "/" && !url.search && !url.username ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Loopback, LAN, tailnet and link-local addresses, and names that only resolve on a local network:
 * what the device that owns a page can reach and the viewing device may not.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (net.isIPv4(host)) {
    const [p, q] = host.split(".").map(Number);
    return p === 127 || p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254);
  }
  if (net.isIPv6(host)) {
    return host === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  }
  if (!host || /[^a-z0-9.-]/.test(host)) return false;
  return !host.includes(".") || /(?:^|\.)localhost$|\.(?:local|lan|home\.arpa|internal)$/.test(host);
}

export type EmbedProxy = {
  http(req: express.Request, res: express.Response, label: string): void;
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, label: string): void;
};

export function embedProxy(options: {
  /** Whether one of this device's embed pages names this origin. */
  allowed(origin: string): boolean;
  /** This daemon's own ports (the board and the peer link), never a target. */
  ports: number[];
  /** This device's name, for the placeholder pages. */
  name(): string;
}): EmbedProxy {
  /** The target for a label, or why it is refused. */
  function resolve(label: string): { target: URL } | { refused: string } {
    const target = embedTarget(label);
    if (!target) return { refused: "This address is not one Scribe forwards to another device." };
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    if (options.ports.includes(port) && isLoopback(target.hostname)) return { refused: "This address is Scribe itself." };
    if (!options.allowed(target.origin)) return { refused: `No embed page on ${options.name()} shows ${target.host}, so Scribe does not forward it.` };
    return { target };
  }

  function placeholder(res: express.Response, status: number, text: string, target?: URL): void {
    res.status(status).set("Cache-Control", "no-store").type("html")
      .send(`<!doctype html><meta charset="utf-8"><title>Embed</title><body style="font:14px system-ui;background:#1a1a1d;color:#e8e8ea;padding:40px;line-height:1.5"><p>${escapeHtml(text)}</p>${target ? `<p style="color:#8e8e96">Open <code>${escapeHtml(target.href)}</code> on ${escapeHtml(options.name())} to use it there.</p>` : ""}</body>`);
  }

  function requestHeaders(headers: http.IncomingHttpHeaders, target: URL, embedOrigin: string): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) if (!HOP.has(name) && value !== undefined) out[name] = value;
    // Dev servers check Host (Vite's allowedHosts, webpack's host check) and some check Origin.
    out.host = target.host;
    if (out.origin === embedOrigin) out.origin = target.origin;
    if (typeof out.referer === "string" && out.referer.startsWith(`${embedOrigin}/`)) out.referer = target.origin + out.referer.slice(embedOrigin.length);
    return out;
  }

  function http_(req: express.Request, res: express.Response, label: string): void {
    const found = resolve(label);
    if ("refused" in found) {
      placeholder(res, 403, found.refused);
      return;
    }
    const { target } = found;
    const embedOrigin = `http://${req.headers.host}`;
    const secure = target.protocol === "https:";
    const proxied = (secure ? https : http).request({
      host: target.hostname.replace(/^\[|\]$/g, ""),
      port: target.port || (secure ? 443 : 80),
      method: req.method,
      path: req.originalUrl,
      headers: requestHeaders(req.headers, target, embedOrigin),
      // A private target: a dev server's self-signed certificate is the usual case.
      ...(secure ? { rejectUnauthorized: false, servername: net.isIP(target.hostname) ? undefined : target.hostname } : {}),
    }, (remote) => {
      res.writeHead(remote.statusCode ?? 502, responseHeaders(remote.headers, target, embedOrigin));
      remote.pipe(res);
    });
    proxied.on("error", () => {
      if (!res.headersSent) placeholder(res, 502, `Nothing answers at ${target.host} on ${options.name()}.`, target);
      else res.destroy();
    });
    res.on("close", () => { if (!res.writableFinished) proxied.destroy(); });
    req.pipe(proxied);
  }

  function upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, label: string): void {
    const found = resolve(label);
    if ("refused" in found) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const { target } = found;
    const headers = requestHeaders(req.headers, target, `http://${req.headers.host}`);
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    const upstream = target.protocol === "https:"
      ? tls.connect({ host, port, rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host })
      : net.connect({ host, port });
    const lines = [`${req.method} ${req.url} HTTP/1.1`, "Connection: Upgrade", `Upgrade: ${req.headers.upgrade ?? "websocket"}`];
    for (const [name, value] of Object.entries(headers)) {
      for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
    const close = () => { socket.destroy(); upstream.destroy(); };
    socket.on("error", close);
    upstream.on("error", close);
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  }

  return { http: http_, upgrade };
}

/** Redirects back to the embed origin, cookies without a Domain, and no framing headers (#917: the board frames it). */
function responseHeaders(headers: http.IncomingHttpHeaders, target: URL, embedOrigin: string): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP.has(name) || value === undefined || name === "x-frame-options") continue;
    out[name] = value;
  }
  const location = out.location;
  if (typeof location === "string" && (location === target.origin || location.startsWith(`${target.origin}/`))) {
    out.location = embedOrigin + location.slice(target.origin.length);
  }
  if (Array.isArray(out["set-cookie"])) {
    out["set-cookie"] = out["set-cookie"].map((cookie) => cookie.replace(/;\s*domain=[^;]*/gi, ""));
  }
  const csp = out["content-security-policy"];
  if (csp !== undefined) {
    const kept = String(csp).split(",").map((policy) => policy.split(";").filter((part) => !/^\s*frame-ancestors\b/i.test(part)).join(";").trim()).filter((policy) => policy && policy !== ";");
    if (kept.length) out["content-security-policy"] = kept.join(", ");
    else delete out["content-security-policy"];
  }
  return out;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "::1" || host.startsWith("127.") || host === "localhost" || host.endsWith(".localhost");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}
