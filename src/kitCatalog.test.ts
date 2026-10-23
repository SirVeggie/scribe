import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readKitCatalog, renderKitDocs, updateKitDocs } from "./kitCatalog.js";
import { SKILL_DIR, skillDocs } from "./skillDocs.js";

const catalog = readKitCatalog();
const css = fs.readFileSync(new URL("../public/kit.css", import.meta.url), "utf8");
const js = fs.readFileSync(new URL("../public/kit.js", import.meta.url), "utf8");
// Only selector preludes, never declarations, comments or embedded SVG/data URLs.
// The kit is flat CSS; this also finds rules inside @media / @supports blocks.
const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)]
  .map((match) => match[1]).join("\n");
const cssClasses = new Set([...selectors.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]));
const cssAttributes = new Set([...selectors.matchAll(/\[(data-[\w-]+)/g)].map((match) => match[1]));
const jsClasses = new Set([
  ...[...js.matchAll(/className\s*=\s*["']([^"']+)["']/g)].flatMap((match) => match[1].split(/\s+/)),
  ...[...js.matchAll(/classList\.(?:add|remove|toggle)\(\s*["']([^"']+)["']/g)].map((match) => match[1]),
]);
const jsAttributes = new Set([...js.matchAll(/data-[\w-]+/g)].map((match) => match[0]));

test("every public kit catalog entry has an implementation and a one-line example", () => {
  assert.ok(catalog.entries.length > 0);
  assert.equal(new Set(catalog.entries.map((entry) => entry.id)).size, catalog.entries.length, "unique entry ids");
  for (const entry of catalog.entries) {
    for (const field of ["id", "write", "gives", "example"] as const) {
      assert.ok(entry[field]?.trim(), entry.id + ": missing " + field);
      assert.doesNotMatch(entry[field], /[\r\n]/, entry.id + ": " + field + " must fit one line");
    }
    assert.ok((entry.classes?.length ?? 0) + (entry.attributes?.length ?? 0) + (entry.properties?.length ?? 0) + (entry.hooks?.length ?? 0), entry.id + ": needs an implementation reference");
    for (const name of entry.classes ?? []) assert.ok(cssClasses.has(name) || jsClasses.has(name), entry.id + ": missing class ." + name);
    for (const name of entry.attributes ?? []) assert.ok(cssAttributes.has(name) || jsAttributes.has(name), entry.id + ": missing attribute " + name);
    for (const name of entry.properties ?? []) assert.ok(css.includes("var(" + name), entry.id + ": missing property " + name);
    for (const hook of entry.hooks ?? []) {
      const source = fs.readFileSync(new URL("../public/" + hook.file, import.meta.url), "utf8");
      assert.ok(hook.text.length > 0 && source.includes(hook.text), entry.id + ": missing hook " + hook.text + " in " + hook.file);
    }
  }
});

test("every kit class, data attribute and page-set property is public or explicitly internal", () => {
  const publicClasses = new Set(catalog.entries.flatMap((entry) => entry.classes ?? []));
  const internal = new Set(catalog.internal.map((entry) => entry.class));
  assert.equal(internal.size, catalog.internal.length, "unique internal classes");
  for (const entry of catalog.internal) {
    assert.ok(entry.why.trim(), entry.class + ": explain why internal");
    assert.ok(!publicClasses.has(entry.class), entry.class + ": cannot be both public and internal");
    assert.ok(cssClasses.has(entry.class) || jsClasses.has(entry.class), entry.class + ": stale internal entry");
  }
  for (const name of new Set([...cssClasses, ...jsClasses])) {
    assert.ok(publicClasses.has(name) || internal.has(name), "." + name + ": add to kit.catalog.json or mark internal");
  }
  const attributes = new Set(catalog.entries.flatMap((entry) => entry.attributes ?? []));
  for (const name of new Set([...cssAttributes, ...jsAttributes])) assert.ok(attributes.has(name), name + ": add to kit.catalog.json");
  // Element defaults and descendant tags are ordinary HTML, not kit opt-in selectors.
  // --kit-* are implementation theme tokens; wrapper theme variables have their own docs test.
  const theme = new Set(["--bg", "--text", "--muted", "--border", "--accent", "--code-bg"]);
  const properties = new Set(catalog.entries.flatMap((entry) => entry.properties ?? []));
  for (const match of css.matchAll(/var\((--[\w-]+)/g)) {
    const name = match[1];
    if (!name.startsWith("--kit-") && !theme.has(name)) assert.ok(properties.has(name), name + ": add to kit.catalog.json");
  }
});

test("the skill and scribe_docs serve the same generated kit catalog", () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  assert.equal(skill.replace(/\r\n/g, "\n"), updateKitDocs(skill, catalog), "Run npm run gen:kit-docs");
  const generated = renderKitDocs(catalog);
  const docs = skillDocs("Page kit");
  assert.equal(docs.error, undefined);
  assert.ok(docs.text.includes(generated));
  assert.ok(skillDocs("all").text.includes(generated));
  for (const entry of catalog.internal) assert.ok(!generated.includes(entry.class), entry.class + " is internal");
});

test("kit doc generation escapes table cells and rejects missing or duplicate markers", () => {
  const sample = { entries: [{ id: "sample", write: "a|b", gives: "one\ntwo | three", example: "a `tick`" }], internal: [] };
  assert.match(renderKitDocs(sample), /a\\\|b/);
  assert.match(renderKitDocs(sample), /one two \\\| three/);
  assert.ok(renderKitDocs(sample).includes("`` a `tick` ``"));
  assert.throws(() => updateKitDocs("No markers", sample), /markers/);
  assert.throws(() => updateKitDocs("<!-- kit-catalog:start --><!-- kit-catalog:start --><!-- kit-catalog:end -->", sample), /markers/);
});
