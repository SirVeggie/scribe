import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "./chromium.js";
import { loadShellScripts } from "./testSupport/shell.js";

test("folder instructions menu, resizing, save, cancel and indicator", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Folder instructions UI test" });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "");
    await page.route("http://scribe-fixture.test/", route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto("http://scribe-fixture.test/");
    await page.addStyleTag({ content: fs.readFileSync(new URL("../public/app.css", import.meta.url), "utf8") });
    await loadShellScripts(page, { scripts: ["pointer-drag.js", "dom-sync.js", "select.js", "library.js"] });
    await page.evaluate(() => {
      const w = window as any;
      document.documentElement.removeAttribute("data-restoring");
      document.getElementById("refresh-overlay")?.remove();
      w.folder = { id: "work", name: "Work", parentId: null, pos: 0 };
      w.saves = [];
      w.fetch = async (url: string, options: any) => {
        w.saves.push({ url, method: options.method, ...JSON.parse(options.body) });
        Object.assign(w.folder, JSON.parse(options.body));
        w.library.render();
        return { ok: true };
      };
      document.getElementById("library")?.removeAttribute("hidden");
      w.library = w.createLibrary({
        folders: () => [w.folder], pages: () => [], paneOpen: () => true,
        icons: { folderInstructions: '<svg width="14" height="14"></svg>' },
        hoverCard: { hide() {} }, showNotice(message: string) { throw new Error(message); },
      });
      w.library.render();
    });
    const folder = page.locator('.lib-folder[data-id="work"]');
    const open = async () => {
      await folder.dispatchEvent("contextmenu", { clientX: 100, clientY: 100 });
      const labels = await page.locator('.lib-menu button').allTextContents();
      assert.ok(labels.indexOf("Move to…") < labels.indexOf("Agent instructions"));
      await page.getByRole("menuitem", { name: "Agent instructions", exact: true }).click();
    };
    await open();
    assert.equal(await page.locator('.folder-instructions h2').textContent(), "Work instructions");
    const description = page.getByLabel("Description", { exact: true });
    const instructions = page.getByLabel("Instructions", { exact: true });
    await description.fill("Release work");
    await instructions.fill("Rule\n".repeat(100));
    const tall = await instructions.boundingBox();
    assert.ok(tall && tall.height <= 542 && tall.height >= 500);
    await instructions.fill("Always lint.");
    assert.ok((await instructions.boundingBox())!.height < tall!.height);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator('.folder-instructions').waitFor({ state: "detached" });
    assert.deepEqual(await page.evaluate(() => (window as any).saves[0]), {
      url: "/api/folders/work/instructions", method: "PUT", description: "Release work", instructions: "Always lint.",
    });
    assert.equal(await folder.locator('.lib-instructions-icon + .lib-count').count(), 1);
    await open();
    assert.equal(await instructions.inputValue(), "Always lint.");
    await instructions.fill("Unsent");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).saves.length), 1);
    await open();
    await description.fill("");
    await instructions.fill("");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator('.folder-instructions').waitFor({ state: "detached" });
    assert.equal(await folder.locator('.lib-instructions-icon').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
