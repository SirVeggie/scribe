import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { contentOriginGate } from "../contentOrigin.js";
import type { SpacesView } from "../spaces.js";
import { AskSource, AskWatcher, asksOf } from "./attention.js";
import { peerGateway } from "./gateway.js";
import { PeerService } from "./peers.js";
import { devicesRouter } from "./routes.js";

/**
 * The space selector's device sections and the remote "needs you" toasts (#906): two daemons on
 * loopback, built like http.ts (gateway, contentOriginGate, the routes). /api/devices is answered by
 * the local daemon even on the remote view's host.
 */
type Thread = { id: string; title: string; status: string; asking?: { kind: string; title?: string; detail?: string } };
type Node = { peers: PeerService; server: http.Server; port: number; id: string; spaces: SpacesView; threads: Thread[]; asks: AskSource; watcher: AskWatcher };
const nodes: Node[] = [];

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function spacesOf(names: string[]): SpacesView {
  const spaces = names.map((name, i) => ({ id: `s_${name.toLowerCase()}`, name, color: "blue", tabs: Array.from({ length: i + 1 }, (_, n) => ({ id: `t_${n}` })), usedAt: 1000, active: i === 0 }));
  return { spaces, activeId: spaces[0].id, deleted: [] } as unknown as SpacesView;
}

async function node(names: string[]): Promise<Node> {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-dv-"));
  const peers = new PeerService({ home, port: await freePort(), hosts: ["127.0.0.1"], version: "1.0.0" });
  const entry = { peers, port, id: peers.identity.id, spaces: spacesOf(names), threads: [] as Thread[] } as Node;
  entry.asks = new AskSource(() => entry.threads);
  entry.watcher = new AskWatcher(peers);
  const devices = express.Router();
  devices.use("/api/devices", express.json(), devicesRouter(peers, {
    spaces: () => entry.spaces,
    switchSpace: (sid) => { entry.spaces = { ...entry.spaces, activeId: sid }; },
    asks: entry.asks,
    watcher: entry.watcher,
  }));
  const app = express();
  app.use(peerGateway(peers, { version: "1.0.0", port, local: (_req, _res, next) => next(), devices }).http);
  app.use(contentOriginGate);
  app.use(express.json());
  app.post("/api/spaces/:sid/switch", (req, res) => {
    entry.spaces = { ...entry.spaces, activeId: req.params.sid };
    res.json(entry.spaces);
  });
  app.get("/api/spaces", (_req, res) => res.json(entry.spaces));
  app.use(devices);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  peers.attach(server);
  await peers.start();
  entry.server = server;
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

function call(to: Node, host: string, pathname: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: to.port,
      method: options.method ?? "GET",
      path: pathname,
      headers: { host: `${host}:${to.port}`, "sec-fetch-site": "same-origin", ...options.headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

/** The first event of an SSE stream, then the stream is closed. */
function firstEvent(to: Node, host: string, pathname: string, accept: (data: { asks: unknown[] }) => boolean = () => true): Promise<{ asks: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: to.port, path: pathname, headers: { host: `${host}:${to.port}`, "sec-fetch-site": "same-origin" } }, (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!block.startsWith("data: ")) continue;
          const data = JSON.parse(block.slice(6));
          if (accept(data)) {
            req.destroy();
            resolve(data);
          }
        }
      });
    });
    req.on("error", (err) => { if (!req.destroyed) reject(err); });
    req.end();
  });
}

let a: Node;
let b: Node;

before(async () => {
  a = await node(["Scribe dev", "Notes"]);
  b = await node(["Travel", "Thesis"]);
  const offer = (await b.peers.createOffer())!;
  await a.peers.pair(offer.code);
  await until(() => a.peers.view().peers.every((peer) => peer.online) && b.peers.view().peers.every((peer) => peer.online), "the link");
});

after(async () => {
  for (const entry of nodes) {
    entry.watcher.stop();
    await entry.peers.stop();
    entry.server.closeAllConnections();
    await new Promise((resolve) => entry.server.close(resolve));
  }
});

