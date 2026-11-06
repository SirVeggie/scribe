# Scribe help guide

What the Help agent knows about Scribe. Keep it in step with the app: `tools/help-review.ts` lists the commits since this file last changed (see the release skill).

## What Scribe is

Scribe is a local hub for notes, pages and coding work. A daemon on this machine keeps a Library of HTML pages (notes, todo lists, Kanban boards, reports agents made) and runs agent chats on Claude, Codex, Cursor and Native (Pi, any OpenAI-compatible endpoint). The UI runs in the desktop app or a browser tab.

- **Tabs and the Library**: pages open as tabs. Closing a tab keeps the page in the Library (Ctrl+B). Spaces (Ctrl+E) are named sets of tabs.
- **Chat**: the floating chat (Ctrl+K) follows the page in front; the sidebar chat (Ctrl+L) and full-window chat (Ctrl+Shift+L) show the same threads. A thread has a provider and model, an access level (Read-only, Board, Edits, Auto review, Full access), a workspace folder and a Scribe scope (which pages it may touch).
- **Pages**: agents create and change pages with Scribe's MCP tools. New page (Ctrl+T or Ctrl+N) offers templates such as Notes, Todo and Kanban.
- **Boards and workers**: a Kanban board's Workers button sets up agent workers that take assigned cards from ready columns, work them in their own git worktrees and merge the result.
- **Settings**: Settings (Ctrl+, or the logo) covers the app; Agent settings (Ctrl+Shift+,) covers providers, models, access, MCP servers, hooks, skills, memories and instructions.
- **Help**: Ctrl+H opens Help, where an agent answers questions about Scribe. The clock button (and the list under the examples) reopens previous results without asking again. Settings → Help → Setup guide shows the first-run setup and tour again.

## Keyboard shortcuts

These are the defaults. Change them in Settings → Shortcuts: click a key, then press the new one.

| Keys | Action |
|---|---|
| Ctrl+D | Search palette: pages, Library content and saved page data. Prefixes: `=` threads, `?` Ask AI, `~` meaning search (editable in Settings → Search) |
| Ctrl+H | Open Help |
| Ctrl+B | Show or hide the Library sidebar |
| Ctrl+E | Spaces overview |
| Ctrl+Shift+PgUp / PgDn | Previous / next space |
| Ctrl+T or Ctrl+N | New page |
| Ctrl+S | Download the current page as HTML (markup only) |
| Ctrl+, (or Ctrl+Alt+S) | Settings |
| Ctrl+Shift+, (or Ctrl+Shift+Alt+S) | Agent settings |
| Ctrl+K | Show, focus or hide the floating chat |
| Ctrl+Shift+K | New thread (in a focused chat) |
| Ctrl+L | Show or hide the sidebar chat |
| Ctrl+Shift+L | Full-window chat |
| Ctrl+J | Thread list (in a focused chat) |
| Ctrl+' | Cycle starred models (in a focused chat) |
| Ctrl+Alt+' | Cycle reasoning effort (in a focused chat) |
| Ctrl+Shift+' | Cycle access level (in a focused chat) |
| Ctrl+. | Cycle workspace (in a focused chat) |
| Ctrl+Shift+. | Cycle Scribe scope (in a focused chat) |
| Ctrl+↑ / Ctrl+↓ (in a focused chat) | Grow the chat: expand the floating chat, then full window / shrink it back |
| Ctrl+K or Ctrl+L with text selected in a page | Ask the chat about the selection |
| / or Ctrl+F | Focus Library search while the sidebar is open |
| Alt+↑ / Alt+↓ | Move the focused Library row |
| F2 or double-click | Rename a page or folder in the Library |
| Esc | Close the palette, a peek, a dialog or the Library sidebar |
| Ctrl / Alt / Shift + click a link | Navigate / peek / split |
| Ctrl+Tab / Ctrl+Shift+Tab | Desktop app: next / previous tab |
| Ctrl+W | Desktop app: close a peek, else the current tab |
| Ctrl+Shift+T | Desktop app: reopen the last closed tab, or undo the last delete, whichever is newer |
| Ctrl+Shift+M | Desktop app: normal / compact window |
| F5 or Ctrl+R | Desktop app: reload Scribe |

On Nordic layouts the `'` keys are the `'*` key next to Enter, and `/` is Shift+7.

