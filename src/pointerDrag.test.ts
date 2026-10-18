import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "./chromium.js";
import { BOARD_BRIDGE_JS } from "./bridge.js";
import { loadShellScripts } from "./testSupport/shell.js";

test("pointer drags coalesce moves, cache geometry, filter pointers and clean up every exit", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Pointer drag lifecycle test" });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="source">Drag</button><iframe></iframe>');
    await page.addScriptTag({ content: "window.__name = (fn) => fn;" });
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/pointer-drag.js", import.meta.url), "utf8") });
    const result = await page.evaluate(() => {
      const w = window as any;
      const source = document.querySelector("button")!;
      let seq = 0, measures = 0, starts = 0, moves: number[] = [], drops = 0, cancels = 0, clicks = 0;
      const queue = new Map<number, FrameRequestCallback>();
      w.requestAnimationFrame = (fn: FrameRequestCallback) => { queue.set(++seq, fn); return seq; };
      w.cancelAnimationFrame = (id: number) => queue.delete(id);
      const flush = () => { const work = [...queue.values()]; queue.clear(); work.forEach(fn => fn(0)); };
      const pointer = (type: string, x: number, pointerId = 1) => new PointerEvent(type, { pointerId, button: 0, clientX: x, clientY: 10, bubbles: true, cancelable: true });
      const start = () => w.scribeDrag({ event: pointer("pointerdown", 10), target: source,
        measure: (api: any) => { measures++; assertRect(api.rect(source) === api.rect(source)); },
        onStart: () => starts++, onMove: (e: PointerEvent) => { moves.push(e.clientX); },
        onDrop: () => drops++, onCancel: () => cancels++,
      });
      function assertRect(same: boolean) { if (!same) throw Error("rect wasn't cached"); }
      source.addEventListener("click", () => clicks++);
      start();
      window.dispatchEvent(pointer("pointermove", 13)); flush();
      const belowThreshold = starts === 0 && measures === 0;
      window.dispatchEvent(pointer("pointermove", 50, 2)); flush();
      const otherPointer = starts === 0;
      window.dispatchEvent(pointer("pointermove", 20));
      window.dispatchEvent(pointer("pointermove", 30));
      window.dispatchEvent(pointer("pointermove", 40));
      flush();
      const coalesced = moves.join() === "40" && measures === 1;
      const shield = getComputedStyle(document.querySelector("iframe")!).pointerEvents === "none";
      window.dispatchEvent(pointer("pointermove", 45)); flush();
      const cached = measures === 1;
      window.dispatchEvent(new Event("scroll")); flush();
      const remeasured = measures === 2;
      window.dispatchEvent(pointer("pointerup", 55, 2));
      const otherUp = drops === 0;
      window.dispatchEvent(pointer("pointerup", 60));
      source.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      const final = moves.at(-1) === 60 && drops === 1 && clicks === 0 && !queue.size;
      const clean = () => !document.body.classList.contains("pointer-shield") && queue.size === 0;
      let exits = clean();
      for (const kind of ["pointercancel", "lostpointercapture", "Escape", "blur"]) {
        start(); window.dispatchEvent(pointer("pointermove", 40)); flush();
        if (kind === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: kind }));
        else if (kind === "blur") window.dispatchEvent(new Event("blur"));
        else (kind === "lostpointercapture" ? source : window).dispatchEvent(pointer(kind, 40));
        exits &&= clean();
      }
      return { belowThreshold, otherPointer, coalesced, shield, cached, remeasured, otherUp, final, exits, cancels };
    });
    assert.deepEqual(result, { belowThreshold: true, otherPointer: true, coalesced: true, shield: true, cached: true, remeasured: true, otherUp: true, final: true, exits: true, cancels: 4 });
  } finally { await browser.close(); }
});

