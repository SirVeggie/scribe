import express, { Router } from "express";
import { identify } from "../callers.js";
import { shellOrigins } from "../config.js";
import type { PermissionGrant } from "../pagePermissions.js";
import { PageMl } from "./page.js";
import { mlService, type MlService } from "./service.js";

/** What the page routes need from the daemon: a page's grants (throws for an unknown page). */
export type MlPageAccess = { grants: (tabId: string) => Map<string, PermissionGrant>; ml?: PageMl };

/**
 * Changes must come from the board shell: JSON (a cross-origin form cannot send it without a
 * preflight) and, when the browser says where it came from, one of the shell's origins. A source's
 * key never appears in a response; tab pages are kept out of /api/ml by the content origin gate.
 */
function shellOnly(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }
  const origin = req.get("origin");
  if (origin && !shellOrigins().includes(origin)) {
    res.status(403).json({ error: "Classifier settings can only be changed from the board" });
    return;
  }
  if (!req.is("application/json")) {
    res.status(415).json({ error: "Classifier requests must be JSON" });
    return;
  }
  next();
}

/**
 * /api/ml/* for the Settings dialog: sources, switches, the Test button and today's usage. With
 * `pages`, also scribe.ml: the board shell calls /pages/:id/* for the page whose frame asked, so the
 * page is named by the shell and never by the page itself. Agents are kept out like they are from
 * page permissions.
 */
export function mlRouter(service: MlService = mlService(), pages?: MlPageAccess): Router {
  const router = Router();
  router.use(shellOnly);
  const guarded = (fn: (req: express.Request) => unknown) => (req: express.Request, res: express.Response) => {
    try {
      res.json(fn(req) ?? { ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  };
  router.get("/settings", (_req, res) => res.json(service.view()));
  router.put("/settings", guarded((req) => service.update(req.body)));
  router.get("/usage", (_req, res) => res.json(service.usage()));
  router.post("/sources", guarded((req) => ({ source: service.saveSource(undefined, req.body), ...service.view() })));
  router.put("/sources/:source", guarded((req) => ({ source: service.saveSource(req.params.source, req.body), ...service.view() })));
  router.delete("/sources/:source", guarded((req) => {
    service.deleteSource(req.params.source);
    return service.view();
  }));
  /** One real question through the source. Always 200: a failure is the result ({ ok: false, error, message }). */
  router.post("/sources/:source/test", async (req, res) => {
    res.json(await service.test(req.params.source));
  });
  if (pages) {
    const ml = pages.ml ?? new PageMl({ service });
    const forPage = (fn: (tabId: string, grants: Map<string, PermissionGrant>, req: express.Request) => unknown) =>
      async (req: express.Request, res: express.Response) => {
        if (identify(req).viewer === "agent") {
          res.status(403).json({ error: "Only the Scribe UI can ask the classifier for a page" });
          return;
        }
        let grants: Map<string, PermissionGrant>;
        try {
          grants = pages.grants(String(req.params.id));
        } catch (err) {
          res.status(404).json({ error: (err as Error).message });
          return;
        }
        res.json(await fn(String(req.params.id), grants, req));
      };
    router.get("/pages/:id/capabilities", forPage((_id, grants) => ml.capabilities(grants)));
    /** Always 200 for a known page: a failure is the result ({ ok: false, error, message }). */
    router.post("/pages/:id/decide", forPage((id, grants, req) => ml.decide(id, grants, req.body)));
  }
  return router;
}
