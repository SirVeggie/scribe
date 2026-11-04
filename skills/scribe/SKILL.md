---
name: scribe
description: Build or change pages in Scribe, the user's local page viewer (page_show / page_patch on the scribe MCP): investigation results, analyses, design options, comparisons and other structured visual HTML, forms that ask the user, and interactive pages with their own scripts. Prefer it over workspace .html files and the host's own canvas or artifact features unless the user asked for those. Not needed to find, read or search pages, or to work a Kanban board or Todo list through page_action; the tool descriptions and the page's guide cover those.
---

# Scribe

Scribe is the user's local tabbed HTML viewer, driven by the `scribe` MCP (`page_*` tools). Put visual output there instead of writing one-off HTML files into the workspace. If your host defers MCP tools, load the `page_*` tools you need with tool search first.

This file has the rules for building and changing pages. Read a file beside it when the task needs it (`skill_read` with `file`, or `scribe_docs` with its name):

| Read | When |
|---|---|
| `PAGE-SCRIPTS.md` | The page has its own script: `window.scribe` state, `bind`, `onChange`, signals and `page_wait`, page assets, `scribe.preview`, `scribe.reply` in your own markup. |
| `PAGE-AGENT.md` | The page starts or drives agent chats (`scribe.agent`): prompts, model pickers, usage limits, agent runs. |
| `PAGE-SERVICES.md` | The page uses the microphone (`scribe.audio`), the classifier (`scribe.ml`) or files in a folder (`scribe.files`). |
| `LARGE-PAGES.md` | A page over 24 KB: reading a window, grep, line edits, building it in parts, checking it out to a file. |
| `TESTING.md` | Screenshots of a design for the current project (`page_screenshot`), or clicking through a page in your browser (`browser_*`). |
| `TEMPLATES.md` | Only when the user asked to create or change a Scribe template. |
| `PLUGINS.md` | Building or editing a page plugin. |

## When to use it

Use Scribe for standalone visual output: investigation results, analyses, design options, architecture notes, tables that should stay on screen, walkthroughs. Skip it for code edits, short factual answers, drafts meant to be copied, or when the user asked for another artifact.

Put a page up and stop. Do not screenshot information pages to tweak their layout or type: `page_screenshot` is only for designs that belong to the current project (`TESTING.md`). After a page is up, answer small follow-ups in chat; change the page only when the user asked for it or the new material belongs there.

## Library model

The **Library** holds every page, in folders and an order the user owns: never move or reorder pages. The tab strip is the pages currently **open**; closing a tab keeps the page, only a delete removes it. A folder's **Agent instructions** (right-click the folder) reach threads scoped to that folder or a page in it.

## Find a page

- **A pasted key** (`scribe:sprint-notes`): pass it as `key` to `page_read`, `page_patch`, `page_state`, … as is; it works for open and closed pages. A page id (`t_1a2b3c4d`) goes in `id`.
- **By title** (the usual way: "my Jira page"): `page_list` lists the open tabs; if the page is not there and `closedCount` > 0, use `library_search`. Never guess a key.
- **By content**: `library_search({ query })` with 1–3 distinctive words (`jira`, `clims-18595`), not the whole sentence. It searches the title, key, text and JSON state of every page. With semantic search on, `mode: "semantic"` finds by meaning (a card on some board, a section deep in a page).
- Page through results (default 20, max 50); do not dump the Library into context.

`page_read` returns the HTML as its own unescaped text block after the metadata: copy `oldString`s from it verbatim. A page over 24 KB comes back as an outline instead (`LARGE-PAGES.md`).

## Show or update

Before you write HTML or call `page_show` / `page_patch`, say in a line that Scribe is being updated, so the pause does not look like a stall.

**Create or rewrite** with one `page_show`:

- `key`: a stable slug for this page (`clims-12345-analysis`, stored as `scribe:clims-12345-analysis`). Reuse it only for in-place edits of the same page.
- `title`: a short tab label. A result with `titleKept: true` means the user renamed the page: keep their title.
- `html`: a fragment (preferred: Scribe wraps it in its dark theme and page kit) or a complete document with inline CSS. `htmlPath` passes a local file instead (in Code mode a temp file, not the workspace).
- `background: true`: when the user said not to switch tabs, or for a page you will link to (a form, evidence, an investigation) rather than put in front of them. A new background page goes to the Library without a tab.
- `pin`: only for pages the user keeps using (a todo list, a tool); never for one-off reports, designs or forms.
- `folder`: for a new page, check `library_folders` and pass an existing path when the page clearly belongs there; a new path only when the user asked for one.
- `assets` for images (see Images); `state` seeds page state (only when the page has none yet); `base` builds on a starter page the user names (your `html` fills its `data-slot` element, else its `<main>`, else its `<body>`).

