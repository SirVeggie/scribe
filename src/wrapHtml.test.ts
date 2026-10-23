import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { inlineKit, KIT_CSS_TAG, KIT_JS_TAG, PAGE_THEME, wrapHtml } from "./wrapHtml.js";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";
import { skillDocs } from "./skillDocs.js";

test("wrapHtml links the page kit after the inline default CSS", () => {
  const wrapped = wrapHtml("Theme", "<p>Hi</p>");
  const styleAt = wrapped.indexOf("<style>");
  const kitCssAt = wrapped.indexOf(KIT_CSS_TAG);
  const kitJsAt = wrapped.indexOf(KIT_JS_TAG);
  assert.ok(styleAt > 0);
  assert.ok(kitCssAt > styleAt);
  assert.ok(kitJsAt > kitCssAt);
  assert.match(wrapped, /color-scheme:\s*dark/);
  assert.equal(wrapped.indexOf(KIT_CSS_TAG, kitCssAt + 1), -1);
});

test("wrapHtml leaves full documents untouched", () => {
  const doc = "<!DOCTYPE html><html><head><title>X</title></head><body>hi</body></html>";
  assert.equal(wrapHtml("Ignored", doc), doc);
  assert.equal(wrapHtml("Ignored", doc).includes("kit.css"), false);
});

test("inlineKit replaces the exact kit tags with file contents", () => {
  const wrapped = wrapHtml("T", "<p>Hi</p>");
  const inlined = inlineKit(wrapped, (file) => (file === "kit.css" ? "/* CSS */" : "/* JS */"));
  assert.match(inlined, /<style>\/\* CSS \*\/<\/style>/);
  assert.match(inlined, /<script>\/\* JS \*\/<\/script>/);
  assert.equal(inlined.includes("kit.css"), false);
  assert.equal(inlined.includes("kit.js"), false);
  assert.match(inlined, /color-scheme:\s*dark/);
  assert.equal(inlineKit("<p>no kit</p>", () => "x"), "<p>no kit</p>");
});

test("inlineKit also inlines a full document's own kit tags", () => {
  const doc = '<!DOCTYPE html><html><head><link href="/kit.css" rel="stylesheet"><script src="/kit.js" defer></script></head><body></body></html>';
  const inlined = inlineKit(doc, (file) => (file === "kit.css" ? "/* CSS */" : "/* JS */"));
  assert.match(inlined, /<style>\/\* CSS \*\/<\/style>/);
  assert.match(inlined, /<script>\/\* JS \*\/<\/script>/);
  assert.equal(inlined.includes("kit.css"), false);
});

test("kit.css carries the fragment theme for full documents", () => {
  const css = fs.readFileSync(fileURLToPath(new URL("../public/kit.css", import.meta.url)), "utf8");
  const block = css.slice(css.indexOf(":where(:root)"), css.indexOf("}", css.indexOf(":where(:root)")));
  for (const [name, value] of Object.entries(PAGE_THEME)) assert.ok(block.includes(`${name}: ${value};`), name);
});

test("kit reply buttons use the host bridge, lock once, signal without a target, and allow retry", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Kit reply buttons test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    const kit = fs.readFileSync(new URL("../public/kit.js", import.meta.url), "utf8");
    async function setup(mode: string, markup: string) {
      await page.setContent(markup);
      await page.evaluate((mode) => {
        const w = window as any;
        w.calls = []; w.signals = [];
        w.scribe = {
          local: {}, setLocal() {},
          reply(data: unknown, options: unknown) {
            w.calls.push({ data, options });
            if (mode === "throw") throw new Error("offline");
            if (mode === "reject") return Promise.reject(new Error("offline"));
            if (mode === "pending") return new Promise((resolve) => { w.complete = resolve; });
            return Promise.resolve(mode === "signal" ? { error: "This page has no reply target" } : { ok: true });
          },
          signal(name: string, data: unknown) { w.signals.push({ name, data }); },
        };
      }, mode);
      await page.addScriptTag({ content: kit });
    }
    await setup("pending", `<form data-reply><button id="a" data-reply="Use B" data-context='{"option":"B"}'><span>Choose B</span></button></form><button id="b" data-reply>Other</button>`);
    await page.locator("#a span").click();
    await page.evaluate(() => { document.querySelector<HTMLButtonElement>("#b")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    assert.deepEqual(await page.evaluate(() => (window as any).calls), [{ data: { option: "B" }, options: { summary: "Use B" } }]);
    assert.equal(await page.locator("button:disabled").count(), 2);
    assert.equal(await page.locator("#a").getAttribute("aria-pressed"), "true");
    await page.evaluate(() => (window as any).complete({ ok: true }));
    await page.getByRole("status").filter({ hasText: /^Sent$/ }).waitFor();
    assert.equal(await page.locator("button:disabled").count(), 2);

    await setup("signal", '<button data-reply>Use text</button>');
    await page.locator("button").click();
    await page.getByRole("status").filter({ hasText: /^Sent$/ }).waitFor();
    assert.deepEqual(await page.evaluate(() => (window as any).signals), [{ name: "submitted", data: { answers: {}, summary: "Use text" } }]);

    for (const mode of ["throw", "reject"]) {
      await setup(mode, '<button id="a" data-reply="A">A</button><button data-reply disabled>B</button>');
      await page.locator("#a").click();
      await page.getByRole("status").filter({ hasText: "Not sent: offline" }).waitFor();
      assert.equal(await page.locator("#a").isEnabled(), true);
      assert.equal(await page.locator("button:disabled").count(), 1);
      assert.equal(await page.locator("#a").getAttribute("aria-pressed"), null);
    }
    for (const context of ["bad", "null", "[]", "42"]) {
      await setup("ok", `<button data-reply data-context='${context}'>A</button>`);
      await page.locator("button").click();
      assert.deepEqual(await page.evaluate(() => (window as any).calls), []);
      assert.equal(await page.locator("button").isEnabled(), true);
      assert.match(await page.getByRole("status").innerText(), /Not sent:/);
    }
  } finally { await browser.close(); }
});

test("scribe_docs serves the kit's declarative reply button contract", () => {
  const docs = skillDocs("Page kit");
  assert.equal(docs.error, undefined);
  for (const term of ["button data-reply", "data-context", "submitted", "component", "disabled"]) assert.ok(docs.text.includes(term), term);
});
