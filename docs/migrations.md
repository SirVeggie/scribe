# Migrations

## Agent port and a narrower local token (#915, #916, no version bump)

- **What changed:** The daemon also listens on `AGENT_PORT` (`SCRIBE_AGENT_PORT`, default board port + 2, loopback). Every caller there is an agent; Scribe chats' MCP calls it and the sandbox allows only it, never the board port. On the board port, the `local-token` file now makes a caller the user only on `/api/devices*` (the `scribe` CLI's device commands); anywhere else it is an external MCP client, and it no longer opens a board WebSocket.
- **Callers to update:** scripts that act as the user on other routes send the board UI's headers instead: `Sec-Fetch-Site: same-origin` and `Origin: <board origin>`, as `tools/perf/*.mjs`, `tools/eval-rerank.mjs`, `tools/probe-*.ts` and the HTTP tests do. They work only on the board port, which a sandbox never opens.
- **Why no version bump:** The shell and pages are unchanged. A chat's MCP falls back to the board port when an older daemon has no agent port.
- **Where:** `src/callers.ts`, `src/http.ts`, `src/daemon.ts`, `src/config.ts`, `src/agent/sandbox.ts`.
- **How to verify:** `src/callers.test.ts`, `src/pageAccessHttp.test.ts`.
- **When to remove:** Keep.

## `message_text` table and triggers (`agent.sqlite`, #602, additive, schema still 1)