test("Kanban and todo use the bridge controller for cross-column drops and Escape", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Template drag test" });
  try {
    for (const kind of ["kanban", "todo-list"]) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on("pageerror", e => errors.push(e.message));
      const state = kind === "kanban" ? {
        columns: [{ id: "a", title: "First" }, { id: "b", title: "Second" }], labels: [], settings: {}, nextNum: 4,
        cards: ["one", "two", "three"].map((id, index) => ({ id, num: index + 1, title: id, col: "a", labels: [], checklist: [], comments: [], images: [], blockedBy: [], priority: 0, description: "" })),
      } : { todos: ["one", "two", "three"].map(id => ({ id, text: id, col: 0 })) };
      const boot = { id: "test", stateRevision: 1, state, template: { values: { columns: 2 } } };
      const html = fs.readFileSync(new URL(`../templates/builtin/${kind}.html`, import.meta.url), "utf8")
        .replace("<head>", `<head><script>window.__SCRIBE_BOOT__=${JSON.stringify(boot)}</script><script>${BOARD_BRIDGE_JS}</script>`);
      let revision = 1;
      await page.route("http://drag.test/**", route => {
        if (route.request().method() === "PUT") return route.fulfill({ json: { ok: true, fromRevision: revision++, stateRevision: revision, applied: route.request().postDataJSON().ops, skipped: [] } });
        return route.fulfill(route.request().url() === "http://drag.test/" ? { contentType: "text/html", body: html } : { json: {} });
      });
      await page.goto("http://drag.test/");
      const item = kind === "kanban" ? '.card[data-id="one"]' : '.item[data-id="one"]';
      const source = await page.locator(item).boundingBox();
      const dest = await page.locator(".column").nth(1).boundingBox();
      assert.ok(source && dest, kind + JSON.stringify(errors));
      const drag = async () => {
        await page.mouse.move(source.x + 60, source.y + source.height / 2);
        await page.mouse.down();
        await page.mouse.move(dest.x + 90, dest.y + 100, { steps: 8 });
        assert.equal(await page.evaluate(() => document.body.classList.contains("pointer-shield")), true, kind + " drag start: " + JSON.stringify(errors));
      };
      await drag();
      await page.keyboard.press("Escape");
      await page.mouse.up();
      assert.equal(await page.locator(".column").nth(0).locator(item).count(), 1, kind);
      assert.equal(await page.locator(".pointer-shield").count(), 0, kind);
      await drag();
      await page.mouse.up();
      await page.waitForFunction((kind) => {
        const s = (window as any).scribe.state;
        return kind === "kanban" ? s.cards.find((c: any) => c.id === "one").col === "b" : s.todos.find((t: any) => t.id === "one").col === 1;
      }, kind);
      assert.equal(await page.locator(".pointer-shield").count(), 0, kind);
      assert.deepEqual(errors, [], kind);
      await page.close();
    }
  } finally { await browser.close(); }
});

