import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";
import { markdownVendor } from "./vendorFixture.js";
import { BOARD_BRIDGE_JS } from "./bridge.js";
import { applyStateOps } from "./stateOps.js";

test("card dialog dictates into the description and the comment box (#1070)", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Kanban voice test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const kanban = fs.readFileSync(new URL("../templates/builtin/kanban.html", import.meta.url), "utf8");
    let state: any = {
      columns: [{ id: "todo", title: "Todo" }], labels: [], settings: {}, nextNum: 2,
      cards: [{ id: "a", num: 1, col: "todo", title: "a", description: "Start", labels: [], priority: 0,
        checklist: [], comments: [], images: [], blockedBy: [], createdAt: 1, movedAt: 1 }],
    };
    let revision = 1;
    await page.route("http://kanban.test/**", route => {
      const vendor = markdownVendor(route.request().url());
      if (vendor !== null) return route.fulfill({ contentType: "text/javascript", body: vendor });
      const request = route.request(), url = request.url();
      if (url.includes("/local?") && request.method() === "PUT") return route.fulfill({ json: { ok: true } });
      if (url.endsWith("/state") && request.method() === "PUT") {
        const ops = request.postDataJSON().ops;
        state = applyStateOps(state, ops);
        return route.fulfill({ json: { ok: true, fromRevision: revision++, stateRevision: revision, applied: ops, skipped: [] } });
      }
      if (url.includes("/api/tabs/")) return route.fulfill({ json: {} });
      const boot = { id: "board", viewer: "test", stateRevision: revision, state, local: {} };
      const frameHtml = kanban.replace("<head>", `<head><script>window.__SCRIBE_BOOT__=${JSON.stringify(boot)};</script><script>${BOARD_BRIDGE_JS}</script>`);
      return route.fulfill({ contentType: "text/html", body: url.endsWith("/frame") ? frameHtml : '<iframe src="/frame" style="width:1100px;height:800px"></iframe>' });
    });
    await page.goto("http://kanban.test/");
    const frame = page.frames()[1];
    // A fake speech-to-text: each stop returns the next transcript.
    await frame.evaluate(`(() => {
      const texts = ["hello there", "spoken comment"];
      window.__cancelled = 0;
      window.scribe.audio = {
        available: async () => ({ mic: true, stt: true }),
        listen: async () => ({ ok: true, live: false, stop: async () => ({ ok: true, text: texts.shift() }), cancel: async () => { window.__cancelled++; } }),
      };
    })()`);
    await frame.locator('.card[data-id="a"] .card-title').click();
    const descMic = frame.locator("#descMic"), commentMic = frame.locator("#commentMic");
    await descMic.waitFor({ state: "visible" });
    assert.equal(await commentMic.isVisible(), true);

    // Description: dictating from the preview opens the editor and appends at the end.
    await descMic.click();
    await frame.waitForFunction(() => document.getElementById("descMic")!.dataset.state === "recording");
    assert.equal(await commentMic.isDisabled(), true, "one field dictates at a time");
    await descMic.click();
    await frame.waitForFunction(() => (document.getElementById("mdEditor") as HTMLTextAreaElement).value === "Start hello there");
    assert.equal(await descMic.getAttribute("data-state"), "idle");

    // Comment: the hold shortcut inserts at the caret.
    await frame.locator("#commentBox").fill("Note:");
    await frame.locator("#commentBox").press("Control+Shift+Space");
    await frame.waitForFunction(() => document.getElementById("commentMic")!.dataset.state === "idle");
    await frame.waitForFunction(() => (document.getElementById("commentBox") as HTMLTextAreaElement).value === "Note: spoken comment");

    // Escape cancels a recording without closing the dialog.
    await commentMic.click();
    await frame.waitForFunction(() => document.getElementById("commentMic")!.dataset.state === "recording");
    await page.keyboard.press("Escape");
    assert.equal(await commentMic.getAttribute("data-state"), "idle");
    assert.equal(await frame.evaluate(() => (window as any).__cancelled), 1);
    assert.equal(await frame.locator("#overlay").evaluate(el => el.classList.contains("hidden")), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
