import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeTemplateValues,
  normalizeTemplateInput,
  parseAgentActions,
  parseTemplateFields,
  parseTemplateValues,
  renderAgentActionText,
  renderTemplateTitle,
  substituteTemplate,
} from "./templates.js";

const fields = parseTemplateFields([
  { key: "title", label: "Title", type: "text", required: true },
  { key: "item", label: "Item", type: "text", default: "task" },
  { key: "columns", label: "Columns", type: "number", default: 3, min: 1, max: 6 },
  { key: "done", label: "Show done", type: "checkbox" },
  {
    key: "theme",
    label: "Theme",
    type: "select",
    options: ["dark", { value: "light", label: "Light" }],
    default: "dark",
  },
]);

test("substitutes escaped placeholders", () => {
  const html = substituteTemplate("<h1>{{title}}</h1><p>{{missing}}</p>", { title: "A <b>x</b>" }, true);
  assert.equal(html, "<h1>A &lt;b&gt;x&lt;/b&gt;</h1><p></p>");
});

test("title uses titleTemplate, then title field, then template name", () => {
  assert.equal(renderTemplateTitle({ title: "Todo", titleTemplate: "{{title}} list", fields }, { title: "Shop" }), "Shop list");
  assert.equal(renderTemplateTitle({ title: "Todo", fields }, { title: "Shop" }), "Shop");
  assert.equal(renderTemplateTitle({ title: "Todo", fields: [] }, {}), "Todo");
});

test("parseTemplateValues fills defaults and coerces numbers", () => {
  const values = parseTemplateValues(fields, { title: "Shop", columns: "2" });
  assert.deepEqual(values, { title: "Shop", item: "task", columns: 2, done: false, theme: "dark" });
});

test("required and range checks", () => {
  assert.throws(() => parseTemplateValues(fields, {}), /Title is required/);
  assert.throws(() => parseTemplateValues(fields, { title: "A", columns: 9 }), /at most 6/);
});

test("maxLength overrides the default text limit", () => {
  const long = "x".repeat(600);
  assert.throws(() => parseTemplateValues(fields, { title: long }), /too long \(max 500\)/);
  const [url] = parseTemplateFields([{ key: "url", label: "URL", type: "text", maxLength: 8192 }]);
  assert.equal(parseTemplateValues([url], { url: long }).url, long);
  assert.throws(() => parseTemplateValues([url], { url: "x".repeat(8193) }), /too long \(max 8192\)/);
  assert.throws(() => parseTemplateFields([{ key: "n", label: "N", type: "number", maxLength: 5 }]), /only applies/);
  assert.throws(() => parseTemplateFields([{ key: "t", label: "T", type: "text", maxLength: 0 }]), /integer from 1/);
});

test("normalizeTemplateInput rejects unknown placeholders", () => {
  assert.throws(
    () =>
      normalizeTemplateInput({
        title: "Todo",
        html: "<h1>{{nope}}</h1>",
        fields: [{ key: "title", label: "Title", type: "text" }],
      }),
    /unknown field/
  );
});

test("mergeTemplateValues keeps current values when fields stay compatible", () => {
  const values = mergeTemplateValues(fields, { title: "Shop", columns: 4, extra: "x" } as never);
  assert.equal(values.title, "Shop");
  assert.equal(values.columns, 4);
  assert.equal("extra" in values, false);
});

test("parseAgentActions fills defaults and keeps declared settings", () => {
  const [plain, chat] = parseAgentActions([
    { id: "summarise", label: "Summarise", prompt: "Summarise {{page.title}}." },
    {
      id: "break-down",
      label: "Break this down",
      prompt: "Break down{{#selection}}: {{selection}}{{/selection}}",
      where: ["menu", "slash"],
      selection: "optional",
      run: "chat",
      thread: { mode: "ask", fast: true, title: "Break down {{page.title}}" },
    },
  ]);
  assert.deepEqual(plain, { id: "summarise", label: "Summarise", prompt: "Summarise {{page.title}}.", where: ["menu", "palette", "slash"] });
  assert.deepEqual(chat.where, ["menu", "slash"]);
  assert.equal(chat.selection, undefined);
  assert.equal(chat.run, "chat");
  assert.deepEqual(chat.thread, { mode: "ask", fast: true, title: "Break down {{page.title}}" });
});

test("parseAgentActions rejects bad ids, placeholders, sections and modes", () => {
  const base = { id: "go", label: "Go", prompt: "Go" };
  assert.throws(() => parseAgentActions([{ ...base, id: "Go now" }]), /id must be/);
  assert.throws(() => parseAgentActions([base, base]), /used twice/);
  assert.throws(() => parseAgentActions([{ ...base, prompt: "{{card}}" }]), /unknown placeholder "card"/);
  assert.throws(() => parseAgentActions([{ ...base, prompt: "{{#selection}}x" }]), /not closed/);
  assert.throws(() => parseAgentActions([{ ...base, prompt: "{{#selection}}x{{/input}}" }]), /does not close/);
  assert.throws(() => parseAgentActions([{ ...base, thread: { mode: "code" } }]), /board, ask or readonly/);
  assert.throws(() => parseAgentActions([{ ...base, thread: { cwd: "C:/" } }]), /not a thread setting/);
  assert.throws(() => parseAgentActions([{ ...base, where: ["toolbar"] }]), /where must list/);
});

test("parseAgentActions takes page-supplied context placeholders", () => {
  const [action] = parseAgentActions([
    { id: "triage-card", label: "Triage this card", prompt: "Triage {{card}} on {{page.title}}", context: ["card", "card"], thread: { title: "Triage {{card}}" } },
  ]);
  assert.deepEqual(action.context, ["card"]);
  assert.equal(action.thread?.title, "Triage {{card}}");
  assert.equal(renderAgentActionText(action.prompt, { card: "#12 Fix login", "page.title": "Board" }), "Triage #12 Fix login on Board");
  const base = { id: "go", label: "Go", prompt: "Go {{card}}" };
  assert.throws(() => parseAgentActions([{ ...base, context: ["item"] }]), /unknown placeholder "card"/);
  assert.throws(() => parseAgentActions([{ ...base, context: ["Card"] }]), /lowercase letters/);
  assert.throws(() => parseAgentActions([{ ...base, context: ["selection"] }]), /built-in placeholder/);
  assert.equal(parseAgentActions([{ id: "go", label: "Go", prompt: "Go" }])[0].context, undefined);
});

test("normalizeTemplateInput keeps agentActions unset when omitted", () => {
  assert.equal(normalizeTemplateInput({ title: "T", html: "<p>x</p>" }).agentActions, undefined);
  assert.deepEqual(normalizeTemplateInput({ title: "T", html: "<p>x</p>", agentActions: [] }).agentActions, []);
});

test("renderAgentActionText fills placeholders and drops empty sections", () => {
  const prompt = "Break down {{page.title}} ({{page.key}}){{#selection}}, starting with: {{selection}}{{/selection}}.{{#input}} Note: {{input}}{{/input}}";
  assert.equal(
    renderAgentActionText(prompt, { "page.title": "Todos", "page.key": "scribe:todos", selection: "Ship it", input: "" }),
    "Break down Todos (scribe:todos), starting with: Ship it."
  );
  assert.equal(
    renderAgentActionText(prompt, { "page.title": "Todos", "page.key": "scribe:todos", selection: "  ", input: "be brief" }),
    "Break down Todos (scribe:todos). Note: be brief"
  );
});
