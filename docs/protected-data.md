# Protected data (#1045)

Fragments of text no model reads: passwords, keys, private names. Decided in #1037: no model
reads values through the vault (not even trusted ones), and fragments agents add apply at once;
the user reviews them later.

## Store

`protected_fragments` in `scribe.sqlite` (src/schema.ts): id, hint, kind, source
(user | agent | detector), detector, creator, thread, date, and `sealed`, the value encrypted with
AES-256-GCM. The key is kept by the OS: DPAPI on Windows (`vault/master.dpapi`), the macOS
Keychain, libsecret on a Linux desktop, else a 0600 key file (`vault/master.key`);
`vault/key.json` records which (src/plugins/secrets.ts `loadMasterKey`). An empty vault never
touches the key. If the key can't be read, the daemon refuses every agent call (503) rather than
hand out values it can no longer redact.

## Reads

`redactAgentResponses` (src/vaultHttp.ts) wraps `res.json` / `res.send` for every agent caller
(`identify(req).viewer === "agent"`: chats' MCPs, external clients, other devices' chats). Its MCP
child only ever gets redacted text, so page_read, page_grep (it greps the redacted page),
page_state, page_action, thread_read/list, helper reports, library_search snippets and file-page
text are all covered. Each match becomes `⟦p:<id> <hint>⟧` (src/vault.ts, one Aho–Corasick
matcher; leftmost-longest, non-overlapping). Messages into a chat are redacted on their way to
the provider (#1048, below).

Search: `pageText` (words search, palette) and the semantic chunker redact before matching or
indexing, so a query can't find a page by a value. A vault change re-indexes; unchanged chunks
keep their vectors.

## Writes

`restoreAgentBodies` runs after the body parsers: tokens in an agent's request become their values
before any route sees it, so page_patch's `oldString` matches against the redacted view and a token
patched around keeps its value. An unknown token, one with another hint, or one cut short is a
400 with a clear error, never saved.

## Agent tools

- `protect { value, hint?, kind? }`: POST /api/vault/protect. Agents: at least 6 characters, not
  a common word, has a letter or digit, and on at most 25 pages (so an injected "protect `the`"
  can't scramble pages).
- `vault_list`: GET /api/vault, metadata only, with how many pages the caller can see hold each.
- DELETE /api/vault/:id is the user's only.

## Secret references (#1049)

Agents can use or point to a value without reading it.

- **Show to the user:** `vault_show { id | query, note? }` (POST /api/vault/show) adds a `secret` item
  to the chat's running turn holding the fragment's id and hint, never the value. The chat card
  stays blurred; the first click fetches GET /api/vault/:id/value, which only the board UI may call
  (not agents, page scripts on their own origin, or other devices). The tool answers `{ shown }`. A
  query that fits several hints returns their ids to pick from instead of guessing.
- **Scribe's own calls** (pages, plugin_call args, card updates): restoreAgentBodies swaps tokens in
  every agent request and redactAgentResponses scrubs the answer (#1045), so plugin backends get the
  value and the agent gets tokens back.
- **Provider tools** (src/agent/secretRefs.ts): in a shell command, a token becomes
  `${SCRIBE_SECRET_<id>}` (`$env:SCRIBE_SECRET_<id>` in PowerShell), and the agent may write that
  variable itself. In any other tool's input, tokens become their values. Output comes back with
  values as tokens. Scribe's own MCP tools and web tools are left alone (the daemon handles the
  former; values should not go to a search engine).

| Provider | Input | Output |
|---|---|---|
| Claude | PreToolUse `updatedInput`: the command starts with `export SCRIBE_SECRET_<id>='…'`. The model's own tool call keeps the token; permission checks see the rewritten call, so the approval card redacts it and drops "always allow" (the rule would save the value). | PostToolUse `updatedToolOutput`, every tool: Bash, Read, Edit, other MCP servers. |
| Native (Pi) | `tool_call` hook, after Scribe's approvals: Pi hands hooks a copy of the arguments, so its session keeps the token. The chat shows the call redacted. | `tool_result` hook replaces content and structured content. |
| Cursor | Only Scribe's host shell (when approvals are on): the variables are set on the command's process alone, not in the command line. Cursor's built-in shell and file tools have no hook that can change input. | Host shell output is scrubbed. Built-in tools: not possible. |
| Codex | Not possible: the app-server's approvals can accept or decline a command, not change it. | Not possible for its own tools. Scribe's MCP tools are still redacted. |

The instructions mention tokens only once the vault holds something; the swap sentence only on
Claude and Native.

Limits: this keeps values out of the model's context by accident, not against an agent set on
reading them. A command can print a value in another form (base64, split up) that the scrub can't
recognise, and a page script or plugin given a value can pass it on. The swapped-in value is in the
command line of the provider's shell process while it runs (Cursor's host shell excepted), and Claude
Code may keep the raw tool result in its own session files.

## Detectors (#1047)

src/detectors.ts: regexes for secret formats with a low false-flag risk. Built in: Anthropic and
OpenAI keys, GitHub tokens, AWS access key ids, Slack tokens, Google API keys, Stripe live keys,
PEM private keys, JWTs (the header must decode to JSON with `alg`). Email and phone detectors
exist but are off until the user turns them on.

- A match becomes a fragment with `source: detector`, `detector: <id>` and the detector's hint.
  Matches go into the vault in memory at once and are sealed and saved once the key is ready.
- Where they run: inside `Vault.redact` (so anything handed to an agent is checked, wherever it
  came from), on page writes (debounced, src/http.ts `watchPagesForSecrets`), and on thread items
  as they are saved (user and agent text, finished tool calls; src/agent/host.ts `detectInItem`).
  Provider tool output goes through the vault even while it is empty (secretRefs `scrubOutput`),
  so a key a command prints reaches Claude and Native models as a token.
  Streaming text skips a match that ends the text, until more arrives.
- Unflag: the user removing a fragment. Its value's SHA-256 goes into `protected_unflagged`, so no
  detector flags it again; removing a detector-made fragment also counts against that detector.
- `protected_detectors` keeps each detector's switch, matches, unflags and change history, and
  custom detectors' definitions. False-flag rate = unflags / matches; at 30 % or more after 4
  matches Settings -> Protected data suggests turning it off.
- Agents: `vault_list` includes the detectors and their rates. `detector_propose` (add, edit,
  enable, disable, remove) asks the user in the chat, with the regex and masked sample matches
  from the pages; the change records the agent as its author. Built-ins only switch on and off.
  Patterns must compile, can't match empty text or nest quantifiers (`(a+)+`; JavaScript regexes
  can't be stopped), and a proposed one matching over 200 values in the pages is refused.

## The user's views (#1046)

- Settings → Protected data (public/protected.js): every value with its hint, kind, source, who added
  it and when, and the pages that hold it; masked until Show. Edit changes hint, kind or value
  (PATCH /api/vault/:id); Delete removes it. Both only change what agents read from then on.
  GET /api/vault/values and PATCH answer the board window on this device only (`ownWindow`), like
  #1049's reveal.
- Blurred spans (public/protected-mark.js): the board window marks text matching a value (chat
  transcripts, the strip, the Library) and a click reveals it; [data-scribe-protect-skip] opts out.
  Built-in pages (Kanban, Todo, file pages) call `scribe.protect.watch(root)` from the bridge, which
  fetches GET /api/tabs/:id/protected: only the values in that page's own text, so a page learns
  nothing it doesn't hold. The board sends `vault` events; pages refetch on them and on state changes.
- Right-click: a span gets Edit hint and Unprotect; selected text (in a chat or any page) gets
  Protect selection, which asks for a hint and kind. Pages send the span id with their
  scribe-context-menu message; the board shows the menu and does the call.

## Messages to the provider (#1048)

The only point where Scribe keeps a value from the provider itself: everything a chat sends it.

- `promptText` (src/agent/host.ts) redacts the whole prompt: the user's text, inlined text files, the
  rewind recap, context chips, page guides and page edits. The transcript item keeps the text as
  written, so the user's own view shows the value (blurred, #1046) and other chats reading the thread
  get tokens through the HTTP redaction. The same goes for board prompts and card comments, page and
  hook messages, helper briefs (from: "agent"), provider slash commands, fork summaries and the
  utility `complete` calls, and every classifier request (src/ml/service.ts `decide`).
- Redacting runs the detectors, so a detected secret is protected the moment it is sent.
- The composer (public/agent.js `protectedHits`) asks POST /api/vault/check { text, files } before it
  sends (board window only, like the reveal). Nothing is protected by the check. On a hit it shows one
  line: the hints, then **Send as ⟦p:…⟧** (vault hits) or **Protect & send** (detector hits), and
  **Send as is**. Enter again takes the first. Editing the text drops the chip.
- Send as is (`asIs` on the message) sends the text and files as written; only the composer can ask
  for it (a page's message never), and editing a queued message drops it. The recap, chips and
  guides are still redacted. A detected value sent as is is still protected for later reads (the
  transcript item's detection); unprotect it in Settings if it was a false flag.
- Not redacted: PDFs and images sent to the provider as documents.

## Not covered yet

- Values written differently: HTML entities (`&amp;`), JSON escapes, other casing.
- Images and assets.
- Thread counts in vault_list; provider transcripts on disk (#1041).
- An agent with filesystem access reading `scribe.sqlite` directly (pages keep values in plain
  text there; see src/callers.ts).
- Blurring in custom HTML pages (only built-in views call `scribe.protect.watch`), and values split
  across elements (a match must sit in one text node).
