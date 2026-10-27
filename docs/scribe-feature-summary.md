# Scribe feature summary

Companion source inventory for card #866. The user-facing reference is [Scribe feature atlas](scribe:scribe-feature-atlas), filed under Scribe/Feature guide.

Snapshot: 2026-10-28, based on the current checkout. This is a curated feature reference, with obvious controls deliberately brief. Provider behavior and customized template versions can differ. Implementation takes precedence over stale README wording.

Discoverability is an editorial estimate: **Easy to miss** = hidden menu, modifier, prerequisite or scope interaction; **Worth a closer look** = visible feature with less-visible depth; **At a glance** = obvious surface, summarized briefly.

Page design follows the user's [UI Style Guide](scribe:ui-style-guide) Graphite tokens, using an original full HTML document without the page kit. The page includes eight area tabs, a curated rediscovery view, cross-area text search, an Easy to miss filter, source notes and per-viewer navigation state.

## Maintenance

Update the page through Scribe page tools; do not replace user changes from this inventory blindly. Recheck the listed implementation sources when behavior changes. The page is stored in Scribe, not in this repository as an HTML artifact.

During research, corrected the Scribe skill's obsolete Instructions-page mechanism to the current folder-menu Description/Instructions fields.

## Find & navigate

The palette is a search surface, a launcher and a way into records inside pages.

### Search

#### One palette, four search modes

- Discoverability: Easy to miss. The same field changes purpose through punctuation.
- Find it: Ctrl+D · Settings → Search → Palette prefixes
- Sources: `public/app.js:5210`, `src/palettePrefixes.ts:14`

Plain text finds pages. The default prefixes are `=` for threads, `?` for Ask AI and `~` for meaning search. Prefixes are editable; typing one turns it into a mode chip.

#### Search inside saved pages and their data

- Discoverability: Worth a closer look. A tab switcher can look like title-only search.
- Find it: Ctrl+D · plain text
- Sources: `src/librarySearch.ts`, `src/pageSearch.ts`, `public/app.js:5330`

Word search covers page titles, keys, page text and JSON state, including closed Library pages. Use a few distinctive words; filler words are ignored and remaining words must match. A space’s Library lens does not narrow the palette.

#### Find a section, card or image by meaning

- Discoverability: Easy to miss. Requires setup and goes much deeper than page titles.
- Find it: Ctrl+D → ~your description · Settings → Search
- Sources: `public/app.js:5399`, `public/app.js:5470`, `docs/search-pack.md`

An optional local search pack enables meaning search across pages, sections, template records and indexed images. Results can open the matching section or record directly. Ordinary word searches also add related results when enabled. Indexing and the first model load can take time.

#### Use an image as the search query

- Discoverability: Easy to miss. There is no separate image-search screen.
- Find it: Paste or drop an image into Ctrl+D
- Sources: `public/app.js:5551`

Find visually similar indexed images, with the card, item or section they belong to. Requires meaning search to be enabled; typing switches back to a text query.

#### Ask a question across your pages

- Discoverability: Easy to miss. Looks like another search prefix but produces an answer.
- Find it: Ctrl+D → ?your question
- Sources: `public/app.js:5615`, `public/agent.js:11525`, `src/aiSearch.ts`

Press Enter on the Ask AI row to run the utility agent; merely typing does not spend a model call. An empty `?` shows recent questions and saved answers. The utility agent is configurable in Agent settings.

#### Search what was said in a thread

- Discoverability: Easy to miss. The list looks like a title filter; transcript matching is less visible.
- Find it: Thread-list search · Ctrl+D → =words
- Sources: `public/agent.js:1261`, `public/agent.js:1353`, `public/agent.js:12234`, `src/agent/threadSearch.ts`

Matches titles, scope labels, workspace paths, your messages and the agent’s replies. Words can match across metadata and messages; title matches rank first, and shortened character sequences can match a title. Tool output and thinking are excluded. Use Archived in the thread list for archived chats; palette thread search excludes them.

### Views & movement

#### A link can navigate, peek or split

- Discoverability: Worth a closer look. Modifiers extend ordinary links and search results.
- Find it: Hold Ctrl / Alt / Shift when opening a Scribe link
- Sources: `README.md:188`, `README.md:204`, `public/views.js`

Ctrl navigates, Alt peeks and Shift splits. These also work in the Library and palette. Settings → Navigation chooses the normal link behavior. Peek is a quick overlay; splits support two to four panes.

#### Link directly to a card or heading

- Discoverability: Easy to miss. Page links can target a specific record rather than just a page.
- Find it: Copy a page key · use an anchor or record link
- Sources: `README.md:186`, `templates/builtin/kanban.guide.md:86`

Pages can link to a heading with `#heading-id`; a Kanban link can end in `#card=12`. Markdown pages and cards accept `[[scribe:key]]`, custom labels, and `[[peek:scribe:key]]` / `[[split:scribe:key]]`. Copy the actual key from the page menu.

#### Spaces remember a working set

