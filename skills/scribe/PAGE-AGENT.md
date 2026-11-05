# Pages that use the agent

Builds on `SKILL.md` in this folder (showing and patching pages, theme, page kit): read that first if you have not.

A page can start Scribe's own agent chat and read its replies with `scribe.agent`. Use it for buttons like "Summarise", "Break this card down" or "Draft a reply", where the page builds the prompt from its state and shows the answer itself.

```js
const { ok, threadId, error } = await scribe.agent.start(prompt, { title: "Card #12", approval: "board", show: "dock" });
await scribe.agent.send(threadId, "Shorter, please.");     // queued if the thread is still working
await scribe.agent.send(threadId, "No, the other one.", { steer: true }); // into the running turn when the provider can: { ok, steered, queued }
const { reply, images } = await scribe.agent.wait(threadId); // when the thread is idle (default 10 min); images: its generated images as page assets
const { threads } = await scribe.agent.threads();          // this page's threads, newest first
const { thread, reply: last } = await scribe.agent.get(threadId);
scribe.agent.onChange((t) => render(t));                   // { id, title, status, queued, reply? } on status changes
const { steps } = await scribe.agent.steps(threadId);      // running turn's last 4 steps [{ key, kind, text }], as the collapsed chat shows them
scribe.agent.onSteps(({ id, steps }) => paint(id, steps)); // then each change to them (empty once the thread stops)
await scribe.agent.stop(threadId);                         // stop the turn and drop queued messages
await scribe.agent.merge(threadId);                        // idle Code thread: merge its worktree branch back, close the worktree
await scribe.agent.card(threadId, { card: 12, title, text }); // Kanban: a card comment into the running turn (steered, else queued); { delivered: null } when idle
await scribe.agent.card(threadId, { card: 12, title, resume: true }); // Kanban Continue: the thread reads the card again and goes on (other pages' threads need a click)
await scribe.agent.show(threadId, { where: "sidebar" });   // open a thread in the chat (inside a click); any of the user's threads
const opts = await scribe.agent.options();                 // { providers, models: { claude: [{ id, label, efforts, params }] }, customModes: [{ id, label, detail, base }] (start({ customMode: id }); base is its highest rung), approvals: the rungs, defaults, favorites: ["claude:opus", …] }
scribe.agent.onOptions((o) => paintPicker(o));             // options() again whenever the user stars or unstars a model (after options())
const pick = await scribe.agent.pickModel(button, { provider, model }); // the app's model picker under button (inside a click): { ok, provider, model, label }
scribe.agent.modelPicker(button, { value: { provider, model }, onChange: (v) => save(v) }); // or let a button of the page open it and show the choice
const unsubscribe = scribe.agent.onLimits((limits) => paintLimits(limits)); // updates after limits(); call unsubscribe() to stop listening
const { ok: limitsOk, limits } = await scribe.agent.limits(); // provider plan usage; also subscribes this page to updates
if (limitsOk) paintLimits(limits);                         // render the initial snapshot
const { path } = await scribe.agent.pickFolder();          // the user picks a folder (inside a click)
const { actions } = await scribe.agent.actions();         // the template's right-click agent actions: [{ id, label, description, selection, context }]
await scribe.agent.runAction("triage-card", { context: { card: "#12 Fix login" } }); // run one from the page's own menu (inside a click)
await scribe.agent.start(prompt, { cwd: path, approval: "edits", provider: "claude", model: "sonnet", effort: "high", worktree: true });
await scribe.agent.delete(threadId);                       // delete one of this page's threads (a running turn stops first)
```

## Usage limits and model pickers

`scribe.agent.limits()` resolves to `{ ok, limits }`, where `limits` is keyed by provider. Each report has `at` (epoch milliseconds) and `windows` (`id`, `label`, `utilization` as a fraction where `1` means 100% used, optional `resetsAt` in epoch milliseconds), and may include `availability`, `detail`, `ordinaryUsageAllowed`, and `overage`. Missing providers have no report. It also has `spend`: today's cost of Native chats per pay-per-use API, keyed by the model id's part before `/` (`deepseek`): `{ day, costUsd, label, balance? }`, where `day` is the local `YYYY-MM-DD` it is for and `balance` (DeepSeek only) is `{ at, available, amounts: [{ currency, total, granted?, toppedUp? }] }`.

`scribe.agent.onLimits(fn)` calls `fn(limits, spend)` with the full provider map whenever provider usage or API cost changes after this page calls `limits()`. Register the listener before calling `limits()` to receive changes during the initial request, and render the returned snapshot for the initial display. The returned unsubscribe function removes that listener.

