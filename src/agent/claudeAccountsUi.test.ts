import { loadChatFixture } from "../testSupport/shell.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { launchChromium } from "../chromium.js";

test("several Claude accounts: averaged meter with each account on hover, and the limit card's switch button", async (t) => {
  let browser;
  try { browser = await launchChromium({ headless: true, args: [], purpose: "Claude accounts UI test" }); }
  catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ locale: "en-US" });
    await page.route("http://accounts.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("http://accounts.test/");
    const code = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8")
      .replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  window.accountsTest = { S, usageTip, usageMeters, limitButtons };");
    await loadChatFixture(page, code);
    const result = await page.evaluate(() => {
      const { S, usageTip, usageMeters, limitButtons } = (window as any).accountsTest;
      const now = Date.now();
      const win = (five: number, week: number) => [
        { id: "five_hour", label: "5-hour", utilization: five, resetsAt: now + 3600000 },
        { id: "seven_day", label: "Weekly", utilization: week, resetsAt: now + 86400000 },
      ];
      S.config.limits = { claude: { availability: "available", at: now, source: "claude", windows: win(0.3, 0.4), accounts: [
        { id: "default", email: "one@example.invalid", plan: "Pro", weight: 1, limits: { availability: "available", at: now, windows: win(0.2, 0.6) } },
        { id: "acc_1", email: "two@example.invalid", plan: "Pro", weight: 1, limits: { availability: "available", at: now, windows: win(0.4, 0.2) } },
      ] } };
      const tip = usageTip("claude", { claudeAccount: "acc_1" }).textContent;
      const meters = usageMeters("claude").textContent;
      const buttons = limitButtons("th_1", "it_1", "pending", null, { account: "acc_1", label: "two@example.invalid" });
      const plain = limitButtons("th_1", "it_1", "pending");
      return {
        tip, meters,
        labels: [...buttons.querySelectorAll("button")].map((b: any) => b.textContent),
        primary: buttons.querySelector("button.primary")?.textContent,
        plainPrimary: plain.querySelector("button.primary")?.textContent,
      };
    });
    assert.match(result.tip, /average of 2 accounts/);
    assert.match(result.tip, /one@example\.invalid20%60%/);
    assert.match(result.tip, /two@example\.invalid · this chat40%20%/);
    assert.match(result.meters, /average of 2 accounts/);
    assert.match(result.meters, /two@example\.invalid/);
    assert.deepEqual(result.labels, ["Continue on two@example.invalid", "Continue after reset", "Dismiss"]);
    assert.equal(result.primary, "Continue on two@example.invalid");
    assert.equal(result.plainPrimary, "Continue after reset");
  } finally {
    await browser.close();
  }
});
