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
import { AskSource, AskWatcher } from "./attention.js";
import { peerGateway } from "./gateway.js";
import { PeerService } from "./peers.js";
import { deviceSlug, findDevice, parseDeviceRef, rememberName } from "./references.js";
import { devicesRouter } from "./routes.js";

/** References to pages and threads on other devices (#908): the parser, and two daemons on loopback. */

test("parseDeviceRef reads pages, cards and threads on a device, and nothing else", () => {
  assert.deepEqual(parseDeviceRef("scribe:@laptop/thesis-plan"), { device: "laptop", kind: "page", ref: "thesis-plan" });
  assert.deepEqual(parseDeviceRef("scribe:@Work-Laptop/board#card=12"), { device: "work-laptop", kind: "page", ref: "board" });
  assert.deepEqual(parseDeviceRef("thread:@laptop/th_abc"), { device: "laptop", kind: "thread", ref: "th_abc" });
  assert.deepEqual(parseDeviceRef("scribe:@a1b2c3d4e5f6/scribe:notes"), { device: "a1b2c3d4e5f6", kind: "page", ref: "notes" });
  for (const other of ["scribe:notes", "thread:th_abc", "https://x.dev/@a/b", "scribe:@laptop/", "file:///C:/x"]) assert.equal(parseDeviceRef(other), null, other);
});

test("a device is found by id, by its name as a slug, then by a name it had before", () => {
  const devices = [
    { id: "aaaaaaaaaaaa", name: "Desktop" },
    { id: "bbbbbbbbbbbb", name: "Work laptop", formerNames: ["Old Laptop"] },
  ];
  assert.equal(deviceSlug("Work laptop"), "work-laptop");
  assert.equal(deviceSlug("Työkone 2"), "tyokone-2");
  assert.equal(findDevice("bbbbbbbbbbbb", devices)?.name, "Work laptop");
  assert.equal(findDevice("work-laptop", devices)?.id, "bbbbbbbbbbbb");
  assert.equal(findDevice("old-laptop", devices)?.id, "bbbbbbbbbbbb");
  assert.equal(findDevice("desktop", devices)?.id, "aaaaaaaaaaaa");
  assert.equal(findDevice("phone", devices), undefined);
  assert.deepEqual(rememberName(undefined, "Laptop", "Work laptop"), ["Laptop"]);
  assert.deepEqual(rememberName(["Work laptop", "X"], "Laptop", "Work laptop"), ["Laptop", "X"]);
  assert.equal(rememberName(undefined, "Laptop", "laptop"), undefined, "a change of case keeps the same links");
});

