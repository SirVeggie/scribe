import { loadChatFixture } from "../testSupport/shell.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "../chromium.js";

test("floating chats open in the sidebar with their draft and reveal the conversation", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Sidebar handoff test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://handoff.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: '<div class="workspace"><main></main></div><aside id="agent-pane"><div class="agent-inner"></div><div class="agent-resizer"></div></aside>',
    }));
    await page.goto("http://handoff.test/");

    const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    await loadChatFixture(page, source.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  window.handoffTest = { S, sidebar, dock, full };"));
    await page.evaluate(() => {
      const { S, sidebar, dock, full } = (window as any).handoffTest;
      S.config.providers = [{ id: "codex", label: "Codex", available: true }];
      sidebar.mount();
      dock.mount();
      full.mount();
      const scope = { kind: "global", ref: null };
      const settings = { provider: "codex", model: "gpt-6.1-sol", effort: "high", mode: "code", approval: "auto", web: "off", cwd: "C:\\project", useWorktree: true, modelParams: { fast: true } };
      sidebar.view.startDraft(scope, { model: "old-model" });
      sidebar.toggleList();
      dock.view.startDraft(scope, settings);
      dock.view.input.value = "Unsent message";
      dock.view.mentions = [{ id: "page", title: "Mentioned page" }];
    });
    const clickOpen = () => page.getByRole("button", { name: "Open in the sidebar", exact: true }).click();
    await clickOpen();
    const draft = await page.evaluate(() => {
      const { S, sidebar, dock } = (window as any).handoffTest;
      const d = sidebar.view.draft;
      return { open: S.sideOpen, list: sidebar.listOpen, hidden: sidebar.view.composer.hidden, draft: d && { scope: d.scope, settings: d.settings }, text: sidebar.view.input.value, mentions: sidebar.view.mentions, sourceText: dock.view.input.value };
    });
    assert.equal(draft.open, true);
    assert.equal(draft.list, false);
    assert.equal(draft.hidden, false);
    assert.equal(draft.text, "Unsent message");
    assert.equal(draft.sourceText, "");
    assert.deepEqual(draft.mentions, [{ id: "page", title: "Mentioned page" }]);
    assert.deepEqual(draft.draft, { scope: { kind: "global", ref: null }, settings: { provider: "codex", model: "gpt-6.1-sol", effort: "high", mode: "code", approval: "auto", web: "off", cwd: "C:\\project", useWorktree: true, modelParams: { fast: true } } });

    // Even re-opening the same persisted thread must dismiss its helper overlay and the list.
    await page.evaluate(() => {
      const { S, sidebar, dock, full } = (window as any).handoffTest;
      const base = { provider: "codex", model: "gpt-6.1-sol", mode: "ask", scope: { kind: "global", ref: null }, status: "idle", stats: {}, activityAt: 1, createdAt: 1 };
      for (const id of ["parent", "helper"]) {
        S.threads.set(id, { ...base, id, title: id });
        S.details.set(id, { items: [], byId: new Map(), turns: new Map() });
      }
      sidebar.view.setThread("parent");
      sidebar.view.openHelper("helper");
      sidebar.toggleList();
      dock.view.setThread("parent");
      dock.view.input.value = "Existing thread draft";
      full.open({ threadId: "helper", draft: null, composer: null });
    });
    await clickOpen();
    assert.deepEqual(await page.evaluate(() => {
      const { S, sidebar } = (window as any).handoffTest;
      return [S.current, S.fullOpen, sidebar.listOpen, sidebar.view.threadId, sidebar.view.helperView?.root.isConnected, sidebar.view.input.value];
    }), ["parent", false, false, "parent", false, "Existing thread draft"]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
