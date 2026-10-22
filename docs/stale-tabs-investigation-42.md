# Deleted tabs returning to the strip (#42)

Investigated 2026-10-22. No application code changed.

## Finding

A daemon/client protocol mismatch can produce this symptom. The concrete
incompatibility is the Archive-to-Library migration in commit `6c33d90`
(2026-09-26):

| Meaning | Before migration | Current protocol |
| --- | --- | --- |
| Delete event | `tab_closed` | `tab_deleted` |
| Closed-page metadata | `archivedAt` | `closedAt` |
| Snapshot's closed pages | `archive` | `closed` |

A current client ignores an old daemon's `tab_closed` event, leaving the tab
visible. An upsert containing `archivedAt` passes the current `isClosedMeta`
check as open, so an old daemon updating an archived page can put it back into
the strip. Conversely, a pre-migration client does not understand current
`tab_deleted` events or `closedAt` metadata.

This establishes a reproducible cause consistent with the report, but does not
prove which versions were running during the original occurrence. A version
difference alone does not imply incompatible tab handling; this particular
protocol change does.

## Evidence and verification

- Compared `6c33d90` and its parent: both event and metadata names changed in
  `public/app.js` and `src/http.ts`.
- Executed the current `applyEvent` function extracted from `public/app.js` in
  Node's VM with a tab present. Sending `tab_closed` left it present; sending
  `tab_deleted` removed it. Assertions passed.
- Executed the actual `isClosedMeta` function: `{ archivedAt: 123 }` returned
  false and `{ closedAt: 123 }` returned true. Assertions passed.
- Current references: `public/app.js` (`isClosedMeta`, `applyEvent`,
  `upsertClosed`, `renderTabs`, `showVersionMismatch`); `src/http.ts` (WebSocket
  snapshot and store-event broadcasts); `src/store.ts` (`load`, `snapshot`,
  `closeTab`, `deleteMany`, `persistSoon`, `closeDb`).

## Current matching versions

Deletion removes the page from client state and invalidates the strip;
`renderTabs` removes DOM entries absent from that state. Every WebSocket
connection receives an authoritative snapshot, and the client replaces its
open-tab list rather than merging it. A reconnect should therefore clear a
missed deletion when the daemon's state is correct.

There is one separate reopening path: a snapshot whose URL hash names a
Library-only page calls `openPage` for it. A stale window URL can consequently
reopen a *closed* page, including after another window closed it. A page
deleted to Trash is absent from both open and closed snapshot lists and cannot
be reopened by this path. This is intentional deep-link restoration in the
current code; it was not reproduced as the original incident.

Persistence waits 150 ms after the last mutation, but normal SIGINT/SIGTERM
shutdown calls `closeDb`, which persists synchronously. Forced termination
before persistence or a persistence failure could also restore older state;
neither was established here.

## Recommendation

No compatibility fix for this development-only report. Restart the daemon
from the intended build and reload the viewer so both use the same protocol.
The mismatch banner added in `96fa1de` reports daemon and page versions, but
does not prevent incompatible events from being processed.

If this recurs with matching builds, record whether the page was closed to
the Library or deleted to Trash, whether another window was open, the URL
hash, and whether reconnect/reload clears it. A tab that disappears on reload
points toward stale client state; one retained in a fresh snapshot points
toward daemon state or an actual reopen request. No live user pages were
deleted or restored during this investigation.
