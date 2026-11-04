# Page services: microphone, classifier, files

Builds on `SKILL.md` in this folder (showing and patching pages, theme, page kit): read that first if you have not.

## Microphone and speech-to-text: scribe.audio

Scribe owns the microphone; pages receive text, a finished clip, or a relayed live stream.
`scribe.audio.listen`, `scribe.audio.record` and `scribe.audio.stream` require a click every time and a visible page.
Listen asks once for `audio.microphone` and `audio.transcribe`; record asks only for the microphone.
Stream asks only for the separate, riskier `audio.microphoneStream` permission: the page receives
every sample while it runs. All microphone permissions default to ask and reset when an agent rewrites the page's code.

```js
const session = await scribe.audio.listen({ language: "en", prompt: "Names used here", maxMs: 30000 });
if (session.ok) {
  session.onlevel = value => { meter.value = value; }; // 0..1, about 15 updates/second
  session.onstate = state => { status.textContent = state; };
  session.ontext = text => { draft.textContent = text; }; // text so far, only when session.live
  // From a Stop button:
  const result = await session.stop(); // { ok, text, error?, permission? }
  // Or discard: await session.cancel();
}
const rec = await scribe.audio.record({ maxMs: 30000 });
if (rec.ok) {
  const clip = await rec.stop(); // { ok, blob, mimeType, durationMs }
  if (clip.ok) await scribe.audio.transcribe(clip.blob, { language: "en" });
}
const caps = await scribe.audio.available(); // { mic, stt, reason? }
```

When the user's speech source has **Live transcription** on, `listen` streams like dictation:
`session.live` is `true`, `ontext` gets the whole text so far while the user speaks, and `stop()`
resolves with the final text sooner. Pass `live: false` to always send one clip at the end.

For visualisers or your own processing, `scribe.audio.stream` returns a real mono `MediaStream`
inside the page at `live.sampleRate`, relayed from the shell with about 60 ms of buffering:

```js
const live = await scribe.audio.stream({ maxMs: 30000 });
if (live.ok) {
  const context = new AudioContext({ sampleRate: live.sampleRate });
  const analyser = context.createAnalyser();
  context.createMediaStreamSource(live.stream).connect(analyser);
  live.onend = reason => { void context.close(); }; // stopped | hidden | max | user | revoked
  // From a Stop button: await live.stop();
}
```

The stream stops its tracks and closes its playback context when it ends. `stopped` means the
page called `stop()` (also close/reload), `hidden` means the page or shell became hidden, `max`
means the time cap, `user` means the shell stop control or device ended, and `revoked` means
permission was withdrawn. A handler assigned just after an early end still receives its reason.
Do not request iframe microphone delegation; only the shell opens the device.

`scribe.audio.transcribe` needs `audio.transcribe`; granted uploads do not need a click.
With a hosted speech source, audio leaves this PC. Pages can send audio Blobs up to 25 MB;
each page is limited to 6 transcriptions/minute and 60/hour. Choose the source in Settings → Audio.
All calls resolve, including failures: `{ ok: false, error, permission? }`, such as `denied`,
`no_gesture`, `no_source`, `no_mic`, `busy`, `cancelled`, `rate_limited` or `too_large`.
A failed start returns that object instead of a session. Captures cap at five minutes, with a
shell recording marker and Stop recording button. Hiding, closing or reloading the page cancels
its session; the shell Stop button and time cap finish the clip. Call `stop()` to collect the
result even when capture ended automatically. Handle failure before reading the transcript or clip.

## Asking the classifier: scribe.ml

A page can put small typed questions about its own text to the classifier the user set up (Settings → Classifier): which labels fit a card, how urgent a note is, whether an entry belongs in a list. It answers in well under a second and costs far less than an agent chat, so use it for sorting and suggesting, not for writing text.

