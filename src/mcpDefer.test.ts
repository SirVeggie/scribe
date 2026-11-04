import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFERRED_TOOLS, deferTools } from "./mcp.js";

function serverWith(env: Record<string, string>) {
  const server = new McpServer({ name: "t", version: "1" });
  deferTools(server, env, new Set(["rare_tool"]));
  const add = (name: string) =>
    server.tool(name, "A tool.", { x: z.string().optional() }, async () => ({ content: [] })) as unknown as { _meta?: Record<string, unknown> };
  return { rare: add("rare_tool"), core: add("page_show") };
}

test("a Claude chat marks only the rare tools for tool search", () => {
  const { rare, core } = serverWith({ SCRIBE_THREAD: "t1", SCRIBE_PROVIDER: "claude" });
  assert.deepEqual(rare._meta, { "anthropic/alwaysLoad": false });
  assert.equal(core._meta, undefined);
});

test("other providers and clients outside Scribe get every tool unmarked", () => {
  for (const env of [{ SCRIBE_THREAD: "t1", SCRIBE_PROVIDER: "codex" }, { SCRIBE_PROVIDER: "claude" }, {}]) {
    const { rare } = serverWith(env as Record<string, string>);
    assert.equal(rare._meta, undefined, JSON.stringify(env));
  }
});

test("every deferred tool is a tool the server registers, and the everyday page tools stay loaded", () => {
  const source = fs.readFileSync(new URL("./mcp.ts", import.meta.url), "utf8");
  for (const name of DEFERRED_TOOLS) {
    const uses = source.split(`"${name}"`).length - 1;
    assert.ok(uses >= 2, `${name} is in DEFERRED_TOOLS but no tool of that name is registered`);
  }
  for (const name of ["page_list", "library_search", "page_read", "page_show", "page_patch", "page_state", "page_update", "page_action", "page_ask", "ask_user", "skill_read", "page_intent", "thread_update", "memory_save"]) {
    assert.ok(!DEFERRED_TOOLS.has(name), `${name} is used in most chats; keep it loaded`);
  }
});
