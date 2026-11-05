# Tools and plugins

[← Permissions overview](../permissions.md)

Besides its built-in tools, a chat can use **MCP servers** you add and **plugins** you install. Each has its own rules on top of the chat's [access level](chat-access.md).

## MCP servers

Scribe keeps its own list of MCP servers for its chats, under Agent harness → **MCP servers** (you can import the ones you already use in Claude Code, Codex or Cursor). For each server you choose:

| Setting | Choices |
|---|---|
| **Enabled** | On or off, globally or for one workspace folder |
| **Modes** | Which kinds of chats get it (by default chats that work on files) |
| **Approve** | *Ask* before each call (default), or run every call without asking |
| **Per tool** | *Allow* (runs without asking), *Disable* (the agent never sees it), or the server's setting |

Chats with Full access run every MCP call without asking. Below that, when a call needs approval, the chat asks:

| Answer | Lasts |
|---|---|
| **Allow once** | This call |
| **Allow this server for this thread** | Every tool from this server, in this chat |
| **Always allow this tool** | This tool on this server, in every chat |
| **Deny** | This call |

The saved answers are listed under **Saved MCP permissions** in the MCP servers settings, where you can revoke them. A grant belongs to the server's exact configuration: if you change the server's command or address, Scribe asks again.

Scribe's own page tools (`page_show`, `page_action` and the rest) don't go through these approvals. What they may touch is decided by [Page access for agents](page-access.md) and by the chat's access level (Read-only chats can't change pages).

## Plugins

Plugins add features to Scribe: backend methods, widgets in pages and the chat, and page templates. Two things are worth knowing up front:

1. **Installing a plugin runs its code as you.** Its manifest declares the folders, hosts and environment it wants, and Scribe shows them before you install, but that is for your review, not a sandbox. Install only plugins you trust. Settings → Plugins shows each plugin's source and changes before you install or update it.
2. **An agent can't install or reload plugin code without asking you**, unless its chat has Full access.

### Who may call a plugin

A plugin's methods can be called by pages (and widgets) and by agents:

```text
 Page code ──► page permission "Plugin: name" ──► method
 Agent     ──► the method's agent level + chat access level ──► method
               (and the chat's page must not Deny that plugin)
```

**Pages** need the page permission **Plugin: *name*** (see [Page permissions](page-permissions.md)). It starts as Ask, or Allow on a page made from that plugin's own template.

**Agents**: each method declares how risky it is for an agent:

| Method level | An agent may call it |
|---|---|
| **read** | At every access level |
| **board** | At Board or higher |
| **ask** | At Full access, or when the chat's page allows the plugin. Otherwise the chat asks: **Allow**, **Allow for this thread**, or **Deny**, even on Auto review |

If the chat's page *denies* the plugin, its ask-level methods are refused. Your answers in the chat never change the page's permissions.