type Node = { peers: PeerService; server: http.Server; port: number; id: string; pages: Record<string, string>; threads: Record<string, string>; watcher: AskWatcher };
const nodes: Node[] = [];

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function node(pages: Record<string, string>, threads: Record<string, string> = {}): Promise<Node> {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-ref-"));
  const peers = new PeerService({ home, port: await freePort(), hosts: ["127.0.0.1"], version: "1.0.0" });
  const entry = { peers, port, id: peers.identity.id, pages, threads, watcher: new AskWatcher(peers) } as Node;
  const devices = express.Router();
  devices.use("/api/devices", express.json(), devicesRouter(peers, {
    spaces: () => ({ spaces: [], activeId: null, deleted: [] }) as unknown as SpacesView,
    switchSpace: () => undefined,
    asks: new AskSource(() => []),
    watcher: entry.watcher,
    describe: (keys, ids) => ({
      pages: Object.fromEntries(keys.map((key) => [key, entry.pages[key] ? { id: `t_${key}`, key, title: entry.pages[key] } : null])),
      threads: Object.fromEntries(ids.map((id) => [id, entry.threads[id] ? { title: entry.threads[id] } : null])),
    }),
  }));
  const app = express();
  app.use(peerGateway(peers, { version: "1.0.0", port, local: (_req, _res, next) => next(), devices }).http);
  app.use(contentOriginGate);
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

async function resolveOn(to: Node, host: string, targets: string[]): Promise<Record<string, Record<string, unknown>>> {
  const body = JSON.stringify({ targets });
  // The board sends its origin; through the gateway it must be that gateway board (a local tool sends none).
  const origin = host.startsWith("d-") ? { origin: `http://${host}:${to.port}` } : {};
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: to.port,
      method: "POST",
      path: "/api/devices/resolve",
      headers: { host: `${host}:${to.port}`, ...origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode !== 200) reject(new Error(`${res.statusCode} ${text}`));
        else resolve(JSON.parse(text).targets);
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

let a: Node;
let b: Node;

before(async () => {
  a = await node({ notes: "Desktop notes" });
  b = await node({ "thesis-plan": "Thesis plan", board: "Travel board" }, { th_b1: "Thesis chat" });
  b.peers.rename("Work laptop");
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

test("A resolves B's pages, cards and threads over the link, by name or id", async () => {
  const got = await resolveOn(a, "127.0.0.1", [
    "scribe:@work-laptop/thesis-plan",
    `scribe:@${b.id}/board#card=12`,
    "thread:@work-laptop/th_b1",
    "scribe:@work-laptop/gone",
    "scribe:@phone/notes",
    "scribe:notes",
  ]);
  const device = { id: b.id, name: "Work laptop" };
  assert.deepEqual(got["scribe:@work-laptop/thesis-plan"], { device, online: true, title: "Thesis plan", key: "thesis-plan" });
  assert.deepEqual(got[`scribe:@${b.id}/board#card=12`], { device, online: true, title: "Travel board", key: "board" });
  assert.deepEqual(got["thread:@work-laptop/th_b1"], { device, online: true, title: "Thesis chat" });
  assert.deepEqual(got["scribe:@work-laptop/gone"], { device, online: true, missing: true });
  assert.deepEqual(got["scribe:@phone/notes"], { unknown: true });
  assert.equal(got["scribe:notes"], undefined, "local keys are the board's own business");
});

test("a link to the device whose UI is showing is a local one; from B's view, A's page resolves on A", async () => {
  const fromB = await resolveOn(a, `d-${b.id}.localhost`, ["scribe:@work-laptop/thesis-plan", `scribe:@${a.id}/notes`]);
  assert.deepEqual(fromB["scribe:@work-laptop/thesis-plan"], { here: true, device: { id: b.id, name: "Work laptop" } });
  assert.deepEqual(fromB[`scribe:@${a.id}/notes`], { device: { id: a.id, name: a.peers.identity.name }, online: true, title: "Desktop notes", key: "notes" });
  const local = await resolveOn(a, "127.0.0.1", [`scribe:@${a.id}/notes`]);
  assert.equal(local[`scribe:@${a.id}/notes`].here, true);
});

test("after a rename the old name still resolves; offline, the last title seen stays with the device's name", async () => {
  b.peers.rename("Laptop");
  await until(() => a.peers.view().peers[0].name === "Laptop", "the new name");
  let got = await resolveOn(a, "127.0.0.1", ["scribe:@work-laptop/thesis-plan", "scribe:@laptop/thesis-plan"]);
  assert.equal(got["scribe:@work-laptop/thesis-plan"].title, "Thesis plan");
  assert.equal(got["scribe:@laptop/thesis-plan"].title, "Thesis plan");
  await b.peers.stop();
  await until(() => !a.peers.view().peers[0].online, "B offline");
  got = await resolveOn(a, "127.0.0.1", ["scribe:@laptop/thesis-plan", "scribe:@laptop/never-seen"]);
  assert.deepEqual(got["scribe:@laptop/thesis-plan"], { device: { id: b.id, name: "Laptop" }, online: false, title: "Thesis plan" });
  assert.deepEqual(got["scribe:@laptop/never-seen"], { device: { id: b.id, name: "Laptop" }, online: false });
});
