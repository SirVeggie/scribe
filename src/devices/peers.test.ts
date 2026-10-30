import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { identify, socketAllowed } from "../callers.js";
import { loadIdentity } from "./identity.js";
import { decodeCode, makeOffer, pairWords } from "./pairing.js";
import { PeerService } from "./peers.js";
import { qrMatrix } from "./qr.js";

/** Three daemons' worth of peer services on loopback, each with its own data folder, port and HTTP server. */
type Node = { peers: PeerService; server: http.Server; home: string; port: number };
const nodes: Node[] = [];

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function node(home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-peer-")), port?: number): Promise<Node> {
  port ??= await freePort();
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.all("/who", (req, res) => res.json({ ...identify(req), body: req.body ?? null }));
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, verifyClient: ({ req }: { req: http.IncomingMessage }) => socketAllowed(req.headers, req.socket) });
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => ws.send(`echo ${data}`))));
  const peers = new PeerService({ home, port, hosts: ["127.0.0.1"], version: "test" });
  peers.attach(server);
  await peers.start();
  const entry = { peers, server, home, port };
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

const online = (a: Node, b: Node) => a.peers.view().peers.find((p) => p.id === b.peers.identity.id)?.online === true;
const knows = (a: Node, b: Node) => a.peers.view().peers.some((p) => p.id === b.peers.identity.id);

after(async () => {
  for (const entry of nodes) await entry.peers.stop();
});

test("the device identity is made once and kept", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-id-"));
  const first = loadIdentity(home);
  const again = loadIdentity(home);
  assert.match(first.id, /^[0-9a-f]{12}$/);
  assert.equal(again.id, first.id);
  assert.equal(again.fingerprint, first.fingerprint);
  assert.equal(again.certPem, first.certPem);
});

test("pairing codes round-trip and the QR code fits", async () => {
  const peers = new PeerService({ home: fs.mkdtempSync(path.join(os.tmpdir(), "scribe-code-")), port: 4748, hosts: [], version: "test" });
  // No address to listen on: Add device says so instead of making a code nobody can use.
  await assert.rejects(peers.createOffer(), /no LAN, tailnet or public address/);
  const fp = peers.identity.fingerprint;
  const offer = makeOffer(fp, 4748, ["192.168.1.20", "fd7a:115c:a1e0::1"]);
  const decoded = decodeCode(offer.code.toLowerCase());
  assert.deepEqual(decoded.hosts, ["192.168.1.20", "fd7a:115c:a1e0:0:0:0:0:1"]);
  assert.equal(decoded.port, 4748);
  assert.ok(fp.startsWith(decoded.fingerprintPrefix));
  assert.ok(decoded.secret.equals(offer.secret));
  assert.throws(() => decodeCode("HELLO-WORLD"), /not a Scribe pairing code/);
  assert.ok(qrMatrix(offer.code).length <= 57);
  assert.deepEqual(pairWords("a", "b"), pairWords("b", "a"));
});

test("two devices pair by code, link up, and carry HTTP and WebSocket streams as the user on that device", async () => {
  const a = await node();
  const b = await node();
  let paired: { words: string[] } | undefined;
  a.peers.once("paired", (result) => (paired = result));
  const offer = await a.peers.createOffer();
  assert.ok(offer?.code && offer.qr.startsWith("<svg"));

  // A wrong secret is refused and counted.
  const wrong = decodeCode(offer.code);
  wrong.secret[0] ^= 0xff;
  await assert.rejects(b.peers.pair(reencode(offer.code, wrong.secret)), /Wrong code/);

  const result = await b.peers.pair(offer.code);
  assert.equal(result.device.id, a.peers.identity.id);
  assert.equal(result.device.name, a.peers.identity.name);
  await until(() => !!paired, "A's paired event");
  assert.deepEqual(paired!.words, result.words);
  assert.equal(result.words.length, 4);
  assert.equal(a.peers.view().offer, null, "the code is one time");
  await until(() => online(a, b) && online(b, a), "the link");
  await until(() => b.peers.view().peers[0].rtt !== undefined, "a round trip");

  const who = await b.peers.request(a.peers.identity.id, { method: "POST", path: "/who", headers: { "content-type": "application/json", "sec-fetch-site": "none", "x-scribe-client": "agent" }, body: JSON.stringify({ hi: 1 }) });
  assert.equal(who.status, 200);
  const caller = JSON.parse(who.body.toString());
  // A header can't make a link request an agent, nor anyone but the device whose key opened the link.
  assert.deepEqual(caller, { viewer: "user", device: b.peers.identity.id, body: { hi: 1 } });

  // Several requests at once share the one link.
  const many = await Promise.all(Array.from({ length: 8 }, () => a.peers.request(b.peers.identity.id, { path: "/who" })));
  for (const response of many) assert.equal(JSON.parse(response.body.toString()).device, a.peers.identity.id);

  // A big body crosses in frames and comes back whole.
  const big = "x".repeat(300_000);
  const echoed = await b.peers.request(a.peers.identity.id, { method: "POST", path: "/who", headers: { "content-type": "application/json" }, body: JSON.stringify({ big }) });
  assert.equal(JSON.parse(echoed.body.toString()).body.big.length, big.length);

  const link = b.peers.linkTo(a.peers.identity.id)!;
  const ws = new WebSocket("ws://peer/ws", { createConnection: () => link.openStream() as unknown as net.Socket });
  const reply = await new Promise<string>((resolve, reject) => {
    ws.on("open", () => ws.send("ping"));
    ws.on("message", (data) => resolve(String(data)));
    ws.on("error", reject);
  });
  assert.equal(reply, "echo ping");
  ws.close();
});