- Discoverability: Worth a closer look. The distinction between a working set and separate page storage is easy to miss.
- Find it: Space chip · Ctrl+E
- Sources: `README.md:57`, `public/spaces.js`

Each space keeps its tab order, pins and focused page. A page can appear in several spaces and still has one shared set of data. Ctrl+Shift+PageUp / PageDown switches spaces directly; the palette also finds them.

#### Give a page or chat its own window

- Discoverability: Worth a closer look. Available from secondary menus rather than the primary layout.
- Find it: Page menu → Open in new window · chat window controls
- Sources: `public/library.js:1989`, `public/popout.js:1`, `public/agent.js:12175`

A page window includes its floating chat. The standalone chat window moves the sidebar/full-window conversation out of the main window and can return it. In a browser, blocked popups need to be allowed.

## Library & pages

Pages are durable objects; tabs, spaces and Library lenses are different views of them.

### Organize

#### Library keeps pages; closing removes a tab

- Discoverability: At a glance. Foundational behavior; kept brief.
- Find it: Library · tab strip
- Sources: `README.md:288`, `README.md:292`

Close a tab to park its page in the Library. Pin keeps it through Clear. Drag a page onto the strip to open it; drag a tab into the Library to file it and close it.

#### A space can have a Library lens

- Discoverability: Easy to miss. A powerful query builder is tucked behind a Library menu.
- Find it: Library ⋯ → Edit lens…
- Sources: `public/library.js:496`, `public/lens.js:51`

Build All/Any rules, with per-rule Not: folders or the space’s home, space of creation, agent/user creator, origin page/folder, workspace or disk location, age, page kind, access, pinned/unread/has chats, and semantic “About” matching. The lens filters the view; Show all reveals the full Library.

#### Set a home folder for a space

- Discoverability: Easy to miss. The destination setting shares a dialog with view filtering.
- Find it: Library ⋯ → Edit lens… → Home folder
- Sources: `public/library.js:676`, `public/library.js:688`

New pages made in that space go to its home folder when no folder is supplied. This controls the default destination independently of the lens conditions.

#### Select Library rows for bulk operations

- Discoverability: Worth a closer look. The bulk menu offers settings beyond filing and deletion.
- Find it: Library ⋯ → Select… · row selection
- Sources: `public/library.js:1110`, `public/library.js:2009`

Move, export or delete selected entries; set agent access together. You can also set workspaces for selected pages and edit instructions for selected folders. Mixed folder instruction values stay unchanged unless you edit the field.

#### Clean up old pages by a chosen date

- Discoverability: Worth a closer look. Cleanup is more selective than its name suggests.
- Find it: Library ⋯ → Clean up tabs…
- Sources: `public/index.html:429`, `public/library.js:1530`, `README.md:63`

Choose age in days/weeks/months/years and base it on last activity, last edit, creation or close date. Open and pinned pages are excluded unless included explicitly; tabs parked in other spaces are protected as open pages.

### Files & templates

#### Link a Library folder to a disk folder

- Discoverability: Easy to miss. Library folders can represent real files, not just saved HTML pages.
- Find it: Folder menu → Link to disk folder… · Open folder here…
- Sources: `public/library.js:1349`, `public/library.js:1366`, `public/library.js:2170`, `src/diskFolders.ts`

Bring disk files into the Library hierarchy, rescan the linked folder, change or unlink it, and create files there. A disk folder can have one linked Library folder. File-deletion dialogs distinguish removing an entry from also deleting its file.

#### Open and edit disk files in Scribe

- Discoverability: Worth a closer look. A file page is connected to disk, unlike an ordinary generated page.
- Find it: Library ⋯ → Open file… / New file
- Sources: `src/filePages.ts:7`, `src/filePages.ts:234`, `public/library.js:1990`

File pages support text/code, Markdown, JSON, HTML, images and PDFs, with editing where supported. Saving checks whether the file changed on disk before overwriting it. File links from a chat can open temporary pages; Keep in Library makes one permanent.

#### Templates update the pages made from them

- Discoverability: Worth a closer look. The instance stays linked to its template after creation.
- Find it: Templates sidebar · template menu
- Sources: `README.md:292`, `src/builtinTemplates.ts`, `src/templates.ts`

Create reusable page types with opening fields and optional agent actions. Updating a template updates its linked instances; change a page’s data independently. Built-in copies follow app updates while uncustomized and compatible; customized or incompatible copies need attention.

#### Built-in notes, todos, boards and embeds

- Discoverability: At a glance. Visible starter tools; only the less obvious variations need space.
- Find it: Templates → Built-in
- Sources: `templates/builtin/todo-list.html:651`, `templates/builtin/todo-list.json`, `README.md:292`

Markdown notes, Todo lists, Kanban boards and Embed pages are starting points. Opening a built-in adds your own template copy. Todo lists can use multiple columns and optional checkboxes.

### Page capabilities

#### A generated page can be a small application

