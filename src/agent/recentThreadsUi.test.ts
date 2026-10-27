import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "../chromium.js";
import { loadChatFixture } from "../testSupport/shell.js";

test("Recent crosses scopes, expires, and has independent switches in every chat list", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Recent threads test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    const interactions: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://recent.test/**", (route) => {
      const url = route.request().url();
      if (url.includes("/api/agent/")) {
        if (url.endsWith("/interact")) interactions.push(url);
        return route.fulfill({ contentType: "application/json", body: "{}" });
      }
      return route.fulfill({ contentType: "text/html", body: "<main></main>" });
    });
    await page.goto("http://recent.test/");
    await page.clock.install({ time: new Date("2026-10-27T12:00:00Z") });
    for (const name of ["app.css", "agent.css"]) await page.addStyleTag({ content: fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8") });
    const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    await loadChatFixture(page, source.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  window.recentTest = { S, renderThreadList, dock, sidebar, full, recentThreads, showPageThread };"));
    await page.evaluate(() => {
      const { S, renderThreadList, dock } = (window as any).recentTest;
      S.filter = "here";
      S.config.providers = [{ id: "claude", label: "Claude", available: true }];
      const base = { provider: "claude", model: "sonnet", scope: { kind: "page", ref: "elsewhere" }, status: "idle", stats: { turns: 1, files: 0, added: 0, removed: 0 }, createdAt: 1, activityAt: Date.now() };
      for (let i = 0; i < 7; i++) S.threads.set(`t${i}`, { ...base, id: `t${i}`, title: `Thread ${i}`, interactedAt: Date.now() - (i + 1) * 1000 });
      S.threads.set("stale", { ...base, id: "stale", title: "Stale", interactedAt: Date.now() - 8 * 3600000 });
      S.threads.set("worker", { ...base, id: "worker", title: "Worker", fromPage: true });
      S.threads.set("archived", { ...base, id: "archived", title: "Archived", archived: true, interactedAt: Date.now() });
      for (const [id, recentList] of [["side-list", "sidebar"], ["full-list", "full"], ["other-chat", "other"]]) {
        const list = document.createElement("div");
        list.id = id;
        list.style.cssText = "display:inline-block;vertical-align:top;width:380px;height:650px";
        document.querySelector("main")!.append(list);
        renderThreadList(list, { recentList, currentId: null, onPick: () => {}, onNew: () => {}, onNewIn: () => {} });
      }
      const anchor = document.createElement("button");
      anchor.id = "dock-picker";
      anchor.textContent = "Floating threads";
      anchor.onclick = () => dock.threadMenu(anchor);
      document.body.append(anchor);
    });
    const side = page.locator("#side-list");
    const full = page.locator("#full-list");
    await side.getByRole("switch", { name: "Recent", exact: true }).click();
    assert.deepEqual(await side.locator(".ag-list-recent .ag-row").evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.id)), ["t0", "t1", "t2", "t3", "t4"]);
    assert.equal(await full.locator(".ag-list-recent").count(), 0);
    assert.equal(await page.locator("#other-chat .ag-list-recent").count(), 0);
    // The top section survives all the scope filters, including Archived.
    for (const label of ["Workspaces", "All", "Archived", "Here"]) {
      await side.getByRole("button", { name: label, exact: true }).click();
      assert.equal(await side.locator(".ag-list-recent .ag-row").count(), 5);
    }
    await full.getByRole("switch", { name: "Recent", exact: true }).click();
    await side.getByRole("switch", { name: "Recent", exact: true }).click();
    assert.equal(await full.locator(".ag-list-recent .ag-row").count(), 5);
    await page.locator("#dock-picker").click();
    const menu = page.locator(".ag-thread-menu");
    assert.equal(await menu.getByRole("switch", { name: "Recent", exact: true }).getAttribute("aria-checked"), "false");
    await menu.getByRole("switch", { name: "Recent", exact: true }).click();
    assert.equal(await menu.locator(".ag-menu-head").first().textContent(), "Recent");
    assert.deepEqual(await menu.locator(".ag-menu-label").allTextContents().then(labels => labels.slice(1, 6)), ["Thread 0", "Thread 1", "Thread 2", "Thread 3", "Thread 4"]);
    await page.keyboard.press("Escape");
    // Each list keeps its own switch across reloads.
    assert.deepEqual(await page.evaluate(() => ["sidebar", "full", "other", "dock"].map(list => localStorage.getItem(`scribe.agent.recent.${list}`))), [null, "1", null, "1"]);
    // Opening threads is not interaction: a row click, the floating picker, or a link from a page.
    await full.locator('.ag-list-recent .ag-row[data-id="t4"]').click();
    await page.evaluate(() => {
      const { dock, showPageThread } = (window as any).recentTest;
      showPageThread("t3", "dock", { reveal: true });
      dock.pick("t2");
    });
    assert.equal(await page.evaluate(() => (window as any).recentTest.recentThreads()[0].id), "t0");
    // A send or answer (stamped by the server) moves a thread to the top.
    await page.evaluate(() => {
      const { S } = (window as any).recentTest;
      S.threads.get("t4").interactedAt = Date.now();
    });
    assert.equal(await page.evaluate(() => (window as any).recentTest.recentThreads()[0].id), "t4");
    // Previously saved drafts count too, even without an interaction timestamp.
    await page.evaluate(() => {
      const { S } = (window as any).recentTest;
      const base = { ...S.threads.get("worker"), fromPage: false, stats: { turns: 0 }, draft: { text: "Unsent idea" } };
      S.threads.set("saved-draft", { ...base, id: "saved-draft", updatedAt: Date.now() - 500 });
      S.threads.set("old-draft", { ...base, id: "old-draft", updatedAt: Date.now() - 8 * 3600000 });
      S.threads.set("empty-draft", { ...base, id: "empty-draft", draft: { text: " " }, updatedAt: Date.now() });
      (document.querySelector("#full-list") as any).agFill();
    });
    assert.deepEqual(await full.locator(".ag-list-recent .ag-row").evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.id)), ["t4", "saved-draft", "t0", "t1", "t2"]);
    assert.equal(await full.locator('.ag-list-recent [data-id="saved-draft"] .ag-row-title').textContent(), "Unsent idea");
    // Let the clock reach the exact cutoff: entries expire without another thread update.
    await page.clock.fastForward(8 * 3600000);
    // An empty Recent section is left out, heading and all.
    assert.equal(await full.locator(".ag-list-recent").count(), 0);
    assert.equal(await full.locator(".ag-list-group-kind", { hasText: "Recent" }).count(), 0);
    assert.deepEqual(errors, []);
    // Opening a chat, clicking and scrolling in it do not count; a draft counts only while it has text.
    await page.evaluate(() => {
      const { S, sidebar } = (window as any).recentTest;
      const view = sidebar.view;
      S.details.set("worker", { items: [], byId: new Map(), turns: new Map() });
      S.sideOpen = true;
      document.querySelector("main")!.replaceChildren(view.root);
      view.setThread("worker");
    });
    await page.locator(".ag-scroll").first().click({ force: true }).catch(() => {});
    await page.mouse.wheel(0, 200);
    await page.keyboard.press("PageDown");
    const recentIds = () => page.evaluate(() => (window as any).recentTest.recentThreads().map((t: { id: string }) => t.id));
    assert.ok(!(await recentIds()).includes("worker"));
    const composer = page.getByPlaceholder("Message the agent…", { exact: true });
    await composer.pressSequentially("Hello");
    await page.waitForFunction(() => (window as any).recentTest.S.threads.get("worker").draft?.text === "Hello");
    assert.equal((await recentIds())[0], "worker");
    // Deleting what was typed takes the intent back.
    await composer.fill("");
    await page.waitForFunction(() => !(window as any).recentTest.S.threads.get("worker").draft);
    assert.ok(!(await recentIds()).includes("worker"));
    // An earlier send still counts once its draft is emptied, at its own time.
    await page.evaluate(() => { (window as any).recentTest.S.threads.get("worker").interactedAt = Date.now() - 60000; });
    await composer.pressSequentially("Again");
    await page.waitForFunction(() => (window as any).recentTest.S.threads.get("worker").draft?.text === "Again");
    await composer.fill("");
    await page.waitForFunction(() => !(window as any).recentTest.S.threads.get("worker").draft);
    assert.equal(await page.evaluate(() => {
      const { recentThreads } = (window as any).recentTest;
      return recentThreads().find((t: { id: string }) => t.id === "worker").interactedAt;
    }), await page.evaluate(() => (window as any).recentTest.S.threads.get("worker").interactedAt));
    assert.deepEqual(interactions, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
