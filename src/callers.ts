import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type express from "express";
import { AGENT_CLIENT, CLIENT_HEADER, LOCAL_TOKEN_HEADER, THREAD_HEADER, THREAD_TOKEN_HEADER, dataDir } from "./config.js";
import { isContentHost } from "./contentOrigin.js";
import { peerDeviceOf } from "./devices/link.js";
import { REMOTE_AGENT_HEADER, decodeRemoteAgent, remoteThreadId, type RemoteAgent } from "./devices/agentAccess.js";
import type { Viewer } from "./types.js";

/**
 * Who is calling the daemon (#682). A chat's MCP proves its thread with a token the daemon gave it
 * (SCRIBE_THREAD_TOKEN), so a thread id alone is worth nothing. The board UI is a browser on the
 * board's origin (contentOriginGate refuses other origins' writes). The data folder's local-token
 * file makes a local tool an external MCP client (one with no Scribe chat: Open pages, untrusted),
 * and the user only on the device CLI's routes (#916). Anything else is an anonymous agent: no pages,
 * and none of the board's own routes. So leaving the token out never reaches more than sending it.
 * A local tool that should act as the user on other routes sends what the board UI sends
 * (Sec-Fetch-Site: same-origin, Origin: the board's): the board port is one a sandbox never opens (#915).
 *
 * This stops callers that leave the agent header out or forge a thread id. A process with the user's
 * file access can still read the token files, or scribe.sqlite itself; that is outside what HTTP can stop.
 *
 * A request that came over a paired device's peer link (#904) is that device's user: { viewer: "user",
 * device }. Its socket is the link's stream, which only a pinned key can open, so no header can claim it
 * and the browser rule below (`sec-fetch-site`) never applies to it. One that carries the remote-agent
 * header is that device's chat instead (#911): { viewer: "agent", thread: "@device/thread", device, remote }.
 *
 * Scribe chats' MCP calls on the agent port (AGENT_PORT, #915), which a sandbox lets through instead of the
 * board's. Every caller there is an agent: a thread with its token, else anonymous. No browser rule, page
 * origin or local token applies, so a sandboxed shell that reaches it is never the user.
 */
export type Caller = { viewer: Viewer; thread?: string; external?: true; device?: string; remote?: RemoteAgent };

const known = new WeakMap<express.Request, Caller>();

export function identify(req: express.Request): Caller {
  let caller = known.get(req);
  if (!caller) {
    caller = decide(req);
    known.set(req, caller);
  }
  return caller;
}

const agentSockets = new WeakSet<object>();

/** A connection to the agent port (AGENT_PORT): http.ts marks each one as it comes in. */
export function markAgentSocket(socket: object): void {
  agentSockets.add(socket);
}

export function onAgentPort(socket: object | undefined): boolean {
  return Boolean(socket) && agentSockets.has(socket!);
}

/**
 * The agent port serves the MCP's /api calls on the plain loopback host, nothing else: no page origins, no
 * gateway hosts (#905), no board UI.
 */
export function agentPortGate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!onAgentPort(req.socket)) {
    next();
    return;
  }
  if ((req.hostname === "127.0.0.1" || req.hostname === "localhost") && req.path.startsWith("/api/")) next();
  else res.status(404).type("text").send("This port only serves Scribe chats' MCP.");
}

function decide(req: express.Request): Caller {
  const device = peerDeviceOf(req.socket);
  if (device) {
    // A chat on that device, sent on by its daemon (#911): an agent here, held to this device's grant.
    const remote = decodeRemoteAgent(req.get(REMOTE_AGENT_HEADER));
    return remote ? { viewer: "agent", thread: remoteThreadId(device, remote.thread), device, remote } : { viewer: "user", device };
  }
  const thread = req.get(THREAD_HEADER)?.slice(0, 60);
  const token = req.get(THREAD_TOKEN_HEADER);
  const chat = thread && token && sameToken(token, threadToken(thread)) ? thread : undefined;
  if (onAgentPort(req.socket)) return chat ? { viewer: "agent", thread: chat } : { viewer: "agent" };
  // A page's own script on its own origin; what it may reach is the page's (frameReach).
  if (isContentHost(req)) return { viewer: "user" };
  if (chat) return { viewer: "agent", thread: chat };
  const agent = req.get(CLIENT_HEADER) === AGENT_CLIENT;
  // The token makes a local tool the user only for the device CLI (#916); anywhere else it is an external client.
  if (hasLocalToken(req.get(LOCAL_TOKEN_HEADER))) return !agent && devicesRoute(req) ? { viewer: "user" } : { viewer: "agent", external: true };
  if (agent) return { viewer: "agent" };
  // Browsers mark every request; a cross-origin write never got this far.
  if (req.get("sec-fetch-site")) return { viewer: "user" };
  return { viewer: "agent" };
}

/** The `scribe` CLI's device commands (pair, devices, add-device): the routes a bare local token reaches as the user. */
function devicesRoute(req: express.Request): boolean {
  const pathname = req.originalUrl.split("?")[0];
  return pathname === "/api/devices" || pathname.startsWith("/api/devices/");
}

/** Whether a WebSocket upgrade may join the board: the board UI (its own origin) or a paired device's link. */
export function socketAllowed(headers: { origin?: string; host?: string; [name: string]: unknown }, socket?: object): boolean {
  if (peerDeviceOf(socket)) return true;
  if (onAgentPort(socket)) return false;
  const origin = headers.origin;
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.host === headers.host && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

/** The token a chat's MCP sends with its thread id. Derived, so the daemon keeps nothing per thread and a restart keeps chats working. */
export function threadToken(thread: string): string {
  return createHmac("sha256", secret("agent-secret")).update(`thread:${thread}`).digest("hex");
}

function hasLocalToken(value: string | undefined): boolean {
  return Boolean(value) && sameToken(value!, secret("local-token").toString("hex"));
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const secrets = new Map<string, Buffer>();

/** A random secret kept in the data folder, made on first use. */
function secret(name: string): Buffer {
  const cached = secrets.get(name);
  if (cached) return cached;
  const file = path.join(dataDir(), name);
  let value: Buffer | undefined;
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(text)) value = Buffer.from(text, "hex");
  } catch {
    /* first use */
  }
  if (!value) {
    value = randomBytes(32);
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(file, value.toString("hex"), { mode: 0o600 });
  }
  secrets.set(name, value);
  return value;
}

/** Make both secrets at startup, so local tools find the local token before anything asked for it. */
export function prepareSecrets(): void {
  secret("agent-secret");
  secret("local-token");
}
