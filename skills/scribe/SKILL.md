---
name: scribe
description: Build or change pages in Scribe, the user's local page viewer (page_show / page_patch on the scribe MCP): investigation results, analyses, design options, comparisons and other structured visual HTML, forms that ask the user, and interactive pages with their own scripts. Prefer it over workspace .html files and the host's own canvas or artifact features unless the user asked for those. Not needed to find, read or search pages, or to work a Kanban board or Todo list through page_action; the tool descriptions and the page's guide cover those.
---

# Scribe

Scribe is the user's local tabbed HTML viewer, driven by the `scribe` MCP (`page_*` tools). Put visual output there, not in one-off HTML files in the workspace. If your host defers MCP tools, load the `page_*` tools with tool search first.

This file covers building and changing pages. Read a file beside it when the task needs it (`skill_read` with `file`, or `scribe_docs` with its name):

| Read | When |
|---|---|
| `PAGE-SCRIPTS.md` | The page has its own script: `window.scribe` state, `bind`, `onChange`, signals and `page_wait`, page assets, `scribe.preview`, `scribe.reply` in your own markup. |
| `PAGE-AGENT.md` | The page starts or drives agent chats (`scribe.agent`): prompts, model pickers, usage limits, agent runs. |
| `PAGE-SERVICES.md` | The page plays sounds, reads text aloud or uses the microphone (`scribe.audio`), the classifier (`scribe.ml`) or files in a folder (`scribe.files`). |
| `LARGE-PAGES.md` | A page over 24 KB: reading a window, grep, line edits, building in parts, checking out to a file. |
| `TESTING.md` | Screenshots of a design for the current project (`page_screenshot`), or clicking through a page in your browser (`browser_*`). |
| `TEMPLATES.md` | Only when the user asked to create or change a Scribe template. |
| `PLUGINS.md` | Building or editing a page plugin. |

## When to use it

Use Scribe for standalone visual output: investigations, analyses, design options, architecture notes, tables that should stay on screen, walkthroughs. Skip it for code edits, short answers, drafts meant to be copied, or when the user asked for another artifact.

Put a page up and stop. Never screenshot an information page to polish it: `page_screenshot` is only for designs that belong to the current project (`TESTING.md`). Answer small follow-ups in chat; change the page only when asked or when the new material belongs there.

## Library model

The **Library** holds every page, in folders and an order the user owns: never move or reorder pages. The tab strip shows the **open** pages; closing a tab keeps the page, only a delete removes it. A folder's **Agent instructions** reach threads scoped to that folder or a page in it.

## Find a page

- **Pasted key** (`scribe:sprint-notes`): pass it as `key` to `page_read`, `page_patch`, `page_state`, … as is, open or closed. A page id (`t_1a2b3c4d`) goes in `id`.
- **By title** ("my Jira page"): `page_list` for open tabs; if missing and `closedCount` > 0, `library_search`. Never guess a key.
- **By content**: `library_search({ query })` with 1–3 distinctive words (`jira`, `clims-18595`), not the whole sentence. It searches title, key, text and JSON state. With semantic search on, `mode: "semantic"` finds by meaning (a card on some board, a section deep in a page).
- Page through results (default 20, max 50); never dump the Library into context.

`page_read` returns the HTML as its own unescaped text block: copy `oldString`s from it verbatim. A page over 24 KB comes back as an outline (`LARGE-PAGES.md`).

## Show or update

Before writing HTML or calling `page_show` / `page_patch`, say in a line that Scribe is being updated, so the pause does not look like a stall.

**Create or rewrite** with one `page_show`:

- `key`: a stable slug (`clims-12345-analysis`, stored as `scribe:clims-12345-analysis`). Reuse it only to edit the same page in place.
- `title`: a short tab label. `titleKept: true` in the result means the user renamed the page: keep their title.
- `html`: a fragment (preferred: Scribe wraps it in its dark theme and page kit) or a full document with inline CSS. `htmlPath` passes a local file instead (in Code mode a temp file, not the workspace).
- `background: true`: when the user said not to switch tabs, or for a page you will link to (a form, evidence) rather than show. A new background page goes to the Library without a tab.
- `pin`: only for pages the user keeps using (a todo list, a tool); never for one-off reports, designs or forms.
- `folder`: for a new page, check `library_folders` and pass an existing path when it clearly fits; a new path only when the user asked.
- `assets` for images (see Images); `state` seeds page state (only when it has none); `base` builds on a starter page the user names (your `html` fills its `data-slot` element, else `<main>`, else `<body>`).

