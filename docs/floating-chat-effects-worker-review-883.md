# Floating chat effects lab: thread reuse (#883)

Reviewed 2026-10-29 against the saved lab page `scribe:floating-chat-effects-lab`
(revision 7) and this branch's Scribe source. The lab is a saved Library page;
its JavaScript is not `public/orb.js`, which supplies the visual effects.

## Follow-up: separate worktrees and apparently missing changes

The user reported three linked effects worktrees and asked for the cause before
any fixes. No runtime, branch, or preview changes were made in this follow-up.
The earlier report described normal reuse but did not establish the failure
paths that strand unmerged work; the following findings supersede its untested
edge-case discussion below.

### Confirmed cause

The lab decides whether to start from its in-memory `thread`, initially null,
instead of waiting for restoration of the saved `threadId`. Three failure paths
were reproduced using the unchanged revision-7 `sendToAgent` and `initAgent`
functions in Node VM contexts with fake agent calls:

1. A send before `agent.get(savedId)` completes starts a replacement despite a
   valid saved worker. Late restoration can then overwrite the in-memory worker
   after the replacement ID was saved.
2. Two initial sends before either `agent.start` completes each start a worker;
   there is no shared in-flight start guard.
3. A temporary rejection from `agent.get` clears the saved ID, just as if the
   worker had actually been deleted.

This reproduction created no real agents, worktrees, or page-state updates.
It proves the code defects, not which event occurred in the historical session.
There is no retained browser trace identifying that exact event.

Every replacement calls `agent.start` with `cwd` set to the main repository and
`worktree: true`. Scribe associates worktrees with threads, not with pages or
titles. The new thread therefore gets a branch from main-checkout HEAD, not from
the lab's previous unmerged branch. `createWorktree` adds `-2`, `-3`, etc. when
the branch name or folder is already taken. Repeated messages on one thread
retain its open worktree (`wantsWorktree` in `host.ts` checks for an open one).

### What actually happened to the effects

Thread transcripts and Git refs confirm this sequence (Europe/Helsinki times):

| When | Event |
| --- | --- |
| 27 October 04:51 | The first effects worker merged 37 commits and removed its worktree. |
| 27 October 04:55–05:13 | Another worker on `agent/floating-chat-effects` added the later Three dots work, ending at `60882b4`. This work remains unmerged. |
| 27 October 05:15 | A page-started replacement created `agent/floating-chat-effects-2` from master, which lacked Three dots. That agent noticed and fast-forwarded its own branch onto `60882b4`, then added Orbit and Voice bars (`3d3109e`). |
| 27 October 05:23–05:24 | Another page-started worker created `agent/floating-chat-effects-3`, immediately hit a Claude session limit, and subsequently had its empty worktree removed. |
| 29 October 05:25–05:27 | The current Codex worker created `agent/floating-chat-effects-3` from master again. It implemented Voice bars in the older file and published it to the lab, then shrank the idle bars (`8c8212d`, `6b38e2e`). It did not bring forward Three dots or Orbit. |

This latest publication replaced the demo's whole `orb.js` snapshot. Thus the
preview stopped including the earlier effects while their Git commits remained
on the other branches. The new workers' initial messages are marked **sent by
page** and contain the lab's `First request` prompt: these were explicit lab
`start` calls, not merely the dock's two-hour draft selection rule.

All three worktrees currently exist and have clean working trees. Relative to
current master, `agent/floating-chat-effects-2` contains nine unmerged commits,
including all eight from `agent/floating-chat-effects` plus Orbit/Voice bars.
`agent/floating-chat-effects-3` contains the two newer Voice bars commits.
Comparing the two `orb.js` versions confirms Three dots, Orbit, and their shared
shade are present on `-2` and absent on `-3`. These effects are recoverable;
neither merging nor copying them was attempted. Recovery must preserve unrelated
newer main-branch changes rather than replace the whole file from the older tree.

### Proposed next step, awaiting the user

Make sends wait for restoration and share an in-flight start; preserve the saved
ID on temporary lookup failures; when a saved worker is truly gone, check for
surviving page work before creating a replacement. Recovery should combine the
earlier effects with the current bars changes. The user-facing report includes
a decision form, because the user explicitly requested the explanation before
fixes.

Evidence: threads `th_b174ae96217e` (merge notice), `th_4e3a5d3864ce` (Three
dots), `th_e57f27b3b4de` (new worktree and fast-forward), `th_70699e16c46e`
(limit and empty merge), and `th_d4df466454d3` (new Codex worktree/publication).
Read-only Git checks: worktree list, all three working-tree statuses, branch
histories, and `orb.js` diffs. The source-level reproduction passed all three
cases. No runtime tests were needed for this documentation-only follow-up.

