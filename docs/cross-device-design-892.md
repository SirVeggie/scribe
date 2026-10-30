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

## Step 2 as built (#905)

- `src/devices/gateway.ts`: the first middleware. A host `d-<id>.localhost` (the board) or
  `<label>.d-<id>.localhost` (`t-`, `x`, `w-`, `w-it-`, `w-pc-`, and `c` for the shared content origin that
  is 127.0.0.2 at home) is forwarded over the link to device `<id>`, streaming bodies both ways. WebSocket
  upgrades on those hosts are piped as raw bytes over a link stream. `d-<this device>` redirects home, an
  unknown device is 404, an offline one 502 with a link back.
- Who may pass: only this device's browser. The local caller must be the user, send `Sec-Fetch-Site`, and
  any `Origin` must be one of the same device's gateway origins on this port; sockets need that Origin.
  Scribe's own headers (local token, thread token, client) are dropped. The agent browser blocks every
  gateway host (`blockedBoardRequest`), since agents get no cross-device access in v1.
- The remote side trusts the link's device (`Caller.device`), not the headers. It reads the suffix from the
  forwarded Host rather than a separate header: only link requests carry gateway hosts, because the
  local gateway takes them first. `config.ts` parsers accept the nested hosts; `contentOrigin.ts` has
  `requestSuffix`, `requestOrigin`, `boardOrigin` and `shellOrigin` (the shell-origin check that also
  takes the gateway board origin over a link), used by the redirects, the component CSP and URLs, and the
  agent, audio, ml and devices routes.
- The UI reads the suffix from its own location: `window.scribeHost` in `index.html` (app.js,
  component-host.js, popout.js, integrations.js), and `gatewayBoard` in the page bridge.
- Efficiency: when the peer's hello `version` equals ours, board files and the shared page files come from
  this device's `public/`. Otherwise `?v=` (content-hashed, immutable) responses are cached in memory per
  device and version (32 MB). Link sockets use a second `WebSocketServer` with permessage-deflate; local
  ones stay uncompressed.
- Not done: caching page HTML by revision. `/view` embeds the page's state and is `no-store`, so caching it
  by revision would show stale state; it needs the state split out of the HTML first.
- Path actions that open a window on the daemon's screen (Open file location, IntelliJ open, the search
  pack's Open folder) answer 409 to link callers and are hidden in a remote view.
- Settings → Devices: Open per online device (`location.href = d-<id>.localhost`), and Back for the device
  you are viewing from (`viewer` in `/api/devices`).
- Desktop: a capability for `http://d-*.localhost:<port>/*`, navigation to gateway boards allowed in the
  main and pop-out windows, `child_window` takes the board `origin`, and `embeds.rs` knows the nested hosts.
- Tests: `src/devices/gateway.test.ts` (three daemons on loopback) and `embeds.rs` cases. Run by hand: two
  daemons through Keeper, B's full UI and a page loaded through A's gateway in Brave.

## Step 3 as built (#906)

- `/api/devices` is this device's in every view: the gateway hands `/api/devices/*` on a `d-<id>.localhost`
  board host to the local devices router (`res.locals.gatewayDevice`), which adds `viewing` (the device whose
  UI asked). Changes from that view are accepted when the Origin is that same gateway board, which the gateway
  already checked.
- `GET /api/devices/spaces`: this device's spaces and each online device's (fetched over the link from its
  `/api/spaces`, 3 s timeout). `POST /api/devices/:id/spaces/:sid/switch` makes it that device's current
  space; the UI then goes to `127.0.0.1` or `d-<id>.localhost` on the same port.
- Space selector (`spaces.js`): with paired devices, a section per device, this one first. The device being
  shown keeps the full cards (keys, drag, menu); the others get compact cards. Offline devices show
  "offline · last seen" and no spaces (nothing is mirrored in v1).
- Remote chrome: a device chip before the space chip in another device's UI, in a color derived from its id;
  its tooltip has the round trip, and it turns hollow when the link or the board socket drops. The startup
  "Could not connect" message names the device.
- Asks: `src/devices/attention.ts`. Each daemon streams its chats waiting on an approval, question or plan
  (not usage limits) at `/api/devices/asks` (SSE). The local daemon keeps one stream per online peer
  (`AskWatcher`) and the board reads `/api/devices/attention`: every other device's asks, plus this device's
  own when the board is another device's UI. Toasts reuse `.ag-toast`; Open goes to that device's UI with
  `?thread=`, which the agent UI opens at boot. Approving from the toast itself is left for later.
- Tests: `src/devices/devicesView.test.ts` (two daemons on loopback).

## Embeds (#917)