## Tabs

- Close a tab with × or middle-click; the page stays in the Library. Shift+click × deletes it (Undo in the notice, or Ctrl+Shift+T in the desktop app). Deleted pages stay in the Trash (Library ⋯ → Trash) for 7 days.
- Right-click a tab to pin, copy its key (`scribe:…`), export it or set its permissions. Double-click a tab copies its key; paste it into a chat so the agent knows which page you mean.
- Right-click inside a page for Ask agent, Copy, Select all and Copy page key. Shift+right-click shows the browser's own menu.
- A dot on a tab means it changed while you were elsewhere.

## Import and export

Settings has Import, Export and Export all (`.scribe.json` packs with HTML, state, images and templates). Import takes HTML files and packs; existing pages are never overwritten. Drop a file on Settings, the tab strip or the Library sidebar to import it.

## Data

The Library, tabs, page data and threads live in `%LOCALAPPDATA%\scribe` (`scribe.sqlite`, `agent.sqlite`); on Linux in `~/.local/share/scribe` (`$XDG_DATA_HOME/scribe`), on macOS in `~/Library/Application Support/Scribe`. A `~/scribe` data folder from an earlier version stays in use. Set `SCRIBE_HOME` to use another folder.

## Find & navigate

The palette is a search surface, a launcher and a way into records inside pages.

### Search

#### One palette, four search modes

- Find it: Ctrl+D · Settings → Search → Palette prefixes

Plain text finds pages. The default prefixes are `=` for threads, `?` for Ask AI and `~` for meaning search. Prefixes are editable; typing one turns it into a mode chip.

#### Search inside saved pages and their data

- Find it: Ctrl+D · plain text

Word search covers page titles, keys, page text and JSON state, including closed Library pages. Use a few distinctive words; filler words are ignored and remaining words must match. A space’s Library lens does not narrow the palette.

#### Find a section, card or image by meaning

- Find it: Ctrl+D → ~your description · Settings → Search

An optional local search pack enables meaning search across pages, sections, template records and indexed images. Results can open the matching section or record directly. Ordinary word searches also add related results when enabled. Indexing and the first model load can take time.

#### Use an image as the search query

- Find it: Paste or drop an image into Ctrl+D

Find visually similar indexed images, with the card, item or section they belong to. Requires meaning search to be enabled; typing switches back to a text query.

#### Ask a question across your pages

- Find it: Ctrl+D → ?your question

Press Enter on the Ask AI row to run the utility agent; merely typing does not spend a model call. An empty `?` shows recent questions and saved answers. The utility agent is configurable in Agent settings.

#### Search what was said in a thread

- Find it: Thread-list search · Ctrl+D → =words

Matches titles, scope labels, workspace paths, your messages and the agent’s replies. Words can match across metadata and messages; title matches rank first, and shortened character sequences can match a title. Tool output and thinking are excluded. Use Archived in the thread list for archived chats; palette thread search excludes them.

### Views & movement

#### A link can navigate, peek or split

- Find it: Hold Ctrl / Alt / Shift when opening a Scribe link

Ctrl navigates, Alt peeks and Shift splits. These also work in the Library and palette. Settings → Navigation chooses the normal link behavior. Peek is a quick overlay; splits support two to four panes.

#### Link directly to a card or heading

- Find it: Copy a page key · use an anchor or record link

Pages can link to a heading with `#heading-id`; a Kanban link can end in `#card=12`. Markdown pages and cards accept `[[scribe:key]]`, custom labels, and `[[peek:scribe:key]]` / `[[split:scribe:key]]`. Copy the actual key from the page menu.

#### Spaces remember a working set

- Find it: Space chip · Ctrl+E

Each space keeps its tab order, pins and focused page. A page can appear in several spaces and still has one shared set of data. Ctrl+Shift+PageUp / PageDown switches spaces directly; the palette also finds them.

#### Give a page or chat its own window

- Find it: Page menu → Open in new window · chat window controls

A page window includes its floating chat. The standalone chat window moves the sidebar/full-window conversation out of the main window and can return it. In a browser, blocked popups need to be allowed.

## Library & pages

Pages are durable objects; tabs, spaces and Library lenses are different views of them.

### Organize

#### Library keeps pages; closing removes a tab

- Find it: Library · tab strip

