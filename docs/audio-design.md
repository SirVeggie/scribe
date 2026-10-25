# Audio in Scribe: design (#562)

Scribe has no audio today: no microphone capture, no speech-to-text (STT), no playback, no
text-to-speech (TTS). This document designs the whole system so that the five features on #562 are
built on shared parts instead of five separate ones.

| # | Feature | Status after this design |
|---|---------|--------------------------|
| 1 | Mic and STT in the chat composer | ready to build (phase A) |
| 2 | Mic and STT in the page API, with a microphone permission | ready to build (phase B, after A) |
| 3 | Playing audio; first use: a sound when a user-level thread finishes | todo (phase C) |
| 4 | TTS, page API first | todo (phase D, after C) |
| 5 | Realtime voice chat for threads and the page API | in design (phase R, after A–D) |

## What the code looks like today

Facts the design rests on, checked in the code:

- **The shell and pages are different origins.** The shell (board UI) is `http://127.0.0.1:<port>`;
  page iframes load from `127.0.0.2` (`contentOrigin()`), sandboxed with
  `allow-scripts allow-same-origin allow-forms allow-modals allow-popups … allow-downloads`
  (`public/app.js:113`). `loadFrame` sets `el.allow = ""` for pages (`public/app.js:2953`), so
  `getUserMedia` in a page is blocked by Permissions Policy today. Both origins are loopback, so
  both are secure contexts.
- **Pages reach the shell by `postMessage`.** `askBoard` in `src/bridge.ts` posts
  `scribe-<name>` with a `reqId`; the shell listener in `public/app.js` (`onPageAgent`, `onPageMl`,
  `onPagePermissions`, `onPagePreview`, …) checks the origin and the frame, and answers with the
  same `reqId`. `frameActivated(frameId)` (`public/app.js:3971`) tells whether the call came with a
  user gesture in that frame.
- **Page permissions** are a list in `src/pagePermissions.ts` (`PAGE_PERMISSIONS`: `agent.chat`,
  `agent.unattended`, `agent.workspace`, `ml.decide`). Each has `default` (allow / ask / deny) and
  `risky` (reset when an agent rewrites the page's code). Grants are stored per page on this PC; the
  shell asks through `window.scribePermissions.ensure(tab, need)`; the daemon checks again with
  `checkPermission` (see `src/ml/page.ts` for a gated page call end to end).
- **A test keeps the page API and its docs in step**: `src/skillDocs.test.ts` requires every key of
  `window.scribe = {` and of the `var agent / permissions / ml = {` sub-objects in `src/bridge.ts`
  to appear in the scribe skill.
- **The composer** is a `<textarea class="ag-textarea">` built in `buildComposer()`
  (`public/agent.js`, near line 4306), with the send button in a send slot and icons from the inline
  SVG map in `public/agent-render.js`. Files reach it only by paste and drop; attachments go to the
  daemon as base64 in JSON (`POST /api/agent/threads/:id/messages`, 80 MB JSON limit).
- **A raw-body upload precedent exists**: `POST /api/tabs/:id/assets` (`src/http.ts`, `readAssetBody`)
  takes bytes with `x-asset-name` / `x-asset-type` headers.
- **Agent and ML routes are shell-only**: `shellOnly` in `src/agent/routes.ts` refuses writes whose
  `Origin` is not a shell origin. Anything that spends the user's API key must keep that gate, or a
  page could call it directly.
- **OpenAI-compatible sources** (`src/agent/openaiSources.ts`): the user's own endpoints (OpenAI,
  OpenRouter, Groq, LM Studio, Ollama, …), each `{ id, name, baseUrl (incl. /v1), apiKey }`, stored in
  agent.sqlite; the key never leaves the daemon. Today they only serve chat models to the Native
  (`pi`) provider.
- **The decision service** (`src/ml/`) is a good structural model: `types.ts`, `settings.ts` (a JSON
  file under the data dir, feature switches, "what may be sent" switches), `service.ts` (queue,
  timeout, typed failures, usage per day), `routes.ts` (shell-only), `page.ts` (the page-gated entry),
  adapters. It is a classifier API and has nothing to do with speech.
