# Cross-device design (#892)

Replaces #66 (hub + nodes) and #65 (agent remote control). The full design, with the options compared,
is the Scribe page `scribe:cross-device-design-892`. This file records what was decided, for the cards
that implement it.

## Decisions (user, 2026-10-30)

| Question | Decision |
|---|---|
| Model | Federated: every device owns its own data (Library, spaces, threads, plugins, templates). Nothing is synced between owners; moving data is an explicit copy, pointing at it a reference. |
| Opening a remote space | Same window: the shell switches to the remote device's own UI, served through the local gateway (`d-<device>.localhost`); the space selector takes you back. |
| Connectivity | Direct first (LAN, Tailscale / WireGuard). A relay through an always-on device comes later. |
| Trust | A paired device can do everything you can do locally. Agent access to other devices is gated separately. |
| Copy | An independent fork that records `copiedFrom: { device, key, revision }`. |
| Always-on device | Not in v1. Later: a headless Scribe holding a read-only mirror. |
| Mirror contents (later) | Every device's catalog, plus full pages in spaces marked Mirrored. Stored plainly behind the device keys. |
| Agents in v1 | None across devices. Agents run where their space lives; grants come later. |
| Remote approvals and questions | Shown as toasts on the device you are using. |
| First work | Steps 1–3 below. |
| Old cards | #66 and #65 archived. |

## Additions from the user's notes

- **Synced pages** (not v1): a page type that stays the same on every device, such as a shared Kanban
  board. It has one owner (later the always-on device), and other devices use it like a hosted web app
  through the peer link, so `store.ts` keeps one writer per page. Keep the gateway and references
  generic enough that a remote page can sit in a local Library.
- **Web access** (own card): the always-on server hosts Scribe behind real auth, so any browser
  (a phone, say) can open it. It is the same gateway as step 2 with user auth in place of loopback trust,
  and it is the first path to phone access before an Android app.

## Architecture

- **Device**: an id and an Ed25519 key pair made on first start, plus a name. Kinds: full, headless,
  client only (later Android).
- **Peer link**: one TLS connection per pair, on its own port, bound to LAN/tailnet interfaces. Each
  side pins the other's key from pairing. HTTP and WS streams are multiplexed over it. The 4747 API
  stays loopback only, because `callers.ts` trusts any browser request there.
- **Caller**: a request over the link is `{ viewer: "user", device }`.
- **Gateway**: the local daemon serves `d-<id>.localhost:4747` and `t-<page>.d-<id>.localhost` and
  forwards to the remote daemon, which serves its own UI (no UI version skew). Needs a configurable page
  host suffix (`config.ts`, `public/app.js`, `public/component-host.js`). `/api/devices` is answered
  locally. Static files come from local disk when `VERSION` matches.
- **Desktop shell**: Tauri capabilities and `desktop.js` must allow `d-*` origins.

## Steps

1. Devices and peer link: id + key, Settings → Devices, pairing by code (UI and `scribe pair`), peer
   listener, heartbeats, version handshake, revocation, `Caller.device`.
2. Gateway: the HTTP + WS proxy over the link, the configurable page host suffix, local static files,
   the desktop shell on `d-*` origins.
3. Device sections in the space selector, the remote device chip, offline and latency states, path
   actions off for remote paths, toasts for remote approvals and questions.
4. Later, as design cards: copy, references, headless, always-on mirror + relay, agent access, synced
   pages, web access, Android.
