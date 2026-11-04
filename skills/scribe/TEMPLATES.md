# Scribe templates

Read this file only when the user asked you to create, edit, delete, or open a **Scribe template**. Do not create templates unprompted. Builds on `SKILL.md` in this folder (showing and patching pages, theme, page kit) and, for template scripts, `PAGE-SCRIPTS.md`: read those first if you have not.

A template is reusable page HTML plus a form. The user opens instances from the Templates sidebar. Updating the template re-renders every linked page with that page's own form values.

## Tools

| Tool | Purpose |
| --- | --- |
| `template_upsert` | Create or replace a template (`key`, `title`, `html`, `fields`, optional `description`, `titleTemplate`, `initialState`, `stateVersion`, `guide`, `agentActions`, `pin`) |
| `template_list` | Names and field schemas (no HTML) |
| `template_get` | Full HTML and fields |
| `template_delete` | Remove the template. Existing pages stay, keep last HTML, and become ordinary pages |
| `template_open` | Open an instance with `values`. Prefer letting the user do this in the UI |

Reuse the same `key` when updating that template.

## Built-in templates

Some templates ship with the app (Embed, Kanban board, Markdown note, Todo list). `template_list` returns them under `builtins` with ids like `builtin:todo-list`. They are read-only: `template_upsert` and `template_delete` refuse them.

Opening a built-in (from the sidebar or `template_open`) copies it into the user's templates first, once, and the page binds to that copy. On startup, an app update refreshes the copy (and its pages) only if the copy is unedited and the built-in's `stateVersion` is unchanged. Otherwise the copy is left alone and flagged `builtinUpdate: true` in `template_list` (the sidebar shows an orange marker). To bring it up to date, compare it with the built-in (`template_get`), merge the changes into the copy while keeping the user's edits, and upsert it with `syncedWithBuiltin: true` to clear the flag. Migrate page state if `stateVersion` changed. `localId` on a built-in is the id of its copy, and the copy's `builtinSource` names the built-in.

If the user wants a changed version of a built-in, `template_get` it and upsert under a new key, or update their copy by `localId` if they want that copy changed.

## Authoring

1. Decide the form with the user, or pick a small set: e.g. Title, item name singular/plural, column count.
2. Write HTML as you would for `page_show`. Use `{{fieldKey}}` where the value should appear in markup (HTML-escaped). In scripts, read `scribe.template.values.fieldKey`.
3. Use `scribe.state` for live data (todos, notes). Put starting data in `initialState`. Items that point at other Scribe pages can keep the page's key in state and render `<a data-scribe-open="scribe:key">` (see Linking pages in the skill).
4. Set `titleTemplate` if the tab title should include a field, e.g. `{{title}}`. A template with no fields opens straight away, with no form and no edit button, under the template's own title. With no `title` field and no `titleTemplate`, the title belongs to the page: a rename survives template updates, and the page can show `scribe.title` and let the user edit it with `scribe.setTitle` (the built-in Markdown note does).
5. Field `type`: `text`, `textarea`, `number`, `select`, `checkbox`. Select needs `options`. Keys must be JS identifiers. `maxLength` caps text/textarea values (default 500 / 4000, up to 65536); `help`, `placeholder`, `default`, `min`, `max` and `required` work as their names say.
6. If an agent will read or change the page's state, write a `guide`: markdown with the state shape, the events the page logs and their data, and the rules for editing (which keys to leave alone, how to add an item). Give array items stable `id`s so agents can address them by path, and keep per-viewer things (filters, drafts, the open item) in `scribe.local`. Tool results hand it to any agent the first time it touches a page from the template, so nothing about the template needs to go in this skill. Keep it under a page; `templates/builtin/todo-list.guide.md` is a good model. (Actions, like the Kanban board's, ship only with built-in templates for now.) Upserting without `guide` keeps the current one.
7. If the user wants one-click agent prompts on these pages, add `agentActions`: `{ id, label, prompt, where?, selection?, context?, run?, thread? }`. Scribe offers them in the page's right-click menu, the Ctrl+P palette while the page is open, and the chat's slash menu (`/<id>`, with any text after it as `{{input}}`). The prompt can use `{{selection}}`, `{{input}}`, `{{page.title}}`, `{{page.key}}`, and `{{#selection}}…{{/selection}}` for text that only shows when there is a selection. For what the user right-clicked (a card, an item), declare `context: ["card"]` and use `{{card}}`: the page marks elements with `data-scribe-context='{"card":"#12 Fix login"}'` (Scribe's right-click menu reads the nearest ones under the cursor), or, when the page draws its own menu, lists `scribe.agent.actions()` and calls `scribe.agent.runAction(id, { context: { card } })`. Such an action shows only in a right-click menu where all its context names are supplied, never in the palette or slash menu. By default an action starts a new thread on the page (`thread`: `mode` board or ask, `provider`, `model`, `effort`, `fast`, `web`, `title`); without `provider` or a non-`default` `model`, Scribe uses the same fixed economical defaults as a Kanban worker (not the user's last chat model). `run: "chat"` sends it in the chat at hand instead. Upserting without `agentActions` keeps the current ones. `templates/builtin/*.json` have examples.
8. Decide whether its pages open pinned. App-like templates the user keeps and returns to (a board, a tracker, a dashboard) pin their pages, which is the default. For page-like templates the user makes many of (a note, a document), pass `pin: false` so those pages close with Clear like ordinary pages (the built-in Markdown note does). The user can still pin one by hand. Upserting without `pin` keeps the current setting.

Do not pin the template itself. The user opens pages from the sidebar.

## Updating a template

`template_upsert` with the same `key` replaces HTML and fields, then re-renders every linked page.

If the **page data shape** changed (new required `scribe.state` keys, different list format):

1. Bump `stateVersion` (integer, start at 1).
2. Linked pages show an overlay and cannot be used until you fix each page.
3. `page_state` / `page_update` still work. After the data is valid, call `page_update` with your ops and `resolveIncompatibility: true`.

If you only change layout or copy and existing data still works, leave `stateVersion` alone.

A page can call `scribe.reportIncompatible(reason)` if it detects bad data itself.

## Bound pages

`page_list` / `page_read` include `templateId` when a page is linked.

- **Do not** `page_show` or `page_patch` HTML on that page. The tools refuse it.
- You **may** change title (`page_patch` with `title` only), pin, and state.
- To change structure, update the template.

Exports (`.scribe.json`) carry the template with its pages, so an imported page stays bound. Import reuses an identical local template instead of duplicating it.

## Example: todo template

Fields: `title` (text, required), `item` (text, default `task`), `items` (text, default `tasks`), `columns` (number, 1–4, default 3).

HTML uses `{{title}}` in the heading and `scribe.template.values.columns` when laying out columns. `initialState` is `{ todos: [] }`. `titleTemplate` is `{{title}}`.
