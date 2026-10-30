import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// The thread tokens come from a secret in the data folder: a folder of this test's own.
process.env.SCRIBE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-agentaccess-"));

const express = (await import("express")).default;
const { identify, threadToken } = await import("../callers.js");
const { THREAD_HEADER, THREAD_TOKEN_HEADER, CLIENT_HEADER, AGENT_CLIENT } = await import("../config.js");
const { pageReach } = await import("../pageAccess.js");
const { AskSource, AskWatcher, asksOf } = await import("./attention.js");
const { PeerService } = await import("./peers.js");
const { devicesRouter } = await import("./routes.js");
const access = await import("./agentAccess.js");
const { agentForwarder, remoteAgentGate, remoteAgentRouter } = await import("./agentRoutes.js");
type AgentDevicesHost = import("./agentRoutes.js").AgentDevicesHost;
type SpacesView = import("../spaces.js").SpacesView;

/** Agents on other devices (#911): what may cross, the remote chat's reader, and two daemons on loopback. */

test("only page reads, page writes, board actions and helpers cross devices", () => {
  const kind = access.remoteRequestKind;
  assert.equal(kind("GET", "/api/library"), "read");
  assert.equal(kind("GET", "/api/search/semantic"), "read");
  assert.equal(kind("GET", "/api/tabs/t_1"), "read");
  assert.equal(kind("GET", "/api/tabs/t_1/state"), "read");
  assert.equal(kind("GET", "/api/tabs/t_1/guide"), "read");
  assert.equal(kind("POST", "/api/tabs/t_1/action"), "action");
  assert.equal(kind("POST", "/api/tabs/t_1/patch"), "write");
  assert.equal(kind("PUT", "/api/tabs/t_1/state"), "write");
  assert.equal(kind("POST", "/api/helper/run"), "run");
  for (const [method, p] of [["GET", "/api/tabs/t_1/file"], ["POST", "/api/tabs"], ["DELETE", "/api/tabs/t_1"], ["POST", "/api/copy/incoming"], ["GET", "/api/devices"], ["POST", "/api/page-access"], ["POST", "/api/agent/approvals/x"], ["GET", "/api/tabs"]]) {
    assert.equal(kind(method, p), null, `${method} ${p}`);
  }
});

test("the remote agent header round-trips and drops what it should not carry", () => {
  const agent = { thread: "th_a", title: "Notes chat", trusted: true, rung: "edits", grants: [{ kind: "page" as const, id: "t_1" }], keys: ["scribe:plan"] };
  assert.deepEqual(access.decodeRemoteAgent(access.encodeRemoteAgent(agent)), agent);
  // A mention is the user's own @ in a chat here, never something another device's chat brings along.
  const mention = access.decodeRemoteAgent(access.encodeRemoteAgent({ ...agent, grants: [{ kind: "page", id: "t_2", mention: true } as never] }));
  assert.deepEqual(mention?.grants, []);
  assert.equal(access.decodeRemoteAgent("not json"), undefined);
  assert.equal(access.decodeRemoteAgent(Buffer.from(JSON.stringify({ trusted: true })).toString("base64url")), undefined, "no thread");
});

test("keys on other devices in a message", () => {
  assert.deepEqual(access.deviceKeysInText("see scribe:@Laptop/thesis-plan and [x](scribe:@work-laptop/board#card=3), not scribe:notes"), [
    { device: "laptop", key: "scribe:thesis-plan" },
    { device: "work-laptop", key: "scribe:board" },
  ]);
});

