import { templateHtml } from "./testSupport/templates.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";

test("Format rewrites a card's description with a tool-less Haiku chat, and Undo puts it back", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Kanban Format test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent(`<script>
      window.starts = [];
      window.deleted = [];
      window.scribe = {
        id: 'board', title: 'Board', local: {},
        state: {
          columns: [{ id: 'todo', title: 'Todo' }], labels: [], nextNum: 2, settings: {},
          cards: [{ id: 'c1', num: 1, col: 'todo', title: 'Idea', description: 'one long block. second thought', comments: [], createdAt: 1, movedAt: 1 }]
        },
        set(patch) { this.state = { ...this.state, ...patch }; if (this.changed) queueMicrotask(() => this.changed(this.state, { source: 'local' })); },
        update() {},
        setLocal(patch) { Object.assign(this.local, patch); },
        onChange(fn) { this.changed = fn; },
        signal() {},
        agent: {
          options: async () => ({ ok: true, providers: ['claude'], models: { claude: [{ id: 'haiku', label: 'Haiku', efforts: [] }, { id: 'opus', label: 'Opus', efforts: [{ id: 'low' }] }] } }),
          get: async () => ({ ok: true, thread: { status: 'idle' } }), onChange() {}, onSteps() {}, steps: async () => ({ ok: true, steps: [] }),
          start: async (prompt, opts) => { window.starts.push({ prompt, opts }); return { ok: true, threadId: 't1' }; },
          wait: async () => ({ ok: true, reply: '\`\`\`markdown\\none long block.\\n\\nsecond thought\\n\`\`\`' }),
          delete: async (id) => { window.deleted.push(id); return { ok: true }; }
        }
      };
    </script>` + templateHtml("kanban"));
    await page.locator('.card[data-id="c1"] .card-title').click();
    await page.getByRole("button", { name: "Format", exact: true }).click();
    await page.getByRole("button", { name: "Undo format", exact: true }).waitFor();
    const s = await page.evaluate(() => ({ starts: (window as any).starts, deleted: (window as any).deleted, desc: (window as any).scribe.state.cards[0].description }));
    assert.equal(s.desc, "one long block.\n\nsecond thought");
    assert.equal(s.starts.length, 1);
    assert.equal(s.starts[0].opts.tools, false);
    assert.equal(s.starts[0].opts.temporary, true);
    assert.equal(s.starts[0].opts.provider, "claude");
    assert.equal(s.starts[0].opts.model, "haiku");
    assert.match(s.starts[0].prompt, /one long block\. second thought$/);
    assert.deepEqual(s.deleted, ["t1"]);
    await page.getByRole("button", { name: "Undo format", exact: true }).click();
    await page.getByRole("button", { name: "Format", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => (window as any).scribe.state.cards[0].description), "one long block. second thought");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