| User said | Call | Result |
| --- | --- | --- |
| show me / put it in Scribe | `page_show` | Focused; a closed page is opened. |
| a form or evidence page to link to | `page_show` with `background: true` | In the Library, not on the strip. |
| update it in the background | `page_show` / `page_patch` with `background: true` | Open tab gets an unread blip; a closed page stays closed. |
| tweak a section, fix a line | `page_patch` | Changes only those snippets. |
| a small follow-up question | nothing: answer in chat | |
| bring it back | `page_open` | Focused. |
| change todos, cards, notes | `page_action` if the page has actions, else `page_update` | Never focuses. |

Mention the tab title in chat; if a result has `open: false`, say the blip is on Library. Never paste the HTML into chat. Fix any `problems` that `page_show` or `page_patch` return from the first render.

### Patch an existing page

```
page_patch({ key: "clims-12345-analysis", edits: [
  { oldString: "<p>Status: in progress</p>", newString: "<p>Status: ready</p>" },
  { oldString: "</section>", newString: "<h2>Next</h2><p>Ship it.</p></section>" }
] })
```

- `oldString` is an exact substring of the stored HTML; for a fragment page, match your body, not the wrapper. It must match once: add context, or pass `replaceAll: true`.
- Edits apply in order, all or nothing. A failure quotes where the stored text diverged: fix the snippet from that, never guess again.
- Skip `page_read` when the markup is still in the conversation. Pass `expectedRevision` if the user may have changed the page since.
- It does not create pages or change state: use `page_show` for a new page, new `assets` or seeded `state`.

### Updating vs replacing

Edits and additions are fine. Never replace all or most of a page, or replace it with a continuation, without asking: the user loses what they may want to look back at. For a continuation, close the old tab (`page_close` keeps it in the Library) and show a new page under a new key.

## HTML

- Self-contained, inline CSS. Workspace paths and `file://` images do not load; use `assets`.
- A full document starts with `<!DOCTYPE html>` or `<html`. Pages render in an iframe; the parent's styles do not apply.
- Keep pages well under 200 KB (hard limit 2 MB; assets do not count).

### Theme

Fragment pages get a **dark** theme: `color-scheme: dark`, body already `background: var(--bg); color: var(--text)`, and these variables on `:root`:

- `--bg`: page background
- `--text`: body text
- `--muted`: secondary text (or the `.muted` class)
- `--border`: rules and table borders
- `--accent`: links
- `--code-bg`: `code` and `pre`

Never hardcode light-theme colors (`#222`, `black`) or fall back to them (`var(--fg, #222)`: `--fg` is undefined). A full document skips the wrapper: copy the `:root` block, or set contrasting background and color yourself.

### Page kit: elements and form wiring

Fragment pages get Scribe's page kit: script-free form wiring, themed fields and buttons, and elements for parts that need behavior: `<s-question>` for questions, `<s-options>` to compare options and pick one, `<s-mock>` for UI mock-ups, `<s-code>` for code with a Copy button. It has no boxes, cards or badges: style the page yourself. Kit elements render into the page and every kit rule sits in `:where()`, so your CSS restyles them; the `--kit-*` variables on `:root` retheme them all. A full document gets only the reply wiring (`form[data-reply]`, `button[data-reply]`), not the kit's styles or elements.

Never make a page plainer to save tokens: its HTML is a small share of a chat's cost. Make design docs, investigations and comparisons easy to scan: color-code categories and options (your own tags, toned sections and table cells), draw flows or architecture (a `flow` row, or inline SVG), and show proposed UI as a mock-up rather than describing it.

**One-click replies.** `<button data-reply="Use option B" data-context='{"option":"B"}'>Choose B</button>` sends the optional JSON object as answers and `data-reply` as the summary through `scribe.reply`; an empty `data-reply` uses the button text. No form or script needed. After a choice all reply buttons are disabled and the chosen one marked; a failed delivery allows retry. Invalid `data-context` shows an error without sending. Without `replyTo`, it logs `submitted` with `{ answers, summary }`, like a reply form. It works in any component host that provides `window.scribe.reply`; that host decides where replies go.

<!-- kit-catalog:start -->
| Write | Gives | Example |
|---|---|---|
| ` form[data-reply="label"?] ` | Keeps a local draft and submits named fields through scribe.reply, or a submitted signal without replyTo. A page can have several, each sent on its own; a data-reply value becomes the reply's summary, else the heading of the form's section leads it. | ` <form data-reply><textarea name="notes"></textarea><button type="submit">Send answers</button></form> ` |
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

