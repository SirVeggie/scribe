import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "../chromium.js";
import { chatScripts, loadShellScripts } from "../testSupport/shell.js";

const agent = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");

/** The production chat view in a bare page: no daemon, no shell; the test feeds it events (#431). */
async function chatPage() {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Transcript update test" });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  // localStorage needs a real origin.
  await page.route("http://chat.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<body></body>" }));
  await page.goto("http://chat.test/");
  const exposed = agent.replace(/  if \(document\.readyState === "loading"\)[\s\S]*?else boot\(\);/, `
    window.T = {
      S, onEvent, view: full.view, R, requestRender, movedBanners,
      open(thread, items, turns) {
        S.threads.set(thread.id, thread);
        S.details.set(thread.id, { items, byId: new Map(items.map((it) => [it.id, it])), turns: new Map(turns.map((t) => [t.id, t])) });
        S.fullOpen = true;
        document.body.append(full.view.root);
        full.view.threadId = thread.id;
        full.view.renderTranscript();
      },
      frame: () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
    };
  `);
  assert.notEqual(exposed, agent, "boot() is replaced");
  await loadShellScripts(page, {
    scripts: [...chatScripts, "/vendor/marked.js", "/vendor/purify.js", "/vendor/highlight.js", "agent.js"],
    transform: (name, source) => (name === "agent.js" ? exposed : source),
  });
  return { browser, page, errors };
}

const thread = { id: "t", title: "Thread", status: "running", scope: { kind: "global", ref: null }, stats: {}, provider: "claude", model: "m" };
const turn = { id: "u1", threadId: "t", seq: 1, status: "running", startedAt: 1 };
const items = [
  { id: "m", threadId: "t", turnId: "u1", seq: 1, kind: "user", text: "Go" },
  { id: "r", threadId: "t", turnId: "u1", seq: 2, kind: "reasoning", text: "Thinking **hard**", startedAt: 1, endedAt: 3000 },
  { id: "x", threadId: "t", turnId: "u1", seq: 3, kind: "tool", tool: "execute", toolId: "c1", title: "ls", detail: "ls", status: "done", output: "a\nb", startedAt: 1, endedAt: 2 },
  { id: "p", threadId: "t", turnId: "u1", seq: 4, kind: "approval", requestId: "p", title: "Run rm", status: "pending", options: [{ id: "allow", kind: "allow_once", label: "Allow" }, { id: "deny", kind: "reject_once", label: "Deny" }] },
];