- Discoverability: Worth a closer look. Generated output can continue working after the originating chat ends.
- Find it: Ask the agent to build an interactive page
- Sources: `README.md:151`, `.cursor/skills/scribe/SKILL.md`

Page state persists in the daemon and is available to the agent. Shared changes synchronize across viewers; per-viewer filters and drafts can stay private to that viewer. Pages can use forms, assets, template actions and model-backed buttons.

#### A page has permissions of its own

- Discoverability: Easy to miss. Reading a page, running its code and granting its agent access are separate controls.
- Find it: Page menu → Permissions…
- Sources: `src/pagePermissions.ts`, `public/permissions.js`, `.cursor/skills/scribe/SKILL.md`

Control agent chats after a click, unattended chats, workspace access, classifier requests, microphone/transcription and plugin access where applicable. These are separate from the chat’s own access settings. Riskier grants return to Ask after an agent changes the page’s code or template.

#### Attachment previews understand more than images

- Discoverability: Worth a closer look. The same preview surface handles structured documents and media.
- Find it: Click a chat attachment or a page’s preview action
- Sources: `public/preview.js:1`, `.cursor/skills/scribe/SKILL.md`

The shared viewer handles PDFs, video/audio, Markdown, CSV/TSV tables, JSON, text/code and sandboxed HTML. Arrow keys step through a set of files. This is also available to custom pages without building another viewer.

#### Plugins add backend features and live components

- Discoverability: Easy to miss. More extensible than the built-in page templates.
- Find it: Settings → Plugins
- Sources: `public/plugin-settings.js`, `docs/plugin-system.md`

Import a plugin package, review its source/changes and requested access, configure it, inspect logs, restart it and export it. Updates can keep local customizations, take the incoming version or use an agent to merge. Plugin components can appear in pages or inline chat.

## Chat & threads

Conversations with scoped context, queues, forks and several ways to keep them on screen.

### Find a conversation

#### One conversation, several chat layouts

- Discoverability: At a glance. The visible list and layout need little explanation.
- Find it: Ctrl+L · Ctrl+K · Ctrl+Shift+L
- Sources: `public/agent.js:10566`, `README.md:252`

Sidebar, floating chat and full-window chat. Ctrl+J opens threads; Ctrl+↑ / ↓ moves between conversation views or expands/collapses the floating chat.

#### Here, Workspaces, All and Archived differ

- Discoverability: Worth a closer look. Here includes more context than the current page alone.
- Find it: Thread list → filter tabs
- Sources: `public/agent.js:1226`, `public/agent.js:8040`, `README.md:258`

Here collects relevant page/folder/workspace/global threads, including the thread that created the page. Workspaces groups by disk folder. Pin a thread to keep it prominent; archived conversations live under Archived.

#### Limit threads to where they were started

- Discoverability: Easy to miss. A scoped filter can hide a thread even when its page is visible.
- Find it: Thread list → Space switch
- Sources: `public/agent.js:52`, `public/agent.js:8058`

Space restricts the list and floating chat to threads started in the active space. Each space remembers its filter tab and Space switch independently. Turn it off to find a conversation started elsewhere.

#### Recent means interacted with, not opened

- Discoverability: Easy to miss. The rule differs from the usual recently-viewed list.
- Find it: Thread-list tools → Recent
- Sources: `public/agent.js:7962`

Shows up to five threads you sent to, answered or hold an unsent draft in during the last eight hours, from every scope. Simply opening a thread does not count. Each list has its own Recent switch.

#### Hide a workspace without losing search access

- Discoverability: Easy to miss. Hidden is a visibility choice rather than deletion.
- Find it: Workspace group ⋯ → Hide workspace
- Sources: `public/agent.js:1137`, `public/agent.js:1171`, `public/agent.js:8134`

Removes that workspace from normal lists and workspace menus. Searching still finds its threads; Archived offers hidden-workspace entries to show again. “Show stale worktrees” is in the same workspace menu.

### Compose & continue

#### Mention pages, folders, files and other chats

- Discoverability: Worth a closer look. The composer has several context pickers, not only slash commands.
- Find it: Composer → @ · # · /
- Sources: `README.md:276`, `public/agent.js`, `src/agent/mention.ts`, `src/agent/threadAccess.ts`

`@` brings in pages/folders/files; `@this` names the current page. `#` tags a thread and grants read access to it. `/` includes local commands, provider skills and template actions; the set depends on the provider and page.

#### Ask about a selected passage

- Discoverability: Worth a closer look. No need to copy and paste a passage into the prompt.
- Find it: Select page text → right-click → Ask agent
- Sources: `README.md:276`, `public/app.js:5083`

Ctrl+K or Ctrl+L with page text selected also attaches it as a chip with the source page. Template actions can use the selection too.

#### Queue, edit, steer or send immediately

- Discoverability: Easy to miss. Sending during a turn has several timing behaviors.
- Find it: Composer while an agent runs · Agent settings → Chat
- Sources: `public/agent.js:11690`, `public/agent.js:10580`, `README.md:276`