- An embed page points its tab frame straight at its URL, so in another device's UI `http://127.0.0.1:8188` was the
  viewing device's loopback. Now, in a remote view, `viewUrl()` (`public/app.js`) sends embeds of private hosts
  (loopback, RFC 1918, tailnet 100.64/10, link-local, ULA, `localhost` / `.local` / `.lan` / `.home.arpa` /
  `.internal` and single-label names) to `eh-<base32 of host:port>.d-<id>.localhost` (`es-` for https): one origin
  per target. Public sites still load directly.
- The viewing device's gateway forwards that host like any other label (never from its own `public/`). The device
  that owns the page proxies it in `src/devices/embedProxy.ts`, for link callers only: Host, Origin and Referer go
  to the target (dev servers check Host), redirects and cookie domains come back to the embed origin, X-Frame-Options
  and `frame-ancestors` are dropped, and WebSocket upgrades (hot reload) are piped.
- Only origins one of that device's embed pages names (`http.ts`, rebuilt at most once a second on a miss), never
  its own board or peer port. Refused targets, a target nothing answers on, and an offline device show a short
  placeholder in the frame. `/api/frame-check` answers framable for these, since the proxy drops the headers.
- Limits: an app that calls itself by an absolute URL (`fetch("http://127.0.0.1:8188/api")`) still reaches the
  viewing device; a peek of a private link that no embed page names shows the refusal placeholder.

## Copy (#907)

- `src/devices/copy.ts`. The device that owns the data pushes. "Copy to this device" in another device's UI is the
  same push: that UI calls its own daemon's `/api/copy` (not taken by the gateway), which pushes to the viewer.
- `POST /api/copy { device, pages?, folders?, templates?, plugins? }` (board only; agents 403) exports like a file
  export (`store.exportFile`), swaps every blob (page images, saved page assets, plugin archives) for its SHA-256,
  asks the target `POST /api/copy/incoming/check` which hashes it lacks and which plugins it has with the same code,
  `PUT`s only the missing blobs, then `POST /api/copy/incoming` the bundle. `/incoming/*` answers link callers only.
- The target keeps incoming blobs in `<data>/device/blobs/<hash>` for a week after they were last asked for, so a copy
  that is sent again (or retried) moves only its JSON. Blobs already inside existing pages are not indexed.
- The target imports with `store.importBoard(…, "closed")`: into the Library, key clashes suffixed, templates matched
  by content, folder paths recreated. Each page gets `provenance.copiedFrom: { device, name, key, revision, at }`; the
  device and name come from the link, not the bundle. Thread ids in `created`/`changed` are dropped (titles kept).
  The hover card shows "Copied from". A copy is a fork: nothing links it back.
- Plugins the pages or templates declare (or the one asked for) travel as their archive (code + source) unless the
  target has the same code. They are not installed: they wait in `<data>/device/pending-plugins.json`, listed at the
  top of Settings → Plugins ("From Laptop · not installed", Review… / Dismiss); Review runs the usual install consent.
- UI: "Copy to device" submenus on the page (Library row and tab), folder, multi-selection and template menus, and a
  "Copy to device…" button in a plugin's settings; offline devices are disabled. The target's board shows a notice
  (`copy_received`), with Review when plugins came.
- Tests: `src/devices/copy.test.ts` (two daemons on loopback, a fake store). Checked by hand with two daemons: a page
  with an image copied twice gives `thesis-plan` and a suffixed key, the second copy sending no blob bytes.

## References (#908)

- Syntax: `scribe:@<device>/<key>` (with `#card=12` or any other anchor), `thread:@<device>/<thread id>`, in every link
  form (`[[…]]`, `[[peek:…]]`, `[label](…)`, a bare `scribe:@laptop/key`). `[[thread:th_…]]` is a chat on this device.
  `templates/scribe-md.js` renders them; `src/devices/references.ts` parses them.
- The device part is an id or a name, written as a slug ("Work laptop" is `@work-laptop`). A device keeps up to five
  former names (`formerNames` in `identity.json` and `peers.json`), so links written before a rename still resolve.
- `POST /api/devices/resolve { targets }` on the viewing device's daemon (so the gateway answers it in a remote view too):
  each target is `{ here }` (the device whose UI asked: a local link), `{ unknown }`, or `{ device, online, title?, key?,
  missing? }`. Titles come from the owner's `POST /api/devices/describe { pages, threads }` over the link, and the last
  one seen is kept in memory, so an offline device's links keep their label.
- Board: `views.resolveAll` (page bridge `scribe.resolve`, the chat's links) and `views.open`. Opening goes to that
  device's UI in this window: `d-<id>.localhost/?open=<key#anchor>` or `?thread=<id>`; the gateway sends `d-<this device>`
  home. Offline: a notice "Laptop is offline". The hover tip (the link's title in pages, the custom tooltip in the chat)
  is "Title · Laptop" or "Laptop is offline".
- Generic for synced pages: nothing past the lookup is page specific, so a Library entry that points at
  `scribe:@pi/board` can use the same resolve and open later. The mirror fallback comes with the always-on device.