Close a tab to park its page in the Library. Pin keeps it through Clear. Drag a page onto the strip to open it; drag a tab into the Library to file it and close it.

#### A space can have a Library lens

- Find it: Library ⋯ → Edit lens…

Build All/Any rules, with per-rule Not: folders or the space’s home, space of creation, agent/user creator, origin page/folder, workspace or disk location, age, page kind, access, pinned/unread/has chats, and semantic “About” matching. The lens filters the view; Show all reveals the full Library.

#### Set a home folder for a space

- Find it: Library ⋯ → Edit lens… → Home folder

New pages made in that space go to its home folder when no folder is supplied. This controls the default destination independently of the lens conditions.

#### Select Library rows for bulk operations

- Find it: Library ⋯ → Select… · row selection

Move, export or delete selected entries; set agent access together. You can also set workspaces for selected pages and edit instructions for selected folders. Mixed folder instruction values stay unchanged unless you edit the field.

#### Clean up old pages by a chosen date

- Find it: Library ⋯ → Clean up tabs…

Choose age in days/weeks/months/years and base it on last activity, last edit, creation or close date. Open and pinned pages are excluded unless included explicitly; tabs parked in other spaces are protected as open pages.

### Files & templates

#### Link a Library folder to a disk folder

- Find it: Folder menu → Link to disk folder… · Open folder here…

Bring disk files into the Library hierarchy, rescan the linked folder, change or unlink it, and create files there. A disk folder can have one linked Library folder. File-deletion dialogs distinguish removing an entry from also deleting its file.

#### Open and edit disk files in Scribe

- Find it: Library ⋯ → Open file… / New file

File pages support text/code, Markdown, JSON, HTML, images and PDFs, with editing where supported. Saving checks whether the file changed on disk before overwriting it. File links from a chat can open temporary pages; Keep in Library makes one permanent.

#### Templates update the pages made from them

- Find it: Templates sidebar · template menu

Create reusable page types with opening fields and optional agent actions. Updating a template updates its linked instances; change a page’s data independently. Built-in copies follow app updates while uncustomized and compatible; customized or incompatible copies need attention.

#### Built-in notes, todos, boards and embeds

- Find it: Templates → Built-in

Markdown notes, Todo lists, Kanban boards and Embed pages are starting points. Opening a built-in adds your own template copy. Todo lists can use multiple columns and optional checkboxes.

### Page capabilities

#### A generated page can be a small application

- Find it: Ask the agent to build an interactive page

Page state persists in the daemon and is available to the agent. Shared changes synchronize across viewers; per-viewer filters and drafts can stay private to that viewer. Pages can use forms, assets, template actions and model-backed buttons.

#### A page has permissions of its own

- Find it: Page menu → Permissions…

Control agent chats after a click, unattended chats, workspace access, classifier requests, microphone/transcription and plugin access where applicable. These are separate from the chat’s own access settings. Riskier grants return to Ask after an agent changes the page’s code or template.

#### Attachment previews understand more than images

- Find it: Click a chat attachment or a page’s preview action

The shared viewer handles PDFs, video/audio, Markdown, CSV/TSV tables, JSON, text/code and sandboxed HTML. Arrow keys step through a set of files. This is also available to custom pages without building another viewer.

#### Plugins add backend features, widgets and page components

- Find it: Settings → Plugins

Import a plugin package, review its source/changes and requested access, configure it, inspect logs, restart it and export it. Updates can keep local customizations, take the incoming version or use an agent to merge. Plugin widgets can appear in pages or inline chat, and plugins can offer page components that pages load like Scribe's own.

## Chat & threads

Conversations with scoped context, queues, forks and several ways to keep them on screen.

### Find a conversation

#### One conversation, several chat layouts

- Find it: Ctrl+L · Ctrl+K · Ctrl+Shift+L

Sidebar, floating chat and full-window chat. Ctrl+J opens threads; Ctrl+↑ / ↓ moves between conversation views or expands/collapses the floating chat.

#### Here, Workspaces, All and Archived differ

- Find it: Thread list → filter tabs

Here collects relevant page/folder/workspace/global threads, including the thread that created the page. Workspaces groups by disk folder. Pin a thread to keep it prominent; archived conversations live under Archived.

#### Limit threads to where they were started

- Find it: Thread list → Space switch

