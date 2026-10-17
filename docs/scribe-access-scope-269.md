# Scribe access scope (#269)

The design was agreed with the user on 17 October 2026; phase 1 is implemented. The Scribe page `scribe:269-scribe-access-scope` holds the full design. This replaces the earlier investigation report.

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

Phase 1 is enforced in the daemon for MCP requests, keyed on the thread header: page routes (`app.param("id")`), listings, word and semantic search, `page_show` by key, `page_ask` and `replyTo`. It guards against accidental access. It does not stop page scripts (#660, phase 2) or local processes that leave out or forge the header (#682, phase 3).

Accepted gaps: a trusted chat can copy protected content into Open pages; an agent can paste content into a helper brief; grants are not tied to the link that created them.

## Code

`src/pageAccess.ts` (rules), `src/http.ts` (`reachFor`, `checkReach`, access routes, `/api/page-access`), `src/store.ts` (levels, grants, link grants), `src/agent/host.ts` (`pageReader`, `requestPageAccess`, `notePageReached`, `approveTaintedHelper`), `src/mcp.ts` (`page_access`), `public/library.js` (Agent access dialog), `public/agent.js` (Trusted flag on native sources, model switch warning).
