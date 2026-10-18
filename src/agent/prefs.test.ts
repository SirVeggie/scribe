import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanForkSummarizers, DEFAULT_PREFS, forkSummaryModel, modelChoice, prefsPatchFromChoices, seedForkSummarizers, seedModelSettings, settingPatch, workspaceKey } from "./prefs.js";

const grok = {
  provider: "cursor" as const,
  model: "cursor-grok-4.6",
  effort: "high",
  modelParams: { context: "1m", fast: "false" },
  mode: "code" as const,
  approval: "ask" as const,
  web: "limited" as const,
  scope: { kind: "global" as const, ref: null },
  cwd: "S:\\proj",
  useWorktree: true,
};

test("creating a thread remembers model and the rest, not only approval", () => {
  const patch = prefsPatchFromChoices(DEFAULT_PREFS, grok, settingPatch(grok));
  assert.equal(patch.provider, "cursor");
  assert.equal(patch.models?.cursor, "cursor-grok-4.6");
  assert.equal(patch.efforts?.cursor, "high");
  assert.deepEqual(patch.modelParams?.cursor, { context: "1m", fast: "false" });
  assert.equal(patch.approval, "ask");
  assert.equal(patch.web, "limited");
  assert.equal(patch.recentWorkspaces?.[0], "S:\\proj");
  assert.equal(patch.worktrees?.[workspaceKey("S:\\proj")], true);
});

test("a page-scoped board thread does not overwrite the global mode default", () => {
  const page = { ...grok, mode: "board" as const, scope: { kind: "page" as const, ref: "t_1" } };
  const patch = prefsPatchFromChoices(DEFAULT_PREFS, page, settingPatch(page));
  assert.equal(patch.mode, undefined);
  assert.equal(patch.models?.cursor, "cursor-grok-4.6");
});

test("a model-only change still stores the provider so the next thread uses that model", () => {
  const patch = prefsPatchFromChoices(DEFAULT_PREFS, grok, { model: grok.model });
  assert.equal(patch.provider, "cursor");
  assert.equal(patch.models?.cursor, "cursor-grok-4.6");
  assert.equal(patch.mode, undefined);
});

test("effort and model params are remembered per model", () => {
  const patch = prefsPatchFromChoices(DEFAULT_PREFS, grok, { modelParams: { fast: "true" } });
  const prefs = { ...DEFAULT_PREFS, ...patch };
  assert.deepEqual(prefs.modelSettings["cursor:cursor-grok-4.6"], { effort: "high", modelParams: { context: "1m", fast: "false" } });
  // Another model of the same provider starts from its own defaults, not grok's.
  assert.deepEqual(modelChoice(prefs, "cursor", "composer-2.5"), { effort: null, modelParams: { fast: "false" } });
  assert.equal(modelChoice(prefs, "cursor", "cursor-grok-4.6").effort, "high");
});

test("prefs from before per-model settings seed each provider's last model", () => {
  const seeded = seedModelSettings({ models: { cursor: "grok" }, efforts: { cursor: "low" }, modelParams: { cursor: { fast: "true" } } });
  assert.deepEqual(seeded, { "cursor:grok": { effort: "low", modelParams: { fast: "true" } } });
  assert.deepEqual(seedModelSettings({ modelSettings: {} }), {});
});

test("fork summaries follow the destination provider and default to its thread model", () => {
  const prefs = { ...DEFAULT_PREFS, forkSummarizers: { claude: "haiku", codex: "mini" } };
  assert.equal(forkSummaryModel(prefs, { provider: "codex", model: "large" }), "mini");
  assert.equal(forkSummaryModel(prefs, { provider: "cursor", model: "composer" }), "composer");
  assert.equal(forkSummaryModel({ ...prefs, forkSummarizers: { codex: null } }, { provider: "codex", model: "large" }), "large");
});

test("legacy summary choices migrate only to their own destination provider", () => {
  assert.deepEqual(seedForkSummarizers({ summarizer: { provider: "claude", model: "haiku" } }), { claude: "haiku" });
  assert.deepEqual(seedForkSummarizers({}), {});
  assert.deepEqual(seedForkSummarizers({ summarizer: DEFAULT_PREFS.summarizer, forkSummarizers: {} }), {});
  assert.deepEqual(seedForkSummarizers({ summarizer: DEFAULT_PREFS.summarizer, forkSummarizers: { claude: null } }), { claude: null });
  assert.deepEqual(cleanForkSummarizers({ codex: "mini", cursor: null, pi: 12, claude: "", unknown: "x" }), { codex: "mini", cursor: null });
});

test("summary choices retain cross-provider selections and reject invalid providers", () => {
  const choice = { provider: "pi" as const, model: "src-local/small" };
  assert.deepEqual(cleanForkSummarizers({ codex: choice, claude: { provider: "unknown", model: "x" } }), { codex: choice });
  assert.equal(forkSummaryModel({ ...DEFAULT_PREFS, forkSummarizers: { codex: choice } }, { provider: "codex", model: "large" }), choice.model);
});