- **Optional packs**: semantic search runs a local ONNX model through transformers.js in a child
  process, installed as an optional pack (`docs/semantic-search-design.md`, `docs/search-pack.md`).
  The same mechanism can carry a local Whisper model later.
- **Thread events** reach the shell over the `/ws` WebSocket (`agent_thread`, `agent_item`,
  `agent_delta` (text deltas), `agent_turn`, …). Thread status is `idle | running | waiting`.
- **Finish and "needs you" toasts already exist**: the toast manager in `public/agent.js`
  (`add(key, t, kind)` with kind `finish` or `ask`, near line 7341) fires when a user-level thread
  finishes off screen or starts waiting. That is the hook for notification sounds.
- **Appearance settings** sync through the daemon (`src/appearance.ts`, a whitelist of keys with
  validation); its test says functional settings stay out of it.
- **Page assets**: files a page saves may be mp3 / wav (`FILE_MIME` in `src/pageAssets.ts`); assets an
  agent attaches with `page_show` are images only (`ASSET_MIME` in `src/assets.ts`).
- **Desktop**: the Tauri shell shows the same web UI in WebView2 and has no handler for webview
  permission requests. Whether WebView2 shows its own microphone prompt for `127.0.0.1`, and
  remembers the answer, has not been tested.
- Dependencies include `ws` and `@anthropic-ai/sdk`; there is no `openai` SDK (and none is needed:
  the audio endpoints are plain HTTP).

## Principles

1. **The shell owns the devices.** Only shell code calls `getUserMedia` and owns the output mixer.
   Pages never get `allow="microphone"`. A page asks the shell to listen or record, and gets text or
   a finished clip back, or a relayed live stream with the separate B2 permission. Reasons: one
   browser permission for one origin; a recording indicator the
   page cannot hide or fake; one place for the stop button, the time cap, the volume and the mute;
   and revoking a page's permission takes effect at once (an iframe `allow` attribute only changes
   on reload).
2. **The daemon owns keys and engines.** STT and TTS calls go shell → daemon → engine. Keys stay in
   the daemon, as they do for chat models.
3. **Engines are swappable behind one interface.** First engine: any OpenAI-compatible endpoint the
   user already added as a source. Later: a local Whisper pack, the browser's own speech API.
4. **Fail open, typed.** Like the decision service: a failure is `{ ok: false, error: <kind> }`, never
   an exception in the caller; the composer keeps what the user typed.
5. **One capture at a time.** Starting a capture stops the one before it. This removes a whole class
   of "who is recording" states.
