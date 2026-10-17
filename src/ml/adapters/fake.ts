import { MlError, type AdapterReply, type MlAdapter, type MlAnswer, type MlAnswers, type MlQuestion, type MlQuestions, type MlSource, type MlState } from "../types.js";
import { jevAnswer } from "./jev.js";

export type FakeCall = { source: MlSource; state: MlState; questions: MlQuestions };

export type FakeAdapter = MlAdapter & {
  /** Every request that reached the backend, oldest first. */
  calls: FakeCall[];
  /** Answers by question id for the next requests; a question without one gets fakeAnswer(). */
  answers: Record<string, MlAnswer>;
  /** Fail the next request with this, once. */
  failNext?: MlError;
  /** Hold each request this long (it still ends early when the caller's signal aborts). */
  delayMs: number;
};

/** A fixed, plausible answer: yes at 0.5, the first option, the lowest level. */
export function fakeAnswer(q: MlQuestion): MlAnswer {
  if (q.type === "yesno") return { type: "yesno", yes: 0.5 };
  if (q.type === "choice") {
    const names = Object.keys(q.options);
    return {
      type: "choice",
      choice: names[0],
      probabilities: Object.fromEntries(names.map((name, i) => [name, i === 0 ? 1 : 0])),
      confidence: 1,
    };
  }
  return {
    type: "score",
    score: 0,
    probabilities: Object.fromEntries(q.levels.map((_, i) => [String(i), i === 0 ? 1 : 0])),
    confidence: 1,
  };
}

/** A backend for tests, like the agent's fake provider: no network, scripted answers, a record of calls. */
export function fakeAdapter(options: { script?: string } = {}): FakeAdapter {
  const adapter: FakeAdapter = {
    calls: [],
    answers: {},
    delayMs: 0,
    async decide(source, state, questions, signal): Promise<AdapterReply> {
      adapter.calls.push({ source, state, questions });
      if (adapter.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, adapter.delayMs);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
      const failure = adapter.failNext;
      if (failure) {
        adapter.failNext = undefined;
        throw failure;
      }
      const answers: MlAnswers = {};
      let script: Record<string, unknown> = {};
      if (options.script) {
        try {
          const parsed: unknown = JSON.parse(options.script);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          script = parsed as Record<string, unknown>;
        } catch {
          throw new MlError("invalid_response", "SCRIBE_FAKE_ML_ANSWERS must be a JSON object keyed by question id");
        }
      }
      for (const [id, q] of Object.entries(questions)) {
        answers[id] = adapter.answers[id] ?? (Object.hasOwn(script, id) ? jevAnswer(id, q, script[id]) : fakeAnswer(q));
      }
      // About four characters to a token, so the counters have something to add up.
      const inputTokens = Math.ceil(JSON.stringify({ state, questions }).length / 4);
      return { answers, model: `${source.model}-fake`, usage: { inputTokens, outputTokens: 0 } };
    },
  };
  return adapter;
}
