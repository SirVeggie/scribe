import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import type { Browser } from "playwright-core";
import { launchChromium } from "./chromium.js";
import { loadShellScripts } from "./testSupport/shell.js";

async function fixture(browser: Browser) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "");
  await page.route("http://selection.test/", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://selection.test/");
  await page.addStyleTag({ content: fs.readFileSync(new URL("../public/app.css", import.meta.url), "utf8") });
  await loadShellScripts(page, { scripts: ["pointer-drag.js", "dom-sync.js", "select.js", "files.js", "lens.js", "library.js"] });
  await page.evaluate(() => {
    const w = window as any;
    document.documentElement.removeAttribute("data-restoring");
    document.getElementById("refresh-overlay")?.remove();
    document.getElementById("library")?.removeAttribute("hidden");
    const sidebar = document.getElementById("side-pane")!;
    sidebar.classList.remove("closed");
    sidebar.removeAttribute("inert");
    sidebar.removeAttribute("aria-hidden");
    w.folders = [
      { id: "work", name: "Work", pos: 0 },
      { id: "nested", name: "Nested", parentId: "work", pos: 0 },
      { id: "target", name: "Target", pos: 1 },
    ];
    w.pages = [
      { id: "c", title: "C", folderId: "nested", libPos: 0 },
      ...["a", "b"].map((id, libPos) => ({ id, title: id.toUpperCase(), folderId: "work", libPos })),
      ...["x", "y", "z"].map((id, libPos) => ({ id, title: id.toUpperCase(), libPos })),
    ];
    w.requests = []; w.opened = []; w.exported = [];
    w.choices = []; w.choice = "delete"; w.recycle = false;
    w.fetch = async (url: string, options: any) => {
      const body = options.body ? JSON.parse(options.body) : {};
      w.requests.push({ url, method: options.method, ...body });
      if (url.endsWith("/instructions")) Object.assign(w.folders.find((f: any) => url.includes(`/${f.id}/`)), body);
      return { ok: true, json: async () => ({}) };
    };
    w.scribeChat = { pickWorkspace: async () => "C:\\Work" };
    w.library = w.createLibrary({
      folders: () => w.folders, pages: () => w.pages, paneOpen: () => true,
      space: () => w.activeSpace,
      findAny: (id: string) => w.pages.find((p: any) => p.id === id),
      isOpen: () => false, isUnread: () => false, icons: {},
      hoverCard: { hide() {}, bind() {}, suspend() {}, resume() {} },
      showNotice() {}, confirm: async () => true, fileSettings: () => ({}),
      choose: async (message: string, _buttons: any, opts: any = {}) => {
        w.choices.push({ message, checked: opts.check?.checked });
        if (opts.check) opts.check.checked = w.recycle;
        return w.choice;
      },
      modeFromEvent: (event: any) => event.shiftKey ? "split" : null,
      openIn: (id: string, mode: string) => w.opened.push({ id, mode }),
      openPage: (id: string) => w.opened.push({ id }), clearStripSlot() {}, stripSlot: () => null,
      downloadSelectionExport: (items: any) => { w.exported = items; },
    });
    document.addEventListener("keydown", event => { if (event.key === "Escape") w.library.onEscape(); });
    w.library.render();
  });
  return { page, errors };
}

