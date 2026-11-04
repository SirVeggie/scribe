import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "./chromium.js";
import { AudioService } from "./audio/service.js";
import { memoryStore } from "./audio/settings.js";

const source = (name: string) => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");

test("background picker renders real previews, toggles choices, and disposes effects", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Settings background picker test" });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="newpage-bgs">Choose…</button>');
    await page.addScriptTag({ content: "window.scribeAppearance = { getItem: () => null };" });
    await page.addStyleTag({ content: source("app.css") });
    for (const name of ["motion.js", "glfx.js", "newpage.js"]) await page.addScriptTag({ content: source(name) });
    const app = source("app.js");
    const picker = app.slice(app.indexOf("  function renderNewPageBgs()"), app.indexOf("  function renderChromeFx()"));
    const items = app.slice(app.indexOf("  const NEWPAGE_BGS ="), app.indexOf("  /** Also read by chromefx.js"));
    await page.addScriptTag({ content: `const appearanceStorage = new Map(); appearanceStorage.getItem = appearanceStorage.get; appearanceStorage.setItem = appearanceStorage.set; const NEWPAGE_BG_KEY = "backgrounds"; ${items}\n${picker}\nrenderNewPageBgs();` });
    await page.getByRole("button", { name: "Choose…" }).click();
    const dialog = page.getByRole("dialog");
    assert.equal(await dialog.locator("canvas").count(), 7);
    await page.waitForFunction(() => document.querySelectorAll('canvas[data-ready="1"]').length === 7);
    const nebula = dialog.getByRole("button", { name: "Nebula", exact: true });
    await nebula.click();
    assert.equal(await nebula.getAttribute("aria-pressed"), "false");
    await dialog.getByRole("button", { name: "Done" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Choose…" }).click();
    assert.equal(await page.getByRole("button", { name: "Nebula", exact: true }).getAttribute("aria-pressed"), "false");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
  } finally { await browser.close(); }
});

/** Settings → Audio in a page, its /api/audio calls answered by a real AudioService. */
async function audioSettingsPage(browser: Awaited<ReturnType<typeof launchChromium>>, service: AudioService, extra = "") {
  const page = await browser.newPage();
  const seen = { tested: "", errors: [] as string[] };
  page.on("pageerror", err => seen.errors.push(err.message));
  await page.route("http://audio.test/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname.replace("/api/audio", ""), method = req.method();
    const body = () => req.postDataJSON();
    try {
      if (path === "/test") { seen.tested = body().sourceId; return route.fulfill({ json: { ok: true, text: "Words" } }); }
      if (path === "/voices") return route.fulfill({ json: await service.voices(body()) });
      const [, kind, id] = path.split("/").map(decodeURIComponent);
      let view = service.view();
      if (kind === "sources") view = method === "DELETE" ? service.removeSource(id) : service.saveSource(body(), id);
      else if (kind === "tts-sources") view = method === "DELETE" ? service.removeTtsSource(id) : service.saveTtsSource(body(), id);
      else if (method === "PUT") view = service.update(body());
      return route.fulfill({ json: view });
    } catch (err) { return route.fulfill({ status: 400, json: { error: (err as Error).message } }); }
  });
  await page.goto("http://audio.test/");
  for (const name of ["app.css", "agent.css", "audio.css"]) await page.addStyleTag({ content: source(name) });
  await page.addScriptTag({ content: `window.scribeAudio = { refresh: async () => (await fetch("/api/audio/settings")).json(), device: () => "",
    voiceName: id => id, voices: async opts => opts.source === "browser" ? { ok: true, voices: [{ id: "Kate", name: "Kate", lang: "en-GB" }] }
      : (await fetch("/api/audio/voices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.source) })).json(),
    speak: (text, opts) => { window.spoken = opts?.sourceId; return { stop() {}, ended: Promise.resolve({ ok: false, error: "blocked", message: "Playback blocked" }) }; } };
    window.scribeChat = { openModelSources: () => document.body.dataset.sources = "open" }; ${extra}` });
  await page.addScriptTag({ content: source("select.js") });
  await page.addScriptTag({ content: source("audio-settings.js") });
  await page.evaluate(async () => {
    const settings = (window as any).scribeAudioSettings;
    document.body.append(...settings.sections); await settings.refresh();
  });
  return { page, seen };
}

