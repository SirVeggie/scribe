# Scribe

A local hub of HTML pages that you and your agents share over MCP.

You keep **http://127.0.0.1:4747** open in the browser (or the desktop app). Agents open, update, read, and close pages there instead of writing throwaway `.html` files into a workspace, and work on interactive pages with you: forms, checklists, todo lists, kanban boards.

## How it works

- A small **daemon** serves Scribe on `127.0.0.1:4747` and remembers tabs in `%LOCALAPPDATA%\scribe`.
- Cursor talks to a **stdio MCP** process. That process starts the daemon if needed, then calls the local HTTP API.
- The browser page stays connected over a WebSocket, so new pages appear as tabs immediately.

The MCP process can come and go with Cursor. The daemon stays up so Scribe does not reset when a chat ends.

## Preview UI changes in a worktree

In an open worktree's branch menu, choose **Preview UI**. The browser opens `/preview/<thread-id>/`, serving that worktree's `public/index.html`, CSS, JavaScript and other public files directly. Reload to see edits; preview responses are not cached. Use `/preview/<thread-id>/<public-file>` for a specific file.

Only open worktrees registered by Scribe can be previewed, over loopback and GET only. Hidden files, traversal and links outside `public/` are refused. Closing the worktree ends its preview. The preview uses the running daemon's APIs and live data: actions there change the same pages and threads as the normal UI. Server changes still need a separate daemon or rebuild/restart. UI assets should use relative URLs (such as `./agent.css`); API and shared `/vendor/` URLs stay rooted at the daemon.

## Setup on a new PC

`dist/` is not in git, and Cursor only sees the MCP server and skill if they are registered on that machine. After clone:

```bat
cd C:\path\to\scribe
npm install
npm run build
```

`npm run build` type-checks all TypeScript tests before compiling the app. Use `npm run typecheck:tests` to check tests without emitting files.

Then two copies outside the repo:

1. **MCP** — add this to `%USERPROFILE%\.cursor\mcp.json`, with the `args` path pointing at this clone:

```json
"scribe": {
  "command": "node",
  "args": ["C:\\path\\to\\scribe\\dist\\index.js"]
}
```

2. **Skill** — copy `.cursor\skills\scribe` to `%USERPROFILE%\.cursor\skills\scribe`. A project skill only applies in this repo; the personal copy is what agents use from every other workspace. A junction stays in sync with git:

```bat
mklink /J %USERPROFILE%\.cursor\skills\scribe C:\path\to\scribe\.cursor\skills\scribe
mklink /J %USERPROFILE%\.claude\skills\scribe C:\path\to\scribe\.cursor\skills\scribe
```

The skill is optional: clients without it (or with an old copy) can read the same text from the MCP's `scribe_docs` tool, which serves this clone's `.cursor/skills/scribe`. A test (`src/skillDocs.test.ts`) fails when `window.scribe` in `src/bridge.ts` gains a member the skill doesn't mention, or when the page-wrapper theme variables in `src/wrapHtml.ts` are missing from the skill.

Reload MCP in Cursor after changing `mcp.json`. Then open http://127.0.0.1:4747 or ask the agent to present something visually.

`npm start` runs the daemon in the foreground. Cursor does not need this: the MCP server starts the daemon on first use. `npm stop` stops a running daemon.

## Spaces

A space is a named set of tabs, such as one for home and one for work, or one per project. The chip beside the logo names the current space; it, or **Ctrl+E**, fades the board away to the space cards (tab strip miniature, focused page, main folders, last used). Pick one (click, Enter, or 1–9) to swap the whole strip: the current tabs close into their space, and the chosen space's tabs open in their saved order with their pins and focused tab. **Ctrl+Shift+PageUp / PageDown** switches to the previous / next space directly, and spaces show up in the Ctrl+D palette by name.

- Pages are shared: a page can be a tab in several spaces, and every page stays in the Library. Opening a page from the Library or an agent's `page_show` puts it in the current space.
- Cards can be renamed (double-click or F2), recolored (⋯), reordered by dragging, and deleted (Del). Ctrl+Z in the overview, the notice's Undo, or the "Recently deleted" chips bring a space back with its tabs (the last 10).
- Tabs parked in other spaces are skipped by Ctrl+Z reopen and by Library clean-up (unless it includes open pages).
- Spaces are stored in `scribe.sqlite` (`meta.spaces`). Agents only see the current strip; the `/api/spaces` routes are for the board UI.

## Desktop app

