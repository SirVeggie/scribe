import { loadChatFixture } from "../testSupport/shell.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { launchChromium } from "../chromium.js";

test("Claude meters isolate thread quotas and distinguish period spend, live overage and estimates", async (t) => {
  let browser;
  try { browser = await launchChromium({ headless: true, args: [], purpose: "Claude billing UI test" }); }
  catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ locale: "en-US" });
    await page.route("http://billing.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("http://billing.test/");
    const code = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8")
      .replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  window.billingTest = { S, planLimits, usageChip, usageTip, usageMeters, ChatView };");
    await loadChatFixture(page, code);
    const result = await page.evaluate(() => {
      const { S, planLimits, usageChip, usageTip, usageMeters, ChatView } = (window as any).billingTest;
      const now = Date.now();
      const subscription = { availability: "available", at: now, billingSource: { apiProvider: "firstParty", tokenSource: "oauth", email: "sub@example.invalid" },
        windows: [{ id: "five_hour", label: "5-hour", utilization: 0.6, resetsAt: now - 1 }],
        extraUsage: { enabled: true, usedCredits: 2500, monthlyLimit: 10000, currency: "USD" } };
      S.config.limits = { claude: subscription };
      const cloud = { claudeLimits: { at: now, availability: "unavailable", billingSource: { apiProvider: "bedrock" }, windows: [] } };
      const api = { claudeLimits: { at: now, availability: "unavailable", billingSource: { apiProvider: "firstParty", apiKeySource: "env", email: "api@example.invalid" }, windows: [] } };
      const cloudChip = usageChip("claude", false, null, cloud);
      const apiChip = usageChip("claude", false, null, api);
      const tip = usageTip("claude", { claudeLimits: subscription }).textContent;
      const staleTip = usageTip("claude", { claudeLimits: { ...subscription, at: now - 600000, overage: true, overageAt: now - 600000 } }).textContent;
      const liveTip = usageTip("claude", { claudeLimits: { ...subscription, overage: false, overageAt: now } }).textContent;
      const paidTip = usageTip("claude", { claudeLimits: { ...subscription, overage: true, overageAt: now } }).textContent;
      const routine = { ...subscription, windows: [{ ...subscription.windows[0], resetsAt: now + 3600000 }],
        extraUsage: { enabled: false, at: now - 600000 }, overage: false, overageAt: now };
      const routineTip = usageTip("claude", { claudeLimits: routine }).textContent;
      const compact = usageChip("claude", true, null, { claudeLimits: routine });
      const staleChip = usageChip("claude", true, null, { claudeLimits: subscription });
      const zeroTip = usageTip("claude", { claudeLimits: { ...routine, extraUsage: { usedCredits: 0, currency: "USD" } } }).textContent;
      const capTip = usageTip("claude", { claudeLimits: { ...routine, extraUsage: { monthlyLimit: 10000, currency: "USD", at: now - 600000 } } }).textContent;
      const footer = ChatView.prototype.renderTurnFooter.call({}, { status: "done", threadId: "fixture", model: "sonnet", usage: { costUsd: 0.5, estimatedCostUsd: 0.5, billingSource: api.claudeLimits.billingSource } }, []);
      document.body.append(cloudChip, apiChip, footer);
      return { cloud: cloudChip.textContent, api: apiChip.textContent, tip, staleTip, liveTip, paidTip, routineTip, zeroTip, capTip,
        compact: compact.textContent, staleChip: staleChip.textContent,
        expired: planLimits("claude", { claudeLimits: subscription }).windows[0].utilization,
        unknown: planLimits("claude", {}), footer: footer.textContent, estimate: footer.querySelector("[aria-description]")?.getAttribute("aria-description"),
        settings: usageMeters("claude").textContent };
    });
    assert.match(result.cloud, /bedrock.*quota unavailable/);
    assert.match(result.api, /API.*quota unavailable/);
    assert.doesNotMatch(result.cloud, /60%/);
    assert.match(result.tip, /Billing-period spend: \$25\.00 \/ \$100\.00 cap/);
    assert.doesNotMatch(result.tip, /paid-credit use unknown|Console API|sub@example|Token|extra usage: enabled/);
    assert.doesNotMatch(result.tip, /Last request: using/);
    assert.match(result.staleTip, /snapshot is stale/);
    assert.doesNotMatch(result.staleTip, /Last request: using/);
    assert.doesNotMatch(result.liveTip, /Last request:/);
    assert.match(result.paidTip, /Last request: using subscription extra usage/);
    assert.doesNotMatch(result.routineTip, /Anthropic|Token|sub@example|extra usage|paid-credit|Console|snapshot is stale/);
    assert.equal(result.compact, "60%");
    assert.match(result.staleChip, /stale/);
    assert.match(result.zeroTip, /Billing-period spend: \$0\.00/);
    assert.match(result.capTip, /Billing-period cap: \$100\.00/);
    assert.match(result.capTip, /Extra-usage snapshot is stale/);
    assert.equal(result.expired, 0.6);
    assert.equal(result.unknown, null);
    assert.match(result.footer, /Estimated \$0\.50/);
    assert.match(result.estimate, /API key \(env\)/);
    assert.match(result.estimate, /SDK estimate/);
    assert.doesNotMatch(result.settings, /Billing source and extra usage|Default query|sub@example|Console API/);
    assert.match(result.settings, /Billing-period spend: \$25\.00 \/ \$100\.00 cap/);
  } finally { await browser.close(); }
});
