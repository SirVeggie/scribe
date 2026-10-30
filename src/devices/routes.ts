import { EventEmitter } from "node:events";
import express, { Router } from "express";
import { identify } from "../callers.js";
import type { PeerService } from "./peers.js";
import { shellOrigin } from "../contentOrigin.js";
import type { SpacesView } from "../spaces.js";
import { peerDeviceOf } from "./link.js";
import { sseStream, type AskSource, type AskWatcher } from "./attention.js";

export type DevicesHost = {
  spaces(): SpacesView;
  switchSpace(id: string): void;
  asks: AskSource;
  watcher: AskWatcher;
};

/** A space as the selector's device sections show it (#906). */
export type SpaceSummary = { id: string; name: string; color: string; tabs: number; active: boolean; usedAt?: number };

function summaries(view: SpacesView | undefined): SpaceSummary[] {
  if (!view || !Array.isArray(view.spaces)) return [];
  return view.spaces.map((space) => ({
    id: String(space.id),
    name: String(space.name),
    color: String(space.color),
    tabs: Array.isArray(space.tabs) ? space.tabs.length : 0,
    active: space.id === view.activeId,
    ...(typeof space.usedAt === "number" ? { usedAt: space.usedAt } : {}),
  }));
}

const REMOTE_TIMEOUT_MS = 3000;

/**
 * /api/devices for Settings → Devices and `scribe pair` (#904): this device, the paired ones, Add
 * device (a code), Enter code, introductions and Revoke. Only the user: agents never pair or revoke,
 * and changes are JSON from the board's own origin (or a local tool, which sends no Origin).
 */
export function devicesRouter(peers: PeerService, host: DevicesHost): Router {
  const router = Router();
  router.use((req, res, next) => {
    if (identify(req).viewer === "agent") {
      res.status(403).json({ error: "Only the user manages paired devices" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.get("origin");
      // A remote view's board asks this device through its gateway (#906), which checked the origin.
      const gateway = res.locals.gatewayDevice && origin === `http://${req.headers.host}`;
      if (origin && !gateway && !shellOrigin(req, origin)) {
        res.status(403).json({ error: "Devices can only be changed from the board" });
        return;
      }
      if (!req.is("application/json")) {
        res.status(415).json({ error: "Device requests must be JSON" });
        return;
      }
    }
    next();
  });
  // viewer: the device this UI is being viewed from, through its gateway (#905); unset here.
  // viewing: the device whose UI asked, when it is shown here through this device's gateway (#906).
  const view = (req: express.Request) => ({ ...peers.view(), viewer: identify(req).device ?? null, viewing: viewingOf(req) });
  const guarded = (fn: (req: express.Request) => unknown) => async (req: express.Request, res: express.Response) => {
    try {
      res.json((await fn(req)) ?? view(req));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  };
  router.get("/", (req, res) => res.json(view(req)));
  // The space selector's device sections: this device's spaces and every online device's (#906).
  router.get("/spaces", async (req, res) => {
    const devices = peers.view();
    const peerSpaces = await Promise.all(devices.peers.map(async (peer) => {
      if (!peer.online) return peer;
      try {
        const reply = await withTimeout(peers.request(peer.id, { method: "GET", path: "/api/spaces", headers: { host: "127.0.0.1", accept: "application/json" } }));
        if (reply.status !== 200) return { ...peer, spaces: [] };
        return { ...peer, spaces: summaries(JSON.parse(reply.body.toString("utf8")) as SpacesView) };
      } catch {
        return { ...peer, spaces: [], unreachable: true };
      }
    }));
    res.set("Cache-Control", "no-store").json({
      self: { id: devices.self.id, name: devices.self.name, spaces: summaries(host.spaces()) },
      peers: peerSpaces,
      viewing: viewingOf(req),
    });
  });
  // Pick a space on a device: it becomes that device's current space, then the UI goes there.
  router.post("/:id/spaces/:sid/switch", guarded(async (req) => {
    const { id, sid } = req.params;
    if (id === peers.identity.id) {
      host.switchSpace(sid);
      return { ok: true };
    }
    const reply = await withTimeout(peers.request(id, {
      method: "POST",
      path: `/api/spaces/${encodeURIComponent(sid)}/switch`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: "{}",
    }));
    if (reply.status !== 200) throw new Error(`${peers.nameOf(id) ?? "The device"} could not switch to that space.`);
    return { ok: true };
  }));
  // This device's own chats that wait on the user, for paired devices to toast (#906).
  router.get("/asks", (req, res) => sseStream(req, res, () => ({ asks: host.asks.asks }), host.asks));
  // What the board here toasts: the asks of every device but the one whose UI is showing (#906).
  router.get("/attention", (req, res) => {
    if (peerDeviceOf(req.socket)) {
      res.status(404).json({ error: "Not over a link" });
      return;
    }
    const viewing = viewingOf(req);
    const self = peers.view().self;
    const value = () => ({
      asks: [
        ...(viewing ? host.asks.asks.map((ask) => ({ ...ask, device: self.id, name: self.name, home: true })) : []),
        ...host.watcher.asks(viewing ?? undefined),
      ],
    });
    // Both sources change the stream; one emitter for sseStream to listen on.
    const both = new EventEmitter();
    const relay = () => both.emit("change");
    host.watcher.on("change", relay);
    if (viewing) host.asks.on("change", relay);
    req.on("close", () => {
      host.watcher.off("change", relay);
      host.asks.off("change", relay);
    });
    sseStream(req, res, value, both);
  });
  router.put("/self", guarded((req) => peers.rename(req.body?.name)));
  router.post("/offer", guarded(async () => ({ offer: await peers.createOffer() })));
  router.delete("/offer", guarded(() => peers.cancelOffer()));
  router.post("/pair", guarded((req) => {
    if (typeof req.body?.code !== "string") throw new Error("Enter the code the other device shows.");
    return peers.pair(req.body.code);
  }));
  router.post("/:id/introduce", guarded((req) => ({ introduced: peers.introduce(req.params.id, Array.isArray(req.body?.to) ? req.body.to : undefined) })));
  router.delete("/:id", guarded((req) => peers.revoke(req.params.id)));
  return router;
}

function viewingOf(req: express.Request): string | null {
  return (req.res?.locals.gatewayDevice as string | undefined) ?? null;
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The device did not answer in time.")), REMOTE_TIMEOUT_MS);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (err) => { clearTimeout(timer); reject(err); });
  });
}
