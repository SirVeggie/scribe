# Page scripts

Builds on `SKILL.md` in this folder (showing and patching pages, theme, page kit): read that first if you have not.

## Interactive pages

Every page owns a JSON state object stored by the daemon. Use it for anything the user can change — todo lists, checklists, notes, review queues — and you can read back exactly what they did.

**Never use `localStorage` in a page.** All pages share one origin, so it collides across pages, and you cannot read it. Use `scribe.local` for things that belong to one viewer.

`window.scribe` is injected before your page scripts run:

```js
scribe.state                      // shared state, available synchronously
scribe.set({ todos })             // replace top-level keys; arrays of items with ids are sent as item changes
scribe.update([{ op: "merge", path: "todos/t_1", value: { done: true } }])   // change one item directly with ops
scribe.onChange(render)           // someone else changed the state; not fired for your own writes
scribe.onChange((state, { source, ops }) => …, { local: true })   // also your own writes; see below
scribe.onOpen(({ anchor, args }) => showItem(args.item || args.record))   // a link or search hit asked for a place in this page
scribe.bind(el, "notes")          // two-way bind an input, textarea, or checkbox to a shared key
scribe.local                      // this viewer's own state: filters, open panels, drafts
scribe.setLocal({ filter: "mine" })
scribe.bind(el, "draft", { local: true })
scribe.signal("submitted", { item: "t_1" })   // log an event agents can wait on, with small data
scribe.action("move", { card: 12, to: "done" })  // run one of the page template's actions
scribe.reply({ approach: "A" }, { summary: "Picked A" })  // send a form's answers to the page you wired it to; see scribe.reply in your own markup
scribe.saveAsset(file)            // store an image/file for this page; see Page assets
scribe.preview(fileOrAssetId)     // show images, PDFs, text and more in Scribe's viewer; see Previewing files
scribe.open("scribe:key", { mode })  // open a page or URL as "tab", "peek", or "split"; see Links from a script
scribe.agent.start(prompt)        // start an agent chat thread for this page; see PAGE-AGENT.md
```

Less common:

```js
scribe.id                         // this page's tab id (t_…)
scribe.revision                   // the state revision this page has seen
scribe.template                   // { id, values, revision, compatible } on a template page, else null
scribe.file                       // a file page's own file: read(), image(), save(text, opts), saveAs(text, opts); Scribe's file viewer uses it
scribe.ide                        // a file in the page's workspace in the user's IDE: check(file) → { project }, open(file, { line }) on a click; <s-code file line> uses it
scribe.browser                    // a thread's browser view page only: info(), watch(onEvent) → stop, navigate, tabs, input, control, fit, close; Scribe's browser page uses it
scribe.title                      // this page's title (its tab and Library name)
scribe.setTitle("Trip plan")      // rename the page, e.g. from a heading the user edits in place; resolves with the new title
scribe.onTitle((title) => …)      // the title changed (setTitle here, or a rename in the tab strip or Library)
scribe.flush()                    // send pending writes now (Scribe already does on hide and unload)
scribe.onError(({ kind, status, message, name }) => …)  // a save or signal was refused for good (read-only here, page gone): its edits are dropped and the state reloads; failures that may pass are retried quietly
scribe.ops.get(state, "todos/t_1")   // the state-op engine: get(state, path), diff(before, after, keys), apply(state, ops)
scribe.reportIncompatible(reason) // template pages: this state is not one the HTML can show; see TEMPLATES.md
```

Links from a script:

- `scribe.open(target, { mode, anchor })` is the script form of a link for a click handler. It resolves to `{ ok, mode, id }` or `{ ok: false, error: "not_found" | "in_trash" }`, and refuses calls outside a click or key press, so a page can never switch the user's view on load.
- `scribe.resolve([keys])` returns `{ key: { id, title, open } | null }`, for a page that builds its link list from state.
- `scribe.onOpen(fn)` calls `fn({ anchor, args })` each time a link or a search hit opens this page with a `#…` part, also when the page is already open, and once for a request that came before the page listened. `args` holds the `name=value` pairs (`#card=12` gives `{ card: "12" }`; several are joined with `&`), and is empty for a plain `#id`, which Scribe has already scrolled to. A search hit for one of the template's `search.records` comes as `args.record`, holding that record's `anchor` field, so accept it beside your own name. It returns a function that stops listening.

Writes apply on the page at once and reach the daemon as small item-level changes. When an agent (or another window) changes a different item at the same time, both changes survive. The same field written by two people at once: the later write wins.

Declarative events (do **not** also call `scribe.signal` in the same click):

```html
<button type="button" data-scribe-signal="submitted">Submit</button>
<form data-scribe-signal="submitted">...</form>
```

Seed a page's shape with the `state` argument to `page_show`. It applies only when the page has no state yet, so re-showing a revised page never resets what the user has done.

Rules that keep pages well behaved:

- Give every item in an array a stable `id` (`{ id: "t_1", ... }`). Arrays of items with ids merge with other writers item by item; arrays without ids are replaced whole.
- Bind every text field with `scribe.bind` rather than wiring inputs by hand. It protects in-flight typing: a remote change to a field the user is inside does not touch their caret.
- In `onChange`, re-render only the parts that changed. Do not rebuild a container that holds a bound field. The second argument says what changed: `source` is `"remote"` (an agent or another window), `"resync"` (a reload, or edits of yours Scribe dropped), or `"local"` (your own writes, only for a listener added with `{ local: true }`, once per burst of writes after your code finishes), and `ops` lists the change as state ops (`cards/c_1/...`), or is `null` when anything may have changed. Writes copy only the path they change, so an item nobody touched is the same object as before: `item === lastRendered` means it needs no repaint.
- Keep what belongs to one viewer — in-progress typing, filters, which item is open — in `scribe.local`, not in shared state. Agents never see it.
- State is JSON only, up to 4 MB per page. Images, files, and other binary data go in page assets (below), never base64 in state.

### The shape to follow

Bind the fields once, render the rest from state, and call `render()` yourself after your own writes:

```js
scribe.bind(document.getElementById("notes"), "notes");

function items() {
  return Array.isArray(scribe.state.todos) ? scribe.state.todos : [];
}

function render() {
  listEl.replaceChildren();          // rebuilds the list only, never the bound fields
  for (const todo of items()) { /* build one row */ }
}

function toggle(id, done) {
  scribe.update([{ op: "merge", path: `todos/${id}`, value: { done } }]);
  render();
}

scribe.onChange(render);
render();
```

## Page assets (images and files saved by the page)