test("an unknown key is refused without an open code, and a used code can't pair again", async () => {
  const [a, b] = nodes;
  const stranger = await node();
  const offer = (await a.peers.createOffer())!;
  // b pairs again (as after losing its copy of a's key); that spends the code.
  await b.peers.pair(offer.code);
  await until(() => online(a, b) && online(b, a), "the link again");
  await assert.rejects(stranger.peers.pair(offer.code));
  assert.equal(knows(a, stranger), false);
  await stranger.peers.stop();
  nodes.splice(nodes.indexOf(stranger), 1);
});

test("five wrong codes close the offer", async () => {
  const [a] = nodes;
  const c = await node();
  const offer = (await a.peers.createOffer())!;
  for (let i = 0; i < 5; i++) {
    const wrong = decodeCode(offer.code);
    wrong.secret[1] ^= i + 1;
    await assert.rejects(c.peers.pair(reencode(offer.code, wrong.secret)));
  }
  assert.equal(a.peers.view().offer, null);
  await assert.rejects(c.peers.pair(offer.code));
});

test("a new device is introduced to the others, and revocation spreads to every paired device", async () => {
  const [a, b, c] = nodes;
  let shown: { others: { id: string }[] } | undefined;
  a.peers.once("paired", (event) => (shown = event));
  const offer = (await a.peers.createOffer())!;
  const result = await c.peers.pair(offer.code);
  // Each side is offered its own other devices: a has b, c has none yet.
  assert.deepEqual(result.others, []);
  await until(() => !!shown, "a's paired event");
  assert.deepEqual(shown!.others.map((o) => o.id), [b.peers.identity.id]);
  await until(() => online(a, c), "a–c link");
  assert.equal(a.peers.introduce(c.peers.identity.id), 1);
  await until(() => online(b, c) && online(c, b), "b–c link from the introduction");

  // Revoke b on a: a, b and c all drop the key, and b can't come back.
  a.peers.revoke(b.peers.identity.id);
  await until(() => !knows(a, b) && !knows(b, a) && !knows(c, b) && !knows(b, c), "revocation everywhere").catch((err) => {
    throw new Error(`${err.message}: a→b ${knows(a, b)}, b→a ${knows(b, a)}, c→b ${knows(c, b)}, b→c ${knows(b, c)}`);
  });
  assert.equal(online(a, c), true);
  await assert.rejects(b.peers.request(c.peers.identity.id, { path: "/who" }), /not online/);
});

test("a restarted device reconnects with the same key", async () => {
  const [a, , c] = nodes;
  await a.peers.stop();
  nodes.splice(nodes.indexOf(a), 1);
  await until(() => !online(c, a), "c to notice");
  const back = await node(a.home, a.port);
  assert.equal(back.peers.identity.id, a.peers.identity.id);
  await until(() => online(back, c) && online(c, back), "the link after restart", 15_000);
});

/** The same code with another secret, to try wrong guesses against a real offer. */
function reencode(code: string, secret: Buffer): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const clean = code.replace(/-/g, "");
  let bits = "";
  for (const ch of clean) bits += ALPHABET.indexOf(ch).toString(2).padStart(5, "0");
  const bytes = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  secret.copy(bytes, 1);
  let outBits = [...bytes].map((b) => b.toString(2).padStart(8, "0")).join("");
  outBits = outBits.padEnd(Math.ceil(outBits.length / 5) * 5, "0");
  return outBits.match(/.{5}/g)!.map((b) => ALPHABET[parseInt(b, 2)]).join("");
}
