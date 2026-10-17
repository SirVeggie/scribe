import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type express from "express";
import { AGENT_CLIENT, CLIENT_HEADER, LOCAL_TOKEN_HEADER, THREAD_HEADER, THREAD_TOKEN_HEADER, dataDir } from "./config.js";
import { isContentHost } from "./contentOrigin.js";
import type { Viewer } from "./types.js";

/**
 * Who is calling the daemon (#682). A chat's MCP proves its thread with a token the daemon gave it
 * (SCRIBE_THREAD_TOKEN), so a thread id alone is worth nothing. The board UI is a browser on the
 * board's origin (contentOriginGate refuses other origins' writes). The data folder's local-token
 * file makes a local tool the user, or with the agent header an external MCP client (one with no
 * Scribe chat: Open pages, untrusted). Anything else is an anonymous agent: no pages, and none of
 * the board's own routes. So leaving the token out never reaches more than sending it.
 *
 * This stops callers that leave the agent header out or forge a thread id. A process with the user's
 * file access can still read the token files, or scribe.sqlite itself; that is outside what HTTP can stop.
 */
export type Caller = { viewer: Viewer; thread?: string; external?: true };

const known = new WeakMap<express.Request, Caller>();

export function identify(req: express.Request): Caller {
  let caller = known.get(req);
  if (!caller) {
    caller = decide(req);
    known.set(req, caller);
  }
  return caller;
}

function decide(req: express.Request): Caller {
  // A page's own script on its own origin; what it may reach is the page's (frameReach).
  if (isContentHost(req)) return { viewer: "user" };
  const thread = req.get(THREAD_HEADER)?.slice(0, 60);
  const token = req.get(THREAD_TOKEN_HEADER);
  if (thread && token && sameToken(token, threadToken(thread))) return { viewer: "agent", thread };
  const agent = req.get(CLIENT_HEADER) === AGENT_CLIENT;
  if (hasLocalToken(req.get(LOCAL_TOKEN_HEADER))) return agent ? { viewer: "agent", external: true } : { viewer: "user" };
  if (agent) return { viewer: "agent" };
  // Browsers mark every request; a cross-origin write never got this far.
  if (req.get("sec-fetch-site")) return { viewer: "user" };
  return { viewer: "agent" };
}

/** Whether a WebSocket upgrade may join the board: the board UI (its own origin) or a local tool with the token. */
export function socketAllowed(headers: { origin?: string; host?: string; [name: string]: unknown }): boolean {
  const origin = headers.origin;
  if (!origin) {
    const token = headers[LOCAL_TOKEN_HEADER];
    return typeof token === "string" && hasLocalToken(token);
  }
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
