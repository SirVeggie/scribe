import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "../chromium.js";
import { findSettings, parseShowInput, setSettingsCatalog } from "./settingsTool.js";

test("settings_find searches the window's list and settings_show takes only known ids", () => {
  setSettingsCatalog({ settings: [] });
  assert.throws(() => findSettings("send"), /not available/);
  const count = setSettingsCatalog({
    settings: [
      { id: "agent/chat", kind: "section", dialog: "Agent settings", category: "Chat", section: "Chat", label: "Chat" },
      { id: "agent/chat/send-messages-with", kind: "row", dialog: "Agent settings", category: "Chat", section: "Chat", label: "Send messages with", control: "choice", options: ["Enter", "Ctrl+Enter"], value: "Enter" },
      { id: "general/tabs/smooth", kind: "row", dialog: "Settings", category: "Navigation", section: "Tabs", label: "Smooth scrolling tab strip", control: "switch", value: "on", hint: "Scrolls the strip smoothly when sending focus" },
      { id: "", kind: "row", label: "dropped" },
      { id: "x", kind: "nope", label: "dropped" },
    ],
  });
  assert.equal(count, 3);
  const found = findSettings("send messages");
  assert.match(found, /agent\/chat\/send-messages-with  Agent settings › Chat › Chat › Send messages with: Enter \(choice: Enter \| Ctrl\+Enter\)/);
  // Ranked by where the words are, then kept in the dialogs' order.
  const lines = found.split("\n").filter((l) => l.includes("  "));
  assert.deepEqual(lines.map((l) => l.split("  ")[0]), ["agent/chat/send-messages-with", "general/tabs/smooth"]);
  assert.match(findSettings("zzz"), /Nothing matched "zzz"\. All 3 settings/);
  assert.match(findSettings(undefined), /^3 settings/);

  assert.deepEqual(parseShowInput({ ids: ["general/tabs/smooth", "general/tabs/smooth"], title: " Here " }), { ids: ["general/tabs/smooth"], title: "Here" });
  assert.throws(() => parseShowInput({ ids: [] }), /at least one/);
  assert.throws(() => parseShowInput({ ids: ["agent/chat/nope"] }), /Unknown setting id: agent\/chat\/nope/);
});

