import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readHtmlPath, resolveShowHtml, templateUpsertBody } from "./mcp.js";

function withTempHtml(name: string, body: string, fn: (file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-htmlpath-"));
  const file = path.join(dir, name);
  try {
    fs.writeFileSync(file, body, "utf8");
    fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("readHtmlPath strips a BOM and returns the file", () => {
  withTempHtml("page.html", "\uFEFF<h1>Hi</h1>", (file) => {
    assert.deepEqual(readHtmlPath(file), { html: "<h1>Hi</h1>" });
  });
});

test("readHtmlPath reports a missing file", () => {
  const missing = path.join(os.tmpdir(), "scribe-htmlpath-missing", "nope.html");
  const result = readHtmlPath(missing);
  assert.ok("error" in result);
  assert.match(result.error, /^Could not read htmlPath:/);
});

test("resolveShowHtml takes html or htmlPath, not both or neither", () => {
  assert.deepEqual(resolveShowHtml("<p>a</p>", undefined), { html: "<p>a</p>" });
  assert.deepEqual(resolveShowHtml("", undefined), { html: "" });
  assert.deepEqual(resolveShowHtml(undefined, undefined), { error: "Provide html or htmlPath" });
  withTempHtml("page.html", "<p>from file</p>", (file) => {
    assert.deepEqual(resolveShowHtml(undefined, file), { html: "<p>from file</p>" });
    assert.deepEqual(resolveShowHtml("<p>a</p>", file), { error: "Pass either html or htmlPath, not both" });
  });
});

test("templateUpsertBody keeps saved values the update leaves out", () => {
  const saved = { title: "Board", description: "d", html: "<p>old</p>\n<i>x</i>", fields: [{ key: "a" }], titleTemplate: "{{a}}" };
  assert.deepEqual(templateUpsertBody({ edits: [{ oldString: "old", newString: "new" }] }, saved), {
    ...saved,
    html: "<p>new</p>\n<i>x</i>",
    initialState: undefined,
  });
  assert.deepEqual(templateUpsertBody({ title: "B2", fields: [] }, saved), { ...saved, title: "B2", fields: [], initialState: undefined });
  withTempHtml("tpl.html", "<p>file</p>", (file) => {
    assert.equal((templateUpsertBody({ htmlPath: file }, saved) as { html: string }).html, "<p>file</p>");
    assert.deepEqual(templateUpsertBody({ html: "<p>a</p>", htmlPath: file }, saved), { error: "Pass only one of html, htmlPath and edits" });
  });
  assert.match((templateUpsertBody({ edits: [{ oldString: "nope", newString: "" }] }, saved) as { error: string }).error, /not found/);
});

test("templateUpsertBody needs html and title for a new template", () => {
  assert.deepEqual(templateUpsertBody({ title: "T" }, undefined), { error: "Provide html or htmlPath for a new template" });
  assert.deepEqual(templateUpsertBody({ html: "<p/>" }, undefined), { error: "Provide title for a new template" });
  assert.deepEqual(templateUpsertBody({ edits: [{ append: true, newString: "x" }] }, undefined), { error: "edits change an existing template: pass its key or id" });
});
