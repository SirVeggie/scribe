import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "../chromium.js";
import { loadChatFixture } from "../testSupport/shell.js";

test("new composers save live, reuse pending creation, and clean up cleared or moved drafts", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Live draft test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const threads = new Map<string, any>();
    const messages: string[] = [];
    let creates = 0;
    let hold = false;
    let release: (() => void) | undefined;
    let creationStarted: (() => void) | undefined;
    const holdCreation = () => {
      hold = true;
      return new Promise<void>(resolve => { creationStarted = resolve; });
    };
    const emit = (event: any) => page.evaluate(event => window.dispatchEvent(new CustomEvent("scribe:agent-event", { detail: event })), event);
    await page.route("http://chat.test/**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (!path.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body:
        '<div class="workspace"><main></main></div><aside id="agent-pane"><div class="agent-inner"></div><div class="agent-resizer"></div></aside>' });
      const body = request.postDataJSON() || {};
      const interaction = /^\/api\/agent\/threads\/([^/]+)\/interact$/.exec(path);
      if (interaction) {
        const thread = threads.get(interaction[1]);
        thread.interactedAt = Date.now();
        await emit({ type: "agent_thread", thread });
        return route.fulfill({ json: {} });
      }
      if (path === "/api/agent/threads" && request.method() === "POST") {
        const id = `draft-${++creates}`;
        if (hold) await new Promise<void>(resolve => { release = resolve; creationStarted!(); });
        const thread = { ...body, id, title: "New thread", status: "idle", stats: { turns: 0 }, activityAt: Date.now(), createdAt: Date.now() };
        threads.set(id, thread);
        // Socket events can arrive before the HTTP response.
        await emit({ type: "agent_thread", thread });
        return route.fulfill({ json: { thread } });
      }
      const match = /^\/api\/agent\/threads\/([^/]+)(\/messages)?$/.exec(path);
      if (match) {
        const id = match[1];
        const thread = threads.get(id);
        if (request.method() === "DELETE") {
          threads.delete(id);
          await emit({ type: "agent_thread_deleted", id });
        } else if (match[2]) {
          messages.push(id);
          thread.draft = null;
          thread.stats.turns++;
          await emit({ type: "agent_thread", thread });
        } else if (request.method() === "PATCH") {
          Object.assign(thread, body);
          await emit({ type: "agent_thread", thread });
        }
        return route.fulfill({ json: { thread, items: [], turns: [] } });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto("http://chat.test/");
    const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    await loadChatFixture(page, source.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/,
      "  window.draftTest = { S, sidebar, dock, full, draftWrites, recentThreads };"));
    await page.evaluate(() => {
      const { S, sidebar, dock, full } = (window as any).draftTest;
      S.config.providers = [{ id: "codex", label: "Codex", available: true }];
      S.filter = "all";
      sidebar.mount(); dock.mount(); full.mount();
      sidebar.setOpen(true);
      sidebar.view.startDraft({ kind: "global", ref: null }, { provider: "codex", model: "default", mode: "ask", cwd: null });
    });
    const input = page.locator('#agent-pane .ag-textarea:not([aria-hidden="true"])');
    const settled = () => page.waitForFunction(() => {
      const { sidebar, draftWrites } = (window as any).draftTest;
      return !sidebar.view.draft?.saving && !draftWrites.size;
    });
    await page.evaluate(() => (window as any).draftTest.sidebar.view.setPlan(true));
    await input.fill("First thought");
    await page.waitForFunction(() => (window as any).draftTest.sidebar.view.threadId);
    await page.waitForFunction(() => (window as any).draftTest.S.threads.get("draft-1")?.interactedAt);
    assert.equal(await page.evaluate(() => (window as any).draftTest.recentThreads()[0].id), "draft-1");
    assert.equal(await page.evaluate(() => (window as any).draftTest.sidebar.view.planOn()), true);
    await input.fill("Revised thought");
    await settled();
    assert.equal(creates, 1);
    assert.equal(threads.get("draft-1").draft.text, "Revised thought");
    await page.evaluate(() => (window as any).draftTest.sidebar.toggleList());
    assert.match(await page.evaluate(() => (window as any).draftTest.sidebar.listEl.textContent), /Revised thought/);
    await page.evaluate(() => (window as any).draftTest.sidebar.toggleList());
    await input.fill("");
    await settled();
    assert.equal(threads.size, 0);
    assert.equal(await input.inputValue(), "");
    assert.equal(await page.evaluate(() => (window as any).draftTest.sidebar.view.planOn()), true);

    // Edits made before creation returns are saved, and clearing removes that pending draft.
    let started = holdCreation();
    await input.fill("Pending");
    await started;
    await input.fill("Pending revision");
    await input.fill("");
    release!(); hold = false;
    await settled();
    assert.equal(threads.size, 0);

    // Sending immediately uses the same pending thread rather than making another.
    started = holdCreation();
    await input.fill("Send immediately");
    await started;
    const send = page.evaluate(() => (window as any).draftTest.sidebar.view.send());
    release!(); hold = false;
    await send;
    assert.deepEqual(messages, ["draft-3"]);
    assert.equal(creates, 3);
    assert.equal(threads.get("draft-3").draft, null);
    await input.fill("Follow-up");
    await settled();
    await input.fill("");
    await settled();
    assert.equal(threads.has("draft-3"), true, "clearing a sent thread never deletes it");

    // Navigating during creation parks the latest text without switching the new composer back.
    await page.evaluate(() => (window as any).draftTest.sidebar.view.startDraft({ kind: "global", ref: null }));
    started = holdCreation();
    await input.fill("Before leaving");
    await started;
    await input.fill("Latest before leaving");
    await page.evaluate(() => (window as any).draftTest.sidebar.view.updateSettings({ mode: "code" }));
    await page.evaluate(() => (window as any).draftTest.sidebar.view.startDraft({ kind: "global", ref: null }));
    release!(); hold = false;
    await page.waitForFunction(() => (window as any).draftTest.S.threads.get("draft-4")?.draft?.text === "Latest before leaving");
    await settled();
    assert.equal(threads.get("draft-4").draft.text, "Latest before leaving");
    assert.equal(threads.get("draft-4").mode, "code");
    assert.equal(await input.inputValue(), "");
    assert.equal(await page.evaluate(() => (window as any).draftTest.sidebar.view.threadId), null);

    // Moving a composer during creation leaves one draft with the receiving layout's content.
    started = holdCreation();
    await input.fill("Move this draft");
    await started;
    const releaseMoved = release!;
    hold = false;
    await page.evaluate(() => {
      const { sidebar, full } = (window as any).draftTest;
      full.view.giveChat(sidebar.view.takeChat());
    });
    releaseMoved();
    await page.waitForFunction(() => {
      const { S, full, draftWrites } = (window as any).draftTest;
      return full.view.threadId === "draft-6" && !S.threads.has("draft-5") && !draftWrites.size;
    });
    assert.equal(threads.has("draft-5"), false);
    assert.equal(threads.get("draft-6").draft.text, "Move this draft");
    assert.equal(await page.evaluate(() => (window as any).draftTest.full.view.input.value), "Move this draft");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
