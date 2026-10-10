# Worktree dependency isolation: proposed design (#331)

The user selected isolated-dependency validation followed by an isolation design.
This is a proposal only; #331 still excludes Scribe implementation.

## Validation status

The committed `docs/fixtures/worktree-build` control passes SSR/client compilation
with its own local dependencies. Its lockfile pins Vite 8.1.3 and SvelteKit 2.55.0;
the default error entry emits at `entries/fallbacks/error.svelte.js`.
See the fixture README for versions, checks, commands and limitations.

The affected LLM Chat app remains unvalidated: a fresh MCP read of
`S:/Library/Projects/llm-chat/package.json` was denied by this thread's workspace
scope. Shell access was not used to bypass it. Continue the affected-app test in
a thread whose workspace is LLM Chat (or provide a workspace-scoped copy of that
commit and lockfile). Broad machine access is unnecessary.

## Proposed behavior

Expose an explicit worktree dependency choice: **Shared** (current behavior)
and **Local** (independent node_modules). Keep Shared as the compatibility default.
Store the preference by repository, with a per-thread override. Snapshot the
effective choice in the worktree record so a fork or reopened thread preserves it.
Board workers and page-started agents must use the same choice; otherwise the
workaround works in interactive chats but fails in unattended board runs.

Local means Scribe creates the git worktree without linking any node_modules
directory, including nested entries from configured symlinkDirectories. Other
configured links remain subject to existing behavior. Do not copy the main
node_modules: a copy may preserve links and stale branch dependency versions.
No package installation is implied by selecting Local. Scribe tells the agent
that dependencies are local and need preparation using the project's package
manager; the agent installs as part of its authorized task. This keeps worktree
creation fast and separates checkout creation errors from package install errors.

For the first implementation, expose isolation independently of installer support.
The tested npm path uses the committed lockfile and `npm ci`; other package
managers use their own locked install commands. Multiple lockfiles, monorepo
roots, workspace package links, and pnpm stores need explicit validation before
claiming isolation supports them. A node_modules directory inside the worktree
does not by itself guarantee every resolved dependency stays on that drive.

## Lifecycle integration

| Area | Required change |
| --- | --- |
| Settings and API | Carry shared/local through draft, persisted thread, workspace preference, worker defaults, page-agent start, and warm/prepared sessions. Reject a mode change on an open worktree; apply it to the next worktree. |
| `ThreadWorktree` | Add effective dependency mode. Old records default to shared; distinguish configured mode from actual linked paths. |
| `createWorktree` / `addWorktree` | Filter node_modules links in local mode; skip main-checkout `syncDependencies` during creation. |
| `reopenWorktree` | Preserve local mode whether the old folder is reused or a replacement folder is needed. Reinstall from the current branch's lockfile after reopening. |
| `threadInstructions` | Derive dependency instructions from effective mode and actual links. Shared gets link-safe install rules; Local gets local install rules. |
| Fork / warm sessions | Sharing an existing worktree shares its mode. A new worktree uses the snapshotted preference; preparation cache keys include mode. |
| Merge | Local build dependencies are discarded with the worktree. Main-checkout dependency sync after merging a lockfile change remains separate: do not remove `host.finishWorktree`'s existing sync merely because the source worktree was local. |
| Cleanup | Unlink actual junctions before removal in all modes. Delete local dependencies only within the verified worktree target. Never infer that local mode guarantees absence of links. |

Current integration points were re-read after the prior merge: worktree.ts
creates/reopens worktrees and links folders; host.ts prepares worktrees and syncs
main dependencies after merge; prompt.ts emits shared dependency rules; prefs.ts
persists workspace worktree preferences; public/agent.js passes useWorktree to
drafts, warm sessions and page agents. Audit all callers when implementing.

Existing open worktrees retain their current layout. A future conversion action
would need to stop every thread sharing the worktree, verify and cut only the
node_modules link, and invalidate provider sessions as needed. Exclude live
conversion from the first version; do not silently switch layouts.

## Acceptance before shipping

1. In LLM Chat's workspace, record commit and package/lock versions. Reproduce
   its shared cross-drive build, then detach only the verified node_modules
   junction, install from that same lockfile locally, and repeat the build.
   Verify resolved runtime paths and preserve main-checkout dependencies.
2. Add meaningful lifecycle tests for default sharing, local link filtering,
   nested links, reopen/fork consistency, mode-specific prompts and merge sync.
3. Verify npm installs stay local and install failures leave the branch and
   worktree recoverable. Confirm cleanup removes links before recursive removal.
4. Validate board worker and page-started runs, settings persistence, and older
   saved thread records. Apply the ui-help-text skill when implementing UI copy.

The local fixture pass supports this proposal. The LLM Chat build result remains
the gate for calling it a verified workaround for the reported app.