test("Library and Spaces drags commit once and defer refreshes until release", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Shell list drag test" });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "");
    await page.route("http://lists.test/", route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto("http://lists.test/");
    await loadShellScripts(page, { scripts: ["pointer-drag.js", "dom-sync.js", "select.js", "files.js", "library.js", "spaces.js"] });
    await page.evaluate(() => {
      const w = window as any;
      w.requests = [];
      w.folders = [{ id: "one", name: "First", pos: 0 }, { id: "two", name: "Second", pos: 1 }];
      w.fetch = async (url: string, options: any) => {
        w.requests.push({ url, body: options.body && JSON.parse(options.body) });
        return { ok: true, json: async () => ({}) };
      };
      w.library = w.createLibrary({ folders: () => w.folders, pages: () => [], paneOpen: () => true,
        icons: {}, hoverCard: { hide() {}, suspend() {}, resume() {} }, findAny() {},
        clearStripSlot() {}, showNotice(message: string) { throw Error(message); },
      });
      const list = document.getElementById("library-list")!;
      document.body.replaceChildren(list);
      list.style.cssText = "position:relative;width:300px;height:300px;margin:20px";
      const style = document.createElement("style");
      style.textContent = ".lib-row {display:flex;height:40px;box-sizing:border-box} .lib-drop-line {position:absolute} .lib-ghost {position:fixed;left:0;top:0;pointer-events:none}";
      document.head.append(style);
      w.library.render();
    });
    const from = await page.locator('.lib-row[data-id="one"]').boundingBox();
    const to = await page.locator('.lib-row[data-id="two"]').boundingBox();
    assert.ok(from && to);
    await page.mouse.move(from.x + 80, from.y + 20); await page.mouse.down();
    await page.mouse.move(to.x + 80, to.y + 20, { steps: 6 });
    assert.equal(await page.evaluate(() => document.body.classList.contains("pointer-shield")), true);
    assert.equal(await page.evaluate(() => {
      const w = window as any, row = document.querySelector('.lib-row[data-id="one"]');
      w.folders[0].name = "Updated while dragging"; w.library.render();
      return row === document.querySelector('.lib-row[data-id="one"]') && !row!.textContent!.includes("Updated");
    }), true);
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => (window as any).requests), [{ url: "/api/folders/one/move", body: { parentId: "two", index: 0 } }]);
    assert.match(await page.locator('.lib-row[data-id="one"]').textContent() || "", /Updated/);

    await page.evaluate(async () => {
      const w = window as any;
      const chip = document.createElement("span"); document.body.replaceChildren(chip);
      w.spaceData = { activeId: "one", deleted: [], spaces: ["one", "two", "three"].map(id => ({ id, name: id, tabs: [] })) };
      w.requests = [];
      w.fetch = async (url: string, options: any) => {
        w.requests.push({ url, body: options.body && JSON.parse(options.body) });
        return { ok: true, json: async () => w.spaceData };
      };
      w.spaces = w.createSpaces({ chipSlot: chip, findAnyTab() {}, showNotice(message: string) { throw Error(message); } });
      await w.spaces.show();
      const style = document.createElement("style");
      style.textContent = ".spaces-grid {display:grid;grid-template-columns:repeat(3,250px);gap:10px} .space-card {height:150px;position:relative} .space-card.dragging {z-index:2}";
      document.head.append(style);
    });
    const first = await page.locator('.space-card[data-id="one"]').boundingBox();
    const third = await page.locator('.space-card[data-id="three"]').boundingBox();
    assert.ok(first && third);
    await page.mouse.move(first.x + 60, first.y + 90); await page.mouse.down();
    await page.mouse.move(third.x + 80, third.y + 90, { steps: 6 });
    await page.mouse.up();
    const requests = await page.evaluate(() => (window as any).requests.filter((r: any) => r.url.endsWith("/move")));
    assert.deepEqual(requests, [{ url: "/api/spaces/one/move", body: { index: 2 } }]);
    assert.equal(await page.evaluate(() => document.body.classList.contains("pointer-shield")), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("sidebar resizing flushes release coordinates and Escape restores the saved width", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Sidebar resize test" });
  try {
    const page = await browser.newPage();
    await page.route("http://resize.test/", route => route.fulfill({ contentType: "text/html", body: '<aside style="width:300px;height:200px"><div id="handle" style="width:10px;height:200px"></div></aside>' }));
    await page.goto("http://resize.test/");
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/pointer-drag.js", import.meta.url), "utf8") });
    const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    const handler = app.slice(app.indexOf('  sideResizer.addEventListener("pointerdown"'), app.indexOf('  window.addEventListener("popstate"'));
    await page.addScriptTag({ content: `{
      const sideResizer = document.querySelector('#handle'), sidePane = document.querySelector('aside');
      const SIDE_WIDTH_KEY = 'test-width';
      document.documentElement.dataset.librarySide = 'left';
      function applySideWidth(width) { sidePane.style.width = width + 'px'; return width; }
      ${handler}
    }` });
    await page.mouse.move(12, 30); await page.mouse.down(); await page.mouse.move(62, 30);
    await page.keyboard.press("Escape"); await page.mouse.up();
    assert.equal(await page.locator("aside").evaluate(el => el.getBoundingClientRect().width), 300);
    assert.equal(await page.evaluate(() => localStorage.getItem("test-width")), null);
    await page.mouse.move(12, 30); await page.mouse.down(); await page.mouse.move(112, 30); await page.mouse.up();
    assert.equal(await page.locator("aside").evaluate(el => el.getBoundingClientRect().width), 400);
    assert.equal(await page.evaluate(() => localStorage.getItem("test-width")), "400");
    assert.equal(await page.locator("body").evaluate(el => el.classList.contains("pointer-shield") || el.classList.contains("resizing-side")), false);
  } finally { await browser.close(); }
});
