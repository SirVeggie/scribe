import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "../chromium.js";

const source = (name: string) => fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8");

test("IntelliJ settings persist and diff actions send the selected source and caret position", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "IntelliJ integration UI test" });
  try {
    const page = await browser.newPage();
    let settings = { enabled: false, launcher: "" };
    const opened: Record<string, unknown>[] = [];
    await page.route("http://intellij.test/**", route => {
      const req = route.request();
      if (new URL(req.url()).pathname.endsWith("/open")) {
        opened.push(req.postDataJSON());
        return route.fulfill({ json: { ok: true } });
      }
      if (req.method() === "PUT") settings = req.postDataJSON().intellij;
      return route.fulfill({ json: { intellij: settings } });
    });
    await page.goto("http://intellij.test/");
    await page.addStyleTag({ content: source("app.css") });
    await page.addStyleTag({ content: source("agent.css") });
    await page.addScriptTag({ content: source("integrations.js") });
    await page.addScriptTag({ content: source("agent-render.js") });
    await page.evaluate(async () => {
      const w = window as any;
      document.body.replaceChildren(...w.scribeIntegrations.sections);
      await w.scribeIntegrations.refresh();
      const head = document.createElement("div");
      const file = { path: "src/hello ü.ts", lines: [{ kind: "ctx", oldNo: 41, newNo: 42, text: "hello" }], added: 0, removed: 0 };
      const diff = w.AgentRender.renderDiffFile(file);
      w.scribeIntegrations.decorateDiff(head, diff, { repo: "worktree", from: "before", to: "after" }, file, (message: string) => document.body.dataset.error = message);
      document.body.append(head, diff);
    });
    assert.equal(await page.getByRole("button", { name: "Open diff", exact: true }).isVisible(), false);
    await page.getByRole("switch", { name: "IntelliJ IDEA" }).click();
    await page.getByRole("button", { name: "Open diff", exact: true }).waitFor();
    await page.getByLabel("Launcher path", { exact: true }).fill("C:\\IDE path\\idea64.exe");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => !(document.querySelector("#intellij-save") as HTMLButtonElement).disabled);
    assert.equal(settings.launcher, "C:\\IDE path\\idea64.exe");
    await page.locator(".ag-dl-text").evaluate(node => {
      const selection = window.getSelection()!;
      selection.collapse(node.firstChild, 4); // prefix + 3 text characters = column 4
      node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Open in IntelliJ", exact: true }).click();
    await page.getByRole("button", { name: "Open diff", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".ag-intellij-actions button")].every(b => !(b as HTMLButtonElement).disabled));
    assert.deepEqual(opened.map(req => ({ ...req })), [
      { repo: "worktree", from: "before", to: "after", path: "src/hello ü.ts", mode: "file", line: 42, column: 4 },
      { repo: "worktree", from: "before", to: "after", path: "src/hello ü.ts", mode: "diff", line: 42, column: 4 },
    ]);
    await page.getByRole("switch", { name: "IntelliJ IDEA" }).click();
    await page.locator(".ag-intellij-actions").waitFor({ state: "hidden" });
    assert.equal(settings.enabled, false);
  } finally { await browser.close(); }
});
