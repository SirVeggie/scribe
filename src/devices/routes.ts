import { EventEmitter } from "node:events";
import express, { Router } from "express";
import { identify } from "../callers.js";
import type { PeerService } from "./peers.js";
import { shellOrigin } from "../contentOrigin.js";
import type { SpacesView } from "../spaces.js";
import { peerDeviceOf } from "./link.js";
import { sseStream, type AskSource, type AskWatcher } from "./attention.js";
import { webSessionToken, type WebAccess } from "./web.js";
import { findDevice, parseDeviceRef, type Described, type DeviceRef, type Resolved } from "./references.js";

export type DevicesHost = {
  /** Web access (#913): this device's domain, Google client and accounts, and its signed-in browsers. */
  web?: WebAccess;
  spaces(): SpacesView;
  switchSpace(id: string): void;
  asks: AskSource;
  watcher: AskWatcher;
  /** Answer one of this device's approvals, from a toast on another device (#911). */
  answerApproval?(requestId: string, optionId: string): void;
  /** This device's pages (by key or id) and threads, for references from other devices (#908). */
  describe?(pages: string[], threads: string[]): Described;
  /** Mirrors this device keeps itself (#910): their spaces and page titles. */
  mirror?: {
    spaces(device: string): { spaces: SpaceSummary[] } | undefined;
    describe(device: string, pages: string[]): Described | undefined;
  };
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

/** What a browser on the web may change here: switch spaces, answer approvals, resolve and describe links. */
const WEB_WRITES = [/^\/[^/]+\/spaces\/[^/]+\/switch$/, /^\/[^/]+\/approvals\/[^/]+$/, /^\/resolve$/, /^\/describe$/];

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
      // A browser on the web (#913) uses devices but never pairs, revokes, grants or changes web access:
      // a stolen session must not be able to add itself or lock the user out.
      if (identify(req).web && !WEB_WRITES.some((pattern) => pattern.test(req.path))) {
        res.status(403).json({ error: "Pairing and web access change only on a paired device, not from the web." });
        return;
      }
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
      if (!peer.online && peer.mirror) {
        // Offline, with a mirror on another device (#910): its spaces as the mirror last saw them, read only.
        if (peer.mirror.id === peers.identity.id) return { ...peer, spaces: host.mirror?.spaces(peer.id)?.spaces ?? [] };
        try {
          const reply = await withTimeout(peers.request(peer.mirror.id, { method: "GET", path: `/api/mirror/of/${peer.id}/spaces`, headers: { host: "127.0.0.1", accept: "application/json" } }));
          if (reply.status === 200) {
            const body = JSON.parse(reply.body.toString("utf8")) as { spaces?: SpaceSummary[] };
            return { ...peer, spaces: Array.isArray(body.spaces) ? body.spaces : [] };
          }
        } catch {
          /* shown offline, without spaces */
        }
        return peer;
      }
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
  // References to pages and threads on a device (#908): the titles last seen, by device, kind and target,
  // so a link to a device that went offline keeps its label.
  const seen = new Map<string, string>();
  const describeHere = (pages: string[], threads: string[]): Described => host.describe?.(pages, threads) ?? { pages: {}, threads: {} };
  router.post("/describe", (req, res) => {
    const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 200) : []);
    res.set("Cache-Control", "no-store").json(describeHere(list(req.body?.pages), list(req.body?.threads)));
  });
  router.post("/resolve", async (req, res) => {
    const targets: string[] = Array.isArray(req.body?.targets) ? req.body.targets.filter((t: unknown) => typeof t === "string").slice(0, 200) : [];
    const devices = peers.devices();
    // The device whose UI asked: a link to it is a link to a page right there.
    const here = viewingOf(req) ?? peers.identity.id;
    const out: Record<string, Resolved> = {};
    const found: Array<{ target: string; ref: DeviceRef; device: (typeof devices)[number] }> = [];
    const wanted = new Map<string, { pages: Set<string>; threads: Set<string> }>();
    for (const target of targets) {
      const ref = parseDeviceRef(target);
      if (!ref) continue;
      const device = findDevice(ref.device, devices);
      if (!device) {
        out[target] = { unknown: true };
      } else if (device.id === here) {
        out[target] = { here: true, device: { id: device.id, name: device.name } };
      } else {
        found.push({ target, ref, device });
        const want = wanted.get(device.id) ?? { pages: new Set(), threads: new Set() };
        (ref.kind === "page" ? want.pages : want.threads).add(ref.ref);
        wanted.set(device.id, want);
      }
    }
    const answers = new Map<string, Described | null>();
    const mirrored = new Map<string, Described>();
    await Promise.all([...wanted].map(async ([id, want]) => {
      const pages = [...want.pages];
      const threads = [...want.threads];
      if (id === peers.identity.id) {
        answers.set(id, describeHere(pages, threads));
        return;
      }
      if (!devices.find((d) => d.id === id)?.online) {
        // Offline: titles from the device that keeps its mirror (#910).
        const mirror = peers.mirrorOf(id);
        if (!mirror || !pages.length) return;
        if (mirror.holder === peers.identity.id) {
          const here = host.mirror?.describe(id, pages);
          if (here) mirrored.set(id, here);
          return;
        }
        try {
          const reply = await withTimeout(peers.request(mirror.holder, {
            method: "POST",
            path: `/api/mirror/of/${id}/describe`,
            headers: { host: "127.0.0.1", "content-type": "application/json" },
            body: JSON.stringify({ pages }),
          }));
          if (reply.status === 200) mirrored.set(id, JSON.parse(reply.body.toString("utf8")) as Described);
        } catch {
          /* the title seen last */
        }
        return;
      }
      try {
        const reply = await withTimeout(peers.request(id, {
          method: "POST",
          path: "/api/devices/describe",
          headers: { host: "127.0.0.1", "content-type": "application/json" },
          body: JSON.stringify({ pages, threads }),
        }));
        answers.set(id, reply.status === 200 ? JSON.parse(reply.body.toString("utf8")) as Described : null);
      } catch {
        /* shown as offline, with the title seen last */
      }
    }));
    for (const { target, ref, device } of found) {
      const answer = answers.get(device.id);
      const memo = `${device.id}|${ref.kind}|${ref.ref}`;
      const base = { device: { id: device.id, name: device.name } };
      if (!answer) {
        const copy = ref.kind === "page" ? (mirrored.get(device.id)?.pages?.[ref.ref] as (Described["pages"][string] & { mirrored?: boolean }) | null | undefined) : undefined;
        if (copy?.title) seen.set(memo, copy.title);
        const title = seen.get(memo);
        out[target] = { ...base, online: false, ...(title ? { title } : {}), ...(copy?.mirrored ? { mirror: true, key: String(copy.key) } : {}) };
        continue;
      }
      const hit = ref.kind === "page" ? answer.pages?.[ref.ref] : answer.threads?.[ref.ref];
      if (!hit) {
        seen.delete(memo);
        out[target] = { ...base, online: true, missing: true };
        continue;
      }
      seen.set(memo, hit.title);
      if (seen.size > 2000) seen.delete(seen.keys().next().value!);
      out[target] = { ...base, online: true, title: hit.title, ...(ref.kind === "page" && "key" in hit ? { key: String(hit.key) } : {}) };
    }
    res.set("Cache-Control", "no-store").json({ targets: out });
  });
  // Allow / Deny on a toast (#911): this device's own approval, or another device's over the link.
  router.post("/:id/approvals/:request", guarded(async (req) => {
    const { id, request } = req.params;
    const optionId = typeof req.body?.optionId === "string" ? req.body.optionId : "";
    if (!optionId) throw new Error("Pick an answer.");
    if (id === peers.identity.id) {
      if (!host.answerApproval) throw new Error("This device has no chats.");
      host.answerApproval(request, optionId);
      return { ok: true };
    }
    const reply = await withTimeout(peers.request(id, {
      method: "POST",
      path: `/api/devices/${encodeURIComponent(id)}/approvals/${encodeURIComponent(request)}`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ optionId }),
    }));
    if (reply.status !== 200) {
      let message = "";
      try { message = String(JSON.parse(reply.body.toString("utf8")).error ?? ""); } catch { /* not JSON */ }
      throw new Error(message || `${peers.nameOf(id) ?? "The device"} did not take the answer.`);
    }
    return { ok: true };
  }));
  // What this device lets a paired device's agents do here (#911).
  // Web access (#913): this device's, and another device's over the link (any paired device may set it up).
  router.get("/web", (req, res) => {
    if (!host.web) return res.status(404).json({ error: "No web access here." });
    res.set("Cache-Control", "no-store").json({ ...host.web.view(webSessionToken(req)), editable: !identify(req).web });
  });
  router.put("/web", guarded((req) => {
    if (!host.web) throw new Error("No web access here.");
    host.web.update(req.body);
    return { ...host.web.view(), editable: true };
  }));
  router.delete("/web/sessions/:sid", guarded((req) => {
    if (!host.web) throw new Error("No web access here.");
    host.web.signOut(req.params.sid);
    return { ...host.web.view(), editable: true };
  }));
  const onDevice = async (req: express.Request, res: express.Response, method: string, path: string) => {
    const { id } = req.params;
    try {
      const reply = await withTimeout(peers.request(id, {
        method,
        path: `/api/devices/web${path}`,
        headers: { host: "127.0.0.1", accept: "application/json", ...(method === "GET" ? {} : { "content-type": "application/json" }) },
        ...(method === "GET" ? {} : { body: JSON.stringify(req.body ?? {}) }),
      }));
      res.status(reply.status).type("json").send(reply.body);
    } catch {
      res.status(502).json({ error: `${peers.nameOf(id) ?? "That device"} is not connected.` });
    }
  };
  router.get("/:id/web", (req, res) => onDevice(req, res, "GET", ""));
  router.put("/:id/web", (req, res) => onDevice(req, res, "PUT", ""));
  router.delete("/:id/web/sessions/:sid", (req, res) => onDevice(req, res, "DELETE", `/sessions/${encodeURIComponent(req.params.sid)}`));
  router.put("/:id/agents", guarded((req) => peers.setAgentGrant(req.params.id, req.body)));
  router.put("/self", guarded((req) => peers.rename(req.body?.name)));
  // Accept connections from the internet on this address (#910), or stop: { host } or { host: null }.
  router.put("/public", guarded((req) => peers.setPublic(req.body?.host)));
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
