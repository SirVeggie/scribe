import { loadChatFixture } from "../testSupport/shell.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import test, { type TestContext } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { launchChromium } from "../chromium.js";

const INITIAL_RULES = [
  { id: "rule-1", enabled: true, match: "regex", pattern: "rm\\s+-rf", event: "tool_call", action: "block", text: "No recursive deletes" },
  { id: "rule-2", enabled: false, match: "question", pattern: "Does this push to main?", event: "tool_call", action: "ask" },
];

const COVERAGE = [
  { provider: "claude", label: "Claude", hold: "all", held: "Every tool call, before it runs.", observed: "" },
  { provider: "pi", label: "Native", hold: "all", held: "Every tool call, before it runs.", observed: "" },
  { provider: "codex", label: "Codex", hold: "some", held: "Some tool calls, before they run.", observed: "Other calls: Block stops the turn." },
  { provider: "cursor", label: "Cursor", hold: "some", held: "Some tool calls, before they run.", observed: "Other calls: Block stops the turn." },
];

async function launch(t: TestContext): Promise<Browser | null> {
  try {
    return process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Hooks UI test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) {
      t.skip("no Chromium installed");
      return null;
    }
    throw error;
  }
}

/** Opens the Hooks settings category with a stub server that keeps the rules in `state`. Every PUT body is kept in `puts`. */
async function openHooks(t: TestContext) {
  const browser = await launch(t);
  if (!browser) return null;
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const state = { rules: INITIAL_RULES.map((rule) => ({ ...rule })), failNext: false };
  const puts: Record<string, any>[] = [];
  await page.route("http://hooks.test/**", async (route) => {
    const request = route.request();
    if (!request.url().includes("/api/agent/")) return route.fulfill({ contentType: "text/html", body: "<main></main>" });
    if (request.method() === "PUT") {
      const body = request.postDataJSON();
      puts.push(body);
      if (state.failNext) {
        return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "\"(\" is not a valid regular expression" }) });
      }
      state.rules = body.rules.map((rule: Record<string, any>, index: number) => (rule.id ? rule : { ...rule, id: `rule-${index + 1}` }));
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ rules: state.rules, classifier: false, coverage: COVERAGE }),
    });
  });
  await page.goto("http://hooks.test/");

  const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
  await loadChatFixture(page, source.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  window.hooksTest = { hookSettings, editHookRule, hookFlags, S };"));
  await page.evaluate(async () => {
    const { hookSettings } = (window as any).hooksTest;
    hookSettings.mount(document.querySelector("main")!);
    await hookSettings.render();
  });
  return { browser, page, state, puts };
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((done) => setTimeout(done, 10));
  assert.ok(check(), "timed out waiting for the request");
}

test("hook list shows each rule with its match, event, action and switch state", async (t) => {
  const opened = await openHooks(t);
  if (!opened) return;
  const { browser, page } = opened;
  try {
    const rows = page.locator(".ag-hook-rule");
    assert.equal(await rows.count(), 2);
    const first = await rows.nth(0).innerText();
    assert.ok(first.includes("rm\\s+-rf"), first);
    assert.match(first, /regex/);
    assert.match(first, /tool call/);
    assert.match(first, /Block/);
    assert.match(await rows.nth(1).innerText(), /needs a classifier/);
    assert.equal(await rows.nth(0).getByRole("switch").getAttribute("aria-checked"), "true");
    assert.equal(await rows.nth(1).getByRole("switch").getAttribute("aria-checked"), "false");
  } finally { await browser.close(); }
});

test("coverage table lists each provider with what it only lets a hook see", async (t) => {
  const opened = await openHooks(t);
  if (!opened) return;
  const { browser, page } = opened;
  try {
    const bodyRows = page.locator(".ag-hook-table tr", { has: page.locator("td") });
    assert.equal(await bodyRows.count(), 4);
    assert.deepEqual(await bodyRows.locator("> th").allInnerTexts(), ["Claude", "Native", "Codex", "Cursor"]);
    const claude = page.locator(".ag-hook-table tr", { has: page.locator("th", { hasText: /^Claude$/ }) });
    assert.equal(await claude.locator("td").nth(1).innerText(), "Nothing");
    assert.match(await claude.locator("td").nth(1).getAttribute("class") ?? "", /ag-muted/);
  } finally { await browser.close(); }
});

test("clicking a rule's switch saves the rules with only that rule's enabled flag changed", async (t) => {
  const opened = await openHooks(t);
  if (!opened) return;
  const { browser, page, puts } = opened;
  try {
    await page.locator(".ag-hook-rule").nth(1).getByRole("switch").click();
    await waitFor(() => puts.length === 1);
    assert.deepEqual(puts[0].rules[0], INITIAL_RULES[0]);
    assert.deepEqual(puts[0].rules[1], { ...INITIAL_RULES[1], enabled: true });
  } finally { await browser.close(); }
});

