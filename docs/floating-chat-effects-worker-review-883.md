# Floating chat effects lab: thread reuse (#883)

Reviewed 2026-10-29 against the saved lab page `scribe:floating-chat-effects-lab`
(revision 7) and this branch's Scribe source. The lab is a saved Library page;
its JavaScript is not `public/orb.js`, which supplies the visual effects.

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
