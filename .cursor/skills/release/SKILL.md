---
name: release
description: Make and publish a Scribe release (Windows installer, headless Linux archive, update manifest) with npm run release. Use when the user asks to create, cut, build or publish a release or a new version of Scribe.
---

# Making a Scribe release

<!-- Same file in .claude/skills (Claude), .cursor/skills (Cursor) and .agents/skills (Native): change all three together. -->

Installed copies of Scribe update themselves from the latest GitHub release (src/updates, docs/updates.md). A release is the version bump commit, its tag `v<version>`, and a GitHub release holding:

- `Scribe_<version>_x64-setup.exe`: the Windows desktop app with the daemon, its modules and Node;
- `scribe-<version>-linux-x64.tar.gz`: the headless Linux build;
- `install-linux.sh`: installs the Linux build and its systemd service;
- `latest.json`: the manifest installed copies check (version, notes, each file's SHA-256).

## Steps

1. **Where and what.** Work in the main checkout on `master` (not an agent worktree: its `node_modules` is a link, and the tag belongs on master). The tree must be clean and up to date with `origin/master` (`git status`, `git fetch`, `git log origin/master..master` / `master..origin/master`). Read the current version from `package.json`.
2. **Version.** Use the version the user gave. Otherwise propose one (semver: patch for fixes only, minor for features, major for breaking changes) and confirm it.
3. **Notes.** Draft release notes from `git log --no-merges <last tag>..HEAD` (`git tag --list "v*" --sort=-v:refname` gives the last tag; with none, summarize recent work). Group them under a few headings, in plain words for users, and leave out internal churn. Write them to `release/notes-<version>.md` and show them to the user.
4. **Help guide.** `npx tsx tools/help-review.ts` lists the commits since `public/help/guide.md` (what the Help agent knows, #962) last changed. Update the guide for anything a user could ask about: new or renamed settings, shortcuts, menus and features, and drop what is gone. Commit it before the build.
5. **Build.** `npm run release -- <version> --notes release/notes-<version>.md`. It bumps the version (package.json, package-lock.json, desktop/tauri.conf.json, desktop/Cargo.toml and Cargo.lock), builds the Windows installer (Rust toolchain, a few minutes) and the Linux archive (downloads modules for linux-x64 from npm and Node from nodejs.org), writes `release/<version>/`, then commits `Release v<version>` and tags it. If a build fails it puts the old version back; fix the cause and run it again. `--skip-windows` / `--skip-linux` leave one out (only when the user agrees: copies on that platform then see the release but cannot install it).
6. **Check.** List `release/<version>/` and the sizes; `latest.json` must name every built file.
7. **Publish only with the user's go-ahead.** Publishing pushes master and the tag, and makes the release public: every installed copy offers it, or installs it on its own in automatic mode. Ask first, then `npm run release -- --publish-only <version>` (needs `gh` signed in). Report the release URL.

## If something goes wrong

- Built but not published, and the build is bad: `git tag -d v<version>` and `git reset --hard HEAD~1` remove the local release commit (only if nothing was pushed). Then build again.
- Published by mistake: say so to the user. Deleting the GitHub release (`gh release delete v<version>`) stops new update checks from finding it, but copies that already updated keep it; the fix is a newer release.
- A different update server: installed copies read `SCRIBE_UPDATE_URL` (or `updateUrl` in the app folder's `install.json`). Upload the contents of `release/<version>/` to a folder there and point `latest.json` at it; asset URLs in it are relative.
