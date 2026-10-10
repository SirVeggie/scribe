# Cross-drive worktree builds (#331)

Investigated 10 October 2026. Documentation and a read-only path probe only; no Scribe implementation changes.

## Finding and evidence limits

The reported C: worktree / S: node_modules layout triggers an identifiable Windows path-classification problem in inspected SvelteKit SSR entry generation. The probe reproduces the exact rejected name shape; same-drive and isolated layouts select the fallback entry instead. This supports the diagnosis, but does not certify an end-to-end build fix.

The existing evidence page (`scribe:llm-chat-worktree-build-limitation`) and #331's two comments report three build failures after 228–229 module transformations, including one outside the sandbox. They identify Vite 8.1.3 / Rolldown and this substitution:

```text
./entries/pages/S_/Library/Projects/llm-chat/node_modules/@sveltejs/kit/src/runtime/components/svelte-5/error.svelte
```

No new LLM Chat build was run. Its installed package source was denied by this thread's read scope; that denial was not bypassed. This Scribe repository uses TypeScript rather than Vite/SvelteKit, so its build cannot validate the affected toolchain. The inspected upstream version is SvelteKit 2.55.0, not a verified match for LLM Chat's lockfile. Full attribution still needs exact installed versions and a controlled build matrix.

## Mechanism

Scribe's `src/agent/worktree.ts` puts new worktrees under `dataDir()/worktrees` (lines 20–22, 114–123). It defaults to sharing node_modules and creates Windows junctions to the checkout (lines 16, 62–86). That combination permits different-drive runtime paths.

[SvelteKit 2.55.0 SSR entry generation](https://github.com/sveltejs/kit/blob/%40sveltejs%2Fkit%402.55.0/packages/kit/src/exports/vite/index.js#L789-L800) computes a component path relative to the route directory. It selects the fallback branch only when that result starts with `..`. On Windows, different drives produce an absolute path instead. The path goes through the page branch; joining it introduces a leading `./`. [Rolldown's sanitizer](https://github.com/rolldown/rolldown/blob/main/crates/rolldown_utils/src/sanitize_filename.rs) replaces the embedded colon with `_`, matching the observed name. Rolldown then rejects the relative-path substitution in the reported failure.

SvelteKit's [runtime location](https://github.com/sveltejs/kit/blob/%40sveltejs%2Fkit%402.55.0/packages/kit/src/core/utils.js#L14) comes from its module URL. [Vite's preserveSymlinks option](https://vite.dev/config/shared-options.html#resolve-preservesymlinks) changes Vite file identity, but alone is not proven to change that runtime URL. It should be an experiment, not an automatic Scribe config rewrite.

## Reproduce the path classification

```powershell
node docs/cross-drive-worktree-path-probe.mjs
```

The probe uses `path.win32`, synthetic filenames, and no dependency packages. It reads/writes no external checkout and can run on any OS.

| Layout | Windows relative result | Classified entry |
| --- | --- | --- |
| C: worktree, S: shared dependency | Absolute S: path | `./entries/pages/S_/Library/.../error.svelte` |
| C: worktree, C: shared dependency | Starts with `..` | `entries/fallbacks/error.svelte` |
| C: worktree, C: local dependency | Starts with `..` | `entries/fallbacks/error.svelte` |

## Options for a follow-up

| Option | Benefit | Cost / remaining validation |
| --- | --- | --- |
| Worktree near checkout on its drive | Retains dependency sharing; avoids this cross-drive path | Requires writable storage, exclusions, sandbox roots, discovery and cleanup outside the existing central directory |
| Isolated dependencies per worktree | Avoids this shared-dependency path and package mutation between branches | Disk space, install time, lockfile/package-manager handling, install failures; must skip shared-dependency sync |
| Project-specific toolchain fix | Could fix the upstream classifier directly | Verify exact SvelteKit version and build first; avoid generic config rewrites |

Recommended next step: validate isolated dependencies on the affected app, then design an explicit isolation choice in Scribe if it passes. Same-drive placement remains a candidate; neither option has a full build pass from this investigation.

For an existing Windows worktree, inspect node_modules with `Get-Item` and confirm it is the junction before removing only that link using `cmd /c rmdir node_modules` (no `/s`). Then install from the worktree lockfile with `npm ci`. Never run install against the shared link and never recursively remove a Scribe worktree. This is an npm-specific procedure; a product feature must respect the project's package manager. No link was removed or install performed here.

## Acceptance for implementation

Pin the affected app commit and package versions. Build it in the main checkout, a cross-drive shared worktree, a same-drive shared worktree, and a cross-drive worktree with local dependencies. Use the same lockfile in all four; inspect resolved runtime paths. Test preserveSymlinks separately if needed. Confirm the main node_modules is intact, installations stay local, and worktree reopen/removal/merge behavior remains safe. Record any unrelated baseline failures separately.

## Follow-up after the user's choice

The user selected isolated-dependency validation followed by an isolation design.
The minimal fixture in `docs/fixtures/worktree-build` now builds successfully
with local dependencies (Vite 8.1.3 / SvelteKit 2.55.0). Its README records the
locked versions, runtime path checks and output. This validates a local control,
not the affected app's commit and lockfile.

`docs/worktree-dependency-isolation-design.md` records the proposed setting and
lifecycle behavior. A fresh LLM Chat package read remained outside this thread's
read scope, so the affected-app test needs its own workspace. No Scribe production
code changed. The card remains in Needs input until that validation can run.
