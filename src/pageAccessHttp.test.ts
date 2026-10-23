import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import http from "node:http";
import { pdfFixture } from "./pdfFixture.test.js";
import { unzip } from "./plugins/package.js";
import { AGENT_CLIENT, CLIENT_HEADER, LOCAL_TOKEN_HEADER, THREAD_HEADER, THREAD_TOKEN_HEADER } from "./config.js";

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
  const secret = (name: string) => fs.readFileSync(path.join(root, name), "utf8").trim();
  /** No thread: the user (a local tool with the local token). "": an external MCP client. Else that chat's MCP (#682). */
  const call = async (method: string, route: string, body?: unknown, thread?: string, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = body ? { "Content-Type": "application/json" } : {};
    if (thread === undefined) headers[LOCAL_TOKEN_HEADER] = secret("local-token");
    else {
      headers[CLIENT_HEADER] = AGENT_CLIENT;
      if (thread) {
        headers[THREAD_HEADER] = thread;
        headers[THREAD_TOKEN_HEADER] = createHmac("sha256", Buffer.from(secret("agent-secret"), "hex")).update(`thread:${thread}`).digest("hex");
      } else headers[LOCAL_TOKEN_HEADER] = secret("local-token");
    }
    Object.assign(headers, extra);
    for (const [name, value] of Object.entries(headers)) if (value === "") delete headers[name];
    const res = await fetch(url + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.headers.get("content-type") === "application/zip") {
      const archive = await unzip(Buffer.from(await res.arrayBuffer()));
      assert.ok(archive["scribe.json"], "export archive contains scribe.json");
      return { status: res.status, headers: res.headers, data: JSON.parse(archive["scribe.json"].toString("utf8")) as Record<string, any> };
    }
    return { status: res.status, headers: res.headers, data: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  /** A page's own script: the request comes in on that page's origin (#660). */
  const fromPage = (page: string, method: string, route: string, body?: unknown) =>
    new Promise<number>((resolve, reject) => {
      const host = `t-${page.slice(2)}.localhost:${port}`;
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request({ host: "127.0.0.1", port, path: route, method, headers: { host, origin: `http://${host}`, "sec-fetch-site": "same-origin", ...(payload ? { "content-type": "application/json" } : {}) } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(payload);
    });
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
    const vault = await show("vault-page");
    assert.equal((await call("PUT", `/api/tabs/${vault.id}/access`, { level: "trusted" })).status, 200);
    const thread = (await call("POST", "/api/agent/threads", { provider: "claude", mode: "board", scope: { kind: "page", ref: home.id } })).data.thread;
    assert.ok(thread?.id);

    assert.equal((await call("GET", `/api/tabs/${home.id}`, undefined, thread.id)).status, 200);
    const outside = await call("GET", `/api/tabs/${other.id}/state`, undefined, thread.id);
    assert.equal(outside.status, 403);
    assert.match(outside.data.error, /page_access/);
    assert.equal((await call("PUT", `/api/tabs/${other.id}/state`, { ops: [{ op: "set", path: "x", value: 1 }] }, thread.id)).status, 403);
    assert.equal((await call("GET", `/api/tabs/${secret.id}`, undefined, thread.id)).status, 404);
    // Trusted only, for an untrusted model: askable by key, but the answer does not give its title.
    const vaulted = await call("GET", `/api/tabs/${vault.id}`, undefined, thread.id);
    assert.equal(vaulted.status, 403);
    assert.match(vaulted.data.error, /page_access/);
    assert.doesNotMatch(vaulted.data.error, /"vault-page"/);

    const listed = await call("GET", "/api/library?query=page", undefined, thread.id);
    assert.deepEqual(listed.data.tabs.map((t: { key: string }) => t.key), ["scribe:home-page"]);
    assert.deepEqual(listed.data.outside.map((t: { key: string }) => t.key), ["scribe:other-page"], "titles only, and never the Restricted or Trusted only page");
    assert.equal(listed.data.outside[0].snippet, undefined);

    // Agents cannot change access; the user (board UI) can, and an MCP with no Scribe chat sees open pages only.
    assert.equal((await call("PUT", `/api/tabs/${other.id}/access`, { level: "open" }, thread.id)).status, 403);
    assert.equal((await call("GET", `/api/tabs/${other.id}`, undefined, "")).status, 200);
    assert.equal((await call("GET", `/api/tabs/${secret.id}`, undefined, "")).status, 404);
    assert.equal((await call("GET", `/api/tabs/${secret.id}`)).status, 200, "the user sees everything");

    // A thread id without its token, or no credential at all, reaches no page and none of the board's routes (#682).
    const forged = { [THREAD_TOKEN_HEADER]: "", [LOCAL_TOKEN_HEADER]: "" };
    assert.equal((await call("GET", `/api/tabs/${home.id}`, undefined, thread.id, { [THREAD_TOKEN_HEADER]: "0".repeat(64) })).status, 404, "a forged token");
    assert.equal((await call("GET", `/api/tabs/${other.id}`, undefined, "", forged)).status, 404, "the agent header alone");
    assert.equal((await call("GET", `/api/tabs/${other.id}`, undefined, undefined, forged)).status, 404, "no header at all");
    assert.deepEqual((await call("GET", "/api/library", undefined, undefined, forged)).data.tabs, []);
    assert.equal((await call("GET", "/api/agent/threads", undefined, undefined, forged)).status, 403);
    assert.equal((await call("GET", "/api/agent/threads", undefined, thread.id)).status, 403, "a chat cannot read other chats or answer its own approvals");
    assert.equal((await call("GET", "/api/export", undefined, "")).status, 403);
    assert.equal((await call("GET", `/api/export?page=${home.id}`, undefined, thread.id)).status, 403);
    const filePath = path.join(root, "outside-workspace.md");
    fs.writeFileSync(filePath, "file page content\nsecond line");
    const filePage = (await call("POST", "/api/files/open", { path: filePath, activate: false })).data.tab;
    assert.ok(filePage?.id);
    const fileThread = (await call("POST", "/api/agent/threads", { provider: "claude", mode: "board", scope: { kind: "page", ref: filePage.id } })).data.thread;
    const fileRoute = `/api/tabs/${filePage.id}/file`;
    assert.equal((await call("POST", `${fileRoute}/open-location`, {}, fileThread.id)).status, 403, "agents cannot open file manager windows");
    assert.equal(await fromPage(filePage.id, "POST", `${fileRoute}/open-location`, {}), 403, "a file page opens its folder through the shell bridge");
    assert.equal((await call("POST", `/api/tabs/${home.id}/file/open-location`, {})).status, 404, "HTML pages have no file location");

    const template = (await call("POST", "/api/templates", { key: "export-me", title: "Export me", html: "<p>Reusable</p>" })).data.template;
    const templateRoute = `/api/export/template/${template.id}`;
    const templateExport = await call("GET", templateRoute);
    assert.equal(templateExport.status, 200);
    assert.equal(templateExport.headers.get("content-type"), "application/zip");
    assert.match(templateExport.headers.get("content-disposition") ?? "", /^attachment;.*\.scribe\.zip"$/);
    assert.equal(templateExport.data.format, "scribe-export");
    assert.deepEqual(templateExport.data.pages, []);
    assert.deepEqual(templateExport.data.templates.map((item: any) => item.id), [template.id]);
    assert.equal((await call("GET", "/api/export/template/missing")).status, 404);
    assert.equal((await call("GET", templateRoute, undefined, thread.id)).status, 403);
    assert.equal((await call("POST", "/api/library/delete", { pages: [home.id] }, thread.id)).status, 403);
    const selectionFolder = (await call("POST", "/api/folders", { name: "Selection" })).data.folder;
    const selectionPage = await show("selection-page");
    await call("POST", `/api/tabs/${selectionPage.id}/move`, { folderId: selectionFolder.id, index: 0 });
    const loosePage = await show("selection-loose");
    const selectedExport = await call("GET", `/api/export?folder=${selectionFolder.id}&page=${loosePage.id}&page=${selectionPage.id}`);
    assert.equal(selectedExport.status, 200);
    assert.equal(selectedExport.headers.get("content-type"), "application/zip");
    assert.match(selectedExport.headers.get("content-disposition") ?? "", /^attachment;.*\.scribe\.zip"$/);
    assert.deepEqual(new Set(selectedExport.data.pages.map((page: any) => page.id || page.key)), new Set([selectionPage.key, loosePage.key]));
    assert.equal((await call("POST", "/api/library/delete", { pages: [loosePage.id], folders: ["missing"] })).status, 404);
    assert.equal((await call("GET", `/api/tabs/${loosePage.id}`)).status, 200, "invalid selection leaves every page in place");
    assert.equal((await call("POST", "/api/library/delete", { pages: "invalid" })).status, 400);
    const deletedSelection = await call("POST", "/api/library/delete", { pages: [loosePage.id], folders: [selectionFolder.id] });
    assert.equal(deletedSelection.status, 200);
    assert.deepEqual(new Set(deletedSelection.data.deleted), new Set([loosePage.id, selectionPage.id]));
    assert.equal((await call("GET", `/api/tabs/${selectionPage.id}`)).status, 404);
    assert.equal((await call("POST", "/api/undo", {})).status, 200);
    assert.equal((await call("GET", `/api/tabs/${selectionPage.id}`)).status, 200);
    assert.equal((await call("GET", "/api/agent/threads")).status, 200, "the local token is the user");
    assert.equal((await call("GET", `/api/tabs/${secret.id}`, undefined, undefined, { ...forged, "sec-fetch-site": "same-origin" })).status, 200, "the board UI in a browser");

    // A page's script reaches its own page only (#660).
    assert.equal(await fromPage(home.id, "GET", `/api/tabs/${home.id}/state`), 200);
    assert.equal(await fromPage(home.id, "PUT", `/api/tabs/${home.id}/state`, { ops: [{ op: "set", path: "x", value: 1 }] }), 200);
    assert.equal(await fromPage(home.id, "GET", `/api/tabs/${other.id}/state`), 404);
    assert.equal(await fromPage(home.id, "PUT", `/api/tabs/${other.id}/state`, { ops: [{ op: "set", path: "x", value: 1 }] }), 404);
    assert.equal(await fromPage(home.id, "POST", `/api/tabs/${other.id}/action`, { action: "list" }), 404);
    assert.equal(await fromPage(home.id, "GET", `/view/${home.id}`), 200);
    assert.equal(await fromPage(home.id, "GET", `/view/${other.id}`), 302);
    assert.equal(await fromPage(home.id, "GET", "/api/tabs"), 403);
    assert.equal(await fromPage(home.id, "POST", "/api/library/delete", { pages: [home.id] }), 403);

    // A Pages-mode chat can read its file page through Scribe, even outside its file roots.
    assert.equal((await call("GET", fileRoute, undefined, fileThread.id)).data.text, "file page content\nsecond line");
    assert.equal((await call("GET", fileRoute, undefined, thread.id)).status, 403);
    assert.equal((await call("POST", "/api/files/open", { path: filePath }, fileThread.id)).status, 403, "reading a file page does not allow opening arbitrary files");
    assert.equal((await call("GET", `${fileRoute}/asset?src=${encodeURIComponent(filePath)}`, undefined, fileThread.id)).status, 403, "an agent cannot read linked images by path");
    assert.equal((await call("POST", `/api/tabs/${filePage.id}/screenshot`, {}, fileThread.id)).status, 400);
    const imagePath = path.join(root, "outside-workspace.png");
    fs.writeFileSync(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
    const imagePage = (await call("POST", "/api/files/open", { path: imagePath, activate: false })).data.tab;
    const imageThread = (await call("POST", "/api/agent/threads", { provider: "claude", mode: "board", scope: { kind: "page", ref: imagePage.id } })).data.thread;
    const image = (await call("GET", `/api/tabs/${imagePage.id}/file/image`, undefined, imageThread.id)).data;
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.data, Buffer.from("89504e470d0a1a0a", "hex").toString("base64"));
    assert.equal((await call("GET", `/api/tabs/${imagePage.id}/file/image`, undefined, thread.id)).status, 403);
    const pdfPath = path.join(root, "outside-workspace.pdf");
    fs.writeFileSync(pdfPath, pdfFixture(["PDF page one", "PDF page two"]));
    const pdfPage = (await call("POST", "/api/files/open", { path: pdfPath, activate: false })).data.tab;
    const pdfThread = (await call("POST", "/api/agent/threads", { provider: "claude", mode: "board", scope: { kind: "page", ref: pdfPage.id } })).data.thread;
    const pdfRoute = `/api/tabs/${pdfPage.id}/file/text`;
    const pdfText = await call("GET", `${pdfRoute}?page=2&limit=1`, undefined, pdfThread.id);
    assert.equal(pdfText.status, 200);
    assert.match(pdfText.data.text, /\[PDF page 2\]\nPDF page two/);
    assert.equal(pdfText.data.pdf.totalPages, 2);
    assert.equal((await call("GET", `${pdfRoute}?page=0`, undefined, pdfThread.id)).status, 400);
    assert.equal((await call("GET", pdfRoute, undefined, thread.id)).status, 403);
    await call("PUT", `/api/tabs/${pdfPage.id}/access`, { level: "restricted" });
    assert.equal((await call("GET", pdfRoute, undefined, thread.id)).status, 404);
    await call("PUT", `/api/tabs/${filePage.id}/access`, { level: "restricted" });
    assert.equal((await call("GET", fileRoute, undefined, thread.id)).status, 404);
  } finally {
    await fetch(url + "/api/shutdown", { method: "POST" }).catch(() => {});
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null) child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
