import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test } from "node:test";
import express from "express";
import { shellAssets } from "./shellAssets.js";
import { contentOriginGate } from "./contentOrigin.js";
import { CONTENT_HOST } from "./config.js";
import { fileURLToPath } from "node:url";

test("content origin serves the injected tooltip script while rejecting other shell resources", async () => {
  const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
  const app = express();
  app.use(contentOriginGate);
  app.use(shellAssets(publicDir, {}));
  app.use(express.static(publicDir));
  // A sentinel catches requests accidentally allowed through the gate.
  app.use((_req, res) => { res.status(200).send("passed gate"); });
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, CONTENT_HOST, resolve));
  const base = `http://${CONTENT_HOST}:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(base + "/tooltip.js?v=3");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /javascript/);
    assert.equal(await response.text(), fs.readFileSync(path.join(publicDir, "tooltip.js"), "utf8"));
    const kitCss = await fetch(base + "/kit.css?v=1");
    assert.equal(kitCss.status, 200);
    assert.match(kitCss.headers.get("content-type")!, /css/);
    assert.equal(await kitCss.text(), fs.readFileSync(path.join(publicDir, "kit.css"), "utf8"));
    const kitJs = await fetch(base + "/kit.js?v=1");
    assert.equal(kitJs.status, 200);
    assert.match(kitJs.headers.get("content-type")!, /javascript/);
    assert.equal(await kitJs.text(), fs.readFileSync(path.join(publicDir, "kit.js"), "utf8"));
    const worklet = await fetch(base + "/audio-stream-worklet.js");
    assert.equal(worklet.status, 200);
    assert.match(worklet.headers.get("content-type")!, /javascript/);
    assert.equal(await worklet.text(), fs.readFileSync(path.join(publicDir, "audio-stream-worklet.js"), "utf8"));
    // The file viewer's shared libraries pass the gate (#654); other vendor files do not.
    for (const url of ["/vendor/highlight.js", "/vendor/marked.js", "/vendor/purify.js", "/vendor/pdfjs/build/pdf.min.mjs", "/vendor/pdfjs/build/pdf.worker.min.mjs", "/vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap", "/vendor/pdfjs/wasm/openjpeg.wasm"]) {
      assert.equal((await fetch(base + url)).status, 200, url);
    }
    for (const url of ["/app.js", "/app.css", "/vendor/other.js", "/vendor/marked.js/x", "/vendor/pdfjs/package.json", "/vendor/pdfjs/build/pdf.mjs.map", "/vendor/pdfjs/cmaps/../package.json", "/vendor/pdfjs/web/pdf_viewer.mjs", "/api/tabs", "/api/tabs/t_1/file", "/api/agent/threads", "/api/appearance", "/api/appearance/bootstrap.js", "/tooltip.js/extra", "/Tooltip.js", "/Kit.css", "/Kit.js"]) {
      assert.equal((await fetch(base + url)).status, 403, url);
    }
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      assert.equal((await fetch(base + "/tooltip.js?v=3", { method })).status, 403, method);
      assert.equal((await fetch(base + "/kit.css?v=1", { method })).status, 403, method);
      assert.equal((await fetch(base + "/kit.js?v=1", { method })).status, 403, method);
    }
    // Pages run on their own origins (#660); the shared one sends a page there.
    const moved = await fetch(base + "/view/t_ab12cd34?viewer=v1", { redirect: "manual" });
    assert.equal(moved.status, 302);
    assert.equal(moved.headers.get("location"), `http://t-ab12cd34.localhost:${new URL(base).port}/view/t_ab12cd34?viewer=v1`);
    assert.equal((await fetch(base + "/api/tabs/t_ab12cd34/state")).status, 403, "page routes answer on page origins only");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("shell cache versions follow bytes, compress responses, and revalidate unversioned URLs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-shell-cache-"));
  fs.writeFileSync(path.join(dir, "index.html"), '<script src="./app.js?v=1"></script><script src="/vendor/test.js"></script>');
  fs.writeFileSync(path.join(dir, "app.js"), "// script\n".repeat(300));
  const app = express();
  app.use(shellAssets(dir, { "/vendor/test.js": () => "// vendor" }));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const html = await fetch(base);
    assert.equal(html.headers.get("cache-control"), "no-store");
    const markup = await html.text();
    const url = /\.\/app.js\?v=[a-f0-9]+/.exec(markup)![0].slice(1);
    assert.match(markup, /vendor\/test.js\?v=[a-f0-9]{16}/);
    const asset = await fetch(base + url);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(asset.headers.get("content-encoding"), "gzip");
    assert.equal(await asset.text(), "// script\n".repeat(300));
    const etag = asset.headers.get("etag")!;
    const plain = await fetch(base + "/app.js", { headers: { "Accept-Encoding": "identity" } });
    assert.equal(plain.headers.get("cache-control"), "no-cache");
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.equal((await fetch(base + "/app.js", { headers: { "If-None-Match": etag, "Cache-Control": "max-age=0" } })).status, 304);
    assert.equal((await fetch(base + url, { method: "HEAD" })).status, 200);
    fs.writeFileSync(path.join(dir, "app.js"), "// new script");
    const updated = await (await fetch(base)).text();
    assert.ok(!updated.includes(url.slice(1)));
    assert.equal((await fetch(base + url)).headers.get("cache-control"), "no-cache");
    assert.equal((await fetch(base + "/missing.js")).status, 404);
    assert.equal((await fetch(base + "/constructor")).status, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A request on a page's own origin: loopback with that page's Host, as a browser sends it. */
function onHost(port: number, host: string, route: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method: options.method ?? "GET", headers: { host: `${host}:${port}`, ...options.headers } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, location: res.headers.location });
    });
    req.on("error", reject);
    req.end();
  });
}

