import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "../chromium.js";
import { loadChatFixture } from "../testSupport/shell.js";

test("diff viewer collapses files with mouse and keyboard, toggles all, and expands sidebar targets", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Diff viewer collapse test" });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const files = [
      { path: "src/hello.ts", status: "M", added: 1, removed: 1 },
      { path: "image.png", status: "A", binary: true },
    ];
    const patch = "diff --git a/src/hello.ts b/src/hello.ts\n--- a/src/hello.ts\n+++ b/src/hello.ts\n@@ -1 +1 @@\n-before\n+after\n";
    await page.route("http://diff.test/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/changes")) return route.fulfill({ json: { files } });
      if (path.endsWith("/patch")) return route.fulfill({ json: { patch } });
      return route.fulfill({ contentType: "text/html", body: "<main></main>" });
    });
    await page.goto("http://diff.test/");
    for (const name of ["app.css", "agent.css"]) {
      await page.addStyleTag({ content: fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8") });
    }
    const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    await loadChatFixture(page, source.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/,
      "  window.diffTest = { openDiff };"));
    await page.evaluate(() => (window as any).diffTest.openDiff({ kind: "thread", threadId: "t1" }));
    const bodies = page.locator(".ag-diff-section-body");
    await bodies.last().waitFor();
    assert.equal(await page.locator(".ag-diff-section-body:visible").count(), 2);
    const first = page.locator(".ag-diff-toggle").first();
    await first.click();
    assert.equal(await bodies.first().isVisible(), false);
    assert.equal(await bodies.last().isVisible(), true);
    await first.press("Enter");
    assert.equal(await first.getAttribute("aria-expanded"), "true");
    await first.press("Space");
    assert.equal(await first.getAttribute("aria-expanded"), "false");
    await page.getByRole("button", { name: "Collapse all", exact: true }).click();
    assert.equal(await page.locator(".ag-diff-section-body:visible").count(), 0);
    assert.equal(await page.locator(".ag-diff-section-head:visible").count(), 2);
    await page.getByRole("button", { name: "Expand all", exact: true }).click();
    assert.equal(await page.locator(".ag-diff-section-body:visible").count(), 2);
    await page.getByRole("button", { name: "Collapse all", exact: true }).click();
    await page.locator(".ag-diff-filebtn").first().click();
    assert.equal(await bodies.first().isVisible(), true);
    assert.equal(await bodies.last().isVisible(), false);
    await page.locator(".ag-diff-filebtn").last().click();
    assert.equal(await bodies.last().textContent(), "Binary file");
    assert.equal(await bodies.last().isVisible(), true);
    await page.getByRole("button", { name: "Close (Esc)", exact: true }).click();
    assert.equal(await page.locator(".ag-diffview").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
