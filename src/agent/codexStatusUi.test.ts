import { loadChatFixture } from "../testSupport/shell.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { launchChromium } from "../chromium.js";

test("Codex settings offer reauthentication after a live usage failure and recover after login", async (t) => {
  let browser;
  try { browser = await launchChromium({ headless: true, args: [], purpose: "Codex status UI test" }); }
  catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    const provider = { id: "codex", label: "Codex", available: true, detail: "codex login" };
    const config = { providers: [provider], models: {}, prefs: {}, limits: {} };
    const requests: string[] = [];
    let configReads = 0;
    await page.route("http://status.test/**", (route) => {
      const request = route.request();
      requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(
        request.url().endsWith("/config") ? { ...config, limits: ++configReads === 1
          ? { codex: { availability: "authentication_required", windows: [] } } : {} }
          : request.url().endsWith("/login") ? { url: null } : { models: [] }
      ) });
    });
    await page.goto("http://status.test/");
    const code = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8")
      .replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  window.statusTest = { S, agentSettings, onEvent };");
    await loadChatFixture(page, code);
    await page.evaluate((config) => {
      const { S, agentSettings } = (window as any).statusTest;
      S.config = config;
      agentSettings.status = document.createElement("div");
      document.body.append(agentSettings.status);
      agentSettings.renderStatus();
    }, config);
    await page.getByText("Ready", { exact: true }).waitFor();
    await page.evaluate(() => {
      const { onEvent } = (window as any).statusTest;
      onEvent({ type: "agent_limits", limits: { codex: { availability: "authentication_required", windows: [] } } });
    });
    await page.getByRole("button", { name: "Log in again", exact: true }).waitFor();
    assert.equal(await page.getByText("Ready", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "Log in again", exact: true }).click();
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 10_000 });
    assert.ok(requests.includes("POST /api/agent/codex/login"));
    assert.equal(configReads, 2, "an existing auth file must not end the login poll before usage recovers");
    assert.equal(await page.getByRole("button", { name: "Log in again", exact: true }).count(), 0);
    // A transient quota outage keeps the existing provider availability.
    await page.evaluate(() => {
      const { onEvent } = (window as any).statusTest;
      onEvent({ type: "agent_limits", limits: { codex: { availability: "unavailable", windows: [] } } });
    });
    await page.getByText("Ready", { exact: true }).waitFor();
  } finally { await browser.close(); }
});

test("provider log out refreshes the row, keeps failures usable, and excludes environment keys", async (t) => {
  let browser;
  try { browser = await launchChromium({ headless: true, args: [], purpose: "Provider logout UI test" }); }
  catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    const config = { providers: [
      { id: "codex", label: "Codex", available: true, logout: true },
      { id: "claude", label: "Claude", available: true, logout: true },
      { id: "cursor", label: "Cursor", available: true, detail: "CURSOR_API_KEY" },
    ], models: {}, prefs: {}, limits: {} };
    let attempts = 0;
    await page.route("http://logout.test/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/codex/logout")) {
        assert.equal(route.request().method(), "POST");
        if (++attempts === 1) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Finish or stop Codex chats before logging out." }) });
        Object.assign(config.providers[0], { available: false, logout: false, login: true });
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(url.pathname.endsWith("/config") ? config : { ok: true }) });
    });
    await page.goto("http://logout.test/");
    const code = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8")
      .replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  window.statusTest = { S, agentSettings };");
    await loadChatFixture(page, code);
    await page.evaluate((config) => {
      const { S, agentSettings } = (window as any).statusTest;
      S.config = config;
      agentSettings.status = document.createElement("div");
      document.body.append(agentSettings.status);
      agentSettings.renderStatus();
    }, config);
    await page.evaluate(() => {
      (window as any).scribeApp = { showNotice(text: string) {
        const message = document.createElement("div");
        message.textContent = text;
        document.body.append(message);
      } };
    });
    const row = page.locator(".setting-row").filter({ has: page.getByText("Codex", { exact: true }) });
    const logout = row.getByRole("button", { name: "Log out", exact: true });
    assert.equal(await page.getByRole("button", { name: "Log out", exact: true }).count(), 2);
    await logout.click();
    await page.getByText("Finish or stop Codex chats before logging out.", { exact: true }).waitFor();
    assert.equal(await logout.isEnabled(), true);
    await logout.click();
    await row.getByRole("button", { name: "Log in", exact: true }).waitFor();
    assert.equal(await row.getByText("Ready", { exact: true }).count(), 0);
    assert.equal(await row.getByRole("button", { name: "Log out", exact: true }).count(), 0);
    assert.equal(attempts, 2);
  } finally { await browser.close(); }
});