test("speech settings add, edit, select, test and remove multiple sources in a modal", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Custom speech settings test" });
  try {
    const linked = { id: "linked", name: "Model API", baseUrl: "https://models.invalid/v1", apiKey: "model-secret", models: [] };
    const service = new AudioService({ sources: () => [linked], store: memoryStore() });
    const { page, seen } = await audioSettingsPage(browser, service);
    const modal = page.locator(".audio-stt-editor");
    const add = page.getByRole("button", { name: "Add speech-to-text source" });
    await add.click();
    await page.locator("#audio-name").fill("Local");
    await page.locator("#audio-url").fill("http://localhost:9000/v1");
    await page.locator("#audio-key").fill("custom-key");
    await modal.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("radio", { name: "Use Local by default" }).waitFor();
    assert.equal(await modal.count(), 0, "the modal closes on save");
    const local = service.view().defaultSource!;
    await add.click();
    await page.locator("#audio-name").fill("Hosted");
    await page.locator("#audio-url").fill("https://speech.invalid/v1");
    await page.locator("#audio-model").fill("speech-model");
    await page.locator("#audio-model").press("Enter");
    await page.getByRole("radio", { name: "Use Hosted by default" }).check();
    await page.waitForFunction(() => document.querySelectorAll(".audio-settings:first-of-type .ml-source").length === 2);
    const hosted = service.view().profiles.find(s => s.name === "Hosted")!.id;
    const hostedRow = page.locator(".ml-source").filter({ hasText: "Hosted" });
    await hostedRow.getByRole("button", { name: "Test", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Transcript: Words" }).waitFor();
    assert.equal(seen.tested, hosted); assert.equal(service.view().defaultSource, hosted);
    await page.locator(".ml-source").filter({ hasText: "Local" }).getByRole("button", { name: "Edit", exact: true }).click();
    assert.equal(await page.locator("#audio-url").inputValue(), "http://localhost:9000/v1");
    assert.equal(await page.locator("#audio-url").isEditable(), true);
    await page.locator("#audio-name").fill("Renamed");
    await modal.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("radio", { name: "Use Renamed by default" }).waitFor();
    assert.equal(service.view().profiles.find(s => s.id === local)!.custom?.hasKey, true);
    await hostedRow.getByRole("button", { name: "Edit", exact: true }).click();
    await modal.getByRole("button", { name: "Remove", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".audio-settings:first-of-type .ml-source").length === 1);
    assert.equal(service.view().defaultSource, local);
    service.saveSource({ name: "Linked", source: linked.id, model: "speech-model" });
    assert.ok(!JSON.stringify(service.view()).includes("model-secret"));
    await page.evaluate(() => (window as any).scribeAudioSettings.refresh());
    await page.locator(".ml-source").filter({ hasText: "Linked" }).getByRole("button", { name: "Edit", exact: true }).click();
    assert.equal(await page.locator("#audio-url").inputValue(), linked.baseUrl);
    assert.equal(await page.locator("#audio-url").isEditable(), false);
    assert.equal(await page.locator("#audio-key").isVisible(), false);
    await modal.getByRole("button", { name: "Source", exact: true }).click();
    await page.getByRole("option", { name: "Custom", exact: true }).click();
    await page.locator("#audio-url").fill("https://custom.invalid/v1");
    await modal.getByRole("button", { name: "Source", exact: true }).click();
    await page.getByRole("option", { name: linked.name, exact: true }).click();
    assert.equal(await page.locator("#audio-url").inputValue(), linked.baseUrl);
    await modal.getByRole("button", { name: "Source", exact: true }).click();
    await page.getByRole("option", { name: "Custom", exact: true }).click();
    assert.equal(await page.locator("#audio-url").inputValue(), "https://custom.invalid/v1");
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await modal.count(), 0);
    await page.getByRole("button", { name: "Model sources →" }).click();
    assert.equal(await page.locator("body").getAttribute("data-sources"), "open");
    assert.deepEqual(seen.errors, []);
  } finally { await browser.close(); }
});

