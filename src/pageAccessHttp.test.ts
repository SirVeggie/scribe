import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AGENT_CLIENT, CLIENT_HEADER, THREAD_HEADER } from "./config.js";

// The daemon's page routes answer a chat's MCP by the chat's Scribe access (#269).
test("a page chat's MCP reaches its page, is told to ask for others, and never sees Restricted pages", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-page-access-http-"));
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
  const call = async (method: string, route: string, body?: unknown, thread?: string) => {
    const headers: Record<string, string> = body ? { "Content-Type": "application/json" } : {};
    if (thread !== undefined) {
      headers[CLIENT_HEADER] = AGENT_CLIENT;
      if (thread) headers[THREAD_HEADER] = thread;
    }
    const res = await fetch(url + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  try {
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      try {
        ready = (await fetch(url + "/api/health", { signal: AbortSignal.timeout(300) })).ok;
      } catch {
        /* starting */
      }
      if (!ready) await delay(100);
    }
    assert.equal(ready, true, "daemon became ready");
    const show = async (key: string) => (await call("POST", "/api/tabs", { key, title: key, html: `<p>${key} body</p>`, activate: false })).data.tab;
    const home = await show("home-page");
    const other = await show("other-page");
    const secret = await show("secret-page");
    assert.equal((await call("PUT", `/api/tabs/${secret.id}/access`, { level: "restricted" })).status, 200);
    const thread = (await call("POST", "/api/agent/threads", { provider: "claude", mode: "board", scope: { kind: "page", ref: home.id } })).data.thread;
    assert.ok(thread?.id);

    assert.equal((await call("GET", `/api/tabs/${home.id}`, undefined, thread.id)).status, 200);
    const outside = await call("GET", `/api/tabs/${other.id}/state`, undefined, thread.id);
    assert.equal(outside.status, 403);
    assert.match(outside.data.error, /page_access/);
    assert.equal((await call("PUT", `/api/tabs/${other.id}/state`, { ops: [{ op: "set", path: "x", value: 1 }] }, thread.id)).status, 403);
    assert.equal((await call("GET", `/api/tabs/${secret.id}`, undefined, thread.id)).status, 404);

    const listed = await call("GET", "/api/library?query=page", undefined, thread.id);
    assert.deepEqual(listed.data.tabs.map((t: { key: string }) => t.key), ["scribe:home-page"]);
    assert.deepEqual(listed.data.outside.map((t: { key: string }) => t.key), ["scribe:other-page"], "titles only, and never the Restricted page");
    assert.equal(listed.data.outside[0].snippet, undefined);

    // Agents cannot change access; the user (board UI) can, and an MCP with no Scribe chat sees open pages only.
    assert.equal((await call("PUT", `/api/tabs/${other.id}/access`, { level: "open" }, thread.id)).status, 403);
    assert.equal((await call("GET", `/api/tabs/${other.id}`, undefined, "")).status, 200);
    assert.equal((await call("GET", `/api/tabs/${secret.id}`, undefined, "")).status, 404);
    assert.equal((await call("GET", `/api/tabs/${secret.id}`)).status, 200, "the user sees everything");
  } finally {
    await fetch(url + "/api/shutdown", { method: "POST" }).catch(() => {});
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null) child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
