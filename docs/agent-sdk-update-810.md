# Agent SDK update — 24 October 2026

All seven direct agent/API/MCP SDK dependencies now use the npm `latest` releases checked on this date. The existing caret-range policy is retained; package-lock.json pins the tested versions. This report covers changes since the previous locked versions, with emphasis on Scribe's integrations rather than every upstream CLI feature.

| Package | Previous | Updated |
| --- | --- | --- |
| @anthropic-ai/claude-agent-sdk | 0.3.296 | 0.3.310 |
| @openai/codex-sdk | 0.162.0 | 0.164.0 |
| @cursor/sdk | 1.0.35 | 1.0.40 |
| @earendil-works/pi-coding-agent | 1.0.3 | 1.4.0 |
| @earendil-works/pi-ai | 1.0.3 | 1.4.0 |
| @anthropic-ai/sdk | 0.130.0 | 1.3.0 |
| @modelcontextprotocol/sdk | 1.31.0 | 1.32.2 |

## Claude Agent SDK

Notable fixes include preserving host-managed hook restrictions, keeping dynamically supplied MCP servers from being overwritten by user settings, better startup timeouts during hooks, Unicode transcript imports, model changes while quota-limited, and refusal handling for structured output. New APIs include per-tool MCP permission policies, loading additional plugins into an existing query, richer context-usage identifiers, and scheduled-task wakeup metadata. Browser integrations gain SSE suspend/resume and dialog capability declarations.

Behavior changes to review: fork subagents are enabled by default; models that cannot disable thinking now use adaptive thinking; hook-supplied updated input is validated and unknown keys removed. The default for an omitted permission mode changed, but Scribe already supplies an explicit mode. New SDK APIs do not automatically become Scribe controls.

Source: [upstream changelog, 0.3.297–0.3.310](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md).

## Codex SDK

An npm package diff from 0.162.0 to 0.164.0 found only package.json changes: the SDK version and its exact @openai/codex dependency. The published TypeScript wrapper and declarations are unchanged; the bundled CLI advances to 0.164.0.

The official OpenAI documentation's 0.164.0 notes highlight safer compaction failure recovery, compressed-history resume and restored thread settings, Windows proxy authentication, credential masking, and sandbox hardening. CLI additions include prompt presets, inline model/permission arguments, image previews, and enterprise MCP authentication. These CLI capabilities are not all exposed in Scribe's UI.

Sources: [official Codex changelog](https://developers.openai.com/codex/changelog/), [Codex SDK documentation](https://learn.chatgpt.com/docs/codex-sdk), and the published [0.162.0](https://registry.npmjs.org/@openai/codex-sdk/0.162.0) / [0.164.0](https://registry.npmjs.org/@openai/codex-sdk/0.164.0) packages compared with npm diff.

## Cursor SDK

The published declaration diff adds explicit team attribution (`teamId`, sent as x-cursor-team-id), max-mode model metadata and selection, computer-use action types, and recovery of already-streamed assistant text when opening the local store fails. Team IDs must be passed again on resume and later account calls; they are not persisted or read from CLI configuration. Existing Scribe model-selection and local-store tests pass.

These findings come from package contents, not a complete upstream release narrative: the package contains no versioned changelog. Scribe does not add team-selection or computer-use controls in this update.

Sources: published [1.0.35](https://registry.npmjs.org/@cursor/sdk/1.0.35) / [1.0.40](https://registry.npmjs.org/@cursor/sdk/1.0.40) package declarations compared with npm diff; [Cursor SDK documentation](https://cursor.com/docs/api/sdk/typescript).

## Native agent / Pi

The agent releases improve compaction and branch summaries by using the model's output limit, preserve active tools on resume, queue codemode scripts when workers are busy, and correct recovery after output truncation. OpenRouter catalogs can reflect the models and limits available to a particular key. Windows shell discovery and BOM-marked configuration handling improve. Image-capable classifiers and generated configuration schemas are added.

Integration changes include a discriminated `before_agent_start` event for user versus custom messages, changed busy/queue semantics during startup, and ignored summary `reserveTokens` arguments. Some changes concern Pi's terminal rather than Scribe. Scribe supplies its own compaction summaries, so the upstream summary-output change does not replace Scribe's summarizer.

Source: [Pi coding-agent changelog, 1.0.4–1.4.0](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md). Unreleased entries were excluded.

The model library adds prompt-length pricing tiers, response duration, classifier image input, client identity configuration, and opt-in telemetry. It improves malformed tool-argument validation, retries, model switching, deferred-tool prompt caching, provider context limits and thinking settings. Breaking APIs include `telemetryContext` becoming `telemetry`, removal of `getPiUserAgent` and experimental message-frame APIs, revised transcript-tool support, and stricter stream return types. Scribe does not use those removed APIs.

**Compatibility fix:** Scribe's rate snapshots support flat rates. Tiered catalog models now report pricing as unavailable instead of applying a flat base rate to every prompt. Flat rates and explicit custom prices continue working. Full tier support is tracked in #814 on Scribe Todo.

Source: [Pi AI changelog, 1.0.4–1.4.0](https://github.com/earendil-works/pi/blob/main/packages/ai/CHANGELOG.md). Unreleased entries were excluded.

## Anthropic API SDK

This crosses a major version: 1.0.0 changes the default `anthropic-version` header from 2023-06-01 to 2026-10-21, confirmed in the published client diff. Other changes include message threads, dimensional usage/cost reports, organization tags and webhooks, model capability metadata, speed parameters, OpenTelemetry integration, and more tolerant streaming. Tool-runner and stream cleanup fixes are included.

There are no direct runtime imports of this SDK in Scribe's src tree; Claude runs through the separate Agent SDK and Native through Pi. The dependency update does not itself migrate those providers to a new Messages API integration. Upstream tracing activates when an application registers a global tracer provider; this update adds no tracing setup.

Source: [Anthropic TypeScript changelog, 0.131.0–1.3.0](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md).

## MCP SDK

HTTP transports now restrict redirects to the endpoint's origin by default; cross-origin redirects require `redirectPolicy: 'follow'` or configuring the final URL. New opt-in server options limit tool-input elements and validate OAuth token audience. Fixes cover task isolation, omitted request arguments, transport optional-property types, and registering handlers after connection when capabilities were already declared.

This is the latest release of the existing @modelcontextprotocol/sdk package. The separately named v2 packages require a migration and are outside this dependency refresh.

Sources: upstream [1.32.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.32.0), [1.32.1](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.32.1), [1.32.2](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.32.2).

## Validation and remaining work

- Installed a private node_modules in this worktree after removing its shared junction. Main-checkout dependencies were not used for validation.
- `npm run build` passes, including kit documentation checks, test typechecking and production TypeScript compilation.
- 162 selected regression tests pass: Native provider, pricing, Cursor SDK/store, Codex provider, Claude usage, MCP bridge/configuration/permissions, SDK updates, and Kanban actions. Claude SDK import/export smoke check also passes.
- Corrected a pre-existing Kanban test typo that put the test clock on ActionCaller instead of ActionContext and blocked typechecking.
- No authenticated live model turns were run. Provider/network behavior is covered by existing fixtures and mocks, not an end-to-end account session.
- npm audit reports six affected packages (one critical, three high, two moderate). Review is recorded as #813 in design, with the By Agent label. No automatic force-fix or Pi downgrade was applied.
- Tiered Native pricing is tracked in #814 in design, also labeled By Agent.

After merge and dependency installation, restart Scribe to load the new SDKs. For manual acceptance, start and resume a short chat with each configured provider and exercise an MCP tool approval.
