import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { internalHostname, markWebRequest, parseWebHost, validWebBase, type WebHost } from "../webRequest.js";

/**
 * Web access (#913): this device (an always-on server, behind a TLS proxy such as Caddy) serves Scribe
 * to a browser anywhere, after a Google sign-in. The listener here is plain HTTP on loopback; the proxy
 * terminates HTTPS for <base> and *.<base> and passes the Host on.
 *
 * - Sign-in: Google's "Sign in with Google" button hands the page an ID token; this checks its signature
 *   against Google's keys, the audience (the OAuth client id set here), the issuer, expiry and a verified
 *   email on the allowed list. An account's Google subject is pinned on its first sign-in.
 * - Session: a random token in a cookie for <base> and every subdomain (HttpOnly, Secure, SameSite=Lax),
 *   kept here only as its hash, for 30 days after it was last used.
 * - A signed-in request gets the Host (and Origin) this daemon already serves on loopback, is marked as
 *   a web request (callers.ts makes it the user, contentOrigin.ts builds web URLs) and goes to the app.
 *   A host on another device goes through the peer gateway (#905), like a browser on this device.
 * - Settings change only from this device or a paired device, never from a web session, so a stolen
 *   session can neither lock you out nor add an account.
 */

export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_MS = 60 * 60 * 1000;
export const SESSION_COOKIE = "__Secure-scribe";
const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLIENT_ID = /^[\w.-]{1,200}\.apps\.googleusercontent\.com$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

export type WebAccount = { email: string; sub?: string };
type Session = { hash: string; email: string; sub: string; createdAt: number; seenAt: number; agent: string };
type Saved = { host?: string; clientId?: string; accounts: WebAccount[]; sessions: Session[] };

export type WebView = {
  host: string | null;
  clientId: string | null;
  accounts: string[];
  port: number;
  listening: boolean;
  sessions: { id: string; email: string; agent: string; createdAt: number; seenAt: number; current?: true }[];
};

type Jwk = crypto.JsonWebKey & { kid?: string };

/** Google's signing keys, cached for as long as Google says, fetched again for a key id it doesn't know. */
export class GoogleKeys {
  private keys = new Map<string, crypto.KeyObject>();
  private until = 0;
  private fetchedAt = 0;

  constructor(private readonly load: () => Promise<{ keys: Jwk[]; maxAge?: number }> = fetchGoogleKeys) {}

  async get(kid: string, now = Date.now()): Promise<crypto.KeyObject | undefined> {
    if (now >= this.until || (!this.keys.has(kid) && now - this.fetchedAt > 60_000)) {
      const { keys, maxAge } = await this.load();
      this.keys = new Map(keys.filter((key) => typeof key.kid === "string" && key.kty === "RSA").map((key) => [key.kid!, crypto.createPublicKey({ key, format: "jwk" })]));
      this.fetchedAt = now;
      this.until = now + Math.min(Math.max(maxAge ?? 3600, 60), 24 * 3600) * 1000;
    }
    return this.keys.get(kid);
  }
}

async function fetchGoogleKeys(): Promise<{ keys: Jwk[]; maxAge?: number }> {
  const response = await fetch(GOOGLE_CERTS, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Google's keys answered ${response.status}`);
  const body = await response.json() as { keys?: Jwk[] };
  const maxAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1];
  return { keys: Array.isArray(body.keys) ? body.keys : [], maxAge: maxAge ? Number(maxAge) : undefined };
}

export type GoogleClaims = { sub: string; email: string; name?: string };

/** A Google ID token's claims, once its signature, issuer, audience, expiry and email check out. */
export async function verifyGoogleToken(token: string, clientId: string, keys: GoogleKeys, now = Date.now()): Promise<GoogleClaims> {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || token.length > 8192) throw new Error("Not a Google sign-in token.");
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Not a Google sign-in token.");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Not a Google sign-in token.");
  const key = await keys.get(header.kid, now);
  if (!key || !crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"))) {
    throw new Error("The sign-in token's signature does not check out.");
  }
  if (!GOOGLE_ISSUERS.has(String(claims.iss))) throw new Error("The sign-in token is not Google's.");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId)) throw new Error("The sign-in token is for another app.");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < now - 60_000) throw new Error("The sign-in token has expired.");
  if (typeof claims.iat === "number" && claims.iat * 1000 > now + 5 * 60_000) throw new Error("The sign-in token is from the future.");
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new Error("That Google account's email is not verified.");
  if (typeof claims.sub !== "string" || typeof claims.email !== "string") throw new Error("The sign-in token has no account.");
  return { sub: claims.sub, email: claims.email.toLowerCase(), ...(typeof claims.name === "string" ? { name: claims.name } : {}) };
}

