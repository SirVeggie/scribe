import { loadChatFixture } from "../testSupport/shell.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "../chromium.js";

test("helper cards open in place, preserve the parent, and attribute approvals", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Helper chat test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 850 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const approvals: string[] = [];
    const approvalDecisions: unknown[] = [];
    await page.route("http://helpers.test/**", async (route) => {
      if (route.request().url().includes("/api/agent/approvals/")) {
        approvals.push(route.request().url().split("/").at(-1)!);
        approvalDecisions.push(route.request().postDataJSON());
        return route.fulfill({ contentType: "application/json", body: "{}" });
      }
      if (route.request().url().includes("/api/agent/thread-search")) {
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ hits: [{ id: "parent", words: ["llama"], snippet: "about llama.cpp" }] }) });
      }
      return route.fulfill({ contentType: "text/html", body: '<main style="display:flex;width:460px;height:780px"></main>' });
    });
    await page.goto("http://helpers.test/");
    for (const name of ["app.css", "agent.css"]) await page.addStyleTag({ content: fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8") });

    // Exercise the real chat views with fixture data, without booting a daemon or providers.
    const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    await loadChatFixture(page, source.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  window.helperTest = { S, view: sidebar.view, views, onEvent, flyoutSnapshot, helperCall, liveStep, searchThreads, searchMessages, renderThreadList, dock };"));
    await page.evaluate(() => {
      const { S, view } = (window as any).helperTest;
      const base = { provider: "claude", model: "sonnet", effort: null, mode: "code", approval: "ask", web: "off", cwd: null, scope: { kind: "global", ref: null }, stats: { turns: 1, files: 0, added: 0, removed: 0 }, createdAt: 1, activityAt: 1, archived: false, unread: false, queued: 0 };
      S.config.providers = [{ id: "claude", label: "Claude", available: true }];
      S.threads.set("parent", { ...base, id: "parent", title: "Main task", status: "idle" });
      S.threads.set("helper", { ...base, id: "helper", helperOf: "parent", title: "Helper: Audit the files", status: "running", activity: { line: "Reading files" } });
      const tool = { id: "launch", threadId: "parent", turnId: "turn", seq: 1, kind: "tool", name: "mcp__scribe__agent_run", tool: "mcp", title: "Helper", helper: "helper", input: { task: "Audit the files", provider: "claude" }, status: "done", output: JSON.stringify({ thread: "helper", status: "running" }), startedAt: 1 };
      S.details.set("parent", { items: [tool], byId: new Map([[tool.id, tool]]), turns: new Map([["turn", { id: "turn", status: "done" }]]) });
      const text = { id: "reply", threadId: "helper", turnId: "helper-turn", seq: 1, kind: "text", text: "I am checking the files." };
      S.details.set("helper", { items: [text], byId: new Map([[text.id, text]]), turns: new Map([["helper-turn", { id: "helper-turn", status: "running" }]]) });
      document.querySelector("main")!.append(view.root);
      // An open sidebar: a closed one is not drawn.
      S.sideOpen = true;
      S.current = "parent";
      view.setThread("parent");
      view.input.value = "Parent draft";
    });
    // Header icons must be discoverable without seeing their custom hover tips.
    const parent = page.locator(".ag-view-side");
    for (const name of ["Thread actions", "Agent settings (Ctrl+Shift+,)", "New thread (Ctrl+Shift+K)", "Full window (Ctrl+Shift+L)", "Send (Enter)"]) {
      assert.equal(await parent.getByRole("button", { name, exact: true }).count(), 1, name);
    }
    const threadActions = parent.getByRole("button", { name: "Thread actions", exact: true });
    assert.equal(await threadActions.getAttribute("data-tooltip"), "Thread actions");
    assert.equal(await threadActions.getAttribute("title"), null);
    // Text and staged text labels keep their visible name, even with a longer tip.
    await page.evaluate(() => {
      const { button, icon, el } = (window as any).AgentRender;
      const fixture = el("div");
      fixture.id = "button-names";
      fixture.append(button("Save", "", null, "Save all changes"));
      const staged = button("", "", null, "Show threads started by workers");
      staged.append(icon("task"), el("span", null, "Show workers"));
      const labelled = el("span", null, "Review");
      labelled.prepend(icon("diff"));
      fixture.append(staged, button(labelled, "", null, "Review the full diff"));
      document.body.append(fixture);
    });
    for (const name of ["Save", "Show workers", "Review"]) {
      assert.equal(await page.locator("#button-names").getByRole("button", { name, exact: true }).count(), 1);
    }
    await page.locator("#button-names").evaluate(node => node.remove());
    assert.equal(await page.locator(".ag-helper-call .ag-task-badge").textContent(), "working");
    // The live feed names the helper, and the pickers keep it under its thread until a search asks for it.
    const picked = await page.evaluate(() => {
      const { S, liveStep, searchThreads, dock } = (window as any).helperTest;
      const anchor = document.createElement("button");
      document.body.append(anchor);
      dock.threadMenu(anchor);
      const menu = [...document.querySelectorAll(".ag-menu-item")].map((node) => [node.querySelector(".ag-menu-label")!.textContent, node.classList.contains("sub")]);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      anchor.remove();
      const hit = (r: any) => [r.id, r.title, r.locationLabel, r.snippet];
      return { step: liveStep(S.details.get("parent").items[0]).text, menu, all: searchThreads("").map(hit), found: searchThreads("audit").map(hit), words: searchThreads("task main").map(hit), none: searchThreads("main audit").length };
    });
    assert.equal(picked.step, "Helper · Audit the files · sonnet");
    assert.deepEqual(picked.menu, [["New thread", false], ["Main task", false], ["Audit the files", true]]);
    assert.deepEqual(picked.all, [["parent", "Main task", "Thread", ""]]);
    assert.deepEqual(picked.found, [["helper", "Audit the files", "Helper", "Main task"]]);
    // A search matches its words one by one, in any order.
    assert.deepEqual(picked.words, [["parent", "Main task", "Thread", ""]]);
    assert.equal(picked.none, 0);
    // The picker keeps its own worker and compact switches; toggling them keeps it open and searchable.
    const workers = await page.evaluate(() => {
      const { S, dock, renderThreadList } = (window as any).helperTest;
      (window as any).scribeChat.closeMenu();
      const base = S.threads.get("parent");
      const previous = { hide: S.dockHidePageThreads, side: S.hidePageThreads, current: dock.view.threadId, stored: localStorage.getItem("scribe.agent.dockHidePageThreads"), compact: localStorage.getItem("scribe.agent.dockCompactThreads") };
      for (const [id, extra] of [
        ["inactive-worker", {}], ["running-worker", { status: "running" }],
        ["waiting-worker", { status: "waiting" }], ["pinned-worker", { pinned: true }],
        ["selected-worker", {}],
      ] as const) S.threads.set(id, { ...base, id, title: id, fromPage: true, ...extra });
      S.dockHidePageThreads = true;
      S.hidePageThreads = true;
      dock.view.threadId = "selected-worker";
      const anchor = document.createElement("button");
      document.body.append(anchor);
      dock.threadMenu(anchor);
      const menu = document.querySelector(".ag-menu")!;
      const toggle = menu.querySelector<HTMLButtonElement>('[role="switch"]')!;
      const labels = () => [...menu.querySelectorAll(".ag-menu-label")].map(node => node.textContent);
      const initial = labels();
      const off = toggle.getAttribute("aria-checked");
      toggle.click();
      const shown = labels().includes("inactive-worker");
      const saved = localStorage.getItem("scribe.agent.dockHidePageThreads");
      const sidebarList = document.createElement("div");
      renderThreadList(sidebarList, { currentId: null, onPick() {}, onNew() {}, onNewIn() {} });
      const sidebarOn = sidebarList.querySelector('[role="switch"]')!.getAttribute("aria-checked");
      const compactSwitch = menu.querySelectorAll<HTMLButtonElement>('[role="switch"]')[1]!;
      const compactBefore = menu.classList.contains("compact");
      compactSwitch.click();
      const compact = [compactBefore, menu.classList.contains("compact"), compactSwitch.getAttribute("aria-checked"), localStorage.getItem("scribe.agent.dockCompactThreads"), menu.querySelector(".ag-menu-item .ag-prov") !== null];
      toggle.click();
      const hidden = !labels().includes("inactive-worker");
      const search = menu.querySelector<HTMLInputElement>("input")!;
      search.value = "inactive-worker";
      search.dispatchEvent(new Event("input"));
      const found = labels();
      const stayedOpen = menu.isConnected;
      (window as any).scribeChat.closeMenu();
      anchor.remove();
      for (const id of ["inactive-worker", "running-worker", "waiting-worker", "pinned-worker", "selected-worker"]) S.threads.delete(id);
      S.dockHidePageThreads = previous.hide;
      S.hidePageThreads = previous.side;
      dock.view.threadId = previous.current;
      for (const [key, value] of [["scribe.agent.dockHidePageThreads", previous.stored], ["scribe.agent.dockCompactThreads", previous.compact]] as const) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
      return { initial, off, shown, saved, sidebarOn, compact, hidden, found, stayedOpen };
    });
    assert.equal(workers.initial.includes("inactive-worker"), false);
    for (const id of ["running-worker", "waiting-worker", "pinned-worker", "selected-worker"]) assert.ok(workers.initial.includes(id), id);
    assert.deepEqual({ ...workers, initial: undefined }, {
      initial: undefined, off: "false", shown: true, saved: "0", sidebarOn: "false",
      compact: [false, true, "true", "1", true],
      hidden: true, found: ["inactive-worker"], stayedOpen: true,
    });
    // Words the title lacks may come from what was said in the thread, which the daemon searches.
    const said = await page.evaluate(async () => {
      const { searchThreads, searchMessages } = (window as any).helperTest;
      const before = searchThreads("llama main").length;
      const fresh = await searchMessages("llama main");
      return { before, fresh, hits: searchThreads("llama main").map((r: any) => [r.id, r.snippet]) };
    });
    assert.deepEqual(said, { before: 0, fresh: true, hits: [["parent", "about llama.cpp"]] });
    // Search relevance must hold across workspace boundaries, not just within each group.
    const rankedList = await page.evaluate(() => {
      const { S, renderThreadList } = (window as any).helperTest;
      const previous = { search: S.search, filter: S.filter };
      const base = S.threads.get("parent");
      S.threads.set("exact-search", { ...base, id: "exact-search", title: "llama main" });
      S.threads.set("workspace-search", { ...base, id: "workspace-search", title: "llama main notes", scope: { kind: "workspace", ref: "C:/models" } });
      S.search = "llama main";
      S.filter = "all";
      const container = document.createElement("div");
      document.body.append(container);
      const opts = { onPick() {}, onNew() {}, onNewIn() {}, currentId: null };
      renderThreadList(container, opts);
      const ids = [...container.querySelectorAll(".ag-row")].map((node: any) => node.dataset.id);
      S.search = "";
      renderThreadList(container, opts);
      const grouped = container.querySelectorAll(".ag-list-group").length > 0;
      container.remove();
      S.threads.delete("exact-search");
      S.threads.delete("workspace-search");
      Object.assign(S, previous);
      return { ids, grouped };
    });
    assert.deepEqual(rankedList, { ids: ["exact-search", "workspace-search", "parent"], grouped: true });
    assert.equal(await page.getByRole("button", { name: "Open thread", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Open helper: Audit the files", exact: true }).click();
    assert.equal(await page.locator(".ag-view-helper .ag-title").textContent(), "Helper: Audit the files");
    assert.equal(await page.evaluate(() => (window as any).helperTest.S.current), "parent");
    assert.equal(await page.evaluate(() => (window as any).helperTest.views().length), 4);
    assert.equal(await page.locator(".ag-view-helper").getByRole("button", { name: "Stop (Esc twice)", exact: true }).count(), 1);
    if (process.env.SCRIBE_HELPER_SCREENSHOT) await page.screenshot({ path: process.env.SCRIBE_HELPER_SCREENSHOT.replace(/\.png$/, "-panel.png") });
    await page.locator('.ag-view-helper textarea:not([aria-hidden])').fill("Helper draft");
    await page.getByRole("button", { name: "Close helper and return to parent chat" }).click();
    assert.equal(await page.locator('.ag-view-side textarea:not([aria-hidden])').inputValue(), "Parent draft");
    await page.getByRole("button", { name: "Open helper: Audit the files", exact: true }).click();
    assert.equal(await page.locator('.ag-view-helper textarea:not([aria-hidden])').inputValue(), "Helper draft");
    await page.getByRole("button", { name: "Close helper and return to parent chat" }).click();
    await page.evaluate(() => {
      const { S, onEvent } = (window as any).helperTest;
      onEvent({ type: "agent_thread", thread: { ...S.threads.get("helper"), provider: "codex", approval: "auto", status: "waiting", asking: { kind: "approval", itemId: "helper-approval", title: "Codex Auto-review denied this action", detail: "scribe/page_action\nThis needs explicit authorization.", options: [{ id: "approveRetry", label: "Approve one retry", kind: "allow_once" }, { id: "keepDenied", label: "Keep denied", kind: "reject_once" }] } } });
    });
    assert.match(await page.locator(".ag-helper-approval-name").textContent() || "", /Audit the files/);
    assert.match(await page.locator(".ag-helper-approval").textContent() || "", /scribe\/page_action/);
    assert.equal(await page.locator(".ag-helper-approval").getByRole("button", { name: "Keep denied", exact: true }).count(), 1);
    await page.locator(".ag-helper-approval").getByRole("button", { name: "Approve one retry", exact: true }).click();
    assert.deepEqual(approvals, ["helper-approval"]);
    assert.deepEqual(approvalDecisions, [{ optionId: "approveRetry" }]);
    const active = await page.evaluate(() => (window as any).helperTest.flyoutSnapshot("button").rows.map((r: any) => [r.thread.id, r.thread.status]));
    assert.deepEqual(active, [["parent", "waiting"]]);
    if (process.env.SCRIBE_HELPER_SCREENSHOT) await page.screenshot({ path: process.env.SCRIBE_HELPER_SCREENSHOT });
    await page.evaluate(() => {
      const { S, onEvent } = (window as any).helperTest;
      const detail = S.details.get("helper");
      detail.turns.get("helper-turn").status = "done";
      detail.items[0].text = "Audit complete.";
      onEvent({ type: "agent_thread", thread: { ...S.threads.get("helper"), status: "idle", asking: undefined } });
    });
    assert.equal(await page.locator(".ag-helper-call .ag-task-badge").textContent(), "done");
    assert.equal(await page.locator(".ag-helper-approval").count(), 0);
    await page.getByRole("button", { name: "Show summary", exact: true }).click();
    assert.match(await page.locator(".ag-helper-call .ag-tool-body").textContent() || "", /Audit complete/);
    assert.equal(await page.getByRole("button", { name: "Hide summary", exact: true }).getAttribute("aria-expanded"), "true");
    await page.getByRole("button", { name: "Hide summary", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Show summary", exact: true }).getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".ag-helper-call .ag-tool-body").isVisible(), false);
    // Waiting, sending more work, and stopping all refer back to the launch card.
    await page.evaluate(() => {
      const { S, view } = (window as any).helperTest;
      const detail = S.details.get("parent");
      for (const [index, input] of [{ thread: "helper" }, { thread: "helper", task: "Check the tests too" }, { thread: "helper", stop: true }].entries()) {
        const item = { ...detail.items[0], id: `action-${index}`, seq: index + 2, input, output: JSON.stringify({ thread: "helper", status: "done", reply: "Action report" }) };
        detail.items.push(item);
        detail.byId.set(item.id, item);
      }
      view.renderTranscript();
    });
    assert.equal(await parent.locator(".ag-helper-call").count(), 1);
    assert.deepEqual(await parent.locator(".ag-helper-action .ag-tool-verb").allTextContents(), ["Wait for helper", "Follow up helper", "Stop helper"]);
    assert.equal(await parent.locator(".ag-helper-action .ag-task-line, .ag-helper-action .ag-task-badge").count(), 0);
    const followUp = parent.locator('.ag-helper-action[data-item-id="action-1"]');
    await followUp.locator(".ag-tool-head").click();
    assert.match(await followUp.locator(".ag-tool-body").textContent() || "", /Check the tests too/);
    assert.match(await followUp.locator(".ag-tool-body").textContent() || "", /Action report/);
    await page.evaluate(() => {
      const { S, onEvent } = (window as any).helperTest;
      onEvent({ type: "agent_thread", thread: { ...S.threads.get("helper"), status: "running" } });
    });
    assert.equal(await parent.locator(".ag-helper-call .ag-task-badge").textContent(), "working");
    assert.equal(await parent.locator(".ag-helper-action.s-done").count(), 3);
    await page.evaluate(() => {
      const { S, onEvent } = (window as any).helperTest;
      onEvent({ type: "agent_thread", thread: { ...S.threads.get("helper"), status: "idle" } });
    });
    assert.equal(await parent.locator(".ag-helper-call").count(), 1);
    assert.equal(await parent.locator(".ag-helper-action").count(), 3);
    // The floating layout reparents the parent controls: helpers must live in its
    // interactive panel, not the pointer-transparent outer dock.
    await page.evaluate(() => {
      const { dock, S } = (window as any).helperTest;
      document.querySelector("main")!.parentElement!.classList.add("workspace");
      Object.assign(document.querySelector("main")!.style, { position: "relative", width: "860px" });
      dock.mount();
      S.dockShown = true;
      dock.view.setThread("parent");
      dock.setExpanded(true);
      dock.view.input.value = "Floating parent draft";
    });
    const floating = page.locator(".agent-dock");
    const capsuleStyle = await floating.locator(".dock-input").evaluate(node => {
      const style = getComputedStyle(node);
      return [style.borderRadius, style.padding, style.boxShadow];
    });
    await floating.getByRole("button", { name: "Open helper: Audit the files", exact: true }).click();
    const helper = floating.locator(".ag-view-helper");
    assert.equal(await helper.evaluate(node => getComputedStyle(node).pointerEvents), "auto");
    const helperBox = await helper.boundingBox();
    assert.ok(helperBox && helperBox.height >= 500 && helperBox.y >= 0);
    assert.equal(await floating.locator(".dock-panel > .dock-head").evaluate(node => (node as HTMLElement).inert), true);
    assert.deepEqual(await helper.locator(".dock-input").evaluate(node => {
      const style = getComputedStyle(node);
      return [style.borderRadius, style.padding, style.boxShadow];
    }), capsuleStyle);
    const layers = await helper.evaluate(node => {
      const input = node.querySelector(".dock-input")!;
      const output = node.querySelector(".dock-out")!;
      const surface = getComputedStyle(output, "::before");
      const parentSurface = getComputedStyle(document.querySelector(".dock-panel > .dock-head .dock-out")!, "::before");
      return {
        transparent: getComputedStyle(node).backgroundColor === "rgba(0, 0, 0, 0)",
        overlap: output.getBoundingClientRect().bottom - input.getBoundingClientRect().top,
        inset: input.getBoundingClientRect().left < output.getBoundingClientRect().left,
        sameEdge: surface.borderRadius === parentSurface.borderRadius && surface.boxShadow === parentSurface.boxShadow,
        dark: surface.backgroundColor === getComputedStyle(input).backgroundColor,
        sidebarComposer: !!node.querySelector(".ag-compose-row"),
      };
    });
    assert.deepEqual(layers, { transparent: true, overlap: 14, inset: true, sameEdge: true, dark: true, sidebarComposer: false });
    await helper.locator('textarea:not([aria-hidden])').fill("Floating helper draft");
    if (process.env.SCRIBE_HELPER_SCREENSHOT) await page.screenshot({ path: process.env.SCRIBE_HELPER_SCREENSHOT.replace(/\.png$/, "-floating.png") });
    await helper.getByRole("button", { name: "Close helper and return to parent chat" }).click();
    assert.equal(await floating.locator('.dock-input textarea:not([aria-hidden])').inputValue(), "Floating parent draft");
    await floating.getByRole("button", { name: "Open helper: Audit the files", exact: true }).click();
    assert.equal(await helper.locator('textarea:not([aria-hidden])').inputValue(), "Floating helper draft");
    await page.evaluate(() => (window as any).helperTest.dock.setExpanded(false));
    assert.equal(await helper.count(), 0);
    assert.equal(await floating.locator(".dock-input").evaluate(node => (node as HTMLElement).inert), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
