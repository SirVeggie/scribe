import express, { Router } from "express";
import fs from "node:fs/promises";
import { identify } from "../callers.js";
import { shellOrigins } from "../config.js";
import { AudioService, MAX_AUDIO_BYTES } from "./service.js";
import type { PageAudio } from "./page.js";

/** Shell-only uploads; page calls also pass the permission and rate-limit gate. */
export function audioRouter(service: AudioService, pagePermission?: PageAudio): Router {
  const router = Router();
  router.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin && !shellOrigins().includes(origin)) { res.status(403).json({ ok: false, error: "permission", message: "Audio requests must come from the board." }); return; }
    if (req.method !== "GET" && req.method !== "HEAD" && !req.is(req.path === "/transcriptions" ? "audio/*" : "application/json")) {
      res.status(415).json({ ok: false, error: "invalid_audio", message: "Send audio bytes for transcription, JSON for settings and tests." }); return;
    }
    next();
  });
  router.use(express.json());
  router.get("/settings", (_req, res) => res.json(service.view()));
  router.put("/settings", (req, res) => { try { res.json(service.update(req.body)); } catch (err) { res.status(400).json({ error: (err as Error).message }); } });
  router.post("/transcriptions", express.raw({ type: "audio/*", limit: MAX_AUDIO_BYTES }), async (req, res) => {
    const tab = req.get("x-scribe-tab");
    try {
      if (tab) {
        const gate = identify(req).viewer === "agent" || !pagePermission ? { ok: false, error: "denied", permission: "audio.transcribe" }
          : pagePermission.check(tab);
        if (!gate.ok) { res.status(403).json(gate); return; }
      }
      res.json(await service.transcribe(new Blob([req.body], { type: req.get("content-type") }), {
        language: typeof req.query.language === "string" ? req.query.language.slice(0, 20) : undefined,
        prompt: typeof req.query.prompt === "string" ? req.query.prompt.slice(0, 2000) : undefined,
      }));
    } catch { res.json({ ok: false, error: "engine", message: "Speech-to-text is unavailable." }); }
  });
  router.post("/test", async (_req, res) => {
    try {
      const bytes = await fs.readFile(new URL("../../public/audio-test.wav", import.meta.url));
      res.json(await service.transcribe(new Blob([bytes], { type: "audio/wav" })));
    } catch { res.json({ ok: false, error: "engine", message: "Audio test clip is unavailable. Restart Scribe after updating." }); }
  });
  router.use((err: { type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.type === "entity.too.large" ? 413 : 400).json({ ok: false, error: err.type === "entity.too.large" ? "too_large" : "invalid_audio", message: err.type === "entity.too.large" ? "Audio must be under 25 MB." : "Invalid audio request." });
  });
  return router;
}
