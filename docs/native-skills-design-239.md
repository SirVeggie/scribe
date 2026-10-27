# Native in-app skills — #239
Updated 2026-10-27 against 6618ef5 (previous version: 2026-10-11, 15f9f13). Design final (all questions answered 2026-10-27). v1 (build order 1–5) implemented in #850: `src/agent/scribeSkills.ts`, routes `/scribe-skills*`, MCP `skill_read`, thread `skills` picks, worker `skills` picks.

## Decisions (from the user, 2026-10)
- Storage: skill folders on disk plus database metadata.
- Delivery: one shared catalog over Scribe's MCP server first; native provider adapters later.
- Scope in v1: global skills plus picks per thread and per worker. Workspace assignments later.
- External (provider/project) skills: read-only from the Scribe-skill side, with Copy to Scribe.
- Scribe's own skill: a versioned, read-only built-in that can be copied for customizing.
- The harness keeps editing provider and workspace skills in place; Scribe skills just never write into those folders.
- A new Scribe skill is off until enabled globally or picked for a thread or worker.
- The built-in scribe skill is in every chat's list by default and can be switched off; it replaces the prompt's "scribe skill when available, else scribe_docs" line.

## What changed since the 11 Oct snapshot
The app now has much of the groundwork, so this plan builds on it instead of adding a second skill manager.
- **Agent harness page (#456, #495)** has a Skills tab (`public/harness.js` renderSkills, openSkill, newSkill, copySkill). It lists skills from every provider folder (`skillFolders`, `discoverSkills` in `src/agent/harness.ts`), shows each skill's index token cost and Claude's Skill-tool use counts, and can create, edit, copy between folders and remove (moved to `dataDir/agent/removed-skills`). Backend: `src/agent/harnessFiles.ts`, routes `/harness/skills*`.
- **Scoped file reads (a8c1c80)**: the scribe MCP `read_file` / `list_files` / `grep_files` read the thread's provider skill folders even outside the workspace (`src/agent/readFile.ts` readRoots), and every prompt says so (`src/agent/prompt.ts`). Pages threads without a workspace still get no file reads.
- **No-tools threads (#729)**: Claude runs with `settingSources: []` and no tools, so no skills at all.
- **Codex** runs with Scribe's own CODEX_HOME; `dataDir/agent/codex/skills` is the folder it reads. `skill_search`, plugins and hooks are switched off.
- **Native (Pi)** reads `dataDir/agent/pi/agent/skills` plus workspace `.agents/skills` and `.pi/skills`; its skills appear as `/skill:name` in the composer.
- **Claude SDK 0.3.310** still has `plugins: [{ type: "local", path }]` and `skills: string[] | 'all'`. Pi still has `additionalSkillPaths`, `skillsOverride`, `noSkills`. Cursor still has only `dirs` (which also loads rules), so it stays MCP-only.
- The scribe skill lives in this repo at `.cursor/skills/scribe` (`SKILL_DIR` in `src/skillDocs.ts`) and is served by `scribe_docs`. Users get it as a provider skill only if they installed it themselves.

## Design

### Where it lives in the UI
Extend the harness page's Skills tab rather than adding an Agent settings section. Add a **Scribe** source next to the provider folders:
- Rows show source (Scribe, Built-in, or the provider folder), enabled-globally switch, and which providers/modes get it.
- Scribe skills: New, Edit (existing file editor), Duplicate, Import folder, Export folder, Remove (to trash, restorable).
- Built-in (scribe): view only, plus Copy to Scribe.
- Provider and workspace skills gain **Copy to Scribe** in the existing Copy to… menu.

### Storage
- `dataDir/skills/<id>/SKILL.md` plus supporting files. `<id>` is a stable generated id, not the name, so renames do not break picks.
- Database table: id, name, description (cached from frontmatter), enabled (global), provenance (new / copied from path / imported), revision, created/updated. Frontmatter stays the source of truth for name and description; the table refreshes from it on save and on startup scan.
- Built-in entries are virtual rows pointing at `SKILL_DIR`; they are never written.

### Selection
- One resolver `effectiveSkills(thread)` = enabled global skills + the thread's picks + (for worker chats) the worker's picks. Used by the prompt index, the MCP tools, the harness view and the composer.
- Thread picks: stored on the thread; edited from a Skills chip in the composer settings row (same dropdown pattern as MCP servers).
- Worker picks: `settings.workers[id].skills: string[]` on the board, set in the worker dialog, copied to the thread like `customMode` in `src/actions/kanbanWorkers.ts`.
- No-tools threads get none. Missing or removed ids stay in saved picks and show as unavailable.

### Delivery (MCP first)
- Prompt index: one short block listing each effective skill's name and description, and "read it with skill_read before using it". Counted in the harness context view like other Scribe context.
- New scribe MCP tools: `skill_read(name, file?)` returns SKILL.md or a supporting file, limited to the thread's effective set and the skill's folder (traversal and symlink checks as in readFile.ts). A separate `skill_list` is not needed while the index is in the prompt.
- `skill_read` works in every mode, including Pages threads without a workspace where `read_file` is unavailable. Scripts in a skill still need Code mode and the thread's own approvals.
- Edits apply from the next turn; the index is rebuilt per turn.
- Composer: Scribe skills appear in the `/` menu next to provider commands; picking one sends the message with an instruction to read and follow that skill.

### Names
- A Scribe skill with the same name as a provider skill: the index labels it as Scribe's, and the harness view flags the clash. Native adapters later must namespace (Claude plugin skills are already plugin-prefixed).

### Later: native adapters
- Claude: a generated local plugin folder with the selected skills (`plugins` option); avoid the global `skills` allowlist, which would hide the user's own skills.
- Pi: `additionalSkillPaths` with the selected folders.
- Codex: materialize into the Scribe CODEX_HOME skills folder only after probing how the app-server picks up changes; keep MCP for it until then.
- Cursor: MCP only.

## Build order
1. Storage, table, scan, CRUD routes, trash/restore, import/export with containment checks.
2. Harness Skills tab: Scribe and Built-in sources, enable switch, Copy to Scribe.
3. Resolver, prompt index, `skill_read`, harness context accounting.
4. Thread picks (composer) and worker picks (board worker dialog).
5. Composer `/` entries.
6. Later: Claude plugin and Pi adapters, Codex probe.

## Evidence
- `src/agent/harness.ts:141–240` (skillFolders, discoverSkills), `:482–509` (what each provider loads).
- `src/agent/harnessFiles.ts:38–135`; `public/harness.js:825–1030`.
- `src/agent/readFile.ts:36–40`; `src/agent/prompt.ts:141`, `:163–166`.
- `src/agent/providers/claude.ts:827`, `:878`, `:898–906`; `codex.ts:519`, `:693–722`; `pi.ts:62–63`, `:518`; `cursor.ts:687`.
- `src/skillDocs.ts:12`; `src/actions/kanbanWorkers.ts:252–258`; `public/agent.js:6142`.
- SDK declarations: claude-agent-sdk 0.3.310 `sdk.d.ts:2073`, `:2339`, `:5852`; Pi `resource-loader.d.ts:76–90`; Cursor `options.d.ts:158–170`.
