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
      if (path === "/models") return route.fulfill({ json: await service.models(body()) });
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
    // Only the linked source answers GET /models; custom URLs fall back to a text box.
    const service = new AudioService({ sources: () => [linked], store: memoryStore(),
      listModels: async source => source.baseUrl === linked.baseUrl ? { ok: true, flagged: true, models: [{ id: "moonshine-medium", default: true }, { id: "speech-model" }] }
        : { ok: false, error: "engine", message: "no list" } });
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
    // The linked source lists its models; the saved one is chosen.
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("#audio-model-pick")?.value === "speech-model"
      && !document.querySelector("#audio-model-pick")!.closest(".ag-field")!.hasAttribute("hidden"));
    assert.deepEqual(await page.locator("#audio-model-pick option").allTextContents(), ["moonshine-medium (default)", "speech-model"]);
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

test("text-to-speech: own source list, then model, voice, speed and streaming for the chosen source from the server's lists", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Text-to-speech settings test" });
  try {
    const linked = { id: "linked", name: "Model API", baseUrl: "https://models.invalid/v1", apiKey: "model-secret", models: [] };
    const asked: (string | undefined)[] = [];
    const service = new AudioService({ sources: () => [linked], store: memoryStore(),
      listModels: async () => ({ ok: true, flagged: true, models: [{ id: "kokoro", default: true, loaded: true, streaming: "sentence" },
        { id: "chatterbox-nano", streaming: "native" }, { id: "plain" }] }),
      tts: { speak: async () => ({ ok: false, error: "engine", message: "unused" }),
        voices: async ({ model }) => { asked.push(model); return { ok: true, voices: [{ id: "af_heart" }, { id: model === "chatterbox-nano" ? "narrator" : "bm_george" }], default: "af_heart", listed: true }; } } });
    service.saveSource({ name: "Transcribe only", source: linked.id, model: "whisper-1" });
    const { page, seen } = await audioSettingsPage(browser, service);
    const tts = page.locator(".audio-settings").nth(1), modal = page.locator(".audio-tts-editor");
    const visible = (id: string) => page.locator(id).evaluate(el => !(el.closest(".setting-row") as HTMLElement).hidden);
    const settings = async () => (await (await page.evaluate(() => fetch("/api/audio/settings").then(r => r.json()))));
    assert.equal(await tts.locator(".ml-source").count(), 2, "Off and This browser; speech-to-text sources are not listed");
    assert.ok(await tts.getByRole("radio", { name: "Turn text-to-speech off" }).isChecked());
    assert.equal(await visible("#audio-tts-speed"), false, "Off has nothing to set");

    // The editor only holds where the source is.
    await page.getByRole("button", { name: "Add text-to-speech source" }).click();
    assert.equal(await modal.locator("#audio-tts-voice, #audio-tts-model").count(), 0);
    await page.locator("#audio-tts-name").fill("Kokoro");
    await page.locator("#audio-tts-url").fill("https://audio.invalid/tts/v1");
    await page.locator("#audio-tts-key").fill("tts-key");
    await modal.getByRole("button", { name: "Save", exact: true }).click();
    await tts.getByRole("radio", { name: "Read aloud with Kokoro" }).waitFor();
    const id = service.view().ttsSources[0].id;
    assert.ok(await tts.getByRole("radio", { name: "Read aloud with Kokoro" }).isChecked(), "the first source becomes the chosen one");

    // Model list with the server's flags; the empty choice is the server default.
    await page.waitForFunction(() => document.querySelectorAll("#audio-tts-model option").length === 4);
    const labels = await page.locator("#audio-tts-model option").allTextContents();
    assert.deepEqual(labels, ["Server default (kokoro)", "kokoro (default, loaded)", "chatterbox-nano (native streaming)", "plain"]);
    assert.ok(await visible("#audio-tts-stream"), "the default model streams");
    await page.waitForFunction(() => document.querySelectorAll("#audio-tts-voice option").length === 3);
    await tts.getByRole("button", { name: "Voice", exact: true }).click();
    await page.getByRole("option", { name: "bm_george", exact: true }).click();
    await page.waitForFunction(async () => (await (await fetch("/api/audio/settings")).json()).ttsSources[0].voice === "bm_george");
    await tts.getByRole("switch", { name: "Stream while generating" }).click();
    await page.waitForFunction(async () => (await (await fetch("/api/audio/settings")).json()).ttsSources[0].stream === true);
    await page.locator("#audio-tts-speed").fill("1.25");
    await page.locator("#audio-tts-speed").blur();
    await page.waitForFunction(async () => (await (await fetch("/api/audio/settings")).json()).ttsSources[0].speed === 1.25);

    // A model without streaming hides the switch and turns streaming off; another model lists its own voices.
    await tts.getByRole("button", { name: "Model", exact: true }).click();
    await page.getByRole("option", { name: "plain", exact: true }).click();
    await page.waitForFunction(async () => (await (await fetch("/api/audio/settings")).json()).ttsSources[0].model === "plain");
    assert.equal((await settings()).ttsSources[0].stream, undefined);
    await page.waitForFunction(() => document.querySelector("#audio-tts-stream")!.closest(".setting-row")!.hasAttribute("hidden"));
    await tts.getByRole("button", { name: "Model", exact: true }).click();
    await page.getByRole("option", { name: "chatterbox-nano (native streaming)", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("#audio-tts-voice option")].some(o => o.textContent === "narrator"));
    assert.ok(asked.includes("chatterbox-nano"));
    assert.match(await page.locator("#audio-tts-stream-label").getAttribute("data-tooltip") ?? "", /natively/);
    assert.deepEqual({ ...service.view().ttsSources[0], id: "" }, { id: "", name: "Kokoro", source: "__custom__", model: "chatterbox-nano", voice: "bm_george", speed: 1.25,
      custom: { baseUrl: "https://audio.invalid/tts/v1", hasKey: true } });

    await tts.locator(".ml-source").filter({ hasText: "Kokoro" }).getByRole("button", { name: "Test", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Playback blocked" }).waitFor();
    assert.equal(await page.evaluate(() => (window as any).spoken), id);

    // This browser: voice and speed only.
    await tts.getByRole("radio", { name: "Read aloud with this browser" }).check();
    await page.waitForFunction(() => document.querySelector("#audio-tts-model")!.closest(".setting-row")!.hasAttribute("hidden")
      && document.querySelectorAll("#audio-tts-voice option").length === 2);
    assert.equal(await visible("#audio-tts-stream"), false);
    await tts.getByRole("button", { name: "Voice", exact: true }).click();
    await page.getByRole("option", { name: "Kate (en-GB)", exact: true }).click();
    await page.locator("#audio-tts-speed").fill("1.5");
    await page.locator("#audio-tts-speed").blur();
    await page.waitForFunction(async () => (await (await fetch("/api/audio/settings")).json()).tts.speed === 1.5);
    assert.deepEqual(service.view().tts, { source: "__browser__", voice: "Kate", speed: 1.5 });
    assert.equal(service.view().ttsSources[0].voice, "bm_george", "the source keeps its own voice");

    await tts.getByRole("radio", { name: "Turn text-to-speech off" }).check();
    await page.waitForFunction(() => document.querySelector("#audio-tts-speed")!.closest(".setting-row")!.hasAttribute("hidden"));
    await tts.locator(".ml-source").filter({ hasText: "Kokoro" }).getByRole("button", { name: "Edit", exact: true }).click();
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
