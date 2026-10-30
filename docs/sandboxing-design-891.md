# Sandboxing design (#891)

Consolidates #75, #229, #283, #291 and #300. The full investigation, with the options compared, is the
Scribe page `scribe:sandbox-design-891`. This file records what was decided, for the cards that implement it.
The hidden warning triggers are a separate design (#893).

## Decisions (user, 2026-10-30)

| Question | Decision |
|---|---|
| Engine | Anthropic sandbox-runtime (`@anthropic-ai/sandbox-runtime`, `srt`) for every process Scribe spawns, plus each provider's own sandbox where it has one (Codex; Claude `options.sandbox` on Linux; Cursor `sandboxOptions`). Not OpenShell. |
| Reads outside the read roots | Ask, with "Allow this folder for this thread". A deny list (secrets, Scribe's data folder) stays unreadable even after a grant. |
| Network | Follows the thread's Web setting. Off: provider API hosts only. On: any public host. Never loopback (except Scribe's MCP endpoint) or private ranges. |
| Windows | Codex `elevated` when it is set up, else `unelevated`. srt-win for Native, the host shell and Claude, behind an "experimental" switch until its Schannel TLS problem is solved. No WSL by default. |
| Default profile | Standard, for chats and workers alike. Full access turns the sandbox off, as Codex does today. |
| Provider can't enforce the profile | Run, and show "not enforced" in the effective view and the worker preflight. |
| First work | Steps 1–3 below. |

## Why not OpenShell (as the default)

- Agents run in containers using API keys injected through its proxy. Claude subscriptions and the ChatGPT/Codex and Cursor logins aren't supported.
- The Cursor SDK agent and Native (Pi) run inside the Scribe daemon, so they can't move into a container.
- Network policy never allows host loopback, so Scribe's MCP server is unreachable. Its exec API is one-shot.
- Windows: WSL2 + Docker Desktop is experimental. Native MXC is branch-only and "not a production-qualified security boundary".

Ideas borrowed from it: per-binary network rules, audit-before-enforce, and agent-proposed rules that the user approves or rejects with a reason.

## Policy

`src/agent/access.ts` computes the policy for a thread. It is a pure function with no state of its own, and extends round 2's `AccessPolicy`:

- **Write roots:** cwd, temp, the worktree's git dir, write grants. Never the worktree links (`node_modules` in the main checkout).
- **Read roots:** cwd, the real targets of worktree links, the thread's attachments, the thread's own provider account folder, read and write grants. A read outside these asks.
- **Deny read** (beats every root and grant): Scribe's data folder (the local-token file, `scribe.sqlite`, the other accounts' folders, other threads' data), `~/.ssh`, cloud CLI credentials (`~/.aws`, `~/.azure`, `gcloud`), `gh`/npm tokens, browser profiles, password stores, plus the user's extra protected paths.
- **Network:** `{ allow: hosts, loopback: [the Scribe MCP port] }`, from the Web setting and web grants.
- `checkPath(policy, path, op)` resolves realpaths and junctions. One function is shared by every host-side check.
- `effective(thread, provider, os)` reports per surface whether a rule is enforced by the OS, by Scribe, by approval only, or not at all (#277).

### As built (#898)

- `policyFor(thread, env)` and `checkPath(policy, path, op)` in `src/agent/access.ts`. `checkPath` answers allow, ask or deny. The order: protected paths (with the thread's own exceptions) first, then the worktree's links (deny for writes), then the roots (ask outside them).
- Grants are the thread's existing `toolGrants` (#743), not a new `fileGrants` field: file and folder grants, read or write, already listed and revocable in the thread's Permissions menu (#216). Read and write grants are read roots; write grants are write roots.
- The temp folder is a write root only when the caller passes `env.tmp` (the OS sandbox, #899). Scribe's own gates leave it out, so a Native write there still asks.
- Exceptions inside Scribe's data folder: the thread's worktree (any workspace under `worktrees/`) or the scratch folder, its attachments, its page checkout, its own Claude account folder (not `.credentials.json`) and the skill folders. Other threads' page checkouts in the temp folder are protected too.
- Users add protected paths under Allowlists → Protected paths (`prefs.protectedPaths`).
- Used by `read_file`, `list_files`/`grep_files`, `page_open`'s file and Native's read, grep, find, ls, edit and write. A read outside the roots asks in the chat (`host.requestFileRead`) with "Allow reading <folder> for this thread"; with no turn running it is refused. A search asks only about its start folder; an allowed folder covers its walk.
- `effective(provider)` is a first table for #277.

## Enforcement

| Surface | Layer |
|---|---|
| Codex shell and edits | Codex's own sandbox: `writable_roots`, network, elevated/unelevated on Windows |
| Claude | Linux: SDK `options.sandbox`. Windows: the whole `claude` process under srt through `spawnClaudeCodeProcess` (experimental) |
| Native (Pi) bash | srt through Pi's `BashOperations` |
| Native read/edit/write, `read_file`, search, attachments | `checkPath` |
| Cursor | `sandboxOptions` where supported. Host shell: srt. Built-in file tools: not enforced |
| Stdio MCP servers that Scribe starts | srt, opt-out per server |

A blocked action shows one row in the chat ("Sandbox blocked: write to …"), with "Allow this folder for this thread" or "Allow host for this thread". The agent gets a short reason back. The same events feed #893.

## Steps

1. (#898) Policy core and Scribe data protection (`access.ts`, used by Pi's gate, `read_file`, search, attachments). File grants and the ask flow for reads.
2. (#899) srt on Linux: Pi `BashOperations`, the host shell, Claude `options.sandbox`, violation rows. Depends on 1.
3. (#900) Windows probes, with no product change: srt-win install and behaviour (PowerShell/TLS), the whole Claude CLI under srt, Codex elevated on this machine. The results decide the Windows rollout.
4. Windows rollout, the sandbox setup row in settings, and the effective view (#277).
5. Roadmap: remote isolated workers (#901), sandboxed MCP servers by default.