Space restricts the list and floating chat to threads started in the active space. Each space remembers its filter tab and Space switch independently. Turn it off to find a conversation started elsewhere.

#### Recent means interacted with, not opened

- Find it: Thread-list tools → Recent

Shows up to five threads you sent to, answered or hold an unsent draft in during the last eight hours, from every scope. Simply opening a thread does not count. Each list has its own Recent switch.

#### Hide a workspace without losing search access

- Find it: Workspace group ⋯ → Hide workspace

Removes that workspace from normal lists and workspace menus. Searching still finds its threads; Archived offers hidden-workspace entries to show again. “Show stale worktrees” is in the same workspace menu.

### Compose & continue

#### Mention pages, folders, files and other chats

- Find it: Composer → @ · # · /

`@` brings in pages/folders/files; `@this` names the current page. `#` tags a thread and grants read access to it. `/` includes local commands, provider skills and template actions; the set depends on the provider and page.

#### Ask about a selected passage

- Find it: Select page text → right-click → Ask agent

Ctrl+K or Ctrl+L with page text selected also attaches it as a chip with the source page. Template actions can use the selection too.

#### Queue, edit, steer or send immediately

- Find it: Composer while an agent runs · Agent settings → Chat

Messages can wait in the queue or be steered into the running turn. Enter on an empty composer can steer/send the first queued message, with behavior set in Chat settings; ↑ edits the last queued message. Stop drops pending messages and offers Send again. Provider support affects when steering is received.

#### Plan one message before editing

- Find it: Composer → /plan <task> · Plan first option

Request a planning turn, then accept the plan to continue with implementation. A custom mode can make its first message a plan turn. This is separate from choosing the thread’s access rung.

#### Dictation can be push-to-talk or live

- Find it: Composer microphone · Ctrl+Shift+Space · Settings → Audio

Configure a speech-to-text source/model, microphone and language. Options include send after dictation, push-to-talk and showing text while speaking. Experimental live transcription supports server stream or sliding-window modes. Hosted sources receive the recording.

### Recover & branch

#### Fork a conversation, including across providers

- Find it: Thread menu → Fork thread · choose a different provider

Continue from an existing conversation in a separate thread. Switching providers stages a fork on send; the UI explains whether prior context comes as a provider session, full conversation or summary. You can archive the original on send. Summary models are configurable.

#### Edit or retry an already sent message

- Find it: Sent message → Change sent message / Retry message

Rewinds to before that message and removes its reply and later turns. When later work is affected, the dialog can also undo file/page changes or keep them. Treat this as a conversation/history change.

#### Work continues when the view is closed

- Find it: Close a chat panel, page or browser window

The daemon owns running agents. Leaving the chat view does not itself stop a turn. Board runs can additionally wait out provider limits and continue in the same card chat.

## Instructions & access

What a chat knows, which standing guidance it receives and which pages it can reach.

### Standing context

#### Folder-level agent instructions

- Find it: Library folder → right-click → Agent instructions

Set Description and Instructions on a Library folder. Page and folder threads inherit parent folders first, nearest folder last; edits apply on the next turn. Global/workspace threads do not inherit these. A page merely titled Instructions is an ordinary page.

#### Memories can be global, workspace or provider specific

- Find it: Agent settings → Memory · Agent harness → Memories

Saved guidance can follow all chats, a workspace or one provider/source. Browse, add, edit or remove it. Turning off shared memories keeps the saved notes but stops supplying or saving them, from the next message. Memory saves appear as notes in the conversation.

#### Provider/project instructions still apply

- Find it: Agent harness → instruction-file editors / Skills

Inspect and edit the instruction files a provider loads, such as AGENTS.md, CLAUDE.md and .cursorrules. Skills can be created, edited, copied to another provider and removed through the harness. Scribe folder instructions are an additional layer.

#### Switch individual Scribe guidance rules

- Find it: Agent settings → Instructions

Controls include checking a wrong-thread message, pointing out likely user slips, language labels for code blocks and thread naming. The dialog describes when the changed guidance applies.

### Scope & access

#### Workspace and Scribe scope are separate

- Find it: Composer scope/workspace chip · /here /folder /workspace /global

A disk workspace controls file work; Scribe scope controls which page/folder the chat belongs to. A page can store a default workspace for new chats. Cycle workspace with Ctrl+. and Scribe access with Ctrl+Shift+., including none.