When the user adds an image or file on the page itself (a kanban card's picture, a pasted screenshot, a dropped PDF), save it with `scribe.saveAsset` and keep its id in state:

```js
const asset = await scribe.saveAsset(file);          // Blob, File, ArrayBuffer, or typed array
// asset: { id, url, name, mimeType, bytes, usage }
scribe.set({ cards: [...cards, { id: newId(), title, image: asset.id }] });
img.src = scribe.assetUrl(card.image);               // "/blob/<id>"; works for an id or a stored url
await scribe.deleteAsset(id);                        // optional; unreferenced ones are cleaned up anyway
const { assets, usage } = await scribe.listAssets();
```

- An asset stays as long as its id (or url) appears anywhere in the page's state or HTML. Once nothing mentions it for 10 minutes it is deleted, so an undo right after removing a card still works. Save the id to state right after the upload.
- Deleting the page permanently deletes its assets with it. Export and import carry them.
- Limits: 32 MB per asset, 2000 assets and 256 MB per page. `usage.warning` is set (and Scribe shows a notice) once a page is 80% full; `saveAsset` rejects past the limit, so handle the error.
- A page that keeps adding assets (generated images, a gallery, uploads that pile up) must plan for a full store when you build it: check `usage` from `saveAsset` or `listAssets()` and make room before it runs out (e.g. delete the oldest entries' assets, keeping anything saved elsewhere such as a file on disk), or tell the user what to remove. Images an agent produces for the page (`scribe.agent` `images`) are stored as its assets too: when the store is full they are left out of `images`, so a reply without the expected image may mean the store is full. Free space and read the thread again. Remove an asset's id from all of the page's state (old job records too) or call `deleteAsset`, or it is never freed.
- To show a local image in the page's markup, use `assets` on `page_show` (Images in `SKILL.md`). To put a local file into the page's *data* (an image on a todo item, a card, a gallery entry), use `assets` on `page_update` and write the whole string `"asset:<name>"` where its URL belongs. It is stored as a page asset and replaced with `/blob/<id>`:

```
page_update({
  key: "groceries",
  assets: ["C:/Users/me/Pictures/apples.jpg"],
  ops: [{ op: "insert", path: "todos", value: { id: "t9", text: "Apples", done: false, description: "", col: 0,
    images: [{ id: "i1", name: "apples.jpg", data: "asset:apples.jpg" }] } }]
})
```

Every file must be referenced and every `asset:<name>` needs a file; otherwise the write is refused. The built-in Todo list keeps images per item as `images: [{ id, name, data }]` and shows one inline in the description with `![alt](#img-<image id>)`. `page_action` get (and a `page_state` path to one card or item) attaches those images so you can see them; a whole-board read does not inline every cover.

## Previewing files

Do not build a lightbox or document viewer into a page. `scribe.preview` opens Scribe's own viewer over the window. It shows images, PDFs, video and audio, Markdown, CSV/TSV as a table, HTML (sandboxed, no scripts), JSON, and plain text or code. Other types get a download button. With several files, the arrow keys step through them.

```js
thumb.addEventListener("click", () => scribe.preview(card.image, { name: "photo.png" }));  // an asset id or /blob/ url
input.addEventListener("change", () => scribe.preview([...input.files]));                 // Blobs or Files
scribe.preview(images.map((i) => ({ src: i.data, name: i.name })), { index: 2 });          // a gallery, opened at the third
```

- It takes a Blob or File, an asset id, a URL the page can fetch, `{ src | blob, name?, mimeType? }`, or an array of any of these. It resolves `{ ok }` or `{ ok: false, error }`.
- Like `scribe.open`, it only works inside a click or key press; otherwise it resolves `{ ok: false, error: "no_gesture" }`. Call it first in the handler.

## scribe.reply in your own markup

A form for a Kanban card (`replyTo` on `page_show`, see Forms for a card in `SKILL.md`) can send its answers from your own markup instead of `<form data-reply>`: have the submit button call `scribe.reply` with the answers and a one-line summary.

```html
<button type="button" id="send">Send answers</button>
<script>
  document.getElementById("send").addEventListener("click", function () {
    var s = scribe.state;
    scribe.reply({ approach: s.approach, notes: s.notes }, { summary: "Picked " + s.approach })
      .then(function (r) { status.textContent = r.ok ? "Sent to #320" : "Not sent: " + r.error; });
  });
</script>
```

- `scribe.reply` needs a click and saves pending edits first. It goes only where `replyTo` points: that is kept with the page, not in its HTML, so the page's code cannot send anywhere else. It resolves `{ ok, target, delivered }` or `{ ok: false, error }`; show the result on the form.
- On a Kanban board the reply becomes the user's comment on the card: the summary, the answers (short ones as a list, long ones quoted), and a peek link back to the form. It goes on to the card's chat: into its running turn, or Continue when that chat is idle (the board claims the card for it and moves it to working). So the agent gets the answers with the card, without reading the form's state.
- On any other page it logs a `reply` event (`data`: `{ from, card?, summary, data }`) you can `page_wait` on.
- Each click sends again and adds a new comment. Name fields so they read well as labels (`approach`, `notes`), and leave unanswered ones empty: empty values are skipped.
- `page_patch` with `replyTo` (and no edits) wires an existing page; `replyTo: null` clears it.

## Waiting for user input

`page_wait` is a single blocked call. The page logs a **named event** when the thing you care about happens; you wait for that name. Typing, `scribe.set`, and `scribe.bind` do **not** wake you. Optional `where` matches fields on each event's `data` (compared as text), e.g. `{ column: "grok issues" }` on a Kanban `card_ready`.

Handshake:

1. Pick a short event name (`submitted`, `chosen`, `all_done`, `approved`).
2. The page logs that name when the condition is met — `data-scribe-signal="submitted"` or `scribe.signal("submitted", data)`. Put ids in `data` (which item, which choice), not whole records.
3. `page_show` the page.
4. `page_wait` with the same `key` and `events: "submitted"`. Without `after`, only events from now on count, which is right just after showing the page. When you read the page first and then wait, pass the `eventCursor` from `page_state` as `after`, so an event that came in between isn't missed.

The result is `{ events: [{ seq, name, data, at, by }], cursor }`, oldest first, with no state. Read what you need next with `page_state` and a `path`, or with a page action. `scribe.signal` sends the edits made before it in the same request, so that read sees them.

Do **not** signal on every keystroke, bind, or `onChange`. Do **not** wait for `stateRevision` to change.

### After the wait

- `events` is non-empty — handle each one (branch on `name`). Pass the returned `cursor` as `after` on your next wait, so nothing is missed or seen twice even if several events arrived together.
- `timedOut: true` — tell the user you are still waiting, then call `page_wait` again with the **same** `after`.
- `closed: true` — the tab was closed (the page is still in the Library); reopen it with `page_open` if you still need the handshake, or stop.
- `deleted: true` — the page was deleted; stop.
- `missed: true` — more events happened than the log keeps (500). Read the page's state instead of relying on the events.

Default timeout is 2 hours, with no maximum. Keep the default unless you have a reason to stop waiting sooner; the user can interrupt you at any time. Never poll `page_state` in a loop.

### Patterns

Submit a form (bound fields are already in state):

```html
<button type="button" data-scribe-signal="submitted">Submit</button>
```

```
page_wait({ key: "review", events: "submitted" })
```

Choice buttons — the choice rides in the event's data. Use `type="button"` and **either** `data-scribe-signal` **or** `scribe.signal`, not both:

```html
<button type="button" onclick="pick('a')">Option A</button>
<button type="button" onclick="pick('b')">Option B</button>
<script>
function pick(id) {
  scribe.set({ choice: id });
  scribe.signal("chosen", { choice: id });
}
</script>
```

```
page_wait({ key: "options", events: "chosen" })   → events[0].data.choice
```

Different outcomes:

```html
<button type="button" data-scribe-signal="approved">Approve</button>
<button type="button" data-scribe-signal="rejected">Reject</button>
```

```
page_wait({ key: "pr-review", events: "approved,rejected" })
```

Then branch on `events[0].name`.

All todos checked — signal from the condition, not from each toggle:

```js
function toggle(id, done) {
  scribe.update([{ op: "merge", path: `todos/${id}`, value: { done } }]);
  render();
  const todos = scribe.state.todos;
  if (todos.length && todos.every((t) => t.done)) {
    scribe.signal("all_done");
  }
}
```

```
page_wait({ key: "todos", events: "all_done" })
```

Keyboard (Ctrl/Cmd+Enter):

```js
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  scribe.signal("submitted");
});
```
