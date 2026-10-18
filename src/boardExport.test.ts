import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPORT_FORMAT,
  buildExport,
  exportAllFilename,
  exportFilename,
  parseImport,
  serializeExport,
  titleFromFilename,
  titleFromHtml,
} from "./boardExport.js";
import type { Tab } from "./types.js";

function fakeTab(partial: Partial<Tab> & Pick<Tab, "key" | "title" | "html">): Tab {
  return {
    id: "t_aaaa",
    pinned: false,
    createdAt: 10,
    updatedAt: 20,
    stripSeq: 1,
    revision: 1,
    state: {},
    stateRevision: 0,
    stateUpdatedAt: 0,
    eventSeq: 0,
    events: [],
    libPos: 0,
    assets: [],
    ...partial,
  };
}

test("parseImport reads a saved HTML document", () => {
  const html = "<!DOCTYPE html><html><head><title>Notes</title></head><body><p>hi</p></body></html>";
  const parsed = parseImport(html, "ignored.json");
  assert.equal(parsed.kind, "html");
  assert.equal(parsed.pages.length, 1);
  assert.equal(parsed.pages[0].title, "Notes");
  assert.equal(parsed.pages[0].html, html);
  assert.equal(parsed.pages[0].state, undefined);
});

test("parseImport uses the filename when HTML has no title", () => {
  const parsed = parseImport("<p>bare</p>", "My-Page.html");
  assert.equal(parsed.kind, "html");
  assert.equal(parsed.pages[0].title, "My Page");
});

test("parseImport reads a single-page export including state and assets", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  const file = buildExport([
    {
      tab: fakeTab({
        key: "todos",
        title: "Todos",
        html: "<!DOCTYPE html><html><body>list</body></html>",
        pinned: true,
        closedAt: 99,
        libPos: 3,
        state: { items: [1] },
      }),
      assets: [{ name: "dot.png", mimeType: "image/png", buffer: png }],
      folderPath: "Work/Lists",
    },
  ]);
  const parsed = parseImport(serializeExport(file), "todos.scribe.json");
  assert.equal(parsed.kind, "export");
  assert.equal(parsed.pages.length, 1);
  const page = parsed.pages[0];
  assert.equal(page.key, "todos");
  assert.equal(page.title, "Todos");
  assert.equal(page.pinned, true);
  assert.equal(page.closedAt, 99);
  assert.equal(page.folderPath, "Work/Lists");
  assert.equal(page.libPos, 3);
  assert.deepEqual(page.state, { items: [1] });
  assert.equal(page.assets?.length, 1);
  assert.equal(page.assets?.[0].name, "dot.png");
  assert.equal(page.assets?.[0].buffer.equals(png), true);
});

test("parseImport reads a multi-page export", () => {
  const file = buildExport([
    { tab: fakeTab({ key: "a", title: "A", html: "<!DOCTYPE html><html><body>a</body></html>" }), assets: [] },
    { tab: fakeTab({ key: "b", title: "B", html: "<!DOCTYPE html><html><body>b</body></html>" }), assets: [] },
  ]);
  const parsed = parseImport(serializeExport(file));
  assert.equal(parsed.kind, "export");
  assert.deepEqual(
    parsed.pages.map((page) => page.title),
    ["A", "B"]
  );
});

test("parseImport rejects random JSON", () => {
  assert.throws(() => parseImport('{"hello":true}'), /not an Scribe export/);
});

test("parseImport rejects an unsupported version", () => {
  assert.throws(
    () => parseImport(JSON.stringify({ format: EXPORT_FORMAT, version: 2, pages: [] })),
    /unsupported export version/
  );
});

test("parseImport rejects a page bound to a template missing from the file", () => {
  const file = {
    format: EXPORT_FORMAT,
    version: 1,
    templates: [],
    pages: [{ title: "A", html: "<p>a</p>", template: { templateId: "tpl_gone", values: {} } }],
  };
  assert.throws(() => parseImport(JSON.stringify(file)), /tpl_gone.*not in the file/);
});

test("parseImport validates exported templates", () => {
  const file = {
    format: EXPORT_FORMAT,
    version: 1,
    templates: [{ id: "tpl_1", title: "T", html: "<p>{{nope}}</p>", fields: [] }],
    pages: [],
  };
  assert.throws(() => parseImport(JSON.stringify(file)), /templates\[0\]: html uses unknown field/);
});

test("parseImport rejects empty or unknown files", () => {
  assert.throws(() => parseImport("   "), /empty/);
  assert.throws(() => parseImport("just text"), /not a recognized/);
});

test("title helpers", () => {
  assert.equal(titleFromHtml("<title>  Hello &amp; Co </title>", "x"), "Hello & Co");
  assert.equal(titleFromFilename("Notes.scribe.json"), "Notes");
  assert.equal(exportFilename("My Page"), "My-Page.scribe.json");
  assert.match(exportAllFilename(Date.UTC(2026, 8, 23)), /^scribe-\d{4}-\d{2}-\d{2}\.json$/);
});
