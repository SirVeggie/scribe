import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { identify, socketAllowed } from "../callers.js";
import { boardOrigin, contentOriginGate, requestOrigin, requestSuffix } from "../contentOrigin.js";
import { pageHost } from "../config.js";
import { internalHostname, markWebSocket, parseWebHost, webHostOf } from "../webRequest.js";
import { peerGateway } from "./gateway.js";
import { peerDeviceOf } from "./link.js";
import { PeerService } from "./peers.js";
import { devicesRouter, type DevicesHost } from "./routes.js";
import { GoogleKeys, SESSION_COOKIE, WebAccess, verifyGoogleToken, webFront } from "./web.js";

/**
 * Web access (#913): A is the always-on server with the web listener, B a paired device. A browser on
 * the web signs in with a (test-signed) Google token and opens A's board, and B's through A.
 */
const BASE = "scribe.test.dev";
const CLIENT = "123-abc.apps.googleusercontent.com";
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys = new GoogleKeys(async () => ({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" }] }));

function token(claims: Record<string, unknown>, kid = "k1", key = privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT, sub: "111", email: "me@example.com", email_verified: true, iat: now, exp: now + 3600, ...claims })).toString("base64url");
  return `${head}.${body}.${crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key).toString("base64url")}`;
}

type Node = { peers: PeerService; server: http.Server; port: number; id: string; web?: { port: number; server: http.Server; access: WebAccess } };
const nodes: Node[] = [];

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function node(withWeb: boolean): Promise<Node> {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-web-"));
  const peers = new PeerService({ home, port: await freePort(), hosts: ["127.0.0.1"], version: "1.0.0" });
  const access = withWeb ? new WebAccess(path.join(home, "device"), await freePort(), keys) : undefined;
  const host = { spaces: () => ({ spaces: [], activeId: null }), switchSpace() {}, asks: {}, watcher: {}, ...(access ? { web: access } : {}) } as unknown as DevicesHost;
  const devicesApi = express.Router();
  devicesApi.use("/api/devices", express.json(), devicesRouter(peers, host));
  const app = express();
  const gateway = peerGateway(peers, { version: "1.0.0", port, local: (_req, _res, next) => next(), devices: devicesApi });
  app.use(gateway.http);
  app.use(contentOriginGate);
  app.use(devicesApi);
  app.use(express.json());
  app.all("/api/who", (req, res) => {
    res.json({ ...identify(req), host: req.hostname, suffix: requestSuffix(req), board: boardOrigin(req), page: requestOrigin(req, pageHost("t_ab12", requestSuffix(req))), cookie: req.get("cookie") ?? null, local: req.get("x-scribe-local-token") ?? null });
  });
  app.get("/view/:id", (req, res) => res.type("html").send(`<p>${req.params.id} on ${req.hostname}</p>`));
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, verifyClient: ({ req }: { req: http.IncomingMessage }) => socketAllowed(req.headers, req.socket) });
  const upgradeBoard = (req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    if (gateway.upgrade(req, socket, head)) return;
    wss.handleUpgrade(req, socket, head, (ws) => ws.send(`hello from ${peers.identity.id} via ${peerDeviceOf(req.socket) ?? "here"} web ${req.headers["x-scribe-web"] ?? "-"}`));
  };
  server.on("upgrade", upgradeBoard);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  peers.attach(server);
  await peers.start();
  const entry: Node = { peers, server, port, id: peers.identity.id };
  if (access) {
    const front = webFront(access, { self: () => peers.identity.id, paired: (id) => peers.nameOf(id) !== undefined, port, publicDir: path.resolve("public"), app: (req, res) => app(req as express.Request, res as express.Response), upgrade: upgradeBoard });
    const webServer = http.createServer(front.request);
    webServer.on("connection", markWebSocket);
    webServer.on("upgrade", front.upgrade);
    await new Promise<void>((resolve) => webServer.listen(access.port, "127.0.0.1", resolve));
    entry.web = { port: access.port, server: webServer, access };
  }
  nodes.push(entry);
  return entry;
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

