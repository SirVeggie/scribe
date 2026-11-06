import { Router } from "express";

/**
 * Preferences the daemon keeps for every browser profile, the desktop app and the gateway view of this
 * device (#1023), in the categories that settings sync shares between devices. localStorage in the
 * browser is only a cache and the source of a one-time migration (public/appearance.js).
 */
export const PREF_CATEGORIES = {
  appearance: [
    "scribe.theme", "scribe.tightSmall", "scribe.uiEffects", "scribe.auroraEdge",
    "scribe.newPageBackgrounds", "scribe.newPageProviderColors", "scribe.chromeFx", "scribe.chromeFxWhen",
    "scribe.dock-appearance.v1", "scribe.workingFx",
    // From Desktop: these two go with Appearance; the rest of Desktop stays on the device.
    "scribe.desktop.reducedMotion", "scribe.desktop.hiddenButtons",
  ],
  layout: [
    "scribe.agentSide", "scribe.librarySide", "scribe.linkMode", "scribe.smoothScroll", "scribe.showClear",
    "scribe.spaceSuggest", "scribe.palettePrefixes",
  ],
  chat: [
    "scribe.agent.sendKey", "scribe.agent.runningSend", "scribe.agent.emptyEnter", "scribe.agent.reasoningOpen",
    "scribe.agent.compactThreads", "scribe.agent.dockCompactThreads", "scribe.agent.showPresets",
    "scribe.agent.showTips", "scribe.agent.showButton",
  ],
} as const;
export type PrefCategory = keyof typeof PREF_CATEGORIES;
export const APPEARANCE_KEYS = Object.values(PREF_CATEGORIES).flat() as string[];
export type Appearance = Record<string, string>;

export function categoryOf(key: string): PrefCategory | undefined {
  for (const [category, keys] of Object.entries(PREF_CATEGORIES)) if ((keys as readonly string[]).includes(key)) return category as PrefCategory;
  return undefined;
}

const SWITCHES = new Set([
  "scribe.tightSmall", "scribe.uiEffects", "scribe.auroraEdge", "scribe.newPageProviderColors", "scribe.desktop.reducedMotion",
  "scribe.smoothScroll", "scribe.showClear", "scribe.spaceSuggest",
  "scribe.agent.reasoningOpen", "scribe.agent.compactThreads", "scribe.agent.dockCompactThreads", "scribe.agent.showPresets",
  "scribe.agent.showTips", "scribe.agent.showButton",
]);
const CHOICES: Record<string, string[]> = {
  "scribe.theme": ["neutral", "ember", "spectrum", "garnet", "dusk", "cream"],
  "scribe.chromeFx": ["wash", "motes", "rise", "off"],
  "scribe.chromeFxWhen": ["idle-still", "always", "busy"],
  "scribe.workingFx": ["shimmer", "comet-css", "edge", "comet", "scan", "motes"],
  "scribe.agentSide": ["left", "right"],
  "scribe.librarySide": ["left", "right"],
  "scribe.linkMode": ["tab", "peek", "split"],
  "scribe.agent.sendKey": ["enter", "mod"],
  "scribe.agent.runningSend": ["queue", "steer"],
  "scribe.agent.emptyEnter": ["steer", "send"],
};
const JSON_OBJECTS = new Set(["scribe.dock-appearance.v1", "scribe.palettePrefixes"]);

/** Only known preferences cross browser profiles and devices. Never accept arbitrary localStorage keys. */
export function parseAppearance(value: unknown): Appearance {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected appearance settings");
  const result: Appearance = {};
  for (const [key, item] of Object.entries(value)) {
    if (!APPEARANCE_KEYS.includes(key) || typeof item !== "string" || item.length > 8192) {
      throw new Error(`Invalid appearance setting: ${key}`);
    }
    if (SWITCHES.has(key) && !["0", "1"].includes(item)) throw new Error(`Invalid switch: ${key}`);
    if (CHOICES[key] && !CHOICES[key].includes(item)) throw new Error(`Invalid value for ${key}`);
    if (key === "scribe.newPageBackgrounds" && (!item || item.split(",").some(id => !["nebula", "stardust", "aurora", "caustics", "contours", "halftone", "bokeh"].includes(id)))) throw new Error("Invalid backgrounds");
    if (JSON_OBJECTS.has(key)) {
      const parsed = JSON.parse(item);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid value for ${key}`);
    }
    if (key === "scribe.desktop.hiddenButtons") {
      const ids = JSON.parse(item);
      if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new Error("Invalid title bar buttons");
    }
    result[key] = item;
  }
  return result;
}

export type AppearanceStorage = { read(): Appearance; write(settings: Appearance): void };

/**
 * The preferences route. `changed` gets every write with the keys this write set, so settings sync can
 * stamp them as the user's; `apply` is how sync writes values that came from another device.
 */
export function appearanceRouter(storage: AppearanceStorage, changed: (settings: Appearance, revision: number, keys: string[]) => void) {
  const router = Router();
  let revision = 0;
  const apply = (patch: Appearance, keys: string[] = Object.keys(patch), local = true) => {
    const settings = storage.read();
    const set: string[] = [];
    for (const key of keys) {
      if (Object.hasOwn(patch, key)) {
        if (settings[key] === patch[key]) continue;
        settings[key] = patch[key];
      } else {
        if (!Object.hasOwn(settings, key)) continue;
        delete settings[key];
      }
      set.push(key);
    }
    if (!set.length) return settings;
    storage.write(settings);
    changed(settings, ++revision, local ? set : []);
    return settings;
  };
  router.get("/bootstrap.js", (_req, res) => {
    res.type("js").set("Cache-Control", "no-store").send(`window.scribeAppearanceSeed=${JSON.stringify({ keys: APPEARANCE_KEYS, settings: storage.read(), revision }).replace(/</g, "\u003c")};`);
  });
  router.get("/", (_req, res) => res.set("Cache-Control", "no-store").set("X-Appearance-Revision", String(revision)).json(storage.read()));
  router.put("/", (req, res) => {
    try {
      let patch: Appearance;
      const migrate = req.body?.migrate === true;
      if (migrate && req.body.settings && typeof req.body.settings === "object" && !Array.isArray(req.body.settings)) {
        patch = {};
        for (const [key, value] of Object.entries(req.body.settings)) {
          if (!APPEARANCE_KEYS.includes(key)) throw new Error(`Invalid appearance setting: ${key}`);
          // Obsolete or malformed cache entries must not prevent other settings migrating.
          try { Object.assign(patch, parseAppearance({ [key]: value })); } catch { /* Use the built-in fallback. */ }
        }
        // Migration must never overwrite a choice already shared by another profile.
        const saved = storage.read();
        for (const key of Object.keys(patch)) if (Object.hasOwn(saved, key)) delete patch[key];
      } else patch = parseAppearance(req.body?.settings);
      const settings = apply(patch);
      res.set("X-Appearance-Revision", String(revision)).json(settings);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  return Object.assign(router, {
    /** Write values from another device (a key missing from `patch` but listed in `keys` is removed). */
    applyRemote: (patch: Appearance, keys: string[]) => apply(patch, keys, false),
  });
}
