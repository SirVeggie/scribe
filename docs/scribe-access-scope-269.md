# Scribe access scope — current investigation

Updated 17 October 2026 for #269; source baseline `a8ea264397883e257ce84d87f31b305cb5311e7a`. This supersedes the 9 October investigation. No application behavior was changed.

## What the control actually means

Scribe access combines a chat's place in Scribe with a switch for page tools. **Page, folder, and global all expose the same page tools and can operate on any agent-visible Library page.** Page and folder do not confine those tools to their named page or folder. **None removes Scribe page tools from that chat's supplied MCP.** It is tool availability, not a general security sandbox.

The setting also selects contextual instructions, defaults for new chats, chat-list grouping, floating dock association, and which other chat scopes the agent may request permission to read.

| Choice | Stored scope | Page-tool reach | Context and default for a new chat |
|---|---|---|---|
| This page | `page`, page id | All agent-visible pages | Own-page context; that page's folder instructions and ancestors; Pages mode; page's saved workspace or none |
| This page's folder | `folder`, folder id | All agent-visible pages | Folder context and ancestor instructions; Pages mode; remembered workspace for this folder, otherwise recent workspace |
| Global | `global`, null | All agent-visible pages | No owning page or folder instructions; last global mode/custom mode; recent workspace |
| None | `workspace`, cwd or null | Page tools omitted | No page/folder context; last global mode/custom mode; workspace retained if selected |

Explicit settings, worker settings, and custom modes can override defaults. Changing an existing chat's scope does not itself reset its mode or workspace. The None scope ref is kept in step when the workspace changes. Pages mode plus None is called **Chat** in the prompt.

The composer/dock menu has separate Scribe access and Workspace sections. `/here`, `/folder`, and `/global` change Scribe scope; `/workspace` picks a disk folder. There is still no `/none`. Ctrl+Shift+. cycles Scribe access; Ctrl+. cycles workspaces. A scope whose page/folder was deleted can display “Missing page/folder”.

Sources: `public/agent.js:3089` (menu), `:3130` (setScope), `:3175` (workspace), `:11395` (cycle); `src/agent/types.ts:40`; `src/agent/host.ts:1402` (defaults), `:1450` (page workspace).

## What is enforced, and where

1. **Page tool availability:** `noPages(scope)` is true only for stored kind `workspace`. Provider MCP configuration supplies `SCRIBE_PAGES=off`; `src/mcp.ts:236` omits page/library/template tools and `page_ask`. Page/folder/global take the same registration path. The remaining tools now include questions, settings, thread updates, web requests, thread access, helpers, memories, and browser tools, plus Codex file tools where permitted. Custom modes can separately remove browser, helper, or thread tool groups; their presence does not mean unrestricted permission to use them.
2. **Normal agent page visibility:** HTTP routes recognize the MCP's agent header and apply the per-page `agentHidden` flag. “Hide from agent” removes the page from normal agent lookups, searches and reads, across page/folder/global scopes. It is not isolation from page JavaScript or every local caller; see below.
3. **Other-chat transcripts:** requestable scopes and user grants are checked in `src/agent/threadAccess.ts`. This is separate from page-tool reach. A page-scoped agent may read another Library page without a transcript grant, while reading another chat normally requires one.
4. **Files and shell:** workspace, mode, resolved file-read roots, provider sandbox, approval policy and custom mode apply separately. Selecting a Library folder does not select a filesystem root. None does not revoke file/shell access when Code mode and a workspace permit it.

Sources: `src/mcp.ts:236`, `:1356` and its `registerCodexFileTools`; `src/types.ts:348`; `src/http.ts:179`; `src/agent/providers/{claude,codex,cursor,pi}.ts`; `src/agent/customModes.ts:105`. The exported `gateTools` in `src/mcp.ts:184` is a hooks gate, not a page/folder scope authorization check.

## Which other chats can be requested

| Current scope | Requestable transcript access |
|---|---|
| Page | Chats scoped to that same page; plus workspace chats if a workspace exists |
| Folder | Chats scoped to that Library folder, descendants, or pages in that tree; plus workspace chats |
| Global | All chats; or narrower eligible grants |
| None | Workspace chats only if a workspace exists |

Workspace grants include threads in child disk folders. A worktree counts as its home workspace, so sibling worktrees share that eligibility. Page grants do not include a folder-scoped chat merely because it belongs to the page's folder.

Eligibility alone grants no transcript access: `thread_list` and `thread_read` ask first when nothing is granted. Grants outside the chat's current eligible scopes stop being effective after a scope/workspace change. **A user's explicit #thread tag is an exception:** it grants that individual chat across scopes and remains effective after a scope change, until revoked. Page, helper and hook messages cannot create those tag grants.

Source: `src/agent/threadAccess.ts:32–98`, with integration coverage in `src/agent/threadAccess.test.ts`.

## Context, defaults and side effects

