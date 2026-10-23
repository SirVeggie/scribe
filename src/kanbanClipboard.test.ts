import { templateHtml } from "./testSupport/templates.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";
import { markdownVendor } from "./vendorFixture.js";

test("comments can be copied from a separate-origin Scribe page", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Kanban clipboard test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    const constants = app.slice(app.indexOf("  const SANDBOX ="), app.indexOf("  const LIVE_FRAME_CAP"));
    const loader = app.slice(app.indexOf("  function loadFrame("), app.indexOf("  function discardFrame("));
    const kanban = templateHtml("kanban");
    const comment = "Copy **Markdown** exactly.\n\nSecond paragraph.";
    const state = {
      columns: [{ id: "todo", title: "Todo" }], labels: [], settings: {}, nextNum: 2,
      cards: [{ id: "c1", num: 1, col: "todo", title: "Copy this comment", createdAt: 1,
        description: "", labels: [], priority: 0, checklist: [], images: [], blockedBy: [], movedAt: 1,
        comments: [{ id: "cm1", by: "user", at: 1, text: comment }] }],
    };
    await page.route("https://content.test/**", route => {
      const vendor = markdownVendor(route.request().url());
      if (vendor !== null) return route.fulfill({ contentType: "text/javascript", body: vendor });
      return route.fulfill({ contentType: "text/html", body:
        kanban.replace("<head>", `<head><script>window.scribe = {
          id: 'board', title: 'Board', state: ${JSON.stringify(state)}, local: {},
          onChange() {}, set(patch) { Object.assign(this.state, patch); }, setLocal(patch) { Object.assign(this.local, patch); }, signal() {}
        };</script>`) });
    });
    await page.route("https://scribe.test/**", route => route.fulfill({ contentType: "text/html", body: `<iframe style="width:1300px;height:900px"></iframe><script>
      ${constants}
      const cancelPageAudio = () => {}, viewUrl = () => 'https://content.test/board';
      ${loader}
      const frame = document.querySelector('iframe'); frame.sandbox = SANDBOX;
      loadFrame(frame, { id: 'board' });
    </script>` }));
    await page.goto("https://scribe.test/");
    const frame = page.frameLocator("iframe");
    await frame.locator('.card[data-id="c1"] .card-title').click();
    await frame.locator(".comment").hover();
    await frame.locator(".comment .copy").click();
    await frame.getByText("Copied the comment.", { exact: true }).waitFor();
    await page.context().grantPermissions(["clipboard-read"], { origin: "https://scribe.test" });
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied.replace(/\r\n/g, "\n"), comment);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
