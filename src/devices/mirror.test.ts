import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { buildExport, type BoardExportFile } from "../boardExport.js";
import { contentOriginGate } from "../contentOrigin.js";
import type { Tab } from "../types.js";
import { peerGateway } from "./gateway.js";
import { MirrorPusher, MirrorStore, mirrorRouter, mirrorView, type MirrorCatalog, type MirrorSource } from "./mirror.js";
import { PeerService } from "./peers.js";

/**
 * The offline mirror (#910), with three daemons on loopback: B (the owner) pushes to R (always on), and
 * A views B through its gateway. Syncs send only what changed; while B is offline, A's gateway serves B's
 * hosts from R's mirror, read only.
 */
type Node = {
  peers: PeerService;
  server: http.Server;
  port: number;
  id: string;
  store: MirrorStore;
  pusher: MirrorPusher;
  pages: Map<string, Tab>;
  /** Mirror requests that came in over the link, to see what crossed it. */
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

function tab(id: string, html: string, revision: number): Tab {
  return { id, key: id.replace("t_", "page-"), title: `Page ${id}`, html, state: { n: revision }, createdAt: 1, updatedAt: 2, revision, stateRevision: 1, assets: [{ name: "logo.png", mimeType: "image/png" }] } as unknown as Tab;
}

async function node(): Promise<Node> {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-mirror-"));
  const peers = new PeerService({ home, port: await freePort(), hosts: ["127.0.0.1"], version: "1.0.0" });
  const pages = new Map<string, Tab>();
  const listeners: Array<() => void> = [];
  const source: MirrorSource = {
    catalog: (): MirrorCatalog => ({
      spaces: [{ id: "s_main", name: "Main", color: "blue", tabs: [...pages.keys()] }],
      folders: [{ id: "f_1", parentId: null, name: "Notes" }],
      pages: [...pages.values()].map((t) => ({ id: t.id, key: t.key, title: t.title, updatedAt: t.updatedAt })).concat([{ id: "t_closed", key: "closed", title: "Closed page", updatedAt: 1 }]),
      templates: [],
    }),
    pages: () => new Map([...pages.values()].map((t) => [t.id, `${t.revision}`])),
    exportPages: (ids) => JSON.parse(JSON.stringify(buildExport(ids.map((id) => ({ tab: pages.get(id)!, assets: [{ name: "logo.png", mimeType: "image/png", buffer: IMAGE }] }))))) as BoardExportFile,
    onChange: (listener) => listeners.push(listener),
  };
  const store = new MirrorStore(home);
  const pusher = new MirrorPusher(peers, source, home);
  const local: express.RequestHandler = (req, res, next) => (req.path === "/kit.js" ? res.type("js").send("// kit") : next());
  const view = mirrorView(peers, store, {
    local,
    render: (t) => `<!doctype html><title>${t.title}</title><script>window.__SCRIBE_BOOT__=${JSON.stringify({ id: t.id, state: t.state })}</script>${t.html}`,
  });
  const gateway = peerGateway(peers, { version: "1.0.0", port, local, mirror: view });
  const entry = { peers, port, id: peers.identity.id, store, pusher, pages, seen: [] } as unknown as Node;
  const app = express();
  app.use((req, _res, next) => {
    if (req.path.startsWith("/api/mirror/")) entry.seen.push(`${req.method} ${req.path}`);
    next();
  });
  app.use(gateway.http);
  app.use(contentOriginGate);
  app.use("/api/mirror", mirrorRouter(peers, pusher, store));
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

function get(to: Node, host: string, pathname: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
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
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

let a: Node;
let b: Node;
let r: Node;

before(async () => {
  r = await node();
  a = await node();
  b = await node();
  for (const other of [a, b]) {
    const offer = (await r.peers.createOffer())!;
    await other.peers.pair(offer.code);
    await until(() => !!other.peers.linkTo(r.id) && !!r.peers.linkTo(other.id), "the link to R");
  }
  r.peers.introduce(a.id, [b.id]);
  await until(() => !!a.peers.linkTo(b.id), "A and B linked");
});

after(async () => {
  for (const entry of nodes) {
    entry.pusher.stop();
    await entry.peers.stop();
    entry.store.close();
    entry.server.closeAllConnections();
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
  }
});

test("the owner pushes only what changed, and the mirror drops pages that left", async () => {
  b.pages.set("t_aa11", tab("t_aa11", "<p>Plan</p>", 1));
  b.pages.set("t_bb22", tab("t_bb22", "<p>Notes</p>", 1));
  assert.throws(() => b.pusher.update({ to: "000000000000" }), /paired device/);
  b.pusher.update({ to: r.id });
  await b.pusher.sync();
  assert.equal(b.pusher.view().error, undefined);
  assert.deepEqual([...r.store.mirrored(b.id)].sort(), ["t_aa11", "t_bb22"]);
  assert.equal(r.store.device(b.id)?.catalog.pages.length, 3);
  // A learns that R keeps B's mirror.
  await until(() => a.peers.view().peers.length > 0 && r.peers.view().peers.length === 2 && a.peers.supports(r.id, "mirror"), "features");
  assert.equal(a.peers.view().peers.find((p) => p.id === b.id)?.mirror, undefined, "B is online: its own UI, not the mirror");

  // Nothing changed: one small request. (Let the sync that update() started settle first.)
  await new Promise((resolve) => setTimeout(resolve, 100));
  await b.pusher.sync();
  r.seen.length = 0;
  await b.pusher.sync();
  assert.deepEqual(r.seen, ["POST /api/mirror/incoming/sync"]);

  // One page changed: only it travels; the image is already there, so no blob does.
  r.seen.length = 0;
  b.pages.set("t_aa11", tab("t_aa11", "<p>Plan v2</p>", 2));
  await b.pusher.sync();
  assert.ok(!r.seen.some((line) => line.startsWith("PUT")), r.seen.join(", "));
  assert.equal(r.store.page(b.id, "t_aa11")?.html, "<p>Plan v2</p>");

  b.pages.delete("t_bb22");
  await b.pusher.sync();
  assert.deepEqual([...r.store.mirrored(b.id)], ["t_aa11"]);
});

test("while the owner is offline, the viewer's gateway shows its mirror, read only", async () => {
  await b.peers.stop();
  await until(() => !a.peers.linkTo(b.id), "B offline for A");
  await until(() => a.peers.mirrorOf(b.id)?.holder === r.id, "A knows R's mirror of B");
  assert.equal(a.peers.view().peers.find((p) => p.id === b.id)?.mirror?.id, r.id);

  const board = await get(a, `d-${b.id}.localhost`, "/");
  assert.equal(board.status, 200);
  assert.match(board.body, /mirror/);
  assert.match(board.body, /Closed page/);

  const host = `t-aa11.d-${b.id}.localhost`;
  const page = await get(a, host, "/view/t_aa11");
  assert.equal(page.status, 200);
  assert.match(page.body, /Plan v2/);
  const image = await get(a, host, "/view/t_aa11/asset/logo.png");
  assert.equal(image.status, 200);
  const state = await get(a, host, "/api/tabs/t_aa11/state");
  assert.deepEqual(JSON.parse(state.body).state, { n: 2 });
  // Another page's id on this page's origin, and a page that is only in the catalog, are not served.
  assert.equal((await get(a, host, "/view/t_bb22")).status, 404);
  assert.equal((await get(a, `t-closed.d-${b.id}.localhost`, "/view/t_closed")).status, 404);
  const write = await get(a, host, "/api/tabs/t_aa11/state", { method: "POST", headers: { "content-type": "application/json", origin: `http://${host}:${a.port}` }, body: "{}" });
  assert.equal(write.status, 403);
  assert.match(JSON.parse(write.body).error, /Read only/);
  assert.equal((await get(a, host, "/kit.js")).body, "// kit");
});
