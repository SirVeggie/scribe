import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "./chromium.js";
import { loadShellScripts } from "./testSupport/shell.js";

test("agent access submenus save page and folder levels and remove grants", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Agent access submenu test" });
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
      document.getElementById("library")?.removeAttribute("hidden");
      w.folder = { id: "work", name: "Work", parentId: null, pos: 0, access: { level: "trusted" } };
      w.tab = { id: "note", title: "Note", folderId: "work", access: { level: "open", origin: { kind: "folder", id: "work" }, grants: [{ kind: "folder", id: "work" }] } };
      w.saves = [];
      w.fetch = async (url: string, options: any) => {
        const body = JSON.parse(options.body);
        w.saves.push({ url, ...body });
        const item = url.includes("/tabs/") ? w.tab : w.folder;
        if (body.level) item.access.level = body.level;
        if (body.removeGrants) item.access.grants = [];
        w.library.render();
        return { ok: true, json: async () => ({}) };
      };
      w.library = w.createLibrary({
        folders: () => [w.folder], pages: () => [w.tab], paneOpen: () => true,
        findAny: (id: string) => id === "note" ? w.tab : null,
        isOpen: () => false, isUnread: () => false,
        icons: {}, hoverCard: { hide() {}, bind() {} }, showNotice(message: string) { throw new Error(message); },
      });
      w.library.render();
    });
    const openPage = async (x = 100, y = 100) => {
      await page.evaluate(({ x, y }) => (window as any).library.pageMenu({
        preventDefault() {}, stopPropagation() {}, clientX: x, clientY: y, target: document.body,
      }, "note"), { x, y });
    };
    await openPage();
    const access = page.getByRole("menuitem", { name: "Agent access", exact: true });
    await access.hover();
    const sub = page.getByRole("menu", { name: "Agent access", exact: true });
    await sub.waitFor({ state: "visible" });
    assert.equal(await sub.getByRole("menuitemradio").count(), 5);
    assert.equal(await sub.getByRole("menuitemradio", { name: "Normal", exact: true }).getAttribute("aria-checked"), "true");
    assert.equal(await sub.getByText("Parent folder: Trusted only", { exact: true }).count(), 1);
    assert.equal(await sub.getByText("Created from Work/", { exact: true }).count(), 1);
    assert.equal(await page.locator("dialog.agent-access").count(), 0);
    await sub.getByRole("menuitemradio", { name: "Ask always", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).saves[0]), { url: "/api/tabs/note/access", level: "ask" });
    assert.equal(await page.locator(".lib-menu").isVisible(), false);
    await openPage(1090, 890);
    await access.focus();
    await access.press("ArrowRight");
    assert.equal(await sub.getByRole("menuitemradio", { name: "Open", exact: true }).evaluate(el => el === document.activeElement), true);
    const box = (await sub.boundingBox())!;
    assert.ok(box.x >= 8 && box.x + box.width <= 1092 && box.y >= 8 && box.y + box.height <= 892);
    await sub.getByRole("menuitemradio", { name: "Open", exact: true }).press("ArrowDown");
    await sub.getByRole("menuitemradio", { name: "Normal", exact: true }).press("ArrowLeft");
    assert.equal(await sub.isVisible(), false);
    assert.equal(await access.evaluate(el => el === document.activeElement), true);
    await access.click();
    await sub.getByRole("menuitem", { name: "Chats here also reach", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Remove Work/", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).saves[1]), { url: "/api/tabs/note/access", removeGrants: [{ kind: "folder", id: "work" }] });
    await page.locator('.lib-folder[data-id="work"]').dispatchEvent("contextmenu", { clientX: 100, clientY: 100 });
    await access.click();
    assert.equal(await sub.getByRole("menuitemradio", { name: "Trusted only", exact: true }).getAttribute("aria-checked"), "true");
    await sub.getByRole("menuitemradio", { name: "Restricted", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).saves[2]), { url: "/api/folders/work/access", level: "restricted" });
    await openPage();
    await access.hover();
    await page.locator(".lib-menu > button").first().hover();
    assert.equal(await sub.isVisible(), false);
    await page.mouse.click(700, 700);
    assert.equal(await page.locator(".lib-menu").isVisible(), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
