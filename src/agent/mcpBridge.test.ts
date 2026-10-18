import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { McpBridge } from "./mcpBridge.js";
import { resolveServer } from "./mcpConfig.js";
import { McpPermissions } from "./mcpPermissions.js";

const sdkServer = fileURLToPath(new URL("../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js", import.meta.url));
const sdkStdio = fileURLToPath(new URL("../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", import.meta.url));

/** A one-tool stdio MCP server that echoes its input and the env var it was given. */
function echoServer(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-mcp-bridge-"));
  const file = path.join(dir, "echo.mjs");
  fs.writeFileSync(
    file,
    `import { McpServer } from ${JSON.stringify(new URL(`file:///${sdkServer.replaceAll("\\", "/")}`).href)};
import { StdioServerTransport } from ${JSON.stringify(new URL(`file:///${sdkStdio.replaceAll("\\", "/")}`).href)};
const server = new McpServer({ name: "echo", version: "1" });
server.registerTool("echo", { description: "Echo", inputSchema: {} }, async (args) => ({ content: [{ type: "text", text: "echo " + (process.env.ECHO_TAG || "") }] }));
await server.connect(new StdioServerTransport());
`
  );
  return file;
}

test("bridged tools call the server, and ask first unless allowed", async () => {
  const file = echoServer();
  const server = resolveServer("echo-srv", "global", { command: process.execPath, args: [file], env: { ECHO_TAG: "tagged" } })!;
  const asked: string[] = [];
  let answer = "reject";
  let approval: "edits" | "full" = "edits";
  const bridge = new McpBridge(
    [server],
    os.tmpdir(),
    () => ({ approval, id: "test-thread" }),
    () => async (req) => {
      asked.push(req.title);
      return { optionId: answer };
    },
    undefined,
    new McpPermissions(path.join(path.dirname(file), "permissions.json"))
  );
  try {
    const tools = await bridge.tools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["echo-srv__echo"]
    );
    const denied = await tools[0].call({}, {});
    assert.equal(denied.isError, true);
    assert.deepEqual(asked, ["echo-srv: echo"]);
    answer = "allow";
    const ok = await tools[0].call({}, {});
    assert.equal(ok.isError, false);
    assert.deepEqual(ok.content, [{ type: "text", text: "echo tagged" }]);
    approval = "full";
    await tools[0].call({}, {});
    assert.equal(asked.length, 2);
    approval = "edits";
    answer = "mcp";
    await tools[0].call({}, {});
    await tools[0].call({}, {});
    assert.equal(asked.length, 3);
  } finally {
    bridge.close();
  }
});

test("a server that does not start is skipped and reported", async () => {
  const errors: string[] = [];
  const bridge = new McpBridge(
    [resolveServer("broken", "global", { command: process.execPath, args: ["-e", "process.exit(1)"] })!],
    os.tmpdir(),
    () => ({ approval: "edits" }),
    () => undefined,
    (name) => errors.push(name)
  );
  assert.deepEqual(await bridge.tools(), []);
  assert.deepEqual(errors, ["broken"]);
  bridge.close();
});
