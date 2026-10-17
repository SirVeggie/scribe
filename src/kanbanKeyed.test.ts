import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";
import { BOARD_BRIDGE_JS } from "./bridge.js";

const card = (id: string, num: number, title: string) => ({
  id, num, col: "todo", title, description: "", labels: [], priority: 0, checklist: [], comments: [], images: [], blockedBy: [],
  createdAt: 1, movedAt: 1,
});
const BOOT = {
  id: "board",
  stateRevision: 1,
  state: {
    columns: [{ id: "todo", title: "Todo" }, { id: "done", title: "Done", role: "done" }],
    labels: [],
    settings: {},
    cards: [card("a", 1, "One"), card("b", 2, "Two"), card("c", 3, "Three")],
    nextNum: 4,
  },
};

test("a remote change repaints only the cards it touched, in place", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Kanban keyed cards test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const kanban = fs.readFileSync(new URL("../templates/builtin/kanban.html", import.meta.url), "utf8");
    const boot = structuredClone(BOOT) as any;
    boot.state.cards[0].images = [{ id: "im_1", name: "shot.png", data: "data:image/png;base64,aGVsbG8=" }];
    boot.state.cards[0].description = "![shot](#img-im_1)";
    const assetUrl = "/blob/pa_aaaaaaaaaaaaaaaaaaaaaaaa";
    let uploads = 0;
    let serverRevision = 1;
    const frameHtml = kanban.replace("<head>", `<head><script>window.__SCRIBE_BOOT__=${JSON.stringify(boot)};</script><script>${BOARD_BRIDGE_JS}</script>`);
    await page.route("http://kanban.test/**", (route) => {
      const url = route.request().url();
      if (url.endsWith("/assets") && route.request().method() === "POST") {
        uploads++;
        return route.fulfill({ json: { asset: { name: "shot.png", url: assetUrl }, usage: {} } });
      }
      if (url.endsWith("/state") && route.request().method() === "PUT") {
        const fromRevision = serverRevision++;
        return route.fulfill({ json: { ok: true, fromRevision, stateRevision: serverRevision, applied: route.request().postDataJSON().ops, skipped: [] } });
      }
      if (url.includes("/api/tabs/")) return route.fulfill({ json: {} });
      return route.fulfill({ contentType: "text/html", body: url.endsWith("/frame") ? frameHtml : '<iframe src="/frame" style="width:1100px;height:700px"></iframe>' });
    });
    const saved = page.waitForResponse(response => response.url().endsWith("/state") && response.request().method() === "PUT");
    await page.goto("http://kanban.test/");
    const frame = page.frames()[1];
    await frame.locator('.card[data-id="c"]').waitFor();
    await frame.waitForFunction(() => (window as any).scribe.state.cards[0].images[0].data.startsWith("/blob/"));
    assert.equal(uploads, 1);
    assert.equal(await frame.locator('.card[data-id="a"] img').getAttribute("src"), assetUrl);
    await frame.locator('.card[data-id="a"] .card-title').click();
    assert.equal(await frame.locator('#gallery img').getAttribute("src"), assetUrl);
    assert.equal(await frame.locator('#mdPreview img').getAttribute("src"), assetUrl);
    await frame.evaluate(() => (window as any).scribe.flush());
    await saved;
    await page.evaluate((revision) => {
      const w = document.querySelector("iframe")!.contentWindow as any;
      const state = structuredClone(w.scribe.state);
      state.cards[0].images[0].data = "/blob/pa_bbbbbbbbbbbbbbbbbbbbbbbb";
      document.querySelector("iframe")!.contentWindow!.postMessage({ type: "scribe-state", id: "board", stateRevision: revision + 1, fromRevision: revision,
        ops: [{ op: "merge", path: "cards/a", value: state.cards[0] }] }, "*");
    }, serverRevision);
    serverRevision++;
    await frame.waitForFunction(() => document.querySelector('#gallery img')?.getAttribute("src") === "/blob/pa_bbbbbbbbbbbbbbbbbbbbbbbb");
    await frame.locator('#mClose').click();

    const watched = await frame.evaluate(() => {
      const w = window as any;
      w.before = { a: document.querySelector('.card[data-id="a"]'), b: document.querySelector('.card[data-id="b"]'), c: document.querySelector('.card[data-id="c"]') };
      w.records = { a: 0, b: 0, c: 0 };
      for (const id of ["a", "b", "c"]) {
        new MutationObserver((list) => { w.records[id] += list.length; }).observe(w.before[id], { subtree: true, childList: true, attributes: true, characterData: true });
      }
      return true;
    });
    assert.equal(watched, true);
    await page.evaluate((revision) => {
      document.querySelector("iframe")!.contentWindow!.postMessage({
        type: "scribe-state", id: "board", stateRevision: revision + 1, fromRevision: revision,
        ops: [{ op: "merge", path: "cards/b", value: { title: "Two, renamed" } }],
      }, "*");
    }, serverRevision);
    await frame.locator('.card[data-id="b"] .card-title', { hasText: "Two, renamed" }).waitFor();
    const after = await frame.evaluate(() => {
      const w = window as any;
      return {
        same: ["a", "b", "c"].map((id) => document.querySelector('.card[data-id="' + id + '"]') === w.before[id]),
        records: w.records,
      };
    });
    assert.deepEqual(after.same, [true, true, true]);
    assert.equal(after.records.a, 0);
    assert.equal(after.records.c, 0);
    assert.ok(after.records.b > 0);

    // A write the board's regions don't show paints from its local notice and leaves them alone.
    await frame.locator('.card[data-id="c"] .card-title').click();
    await frame.locator("#mTimes").waitFor();
    const regions = await frame.evaluate(async () => {
      const w = window as any;
      const nodes = ['.col-head[data-col="todo"]', "#meta", "#workersBtn", "#mdPreview", "#checklist", "#mTimes"]
        .map((sel) => document.querySelector(sel)!);
      const seen: string[] = [];
      const observer = new MutationObserver((list) => {
        list.forEach((r) => seen.push(((r.target as Element).id || (r.target as Element).className) + " " + r.type));
      });
      nodes.forEach((node) => observer.observe(node, { subtree: true, childList: true, attributes: true, characterData: true }));
      w.scribe.update([{ op: "set", path: "settings/workerLog", value: [] }]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      observer.disconnect();
      return { seen, painted: nodes.every((node) => node.isConnected) };
    });
    assert.deepEqual(regions, { seen: [], painted: true });
    await frame.locator("#mClose").click();

    // User-created cards go first in every column.
    for (const col of ["todo", "done"]) {
      await frame.locator(`.column[data-col="${col}"] .add-card`).click();
      await frame.locator(".composer-input").fill(`New ${col}`);
      await frame.locator(".composer-input").press("Enter");
      assert.ok((await frame.locator(`.cards[data-col="${col}"] .card-title`).first().textContent())?.endsWith(`New ${col}`));
      await frame.locator(".composer-input").press("Escape");
    }
    await frame.locator('.card[data-id="b"] .card-title').click();
    await frame.locator("#mColumn").selectOption("done", { force: true });
    await frame.locator("#mClose").click();
    assert.equal(await frame.locator('.cards[data-col="done"] .card').first().getAttribute("data-id"), "b");

    // A drag into Done follows the drop position, even on first completion.
    const source = await frame.locator('.card[data-id="c"] .card-title').boundingBox();
    const target = await frame.locator('.cards[data-col="done"] .card').last().boundingBox();
    assert.ok(source && target);
    await page.mouse.move(source.x + 20, source.y + 8);
    await page.mouse.down();
    await page.mouse.move(target.x + 30, target.y + target.height - 2, { steps: 12 });
    await page.mouse.up();
    assert.equal(await frame.locator('.cards[data-col="done"] .card').last().getAttribute("data-id"), "c");
    const moved = await frame.evaluate(() => (window as any).scribe.state.cards.find((c: any) => c.id === "c"));
    assert.ok(moved.doneAt);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
