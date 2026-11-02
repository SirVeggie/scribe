import express, { Router } from "express";
import { identify } from "../callers.js";
import { shellOrigin } from "../contentOrigin.js";
import type { UpdateService } from "./updates.js";

/**
 * /api/updates for Settings → Updates and the update notice (#942). Only the user: agents read it but never
 * install, skip or change the mode. A signed-in browser on the web (#913) may (#946): an update installs only
 * what this install's own source publishes, so the sign-in is barrier enough, as for pairing (#939).
 */
export function updatesRouter(service: UpdateService): Router {
  const router = Router();
  router.use(express.json());
  router.use((req, res, next) => {
    if (identify(req).viewer === "agent") {
      res.status(403).json({ error: "Only the user manages updates" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.get("origin");
      if (origin && !shellOrigin(req, origin)) {
        res.status(403).json({ error: "Updates can only be changed from the board" });
        return;
      }
    }
    next();
  });
  const guarded = (fn: (req: express.Request) => unknown) => async (req: express.Request, res: express.Response) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message, view: service.view() });
    }
  };
  router.get("/", guarded(() => service.view()));
  router.post("/check", guarded(() => service.check()));
  router.post("/mode", guarded((req) => service.setMode(req.body?.mode)));
  router.post("/skip", guarded((req) => service.skip(req.body?.id ?? null)));
  router.post("/dismiss", guarded((req) => service.dismiss(req.body?.id ?? null)));
  // Answers once the install has started; the daemon restarts (or the installer stops it) right after.
  router.post("/apply", guarded(async () => {
    const view = service.view();
    if (!view.available) throw new Error("There is no update to install");
    void service.apply().catch(() => {});
    return { ...service.view(), phase: service.view().phase === "idle" ? "installing" : service.view().phase };
  }));
  return router;
}
