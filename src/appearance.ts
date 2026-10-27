import { Router } from "express";

export const APPEARANCE_KEYS = [
  "scribe.theme", "scribe.tightSmall", "scribe.uiEffects", "scribe.auroraEdge",
  "scribe.newPageBackgrounds", "scribe.newPageProviderColors", "scribe.chromeFx", "scribe.chromeFxWhen",
  "scribe.dock-appearance.v1", "scribe.workingFx",
] as const;
export type Appearance = Record<string, string>;

/** Only visual preferences cross browser profiles. Never accept arbitrary localStorage keys. */
export function parseAppearance(value: unknown): Appearance {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected appearance settings");
  const result: Appearance = {};
  for (const [key, item] of Object.entries(value)) {
    if (!(APPEARANCE_KEYS as readonly string[]).includes(key) || typeof item !== "string" || item.length > 8192) {
      throw new Error(`Invalid appearance setting: ${key}`);
    }
    if (key === "scribe.theme" && !["neutral", "ember", "spectrum", "garnet", "dusk", "cream"].includes(item)) throw new Error("Invalid theme");
    if (["scribe.tightSmall", "scribe.uiEffects", "scribe.auroraEdge", "scribe.newPageProviderColors"].includes(key) && !["0", "1"].includes(item)) throw new Error("Invalid appearance switch");
    if (key === "scribe.chromeFx" && !["wash", "motes", "rise", "off"].includes(item)) throw new Error("Invalid title bar background");
    if (key === "scribe.chromeFxWhen" && !["idle-still", "always", "busy"].includes(item)) throw new Error("Invalid title bar motion");
    if (key === "scribe.workingFx" && !["shimmer", "comet-css", "edge", "comet", "scan", "motes"].includes(item)) throw new Error("Invalid working thread look");
    if (key === "scribe.newPageBackgrounds" && (!item || item.split(",").some(id => !["nebula", "stardust", "aurora", "caustics", "contours", "halftone", "bokeh"].includes(id)))) throw new Error("Invalid backgrounds");
    if (key === "scribe.dock-appearance.v1") {
      const dock = JSON.parse(item);
      if (!dock || typeof dock !== "object" || Array.isArray(dock)) throw new Error("Invalid floating chat appearance");
    }
    result[key] = item;
  }
  return result;
}

export function appearanceRouter(storage: { read(): Appearance; write(settings: Appearance): void }, changed: (settings: Appearance, revision: number) => void) {
  const router = Router();
  let revision = 0;
  router.get("/bootstrap.js", (_req, res) => {
    res.type("js").set("Cache-Control", "no-store").send(`window.scribeAppearanceSeed=${JSON.stringify({ keys: APPEARANCE_KEYS, settings: storage.read(), revision }).replace(/</g, "\\u003c")};`);
  });
  router.get("/", (_req, res) => res.set("Cache-Control", "no-store").set("X-Appearance-Revision", String(revision)).json(storage.read()));
  router.put("/", (req, res) => {
    try {
      let patch: Appearance;
      if (req.body?.migrate === true && req.body.settings && typeof req.body.settings === "object" && !Array.isArray(req.body.settings)) {
        patch = {};
        for (const [key, value] of Object.entries(req.body.settings)) {
          if (!(APPEARANCE_KEYS as readonly string[]).includes(key)) throw new Error(`Invalid appearance setting: ${key}`);
          // Obsolete or malformed cache entries must not prevent other settings migrating.
          try { Object.assign(patch, parseAppearance({ [key]: value })); } catch { /* Use the built-in fallback. */ }
        }
      } else patch = parseAppearance(req.body?.settings);
      const settings = storage.read();
      for (const [key, value] of Object.entries(patch)) {
        // Migration must never overwrite a choice already shared by another profile.
        if (req.body.migrate === true && Object.hasOwn(settings, key)) continue;
        settings[key] = value;
      }
      storage.write(settings);
      changed(settings, ++revision);
      res.set("X-Appearance-Revision", String(revision)).json(settings);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  return router;
}
