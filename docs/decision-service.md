# Decision service (`src/ml/`)

Card #516, the first piece of the intent-detection design (`docs/intent-detection-hooks-design.md`). One daemon function that asks a classifier small typed questions about a piece of state. Its callers so far: thread hooks (feature `hooks`), the page-creation hint (feature `page-intent`, `src/agent/pageIntent.ts`) and the check of search results (feature `search-rerank`, `src/search/rerank.ts`, described in `docs/semantic-search-index.md`).

## Calling it

```ts
import { mlService } from "./ml/service.js";

const result = await mlService().decide(
  "Make me a page that tracks my reading list",      // state: text, an object or an array
  {
    page: { type: "yesno", instructions: "Does answering this need a new Scribe page?" },
    needs: { type: "choice", instructions: "What does the message need?", options: { read: "Only reading", edit: "File edits", shell: null } },
    risk: { type: "score", instructions: "How risky is this?", levels: ["harmless", "needs care", "dangerous"] },
  },
  { feature: "page-intent", sends: ["messages"], timeoutMs: 500 },
);
if (result.ok) result.answers.page;   // { type: "yesno", yes: 0.93 }
```

- `decide` never throws. A failure is `{ ok: false, error, message, ms }` and the caller carries on without an answer. `error` is one of `no_source`, `disabled`, `not_allowed`, `invalid_request`, `input_too_large`, `unauthorized`, `rate_limited`, `busy`, `timeout`, `unavailable`, `invalid_response`.
- Answers come back under the question ids: `{ type: "yesno", yes }` (probability of yes), `{ type: "choice", choice, probabilities, confidence }`, `{ type: "score", score, probabilities, confidence }` (the score is probability-weighted and can fall between levels; 0 is the first, and `probabilities` is keyed "0" to levels − 1, as llama.cpp and Jev both answer). `confidence` comes from the whole distribution and is not the probability of the chosen option.
- Options: `source` (id; the default source otherwise), `feature` (refused with `disabled` while its switch is off), `sends` (what the state holds: `messages`, `agentText`, `toolCalls`, `toolResults`; refused with `not_allowed` when one is switched off in Settings), `timeoutMs` (default 5000, at most 30000; it covers queueing and retries), `cache: false`.
- Limits: 32 questions per call, 120,000 characters of state, 2–255 choice options, 2–10 score levels. At most 4 calls are at a backend at once and 32 more may wait (`busy` beyond that). Identical requests are answered from a cache for 5 minutes (200 entries) and share one call while in flight.
- A feature adds itself to `ML_FEATURES` in `src/ml/settings.ts` (`{ id, label, hint, default }`) and gets its switch in Settings → Classifier.

## Pages (`scribe.ml`, card #521)

A page asks through its bridge: `scribe.ml.decide({ state, questions, timeoutMs? })` and `scribe.ml.capabilities()` (`src/bridge.ts`). The shell (`onPageMl` in `public/app.js`) passes the call on for the page whose frame asked, to `POST /api/ml/pages/:id/decide` and `GET /api/ml/pages/:id/capabilities`; tab pages cannot reach `/api/ml` themselves and agents are refused. `src/ml/page.ts` is the gate in front of `decide`:

- The page needs the `ml.decide` page permission (`src/pagePermissions.ts`, default Ask, not reset when an agent edits the page: it can only send what the page already holds, to the user's own source). `decide` never prompts; a page asks with `scribe.permissions.request("ml.decide")` inside a click. Without the grant the result is `{ ok: false, error: "denied", permission: "ml.decide" }`.
- Feature `pages` (Settings → Classifier → Pages, on by default) switches it off for every page.
- Limits per page: 20,000 characters of state, 30 calls a minute and 300 an hour (`rate_limited` with `retryAfterMs`), two calls in flight (`busy`), a timeout of at most 15 s. The service's own limits (32 questions, the shared four slots, the cache) apply after that.
- The result is `{ ok, answers, cached, ms }`: no source id, model or usage.

Its first user is the Kanban board's "Suggest labels and priority" setting (`templates/builtin/kanban.html`, "suggested labels and priority"): the page watches its state for cards that are new or whose title or description changed, asks one yes/no question per label the card lacks and one choice for the priority, and keeps the answer on the card as `suggest` for the user to accept or dismiss. It runs only while the board is open in a window; an answer for text that has since changed is dropped.

## Sources

A source is a Jev-API endpoint: name, base URL, API key, model. The adapter (`adapters/jev.ts`) posts `{ model, state, questions }` to `{baseUrl}/v1/systemone` with a Bearer key and retries 429 and 529 twice with backoff (or the server's `Retry-After`). A local source is any server that speaks the same API at another base URL. One source is the default.

Sources and switches are in `ml-settings.json` in the data folder; today's counters in `ml-usage.json`. A key never leaves the daemon: the routes return `hasKey` only, and pointing a source at another host clears its saved key unless a new one is sent with it.

`SCRIBE_FAKE_ML=1` makes the daemon answer from `adapters/fake.ts` (no network), like `SCRIBE_FAKE_AGENTS` for agents. Tests build their own `new MlService({ store: memoryStore(), adapter: fakeAdapter() })`.

Set `SCRIBE_FAKE_ML_ANSWERS` before starting a fake daemon to a JSON object of Jev answers keyed by question id. For board suggestions, for example:

```powershell
$env:SCRIBE_FAKE_ML = '1'
$env:SCRIBE_FAKE_ML_ANSWERS = '{"label0":{"noul":0.9},"priority":{"choice":"high","probabilities":{"unspecified":0.05,"low":0.05,"medium":0.05,"high":0.8,"urgent":0.05},"confidence":0.7}}'
npm start
```

Unspecified ids keep the default fake answer (yes 0.5, first choice, lowest score). Invalid JSON or an answer incompatible with its question returns `invalid_response`. Restart to change answers; the usual service cache still applies. Tests can pass the same JSON as `fakeAdapter({ script })`; `adapter.answers` takes precedence.

Board labels can carry `description` and `neverSuggest` (editable in Labels). Descriptions appear in chip tooltips and label questions; `neverSuggest: true` excludes a label from questions and hides its pending suggestions. Existing boards need their saved HTML updated to use these controls.

## Routes (`/api/ml`, board shell only)

| Route | Does |
|---|---|
| `GET /settings` | `{ sources, defaultSource, features, send, usage }` |
| `PUT /settings` | `{ defaultSource?, features?, send? }`; only what is named changes |
| `POST /sources`, `PUT /sources/:id`, `DELETE /sources/:id` | Add, change (`apiKey: ""` clears the key), remove |
| `POST /sources/:id/test` | One short made-up question through the source; always 200 with a decide result |
| `GET /usage` | Today's `calls`, `cached`, `failed`, `inputTokens`, `outputTokens`, and `latency` (`last`, `median`, `p95` in ms since the daemon started) |
| `GET /pages/:id/capabilities`, `POST /pages/:id/decide` | `scribe.ml` for the page `:id`, see Pages above; always 200 for a known page |

## Latency

Not measured yet against the real API. Every backend call logs `ml decide { source, model, ms, questions, feature, inputTokens }` to the daemon log, and Settings → Classifier shows the last, median and 95th-percentile time, so later cards can set their time budgets from real numbers.
