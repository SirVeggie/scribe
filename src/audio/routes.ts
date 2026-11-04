import express, { Router } from "express";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { identify } from "../callers.js";
import { AudioService, MAX_AUDIO_BYTES } from "./service.js";
import type { PageAudio } from "./page.js";
import { shellOrigin } from "../contentOrigin.js";

/** Shell-only uploads; page calls also pass the permission and rate-limit gate. */
export function audioRouter(service: AudioService, pagePermission?: PageAudio): Router {
  const router = Router();
  router.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin && !shellOrigin(req, origin)) { res.status(403).json({ ok: false, error: "permission", message: "Audio requests must come from the board." }); return; }
    if (req.method !== "GET" && req.method !== "HEAD" && !req.is(req.path === "/transcriptions" ? "audio/*" : "application/json")) {
      res.status(415).json({ ok: false, error: "invalid_audio", message: "Send audio bytes for transcription, JSON for settings and tests." }); return;
    }
    next();
  });
  router.use(express.json());
  router.get("/settings", (_req, res) => res.json(service.view()));
  router.put("/settings", (req, res) => { try { res.json(service.update(req.body)); } catch (err) { res.status(400).json({ error: (err as Error).message }); } });
  router.post("/sources", (req, res) => { try { res.json(service.saveSource(req.body)); } catch (err) { res.status(400).json({ error: (err as Error).message }); } });
  router.put("/sources/:id", (req, res) => { try { res.json(service.saveSource(req.body, req.params.id)); } catch (err) { res.status(400).json({ error: (err as Error).message }); } });
  router.delete("/sources/:id", (req, res) => { try { res.json(service.removeSource(req.params.id)); } catch (err) { res.status(400).json({ error: (err as Error).message }); } });
  router.post("/tts-sources", (req, res) => { try { res.json(service.saveTtsSource(req.body)); } catch (err) { res.status(400).json({ error: (err as Error).message }); } });
  router.put("/tts-sources/:id", (req, res) => { try { res.json(service.saveTtsSource(req.body, req.params.id)); } catch (err) { res.status(400).json({ error: (err as Error).message }); } });
  router.delete("/tts-sources/:id", (req, res) => { try { res.json(service.removeTtsSource(req.params.id)); } catch (err) { res.status(400).json({ error: (err as Error).message }); } });
  /** Voices of a text-to-speech source: {} for the chosen one, { id } for a saved one, or the editor's draft. */
  router.post("/voices", async (req, res) => {
    try { res.json(await service.voices(req.body)); }
    catch { res.json({ ok: false, error: "engine", message: "Cannot list voices." }); }
  });
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
  /** Text-to-speech: JSON { text, voice?, speed? } in, the source's audio stream out (Phase D). Failures come back as JSON. */
  router.post("/speech", async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableFinished) controller.abort(); });
    const body = req.body as { text?: unknown; voice?: unknown; speed?: unknown; sourceId?: unknown } | undefined;
    const tab = req.get("x-scribe-tab");
    try {
      if (tab) {
        const gate = identify(req).viewer === "agent" || !pagePermission ? { ok: false, error: "denied", permission: "audio.speak" }
          : pagePermission.checkSpeech(tab, typeof body?.text === "string" ? body.text.length : 0);
        if (!gate.ok) { res.status(403).json(gate); return; }
      }
      const result = await service.speak(body?.text, { voice: body?.voice, speed: body?.speed, signal: controller.signal,
        // Settings → Audio tests a source before it is chosen; pages always use the chosen one.
        sourceId: !tab && typeof body?.sourceId === "string" ? body.sourceId : undefined });
      if (!result.ok) {
        res.status(result.error === "too_large" ? 413 : result.error === "invalid_audio" ? 400 : result.error === "no_source" ? 409 : 502).json(result);
        return;
      }
      res.status(200).set({ "Content-Type": result.type, "Cache-Control": "no-store" });
      const stream = Readable.fromWeb(result.body as unknown as NodeReadableStream<Uint8Array>);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    } catch { if (!res.headersSent) res.status(502).json({ ok: false, error: "engine", message: "Text-to-speech is unavailable." }); else res.destroy(); }
  });
  router.post("/test", async (req, res) => {
    try {
      const bytes = await fs.readFile(new URL("../../public/audio-test.wav", import.meta.url));
      res.json(await service.transcribe(new Blob([bytes], { type: "audio/wav" }), { sourceId: typeof req.body?.sourceId === "string" ? req.body.sourceId : undefined }));
    } catch { res.json({ ok: false, error: "engine", message: "Audio test clip is unavailable. Restart Scribe after updating." }); }
  });
  router.use((err: { type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.type === "entity.too.large" ? 413 : 400).json({ ok: false, error: err.type === "entity.too.large" ? "too_large" : "invalid_audio", message: err.type === "entity.too.large" ? "Audio must be under 25 MB." : "Invalid audio request." });
  });
  return router;
}