**Forms.** `<form data-reply>` needs no script: Scribe keeps the user's typing as a draft, and Submit sends the named fields with `scribe.reply` to the page's `replyTo` (see Forms for a card): check boxes as lists, empty fields left out. Without `replyTo` it logs `submitted` with `{ answers, summary }`. Questions are `<s-question>` elements (each `name` becomes an answer key); named plain inputs work too.

```html
<form data-reply>
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

Put each question next to the part of the page it is about, and give every form a free-text field so the user can answer in their own words.

**Shape the forms by how the user will act on them.** Decisions that only make sense together (a plan's choices) go in one form wrapping the page, sent once. Items the user can take up one at a time get a form each: ideas, proposals or findings that could each become a card, options to try separately, review points. Give each its own note field and a submit button named for what it does, with the item in the form's `data-reply` label, so the user can fill in and send one, come back for another later, or leave the rest:

```html
<section>
  <h2>One Settings window</h2>
  <p>…the finding…</p>
  <form data-reply="Create card: One Settings window">
    <s-question name="scope" label="Scope">
      <s-choice value="merge" checked>Merge the five dialogs</s-choice><s-choice value="tree">Tree first</s-choice>
    </s-question>
    <s-question name="notes" label="Notes for the card" placeholder="Optional"></s-question>
    <button type="submit">Create card</button>
  </form>
</section>
```

Each send is its own reply (the label is its summary, the fields follow), and a sent form can be changed and sent again. Act on each reply as it arrives (create that card, answer that point) rather than waiting for the rest. A page can mix both: per-item forms and one form for the overall questions.

In a Scribe chat, show the form and call `page_ask` on it: your turn resumes with the answers. Elsewhere, `page_wait` on `submitted` (its data names the form: its `id`, else `form0`, `form1`…).

**Full documents** can use the kit too: add `<link rel="stylesheet" href="/kit.css">` and `<script src="/kit.js" defer></script>` to `<head>` for the theme variables (your `:root` wins), the elements and classes above and the form wiring; set the body's background, color and font yourself.

### Forms for a card

A form for a Kanban card (questions, mockup feedback, a review) can hand its answers to the card, so its submit button works even after your chat ends:

```js
page_show({ key: "card-320-questions", html, background: true,
            replyTo: { page: "scribe:agent-todo", card: 320 } })
```

`<form data-reply>` does the rest: the answers become the user's comment on the card (summary, answers, a peek link to the form) and go to the card's chat, into its running turn or as Continue once it ended. So you can release the card and end your turn. `page_patch` with `replyTo` (no edits) wires an existing page; `replyTo: null` clears it. For a submit button in your own markup: `scribe.reply` in `PAGE-SCRIPTS.md`.

### Page components

Ready-made pieces of the app's UI, loaded by name with `<script src="/c/<name>.js"></script>`. Use them instead of hand-built versions, which drift from the app's look. Read a component's guide with `plugin_guide({ id: "core" })` before first use; it also lists plugins' components (`/c/<plugin>/<name>.js`).

<!-- page-components:start -->
| Load | Gives |
|---|---|
| `<script src="/c/select.js"></script>` | Scribe's own dropdown in place of every native `<select>` on the page. |
| `<script src="/c/chart.js"></script>` | `<s-chart>`: column, bar, line, area and sparkline charts in Scribe's theme, with hover, legend and a table view. |
<!-- page-components:end -->

## Linking pages

The user opens a link as a tab, a **peek** (a card over the page for a quick look) or a **split** (a pane beside it). Link related pages instead of putting everything on one.

```html
<a data-scribe-open="scribe:clims-12345-analysis">Analysis</a>                              <!-- no mode: the user's setting -->
<a data-scribe-open="scribe:clims-12345-logs" data-scribe-mode="peek">raw logs</a>          <!-- a quick look -->
<a data-scribe-open="scribe:clims-12345-analysis#risks" data-scribe-mode="split">Risks</a>  <!-- beside this page, at id="risks" -->
<a data-scribe-open="scribe:clims-12345-logs"></a>                                         <!-- empty: shows the page's title -->
<a href="https://tauri.app/reference/config/">Tauri config</a>                              <!-- a website: opens the browser -->
```

- Peek for evidence and references, split for side-by-side reading, no mode for a page the user should go and work on.
- Link by **key**: ones you chose or found with `page_list` / `library_search`. A missing key shows struck through and fixes itself once the page exists, so a hub page may come before its detail pages in the same turn.
- `#anchor` scrolls to that `id`. `#name=value` opens a record: `scribe:board-key#card=12` opens card 12 of a Kanban board, `#item=<id>` a Todo list item.
- Many websites refuse to show in a peek or split (GitHub, Google, logins): use those modes for docs, not apps. No `target="_blank"` or script navigation.
- The built-in Todo list, Kanban board and Markdown note link in their text with `[[scribe:key]]`, `[[scribe:key|text]]`, `[[peek:scribe:key]]`, `[[split:scribe:key]]` or `[text](scribe:key)`; write those into their state, not raw HTML. Chat replies use `[[scribe:key]]` too.
- A file on disk links as `file:` plus its path (`<a href="file:///C:/work/out/shot.png">`, `[[file:C:\work\out\shot.png]]`) and opens as a temporary page outside the Library. Use it for images, logs or outputs instead of a page each.
- You cannot open a peek or split yourself; links are for the user.

