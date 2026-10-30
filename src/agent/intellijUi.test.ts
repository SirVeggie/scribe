import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "../chromium.js";
import { loadShellScripts } from "../testSupport/shell.js";

const source = (name: string) => fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8");

test("IntelliJ settings persist, and diff and code reference actions show for project files and send the source and position", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "IntelliJ integration UI test" });
  try {
    const page = await browser.newPage();
    let settings = { enabled: false, launcher: "" };
    const opened: Record<string, unknown>[] = [];
    const checked: string[] = [];
    await page.route("http://intellij.test/**", route => {
      const req = route.request();
      if (new URL(req.url()).pathname.endsWith("/projects")) {
        const paths: string[] = req.postDataJSON().paths;
        checked.push(...paths);
        return route.fulfill({ json: { files: Object.fromEntries(paths.map(p => [p, !p.startsWith("plain")])) } });
      }
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
    // Chat markdown renders through the shared renderer, so code references need marked and scribe-md.
    await loadShellScripts(page, { scripts: ["integrations.js", "/vendor/marked.js", "/vendor/purify.js", "/vendor/scribe-md.js", "agent-render.js"] });
    await page.evaluate(async () => {
      const w = window as any;
      document.body.replaceChildren(...w.scribeIntegrations.sections);
      await w.scribeIntegrations.refresh();
      const head = document.createElement("div");
      const file = { path: "src/hello ü.ts", lines: [{ kind: "ctx", oldNo: 41, newNo: 42, text: "hello" }], added: 0, removed: 0 };
      const diff = w.AgentRender.renderDiffFile(file);
      w.scribeIntegrations.decorateDiff(head, diff, { repo: "worktree", from: "before", to: "after" }, file, (message: string) => document.body.dataset.error = message);
      document.body.append(head, diff);
      // Not in an IntelliJ project: no actions.
      const plainHead = document.createElement("div");
      plainHead.id = "plain";
      w.scribeIntegrations.decorateDiff(plainHead, null, { repo: "worktree", from: "before", to: "after" }, { path: "plain.txt", lines: [] }, () => {});
      document.body.append(plainHead);
      // A chat's code reference opens its file at the first line.
      const md = document.createElement("div");
      md.className = "ag-md";
      document.body.append(md);
      w.AgentRender.renderMarkdown(md, ["```12:14:src/ref.ts", "const a = 1;", "```", "", "```ts", "plain fence", "```"].join("\n"), Object.fromEntries([
        // As an array entry, so the bundler does not name the function (page code has no __name).
        ["codeRef", (refHead: HTMLElement, ref: unknown) => w.scribeIntegrations.decorateRef(refHead, () => ({ threadId: "t1", workspace: true }), ref, () => {})],
      ]));
    });
    assert.equal(await page.getByRole("button", { name: "Open diff", exact: true }).isVisible(), false);
    await page.getByRole("switch", { name: "IntelliJ IDEA" }).click();
    await page.getByRole("button", { name: "Open diff", exact: true }).waitFor();
    await page.locator(".ag-code-open button").waitFor();
    assert.equal(await page.locator("#plain .ag-intellij-actions").isVisible(), false);
    assert.equal(await page.locator(".ag-code-open").count(), 1, "only the code reference gets the action");
    assert.deepEqual(checked.sort(), ["plain.txt", "src/hello ü.ts", "src/ref.ts"]);
    await page.getByLabel("Launcher path", { exact: true }).fill("C:\\IDE path\\idea64.exe");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => !(document.querySelector("#intellij-save") as HTMLButtonElement).disabled);
    assert.equal(settings.launcher, "C:\\IDE path\\idea64.exe");
    await page.locator(".ag-dl-text").evaluate(node => {
      const selection = window.getSelection()!;
      selection.collapse(node.firstChild, 4); // prefix + 3 text characters = column 4
      node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.locator(".ag-intellij-actions:not(.ag-code-open)").getByRole("button", { name: "Open in IntelliJ", exact: true }).click();
    await page.getByRole("button", { name: "Open diff", exact: true }).click();
    await page.locator(".ag-code-open").getByRole("button", { name: "Open in IntelliJ", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".ag-intellij-actions button")].every(b => !(b as HTMLButtonElement).disabled));
    assert.deepEqual(opened.map(req => ({ ...req })), [
      { repo: "worktree", from: "before", to: "after", path: "src/hello ü.ts", mode: "file", line: 42, column: 4 },
      { repo: "worktree", from: "before", to: "after", path: "src/hello ü.ts", mode: "diff", line: 42, column: 4 },
      { threadId: "t1", workspace: true, path: "src/ref.ts", mode: "file", line: 12, column: 1 },
    ]);
    await page.getByRole("switch", { name: "IntelliJ IDEA" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".ag-intellij-actions")].every(node => (node as HTMLElement).hidden));
    assert.equal(settings.enabled, false);
  } finally { await browser.close(); }
});
