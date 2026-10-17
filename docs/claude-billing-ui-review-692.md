# Claude billing UI review (#692)

Investigated 2026-10-17 from the two card screenshots, current source, and
commit `bf8ee7d` (Fix Claude billing source, extra usage and cumulative accounting).
No product changes or live account probes. Decision form: Scribe page
`scribe:claude-billing-review-692`, linked from #692.

## Recommendation

Simplify the UI rather than revert the whole change. The screenshots show mostly
account metadata and negative/unknown states, which add little to routine quota
checking. Remove these from the quota hover and remove the settings billing
disclosure. Keep actual extra-usage spending/cap when reported and a recent
positive overage warning. Keep quota availability and stale/reset warnings.
Remove the routine route prefix from an available Claude quota chip; keep its
percentage. Source metadata can remain in the turn estimate's intentional cost
detail without repeating email/organization in routine quota UI.

This proposal awaits the user's scope choice; nothing has been removed yet.

## What the change actually does

| Part | Value beyond the screenshots | Recommended treatment |
| --- | --- | --- |
| Account/backend/auth text | Helps diagnose API, cloud or unexpected-account routing; does not prove which balance paid | Remove from routine quota display; retain recorded metadata |
| Disabled extra usage, unknown paid-credit use, unavailable Console balances | Describes limitations but supplies no balance or actionable amount | Remove routine boilerplate |
| Billing-period extra spend/cap | Can show real spending even when utilization is null | Keep when concrete amounts are reported; never call it a remaining balance |
| Recent `isUsingOverage` event | Distinguishes a request using extra usage from historical spend | Keep a recent positive warning; omit routine negative/unknown text |
| Per-query quotas | API/project credentials cannot inherit another thread's subscription meter; settings use a separate default query | Keep |
| Cumulative SDK accounting | Converts running totals into turn deltas, handles resume/reset/missing baseline and avoids separately counting child results | Keep |
| Estimate labelling | SDK dollars are estimates, not actual charges | Keep |
| Observed reset values | Avoids fabricating zero utilization after a reset | Keep |
| Removal of Claude quota-delta pricing | Account usage from other apps no longer masquerades as this turn's cost | Keep |

For example, cumulative SDK results of $1 then $1.50 previously summed to $2.50;
the delta logic records $1 then $0.50 when a valid zero baseline exists. A full
revert would restore the old aggregation along with the simpler UI.

## Source evidence

- `public/agent.js`: `claudeSourceLabel`, `claudeQuotaNotes`, `usageChip`,
  `usageMeters`, and `ChatView.renderTurnFooter` generate the relevant display.
  The Console-balance statement is unconditional text, not a failed balance API.
- `src/agent/claudeUsage.ts`: metadata filtering, quota snapshots, and
  `ClaudeUsageDelta` are separate from presentation.
- `src/agent/providers/claude.ts`: reads active-query `accountInfo()` and usage
  baselines, emits per-thread snapshots, and consumes cumulative result deltas.
- `src/agent/host.ts`: isolates thread quotas, clears legacy provider quota,
  uses thread-specific reset information, and disables Claude quota-delta pricing.
- `src/agent/planLimits.ts`: retains extra spending separately from live overage.
- `src/agent/claudeUsageUi.test.ts`: existing synthetic coverage distinguishes
  API/cloud quotas, spend, stale/active overage and estimated dollars.
- `docs/claude-billing-usage-audit.md`: earlier audit and implementation context.

## Implementation boundary after the decision

For the recommended simplification, change presentation in `public/agent.js` and
adjust the existing focused UI test. Preserve backend parsing, query isolation,
delta accounting and historical data. Validate with the focused UI test and JS
syntax check. Removing all extra-usage UI is also feasible without reverting
those correctness fixes.

This review used source inspection; it does not establish actual charges or
validate a live account's reported amounts. No runtime tests were run because
this branch changes documentation only.
