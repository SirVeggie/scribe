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

## Step 1 as built (#904)

- `src/devices/identity.ts`: `<data folder>/device/` holds `identity.json` (id, name), `key.pem` (Ed25519,
  mode 600) and a self-signed `cert.pem`. The data folder is on #891's deny list, so agents can't read
  the key once #898's policy core lands.
- `src/devices/peers.ts`: the peer listener (TLS 1.3, `SCRIBE_PEER_PORT`, default API port + 1). It binds
  LAN (RFC 1918), tailnet (100.64/10) and unique-local IPv6 addresses, rescanned every minute, and only
  while a device is paired or a code is open, so a device that never pairs opens no port.
  `SCRIBE_PEER_HOSTS=127.0.0.1` (or `off`) overrides the addresses, for two daemons on one machine.
  Paired keys and revoked fingerprints are in `device/peers.json`.
- `src/devices/link.ts`: one link per pair (the one dialed by the smaller device id wins a tie). Frames are
  `[type][stream][length][payload]`: control JSON (hello with `protocol`, ping/pong every 15 s, dead after
  45 s, update, introduce, revoke, revoked) and byte streams. An incoming stream is handed to the daemon's
  HTTP server as a connection, so HTTP and WebSocket both work over it, and `callers.ts` reads the device
  from the stream: `{ viewer: "user", device }`. `PeerService.request` / `linkTo` are the gateway's (#905) way in.
- Pairing (`src/devices/pairing.ts`): the code is Crockford base32 of a version byte, a 10-byte secret, the
  first 12 bytes of the key fingerprint, the peer port and up to four address hints, grouped by five. The
  dialer checks the listener's key against that prefix before sending anything; both then prove the secret
  with an HMAC bound to both keys and their roles. Five wrong proofs close the offer. Four words from a hash
  of both keys are shown on both sides. `src/devices/qr.ts` draws the QR code.
- Revocation drops the key on both sides and sends `revoked` to every online peer, which drops it and tells
  the revoked device too. Each hello carries the revoked list, so a device that was away catches up.
- `/api/devices` (user only; agents get 403), Settings → Devices, and `scribe pair <code>` / `scribe devices`
  (`npm run pair -- <code>`). Events: `devices` (refetch), `device_paired` (words + other devices to introduce).