Messages can wait in the queue or be steered into the running turn. Enter on an empty composer can steer/send the first queued message, with behavior set in Chat settings; ↑ edits the last queued message. Stop drops pending messages and offers Send again. Provider support affects when steering is received.

#### Plan one message before editing

- Discoverability: Easy to miss. Planning can apply to one message rather than requiring a separate kind of thread.
- Find it: Composer → /plan <task> · Plan first option
- Sources: `public/agent.js:223`, `public/agent.js:12361`, `src/agent/customModes.ts:28`

Request a planning turn, then accept the plan to continue with implementation. A custom mode can make its first message a plan turn. This is separate from choosing the thread’s access rung.

#### Dictation can be push-to-talk or live

- Discoverability: Worth a closer look. Behavior is configurable beyond a simple microphone toggle.
- Find it: Composer microphone · Ctrl+Shift+Space · Settings → Audio
- Sources: `public/audio-settings.js:55`, `public/audio-settings.js:126`, `public/audio-composer.js`

Configure a speech-to-text source/model, microphone and language. Options include send after dictation, push-to-talk and showing text while speaking. Experimental live transcription supports server stream or sliding-window modes. Hosted sources receive the recording.

### Recover & branch

#### Fork a conversation, including across providers

- Discoverability: Worth a closer look. Provider changes preserve useful context through a fork.
- Find it: Thread menu → Fork thread · choose a different provider
- Sources: `public/agent.js:3184`, `public/agent.js:6215`, `src/agent/fork.ts`

Continue from an existing conversation in a separate thread. Switching providers stages a fork on send; the UI explains whether prior context comes as a provider session, full conversation or summary. You can archive the original on send. Summary models are configurable.

#### Edit or retry an already sent message

- Discoverability: Worth a closer look. Editing a sent prompt can also affect later work.
- Find it: Sent message → Change sent message / Retry message
- Sources: `public/agent.js:1940`, `public/agent.js:4434`

Rewinds to before that message and removes its reply and later turns. When later work is affected, the dialog can also undo file/page changes or keep them. Treat this as a conversation/history change.

#### Work continues when the view is closed

- Discoverability: Worth a closer look. Visible UI and execution lifetime are independent.
- Find it: Close a chat panel, page or browser window
- Sources: `README.md:243`, `src/agent/pageRuns.ts`

The daemon owns running agents. Leaving the chat view does not itself stop a turn. Board runs can additionally wait out provider limits and continue in the same card chat.

## Instructions & access

What a chat knows, which standing guidance it receives and which pages it can reach.

### Standing context

#### Folder-level agent instructions

- Discoverability: Easy to miss. No dedicated top-level screen; inheritance depends on chat scope.
- Find it: Library folder → right-click → Agent instructions
- Sources: `public/library.js:2009`, `src/agent/prompt.ts:208`, `README.md:264`

Set Description and Instructions on a Library folder. Page and folder threads inherit parent folders first, nearest folder last; edits apply on the next turn. Global/workspace threads do not inherit these. A page merely titled Instructions is an ordinary page.

#### Memories can be global, workspace or provider specific

- Discoverability: Easy to miss. Persistence and scope extend beyond the current transcript.
- Find it: Agent settings → Memory · Agent harness → Memories
- Sources: `src/agent/memory.ts`, `public/memories.js`, `public/agent.js:11531`

Saved guidance can follow all chats, a workspace or one provider/source. Browse, add, edit or remove it. Turning off shared memories keeps the saved notes but stops supplying or saving them, from the next message. Memory saves appear as notes in the conversation.

#### Provider/project instructions still apply

- Discoverability: Worth a closer look. Several instruction systems coexist and have different scopes.
- Find it: Agent harness → instruction-file editors / Skills
- Sources: `public/harness.js`, `src/agent/harnessFiles.ts`, `README.md:282`

Inspect and edit the instruction files a provider loads, such as AGENTS.md, CLAUDE.md and .cursorrules. Skills can be created, edited, copied to another provider and removed through the harness. Scribe folder instructions are an additional layer.

#### Switch individual Scribe guidance rules

- Discoverability: Easy to miss. App behavior is partly controlled by prompt guidance, not only UI settings.
- Find it: Agent settings → Instructions
- Sources: `public/agent.js:159`, `public/agent.js:11559`

Controls include checking a wrong-thread message, pointing out likely user slips, language labels for code blocks and thread naming. The dialog describes when the changed guidance applies.

### Scope & access

#### Workspace and Scribe scope are separate

- Discoverability: Easy to miss. Two independent context boundaries share nearby controls.
- Find it: Composer scope/workspace chip · /here /folder /workspace /global
- Sources: `public/agent.js:215`, `public/agent.js:10578`, `public/library.js:2002`, `src/agent/threadAccess.ts`

A disk workspace controls file work; Scribe scope controls which page/folder the chat belongs to. A page can store a default workspace for new chats. Cycle workspace with Ctrl+. and Scribe access with Ctrl+Shift+., including none.

