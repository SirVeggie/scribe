import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "../chromium.js";

test("Harness SDK settings render update, current and failed checks and allow retry", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "SDK updates test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    const requests: string[] = [];
    let failed = false;
    await page.route("http://sdk.test/**", async (route) => {
      const url = route.request().url();
      if (!url.includes("/api/agent/")) return route.fulfill({ contentType: "text/html", body: "<main></main>" });
      if (!url.includes("/sdk-updates")) return route.fulfill({ contentType: "application/json", body: "{}" });
      requests.push(url);
      return route.fulfill({ contentType: "application/json", status: failed ? 500 : 200, body: JSON.stringify(failed ? { error: "offline" } : {
        checkedAt: 100,
        sdks: [
          { label: "Cursor SDK", installed: "1.0.9", latest: "1.0.10", outdated: true },
          { label: "Codex SDK", installed: "1.0.0", latest: "1.0.0", outdated: false },
          { label: "Claude Agent SDK", installed: "1.0.0", latest: null, outdated: null, error: "npm check timed out" },
        ],
      }) });
    });
    await page.goto("http://sdk.test/");

    const source = fs.readFileSync(new URL("../../public/harness.js", import.meta.url), "utf8");
    await page.addScriptTag({ content: source });
    assert.equal(requests.length, 0);
    await page.evaluate(() => (window as any).scribeHarness.open("sdks"));
    await page.getByText("Update available", { exact: true }).waitFor();
    const sdkLink = page.getByRole("button", { name: "Agent SDKs", exact: true });
    assert.equal(await sdkLink.getAttribute("aria-pressed"), "true");
    assert.equal(await sdkLink.evaluate((node) => node.nextElementSibling?.textContent), "Allowlists…");
    const rows = page.locator(".setting-row");
    assert.match(await rows.nth(0).innerText(), /1.0.9.*latest 1.0.10[\s\S]*Update available/);
    assert.match(await rows.nth(1).innerText(), /Up to date/);
    assert.match(await rows.nth(2).innerText(), /npm check timed out/);
    assert.equal(await page.locator(".ag-tag.ok").count(), 1);
    assert.match(await page.locator(".hx-body").innerText(), /restart Scribe/);
    failed = true;
    await page.getByRole("button", { name: "Check for updates" }).click();
    await page.getByText("SDK check failed: offline", { exact: true }).waitFor();
    assert.ok(requests.at(-1)?.endsWith("/sdk-updates?refresh=1"));
    assert.match(await page.locator(".hx-body").innerText(), /SDK check failed: offline/);
    assert.equal(await page.getByRole("button", { name: "Check for updates" }).isEnabled(), true);
  } finally { await browser.close(); }
});
