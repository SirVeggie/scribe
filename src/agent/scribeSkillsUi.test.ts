import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "../chromium.js";
import { loadChatFixture } from "../testSupport/shell.js";

test("Scribe skill picks, effective counts, slash insertion and draft creation", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Scribe skills UI test" });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const skills = [
      { id: "builtin:scribe", name: "Scribe", enabled: true, builtin: true },
      { id: "always", name: "Always", enabled: true },
      { id: "review", name: "Review", description: "Review changes", enabled: false },
      { id: "missing", name: "Missing", enabled: false, missing: true },
      { id: "clear", name: "clear", enabled: false },
    ];
    const writes: { path: string; body: any }[] = [];
    let thread: any;
    await page.route("http://skills.test/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (!path.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: "<main></main>" });
      const body = request.method() === "GET" ? null : request.postDataJSON();
      if (body) writes.push({ path, body });
      if (path === "/api/agent/threads" && body) thread = { ...body, id: "created", title: "New thread", status: "idle", stats: { turns: 0 } };
      if (path === "/api/agent/threads/created" && body) thread = { ...thread, ...body };
      const data = path.endsWith("/scribe-skills") ? { skills }
        : path.endsWith("/commands") ? { commands: [{ name: "Review", description: "Provider review" }] }
        : path === "/api/agent/config" ? { providers: [{ id: "codex", available: true }], prefs: {}, models: { claude: [], cursor: [], codex: [], pi: [] } }
        : ["/api/agent/threads", "/api/agent/threads/created"].includes(path) && body ? { thread }
        : {};
      return route.fulfill({ json: data });
    });
    await page.goto("http://skills.test/");
    const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    await loadChatFixture(page, source.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/,
      "  window.skillsTest = { ChatView, S, loadScribeSkills, effectiveScribeSkills, closeMenu };"));
    await page.evaluate(async () => {
      const { ChatView, S, loadScribeSkills } = (window as any).skillsTest;
      S.config.providers = [{ id: "codex", label: "Codex", available: true }];
      const view = new ChatView("side");
      (window as any).skillView = view;
      document.querySelector("main")!.append(view.root);
      await loadScribeSkills();
      view.renderAll();
    });
    const pill = page.locator(".ag-skills");
    assert.equal(await pill.textContent(), "2 skills");
    await pill.click();
    const menu = page.locator(".ag-menu");
    const always = menu.locator(".ag-menu-item").filter({ hasText: "Always" });
    assert.equal(await always.isDisabled(), true);
    assert.match(await always.textContent() || "", /On for every chat/);
    await menu.locator(".ag-menu-item").filter({ hasText: "Review changes" }).click();
    await page.waitForFunction(() => document.querySelector(".ag-skills")?.textContent === "3 skills");
    assert.equal(await pill.textContent(), "3 skills");
    await page.evaluate(async () => {
      const view = (window as any).skillView;
      await view.updateSettings({ skills: ["gone"] });
    });
    await pill.click();
    assert.equal(await menu.locator(".ag-menu-item").filter({ hasText: /^Unavailable skill/ }).isDisabled(), true);
    await menu.locator(".ag-menu-item").filter({ hasText: /^Remove unavailable skill/ }).click();
    await page.waitForFunction(() => !(window as any).skillView.settings().skills.length);

    await page.evaluate(async () => {
      const view = (window as any).skillView;
      await view.updateSettings({ skills: ["review"] });
      view.input.value = "Review this task";
      await view.send();
      await view.updateSettings({ skills: [] });
    });
    assert.deepEqual(writes.find(write => write.path === "/api/agent/threads")?.body.skills, ["review"]);

    const input = page.locator('.ag-textarea:not([aria-hidden="true"])');
    await input.fill("/rev");
    const slash = page.locator(".ag-slash-item");
    await slash.first().waitFor();
    assert.equal(await slash.count(), 1, "skill wins a name collision with a provider command");
    assert.match(await slash.textContent() || "", /Scribe skill/);
    await input.press("Tab");
    assert.equal(await input.inputValue(), 'Use the Scribe skill "Review": read it with skill_read and follow it. ');
    await page.waitForFunction(() => (window as any).skillView.settings().skills.includes("review"));
    assert.ok(writes.some(write => write.path === "/api/agent/threads/created" && write.body.skills?.includes("review")), "slash selection patches an existing thread");

    await page.evaluate(() => {
      const { S, effectiveScribeSkills } = (window as any).skillsTest;
      const settings = { skills: ["review", "missing"], scope: { kind: "workspace" } };
      if (effectiveScribeSkills(settings).length !== 2) throw new Error("Scope None must exclude the built-in and missing skills");
      if (effectiveScribeSkills({ ...settings, noTools: true }).length) throw new Error("Tools-off chats must have no skills");
      S.scribeSkills = S.scribeSkills.filter((skill: any) => skill.builtin);
      const view = (window as any).skillView;
      view.threadId = null;
      view.draft = { scope: { kind: "global" }, settings: {} };
      view.renderComposerBar();
    });
    assert.equal(await pill.count(), 0, "users with only the built-in see no new pill");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