#### Five levels of page/folder agent access

- Discoverability: Easy to miss. Access is richer than a single hide switch, with inherited limits.
- Find it: Page or Library folder menu → Agent access
- Sources: `public/library.js:2084`, `public/library.js:2131`, `src/pageAccess.ts`

Open: every chat; Normal: in-scope chats, others ask; Ask always: every chat asks; Trusted only: trusted model sources; Restricted: only a chat on that exact page. A stricter parent folder wins. Menu entries also show and remove grants to other pages/folders.

#### Other conversation history needs access too

- Discoverability: Worth a closer look. Sharing a page is different from sharing the conversations about it.
- Find it: #thread mention · chat permission requests · thread menu → Permissions…
- Sources: `src/agent/threadAccess.ts`, `public/agent.js:3833`, `public/agent.js:3875`

Agents can search/read other chats when allowed. Tagging one grants that thread read access, including across normal scope boundaries. Existing grants can be inspected and removed from the thread menu.

#### Page code permissions and agent access differ

- Discoverability: Easy to miss. Similar-sounding controls protect different directions of access.
- Find it: Compare Page menu → Agent access and Permissions…
- Sources: `src/pageAccess.ts`, `src/pagePermissions.ts`, `public/agent.js:166`

Agent access controls which chats reach a page. Permissions controls what that page’s own code may do, such as launch agents or record audio. The chat’s Read-only/Board/Edits ladder is a third boundary for its tools.

## Code & worktrees

Review changes, isolate a branch and bring completed work back into the checkout.

### Review & recovery

#### Review this turn, this thread or the working tree

- Discoverability: Worth a closer look. A single Review button contains several useful scopes.
- Find it: Turn footer → Review · thread menu → Changes in this thread
- Sources: `README.md:272`, `public/agent.js:2868`, `src/agent/fileSnapshots.ts`

Git work captures before/after snapshots, including new files, without using your staging index. The diff viewer separates turn changes, accumulated thread changes and the current Git working tree; SVN working-copy review is supported too.

#### Revert a turn’s file changes

- Discoverability: Easy to miss. Recovery is attached to each turn, not just to Git commands.
- Find it: Completed turn → Revert turn
- Sources: `README.md:272`, `src/agent/git.ts`, `public/agent.js`

Undo the files changed by that turn when the reverse patch still applies cleanly. Later edits can make a revert conflict. Review first to understand the actual change being reversed.

#### Restore a page’s pre-turn HTML

- Discoverability: Easy to miss. Page-code recovery is separate from file diffs and page data.
- Find it: Turn footer → Page edited
- Sources: `README.md:273`, `src/agent/pageEdits.ts`

A turn on a scoped or attached page keeps an HTML checkpoint. The footer can restore it. This checkpoint concerns page code; shared page state is stored separately.

#### Open a diff at the chosen line in IntelliJ

- Discoverability: Easy to miss. The integration only appears after opting in.
- Find it: Settings → Integrations → IntelliJ IDEA
- Sources: `public/integrations.js:5`, `public/integrations.js:44`

Enable the integration, optionally set its launcher, then use Open diff or Open in IntelliJ on a diff. A selected diff line/column is carried into the editor.

### Workspaces & branches

#### Run a thread in an isolated Git worktree

- Discoverability: Worth a closer look. The exit options have materially different effects on the saved work.
- Find it: New chat’s workspace/worktree controls · branch menu
- Sources: `src/agent/worktree.ts`, `public/agent.js:3795`, `src/agent/pageRuns.ts`

Give a chat its own branch and checkout. The branch menu offers merge into the base branch, Leave branch (keeps work, removes checkout), and Discard worktree (deletes branch and changes). Worker runs can merge automatically when finished.

#### Preview a worktree’s UI without live app data

- Discoverability: Easy to miss. A built-in preview exists, with a specific limit that is easy to overlook.
- Find it: Open worktree → branch menu → Preview UI
- Sources: `README.md:15`, `public/agent.js:3803`, `src/worktreePreview.ts`

Serves that checkout’s public/ assets on its own local preview origin. Reload to see edits. This shows layout/styles without the main app’s API or WebSocket data; a separate test daemon is needed for real data interactions.

#### Recover a moved workspace and its threads

- Discoverability: Easy to miss. Workspace history can survive a folder move.
- Find it: Thread → Folder not found · Update threads notice
- Sources: `README.md:260`, `src/agent/workspaceMove.ts`

Scribe can rediscover a renamed/moved folder on the same drive by file identity. “Locate moved folder…” lets you pick a cross-drive/copied destination. Updating threads also repairs related worktree paths and workspace configuration.

#### Code work without an attached project

- Discoverability: Worth a closer look. No workspace does not always mean no filesystem tools.
- Find it: Workspace picker → No workspace
- Sources: `README.md:262`, `src/agent/host.ts`, `src/agent/hostShell.ts`

