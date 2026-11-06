# Sharing setup between devices (#979)

The investigation, with the full inventory and mock-ups, is the Scribe page `scribe:sync-setup-design-979`.
This file records what was decided, for the cards that implement it. It builds on the federated model of
`cross-device-design-892.md`: the Library stays per device; this is about the user's setup.

## Decisions (user, 2026-11-06)

| Question | Decision |
|---|---|
| First version covers | Appearance; layout, navigation, search and chat preferences; memories (done in #978); model / classifier / audio sources with keys opt-in; web and command allowlists; offers for MCP servers and plugins. |
| Not now | Hook rules, skills, custom modes and model defaults; classifier and audio preference switches; user templates. |
| First pairing | Merge, ask only about conflicts: a setting changed on one device beats a default and just flows over; settings both devices changed go to one "Choose setup" screen (use one device's for all, or pick per row). A device joining an existing group is compared against the group. |
| Sync page | Categories only: one switch per category in Settings → Devices → Sync (shared by the group), plus "this device keeps its own" per category (per device). |
| Headless devices | Take part as store-and-forward copies only, so devices that are rarely on together still sync. |
| Cards | Fewer, bigger: (1) step 0 + sync core + appearance and preferences + Sync page; (2) the rest on that core. |

## Inventory as decided

| Category | Mode | Notes |
|---|---|---|
| Appearance (`APPEARANCE_KEYS`, already in the daemon) | sync | |
| Layout, navigation, palette prefixes, search by meaning switch, chat preferences | sync | Now in browser `localStorage` (`public/app.js`, `public/agent.js`): move to the daemon first (step 0). That alone makes the desktop app, browser tabs and the gateway view of another device agree. |
| Reduce motion, title bar buttons | sync | The rest of Desktop stays local. |
| Memories | sync | Shipped in #978 (`src/devices/memorySync.ts`). Its on/off switch moves to the Sync page. |
| Model sources, classifier and speech-to-text sources | opt-in | Remote endpoints sync; `127.0.0.1` sources stay local. API keys only with a separate "include keys" switch, over the pinned peer link, into the target's secret store. |
| Web and command allowlists | opt-in | Widening on one device widens all; the Sync page says so. |
| MCP servers, plugins | offer | Shown on the other device to accept ("Laptop has 2 MCP servers this device doesn't: Add…"); plugins reuse the review flow from #907. Paths in plugin settings stay local. |
| Provider logins, plan usage, paths (workspaces, protected paths, worktrees, files on disk), microphone, device identity and peers, mirror and web access, startup and tray, updates, IntelliJ | local | OAuth refresh tokens rotate, so logins are never copied. |

## Sync core (shape)

- One settings channel over the peer link, like memory sync: each device sends its synced keys to online peers and
  merges what it gets.
- Each key carries a logical clock (device id + counter, not wall time, so clock skew can't make an old change win)
  and whether the user set it; a key with no record is a default and loses to any user-set value.
- Newest change wins per key after the first join. At the first join, keys both sides set differently are held
  back and listed on the Choose setup screen until the user picks.
- Headless devices store and pass on the synced keys but apply none of them.
- A category switched off on the Sync page stops for the whole group; "this device keeps its own" makes one
  device ignore incoming changes for that category and stop sending its own.