To let the user choose a model, don't build a picker: open the app's own. `scribe.agent.pickModel(anchor, { provider, model })` (inside a click) opens Scribe's model picker over the page, below `anchor` (an element, or `{ left, top, width, height }` in the page), with the user's starred models, search and stars, and `{ provider, model }` checked. It resolves `{ ok: true, provider, model, label }`, or `{ ok: false, error: "cancelled" }` when the user closes it. `scribe.agent.modelPicker(button, { value, placeholder, onChange })` wires a button the page styles itself: it shows the chosen model's label (`placeholder`, default "Default model", while `value` is null), opens the picker on click and calls `onChange({ provider, model })`. It returns `{ value(), set(value), destroy() }`. Pass the choice to `start({ provider, model })`; effort and other settings stay the page's.

`favorites` lists the models the user starred in the app's model picker, as `"provider:id"` strings in star order. A page that must list models itself (a whole table of them) should list these first, as the app does, and keep them current with `scribe.agent.onOptions(fn)`: after the page calls `options()`, `fn` gets the full options again whenever a star changes. It returns an unsubscribe function.

## Thread settings and permissions

- `approval` is the thread's rung: `"readonly"` (read files and pages), `"board"` (the default: also create and change pages), `"edits"` (also edit files: workspace edits accepted, commands ask), `"auto"` (a classifier answers), `"full"`. From Edits up it needs a `cwd`. `mode: "plan"` plans first; older pages' `mode: "board"` / `"ask"` mean Board and `"code"` an editing rung (Auto review without an `approval`). Unset `provider` / `model` / `effort` / `approval` / `web` / `fast` follow the user's defaults; take ids from `options()`. Cursor models expose a `fast` param; pass `fast: true` (or `modelParams: { fast: "true" }`) to turn it on.
- A page only sees and drives **its own** threads (scoped to that page). It cannot reach other threads, except to `show` one by id, which tells the page nothing about it.
- `show: "dock"` or `"sidebar"` opens the thread in that chat; omit it to run quietly. The tab still shows its working dot.
- What else a page may do is the user's call, per page (tab menu → Permissions…). Scribe asks the user when a call needs a permission the page doesn't have yet, so `start`, `send`, and `stop` may take as long as the user does. A refusal is `{ ok: false, error: "denied", permission }`; show it on the page instead of retrying in a loop.
  - `agent.chat` (allowed by default): `start` / `send` / `stop` right after a click or key press on the page. Call them first in the handler, before other `await`s.
  - `agent.unattended` (asks): the same from the page's own code, e.g. in `scribe.onChange` when a card moves. Only while the page is loaded in a Scribe window, and every open window runs the page's code: claim the work in state first (an `update` with a `test` op) so two windows don't both start it.
  - `agent.workspace` (asks): any thread with a `cwd`, approved per folder and rung. `pickFolder()` only picks; Scribe still asks before the first thread there.
  - `files` (asks): `scribe.files`, approved per folder at Read, Write or Read & write (see Files in a folder in `PAGE-SERVICES.md`).
  - `scribe.permissions.request("agent.unattended")` (inside a click) asks up front, e.g. from a settings dialog; `scribe.permissions.query()` reads `[{ id, label, value, folders? }]`.