Editing access can run machine tasks in a scratch workspace under Scribe’s data folder. An agent can request a workspace move for ongoing work elsewhere; it applies after the current turn. An isolated worktree keeps its own workspace.

## Boards & automation

Workers run in the daemon; a visible board is the control surface, not the thing keeping them alive.

### Worker dispatch

#### Workers take only ready, assigned cards

- Discoverability: Worth a closer look. Ready placement alone does not make a card eligible.
- Find it: Kanban → Workers · ready-column cards
- Sources: `templates/builtin/kanban.guide.md:43`, `src/actions/kanbanWorkers.ts`

A running worker takes its own assigned cards, top first. Unassigned/person-assigned cards and stopped workers’ cards wait. A worker starts a fresh chat per card; its settings and shared instructions apply when that chat starts.

#### Parallelism has two separate caps

- Discoverability: Easy to miss. A free global slot may still be blocked by the provider cap.
- Find it: Workers → Max parallel · Per provider
- Sources: `templates/builtin/kanban.guide.md:37`, `src/actions/kanbanWorkers.ts`

Overall parallelism caps automatically picked and one-card chats alike. Per provider separately caps chats using the same provider, regardless of worker name; Any removes a cap. Lowering the limit lets existing chats finish.

#### Defer pickup with Start after

- Discoverability: Easy to miss. A schedule is an earliest start, not an exact launch appointment.
- Find it: Card dialog → Start after
- Sources: `templates/builtin/kanban.guide.md`, `src/actions/kanbanWorkers.ts`

Choose the earliest local time for a worker to take a card. It still needs normal dispatch conditions, and pickup may follow the daemon’s next minute check. A running holder keeps working. Workers also respect dependencies and paused ready inboxes.

#### Workers run with the board closed

- Discoverability: Worth a closer look. The board is not a browser script that must stay visible.
- Find it: Workers → run switch
- Sources: `templates/builtin/kanban.guide.md:43`, `src/agent/pageRuns.ts`, `src/actions/kanbanWorkers.ts`

The daemon dispatches and tracks worker runs, waits out provider plan limits and sends the same chat on after recovery. Finished worktree runs merge back; merge conflicts can be sent to the agent to resolve.

### Keep work moving

#### A comment can resume the card’s original chat

- Discoverability: Easy to miss. Replies can become resumable work without creating another task.
- Find it: Card comments → Continue
- Sources: `templates/builtin/kanban.guide.md:14`, `.cursor/skills/scribe/SKILL.md`

A comment on a held card reaches its running chat. After the chat ends, Continue requests another turn of that conversation; dispatch waits for dependencies, scheduling, a running worker, inbox, slot and permissions. Form replies can route back to the same card as comments and request continuation.

#### Ask about a card without taking it

- Discoverability: Easy to miss. Ask and Continue use different workflows.
- Find it: Workers → Default model · comment → Ask
- Sources: `templates/builtin/kanban.guide.md:41`, `src/actions/kanbanWorkers.ts`

With a default worker set, a comment on a card without a worker assignee offers Ask. It starts a separate question/investigation chat with the card snapshot, without claiming, assigning or moving the card.

#### Run one card; stop now or after current work

- Discoverability: Worth a closer look. Running one item does not require starting a queue.
- Find it: Card right-click → Run · Workers stop controls
- Sources: `templates/builtin/kanban.guide.md:39`, `templates/builtin/kanban.guide.md:45`

A one-card run is separate from the worker’s normal queue and still counts against its caps. Stop after current cards lets existing work finish; Stop now cancels the worker’s current chats.

#### Find why a worker is waiting

- Discoverability: Easy to miss. A stopped-looking queue has several independent gates.
- Find it: Workers → logs / status
- Sources: `templates/builtin/kanban.guide.md:9`, `docs/kanban-worker-trigger-conditions.md`

Starts, pauses, blocked launches, usage waits, resumes and merges are logged. A card can wait on assignment, dependencies, Start after, a paused inbox, concurrency, provider usage or page permissions. Card-specific failure normally blocks that card while the worker proceeds.

### Built-in tools

#### Labels and priority can be suggestions

- Discoverability: Worth a closer look. A displayed suggestion is not already applied data.
- Find it: Board settings → Suggest labels and priority
- Sources: `templates/builtin/kanban.guide.md:93`, `src/ml/page.ts`, `templates/builtin/kanban.html`

The configured classifier can suggest chips for a new or edited card. Clicking applies one; a suggestion is separate from the card’s actual labels/priority. Label descriptions can give the classifier useful context.

#### Template actions become agent commands

- Discoverability: Easy to miss. The same action is reachable in multiple places and can target a record.
- Find it: Page/card right-click · Ctrl+P · chat / menu
- Sources: `README.md:278`, `public/app.js:5085`

Built-ins include Summarise, Break this down, Triage inbox and card-specific variants. Template authors choose the prompt, placement and model settings. Context-sensitive actions can receive the exact card or selection you clicked.

#### Cards carry more than status