| User said | Call | Result |
| --- | --- | --- |
| show me / put it in Scribe | `page_show` | Focused; a closed page is opened. |
| a form or evidence page to link to | `page_show` with `background: true` | In the Library, not on the strip. |
| update it in the background | `page_show` / `page_patch` with `background: true` | An open tab gets an unread blip; a closed page stays closed. |
| tweak a section, fix a line | `page_patch` | Changes only those snippets. |
| a small follow-up question | nothing: answer in chat | |
| bring it back | `page_open` | Focused. |
| change todos, cards, notes | `page_action` if the page has actions, else `page_update` | Never focuses. |

Mention the tab title in chat; when a result has `open: false`, say the unread blip is on Library. Do not paste the HTML into chat.

`page_show` and HTML-changing `page_patch` check the first render: fix any `problems` they return.

### Patch an existing page

```
page_patch({ key: "clims-12345-analysis", edits: [
  { oldString: "<p>Status: in progress</p>", newString: "<p>Status: ready</p>" },
  { oldString: "</section>", newString: "<h2>Next</h2><p>Ship it.</p></section>" }
] })
```

- `oldString` is an exact substring of the stored HTML. For a fragment page, match the body you wrote, not the wrapper. It must match once: add context, or pass `replaceAll: true`.
- Edits apply in order, all or nothing. A failed edit quotes where the stored text diverged: fix the snippet from that, do not guess again.
- Do not `page_read` first when the markup is still in the conversation. Pass `expectedRevision` when the user may have changed the page since.
- It does not create pages or change state: use `page_show` for a new page, new `assets` or seeded `state`.

### Updating vs replacing

Edits, additions and improvements to a page are fine. Do not replace all or most of a page, or replace it with a continuation, without asking: the user loses what they may want to look back at. For a continuation, close the old tab (`page_close` keeps it in the Library) and show a new page under a new key.

## HTML

- Self-contained, with inline CSS. Workspace paths and `file://` images do not load; use `assets`.
- A full document starts with `<!DOCTYPE html>` or `<html`. Pages render in an iframe, so the parent's styles do not apply.
- Keep pages well under 200 KB (hard limit 2 MB; assets do not count).

### Theme

Fragment pages are wrapped in a **dark** theme: `color-scheme: dark`, the body already `background: var(--bg); color: var(--text)`, and these variables on `:root`:

- `--bg`: page background
- `--text`: body text
- `--muted`: secondary text (or the `.muted` class)
- `--border`: rules and table borders
- `--accent`: links
- `--code-bg`: `code` and `pre`

Do not hardcode light-theme colors (`#222`, `black`) or fall back to them (`var(--fg, #222)`: `--fg` is not defined). A full document skips the wrapper: copy the same `:root` block, or set background and color so they contrast.

### Page kit: elements and form wiring

Fragment pages get Scribe's page kit: form wiring with no script, themed fields and buttons, and elements for the parts that need behavior: `<s-question>` for questions, `<s-options>` to compare options and let the user pick one, `<s-mock>` for UI mock-ups, `<s-code>` for code with a Copy button. The kit has no boxes, cards or badges: give the page its own look with your own `<style>`. Its elements render into the page itself and every kit rule sits in `:where()`, so your CSS restyles them like your own markup; the `--kit-*` variables on `:root` retheme them all at once.

The kit is not a way to save tokens: a page's HTML is a small share of a chat's cost, so never make a page plainer to keep it short. A design doc, investigation or comparison should be easy to scan: color-code categories and options (your own tags and toned sections, toned table cells), draw the flow or architecture (a `flow` row, or your own inline SVG), and show proposed UI as a mock-up rather than describing it.

**One-click replies.** `<button data-reply="Use option B" data-context='{"option":"B"}'>Choose B</button>` sends the optional JSON object as answers and `data-reply` as the summary through `scribe.reply`. An empty `data-reply` uses the button text. No form or script is needed. All reply buttons in the page are disabled after choosing, and the chosen button is marked; failed delivery allows retry. Invalid `data-context` shows an error without sending. Without `replyTo`, it logs `submitted` with `{ answers, summary }`, like a reply form. The wiring also works in any component host that provides `window.scribe.reply`; that host determines reply routing.