test("adding a rule sends it as a new keyword rule and the list picks it up", async (t) => {
  const opened = await openHooks(t);
  if (!opened) return;
  const { browser, page, puts } = opened;
  try {
    await page.evaluate(() => (window as any).hooksTest.editHookRule(null));
    await page.getByLabel("Pattern", { exact: true }).fill("--force");
    await page.getByLabel("Then", { exact: true }).selectOption("ask");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await waitFor(() => puts.length === 1);
    assert.equal(puts[0].rules.length, 3);
    assert.deepEqual(puts[0].rules[2], { match: "keyword", pattern: "--force", event: "any", action: "ask", enabled: true, text: "" });
    await page.waitForFunction(() => !document.querySelector(".ag-hook"));
    await page.waitForFunction(() => document.querySelectorAll(".ag-hook-rule").length === 3);
  } finally { await browser.close(); }
});

test("the hook editor narrows events for tool names, shows the threshold for questions and renames the message field", async (t) => {
  const opened = await openHooks(t);
  if (!opened) return;
  const { browser, page } = opened;
  try {
    await page.evaluate(() => (window as any).hooksTest.editHookRule(null));
    const when = page.getByLabel("When", { exact: true });
    const match = page.getByLabel("Match", { exact: true });
    const threshold = page.getByLabel("Match when at least this sure (%)", { exact: true });
    const shownEvents = () => when.evaluate((select: HTMLSelectElement) => [...select.options].filter((option) => !option.hidden).map((option) => option.value));

    assert.equal(await threshold.isVisible(), false);
    await match.selectOption("tool");
    assert.deepEqual(await shownEvents(), ["tool_call", "tool_result"]);
    assert.equal(await when.inputValue(), "tool_call");
    await match.selectOption("keyword");
    assert.equal((await shownEvents()).length, 7);

    await match.selectOption("question");
    assert.equal(await threshold.isVisible(), true);
    await match.selectOption("regex");
    assert.equal(await threshold.isVisible(), false);

    const message = page.getByLabel("Message to the agent", { exact: true });
    await page.getByLabel("Then", { exact: true }).selectOption("context");
    assert.equal(await message.count(), 1);
    assert.equal(await page.locator(".ag-hook .ag-field-label", { hasText: /^Message to the agent$/ }).count(), 1);
  } finally { await browser.close(); }
});

test("a failed save shows the server's error and keeps the editor open", async (t) => {
  const opened = await openHooks(t);
  if (!opened) return;
  const { browser, page, state, puts } = opened;
  try {
    state.failNext = true;
    await page.evaluate(() => (window as any).hooksTest.editHookRule(null));
    await page.getByLabel("Match", { exact: true }).selectOption("regex");
    await page.getByLabel("Pattern", { exact: true }).fill("(");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const error = page.locator("p.ag-source-error");
    await error.waitFor({ state: "visible" });
    assert.equal(await error.innerText(), "\"(\" is not a valid regular expression");
    assert.equal(puts.length, 1);
    assert.equal(await page.locator(".ag-hook").count(), 1);
  } finally { await browser.close(); }
});

test("removing a rule from its editor saves the rules without it", async (t) => {
  const opened = await openHooks(t);
  if (!opened) return;
  const { browser, page, puts } = opened;
  try {
    await page.locator(".ag-hook-rule").nth(0).getByRole("button", { name: "Edit", exact: true }).click();
    assert.equal(await page.getByLabel("Pattern", { exact: true }).inputValue(), "rm\\s+-rf");
    assert.equal(await page.getByLabel("Reason", { exact: true }).inputValue(), "No recursive deletes");
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await waitFor(() => puts.length === 1);
    assert.deepEqual(puts[0].rules, [INITIAL_RULES[1]]);
  } finally { await browser.close(); }
});

test("hook flags render as tags with their action and reason, and nothing without flags", async (t) => {
  const opened = await openHooks(t);
  if (!opened) return;
  const { browser, page } = opened;
  try {
    const result = await page.evaluate(() => {
      const { hookFlags } = (window as any).hooksTest;
      const wrap = hookFlags({ flags: [{ id: "rule:rule-1", label: "rm -rf", action: "block", reason: "No recursive deletes" }] });
      const tag = wrap.querySelector(".ag-flag") as HTMLElement;
      return {
        blocks: wrap.querySelectorAll(".ag-flag.a-block").length,
        text: wrap.textContent,
        tip: tag.dataset.tooltip,
        none: hookFlags({}),
      };
    });
    assert.equal(result.blocks, 1);
    assert.equal(result.text, "rm -rf");
    assert.match(result.tip ?? "", /Blocked/);
    assert.match(result.tip ?? "", /No recursive deletes/);
    assert.equal(result.none, null);
  } finally { await browser.close(); }
});
