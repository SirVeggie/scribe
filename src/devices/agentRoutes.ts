import express, { Router } from "express";
import { identify } from "../callers.js";
import { peerDeviceOf } from "./link.js";
import type { PeerService } from "./peers.js";
import { findDevice } from "./references.js";
import {
  DEVICE_HEADER,
  REMOTE_AGENT_HEADER,
  TAINT_HEADER,
  encodeRemoteAgent,
  remoteActionReadOnly,
  remoteRefusal,
  remoteRequestKind,
  type AgentGrant,
  type RemoteAgent,
} from "./agentAccess.js";

/** A page on the other device, as page_access asks the user about it. */
export type RemotePage = { id: string; key: string; title: string; folderId?: string; folder?: string | null; reach: string };

/** What the routes need from the agent host (on A) and the page store (on B). */
export type AgentDevicesHost = {
  /** A: the chat as the other device should see it; a string says why it cannot go. */
  remoteAgent(thread: string, device: string, writtenFor: (token: string) => boolean): RemoteAgent | string;
  /** A: ask the user in the chat to let it reach a page on another device. */
  pageAccess(thread: string, device: { id: string; name: string }, page: RemotePage, opts: { folder?: boolean; importance?: string; reason?: string; signal: AbortSignal }): Promise<{ allowed: boolean; message: string }>;
  /** A: the rung a helper on another device gets, asking the user once per folder; throws when refused. */
  helperAccess(thread: string, device: { id: string; name: string }, folder: string, access: string | undefined, signal: AbortSignal): Promise<string>;
  /** A: the chat read Trusted only or Restricted content on another device. */
  taint(thread: string): void;
  /** B: a page as the remote agent's request may see it, or null when it may not know of it. */
  describePage(req: express.Request, which: string): RemotePage | null;
};

const LIST_TIMEOUT_MS = 3000;

/**
 * On B, before every route (#911): a link request from another device's agent goes on only for the
 * calls agents may make across devices, and only as far as this device's grant for that device goes.
 */
export function remoteAgentGate(peers: PeerService): express.RequestHandler {
  return (req, res, next) => {
    const caller = identify(req);
    if (!caller.remote || !caller.device) {
      next();
      return;
    }
    const kind = remoteRequestKind(req.method, req.path);
    if (!kind) {
      res.status(403).json({ error: "Agents on other devices can't do this here." });
      return;
    }
    const grant = peers.agentGrant(caller.device);
    const name = peers.identity.name;
    const refusal = remoteRefusal(kind, grant, caller.remote.rung, name);
    if (refusal) {
      res.status(403).json({ error: refusal });
      return;
    }
    if (kind === "action") {
      const readOnly = remoteActionReadOnly(grant, caller.remote.rung, name);
      if (readOnly) res.locals.readOnlyReach = readOnly;
    }
    next();
  };
}

/**
 * On A: a chat's call that names another device (DEVICE_HEADER) goes there over the link, as that
 * chat. Asking the user (page_access) and approving helpers happen here, in the chat; the rest is B's.
 */
