import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "../chromium.js";

test("save picker browses the parent of a new file and preserves it when replacing the filename", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Save picker regression test" });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const requests: string[] = [];
    await page.route("http://picker.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname !== "/api/files/list") return route.fulfill({ contentType: "text/html", body: "<body></body>" });
      const dir = (url.searchParams.get("path") || "").replace(/\\$/, "");
      requests.push(dir);
      await route.fulfill({ json: {
        path: dir, parent: "C:\\", exists: true,
        dirs: dir === "C:\\notes" ? [{ name: "drafts", path: "C:\\notes\\drafts" }] : [],
        files: [{ name: "existing.md", path: `${dir}\\existing.md` }],
      } });
    });
    await page.goto("http://picker.test/");
    const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    const picker = source.slice(source.indexOf("  function pickWorkspace("), source.indexOf("  /* ---------- Hook rules"));
    await page.addScriptTag({ content: `
      const modalStack = [];
      const prefs = () => ({ recentWorkspaces: ["C:/recent"] });
      const el = (tag, cls, text) => {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text) node.textContent = text;
        return node;
      };
      const modal = () => {
        const panel = el("div"); document.body.append(panel);
        modalStack.push(() => {});
        return { panel, close: () => { panel.remove(); modalStack.pop(); } };
      };
      const button = (text, cls, click) => { const node = el("button", cls, text); node.onclick = click; return node; };
      const icon = () => el("span");
      ${picker}
      window.openPicker = (initial) => { window.result = undefined; pickWorkspace(initial, { files: "save", title: "New file", action: "Create" }).then(value => window.result = value); };
    ` });
    for (const initial of ["C:\\notes\\Untitled.md", "C:/notes/Untitled.md", "C:\\Untitled.md", "/Untitled.md"]) {
      await page.evaluate(value => (window as any).openPicker(value), initial);
      const input = page.getByRole("textbox", { name: "File name" });
      await page.locator(".ag-ws-file").waitFor();
      assert.equal(await input.inputValue(), "Untitled.md");
      assert.ok(!requests.at(-1)?.includes("Untitled.md"));
      await input.fill("replacement.md");
      await input.press("Enter");
      await page.waitForFunction(() => (window as any).result !== undefined);
      const result = await page.evaluate(() => (window as any).result as string);
      assert.equal(result.replace(/\\/g, "/"), initial.replace(/\\/g, "/").replace("Untitled.md", "replacement.md"));
    }
    await page.evaluate(() => (window as any).openPicker("C:\\notes\\Untitled.md"));
    await page.getByRole("button", { name: "drafts", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".ag-ws-cur")?.textContent === "C:\\notes\\drafts");
    const input = page.getByRole("textbox", { name: "File name" });
    assert.equal(await input.inputValue(), "Untitled.md");
    await input.fill("");
    await input.press("Enter");
    assert.equal(await page.evaluate(() => (window as any).result), undefined);
    await input.fill("renamed.md");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForFunction(() => (window as any).result !== undefined);
    assert.equal(await page.evaluate(() => (window as any).result), "C:\\notes\\drafts\\renamed.md");
  } finally { await browser.close(); }
});
