import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { inlineKit, KIT_CSS_TAG, KIT_JS_TAG, PAGE_THEME, wrapHtml } from "./wrapHtml.js";

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