6. **Nothing listens without a visible sign.** While the mic is open the shell shows it (composer
   state, a marker on the page's tab, and one global control that stops it).

## Architecture

```text
 chat composer ─────┐                                       ┌─ OpenAI-compatible source
 (public/agent.js)  │                                       │    POST {baseUrl}/audio/transcriptions
                    ▼                                       │    POST {baseUrl}/audio/speech
 page iframe ──postMessage──▶ public/audio.js ──HTTP──▶ src/audio/ ─┼─ local Whisper pack (later)
 (scribe.audio in             window.scribeAudio        service.ts  │
  src/bridge.ts)              · capture (mic)           routes.ts   └─ realtime sessions (phase R)
                              · transcribe              page.ts
                              · mixer: play, cues       settings.ts
                              · speak (TTS)
                              · indicator + stop
```

### Daemon: `src/audio/`

Same shape as `src/ml/`.

- `types.ts`: `AudioSettings`, `AudioErrorKind` (`no_source`, `disabled`, `not_allowed`,
  `too_large`, `too_long`, `unauthorized`, `rate_limited`, `timeout`, `unavailable`,
  `invalid_response`), engine interfaces:

  ```ts
  type SttEngine = {
    transcribe(audio: Buffer, opts: { mimeType: string; language?: string; prompt?: string }, signal: AbortSignal):
      Promise<{ text: string; language?: string; durationMs?: number }>;
  };
  type TtsEngine = {
    speak(text: string, opts: { voice?: string; format: "mp3" | "opus" | "wav"; speed?: number }, signal: AbortSignal):
      Promise<{ stream: ReadableStream<Uint8Array>; mimeType: string }>;
  };
  ```

- `settings.ts`: `audio-settings.json` under the data dir.

  ```ts
  type AudioSettings = {
    stt: { source?: string; model: string; language?: string };          // source: an OpenAISource id
    tts: { source?: string; model: string; voice?: string; speed?: number };
    input: { deviceId?: string; sendAfterDictation: boolean; pushToTalk: boolean };  // deviceId is per browser profile, see below
    output: { volume: number; muted: boolean; cues: Record<string, boolean> };       // phase C
  };
  ```

  Speech engines reuse the **existing OpenAI sources** (the audio service gets a lookup function
  from the agent host) instead of a third list of endpoints: one OpenAI key then covers chat, STT,
  TTS and realtime, and a local server (speaches, faster-whisper-server, whisper.cpp's server, Kokoro
  FastAPI) is added the same way as LM Studio. Defaults when the chosen source is OpenAI's:
  `gpt-4o-mini-transcribe` for STT, `gpt-4o-mini-tts` for TTS; otherwise the model field is free text.
- `service.ts`: `transcribe()` and `speak()`: resolve the source, one retry on 429 / 5xx, timeout,
  usage per day (seconds of audio in, characters out) like `MlDayUsage`.
- `routes.ts`, mounted at `/api/audio`, shell-only:
  - `GET /settings`, `PUT /settings`
  - `POST /transcriptions`: raw body (`Content-Type: audio/webm` etc.), limit 25 MB (OpenAI's own
    limit), optional `?language=&prompt=`, optional `x-scribe-tab: <tab id>` when the shell records
    for a page. Returns `{ ok: true, text }` or a typed failure.
  - `POST /speech` (phase D): JSON `{ text, voice?, speed? }` → the audio stream.
  - `POST /test`: transcribes a built-in two-second clip, for the Settings "Test" button.
- `page.ts`: when `x-scribe-tab` is set, checks the page's grant with `checkPermission` before the
  engine is called (defence in depth; the shell has already asked the user).

OpenAI-compatible calls are plain `fetch`: multipart `file` + `model` to `/audio/transcriptions`,
JSON to `/audio/speech`. No new dependency.

### Shell: `public/audio.js` (`window.scribeAudio`)

One module that both the chat and the page bridge use.

```js
scribeAudio.capture({ owner, maxMs, onLevel, onState })   // → session { stop(): Promise<Blob>, cancel(), state }
scribeAudio.transcribe(blob, { language, prompt, tabId }) // → { ok, text } | { ok:false, error }
scribeAudio.dictate({ owner, onLevel, onState, tabId })   // capture + transcribe; session.stop() → { ok, text }
scribeAudio.available()                                   // → { mic: boolean, stt: boolean, reason? }
// phase C
scribeAudio.play(src, { volume, channel })                // src: URL | Blob; → handle { stop(), ended: Promise }
scribeAudio.cue(name)                                     // "thread-finish", "thread-ask", …
// phase D
scribeAudio.speak(text, { voice, tabId })                 // → handle { stop(), ended }
```

- Capture: `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId } })`,
  `MediaRecorder` with `audio/webm;codecs=opus` (falls back to what `isTypeSupported` offers), an
  `AnalyserNode` for the level meter. The stream is opened on start and its tracks are stopped on
  stop, so the OS mic light is on only while recording. Default cap: 5 minutes (opus at 32 kbit/s is
  about 1.2 MB, far under the route's limit).
- `owner` is `{ kind: "chat", threadId }` or `{ kind: "page", tabId }`. It drives the indicator and
  lets the shell stop a page's capture when its tab is closed, navigated or hidden.
- Mic device choice is stored per browser profile (device ids differ per browser), not in the
  daemon; everything else is in `audio-settings.json`.
- Output (phase C): one `AudioContext` with a master gain (volume, mute) and channels (`cue`,
  `page`, `speech`) so a later setting can duck or mute one kind. The context is resumed on the first
  user gesture in the shell; before that, cues are dropped, not queued.

### Settings: a new "Audio" section

Fields, in the order they are built: speech-to-text source and model, language (auto by default),
a Test button, "Send after dictation" (off), microphone device; later: notification sounds with
volume, text-to-speech source, model and voice. When no source can transcribe, the composer's mic
button opens this section instead of failing silently.

## Phase A: mic and STT in the chat composer

- A mic button in the composer's control bar (new `mic` icon in `public/agent-render.js`).
- States: idle → recording (button shows a level ring and elapsed time; Esc or a second control
  cancels) → transcribing (spinner; the textarea stays editable) → idle. Errors show as the
  composer's usual notice, not a dialog.
- Click starts, click stops. The transcript is inserted at the caret (replacing the selection),
  with a space added when the text before it needs one; the composer keeps focus. It is **not** sent
  unless "Send after dictation" is on.
- Push-to-talk: hold a shortcut to record, release to stop. Proposed key: hold `Ctrl+Shift+Space`
  in the composer (to be checked against the tables in `public/agent.js` near 10495 and
  `public/app.js` `runShortcut`).
- Switching threads or closing the dock while recording cancels the capture. Text already
  transcribed stays in that thread's draft.
- The first click asks the browser for the microphone. A denied or missing mic gives one clear
  message ("Microphone blocked for this site" with where to change it).
- Desktop (WebView2): check that the prompt appears and is remembered. If not, add a
  `PermissionRequested` handler that allows `microphone` for the board origin only.
- Tests: `src/audio/` unit tests with a fake engine (limits, typed failures, shell-only gate, source
  lookup), and a UI test in the style of the existing `*Ui.test.ts` files for the insert-at-caret
  logic (keep that logic in a pure function).

Out of scope for A: live partial transcripts, voice activity detection, sending the recording
itself to a model as an attachment.

## Phase B: mic and STT in the page API

```js
// in a page
const session = await scribe.audio.listen({ language, prompt, maxMs });   // needs a click; asks for the permission
session.onlevel = (v) => …;            // 0..1, about 15 times a second
const { ok, text, error } = await session.stop();   // or session.cancel()

const rec = await scribe.audio.record({ maxMs });    // the clip itself, no transcription
const { ok, blob, mimeType, durationMs } = await rec.stop();

await scribe.audio.transcribe(blob, { language, prompt });   // a clip the page already has
scribe.audio.available();                                    // { mic, stt }
```

- `var audio = { … }` in `src/bridge.ts`, added to `window.scribe` and to the `skillDocs.test.ts`
  prefix list; documented in the scribe skill (`.cursor/skills/scribe/SKILL.md`) and in the
  `scribe_docs` description in `src/mcp.ts`.
- Transport: `scribe-audio` messages with `op: "listen" | "record" | "stop" | "cancel" | "transcribe"`;
  level updates and state changes come back as `scribe-audio-event` posts to that frame. A recorded
  clip is posted back as an `ArrayBuffer` (transferred).
- Permissions (in `PAGE_PERMISSIONS`):

  | id | label | default | risky |
  |----|-------|---------|-------|
  | `audio.microphone` | Use the microphone | ask | yes |
  | `audio.transcribe` | Turn speech into text | ask | no |

  `audio.microphone` covers `listen` and `record`. `audio.transcribe` covers sending audio to the
  speech engine set up in Settings (with a hosted source that audio leaves this PC, and it costs
  money), so `listen` needs both and the shell asks for both in one prompt. `record` alone needs only
  the microphone. `audio.microphone` is risky: it resets when an agent rewrites the page's code, so
  a rewritten page cannot inherit the mic.
- Rules the shell enforces, whatever the page does:
  - Starting a capture needs a user gesture in that frame (`frameActivated`), every time. There is
    no unattended microphone in this phase.
  - The capture stops when the tab is hidden, closed or reloaded, at `maxMs` (capped at 5 minutes),
    or when the user clicks the shell's stop control.
  - While it runs, the page's tab shows a recording marker, and the top bar shows one stop control.
  - A page in a background window or a split it is not visible in cannot start one.
- The kanban board is the first user: a mic button in the card dialog's description and comment
  fields is a natural follow-up, not part of this phase.

### B2: the live microphone stream (user's answer on #562)

The user wants pages to be able to get the live microphone too (visualisers, custom processing,
a page's own voice activity detection), behind a second, riskier permission. The shell still owns
the device: it does **not** add `allow="microphone"` to page iframes. It relays the audio instead.

```js
const live = await scribe.audio.stream({ maxMs });   // needs a click; asks for audio.microphoneStream
live.stream;                 // a real MediaStream inside the page: feed it to an AudioContext, a <canvas> visualiser, MediaRecorder
live.sampleRate;             // the shell capture's rate (48000 usually)
live.onend = (reason) => …;  // "stopped" | "hidden" | "max" | "user" | "revoked"
live.stop();
```

- Shell: the same capture (lock, marker, stop control, stop-on-hide, 5-minute cap) with an
  `AudioWorkletNode` tapping the mic and posting Float32 frames (mono, about 20 ms each) through a
  `MessagePort` given to the frame, buffers transferred.
- Bridge: the page side builds an `AudioContext` and a worklet that plays the frames into a
  `MediaStreamAudioDestinationNode`; `live.stream` is that node's stream. A small jitter buffer
  (about 60 ms) absorbs postMessage timing. The page never touches `getUserMedia`.
- Permission `audio.microphoneStream` ("Stream the live microphone to this page", default ask,
  risky). It is separate from `audio.microphone` because the page gets every sample while the
  capture runs, not a clip at the end. Risky means it resets when an agent rewrites the page.
- Why relay and not `allow="microphone"`: with delegation the page could keep the mic open after
  Scribe's marker and stop control think it closed, start without a gesture once the browser has
  remembered the grant, and hold the device against the chat's capture. Relaying keeps the six
  principles true at the cost of a few tens of milliseconds.

#### Implementation

`scribe.audio.stream({ maxMs })` returns `{ ok: true, stream, sampleRate, onend, stop() }`.
It needs a click, a visible page, and only `audio.microphoneStream` (ask by default, risky).
That permission explains that every sample reaches the page, rather than just a finished clip.
Failure resolves `{ ok: false, error }`.

The shell uses the same capture reservation, indicator, stop control and five-minute cap as
recording. A static `/audio-stream-worklet.js` module taps capture into mono Float32 packets of
20 ms, transferred over a MessageChannel to the page. The module is also served as a data-free
shared file on page origins, so its playback processor loads from the iframe's own origin.
No blob module, cross-origin module request or iframe microphone delegation is needed.

The page creates an AudioContext at the shell's sample rate and feeds the packets through a
60 ms jitter buffer into a MediaStreamAudioDestinationNode. Above 200 ms it discards the oldest
samples back to 60 ms. Underruns rebuffer. It never connects the live samples to speakers.

On stop, hiding, cap, shell stop/device loss or permission revocation, the shell sends an end
message (`stopped`, `hidden`, `max`, `user`, `revoked`) and closes its port. The bridge closes
its port and context and stops the destination tracks. Close/reload use `stopped`.

## Phase C: playing audio, notification sounds (todo)

- The mixer in `public/audio.js` (above). Sound files in `public/sounds/` (short, under 50 KB each,
  ogg or mp3, with a licence note next to them like `public/Inter-OFL.txt`). Files rather than
  synthesised chirps: simpler, and they sound better. A tiny synthesiser can come later if cues need
  to vary with data.
- First cues, from the existing toast manager (`add(key, t, kind)` in `public/agent.js`):
  `thread-finish` when a **user-level** thread finishes (not helpers, not board workers' chats, not
  page chats), and `thread-ask` when one starts waiting on the user. Both only when that thread is
  not the one the user is looking at with the window focused. Cues within 1.5 s of each other merge
  into one.
- Settings: sounds on / off (default off until the user turns them on), volume, and a switch per
  cue, in `audio-settings.json` and synced to open windows over `/ws` (not through the appearance
  whitelist, which is for looks). With several Scribe windows open only one plays the cue: the
  focused one, else the one that has held the `/ws` connection longest (a `BroadcastChannel`
  election in the shell).
- Page API: `scribe.audio.play(src, { volume })` → `{ stop(), ended }`, where `src` is an
  `asset:name`, a data URL or a Blob. Pages can already use `<audio>` and `new Audio()` after a click;
  the API adds the shell's volume and mute and works without a click when the page has the new
  permission `audio.play` ("Play sounds", default allow, not risky; "without a click" additionally
  needs the tab to be visible). Also allow audio types (mp3, ogg, wav, m4a; 8 MiB) for assets an agent
  attaches with `page_show`, so an agent can ship a page with its sounds.
- Autoplay: browsers block sound until the user has interacted with the site. The shell resumes
  its `AudioContext` on the first gesture; the desktop app can lift the restriction for the board
  origin (WebView2 `--autoplay-policy=no-user-gesture-required`).

## Phase D: text-to-speech (todo)

- Daemon `POST /api/audio/speech` → the engine's stream passed through (mp3 or opus). The shell plays
  it with `MediaSource` when the format allows, so speech starts before the whole clip has arrived;
  otherwise it buffers. Long text is split at sentence ends and requested piece by piece (the
  OpenAI endpoint takes 4096 characters), each piece queued behind the one before.
- Page API: `scribe.audio.speak(text, { voice, speed })` → `{ stop(), ended }`, and
  `scribe.audio.voices()`. Permission `audio.speak` ("Read text aloud", default ask, not risky: it
  sends the page's text to the speech source and costs money).
- Engines: OpenAI-compatible `/audio/speech` first. Second, as a no-setup fallback: the browser's
  `speechSynthesis` run in the shell (free, local, robotic), chosen in Settings as the source
  "This browser".
- In chat, later: a "Read aloud" action on an assistant message. Not part of the first cut.

## Phase R: realtime voice chat (in design)

The goal: talk to a thread (or to a page's agent) and be answered within about half a second, while
the work is still done by the thread's normal agent with its tools and its care.

### Two layers

```text
        ┌──────────────── shell ────────────────┐
  mic ─▶│ capture ─▶ FRONT (voice session) ─▶ mixer ─▶ speakers
        │               ▲        │ tools                │
        └───────────────┼────────┼──────────────────────┘
                        │        ▼
              thread events    delegate / steer / stop / answer
              (digested)         │
                        ┌────────┴─────────┐
                        │ BACK: the thread │  ← the normal agent turn: tools, files, approvals
                        └──────────────────┘
```

- **Front**: a small, fast model that holds the spoken conversation. It hears the user, answers at
  once, and decides whether it can answer itself (small talk, "what is it doing?", reading back what
  the agent said, clarifying the request) or must hand over.
- **Back**: the thread, unchanged. It receives ordinary user messages and produces ordinary items.
  It does not know or care that a voice sits in front of it, apart from one line in the message
  ("sent by voice; the user hears a spoken summary of your reply, so lead with the outcome").

The front never edits files or runs tools of its own. Its only powers are the thread's existing
controls:

| Front tool | What it does | Existing code path |
|------------|--------------|--------------------|
| `delegate(text)` | Send a user message to the thread; starts a turn or queues behind the running one | `host.send` |
| `steer(text)` | Add to the running turn | `ProviderSession.steer` (where the provider has it) |
| `stop()` | Cancel the running turn | `ProviderSession.cancel` |
| `status()` | What the thread is doing now | `ThreadView.activity`, last items |
| `read(itemId?)` | The full text of the last reply, to read out or quote | thread items |
| `answer(choice)` | Answer a question the thread asked the user | the question's reply path |

Approvals (run this command? edit this file?) are **not** answerable by voice in the first cut: the
front says that the agent is waiting for approval and what for, and the user clicks. Speech
recognition mishears, and "yes" to the wrong prompt can delete things. Voice approval can follow
later, with a read-back ("approve deleting the build folder — say 'confirm' to go ahead").

### What the front knows

Its context is rebuilt, not accumulated:

1. Fixed instructions: who it is, the tools, when to delegate (anything that needs files, tools,
   the web, or more than a sentence of reasoning), how to talk (short, no lists, no markdown).
2. A **thread digest**: title, workspace, a summary of the thread so far (the existing summariser
   with a voice-specific prompt, refreshed when a turn ends), and the last few items verbatim.
3. The spoken conversation so far (last N turns).
4. **Live updates** injected as they happen, each a short system note: "turn started", "running
   tests", "asked the user: …", "turn finished: <first 600 characters of the reply>". The shell
   already receives these as `agent_turn` / `agent_item` / `agent_delta` events; a digester turns
   them into notes, at most one every few seconds, dropping noise.

On an update the front may speak without being asked ("done — the tests pass, two files changed"),
but only at a pause: never over the user, and progress notes at most every 20 s unless asked.

### Where the spoken conversation is kept

Voice turns are stored on the thread as a new item kind (`voice`: who, text, time), shown in the
transcript as compact lines, so the thread still reads as one history. They are **not** sent to the
back model, with one exception: when the front delegates, the message it sends carries the request
as the user said it, plus anything from the voice exchange the agent needs to make sense of it.

### Two ways to build the front

| | A. Speech-to-speech model | B. Cascade |
|---|---|---|
| Parts | One realtime model (OpenAI Realtime, Gemini Live) does hearing, thinking and speaking | Streaming STT → small text model → streaming TTS, with our own turn detection |
| Time to first sound | about 0.3–0.6 s | about 1–2 s (0.3 endpointing + 0.3 STT + 0.4 first tokens + 0.3 TTS) |
| Interruptions | Built in (server-side voice activity detection, truncation) | Ours to build: voice activity detection in the shell, cancel TTS, drop the unsaid text |
| Models | The realtime provider's only | Any: Haiku, a small GPT, a local model; any STT and TTS |
| Cost | Higher per minute of audio | Lower; near zero with local engines |
| Audio path | Browser ↔ provider directly over WebRTC with a short-lived token the daemon mints; the key stays in the daemon and audio does not pass through it | Browser ↔ daemon ↔ engines |
| Work | Small: session setup, tool plumbing, digester | Larger: streaming STT, endpointing, sentence-chunked TTS, barge-in |

Both sit behind one interface in the shell, so the rest of the system does not care:

```ts
type VoiceSession = {
  start(opts: { instructions: string; tools: ToolDef[]; context: string }): Promise<void>;
  inject(note: string, opts?: { speak?: boolean }): void;     // live updates from the thread
  onTool(name: string, args: unknown): Promise<unknown>;      // delegate, steer, stop, status, …
  onTranscript(turn: { who: "user" | "front"; text: string; final: boolean }): void;
  mute(on: boolean): void;
  end(): void;
};
```

**Superseded:** the user chose B first, local only (see "Decisions" below). The original
recommendation follows for the record.

Recommendation: build **A first** (it meets the latency goal with the least code and tells us
whether the two-layer idea feels right), keep the interface honest so **B** can follow for people
without a realtime provider and for local, private use. B also needs one provider addition: a
streaming one-shot call (`AgentProvider.complete` returns the whole text today).

### Echo and devices

Capture uses the browser's echo cancellation, which is good enough for laptop speakers in WebRTC
mode (A) and passable in B. Headphones remove the problem. Barge-in in B must not trigger on the
front's own voice: gate the voice activity detector while TTS plays unless the input level clearly
exceeds the echo estimate.

### Page API

```js
const voice = await scribe.voice.start({
  instructions,                 // the front's persona and job on this page
  tools: { addCard: { description, parameters, run: async (args) => … } },   // run in the page
  thread,                       // optional: a page agent chat (scribe.agent) to use as the back
});
voice.ontranscript = …; voice.onstate = …;
voice.say(text); voice.inject(note); voice.end();
```

A page gets the front alone (a voice interface to the page's own functions) or the front plus one
of its own agent chats as the back. Permissions: `audio.microphone`, plus a new `audio.realtime`
("Hold a live voice conversation", default ask, risky: it keeps the mic open, and it costs money
by the minute), plus `agent.chat` when a thread is attached. The session shows the same recording
marker and stop control as a capture, and ends when the tab is hidden for more than a grace period.

### Decisions (user's answers on #562)

- **Backend B (cascade) first, local only.** No OpenAI Realtime or Gemini Live. Backend A stays a
  possible later `VoiceSession` implementation but is not planned.
- **Scope:** the front talks only to the thread it was opened on; it cannot start new threads.
- **Approvals:** never by voice. The front says what is waiting; the user clicks.
- **Opening:** not answered; the default stands: voice mode is opened by a click, no wake word.

What "local only" means for each stage. Each is an OpenAI-compatible endpoint the user runs, set up
as a source in Settings → Audio (the custom source type from #714), so no new engine code is needed
per server:

| Stage | Local server examples | Endpoint |
|-------|----------------------|----------|
| STT | whisper.cpp server, faster-whisper-server / Speaches | `/audio/transcriptions` |
| Front model | Ollama, LM Studio, llama.cpp server (a 1–8B instruct model) | `/chat/completions` with `stream: true` |
| TTS | Kokoro-FastAPI, Piper behind Speaches; "This browser" `speechSynthesis` as a no-setup fallback | `/audio/speech` |

Local Whisper servers transcribe whole utterances, not streams. That is fine here: the shell's
voice activity detector ends the utterance (about 300 ms of silence), and a local GPU transcribes a
short utterance in 100–300 ms. The front model's first sentence goes to TTS as soon as it ends, so
the target is about 1 s from end of speech to first sound.

### Steps

1. **R0, spike** (throwaway): a test page that runs the local cascade (VAD → local STT → local
   model streaming → sentence-chunked local TTS) and measures end-of-speech → first sound, each
   stage's share, and barge-in behaviour. Picks the default engines and the VAD settings.
2. **R1**: voice mode on a thread, front only: talk, hear answers from the digest, `status` and
   `read`. No delegation.
3. **R2**: `delegate`, `steer`, `stop`, `answer`, live updates, voice items in the transcript.
4. **R3**: `scribe.voice` for pages.

R0 needs only #567's capture; R1 needs the text-to-speech card (#565) and the mixer (#564), and a
streaming one-shot call on the agent providers or a direct streaming chat call to the local source.

## Order of work

```text
A  chat mic + STT  ─▶  B  page mic + STT
        │
        └─▶  C  playback + cues  ─▶  D  TTS  ─▶  R  realtime (R0 can start once A is in)
```

A builds `src/audio/`, `public/audio.js` capture and the Settings section. B adds the bridge, the
permissions and the indicator. C adds the mixer. D adds `speak`. R reuses all of it.

## Decisions taken as defaults (say so on #562 to change them)

1. Speech engines come from the existing OpenAI-compatible sources; no browser speech recognition
   (it works only in Chrome and Edge, not in the desktop app's WebView2, and sends audio to Google
   or Microsoft without saying so) and no local Whisper pack in the first cut.
2. The shell captures; pages get text or a finished clip, or the live stream relayed by the shell
   behind the separate, risky `audio.microphoneStream` permission (B2). Pages never get `getUserMedia`.
3. Dictation inserts text and does not send it, unless the user turns "Send after dictation" on.
4. Record-then-transcribe first; live partial transcripts come with phase R's streaming work.
5. Notification sounds are off until the user turns them on.

## Live transcription (#832, experimental)

Each speech-to-text source has a **Live transcription** setting: Off (default), **Server stream**, or
**Sliding window**. With it on, the composer streams the recording while the user speaks instead of
uploading one clip at the end, and (with **Show text while dictating**) shows the text so far above the input.

- The shell resamples the microphone to 16 kHz mono 16-bit PCM and sends it in 100 ms messages over
  `WS /api/audio/stream?preview=0|1` (board origin only). The daemon answers `ready`, `text` (the whole
  text so far) and `done` (`{ ok, text }` or a typed failure). Keys stay in the daemon.
- **Server stream** proxies to the source's own stream, `{baseUrl}/stream?rate=16000` (Moonshine's
  protocol: lines with partial and final text, `stop`, `done`). Line ids are 64-bit, so they are read
  from the raw JSON text. Measured on the Moonshine server: the same transcript as an upload, about 30 ms
  after stop instead of about 2 s for an 11 s clip.
- **Sliding window** is for upload-only sources (Qwen3-ASR on llama.cpp, Whisper servers). The daemon cuts
  the recording at pauses (≥ 500 ms after ≥ 1.5 s of audio, or at the quietest point near 25 s), so no word
  straddles a cut and pieces need no overlap. Finished pieces are transcribed while the user goes on
  speaking; on stop only the last piece is left. With the preview on, the open piece is re-transcribed
  every 1.5 s and settles when it is cut. Leading silence is never sent. Pieces lose context across a
  cut, which can cost some accuracy compared with one clip.
- If the stream fails, the shell still has the recording and sends it as one WAV clip.
- Pages (#841): `scribe.audio.listen` streams the same way when the default source has live transcription on,
  sends `ontext` with the text so far and reports `session.live`; `live: false` keeps one upload. The shell adds
  `tab=` to the socket, and the daemon runs the page's `audio.transcribe` permission and rate limit before it
  opens the stream, as for page uploads. Denied or rate-limited streams do not fall back to an upload.
