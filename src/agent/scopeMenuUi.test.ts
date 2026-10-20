import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "../chromium.js";
import { loadChatFixture } from "../testSupport/shell.js";

test("scope menu stays in place across successive selections in sidebar and fullscreen", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Scope menu position test" });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://scope.test/**", route => route.fulfill({ contentType: "text/html",
      body: '<main style="position:absolute;left:500px;top:100px;width:500px;height:700px;display:flex"></main>' }));
    await page.goto("http://scope.test/");
    for (const name of ["app.css", "agent.css"]) {
      await page.addStyleTag({ content: fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8") });
    }
    const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    await loadChatFixture(page, source.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/,
      "  window.scopeTest = { ChatView, S, closeMenu };"));
    for (const variant of ["side", "full"]) {
      await page.evaluate(variant => {
        const { ChatView, S } = (window as any).scopeTest;
        S.sideOpen = true;
        S.config.providers = [{ id: "claude", label: "Claude", available: true }];
        const view = new ChatView(variant);
        (window as any).scopeView = view;
        document.querySelector("main")!.replaceChildren(view.root);
        view.renderAll();
      }, variant);
      const chip = page.locator(".ag-scope-chip");
      await chip.click();
      const oldAnchor = await chip.elementHandle();
      const menu = page.locator(".ag-menu");
      const before = await menu.boundingBox();
      assert.ok(before && before.x > 100 && before.y > 50);
      const scopeNone = menu.locator(".ag-menu-item").filter({ hasText: "No Scribe pages" });
      await scopeNone.click();
      assert.equal(await oldAnchor!.evaluate(el => el.isConnected), false);
      assert.deepEqual(await menu.boundingBox(), before, variant);
      assert.equal(await scopeNone.evaluate(el => el.classList.contains("on")), true);
      await menu.locator(".ag-menu-item").filter({ hasText: "No files or shell" }).click();
      assert.deepEqual(await menu.boundingBox(), before, variant);
      await menu.locator(".ag-menu-item").filter({ hasText: "All pages, not tied to one" }).click();
      assert.deepEqual(await menu.boundingBox(), before, variant);
      assert.equal(await page.evaluate(() => (window as any).scopeView.settings().scope.kind), "global");
      // The replacement scope button still toggles the open menu shut.
      await chip.click();
      assert.equal(await menu.count(), 0);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
