# Board suggestion evaluation — 17 October 2026

The real-model pass is complete; user accept/dismiss review is pending. Keep
`SUGGEST_YES = 0.75` and `SUGGEST_PRIORITY = 0.6` until that review provides an
answer key. Results and the review form: `scribe:board-suggestion-results-634`.

## Method

- Snapshot of Scribe Todo (`scribe:agent-todo`), taken before model calls.
- Deterministic, evenly spaced card-number sample within saved priority strata:
  10 low, 10 medium, 10 high, six unspecified. No urgent cards were available.
  Archived cards and #634 were excluded. Includes completed cards and retrospective
  descriptions, so it is not a fresh-card benchmark or representative traffic sample.
- Removed By Agent on the copy. The remaining nine labels have no descriptions.
- Hid all assignments on each evaluation copy; asked the template's questions with
  its 8,000-character description limit. Evaluated the top three labels per card.
  This simulates entirely unassigned cards; live cards with assignments may receive
  different chips because assigned labels are excluded before the top-three cap.
- Explicit source `h2o-lightning-4b` at `http://127.0.0.1:10000`, through the real
  MlService/Jev adapter, cache disabled. No fake answers, live board edits, settings
  writes, or changes to the running daemon's usage counters. Settings and send
  switches were respected; credentials are not in the artifacts.
- 36/36 calls succeeded; 360 questions; reported input tokens 101,284;
  upper-middle median latency 254 ms and nearest-rank p95 411 ms.

## Label cutoff sweep

| Cutoff | Offered, cap three | Already assigned | Saved assignments missed (of 26) |
| --- | ---: | ---: | ---: |
| 0.50 | 47 | 11 | 15 |
| 0.60 | 27 | 9 | 17 |
| 0.65 | 18 | 9 | 17 |
| 0.70 | 13 | 8 | 18 |
| **0.75** | **8** | **7** | **19** |
| 0.80 | 5 | 4 | 22 |
| 0.85 | 4 | 4 | 22 |
| 0.90 | 0 | 0 | 26 |

Already assigned is agreement, not measured precision: unassigned labels are not
known negatives. Seven of eight current-cutoff suggestions recover saved labels.
The eighth, Design for #347 (animated mockups), looks reasonable but still needs
user judgment. Dropping to 0.6 adds 19 suggestions and recovers two additional saved
assignments. There is no evidence yet that the other additions are acceptable.
Security on #483 is missed despite its explicit out-of-workspace approval problem;
global threshold changes cannot repair all ranking errors.

## Priority cutoff sweep

| Cutoff | Offered | Match saved triage | Details |
| --- | ---: | ---: | --- |
| 0.50 | 3 | 1 | Adds #578 medium (saved low), probability 0.516 |
| **0.60** | **2** | **1** | #313 low, 0.633 (saved low); #69 urgent, 0.674 (saved high) |
| 0.65 | 1 | 0 | #69 urgent only |
| 0.70 or higher | 0 | 0 | All abstain |

Saved priorities may encode user importance absent from card text. They are not
accepted classifier outcomes. Few offers and no urgent reference cards make
priority tuning especially weak here.

## Required review

The background page shows all 36 card texts and scores, with 29 explicit review
choices: 27 top-three label offers at 0.6 and two priority offers at 0.6. Current
threshold offers are marked. It stores accept/dismiss/unsure judgments and freeform
notes, then replies to #634. No decision is preselected. Partial reviews are allowed.
Use those outcomes to compare candidate precision at 0.6–0.85, and review the saved
assignments missed before claiming recall. Outcomes remain user input, not model
self-evaluation.

The live board has no `suggest.no` dismissals. The template discards acceptance
provenance and proposal scores, so historical assignments cannot establish actual
acceptance rates. New design card #696 tracks this limitation.

## Reproduce

```powershell
npx tsx tools/eval-board-suggestions.ts --input tools/fixtures/board-suggestions-634.json --out tools/fixtures/board-suggestions-634-results.json --source h2o-lightning-4b
```

Add `--dry` to inspect the selected source/count without model calls; `--data <dir>`
selects a separate settings folder. The source is explicit to avoid silently using
a changed default. Results are checkpointed after each card, including failures.
The JSON contains every normalized probability, original held-out assignment,
question, returned model name, latency and reported usage. Model calls can differ
on rerun; these numbers describe the committed run only.

Validation: `npm run build`; strict standalone TypeScript check of the evaluator;
36 real-source calls and arithmetic over the stored answers. No production code or
threshold was changed.