function call(port: number, host: string, pathname: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: options.method ?? "GET", path: pathname, headers: { host, ...options.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

let a: Node;
let b: Node;
let cookie = "";
/** A browser on the web: what Caddy passes on, with the session once signed in. */
const web = (host: string, pathname: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  call(a.web!.port, host, pathname, { ...options, headers: { "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}), ...options.headers } });

before(async () => {
  a = await node(true);
  b = await node(false);
  const offer = (await b.peers.createOffer())!;
  await a.peers.pair(offer.code);
  const end = Date.now() + 8000;
  while (!a.peers.view().peers.every((peer) => peer.online)) {
    if (Date.now() > end) throw new Error("no link");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  a.web!.access.update({ host: BASE, clientId: CLIENT, accounts: "me@example.com" });
});

after(async () => {
  for (const entry of nodes) {
    await entry.peers.stop();
    for (const server of [entry.server, entry.web?.server]) {
      if (!server) continue;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test("web host names map to the daemon's own and back", () => {
  const self = "aaaaaaaaaaaa";
  const other = "0123456789ab";
  assert.deepEqual(parseWebHost(BASE, BASE), {});
  assert.deepEqual(parseWebHost(`d-${other}.${BASE}`, BASE), { device: other });
  assert.deepEqual(parseWebHost(`t-ab12.${BASE}`, BASE), { label: "t-ab12" });
  assert.deepEqual(parseWebHost(`t-ab12--${other}.${BASE}`, BASE), { device: other, label: "t-ab12" });
  assert.equal(parseWebHost(`a.b.${BASE}`, BASE), undefined);
  assert.equal(parseWebHost(`evil${BASE}`, BASE), undefined);
  assert.equal(internalHostname({}, self), "127.0.0.1");
  assert.equal(internalHostname({ label: "c" }, self), "127.0.0.2");
  assert.equal(internalHostname({ device: self, label: "t-ab12" }, self), "t-ab12.localhost");
  assert.equal(internalHostname({ device: other, label: "t-ab12" }, self), `t-ab12.d-${other}.localhost`);
  assert.equal(webHostOf("127.0.0.1", BASE), BASE);
  assert.equal(webHostOf("t-ab12.localhost:4747", BASE), `t-ab12.${BASE}`);
  assert.equal(webHostOf(`d-${other}.localhost`, BASE), `d-${other}.${BASE}`);
  assert.equal(webHostOf(`c.d-${other}.localhost`, BASE), `c--${other}.${BASE}`);
});

test("Google tokens: signature, audience, expiry and verified email", async () => {
  assert.equal((await verifyGoogleToken(token({}), CLIENT, keys)).email, "me@example.com");
  await assert.rejects(verifyGoogleToken(token({ aud: "other.apps.googleusercontent.com" }), CLIENT, keys), /another app/);
  await assert.rejects(verifyGoogleToken(token({ exp: Math.floor(Date.now() / 1000) - 3600 }), CLIENT, keys), /expired/);
  await assert.rejects(verifyGoogleToken(token({ email_verified: false }), CLIENT, keys), /not verified/);
  await assert.rejects(verifyGoogleToken(token({ iss: "https://evil.example" }), CLIENT, keys), /not Google's/);
  const forged = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  await assert.rejects(verifyGoogleToken(token({}, "k1", forged), CLIENT, keys), /signature/);
  await assert.rejects(verifyGoogleToken("not.a.token", CLIENT, keys), /Not a Google/);
});

test("without a session: the sign-in page, never the API", async () => {
  cookie = "";
  const board = await web(BASE, "/", { headers: { accept: "text/html" } });
  assert.equal(board.status, 302);
  assert.equal(board.headers.location, `https://${BASE}/auth/login?next=${encodeURIComponent(`https://${BASE}/`)}`);
  const api = await web(BASE, "/api/who", { headers: { "x-scribe-local-token": "x" } });
  assert.equal(api.status, 401);
  const page = await web(`t-ab12.${BASE}`, "/view/t_ab12");
  assert.equal(page.status, 401);
  const login = await web(BASE, "/auth/login");
  assert.equal(login.status, 200);
  assert.match(login.body, new RegExp(CLIENT.replace(/\./g, "\\.")));
  // The manifest and its icons load without the cookie, as browsers fetch them.
  assert.equal((await web(BASE, "/manifest.webmanifest")).status, 200);
  assert.equal((await web(BASE, "/icon-192.png")).status, 200);
  assert.equal((await web("other.example.com", "/")).status, 404);
  assert.equal((await web(`d-ffffffffffff.${BASE}`, "/")).status, 404);
});

test("the TLS proxy may get certificates only for names Scribe serves", async () => {
  const ask = (domain: string) => call(a.web!.port, `127.0.0.1:${a.web!.port}`, `/caddy-ask?domain=${encodeURIComponent(domain)}`).then((r) => r.status);
  assert.equal(await ask(BASE), 200);
  assert.equal(await ask(`d-${b.id}.${BASE}`), 200);
  assert.equal(await ask(`c--${b.id}.${BASE}`), 200);
  assert.equal(await ask(`whatever.${BASE}`), 404);
  assert.equal(await ask(`d-ffffffffffff.${BASE}`), 404);
  assert.equal(await ask("example.org"), 404);
});

test("sign-in: an allowed, verified account from the sign-in page gets a session", async () => {
  const post = (credential: string, origin = `https://${BASE}`) => web(BASE, "/auth/google", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ credential }) });
  assert.equal((await post(token({}), "https://evil.example")).status, 403);
  assert.equal((await post(token({ email: "someone@example.com", sub: "222" }))).status, 403);
  const ok = await post(token({}));
  assert.equal(ok.status, 200, ok.body);
  const set = String(ok.headers["set-cookie"]);
  assert.match(set, new RegExp(`^${SESSION_COOKIE}=[\\w-]+; Domain=${BASE.replace(/\./g, "\\.")}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`));
  cookie = set.split(";")[0];
  // The account's Google subject is pinned: another account with that email no longer gets in.
  assert.equal((await post(token({ sub: "999" }))).status, 403);
});

test("signed in: this device's board is the user, with web URLs", async () => {
  const who = await web(BASE, "/api/who", { headers: { "x-scribe-local-token": "x", cookie: `${cookie}; other=1` } });
  assert.equal(who.status, 200);
  const caller = JSON.parse(who.body);
  assert.equal(caller.viewer, "user");
  assert.equal(caller.web, true);
  assert.equal(caller.host, "127.0.0.1");
  assert.equal(caller.board, `https://${BASE}`);
  assert.equal(caller.page, `https://t-ab12.${BASE}`);
  assert.equal(caller.cookie, "other=1", "the session cookie stays with the web listener");
  assert.equal(caller.local, null);
  // Writes from a page's origin are another origin's, as on loopback.
  const write = await web(BASE, "/api/who", { method: "POST", headers: { origin: `https://t-ab12.${BASE}`, "sec-fetch-site": "same-site" } });
  assert.equal(write.status, 403);
  const own = await web(BASE, "/api/who", { method: "POST", headers: { origin: `https://${BASE}` } });
  assert.equal(own.status, 200);
  // A page on its own origin, and on another page's it moves to its own web name.
  assert.equal((await web(`t-ab12.${BASE}`, "/view/t_ab12")).status, 200);
  const moved = await web(`t-ab12.${BASE}`, "/view/t_cd34");
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.location, `https://t-cd34.${BASE}/view/t_cd34`);
});

test("signed in: another device's UI through the server, as that device's user from the web", async () => {
  const who = await web(`d-${b.id}.${BASE}`, "/api/who");
  assert.equal(who.status, 200, who.body);
  const caller = JSON.parse(who.body);
  assert.equal(caller.viewer, "user");
  assert.equal(caller.device, a.id);
  assert.equal(caller.web, true);
  assert.equal(caller.board, `https://d-${b.id}.${BASE}`);
  assert.equal(caller.page, `https://t-ab12--${b.id}.${BASE}`);
  assert.equal(caller.cookie, null);
  const moved = await web(`t-ab12--${b.id}.${BASE}`, "/view/t_cd34");
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.location, `https://t-cd34--${b.id}.${BASE}/view/t_cd34`);
  // The web header from a browser on loopback never crosses the gateway.
  const local = await call(a.port, `d-${b.id}.localhost:${a.port}`, "/api/who", { headers: { "sec-fetch-site": "none", "x-scribe-web": BASE } });
  assert.equal(JSON.parse(local.body).web, undefined);
  assert.equal(JSON.parse(local.body).board, `http://d-${b.id}.localhost:${a.port}`);
});

test("signed in: sockets to this board and through to another device", async () => {
  const open = (host: string, origin: string, withCookie = true) => new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${a.web!.port}/ws`, { headers: { host, origin, ...(withCookie ? { cookie } : {}) } });
    ws.on("message", (data) => { resolve(String(data)); ws.close(); });
    ws.on("error", (err) => resolve(`error ${err.message}`));
    ws.on("unexpected-response", (_req, res) => resolve(`status ${res.statusCode}`));
  });
  assert.equal(await open(BASE, `https://${BASE}`, false), "status 401");
  assert.equal(await open(BASE, `https://${BASE}`), `hello from ${a.id} via here web -`);
  assert.equal(await open(`d-${b.id}.${BASE}`, `https://d-${b.id}.${BASE}`), `hello from ${b.id} via ${a.id} web ${BASE}`);
  assert.equal(await open(BASE, "https://evil.example"), "status 401");
});

test("web access is set up from a paired device, never from the web", async () => {
  const fromWeb = await web(BASE, "/api/devices/web", { method: "PUT", headers: { origin: `https://${BASE}`, "content-type": "application/json" }, body: JSON.stringify({ accounts: "evil@example.com" }) });
  assert.equal(fromWeb.status, 403);
  const seen = JSON.parse((await web(BASE, "/api/devices/web")).body);
  assert.equal(seen.editable, false);
  assert.deepEqual(seen.accounts, ["me@example.com"]);
  assert.equal(seen.sessions.length, 1);
  assert.equal(seen.sessions[0].current, true);
  // B sets A's up over the link, as a paired device may.
  const fromB = await call(b.port, `127.0.0.1:${b.port}`, `/api/devices/${a.id}/web`, { method: "PUT", headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ accounts: "me@example.com, you@example.com" }) });
  assert.equal(fromB.status, 200, fromB.body);
  assert.deepEqual(JSON.parse(fromB.body).accounts, ["me@example.com", "you@example.com"]);
  // Dropping an account signs its browsers out.
  a.web!.access.update({ accounts: "you@example.com" });
  assert.equal((await web(BASE, "/api/who")).status, 401);
});
