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
import { launchChromium } from "./chromium.js";

test("page writes report visible and background first renders, original lines, clean patches and deadlines", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-page-problems-"));
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./index.ts", import.meta.url)), "--daemon"], {
    env: {...process.env, SCRIBE_HOME: root, SCRIBE_PORT: String(port), SCRIBE_FAKE_AGENTS: "1"},
    windowsHide: true, stdio: "ignore",
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const url = `http://127.0.0.1:${port}`;
  const call = async (route: string, body: unknown) => {
    const response = await fetch(url + route, {method: "POST", headers: {
      [LOCAL_TOKEN_HEADER]: fs.readFileSync(path.join(root, "local-token"), "utf8").trim(),
      "Content-Type": "application/json",
    }, body: JSON.stringify(body)});
    const result = await response.json() as any;
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  };
  let browser;
  try {
    const deadline = Date.now() + 30000;
    for (;;) {
      try { if (fs.existsSync(path.join(root, "local-token")) && (await fetch(url + "/api/health")).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error("Daemon did not start");
      await delay(100);
    }
    const created = await call("/api/tabs", {key: "diagnostics", title: "Diagnostics", state: {quoted: "SCRIBE_PROBLEM_BOOT"}, activate: false, html: "<p>initial</p>"});
    const id = created.tab.id;
    browser = await launchChromium({headless: true, args: [], purpose: "Visible diagnostics test"});
    const page = await browser.newPage();
    const html = '<!doctype html>\n<html><head></head><body>\n<script>throw new Error("visible failure")</script>\n</body></html>';
    const pending = call(`/api/tabs/${id}/patch`, {html, checkProblems: true, activate: false});
    // Simulate an existing shell loading its freshly changed view, before the fallback starts.
    await delay(40);
    await page.goto(`http://${id.replace("_", "-")}.localhost:${port}/view/${id}`);
    const visible = await pending;
    assert.deepEqual(visible.problems, [{code: "uncaught_error", message: "Uncaught Error: visible failure", line: 3}]);
    const background = await call(`/api/tabs/${id}/patch`, {
      html: '<form data-reply><input></form><a href="scribe:no-such-diagnostic-page">Missing</a><script>throw new Error("background failure")</script>',
      checkProblems: true, activate: false,
    });
    for (const code of ["uncaught_error", "reply_field_name", "missing_page"]) assert.ok(background.problems?.some((p: any) => p.code === code), JSON.stringify(background));
    const clean = await call(`/api/tabs/${id}/patch`, {html: "<p>fixed</p>", checkProblems: true, activate: false});
    assert.equal("problems" in clean, false, JSON.stringify(clean));
    const denied = await fetch(url + `/api/tabs/${id}/problems`, {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
    assert.equal(denied.status, 404, "The board origin cannot submit a page report");
    const embedStart = Date.now();
    const embed = await call("/api/tabs", {key: "embed-diagnostics", title: "Embed", activate: false, checkProblems: true,
      html: '<!doctype html><meta name="scribe-embed" content="https://example.com"><iframe src="https://example.com"></iframe>'});
    assert.equal("problems" in embed, false);
    assert.ok(Date.now() - embedStart < 1000, "Embeds must skip the diagnostic wait");
    const start = Date.now();
    const stuck = await call(`/api/tabs/${id}/patch`, {html: "<script>while(true){}</script>", checkProblems: true, activate: false});
    assert.equal("problems" in stuck, false);
    assert.ok(Date.now() - start < 3500, "A hung render must not stall the write");
  } finally {
    await browser?.close();
    child.kill();
    await exited;
    fs.rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  }
});
