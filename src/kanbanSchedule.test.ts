import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";
import { BOARD_BRIDGE_JS } from "./bridge.js";
import { applyStateOps } from "./stateOps.js";

test("card schedules use local time, survive reload, duplicate, clear and expire without a state write", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Kanban schedule test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "Europe/Helsinki" });
    page.setDefaultTimeout(5000);
    await page.clock.install({ time: new Date("2026-10-20T08:00:00Z") });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const html = fs.readFileSync(new URL("../templates/builtin/kanban.html", import.meta.url), "utf8");
    let state: any = {
      columns: [{ id: "ready", title: "Ready", role: "agent" }], labels: [], settings: {}, nextNum: 2,
      cards: [{ id: "one", num: 1, col: "ready", title: "Later", description: "", labels: [], priority: 0,
        checklist: [], comments: [], images: [], blockedBy: [], createdAt: 1, movedAt: 1 }],
    };
    let revision = 1;
    await page.route("http://kanban.test/**", route => {
      const request = route.request(), url = request.url();
      if (url.endsWith("/state") && request.method() === "PUT") {
        const ops = request.postDataJSON().ops;
        state = applyStateOps(state, ops);
        return route.fulfill({ json: { ok: true, fromRevision: revision++, stateRevision: revision, applied: ops, skipped: [] } });
      }
      if (url.includes("/api/tabs/")) return route.fulfill({ json: {} });
      const boot = { id: "board", viewer: "test", stateRevision: revision, state, local: {} };
      return route.fulfill({ contentType: "text/html", body: html.replace("<head>", `<head><script>window.__SCRIBE_BOOT__=${JSON.stringify(boot)};</script><script>${BOARD_BRIDGE_JS}</script>`) });
    });
    await page.goto("http://kanban.test/frame");
    await page.locator(".card .card-title").click();
    const savedSchedule = page.waitForResponse(r => r.url().endsWith("/state") && r.request().method() === "PUT");
    await page.locator("#mScheduled").fill("2026-10-21T11:30");
    await page.locator("#mScheduled").press("Tab");
    await savedSchedule;
    await page.waitForFunction(() => (window as any).scribe.state.cards[0].scheduledAt === Date.parse("2026-10-21T08:30:00Z"));
    assert.equal(state.cards[0].scheduledAt, Date.parse("2026-10-21T08:30:00Z"));
    assert.match(await page.locator(".card .badges").innerText(), /Starts/);
    await page.reload();
    await page.locator(".card .card-title").click();
    assert.equal(await page.locator("#mScheduled").inputValue(), "2026-10-21T11:30");
    assert.equal(await page.locator("#mScheduled").evaluate(el => el.getBoundingClientRect().right <= el.closest(".side")!.getBoundingClientRect().right + 1), true);
    const savedCopy = page.waitForResponse(r => r.url().endsWith("/state") && r.request().method() === "PUT");
    await page.locator("#mDup").click();
    await savedCopy;
    await page.waitForFunction(() => (window as any).scribe.state.cards.length === 2);
    assert.equal(state.cards[1].scheduledAt, state.cards[0].scheduledAt);
    const savedClear = page.waitForResponse(r => r.url().endsWith("/state") && r.request().method() === "PUT");
    await page.locator("#mScheduledClear").click();
    await savedClear;
    await page.waitForFunction(() => !(window as any).scribe.state.cards[1].scheduledAt);
    assert.equal(await page.locator("#mScheduled").inputValue(), "");
    await page.locator("#mClose").click();
    // Move past the original card's time: its badge refreshes without another board write.
    await page.clock.fastForward(25 * 60 * 60 * 1000);
    await page.waitForFunction(() => !document.querySelector('.card[data-id="one"] .badges')?.textContent?.includes("Starts"));
    assert.equal(state.cards[0].scheduledAt, Date.parse("2026-10-21T08:30:00Z"));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
