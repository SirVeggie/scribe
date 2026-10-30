# Windows sandbox probes (#900)

Step 3 of `docs/sandboxing-design-891.md`. Probes only, no product change. Machine: Windows 11 Pro
10.0.26200.9711, Node 25.2.1 (nvm, under the user profile), Codex 0.164.0 (repo) and 0.166.0 (scratch),
`@anthropic-ai/sandbox-runtime` 0.0.81 (scratch install, not a repo dependency).

Reproduce with `tools/probe-windows-sandbox.ts` (usage in its header). It runs one command matrix
(writes in and outside the workspace, the worktree's git dir, a `node_modules` junction, a planted secret,
Scribe's `local-token`, Node fetch, Schannel `curl.exe`, `Invoke-WebRequest`, git over HTTPS, the daemon
on loopback) under each engine and prints one JSON line per probe. Secrets print only a byte count.

`example.com` does not resolve on this machine (local DNS), so the probes use `registry.npmjs.org`.

## Status

| Engine | State |
|---|---|
| Codex MXC | Probed. Works here without setup. **Recommended.** |
| Codex unelevated | Probed. Scribe's current default; network-off and reads are not enforced (#916). |
| Codex elevated | Skipped (user's choice): its setup UAC prompt was cancelled once (`ShellExecuteExW … 1223`), and MXC covers this machine. |
| srt-win | Probed after `windows-install --allow-loopback --skip-profile-grant` (left installed). |
| Claude under srt | Probed. Login, Scribe MCP and the Bash tool work, but only with two workarounds (stdin relay, env relay). |

## Codex

### MXC (new in Codex: recommended on Windows 11 24H2/25H2)

Codex now has three Windows implementations: `mxc`, `elevated`, `unelevated`. OpenAI's docs call
`elevated` and `unelevated` legacy. MXC is process isolation (an AppContainer-style process container)
with no admin setup, no extra accounts and no firewall rules. Codex's own log on this machine already
says `MXC availability: true`.

Compatibility check (documented): `codex -c windows.sandbox=mxc sandbox --include-managed-config
--permission-profile :workspace -- cmd.exe /d /c echo MXC_OK` printed `MXC_OK`, exit 0.

With the built-in `:workspace` profile:

| Probe | Result |
|---|---|
| write cwd / outside | allowed / Access is denied |
| `%TEMP%` | redirected to the container's own temp (`…\Packages\sandbox.{…}\AC\Temp`) |
| worktree git dir (`S:\…\agent-board\.git`) | **denied** (`update-ref` cannot lock) |
| `node_modules` junction, nvm Node, git status | work |
| reads (planted secret, `local-token`, `~/.codex/auth.json`) | readable (no deny configured) |
| network (Node, git, Schannel curl, `Invoke-WebRequest`, loopback) | all blocked, DNS included |

With a Scribe-shaped permission profile (`extends = ":workspace"`, the git common dir as a workspace root,
deny entries for the secret and `local-token`, network on or off):

| Probe | network off | network on |
|---|---|---|
| worktree git dir | writable | writable |
| denied secret / `local-token` | `ENOENT` (hidden) | `ENOENT` |
| Node fetch / git HTTPS / **Schannel curl** | blocked | 200 / works / **200** |
| daemon on loopback (4747) | `EACCES` | **200** |

So under MXC Schannel works (unlike srt-win), deny-read works, and the git dir works once it is a
workspace root. With network on, loopback is open (the docs say managed networking needs
`allow_local_binding`), so a sandboxed command can reach the Scribe daemon.

Through the app server (what Scribe uses), `thread/start` with
`config: { "windows.sandbox": "mxc", default_permissions: "scribe", permissions: { scribe: {...} } }`:

- **Codex 0.164.0 fails** every MXC profile: `failed to load AGENTS.md instructions … MXC launcher: The
  supplied process.env … is missing the required variable(s): SYSTEMROOT`. Setting
  `shell_environment_policy` or an empty cwd does not help.
- **Codex 0.166.0 works**: returns `workspaceWrite` with `writableRoots: [<git common dir>]` and the
  requested `networkAccess`.
- Sending `sandbox: "workspace-write"` alongside the profile (what `threadOptions` does today) silently
  wins: `writableRoots: []`, the profile is dropped. Profiles and `sandbox_mode`/`sandbox_workspace_write`
  must not be mixed.

### Unelevated (Scribe's current setting)

`windows.sandbox = "unelevated"`, `sandbox_mode = workspace-write`, the git dir in `writable_roots`,
`network_access = false`:

| Probe | Result |
|---|---|
| write cwd / outside / `%TEMP%` | allowed / denied / allowed (the user's real temp) |
| worktree git dir | writable (Scribe's `writable_roots` fix works) |
| junction, Node, git status | work |
| reads (secret, `local-token`, `~/.codex/auth.json`) | **all readable**; unelevated has no deny-read |
| Schannel curl, git HTTPS, `Invoke-WebRequest` | blocked (proxy env points at a dead `127.0.0.1` port; IWR "Access is denied") |
| **Node fetch to a public host** | **200**: Node's fetch ignores the proxy variables, and unelevated has no firewall fence |
| **daemon on loopback** | **200** |

"Network off" under unelevated stops only clients that honour proxy variables. Together with the readable
`local-token`, any sandboxed Codex command can call the Scribe daemon's API as the user today (#916).

### Elevated

Skipped by the user's choice. A first attempt (a command with `windows.sandbox = "elevated"` in a scratch
`CODEX_HOME`) launched the setup helper through UAC; the prompt was cancelled and Codex reported
`orchestrator_helper_launch_canceled: ShellExecuteExW failed to launch setup helper: 1223`.
`CreateRestrictedToken failed: 87` is a third-party report (see the #891 investigation); it is not in
this machine's Codex logs and not in OpenAI's docs. Given MXC, elevated matters only for machines without
MXC (Windows 10, older 11 builds).

## srt-win

### Install and undo

`npx @anthropic-ai/sandbox-runtime windows-install --allow-loopback --skip-profile-grant` (one UAC prompt,
exit 0, about a minute):

- creates the local user `srt-sandbox` (hidden from the logon screen, member of `Users`; random password,
  DPAPI-encrypted in `HKLM\SOFTWARE\sandbox-runtime`) and the group `sandbox-runtime-users`;
- installs a machine-wide WFP filter set keyed on that user's SID: loopback to srt's proxy ports
  (60080–60089) allowed, all other direct connects blocked; with `--allow-loopback` every loopback port
  but port 1 is allowed too;
- without `--skip-profile-grant` it would also grant the sandbox group read on the whole user profile
  except credential stores (minutes on a big profile). Skipped: Scribe grants what it needs per session.

Undo: `npx @anthropic-ai/sandbox-runtime windows-uninstall` (one UAC prompt) removes the filters, the account
and its profile, the group, the kept write grants, the profile grant and the registry key.
`%ProgramData%\sandbox-runtime` and `%LOCALAPPDATA%\sandbox-runtime` stay; delete by hand. Kept write grants
alone: `srt-win acl forget --all` (no prompt).

`verifyWindowsWfpEgress` (`srt-win wfp verify`) after install: direct egress blocked under the plain,
low-integrity and untrusted-integrity tokens, open loopback connects, no residuals reported.

### Behaviour (`srt` case, worktree as cwd, loopback open)

| Probe | Result |
|---|---|
| whoami | `carrotbox\srt-sandbox` |
| write cwd / outside / `%TEMP%` | allowed / denied / allowed (the sandbox user's own temp) |
| git status, worktree git dir (`update-ref`) | work (git dir as an `allowWrite` root) |
| read planted secret / `local-token` (`denyRead`) | **denied** |
| read `~/.gitconfig` (not granted) | denied: without the profile grant nothing in the profile is readable |
| Node in nvm (`%LOCALAPPDATA%\nvm`) | "not recognized" unless its folder is in `allowRead` |
| **Node script in the worktree** | **fails**: `EPERM: lstat 'C:\Users\veggie\AppData'` (problem 2) |
| Node fetch, workspace outside the profile | allowed host 200, other host refused by the proxy, daemon on loopback 200 |
| git over HTTPS | works (srt forces Git for Windows onto OpenSSL) |
| System32 `curl.exe` | `SEC_E_NO_CREDENTIALS` (Schannel, as documented) |
| `Invoke-WebRequest` | "forbidden by its access permissions": it ignores the proxy variables, so the WFP fence blocks it before TLS |

### Problems found

1. **srt-win.exe must be readable by the sandbox user.** The packaged binary of a package installed in
   the user profile (here `%LOCALAPPDATA%\Temp\…\node_modules`) fails every session start with
   `CreateProcessWithLogonW(srt-sandbox): Access is denied`, although seclogon runs. A copy in
   `C:\ProgramData\…` works (`windows.srtWin.path`, the probe's `--srt-win`). Scribe's own install must sit
   outside the profile, or Scribe copies the exe out.
2. **Scribe's worktrees live under the user profile** (`%LOCALAPPDATA%\scribe\worktrees`). srt grants the
   worktree itself, not its parents, and Node resolves a script's real path by `lstat`ing every parent:
   `C:\Users\veggie\AppData` is not readable to `srt-sandbox`, so `node script.js` fails. Workarounds:
   `node --preserve-symlinks-main` (works, but every tool that resolves real paths hits the same wall), the
   profile read grant (opens the whole profile), or worktrees outside the profile. The same applies to
   Scribe's Claude account folders.
3. **First grants are slow, and write grants leak reads.** A grant writes an ACE on every file below the
   root: granting nvm's folder (with global npm packages) took several minutes. Write grants are kept
   between sessions, and **a kept root is readable by every later sandboxed session**, whatever its own
   lists say. Granting a Claude account folder for writing therefore exposes its credentials to all
   sandboxed commands until `srt-win acl forget`. (The probe's grants were removed afterwards.)
4. **No stdin.** `srt-win exec` does not pass a piped or file stdin to the sandboxed process (0.0.81;
   confirmed with `srt-win exec -- findstr x`). The Claude CLI takes the SDK's stream-json input on stdin,
   so it exits at once. The same goes for anything else that reads stdin.
5. **The caller's environment is dropped.** The child gets the sandbox user's environment plus `PATH`,
   `PATHEXT`, srt's proxy and git variables and `setEnvVars`. `CLAUDE_CONFIG_DIR`, `SCRIBE_*` and the
   SDK's own variables are lost unless passed explicitly.
6. **Loopback is all-or-nothing and machine-wide.** `--allow-loopback` is an install-time mode for every
   sandboxed process on the machine; a session asking for the other mode does not start. Scribe's MCP
   bridge needs the daemon on 127.0.0.1, so it needs the open mode, which also exposes Keeper, dev servers
   and the daemon's whole API to sandboxed commands. "Never loopback except Scribe's MCP endpoint" is not
   expressible.
7. **Host-side quoting.** With srt's `cmd` shell the command line is cmd's (8191 characters, msvcrt
   quoting). Its `powershell` shell (Windows PowerShell 5.1) drops embedded double quotes from native
   arguments and does not forward stdin. A product wrapper should use `cmd` and msvcrt-quote each argument.
   srt's proxies run in the host process: a sync spawn of a sandboxed command deadlocks its network calls.
8. Running sandboxed processes belong to `srt-sandbox`: the user's own `taskkill` gets "Access is denied".
   srt-win ends them when the session's parent process exits (`--held-by`), which worked.

## Claude under srt

`tools/probe-windows-sandbox.ts claude --stdin-relay --loopback --srt-win <copy> --config-dir <account>`
runs the SDK's `query()` with `spawnClaudeCodeProcess` → `wrapWithSandboxArgv(cmd)`. Allowed: write to the
worktree, its git dir and the account folder; read the main checkout (CLI binary, `dist/index.js` for the MCP
bridge) and nvm's Node; hosts `api.anthropic.com`, `*.anthropic.com`, `claude.ai`, `*.claude.ai`.

| Step | Result |
|---|---|
| Plain wrapper | CLI exits 0 with no output: no stdin (problem 4) |
| + stdin relay (Node inside the sandbox reads the SDK's input from a loopback socket) | starts; `Not logged in`: `CLAUDE_CONFIG_DIR` dropped (problem 5) |
| + env relay (the relay sets the SDK's extra variables) | **works**: `init` with the Scribe MCP server `connected`, Bash tool output `srt-sandbox` / `SANDBOX_BASH_OK`, a `mcp__scribe__page_list` call answered |

So login from a Scribe account folder, MCP to the daemon and the Bash tool all work under srt-win, but only
through a relay that needs open loopback and an account folder kept writable (and so readable to every
sandboxed session), and the worktree's Node scripts fail unless run with `--preserve-symlinks-main`.
`local-token` was denied and the MCP bridge still answered: it gets the daemon port from the MCP config's
`env`, which the CLI sets for its own child.

## Recommendation

1. **Codex: MXC first** (user's choice). Done in #916: `src/agent/codexMxc.ts` (the profiles `scribe-read`,
   `scribe-write`, `scribe-web` and `:danger-full-access`, selected per turn by `permissions`). Bump `@openai/codex` to ≥ 0.166 and send a permission profile
   (`default_permissions` + `permissions.scribe`: `:workspace`, the git common dir as a workspace root,
   network from the Web setting, deny entries for Scribe's secrets) instead of
   `sandbox`/`sandbox_workspace_write`. Fall back to `elevated` when set up, then `unelevated`, and show
   "network and reads not enforced" for it in the effective view. Detect MXC with the documented
   `echo MXC_OK` check and cache it.
2. **srt-win: experimental, off by default, and not yet for Claude.** For one-shot commands (Native bash,
   the host shell) it is solid: writes, deny-read, the network fence and git all behave. Before Claude can
   run under it, upstream needs stdin forwarding and an environment passthrough (or Scribe ships the
   relay), and Scribe needs worktrees outside the profile or an answer to the parent-`lstat` problem. Run it
   only with `--skip-profile-grant`, `srt-win.exe` outside the profile, and the loopback mode as an
   explicit, machine-wide choice in the setup row. Never keep a write grant on an account folder.
3. **Fix independent of engines:** sandboxed commands can read `local-token` and reach the daemon (#916).

## Settings setup row (proposal)

"Windows sandbox" row in Settings → Agents:

- Status line from one probe per engine: `MXC: available` (Codex `echo MXC_OK`), `Codex elevated: set up /
  not set up`, `srt-win: installed (loopback on/off) / not installed` (`srt-win status`).
- Buttons: **Set up** (runs the elevated step; shows "Windows will ask for administrator permission"),
  **Verify** (reruns the probes and `verifyWindowsWfpEgress`), **Remove** (the uninstall, one UAC prompt).
- The experimental srt-win switch sits under it, disabled until installed. The loopback mode is chosen in
  the Set up dialog (it is machine-wide) and shown in the status line.
- Verify also checks that `srt-win.exe` is readable by the sandbox user and that no account folder carries
  a kept grant.