- **Folder instructions:** page/folder chats receive folder descriptions and instruction text from folder settings, outermost ancestor first; changes are read next turn. Global/None receive none through this mechanism. The old report's instruction-page/title mechanism is obsolete. Global/workspace/provider memories and other supplied instructions are separate from Library scope.
- **Page workspace:** a new page chat now reads the page's own saved `workspace`, otherwise none. It no longer infers cwd from the latest finished page chat. Folder chats still use remembered folder workspace or a recent workspace. Page/folder mode choices do not overwrite the global default.
- **Here grouping:** now includes chats on the page, the chat that created the page, ancestor-folder chats, chats matching the page's saved workspace, and globals. Thus a None/workspace chat can appear under Here when its workspace matches; the old “Workspaces list only” claim is outdated.
- **Floating dock:** selects page-scoped chats for that page; when choosing a chat automatically, an old reply can lead to a new chat. A newly shown page can take over the current conversation's page association.
- **Automatic rebinding:** foreground page creation/show/open paths call `followToPage`. A user chat, including a global chat, becomes scoped to the shown page; its subsequent context, instructions and eligible transcript grants follow. Background report updates do not take over the chat. Page-owned chats such as board workers remain on their original page.
- **Own-page handling:** page scope supplies the owning-page prompt, template guide delivery, page edit notices and page checkpoint/revert context. A blank owning page can be filled by the next foreground page the agent creates. These conveniences are not access boundaries.
- **Provider sessions:** None changes the supplied tool set and participates in provider session/cache keys. Scope changes can refresh/restart sessions as instructions change; they do not erase conversation text or retract data already returned to the model. Switching page/folder/global does not narrow page tools.

Sources: `src/store.ts:439–468`; `src/agent/host.ts:1402–1451`, `:1548`, `:1801–1832`, `:1840`, `:1894`, `:3225`; `src/agent/prefs.ts:200–241`; `public/agent.js:1055–1078`; `src/http.ts:2156`; provider session-key implementations.

## #660: page scripts are a separate trust boundary

**#660 remains applicable at this baseline.** Its card is archived because the user pointed it here; archiving did not fix the routes. All HTML pages share the content origin, normally `127.0.0.2:4747`. The content-origin gate permits paths naming arbitrary tab ids, without binding the target id to the calling page.

| Content-origin request | Current exposure |
|---|---|
| `GET /api/tabs/:id/state` | Read another page's state |
| `PUT /api/tabs/:id/state` | Apply state operations to another page |
| `POST /api/tabs/:id/events` or `/action` | Log events (with optional state operations), invoke template actions; action-specific rules still apply |
| `GET`/`PUT /api/tabs/:id/local` | Read/change per-viewer local state if the viewer identifier is known |
| Asset list/upload/read/delete routes | Access or alter another page's stored assets, subject to normal asset validation |
| `GET /view/:id` and view asset routes | Retrieve another page's rendered HTML/runtime or attached view asset |

Knowing a target tab id is a precondition, not authorization. These routes do not verify a per-page capability or the requesting frame's ownership of that id. Page JavaScript normally has no MCP agent header, so `viewerOf` treats it as the user and the normal agentHidden filter does not protect the target. Events/actions from the content origin also receive user attribution. This permits cross-page data access and mutation even if the generating agent was working on a different page or Library folder. Narrowing only the agent's MCP scope would leave this route open.

This is a source-level confirmation, not a live attack against Library data. The wider view/asset exposure is visible in the same allowlist; `/local` additionally needs a viewer id, and template actions retain their own validation and claim rules.

File pages' actual disk reads/writes and `scribe.reply` instead travel through host handlers that derive the source page from the frame. That is a useful direction for a fix, not proof that the whole content origin is isolated. Possible designs remain per-page capabilities on every relevant route, or host-mediated calls with ownership checks; shared-origin access to page HTML/runtime must be considered too.

Sources: `src/contentOrigin.ts:8–65`; `src/http.ts:179–184`, `:455–627`, `:1623–1646`, `:2134–2147`, `:2475`; `public/app.js` frame-based file/reply handlers. See [#660](scribe:agent-todo#card=660).

## Related local-API limitation: #682

**None is not a server-wide deny rule.** Removing tools and instructing the model not to use pages does not authorize or block arbitrary HTTP callers. The page routes do not check the caller thread's Scribe scope. The app currently distinguishes agents from users using a caller-supplied header; a local process omitting it is treated as the user. Existing design issue [#682](scribe:agent-todo#card=682) documents the shell/browser implications and proposed session authentication. Provider network/shell restrictions can still prevent a particular request. No scope choice should be described as protection against a hostile local process or untrusted page script.

The existing #660 and #682 cover these limitations, so this investigation does not create duplicate design cards. A complete confidentiality design must decide agent page authorization, local API identity, and page-script isolation together.

## Verification and decisions

Inspected the current UI, defaults, prompt/context generation, all four provider MCP configurations, registration gates, transcript grants, content-origin allowlist, HTTP handlers and frame-based host handling. Ran existing suites for `threadAccess`, `followPage`, `prefs`, `codexProvider`, `mcpFileTools`, and `pagePermissions`: **82 passed, 0 failed**. The initial sandbox run could not spawn test processes (`EPERM`); the approved rerun passed. No new tests or application changes were needed for this investigation. Route findings are based on source inspection, not a destructive live probe.

Suggested decisions are to clarify the control's name/help, decide whether page/folder should become enforced agent page limits, and decide the #660/#682 isolation design. Those are separate changes. The linked Scribe report has a follow-up form with a freeform field; this investigation card goes to Needs input as requested for work without implementation.
