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

test("speech settings add, edit, select, test and remove multiple sources", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Custom speech settings test" });
  try {
    const page = await browser.newPage();
    const service = new AudioService({ sources: () => [], store: memoryStore() });
    let tested = "";
    await page.route("http://audio.test/**", route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (path.endsWith("/test")) { tested = req.postDataJSON().sourceId; return route.fulfill({ json: { ok: true, text: "Words" } }); }
      let view = service.view();
      if (path === "/api/audio/sources") view = service.saveSource(req.postDataJSON());
      else if (path.startsWith("/api/audio/sources/")) {
        const id = decodeURIComponent(path.split("/").at(-1)!);
        view = req.method() === "DELETE" ? service.removeSource(id) : service.saveSource(req.postDataJSON(), id);
      } else if (req.method() === "PUT") view = service.update(req.postDataJSON());
      return route.fulfill({ json: view });
    });
    await page.goto("http://audio.test/");
    await page.addStyleTag({ content: source("app.css") });
    await page.addScriptTag({ content: `window.scribeAudio = { refresh: async () => (await fetch("/api/audio/settings")).json(), device: () => "" }; window.scribeChat = { openModelSources: () => document.body.dataset.sources = "open" };` });
    await page.addScriptTag({ content: source("select.js") });
    await page.addScriptTag({ content: source("audio-settings.js") });
    await page.evaluate(async () => {
      const settings = (window as any).scribeAudioSettings;
      document.body.append(...settings.sections); await settings.refresh();
    });
    assert.equal(await page.locator("#audio-url").isVisible(), false);
    await page.getByRole("button", { name: "Add source", exact: true }).click();
    await page.locator("#audio-name").fill("Local");
    await page.locator("#audio-url").fill("http://localhost:9000/v1");
    await page.locator("#audio-key").fill("custom-key");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("radio", { name: "Use Local by default" }).waitFor();
    const local = service.view().defaultSource!;
    await page.getByRole("button", { name: "Add source", exact: true }).click();
    await page.locator("#audio-name").fill("Hosted");
    await page.locator("#audio-url").fill("https://speech.invalid/v1");
    await page.locator("#audio-model").fill("speech-model");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("radio", { name: "Use Hosted by default" }).check();
    await page.waitForFunction(() => document.querySelectorAll(".ml-source").length === 2);
    const hosted = service.view().profiles.find(s => s.name === "Hosted")!.id;
    const hostedRow = page.locator(".ml-source").filter({ hasText: "Hosted" });
    await hostedRow.getByRole("button", { name: "Test", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Transcript: Words" }).waitFor();
    assert.equal(tested, hosted); assert.equal(service.view().defaultSource, hosted);
    await page.locator(".ml-source").filter({ hasText: "Local" }).getByRole("button", { name: "Edit", exact: true }).click();
    await page.locator("#audio-name").fill("Renamed");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("radio", { name: "Use Renamed by default" }).waitFor();
    assert.equal(service.view().profiles.find(s => s.id === local)!.custom?.hasKey, true);
    await hostedRow.getByRole("button", { name: "Remove", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".ml-source").length === 1);
    assert.equal(service.view().defaultSource, local);
    await page.getByRole("button", { name: "Model sources →" }).click();
    assert.equal(await page.locator("body").getAttribute("data-sources"), "open");
  } finally { await browser.close(); }
});