#### Five levels of page/folder agent access

- Find it: Page or Library folder menu → Agent access

Open: every chat; Normal: in-scope chats, others ask; Ask always: every chat asks; Trusted only: trusted model sources; Restricted: only a chat on that exact page. A stricter parent folder wins. Menu entries also show and remove grants to other pages/folders.

#### Other conversation history needs access too

- Find it: #thread mention · chat permission requests · thread menu → Permissions…

Agents can search/read other chats when allowed. Tagging one grants that thread read access, including across normal scope boundaries. Existing grants can be inspected and removed from the thread menu.

#### Page code permissions and agent access differ

- Find it: Compare Page menu → Agent access and Permissions…

Agent access controls which chats reach a page. Permissions controls what that page’s own code may do, such as launch agents or record audio. The chat’s Read-only/Board/Edits ladder is a third boundary for its tools.

## Code & worktrees

Review changes, isolate a branch and bring completed work back into the checkout.

### Review & recovery

#### Review this turn, this thread or the working tree

- Find it: Turn footer → Review · thread menu → Changes in this thread

Git work captures before/after snapshots, including new files, without using your staging index. The diff viewer separates turn changes, accumulated thread changes and the current Git working tree; SVN working-copy review is supported too.

#### Revert a turn’s file changes

- Find it: Completed turn → Revert turn

Undo the files changed by that turn when the reverse patch still applies cleanly. Later edits can make a revert conflict. Review first to understand the actual change being reversed.

#### Restore a page’s pre-turn HTML

- Find it: Turn footer → Page edited

A turn on a scoped or attached page keeps an HTML checkpoint. The footer can restore it. This checkpoint concerns page code; shared page state is stored separately.

#### Open a diff at the chosen line in IntelliJ

- Find it: Settings → Integrations → IntelliJ IDEA

Enable the integration, optionally set its launcher, then use Open diff or IntelliJ on a diff. A selected diff line/column is carried into the editor.

### Workspaces & branches

#### Run a thread in an isolated Git worktree

- Find it: New chat’s workspace/worktree controls · branch menu

Give a chat its own branch and checkout. The branch menu offers merge into the base branch, Leave branch (keeps work, removes checkout), and Discard worktree (deletes branch and changes). Worker runs can merge automatically when finished.

#### Preview a worktree’s UI without live app data

- Find it: Open worktree → branch menu → Preview UI

Serves that checkout’s public/ assets on its own local preview origin. Reload to see edits. This shows layout/styles without the main app’s API or WebSocket data; a separate test daemon is needed for real data interactions.

#### Recover a moved workspace and its threads

- Find it: Thread → Folder not found · Update threads notice

Scribe can rediscover a renamed/moved folder on the same drive by file identity. “Locate moved folder…” lets you pick a cross-drive/copied destination. Updating threads also repairs related worktree paths and workspace configuration.

#### Code work without an attached project

- Find it: Workspace picker → No workspace

Editing access can run machine tasks in a scratch workspace under Scribe’s data folder. An agent can request a workspace move for ongoing work elsewhere; it applies after the current turn. An isolated worktree keeps its own workspace.

## Boards & automation

Workers run in the daemon; a visible board is the control surface, not the thing keeping them alive.

### Worker dispatch

#### Workers take only ready, assigned cards

- Find it: Kanban → Workers · ready-column cards

A running worker takes its own assigned cards, top first. Unassigned/person-assigned cards and stopped workers’ cards wait. A worker starts a fresh chat per card; its settings and shared instructions apply when that chat starts.

#### Parallelism has two separate caps

- Find it: Workers → Max parallel · Per provider

Overall parallelism caps automatically picked and one-card chats alike. Per provider separately caps chats using the same provider, regardless of worker name; Any removes a cap. Lowering the limit lets existing chats finish.

#### Defer pickup with Start after

- Find it: Card dialog → Start after

Choose the earliest local time for a worker to take a card. It still needs normal dispatch conditions, and pickup may follow the daemon’s next minute check. A running holder keeps working. Workers also respect dependencies and paused ready inboxes.

#### Workers run with the board closed

- Find it: Workers → run switch

The daemon dispatches and tracks worker runs, waits out provider plan limits and sends the same chat on after recovery. Finished worktree runs merge back; merge conflicts can be sent to the agent to resolve.