## Images

Local image files go on a page through `assets` on `page_show`, referenced as `asset:<name>`:

```
page_show({ key: "mockup", title: "Mockup", html: `<img src="asset:hero.png" alt="Hero">`,
            assets: [{ path: "C:/Users/me/Pictures/hero.png", name: "hero.png" }] })
```

- `assets` may be plain paths (name = basename). Use the names the result lists.
- No `file://`, workspace paths or base64 data URIs. png, jpg, gif, webp, svg, ico, avif; 8 MB each, 16 per page, 32 MB total.
- Sounds attach the same way (mp3, ogg, wav, m4a): `<audio src="asset:ding.mp3">`, or play one from a script with `scribe.audio.play("asset:ding.mp3")` (`PAGE-SERVICES.md`).
- Re-showing without `assets` keeps attached images; the same name replaces one.
- A file in a page's data (an image on a card or todo): `assets` on `page_update` (Page assets in `PAGE-SCRIPTS.md`).

## Reading and changing page state

**Actions first.** Template pages with actions (the built-in Kanban board and Todo list) come with an agent guide listing them; use `page_action` there, which applies the page's rules in one step.

**Reading.** `page_state` returns `state`, `stateRevision` and `eventCursor`. On a large page read one part: `path: "cards/num=12"`, or `path: "cards"` with `where: { col: "col_ab12" }`. Never poll it.

**Writing.** `page_update` takes ops: `set`, `merge` (a `null` field removes it), `remove`, `insert`, `move` (with `before` / `after` / `at`) and `test` (fail unless the value matches). Paths are `/`-separated; on an array a segment picks an item by `id` (`cards/c_12ab`), `field=value` (`cards/num=12`) or `#<index>`. Ops apply in order, all or nothing, to the latest state; pass `expectedRevision` or a `test` op when your edit depends on what you read.

```
page_update({ key: "sprint-board", ops: [
  { op: "merge", path: "items/t_12", value: { done: true, note: null } },
  { op: "insert", path: "items/t_12/comments", value: { id: "cm_1", by: "agent", at: 1790000000000, text: "Done." } }
] })
```

- Never write keys a page keeps per viewer or for in-progress typing.
- Re-read state before acting on a page the user has had time to touch.

**Waiting for the user.** When a page asks the user to submit, choose or finish something you continue from: in a Scribe chat call `page_ask` on it (your turn resumes with the answer); elsewhere call `page_wait` next, in the same turn, with the event the page logs. Never poll `page_state`. Designing a page's signals: Waiting for user input in `PAGE-SCRIPTS.md`.

## Inline UI in chat: widget_show

For a small choice or table inside the reply rather than a page, `widget_show` takes page-kit `html` (`<button data-reply>` and `<form data-reply>` work) with `fallback` markdown for history.

## Templates and plugins

Never create, edit or delete templates unless the user explicitly asked; then read `TEMPLATES.md` first. A template-bound page's HTML cannot change (change the template); its state, title and pin can. Template pages come with an **agent guide** in the first tool result about them: follow it over this file.

Plugins give pages backend methods, shared state and widgets: `plugin_list`, then `plugin_guide` for one. Pages use `scribe.plugin(id)` and declare it with `page_show({ plugins: [id] })`. Building or editing a plugin: `PLUGINS.md`.
