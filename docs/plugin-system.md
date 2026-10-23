# Page plugins

Plugins are local, user-approved Node packages. Installing one runs its code as the current user. Declared folders and hosts inform consent; they are not a Node sandbox. Pages use plugins through daemon-gated methods, including ordinary pages that were not created from a plugin template.

## Package and backend contract

`plugin.json` declares `id`, `name`, semver `version`, a short `summary`, optional `author`, `risky`, `access: {files, network}`, a backend entry, settings, methods and templates. Backend code exports `{methods, templates, start?}`. Dependencies must be bundled into the package. Package paths are relative; links, path traversal and oversized archives are refused.

`methods[name](args, ctx)` receives public settings, `secret(name)`, `dataDir`, `db()` (a private SQLite database), keyed `state.get/set`, `emit`, `saveAsset`, and the caller. Secrets are encrypted with Windows DPAPI and never appear in public settings or exports. Shared state is keyed JSON in SQLite with per-key revisions; pages write it only through methods.

Source lives in `plugins/<id>/source` with Git history. Installation creates an immutable content-addressed version; edits do not change running code. Reload validates source and bumps a changed package's patch version. Installing/reloading runnable code requires consent except for Full agents. No package installation scripts execute.

The child starts lazily, stops after ten idle minutes, bounds pending calls, times out hung calls and tracks repeated crashes. Keep-running is an explicit user setting. Backends receive a minimal environment, excluding Scribe credentials and provider keys.

## Permissions

Each plugin adds `plugin.<id>` to page permissions. The default is Ask, or Allow for a page bound to that plugin's template. A manifest's `risky` flag determines whether an agent rewriting a page resets access to Ask. HTML dependencies use `<meta name="scribe-plugins" content="git-history">`; metadata never grants access.

Agent-callable methods declare `agent: "read" | "board" | "ask"`. Read methods work on every rung, Board methods require Board or higher. Ask methods run on Full or inherit Allow from the thread's page. A page's Deny refuses Ask methods. Otherwise the user chooses Allow, Allow for this thread, or Deny, including on Auto. These answers never change page permissions.

Plugin authoring tools work on Board and higher; Read-only chats can inspect source, guides and logs. Catalog instructions include enabled plugin IDs and short summaries; full guides and method signatures are loaded on demand.

## Chat components

Manifests can declare `components: { name: {description, html, props, height: {min,max}, methods, state, events} }`. `html` is a package-relative file (at most 256 KiB); heights are 64–1200 pixels. `props` is an object JSON Schema. Supported keywords are type, properties, required, additionalProperties, items, enum, const, numeric bounds/multipleOf, string length/pattern, array length, anyOf/allOf/oneOf, title and description. Unsupported keywords are rejected during package validation. Methods must be agent-callable. State declarations are exact keys or prefixes ending in `/*`; events are exact names.

Only `component_show({plugin,component,props,title?,wait?,fallback?})` creates a chat item. Props are checked before insertion and on each render. The history stores identity and props, and renders the installed version now; disabled, missing or incompatible plugins display fallback markdown with a reason. First-render diagnostics return capped problems; the bounded background probe cannot execute methods.

Components receive deep-frozen `scribe.props`, `scribe.plugin.call(method,args)` (returns the method result directly), `scribe.plugin.state.get(key)` (returns `{value,revision}`), `state.on(key,(value,revision)=>...)`, and `scribe.plugin.on(event,fn)`. Listeners return unsubscribe functions. State is shared and live; writes go through declared methods. Subscriptions close on lazy unmount, reread on remount, and are checked against current permissions. Calls use the thread rung, plugin grants and home-page permission; Deny wins. An idle thread cannot prompt for missing consent. Components have no network, raw state writes or page API. The shared component reply/local/summary APIs work as for agent HTML.

Git history 1.2.0 includes an `activity` heatmap component. Existing bundled plugin installs are preserved when Scribe updates; receiving the new example currently requires a reviewed package update. Fresh installs receive it automatically.

## Components on pages

Pages embed the same components with `<scribe-component id="activity" plugin="git-history" name="activity" props='{"repository":"/approved/repo","weeks":52}'></scribe-component>`. Props are JSON checked against the installed component schema. Invalid tags show an inline error and participate in first-render diagnostics. The tag also declares a plugin dependency; metadata never grants access. Optional child content is the fallback for unavailable components and exported pages.

Each mount uses its own opaque sandboxed origin and the chat component bridge, with no network or page API. Calls, declared state and declared events use the host page's `plugin.<id>` permission. Ask requests the page permission; Deny wins. The page can read the same shared state through `scribe.plugin(id).state`. Removing a tag closes its port and live subscription. Plugin updates and permission changes recheck live mounts; denied or unavailable components show an inline error.

Frames mount within 900px of the viewport and release their subscriptions when scrolled away, retaining their last height and `scribe.local` state for remounting. A focused frame stays mounted until focus leaves it. Offscreen tags still receive schema validation for first-render diagnostics. Captures mount offscreen frames as well. There are at most 64 active instances across all viewers of one page, a separate 64 for its captures, and 500 across all pages; exceeding a limit shows an inline error without evicting an active instance. After freeing capacity, scroll the affected tag back into view or reload to retry. Browser heartbeats renew 90-second mount leases; abandoned mounts are reclaimed on the next allocation. Frozen viewers silently remount reclaimed instances when they resume.

A clicked component's reply dispatches a cancelable, bubbling `scribe-component-reply` event on the tag (`detail: {data,summary}`). Unless handled with `preventDefault()`, it goes to the page's `replyTo`, or a `submitted` page signal when there is no target. Components with an `id` save `scribe.local` in the host page's viewer state; other mounts keep it in memory. `setSummary` has no effect on pages. Component tags in card descriptions and comments are not supported.

## Template actions

Templates have normal metadata and HTML files plus declared actions and hooks. Backend template sets provide actions, seed, reply, replyDelivered, sweep, drive and launch callbacks. Calls run outside the daemon. A state-changing result applies only to the revision it read; a concurrent edit retries the computation up to three times. Hooks must be safe to compute repeatedly. Side effects belong in explicit methods or in post-commit lifecycle callbacks, not speculative action computation.

Built-in actions retain their synchronous path. Plugin workers run without a page window, under the page's existing agent permissions. Only one periodic plugin action loop per page runs at a time.

## Transfer and updates

`.scribeplugin` is a ZIP package. Page exports are ZIPs while imports remain compatible with legacy JSON. Each dependency can include Code, Source, Settings, State and Data; Code and Source are selected initially. Secrets never travel. Omitted plugins remain recorded as page requirements. Updates show changed capabilities and author changes, preserve locally edited source, and offer Keep mine, Take theirs or Merge with an agent.

The first bundled example is Git history, with an approved repository setting initialized from known workspaces. Pages may request consent to add another repository. Jira plugin/page authoring on another PC is a first-delivery use case, so secrets, source tools, state, transfer and template lifecycle support are included together.
