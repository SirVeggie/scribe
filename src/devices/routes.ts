import express, { Router } from "express";
import { identify } from "../callers.js";
import { shellOrigins } from "../config.js";
import type { PeerService } from "./peers.js";

/**
 * /api/devices for Settings → Devices and `scribe pair` (#904): this device, the paired ones, Add
 * device (a code), Enter code, introductions and Revoke. Only the user: agents never pair or revoke,
 * and changes are JSON from the board's own origin (or a local tool, which sends no Origin).
 */
export function devicesRouter(peers: PeerService): Router {
  const router = Router();
  router.use((req, res, next) => {
    if (identify(req).viewer === "agent") {
      res.status(403).json({ error: "Only the user manages paired devices" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.get("origin");
      if (origin && !shellOrigins().includes(origin)) {
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
  const guarded = (fn: (req: express.Request) => unknown) => async (req: express.Request, res: express.Response) => {
    try {
      res.json((await fn(req)) ?? peers.view());
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  };
  router.get("/", (_req, res) => res.json(peers.view()));
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