- Discoverability: At a glance. Visible card fields are summarized briefly.
- Find it: Card dialog · board filters and menus
- Sources: `templates/builtin/kanban.guide.md`

Descriptions/comments support Markdown, page links, tables and images; cards also have checklists, due dates, assignees, priority, dependencies, covers and an archive. Completed worker cards can show token/cost usage.

## Models & controls

Provider settings, reusable restrictions and the tools for seeing what a conversation costs.

### Choose & configure

#### Several providers, including custom endpoints

- Discoverability: At a glance. Basic provider choice is visible; source behavior is less so.
- Find it: Agent settings → Providers
- Sources: `public/agent.js:11454`, `public/agent.js:11580`, `src/agent/openaiSources.ts`

Claude, Codex and Cursor integrations, plus Native using configured model sources or supported environment API keys. Model sources can point to compatible hosted or local endpoints. Source trust also matters for Trusted only pages.

#### Star models and cycle without reopening pickers

- Discoverability: Worth a closer look. Stars double as a keyboard rotation list.
- Find it: Model picker stars · Agent settings → Keys
- Sources: `public/agent.js:10566`, `public/agent.js:11703`

Ctrl+' cycles starred models; Ctrl+Alt+' cycles reasoning. Ctrl+Shift+' cycles the access rungs you enabled under Chat → Access cycling. Reasoning/fast options depend on the provider/model.

#### Access is a ladder, with provider differences

- Discoverability: Worth a closer look. Similar labels do not imply identical provider enforcement.
- Find it: Composer access picker
- Sources: `public/agent.js:166`, `public/agent.js:194`, `src/agent/effectivePermissions.ts`

Read-only → Board → Edits → Auto review → Full access. Board adds page changes; Edits adds workspace edits with command approval. Codex can run read-only sandbox commands on the first two rungs. Cursor’s SDK cannot ask for every tool, so its review can deny calls. Read the provider-specific detail in the picker.

#### Web access has provider-specific limits

- Discoverability: Worth a closer look. The web setting is not implemented identically by every provider.
- Find it: Composer Web control · Agent settings → Providers → Allowlists…
- Sources: `public/agent.js:174`, `public/agent.js:188`, `public/agent.js:199`, `src/agent/webAccess.ts`

Full, Limited and Off govern the provider’s available search/fetch behavior. Limited uses the configured web allowlist where supported. Codex has no gated allowlist fetch, so Limited does not enable web search. Native/Cursor can use a configured SearXNG source. A domain allowlist alone does not enable a missing tool.

#### Use different models for background summaries

- Discoverability: Easy to miss. These choices affect work outside the main conversation’s model picker.
- Find it: Agent settings → Helpers & utilities
- Sources: `public/agent.js:11513`, `public/agent.js:11520`

Choose Scribe’s utility agent for palette AI search and summary models for forks / Native context compaction. Provider-managed compaction remains the provider’s responsibility. Helpers can hand a requested task to another model and keep its own child thread.

### Inspect & constrain

#### See the cost and contents of agent context

- Discoverability: Easy to miss. A diagnostic console sits behind the regular settings dialogs.
- Find it: Agent settings → Agent harness / Advanced settings…
- Sources: `public/harness.js:21`, `public/harness.js:489`, `README.md:282`

Overview, Session context, Tool use and Heaviest threads show token/cost statistics, cache share, failures, tool time/result size and typical first-call size. Session context breaks down instructions and tool schemas for a provider/workspace; Claude Measure compares real context counts with and without Scribe.

#### Create a restricted reusable mode

- Discoverability: Easy to miss. A mode can shape the available tools, not just add a prompt.
- Find it: Agent harness → Modes
- Sources: `src/agent/customModes.ts:5`, `public/harness.js`

Save instructions, a maximum access rung, first-message planning, web defaults, tool groups to disable and the MCP servers to keep. A thread keeps a copy of its restrictions, even if the saved mode is later deleted.

#### Detect patterns and intervene during a turn

- Discoverability: Easy to miss. Automation and provider coverage live behind advanced settings.
- Find it: Agent harness → Hooks
- Sources: `public/agent.js:2121`, `src/agent/hooks.ts`

Match keywords, regex, tool names or classifier questions against messages, output, thinking, tool calls/results or turn end. Actions flag, tell the agent, ask first, block or emit a signal. The coverage table says which providers can hold a tool before it runs. Detection can be disabled per thread.

#### Control what the classifier receives

- Discoverability: Easy to miss. These short decisions are a separate service from the main chat model.
- Find it: Settings → Classifier
- Sources: `public/ml-settings.js:5`, `src/ml/settings.ts`

Choose a source, allowed input categories and individual features: Native auto review, hook questions, page-creation hints, prompt-injection scan, search-result checks and page requests. Inspect today’s usage/latency. Hosted sources receive the enabled inputs.

#### Manage MCP servers and inspect tool overhead

