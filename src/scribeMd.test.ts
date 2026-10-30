import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const SCRIPTS = [
  read("../node_modules/marked/lib/marked.umd.js"),
  read("../node_modules/dompurify/dist/purify.min.js"),
  read("../templates/scribe-md.js"),
];

test("the shared markdown renderer handles Scribe's syntax and controls", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Shared markdown renderer test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent("<!DOCTYPE html><body></body>");
    for (const content of SCRIPTS) await page.addScriptTag({ content });
    const render = (src: string, opts: Record<string, unknown> = {}) =>
      page.evaluate(([s, o]) => {
        const md = (window as any).ScribeMd;
        const extra = o as any;
        return md.render(s, {
          ...extra,
          card: extra.cards ? (n: number) => (extra.cards.includes(n) ? { id: "c" + n } : null) : undefined,
          image: extra.images ? (u: string) => (u.startsWith("#img-") ? extra.images[u.slice(5)] || "" : "") : undefined,
        });
      }, [src, opts] as const);

    // Page links in every form, and a key on its own.
    let html = await render("See [[scribe:notes]], [[peek:scribe:a|A]], [B](split:scribe:b), [C](scribe:c) and scribe:d.");
    assert.match(html, /<a href="#" class="page-link" data-scribe-open="scribe:notes"><\/a>/);
    assert.match(html, /data-scribe-open="scribe:a" data-scribe-mode="peek">A<\/a>/);
    assert.match(html, /data-scribe-open="scribe:b" data-scribe-mode="split">B<\/a>/);
    assert.match(html, /data-scribe-open="scribe:c">C<\/a>/);
    assert.match(html, /data-scribe-open="scribe:d"><\/a>\./);
    // Threads, and pages, cards and threads on another device (#908).
    html = await render("[[thread:th_1]], [[scribe:@laptop/plan]], [T](thread:@laptop/th_2), scribe:@work-laptop/board#card=12 here");
    assert.match(html, /data-scribe-open="thread:th_1"><\/a>/);
    assert.match(html, /data-scribe-open="scribe:@laptop\/plan"><\/a>/);
    assert.match(html, /data-scribe-open="thread:@laptop\/th_2">T<\/a>/);
    assert.match(html, /data-scribe-open="scribe:@work-laptop\/board#card=12"><\/a> here/);
    html = await render("[[file:C:\\notes\\a.png]] and `scribe:code` and a/scribe:x and wordscribe:y");
    assert.match(html, /data-scribe-open="file:C:\\notes\\a.png"/);
    assert.match(html, /<code>scribe:code<\/code>/);
    assert.doesNotMatch(html, /scribe:[xy]"/);

    // Card links only for cards that exist; images through the caller.
    html = await render("Blocked by #12 and #99 (#12)", { cards: [12] });
    assert.equal((html.match(/data-card="c12"/g) || []).length, 2);
    assert.doesNotMatch(html, /c99/);
    html = await render("![shot](#img-im_1) ![gone](#img-x) ![web](https://e.test/a.png)", { images: { im_1: "/blob/pa_aaaaaaaaaaaaaaaaaaaaaaaa" } });
    assert.match(html, /<img src="\/blob\/pa_a{24}" alt="shot">/);
    assert.doesNotMatch(html, /gone/, "a missing image is left out");
    assert.doesNotMatch(html, /e\.test/, "the caller's resolver decides");

    // Raw HTML is text unless asked for; scripts never survive.
    html = await render("Use a <div> here <script>alert(1)</script>");
    assert.match(html, /&lt;div&gt;/);
    html = await render("<b>bold</b><img src=x onerror=alert(1)>", { html: true });
    assert.match(html, /<b>bold<\/b>/);
    assert.doesNotMatch(html, /onerror/);

    // Line breaks within a paragraph, web links open outside, other links are text.
    html = await render("one\ntwo [w](https://e.test) [r](./rel.md) [j](javascript:alert(1))");
    assert.match(html, /one<br>two/);
    assert.match(html, /<a href="https:\/\/e.test" target="_blank" rel="noopener">w<\/a>/);
    assert.doesNotMatch(html, /rel\.md|javascript/);

    // Task lists: each checkbox knows its line, nested lists nest, tables and code get their wrappers.
    const src = "# Plan\n\n- [ ] parent\n  - [x] child one\n  - [ ] child two\n- plain\n\n```js\nlet a = 1;\n```\n\n| a | b |\n|---|:-:|\n| 1 | 2 |";
    html = await render(src, { tasks: true });
    assert.deepEqual([...html.matchAll(/data-line="(\d+)"/g)].map((m) => Number(m[1])), [2, 3, 4]);
    assert.match(html, /<li class="task"><input[^>]*class="task-box"/);
    assert.doesNotMatch(html, /disabled/);
    assert.match(html, /<div class="code-block"><button type="button" class="code-copy">Copy<\/button><pre><code class="language-js">/);
    assert.match(html, /<div class="table-wrap"><table>/);
    assert.match(await render(src), /disabled/, "read-only unless tasks");

    // Ticking: sub-items follow their parent, and a parent follows its sub-items.
    const toggle = (s: string, line: number) => page.evaluate(([a, b]) => (window as any).ScribeMd.toggleTask(a, b), [s, line] as const);
    assert.equal(await toggle(src, 2), src.replace("- [ ] parent", "- [x] parent").replace("- [ ] child two", "- [x] child two"));
    assert.equal(await toggle(src, 4), src.replace("- [ ] parent", "- [x] parent").replace("- [ ] child two", "- [x] child two"));
    assert.equal(await toggle(src, 3), src.replace("- [x] child one", "- [ ] child one"));
    assert.equal(await toggle(src, 0), null);

    // Notes and cards go line by line: a plain line ends the list or quote above it, "---" is a rule,
    // and one tilde is not a strike. A file keeps markdown's own reading.
    const lazy = "Buttons:\n- [ ] one\n- [ ] two\nRemove these:\n- [ ] three\n> quote\nafter\ntext\n---\n~/.claude.json, its entries~";
    html = await render(lazy, { tasks: true });
    assert.equal((html.match(/<ul>/g) || []).length, 2);
    assert.deepEqual([...html.matchAll(/data-line="(\d+)"/g)].map((m) => Number(m[1])), [1, 2, 4]);
    assert.match(html, /<\/ul>\s*<p>Remove these:<\/p>/);
    assert.match(html, /<\/blockquote>\s*<p>after<br>text<\/p>\s*<hr>/);
    assert.match(html, /~\/\.claude\.json, its entries~/);
    assert.match(await render("a ~~gone~~"), /<del>gone<\/del>/);
    assert.equal((await render(lazy, { breaks: false })).match(/<ul>/g)?.length, 1);
    const offsets = await page.evaluate((s) => (window as any).ScribeMd.blocks(s, {}).map((b: any) => s.slice(b.start, b.end)), "- a\nplain\n> q\nz");
    assert.deepEqual(offsets, ["- a", "plain", "> q", "z"]);

    // Blocks carry their offsets in the text.
    const blocks = await page.evaluate((s) => (window as any).ScribeMd.blocks(s, {}).map((b: any) => s.slice(b.start, b.end)), "# A\n\npara\nmore\n\n- x\n");
    assert.deepEqual(blocks, ["# A", "para\nmore", "- x"]);

    // The chat (public/agent-render.js) reads the same syntax and draws its own links.
    // A script tag, not page.evaluate: tsx would name the helpers with a __name the page doesn't have.
    await page.addScriptTag({ content: read("../public/agent-render.js") });
    await page.addScriptTag({
      content: `window.chat = function (s, streaming) {
        var R = window.AgentRender, box = document.createElement("div");
        var ctx = { resolvePages: function (keys) { var out = {}; keys.forEach(function (k) { if (k === "scribe:notes") out[k] = { title: "Notes" }; }); return out; } };
        if (streaming) [5, 20, s.length].forEach(function (end) { R.renderMarkdownStream(box, s.slice(0, end), ctx); });
        else R.renderMarkdown(box, s, ctx);
        return box.innerHTML;
      };`,
    });
    const chat = (src: string, stream = false) => page.evaluate(([s, streaming]) => (window as any).chat(s, streaming), [src, stream] as const);
    const links = "[[scribe:notes]], [[peek:scribe:a|A]], [B](split:scribe:b), [F](file:///C:/a.png), [O](board:scribe:old), scribe:gone and ~/.x~ [w](https://e.test)";
    for (const stream of [false, true]) {
      html = await chat(links, stream);
      assert.match(html, /<a class="ag-board-link" data-board-target="scribe:notes" tabindex="0">Notes<\/a>/);
      assert.match(html, /data-board-target="scribe:a" data-board-mode="peek" tabindex="0">A<\/a>/);
      assert.match(html, /data-board-target="scribe:b" data-board-mode="split" tabindex="0">B<\/a>/);
      assert.match(html, /data-board-target="file:\/\/\/C:\/a.png" tabindex="0">F<\/a>/);
      assert.match(html, /data-board-target="scribe:old" tabindex="0">O<\/a>/);
      assert.match(html, /class="ag-board-link missing" data-board-target="scribe:gone" tabindex="0">scribe:gone<\/a>/);
      assert.match(html, /~\/\.x~/);
      assert.match(html, /<a href="https:\/\/e.test" rel="noopener" class="ag-web-link" data-web-href="https:\/\/e.test">w<\/a>/);
      assert.doesNotMatch(html, /data-scribe-open|page-link/);
    }
    html = await chat("one\ntwo\n\n- [x] done\n\n```ts\nlet a = 1;\n```\n\n<b>b</b><script>alert(1)</script>");
    assert.match(html, /<p>one\ntwo<\/p>/, "standard markdown: one newline is not a break");
    assert.match(html, /<li class="task"><input[^>]*disabled[^>]*class="task-box"|<li class="task"><input[^>]*class="task-box"[^>]*disabled/);
    assert.match(html, /class="ag-code"/);
    assert.match(html, /<b>b<\/b>/);
    assert.doesNotMatch(html, /<script/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