test("Lens editor autosaves controls and pending text on outside click or Escape", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Lens editor test" });
  try {
    const { page, errors } = await fixture(browser);
    await page.evaluate(() => {
      const w = window as any;
      w.activeSpace = { id: "s1", name: "Work", lens: { on: false, match: "all", conditions: [{ type: "about", text: "audio" }] } };
      w.library.render();
    });
    const open = () => page.locator("#library-lens").dispatchEvent("contextmenu");
    const latest = () => page.evaluate(() => (window as any).requests.at(-1));
    await open();
    const dialog = page.locator(".lens-editor");
    assert.equal(await dialog.getByRole("button", { name: /^(Save|Cancel)$/ }).count(), 0);
    assert.equal(await dialog.getByRole("switch").count(), 0);
    assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole("button", { name: "Not", exact: true }).click();
    await page.waitForFunction(() => (window as any).requests.at(-1)?.lens.conditions[0]?.not === true);
    await dialog.getByLabel("Topic", { exact: true }).fill("music");
    await page.mouse.click(1, 1);
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => (window as any).requests.at(-1)?.lens.conditions[0]?.text === "music");
    assert.equal((await latest()).url, "/api/spaces/s1");
    await open();
    await dialog.getByLabel("Remove condition", { exact: true }).click();
    await page.waitForFunction(() => (window as any).requests.at(-1)?.lens.conditions.length === 0);
    // Adding an empty text condition is kept in the editor until it has a value.
    await dialog.getByRole("button", { name: "Add condition", exact: true }).click();
    await dialog.getByRole("option", { name: "About (semantic)", exact: true }).click();
    await dialog.getByLabel("Topic", { exact: true }).fill("design");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => (window as any).requests.at(-1)?.lens.conditions[0]?.text === "design");
    assert.equal((await latest()).lens.on, false, "editing conditions preserves the icon's off state");
    await page.locator("#library-lens").click();
    await page.waitForFunction(() => (window as any).requests.at(-1)?.lens.on === true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("Library selection entry, toggles, ranges, folder coverage and split clicks", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Library selection test" });
  try {
    const { page, errors } = await fixture(browser);
    const row = (id: string) => page.locator(`.lib-row[data-id="${id}"]`);
    const selected = () => page.locator(".lib-selected").evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.id));
    await row("x").click({ modifiers: ["Shift"] });
    assert.deepEqual(await page.evaluate(() => (window as any).opened), [{ id: "x", mode: "split" }]);
    assert.equal(await page.locator(".lib-check").count(), 0);
    await page.getByLabel("Library actions", { exact: true }).click();
    await page.getByRole("menuitem", { name: "Select…", exact: true }).click();
    assert.equal(await page.locator(".lib-check").count(), 9);
    await row("a").click();
    await row("b").click({ modifiers: ["Control"] });
    assert.deepEqual(await selected(), ["a", "b"]);
    await row("a").click(); await row("b").click();
    assert.equal(await page.locator(".lib-check").count(), 0);

    await row("work").click({ modifiers: ["Control"] });
    assert.equal(await page.locator(".lib-covered").count(), 4);
    await row("a").click({ modifiers: ["Shift"] });
    assert.deepEqual(await selected(), ["nested", "a"]);
    assert.equal(await row("b").getAttribute("aria-selected"), "false");
    await row("b").click({ modifiers: ["Shift"] });
    assert.deepEqual(await selected(), ["work"]);
    await row("a").click({ modifiers: ["Shift"] });
    assert.deepEqual(await selected(), ["nested", "a"]);
    assert.equal(await row("b").getAttribute("aria-selected"), "false");
    await row("b").click({ modifiers: ["Shift"] });
    await row("work").locator(".lib-chevron").click();
    assert.equal(await row("a").count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".lib-check").count(), 0);
    await row("work").click();
    await row("a").click({ modifiers: ["Control"] });
    await row("a").click({ modifiers: ["Shift"] });
    await page.keyboard.press("Escape");
    await row("x").click({ modifiers: ["Shift"] });
    assert.equal(await page.evaluate(() => (window as any).opened.length), 2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("file deletion defaults to keeping files and folder choices include nested files", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "File deletion choices test" });
  try {
    const { page, errors } = await fixture(browser);
    await page.evaluate(() => {
      const w = window as any;
      w.pages.find((p: any) => p.id === "c").file = { path: "C:/Notes/nested.md" };
      w.pages.find((p: any) => p.id === "x").file = { path: "C:/Notes/x.md" };
      w.pages.find((p: any) => p.id === "b").file = { path: "C:/Copies/b.md", copy: true };
      w.library.render();
    });
    const remove = async (id: string, label = "Delete") => {
      await page.locator(`.lib-row[data-id="${id}"]`).dispatchEvent("contextmenu", { clientX: 130, clientY: 120 });
      await page.getByRole("menuitem", { name: label, exact: true }).click();
    };
    await remove("x");
    assert.deepEqual(await page.evaluate(() => (window as any).requests.at(-1)), { url: "/api/tabs/x?permanent=true", method: "DELETE" });
    assert.equal(await page.evaluate(() => (window as any).choices.at(-1).checked), false);
    await page.evaluate(() => { (window as any).choice = null; });
    await remove("work", "Delete folder…");
    assert.equal(await page.evaluate(() => (window as any).requests.length), 1, "cancel leaves pages and files alone");
    await page.evaluate(() => { const w = window as any; w.choice = "lift"; w.recycle = true; });
    await remove("work", "Delete folder…");
    assert.deepEqual(await page.evaluate(() => (window as any).requests.at(-1)), { url: "/api/folders/work?mode=lift", method: "DELETE" });
    await page.evaluate(() => { (window as any).choice = "delete"; });
    await remove("work", "Delete folder…");
    assert.deepEqual(await page.evaluate(() => (window as any).requests.at(-1)), {
      url: "/api/library/delete", method: "POST", pages: ["c"], folders: ["work"], recycle: ["c"],
    });
    await page.locator('.lib-row[data-id="work"]').click({ modifiers: ["Control"] });
    await page.locator('.lib-row[data-id="x"]').click();
    await remove("work", "Delete…");
    const bulk = await page.evaluate(() => (window as any).requests.at(-1));
    assert.deepEqual(bulk.recycle.sort(), ["c", "x"]);
    assert.deepEqual(bulk.pages.sort(), ["c", "x"]);
    assert.deepEqual(bulk.folders, ["work"]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("Library bulk menus target roots, apply workspaces to covered pages and preserve instructions", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Library bulk actions test" });
  try {
    const { page, errors } = await fixture(browser);
    const row = (id: string) => page.locator(`.lib-row[data-id="${id}"]`);
    const context = async () => row("a").dispatchEvent("contextmenu", { clientX: 130, clientY: 120 });
    const requests = () => page.evaluate(() => (window as any).requests);
    await row("work").click({ modifiers: ["Control"] });
    await row("x").click();
    await context();
    assert.equal(await page.getByRole("menuitem", { name: "Select…", exact: true }).count(), 0);
    await page.getByRole("menuitem", { name: "Export", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).exported), [{ kind: "folder", id: "work" }, { kind: "page", id: "x" }]);
    await context();
    await page.getByRole("menuitem", { name: "Agent access", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Ask always", exact: true }).click();
    assert.deepEqual((await requests()).map((r: any) => r.url), ["/api/folders/work/access", "/api/tabs/x/access"]);
    await context();
    await page.getByRole("menuitem", { name: "Agent instructions", exact: true }).click();
    await page.getByLabel("Instructions", { exact: true }).fill("Keep pages as they are.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    assert.equal((await requests()).filter((r: any) => r.url.endsWith("/instructions")).length, 1);
    assert.equal((await requests())[2].url, "/api/folders/work/instructions");
    await context();
    await page.getByRole("menuitem", { name: "Set workspace…", exact: true }).click();
    await page.waitForFunction(() => (window as any).requests.length === 7);
    assert.deepEqual((await requests()).filter((r: any) => r.url.endsWith("/workspace")).map((r: any) => r.url).sort(),
      ["a", "b", "c", "x"].map(id => `/api/tabs/${id}/workspace`));
    await context();
    await page.getByRole("menuitem", { name: "Move to…", exact: true }).click();
    assert.equal(await page.locator(".lib-picker-row").filter({ hasText: "Work" }).count(), 0);
    await page.locator(".lib-picker-row").filter({ hasText: "Target" }).click();
    await page.waitForFunction(() => (window as any).requests.length === 9);
    assert.deepEqual((await requests()).slice(-2).map((r: any) => r.url), ["/api/folders/work/move", "/api/tabs/x/move"]);
    await context();
    await page.getByRole("menuitem", { name: "Delete…", exact: true }).click();
    await page.waitForFunction(() => (window as any).requests.length === 10);
    assert.deepEqual((await requests()).at(-1), { url: "/api/library/delete", method: "POST", pages: ["x"], folders: ["work"], recycle: [] });
    assert.equal(await page.locator(".lib-check").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("bulk folder instructions preserve each folder's untouched mixed values", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Bulk folder instructions test" });
  try {
    const { page, errors } = await fixture(browser);
    await page.evaluate(() => {
      const w = window as any;
      Object.assign(w.folders[0], { description: "Work summary", instructions: "Work rule" });
      Object.assign(w.folders[2], { description: "Target summary", instructions: "Target rule" });
      w.library.render();
    });
    await page.locator('.lib-row[data-id="work"]').click({ modifiers: ["Control"] });
    await page.locator('.lib-row[data-id="target"]').click();
    await page.locator('.lib-row[data-id="work"]').dispatchEvent("contextmenu", { clientX: 130, clientY: 120 });
    await page.getByRole("menuitem", { name: "Agent instructions", exact: true }).click();
    assert.equal(await page.getByLabel("Instructions", { exact: true }).getAttribute("placeholder"), "Mixed values");
    await page.getByLabel("Description", { exact: true }).fill("Shared description");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const saved = await page.evaluate(() => (window as any).requests);
    assert.deepEqual(saved.map((request: any) => [request.url, request.description, request.instructions]), [
      ["/api/folders/work/instructions", "Shared description", "Work rule"],
      ["/api/folders/target/instructions", "Shared description", "Target rule"],
    ]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("Library drag moves selected pages in tree order and rejects a selected subtree", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Library selection drag test" });
  try {
    const { page, errors } = await fixture(browser);
    const row = (id: string) => page.locator(`.lib-row[data-id="${id}"]`);
    await row("b").click({ modifiers: ["Control"] });
    await row("a").click();
    const from = (await row("a").boundingBox())!, to = (await row("z").boundingBox())!;
    await page.mouse.move(from.x + 100, from.y + from.height / 2); await page.mouse.down();
    await page.mouse.move(to.x + 100, to.y + to.height - 2, { steps: 8 });
    assert.match(await page.locator(".lib-ghost").textContent() || "", /2 items/);
    await page.mouse.up();
    await page.waitForFunction(() => (window as any).requests.length === 2);
    assert.deepEqual(await page.locator(".lib-page").evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.id)), ["c", "x", "y", "z", "a", "b"]);
    assert.equal(await page.locator(".lib-selected").count(), 2);
    await page.keyboard.press("Escape");
    await row("work").click({ modifiers: ["Control"] });
    const folder = (await row("work").boundingBox())!, nested = (await row("nested").boundingBox())!;
    await page.mouse.move(folder.x + 100, folder.y + folder.height / 2); await page.mouse.down();
    await page.mouse.move(nested.x + 100, nested.y + nested.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => (window as any).requests.length), 2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
