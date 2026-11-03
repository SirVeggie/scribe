import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";
import { BOARD_BRIDGE_JS } from "./bridge.js";

const BOOT = { id: "page", state: { title: "A" }, stateRevision: 1 };

const PAGE = `<script>window.__SCRIBE_BOOT__=${JSON.stringify(BOOT)};</script><script>${BOARD_BRIDGE_JS}</script>
<script>
  window.errors = [];
  scribe.onError(function (info) { errors.push(info); });
</script>`;

test("a save the daemon refuses for good is dropped and reported once; a server error keeps retrying", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Bridge save error test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    let status = 403;
    let puts = 0;
    await page.route("http://bridge.test/**", (route) => {
      const url = route.request().url();
      if (url.includes("/api/tabs/page/state")) {
        if (route.request().method() === "PUT") {
          puts += 1;
          return route.fulfill({ status, json: { error: "not allowed" } });
        }
        return route.fulfill({ json: { state: { title: "A" }, stateRevision: 1 } });
      }
      return route.fulfill({ contentType: "text/html", body: url.endsWith("/frame") ? PAGE : '<iframe src="/frame"></iframe>' });
    });
    await page.goto("http://bridge.test/");
    const frame = page.frames()[1];
    await frame.waitForFunction(() => Array.isArray((window as any).errors));

    // 403: one request, the edit is dropped, the state reloads, and the page hears why.
    await frame.evaluate(() => { (window as any).scribe.set({ title: "B" }); (window as any).scribe.flush(); });
    await frame.waitForFunction(() => (window as any).errors.length === 1);
    await frame.waitForFunction(() => (window as any).scribe.state.title === "A");
    assert.deepEqual(await frame.evaluate(() => (window as any).errors[0]), { kind: "save", status: 403, message: "not allowed" });
    await page.waitForTimeout(2500);
    assert.equal(puts, 1);

    // 503: the edit stays and is sent again; nothing is reported.
    status = 503;
    await frame.evaluate(() => { (window as any).scribe.set({ title: "C" }); (window as any).scribe.flush(); });
    await page.waitForTimeout(2800);
    assert.ok(puts >= 3, `retried: ${puts} requests`);
    assert.equal(await frame.evaluate(() => (window as any).scribe.state.title), "C");
    assert.equal(await frame.evaluate(() => (window as any).errors.length), 1);
  } finally {
    await browser.close();
  }
});
