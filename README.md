# Scribe

**A desktop app where you and your AI agents work on the same pages.**

Ask an agent to compare three options, plan a trip or investigate a bug, and the answer opens as a page next to your notes, not as a wall of text in a chat. Pages can be interactive: a form the agent waits on, a checklist you tick off, a Kanban board the agents pick work from. Everything is kept in a Library on your own machine.

Scribe runs the agents you already use (Claude Code, Codex, Cursor) and any OpenAI-compatible model, including local ones.

![A Kanban board in Scribe with the agent chat open beside it](docs/images/board-and-chat.png)

## What you can do with it

- **Get answers you can see.** Agents make pages: comparison tables, charts, reports, design mockups. They open as tabs, stay in your Library, and the agent can update them later instead of starting over.
- **Work on the same page.** Pages keep their own data. When you tick items, fill in a form or move a card, the agent reads it, and you see its changes while it works.
- **One chat for every agent.** Claude, Codex, Cursor and your own models share one chat, with plan usage and costs shown as you go. The chat follows the page in front, so "make this shorter" means this page.
- **Hand work to agent workers.** Put a card on a Kanban board and assign it to a worker. The worker takes the card, works in its own git branch, and hands it back for review. The board merges approved work, so the next worker starts from it.
- **Stay in control.** Every chat has an access level, from read-only to full access, and asks before it runs anything you have not allowed. You can review each turn's changes and undo them.
- **Keep it local.** Your pages, chats and settings live in one folder on your PC. There is no Scribe account and no cloud service; only the model providers you choose see your prompts.
- **Use it on all your devices.** Pair your PCs (on your network or over Tailscale) and open one device's pages from another, or run Scribe on a server and reach it from any browser.

![A hosting comparison page an agent made from one chat message](docs/images/agent-page.png)

## Install

### Windows (desktop app)