### Keep work moving

#### A comment can resume the card’s original chat

- Find it: Card comments → Continue

A comment on a held card reaches its running chat. After the chat ends, Continue requests another turn of that conversation; dispatch waits for dependencies, scheduling, a running worker, inbox, slot and permissions. Form replies can route back to the same card as comments and request continuation.

#### Ask about a card without taking it

- Find it: Workers → Default model · comment → Ask

With a default worker set, a comment on a card without a worker assignee offers Ask. It starts a separate question/investigation chat with the card snapshot, without claiming, assigning or moving the card.

#### Run one card; stop now or after current work

- Find it: Card right-click → Run · Workers stop controls

A one-card run is separate from the worker’s normal queue and still counts against its caps. Stop after current cards lets existing work finish; Stop now cancels the worker’s current chats.

#### Find why a worker is waiting

- Find it: Workers → logs / status

Starts, pauses, blocked launches, usage waits, resumes and merges are logged. A card can wait on assignment, dependencies, Start after, a paused inbox, concurrency, provider usage or page permissions. Card-specific failure normally blocks that card while the worker proceeds.

### Built-in tools

#### Labels and priority can be suggestions

- Find it: Board settings → Suggest labels and priority

The configured classifier can suggest chips for a new or edited card. Clicking applies one; a suggestion is separate from the card’s actual labels/priority. Label descriptions can give the classifier useful context.

#### Format a card's description

- Find it: card dialog → Description → Format · Board settings → Format model

A small model (Claude Haiku unless you pick another) rewrites the description as cleaner Markdown, keeping its wording. Undo format puts the old text back.

#### Template actions become agent commands

- Find it: Page/card right-click · Ctrl+P · chat / menu

Built-ins include Summarise, Break this down, Triage inbox and card-specific variants. Template authors choose the prompt, placement and model settings. Context-sensitive actions can receive the exact card or selection you clicked.

#### Cards carry more than status

- Find it: Card dialog · board filters and menus

Descriptions/comments support Markdown, page links, tables and images; cards also have checklists, due dates, assignees, priority, dependencies, covers and an archive. Completed worker cards can show token/cost usage.

## Models & controls

Provider settings, reusable restrictions and the tools for seeing what a conversation costs.

### Choose & configure

#### Several providers, including custom endpoints

- Find it: Agent settings → Providers

Claude, Codex and Cursor integrations, plus Native using configured model sources or supported environment API keys. Model sources can point to compatible hosted or local endpoints. Source trust also matters for Trusted only pages.

#### Star models and cycle without reopening pickers

- Find it: Model picker stars · Agent settings → Keys

Ctrl+' cycles starred models; Ctrl+Alt+' cycles reasoning. Ctrl+Shift+' cycles the access rungs you enabled under Chat → Access cycling. Reasoning/fast options depend on the provider/model.

#### Access is a ladder, with provider differences

- Find it: Composer access picker

Read-only → Board → Edits → Auto review → Full access. Board adds page changes; Edits adds workspace edits with command approval. Codex can run read-only sandbox commands on the first two rungs. Cursor’s SDK cannot ask for every tool, so its review can deny calls. Read the provider-specific detail in the picker.

#### Web access has provider-specific limits

- Find it: Composer Web control · Agent settings → Providers → Allowlists…

Full, Limited and Off govern the provider’s available search/fetch behavior. Limited uses the configured web allowlist where supported. Codex has no gated allowlist fetch, so Limited does not enable web search. Native/Cursor can use a configured SearXNG source. A domain allowlist alone does not enable a missing tool.

#### Use different models for background summaries

- Find it: Agent settings → Helpers & utilities

Choose Scribe’s utility agent for palette AI search and summary models for forks / Native context compaction. Provider-managed compaction remains the provider’s responsibility. Helpers can hand a requested task to another model and keep its own child thread.

### Inspect & constrain

#### See the cost and contents of agent context

- Find it: Agent settings → Agent harness / Advanced settings…

Overview, Session context, Tool use and Heaviest threads show token/cost statistics, cache share, failures, tool time/result size and typical first-call size. Session context breaks down instructions and tool schemas for a provider/workspace; Claude Measure compares real context counts with and without Scribe.

#### Create a restricted reusable mode

- Find it: Agent harness → Modes