export function agentForwarder(peers: PeerService, host: () => AgentDevicesHost | undefined): express.RequestHandler {
  return async (req, res, next) => {
    let token = req.get(DEVICE_HEADER)?.trim();
    try {
      token = token && decodeURIComponent(token);
    } catch {
      /* sent as is */
    }
    if (!token) {
      next();
      return;
    }
    const caller = identify(req);
    const agents = host();
    if (caller.viewer !== "agent" || !caller.thread || caller.device || !agents) {
      res.status(403).json({ error: "Only Scribe chats on this device can reach other devices." });
      return;
    }
    const devices = peers.devices();
    const device = findDevice(token, devices);
    if (!device) {
      res.status(404).json({ error: `No paired device "${token}". device_list shows the paired devices.` });
      return;
    }
    if (device.self) {
      next();
      return;
    }
    if (!device.online) {
      res.status(503).json({ error: `${device.name} is offline.` });
      return;
    }
    const pageAccess = req.method === "POST" && req.path === "/api/page-access";
    const kind = pageAccess ? "read" : remoteRequestKind(req.method, req.path);
    if (!kind) {
      res.status(400).json({ error: "This tool does not work on other devices." });
      return;
    }
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    req.setTimeout(0);
    res.setTimeout(0);
    const thread = caller.thread;
    const target = { id: device.id, name: device.name };
    const writtenFor = (written: string) => findDevice(written, devices)?.id === device.id;
    const send = async (method: string, path: string, body: unknown) => {
      const agent = agents.remoteAgent(thread, device.id, writtenFor);
      if (typeof agent === "string") throw Object.assign(new Error(agent), { status: 403 });
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const reply = await peers.request(device.id, {
        method,
        path,
        headers: {
          host: "127.0.0.1",
          accept: "application/json",
          [REMOTE_AGENT_HEADER]: encodeRemoteAgent(agent),
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        body: payload,
        signal: abort.signal,
      });
      if (reply.headers[TAINT_HEADER]) agents.taint(thread);
      return reply;
    };
    try {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : (req.body ?? {});
      if (pageAccess) {
        const which = typeof req.body?.page === "string" ? req.body.page.trim() : "";
        if (!which) throw Object.assign(new Error("page is required: the page's key or id"), { status: 400 });
        const found = await send("POST", "/api/remote-agent/page", { page: which });
        if (found.status !== 200) {
          res.status(found.status).type("application/json").send(found.body);
          return;
        }
        const page = JSON.parse(found.body.toString("utf8")) as RemotePage;
        const answer = await agents.pageAccess(thread, target, page, {
          folder: req.body?.folder === true,
          importance: typeof req.body?.importance === "string" ? req.body.importance : undefined,
          reason: typeof req.body?.reason === "string" ? req.body.reason.slice(0, 1000) : undefined,
          signal: abort.signal,
        });
        res.json(answer);
        return;
      }
      let forward = body;
      if (req.path === "/api/helper/run" && body && typeof body === "object" && !(body as Record<string, unknown>).thread) {
        const folder = typeof (body as Record<string, unknown>).cwd === "string" ? String((body as Record<string, unknown>).cwd).trim() : "";
        if (!folder) throw Object.assign(new Error(`cwd is required for a helper on ${device.name}: a folder that device already has chats in.`), { status: 400 });
        const raw = (body as Record<string, unknown>).access ?? (body as Record<string, unknown>).mode;
        const access = await agents.helperAccess(thread, target, folder, typeof raw === "string" ? raw : undefined, abort.signal);
        forward = { ...(body as Record<string, unknown>), access, mode: undefined };
      }
      const reply = await send(req.method, req.originalUrl, forward);
      res.status(reply.status).type(String(reply.headers["content-type"] ?? "application/json")).send(reply.body);
    } catch (err) {
      if (res.writableEnded) return;
      const status = (err as { status?: number }).status ?? (abort.signal.aborted ? 499 : 502);
      res.status(status).json({ error: (err as Error).message || `${device.name} did not answer.` });
    }
  };
}

/**
 * /api/remote-agent: device_list for a chat here, the grant this device gives the device asking over
 * the link, and a page as another device's agent may know it (for page_access asked there).
 */
export function remoteAgentRouter(peers: PeerService, host: () => AgentDevicesHost | undefined): Router {
  const router = Router();
  router.get("/devices", async (req, res) => {
    const caller = identify(req);
    if (caller.viewer !== "agent" || !caller.thread || caller.device) {
      res.status(403).json({ error: "device_list only works in Scribe chats." });
      return;
    }
    const view = peers.view();
    const devices = await Promise.all(view.peers.map(async (peer) => {
      const row = { id: peer.id, name: peer.name, online: peer.online };
      if (!peer.online) return row;
      try {
        const reply = await Promise.race([
          peers.request(peer.id, { method: "GET", path: "/api/remote-agent/grant", headers: { host: "127.0.0.1", accept: "application/json" } }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), LIST_TIMEOUT_MS).unref()),
        ]);
        if (reply.status !== 200) return { ...row, grants: "unknown (an older Scribe)" };
        return { ...row, grants: JSON.parse(reply.body.toString("utf8")) as AgentGrant };
      } catch {
        return { ...row, grants: "unknown (no answer)" };
      }
    }));
    res.json({ self: { id: view.self.id, name: view.self.name }, devices });
  });
  router.get("/grant", (req, res) => {
    const device = peerDeviceOf(req.socket);
    if (!device) {
      res.status(404).json({ error: "Over a link only" });
      return;
    }
    res.json(peers.agentGrant(device));
  });
  router.post("/page", (req, res) => {
    const caller = identify(req);
    const agents = host();
    if (!caller.remote || !agents) {
      res.status(404).json({ error: "For agents on other devices" });
      return;
    }
    const which = typeof req.body?.page === "string" ? req.body.page.trim() : "";
    const page = which ? agents.describePage(req, which) : null;
    if (!page) {
      res.status(404).json({ error: `tab not found: ${which}` });
      return;
    }
    res.json(page);
  });
  return router;
}