test("a remote chat reaches pages like a chat with no scope: ask, its grants, written keys, Open to all agents", () => {
  const lookup = { folderChain: () => [], folderAccess: () => undefined, pageFolder: () => undefined, pageAccess: () => undefined };
  const agent = { thread: "th_a", trusted: false, rung: "edits", grants: [{ kind: "page" as const, id: "t_granted" }], keys: ["scribe:named"] };
  const reader = access.remoteReader("dev_a", agent, (key) => (key === "scribe:named" ? "t_named" : undefined));
  assert.equal(reader.thread, "@dev_a/th_a");
  assert.equal(pageReach(reader, { id: "t_other" }, lookup), "ask");
  assert.equal(pageReach(reader, { id: "t_granted" }, lookup), "allow");
  assert.equal(pageReach(reader, { id: "t_named" }, lookup, true), "allow", "a written key reads");
  assert.equal(pageReach(reader, { id: "t_named" }, lookup, false), "ask", "but does not change");
  assert.equal(pageReach(reader, { id: "t_open", access: { level: "public" } }, lookup), "allow");
  assert.equal(pageReach(reader, { id: "t_trusted", access: { level: "trusted" } }, lookup), "request", "an untrusted model asks by key only");
  assert.equal(pageReach(reader, { id: "t_hidden", agentHidden: true }, lookup), "hidden");
  assert.equal(pageReach({ ...reader, trusted: true }, { id: "t_trusted", access: { level: "trusted" } }, lookup), "ask", "trust follows the model on its own device");
  const workspace = access.remoteReader("dev_a", { ...agent, noPages: true }, () => undefined);
  assert.equal(pageReach(workspace, { id: "t_granted" }, lookup), "hidden");
});

test("approvals carry their answers to the toast; questions don't", () => {
  const asks = asksOf([
    { id: "th_1", title: "Fix", status: "waiting", asking: { kind: "approval", title: "Run npm test", itemId: "it_1", options: [{ id: "allow", label: "Allow once", kind: "allow_once" }] } },
    { id: "th_2", title: "Ask", status: "waiting", asking: { kind: "question", title: "Which?", itemId: "it_2" } },
  ]);
  assert.deepEqual(asks[0].options, [{ id: "allow", label: "Allow once", kind: "allow_once" }]);
  assert.equal(asks[0].request, "it_1");
  assert.equal(asks[1].request, undefined);
});

