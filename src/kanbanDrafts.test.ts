import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";
import { BOARD_BRIDGE_JS } from "./bridge.js";
import { applyStateOps } from "./stateOps.js";

test("card editors recover private comment drafts and autosave descriptions across reloads", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Kanban drafts test" });
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
      columns: [{ id: "todo", title: "Todo" }], labels: [], settings: {}, nextNum: 3,
      cards: ["a", "b"].map((id, i) => ({ id, num: i + 1, col: "todo", title: id, description: "",
        labels: [], priority: 0, checklist: [], comments: [], images: [], blockedBy: [], createdAt: 1, movedAt: 1 })),
    };
    let local: any = {};
    let revision = 1;
    let writes = 0;
    await page.route("http://kanban.test/**", route => {
      const request = route.request();
      const url = request.url();
      if (url.includes("/local?") && request.method() === "PUT") {
        local = request.postDataJSON().state;
        return route.fulfill({ json: { ok: true } });
      }
      if (url.endsWith("/state") && request.method() === "PUT") {
        const ops = request.postDataJSON().ops;
        state = applyStateOps(state, ops);
        writes++;
        return route.fulfill({ json: { ok: true, fromRevision: revision++, stateRevision: revision, applied: ops, skipped: [] } });
      }
      if (url.includes("/api/tabs/")) return route.fulfill({ json: {} });
      const boot = { id: "board", viewer: "test", stateRevision: revision, state, local };
      const frameHtml = kanban.replace("<head>", `<head><script>window.__SCRIBE_BOOT__=${JSON.stringify(boot)};</script><script>${BOARD_BRIDGE_JS}</script>`);
      return route.fulfill({ contentType: "text/html", body: url.endsWith("/frame") ? frameHtml : '<iframe src="/frame" style="width:1100px;height:800px"></iframe>' });
    });
    await page.goto("http://kanban.test/");
    let frame = page.frames()[1];
    const open = async (id: string) => frame.locator(`.card[data-id="${id}"] .card-title`).click();
    await open("a");
    await frame.locator("#mTitle").focus();
    await frame.locator("#mTitle").press("Tab");
    assert.equal(await frame.locator("#mdEditor").evaluate(el => el === document.activeElement), true,
      "tabbing into the description enters editing immediately");
    assert.equal(await frame.locator("#mdEditor").evaluate(el => getComputedStyle(el).font),
      await frame.locator("#mdPreview").evaluate(el => getComputedStyle(el).font));
    const longText = Array.from({ length: 18 }, (_, i) => `Line ${i}`).join("\n");
    for (const selector of ["#mdEditor", "#commentBox"]) {
      const editor = frame.locator(selector);
      const initialHeight = await editor.evaluate(el => el.clientHeight);
      await editor.fill(longText);
      assert.ok(await editor.evaluate(el => el.clientHeight) > initialHeight, `${selector} grows with input`);
      assert.ok(await editor.evaluate(el => el.scrollHeight <= el.clientHeight + 1), `${selector} shows all lines`);
      await editor.fill("");
      assert.equal(await editor.evaluate(el => el.clientHeight), initialHeight, `${selector} shrinks after deletion`);
    }
    await frame.locator("#commentBox").fill("unfinished A");
    // Close immediately, before the debounce, then verify card-specific recovery.
    await frame.locator("#mClose").click();
    await open("b");
    assert.equal(await frame.locator("#commentBox").inputValue(), "");
    await frame.locator("#commentBox").fill("unfinished B");
    await frame.locator("#mClose").click();
    await open("a");
    assert.equal(await frame.locator("#commentBox").inputValue(), "unfinished A");
    await frame.locator("#mdPreview").click();
    await frame.locator("#mdEditor").fill("saved while still focused");
    await frame.waitForFunction(() => (window as any).scribe.state.cards[0].description === "saved while still focused");
    assert.equal(await frame.locator("#mdEditor").evaluate(el => el === document.activeElement), true);
    assert.equal(state.cards[0].comments.length, 0, "a draft never posts a comment");
    assert.equal(JSON.stringify(state).includes("unfinished"), false, "drafts stay out of shared state");

    // Continuous input is bounded: it must persist even without a pause.
    const before = writes;
    await frame.evaluate(async () => {
      const editor = document.querySelector<HTMLTextAreaElement>("#mdEditor")!;
      for (let i = 0; i < 25; i++) {
        editor.value = "continuous " + i;
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });
    assert.ok(writes > before, "continuous typing saves within two seconds");
    assert.ok(writes - before < 5, "typing is batched, not saved on each keystroke");
    // Simulate the page lifecycle while edits are still inside the debounce.
    await frame.locator("#mdEditor").fill("last description");
    const saved = page.waitForResponse(r => r.url().endsWith("/state") && r.request().method() === "PUT");
    await frame.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await saved;
    await page.reload();
    frame = page.frames()[1];
    await open("a");
    assert.equal(await frame.locator("#commentBox").inputValue(), "unfinished A");
    assert.equal(await frame.locator("#mdPreview").innerText(), "last description");
    const cleared = page.waitForResponse(r => r.url().includes("/local?") && r.request().method() === "PUT");
    await frame.locator("#commentBox").press("Control+Enter");
    await frame.evaluate(() => (window as any).scribe.flush());
    await cleared;
    await frame.locator("#mClose").click();
    await open("b");
    assert.equal(await frame.locator("#commentBox").inputValue(), "unfinished B");
    await frame.locator("#mClose").click();
    await open("a");
    assert.equal(await frame.locator("#commentBox").inputValue(), "");
    assert.equal(local.commentDrafts.a, undefined);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
