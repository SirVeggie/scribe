# IntelliJ integration investigation (#22)

Investigated 2026-10-13. The launcher integration was implemented on 2026-10-22: Settings → Integrations has an IntelliJ toggle and optional launcher path; file diffs offer Open diff and Open in IntelliJ. Clicking a diff line selects the file-opening caret position. Comparisons export full Git snapshot blobs, including renamed, added, deleted and binary files, and retain temporary exports for a week. Non-Git historical comparisons report that snapshots are unavailable; files that exist can still be opened. No custom plugin was needed.

Validation uses `npm run test:intellij` (snapshot exports, a fake launcher, HTTP routes and browser UI) and `npm run build`. No installed IntelliJ instance was exercised. The sections below preserve the investigation and design rationale.

## Conclusion

Use IntelliJ's command-line launcher for the first version. It supports both opening a file at a line/column and displaying a two-file diff. A custom plugin is feasible but unnecessary for those basic operations.

## Supported interfaces

| Interface | Capability | Fit for Scribe |
|---|---|---|
| Command-line launcher | Open files at a line/column; compare two or three files | Recommended initial integration |
| Bundled MCP server (2025.2+) | External clients can call IDE tools, including `open_file_in_editor` | Useful for agent tooling; documented open-file parameters do not include a line/column, and the tool list does not document a show-diff operation |
| IDE Remote Control plugin | JetBrains support says the historical `/api/file/` HTTP endpoint moved into this plugin | Optional dependency; do not assume stock IntelliJ exposes this endpoint |
| Custom IntelliJ Platform plugin | Navigate to files; construct diff requests with content and labels | Suitable for a richer, project-aware integration later |

JetBrains documents these Windows launcher forms:

```powershell
& 'C:\path\to\IntelliJ IDEA\bin\idea64.exe' --line 42 --column 5 'C:\project\src\Example.java'
& 'C:\path\to\IntelliJ IDEA\bin\idea64.exe' diff 'C:\temp\before\Example.java' 'C:\temp\after\Example.java'
```

The macOS launcher uses `idea`, and Linux uses `idea.sh`. File opening may use LightEdit if the file does not belong to an already-open project. The documented diff syntax has no line-selection option: file navigation and opening a diff should be separate actions. [Open files](https://www.jetbrains.com/help/idea/opening-files-from-command-line.html), [compare files](https://www.jetbrains.com/help/idea/command-line-differences-viewer.html).

The MCP server must be enabled under Settings → Tools → MCP Server; manual client configuration supports SSE, stdio and HTTP streaming. Its `open_file_in_editor` takes `filePath` and `projectPath`. It is an actual API option, but adds connection setup without supplying the documented diff capability needed here. [MCP server](https://www.jetbrains.com/help/idea/mcp-server.html).

The old localhost HTTP file-opening endpoint is plugin-dependent according to [JetBrains support](https://intellij-support.jetbrains.com/hc/en-us/community/posts/12555740233618-Open-file-with-Build-in-Server-always-shows-404-File-not-found?sort_by=votes). Its current compatibility and authentication were not verified in an IDE.

## Proposed Scribe implementation

1. Add an opt-in setting and a launcher executable path. Provide explicit “Open in IntelliJ” and “Compare in IntelliJ” actions for the selected file; retain the built-in viewer.
2. Resolve the diff on the backend using the same source as the visible viewer. `public/agent.js:2054` handles turn, thread and Git views. `AgentHost.changes()` in `src/agent/host.ts` returns repository/from/to trees for recorded Git snapshots; `src/agent/routes.ts:646` returns the base and working snapshot for Git/branch views.
3. Read both complete versions through `fileAtTree()` in `src/agent/git.ts:159`, respecting rename paths. Write them to a unique temporary directory with `before` and `after` subdirectories and original extensions. Use an empty file for a missing side in additions/deletions. Do not reconstruct whole files from displayed patches, which can be truncated.
4. Launch the configured executable from the backend with an argument array and no shell interpolation. Validate the selected file against the authorized repository/worktree. Report missing launchers and spawn errors in the UI.
5. Keep temporary contents available after launcher exit: exit need not mean the IDE closed the diff. Clean old exports with a bounded retention policy. Do not depend on `--wait` for cleanup without testing the exact launcher; JetBrains tracks [diff/wait launcher issues](https://youtrack.jetbrains.com/projects/IJPL/issues/IJPL-35434/idea-diff-command-does-not-recognize-wait-argument).

Historical comparisons should use two exported snapshots so later edits do not change the result. Opening an editable file should resolve the actual thread worktree path. If snapshots are unavailable (for example, a non-Git tool diff), offer file opening when possible and explain that full historical comparison is unavailable. Remote/WSL path mapping and binary fidelity require separate handling; the existing `fileAtTree()` returns text.

## When a plugin would help

A Kotlin plugin could accept authenticated local requests containing project, file, position and before/after content. It could use `OpenFileDescriptor` for navigation and `DiffManager.showDiff()` with `SimpleDiffRequest`/`DiffContentFactory` for labeled comparisons, including empty sides. This would allow explicit project selection and avoid CLI temporary-file lifecycle constraints. [Navigation implementation](https://github.com/JetBrains/intellij-community/blob/master/platform/platform-impl/src/com/intellij/platform/PlatformProjectOpenProcessor.kt), [DiffManager API](https://github.com/JetBrains/intellij-community/blob/master/platform/diff-api/src/com/intellij/diff/DiffManager.java), [SimpleDiffRequest API](https://github.com/JetBrains/intellij-community/blob/master/platform/diff-api/src/com/intellij/diff/requests/SimpleDiffRequest.java).

That bridge would need loopback binding, a pairing token, project/path validation, UI-thread dispatch, and a tested IDE compatibility range. These are proposed implementation details, not a verified plugin prototype.

## Verification for implementation

Exercise paths with spaces and Unicode, an already-open project, a closed IDE, worktree paths, historical turns after later edits, additions/deletions/renames, missing snapshots, binary files and launch failures. Verify that exported contents match the selected snapshots and stay available while the diff is open. For richer plugin requirements, first build a small navigation/diff proof of concept against the intended IntelliJ version.