test("asksOf keeps approvals, questions and plans, not usage limits or running chats", () => {
  const asks = asksOf([
    { id: "th_1", title: "Thesis chat", status: "waiting", asking: { kind: "approval", title: "Run a command", detail: "npm test" } },
    { id: "th_2", title: "Limit", status: "waiting", asking: { kind: "limit", title: "Usage limit hit" } },
    { id: "th_3", title: "Busy", status: "running" },
  ]);
  assert.deepEqual(asks, [{ thread: "th_1", title: "Thesis chat", kind: "approval", text: "Run a command", detail: "npm test" }]);
});

test("the device list on A has A's spaces and B's, fetched over the link", async () => {
  const reply = await call(a, "127.0.0.1", "/api/devices/spaces");
  assert.equal(reply.status, 200);
  const view = JSON.parse(reply.body);
  assert.equal(view.self.id, a.id);
  assert.deepEqual(view.self.spaces.map((s: { name: string }) => s.name), ["Scribe dev", "Notes"]);
  assert.equal(view.viewing, null);
  const peer = view.peers.find((p: { id: string }) => p.id === b.id);
  assert.equal(peer.online, true);
  assert.deepEqual(peer.spaces.map((s: { name: string; tabs: number; active: boolean }) => [s.name, s.tabs, s.active]), [["Travel", 1, true], ["Thesis", 2, false]]);
});

test("in B's UI through A's gateway, /api/devices is A's own, naming the device being viewed", async () => {
  const reply = await call(a, `d-${b.id}.localhost`, "/api/devices");
  assert.equal(reply.status, 200, reply.body);
  const view = JSON.parse(reply.body);
  assert.equal(view.self.id, a.id, "answered by A, not forwarded to B");
  assert.equal(view.viewing, b.id);
  const spaces = JSON.parse((await call(a, `d-${b.id}.localhost`, "/api/devices/spaces")).body);
  assert.equal(spaces.self.id, a.id);
  assert.equal(spaces.viewing, b.id);
});

test("picking a space on B switches B; from B's view, a space on A switches A", async () => {
  let reply = await call(a, "127.0.0.1", `/api/devices/${b.id}/spaces/s_thesis/switch`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(reply.status, 200, reply.body);
  assert.equal(b.spaces.activeId, "s_thesis");
  const gatewayOrigin = `http://d-${b.id}.localhost:${a.port}`;
  reply = await call(a, `d-${b.id}.localhost`, `/api/devices/${a.id}/spaces/s_notes/switch`, { method: "POST", headers: { "content-type": "application/json", origin: gatewayOrigin }, body: "{}" });
  assert.equal(reply.status, 200, reply.body);
  assert.equal(a.spaces.activeId, "s_notes");
  // Another site's script may not switch spaces through the gateway.
  reply = await call(a, `d-${b.id}.localhost`, `/api/devices/${a.id}/spaces/s_notes/switch`, { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: "{}" });
  assert.equal(reply.status, 403);
});

test("B's chats that wait on the user reach A's board as asks; B's own view leaves them out", async () => {
  b.threads = [{ id: "th_b", title: "Thesis chat", status: "waiting", asking: { kind: "approval", title: "Run a command", detail: "npm test" } }];
  b.asks.touch();
  const local = await firstEvent(a, "127.0.0.1", "/api/devices/attention", (data) => data.asks.length > 0);
  assert.deepEqual(local.asks, [{ thread: "th_b", title: "Thesis chat", kind: "approval", text: "Run a command", detail: "npm test", device: b.id, name: b.peers.identity.name }]);
  // In B's own UI through A's gateway, B shows its asks itself; A's own asks come instead.
  a.threads = [{ id: "th_a", title: "Desktop chat", status: "waiting", asking: { kind: "question", title: "Which file?" } }];
  a.asks.touch();
  await until(() => a.asks.asks.length === 1, "A's asks");
  const remote = await firstEvent(a, `d-${b.id}.localhost`, "/api/devices/attention");
  assert.deepEqual(remote.asks.map((ask) => [ask.thread, ask.home ?? false]), [["th_a", true]]);
  // Answered on B: the ask goes away on A.
  b.threads = [];
  b.asks.touch();
  await until(() => a.watcher.asks().length === 0, "the ask to clear");
});
