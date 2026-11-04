# Page scripts

Builds on `SKILL.md` in this folder (showing and patching pages, theme, page kit): read that first if you have not.

## Interactive pages

Every page has a JSON state object stored by the daemon. Keep anything the user can change there (todos, checklists, notes, review queues) and you can read back exactly what they did.

**Never use `localStorage` in a page**: all pages share one origin, so it collides, and you cannot read it. Per-viewer things go in `scribe.local`.

`window.scribe` is injected before your scripts run:

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

- `scribe.open(target, { mode, anchor })`, the script form of a link, resolves `{ ok, mode, id }` or `{ ok: false, error: "not_found" | "in_trash" }`. It only works inside a click or key press, so a page can never switch the user's view on load.
- `scribe.resolve([keys])` returns `{ key: { id, title, open } | null }`, for a link list built from state.
- `scribe.onOpen(fn)` calls `fn({ anchor, args })` whenever a link or search hit opens this page with a `#…` part (also when already open, and once for a request made before it listened). `args` holds the `name=value` pairs (`#card=12` → `{ card: "12" }`; several joined with `&`); it is empty for a plain `#id`, which Scribe already scrolled to. A search hit for one of the template's `search.records` arrives as `args.record` (that record's `anchor` field): accept it beside your own name. Returns an unsubscribe function.

Writes apply on the page at once and reach the daemon as item-level changes: concurrent edits to different items both survive; the same field written twice at once keeps the later write.

Declarative events (never also call `scribe.signal` in the same click):

```html
<button type="button" data-scribe-signal="submitted">Submit</button>
<form data-scribe-signal="submitted">...</form>
```

Seed a page's shape with `state` on `page_show`: it applies only when the page has no state, so re-showing a revised page never resets the user's work.

Rules:

- Give every array item a stable `id` (`{ id: "t_1", ... }`): such arrays merge with other writers item by item; arrays without ids are replaced whole.
- Bind every text field with `scribe.bind`, not by hand: a remote change to the field the user is in then leaves their caret alone.
- In `onChange`, re-render only what changed, and never rebuild a container holding a bound field. The second argument says what changed: `source` is `"remote"` (an agent or another window), `"resync"` (a reload, or your edits Scribe dropped) or `"local"` (your own writes, only for a `{ local: true }` listener, once per burst after your code finishes); `ops` lists the change as state ops (`cards/c_1/...`), or is `null` when anything may have changed. Writes copy only the path they change, so `item === lastRendered` means no repaint is needed.
- Per-viewer things (in-progress typing, filters, which item is open) go in `scribe.local`, not shared state. Agents never see it.
- State is JSON only, up to 4 MB per page. Binary data goes in page assets, never base64 in state.

### The shape to follow

Bind fields once, render the rest from state, and call `render()` yourself after your own writes:

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

