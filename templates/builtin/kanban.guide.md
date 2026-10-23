# Kanban board: agent guide

Work on this board with `page_action`. Actions read the latest state and apply the board's rules in one step (move and done times, column order, card numbers, who holds a card), so there is nothing to merge or retry. People refer to cards by number: `#12`, passed as `card: 12`.

## Actions

{{actions}}

`scheduledAt` is the earliest worker pickup time in epoch milliseconds (the card dialog's
**Start after**, entered in local time); `null` clears it. Workers, Continue requests and
agent claims wait until then; a running holder keeps working. Pickup also needs the usual
worker conditions and may follow on the daemon's next minute check, including when the board is closed.

Form answers and Continue requests are saved and immediately move the card to its originating
ready inbox (or the first ready inbox if none is recorded). They wait there for dependencies,
the assigned worker to be running, an unpaused originating ready inbox, a free slot and
page permissions. The daemon resumes the previous chat (or starts a fresh one if it is gone)
and claims the card only when it dispatches. Dismiss cancels a pending request. Replies to
an already running holder still enter its current turn.

Columns are named by role (`agent`, `working`, `review`, `done`), id, or title. Match by role: the user renames columns. If several columns share a role (two agent inboxes), `list` includes all of them; `move`, `create`, and `release` need an id or title.

## Working a card

