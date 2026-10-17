import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeAdapter } from "./adapters/fake.js";
import { MlError, type MlQuestions } from "./types.js";

const source = { id: "fake", name: "Fake", baseUrl: "", model: "test" };
const questions: MlQuestions = {
  label0: { type: "yesno", instructions: "Bug?" },
  label1: { type: "yesno", instructions: "Feature?" },
  priority: { type: "choice", instructions: "Priority?", options: { unspecified: null, high: null } },
  risk: { type: "score", instructions: "Risk?", levels: ["low", "high"] },
};
const decide = (script?: string) => fakeAdapter({ script }).decide(source, {}, questions, new AbortController().signal);

test("scripted fake answers exercise probabilities, choice and score; missing ids retain defaults", async () => {
  const { answers } = await decide(JSON.stringify({
    label0: { noul: 0.9 },
    priority: { choice: "high", probabilities: { unspecified: 0.2, high: 0.8 }, confidence: 0.7 },
    risk: { score: 0.8, probabilities: { "0": 0.2, "1": 0.8 }, confidence: 0.7 },
  }));
  assert.deepEqual(answers.label0, { type: "yesno", yes: 0.9 });
  assert.deepEqual(answers.label1, { type: "yesno", yes: 0.5 });
  assert.equal(answers.priority.type === "choice" && answers.priority.choice, "high");
  assert.equal(answers.risk.type === "score" && answers.risk.score, 0.8);
  const adapter = fakeAdapter({ script: '{"label0":{"noul":0.9}}' });
  adapter.answers.label0 = { type: "yesno", yes: 0.1 };
  assert.deepEqual((await adapter.decide(source, {}, questions, new AbortController().signal)).answers.label0, { type: "yesno", yes: 0.1 });
});

test("invalid fake scripts fail clearly without returning malformed answers", async () => {
  for (const script of ["{", "[]", "null", '{"label0":{"noul":2}}', '{"priority":{"choice":"missing"}}']) {
    await assert.rejects(decide(script), (error: unknown) => error instanceof MlError && error.kind === "invalid_response");
  }
});
