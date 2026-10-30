import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { buildExport, type BoardExportFile, type ParsedImport } from "../boardExport.js";
import { contentOriginGate } from "../contentOrigin.js";
import { zip } from "../plugins/package.js";
import type { Tab } from "../types.js";
import { copyRouter, type CopyHost } from "./copy.js";
import { PeerService } from "./peers.js";

/**
 * Copy to another device (#907): two daemons on loopback with the copy router and a fake store.
 * Blobs go by hash and only the missing ones travel; the target records where the copy came from
 * using the link's device; plugins wait for review.
 */
type Node = {
  peers: PeerService;
  server: http.Server;
  port: number;
  id: string;
  home: string;
  imports: ParsedImport[];
  received: number;
  plugins: Map<string, { name: string; version: string; hash: string }>;
  /** Paths of the incoming requests, to see what crossed the link. */
  seen: string[];
};
const nodes: Node[] = [];

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const IMAGE = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PLUGIN = zip({ "plugin.json": Buffer.from(JSON.stringify({ id: "demo", name: "Demo", version: "1.0.0" })) });

function tab(key: string, html: string, revision: number): Tab {
  return { id: `t_${key}`, key, title: key, html, state: { n: 1 }, createdAt: 1, updatedAt: 2, revision, assets: [], provenance: { created: { at: 1, thread: "th_x", title: "Made it" } } } as unknown as Tab;
}

async function node(): Promise<Node> {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-copy-"));
  const peers = new PeerService({ home, port: await freePort(), hosts: ["127.0.0.1"], version: "1.0.0" });
  const entry = { peers, port, id: peers.identity.id, home, imports: [], received: 0, plugins: new Map(), seen: [] } as unknown as Node;
  const pages = new Map([["plan", tab("plan", '<meta name="scribe-plugins" content="demo"><p>Plan</p>', 14)], ["notes", tab("notes", "<p>Notes</p>", 3)]]);
  const host: CopyHost = {
    exportFile: (scope) => {
      const chosen = [...pages.values()].filter((t) => scope.pageIds?.includes(t.id));
      if (!chosen.length) throw new Error("nothing to export");
      return JSON.parse(JSON.stringify(buildExport(chosen.map((t) => ({ tab: t, assets: [{ name: "logo.png", mimeType: "image/png", buffer: IMAGE }] }))))) as BoardExportFile;
    },
    importBoard: (parsed) => {
      entry.imports.push(parsed);
      return { tabs: parsed.pages.map((p) => ({ id: `t_new_${p.key}` }) as Tab), templatesCreated: 0, templatesReused: 0 };
    },
    revision: (key) => pages.get(key)?.revision,
    plugin: (id) => entry.plugins.get(id),
    exportPlugin: () => PLUGIN,
    previewPlugin: (files) => {
      const manifest = JSON.parse(files["plugin.json"].toString()) as { id: string; name: string; version: string };
      return { manifest, same: entry.plugins.has(manifest.id) };
    },
    received: () => { entry.received++; },
  };
  const app = express();
  app.use((req, _res, next) => { entry.seen.push(`${req.method} ${req.path}`); next(); });
  app.use(contentOriginGate);
  app.use("/api/copy", copyRouter(peers, host, home));
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

function call(to: Node, pathname: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: to.port,
      method: options.method ?? "GET",
      path: pathname,
      headers: { host: `127.0.0.1:${to.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", ...options.headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
    });
    req.on("error", reject);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

let a: Node;
let b: Node;

before(async () => {
  a = await node();
  b = await node();
  a.plugins.set("demo", { name: "Demo", version: "1.0.0", hash: "code1" });
  const offer = (await b.peers.createOffer())!;
  await a.peers.pair(offer.code);
  await until(() => a.peers.view().peers.every((peer) => peer.online) && b.peers.view().peers.every((peer) => peer.online), "the link");
});

after(async () => {
  for (const entry of nodes) {
    await entry.peers.stop();
    entry.server.closeAllConnections();
    await new Promise((resolve) => entry.server.close(resolve));
  }
});

test("targets lists the paired devices", async () => {
  const reply = await call(a, "/api/copy/targets");
  assert.equal(reply.status, 200);
  assert.equal(reply.body.self.id, a.id);
  assert.deepEqual(reply.body.devices.map((d: { id: string; online: boolean }) => [d.id, d.online]), [[b.id, true]]);
});

test("a copy imports on the target as a fork that names its source, with the plugin waiting for review", async () => {
  const reply = await call(a, "/api/copy", { method: "POST", body: { device: b.id, pages: ["t_plan", "t_notes"] } });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.pages, 2);
  assert.deepEqual(reply.body.plugins, [{ id: "demo", name: "Demo", version: "1.0.0" }]);
  // The same image on both pages crosses once; so does the plugin archive.
  assert.equal(b.seen.filter((line) => line.startsWith("PUT /api/copy/incoming/blobs/")).length, 2);
  assert.equal(reply.body.sent, IMAGE.length + PLUGIN.length);
  assert.equal(reply.body.skipped, 0);
  const parsed = b.imports[0];
  assert.deepEqual(parsed.pages.map((p) => [p.key, p.assets?.[0]?.buffer.equals(IMAGE)]), [["plan", true], ["notes", true]]);
  const source = parsed.pages[0].provenance?.copiedFrom;
  assert.equal(source?.device, a.id);
  assert.equal(source?.name, a.peers.identity.name);
  assert.equal(source?.key, "plan");
  assert.equal(source?.revision, 14);
  assert.equal(parsed.pages[0].provenance?.created?.thread, undefined, "thread ids stay on their device");
  assert.equal(parsed.pages[0].provenance?.created?.title, "Made it");
  assert.equal(b.received, 1);

  const waiting = await call(b, "/api/copy/plugins");
  assert.deepEqual(waiting.body.plugins.map((p: { id: string; from: { id: string } }) => [p.id, p.from.id]), [["demo", a.id]]);
  const one = await call(b, "/api/copy/plugins/demo");
  assert.equal(Buffer.from(one.body.archive, "base64").equals(PLUGIN), true);
  await call(b, "/api/copy/plugins/demo", { method: "DELETE" });
  assert.deepEqual((await call(b, "/api/copy/plugins")).body.plugins, []);
});

test("copying again sends no blobs, and a plugin the target has is not sent", async () => {
  b.seen = [];
  b.plugins.set("demo", { name: "Demo", version: "1.0.0", hash: "code1" });
  const reply = await call(a, "/api/copy", { method: "POST", body: { device: b.id, pages: ["t_plan"] } });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.sent, 0);
  assert.deepEqual(reply.body.pluginsPresent, ["demo"]);
  assert.deepEqual(reply.body.plugins, []);
  assert.equal(b.seen.some((line) => line.startsWith("PUT")), false);
});

test("only paired devices send copies, and only the board starts one", async () => {
  const direct = await call(b, "/api/copy/incoming/check", { method: "POST", body: { hashes: [] } });
  assert.equal(direct.status, 403, "not over a link");
  const foreign = await call(a, "/api/copy", { method: "POST", headers: { origin: "http://evil.example" }, body: { device: b.id, pages: ["t_plan"] } });
  assert.equal(foreign.status, 403);
  const self = await call(a, "/api/copy", { method: "POST", body: { device: a.id, pages: ["t_plan"] } });
  assert.equal(self.status, 400);
});
