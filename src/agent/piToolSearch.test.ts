import assert from "node:assert/strict";
import { test } from "node:test";
import { boardToolDefinitions, describeTools, effectiveTool } from "./providers/pi.js";

const schema = (props: Record<string, unknown> = {}) => ({ type: "object", properties: props });
const TOOLS = [
  { name: "page_show", description: "Show a page.", inputSchema: schema({ title: { type: "string" } }) },
  { name: "settings_find", description: "Search Scribe's own settings. Then show them.", inputSchema: { ...schema({ query: { type: "string" } }), required: ["query"] } },
  { name: "browser_act", description: "Act on the page in your browser: click or type.", inputSchema: schema({ action: { type: "string" } }) },
];

function definitions(defer: boolean) {
  const calls: Array<{ name: string; params: unknown }> = [];
  const defs = boardToolDefinitions(TOOLS, async (name, params) => {
    calls.push({ name, params });
    return { content: [{ type: "text", text: `ran ${name}` }], details: undefined };
  }, defer);
  return { defs, calls, byName: (name: string) => defs.find((d) => d.name === name)! };
}

test("without deferral every board tool is sent as itself", () => {
  assert.deepEqual(definitions(false).defs.map((d) => d.name), ["page_show", "settings_find", "browser_act"]);
});

test("with deferral the rare tools are left out and tool_search names them", () => {
  const { defs, byName } = definitions(true);
  assert.deepEqual(defs.map((d) => d.name), ["page_show", "tool_search", "tool_call"]);
  assert.match(byName("tool_search").description, /settings_find, browser_act/);
  assert.deepEqual((byName("tool_call").parameters as { properties: { name: { enum: string[] } } }).properties.name.enum, ["settings_find", "browser_act"]);
});

test("tool_call runs the deferred tool with its args and refuses others", async () => {
  const { byName, calls } = definitions(true);
  const run = byName("tool_call").execute as unknown as (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
  const out = await run("1", { name: "settings_find", args: { query: "send" } });
  assert.equal(out.content[0].text, "ran settings_find");
  assert.deepEqual(calls, [{ name: "settings_find", params: { query: "send" } }]);
  await assert.rejects(run("2", { name: "page_show", args: {} }), /No tool "page_show" to call this way/);
  await assert.rejects(run("3", { name: "bash", args: {} }), /No tool "bash"/);
});

test("tool_search describes named tools, finds by words, and lists all without arguments", () => {
  const deferred = TOOLS.slice(1);
  const one = describeTools(deferred, { names: ["settings_find"] });
  assert.match(one, /^## settings_find\n\nSearch Scribe's own settings/);
  assert.match(one, /"required":\["query"\]/);
  assert.match(one, /tool_call\(\{ name: "settings_find"/);
  assert.match(describeTools(deferred, { query: "click in the browser" }), /^## browser_act/);
  assert.equal(describeTools(deferred, {}), "- settings_find: Search Scribe's own settings.\n- browser_act: Act on the page in your browser: click or type.");
  assert.match(describeTools(deferred, { query: "zzz" }), /^No tool matches/);
});

test("a tool_call is seen as the deferred tool it runs, never as one of Pi's own tools", () => {
  assert.deepEqual(effectiveTool("tool_call", { name: "settings_find", args: { query: "x" } }), { name: "settings_find", args: { query: "x" } });
  assert.deepEqual(effectiveTool("tool_call", { name: "bash", args: { command: "rm" } }), { name: "tool_call", args: { name: "bash", args: { command: "rm" } } });
  assert.deepEqual(effectiveTool("page_show", { title: "t" }), { name: "page_show", args: { title: "t" } });
});