Save instructions, a maximum access rung, first-message planning, web defaults, tool groups to disable and the MCP servers to keep. A thread keeps a copy of its restrictions, even if the saved mode is later deleted.

#### Detect patterns and intervene during a turn

- Find it: Agent harness → Hooks

Match keywords, regex, tool names or classifier questions against messages, output, thinking, tool calls/results or turn end. Actions flag, tell the agent, ask first, block or emit a signal. The coverage table says which providers can hold a tool before it runs. Detection can be disabled per thread.

#### Control what the classifier receives

- Find it: Settings → Classifier

Choose a source, allowed input categories and individual features: Native auto review, hook questions, page-creation hints, prompt-injection scan, search-result checks and page requests. Inspect today’s usage/latency. Hosted sources receive the enabled inputs.

#### Manage MCP servers and inspect tool overhead

- Find it: Agent harness → MCP servers / Skills

Add/edit/enable servers, see which a thread receives and why others are excluded, inspect their tools and identify unused tools. Skill listings expose provider discovery and estimated description-token overhead. Per-workspace server configuration is supported.

#### Optionally start the next usage window

- Find it: Agent settings → Providers → Plan usage

An opt-in setting sends a tiny context-free hello ten minutes after a reported five-hour reset for Claude or Codex, while Scribe runs. It uses some subscription allowance, skips ongoing work/exhausted weekly usage/unavailable access, and does not retry a failed send in that window.

#### Check the installed agent SDK versions

- Find it: Agent settings → Providers → Agent SDKs

Compares installed SDKs with npm’s latest releases, caches checks for six hours and offers a manual recheck. Applying an update still means updating Scribe’s dependencies and restarting.

## Data & desktop

Transfer, recovery, desktop behavior and settings that sit outside the daily chat workflow.

### Keep & recover

#### Undo a close or deletion; restore from Trash

- Find it: the notice's Undo · Ctrl+Shift+T (desktop app) · Library ⋯ → Trash

Ctrl+Shift+T undoes the more recent close/delete; a bulk delete counts as one step. Deleted pages/folders remain in Trash for seven days before permanent deletion. Closing alone keeps the page indefinitely in the Library.

#### HTML download and full export are different

- Find it: Ctrl+S · page/folder menu → Export · Settings → Import / Export

Ctrl+S downloads page markup only. A `.scribe.json` pack carries page state, images, Library placement and relevant templates. Export a page, a folder or everything; import restores packs. Browser drag/drop accepts packs on the strip, Library or Settings.

#### The daemon keeps data across UI restarts

- Find it: Local Scribe data folder

Library/pages, interactive state, spaces and chat transcripts are local daemon data. Browser and desktop clients see the same daemon. Provider resumable sessions are also kept separately. Hosted model/classifier/speech requests still send their inputs to those services.

### Desktop & preferences

#### Embedded sites behave differently on desktop

- Find it: Embed page · desktop app vs browser

Desktop can display sites that reject browser framing and catches Scribe shortcuts while an embedded site has focus. Browser frames may show Open in browser instead. Embedded sites use the desktop WebView2 profile, not your browser cookies/extensions; sign-ins may still differ.

#### Compact, tray and startup modes

- Find it: Desktop controls · Ctrl+Shift+M · Settings → Desktop

Compact mode remembers its own size/place and can stay on top. Close to tray hides on close; Launch at startup starts hidden when close-to-tray is enabled. Agent-created pages can bring a hidden app back.

#### Recover the daemon or check shell compatibility

- Find it: Desktop offline screen · Settings → Desktop → Build details

If the daemon stops, Start retries and the app returns once it answers. Build details show native version/build/executable/API revision; Update desktop appears when the UI needs newer native APIs. The check is compatibility-based rather than a remote-release check.

#### File drops have a desktop limitation

- Find it: Desktop app vs browser

The desktop shell currently does not deliver file drops to the page: this affects packs dropped on the strip/Library and attachments dropped on chat. Use the explicit import/file controls or the browser workflow.

#### Appearance, motion and layout are configurable

- Find it: Settings → Appearance / Navigation · Desktop → Reduce motion

Choose themes, sidebar placement and layout/effect options, including new-page backgrounds and working-thread effects. Desktop Reduce motion overrides Windows motion preference for Scribe and pages that honor it.
