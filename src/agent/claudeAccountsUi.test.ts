import { loadChatFixture } from "../testSupport/shell.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { launchChromium } from "../chromium.js";

test("several Claude accounts: each account on hover, no average, and the limit card's switch button", async (t) => {
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
      const acc = (id: string, five: number, week: number) => ({ id, email: `${id}@example.invalid`, weight: 1, limits: { availability: "available", at: now, windows: win(five, week) } });
      S.config.limits.claude.accounts = [acc("a", 0.1, 0.1), acc("b", 0.2, 0.2), acc("c", 0.3, 0.3), acc("d", 0.4, 0.4)];
      S.config.limits.claude.nextAccount = "c";
      const many = usageTip("claude", null);
      const manyText = many.textContent;
      const manyBars = many.querySelectorAll(".ag-usage-tip-row").length;
      const buttons = limitButtons("th_1", "it_1", "pending", null, { account: "acc_1", label: "two@example.invalid" });
      const plain = limitButtons("th_1", "it_1", "pending");
      return {
        tip, meters, manyText, manyBars,
        labels: [...buttons.querySelectorAll("button")].map((b: any) => b.textContent),
        primary: buttons.querySelector("button.primary")?.textContent,
        plainPrimary: plain.querySelector("button.primary")?.textContent,
      };
    });
    // Up to three accounts: all as bars, the chat's own first, no average.
    assert.doesNotMatch(result.tip, /average/);
    assert.match(result.tip, /^Claude plan usagetwo@example\.invalid · this chat5-hour40%.*Weekly20%.*one@example\.invalid5-hour20%.*Weekly60%/);
    // More: the next chat's account as bars, the others a line each.
    assert.equal(result.manyBars, 2);
    assert.match(result.manyText, /^Claude plan usagec@example\.invalid · next chat5-hour30%/);
    assert.match(result.manyText, /5hwka@example\.invalid10%10%b@example\.invalid20%20%d@example\.invalid40%40%/);
    assert.match(result.meters, /2 accounts combined/);
    assert.match(result.meters, /two@example\.invalid/);
    assert.deepEqual(result.labels, ["Continue on two@example.invalid", "Continue after reset", "Dismiss"]);
    assert.equal(result.primary, "Continue on two@example.invalid");
    assert.equal(result.plainPrimary, "Continue after reset");
  } finally {
    await browser.close();
  }
});
