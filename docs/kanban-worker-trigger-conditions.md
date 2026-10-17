# Worker trigger conditions (#688)

Investigation and implementation, 2026-10-17. The user selected deferred automatic
continuation through the decision form.

## Implemented

Form replies save a card-level continuation request and user comment. The daemon
selects requests through the existing worker scheduler, including outside ready
columns when the card records its originating ready inbox. Dependencies, worker
stop state, inbox pause, live claims, capacity and page permissions gate dispatch.
The request remains pending while these conditions prevent work.

Dispatch rechecks current state after asynchronous provider setup. Accepted
requests carry their ID in persisted run data for retry deduplication. Deleted
chats fall back to fresh chats; archive, reassignment and Dismiss cancel pending
requests. Continue uses the same action, and the host intercepts older boards'
direct card-message resumes. Current templates show waiting state and Dismiss.

Running-holder feedback is still delivered immediately. Existing plan-limit
waits retain their lifecycle ownership and read saved answers when they resume;
they do not get another pending continuation. This change does not interrupt or
reschedule already-owned runs when blockers are added during them.

Cards without a recorded ready inbox need to be moved to an eligible ready inbox
before dispatch. Setup/provider failures keep the request and pause the worker
using the existing error handling; restarting the worker retries it.

The sections below retain the original investigation and design rationale.

## Cause

Normal scheduling goes through `nextCard` / `cardTakeable` in
`src/actions/kanbanWorkers.ts:112`. This checks live claims, unanswered blocked
status, and unfinished `blockedBy` cards. `workerCards` also skips paused inboxes;
`workerStep` checks worker stop state, capacity, and launch permission.

Form submission takes another route. `kanbanActions.reply` in
`src/actions/kanban.ts:982` saves a user comment, then returns a direct
`resume: true` delivery for an idle existing chat assigned to a worker. It does
not check dependencies, worker run state, paused inboxes, or scheduling capacity.
`src/http.ts:575` sends that delivery to `AgentHost.cardMessage`.
`replyDelivered` then claims and moves the card to working, after delivery.
Checking blockers only in `replyDelivered` would be too late.

Existing tests in `src/actions/kanban.test.ts:956` establish automatic continuation
from review, but do not cover blockers. Preserve the current dependency rule:
review and done satisfy a blocker; archived and missing blockers do not hold work.
Changing review to require done would be a separate product decision.

## Recommended behavior

Always save the form answer as a user comment. Treat automatic continuation as a
durable request that the daemon schedules when eligible. A successful submission
means the answer was saved; it need not mean an agent started.

- With an unfinished dependency, leave the card in its current column, unclaimed.
  Show a short state such as “Answer saved; waiting for #123”.
- When dependencies become satisfied, resume the same chat once a worker slot is
  free. If it no longer exists, start a fresh worker chat with the card and answers.
- Respect the worker's running/stop state, paused originating ready inbox,
  assignment, live ownership, capacity and current launch permissions. For a card
  outside an inbox, use its recorded `from`; if unavailable, do not invent an inbox
  or bypass a pause: leave a manual continuation offer.
- A user answer resolves the unanswered-input gate only. It does not resolve
  dependency blockers. Multiple submissions remain separate comments but coalesce
  into one pending continuation per card, which reads all saved answers.
- Deliver replies into an already running holder's turn as today; this is feedback
  to existing work, not a new launch. If blockers are added during a running turn,
  stopping that work is outside this proposal.
- Preserve the current Ask behavior for person-assigned and unassigned cards.

## Implementation shape

1. Extract shared dependency/ownership eligibility helpers with reason codes.
   Keep source-specific rules explicit: normal picking requires a ready column;
   a requested continuation may come from needs-input or review. Reusing
   `nextCard` unchanged would strand those continuations.
2. Store a narrow pending request keyed by stable card ID, with request ID,
   triggering comment IDs, expected assignee and preferred thread. Do not store
   a second copy of answer text. Clear/cancel on archive, deletion, reassignment
   or explicit dismissal; a newer submission can create a new request.
3. Extend daemon scheduling to consider pending continuations alongside fresh
   cards. Reuse persisted leases and reserve capacity for resumed chats too.
   Use the existing run lifecycle for limits, completion and merges. Consume the
   request only after accepted delivery; failed delivery must remain retryable
   without a busy retry loop. Reconcile a crash after accepted delivery using
   the request ID as an idempotency key in the receiving thread.
4. Recheck eligibility against current board state and reserve the card/slot
   immediately before dispatch. Failed dispatch releases the reservation. Do not
   rely on the form's stale view or a check after the chat has already started.
5. Reconsider pending requests on relevant board changes and daemon startup,
   including closed boards. Do not require another form submission or open tab.
6. Route the board's explicit Continue through the same server gate. The template
   currently calls `scribe.agent.card(... resume: true)` directly around line
   3690; changing only form replies leaves a second bypass. Account for saved
   older/custom board HTML: enforce the guard at the server's Kanban continuation
   boundary as well. No implicit force override in this proposal.

The scheduler needs an explicit resume operation/result alongside its existing
new-thread launch operation; a pending record alone will not resume an old chat.
Keep pending request data separate from a generic blocked status so ordinary
card selection cannot also start a fresh chat for the same card.

## Smaller alternative

Save the answer and offer manual Continue while blocked, with the same shared
server gate. Once the blocker clears, the user clicks Continue. This avoids a
durable continuation queue, but requires another click and is easier to overlook.
Recommendation: durable deferred continuation, matching today's automatic-submit
intent while respecting the board's conditions.

## Acceptance checks for implementation

- Blocked submission persists its answer without a start, claim or column move.
- Resolving the last blocker triggers exactly one continuation, including with
  the board closed and after daemon restart. Review/done/archive/missing blocker
  semantics match normal scheduling.
- Worker stop, inbox pause, full global/provider capacity and revoked permission
  prevent dispatch; clearing the condition allows the pending request to proceed.
- Repeated submits, two windows, simultaneous normal picking and reply delivery,
  stale leases, crash recovery and a blocker added before dispatch do not produce
  duplicate or premature starts.
- Missing chats, reassignment, archive/deletion and dismissed requests have the
  behavior above; current running-turn feedback and person-card Ask still work.
- Explicit Continue and older saved HTML cannot bypass the server check.

## Decision

The user chose durable deferred continuation. Regression coverage includes
closed-board persistence and restart, dependency transitions, leases, worker
gates, missing chats, cancellation, older board dispatch and request retry
deduplication.