```js
const caps = await scribe.ml.capabilities();
// { ok, available, reason?: "denied" | "disabled" | "no_source", permission: "allow" | "deny" | "ask",
//   types: ["yesno", "choice", "score"], limits: { stateChars, questions, perMinute, perHour } }
const result = await scribe.ml.decide({
  state: { title: card.title, description: card.description },   // text, or a small object or array
  questions: {
    bug: { type: "yesno", instructions: 'Should this card have the label "Bug"?' },
    priority: { type: "choice", instructions: "How urgent is this?", options: { unspecified: "It does not say", low: null, high: "Should be done soon" } },
    effort: { type: "score", instructions: "How much work is it?", levels: ["minutes", "hours", "days"] },
  },
});
if (result.ok) result.answers.bug;   // { type: "yesno", yes: 0.93 }
```

- Answers come back under the question ids: `{ type: "yesno", yes }` (probability of yes), `{ type: "choice", choice, probabilities, confidence }`, `{ type: "score", score, probabilities, confidence }` (1 is the first level; it can fall between levels). Pick your own thresholds, and give a choice an option for "it does not say" so the classifier is not forced to pick.
- `decide` never rejects. A failure is `{ ok: false, error, message }` and the page carries on without an answer: `denied` (no permission), `disabled` (Pages is off in Settings), `no_source` (no classifier set up), `input_too_large`, `rate_limited` (with `retryAfterMs`), `busy`, `invalid_request`, `timeout`, `unavailable`. Do not retry in a loop.
- It needs the page's `ml.decide` permission (asks by default). `decide` itself never prompts, so it can run from `scribe.onChange`: ask up front, inside a click, with `scribe.permissions.request("ml.decide")` (a switch in the page's settings is the usual place), and show `capabilities().reason` when it would not go through.
- Limits per page: 20,000 characters of state, 32 questions a call, 30 calls a minute and 300 an hour, two calls at once. Send the one card or note being judged, not the whole state. Ask about several things in one call rather than one call each.
- The page never learns which source or model answered, and cannot pick one. With a hosted source the text leaves this PC, which is what the permission tells the user.
- Treat an answer as a suggestion: show it and let the user take it (the Kanban board's label and priority chips), and check that the thing asked about has not changed before you store the answer. Every open window runs the page's code, so write the result in a way that is safe to repeat.

## Files in a folder: scribe.files

A page's own code can read and save files on disk, only in folders the user approved for that page, each at **Read**, **Write**, or **Read & write** (permission `files`, risky, asks by default). Write only saves without seeing what is there: generated images, a log. Use it when output belongs in the user's folder; keep page data in state and page-owned uploads in assets.

```js
// In a click: the user picks a folder (or pass one) and approves it at that access.
const { granted, folder } = await scribe.files.request({ access: "write" });   // or { folder, access }
if (granted) scribe.set({ outDir: folder });

await scribe.files.write(scribe.files.join(state.outDir, "2026", "shot.png"), blob);  // string, Blob, ArrayBuffer, typed array
await scribe.files.write(scribe.files.join(state.outDir, "run.log"), line + "\n", { append: true });
const { text } = await scribe.files.read(file);                    // { as: "blob" } → { blob }, "arrayBuffer" → { buffer }
const { entries } = await scribe.files.list(dir);                  // [{ name, kind: "file" | "directory", size, mtime }]
await scribe.files.stat(file); await scribe.files.remove(file);    // remove: a file or an empty folder
const { folders } = await scribe.files.folders();                  // [{ path, access }]
```

- Paths are absolute. `write` makes missing folders; `{ overwrite: false }` fails with `exists`. read, list and stat need Read; write and remove need Write. Up to 32 MB a file.
- Calls never prompt, so they work from the page's own code (after an agent run, in `onChange`). They resolve `{ ok: false, error, message }`: `permission` (no folder covers the path at that access: ask with `request` in a click), `denied`, `not_found`, `exists`, `invalid_path`, `too_large`. Show it on the page; don't retry in a loop.
- Links inside a folder cannot lead out of it, and another page cannot use this page's folders. Agents you start from the page still need their own `cwd` approval (`agent.workspace`): a Read-only worker can make the images and the page saves them.
