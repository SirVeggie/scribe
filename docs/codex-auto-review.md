# Codex auto-review presentation

Allowed native reviews do not add chat notices. Tool activity still appears normally.
Denied reviews show one warning naming the action and a compact rationale. Timeouts,
aborted reviews, and unknown outcomes show one error. Notices are deduplicated by
review ID within each turn; separate reviews of the same tool remain separate.

Full started/completed payloads and unstructured guardian explanations are retained
in the Scribe data directory's `daemon.log`. Search for `Codex Auto-review` and the
`scribeThreadId`, native `threadId`, `turnId`, or `reviewId`. Entries include the full
action, rationale, risk level, authorization assessment, and timestamps provided
by Codex. Long commands and rationales are only shortened in chat.

Unstructured `guardianWarning` explanations stay in diagnostics because they also
repeat the allowed/denied decisions shown by structured review notifications.
Completed denials offer a human-only approval prompt with the action, directory,
risk and rationale. Approve one retry records the native denial override and
starts a new turn to retry the approved action through Auto-review. Deny,
cancellation, disconnection or an override error cannot start a retry. Pending
human decisions survive native turn completion or failure. Full and Edits do not
automatically grant these overrides; Pages retains its tool refusals.

Auto-review uses the native `auto_review` reviewer with `on-request` policy. Ask
uses the `user` reviewer; Full retains `never`. Each mode keeps its sandbox
boundary. Native review applies to eligible actions requiring approval; actions
already allowed by the sandbox run normally.
