import type http from "node:http";
import { CONTENT_HOST, PAGE_HOST_SUFFIX, gatewayHost } from "./config.js";
import { peerDeviceOf } from "./devices/link.js";

/**
 * Web access (#913): a browser anywhere opens Scribe at https://<base> (this device's board) and
 * https://d-<device>.<base> (another device's), behind a Google sign-in. Free wildcard certificates cover
 * one label, so the page origins are flattened: <label>.<base> here, <label>--<device>.<base> on another
 * device. The web listener (src/devices/web.ts) rewrites each request to the host this daemon already
 * knows (<label>.localhost, <label>.d-<device>.localhost) and marks it here; everything that builds a URL
 * for the browser asks webBaseOf and maps the host back with webHostOf.
 *
 * Another device learns that a request came from the web from WEB_HEADER, which only the device that
 * forwarded it over the peer link can set (the gateway drops it from everything else).
 */
export const WEB_HEADER = "x-scribe-web";

const BASE = /^(?=.{1,200}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A domain the web may use: lower-case labels, at least two, no port. */
export function validWebBase(value: unknown): value is string {
  return typeof value === "string" && BASE.test(value) && !value.endsWith(".localhost") && !/^\d+(\.\d+){3}$/.test(value);
}

const marked = new WeakMap<object, string>();
const webSockets = new WeakSet<object>();

/** A connection to the web listener: every request on it is a stranger until its session says otherwise. */
export function markWebSocket(socket: object): void {
  webSockets.add(socket);
}

export function onWebPort(socket: object | undefined | null): boolean {
  return Boolean(socket) && webSockets.has(socket!);
}

/** A web request whose session checked out, on the base domain it came in on. */
export function markWebRequest(req: http.IncomingMessage, base: string): void {
  marked.set(req, base);
  marked.set(req.headers, base);
}

/** Whether a signed-in web request is this one (or carries these headers). */
export function signedInWeb(req: object): boolean {
  return marked.has(req);
}

/**
 * The web domain the request's browser uses, or undefined for a browser on a loopback name: a request
 * this device's web listener let in, or one another device forwarded over the link from its web listener.
 */
export function webBaseOf(req: { socket?: object | null; headers: http.IncomingHttpHeaders }): string | undefined {
  const own = marked.get(req) ?? marked.get(req.headers);
  if (own) return own;
  if (!peerDeviceOf(req.socket)) return undefined;
  const value = req.headers[WEB_HEADER];
  return validWebBase(value) ? value : undefined;
}

/** A web host as the daemon knows it: undefined device is the one the listener runs on. */
export type WebHost = { device?: string; label?: string };

/** Which board or page origin a host on the web domain names, or undefined when it is none. */
export function parseWebHost(hostname: string, base: string): WebHost | undefined {
  const host = hostname.toLowerCase();
  if (host === base) return {};
  if (!host.endsWith(`.${base}`)) return undefined;
  const sub = host.slice(0, -base.length - 1);
  if (!/^[a-z0-9-]{1,63}$/.test(sub)) return undefined;
  const device = /^d-([0-9a-f]{12})$/.exec(sub);
  if (device) return { device: device[1] };
  const remote = /^([a-z0-9-]+?)--([0-9a-f]{12})$/.exec(sub);
  if (remote) return { device: remote[2], label: remote[1] };
  return { label: sub };
}

/** The loopback host name the daemon uses for a web host (no port). */
export function internalHostname(web: WebHost, self: string): string {
  if (!web.device || web.device === self) {
    if (!web.label) return "127.0.0.1";
    return web.label === "c" ? CONTENT_HOST : `${web.label}${PAGE_HOST_SUFFIX}`;
  }
  return web.label ? `${web.label}.d-${web.device}${PAGE_HOST_SUFFIX}` : `d-${web.device}${PAGE_HOST_SUFFIX}`;
}

/** The web name of a host the daemon builds a URL for (127.0.0.1, t-ab.localhost, t-ab.d-<device>.localhost). */
export function webHostOf(hostname: string, base: string): string {
  const host = hostname.toLowerCase().replace(/:\d+$/, "");
  if (host === "127.0.0.1" || host === "localhost") return base;
  if (host === CONTENT_HOST) return `c.${base}`;
  const gateway = gatewayHost(host);
  if (gateway) return gateway.label ? `${gateway.label}--${gateway.device}.${base}` : `d-${gateway.device}.${base}`;
  if (host.endsWith(PAGE_HOST_SUFFIX)) return `${host.slice(0, -PAGE_HOST_SUFFIX.length)}.${base}`;
  return host;
}