When the user adds an image or file on the page (a card's picture, a pasted screenshot, a dropped PDF), save it with `scribe.saveAsset` and keep its id in state:

```js
const asset = await scribe.saveAsset(file);          // Blob, File, ArrayBuffer, or typed array
// asset: { id, url, name, mimeType, bytes, usage }
scribe.set({ cards: [...cards, { id: newId(), title, image: asset.id }] });
img.src = scribe.assetUrl(card.image);               // "/blob/<id>"; works for an id or a stored url
await scribe.deleteAsset(id);                        // optional; unreferenced ones are cleaned up anyway
const { assets, usage } = await scribe.listAssets();
```

- An asset lives while its id (or url) appears anywhere in the page's state or HTML; 10 minutes after nothing mentions it, it is deleted (so undo right after a removal still works). Save the id to state right after the upload.
- Deleting the page deletes its assets. Export and import carry them.
- Limits: 32 MB per asset, 2000 assets and 256 MB per page. At 80% full `usage.warning` is set and Scribe shows a notice; past the limit `saveAsset` rejects: handle it.
- A page that keeps adding assets (generated images, a gallery, piling uploads) must plan for a full store: check `usage` from `saveAsset` or `listAssets()` and make room first (e.g. delete the oldest entries' assets, keeping anything saved elsewhere such as on disk), or tell the user what to remove. Images an agent makes for the page (`scribe.agent` `images`) are its assets too, and are left out of `images` when the store is full: a reply missing its image may mean that. Free space and read the thread again. An asset is only freed once its id is gone from all the page's state (old job records too) or `deleteAsset` is called.
- A local image in the page's markup: `assets` on `page_show` (Images in `SKILL.md`). A local file in the page's *data* (an image on a todo, a card, a gallery entry): `assets` on `page_update`, writing the whole string `"asset:<name>"` where its URL belongs; it is stored as a page asset and replaced with `/blob/<id>`:

```
page_update({
  key: "groceries",
  assets: ["C:/Users/me/Pictures/apples.jpg"],
  ops: [{ op: "insert", path: "todos", value: { id: "t9", text: "Apples", done: false, description: "", col: 0,
    images: [{ id: "i1", name: "apples.jpg", data: "asset:apples.jpg" }] } }]
})
```

Every file must be referenced and every `asset:<name>` needs a file, or the write is refused. The built-in Todo list keeps images per item as `images: [{ id, name, data }]` and shows one inline in the description with `![alt](#img-<image id>)`. `page_action` get (and a `page_state` path to one card or item) attaches those images so you can see them; a whole-board read does not.

## Previewing files

Never build a lightbox or document viewer into a page: `scribe.preview` opens Scribe's own viewer over the window, for images, PDFs, video and audio, Markdown, CSV/TSV (as a table), HTML (sandboxed, no scripts), JSON, and text or code. Other types get a download button. Arrow keys step through several files.

```js
thumb.addEventListener("click", () => scribe.preview(card.image, { name: "photo.png" }));  // an asset id or /blob/ url
input.addEventListener("change", () => scribe.preview([...input.files]));                 // Blobs or Files
scribe.preview(images.map((i) => ({ src: i.data, name: i.name })), { index: 2 });          // a gallery, opened at the third
```

- Takes a Blob or File, an asset id, a URL the page can fetch, `{ src | blob, name?, mimeType? }`, or an array of these. Resolves `{ ok }` or `{ ok: false, error }`.
- Like `scribe.open`, it only works inside a click or key press (else `{ ok: false, error: "no_gesture" }`): call it first in the handler.

## scribe.reply in your own markup

A form for a Kanban card (`replyTo` on `page_show`; Forms for a card in `SKILL.md`) can send its answers from your own markup instead of `<form data-reply>`: the submit button calls `scribe.reply` with the answers and a one-line summary.

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

- `scribe.reply` needs a click and saves pending edits first. It goes only where `replyTo` points, which is kept with the page, not its HTML, so page code cannot send anywhere else. Resolves `{ ok, target, delivered }` or `{ ok: false, error }`: show the result on the form.
- On a Kanban board the reply becomes the user's comment on the card (summary, answers: short ones as a list, long ones quoted, and a peek link to the form) and goes to the card's chat: into its running turn, or Continue when it is idle (the board claims the card for it and moves it to working). The agent gets the answers with the card, without reading the form's state.
- On any other page it logs a `reply` event (`data`: `{ from, card?, summary, data }`) for `page_wait`.
- Each click sends again and adds a comment. Name fields to read well as labels (`approach`, `notes`); empty values are skipped.
- `page_patch` with `replyTo` (no edits) wires an existing page; `replyTo: null` clears it.

## Waiting for user input

`page_wait` is one blocking call: the page logs a **named event** when the thing you care about happens, and you wait for that name. Typing, `scribe.set` and `scribe.bind` never wake you. Optional `where` matches fields of the event's `data` as text, e.g. `{ column: "grok issues" }` on a Kanban `card_ready`. In a Scribe chat, use `page_ask` on the page instead (same events; your turn counts as waiting for the user).

Handshake:

1. Pick a short event name (`submitted`, `chosen`, `all_done`, `approved`).
2. The page logs it when the condition is met: `data-scribe-signal="submitted"` or `scribe.signal("submitted", data)`. Put ids in `data` (which item, which choice), not whole records.
3. `page_show` the page.
4. `page_wait` with the same `key` and `events: "submitted"`. Without `after` only new events count, right after showing the page. If you read the page first, pass `page_state`'s `eventCursor` as `after` so an event in between is not missed.

The result is `{ events: [{ seq, name, data, at, by }], cursor }`, oldest first, without state: read what you need with `page_state` and a `path`, or a page action. `scribe.signal` sends the edits made before it in the same request, so that read sees them.

Never signal on every keystroke, bind or `onChange`, and never wait for `stateRevision` to change.

### After the wait

- `events` non-empty: handle each (branch on `name`), and pass the returned `cursor` as `after` next time so nothing is missed or seen twice.
- `timedOut: true`: tell the user you are still waiting, then wait again with the **same** `after`.
- `closed: true`: the tab was closed (the page is still in the Library); `page_open` it if you still need the answer, or stop.
- `deleted: true`: the page was deleted; stop.
- `missed: true`: more events than the log keeps (500); read the state instead.

The default timeout is 2 hours, with no maximum; keep it unless you have a reason not to (the user can interrupt you). Never poll `page_state` in a loop.

### Patterns

Use `type="button"` and **either** `data-scribe-signal` **or** `scribe.signal` for one click, not both.

```html
<!-- Submit (bound fields are already in state) → page_wait({ key, events: "submitted" }) -->
<button type="button" data-scribe-signal="submitted">Submit</button>

<!-- Outcomes → page_wait({ key, events: "approved,rejected" }), then branch on events[0].name -->
<button type="button" data-scribe-signal="approved">Approve</button>
<button type="button" data-scribe-signal="rejected">Reject</button>

<!-- A choice in the event's data → events[0].data.choice -->
<button type="button" onclick="pick('a')">Option A</button>
<script>
function pick(id) {
  scribe.set({ choice: id });
  scribe.signal("chosen", { choice: id });
}
</script>
```

Signal from the condition, not from each change: all todos checked, or a keyboard shortcut.

```js
function toggle(id, done) {
  scribe.update([{ op: "merge", path: `todos/${id}`, value: { done } }]);
  render();
  const todos = scribe.state.todos;
  if (todos.length && todos.every((t) => t.done)) scribe.signal("all_done");
}
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;  // Ctrl/Cmd+Enter
  event.preventDefault();
  scribe.signal("submitted");
});
```