test("text-to-speech has its own source list: add with the server's voices, choose, browser voice, off, test and remove", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Text-to-speech settings test" });
  try {
    const linked = { id: "linked", name: "Model API", baseUrl: "https://models.invalid/v1", apiKey: "model-secret", models: [] };
    const asked: (string | undefined)[] = [];
    const service = new AudioService({ sources: () => [linked], store: memoryStore(), tts: {
      speak: async () => ({ ok: false, error: "engine", message: "unused" }),
      voices: async ({ model }) => { asked.push(model); return { ok: true, voices: [{ id: "af_heart" }, { id: "bm_george" }], default: "af_heart", listed: true }; } } });
    service.saveSource({ name: "Transcribe only", source: linked.id, model: "whisper-1" });
    const { page, seen } = await audioSettingsPage(browser, service);
    const tts = page.locator(".audio-settings").nth(1), modal = page.locator(".audio-tts-editor");
    assert.equal(await tts.locator(".ml-source").count(), 2, "Off and This browser; speech-to-text sources are not listed");
    assert.ok(await tts.getByRole("radio", { name: "Turn text-to-speech off" }).isChecked());
    await page.getByRole("button", { name: "Add text-to-speech source" }).click();
    await page.locator("#audio-tts-name").fill("Kokoro");
    await page.locator("#audio-tts-url").fill("https://audio.invalid/tts/v1");
    await page.locator("#audio-tts-key").fill("tts-key");
    await page.locator("#audio-tts-model").fill("kokoro");
    await page.locator("#audio-tts-model").blur();
    await page.waitForFunction(() => document.querySelectorAll("#audio-tts-voice option").length === 3);
    assert.equal(asked.at(-1), "kokoro");
    await modal.getByRole("button", { name: "Voice", exact: true }).click();
    await page.getByRole("option", { name: "bm_george", exact: true }).click();
    await page.locator("#audio-tts-speed").fill("1.25");
    await page.locator("#audio-tts-stream").check();
    await modal.getByRole("button", { name: "Save", exact: true }).click();
    await tts.getByRole("radio", { name: "Read aloud with Kokoro" }).waitFor();
    const saved = service.view().ttsSources[0];
    assert.deepEqual({ ...saved, id: "" }, { id: "", name: "Kokoro", source: "__custom__", model: "kokoro", voice: "bm_george", speed: 1.25, stream: true,
      custom: { baseUrl: "https://audio.invalid/tts/v1", hasKey: true } });
    assert.equal(service.view().tts.source, saved.id, "the first source becomes the chosen one");
    assert.ok(await tts.getByRole("radio", { name: "Read aloud with Kokoro" }).isChecked());
    await tts.locator(".ml-source").filter({ hasText: "Kokoro" }).getByRole("button", { name: "Test", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Playback blocked" }).waitFor();
    assert.equal(await page.evaluate(() => (window as any).spoken), saved.id);
    await tts.getByRole("radio", { name: "Read aloud with this browser" }).check();
    await page.waitForFunction(async () => (await (await fetch("/api/audio/settings")).json()).tts.source === "__browser__");
    await tts.locator(".ml-source").filter({ hasText: "This browser" }).getByRole("button", { name: "Edit", exact: true }).click();
    const browserModal = page.locator(".audio-tts-editor");
    await page.waitForFunction(() => document.querySelectorAll("#audio-browser-voice option").length === 2);
    await browserModal.getByRole("button", { name: "Voice", exact: true }).click();
    await page.getByRole("option", { name: "Kate (en-GB)", exact: true }).click();
    await page.locator("#audio-browser-speed").fill("1.5");
    await browserModal.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(async () => (await (await fetch("/api/audio/settings")).json()).tts.voice === "Kate");
    assert.deepEqual(service.view().tts, { source: "__browser__", voice: "Kate", speed: 1.5 });
    await tts.getByRole("radio", { name: "Turn text-to-speech off" }).check();
    await page.waitForFunction(async () => !(await (await fetch("/api/audio/settings")).json()).tts.source);
    await tts.locator(".ml-source").filter({ hasText: "Kokoro" }).getByRole("button", { name: "Edit", exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("#audio-tts-voice")?.value === "bm_george");
    assert.equal(await page.locator("#audio-tts-key").getAttribute("placeholder"), "Saved (type to replace)");
    await modal.getByRole("button", { name: "Clear saved key" }).click();
    assert.equal(service.view().ttsSources[0].custom?.hasKey, true, "clearing waits for Save");
    await modal.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(async () => !(await (await fetch("/api/audio/settings")).json()).ttsSources[0].custom.hasKey);
    await tts.locator(".ml-source").filter({ hasText: "Kokoro" }).getByRole("button", { name: "Edit", exact: true }).click();
    assert.equal(await modal.getByRole("button", { name: "Clear saved key" }).count(), 0);
    await modal.getByRole("button", { name: "Remove", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".audio-settings:nth-of-type(2) .ml-source").length === 2);
    assert.equal(service.view().ttsSources.length, 0);
    assert.deepEqual(seen.errors, []);
  } finally { await browser.close(); }
});