test("settings catalogs and inert cards exclude secrets while live controls keep drafts", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Settings secrets test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    const published: any[] = [];
    await page.route("http://settings.test/**", async (route) => {
      if (route.request().url().endsWith("/api/settings/index")) {
        published.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ contentType: "text/html", body: `
        <div hidden><div class="settings-panel" id="panel"><h2 class="settings-title" id="title">Settings</h2>
          <section class="settings-section" id="secrets"><h3>Secrets</h3>
            <div class="setting-row"><label>API key</label><input id="key" type="password" value="attribute-secret"></div>
            <div class="setting-row"><label>Empty key</label><input type="password" placeholder="Saved (type to replace)"></div>
            <form><label>Model source key<input id="nested" type="password" value="nested-secret"></label></form>
            <input id="direct" aria-label="Direct key" type="password" value="direct-secret">
            <div class="setting-row"><label>Endpoint</label><input type="text" value="https://example.test"></div>
          </section>
        </div></div><main id="chat"></main>` });
    });
    await page.goto("http://settings.test/");
    await page.addScriptTag({ content: "window.__name = (fn) => fn; window.scribeMotion = { enabled: () => false };" });
    await page.addScriptTag({ content: fs.readFileSync(new URL("../../public/settings-ui.js", import.meta.url), "utf8") });
    const publication = page.waitForResponse("http://settings.test/api/settings/index");
    await page.evaluate(() => {
      const w = window as any;
      (document.getElementById("key") as HTMLInputElement).value = "typed-secret";
      w.view = w.scribeSettingsUI.mount(document.getElementById("panel"), [
        { label: "Sources", sections: [document.getElementById("secrets")] },
      ]);
      w.view.open();
      w.addCard = (id: string) => {
        const root = document.createElement("div");
        root.id = id;
        document.getElementById("chat")!.append(root);
        w.scribeSettingsUI.lend(root, ["general/secrets"]);
      };
      w.addCard("first"); // Built while the dialog is open: all copies.
      window.dispatchEvent(new CustomEvent("scribe:connection", { detail: { connected: true } }));
    });
    const assertSafeCopies = async (id: string) => {
      const fields = await page.locator(`#${id} input[type=password]`).evaluateAll((inputs) => inputs.map((el) => {
        const input = el as HTMLInputElement;
        return { value: input.value, defaultValue: input.defaultValue, attribute: input.getAttribute("value"), inert: !!input.closest("[inert]") };
      }));
      assert.equal(fields.length, 4);
      assert.deepEqual(fields, Array.from({ length: 4 }, () => ({ value: "", defaultValue: "", attribute: null, inert: true })));
    };
    const assertSafeCatalog = (catalog: any[]) => {
      assert.doesNotMatch(JSON.stringify(catalog), /(?:attribute|typed|nested|direct)-secret/);
      assert.equal(catalog.find((e) => e.label === "API key")?.value, "Entered");
      assert.equal(catalog.find((e) => e.label === "Empty key")?.value, "");
      assert.equal(catalog.find((e) => e.label === "Endpoint")?.value, "https://example.test");
    };
    await assertSafeCopies("first");
    assertSafeCatalog(await page.evaluate(() => (window as any).scribeSettingsUI.catalog()));
    await publication;
    assertSafeCatalog(published.at(-1).settings);
    setSettingsCatalog(published.at(-1));
    assert.doesNotMatch(findSettings(undefined), /(?:attribute|typed|nested|direct)-secret/);

    await page.evaluate(() => (window as any).view.close());
    await page.waitForSelector("#first #key");
    assert.equal(await page.locator("#first #key").inputValue(), "typed-secret");
    await page.evaluate(() => (window as any).addCard("second")); // Transfers the live nodes.
    await assertSafeCopies("first");
    assert.equal(await page.locator("#second #key").inputValue(), "typed-secret");
    assertSafeCatalog(await page.evaluate(() => (window as any).scribeSettingsUI.catalog()));
    await page.evaluate(() => (window as any).view.open()); // Returns them to the dialog.
    await assertSafeCopies("second");
    assert.equal(await page.locator("#panel #key").inputValue(), "typed-secret");
    assert.equal(await page.locator("#panel #direct").inputValue(), "direct-secret");
  } finally {
    await browser.close();
  }
});

