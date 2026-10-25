import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "../chromium.js";
import { loadChatFixture } from "../testSupport/shell.js";

test("composer arrows keep slash and mention results open and accept the highlighted item", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Chat autocomplete test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let requests = 0;
    await page.route("http://chat.test/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith("/api/")) return route.fulfill({
        contentType: "text/html",
        body: '<aside id="agent-pane"><div class="agent-inner"></div><div class="agent-resizer"></div></aside>',
      });
      requests++;
      const data = path.endsWith("/commands") ? { commands: [{ name: "remote-one" }, { name: "remote-two" }] }
        : path === "/api/search" ? { tabs: [
          { id: "page-one", key: "scribe:one", title: "Page one" },
          { id: "page-two", key: "scribe:two", title: "Page two" },
        ] }
        : path === "/api/agent/threads" ? { threads: [
          { id: "thread-one", title: "Thread one" }, { id: "thread-two", title: "Thread two" },
        ] } : {};
      return route.fulfill({ json: data });
    });
    await page.goto("http://chat.test/");
    const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    await loadChatFixture(page, source.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/,
      "  window.autocompleteTest = { S, sidebar };"));
    await page.evaluate(() => {
      const { S, sidebar } = (window as any).autocompleteTest;
      S.config.providers = [{ id: "codex", label: "Codex", available: true }];
      sidebar.mount();
      sidebar.setOpen(true);
      sidebar.view.settings = () => ({ provider: "codex", mode: "ask" });
    });
    const input = page.locator('#agent-pane .ag-textarea:not([aria-hidden="true"])');
    const picker = page.locator("#agent-pane .ag-slash");
    const active = picker.locator(".ag-slash-item.on");
    for (const token of ["/remote-", "@", "#"]) {
      await input.fill(token);
      await page.waitForFunction(() => {
        const { sidebar } = (window as any).autocompleteTest;
        return !sidebar.view.slash.hidden && !sidebar.view.mentionLoading
          && sidebar.view.slash.querySelectorAll(".ag-slash-item").length === 2;
      });
      const first = await active.textContent();
      const before = requests;
      await input.press("ArrowDown"); // Includes keyup, which used to rebuild the results.
      const second = await active.textContent();
      assert.notEqual(second, first);
      assert.equal(await picker.isVisible(), true);
      await input.press("ArrowDown");
      assert.equal(await active.textContent(), first, "wraps to first result");
      await input.press("ArrowUp");
      assert.equal(await active.textContent(), second, "wraps to last result");
      assert.equal(requests, before, "navigation does not refetch results");
      await input.press(token === "/remote-" ? "Tab" : "Enter");
      assert.equal(await picker.isVisible(), false);
      assert.equal(await input.inputValue(), token === "/remote-" ? "/remote-two " : token === "@" ? "@Page two " : "#Thread two ");
      await page.evaluate(() => (window as any).autocompleteTest.sidebar.view.emptyComposer());
    }
    // Caret navigation still dismisses results when the caret leaves a token.
    await input.fill("/remote-");
    await page.waitForFunction(() => !(window as any).autocompleteTest.sidebar.view.slash.hidden);
    await input.press("Home");
    assert.equal(await picker.isVisible(), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
