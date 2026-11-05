# Chat access

[← Permissions overview](../permissions.md)

Every chat has an **access level** and a **Web** setting, shown in the bar under the message box. Together they decide what the agent may do on your machine. Which *pages* it may reach is a separate layer: [Page access for agents](page-access.md).

## The access ladder

Each rung allows everything the one below it does, plus more:

```text
 Read-only ──► Board ──► Edits ──► Auto review ──► Full access
 read files    + create   + edit files   + a classifier   + everything
 and pages     and change   in the        approves safe     without
               pages        workspace     calls             asking
```

| Level | Files | Commands | Pages | Asks you before |
|---|---|---|---|---|
| **Read-only** | Read | No | Read | — (it can't change anything) |
| **Board** | Read | No | Read, create and change | — |
| **Edits** | Read; edit inside the workspace | Yes, after asking | Read, create and change | Commands, and edits outside the workspace |
| **Auto review** | Like Edits | Like Edits | Like Edits | Only what a classifier doesn't judge safe |
| **Full access** | Everything | Everything | Read, create and change | Nothing |

**Ctrl+Shift+'** cycles through the levels you turned on under Agent settings → Keys → Access cycling.

The *workspace* is the folder the chat works in. A chat without one that needs to run something (installing a tool, say) works in a scratch folder in Scribe's data folder.

### The providers differ

Scribe drives each provider through its own SDK, and not every SDK can stop and ask. The access picker shows what each level means for the chat's provider.

| | Claude | Codex | Cursor | Native |
|---|---|---|---|---|
| **Read-only, Board** | As above | As above, and commands run in a read-only sandbox | As above | As above |
| **Edits** | As above | Approves file edits; asks for other actions that need approval | Can't ask: runs Cursor's Auto-review, which denies risky calls instead | As above |
| **Auto review** | Claude's classifier approves safe calls | Codex reviews actions; when it denies one, you can approve a retry | Cursor's Auto-review approves safe calls and denies the rest | Edits run; your classifier reviews commands and asks when unsure |
| **Full access** | Everything | Everything | Everything | Everything |

## Files outside the workspace

- **Reading** a file outside the workspace asks, with **Allow reading *folder* for this thread**.
- **Protected paths** can't be read even with a grant: Scribe's data folder (its database and tokens, other chats' data), `~/.ssh`, cloud and `gh`/npm credentials, browser profiles and password stores. Add your own under Agent settings → Providers → Allowlists… → Protected paths.

### OS sandbox

Below Full access, Scribe also asks the operating system to hold the agent's commands to the workspace, where it can:

| | Sandbox |
|---|---|
| **Linux** | Commands from Native, Claude, Cursor's host shell and Scribe-started MCP servers run under Anthropic's sandbox runtime: writes only in the workspace and temp, no protected paths, network as the Web setting allows |
| **Windows** | Codex runs its commands in its own sandbox. For the other providers, the access level's approvals and Scribe's own file checks are the boundary |
| **Full access** | No sandbox |

When the sandbox blocks something, the chat shows **Sandbox blocked: …** with a button to allow that folder or host for the thread.

## Web

| Web | What the agent may do |
|---|---|
| **Full** | Search and fetch any site |
| **Limited** | The web allowlist's domains without asking; it asks for others |
| **Off** | It asks before each search or fetch |

When it asks, you can allow once, allow that domain for the thread, allow all websites for the thread, or deny. The allowlist is under Agent settings → Providers → Allowlists….

Provider limits: Codex has no way to limit fetches to the allowlist, so on Codex *Limited* turns web search off. Cursor and Native can only search on *Limited* if you set up a SearXNG instance; without one, Limited covers fetching only.

## Other things a chat asks about

| When the agent wants to | It asks unless |
|---|---|
| Start a [helper agent](../reference.md#agent-tools) on another model | The chat has Full access, or you allowed helpers for this thread |
| Hand Trusted only content to a helper on an untrusted model | Never skipped (see [Page access](page-access.md#trusted-models)) |
| Change your MCP servers, hook rules, skills or instruction files | You allowed it for this thread |
| Read another chat's conversation | You tagged that chat with `#` in a message, or allowed it before |

## Limiting chats further

- **Modes** (Agent harness → Modes) save a set of limits you can start a chat with: the highest access level it may use, tool groups to turn off (file edits, shell, web, subagents, helpers, browser, reading other threads), and which MCP servers it keeps. A chat keeps its mode's limits even if you later delete the mode.
- **Hooks** (Agent harness → Hooks) watch messages, tool calls and output, and can ask you first or block a tool call before it runs. The Hooks page shows which providers can hold a tool call.

## Seeing and taking back grants

Everything you allowed *for this thread* (folders, web domains, plugins, helpers, other chats) is listed in the thread's menu → **Permissions…**, where you can remove it.
