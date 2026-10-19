import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { LOCAL_TOKEN_HEADER } from "./config.js";

// page_show base (#630): a new page starts from a starter page's HTML, with the agent's html in its slot.
test("page_show base fills the starter's slot, and a download inlines the page kit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-page-base-"));
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./index.ts", import.meta.url)), "--daemon"], {
    env: { ...process.env, SCRIBE_HOME: root, SCRIBE_PORT: String(port), SCRIBE_FAKE_AGENTS: "1" },
    windowsHide: true,
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const url = `http://127.0.0.1:${port}`;
  const token = () => fs.readFileSync(path.join(root, "local-token"), "utf8").trim();
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(url + route, {
      method,
      headers: { [LOCAL_TOKEN_HEADER]: token(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, text: await res.text() };
  };
  try {
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        if (fs.existsSync(path.join(root, "local-token")) && (await fetch(`${url}/api/health`)).ok) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error("daemon did not start");
      await delay(100);
    }

    const starter = await call("POST", "/api/tabs", {
      key: "starter", title: "Starter", activate: false,
      html: `<style>.brand{color:red}</style><header class="brand">Team</header><section data-slot><p>placeholder</p></section><footer>f</footer>`,
    });
    assert.ok(starter.status < 300, starter.text);

    const made = await call("POST", "/api/tabs", { key: "from-starter", title: "Report", activate: false, base: "scribe:starter", html: "<h1>Findings</h1>" });
    assert.ok(made.status < 300, made.text);
    const tab = JSON.parse(made.text).tab;
    const page = JSON.parse((await call("GET", `/api/tabs/${tab.id}`)).text);
    assert.match(page.html, /<header class="brand">Team<\/header><section data-slot><h1>Findings<\/h1><\/section><footer>f<\/footer>/);
    assert.doesNotMatch(page.html, /placeholder/);
    assert.equal(page.html.match(/<!DOCTYPE html>/gi)?.length, 1, "the starter's wrapper is not wrapped again");

    const missing = await call("POST", "/api/tabs", { key: "nope", title: "Nope", activate: false, base: "scribe:no-such-page", html: "<p>x</p>" });
    assert.equal(missing.status, 404, missing.text);

    const download = await call("GET", `/download/${tab.id}`);
    assert.equal(download.status, 200);
    assert.doesNotMatch(download.text, /href="\/kit\.css/);
    assert.doesNotMatch(download.text, /src="\/kit\.js/);
    assert.ok(download.text.includes(fs.readFileSync(fileURLToPath(new URL("../public/kit.css", import.meta.url)), "utf8")));
  } finally {
    child.kill();
    await exited.catch(() => null);
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Windows may still hold the folder for a moment.
    }
  }
});