test("a chat card shows the dialogs' own rows under their headings and hands them back", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Settings in chat test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    const published: any[] = [];
    await page.route("http://settings.test/**", async (route) => {
      const req = route.request();
      if (req.url().endsWith("/api/settings/index")) {
        published.push(req.postDataJSON());
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({
        contentType: "text/html",
        body: `<div class="settings" hidden><div class="settings-backdrop"></div>
          <div class="settings-panel" id="panel"><h2 class="settings-title" id="t">Settings</h2>
            <section class="settings-section" id="tabs"><h3>Tabs</h3>
              <div class="setting-row"><span>Smooth scrolling</span><button type="button" class="pill-toggle" id="smooth" role="switch" aria-checked="true"></button></div>
              <div class="setting-row"><span>Clear button</span><button type="button" class="pill-toggle" role="switch" aria-checked="false"></button></div>
            </section>
            <section class="settings-section"><h3>Links <button type="button">?</button></h3>
              <div class="setting-row"><span data-hint="How links open">Links open as</span><div class="button-track"><button aria-pressed="true">Tab</button><button aria-pressed="false">Peek</button></div></div>
              <p class="settings-hint settings-hint-after">Hold Ctrl to navigate.</p>
            </section>
          </div></div><main id="chat"></main>`,
      });
    });
    await page.goto("http://settings.test/");
    await page.addScriptTag({ content: "window.__name = (fn) => fn; window.scribeMotion = { enabled: () => false };" });
    await page.addScriptTag({ content: fs.readFileSync(new URL("../../public/settings-ui.js", import.meta.url), "utf8") });
    await page.evaluate(() => {
      const w = window as any;
      w.flips = 0;
      document.getElementById("smooth")!.addEventListener("click", (e) => {
        w.flips++;
        const b = e.currentTarget as HTMLElement;
        b.setAttribute("aria-checked", String(b.getAttribute("aria-checked") !== "true"));
      });
      const sections = [...document.querySelectorAll("#panel > .settings-section")];
      w.view = w.scribeSettingsUI.mount(document.getElementById("panel"), [
        { label: "Navigation", sections: [sections[0]] },
        { label: "Links", sections: [sections[1]] },
      ], { close: () => w.scribeSettingsUI.close() });
    });

    const catalog = await page.evaluate(() => (window as any).scribeSettingsUI.catalog());
    assert.deepEqual(catalog.map((e: any) => e.id), ["general/tabs", "general/tabs/smooth-scrolling", "general/tabs/clear-button", "general/links", "general/links/links-open-as"]);
    assert.deepEqual(catalog[4], { dialog: "Settings", category: "Links", section: "Links", id: "general/links/links-open-as", kind: "row", label: "Links open as", hint: "How links open", control: "choice", options: ["Tab", "Peek"], value: "Tab" });
    assert.equal(catalog[1].value, "on");

    // Asked for out of order: shown in the dialogs' order, each under its own heading.
    const card = () => page.evaluate(() => {
      const root = document.querySelector("#chat .settings-lent")!;
      return [...root.querySelectorAll(".settings-section")].map((s) => [...s.children].map((c) => `${c.tagName}${(c as HTMLElement).inert ? "(copy)" : ""}:${c.textContent!.trim()}`));
    });
    const lent = await page.evaluate(() => {
      const root = document.createElement("div");
      document.getElementById("chat")!.append(root);
      return (window as any).scribeSettingsUI.lend(root, ["general/links/links-open-as", "general/tabs/smooth-scrolling", "gone/away"]).missing;
    });
    assert.deepEqual(lent, ["gone/away"]);
    assert.deepEqual(await card(), [["H3:Tabs", "DIV:Smooth scrolling"], ["H3:Links ?", "DIV:Links open asTabPeek", "P:Hold Ctrl to navigate."]]);

    // The real control, with its own handler, is in the chat.
    await page.locator("#chat [role=switch]").click();
    assert.equal(await page.evaluate(() => (window as any).flips), 1);
    assert.equal(await page.locator("#smooth").getAttribute("aria-checked"), "false");
    assert.equal(await page.evaluate(() => document.querySelector("#tabs")!.contains(document.getElementById("smooth"))), false);

    // Opening the dialog brings the rows home; the card keeps still copies until it is closed again.
    await page.evaluate(() => (window as any).view.open());
    assert.equal(await page.evaluate(() => document.querySelector("#tabs")!.contains(document.getElementById("smooth"))), true);
    assert.deepEqual((await card())[0], ["H3(copy):Tabs", "DIV(copy):Smooth scrolling"]);
    assert.equal(await page.locator("#chat [role=switch]").getAttribute("aria-checked"), "false");
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("#tabs .setting-row")].length), 2);
    await page.evaluate(() => (window as any).view.close());
    await page.waitForFunction(() => document.querySelector("#chat #smooth"));

    // A card that leaves the page gives its rows back.
    await page.evaluate(() => document.getElementById("chat")!.replaceChildren());
    await page.waitForFunction(() => document.querySelector("#tabs #smooth"));
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#tabs .setting-row span")].map((s) => s.textContent)), ["Smooth scrolling", "Clear button"]);

    // A change sends the list again, with the new value.
    await page.locator("#smooth").evaluate((b: HTMLElement) => b.click());
    await page.waitForFunction(() => true);
    await page.waitForTimeout(1700);
    assert.equal(published.at(-1)?.settings.find((e: any) => e.id === "general/tabs/smooth-scrolling")?.value, "on");
  } finally {
    await browser.close();
  }
});
