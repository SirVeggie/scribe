import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { identify, socketAllowed } from "../callers.js";
import { componentItemFromHost, gatewayHost, hostSuffixOf, pageHost, pageIdFromHost, previewThreadFromHost } from "../config.js";
import { boardOrigin, contentOriginGate, isContentHost, requestSuffix, shellOrigin } from "../contentOrigin.js";
import { blockedBoardRequest } from "../browser.js";
import { peerGateway } from "./gateway.js";
import { peerDeviceOf } from "./link.js";
import { PeerService } from "./peers.js";

/**
 * Two daemons on loopback, each with its own data folder, peer port and HTTP server built the way
 * http.ts builds the real one: the gateway first, then contentOriginGate, then the routes. A views B's UI
 * through A's gateway, as a browser on A would (#905).
 */
type Node = { peers: PeerService; server: http.Server; port: number; id: string; hits: Map<string, number> };
const nodes: Node[] = [];

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function node(version: string): Promise<Node> {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-gw-"));
  const peers = new PeerService({ home, port: await freePort(), hosts: ["127.0.0.1"], version });
  const hits = new Map<string, number>();
  const count = (name: string) => hits.set(name, (hits.get(name) ?? 0) + 1);
  const app = express();
  const local: express.RequestHandler = (req, res, next) => {
    if (req.path === "/app.js") res.type("js").send(`// local copy on ${peers.identity.id}`);
    else next();
  };
  const gateway = peerGateway(peers, { version, port, local });
  app.use(gateway.http);
  app.use(contentOriginGate);
  app.use(express.json());
  app.get("/app.js", (_req, res) => { count("app.js"); res.type("js").send(`// served by ${peers.identity.id}`); });
  app.get("/kit.js", (req, res) => {
    count("kit.js");
    res.set("Cache-Control", req.query.v ? "public, max-age=31536000, immutable" : "no-cache").type("js").send(`// kit from ${peers.identity.id}`);
  });
  app.all("/api/who", (req, res) => {
    count("who");
    res.json({ ...identify(req), host: req.hostname, suffix: requestSuffix(req), board: boardOrigin(req), content: isContentHost(req), body: req.body ?? null, token: req.get("x-scribe-local-token") ?? null });
  });
  app.post("/api/shell", (req, res) => res.json({ shell: shellOrigin(req, req.get("origin") ?? "") }));
  app.get("/view/:id", (req, res) => res.type("html").send(`<p>${req.params.id} on ${req.hostname}</p>`));
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, verifyClient: ({ req }: { req: http.IncomingMessage }) => socketAllowed(req.headers, req.socket) });
  const linkWss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 0 }, verifyClient: ({ req }: { req: http.IncomingMessage }) => socketAllowed(req.headers, req.socket) });
  server.on("upgrade", (req, socket, head) => {
    if (gateway.upgrade(req, socket, head)) return;
    (peerDeviceOf(req.socket) ? linkWss : wss).handleUpgrade(req, socket, head, (ws) => {
      ws.send(`hello from ${peers.identity.id} via ${peerDeviceOf(req.socket) ?? "here"} on ${req.headers.host}`);
      ws.on("message", (data) => ws.send(`echo ${data}`));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  peers.attach(server);
  await peers.start();
  const entry = { peers, server, port, id: peers.identity.id, hits };
  nodes.push(entry);
  return entry;
}

async function until(check: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

/** A request to a node's HTTP port with the Host a browser on that device would send. */
function get(to: Node, host: string, pathname: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: to.port,
      method: options.method ?? "GET",
      path: pathname,
      headers: { host: `${host}:${to.port}`, "sec-fetch-site": "none", ...options.headers },
    }, (res) => {
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
let c: Node;

before(async () => {
  a = await node("1.0.0");
  b = await node("1.0.0");
  c = await node("2.0.0");
  for (const other of [b, c]) {
    const offer = (await other.peers.createOffer())!;
    await a.peers.pair(offer.code);
  }
  await until(() => a.peers.view().peers.every((peer) => peer.online), "the links");
});

after(async () => {
  for (const entry of nodes) {
    await entry.peers.stop();
    entry.server.closeAllConnections();
    await new Promise((resolve) => entry.server.close(resolve));
  }
});

test("gateway host names parse, with and without a device", () => {
  assert.deepEqual(gatewayHost("d-0123456789ab.localhost"), { device: "0123456789ab" });
  assert.deepEqual(gatewayHost("T-AB12.d-0123456789ab.localhost"), { device: "0123456789ab", label: "t-ab12" });
  assert.equal(gatewayHost("d-xyz.localhost"), undefined);
  assert.equal(gatewayHost("t-ab12.localhost"), undefined);
  assert.equal(gatewayHost("a.b.d-0123456789ab.localhost"), undefined);
  assert.equal(hostSuffixOf("t-ab12.d-0123456789ab.localhost"), ".d-0123456789ab.localhost");
  assert.equal(hostSuffixOf("t-ab12.localhost"), ".localhost");
  assert.equal(pageHost("t_ab12", ".d-0123456789ab.localhost"), "t-ab12.d-0123456789ab.localhost");
  assert.equal(pageIdFromHost("t-ab12.d-0123456789ab.localhost"), "t_ab12");
  assert.equal(pageIdFromHost("t-ab12.localhost"), "t_ab12");
  assert.equal(pageIdFromHost("d-0123456789ab.localhost"), undefined);
  assert.equal(pageIdFromHost("t-ab12.evil.localhost"), undefined);
  assert.equal(previewThreadFromHost("w-ab12.d-0123456789ab.localhost"), "th_ab12");
  assert.equal(componentItemFromHost("w-it-012345abcdef.d-0123456789ab.localhost"), "it_012345abcdef");
});

test("A shows B's UI: B answers as for its own board, with A's gateway names", async () => {
  const who = await get(a, `d-${b.id}.localhost`, "/api/who");
  assert.equal(who.status, 200);
  const caller = JSON.parse(who.body);
  assert.equal(caller.viewer, "user");
  assert.equal(caller.device, a.id, "B trusts the link's device");
  assert.equal(caller.host, `d-${b.id}.localhost`);
  assert.equal(caller.suffix, `.d-${b.id}.localhost`);
  assert.equal(caller.board, `http://d-${b.id}.localhost:${a.port}`);
  assert.equal(caller.content, false);

  // A body crosses, and A's local token never does.
  const posted = await get(a, `d-${b.id}.localhost`, "/api/who", {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://d-${b.id}.localhost:${a.port}`, "sec-fetch-site": "same-origin", "x-scribe-local-token": "secret" },
    body: JSON.stringify({ hi: 1 }),
  });
  assert.equal(posted.status, 200);
  assert.deepEqual(JSON.parse(posted.body).body, { hi: 1 });
  assert.equal(JSON.parse(posted.body).token, null);

  // B takes its gateway origin as its shell's, but only over the link.
  const shell = await get(a, `d-${b.id}.localhost`, "/api/shell", { method: "POST", headers: { origin: `http://d-${b.id}.localhost:${a.port}`, "sec-fetch-site": "same-origin" } });
  assert.deepEqual(JSON.parse(shell.body), { shell: true });
  const direct = await get(b, "127.0.0.1", "/api/shell", { method: "POST", headers: { origin: `http://d-${b.id}.localhost:${b.port}` } });
  assert.notEqual(direct.status, 200);
});

test("B's pages get their own origins under A's gateway suffix", async () => {
  const page = await get(a, `t-ab12.d-${b.id}.localhost`, "/view/t_ab12");
  assert.equal(page.status, 200);
  assert.match(page.body, new RegExp(`t_ab12 on t-ab12\\.d-${b.id}\\.localhost`));
  // A page asked for on another page's origin goes to its own, on the gateway names and A's port.
  const moved = await get(a, `t-ab12.d-${b.id}.localhost`, "/view/t_cd34");
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.location, `http://t-cd34.d-${b.id}.localhost:${a.port}/view/t_cd34`);
  // Page origins never reach the board's API.
  const api = await get(a, `t-ab12.d-${b.id}.localhost`, "/api/who");
  assert.equal(api.status, 403);
  // The shared content origin is c.d-<device>.localhost.
  const content = await get(a, `c.d-${b.id}.localhost`, "/kit.js");
  assert.equal(content.status, 200);
  const board = await get(a, `t-ab12.d-${b.id}.localhost`, "/");
  assert.equal(board.status, 302);
  assert.equal(board.headers.location, `http://d-${b.id}.localhost:${a.port}/`);
});

test("the gateway lets only this device's browser through", async () => {
  // No browser marks: an agent's or a tool's request.
  const tool = await get(a, `d-${b.id}.localhost`, "/api/who", { headers: { "sec-fetch-site": "" } });
  assert.equal(tool.status, 403);
  const agent = await get(a, `d-${b.id}.localhost`, "/api/who", { headers: { "x-scribe-client": "agent" } });
  assert.equal(agent.status, 403);
  // Another origin's script: this device's board, one of its pages, or another device's view.
  for (const origin of [`http://127.0.0.1:${a.port}`, `http://t-ab12.localhost:${a.port}`, `http://d-${c.id}.localhost:${a.port}`, "https://example.com"]) {
    const write = await get(a, `d-${b.id}.localhost`, "/api/who", { method: "POST", headers: { origin } });
    assert.equal(write.status, 403, origin);
  }
  assert.equal(b.hits.get("who"), 2, "nothing refused reached B");
  // An unknown device, and the agent browser.
  const unknown = await get(a, "d-0000000000aa.localhost", "/");
  assert.equal(unknown.status, 404);
  assert.equal(blockedBoardRequest(`http://d-${b.id}.localhost:4747/`, 4747), true);
  assert.equal(blockedBoardRequest("http://t-ab12.localhost:4747/view/t_ab12", 4747), false);
});

test("this device named through its own gateway goes home", async () => {
  const home = await get(a, `d-${a.id}.localhost`, "/?x=1");
  assert.equal(home.status, 302);
  assert.equal(home.headers.location, `http://127.0.0.1:${a.port}/?x=1`);
  const page = await get(a, `t-ab12.d-${a.id}.localhost`, "/view/t_ab12");
  assert.equal(page.headers.location, `http://t-ab12.localhost:${a.port}/view/t_ab12`);
});

test("UI files come from this device when the versions match, else from the cache by content hash", async () => {
  const same = await get(a, `d-${b.id}.localhost`, "/app.js");
  assert.equal(same.body, `// local copy on ${a.id}`);
  assert.equal(b.hits.get("app.js"), undefined, "never crossed the link");

  const other = await get(a, `d-${c.id}.localhost`, "/app.js");
  assert.equal(other.body, `// served by ${c.id}`);
  for (let i = 0; i < 3; i++) {
    const kit = await get(a, `d-${c.id}.localhost`, "/kit.js?v=abc");
    assert.equal(kit.body, `// kit from ${c.id}`);
  }
  assert.equal(c.hits.get("kit.js"), 1, "an immutable file crosses once");
  await get(a, `d-${c.id}.localhost`, "/kit.js");
  await get(a, `d-${c.id}.localhost`, "/kit.js");
  assert.equal(c.hits.get("kit.js"), 3, "a file without a content hash is asked for each time");
});

test("the board's socket opens through the gateway, compressed", async () => {
  const origin = `http://d-${b.id}.localhost:${a.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${a.port}/ws`, { headers: { host: `d-${b.id}.localhost:${a.port}`, origin }, perMessageDeflate: true });
  const messages: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on("message", (data) => {
      messages.push(String(data));
      if (messages.length === 1) ws.send("x".repeat(5000));
      else resolve();
    });
    ws.on("error", reject);
  });
  assert.equal(messages[0], `hello from ${b.id} via ${a.id} on d-${b.id}.localhost:${a.port}`);
  assert.equal(messages[1], `echo ${"x".repeat(5000)}`);
  assert.match(ws.extensions, /permessage-deflate/);
  ws.close();

  // Not from another origin, and not without one.
  for (const headers of [{ origin: `http://127.0.0.1:${a.port}` }, {}]) {
    const refused = new WebSocket(`ws://127.0.0.1:${a.port}/ws`, { headers: { host: `d-${b.id}.localhost:${a.port}`, ...headers } });
    const status = await new Promise<number>((resolve) => {
      refused.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      refused.on("error", () => resolve(-1));
    });
    assert.equal(status, 403);
  }
});

test("an offline device shows a page that leads back", async () => {
  await c.peers.stop();
  await until(() => !a.peers.view().peers.find((peer) => peer.id === c.id)?.online, "C offline");
  const page = await get(a, `d-${c.id}.localhost`, "/");
  assert.equal(page.status, 502);
  assert.match(page.body, /not connected/);
  assert.match(page.body, new RegExp(`http://127\\.0\\.0\\.1:${a.port}/`));
});
