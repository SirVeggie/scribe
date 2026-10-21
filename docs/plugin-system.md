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

## Template actions

Templates have normal metadata and HTML files plus declared actions and hooks. Backend template sets provide actions, seed, reply, replyDelivered, sweep, drive and launch callbacks. Calls run outside the daemon. A state-changing result applies only to the revision it read; a concurrent edit retries the computation up to three times. Hooks must be safe to compute repeatedly. Side effects belong in explicit methods or in post-commit lifecycle callbacks, not speculative action computation.

Built-in actions retain their synchronous path. Plugin workers run without a page window, under the page's existing agent permissions. Only one periodic plugin action loop per page runs at a time.

## Transfer and updates

`.scribeplugin` is a ZIP package. Page exports are ZIPs while imports remain compatible with legacy JSON. Each dependency can include Code, Source, Settings, State and Data; Code and Source are selected initially. Secrets never travel. Omitted plugins remain recorded as page requirements. Updates show changed capabilities and author changes, preserve locally edited source, and offer Keep mine, Take theirs or Merge with an agent.

The first bundled example is Git history, with an approved repository setting initialized from known workspaces. Pages may request consent to add another repository. Jira plugin/page authoring on another PC is a first-delivery use case, so secrets, source tools, state, transfer and template lifecycle support are included together.
