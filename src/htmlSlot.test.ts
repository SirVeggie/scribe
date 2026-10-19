import assert from "node:assert/strict";
import { test } from "node:test";
import { HtmlSlotError, spliceHtmlSlot } from "./htmlSlot.js";
import { wrapHtml } from "./wrapHtml.js";

test("data-slot on a div replaces inner content and counts nested divs", () => {
  const base = `<div data-slot><script>const x = "<div></div>";</script><div><div>deep</div></div></div>`;
  assert.equal(spliceHtmlSlot(base, "<p>new</p>"), `<div data-slot><p>new</p></div>`);
});

test("attribute values containing > do not end the opening tag", () => {
  const base = `<div title="a > b" data-slot class="x">old</div>`;
  assert.equal(spliceHtmlSlot(base, "new"), `<div title="a > b" data-slot class="x">new</div>`);
});

test("falls back to the first main when there is no data-slot", () => {
  const base = `<!DOCTYPE html><html><body><header>h</header><main>old</main></body></html>`;
  assert.equal(
    spliceHtmlSlot(base, "<p>new</p>"),
    `<!DOCTYPE html><html><body><header>h</header><main><p>new</p></main></body></html>`
  );
});

test("falls back to body when there is no data-slot or main", () => {
  const base = `<!DOCTYPE html><html><body>old</body></html>`;
  assert.equal(spliceHtmlSlot(base, "<p>new</p>"), `<!DOCTYPE html><html><body><p>new</p></body></html>`);
});

test("fills a slot inside a stored fragment page that wrapHtml already wrapped", () => {
  const stored = wrapHtml("Starter", "<header>H</header>\n<div data-slot>old</div>");
  const result = spliceHtmlSlot(stored, "<p>new</p>");
  assert.match(result, /<header>H<\/header>\n<div data-slot><p>new<\/p><\/div>/);
  assert.match(result, /<link rel="stylesheet" href="\/kit\.css\?v=1">/);
  assert.equal(wrapHtml("Other title", result), result);
});

test("errors when nothing fits", () => {
  assert.throws(
    () => spliceHtmlSlot("<p>only a paragraph</p>", "<b>x</b>"),
    (err: unknown) => err instanceof HtmlSlotError && /no data-slot, <main>, or <body>/.test(err.message)
  );
});

test("an unquoted attribute value with slashes does not hide a later data-slot", () => {
  const base = `<main><a href=/a/b data-slot>old</a></main>`;
  assert.equal(spliceHtmlSlot(base, "new"), `<main><a href=/a/b data-slot>new</a></main>`);
});