const hashOf = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** The web access settings and sessions of this device, in <data>/device/web.json. */
export class WebAccess extends EventEmitter {
  private saved: Saved;
  private readonly file: string;
  private failures: number[] = [];
  listening = false;

  constructor(dir: string, readonly port: number, private readonly keys = new GoogleKeys(), private readonly now = () => Date.now()) {
    super();
    this.file = path.join(dir, "web.json");
    this.saved = { accounts: [], sessions: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Saved>;
      this.saved = {
        ...(validWebBase(raw.host) ? { host: raw.host } : {}),
        ...(typeof raw.clientId === "string" && CLIENT_ID.test(raw.clientId) ? { clientId: raw.clientId } : {}),
        accounts: Array.isArray(raw.accounts) ? raw.accounts.filter((a) => a && typeof a.email === "string") : [],
        sessions: Array.isArray(raw.sessions) ? raw.sessions.filter((s) => s && typeof s.hash === "string") : [],
      };
    } catch {
      /* not set up */
    }
  }

  get host(): string | undefined {
    return this.saved.host;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  view(current?: string): WebView {
    const now = this.now();
    const currentHash = current ? hashOf(current) : undefined;
    return {
      host: this.saved.host ?? null,
      clientId: this.saved.clientId ?? null,
      accounts: this.saved.accounts.map((a) => a.email),
      port: this.port,
      listening: this.listening,
      sessions: this.saved.sessions.filter((s) => now - s.seenAt < SESSION_MS).map((s) => ({
        id: s.hash.slice(0, 16), email: s.email, agent: s.agent, createdAt: s.createdAt, seenAt: s.seenAt,
        ...(s.hash === currentHash ? { current: true as const } : {}),
      })),
    };
  }

  /** host, clientId and accounts; each one left out stays as it is, an empty one turns it off. */
  update(body: unknown): void {
    const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    if ("host" in input) {
      const host = typeof input.host === "string" ? input.host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "") : "";
      if (host && !validWebBase(host)) throw new Error("The web address is a domain name such as scribe.example.com.");
      if (host) this.saved.host = host;
      else delete this.saved.host;
    }
    if ("clientId" in input) {
      const id = typeof input.clientId === "string" ? input.clientId.trim() : "";
      if (id && !CLIENT_ID.test(id)) throw new Error("A Google client id ends in .apps.googleusercontent.com.");
      if (id) this.saved.clientId = id;
      else delete this.saved.clientId;
    }
    if ("accounts" in input) {
      const list = Array.isArray(input.accounts) ? input.accounts : typeof input.accounts === "string" ? input.accounts.split(/[\s,;]+/) : [];
      const emails = [...new Set(list.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
      const bad = emails.find((e) => !EMAIL.test(e));
      if (bad) throw new Error(`“${bad}” is not an email address.`);
      const before = new Map(this.saved.accounts.map((a) => [a.email, a]));
      this.saved.accounts = emails.map((email) => before.get(email) ?? { email });
      // A removed account's browsers are signed out with it.
      this.saved.sessions = this.saved.sessions.filter((s) => emails.includes(s.email));
    }
    this.save();
    this.emit("changed");
  }

  signOut(id: string): void {
    const before = this.saved.sessions.length;
    this.saved.sessions = this.saved.sessions.filter((s) => s.hash.slice(0, 16) !== id);
    if (this.saved.sessions.length === before) throw new Error("No such browser.");
    this.save();
  }

  /** Sign a browser in with a Google ID token: a new session token. */
  async signIn(credential: unknown, agent: string): Promise<{ token: string; email: string }> {
    const now = this.now();
    this.failures = this.failures.filter((at) => now - at < 60_000);
    if (this.failures.length >= 10) throw Object.assign(new Error("Too many sign-in attempts; wait a minute."), { status: 429 });
    try {
      if (!this.saved.clientId) throw new Error("Web access has no Google client id yet.");
      const claims = await verifyGoogleToken(String(credential ?? ""), this.saved.clientId, this.keys, now);
      const account = this.saved.accounts.find((a) => a.email === claims.email);
      if (!account) throw new Error(`${claims.email} may not sign in here.`);
      if (account.sub && account.sub !== claims.sub) throw new Error(`${claims.email} is another Google account than the one that signed in first.`);
      account.sub = claims.sub;
      const token = crypto.randomBytes(32).toString("base64url");
      this.saved.sessions = this.saved.sessions.filter((s) => now - s.seenAt < SESSION_MS);
      this.saved.sessions.push({ hash: hashOf(token), email: claims.email, sub: claims.sub, createdAt: now, seenAt: now, agent: agentName(agent) });
      this.save();
      return { token, email: claims.email };
    } catch (err) {
      this.failures.push(now);
      throw err;
    }
  }

  /** The session a cookie's token names, while it and its account are still good. */
  session(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const now = this.now();
    const hash = hashOf(token);
    const session = this.saved.sessions.find((s) => s.hash === hash);
    if (!session || now - session.seenAt >= SESSION_MS) return undefined;
    const account = this.saved.accounts.find((a) => a.email === session.email);
    if (!account || (account.sub && account.sub !== session.sub)) return undefined;
    if (now - session.seenAt > TOUCH_MS) {
      session.seenAt = now;
      this.save();
    }
    return session;
  }

  endSession(token: string | undefined): void {
    if (!token) return;
    const hash = hashOf(token);
    const before = this.saved.sessions.length;
    this.saved.sessions = this.saved.sessions.filter((s) => s.hash !== hash);
    if (this.saved.sessions.length !== before) this.save();
  }
}

/** A short name for a browser, from its User-Agent: "Chrome on Android". */
function agentName(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "A browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function cookieToken(header: string | undefined): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === SESSION_COOKIE) return part.slice(at + 1).trim();
  }
  return undefined;
}

const sessionTokens = new WeakMap<object, string>();

/** The session token a signed-in web request came with (Settings marks "This browser"). */
export function webSessionToken(req: object): string | undefined {
  return sessionTokens.get(req);
}

/** Headers that are Scribe's own or one proxy hop's: a browser on the web never gets to send them on. */
const STRIP = /^(x-scribe-|x-forwarded-|x-real-ip$|forwarded$|cf-|true-client-ip$)/;

/** Files the browser fetches without the session cookie: the web app manifest and its icons. */
const OPEN_FILES = new Map([
  ["/manifest.webmanifest", "application/manifest+json"],
  ["/icon-192.png", "image/png"],
  ["/icon-512.png", "image/png"],
  ["/icon-maskable-512.png", "image/png"],
  ["/favicon.svg", "image/svg+xml"],
]);

export type WebFrontOptions = {
  self: () => string;
  /** Whether another device is paired with this one. */
  paired: (id: string) => boolean;
  /** Whether a page exists, for the TLS proxy's question (pages on another device answer over the link). */
  pageExists?: (device: string | undefined, label: string) => Promise<boolean>;
  /** The board port: rewritten requests name it, as a browser on this device would. */
  port: number;
  publicDir: string;
  app: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  upgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
};

/** Labels Scribe uses for a device's own origins: pages, the content origin, components, previews, embeds. */
const KNOWN_LABEL = /^(t-[0-9a-f]{1,61}|x[0-9a-f]{2,62}|c|w-it-[0-9a-f]{12}|w-pc-[0-9a-f]{16}|w-[0-9a-f]{1,61}|wx[0-9a-f]{2,60}|e[hs]-[a-z2-7]{1,60})$/;
const ASKS_PER_HOUR = 30;

/** The web listener's request and upgrade handlers. */
export function webFront(access: WebAccess, options: WebFrontOptions) {
  const approved = new Set<string>();
  let asks: number[] = [];

  function known(web: WebHost): boolean {
    if (web.device && web.device !== options.self() && !options.paired(web.device)) return false;
    return web.label === undefined || KNOWN_LABEL.test(web.label);
  }

  /**
   * Caddy's on-demand TLS asks before it gets a certificate for a name. Every name is a certificate and
   * certificate authorities limit how many a domain gets a week, so only names Scribe serves pass: the
   * boards, and the pages that exist. New names are capped per hour besides.
   */
  async function ask(domain: string): Promise<boolean> {
    const base = access.host;
    if (!base) return false;
    const web = parseWebHost(domain, base);
    if (!web || !known(web)) return false;
    if (approved.has(domain)) return true;
    if (web.label && /^(t-|x)/.test(web.label) && options.pageExists && !(await options.pageExists(web.device === options.self() ? undefined : web.device, web.label))) return false;
    const now = Date.now();
    asks = asks.filter((at) => now - at < 3600_000);
    if (asks.length >= ASKS_PER_HOUR) return false;
    asks.push(now);
    approved.add(domain);
    return true;
  }

  function cookie(base: string, token: string, maxAge: number): string {
    return `${SESSION_COOKIE}=${token}; Domain=${base}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
  }

  /** The rest of the request goes to the app as if a browser on this device had sent it. */
  function rewrite(req: http.IncomingMessage, web: WebHost, base: string): void {
    const self = options.self();
    const headers = req.headers;
    for (const name of Object.keys(headers)) if (STRIP.test(name)) delete headers[name];
    headers.host = `${internalHostname(web, self)}:${options.port}`;
    if (typeof headers.origin === "string" && headers.origin !== "null") {
      try {
        const url = new URL(headers.origin);
        const from = url.protocol === "https:" && !url.port ? parseWebHost(url.hostname, base) : undefined;
        headers.origin = from && known(from) ? `http://${internalHostname(from, self)}:${options.port}` : headers.origin;
      } catch {
        headers.origin = "null";
      }
    }
    // The session stays here: other devices and pages' own servers never see it.
    const token = cookieToken(headers.cookie);
    if (token) sessionTokens.set(req, token);
    if (headers.cookie) {
      const rest = headers.cookie.split(";").filter((part) => part.split("=")[0].trim() !== SESSION_COOKIE).join(";").trim();
      if (rest) headers.cookie = rest;
      else delete headers.cookie;
    }
    // Raw headers too: the gateway writes a socket's upgrade from them.
    req.rawHeaders.length = 0;
    for (const [name, value] of Object.entries(headers)) {
      for (const one of Array.isArray(value) ? value : [value]) if (one !== undefined) req.rawHeaders.push(name, String(one));
    }
    markWebRequest(req, base);
  }

  function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer, extra: http.OutgoingHttpHeaders = {}): void {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
    res.end(body);
  }

  async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 16_384) throw new Error("Too large.");
      chunks.push(chunk as Buffer);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return value && typeof value === "object" ? value : {};
  }

  async function auth(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, base: string): Promise<boolean> {
    const sameOrigin = req.headers.origin === `https://${base}`;
    if (pathname === "/auth/login" && req.method === "GET") {
      send(res, 200, "text/html; charset=utf-8", loginPage(access.view().clientId, base), {
        "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' data: https:",
        "referrer-policy": "no-referrer-when-downgrade",
      });
      return true;
    }
    if (pathname === "/auth/google" && req.method === "POST") {
      if (!sameOrigin) return send(res, 403, "application/json", JSON.stringify({ error: "Sign in from the sign-in page." })), true;
      try {
        const body = await readJson(req);
        const { token, email } = await access.signIn(body.credential, String(req.headers["user-agent"] ?? ""));
        send(res, 200, "application/json", JSON.stringify({ ok: true, email }), { "set-cookie": cookie(base, token, SESSION_MS / 1000) });
      } catch (err) {
        send(res, (err as { status?: number }).status ?? 403, "application/json", JSON.stringify({ error: (err as Error).message }));
      }
      return true;
    }
    if (pathname === "/auth/logout" && req.method === "POST") {
      // Any of this domain's boards may sign out (a form posts here from d-<device>.<domain> too).
      let ours = false;
      try { ours = new URL(String(req.headers.origin)).protocol === "https:" && parseWebHost(new URL(String(req.headers.origin)).hostname, base) !== undefined; } catch { /* no origin */ }
      if (!ours) return send(res, 403, "application/json", JSON.stringify({ error: "Sign out from the board." })), true;
      access.endSession(cookieToken(req.headers.cookie));
      res.writeHead(303, { location: `https://${base}/auth/login`, "set-cookie": cookie(base, "", 0), "cache-control": "no-store" }).end();
      return true;
    }
    return false;
  }

  /** Where a browser without a session goes: the sign-in page, then back to what it asked for. */
  function signInRedirect(res: http.ServerResponse, base: string, hostname: string, url: string): void {
    const next = `https://${hostname}${url}`;
    res.writeHead(302, { location: `https://${base}/auth/login?next=${encodeURIComponent(next)}`, "cache-control": "no-store" }).end();
  }

  async function request(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://web");
    const hostname = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    if (hostname === "127.0.0.1" || hostname === "localhost") {
      // The TLS proxy's question, from this machine: may it get a certificate for this name?
      if (url.pathname === "/caddy-ask" && req.method === "GET") {
        const ok = await ask(String(url.searchParams.get("domain") ?? "").toLowerCase()).catch(() => false);
        send(res, ok ? 200 : 404, "text/plain", ok ? "ok" : "no");
      } else send(res, 404, "text/plain", "Not found.");
      return;
    }
    const base = access.host;
    const web = base ? parseWebHost(hostname, base) : undefined;
    if (!base || !web || !known(web)) return send(res, 404, "text/plain", "Unknown host.");
    const board = web.label === undefined;
    if (board && !web.device && url.pathname.startsWith("/auth/") && await auth(req, res, url.pathname, base)) return;
    if (board && req.method === "GET" && OPEN_FILES.has(url.pathname)) {
      try {
        const body = fs.readFileSync(path.join(options.publicDir, url.pathname.slice(1)));
        res.writeHead(200, { "content-type": OPEN_FILES.get(url.pathname)!, "cache-control": "public, max-age=3600" }).end(body);
      } catch {
        send(res, 404, "text/plain", "Not found.");
      }
      return;
    }
    if (!access.session(cookieToken(req.headers.cookie))) {
      if (board && req.method === "GET" && /text\/html/.test(String(req.headers.accept ?? ""))) return signInRedirect(res, base, hostname, req.url ?? "/");
      return send(res, 401, "application/json", JSON.stringify({ error: "Sign in first.", signIn: `https://${base}/auth/login` }));
    }
    rewrite(req, web, base);
    options.app(req, res);
  }

  function upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const hostname = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    const base = access.host;
    const web = base ? parseWebHost(hostname, base) : undefined;
    if (!base || !web || !known(web) || !access.session(cookieToken(req.headers.cookie))) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    rewrite(req, web, base);
    options.upgrade(req, socket, head);
  }

  return {
    request: (req: http.IncomingMessage, res: http.ServerResponse) => {
      request(req, res).catch((err) => {
        if (!res.headersSent) send(res, 500, "text/plain", (err as Error).message);
        else res.destroy();
      });
    },
    upgrade,
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** The sign-in page: Google's button, and back to where the browser was going. */
function loginPage(clientId: string | null, base: string): string {
  const body = clientId
    ? `<div id="g_id_onload" data-client_id="${escapeHtml(clientId)}" data-callback="scribeSignedIn" data-auto_prompt="false" data-ux_mode="popup"></div>
<div class="g_id_signin" data-type="standard" data-theme="filled_black" data-size="large" data-shape="pill" data-text="signin_with"></div>
<p id="error" role="alert" hidden></p>
<script src="https://accounts.google.com/gsi/client" async></script>`
    : `<p>Web access has no Google client id yet. Set it in Settings → Devices → Web access on a paired device.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Scribe</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#1a1a1d">
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1a1a1d;color:#e8e8ea;font:15px/1.5 system-ui,sans-serif}
main{display:flex;flex-direction:column;align-items:center;gap:18px;padding:32px;max-width:360px;text-align:center}
img{width:56px;height:56px}
h1{margin:0;font-size:20px;font-weight:600}
p{margin:0;color:#8e8e96}
#error{color:#e58f8f}
</style></head>
<body><main>
<img src="/favicon.svg" alt="">
<h1>Scribe</h1>
<p>${escapeHtml(base)}</p>
${body}
</main>
<script>
function scribeSignedIn(response) {
  var error = document.getElementById("error");
  error.hidden = true;
  fetch("/auth/google", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential: response.credential }) })
    .then(function (r) { return r.json().then(function (body) { if (!r.ok) throw new Error(body.error || "Sign-in failed."); }); })
    .then(function () {
      var next = new URLSearchParams(location.search).get("next");
      var to = "/";
      try { var url = new URL(next); var host = url.hostname; if (url.protocol === "https:" && (host === ${JSON.stringify(base)} || host.endsWith(${JSON.stringify("." + base)}))) to = url.href; } catch (e) {}
      location.replace(to);
    })
    .catch(function (err) { error.textContent = err.message; error.hidden = false; });
}
</script>
</body></html>`;
}