1. Download `Scribe_<version>_x64-setup.exe` from the [latest release](https://github.com/SirVeggie/scribe/releases/latest).
2. Run it. It installs for your user only (no admin rights) and includes everything it needs.
3. Start Scribe. A short setup guide walks you through signing in to your agents and choosing a theme. You can skip any step and come back to it under Settings → Help → Setup guide.

Scribe checks for updates itself. Choose under Settings → Updates whether it installs them automatically, asks first, or never checks.

### What you need for the agents

Scribe doesn't come with a model of its own. Set up at least one of these under Agent settings:

| Agent | What you need |
|---|---|
| **Claude** | A Claude plan you are signed in to with Claude Code (`claude`, then `/login`), or an `ANTHROPIC_API_KEY` |
| **Codex** | A ChatGPT account: **Log in** under Agent settings |
| **Cursor** | A Cursor account: **Log in** under Agent settings |
| **Native** | Any OpenAI-compatible endpoint: OpenRouter, LM Studio, Ollama, llama.cpp, vLLM, … or an API key for OpenAI, Anthropic, Gemini and others |

### Linux and macOS

There is no desktop app for Linux or macOS yet. You can run Scribe as a background service and use it in your browser:

```sh
curl -fsSL https://github.com/SirVeggie/scribe/releases/latest/download/install.sh | sh
```

Then open <http://127.0.0.1:4747>. This is also how you set up an [always-on server](#an-always-on-server).

## First steps

Press **Ctrl+K** on any page and ask for something. A few more keys get you around:

| Key | What it does |
|---|---|
| **Ctrl+K** | Floating chat over the current page |
| **Ctrl+L** | Chat in the sidebar (**Ctrl+Shift+L** for the full window) |
| **Ctrl+T** | New page: notes, a todo list, a Kanban board, or ask an agent |
| **Ctrl+B** | Library: every page, in folders you arrange |
| **Ctrl+D** | Search pages, their contents and your chats |
| **Ctrl+E** | Spaces: separate sets of tabs, such as home and work |
| **Ctrl+H** | Help: ask how to do anything in Scribe |

Some things to try:

- "Make a packing list for a weekend of hiking" gives you a checklist page. Tick a few items and ask "what's left?".
- Open a Kanban board from **Ctrl+T**, add a card, then ask the chat to break it into smaller cards.
- Give a chat a project folder (**Ctrl+.**) and raise its access level (**Ctrl+Shift+'**) to let it edit your code. In a git repository, you can review and undo the changes from each turn.

## Use Scribe's pages from other tools

Agents outside Scribe can use its pages too. Scribe is an MCP server: add it to Claude Code, Cursor, Codex or any MCP client, and their agents can show you pages and read what you did on them.

With the desktop app installed, the command is Scribe's own Node and entry point:

```json
{
  "mcpServers": {
    "scribe": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\Programs\\Scribe\\app\\node\\node.exe",
      "args": ["C:\\Users\\<you>\\AppData\\Local\\Programs\\Scribe\\app\\dist\\index.js"]
    }
  }
}
```

The server starts Scribe if it isn't running. Then ask the agent to "show this in Scribe".

## Using several devices

Each device runs its own Scribe and keeps its own pages and chats. Pairing connects them: the space picker (**Ctrl+E**) lists the spaces of every paired device, and opening one shows that device's pages and chats in your window. You can copy pages, folders and templates between devices, and approvals or questions from a chat on another device show up where you are.

Devices connect directly over an encrypted connection. They need to reach each other on your local network, over a VPN such as Tailscale, or through an always-on device that relays for them.

### On the same network, or with Tailscale

1. Install Scribe on both devices.
2. If the devices are not on the same network, install [Tailscale](https://tailscale.com/download) on both and sign in to the same account. Scribe finds Tailscale addresses on its own; there is nothing to configure.
3. On the first device, open Settings → Devices → **Add device**. It shows a pairing code and a QR code.
4. On the second device, open Settings → Devices → **Enter code** and type the code.
5. Both devices show four words. Check that they match.

Every paired device then knows about all the others, so pairing a third device with any one of them is enough.

### An always-on server

A Linux or macOS machine that is always on (a home server, a Raspberry Pi-class box, a VPS) can do more for your other devices:

- **Relay**: devices that can't reach each other directly connect through it. The connection stays encrypted end to end; the server only passes it on.
- **Offline mirror**: it keeps a read-only copy of a device's open pages and chosen folders, so you can still read and copy them while that device is off.
- **Browser access**: it can serve Scribe to any browser, such as your phone (see below).

To set it up:

1. Run the install script above on the server. It installs Scribe as a service that starts at boot.
2. On the server, run `scribe add-device` to get a pairing code, and enter it on your PC (Settings → Devices → **Enter code**). Or run `scribe pair <code>` on the server with a code from your PC.
3. For devices outside your network, give the server a public address (Settings → Devices → **Public address**, from any paired device) and open its peer port (`4748` by default) in the firewall.
4. Choose which device mirrors to it under Settings → Devices → **Offline mirror**, and mark folders as Mirrored from their menu.

### Browser access from anywhere

Web access lets you open Scribe on a phone or any computer with a browser. It needs an always-on device, a domain you control, and a TLS proxy such as [Caddy](https://caddyserver.com) in front of it. Only Google accounts you list can sign in.

1. Point your domain and its subdomains (`scribe.example.com` and `*.scribe.example.com`) at the server.
2. Create an OAuth client in the [Google Cloud console](https://console.cloud.google.com/apis/credentials) (type Web application) with `https://scribe.example.com` as an authorized JavaScript origin.
3. Have Caddy pass the domain to Scribe's web port (`4750` by default). Scribe tells Caddy which names may get certificates:

   ```caddyfile
   {
   	on_demand_tls {
   		ask http://127.0.0.1:4750/caddy-ask
   	}
   }

   https://scribe.example.com, https://*.scribe.example.com {
   	tls {
   		on_demand
   	}
   	reverse_proxy 127.0.0.1:4750
   }
   ```

4. On any paired device, open Settings → Devices → **Web access**, pick the server, and enter the web address, the Google client id and the accounts that may sign in.

Then open `https://scribe.example.com` and sign in. On a phone, Scribe switches to a layout made for small screens, and you can add it to your home screen.

## Build from source

You need [Node.js](https://nodejs.org) 22.19 or newer, and a [Rust toolchain](https://rustup.rs) for the desktop app.

```sh
git clone https://github.com/SirVeggie/scribe.git
cd scribe
npm install
npm run build
npm start              # the background service; then open http://127.0.0.1:4747
npm run desktop        # or build and run the desktop app
```

A copy built from git updates itself by pulling and rebuilding. [docs/reference.md](docs/reference.md) covers how Scribe works inside: the page API, the agent tools, the chat, the desktop app and the data folder. The [docs](docs) folder has design notes for individual features.