- Agents can't read or change these grants, and an agent changing a page's HTML (or its template) resets the risky ones to Ask: tell the user to re-approve after you edit such a page.
- Messages are marked as sent by the page, and the agent is told that the page's code sent them, not the user. Put page data in the prompt, never instructions from untrusted content.
- Keep the thread id in state if the page should continue the same conversation later.
- `send(threadId, text, { steer: true })` puts the message into the turn the thread is running, as a Kanban card comment goes, instead of after it (a voice page passing on what the user says while the agent answers). The result says which happened: `steered: true, queued: false` when the provider took it in (Claude, Codex, Cursor and Pi threads, with or without tools; the agent reads it at its next step, which for a thread without tools is right after the reply it is writing), else `steered: false` and it queued behind the turn and any earlier queued messages. An idle thread just starts a turn (`steered: false, queued: false`). It needs the same permissions as any `send`.
- A page that lets the user change the model of a thread it keeps passes the choice on each `send(threadId, text, { provider, model, effort })`. The same provider switches the thread in place. Another provider goes on in a fork that keeps the history and the open worktree: the result has `threadId` (the fork's) and `forked: true`, so store that id from then on. While the old thread still runs a turn, a provider switch returns `error: "busy"`.

## One-off chats: images in, text out, no tools

For a page that only needs a model's answer about what it sends (read the text in an image, classify, rewrite, translate), start the chat with `tools: false` and send the input with it. Such a thread has no tools at all: no pages, files, shell, web, MCP servers or memory, on every provider, whatever the prompt says. It runs Read-only with no folder and web off, so it needs no folder approval and costs a single model call with no tool round trips.

```js
const { ok, threadId } = await scribe.agent.start("Transcribe all text in the image. Reply with the text only.",
  { title: "OCR", tools: false, images: [file], provider, model, effort: "low" });
const { reply } = await scribe.agent.wait(threadId);
await scribe.agent.delete(threadId);                       // keep the user's chat list clear of one-off chats
```

- `temporary: true` (on `start`, any thread, with or without tools): the chat stays out of the user's thread lists, showing only while it runs or waits on them, and Scribe deletes it when it restarts. Use it for chats the page starts in bulk (one per generated image, one per classified item), and still `delete` each one once the page has what it needs.

- `images` (on `start` and `send`): up to 10 images, 8 MB each: Blobs or Files (a paste or drop), `data:` URLs, or asset ids or URLs of this page. A bad one resolves `{ ok: false, error }` with `too_many_images`, `image_too_large`, `not_an_image` or `image_not_found`, and nothing is sent. Any thread takes them, not only one without tools.
- Images out: `wait`, `get` and the settled `onChange` event also carry `images`, the images the agent produced in its latest turn (image generation, a tool's image result), already saved as this page's own assets: `[{ id, url, name, mimeType, bytes }]`. Show `url` or keep `id` in state (an asset nothing references is deleted later). Never ask the agent to report an image path; it may not know one, and the page cannot read it. An image that could not be saved is listed in `imageErrors: [{ name, error, message }]` instead (`error`: `asset_limit` when this page's assets are full, else `save_failed`); the image stays in the chat, so free space and call `get` again to fetch it.
- `delete` takes only the page's own threads. Delete a one-off chat once the page has its reply (or kept what it needs); leave it when the user may want to see the conversation.

## Agent runs: let Scribe see a chat through

For pages that hand work to agents and act on the result (a board's workers, a queue of jobs, a batch of reviews), don't write your own wait/retry/merge loop. Hand the thread to Scribe as a **run**, and Scribe sees it through in the daemon, even while no window shows the page: when a plan usage limit stops the agent's turn, it waits until the provider confirms the reset and sends the chat on (`resumePrompt`); when the turn is done, it merges the worktree branch (Code threads with `worktree: true`), and asks the agent to rebase and fix a branch that won't merge (twice) before giving up. Fixes to that lifecycle ship with Scribe, so they reach every page that uses it, customized templates included. The page only decides what to start and what an outcome means for its own data.

```js
const { threadId } = await scribe.agent.start(prompt, { approval: "auto", cwd, worktree: true,
  run: { tag: "job", data: { job: 7 }, resumePrompt: "Your usage limit reset: check job #7 and go on." } });
scribe.agent.onChange((t) => {                           // t.run: { phase: "running" | "waiting" | "ended", wait?: { until, count }, fixes, tag, data, outcome? }
  if (t.run?.phase !== "ended") return;
  const { kind, merged, held, message, error } = t.run.outcome; // kind: done | failed | cancelled | limit | merge_failed
  // …update the page's state from the outcome (claim it with a `test` op first: every open window sees this)…
  scribe.agent.release(t.id);                            // Scribe forgets the ended run (or stops seeing a live one through)
});
await scribe.agent.watch(threadId, { data: { job: 7 }, after: 0 }); // hand over a thread already running or done (after: 0 takes its last turn as it is)
```

- `run` options (on `start`, or `watch`): `tag` and `data` (small JSON, at most 4000 characters) come back as given; `merge: false` skips the merge; `resumePrompt` is what the chat gets after a limit; `after` (`watch` only, default now) is when the turns that count start, so hand a thread over before sending it the message that starts its work.
- Outcomes: `done` (`merged: true` when a branch was merged, `held` when the template's actions kept it unmerged), `failed` / `cancelled` (the turn failed or was stopped; `fixes > 0` means it was the agent's merge fix), `limit` (it kept running out of usage), `merge_failed` (`fixable: false` for problems no agent can fix, like the main checkout being on another branch).
- Each step also logs an `agent_run` event on the page (`{ thread, kind: "limit" | "resume" | "merge_fix" | "end", text, tag, data, phase, outcome }`), so `page_wait` can wait on it. Ended runs stay on the thread until the page releases them (a week at most), so a page that was closed still sees how they ended.
- Kanban boards go further: Scribe also picks each worker's next card and acts on the outcome (the Kanban action set's `drive` hook), so their workers go on with no window open. Their ▶ calls `scribe.agent.allow({ cwd, approval })` after the click, which asks the user for what starting chats without a click needs (`agent.unattended`, and the folder at that rung).