test("a page's origin serves only that page, and its routes answer only its own script (#660)", async () => {
  const app = express();
  app.use(contentOriginGate);
  app.use((_req, res) => { res.status(200).send("passed gate"); });
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const own = "t-ab12cd34.localhost";
  try {
    assert.equal((await onHost(port, own, "/view/t_ab12cd34")).status, 200);
    assert.equal((await onHost(port, own, "/view/t_ab12cd34/asset/a.png")).status, 200);
    const other = await onHost(port, own, "/view/t_00000001");
    assert.equal(other.status, 302, "another page is never served on this origin");
    assert.equal(other.location, `http://t-00000001.localhost:${port}/view/t_00000001`);
    assert.equal((await onHost(port, own, "/api/tabs/t_ab12cd34/state", { headers: { "sec-fetch-site": "same-origin" } })).status, 200);
    assert.equal((await onHost(port, own, "/api/tabs/t_ab12cd34/state", { method: "PUT", headers: { origin: `http://${own}:${port}` } })).status, 200);
    assert.equal((await onHost(port, own, "/api/tabs/t_ab12cd34/state", { headers: { "sec-fetch-site": "same-site" } })).status, 403, "another page's script");
    assert.equal((await onHost(port, own, "/api/tabs/t_ab12cd34/events", { method: "POST", headers: { origin: `http://t-00000001.localhost:${port}` } })).status, 403);
    assert.equal((await onHost(port, own, "/api/tabs/t_ab12cd34/file")).status, 403, "only the page runtime's routes");
    assert.equal((await onHost(port, own, "/api/tabs")).status, 403);
    assert.equal((await onHost(port, own, "/blob/pa_1")).status, 200);
    assert.equal((await onHost(port, own, "/tooltip.js")).status, 200);
    assert.equal((await onHost(port, own, "/kit.css")).status, 200);
    assert.equal((await onHost(port, own, "/kit.js")).status, 200);
    assert.equal((await onHost(port, own, "/audio-stream-worklet.js")).status, 200);
    assert.equal((await onHost(port, own, "/audio-stream-worklet.js", { method: "POST" })).status, 403);
    assert.equal((await onHost(port, "app.localhost", "/api/tabs")).status, 403, "other *.localhost names are not the board");
    // The board's own API: no other origin writes through it, and a rebound DNS name is refused.
    assert.equal((await onHost(port, "127.0.0.1", "/api/tabs", { method: "POST", headers: { origin: `http://${own}:${port}` } })).status, 403);
    assert.equal((await onHost(port, "127.0.0.1", "/api/tabs", { method: "POST", headers: { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } })).status, 200);
    assert.equal((await onHost(port, "127.0.0.1", "/api/tabs", { method: "POST" })).status, 200, "local tools send no Origin");
    assert.equal((await onHost(port, "evil.example", "/api/tabs")).status, 403);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("page hosts map to tab ids and back", async () => {
  const { pageHost, pageIdFromHost } = await import("./config.js");
  assert.equal(pageHost("t_ab12cd34"), "t-ab12cd34.localhost");
  assert.equal(pageIdFromHost("T-AB12CD34.localhost"), "t_ab12cd34");
  for (const id of ["t_ab12cd34", "Odd_Id-1", "test-page"]) assert.equal(pageIdFromHost(pageHost(id)), id);
  for (const host of ["localhost", "app.localhost", "t-xyz.localhost", "x1.localhost", "127.0.0.2"]) assert.equal(pageIdFromHost(host), undefined, host);
});
