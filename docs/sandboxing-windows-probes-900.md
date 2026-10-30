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
| Codex MXC | Probed. Works here without setup. |
| Codex unelevated | Probed. Scribe's current default. |
| Codex elevated | Not probed: its setup UAC prompt was cancelled (`ShellExecuteExW … 1223`). Needs the user. |
| srt-win | Not probed: `windows-install` needs one UAC prompt. `initialize()` refuses until then ("Sandbox user is not provisioned"). |
| Claude under srt | Not probed: needs srt-win. The probe (`claude` case) is ready. |

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
`local-token`, any sandboxed Codex command can call the Scribe daemon's API as the user today.

### Elevated

Not reached: running a command with `windows.sandbox = "elevated"` in a scratch `CODEX_HOME` launches the
setup helper through UAC; the prompt was cancelled, and Codex reported
`orchestrator_helper_launch_canceled: ShellExecuteExW failed to launch setup helper: 1223`.
`CreateRestrictedToken failed: 87` is a third-party report (see the #891 investigation); it is not in
this machine's Codex logs and not in OpenAI's docs. Given MXC, elevated matters only for machines without
MXC (Windows 10, older 11 builds).

## srt-win (from the package and `srt-win status`; behaviour not yet run)

- `windows-install` (one UAC prompt) creates the local user `srt-sandbox` (random password,
  DPAPI-encrypted in `HKLM\SOFTWARE\sandbox-runtime`), the group `sandbox-runtime-users`, and a
  machine-wide WFP filter set keyed on that user's SID (allow loopback to the proxy port range
  60080–60089, block everything else). Then, unelevated, it grants the sandbox group read on the user's
  profile except credential stores (minutes on a big profile; `--skip-profile-grant` skips it).
- Undo: `npx @anthropic-ai/sandbox-runtime windows-uninstall` (one UAC prompt) removes the filters, the
  account and its profile, the group, the kept write grants, the profile grant and the registry key.
  `%ProgramData%\sandbox-runtime` and `%LOCALAPPDATA%\sandbox-runtime` stay; delete by hand.
- Writes: a write-restricted token, so only `allowWrite` roots, the sandbox user's profile and
  Everyone-writable places. Write grants on project folders are **kept between sessions** (ACEs on every
  file; any sandboxed session can then read those folders).
- **Loopback is all-or-nothing and machine-wide**: `--allow-loopback` at install opens every loopback port
  to every sandboxed process; without it, nothing but srt's own proxies. Scribe's MCP bridge (a
  `node dist/index.js` child of `claude`) talks to the daemon on `127.0.0.1:4747`, so Claude under srt needs
  `--allow-loopback`, which also opens the daemon's whole API (and Keeper, dev servers…) to sandboxed code.
  The design's "never loopback except Scribe's MCP endpoint" is not expressible with srt-win.
- Schannel clients (System32 `curl.exe`, `Invoke-WebRequest`, WinHTTP tools, git with
  `http.sslBackend=schannel`) cannot do TLS under the restricted token; no workaround. Node, Python, Git
  for Windows (srt forces its OpenSSL backend) work through the proxy.
- Per-user tools: without the profile grant the sandbox user cannot open nvm's Node
  (`%LOCALAPPDATA%\nvm`, this machine's Node), so Scribe must add the Node and tool folders to `allowRead`
  (the probe does) or take the profile grant.
- Data folder: Scribe's worktrees live under `%LOCALAPPDATA%\scribe\worktrees`, inside the data folder the
  design denies. A deny on the whole folder would hide the workspace; deny the specific files and
  folders (`local-token`, `agent-secret`, `*.sqlite`, `agent\claude-accounts\<others>`) instead. This
  applies to Codex profiles too.

## Claude under srt (design, not yet run)

The `claude` probe wraps the SDK's spawn in `spawnClaudeCodeProcess` → `wrapWithSandboxArgv` (PowerShell
shell, the CLI and its args single-quoted) and checks the `init` message (login source, MCP server
status) and a Bash tool call. Expected needs, to confirm:

- `allowWrite` the account's `CLAUDE_CONFIG_DIR` (transcripts, credentials refresh).
- `allowRead` the Claude binary, Node, the main checkout (`dist/index.js` for the MCP bridge).
- `allowedDomains` for `api.anthropic.com`, `claude.ai` and the OAuth refresh host.
- `--allow-loopback` for the MCP bridge (above), and `local-token` readable for the bridge, which the
  deny list forbids. Alternative: give Claude Scribe's MCP as an HTTP server with the token in a header
  set by the host, so nothing in the sandbox reads `local-token`.

## Recommendation (so far)

1. **Codex: MXC first.** Bump `@openai/codex` to ≥ 0.166 and send a permission profile
   (`default_permissions` + `permissions.scribe`: `:workspace`, the git common dir as a workspace root,
   network from the Web setting, deny entries for Scribe's secrets) instead of
   `sandbox`/`sandbox_workspace_write`. Fall back to `elevated` when set up, then `unelevated` (and show
   "network not enforced, reads not protected" for it in the effective view). Probe MXC with the
   documented `echo MXC_OK` check at startup and cache the result.
2. **srt-win stays experimental**, as decided. Beyond Schannel, its loopback model blocks Scribe's MCP
   unless the whole machine's sandboxed processes get all of loopback. Decide once srt-win has been run.
3. **Fix now, independent of engines:** sandboxed commands can read `local-token` and reach the daemon
   (#916).

## Settings setup row (proposal)

"Windows sandbox" row in Settings → Agents:

- Status line from one probe per engine: `MXC: available` (Codex `echo MXC_OK`), `Codex elevated: set up /
  not set up`, `srt-win: installed (loopback on/off) / not installed` (`srt-win status`).
- Buttons: **Set up** (runs the elevated step; shows "Windows will ask for administrator permission"),
  **Verify** (reruns the probes and `verifyWindowsWfpEgress`), **Remove** (the uninstall, one UAC prompt).
- The experimental srt-win switch sits under it, disabled until installed.