test("component summary and local updates keep the live iframe through transcript reconciliation", async () => {
  const { browser, page, errors } = await chatPage();
  try {
    let loads = 0;
    await page.route("http://w-it-012345abcdef.localhost/**", route => {
      loads++;
      return route.fulfill({ contentType: "text/html", body: "<p>Inline kit</p>" });
    });
    const component = { id: "it_012345abcdef", threadId: "t", turnId: "u1", seq: 5, kind: "component", html: "<p>Inline kit</p>", fallback: "Color table", status: "shown", wait: false };
    await page.evaluate(([thread, component, turn]) => (window as any).T.open(thread, [component], [turn]), [thread, component, turn] as const);
    await page.locator(".ag-component iframe").waitFor();
    await page.evaluate(() => { (window as any).originalFrame = document.querySelector(".ag-component iframe"); });
    await page.evaluate(async component => {
      const { T } = window as any;
      T.onEvent({ type: "agent_item", item: { ...component, local: { tab: "two" }, summary: "Updated table" } });
      T.onEvent({ type: "agent_item", item: { id: "later", threadId: "t", turnId: "u1", seq: 6, kind: "text", text: "After the table" } });
      await T.frame();
    }, component);
    assert.equal(await page.evaluate(() => (window as any).originalFrame === document.querySelector(".ag-component iframe")), true);
    assert.equal(loads, 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("missing workspaces offer manual repair when automatic recovery finds nothing", async () => {
  const { browser, page, errors } = await chatPage();
  try {
    await page.evaluate(() => {
      const { S, movedBanners } = (window as any).T;
      S.missing = [
        { path: "C:/lost/project", found: null, threads: 2, dismissed: false },
        { path: "C:/old/app", found: "C:/new/app", threads: 1, dismissed: false },
        { path: "C:/ignored", found: null, threads: 1, dismissed: true },
      ];
      document.body.append(...movedBanners());
    });
    const banners = page.locator(".ag-ws-moved");
    assert.equal(await banners.count(), 2);
    assert.equal(await banners.nth(0).locator(".ag-ws-moved-text").textContent(), "project is missing");
    assert.deepEqual(await banners.nth(0).locator("button").allTextContents(), ["Locate folder…", "Ignore"]);
    assert.equal(await banners.nth(1).locator(".ag-ws-moved-text").textContent(), "app is now app");
    assert.deepEqual(await banners.nth(1).locator("button").allTextContents(), ["Update 1 thread", "Other…", "Ignore"]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("sending to a missing workspace opens repair and keeps the unsent draft", async () => {
  const { browser, page, errors } = await chatPage();
  const writes: { url: string; body: any }[] = [];
  try {
    await page.route("**/api/agent/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() !== "GET") writes.push({ url: url.pathname, body: req.postDataJSON() });
      const data = url.pathname.endsWith("/workspaces/missing")
        ? { missing: [{ path: "C:/lost/project", found: null, threads: 1, dismissed: false }] }
        : url.pathname.endsWith("/workspaces/relocate") ? { threads: 1 }
        : { exists: url.searchParams.get("check") !== "1", path: "C:/lost", parent: "C:/", dirs: [], repo: null };
      await route.fulfill({ json: data });
    });
    await page.evaluate((thread) => {
      const { T } = window as any;
      T.open({ ...thread, status: "idle", cwd: "C:/lost/project" }, [], []);
      T.view.input.value = "Keep this message";
      T.view.attachments = [{ name: "note.txt", mimeType: "text/plain", data: "aGVsbG8=" }];
      void T.view.send();
    }, thread);
    await page.getByRole("heading", { name: "Where is this folder now?" }).waitFor();
    assert.equal(await page.evaluate(() => (window as any).T.view.input.value), "Keep this message");
    await page.locator(".ag-ws").getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForFunction(() => !(window as any).T.view.sending);
    assert.deepEqual(writes, []);
    await page.evaluate(() => { void (window as any).T.view.send(); });
    await page.getByRole("heading", { name: "Where is this folder now?" }).waitFor();
    await page.locator(".ag-ws input[type=text]").fill("C:/new/project");
    await page.locator(".ag-ws").getByRole("button", { name: "Use folder", exact: true }).click();
    await page.waitForFunction(() => !(window as any).T.view.sending);
    assert.deepEqual(writes, [{ url: "/api/agent/workspaces/relocate", body: { from: "C:/lost/project", to: "C:/new/project" } }]);
    assert.deepEqual(await page.evaluate(() => {
      const view = (window as any).T.view;
      return { text: view.input.value, files: view.attachments.length };
    }), { text: "Keep this message", files: 1 });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("notices keep their text and recovery controls through repeated turn updates", async () => {
  const { browser, page, errors } = await chatPage();
  try {
    const notices = [
      { id: "limit", level: "error", text: "Usage limit reached. Try again later." },
      { id: "info", level: "info", text: "Connected again." },
      { id: "warn", level: "warn", text: "Connection interrupted." },
      { id: "folder", level: "error", text: "Not a folder: C:/missing" },
    ].map((notice, i) => ({ ...notice, kind: "notice", threadId: "t", turnId: "u1", seq: 5 + i }));
    await page.evaluate(([thread, items, turn]) => (window as any).T.open(thread, items, [turn]), [thread, [...items, ...notices], turn] as const);
    const before = await page.locator(".ag-notice").allTextContents();
    assert.deepEqual(before, notices.map((notice) => notice.text + (notice.id === "folder" ? " Choose folder" : "")));
    await page.evaluate(async () => {
      const { onEvent, frame } = (window as any).T;
      for (let i = 0; i < 3; i++) {
        onEvent({ type: "agent_item", item: { id: "answer", threadId: "t", turnId: "u1", seq: 9, kind: "text", text: `Update ${i}` } });
        await frame();
      }
    });
    assert.deepEqual(await page.locator(".ag-notice").allTextContents(), before);
    assert.equal(await page.locator(".ag-notice button").count(), 1);
    assert.equal(await page.locator("[data-sync-keep]").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("a turn's unchanged steps stay in the page, typed notes survive, and collapsed bodies build on open", async () => {
  const { browser, page, errors } = await chatPage();
  try {
    await page.evaluate(([thread, items, turn]) => (window as any).T.open(thread, items, [turn]), [thread, items, turn] as const);
    const before = await page.evaluate(() => {
      const w = window as any;
      const tool = document.querySelector('[data-item-id="x"]')!;
      const reason = document.querySelector('[data-item-id="r"]')!;
      const note = document.querySelector('[data-item-id="p"] input') as HTMLInputElement;
      note.value = "because";
      note.dispatchEvent(new Event("input"));
      w.kept = { tool, reason, note };
      // Collapsed: nothing built yet.
      return [tool.querySelector(".ag-tool-body")!.childElementCount, reason.querySelector(".ag-reason-body")!.childElementCount];
    });
    assert.deepEqual(before, [0, 0]);

    // A new step and a changed approval in the same turn.
    await page.evaluate(async () => {
      const w = window as any;
      w.T.onEvent({ type: "agent_item", item: { id: "y", threadId: "t", turnId: "u1", seq: 5, kind: "text", text: "Done." } });
      const p = w.T.S.details.get("t").byId.get("p");
      w.T.onEvent({ type: "agent_item", item: { ...p, title: "Run rm -rf" } });
      await w.T.frame();
    });
    const after = await page.evaluate(() => {
      const w = window as any;
      const tool = document.querySelector('[data-item-id="x"]');
      const note = document.querySelector('[data-item-id="p"] input') as HTMLInputElement;
      return [tool === w.kept.tool, document.querySelector('[data-item-id="r"]') === w.kept.reason, note === w.kept.note, note.value,
        Boolean(document.querySelector('[data-item-id="y"]')), document.querySelectorAll("[data-sync-keep]").length,
        tool!.classList.contains("ag-step-last")];
    });
    // The approval was rebuilt, but its note came back from the model.
    assert.deepEqual(after, [true, true, false, "because", true, 0, true]);

    const opened = await page.evaluate(() => {
      (document.querySelector('[data-item-id="x"] .ag-tool-head') as HTMLElement).click();
      (document.querySelector('[data-item-id="r"] .ag-reason-head') as HTMLElement).click();
      return [document.querySelector('[data-item-id="x"] .ag-out')?.textContent, document.querySelector('[data-item-id="r"] strong')?.textContent];
    });
    assert.deepEqual(opened, ["a\nb", "hard"]);

    // Opened steps stay open and built through another update.
    const still = await page.evaluate(async () => {
      const w = window as any;
      w.T.onEvent({ type: "agent_item", item: { id: "z", threadId: "t", turnId: "u1", seq: 6, kind: "text", text: "More." } });
      // A later step on the same rail takes the last-step mark from the kept one.
      w.T.onEvent({ type: "agent_item", item: { id: "w", threadId: "t", turnId: "u1", seq: 3.5, kind: "tool", tool: "execute", toolId: "c2", title: "pwd", detail: "pwd", status: "running", startedAt: 5 } });
      await w.T.frame();
      const tool = document.querySelector('[data-item-id="x"]')!;
      return [tool === w.kept.tool, tool.classList.contains("open"), Boolean(tool.querySelector(".ag-out")), tool.classList.contains("ag-step-last"),
        document.querySelector('[data-item-id="y"]')!.classList.contains("ag-answer-earlier")];
    });
    assert.deepEqual(still, [true, true, true, false, true]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("streamed markdown redraws only the block being written and highlights a fence once it closes", async () => {
  const { browser, page, errors } = await chatPage();
  try {
    const result = await page.evaluate(() => {
      const { R } = (window as any).T;
      const target = document.createElement("div");
      document.body.append(target);
      const ctx = {};
      R.renderMarkdownStream(target, "First paragraph.\n\nSecond", ctx);
      const first = target.querySelector("p");
      R.renderMarkdownStream(target, "First paragraph.\n\nSecond paragraph.\n\n```js\nconst a = 1;", ctx);
      const keptFirst = target.querySelector("p") === first;
      const openFence = target.querySelector("code")!;
      const highlightedWhileOpen = openFence.classList.contains("hljs");
      const text = "First paragraph.\n\nSecond paragraph.\n\n```js\nconst a = 1;\n```\n\nAfter **that**.";
      R.renderMarkdownStream(target, text, ctx);
      const code = target.querySelector("code")!;
      const streamed = target.innerHTML;
      const full = document.createElement("div");
      R.renderMarkdown(full, text, ctx);
      return [keptFirst, target.querySelector("p") === first, highlightedWhileOpen, code.classList.contains("hljs"),
        target.querySelectorAll(".ag-code").length, streamed === full.innerHTML];
    });
    assert.deepEqual(result, [true, true, false, true, 1, true]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("a hidden view skips transcript work and draws once when shown", async () => {
  const { browser, page, errors } = await chatPage();
  try {
    await page.evaluate(([thread, items, turn]) => (window as any).T.open(thread, items, [turn]), [thread, items, turn] as const);
    const result = await page.evaluate(async () => {
      const w = window as any;
      const { S, view, onEvent, frame } = w.T;
      S.fullOpen = false;
      let draws = 0;
      const draw = view.renderTranscript.bind(view);
      view.renderTranscript = () => { draws += 1; draw(); };
      onEvent({ type: "agent_item", item: { id: "y", threadId: "t", turnId: "u1", seq: 5, kind: "text", text: "Hi" } });
      onEvent({ type: "agent_delta", threadId: "t", itemId: "y", append: " there" });
      await frame();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const hidden = [Boolean(document.querySelector('[data-item-id="y"]')), view.stale];
      S.fullOpen = true;
      view.wake();
      view.wake();
      return [...hidden, document.querySelector('[data-item-id="y"]')?.textContent?.trim(), view.stale, draws];
    });
    // Nothing asked for a whole redraw while hidden, and the second wake had nothing to do.
    assert.deepEqual(result, [false, true, "Hi there", false, 1]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("render requests in one frame draw once, at the widest scope asked for", async () => {
  const { browser, page, errors } = await chatPage();
  try {
    await page.evaluate(([thread, items, turn]) => (window as any).T.open(thread, items, [turn]), [thread, items, turn] as const);
    const counts = await page.evaluate(async () => {
      const { view, requestRender, frame } = (window as any).T;
      const seen = { all: 0, chrome: 0 };
      view.renderAll = () => { seen.all += 1; };
      view.renderChrome = () => { seen.chrome += 1; };
      requestRender("chrome");
      requestRender("chrome");
      await frame();
      const chromeOnly = { ...seen };
      requestRender("chrome");
      requestRender();
      requestRender("chrome");
      await frame();
      return [chromeOnly, seen];
    });
    assert.deepEqual(counts, [{ all: 0, chrome: 1 }, { all: 1, chrome: 1 }]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
