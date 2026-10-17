import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AGENT_CLIENT, CLIENT_HEADER, THREAD_HEADER, VERSION } from "./config.js";

test("page tools read saved file content through page access, without local file reads", async () => {
  let text = "first line\n<hello> & world\nlast line";
  let kind = "markdown";
  let fileStatus = 200;
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      res.end(JSON.stringify({ ok: true, version: VERSION }));
      return;
    }
    assert.equal(req.headers[CLIENT_HEADER], AGENT_CLIENT);
    assert.equal(req.headers[THREAD_HEADER], "file-page-test");
    requests.push(req.url!);
    if (req.url === "/api/tabs/denied") {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "outside this chat's Scribe access; use page_access" }));
    } else if (req.url === "/api/tabs/t_file/file") {
      res.statusCode = fileStatus;
      res.end(JSON.stringify(fileStatus === 200
        ? { path: "Z:/not-accessible/note.md", name: "note.md", kind, size: text.length, mtime: 123, ...(kind === "markdown" ? { text, eol: "\n", bom: false } : {}) }
        : { error: "file not found" }));
    } else if (req.url === "/api/tabs/t_file/file/image") {
      res.end(JSON.stringify({ mimeType: "image/png", bytes: 4, data: "iVBORw==" }));
    } else if (req.url?.startsWith("/api/tabs/t_file/file/text?")) {
      const page = Number(new URL(req.url, "http://localhost").searchParams.get("page"));
      res.end(JSON.stringify({ text: `[PDF page ${page}]\nEmbedded needle`, pdf: { totalPages: 3, firstPage: page, lastPage: page, nextPage: page + 1, emptyPages: [], truncatedPages: [] } }));
    } else if (req.url?.startsWith("/api/tabs/")) {
      res.end(JSON.stringify({ id: "t_file", key: "scribe:file-test", title: "note.md", html: "placeholder", revision: 1, createdAt: 1, updatedAt: 1, ...(req.url !== "/api/tabs/html" ? { file: { path: "Z:/not-accessible/note.md" } } : {}) }));
    } else {
      // Tool gate and injection scan hooks.
      res.end("{}");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("./index.ts", import.meta.url))],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SCRIBE_PORT: String(port), SCRIBE_THREAD: "file-page-test", SCRIBE_PROVIDER: "claude", SCRIBE_PAGES: "on" },
    stderr: "pipe",
  });
  const client = new Client({ name: "file-page-test", version: "1" });
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;
  try {
    await client.connect(transport);
    const read = await call("page_read", { key: "file" });
    assert.equal(read.isError ?? false, false);
    assert.equal(read.content[1].text, text);
    const meta = JSON.parse(read.content[0].text);
    assert.equal(meta.file.path, "Z:/not-accessible/note.md");
    assert.equal(meta.file.mtime, 123);
    assert.equal(meta.htmlBytes, undefined);
    assert.equal(meta.contentBytes, Buffer.byteLength(text));
    const window = await call("page_read", { key: "file", offset: 2, limit: 1 });
    assert.equal(window.content[1].text, "2\t<hello> & world");
    const grep = await call("page_grep", { key: "file", pattern: "<hello>", literal: true });
    assert.match(grep.content[1].text, /2:.*<hello> & world/);

    text = "fresh disk content";
    assert.equal((await call("page_read", { key: "file" })).content[1].text, text);
    const checkout = await call("page_read", { key: "file", toFile: true });
    assert.equal(checkout.isError, true);
    assert.match(checkout.content[0].text, /cannot be checked out/);

    text = Array.from({ length: 1000 }, (_, i) => `${i} ${"x".repeat(200)}`).join("\n");
    const large = await call("page_read", { key: "file" });
    const largeMeta = JSON.parse(large.content[0].text);
    assert.equal(largeMeta.lines.total, 1000);
    assert.ok(largeMeta.lines.end < 1000);
    assert.match(largeMeta.more, /offset/);
    assert.equal((await call("page_read", { key: "file", full: true })).content[1].text, text);
    text = "x".repeat(100_000);
    const minified = await call("page_read", { key: "file" });
    assert.ok(minified.content[1].text.length < 1000, "automatic preview bounds long lines");
    assert.equal((await call("page_read", { key: "file", offset: 1, limit: 1, numbered: false })).content[1].text, text);

    kind = "image";
    const image = await call("page_read", { key: "file" }) as unknown as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
    assert.equal(image.content[1].type, "image");
    assert.equal(image.content[1].data, "iVBORw==");
    assert.equal(image.content[1].mimeType, "image/png");
    assert.equal(JSON.parse(image.content[0].text!).file.kind, "image");
    const imageGrep = await call("page_grep", { key: "file", pattern: "x" });
    assert.equal(imageGrep.isError, true);
    assert.match(imageGrep.content[0].text, /image file.*page_read/);
    assert.ok(!requests.slice(-2).some(route => route.endsWith("/file/image")), "page_grep does not fetch the image");
    kind = "pdf";
    const pdf = await call("page_read", { key: "file" });
    assert.equal(pdf.isError ?? false, false);
    assert.match(pdf.content[1].text, /\[PDF page 1\]\nEmbedded needle/);
    assert.equal(JSON.parse(pdf.content[0].text).pdf.nextPage, 2);
    const pdfWindow = await call("page_read", { key: "file", pdfPage: 2, pdfLimit: 1, offset: 2, limit: 1 });
    assert.equal(pdfWindow.content[1].text, "2\tEmbedded needle");
    assert.ok(requests.includes("/api/tabs/t_file/file/text?page=2&limit=1"));
    const pdfGrep = await call("page_grep", { key: "file", pdfPage: 3, pdfLimit: 2, pattern: "needle" });
    assert.match(pdfGrep.content[1].text, /2:Embedded needle/);
    assert.equal(JSON.parse(pdfGrep.content[0].text).pdf.firstPage, 3);
    assert.ok(requests.includes("/api/tabs/t_file/file/text?page=3&limit=2"));
    assert.equal((await call("page_read", { key: "file", pdfLimit: 6 })).isError, true);
    fileStatus = 404;
    assert.match((await call("page_read", { key: "file" })).content[0].text, /file not found/);
    fileStatus = 403;
    assert.equal((await call("page_grep", { key: "file", pattern: "x" })).isError, true);
    const before = requests.filter(route => route.endsWith("/file")).length;
    assert.equal((await call("page_read", { key: "denied" })).isError, true);
    assert.equal(requests.filter(route => route.endsWith("/file")).length, before);
    assert.equal((await call("page_read", { key: "html" })).content[1].text, "placeholder");
  } finally {
    await client.close();
    await transport.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