- **What changed:** Thread message search (the thread menu, the palette's thread search, and `thread_list` with `messages: true`) reads a new `message_text` table instead of scanning every item's JSON. It holds one row per searchable item (`item_id`, `thread_id`, `seq`, `text`): the user's messages and the agent's own replies, not dropped and not a subagent's. On the real history that is about 5 MB of 195 MB, and queries went from 250–300 ms to 9–37 ms.
- **Data:** Two triggers on `items` (`items_message_text_insert`, `items_message_text_update`) keep it current, and `ON DELETE CASCADE` from `items(id)` removes rows with their item or thread. The triggers live in the database, so an older daemon writing items keeps the table correct too. On open, `fillMessageText` fills the table from `items` once (about 0.4 s on the real history) and writes `message_text = 1` to `meta`.
- **Changing what is searchable:** edit `searchable()` in `src/agent/db.ts` and `searchableMessageText` in `public/agent.js`, drop and recreate both triggers, and bump `MESSAGE_TEXT_VERSION` so the table is rebuilt.
- **Why no version bump:** Nothing existing changes; `CREATE ... IF NOT EXISTS` runs on every open. `AGENT_SCHEMA_VERSION` stays `1` and `VERSION` stays as is.
- **Where:** `src/agent/db.ts` (`searchMessages`, `messagesMentioning`, `fillMessageText`), `src/agent/threadSearch.ts` (`textLikePatterns`), `src/agent/host.ts` (`searchThreadMessages`, `listReadableThreads`). `tools/probe-thread-search-real.ts` measures the real history read-only.
- **How to verify:** `src/agent/threadSearch.test.ts`, `src/agent/threadSearchHost.test.ts`, `src/agent/threadAccess.test.ts`.
- **When to remove:** Keep.

## Newest-first unpinned strip and the `strip_order` meta key (#861, data change, schema still 3)

- **What changed:** New unpinned tabs open at the left of the unpinned group (next to the pinned tabs) instead of the right end, so the strip sorts unpinned tabs by `strip_seq` descending. Pinned tabs still sort ascending (new pins on the right). Space switches and Open folder number tabs so their saved or Library order still reads left to right.
- **Data:** `ensureNewestFirstStrip` reverses the `strip_seq` of open unpinned tabs once, so the order users had stays, then writes `strip_order = newest-first` to the meta table. Closed tabs keep their seqs: a Ctrl+Z restore of a tab closed before the update may land in a different spot.
- **Why no version bump:** The migration runs on open and is guarded by the meta key. An older daemon on a migrated board shows the unpinned tabs reversed. `SCHEMA_VERSION` and `VERSION` stay as is.
- **Where:** `src/dbMigrate.ts` (`ensureNewestFirstStrip`), `src/db.ts`, `src/store.ts` (`rebuildOrder`, `switchSpace`, `openFolder`), `public/app.js` (`renderTabs`, `revealTab`: a new tab out of view scrolls to the middle of the strip).
- **How to verify:** `src/store.test.ts` (#861 tests), `src/spaces.test.ts`.
- **When to remove:** Keep.

## Shared markdown renderer `/vendor/scribe-md.js` (#770, additive, no data change)

- **What changed:** The markdown note, the kanban board (descriptions and comments) and the file page render markdown with one script, `templates/scribe-md.js`, served as `/vendor/scribe-md.js` on top of `/vendor/marked.js` and `/vendor/purify.js`. It replaces the note's and board's own parsers. Notes and cards keep their line-by-line reading (a single newline is a break, a plain line ends the list or quote above it, one `~` is not a strike) and show raw HTML as text; the file page keeps standard markdown with sanitized HTML.
- **Why no version bump:** The route is additive. A page whose HTML loads the script from a daemon without it shows the text unrendered.
- **Data:** none. Card and note text is unchanged; checkboxes still write `[x]` / `[ ]` into it.
- **Protocol:** additive: the content origin (and worktree previews) may load `/vendor/scribe-md.js`. `VERSION` stays as is.
- **Where:** `templates/scribe-md.js`, `src/http.ts`, `src/contentOrigin.ts`, `templates/builtin/markdown-note.html`, `templates/builtin/kanban.html`, `templates/file-page.html`.
- **How to verify:** `src/scribeMd.test.ts`, `src/shellAssets.test.ts`.
- **When to remove:** Keep.

## `folders.disk` column and the `files` meta key (#707, additive, schema still 3)

- **What changed:** A Library folder can stand for a disk folder: `folders.disk TEXT` holds its absolute path (`Folder.disk`). Subfolders without one inherit `<parent's location>\<name>`; renaming or moving one whose disk folder exists pins that path as its own link. Open folder now links the folder it makes (and updates the folder already linked to that disk folder instead of making a second one); one Library folder per disk folder. The meta table gains a `files` key (JSON `{ defaultLocation?, deleteFiles?: "trash" | "keep" }`): where new files go when the target folder is not on disk, and what deleting a file page does with its file. The daemon watches each linked disk folder (one recursive `fs.watch` per root; nested and equal links share it) and gives new files there pages.
- **Why no version bump:** Existing rows read as null (not on disk), so nothing is watched or moved until a folder is linked. `ensureFolderDiskColumn` checks `PRAGMA table_info(folders)` before `ALTER TABLE`. A board without the `files` key has no default location and asks before deleting a file. `SCHEMA_VERSION` stays `3`.
- **Export format:** unchanged; disk paths are on this PC.
- **Protocol:** additive: `disk` on folders; `PUT /api/folders/:fid/disk`, `POST /api/folders/:fid/rescan`, `GET` / `PUT /api/files/settings`, `POST /api/files/create` (409 `needsLocation` or `exists`), `keepBoth` on `POST /api/tabs/:id/move` (409 `exists`; the board moving a file page into a folder on disk moves its file, agents only move the page), `file=trash` on `DELETE /api/tabs/:id?permanent=true`. All board UI only. `VERSION` stays as is.
- **Where:** `src/diskFolders.ts`, `src/schema.ts`, `src/dbMigrate.ts` (`ensureFolderDiskColumn`), `src/db.ts` (`readMetaJson`, `writeMetaJson`), `src/types.ts`, `src/store.ts` (`folderDiskPath`, `setFolderDisk`, `createFile`, `moveFileWithPage`, `watchDisk`, `diskChanged`), `src/http.ts`, `public/files.js`, `public/library.js`, `public/app.js`, `public/newpage.js`, `public/agent.js` (`pickWorkspace` `remember`).
- **How to verify:** `src/diskFolders.test.ts`.
- **When to remove:** Keep. This is the current schema.

## `tabs.made_in` column, space home folders and lenses (#260, additive, schema still 3)

- **What changed:** Spaces can have a home folder and a Library lens (`home`, `lens` on each space in the `spaces` meta JSON). A page records the space it was made in as `tabs.made_in TEXT` (the active space for the user's pages, the space a chat was started in for an agent's), and a new page without a folder goes to that space's home folder (for an agent, only when it could still reach a page there). Threads (`agent.sqlite`, JSON) gain `space`. The lens is evaluated in the board (`public/lens.js`); its About condition asks `GET /api/search/about`, which caches each phrase until the index changes.
- **Why no version bump:** Existing rows read as null (made in no recorded space); `ensureMadeInColumn` checks `PRAGMA table_info(tabs)` before `ALTER TABLE`. Spaces without `home` or `lens` behave as before, and thread `space` is optional JSON. `SCHEMA_VERSION` stays `3`.
- **Export format:** unchanged; space ids are local.
- **Protocol:** additive: `home` and `lens` on `PATCH /api/spaces/:sid` and in the spaces view, `madeIn` on tab meta, `space` on threads, `homeOf` and `newPages` on `GET /api/folders/tree` (MCP `library_folders` names home folders and where new pages go), `GET /api/search/about` (board UI only). `VERSION` stays as is.
- **Where:** `src/lens.ts`, `src/spaces.ts`, `src/schema.ts`, `src/dbMigrate.ts` (`ensureMadeInColumn`), `src/db.ts`, `src/types.ts`, `src/store.ts` (`spaceHome`, `placeNew`, `newPageSpace`), `src/http.ts` (`homeFits`), `src/agent/host.ts` (`startSpace`), `src/search/indexer.ts` (`aboutPages`), `src/search/routes.ts`, `src/mcp.ts`, `public/lens.js`, `public/library.js`, `public/agent.js`, `public/app.js`, `public/spaces.js`.
- **How to verify:** `src/spaces.test.ts`, `src/lens.test.ts`.
- **When to remove:** Keep. This is the current schema.

## Page origins and caller tokens (#690, protocol `3.1.0`)

- **What changed:** Each tab page runs on an origin of its own, `http://t-<hex>.localhost:<port>` for `t_<hex>` (other ids: `x<hex of the id>`). `/view/:id` and the page routes answer only there; `127.0.0.2` redirects `/view` there and serves only shared files and blobs. Agent identity is a token: chats' MCPs get `SCRIBE_THREAD_TOKEN` (sent as `x-scribe-token`), and the data folder gets two new secret files, `agent-secret` and `local-token` (sent as `x-scribe-local-token` by MCPs outside a chat and by local tools acting as the user).
- **Why the version bump:** The shell checks frame messages against each page's origin and loads frames from it; an old shell and a new daemon (or the reverse) disagree on where pages live. `VERSION` and `BOARD_VERSION` are `3.1.0`, so open windows reload.
- **Data:** none. Pages' `localStorage` was on `127.0.0.2` and is not carried over (pages are told not to use it).
- **Callers to update:** scripts that call the daemon without the MCP now count as anonymous agents (no pages, no board routes). Send `x-scribe-local-token` with the `local-token` file's contents, as `tools/perf/*.mjs`, `tools/eval-rerank.mjs` and `tools/probe-*.ts` do.
- **Where:** `src/config.ts` (`pageHost`), `src/contentOrigin.ts`, `src/callers.ts`, `src/pageAccess.ts` (`frameReach`), `src/http.ts`, `src/daemon.ts`, the providers in `src/agent/providers/`, `public/app.js`, `public/views.js`, `src/bridge.ts`, `desktop/src/embeds.rs`.
- **How to verify:** `src/shellAssets.test.ts`, `src/pageAccess.test.ts`, `src/pageAccessHttp.test.ts`.
- **When to remove:** Keep.

## `tabs.access` and `folders.access` columns (additive, schema still 3)

- **What changed:** Scribe access scopes page reach (#269). A page's or folder's agent access is stored as JSON in a new `access TEXT` column: `level` (`ask`, `trusted`; folders also `restricted`), the grants chats on it hold (`grants: [{ kind: "page" | "folder", id }]`), and for a page its `origin` (the page or folder of the chat that created it). A page's Restricted level stays `tabs.agent_hidden` (was Hide from agent). Threads (`agent.sqlite`, JSON) gain `pageGrants`, `formerScopes` and `tainted`; native model sources gain `trusted`.
- **Why no version bump:** Existing rows read as null: open, no grants, no origin, which is today's reach for global chats. `ensureAccessColumns` checks `PRAGMA table_info` before `ALTER TABLE`. Thread and source fields are optional JSON. `SCHEMA_VERSION` stays `3`.
- **Export format:** unchanged; access stays on this PC (grants and origins name local ids).
- **Protocol:** additive: `access` on tab meta and folders; `PUT /api/tabs/:id/access` and `PUT /api/folders/:fid/access` (board UI only); `POST /api/page-access` for MCP `page_access`; `outside` lists on `GET /api/tabs` and `GET /api/library` for agents. Agent requests to a page outside their reach now answer 403 (ask with `page_access`; for a Trusted only page and an untrusted model, without its title) or 404 (Restricted). `VERSION` stays `3.0.0`.
- **Where:** `src/pageAccess.ts`, `src/schema.ts`, `src/dbMigrate.ts` (`ensureAccessColumns`), `src/db.ts`, `src/types.ts`, `src/store.ts`, `src/http.ts`, `src/search/routes.ts`, `src/mcp.ts`, `src/agent/host.ts`, `src/agent/grants.ts`, `src/agent/openaiSources.ts`, `public/library.js`, `public/agent.js`.
- **How to verify:** `src/pageAccess.test.ts`, `src/pageAccessHttp.test.ts`, `src/agent/pageAccess.test.ts`.
- **When to remove:** Keep. This is the current schema.

## `thread_stats` table and `hiddenWorkspaces` pref (`agent.sqlite`, additive, schema still 1)

- **What changed:** A workspace can be hidden or deleted from the thread list (#507). Hidden workspace folders are kept in the saved `prefs` setting as `hiddenWorkspaces: string[]`. Deleting a workspace deletes its threads for good, after writing one row per thread to a new `thread_stats` table: `id` (the thread's id), `deleted_at`, `workspace`, and `data` (JSON `ThreadStats`: settings, dates, token and cost totals, per-turn usage, tool call counts, message and character counts; no titles, messages, tool input or output, file names or page ids).
- **Why no version bump:** Nothing existing changes. `CREATE TABLE IF NOT EXISTS` runs on every open, and prefs without `hiddenWorkspaces` read as an empty list. `AGENT_SCHEMA_VERSION` stays `1`.
- **Protocol:** additive routes `POST /api/agent/workspaces/hide`, `POST /api/agent/workspaces/delete`, `GET /api/agent/workspaces/deleted-stats`. `GET /api/agent/harness/stats` now counts the deleted threads in its totals (not in its heaviest-threads list). `VERSION` stays `3.0.0`.
- **Where:** `src/agent/threadStats.ts`, `src/agent/db.ts` (`saveThreadStats`, `listThreadStats`), `src/agent/host.ts` (`setWorkspaceHidden`, `deleteWorkspace`), `src/agent/harness.ts` (`harnessStats` `deleted`), `src/agent/prefs.ts`, `public/agent.js`.
- **How to verify:** `src/agent/workspaceDelete.test.ts`.
- **When to remove:** Keep. This is the current schema.

## `tabs.temp` column (additive, schema still 3)

- **What changed:** Temporary pages (#655, #403): a `file:` link, or a website opened in a split or as a tab from a peek, opens a page that is not in the Library, can't be pinned, and is dropped (not closed into the Library, not binned) when its tab closes; one shown only in a peek goes when no peek shows it. Keep in Library (tab menu) or a move into a folder makes it a normal page. Stored as `tabs.temp INTEGER NOT NULL DEFAULT 0`.
- **Why no version bump:** Existing rows read as 0 (a normal page). `ensureTempColumn` checks `PRAGMA table_info(tabs)` before `ALTER TABLE`. On load, a temporary page that is not open is dropped, like the help page. `SCHEMA_VERSION` stays `3`.
- **Export format:** unchanged; exports only hold Library pages, which temporary pages are not.
- **Protocol:** additive: a `temp` field on tab meta, `temp` on `POST /api/files/open`, `POST /api/temp-pages/url`, `POST /api/tabs/:id/keep` (board UI only), and `POST /api/agent-open-file` for MCP `page_open`'s new `file` / `keep` arguments (an agent opens a file as a page only within its thread's read scope, `src/agent/openFile.ts`). The agent browser can't reach the board's file-opening routes (`blockedBoardRequest`), and `GET /api/files/list` refuses agents. `PATCH /api/tabs/:id` with `pin: true` on a temporary page is refused. `VERSION` stays `3.0.0`.
- **Where:** `src/schema.ts`, `src/dbMigrate.ts` (`ensureTempColumn`), `src/types.ts` (`Tab.temp`, `isAppTab`), `src/store.ts` (`openTempUrl`, `keepPage`), `src/http.ts`, `src/search/service.ts`, `src/bridge.ts` (file links), `public/views.js`, `public/app.js`, `public/library.js`, `public/agent-render.js`, `templates/builtin/kanban.html`.
- **How to verify:** the temporary page tests in `src/filePages.test.ts`.
- **When to remove:** Keep. This is the current schema.

## `tabs.file` column (additive, schema still 3)

- **What changed:** File pages (#654): a page can show and save a file on disk. `file` on the tab is `{ path, copy? }` (`copy`: a dropped file whose bytes Scribe keeps in `<data>/files/<page id>/`, since a browser drop gives no path). The board serves `templates/file-page.html` for these pages instead of their stored HTML, which is only a placeholder naming the file. Stored as `tabs.file TEXT` (JSON, nullable).
- **Why no version bump:** Existing rows are unchanged (null: not a file page). SQLite has no `ADD COLUMN IF NOT EXISTS`, so `ensureFileColumn` checks `PRAGMA table_info(tabs)` first. `SCHEMA_VERSION` stays `3`.
- **Export format:** unchanged on purpose: the path is on this PC. An exported file page carries only its placeholder HTML. `EXPORT_VERSION` stays `1`.
- **Protocol:** additive routes `GET /api/files/list`, `POST /api/files/open`, `POST /api/files/open-folder`, `POST /api/files/upload`, `GET` / `PUT /api/tabs/:id/file`, `GET /api/tabs/:id/file/raw`, `POST /api/tabs/:id/file/save-as` (board UI only: refused for agents, not open to the content origin); the content origin may now load `/vendor/highlight.js`, `/vendor/marked.js` and `/vendor/purify.js`; a `file` field on tab meta; the bridge call `scribe.file` and the shell message `scribe-file`. `VERSION` stays `3.0.0`.
- **Where:** `src/schema.ts`, `src/dbMigrate.ts` (`ensureFileColumn`), `src/types.ts` (`FileBinding`), `src/filePages.ts`, `src/store.ts` (`openFilePage`, `setFilePath`, `openDiskFolder`), `src/http.ts`, `src/contentOrigin.ts`, `src/bridge.ts`, `templates/file-page.html`, `public/app.js` (`onPageFile`, `dropFiles`), `public/library.js`, `public/agent.js` (`pickWorkspace` file modes).
- **How to verify:** `src/filePages.test.ts`.
- **When to remove:** Keep. This is the current schema.

## `tabs.workspace` column (additive, schema still 3)

- **What changed:** A page has a workspace folder (#611): `workspace` on the tab, the disk folder new chat threads on the page start in. A page an agent creates takes the creating thread's folder (its worktree's home folder, else its cwd); the page menu **Set workspace…** changes or clears it. This replaces the old default (the folder of the page thread with the latest reply). The thread list's Here filter also shows the page's workspace threads and the thread that created the page. Stored as `tabs.workspace TEXT` (nullable).
- **Why no version bump:** Existing rows are unchanged (null: no workspace). SQLite has no `ADD COLUMN IF NOT EXISTS`, so `ensureWorkspaceColumn` checks `PRAGMA table_info(tabs)` first. `SCHEMA_VERSION` stays `3`.
- **Export format:** unchanged on purpose: the folder is a path on this PC. `EXPORT_VERSION` stays `1`.
- **Protocol:** additive route `POST /api/tabs/:id/workspace` (board UI only), a `workspace` field on tab meta. `VERSION` stays `3.0.0`.
- **Where:** `src/schema.ts`, `src/dbMigrate.ts` (`ensureWorkspaceColumn`), `src/types.ts` (`noteAgentWrite`), `src/store.ts` (`setWorkspace`), `src/http.ts` (`actorOf`), `src/agent/host.ts` (`pageWorkspace`), `public/agent.js` (`hereGroup`, `pageWorkspace`), `public/app.js`, `public/library.js`.
- **How to verify:** `a page takes the workspace of the thread that created it…` in `src/agent/pageChat.test.ts`.
- **When to remove:** Keep. This is the current schema.

## `tabs.reply_to` column (additive, schema still 3)

- **What changed:** A page can have a reply target (#320): `replyTo` on the tab, `{ page: <target tab id>, card?: number }`, set by agents with `page_show` / `page_patch` `replyTo` (keys are resolved to ids). The page's `scribe.reply(data, { summary })` sends its answers there after a click; a Kanban target posts them as the user's comment and passes them on to the card's chat (server side, `AgentHost.cardMessage`). Stored as `tabs.reply_to TEXT` (JSON, nullable).
- **Why no version bump:** Existing rows are unchanged (null). SQLite has no `ADD COLUMN IF NOT EXISTS`, so `ensureReplyToColumn` checks `PRAGMA table_info(tabs)` first. `SCHEMA_VERSION` stays `3`.
- **Export format:** unchanged on purpose: the target is a tab id on this PC. `EXPORT_VERSION` stays `1`.
- **Protocol:** additive route `POST /api/tabs/:id/reply` (board UI only: refused for agents, and not open to the content origin), a `replyTo` field on tab meta and the `POST /api/tabs` / `patch` bodies, the bridge call `scribe.reply`, and the shell message `scribe-reply`. `VERSION` stays `3.0.0`. Pages need the daemon restarted to use it.
- **Where:** `src/schema.ts`, `src/dbMigrate.ts` (`ensureReplyToColumn`), `src/types.ts` (`ReplyTarget`), `src/store.ts` (`setReplyTo`, `receiveReply`, `replyDelivered`), `src/actions/kanban.ts` (`reply`, `replyDelivered`), `src/http.ts`, `src/bridge.ts`, `public/app.js` (`onPageReply`).
- **How to verify:** `a page's reply target is set by agents, persists, …` in `src/store.test.ts`; the reply tests at the end of `src/actions/kanban.test.ts`.
- **When to remove:** Keep. This is the current schema.

## Kanban workers: the daemon picks the next card (page state, no schema change)

- **What changed:** The daemon now runs Kanban workers end to end (#312): the Kanban action set's `drive` hook wraps up a worker's chat once its run ended (blocks unfinished cards, pauses the worker), and starts its next ready card (`AgentHost.launchPageThread`), whether or not a window shows the board. The built-in board only shows workers and takes clicks: its run switch calls `scribe.agent.allow` and the new `worker_start` action.
- **Affected data:** None new. The daemon writes the same worker fields the page did (`threadId`, `run`, `step`, `merge`, `fails`, `mergeCards`, `solo`) and the same `settings.workerLog` lines.
- **Transform:** None. Board copies with older saved HTML keep their own loop; they and the daemon share the step lease (`settings.workers[id].step`, taken by `worker_step`), so only one of them starts each card. Starting chats without a click needs the page's `agent.unattended` permission (and the worker's folder): when it is missing, the worker pauses and says so, and ▶ asks for it.
- **Protocol:** additive bridge call `scribe.agent.allow`, action `worker_start`, agent event `agent_page_show`; `VERSION` stays `3.0.0`.
- **Where:** `src/actions/kanbanWorkers.ts`, `src/actions/kanban.ts` (`drive`, `launched`, `worker_start`), `src/store.ts` (`driveActions`, `mayStartAgent`), `src/http.ts` (`scheduleSweep`), `src/agent/host.ts` (`launchPageThread`), `templates/builtin/kanban.html` (`launchWorker`), `public/agent.js` (`allow`).
- **How to verify:** `src/actions/kanbanWorkers.test.ts`.
- **When to remove:** `worker_step` / `worker_solo_step` once no edited board copies predate this.

## Kanban workers: chats handed to Scribe as runs (`agent.sqlite` setting, page state, no schema change)

- **What changed:** The daemon now owns the lifecycle of worker chats (#285): plan-limit waits and resumes, worktree merges, and merge-fix requests (`src/agent/pageRuns.ts`). The Kanban template hands each chat over with `scribe.agent.start({ run })` / `scribe.agent.watch()` and only acts on the run's outcome. Runs are kept in the `pageRuns` setting of `agent.sqlite`.
- **Affected data:** Worker fields the page used to keep: `settings.workers[id].wait` / `.fix`, and `solo[thread].wait` / `.fix` / `.after`. They are no longer read; the board clears `wait` / `fix` with its next patch to the worker.
- **Transform:** A worker chat or one-card run that was in flight when the board updated has no run yet: the board hands it to Scribe as it is (`watch` with `after: 0`), so a chat that was waiting on a usage limit is picked up by the daemon's wait. Boards whose saved HTML predates runs (an edited copy) keep their own loop; the sweep and `worker_step` still serve them (`workerWaits` is only used when the thread has no run).
- **Protocol:** additive routes `POST` / `DELETE /api/agent/threads/:id/run`, a `run` field on thread views, bridge calls `scribe.agent.watch` / `release` and `start({ run })`; `VERSION` stays `3.0.0`. The board needs the daemon restarted to use them.
- **Where:** `src/agent/pageRuns.ts`, `src/agent/host.ts`, `src/actions/kanban.ts` (`runHold`, `runEvent`, sweep), `templates/builtin/kanban.html` (`handOver`, `wrapUp`, `wrapUpSolos`).
- **How to verify:** `src/agent/pageRuns.test.ts`; the run tests at the end of `src/actions/kanban.test.ts`.
- **When to remove:** The legacy `workerWaits` branch of the sweep, once no edited board copies predate runs.

## Agent chat: OpenAI-compatible provider replaced by Pi (`agent.sqlite`, no schema change)

- **What changed:** The `openai` agent provider was removed (#192). Its model sources (Agent settings) now feed the Pi provider (`pi`), which also reaches local and other providers' models.
- **Affected data:** `threads.provider = "openai"` rows in `agent.sqlite`, and the saved `prefs` setting (`provider`, `models.openai`, `summarizer`, `favoriteModels` entries `openai:…`). Model sources (`openaiSources`) keep their shape and are read by Pi unchanged.
- **Transform:** Model ids `<source>/<model>` become Pi's `src-<source>/<model>`. On daemon start, each `openai` thread becomes a `pi` thread with the mapped model and `nativeId = null`, so its next turn starts a new Pi session (Pi cannot read the old provider's history; the chat transcript in Scribe stays). Prefs are mapped each time they are read (not rewritten): `openai` → `pi` with mapped model ids; an existing `models.pi` wins over the mapped one.
- **Where:** `src/agent/legacyOpenai.ts` (`migrateOpenaiThread`, `migrateOpenaiPrefs`), called once each from `src/agent/host.ts` (constructor thread load, `prefs()`).
- **How to verify:** `openai threads and prefs move to Pi` in `src/agent/piProvider.test.ts`. By hand: an old OpenAI-compatible thread opens as Pi with the same model and answers in a new session.
- **When to remove:** Once every install has started a build with Pi at least once (no `openai` rows or prefs left). Then delete `legacyOpenai.ts` and its two calls and test.

## `tabs.provenance` column (additive, schema still 3)

- **What changed:** Agent page writes record who created the page and who last changed it (`provenance` on the tab: `{ created?, changed? }`, each `{ thread?, title?, at }`). In-app chats send `x-scribe-thread`; external MCP clients have no thread. Hovercards show it; the page menu **Open thread** opens the creating thread. Stored as `tabs.provenance TEXT` (JSON, nullable). Export files carry optional `provenance`.
- **Why no version bump:** Existing rows are unchanged (null). SQLite has no `ADD COLUMN IF NOT EXISTS`, so `ensureProvenanceColumn` checks `PRAGMA table_info(tabs)` first. `SCHEMA_VERSION` stays `3`. Older pages stay blank until an agent writes them.
- **Export format:** No transform. Older exports have no `provenance` and import as unset. `EXPORT_VERSION` stays `1`.
- **Protocol:** additive field on tab meta; `VERSION` stays `3.0.0`.
- **Where:** `src/schema.ts` (`TABS_TABLE_SQL`), `src/dbMigrate.ts` (`ensureProvenanceColumn`), `src/types.ts` (`PageActor`, `noteAgentWrite`), `src/store.ts`, `src/http.ts` (`actorOf`), `public/library.js` / `public/hovercard.js` / `public/agent.js`.
- **How to verify:** `agent page writes record created-by and last-changed-by`, `user writes leave provenance alone; external agents have no thread`, and `page provenance persists, exports, and migrates a missing column` in `src/store.test.ts`.
- **When to remove:** Keep. This is the current schema.

## Folder description and instructions (additive, schema still 3)

- **What changed:** Agent instructions now belong to folders, edited through the folder context menu. `folders.description` and `folders.instructions` are text columns with empty defaults, added on open for existing databases. Descriptions appear in folder listings; both fields enter folder/page thread context, with parents first.
- **Compatibility:** The old page flag column remains for database compatibility but is no longer used. Pages titled Instructions are ordinary pages, and the page toggle route is retired. Existing instruction pages remain in the Library; their text can be copied into the new folder dialog.
- **Export format:** Optional `folders` entries carry paths, descriptions and instructions in folder/Library exports, including empty folders. Older exports without these entries still import. `EXPORT_VERSION` stays `1`.
- **Protocol:** `PUT /api/folders/:fid/instructions` replaces the page toggle and remains restricted to the Scribe UI. `VERSION` stays `3.0.0`.

## `tabs.folder_instructions` column (retired, additive, schema still 3)

- **What changed:** A page can be marked as its Library folder's standing agent instructions (`folderInstructions` on the tab, tab menu **Use as folder instructions**). Stored as `tabs.folder_instructions INTEGER NOT NULL DEFAULT 0`. A page titled `Instructions` counts even without the flag. Export files carry optional `folderInstructions: true`.
- **Why no version bump:** Existing rows are unchanged (default 0). SQLite has no `ADD COLUMN IF NOT EXISTS`, so `ensureFolderInstructionsColumn` checks `PRAGMA table_info(tabs)` first. `SCHEMA_VERSION` stays `3`.
- **Export format:** No transform. Older exports have no `folderInstructions` and import as unset. `EXPORT_VERSION` stays `1`.
- **Protocol:** additive route only (`POST /api/tabs/:id/folder-instructions`), refused for agents. `VERSION` stays `3.0.0`.
- **Where:** `src/schema.ts` (`TABS_TABLE_SQL`), `src/dbMigrate.ts` (`ensureFolderInstructionsColumn`), `src/store.ts` (`setFolderInstructions`, `folderInstructionsFor`), `src/agent/prompt.ts`.
- **How to verify:** `folder instruction pages walk parent folders and prefer a flag over the title` and the persist/export test in `src/store.test.ts`; `threadInstructions includes folder instruction pages` in `src/agent/prompt.test.ts`.
- **When to remove:** Keep. This is the current schema.

## `page_permissions` table (additive, schema still 3)

- **What changed:** What the user lets a page's own code do (`agent.chat`, `agent.unattended`, `agent.workspace`; plugins will add `plugin.<id>` ids) is stored in a new `page_permissions` table: `tab_id REFERENCES tabs(id) ON DELETE CASCADE`, `perm`, `value` (`allow` / `deny` / `ask`), `data` (JSON, `{ folders: [{ path, approval }] }` for per-folder permissions), `updated_at`. No row means the permission's default (`src/pagePermissions.ts`).
- **Why no version bump:** Nothing existing changes. `ensurePagePermissionSchema` runs `CREATE TABLE IF NOT EXISTS` on every open. `SCHEMA_VERSION` stays `3`.
- **Export format:** unchanged on purpose: grants stay on the PC that gave them and never travel with a page. `EXPORT_VERSION` stays `1`.
- **Protocol:** additive routes only (`GET`/`PUT /api/tabs/:id/permissions`, `POST /api/tabs/:id/permissions/check`), refused for agents and tab pages, so `VERSION` stays `3.0.0`. The shell falls back to the old behavior (clicks only) against a daemon without them. New bridge calls (`scribe.permissions`, `scribe.agent.stop` / `options` / `pickFolder`, start settings) need the daemon restarted.
- **Where:** `src/schema.ts` (`PAGE_PERMISSIONS_TABLE_SQL`), `src/dbMigrate.ts` (`ensurePagePermissionSchema`), `src/store.ts` (`pagePermissions`, `setPagePermission`, `resetRiskyPermissions`).
- **How to verify:** `page permissions are kept per page, reset by an agent rewrite, and not exported` in `src/store.test.ts`, and `src/pagePermissions.test.ts`.
- **When to remove:** Keep. This is the current schema.

## Scribe release: schema 3, data folder, page keys (breaking)

- **What changed:** The app is renamed from Agent Board to Scribe, and page state moved to ops, an event log, and per-viewer local state.
  - **Data folder:** `%LOCALAPPDATA%\agent-board` moves to `%LOCALAPPDATA%\scribe` the first time the new daemon starts (`migrateLegacyData` in `src/config.ts`), entry by entry, never overwriting what is already there. `board.sqlite` (and `-wal` / `-shm`) becomes `scribe.sqlite`. Claude Code's session folder for the scratch dir is copied to the new path's name so Pages-mode threads still resume. `SCRIBE_HOME` skips the folder move but still renames the database.
  - **Schema 2 → 3** (`migrateV2ToV3` in `src/dbMigrate.ts`): `tabs.signal_revision` / `tabs.signal` are renamed to `event_seq` / `events`, and a page's last signal becomes the first entry of its event log. A new `page_local` table (`tab_id` → `tabs(id)` cascade, `viewer`, `state`) holds `scribe.local`. A schema 1 board migrates through 2 (using the frozen `TABS_TABLE_V2_SQL`) and then to 3.
  - **Page keys** read `scribe:<slug>`. The store adds the prefix to any key without it when it loads (`store.load`) and writes those rows back; lookups take either form. Exports carry the prefixed keys; importing an older export prefixes its keys on the way in.
  - **Browser settings:** the UI moves `agent-board.*` localStorage keys to `scribe.*` on load. The desktop app has a new identifier (`local.scribe.desktop`), so its WebView profile, and with it window-only settings, starts fresh once.
  - **Desktop:** `scribe.exe` replaces `board.exe` (the installer removes the old exe), and the "Agent Board" startup entry moves to "Scribe".
- **Protocol:** `VERSION` 2.5.0 → 3.0.0. State writes are ops only (`PUT /api/tabs/:id/state { ops }`), `tab_state` carries ops instead of the whole state, `POST /api/tabs/:id/signal` became `/events`, waits take a cursor and return events. MCP tools are renamed (`board_*` → `page_*` / `library_*` / `template_*`), the page API is `window.scribe` with `data-scribe-*` attributes, and the MCP server is named `scribe`. Pages written for the old API need updating; the built-in templates are updated and resync on startup.
- **Outside the repo:** MCP configs must point a server named `scribe` at `dist/index.js` (Cursor: `~/.cursor/mcp.json`; Claude Code: `claude mcp`), and the skill folder is `.cursor/skills/scribe`.
- **How to verify:** `a schema v1 board migrates archived tabs into the Library` runs v1 → 3; the event, local state and key tests in `src/store.test.ts`; manually, copy an old `%LOCALAPPDATA%\agent-board` aside, start the daemon, and check that the folder moved and pages, keys and threads are intact.
- **When to remove:** the folder move, key prefixing and localStorage move can go once no Agent Board install is left to upgrade. Keep `migrateV2ToV3`.

## Templates tables (additive, schema still 1)

- **What changed:** Templates and page-to-template links are stored in two new SQLite tables: `templates` and `template_bindings`.
- **Why no version bump:** Existing `tabs` rows are unchanged. Old boards open as before; they simply have no templates until one is created. `SCHEMA_VERSION` stays `1`.
- **Where:** `src/dbMigrate.ts` (`ensureTemplateSchema`), called from `BoardDb.open` / `openExisting`. New databases also get the tables from `CREATE_SQL` in `src/db.ts`.
- **How to verify:** Create a template, open a page from it, restart the daemon, confirm the template list and the page link survive. Existing tabs without a binding still load.
- **When to remove:** Keep. This is the current schema, not a one-shot rewrite.

## `templates.builtin_key` / `builtin_fingerprint` columns (additive, schema still 2)

- **What changed:** Built-in templates ship in `templates/builtin` and are never stored. Opening one creates a local copy in `templates`, and the copy records which built-in it came from (`builtin_key`) and that built-in's content fingerprint at copy time (`builtin_fingerprint`). Both are nullable `TEXT`; null means an ordinary user template.
- **Why migration was needed:** Existing `templates` tables lack the columns and the template upsert writes them. SQLite has no `ADD COLUMN IF NOT EXISTS`, so `ensureTemplateBuiltinColumns` checks `PRAGMA table_info(templates)` first. `SCHEMA_VERSION` stays `2`.
- **Later addition:** `templates.guide` (nullable `TEXT`, the template's agent guide) is added by the same function in the same way.
- **On load:** a user template with no source whose content is identical to a built-in is linked to it, so opening that built-in reuses it instead of making a second copy.
- **Export format:** templates may carry an optional `source: { builtin, fingerprint }`. Import keeps it only when the target board has no copy of that built-in yet. Older exports have no `source`. `EXPORT_VERSION` stays `1`.
- **Where:** `src/dbMigrate.ts` (`ensureTemplateBuiltinColumns`, run by `ensureTemplateSchema`). New databases get the columns from `CREATE_SQL` / `TEMPLATE_TABLES_SQL`.
- **How to verify:** `template tables without the built-in columns are migrated` in `src/store.test.ts` drops the columns from a board, reopens it, and checks a copy's link survives a reload.
- **When to remove:** Keep. This is the current schema.

## `page_assets` table (additive, schema still 2)

- **What changed:** Blobs saved by page code (`board.saveAsset`) are stored in a new `page_assets` table: `id`, `tab_id REFERENCES tabs(id) ON DELETE CASCADE`, `name`, `mime_type`, `bytes`, `data BLOB`, `created_at`, `orphaned_at` (set while nothing in the page's state or HTML mentions the id).
- **Why no version bump:** Nothing existing changes. `ensurePageAssetSchema` runs `CREATE TABLE IF NOT EXISTS` on every open. `SCHEMA_VERSION` stays `2`.
- **Hazard for future migrations:** the cascade fires on any `DELETE` of a `tabs` row, and `foreign_keys` is on. A migration that rebuilds `tabs` (rename, create, copy, drop, like `migrateV1ToLibrarySchema`) would delete every page asset when it drops the old table, because `ALTER TABLE RENAME` repoints the foreign key at the renamed table. Turn `foreign_keys` off for such a rebuild (it cannot be changed inside a transaction), and keep the tabs upsert as `ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE`.
- **Export format:** pages may carry an optional `pageAssets: [{ id, name, mimeType, createdAt, data }]` (base64). Older exports have none. Importing reuses the ids unless they already exist on the board; taken ids get new ones and the page's state and HTML are rewritten to match. `EXPORT_VERSION` stays `1`. `MAX_IMPORT_BYTES` rose from 128 MB to 400 MB.
- **Protocol:** `VERSION` 2.2.0 → 2.3.0 for the new `page_asset_warning` event.
- **Where:** `src/schema.ts` (`PAGE_ASSETS_TABLE_SQL`), `src/dbMigrate.ts` (`ensurePageAssetSchema`), `src/pageAssets.ts`.
- **How to verify:** the page asset tests in `src/store.test.ts`.
- **When to remove:** Keep. This is the current schema.

## `tabs.agent_hidden` column (additive, schema still 1)

- **What changed:** Tabs can be hidden from the agent, from the board UI only. The flag is stored in a new `tabs.agent_hidden INTEGER NOT NULL DEFAULT 0` column. Export files carry it as an optional `agentHidden: true` on each page.
- **Why migration was needed:** `board.sqlite` files created before this change have no `agent_hidden` column, and the tab upsert writes it. SQLite has no `ADD COLUMN IF NOT EXISTS`, so the migration checks `PRAGMA table_info(tabs)` first. Existing rows get the default `0` (visible). `SCHEMA_VERSION` stays `1`.
- **Export format:** No transform. Older exports don't have `agentHidden` and import as visible. `EXPORT_VERSION` stays `1`.
- **Where:** `src/dbMigrate.ts` (`ensureAgentHiddenColumn`). It now runs only as the first step of the schema 1 → 2 migration below, so a v1 board without the column still upgrades. New databases get the column from `TABS_TABLE_SQL` in `src/schema.ts`.
- **How to verify:** Covered by the schema 1 → 2 test below, which builds a v1 database.
- **When to remove:** Together with `migrateV1ToLibrarySchema`.

## Library: schema 2 (`tabs` rebuild, `folders` table)

- **What changed:** The Archive became the Library. Every page is in it, open or closed, organized into nested folders with a manual order. The strip is just the open pages.
  - `tabs.status` `'archived'` → `'closed'`, `tabs.archived_at` → `tabs.closed_at`.
  - New `tabs` columns: `folder_id` (null = root), `lib_pos` (sparse float order within a folder), `deleted_batch` (groups a multi-page delete into one undo step), `user_title_at` (last user rename; holds off agent title writes for 24h).
  - New `folders` table (`id`, `name`, `parent_id`, `pos`, `created_at`).
  - `SCHEMA_VERSION` 1 → 2.
- **Why migration was needed:** SQLite cannot change the `status` CHECK constraint in place, so `tabs` is rebuilt (rename to `tabs_v1`, create the new table, copy, drop). Existing boards also need an initial Library order.
- **Initial order:** Everything lands in the root. Open tabs first in strip order (pinned first), then archived pages newest first.
- **Where:** `src/dbMigrate.ts` (`migrateV1ToLibrarySchema`), called from `BoardDb.openExisting` in `src/db.ts` when `meta.schema` is `1`. It runs in one transaction and rolls back on failure. The table DDL is shared with new databases through `src/schema.ts` (`TABS_TABLE_SQL`, `FOLDERS_TABLE_SQL`), which also breaks the `db.ts` ↔ `dbMigrate.ts` import cycle.
- **Other shape changes (no migration code):**
  - MCP tools were renamed without aliases: `board_archive` → `library_search`, `board_restore` → `page_open`. Result fields `archived` / `archiveCount` became `open` / `closedCount`; `page_wait` reports `closed` (tab closed, page kept) and `deleted`. Agents with a stale MCP need a reload.
  - HTTP: `/api/archive` → `/api/library`; `/api/tabs/:id/restore` → `/api/tabs/:id/open`.
  - Export files: `archivedAt` → `closedAt`, plus optional `folderPath` and `libPos`. `EXPORT_VERSION` stays `1`. Old exports still import (as open pages in the root); their `archivedAt` is ignored, with no fallback.
  - Browser localStorage keys keep their old names (`scribe.archiveOpen`, `scribe.archiveWidth`); a stored sidebar tab of `archive` is read as `library`. No transform.
- **How to verify:** The `a schema v1 board migrates archived tabs into the Library` test in `src/store.test.ts` builds a v1 database, opens it, and checks the migrated statuses, `closedAt`, and the initial Library order. Manually: copy an old `board.sqlite`, start the new daemon against it, and confirm open tabs and former archive rows show in the Library in that order.
- **When to remove:** Once every board in use has been opened by a schema 2 daemon, delete `migrateV1ToLibrarySchema` and `ensureAgentHiddenColumn` and make `openExisting` reject schema 1. For a local-only tool, one release after this lands is enough.

## Agent chat: `agent.sqlite` (new file, board schema unchanged)

- **What changed:** The in-app agent chat stores its threads, turns, transcript items, preferences, cached model lists, and page checkpoints in a separate SQLite file, `agent.sqlite`, next to `board.sqlite`. Tables: `meta`, `threads`, `turns`, `items`, `settings`. Rows keep their payload as JSON; the columns are only what queries need (`activity_at`, `archived`, `thread_id`, `seq`). `turns` and `items` reference `threads(id) ON DELETE CASCADE`.
- **Why a separate file:** Nothing in `board.sqlite` changes, so old boards open as before and a broken agent database can't affect pages. `SCHEMA_VERSION` stays `2`; `agent.sqlite` has its own `meta.schema` (`AGENT_SCHEMA_VERSION = 1`).
- **Protocol:** `VERSION` 2.4.0 → 2.5.0 for the new WebSocket events (`agent_thread`, `agent_thread_deleted`, `agent_item`, `agent_delta`, `agent_turn`) and the `/api/agent/*` routes. `public/app.js` `BOARD_VERSION` matches.
- **Dependencies:** zod 3 → 4 and `@modelcontextprotocol/sdk` 1.25 → 1.29 (peer dependencies of `@anthropic-ai/claude-agent-sdk`). The only code change was `z.record(value)` → `z.record(z.string(), value)` in `src/mcp.ts`.
- **On startup:** turns left `running` by a daemon that stopped are marked `cancelled`.
- **Export format:** unchanged; board exports don't include agent threads.
- **Where:** `src/agent/db.ts`.
- **When to remove:** Keep. This is the current schema.

## Access ladder: modes become approval rungs (`agent.sqlite` thread JSON, prefs, page state, no schema change)

- **What changed:** Code / Ask / Plan / Pages are gone from the pickers (#719). A thread's `approval` is its rung: `readonly`, `board`, `edits`, `auto`, `full`. `mode` stays on the thread, derived from the rung (`board` on Read-only and Board, else `code`, or `plan` when it plans first); `settleAccess` and `changeAccess` in `src/agent/types.ts` keep the two in step. Read-only also turns off Scribe's page writes (`pagewrite` in `SCRIBE_TOOLS_OFF`; `page_action` refuses actions that change the page).
- **Affected data:** Thread JSON (`mode`, `approval`), prefs (`approval`, `approvals`, `mode`, `disabledModes`), custom modes (`base`, `approval`), page folder grants (`agent.workspace` folders' `approval`), Kanban worker settings (`mode`, `approval`).
- **Transform (on read, never written back until the next save):** code + `ask` (Ask first) becomes Edits, so those threads now accept workspace edits without asking; ask and board modes become the Board rung (Read-only stays); plan keeps its rung and plans first. Prefs: `ask` reads as Edits, `mode` ask/board as code, and `disabledModes` keeps only rung ids (old mode ids are dropped). Custom modes: `base` is the highest rung (code → full, plan → full + `plan: true`, ask/board → board). Folder grants: `ask` reads as Edits. Worker settings and `scribe.agent.start({ mode })` keep the old values as aliases (`workerAccess`, `AgentHost.launchPageThread`, `pageAccess` in `public/agent.js`).
- **Protocol:** `agent_run` takes `access` (a rung, at most the parent's) instead of `mode`; the daemon still accepts `mode` with old values. `POST /api/tabs/:id/action` takes `readOnly`. `VERSION` stays `3.0.0`.
- **How to verify:** `src/agent/accessLadder.test.ts`.
- **When to remove:** The `ask` aliases once no stored threads, prefs, grants or edited board copies use them.
