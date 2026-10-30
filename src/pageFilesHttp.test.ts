import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { LOCAL_TOKEN_HEADER } from "./config.js";

// scribe.files (#882): only a page's own script, only in the folders the user approved for it.
test("a page reads and writes files only in its approved folders, at their access", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-page-files-http-"));
  const home = path.join(root, "home");
  const images = path.join(root, "images");
  const notes = path.join(root, "notes");
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, "a.txt"), "hello");
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./index.ts", import.meta.url)), "--daemon"], {
    env: { ...process.env, SCRIBE_HOME: home, SCRIBE_PORT: String(port), SCRIBE_FAKE_AGENTS: "1" },
    windowsHide: true,
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const url = `http://127.0.0.1:${port}`;
  const user = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(url + route, {
      method,
      headers: { [LOCAL_TOKEN_HEADER]: fs.readFileSync(path.join(home, "local-token"), "utf8").trim(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return (await res.json()) as Record<string, any>;
  };
  /** A page's own script: the request comes in on that page's origin. */
  const fromPage = (page: string, method: string, route: string, body?: string) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const host = `t-${page.slice(2)}.localhost:${port}`;
      const req = http.request({ host: "127.0.0.1", port, path: route, method, headers: { host, origin: `http://${host}`, "sec-fetch-site": "same-origin", ...(body !== undefined ? { "content-type": "application/octet-stream" } : {}) } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on("error", reject);
      req.end(body);
    });
  const files = (page: string, op: string, file: string, query = "") => `/api/tabs/${page}/files/${op}?path=${encodeURIComponent(file)}${query}`;
  try {
    let ready = false;
    // A full npm test run starts many processes at once, so startup can take far longer than alone.
    for (const until = Date.now() + 90_000; !ready && Date.now() < until;) {
      try {
        ready = (await fetch(url + "/api/health", { signal: AbortSignal.timeout(300) })).ok;
      } catch {
        /* starting */
      }
      if (!ready) await delay(100);
    }
    assert.equal(ready, true, "daemon became ready");
    const page = (await user("POST", "/api/tabs", { key: "studio", title: "Studio", html: "<p>studio</p>", activate: false })).tab.id;
    const other = (await user("POST", "/api/tabs", { key: "other", title: "Other", html: "<p>other</p>", activate: false })).tab.id;
    const shot = path.join(images, "shot.png");

    // Nothing approved yet: the page is told to ask.
    const before = await fromPage(page, "POST", files(page, "write", shot), "png");
    assert.equal(before.status, 403);
    assert.equal(JSON.parse(before.text).error, "permission");

    await user("PUT", `/api/tabs/${page}/permissions`, { perm: "files", value: "ask", folders: [{ path: images, approval: "write" }, { path: notes, approval: "read" }] });
    const wrote = await fromPage(page, "POST", files(page, "write", shot), "png");
    assert.equal(wrote.status, 200, wrote.text);
    assert.equal(fs.readFileSync(shot, "utf8"), "png");
    assert.equal((await fromPage(page, "POST", files(page, "write", path.join(images, "log.txt"), "&append=1"), "a")).status, 200);
    assert.equal((await fromPage(page, "POST", files(page, "write", path.join(images, "log.txt"), "&append=1"), "b")).status, 200);
    assert.equal(fs.readFileSync(path.join(images, "log.txt"), "utf8"), "ab");
    // Write only cannot read back; read only cannot write.
    assert.equal((await fromPage(page, "GET", files(page, "read", shot))).status, 403);
    assert.equal((await fromPage(page, "POST", files(page, "write", path.join(notes, "b.txt")), "x")).status, 403);
    const read = await fromPage(page, "GET", files(page, "read", path.join(notes, "a.txt")));
    assert.deepEqual([read.status, read.text], [200, "hello"]);
    assert.deepEqual(JSON.parse((await fromPage(page, "GET", files(page, "list", notes))).text).entries.map((e: { name: string }) => e.name), ["a.txt"]);
    assert.equal((await fromPage(page, "GET", files(page, "read", path.join(root, "home", "local-token")))).status, 403);

    // Another page cannot borrow these folders, and no other caller reaches the routes.
    assert.equal((await fromPage(other, "GET", files(other, "read", path.join(notes, "a.txt")))).status, 403);
    assert.notEqual((await fromPage(other, "GET", files(page, "read", path.join(notes, "a.txt")))).status, 200);
    assert.notEqual((await fetch(url + files(page, "read", path.join(notes, "a.txt")))).status, 200);
  } finally {
    child.kill();
    await exited.catch(() => null);
    // Windows can hold the exited daemon's files for a moment.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