1. Find work: `list` with `column: "agent"` (every agent inbox), then `get` the card you take. To stay in one inbox, pass its id or title. A `list` with no column skips done-role cards (pass `done: true` for those, or `q` to search including them).
2. `claim` it with a short status text. That moves it to the working column and records you as its holder. Another agent's claim makes yours fail: pick a different card.
3. Report progress or ask questions with `comment`. If you are stuck, `update` its `status` to `{ kind: "blocked", text: "<why>" }` and wait for a `comment` event.
   In a Scribe chat, the user's new comments on a card you hold also come into your chat as a `<card_comment>` message, mid-turn when the provider can steer, else right after it. Answer them on the card. On a card whose chat has finished, a comment offers the user **Continue**, which sends that chat a note to get the card again and go on; the board claims the card for that chat again and moves it to the working column. If that chat's worktree branch was merged, it works in a new worktree from the latest base branch (files may have changed since: read them again), and the board merges the branch again when the chat ends. The same goes for a chat on a review or done card that ends with new commits on its worktree branch by any other route (a message typed into the chat itself): the board merges that branch too, so work done after a merge is not left behind.
   A form page you make for the card (questions, mockup feedback) gets `replyTo: { page: "<this board's key>", card: <num> }` on `page_show`, and its submit button calls `scribe.reply(answers, { summary })` (the scribe skill's "Forms for a card"). The user's click posts the answers on the card as their comment and sends it to the card's chat like any comment: into your running turn, or Continue once your chat has ended. So you can release the card to wait for input and end your turn; the answer finds its way back.
4. Done: `finish` with a summary (what changed, what to check). The summary is posted as the card's hand-in comment, so do not also `comment` the same wrap-up. If you already did, call `finish` without `summary` and that comment is the hand-in. It moves the card to review, or to done when the board has no review column.
5. Giving up or handing back: `release` with a note.

If your thread fails or is stopped, Scribe moves your card back to the column it was claimed from with a blocked note. If you go quiet for a long time, it marks the card as held by a stale agent so someone can pick it up. While your chat waits on the user (page_ask, a question, an approval), the card you hold shows as blocked on that, and gets its status back once they answer.

## Agent workers

The Workers panel's **Max parallel** setting caps how many worker chats run at once: queued ones and one-card runs (right-click Run) alike, so a queued card waits for any of them to finish. **Per provider** caps the ones sharing a provider, regardless of worker name, and defaults to 1. Choose **Any** to remove either limit. Existing chats finish when a limit is lowered.

The Workers popup's **Default model** selects a worker whose model and settings a posted comment's **Ask** button uses. Ask is available only with a default worker set. A comment on a card without a worker assignee offers Ask instead of Continue. Asking starts a separate question or investigation chat without claiming, assigning, moving, or changing the status of the card. Its first message includes the full card snapshot (including all comments) and its images, so no initial get is needed; images that cannot be attached within the message limits are noted. Answer briefly in a comment; for investigation or design, create a background report page and comment with a peek link. Change the card's workflow only when explicitly asked in the comment.

Workers are assignees. The user sets them up under the board's **Workers** button: each has a name, a color, and agent settings, and a run switch. Shared instructions in the Workers panel apply to every worker; its own instructions are appended after them. Either shared or worker instructions are enough to start. Changes apply to new card chats. A running worker takes the cards in the agent (ready) columns that are assigned to its name, top first (a paused inbox is skipped; click its inbox tag to pause or resume); several can run side by side on one ready column, each on its own cards (up to the board's max parallel setting). A ready card assigned to a stopped worker waits, and cards assigned to people or to nobody are left alone. The board starts a fresh agent chat for each card, with the user's instructions and the card to take, so no chat carries the whole run's context. It claims that card for the new chat under the worker's name and moves it to the working column, and puts the card (description, checklist, last few comments) and the worker's other ready cards in the prompt, so the agent needs neither `claim` nor `get` to start (`get` only for images or older comments); a further card it takes in the same chat it claims itself. Its prompt says when it may take a closely related card in the same chat; otherwise it ends its turn and the board starts the next agent, or waits for cards itself. In a worktree, the agent commits its work before it ends; the board then rebases the branch onto the one it came from and merges it, so the next agent starts from the latest work. If that doesn't go through (conflicts), the board sends you a message in the same chat saying why: rebase, resolve the conflicts, commit, and end your turn without taking another card; the board tries the merge again (if it still won't merge, the card goes back to its ready column, blocked). If your turn fails or ends without finishing your card, the board leaves the card blocked with a note and the worker goes on with its next card. If a plan usage limit stops your turn, your card stays yours and the board sends you on in the same chat once the limit resets: check the card and your work so far, then finish it. If another chat took over or finished the card while you waited, that message says so: then only commit your own leftovers that are still needed and end your turn. `list` returns the workers (`workers: [{ id, name, running?, stopRequested? }]`). Starts, pauses, merges, and usage-limit waits are kept in a log on the Workers panel; `logs` reads it (so you can debug the board's run without Keeper process logs). When the user asks yours to stop after its card, it shows `stopRequested: true` there, the page logs `worker_stop`, and `claim` refuses any further card for that chat: take no more cards and end your turn. Scribe runs the workers itself, so they go on with or without a window showing the board. `worker_start`, `worker_step`, `worker_solo_step`, and `worker_claim` are the board's own bookkeeping; don't call them.

The user can also run a worker on one ready card from the card's right-click menu. That chat is separate from the worker's run: it takes only its card, and the board claims the card for it and moves it to the working column. A plan usage limit waits the same way as the worker's own run: the card stays claimed and the board sends that chat on once the limit resets.

## Events

Wait with `page_wait`. Pass the returned `cursor` as `after` next time, so nothing is missed or seen twice. Each event's `data` names the card: `{ card: "<id>", num: 12, column: "<title>", columnId, role }`. Pass `where` to match fields on that data (compared as text), e.g. `{ column: "grok issues" }`, so another agent column does not wake you.

| event | when |
|---|---|
| `card_ready` | The user moved a card into an `agent` column. `data` includes `column` (title), `columnId`, and `role`. |
| `comment` | The user commented on a card. |
| `approved` | The user approved a card in review; it moved to done. |
| `changes` | The user requested changes. Their note is the card's last comment and the card is back in the column it came from. |
| `claim_lost` | Scribe released a card because its agent's thread stopped. |
| `claim_stale` | Scribe flagged a card whose agent went quiet. |
| `worker_stop` | The user asked an agent worker to stop once its card is done. `data`: `{ worker, workerId }` (worker is its name). |

## State

You rarely need raw state; the actions cover the usual work. For anything they don't, read with `page_state` and a `path` (`cards/num=12`) and write with `page_update` ops.

```
columns: [{ id, title, role?, wip?, askAssignee?, paused? }]  // array order = board order
labels:  [{ id, name, color }]
cards:   [{ id, num, col, title, description, labels: [labelId], priority,
            due?, assignee?, checklist: [{ id, text, done }],
            comments: [{ id, by, at, text }], images: [{ id, name, data }],  // by: "user" | assignee name | "agent"
            blockedBy: [cardId], status?, claim?, thread?, from?, archived?,
            suggest?: { labels?: [labelId], priority?, no?: [labelId | "priority"] },  // the page's; leave it alone
            cover?, createdAt, createdBy?, createdThread?, movedAt, doneAt?,
            usage?: { turns, inputTokens?, outputTokens?, at?, thread? } }]  // last worker chat; page writes it
nextNum: number
settings: { hideAddColumn?, showDoneDate?, maxWorkers?, maxWorkersPerProvider?, workerInstructions?, defaultWorker?,    // the user's page settings; leave them alone
            workerLog?: [{ id, at, kind, text, worker?, workerId?, card?, thread?,
                           usage?: { turns, inputTokens?, outputTokens? } }],  // the page's; read with logs
            workers?: { [workerId]: { name, color?, instructions?, context?, provider?, model?, effort?, fast?, mode?, customMode?,
                                      cwd?, approval?, worktree?, web?, show?, helpers?,
                                      threadId?, run?, step?, stop?, merge?, error?, fails?, solo? } } }  // run..solo: the page's
```

- `description` and comments are markdown: headings, lists, quotes, code, links and GFM tables (`| a | b |` over a `|---|---|` row). `#12` links to card 12. `![alt](#img-<image id>)` shows one of the card's images inline.
- comments `by` is `"user"` for the person, or the assignee/worker name that posted it. Older comments may still say `"agent"`.
- Link Scribe pages in a title, description, or comment with their key: `[[scribe:some-page]]` shows the page's title, `[[scribe:some-page|text]]` your own text, `[[peek:scribe:some-page]]` / `[[split:…]]` open it as a peek or beside the board, and `[text](scribe:some-page)` works too. A card on another board (or this one, from a chat reply or another page) is `scribe:board-key#card=12`: `[[scribe:board-key#card=12|#12 on the other board]]` opens that card's dialog. Use keys you created or found with `page_list` / `library_search`.
- Link a file on disk (a screenshot, a log, an output) with `[[file:C:\path\shot.png]]` (shows the file name), `[[peek:file:…]]`, or `[text](file:///C:/path/shot.png)`. It opens as a temporary page that stays out of the user's Library and is gone once closed.
- `priority`: 0 none, 1 low, 2 medium, 3 high, 4 urgent. `due`: `"YYYY-MM-DD"`. Times are epoch ms.
- `thread` is the in-app agent thread that last claimed the card (set by `claim`, kept after `finish`). The card's right-click menu opens it.
- `createdBy` is the original creator (`"user"` for the person, otherwise the worker or agent name); `createdThread` links to the agent chat that created it. They stay unchanged when the card is assigned or claimed. Older cards without them show an unknown creator.
- `usage` is the last worker chat's token totals (input, output, rounds), including its helper tree, written when that chat ends. `promptTokens` includes cached input exactly once. With helpers, `main` keeps the main chat's own provider figures and `helpers` gives their normalized totals and `threads` count. `costUsd` includes only reported costs; `costPartial` marks missing costs. Running helpers contribute what they have reported so far. Leave it alone; `list` includes it so cost outliers are easy to spot. Existing boards retain their saved HTML: older copies can strip these breakdown fields when saving usage and keep their old token formatting until their HTML is updated.
- Images: insert into `cards/num=12/images` with `page_update`, pass the file in `assets`, and write `data: "asset:<file name>"`. The first image is the card's cover unless `cover` is `false` (the card dialog's Show cover switch). `get` (and a `page_state` path to one card) attaches those images so you can see them; a whole-board read does not inline every cover.
- `paused` on an agent column: workers skip it until the inbox tag is clicked again. Leave it alone; the user toggles it from the tag.
- `workerLog` is the board's own run log (starts, pauses, merges, usage-limit waits). End-of-chat lines include `usage` when the daemon reported totals. Leave it alone; read it with `logs`.
- `from` is the last agent column the card entered. Sweep, `release` (no `to`), and Request changes send it back there when there is more than one agent column.
- Keep `archived` cards; they are the user's archive.
- `suggest` holds what the classifier suggested for a card (board setting "Suggest labels and priority", `settings.suggest`): labels and a priority the user has not taken yet, and in `no` the ones they dismissed. The board asks about a card that is created or whose title or description changes while the board is open in a window, however it got there (the UI or your `create` / `update`), and shows the answer as chips; only the user's click applies one. Don't write `suggest` and don't treat it as the card's labels or priority. A label may carry a `description` (set it with `page_update`): it is added to the question asked about that label.