<!-- kit-catalog:start -->
| Write | Gives | Example |
|---|---|---|
| ` form[data-reply] ` | Keeps a local draft and submits named fields through scribe.reply, or a submitted signal without replyTo. | ` <form data-reply><textarea name="notes"></textarea><button type="submit">Send answers</button></form> ` |
| ` <s-question name label type?> / <s-choice value checked?> ` | A question set apart from the text around it, inside a form[data-reply]. With s-choice children it is one choice (type="many" for check boxes); without, a text box (type="line" for one line); type="scale" with min, max, low and high. required and value (the default) work too. | ` <s-question name="approach" label="Which approach?"><s-choice value="a" checked>Patch <small>an hour</small></s-choice><s-choice value="b">Rewrite</s-choice></s-question> ` |
| ` <s-options name? style="--min:…"> / <s-option value label recommended?> ` | Options side by side, each with its own content. With a name, inside a form[data-reply] the user picks one like a radio; outside a form each gets a Choose button that replies at once. Without a name it only compares. | ` <s-options name="plan"><s-option value="a" label="Patch" recommended><p>An hour, low risk.</p></s-option><s-option value="b" label="Rewrite"><p>A day.</p></s-option></s-options> ` |
| ` button[data-reply][data-context] ` | Sends the summary (button text when empty) and an optional JSON answers object through the host's scribe.reply. | ` <button data-reply="Use option B" data-context='{"option":"B"}'>Choose B</button> ` |
| ` <s-mock label> / <s-mock-row label hint?> / <s-switch on?> ` | A window frame for a UI mock-up, setting rows with the control on the right, and a drawn switch. | ` <s-mock label="Settings"><s-mock-row label="Sync" hint="Every 5 minutes"><s-switch on></s-switch></s-mock-row></s-mock> ` |
| ` [data-new] ` | A dashed outline marking a new or changed part of a mock-up. | ` <s-mock-row label="Theme" data-new><select><option>Dark</option></select></s-mock-row> ` |
| ` <s-code language? file? line? diff?> ` | A code block with a copy icon button, highlighted when language is set, with + and - lines marked when diff is set. With file (relative to the page's workspace), it offers an IntelliJ button when that file is in an IntelliJ project, at line or a diff's first new line. Escape < and & in the code, or put it in a <script type="text/plain"> child. | ` <s-code language="ts" file="src/a.ts">const total = items.length;</s-code> ` |
| ` <scribe-widget plugin="…" name="…" props='{}'></scribe-widget> ` | Embeds a plugin_guide widget in an isolated frame on a page; props follow its schema, calls and live state/events use the page's plugin permission, and replies use the page's replyTo or a reply event. | ` <scribe-widget plugin="git-history" name="activity" props='{}'></scribe-widget> ` |
| ` .lead / .small ` | A muted intro line under the title, or smaller text. | ` <p class="lead">What we found</p><p class="small">Details</p> ` |
| ` .grid; --min ` | Responsive columns; --min sets the minimum column width (240px by default). | ` <div class="grid" style="--min:320px"><section>Findings</section><section>Risks</section></div> ` |
| ` .row ` | A wrapping row of buttons. | ` <div class="row"><button>Back</button><button class="primary">Next</button></div> ` |
| ` .flow ` | A diagram row of toned boxes joined by arrows. | ` <div class="flow"><div>Agent</div><div class="ok">Daemon <small>port 7420</small></div></div> ` |
| ` ol.steps ` | A numbered list with round markers. | ` <ol class="steps"><li>Inspect</li><li>Implement</li></ol> ` |
| ` .ok / .warn / .error / .info / .purple / .teal / .orange / .pink; --tone ` | Shared tones for table cells or rows and flow boxes; --tone accepts any custom color. | ` <table><tr class="warn"><td>Pending</td><td class="ok">Ready</td></tr></table><div class="flow"><div style="--tone:#7fc8c0">Custom</div></div> ` |
| ` dl.kv ` | Key-value rows. | ` <dl class="kv"><dt>Files</dt><dd>12</dd></dl> ` |
| ` ul.pros / ul.cons ` | Lists with plus and minus markers. | ` <ul class="pros"><li>Fast</li></ul><ul class="cons"><li>Limited</li></ul> ` |
| ` button / button.primary / a.button ` | App-style buttons; primary highlights the main action. | ` <button class="primary">Save</button><a class="button" href="https://example.com">Open</a> ` |
| ` input / textarea / select ` | Themed fields, radios and check boxes. | ` <input type="text" name="title"><textarea name="notes"></textarea> ` |
<!-- kit-catalog:end -->

**Forms.** `<form data-reply>` needs no script: Scribe keeps what the user types as their draft, and Submit sends the named fields with `scribe.reply` to the page's `replyTo` (see Forms for a card), check boxes as lists, empty fields left out. On a page without `replyTo` it logs a `submitted` event with `{ answers, summary }` instead. The questions inside it are `<s-question>` elements (each gives its `name` to the answers); plain inputs with a `name` work too.

```html
<form data-reply>
  <p>…the finding the first question is about…</p>
  <s-question name="approach" label="Which approach?">
    <s-choice value="patch" checked>Patch the parser <small>an hour, low risk</small></s-choice>
    <s-choice value="rewrite">Rewrite it <small>a day</small></s-choice>
  </s-question>
  <s-options name="layout">
    <s-option value="tabs" label="Tabs" recommended><p>…mock-up or notes…</p></s-option>
    <s-option value="list" label="One list"><p>…</p></s-option>
  </s-options>
  <s-question name="blocks" type="many" label="Which parts?">
    <s-choice value="api">API</s-choice><s-choice value="ui">UI</s-choice>
  </s-question>
  <s-question name="urgency" type="scale" min="1" max="5" low="whenever" high="now" label="How urgent?"></s-question>
  <s-question name="notes" label="Anything else?" placeholder="Optional"></s-question>
  <button type="submit">Send answers</button>
</form>
```

Put each question next to the part of the page it is about; one form can wrap the whole page. In a Scribe chat, show the form and call `page_ask` on it: your turn resumes with the answers. Elsewhere, `page_wait` on `submitted`.

**Full documents.** A page with its own look can still use the kit: put `<link rel="stylesheet" href="/kit.css">` and `<script src="/kit.js" defer></script>` in its `<head>`. It brings the theme variables (your own `:root` wins), the elements and classes above and the `<form data-reply>` wiring; set the body's own background, color and font.

### Forms for a card

A form you make for a Kanban card (questions, mockup feedback, a review) can hand its answers to the card itself, so its submit button works even after your chat has ended:

```js
page_show({ key: "card-320-questions", html, background: true,
            replyTo: { page: "scribe:agent-todo", card: 320 } })
```

`<form data-reply>` does the rest. The answers become the user's comment on the card (the summary, the answers, a peek link back to the form) and go to the card's chat: into its running turn, or Continue once it has ended. So you can release the card to wait for the answers and end your turn. `page_patch` with `replyTo` (and no edits) wires an existing page; `replyTo: null` clears it. For a submit button in your own markup, see `scribe.reply` in `PAGE-SCRIPTS.md`.

### Page components

Scribe offers ready-made pieces of the app's own UI that a page loads by name with `<script src="/c/<name>.js"></script>`. Use them instead of building these by hand: a page's own dropdown or hand-drawn chart drifts from the app's look. Read a component's guide with `plugin_guide({ id: "core" })` before its first use; it also lists plugins' components (`/c/<plugin>/<name>.js`).

<!-- page-components:start -->
| Load | Gives |
|---|---|
| `<script src="/c/select.js"></script>` | Scribe's own dropdown in place of every native `<select>` on the page. |
| `<script src="/c/chart.js"></script>` | `<s-chart>`: column, bar, line, area and sparkline charts in Scribe's theme, with hover, legend and a table view. |
<!-- page-components:end -->

## Linking pages

The user opens a link as a tab, a **peek** (a card over the page for a quick look) or a **split** (a pane beside it). Links keep related pages connected instead of one page holding everything.

```html
<a data-scribe-open="scribe:clims-12345-analysis">Analysis</a>                              <!-- no mode: the user's setting -->
<a data-scribe-open="scribe:clims-12345-logs" data-scribe-mode="peek">raw logs</a>          <!-- a quick look -->
<a data-scribe-open="scribe:clims-12345-analysis#risks" data-scribe-mode="split">Risks</a>  <!-- beside this page, at id="risks" -->
<a data-scribe-open="scribe:clims-12345-logs"></a>                                         <!-- empty: shows the page's title -->
<a href="https://tauri.app/reference/config/">Tauri config</a>                              <!-- a website: opens the browser -->
```

- Peek for evidence and references, split for pages read side by side, no mode for a page the user should go and work on.
- Link by **key**: ones you chose in `page_show` or found with `page_list` / `library_search`. A link to a missing key is struck through and fixes itself once the page exists, so a hub page may come before its detail pages in the same turn.
- `#anchor` scrolls to that `id`. `#name=value` opens a record instead: `scribe:board-key#card=12` opens card 12 of a Kanban board, `#item=<id>` an item of a Todo list.
- Many websites refuse to show in a peek or split (GitHub, Google, logins): use those modes for docs, not apps. No `target="_blank"` or script navigation.
- The built-in Todo list, Kanban board and Markdown note link pages in their text with `[[scribe:key]]`, `[[scribe:key|text]]`, `[[peek:scribe:key]]`, `[[split:scribe:key]]` or `[text](scribe:key)`; write those in their state, not raw HTML. Chat replies use `[[scribe:key]]` too.
- A file on disk links as `file:` plus its path (`<a href="file:///C:/work/out/shot.png">`, `[[file:C:\work\out\shot.png]]`): it opens as a temporary page that stays out of the Library. Use it to point at images, logs or outputs instead of making a page for each.
- You cannot open a peek or split yourself; links are for the user to follow.

## Images

Local image files go on a page through `assets` on `page_show`, referenced as `asset:<name>`:

```
page_show({ key: "mockup", title: "Mockup", html: `<img src="asset:hero.png" alt="Hero">`,
            assets: [{ path: "C:/Users/me/Pictures/hero.png", name: "hero.png" }] })
```

- `assets` may be plain paths; the name is then the file's basename. Use the names the result lists.
- No `file://`, workspace paths or base64 data URIs. png, jpg, gif, webp, svg, ico, avif; 8 MB each, 16 per page, 32 MB total.
- Re-showing without `assets` keeps the attached images; the same name replaces one.
- To put a file into a page's data (an image on a card or todo item), use `assets` on `page_update` (`PAGE-SCRIPTS.md`, Page assets).

## Reading and changing page state

**Actions first.** Pages made from a template with actions (the built-in Kanban board and Todo list) come with an agent guide listing them. Use `page_action` there: it applies the page's own rules in one step.

**Reading.** `page_state` returns `state`, `stateRevision` and `eventCursor`. On a large page, read one part: `path: "cards/num=12"`, or `path: "cards"` with `where: { col: "col_ab12" }`. Do not poll it.

**Writing.** `page_update` takes ops: `set`, `merge` (a `null` field removes it), `remove`, `insert`, `move` (with `before` / `after` / `at`), and `test` (fail the write unless the value matches). Paths are `/`-separated; on an array a segment picks an item by `id` (`cards/c_12ab`), `field=value` (`cards/num=12`) or `#<index>`. Ops apply in order, all or nothing, to the latest state; pass `expectedRevision` or a `test` op when your edit depends on what you read.

```
page_update({ key: "sprint-board", ops: [
  { op: "merge", path: "items/t_12", value: { done: true, note: null } },
  { op: "insert", path: "items/t_12/comments", value: { id: "cm_1", by: "agent", at: 1790000000000, text: "Done." } }
] })
```

- Never write keys a page keeps per viewer or for in-progress typing.
- Read state again before acting on a page the user has had time to touch.

**Waiting for the user.** When a page asks the user to submit, choose or finish something you continue from: in a Scribe chat, call `page_ask` on it (the chat shows it as a question and your turn resumes with the answer); elsewhere call `page_wait` next, in the same turn, with the event name the page logs. Never poll `page_state`. Designing the page's own signals: `PAGE-SCRIPTS.md`, Waiting for user input.

## Inline UI in chat: widget_show

For a small choice or table inside the reply itself rather than a page, `widget_show` takes page-kit `html` (`<button data-reply>` and `<form data-reply>` work) with `fallback` markdown for history.

## Templates and plugins

Do **not** create, edit or delete templates unless the user explicitly asked; then read `TEMPLATES.md` first. A page bound to a template cannot have its HTML changed (change the template); its state, title and pin still can. Pages made from a template come with an **agent guide** in the first tool result about them: follow it over general advice here.

Plugins give pages local backend methods, shared state and widgets: `plugin_list`, then `plugin_guide` for one. Ordinary pages use `scribe.plugin(id)` and declare it with `page_show({ plugins: [id] })`. To build or edit a plugin, read `PLUGINS.md`.
