import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "./chromium.js";
import { CORE_COMPONENTS, COMPONENT_PATH, coreComponentGuide, inlineComponents, readComponent, renderComponentDocs } from "./coreComponents.js";

test("the scribe skill lists every core page component", () => {
  const skill = fs.readFileSync(new URL("../.cursor/skills/scribe/SKILL.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const block = /<!-- page-components:start -->\n([\s\S]*?)\n<!-- page-components:end -->/.exec(skill);
  assert.ok(block, "SKILL.md has the page-components markers");
  assert.equal(block[1], renderComponentDocs());
});

test("plugin_guide core returns each component's guide and source path", () => {
  const guide = coreComponentGuide();
  assert.deepEqual(guide.pageComponents.map((c) => c.name), CORE_COMPONENTS.map((c) => c.name));
  for (const component of guide.pageComponents) {
    assert.match(component.guide, new RegExp(`/c/${component.name}\\.js`));
    assert.ok(COMPONENT_PATH.test(component.src));
    assert.ok(readComponent(component.name));
  }
  assert.equal(readComponent("nope"), undefined);
});

test("inlineComponents inlines known component scripts and leaves others", () => {
  const html = '<script src="/c/chart.js"></script><script src="/c/select.js?v=1" defer></script><script src="/c/nope.js"></script>';
  const out = inlineComponents(html, (name) => (name === "nope" ? undefined : `/* ${name} */ "</script>"`));
  assert.equal(out, '<script data-scribe-component="chart">/* chart */ "<\\/script>"</script><script data-scribe-component="select">/* select */ "<\\/script>"</script><script src="/c/nope.js"></script>');
});

test("select and chart components work in a page, inlined as an export would", async (t) => {
  let browser;
  try {
    browser = await launchChromium({ headless: true, args: [], purpose: "Page components test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent(inlineComponents(`<!doctype html><html><head><style>:root{--bg:#1a1a1d;--text:#eee;--muted:#999;--border:#333}</style></head><body>
      <select id="sort" name="sort"><option value="new">Newest</option><option value="old">Oldest</option></select>
      <select id="raw" data-native><option>A</option></select>
      <s-chart id="cols" label="Opened" x="week" data='[{"week":"W1","n":3},{"week":"W2","n":-1}]'></s-chart>
      <s-chart id="lines" type="line" x="week" y="a,b" names="Alpha,Beta" data='[{"week":"W1","a":1,"b":2},{"week":"W2","a":4,"b":3}]'></s-chart>
      <s-chart id="spark" type="spark" data='[{"d":"1","v":1},{"d":"2","v":3},{"d":"3","v":2}]'></s-chart>
      <script src="/c/select.js"></script><script src="/c/chart.js"></script></body></html>`));

    // select: wrapped, opt-out respected, code and clicks both keep the button and the select in step.
    assert.equal(await page.locator(".select-wrap").count(), 1);
    assert.equal(await page.locator("#raw").isVisible(), true);
    const button = page.locator(".select-button");
    assert.equal(await button.textContent(), "Newest");
    await page.evaluate(() => { (document.getElementById("sort") as HTMLSelectElement).value = "old"; });
    assert.equal(await button.textContent(), "Oldest");
    await page.evaluate(() => { (window as any).changes = 0; document.getElementById("sort")!.addEventListener("change", () => (window as any).changes++); });
    await button.click();
    await page.getByRole("option", { name: "Newest" }).click();
    assert.equal(await page.evaluate(() => (document.getElementById("sort") as HTMLSelectElement).value), "new");
    assert.equal(await page.evaluate(() => (window as any).changes), 1);
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<select id="late"><option>Late</option></select>'));
    await page.waitForFunction(() => document.getElementById("late")!.closest(".select-wrap"));

    // chart: a column per value (negative too), no legend for one series; lines get a legend and end dots.
    await page.waitForSelector("#cols svg");
    assert.equal(await page.locator("#cols svg path").count(), 2);
    assert.equal(await page.locator("#cols .chart-legend").count(), 0);
    assert.equal(await page.locator("#cols svg").getAttribute("aria-label"), "Opened");
    assert.deepEqual(await page.locator("#lines .chart-key").allTextContents(), ["Alpha", "Beta"]);
    assert.equal(await page.locator("#lines svg circle").count(), 2);
    assert.equal(await page.locator("#spark svg path").count(), 1);
    const plot = (await page.locator("#lines svg rect").boundingBox())!;
    await page.locator("#lines svg rect").hover({ position: { x: plot.width - 5, y: 50 } });
    assert.match(await page.locator("#lines .chart-tip").textContent() ?? "", /W2.*Alpha.*4.*Beta.*3/);
    await page.locator("#cols").getByRole("button", { name: "Table" }).click();
    assert.deepEqual(await page.locator("#cols td").allTextContents(), ["W1", "3", "W2", "-1"]);
    await page.evaluate(() => { (document.getElementById("cols") as any).data = [{ week: "W3", n: 5 }]; });
    assert.deepEqual(await page.locator("#cols td").allTextContents(), ["W3", "5"]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
