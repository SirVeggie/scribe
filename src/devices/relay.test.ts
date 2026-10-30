import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import express from "express";
import { identify } from "../callers.js";
import { decodeCode, makeOffer } from "./pairing.js";
import { PeerService } from "./peers.js";

/**
 * The relay (#910): A and B listen on nothing (both behind NAT, say) and only dial out to R. Once R
 * introduces them, each reaches the other through R, end to end over the pinned-key TLS it would use
 * directly. Flow control keeps a big transfer from holding up other streams on the same link.
 */
type Node = { peers: PeerService; server: http.Server; home: string };
const nodes: Node[] = [];

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function node(hosts: string[]): Promise<Node> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-relay-"));
  const app = express();
  app.get("/who", (req, res) => res.json(identify(req)));
  app.get("/big", (req, res) => res.type("application/octet-stream").send(Buffer.alloc(Number(req.query.n), 7)));
  const server = http.createServer(app);
  const peers = new PeerService({ home, port: await freePort(), hosts, version: "test" });
  peers.attach(server);
  await peers.start();
  const entry = { peers, server, home };
  nodes.push(entry);
  return entry;
}

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const viewOf = (a: Node, b: Node) => a.peers.view().peers.find((p) => p.id === b.peers.identity.id);

after(async () => {
  for (const entry of nodes) await entry.peers.stop();
});

test("pairing codes carry a public host name", () => {
  const offer = makeOffer("ab".repeat(32), 4748, ["scribe.example.com", "10.0.0.2"]);
  assert.deepEqual(decodeCode(offer.code).hosts, ["scribe.example.com", "10.0.0.2"]);
});

test("two devices with no route to each other link up through a third", async () => {
  const relay = await node(["127.0.0.1"]);
  const a = await node([]);
  const b = await node([]);
  for (const side of [a, b]) {
    const offer = await relay.peers.createOffer();
    await side.peers.pair(offer!.code);
    await until(() => viewOf(side, relay)?.online === true, "the link to the relay");
  }
  assert.equal(relay.peers.introduce(a.peers.identity.id, [b.peers.identity.id]), 1);
  await until(() => viewOf(a, b)?.online === true && viewOf(b, a)?.online === true, "A and B through the relay");
  assert.deepEqual(viewOf(a, b)?.via, { id: relay.peers.identity.id, name: relay.peers.identity.name });
  assert.equal(viewOf(b, a)?.via?.id, relay.peers.identity.id);

  // B's server sees A's device on requests that came through the relay: the inner link is A's own.
  const who = await a.peers.request(b.peers.identity.id, { path: "/who", headers: { host: "127.0.0.1" } });
  assert.equal(JSON.parse(who.body.toString()).device, a.peers.identity.id);

  // A big transfer (several windows) arrives whole, and a small request on the same links isn't stuck behind it.
  const big = a.peers.request(b.peers.identity.id, { path: "/big?n=3000000", headers: { host: "127.0.0.1" } });
  const small = await a.peers.request(b.peers.identity.id, { path: "/who", headers: { host: "127.0.0.1" } });
  assert.equal(small.status, 200);
  const body = (await big).body;
  assert.equal(body.length, 3_000_000);
  assert.ok(body.every((byte) => byte === 7));

  // The relay refuses a CONNECT to a device that isn't paired with it.
  const link = a.peers.linkTo(relay.peers.identity.id)!;
  const status = await new Promise<number>((resolve) => {
    const req = http.request({ method: "CONNECT", path: "/relay/0123456789ab", headers: { host: "relay" }, createConnection: () => link.openStream() as unknown as net.Socket });
    req.on("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
    req.on("error", () => resolve(-1));
    req.end();
  });
  assert.equal(status, 502);
});