## The lab's effect request fields

All effect fields share one worker conversation, tracked in page state as
`threadId` and in the page's JavaScript as `thread`. There is no separate worker
per effect, tab, preview provider, palette, or request.

| Situation | Result |
| --- | --- |
| First request, with no restored worker | `scribe.agent.start` creates a new page-scoped thread and requests its own Git worktree. |
| Another request while the worker is idle | `scribe.agent.send` continues that thread. |
| Another request while the worker is busy | The message queues on that same thread. |
| Switch effect/tab, change the preview, or finish a reply | Keeps the worker. Preview changes alone do not send messages. |
| Stop the worker | Stops its turn; the lab retains its thread reference. A later send continues it. |
| Reload/reopen the lab | Restores the saved `threadId` with `scribe.agent.get`; reuses it when found. |
| Saved thread cannot be restored | Clears `threadId`; the next request starts a worker. |
| Click the lab's Merge button and the call succeeds | Clears `thread` and `threadId`; the next request starts a fresh worker. |
| Merge returns `ok: false` | Keeps the existing worker and reports the failure. |

The exact send branch is `thread && thread.status !== "gone"`: send to the
existing ID; otherwise start. The lab does not apply an idle timeout.

The first request includes the full effects-agent instructions: edit and commit
in the worktree, publish `orb.js` to the lab, check shader errors, and leave merging
to the user. Later requests contain only the named target, request, and current
preview settings; conversation history supplies the earlier instructions.

Merge is therefore the normal boundary between batches of related changes.
The old conversation is not deleted when the lab clears its reference.
Technically the lab resets on any non-failing merge response, including
`ok: true, merged: false` when the thread has no open worktree. The displayed
toast calls that "Merged" too.

## Scribe's floating chat has a separate selection rule

Opening Scribe's ordinary floating chat selects its remembered conversation on
the page, otherwise the most recently active non-archived page conversation.
If the selected idle conversation's last completed reply is more than two hours
old, the dock offers a new-thread draft. The thread is created when a message is
sent, not just when the draft appears.

Running/waiting threads do not expire under that rule. Explicitly choosing an old
thread refreshes its selection for two hours; a newer reply refreshes it too.
An explicit New thread choice remains a draft until the user sends or chooses
another conversation.

This rule changes which chat the dock displays. It does not clear the lab's saved
`threadId`. The lab's Open chat button explicitly opens its own worker. Starting
another conversation manually in the dock does not make it the lab's worker.
Thus a dock message can use a new conversation while an effect field still sends
to the older effects worker.

## Model and preview choices

The lab's model picker stores `state.model`, but only `scribe.agent.start` reads
it. Changing it during an existing worker's session does not change that worker
or create a replacement; it takes effect on the next start. The provider shown in
the visual demo only changes the preview, not the worker's provider/model.

## Limits of the finding

This is a source review, not a reconstruction of a specific observed click
sequence. The routine explanations for different threads are Merge, failed
restoration, or using the floating chat's separate selection rule. There are
also asynchronous edge cases: the lab has no shared in-flight start guard, and
initial restoration finishes asynchronously. Multiple initial sends or a send
before restoration completes can reach the start branch. Its restoration code
also treats a failed `get` like a missing thread. Those paths were not reproduced
here and should not be claimed as the cause of the reported observation.

## Evidence and validation

- Saved lab revision 7, lines 303–399: prompt, send/start branch, Merge, model
  picker, event subscriptions, restoration. Lines 407–490 route all request
  fields through the same sender.
- `src/bridge.ts`, `agent.start` and `agent.send`: distinct new-thread and
  existing-thread operations.
- `public/agent.js`, `pageRequest` start/send/get/merge cases: start creates a
  thread, send addresses an ID, get restores it, merge can be a successful no-op.
- `src/agent/host.ts`, `send`: busy threads queue messages on the existing ID.
- `src/agent/pageChat.ts` and matching `public/agent.js` helpers:
  `pageDockThreadId`, `pageThreadIsStale`, `PAGE_CHAT_STALE_MS`.
- Existing tests: `npx tsx --test --test-isolation=none
  src/agent/pageChat.test.ts` — 9 passed, 0 failed. These cover dock selection,
  age boundaries, remembered picks, and workspace selection; they do not exercise
  the saved lab page. The initial sandboxed attempts could not spawn Node/esbuild;
  the successful run used approved execution outside the sandbox.

No runtime behavior changed in this investigation. The user-facing report and
follow-up form are in Scribe as `scribe:worker-logic-review-883`.
