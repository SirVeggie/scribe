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