`desktop/` is an optional Tauri window over the same daemon and UI, so the browser keeps working as before. It needs a Rust toolchain to build and Node at runtime (it runs this clone's `dist/index.js` to start the daemon; set `SCRIBE_DIR` to point elsewhere).

- `npm run desktop` builds and runs a debug copy. `npm run desktop:build` builds `desktop\target\release\scribe.exe` and an installer under `desktop\target\release\bundle\nsis`. `npm run desktop:install -- <folder>` closes a running app, builds the release exe, copies it into `<folder>`, and restarts it from there if it was open. The exe runs on its own, so that copy is all you need.
- The tab strip is the title bar: drag empty space (or the spacing around panels) to move the window, double-click to maximize.
- Settings → Desktop shows or hides each title bar button (compact, minimize, maximize, close). Right-click any button still shown for the hidden ones; with all four hidden, a ⋯ menu holds them.
- Settings → Desktop reports native version, build time, executable path and API revision under Build details. When the daemon's UI requires a newer native API (including shells too old to report a revision), an Update desktop button opens rebuild/install instructions. Unsupported settings are disabled. Compatibility is based on API support; it does not check remote releases or every source change. When adding native APIs required by the UI, increase both `api_revision` in `desktop/src/layout.rs` and `REQUIRED_API_REVISION` in `public/desktop.js`, and guard the affected control on old shells.
- Settings → Desktop → "Reduce motion" on Windows reduces animations, effects and smooth scrolling in Scribe and pages that honor `prefers-reduced-motion`. The choice is saved across restarts and applies to page windows too. Turning it off restores the system preference.
- While an embedded site has focus, Scribe shortcuts (Ctrl+D, Ctrl+S, Ctrl+K, …) are caught natively, since the site keeps its keys from the board. Elsewhere Scribe's pages get them first, as in a browser: a page that uses Ctrl+K or Ctrl+B keeps it. Ctrl+Z stays with the page; Ctrl+Shift+T does the same and is caught natively. F5 / Ctrl+R in an embedded site reloads only that site.
- Websites that refuse to be framed (`X-Frame-Options`, CSP `frame-ancestors`) load in tabs, peeks and splits anyway: the app drops those headers from embedded documents. Sites that sign in with `SameSite` cookies may still not stay logged in inside a frame.
- Desktop-only tab keys: Ctrl+Tab / Ctrl+Shift+Tab cycle tabs, Ctrl+W closes the current tab (it stays in the Library).
- Ctrl+Shift+M, or the button beside the window controls, switches between the normal window and a compact one. Each remembers its own size and place; the compact one stays on top unless turned off in Settings.
- Links that open a new window go to the default browser.
- Settings → Desktop → "Close to tray" hides the window on close instead of quitting. Left-click the tray icon to bring it back; right-click for Open and Quit. With the setting off there is no tray icon. While hidden, agents open the window again as if it were closed.
- Settings → Desktop → "Launch at startup" adds a sign-in entry (`HKCU\...\Run`). At sign-in the app starts hidden in the tray when "Close to tray" is on, otherwise as a normal window. Starting it yourself always shows the window, and starting it while it runs brings the running one forward.
- If the daemon cannot be started, or stops while the app is open, the window shows a "daemon isn't running" page with a Start button and the last error. It returns to Scribe as soon as the daemon answers.
- On launch the app writes `desktop.json` to the data folder. While Settings → Desktop → "Agents open Scribe in this app" is on, agents open the app instead of a browser tab when no Scribe window is open.

### Desktop app vs browser

Pages, state, the Library, spaces and agent chat live in the daemon, so both show the same data. The differences:

| | Desktop app | Browser |
|---|---|---|
| Sites that refuse framing | Load anyway | Open in browser card |
| Scribe shortcuts while an embedded site has focus | Work (caught natively) | Stay with the site |
| Ctrl+T / Ctrl+N, Ctrl+W, Ctrl+Tab, Ctrl+Shift+T | Scribe's | The browser's (use **+** and Ctrl+Z) |
| Pages that use Ctrl+K, Ctrl+B, Ctrl+L, … | The page keeps it | The page keeps it |
| Embedded sites that use those keys | Scribe takes the key | The site keeps it |
| F5 / Ctrl+R in an embedded site | Reloads the site | Reloads the board |
| F5 / Ctrl+R | Also drops the HTTP cache | Normal reload (Ctrl+Shift+R for a hard one) |
| Links and popups, including from embedded sites | Open in the default browser | New browser tab or popup |
| Sign-ins, cookies, extensions in embeds | WebView2's own profile, none of yours | Your browser profile |
| Zoom (Ctrl+= / Ctrl+-, Ctrl+wheel) | Off | Works |
| Dropping files (packs on the strip or Library, attachments on the chat) | Not delivered (Tauri's drop handler) | Works |
| Daemon down | Offline page with a Start button | Keeps reconnecting |
| Tray, startup, compact window, agents open the window | Yes | No |
| DevTools | Debug builds only | Yes |

UI preferences (theme, link mode, sidebar and chat layout) are kept in `localStorage`, and page `scribe.local` per viewer, so the app and each browser (and `localhost` vs `127.0.0.1`) keep their own copies.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `page_show` | Create or replace a page (`key` + `title` + `html` or `htmlPath`, optional `state`, `assets`, and `folder` for new pages). Default focuses the tab (and opens it if it was closed). Pass `background: true` to skip focus: a new page is created in the Library (not on the strip); an open tab gets an unread blip; a closed page stays closed with a Library blip. Returns `titleKept: true` when the user renamed the page in the last 24h and the new title was ignored. |
| `page_patch` | Change snippets on an existing page (`id`/`key` + `edits`: `oldString`/`newString`, a numbered line range `startLine`/`endLine`, an insert `afterLine`, or `append: true` to add a part before `</body>`), or replace the whole HTML from a checked-out file (`htmlPath`). Optional `expectedRevision` refuses the change if the page moved. Same background/focus rules as show. Does not create a tab or change state or events. |
| `page_screenshot` | Capture a PNG (or JPEG) of a tab's page or a CSS `selector`. Canonical 1280×800 viewport unless you pass `width`/`height`/`fullPage`. Optional `local` seeds `scribe.local` for that capture only; `fromViewer` starts from the user's last local; `click` clicks a selector after load. Embed pages are captured at the embedded URL. |
| `page_list` | List open tabs (`id`, `key`, `title`, `folder`, …) plus `closedCount`. Pass `query` to search title, key, page text, and JSON state among **open** tabs. |
| `library_search` | Page the whole Library in the user's order (default 20, max 50), or search every page with `query` over title, key, page text, and JSON state. `folder` limits it to one folder and its subfolders. `mode: "semantic"` searches by meaning when semantic search is on, and returns the cards, items and sections that fit, with their anchors (the card number on a board). |
| `library_folders` | List Library folders as paths (`"CLIMS/Releases"`) in the user's order, each with its direct page count, so an agent can file a new page in a matching folder via `page_show`'s `folder`. |
| `page_open` | Open a closed page on the strip |
| `page_read` | Read a page's HTML so it can be revised (open or closed). Pages over 24 KB return an outline instead; read a numbered line window with `offset`/`limit`. `toFile: true` checks it out to a temp file for editing with file tools instead |
| `page_grep` | Find text inside one page: matching lines with line numbers and optional context |
| `page_state` | Read what the user has actually typed, added, or checked off on an interactive page, plus `stateRevision` and `eventCursor`. `path` / `where` return one part (e.g. one card) |
| `page_wait` | Block until the page logs a named event (`scribe.signal(name, data)` / `data-scribe-signal`), then return the events after the cursor (`{ events, cursor }`, no state). Optional `where` matches fields on event `data` (e.g. `{ column: "grok issues" }`). Default 2 hours, no maximum. Do not poll `page_state`. |
| `page_ask` | Scribe chat threads only. Ask the user with a form page: the turn shows it as a question card (Open peeks it, Skip ends it with a note), counts as waiting for the user, and resumes when the page logs `submit` (or the `events` you pass), returning `{ answered, events, state }`. Use it instead of `page_wait` inside a chat. |
| `agent_run` / `agent_models` | Scribe chat threads only, with Helper agents turned on in Agent settings. `agent_run` hands a task to a helper agent on another provider or model (a model you host yourself, say) and returns its final reply, changed files and thread id; `thread` sends that helper a follow-up. The helper is a chat thread of its own in the same folder, with the caller's approval and web settings. Optional `mode` reduces access for a new helper: Code can choose Plan or read-only Ask, and Plan can choose Ask. Ask and Pages keep their mode; omitted `mode` inherits the parent mode, and follow-ups keep the helper's original mode. The user is asked before each new helper unless the thread has Full access. `agent_models` lists the providers and models. |
| `page_update` | Change state with ops (`set`, `merge`, `remove`, `insert`, `move`, `test`) addressed by path, so one card or todo changes without resending the rest. All or nothing, applied to the latest state. Optional `assets` (local files) are stored as page assets; each op value `"asset:<name>"` becomes that file's `/blob/<id>` URL. |
| `page_action` | Run an action of the page's template (built-in Kanban: `list`, `get`, `create`, `update`, `comment`, `move`, `claim`, `release`, `finish`; Todo: `list`, `get`, `add`, `update`, `remove`). Actions apply the page's own rules in one step. |
| `page_pin` / `page_unpin` | Pin or unpin a tab (`id` or `key`) so Clear keeps or drops it |
| `page_close` | Close one tab, all unpinned tabs, or everything; the pages stay in the Library. Pass `permanent: true` to delete instead. Returns `{ closed: [ids] }` or `{ deleted: [ids] }` for this call (not the Library-wide `closedCount`) |
| `template_upsert` / `_list` / `_get` / `_delete` / `_open` | Reusable page templates (agent authors them only when asked; the user opens instances from the sidebar). A template can carry an agent `guide` (built-ins: `templates/builtin/<key>.guide.md`), which the MCP appends to the first tool result that touches one of its pages in a session. In a Scribe chat, the guide goes into the prompt instead when the thread's own page, a page chip, or a `scribe:` key in the message brings such a page up, and the daemon remembers per thread which guides it has, so the MCP does not send them again. |

Reuse the same `key` when updating a topic. Pass a full HTML document, or a fragment (it gets a readable dark template). In Code mode, pass `htmlPath` to a local file instead of inline `html` when the page is large (`page_show` creates or replaces; `page_patch` does not create). For a small change to an existing page, `page_patch` with exact `oldString`/`newString` edits instead of sending the whole document again. For a large existing page, `page_read` with `toFile: true`, edit the file, then `page_patch` with `htmlPath` and `expectedRevision`.

`page_show`, `page_patch`, and `page_read` also return `viewUrl`: the tab page on its own (`http://t-<hex>.localhost:4747/view/t_<hex>`, its own origin), outside Scribe's iframe, so a browser tool can click, drag, and run scripts in it.

### Images

`page_show` accepts local image files via `assets` (path strings, or `{ path, name }`). The daemon copies them next to the tab and the page can reference them as `asset:name`:

```html
<img src="asset:hero.png" alt="Hero">
```

png, jpg, gif, webp, svg, ico, and avif. 8 MB per file, 16 files / 32 MB per tab. These do not count toward the 2 MB HTML cap. Re-showing a key without `assets` keeps files already attached. Workspace-relative `<img src>` and `file://` URLs do not work — tab pages are served from their own `*.localhost` origins and cannot see the disk.

`page_screenshot` loads the tab's content page in a headless Chromium browser (Edge, Chrome, or Brave — not the Scribe UI) and returns an image. Pair it with `page_show(..., background: true)` so a design loop does not steal window focus. Default viewport is 1280×800; pass `selector` for one element or `fullPage` for a tall page.

Pass `local: { … }` to seed `scribe.local` for that capture only (view switchers, open panels) without editing the page or saving a viewer. `fromViewer: true` starts from the most recently written viewer local (what the user last had in the desktop app or a browser); combine with `local` to overlay fields. `click` is a CSS selector clicked after load. Capture boots ignore shared state writes (`set`, `update`), actions, signals, and asset writes, while local view changes still work. Prefer `local` when the view lives in `scribe.local`. Nested iframe captures relax `X-Frame-Options` and CSP `frame-ancestors` in the disposable screenshot context, matching desktop framing behavior.

Pages from the embed template (`<meta name="scribe-embed">`) are captured at the embedded URL, not the placeholder HTML. The capture is still a canonical viewport, not the user's live window (scroll, hover, size).

## Interactive pages

Every page owns a JSON state object that lives in the daemon, not in the browser. The agent can read and write it whether or not the tab is focused, or the browser is even open. Pages get it as `window.scribe`, injected before any page script runs:

```js
scribe.state                  // shared state, readable synchronously on load
scribe.set({ todos })         // replace top-level keys; arrays of items with ids go out as item changes
scribe.update(ops)            // change one item directly: [{ op: "merge", path: "todos/t_1", value: { done: true } }]
scribe.onChange(render)       // an agent or another viewer changed something; render(state, { source, ops })
scribe.onOpen(({ anchor, args }) => …)  // a link (key#card=12) or search hit asked for a place in this page
scribe.bind(el, "notes")      // two-way bind an input, textarea, or checkbox
scribe.local / scribe.setLocal({ filter })   // this viewer's own state: filters, open panels, drafts
scribe.signal("submitted", { item: "t_1" })  // log an event agents can wait on
scribe.action("move", { card: 12, to: "done" })  // run one of the template's actions
scribe.reply({ approach: "A" }, { summary: "Picked A" })  // after a click: send a form's answers to its replyTo page (a Kanban card)
```

A submit button can log the same event without extra script: `data-scribe-signal="submitted"`. The agent then calls `page_wait` with that event name.

Pages can read provider plan usage with `scribe.agent.limits()` (`{ ok, limits }`, keyed by provider). Call `scribe.agent.onLimits(fn)` before the first read to receive live updates; it returns an unsubscribe function. Reports include a timestamp and usage windows (label, utilization from 0 to 1, optional reset time), plus provider availability and billing status when reported. Missing reports mean usage is unavailable. Codex reports remain authoritative after a reset until the provider confirms recovery. The Kanban Workers panel shows these limits for its workers’ providers.

Pages can also use Scribe's agent chat with `scribe.agent`: `start(prompt, opts)` makes a thread for the page, `send(threadId, prompt)` continues it, `stop(threadId)` stops it, `wait(threadId)` resolves with the reply, and `threads()` / `get()` / `onChange()` read it. `options()` lists the providers, models, modes, and approval policies `start` can pick, `pickFolder()` lets the user choose a folder, and `actions()` / `runAction(id, { context })` offer the template's agent actions in the page's own menus. A page only reaches its own threads; `show(threadId)` (on a click) is the exception: it opens any thread in the chat without telling the page anything about it. A page can also hand a thread to Scribe as a **run** (`start(prompt, { run })`, or `watch(threadId)`): the daemon then sees it through even while the page is closed, waiting out a plan usage limit until the provider confirms the reset and sending the chat on, merging its worktree branch when it is done, and asking the agent to fix a branch that won't merge. The thread's `run` shows its phase and, once ended, its outcome; `release(threadId)` lets go of it. Template actions can keep a run's branch unmerged (`runHold`) and record its steps (`runEvent`).

What else a page may do is up to the user, per page (tab menu → **Permissions…**):

| Permission | Default | Lets the page |
| --- | --- | --- |
| Agent chats when you click (`agent.chat`) | Allow | start, send, and stop Pages or Ask threads after a click or key press on the page |
| Agent chats without a click (`agent.unattended`) | Ask | do the same from its own code, e.g. when a card moves, while the page is loaded |
| Agents with file and shell access (`agent.workspace`) | Ask | start Code or Plan threads in folders the user approved, up to the approval policy approved there |

When a page needs one it doesn't have, Scribe asks (Allow, Deny, or Not now) and the call waits for the answer; `scribe.permissions.request(perm)` asks up front and `scribe.permissions.query()` reads them. Grants stay on this PC: they are not in the page's state or exports, and the risky ones go back to Ask when an agent changes the page's code or its template.

Interactive pages should use this instead of `localStorage` — all tab pages share one origin, so their `localStorage` collides, and the agent cannot see it.

### Page links

Pages can open other Scribe pages and websites as a tab, a **peek** (a fixed card over the page area), or a **split** (two to four panes side by side, each a tab in the strip; the strip and the floating chat follow the pane with focus):

```html
<a data-scribe-open="release-notes">Release notes</a>                      <!-- Settings default (Navigate) -->
<a data-scribe-open="release-notes#risks" data-scribe-mode="peek">Risks</a> <!-- key#anchor scrolls the target -->
<a data-scribe-open="roadmap#card=12">Card 12</a>                          <!-- key#name=value opens a record: the page gets it in scribe.onOpen -->
<a href="https://docs.rs/tauri" data-scribe-mode="split">Tauri docs</a>    <!-- a plain href opens the browser -->
```

```js
await scribe.open("release-notes", { mode: "peek" })  // "tab" | "peek" | "split"; also { anchor, background }
// → { ok: true, mode, id } | { ok: false, error: "not_found" | "in_trash" | "no_gesture" }
await scribe.resolve(["release-notes", "roadmap"])     // → { "release-notes": { id, title, open }, roadmap: null }
```

- A target is a page key or id, or an http(s) URL. Keys resolve to an open tab first, then the Library.
- The mode comes from a held modifier (<kbd>Ctrl</kbd> navigate, <kbd>Shift</kbd> split, <kbd>Alt</kbd> peek), then `data-scribe-mode`, then Settings → Links for Scribe pages. Websites default to the browser, and Ctrl+click always sends them there; they never become Scribe tabs. The same modifiers work on Library rows and in the Ctrl+D palette.
- `scribe.open` only works during a click or key press, so a page can't take over the view on load.
- Links to missing pages get the `scribe-link-missing` class, and an empty `data-scribe-open` link shows the target's title.
- Peeks and splits reuse the page's iframe, so switching between them and a tab never reloads the page. A website that refuses framing (checked by the daemon at `/api/frame-check`) shows an Open in browser card instead, except in the desktop app, which frames it anyway.

### Page assets

A page can store images and other files from its own code, for example a picture pasted onto a kanban card:

```js
const asset = await scribe.saveAsset(file, { name: "card.png" }); // Blob, File, ArrayBuffer, or typed array
scribe.set({ cards: [...cards, { image: asset.id }] });
img.src = scribe.assetUrl(card.image);                            // "/blob/<id>"
```

They are stored in `scribe.sqlite`, tied to the page by a foreign key, so permanently deleting the page (emptying it from the Trash, or its 7 days running out) deletes them in the same statement. An asset is kept as long as its id appears anywhere in the page's state or HTML. When nothing mentions it any more it is deleted 10 minutes later (so an undo in the page still finds it); the check runs after each save, and an hourly sweep plus one at startup catch anything the per-save check missed. Limits are 32 MB per asset and 2000 assets / 256 MB per page. From 80% of either limit, `saveAsset` results carry `usage.warning` and Scribe shows a notice. Page assets travel with exports and imports.

`scribe.bind` is what makes text fields safe. It saves as you type (250 ms idle, 1 s ceiling), and when a remote change arrives for a field you are currently in, it leaves your caret and half-typed text alone, marks the field `scribe-stale`, and reconciles once you move on.

### How changes sync

Every write is a list of ops (see `src/stateOps.ts`; the daemon and the page bridge run the same code). A page applies its own writes at once, sends them as ops, and rebases anything not yet confirmed onto the deltas other writers produce, so an agent commenting on one card and you renaming another both keep their change. `scribe.set` diffs the keys you pass against the current state, turning a rewritten array of items with `id`s into item-level ops. The same field written twice at once: the later write wins. Viewers receive each change as the ops that made it (`tab_state` carries `fromRevision`, `stateRevision`, `ops`); one that missed a delta refetches the state.

Agent writes are strict: all or nothing, on the latest state. `expectedRevision` (or a `test` op) makes a write conditional when it depends on a value the agent read. Page writes are lenient: an op whose target someone else removed is skipped, and the rest apply. State is capped at 4 MB per page.

Per-viewer state (`scribe.local`) is stored per page and viewer (the desktop app, a browser), never broadcast, and never shown to agents.

### Events

`scribe.signal("name", data)` (or `data-scribe-signal="name"`) logs an event on the page: `{ seq, name, data, at, by }`. Each page keeps its last 500. `page_wait` returns the events after a cursor and the new cursor, so several events in a row are never merged and none is seen twice. Scribe logs events of its own too, like `claim_lost` when an agent holding a Kanban card stops.

### Actions and claims

Built-in templates ship actions (`src/actions`), which the agent runs with `page_action` and a page with `scribe.action`. They read the latest state and apply the template's rules in one step; the template's guide lists them. Kanban's `claim` records which MCP session and chat thread holds a card. When that thread's turn fails or is stopped (or the daemon restarts mid-turn), a sweep moves the card back to the column it was claimed from with a blocked note; a holder that goes quiet gets its card flagged instead.

A Kanban board can have **agent workers**, which are assignees: the **Workers** button (top right) lists them with a color, a settings summary, their card count, and a run switch, and a row opens its settings (name, color, instructions, provider, model, reasoning, mode, folder, web; *All settings…* adds context, approval, and chat). A running worker takes the cards in the agent (ready) columns assigned to its name, so several workers share one ready column, each on its own cards, up to *Max parallel*. Cards show their assignee's name in the top-right corner, in a worker's color when that assignee is a worker; a ready card assigned to a stopped worker says so. Dropping a card without an assignee into an agent column opens the assign picker (workers first, then people), unless the column's ⋯ menu turns that off. The board gives each card a fresh agent chat, and claims the card for it under the worker's name and moves it to the working column itself (`worker_claim`), so the agent doesn't spend a call on that, so a long run doesn't pay for one ever-growing context; the agent may take a closely related card in the same chat (up to 3), unless *Context* is set to fresh for every card. With a worktree, each agent branches from the latest work and rebases before it ends, and the board merges its branch back (`scribe.agent.merge`), so the main checkout stays current. When it has no cards the board waits for them itself. A failed turn, a card left unfinished, or a merge that doesn't go through even after the agent tried to fix it is a problem with that card's chat, not the worker: the board leaves the card blocked in its ready column with the reason in a comment (workers skip it until you answer on it), logs it, and the worker goes on with its next card. Only problems with the worker itself (it can't launch, or a merge no agent can fix, such as the main checkout being on another branch) pause it with the reason in the Workers panel; the next card that starts clears it. Starts, pauses, merges, and usage-limit waits are also kept in a rolling log on that panel (and the `logs` action), so they can be read even when Keeper process logs are not available. A turn that a plan usage limit stops is the exception: the daemon records when the limit resets (`limitResetsAt` on the turn), the card stays claimed with an "Out of plan usage" note, and Scribe sends the same chat on once the provider confirms the reset (the board hands each worker chat to Scribe as a run, so this, the merge, and the merge fixes happen in the daemon even while the board is closed, and fixes to them reach customized board templates too); if another chat took over or finished the card meanwhile, that message says so and asks only for leftovers, so the chat does not redo the work. The daemon runs the workers (the Kanban action set's `drive` hook): it picks each worker's next card, starts its chat, and acts on how the chat ended, whether or not a window shows the board. Starting a worker asks once for what that needs (`agent.unattended`, and the worker's folder for Code and Plan, through `scribe.agent.allow`); if those permissions are gone later, the worker pauses and says so. The step lease (`worker_step` for board copies with older saved HTML) keeps the daemon and any window from both starting a card. Switching it off while it works offers *Stop when its card is done* (`list` shows `stopRequested` on the worker and the page logs `worker_stop`), *Stop now*, or Cancel. Code and Plan workers go through the page's permissions (see above). A ready card's right-click menu can also run a worker on just that card, in a chat of its own beside the worker's run; the board claims the card for that chat the same way, waits out a plan usage limit the same way as the worker's own run, and merges its branch when it ends. A comment the user posts on a card an agent chat holds goes into that chat (`scribe.agent.card`): steered into its running turn, or queued behind it when the provider can't steer, worded by the daemon as a card comment rather than a chat message. On a card whose chat has finished, the latest comment offers *Continue* (the board claims the card for that chat again and moves it to working; the chat gets the card again and goes on, since it has the context) or *Dismiss*.

## Agent chat

Scribe has its own chat with coding agents, so Claude, Cursor, Codex, and Native run from one place. The daemon runs the agents; the browser only shows them.

| Provider | How it runs | Login |
| --- | --- | --- |
| **Cursor** | The Cursor SDK (`@cursor/sdk`) in the daemon: one local agent per thread, kept under the data folder's `cursor-agents`. Each thread's mode and web setting become the agent's tool list; the board's page tools reach it as SDK custom tools. The SDK has no approval callback, so Cursor can't ask yet: every approval but Full access runs Cursor's Auto-review, which denies risky calls instead. Threads from the older ACP integration start a new agent with a recap of the conversation on their next message. | **Log in** under Agent settings (a browser login that saves a key to `~/.cursor/sdk/auth.json`), or `CURSOR_API_KEY` |
| **Claude** | The Claude Agent SDK, one long-lived query per active thread. | Your Claude Code login (`claude` → `/login`) or `ANTHROPIC_API_KEY` |
| **Codex** | The Codex SDK (`@openai/codex-sdk`) in the daemon: each turn spawns `codex exec`. Sessions resume under the data folder's `agent/codex`, using your ChatGPT login. The model picker is the live ChatGPT catalog (same models as Codex web work mode), not a hardcoded list. The board's page tools reach it as a Codex MCP server named `scribe`. The SDK has no approval callback or steer, so every approval but Full access runs commands in the workspace sandbox without asking; Ask, Plan, and Pages use a read-only sandbox. | **Log in** under Agent settings (runs `codex login` and saves to `~/.codex/auth.json`), or `CODEX_API_KEY` / `OPENAI_API_KEY` |
| **Native** | Scribe's own harness. Model sources in Agent settings (any OpenAI-compatible endpoint: OpenRouter, LM Studio, Ollama, vLLM, llama.cpp, …) plus models of providers whose API key is set in the environment. | Model-source keys in Agent settings, or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / … |

Three ways to open it:

- **Sidebar** — the ✦ button or **Ctrl+L**. The ☰ button lists threads.
- **Floating** — **Ctrl+K**. A composer over the bottom of the page for quick asks and edits. While the conversation is collapsed, progress shows as lines that fade out; the final answer stays for a while. **Ctrl+↑** or the list button shows the conversation; **Esc** hides it to a small handle. It follows the active page: its newest thread for that page, or a new one. When that thread opens a page for you, the conversation moves with it.
- **Full window** — **Ctrl+Shift+L** or ⤢ in the sidebar. Threads on the left, the conversation in the middle.

**Threads** belong to a page, a Library folder, a workspace folder, or nothing (global). The list's **Here** filter shows threads for the current page (with the thread that created it), its folders, the page's workspace, and global ones; **Workspaces** lists every thread attached to a disk folder, grouped by that folder; **All** and **Archived** show the rest. New page and folder threads start in Pages mode. A page an agent creates takes that thread's workspace folder, and new threads on the page start there; change or clear it from the page's menu (**Set workspace…**). A thread keeps its provider; picking a model from the other provider starts a new thread in the same place.

When a workspace folder is renamed or moved on its drive, Scribe finds it again by its file id and the thread list offers **Update threads**: threads, their worktrees, recent workspaces, per-workspace MCP servers, page folder grants, Kanban worker folders and Claude Code's session folder (`~/.claude/projects`) all follow the new path. For a folder moved to another drive or copied, the **Folder not found** notice in a thread has **Locate moved folder…** to pick the new place by hand.

An agent can also change its own thread with the `thread_update` tool: it renames the thread when the subject has changed (a thread you named keeps its title), and asks to move the workspace to the folder the work moved to, so file access there stops needing approval call by call. You allow the move in the chat (Full access is not asked); it applies when the turn ends, and Scribe then sends the agent on in the new folder. A thread in its own worktree, a helper thread and a Pages thread keep their workspace.

Right-click a Library folder and choose **Agent instructions** to edit its **Description** and **Instructions**. The description appears in agents' folder listings. Both fields are included in the context of threads scoped to that folder or a page in it; parent folders apply first, nearest last. Edits apply on the next turn. Global and workspace threads do not pick these up. A folder icon beside its page count marks custom settings. Pages titled Instructions are ordinary pages. Folder settings persist and are included in folder and Library exports.

**Modes** set what the agent may touch: **Code** (files and shell in the workspace; with **No workspace** the agent starts in a scratch folder under the data folder, for machine tasks such as installing a tool), **Ask** (read-only), **Plan** (propose first; accepting the plan continues in Code), **Pages** (page tools and web only, no files or shell). In Code mode the shield picks approvals: **Ask first**, **Auto-edit** (edits pass, commands ask), **Auto review** (Claude's classifier), **Full access**. On Cursor, all but Full access run Cursor's Auto-review (see above). On Codex, all but Full access run in the workspace sandbox without asking. Approval cards offer the provider's own "always allow", which it saves to its own allowlist. Page tools on this daemon's MCP server are approved automatically, like the MCP today. **Web** picks web search and fetch: **on** (any site), **limited** (only the domains on the web allowlist, edited under Agent settings → Allowlists and seeded with common docs, registries and code hosts; calls on it run without asking; Cursor gets a fetch tool and no search), or **off**. With limited or off, a call the setting does not cover shows an approval card: **Allow once**, **Allow** the domain or **Allow for this thread** (both kept for the rest of the thread), or **Deny**. Agents can ask ahead with `web_request`, giving a reason and an importance: in a board worker's chat nobody may be watching, so an unanswered request is refused after its wait (necessary: never, important: 2 hours, useful: 15 minutes, trivial: 2 minutes) and the agent carries on without the web. Claude threads skip the hooks in your Claude Code settings files and plugins, so a fail-closed hook meant for your terminal sessions cannot silently deny their tools; turn them on under Agent settings → Allowlists → Hooks. The model and reasoning pickers read the provider's model list: Claude effort levels, Cursor's effort, fast, and context options per model.

What shows in a thread:

- **Reasoning** as collapsible "Thought" rows with a one-line preview (Settings → Agent → Reasoning expands them by default).
- **Tool rows**: reads and searches fold into "Explored N files"; edits show file names and `+added −removed`; commands show the command and exit code. Expand a row for its output or inline diff.
- **Changes**: every turn in a git workspace snapshots the working copy before and after (a temporary index, so your index and refs are untouched and new files count). The turn ends with the files it changed and line counts; **Review** opens the diff viewer with This turn, Thread, and Git working tree tabs, and **Revert turn** undoes the turn's changes if they still apply cleanly. Without git, the per-tool diffs are used.
- **Page edits**: a turn on a page (a page thread, or with the page attached) keeps a checkpoint of the page's HTML. The footer's **Page edited** button puts it back.
- Approvals, questions, plans, and todo lists as cards. Page links from the agent (`[[scribe:page-key]]` or `[label](scribe:page-key)`) open like page links do (Ctrl navigate, Shift split, Alt peek).

The composer takes pasted or dropped images, `/` opens the provider's slash commands and skills, and `@` mentions pages, folders and files (its **Here** section offers the current page and its folder; `@this` is the current page). To ask about part of a page, select the text and right-click → **Ask agent**, or press **Ctrl+K** / **Ctrl+L** with it selected: the chat opens with the selection as a chip (the page named as its source) and the input focused. Messages sent while a turn runs are queued; Stop drops the queue, and those messages stay marked "Not sent" with **Send again**. Esc twice in the composer stops a running turn.

A template can declare **agent actions** (`agentActions` in `template_upsert`): a label, a prompt with placeholders (`{{selection}}`, `{{input}}`, `{{page.title}}`, `{{page.key}}`, names the page supplies, and `{{#selection}}…{{/selection}}` for text that only shows with a selection), where it shows, and the new thread's settings (Pages or Ask mode, provider, model, effort, fast, web, title). Actions that do not set `provider` or a non-`default` `model` start with the same fixed economical defaults as a Kanban board worker (for example Cursor **composer-2.5**, web off, fast off), not your last chat model; set `thread.provider` / `thread.model` to override. On a page from that template, the actions sit in the page's right-click menu, at the top of the Ctrl+P palette, and in the chat's `/` menu (`/<id> more text` fills `{{input}}`; a selection chip attached with Ask agent fills `{{selection}}`). An action starts a new thread on the page by default, or with `run: "chat"` sends its prompt in the chat at hand. An action can also name placeholders the page supplies for what was right-clicked (`context: ["card"]` for `{{card}}`): the page marks elements with `data-scribe-context='{"card":"#12 Fix login"}'`, or a page with its own menu lists them with `scribe.agent.actions()` and runs one with `scribe.agent.runAction(id, { context })`. Those show only in a right-click menu where the page supplies them. The built-ins come with some: Todo list **Break this down** and **Break this item down**, Markdown note **Summarise**, Kanban **Triage inbox**, and on a card's menu **Triage this card** and **Break this card down**; a built-in's copy uses the built-in's actions until you give it its own.

In Code, Ask, and Plan modes the agents load your usual setup: Claude's user and project settings, skills and CLAUDE.md; Cursor's own config, rules, skills and MCP servers. Claude's MCP servers come from Scribe's list under Agent settings. Code chats (including workers) also inherit `keeper` from Claude Code's global, per-project or workspace MCP config when Scribe has no Keeper entry. A Scribe Keeper entry takes precedence, including disabling it or restricting its modes; inherited Keeper uses the thread's normal approval flow. Other Claude Code servers need to be imported into Scribe's list. Pages mode runs in a scratch folder under the data folder.

**Agent harness** (the link at the bottom of Settings and of Agent settings) is a full panel on what your chats are given, what they do with it, and where you change it: MCP servers are switched, edited and added there, skills are edited, created, copied to another provider's folder and removed (a removed skill's folder is moved into Scribe's data folder, under `agent/removed-skills`), memories are added, edited and removed, and the instruction files a provider loads (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`) open in an editor. The statistics read the stored threads. Overview has tokens sent and written by day, provider and model, cache share, tool calls and failures, and what a session's first model call costs. Session context shows, for a provider, mode and workspace, Scribe's instructions part by part, the schema size of each Scribe tool, and what the provider loads by itself; for Claude, **Measure** starts Claude Code twice without a message (as Scribe sets it up, and on its own) and compares their `/context` counts. Tool use shows calls, failures, result sizes and time by tool. MCP servers lists the servers a thread gets and why another is left out, can start one to list its tools, and marks tools no thread has called. Skills lists the skills each provider finds, with what their descriptions cost every chat. Sizes marked ≈ are estimated from text length.

Threads, transcripts, and page checkpoints are stored in `%LOCALAPPDATA%\scribe\agent.sqlite`; the providers keep their own session files for resuming. HTTP routes are under `/api/agent/*` and are not reachable from tab pages.

## Data

Tabs persist in `%LOCALAPPDATA%\scribe\scribe.sqlite` across daemon and Cursor restarts, including each page's state object (max 4 MB per page), its event log, and per-viewer local state. Image files live in `%LOCALAPPDATA%\scribe\assets\<tabId>\`. Every page lives in the **Library** until you delete it; closing a tab only takes it off the strip. **Ctrl+Z** undoes whichever is newer: the most recent close (reopens the tab), or the most recent delete. A folder delete or any other bulk delete is one undo step. Deleted pages and folders sit in the **Trash** (Library ⋯ menu → Trash) for 7 days: each row has a restore button that puts it back in the Library, and its context menu can delete it for good. After 7 days they are deleted automatically. A previous `state.json` is imported once and renamed to `state.json.bak`.

The browser **Clear** button closes unpinned tabs. Pinned tabs stay until you close or delete them. Settings → Tabs can hide Clear. Shift+click a tab's × deletes the page (the notice has Undo). **Ctrl+S** downloads the current page as HTML (markup only). Settings and the tab/Library context menus export a `.scribe.json` pack that includes state, images, Library folder and position, and the templates behind any template pages (Export all includes every template; a folder's menu exports just that folder); Import (or a drop on Settings, the tab strip, or the Library) restores those files.

The sidebar has **Library** and **Templates**. The Library is a tree of folders and pages in your own order: drag rows to reorder or file them, drag a page onto the strip to open it there, or drag a tab into the Library to file it and close it. Open pages have an accent bar, the current tab's row is filled, and pinned pages get a faint warm tint. Hovering a tab or Library row shows its full title, id, created and updated times, and folder. Templates are reusable pages with a form. The agent creates a template when you ask; you open copies from the list. A few built-ins (Embed, Markdown note, Todo list) sit in a collapsible **Built-in** group under your own; opening one first adds a copy to your templates and the page uses that copy, and app updates only refresh that copy while you haven't edited it and the page data format is unchanged. Otherwise the copy gets a dim orange marker, and an agent can bring it up to date. Right-click a built-in to add it without opening a page. A test daemon (one with `SCRIBE_HOME` set) watches `templates/builtin` and reloads a built-in when its files change, updating copies and pages the same way an app update does, so template edits show without a restart; `SCRIBE_WATCH_BUILTINS=1` or `0` turns that on or off for any daemon. Updating a template refreshes every page created from it. A linked page's HTML cannot be edited — only the template can. If a template change breaks that page's data, Scribe blocks the page until the agent fixes the data.

### Embedding a site

A page whose `<head>` has `<meta name="scribe-embed" content="URL">` is shown by pointing the tab iframe straight at that URL, instead of nesting it inside the tab page. The Embed template does this. Only `http:` and `https:` URLs outside Scribe's own origin count; anything else falls back to rendering the page's HTML. The stored HTML stays a small wrapper, so `page_read` and search see the URL but not the site's content.

A direct frame keeps the site on the same site as Scribe chrome (`127.0.0.1`), so logins that use `SameSite=Lax` cookies (ComfyUI-Login, for example) keep working. Use `127.0.0.1`, not `localhost`: the browser treats them as different sites. Scribe shortcuts (Ctrl+S, Ctrl+D, …) don't reach Scribe while focus is inside the embedded site.

### Hiding a tab from the agent

Right-click a tab or Library row and choose **Hide from agent**, or tick **Hide from agent** in a template's Open/Edit form. Hidden tabs show an eye icon. To the agent they don't exist: they're left out of `page_list`, `library_search`, search, `activeId`, bulk `page_close`, and template instance counts, and every per-tab tool returns "tab not found". A `page_wait` already running on the tab ends as if the tab had closed. `page_show` with a hidden tab's key creates a separate tab instead of overwriting it. Only Scribe UI can change the flag; the MCP marks its requests with an `x-scribe-client: agent` header and cannot flip it.

This is a guardrail on Scribe's tools, not a sandbox. An agent with a shell or browser could still call the HTTP API without the header, or open the embedded URL itself.

Port: `4747` (override with `SCRIBE_PORT`). Bound to localhost only.

### Testing board workers with fake agents

Start a test daemon with `SCRIBE_FAKE_AGENTS=1` (plus its own `SCRIBE_PORT` and `SCRIBE_HOME`) and every chat, whatever provider it picks, runs a fake agent: no model, tools, MCP or account calls. A turn goes running, waits `SCRIBE_FAKE_AGENT_DELAY` ms (default 2000), and ends. Given a board worker's prompt, it claims its card, waits, and finishes it through the board's actions as its own thread, so worker start, step, wrap-up, merge and max parallel run for real. Directives anywhere in the message (a card title works) change a turn: `[fake:delay=5000]`, `[fake:error]`, `[fake:hang]` (runs until stopped), `[fake:nofinish]` (keeps the claim), `[fake:commit]` (commits a file in the thread's worktree, never outside one), `[fake:limit=30]` (the chat's first turn hits a plan usage limit that resets in 30 seconds; the turn Scribe resumes it with goes on with the card, as long as the daemon wasn't restarted in between). Combine them as `[fake:commit,delay=500]`.

Each tab page loads in an iframe from an origin of its own, **http://t-<hex>.localhost:4747** for page `t_<hex>` (browsers resolve `*.localhost` to loopback), so a page's script cannot reach Scribe's chrome and API or another page's frame, state, assets or view. It reaches its own page, and reads Open pages its page or folders were granted. `http://127.0.0.2:4747` serves only shared, data-free files and blobs, and sends `/view/<id>` to the page's own origin.

Agent requests are identified by token, not by header (#690): each chat's MCP gets `SCRIBE_THREAD_TOKEN` for its thread. An MCP outside a Scribe chat, and a local tool that should act as the user, send the `local-token` file from Scribe's data folder as `x-scribe-local-token`. A caller with neither reaches no pages and none of the board's own routes. A process that reads Scribe's data folder can still get past this, as it can read `scribe.sqlite` itself.
