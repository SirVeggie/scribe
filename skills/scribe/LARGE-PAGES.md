# Large pages

Builds on `SKILL.md` in this folder (showing and patching pages, theme, page kit): read that first if you have not.

## Large pages: read a window, grep, patch

`page_read` does not return a page over 24 KB whole. It returns the size, line count and an outline (headings, sections, script/style blocks with line numbers). Work on it like a file:

```
page_grep({ key: "todo-page", pattern: "renderList", context: 2 })
  → 412:function renderList(items) {  (with 2 lines either side)

page_read({ key: "todo-page", offset: 400, limit: 60 })
  → lines 400–459, numbered "412	function renderList(items) {"

page_patch({ key: "todo-page", edits: [{ oldString: "...", newString: "..." }], expectedRevision: 23 })
```

- Line numbers are a prefix (number, tab), not part of the HTML. Leave them out of `oldString`.
- `pattern` is a JavaScript regex; pass `literal: true` to search plain text.
- `full: true` returns the whole page anyway. Use it rarely: it costs the whole page in context.
- To rewrite a whole block you just read, replace its lines instead of copying it into `oldString`: `{ startLine: 412, endLine: 440, newString: "..." }`. `{ afterLine: 440, newString: "..." }` inserts new lines after line 440 (`afterLine: 0` at the top); an empty `newString` on a range deletes those lines. Line numbers count against the page as earlier edits in the same call left it, so list several line edits bottom to top, and always pass `expectedRevision` from the read you took the numbers from: a stale number edits the wrong lines, where a stale `oldString` only fails.
- This works in every mode and for every provider. It is the way to edit large pages in Pages mode, which has no file tools.

## Building a large page in parts

A new page too big to pass as inline `html`:

- **Code mode:** write the HTML to a temp file (not the workspace) and `page_show` with `htmlPath` instead of `html`. One call; title, state, assets, and background work as usual. Do not create a placeholder page and then `page_patch` it.
- **Pages mode** (no file tools): show the first part, then add the rest with `append` edits.

Each `{ append: true, newString }` lands just before the page's closing `</body>` (at the end of a page without one), so parts stay in order inside the body.

```
page_show({ key: "audit", title: "Audit", htmlPath: "<temp file>", background: true })

page_show({ key: "audit", title: "Audit", html: "<h1>Audit</h1><section id=\"part-1\">...</section>", background: true })
page_patch({ key: "audit", edits: [{ append: true, newString: "<section id=\"part-2\">...</section>" }], background: true })
page_patch({ key: "audit", edits: [{ append: true, newString: "<script>/* wire it up */</script>" }] })
```

Pages are stored with LF line endings (CRLF is converted when a page is saved), so numbered lines, grep lines and copied snippets always agree.

## Large rewrites with file tools: check out to a file

When you have file tools (Code mode) and are rewriting a big part of a large page, you can instead check it out, edit it with your normal file tools, and check it back in. Not in Pages mode: there are no file tools there, so the file cannot be edited.

```
page_read({ key: "todo-page", toFile: true })
  → { path: "C:/Users/me/AppData/Local/Temp/scribe/todo-page.html", revision: 23, ... }

// edit that path with your normal file tools

page_patch({ key: "todo-page", htmlPath: "<that path>", expectedRevision: 23, background: true })
```

- The checkout is a scratch copy in the system temp folder, not a workspace file. The tab stays the source of truth; the file is only for editing.
- Check-in replaces the whole HTML but keeps title, page state, and events (unlike `page_show`). `htmlPath` and `edits` are mutually exclusive. For a **new** large page, use `page_show` with `htmlPath`; `page_patch` does not create.
- Always pass the checkout's `revision` as `expectedRevision`. If it is refused, the page moved: check out again and redo your edits on the fresh copy.
- Template-bound pages cannot be checked out.
