import { loadChatFixture } from "../testSupport/shell.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "../chromium.js";

test("MCP dialog discovers Claude servers and imports one with its scope and ask approval", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "MCP dialog test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const view = { path: "scribe/mcp.json", defaultModes: ["code", "plan", "ask"], file: { mcpServers: {} as Record<string, unknown>, workspaces: {} as Record<string, any> } };
    const candidate = (name: string, scope = "global", source = "claude") => ({ source, name, scope, file: scope === "global" ? "home/.claude.json" : `${scope}/.mcp.json`, server: { command: name, approve: "auto" } });
    const candidates = [candidate("keeper"), candidate("shared", "/project"), candidate("cursor-only", "global", "cursor"), candidate("codex-only", "global", "codex")];
    const imported: any[] = [];
    let grants = [
      { key: "a".repeat(64), tool: "read", server: { name: "keeper", layer: "global" } },
      { key: "b".repeat(64), thread: "thread-a", threadTitle: "My project", server: null },
    ];
    const revoked: any[] = [];
    const layerSaves: any[] = [];
    let fail = false;
    await page.route("http://mcp.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith("/api/agent/")) return route.fulfill({ contentType: "text/html", body: "<main></main>" });
      if (url.pathname.includes("/harness/") || url.pathname.endsWith("/config") || url.pathname.endsWith("/threads")) {
        const data = url.pathname.endsWith("/context")
          ? { thread: route.request().postDataJSON(), own: { mcpDelivery: "" }, servers: [], leftOut: [], duplicates: [] }
          : { prefs: {}, threads: [], totals: {}, toolKinds: [], tools: [], mcp: [], skills: [], folders: [], memories: [] };
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
      }
      if (url.pathname.endsWith("/mcp/permissions")) {
        if (route.request().method() === "DELETE") {
          if (fail) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "revoke failed" }) });
          const grant = route.request().postDataJSON();
          revoked.push(grant);
          grants = grants.filter((g) => g.key !== grant.key);
        }
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ grants }) });
      }
      if (route.request().method() === "PUT" && url.pathname.endsWith("/mcp/layer")) {
        const body = route.request().postDataJSON();
        layerSaves.push(body);
        view.file.mcpServers = body.servers;
      }
      if (route.request().method() === "POST") {
        if (fail) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "write failed" }) });
        for (const item of route.request().postDataJSON().items) {
          imported.push(item);
          if (item.scope === "global") view.file.mcpServers[item.name] = item.server;
          else view.file.workspaces[item.scope] = { path: item.scope, mcpServers: { [item.name]: item.server } };
        }
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(url.pathname.endsWith("/import") && route.request().method() === "GET" ? { candidates } : view) });
    });
    await page.goto("http://mcp.test/");

    await page.addScriptTag({ content: "window.__name = (fn) => fn;" });
    await page.evaluate(() => {
      (window as any).scribeApp = { showNotice: (text: string) => {
        let notice = document.getElementById("notice");
        if (!notice) { notice = document.createElement("div"); notice.id = "notice"; document.body.append(notice); }
        notice.textContent = text;
      } };
    });

    const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    await loadChatFixture(page, source.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  window.mcpTest = mcpServers;"));
    await page.evaluate(() => (window as any).mcpTest.open());
    assert.equal(await page.getByRole("button", { name: "Import keeper from home/.claude.json" }).count(), 1);
    assert.equal(await page.getByText("cursor-only", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "Import keeper from home/.claude.json" }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
    assert.deepEqual(imported[0], { name: "keeper", scope: "global", server: { command: "keeper", approve: "ask" } });
    assert.equal(await page.getByRole("button", { name: "Import keeper from home/.claude.json" }).count(), 0);
    // The working folder is editable and cleared when emptied. Wait for the editor to focus Command first.
    const editor = page.locator(".ag-mcp-edit");
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.waitForFunction(() => (document.activeElement as HTMLInputElement | null)?.placeholder === "e.g. npx");
    await editor.getByLabel("Working folder").fill("C:\\keeper");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    assert.equal(layerSaves[0].servers.keeper.cwd, "C:\\keeper");
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.waitForFunction(() => (document.activeElement as HTMLInputElement | null)?.placeholder === "e.g. npx");
    assert.equal(await editor.getByLabel("Working folder").inputValue(), "C:\\keeper");
    await editor.getByLabel("Working folder").fill("");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    assert.equal("cwd" in layerSaves[1].servers.keeper, false);
    // The discovered workspace is selectable even when Scribe has no entries there yet.
    await page.getByRole("combobox", { name: "Where the servers apply" }).selectOption("/project");
    const shared = page.getByRole("button", { name: "Import shared from /project/.mcp.json" });
    fail = true;
    await shared.click();
    await page.getByText("write failed", { exact: true }).waitFor();
    assert.equal(await shared.isEnabled(), true);
    fail = false;
    await shared.click();
    await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
    assert.equal(imported[1].scope, "/project");
    assert.equal(imported[1].server.approve, "ask");
    await page.getByRole("button", { name: "Import…", exact: true }).click();
    const importer = page.locator(".ag-mcp-import");
    await importer.getByRole("checkbox", { name: "Codex", exact: true }).waitFor();
    assert.match(await importer.innerText(), /codex-only/);
    await importer.getByRole("checkbox", { name: /codex-only/ }).check();
    await importer.getByRole("button", { name: "Import", exact: true }).click();
    await importer.waitFor({ state: "detached" });
    assert.equal(imported[2].name, "codex-only");
    assert.equal(imported[2].scope, "global");
    await page.getByRole("button", { name: "Saved permissions…", exact: true }).click();
    const permissions = page.locator(".ag-mcp").last();
    await permissions.getByText("Tool: read · All threads", { exact: true }).waitFor();
    assert.match(await permissions.innerText(), /All tools · Thread: My project/);
    const revoke = permissions.getByRole("button", { name: "Revoke keeper: read for all threads", exact: true });
    fail = true;
    await revoke.click();
    await page.getByText("revoke failed", { exact: true }).waitFor();
    assert.equal(await revoke.isEnabled(), true);
    fail = false;
    await revoke.click();
    await permissions.getByText("Tool: read · All threads", { exact: true }).waitFor({ state: "detached" });
    assert.deepEqual(revoked[0], { key: "a".repeat(64), tool: "read" });
    await permissions.getByRole("button", { name: /Revoke Unavailable server/ }).click();
    await permissions.getByText("No saved permissions.", { exact: true }).waitFor();
    assert.deepEqual(revoked[1], { key: "b".repeat(64), thread: "thread-a" });
    // app.js routes Escape to scribeChat.escape(); this fixture has no app.js.
    await page.evaluate(() => (window as any).scribeChat.escape());
    await page.evaluate(() => (window as any).mcpTest.close());
    assert.equal(await page.locator(".ag-mcp").count(), 0);
    await page.addScriptTag({ content: fs.readFileSync(new URL("../../public/harness.js", import.meta.url), "utf8") });
    await page.evaluate(() => (window as any).scribeHarness.open("mcp"));
    await page.getByRole("button", { name: "Saved permissions…", exact: true }).click();
    await page.locator(".ag-mcp").getByText("No saved permissions.", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
