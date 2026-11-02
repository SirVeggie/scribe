# App updates and releases (#942)

## Kinds of install

`src/updates/updates.ts` decides from the folder the daemon runs from (`INSTALL_ROOT`):

| Install | How it is recognized | How it updates |
|---|---|---|
| Git checkout | a `.git` folder | `git fetch`; when the branch is behind its upstream and has no commits of its own and no changes in tracked files: `git merge --ff-only`, `npm install` if package.json or the lockfile changed, `npm run build`, restart. A failed build goes back to the previous commit (`git reset --keep`) and builds that again. When `desktop/` changed, the notice says to run `npm run desktop:install`. |
| Windows release | `install.json` `{ kind: "standalone", target: "windows-x64-desktop" }` in the app folder (`desktop/release.mjs` writes it) | downloads the installer named in the release manifest, checks its SHA-256, and runs it detached with `/S /UPDATE` (plus `/R` when the desktop app is open, which starts it again). The installer stops the daemon (`desktop/nsis-hooks.nsh`) and the app; without the app open, the script starts the daemon afterwards. |
| Linux headless release | `install.json` with `target: "linux-x64-headless"` (`tools/release-linux.mjs`) | downloads and checks the archive, unpacks it beside the app folder, swaps the two folders, restarts. |
| Anything else | neither | does not update itself. |

The release manifest is `https://github.com/SirVeggie/scribe/releases/latest/download/latest.json` unless `SCRIBE_UPDATE_URL` or `updateUrl` in `install.json` names another; asset URLs in it are relative to it, so a release folder can be served from any web server as is.

## Modes

Settings → Updates → Install updates (`updates.json` in the data folder):

- **Automatically**: checks two minutes after start and every six hours, downloads a release ahead, and installs once no chat has a turn running and no window has had input for 15 minutes (windows report key, click and scroll at most every 30 s in `viewer_state.activeAt`).
- **Ask first** (default): the same checks; a notice offers **Update**, **Skip version** (remembered) and **Dismiss** (until the daemon restarts or a newer update appears).
- **Don't check**: no checks of its own; Settings → Updates → Check now still works.

Only the user can install, skip or change the mode (`/api/updates`), from this device, a paired device or a signed-in web session (#946); agents read it only.

## Restarting

After installing, the daemon restarts itself: under systemd (`scribe service install`) it exits with code 75 and the unit's `Restart=on-failure` starts the new build; elsewhere it starts `dist/index.js --restart-after <pid>` from the new build, which waits for the old daemon to exit and starts the new one. Chats whose turn was cut off resume (`resumeInterrupted`). Open windows reload once they reconnect, so they load the new UI.

## Releases

`npm run release -- <version> [--notes <file>]` bumps the version everywhere, builds `release/<version>/` (Windows installer, Linux archive, `install-linux.sh`, `latest.json`, notes), commits `Release v<version>` and tags it. `npm run release -- --publish-only <version>` pushes and creates the GitHub release with `gh`. The `release` skill (`.claude/skills/release`) walks an agent through it.

The Linux archive is built on Windows too: modules come from `npm ci --os=linux --cpu=x64`, Node from nodejs.org (checked against `SHASUMS256.txt`), and the archive is written by a small tar writer so file modes are right. A fresh Linux machine installs it with:

```sh
curl -fsSL https://github.com/SirVeggie/scribe/releases/latest/download/install-linux.sh | sh
```

## Not covered yet

- A Linux desktop app release (Tauri needs a Linux build host).
- Signatures beyond the manifest's SHA-256 over HTTPS.
