import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AGENT_CLIENT, CLIENT_HEADER, THREAD_HEADER, VERSION } from "./config.js";

test("page_show forwards base with html or htmlPath, and page writes forward optional render problems", async () => {
  const posts: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      res.end(JSON.stringify({ ok: true, version: VERSION, viewers: 1 }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/tabs") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const json = JSON.parse(body) as Record<string, unknown>;
        posts.push(json);
        if (json.base === "scribe:file-page") {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "scribe:file-page is a file page (Z:/x.md); page_show base needs an HTML page." }));
          return;
        }
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            created: true,
            closed: false,
            ...(json.title === "N" ? {problems: [{code: "uncaught_error", message: "broken page", line: 12}]} : {}),
            tab: { id: "t_1", key: "scribe:n", title: json.title, revision: 1, folder: null },
          })
        );
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/tabs/t_1/patch") {
      res.end(JSON.stringify({applied: 1, closed: false, problems: [{code: "asset_load", message: "missing.png"}],
        tab: {id: "t_1", key: "scribe:n", title: "N", revision: 2, htmlBytes: 10, folder: null}}));
      return;
    }
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("./index.ts", import.meta.url))],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      SCRIBE_PORT: String(port),
      SCRIBE_AGENT_PORT: "0",
      SCRIBE_THREAD: "page-base-test",
      SCRIBE_PROVIDER: "claude",
      SCRIBE_PAGES: "on",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "page-base-test", version: "1" });
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-page-base-"));
  const file = path.join(dir, "inner.html");
  fs.writeFileSync(file, "<p>from file</p>", "utf8");
  try {
    await client.connect(transport);
    const shown = await call("page_show", {
      key: "n",
      title: "N",
      html: "<p>inner</p>",
      base: "scribe:starter",
      background: true,
    });
    assert.equal(shown.isError ?? false, false);
    assert.equal(posts[0]?.html, "<p>inner</p>");
    assert.equal(posts[0]?.base, "scribe:starter");
    assert.equal(posts[0]?.title, "N");
    assert.equal(posts[0]?.checkProblems, true);
    assert.deepEqual(JSON.parse(shown.content[0].text).problems, [{code: "uncaught_error", message: "broken page", line: 12}]);

    const patched = await call("page_patch", {id: "t_1", edits: [{oldString: "x", newString: "y"}], background: true});
    assert.deepEqual(JSON.parse(patched.content[0].text).problems, [{code: "asset_load", message: "missing.png"}]);
    const clean = await call("page_show", {key: "clean", title: "Clean", html: "<p>ok</p>", background: true});
    assert.equal("problems" in JSON.parse(clean.content[0].text), false);

    const fromFile = await call("page_show", {
      key: "n",
      title: "N",
      htmlPath: file,
      base: "starter",
      background: true,
    });
    assert.equal(fromFile.isError ?? false, false);
    assert.equal(posts[2]?.html, "<p>from file</p>");
    assert.equal(posts[2]?.base, "starter");

    const refused = await call("page_show", {
      key: "n",
      title: "N",
      html: "<p>x</p>",
      base: "scribe:file-page",
      background: true,
    });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /file page/);
  } finally {
    await client.close();
    await transport.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