- Discoverability: Worth a closer look. Connection setup and context diagnostics share a deeper control panel.
- Find it: Agent harness → MCP servers / Skills
- Sources: `public/harness.js`, `src/agent/mcpConfig.ts`, `README.md:282`

Add/edit/enable servers, see which a thread receives and why others are excluded, inspect their tools and identify unused tools. Skill listings expose provider discovery and estimated description-token overhead. Per-workspace server configuration is supported.

#### Optionally start the next usage window

- Discoverability: Easy to miss. A small scheduler is hidden among usage displays.
- Find it: Agent settings → Providers → Plan usage
- Sources: `public/agent.js:11593`, `src/agent/usageWindowStarts.ts`

An opt-in setting sends a tiny context-free hello ten minutes after a reported five-hour reset for Claude or Codex, while Scribe runs. It uses some subscription allowance, skips ongoing work/exhausted weekly usage/unavailable access, and does not retry a failed send in that window.

#### Check the installed agent SDK versions

- Discoverability: Worth a closer look. The version check informs you; it is not an automatic installer.
- Find it: Agent settings → Providers → Agent SDKs
- Sources: `public/agent.js:11462`, `src/agent/sdkUpdates.ts`

Compares installed SDKs with npm’s latest releases, caches checks for six hours and offers a manual recheck. Applying an update still means updating Scribe’s dependencies and restarting.

## Data & desktop

Transfer, recovery, desktop behavior and settings that sit outside the daily chat workflow.

### Keep & recover

#### Undo a close or deletion; restore from Trash

- Discoverability: Worth a closer look. Close, delete and permanent deletion have different lifetimes.
- Find it: Ctrl+Z · Library ⋯ → Trash
- Sources: `README.md:288`, `public/trash.js`

Ctrl+Z undoes the more recent close/delete; a bulk delete counts as one step. Deleted pages/folders remain in Trash for seven days before permanent deletion. Closing alone keeps the page indefinitely in the Library.

#### HTML download and full export are different

- Discoverability: Easy to miss. A saved HTML file does not include the full working page data.
- Find it: Ctrl+S · page/folder menu → Export · Settings → Import / Export
- Sources: `README.md:290`, `src/boardExport.ts`

Ctrl+S downloads page markup only. A `.scribe.json` pack carries page state, images, Library placement and relevant templates. Export a page, a folder or everything; import restores packs. Browser drag/drop accepts packs on the strip, Library or Settings.

#### The daemon keeps data across UI restarts

- Discoverability: At a glance. Local storage does not imply that configured model calls stay local.
- Find it: Local Scribe data folder
- Sources: `README.md:284`, `README.md:286`, `README.md:87`

Library/pages, interactive state, spaces and chat transcripts are local daemon data. Browser and desktop clients see the same daemon. Provider resumable sessions are also kept separately. Hosted model/classifier/speech requests still send their inputs to those services.

### Desktop & preferences

#### Embedded sites behave differently on desktop

- Discoverability: Worth a closer look. Embedding has platform-dependent behavior.
- Find it: Embed page · desktop app vs browser
- Sources: `README.md:85`

Desktop can display sites that reject browser framing and catches Scribe shortcuts while an embedded site has focus. Browser frames may show Open in browser instead. Embedded sites use the desktop WebView2 profile, not your browser cookies/extensions; sign-ins may still differ.

#### Compact, tray and startup modes

- Discoverability: Worth a closer look. Several window behaviors interact behind desktop settings.
- Find it: Desktop controls · Ctrl+Shift+M · Settings → Desktop
- Sources: `README.md:78`, `README.md:80`, `README.md:81`

Compact mode remembers its own size/place and can stay on top. Close to tray hides on close; Launch at startup starts hidden when close-to-tray is enabled. Agent-created pages can bring a hidden app back.

#### Recover the daemon or check shell compatibility

- Discoverability: Easy to miss. Useful diagnostics are hidden until failure or incompatibility.
- Find it: Desktop offline screen · Settings → Desktop → Build details
- Sources: `README.md:73`, `README.md:82`

If the daemon stops, Start retries and the app returns once it answers. Build details show native version/build/executable/API revision; Update desktop appears when the UI needs newer native APIs. The check is compatibility-based rather than a remote-release check.

#### File drops have a desktop limitation

- Discoverability: Easy to miss. A supported browser gesture can appear broken in desktop.
- Find it: Desktop app vs browser
- Sources: `README.md:101`

The desktop shell currently does not deliver file drops to the page: this affects packs dropped on the strip/Library and attachments dropped on chat. Use the explicit import/file controls or the browser workflow.

#### Appearance, motion and layout are configurable

- Discoverability: At a glance. Visible preferences are kept concise.
- Find it: Settings → Appearance / Navigation · Desktop → Reduce motion
- Sources: `public/app.js:1545`, `public/index.html:301`, `README.md:74`

Choose themes, sidebar placement and layout/effect options, including new-page backgrounds and working-thread effects. Desktop Reduce motion overrides Windows motion preference for Scribe and pages that honor it.

