# Testing pages

Builds on `SKILL.md` in this folder (showing and patching pages, theme, page kit): read that first if you have not.

## Visual feedback (project designs only)

`page_screenshot` is for **designs that belong to the current project** — a mock, layout, or component the user asked you to design or ship. It is not a proofreader for information pages.

Do **not** screenshot investigation results, analyses, architecture notes, ticket dumps, checklists, walkthroughs, or any other throwaway information page. Show (or patch) those once. The user can see them. Polishing their spacing or type wastes tokens.

When it **is** project design work:

1. `page_show` with the same `key`, `background: true` (so a new page stays in the Library and does not steal focus).
2. `page_screenshot` with that `key`. Default is a 1280×800 viewport of the page.
3. Inspect the image. For a small markup change, `page_patch` with `background: true`. For a larger rewrite, `page_show` again with `background: true`. Then screenshot again.

```
page_show({ key: "hero", title: "Hero", html, background: true })
page_screenshot({ key: "hero" })
page_screenshot({ key: "hero", selector: ".hero" })   // one component
page_screenshot({ key: "hero", fullPage: true })      // tall page; height is capped
page_screenshot({ key: "hero", local: { view: "expanded" } })  // capture-only scribe.local
page_screenshot({ key: "hero", fromViewer: true })             // user's last local
page_screenshot({ key: "hero", click: "[data-view=idle]" })    // click, then capture
```

Rules:

- Always `background: true` on `page_show` / `page_patch` in this loop unless the user should look at the tab right now.
- Identify the tab by the same `key` (or `id`) you used in `page_show`.
- `selector` is a CSS selector; it captures the first match. If it is missing or not visible, the tool errors — fix the markup or selector, do not retry blindly.
- `local` is seeded into `scribe.local` for this capture only; it is not saved as a viewer. Overlay it on `fromViewer` when both are set. Prefer `local` over patching the page's default to check another view.
- `fromViewer` uses the most recently written viewer local, not the live window's scroll, hover, or size.
- `click` clicks a selector after load. Capture boots ignore shared state writes (`set`, `update`), actions, signals, and asset writes. Local view changes still work; prefer `local` when the view lives in `scribe.local`.
- Embed-template pages are captured at the embedded URL, not the placeholder HTML.
- After `page_update` or `page_patch`, screenshot again without re-showing the full HTML. The capture loads current HTML + state from the daemon.
- The image is a canonical viewport, not the user's window size, zoom, or currently focused tab. Inactive / hidden tabs still screenshot correctly.
- Do not pin design-test pages. Do not write the HTML to a workspace file.
- If `page_screenshot` is missing, the Scribe MCP is on an old build — tell the user to reload MCP after rebuilding the daemon.

When you are done iterating and the user should see the result, `page_show` or `page_patch` once more **without** `background` so the tab comes to the front.

## Testing interactions

To click, drag, type, or run a script in a page, open its `viewUrl` (returned by `page_show`, `page_patch`, and `page_read`) directly in a browser. There, the page runs on its own with a live `window.scribe`.

In a Scribe chat thread you have your own browser: the `browser_*` tools (other MCP clients don't get them; use your host's browser tool there). It runs headless, so it never takes the user's focus; the user can watch it live and click or type into it from your chat. It has your thread's own cookies and storage, kept between turns and closed when the thread is archived. It opens loopback addresses (`localhost`, `127.x.x.x`, `*.localhost`) and Scribe pages only, so start dev servers with Keeper first.

```
browser_open({ key: "scribe:hero" })            // a Scribe page's viewUrl; or { url: "localhost:5173" }
// → { tab: "b1", url, title } and a snapshot:  - button "Add one" [ref=e3]
browser_act({ action: "click", ref: "e3" })      // also fill, type, press, select, check, scroll, drag, back, reload
browser_act({ action: "fill", ref: "e5", value: "Ada" })
browser_act({ action: "drag", ref: "e3", to: { ref: "e8" } })  // interpolated pointer travel (default 10 steps)
browser_console({ level: "error" })              // check before you call it done
browser_network({ failedOnly: true })
browser_screenshot({})                           // or { ref }, { selector }, { fullPage: true }
browser_viewport({ width: 390, height: 844, colorScheme: "dark" })
browser_eval({ script: "document.title" })       // inspect only; act with browser_act
browser_eval({ script: "scribe.state", frame: "scribe:hero" })  // inside the page's frame in the Scribe shell
browser_tabs({ closeAll: true })                 // when you are done testing
```

- Act on refs from the **latest** snapshot. `browser_act` returns a fresh one and the console errors the action caused; pass `snapshot: false` to skip it.
- `selector` or `text` work as targets when a ref is not handy. Pass `selector` to `browser_snapshot` to read one region of a large page.

- Writes and signals from that page go to the **real page**. Do not test destructive interactions on a page the user relies on (their todo list). Show a copy under a temp key with `background: true`, test its `viewUrl`, then delete it with `page_close({ key, permanent: true })`.
- Looking without changing anything (snapshot, reading the DOM, a script that only reads) is fine on the real page.
- Loaded directly, the page does not receive live updates from `page_update` or other viewers, and links to other pages show no titles, and `scribe.agent` has no options. Reload it to see updates. To check live behaviour (state arriving from elsewhere, link titles, flicker or scroll jumps as it re-renders, agent buttons), open the Scribe shell itself with the page in front (`browser_open({ url: "<Scribe address>/#<page id>" })`) and pass `frame: "<page key or id>"` to `browser_snapshot`, `browser_act`, `browser_screenshot`, and `browser_eval`: the page's iframe is on another origin, so without `frame` a `selector`, `text`, or script only reaches the shell. With `frame`, the snapshot is the page's alone and the screenshot is its iframe; refs from any snapshot (`f1e2` for an element in a frame) work with or without it. `frame` also takes a CSS selector of any iframe.
- This is for testing behavior. For a picture of the layout, `page_screenshot` is still the tool.
