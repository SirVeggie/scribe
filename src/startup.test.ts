import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";

test("bundled Inter is ready for the first text paint, including a cache-free refresh", async () => {
  const browser = process.env.SCRIBE_TEST_CHROMIUM
    ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
    : await launchChromium({ headless: true, args: [], purpose: "Bundled fonts test" });
  try {
    const page = await browser.newPage();
    const root = new URL("../public/", import.meta.url);
    const shell = fs.readFileSync(new URL("index.html", root), "utf8");
    const fontLink = shell.match(/<link[^>]+href="\.\/fonts\.css"[^>]*>/)![0];
    const fontScript = shell.match(/<script src="\.\/fonts\.js"[^>]*><\/script>/)![0];
    const external: string[] = [];
    page.on("request", request => {
      if (!request.url().startsWith("http://fonts.local/")) external.push(request.url());
    });
    // Routing disables the browser HTTP cache. Delay the stylesheet to simulate
    // a cold/hard refresh; its embedded faces must still be ready at first paint.
    await page.route("http://fonts.local/**", async route => {
      if (new URL(route.request().url()).pathname === "/fonts.css") {
        await new Promise(resolve => setTimeout(resolve, 150));
        return route.fulfill({ contentType: "text/css", body: fs.readFileSync(new URL("fonts.css", root)) });
      }
      if (new URL(route.request().url()).pathname === "/fonts.js") {
        return route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(new URL("fonts.js", root)) });
      }
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8">${fontLink}${fontScript}
        <style>span { font-family: Inter, monospace; font-size: 24px; }</style></head><body>
        ${[400, 500, 600, 700].map(weight => `<span style="font-weight:${weight}">Restoring your pages… Ää Őő Ελληνικά Русский</span>`).join("<br>")}
        </body></html>` });
    });
    await page.addInitScript({ content: `
      window.firstTextFrame = new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(function check() {
          if (getComputedStyle(document.body).visibility === 'hidden') { requestAnimationFrame(check); return; }
          resolve({ ready: [400,500,600,700].every(w => document.fonts.check(w + ' 24px Inter', 'Restoring Ää Őő Ελληνικά Русский')),
            widths: Array.from(document.querySelectorAll('span'), el => el.getBoundingClientRect().width) });
        }), { once: true });
      });
    ` });
    for (let refresh = 0; refresh < 2; refresh++) {
      if (refresh) await page.reload(); else await page.goto("http://fonts.local/");
      const first = await page.evaluate(() => (window as any).firstTextFrame);
      assert.equal(first.ready, true, "all shell weights are loaded before text is painted");
      await page.evaluate(() => document.fonts.ready);
      assert.deepEqual(await page.locator("span").evaluateAll(elements => elements.map(el => el.getBoundingClientRect().width)), first.widths);
    }
    assert.deepEqual(external, [], "fonts require no external connections");
  } finally { await browser.close(); }
});

test("New page warms one real shader after restoration and shows it immediately on use", async () => {
  const browser = process.env.SCRIBE_TEST_CHROMIUM
    ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
    : await launchChromium({ headless: true, args: [], purpose: "New page warmup test" });
  try {
    const page = await browser.newPage();
    const shell = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const screen = shell.slice(shell.indexOf('<div id="newpage"'), shell.indexOf('<div id="frames"'));
    await page.route("http://warmup.test/", route => route.fulfill({ contentType: "text/html", body: `<html data-restoring><body><main style="width:900px;height:600px">${screen}</main></body></html>` }));
    await page.goto("http://warmup.test/");
    await page.addStyleTag({ content: fs.readFileSync(new URL("../public/app.css", import.meta.url), "utf8") });
    await page.addScriptTag({ content: "window.__name = value => value; localStorage.setItem('scribe.newPageBackgrounds', 'aurora,caustics');" });
    for (const name of ["motion.js", "glfx.js", "newpage.js"]) {
      await page.addScriptTag({ content: fs.readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8") });
    }
    await page.evaluate(() => {
      const w = window as any;
      const create = w.scribeGL.create;
      w.created = 0;
      w.scribeGL.create = (...args: any[]) => { w.created++; return create(...args); };
      w.newPage = w.createNewPage({ templates: () => [], builtins: () => [], threads: () => 0, working: () => false, openChat() {} });
    });
    assert.equal(await page.evaluate(() => (window as any).created), 0);
    await page.evaluate(() => { document.documentElement.removeAttribute("data-restoring"); dispatchEvent(new Event("scribe:restored")); });
    await page.waitForFunction(() => document.querySelector('body > canvas[data-ready="1"]'));
    const first = await page.evaluate(() => {
      const w = window as any;
      w.prepared = document.querySelector("body > canvas");
      w.newPage.render({ id: "first" });
      const root = document.querySelector("#newpage")!;
      const canvas = root.querySelector("canvas")!;
      return { reused: canvas === w.prepared, created: w.created, width: canvas.width, opacity: getComputedStyle(canvas).opacity, animation: getComputedStyle(canvas).animationName };
    });
    assert.equal(first.reused, true);
    assert.equal(first.created, 1);
    assert.ok(first.width > 64, "first visible draw resizes the prepared shader");
    assert.equal(first.opacity, "1");
    assert.equal(first.animation, "none");
    await page.waitForFunction(() => document.querySelector('body > canvas[data-ready="1"]'));
    assert.equal(await page.evaluate(() => {
      const w = window as any;
      const prepared = document.querySelector("body > canvas");
      w.newPage.render({ id: "second" });
      return document.querySelector("#newpage canvas") === prepared && w.created === 2 && document.querySelectorAll("canvas").length === 1;
    }), true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.evaluate(() => {
      const w = window as any;
      w.newPage.render(null);
      w.newPage.render({ id: "second" });
      return getComputedStyle(document.querySelector("#newpage canvas")!).opacity;
    }), "1");
  } finally { await browser.close(); }
});

test("effects wait for visible restored UI, cancel queued work, and keep fallback on failure", async () => {
  const browser = process.env.SCRIBE_TEST_CHROMIUM
    ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
    : await launchChromium({ headless: true, args: [], purpose: "Startup test" });
  try {
    const page = await browser.newPage();
    await page.setContent('<html data-restoring><body><div id="host" style="display:none"><canvas style="width:60px;height:60px"></canvas></div></body></html>');
    await page.addScriptTag({ content: "window.__name = value => value;" });
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/glfx.js", import.meta.url), "utf8") });
    await page.evaluate(() => {
      const w = window as any;
      w.created = 0; w.drawn = 0; w.ready = 0;
      w.scribeGL.create = () => { w.created++; return { set() {}, draw() { w.drawn++; return true; }, destroy() {} }; };
      w.effect = w.scribeGL.lazy(document.querySelector("canvas"), "", { onReady: () => w.ready++ });
      w.effect.draw({ u_time: 1 });
    });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => (window as any).created), 0);
    await page.evaluate(() => { document.querySelector<HTMLElement>("#host")!.style.display = "block"; (window as any).effect.draw({ u_time: 2 }); });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => (window as any).created), 0, "restoring blocks visible graphics");
    await page.evaluate(() => { document.documentElement.removeAttribute("data-restoring"); dispatchEvent(new Event("scribe:restored")); });
    await page.waitForFunction(() => (window as any).ready === 1);
    assert.equal(await page.evaluate(() => (window as any).created), 1);
    assert.ok(await page.evaluate(() => (window as any).drawn) > 0);
    await page.evaluate(() => {
      const w = window as any;
      w.effect.destroy();
      const cancelled = w.scribeGL.lazy(document.querySelector("canvas"), "");
      cancelled.draw({}); cancelled.destroy();
    });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => (window as any).created), 1);
    await page.evaluate(() => {
      const w = window as any;
      w.scribeGL.create = () => null;
      w.failed = false;
      w.scribeGL.lazy(document.querySelector("canvas"), "", { onError: () => w.failed = true }).draw({});
    });
    await page.waitForFunction(() => (window as any).failed);
    // A pane can close while the driver is still compiling.
    await page.evaluate(() => {
      const w = window as any;
      w.destroyed = 0;
      w.scribeGL.create = () => new Promise(resolve => w.finish = resolve);
      w.pending = w.scribeGL.lazy(document.querySelector("canvas"), "", { onReady: () => w.ready++ });
      w.pending.draw({});
    });
    await page.waitForFunction(() => (window as any).finish);
    await page.evaluate(() => {
      const w = window as any;
      w.pending.destroy();
      w.finish({ destroy() { w.destroyed++; } });
    });
    await page.waitForFunction(() => (window as any).destroyed === 1);
    assert.equal(await page.evaluate(() => (window as any).ready), 1, "cancelled compiler cannot replace the fallback");
  } finally { await browser.close(); }
});

test("refresh restores the shell, and child windows keep their page across space switches", async () => {
  const browser = process.env.SCRIBE_TEST_CHROMIUM
    ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
    : await launchChromium({ headless: true, args: [], purpose: "Restore test" });
  try {
    const page = await browser.newPage();
    await page.context().addInitScript({ content: "window.__name = value => value;" });
    const root = new URL("../public/", import.meta.url);
    await page.context().route(/^http:\/\/(?:[^/]+\.)?restore\.local\//, route => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (name.startsWith("api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
      if (name.startsWith("view/")) return route.fulfill({ contentType: "text/html", body: "<p>Saved page</p>" });
      if (name.startsWith("vendor/")) return route.fulfill({ body: "" });
      if (!name) {
        // The shell is tested independently of the agent UI's network configuration.
        const html = fs.readFileSync(new URL("index.html", root), "utf8").replace(/<script src="\.\/agent(?:-render)?\.js[^>]*><\/script>/g, "");
        return route.fulfill({ contentType: "text/html", body: html });
      }
      const type = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "image/svg+xml";
      return route.fulfill({ contentType: type, body: fs.readFileSync(new URL(name, root)) });
    });
    await page.route("https://fonts.googleapis.com/**", route => route.abort());
    await page.context().addInitScript(() => {
      const w = window as any;
      w.sockets = [];
      w.WebSocket = class extends EventTarget {
        static OPEN = 1; static CLOSING = 2;
        readyState = 0;
        constructor() { super(); w.sockets.push(this); }
        send() {}
        close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
      };
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://restore.local/");
    assert.equal(await page.locator("#refresh-overlay").isVisible(), true);
    assert.equal(await page.locator("#startup").isVisible(), true);
    assert.equal(await page.locator("#empty").isVisible(), false);
    // Initial connection timeout must expose a useful retry control.
    await page.getByRole("button", { name: "Retry connection" }).waitFor({ state: "visible", timeout: 8000 });
    assert.equal(await page.locator("#refresh-overlay").isVisible(), false, "connection failure exposes retry");
    await page.getByRole("button", { name: "Retry connection" }).click();
    await page.evaluate(() => {
      const w = window as any;
      const socket = w.sockets.at(-1);
      socket.readyState = 1; socket.dispatchEvent(new Event("open"));
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "snapshot", version: "3.0.2", tabs: [], closed: [], folders: [], templates: [], activeId: null }) }));
    });
    assert.equal(await page.locator("#startup").isVisible(), false);
    assert.equal(await page.locator("#empty").isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-restoring")), false);

    // A successful refresh gets the short overlay even with a fast snapshot.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    assert.equal(await page.locator("#refresh-overlay").isVisible(), true);
    assert.equal(await page.locator(".refresh-overlay-line").evaluate(el => getComputedStyle(el).animationName), "none");
    await page.evaluate(() => {
      const socket = (window as any).sockets.at(-1);
      socket.readyState = 1; socket.dispatchEvent(new Event("open"));
      const tab = { id: "saved", title: "Saved page", revision: 1 };
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
        type: "snapshot", tabs: [tab], activeId: "saved",
        spaces: { activeId: "work", spaces: [{ id: "work", name: "Work", activeId: "saved", tabs: [{ id: "saved" }] }] },
      }) }));
    });
    assert.equal(await page.locator("#refresh-overlay").isVisible(), true, "snapshot renders underneath the brief overlay");
    await page.locator("#refresh-overlay").waitFor({ state: "hidden", timeout: 2000 });
    assert.equal(await page.locator("#empty").isVisible(), false);
    assert.equal(await page.getByRole("tab", { name: "Saved page" }).isVisible(), true);
    assert.equal(await page.locator(".space-chip").innerText(), "Work");

    // A real popup keeps its page and live frame when the main strip changes spaces.
    const popupOpened = page.waitForEvent("popup");
    await page.evaluate(() => (window as any).scribePopout.open({ id: "saved", title: "Saved page" }));
    const child = await popupOpened;
    child.on("pageerror", error => errors.push(error.message));
    const saved = { id: "saved", title: "Saved page", revision: 1 };
    const snapshot = (away: boolean) => ({
      type: "snapshot", reset: true, tabs: away ? [] : [saved],
      closed: away ? [{ ...saved, closedAt: 1 }] : [], activeId: away ? null : "saved",
      spaces: { activeId: away ? "other" : "work", spaces: [
        { id: "work", name: "Work", tabs: [{ id: "saved" }], activeId: "saved" },
        { id: "other", name: "Other", tabs: [], activeId: null },
      ] },
    });
    const send = async (target: typeof page, message: unknown) => {
      await target.waitForFunction(() => (window as any).sockets?.length);
      await target.evaluate(message => new Promise<void>(resolve => {
        addEventListener("scribe:render", () => resolve(), { once: true });
        const socket = (window as any).sockets.at(-1);
        socket.readyState = 1;
        socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
      }), message);
    };
    await send(child, snapshot(false));
    await child.locator("#frames iframe[data-role=primary]").waitFor();
    await child.frameLocator("#frames iframe").locator("p").waitFor();
    const frame = await (await child.locator("#frames iframe").elementHandle())!.contentFrame();
    await frame!.evaluate(() => { (window as any).unsavedValue = "keep me"; });
    await child.evaluate(() => { (window as any).savedFrame = document.querySelector("#frames iframe"); });
    for (const away of [true, false, true]) {
      await send(page, snapshot(away));
      await send(child, snapshot(away));
      assert.equal(child.isClosed(), false);
      assert.equal(await child.locator("#empty").isVisible(), false);
      assert.equal(await child.title(), "Saved page");
      assert.equal(await child.evaluate(() => (window as any).savedFrame === document.querySelector("#frames iframe[data-role=primary]")), true);
      assert.equal(await frame!.evaluate(() => (window as any).unsavedValue), "keep me");
    }
    // Updates to a page parked in another space must keep the displayed frame too.
    await send(child, { type: "tab_upserted", tab: { ...saved, closedAt: 1, stateRevision: 2 }, structural: false });
    await child.waitForFunction(() => document.querySelector("iframe[data-role=primary]"));
    assert.equal(await child.evaluate(() => (window as any).savedFrame === document.querySelector("#frames iframe")), true);
    await child.reload();
    await send(child, snapshot(true));
    await child.locator("#frames iframe[data-role=primary]").waitFor();
    assert.equal(await child.title(), "Saved page", "reload finds the page in its saved space");
    await send(page, snapshot(false));
    await send(child, snapshot(false));
    const childClosed = child.waitForEvent("close");
    await send(page, { type: "tab_upserted", tab: { ...saved, closedAt: 2 }, structural: true });
    await childClosed;

    await send(page, snapshot(false));
    await page.evaluate(() => (window as any).sockets.at(-1).close());
    assert.equal(await page.locator("#refresh-overlay").isVisible(), false, "reconnect does not replay the overlay");
    assert.equal(await page.getByRole("tab", { name: "Saved page" }).isVisible(), true, "reconnect keeps saved tabs visible");

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByRole("switch", { name: "Overlay on refresh", exact: true }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem("scribe.refreshOverlay")), "0");
    await page.reload();
    assert.equal(await page.locator("#refresh-overlay").isVisible(), false, "off persists before first paint");
    assert.equal(await page.locator("#startup").isVisible(), true, "off retains the restoration status");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
