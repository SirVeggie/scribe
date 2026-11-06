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
matcher; leftmost-longest, non-overlapping). Messages a page, component, hook or Scribe sends into
a chat (card prompts, card comments) are redacted in `AgentHost.send`; the person's own composer is
not.

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

## Not covered yet

- Values written differently: HTML entities (`&amp;`), JSON escapes, other casing.
- Images and assets.
- Thread counts in vault_list; provider transcripts on disk (#1041).
- An agent with filesystem access reading `scribe.sqlite` directly (pages keep values in plain
  text there; see src/callers.ts).
- The user's UI for reviewing and removing fragments (the routes are there).
