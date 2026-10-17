# Scribe access scope (#269)

The design was agreed with the user on 17 October 2026; phases 1–3 are implemented (phase 1 in #269, phases 2–3 in #690). The Scribe page `scribe:269-scribe-access-scope` holds the full design. This replaces the earlier investigation report.

## Model

A chat reaches the pages in its Scribe scope plus anything it has been granted. Outside that it asks with `page_access`; it does not simply fail. No new chat control was added.

- **Scope:** page (that page), folder (the folder tree), global (every page its access level allows), None (no page tools).
- **Also reachable:** pages the thread created itself; pages whose origin (the page or folder of the chat that created them; for older pages, that thread's first home) is in scope; grants held by the chat's home page or folder (and folders above it); the thread's own grants; and homes it had before it followed a page it showed (`formerScopes`, cleared when the user picks a scope).
- **Access levels** (page or folder; the strictest up the tree wins):
  - **Open:** the normal rules.
  - **Ask always:** only a grant for the thread itself counts, so every new chat asks, global ones included.
  - **Trusted only:** untrusted model sources can neither see nor ask for the page.
  - **Restricted:** only a chat on that exact page. This replaces Hide from agent and is still stored as `agentHidden`.
- **User intent overrides everything.** An `@page` or `@folder` the user types in the composer grants that page or folder to the thread at any level. A `#thread` mention grants that transcript. Page, helper, hook and card messages grant nothing.
- **Titles** of pages that need asking are listed as `outside` (title only, no snippet) in `page_list` and `library_search`. Hidden pages are not listed or counted.

## Ask card

**Allow for this thread** (primary) · **Always allow for <home>** · **Deny**, in the order the other approval cards use. Always stores a grant on the chat's page or folder. It is not offered to global chats or for Ask always pages. `page_access` takes `folder: true` to ask for the page's folder.

## Grants from the user's edits

A link to an Open page that the user adds on a page bound to a built-in template (a Kanban card) grants the target to that page once the link has stayed for a minute. Agent writes never create grants. Removing the link does not revoke the grant; grants are listed and removable in **Agent access…**.

## Trust and taint

- Native model sources have a **Trusted** flag. Claude, Codex and Cursor are untrusted. A helper is no more trusted than the thread that started it.
- A thread that reaches Trusted only or Restricted content without an @mention becomes **tainted**, and so do the threads it reports to.
- A tainted thread asks the user before every untrusted helper, whatever its approval level. An unanswered request is denied after 15 minutes.
- Switching a tainted thread to an untrusted model shows a warning.
- Untrusted readers cannot read a tainted transcript with `thread_read` unless the user #tagged it. A trusted reader becomes tainted itself.

## Enforcement and limits

Phase 1 is enforced in the daemon for agent requests: page routes (`app.param("id")`), listings, word and semantic search, `page_show` by key, `page_ask` and `replyTo`.

**Phase 2 (page scripts).** Each page runs on an origin of its own, `t-<hex>.localhost` for `t_<hex>` (`pageHost` in `src/config.ts`). A per-frame token on one shared origin would not hold, since same-origin frames can reach into each other. On its origin a page's script reaches its own page, and can read Open pages its page or folders were granted (`frameReach`, the same grant table chats inherit); it writes only its own page, and those writes count as the user's. `/view/<id>` is served only on that page's origin. The page routes answer only to the page's own script (`Sec-Fetch-Site` / `Origin`). The board's origin refuses writes and WebSocket joins from other origins and unknown `Host` names. `127.0.0.2` keeps the shared, data-free files and blobs.

**Phase 3 (local callers).** Identity comes from `src/callers.ts`. A chat's MCP sends its thread id with `SCRIBE_THREAD_TOKEN`, an HMAC of the id under `agent-secret` in the data folder, so a forged thread id counts for nothing. An MCP with no chat sends the data folder's `local-token` and keeps the external client's reach (Open pages, untrusted). The board UI is a browser on the board's origin. A local tool with the local token is the user. Anything else is an anonymous agent: it reaches no pages and none of the board's own routes (`/api/agent`, export, import, trash, undo, folder writes, settings). So leaving the token out never reaches more than sending it.

What this does not stop: a process with the user's file access can read the token files, or `scribe.sqlite` itself, and can pose as a browser.

Accepted gaps: a trusted chat can copy protected content into Open pages; an agent can paste content into a helper brief; grants are not tied to the link that created them; local processes with the user's file access (above).

## Code

`src/pageAccess.ts` (rules, `frameReach`), `src/callers.ts` (who is calling), `src/contentOrigin.ts` (page origins), `src/http.ts` (`reachFor`, `checkReach`, `reachedByFrame`, access routes, `/api/page-access`), `src/store.ts` (levels, grants, link grants), `src/agent/host.ts` (`pageReader`, `requestPageAccess`, `notePageReached`, `approveTaintedHelper`), `src/mcp.ts` (`page_access`), `public/library.js` (Agent access dialog), `public/agent.js` (Trusted flag on native sources, model switch warning).