type Node = {
  peers: InstanceType<typeof PeerService>;
  server: http.Server;
  port: number;
  id: string;
  watcher: InstanceType<typeof AskWatcher>;
  seen: Array<Record<string, unknown>>;
  calls: Array<[string, ...unknown[]]>;
};
const nodes: Node[] = [];

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function node(): Promise<Node> {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-agentaccess-node-"));
  const peers = new PeerService({ home, port: await freePort(), hosts: ["127.0.0.1"], version: "1.0.0" });
  const entry = { peers, port, id: peers.identity.id, watcher: new AskWatcher(peers), seen: [], calls: [] } as unknown as Node;
  const host: AgentDevicesHost = {
    remoteAgent: (thread, device, writtenFor) => ({ thread, title: "Notes chat", trusted: false, rung: thread === "th_ro" ? "readonly" : "edits", grants: [], keys: writtenFor("laptop") ? ["scribe:plan"] : [] }),
    pageAccess: async (thread, device, page, opts) => {
      entry.calls.push(["pageAccess", thread, device.name, page, opts.folder]);
      return { allowed: true, message: "Allowed" };
    },
    helperAccess: async (thread, device, folder, requested) => {
      entry.calls.push(["helperAccess", thread, device.name, folder, requested]);
      return "edits";
    },
    taint: (thread) => entry.calls.push(["taint", thread]),
    describePage: (_req, which) => (which === "plan" ? { id: "t_plan", key: "plan", title: "Plan", reach: "ask" } : null),
  };
  const app = express();
  app.use(remoteAgentGate(peers));
  app.use("/api/devices", express.json(), devicesRouter(peers, {
    spaces: () => ({ spaces: [], activeId: null, deleted: [] }) as unknown as SpacesView,
    switchSpace: () => undefined,
    asks: new AskSource(() => []),
    watcher: entry.watcher,
    answerApproval: (request, optionId) => entry.calls.push(["answer", request, optionId]),
  }));
  app.use(express.json());
  app.use("/api/remote-agent", remoteAgentRouter(peers, () => host));
  app.use(agentForwarder(peers, () => host));
  // Stand-ins for the page routes: what the caller looks like here, and what the gate left for the route.
  const record = (req: import("express").Request, res: import("express").Response) => {
    const caller = identify(req);
    entry.seen.push({ path: req.path, viewer: caller.viewer, thread: caller.thread, device: caller.device, keys: caller.remote?.keys, readOnly: res.locals.readOnlyReach, body: req.body });
    if (req.query.taint) res.setHeader(access.TAINT_HEADER, "1");
    res.json({ ok: true, here: entry.id });
  };
  app.get(["/api/library", "/api/tabs/:id"], record);
  app.post(["/api/tabs/:id/action", "/api/tabs/:id/patch", "/api/helper/run", "/api/copy/incoming"], record);
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

/** A call to a node's daemon: as a chat's MCP (thread), or as a local tool or the board. */
async function call(to: Node, method: string, p: string, opts: { thread?: string; device?: string; body?: unknown; board?: boolean } = {}): Promise<{ status: number; data: Record<string, unknown> }> {
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = { host: `127.0.0.1:${to.port}` };
  if (opts.thread) Object.assign(headers, { [THREAD_HEADER]: opts.thread, [THREAD_TOKEN_HEADER]: threadToken(opts.thread), [CLIENT_HEADER]: AGENT_CLIENT });
  if (opts.board) headers["sec-fetch-site"] = "same-origin";
  if (opts.device) headers[access.DEVICE_HEADER] = encodeURIComponent(opts.device);
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: to.port, method, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(text); } catch { data = { text }; }
        resolve({ status: res.statusCode ?? 0, data });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

let a: Node;
let b: Node;

before(async () => {
  a = await node();
  b = await node();
  b.peers.rename("Laptop");
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

test("off by default: B refuses A's agents until its user turns access on", async () => {
  const got = await call(a, "GET", "/api/library?query=x", { thread: "th_1", device: "laptop" });
  assert.equal(got.status, 403);
  assert.match(String(got.data.error), /Laptop does not let agents on this device read its pages/);
  assert.equal(b.seen.length, 0);
  const list = await call(a, "GET", "/api/remote-agent/devices", { thread: "th_1" });
  assert.deepEqual(list.data.devices, [{ id: b.id, name: "Laptop", online: true, grants: { read: false, write: false, run: false } }]);
});

test("with read on, A's chat reads as an agent on B, with the keys its user wrote for that device", async () => {
  b.peers.setAgentGrant(a.id, { read: true });
  const got = await call(a, "GET", "/api/tabs/t_plan?taint=1", { thread: "th_1", device: "Laptop" });
  assert.equal(got.status, 200);
  assert.equal(got.data.here, b.id);
  const seen = b.seen.at(-1)!;
  assert.equal(seen.viewer, "agent");
  assert.equal(seen.thread, `@${a.id}/th_1`);
  assert.equal(seen.device, a.id);
  assert.deepEqual(seen.keys, ["scribe:plan"]);
  assert.deepEqual(a.calls.at(-1), ["taint", "th_1"], "Trusted only content read there taints the chat here");
  // A board action answers its reads, its changes refused; a page write is refused outright.
  await call(a, "POST", "/api/tabs/t_plan/action", { thread: "th_1", device: "laptop", body: { action: "list" } });
  assert.match(String(b.seen.at(-1)!.readOnly), /does not let agents on this device change its pages/);
  const write = await call(a, "POST", "/api/tabs/t_plan/patch", { thread: "th_1", device: "laptop", body: { edits: [] } });
  assert.equal(write.status, 403);
});

test("with write on, a page write goes through, but not for a Read-only chat", async () => {
  b.peers.setAgentGrant(a.id, { write: true });
  assert.equal((await call(a, "POST", "/api/tabs/t_plan/patch", { thread: "th_1", device: "laptop", body: { edits: [] } })).status, 200);
  assert.equal((await call(a, "POST", "/api/tabs/t_plan/patch", { thread: "th_ro", device: "laptop", body: { edits: [] } })).status, 403);
  await call(a, "POST", "/api/tabs/t_plan/action", { thread: "th_1", device: "laptop", body: { action: "move" } });
  assert.equal(b.seen.at(-1)!.readOnly, undefined);
});

test("nothing else crosses: other routes, callers that are not chats, and link calls past the gate", async () => {
  assert.equal((await call(a, "POST", "/api/copy/incoming", { thread: "th_1", device: "laptop", body: {} })).status, 400);
  assert.equal((await call(a, "GET", "/api/library", { device: "laptop" })).status, 403, "no chat thread");
  assert.equal((await call(a, "GET", "/api/library", { thread: "th_1", device: "phone" })).status, 404);
  // Straight over the link with the remote-agent header: B's gate refuses what is not an agent call.
  const agent = access.encodeRemoteAgent({ thread: "th_1", trusted: true, rung: "full", grants: [], keys: [] });
  const direct = await a.peers.request(b.id, { method: "POST", path: "/api/copy/incoming", headers: { host: "127.0.0.1", "content-type": "application/json", [access.REMOTE_AGENT_HEADER]: agent }, body: "{}" });
  assert.equal(direct.status, 403);
  const devices = await a.peers.request(b.id, { method: "GET", path: "/api/devices", headers: { host: "127.0.0.1", [access.REMOTE_AGENT_HEADER]: agent } });
  assert.equal(devices.status, 403);
});

test("page_access for a page on B asks in A's chat about the page B describes", async () => {
  const got = await call(a, "POST", "/api/page-access", { thread: "th_1", device: "laptop", body: { page: "plan", folder: false } });
  assert.deepEqual(got.data, { allowed: true, message: "Allowed" });
  assert.deepEqual(a.calls.at(-1), ["pageAccess", "th_1", "Laptop", { id: "t_plan", key: "plan", title: "Plan", reach: "ask" }, false]);
  assert.equal((await call(a, "POST", "/api/page-access", { thread: "th_1", device: "laptop", body: { page: "gone" } })).status, 404);
});

test("helpers on B need its run switch, a folder, and the rung A's chat approved", async () => {
  const off = await call(a, "POST", "/api/helper/run", { thread: "th_1", device: "laptop", body: { task: "x", title: "T", cwd: "S:\\site" } });
  assert.equal(off.status, 403);
  assert.match(String(off.data.error), /run helpers/);
  b.peers.setAgentGrant(a.id, { run: true });
  assert.equal((await call(a, "POST", "/api/helper/run", { thread: "th_1", device: "laptop", body: { task: "x", title: "T" } })).status, 400, "no folder");
  const ran = await call(a, "POST", "/api/helper/run", { thread: "th_1", device: "laptop", body: { task: "x", title: "T", cwd: "S:\\site", access: "full" } });
  assert.equal(ran.status, 200);
  assert.deepEqual(a.calls.at(-1), ["helperAccess", "th_1", "Laptop", "S:\\site", "full"]);
  assert.equal((b.seen.at(-1)!.body as Record<string, unknown>).access, "edits");
});

test("Settings → Devices shows and saves the grant; an approval on B is answered from a toast on A", async () => {
  const view = b.peers.view();
  assert.deepEqual(view.peers[0].agents, { read: true, write: true, run: true });
  const saved = await call(b, "PUT", `/api/devices/${a.id}/agents`, { board: true, body: { write: false } });
  assert.equal(saved.status, 200);
  assert.deepEqual(b.peers.agentGrant(a.id), { read: true, write: false, run: true });
  const answered = await call(a, "POST", `/api/devices/${b.id}/approvals/it_9`, { board: true, body: { optionId: "allow" } });
  assert.equal(answered.status, 200);
  assert.deepEqual(b.calls.at(-1), ["answer", "it_9", "allow"]);
  assert.equal((await call(a, "POST", `/api/devices/${b.id}/approvals/it_9`, { thread: "th_1", body: { optionId: "allow" } })).status, 403, "never an agent");
});
