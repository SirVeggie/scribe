import assert from "node:assert/strict";
import { test } from "node:test";
import { jevAdapter, jevAnswer, jevQuestion } from "./adapters/jev.js";
import { MlError, type MlQuestion, type MlQuestions, type MlSource } from "./types.js";

const source: MlSource = { id: "jev", name: "Jev", baseUrl: "https://jev.example", apiKey: "sk-test", model: "jev-latest" };
const yes: MlQuestion = { type: "yesno", instructions: "Is it a question?" };
const pick: MlQuestion = { type: "choice", instructions: "Which one?", options: { a: "first", b: "second" } };
const scale: MlQuestion = { type: "score", instructions: "How much?", levels: ["low", "high"] };
const questions: MlQuestions = { q1: yes, q2: pick, q3: scale };

type Recorded = { url: string; init: RequestInit };

/** A fetch stand-in that replays the given responses in order and records each request. */
function scripted(...replies: Array<Response | Error | ((signal: AbortSignal) => Promise<Response>)>) {
  const calls: Recorded[] = [];
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = replies.shift();
    if (next === undefined) throw new Error("no scripted reply left");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(init?.signal as AbortSignal);
    return next;
  }) as unknown as typeof fetch;
  return { fetch: fetchStub, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const goodReply = {
  model: "jev-latest-2026",
  answers: {
    q1: { noul: 0.8 },
    q2: { choice: "b", probabilities: { a: 0.2, b: 0.8 }, confidence: 0.9 },
    q3: { score: 0.7, probabilities: { "0": 0.3, "1": 0.7 }, confidence: 0.6 },
  },
  usage: { input_tokens: 120, output_tokens: 7 },
};

const noWait = () => 1;

test("jevQuestion maps a yes/no question to a noul with its criteria", () => {
  assert.deepEqual(jevQuestion({ type: "yesno", instructions: "x", criteria: { yes: "a cat", no: "a dog" } }), {
    type: "noul",
    instructions: "x",
    criteria: { true: "a cat", false: "a dog" },
  });
});

test("jevQuestion leaves criteria out of a yes/no question that has none", () => {
  const mapped = jevQuestion({ type: "yesno", instructions: "x" });
  assert.equal(mapped.type, "noul");
  assert.equal("criteria" in mapped, false);
});

test("jevQuestion sends choice options and score levels as criteria", () => {
  assert.deepEqual(jevQuestion(pick), { type: "choice", instructions: "Which one?", criteria: { a: "first", b: "second" } });
  assert.deepEqual(jevQuestion(scale), { type: "score", instructions: "How much?", criteria: ["low", "high"] });
});

test("jevAnswer reads a yes/no probability", () => {
  assert.deepEqual(jevAnswer("q1", yes, { noul: 0.25 }), { type: "yesno", yes: 0.25 });
});

test("jevAnswer reads a choice with its probabilities and confidence", () => {
  assert.deepEqual(jevAnswer("q2", pick, { choice: "a", probabilities: { a: 0.6, b: 0.4 }, confidence: 0.5 }), {
    type: "choice",
    choice: "a",
    probabilities: { a: 0.6, b: 0.4 },
    confidence: 0.5,
  });
});

test("jevAnswer defaults a missing or bad confidence to 0", () => {
  const raw = { choice: "a", probabilities: { a: 1 } };
  assert.deepEqual(jevAnswer("q2", pick, raw), { type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 0 });
  assert.deepEqual(jevAnswer("q2", pick, { ...raw, confidence: 3 }), { type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 0 });
});

test("jevAnswer rejects an answer that is not an object or has the wrong fields", () => {
  const invalid = (q: MlQuestion, raw: unknown) =>
    assert.throws(() => jevAnswer("q", q, raw), (e) => e instanceof MlError && e.kind === "invalid_response");
  invalid(yes, null);
  invalid(yes, "yes");
  invalid(yes, { noul: "0.5" });
  invalid(yes, { noul: 1.5 });
  invalid(pick, { choice: "zzz", probabilities: { a: 1 } });
  invalid(pick, { choice: "a" });
  invalid(pick, { choice: "a", probabilities: { a: -0.1 } });
  invalid(scale, { probabilities: { low: 1 } });
  invalid(scale, { score: Number.NaN, probabilities: { "0": 1, "1": 0 } });
});

test("jevAnswer keeps 0-based score levels and rejects any other numbering", () => {
  const invalid = (raw: unknown) =>
    assert.throws(() => jevAnswer("q", scale, raw), (e) => e instanceof MlError && e.kind === "invalid_response");
  // As H2O (llama.cpp) and Jev answered the first and last of two levels.
  assert.deepEqual(jevAnswer("q", scale, { score: 0.07, probabilities: { "0": 0.94, "1": 0.06 }, confidence: 0.9 }), {
    type: "score", score: 0.07, probabilities: { "0": 0.94, "1": 0.06 }, confidence: 0.9,
  });
  assert.equal((jevAnswer("q", scale, { score: 1 + 1e-9, probabilities: { "0": 0, "1": 1 } }) as { score: number }).score, 1);
  invalid({ score: 2, probabilities: { "1": 0, "2": 1 } });
  invalid({ score: 1.5, probabilities: { "0": 0.5, "1": 0.5 } });
  invalid({ score: -0.5, probabilities: { "0": 1, "1": 0 } });
  invalid({ score: 0.5, probabilities: { "0": 0.5, "1": 0.5, "2": 0 } });
  invalid({ score: 0.5, probabilities: { low: 0.5, high: 0.5 } });
});

test("the request goes to the source's systemone endpoint as a POST with the key", async () => {
  const { fetch, calls } = scripted(json(goodReply));
  await jevAdapter({ fetch, backoffMs: noWait }).decide(source, "the state", questions, new AbortController().signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://jev.example/v1/systemone");
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers.Authorization, "Bearer sk-test");
});

test("the request body carries the model, state and mapped questions", async () => {
  const { fetch, calls } = scripted(json(goodReply));
  await jevAdapter({ fetch, backoffMs: noWait }).decide(source, "the state", questions, new AbortController().signal);
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, "jev-latest");
  assert.equal(body.state, "the state");
  assert.deepEqual(Object.keys(body.questions).sort(), ["q1", "q2", "q3"]);
  assert.equal(body.questions.q1.type, "noul");
  assert.equal(body.questions.q2.type, "choice");
  assert.equal(body.questions.q3.type, "score");
});

test("no Authorization header is sent when the source has no key", async () => {
  const { fetch, calls } = scripted(json(goodReply));
  const keyless: MlSource = { ...source, apiKey: undefined };
  await jevAdapter({ fetch, backoffMs: noWait }).decide(keyless, "s", questions, new AbortController().signal);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal("Authorization" in headers, false);
});

test("a successful reply maps every answer, the model and the usage", async () => {
  const { fetch } = scripted(json(goodReply));
  const reply = await jevAdapter({ fetch, backoffMs: noWait }).decide(source, "s", questions, new AbortController().signal);
  assert.deepEqual(reply.answers.q1, { type: "yesno", yes: 0.8 });
  assert.deepEqual(reply.answers.q2, { type: "choice", choice: "b", probabilities: { a: 0.2, b: 0.8 }, confidence: 0.9 });
  assert.deepEqual(reply.answers.q3, { type: "score", score: 0.7, probabilities: { "0": 0.3, "1": 0.7 }, confidence: 0.6 });
  assert.equal(reply.model, "jev-latest-2026");
  assert.deepEqual(reply.usage, { inputTokens: 120, outputTokens: 7 });
});

test("the reply falls back to the source's model and zero usage when they are missing", async () => {
  const { fetch } = scripted(json({ answers: { q1: { noul: 0.5 } } }));
  const reply = await jevAdapter({ fetch, backoffMs: noWait }).decide(source, "s", { q1: yes }, new AbortController().signal);
  assert.equal(reply.model, "jev-latest");
  assert.deepEqual(reply.usage, { inputTokens: 0, outputTokens: 0 });
});

test("a 429 is retried and the retry's answer is used", async () => {
  const waits: number[] = [];
  const { fetch, calls } = scripted(new Response("slow down", { status: 429 }), json(goodReply));
  const adapter = jevAdapter({
    fetch,
    backoffMs: (attempt) => {
      waits.push(attempt);
      return 1;
    },
  });
  const reply = await adapter.decide(source, "s", questions, new AbortController().signal);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [0]);
  assert.equal(reply.answers.q1.type, "yesno");
});

test("a 529 is retried too", async () => {
  const { fetch, calls } = scripted(new Response("", { status: 529 }), json(goodReply));
  await jevAdapter({ fetch, backoffMs: noWait }).decide(source, "s", questions, new AbortController().signal);
  assert.equal(calls.length, 2);
});

test("the backoff is given the response so Retry-After can be read", async () => {
  const seen: string[] = [];
  const { fetch } = scripted(new Response("", { status: 429, headers: { "retry-after": "2" } }), json(goodReply));
  await jevAdapter({
    fetch,
    backoffMs: (_attempt, res) => {
      seen.push(res.headers.get("retry-after") ?? "");
      return 1;
    },
  }).decide(source, "s", questions, new AbortController().signal);
  assert.deepEqual(seen, ["2"]);
});

test("three 429s in a row end as rate_limited after three tries", async () => {
  const { fetch, calls } = scripted(
    new Response("", { status: 429 }),
    new Response("", { status: 429 }),
    new Response("", { status: 429 }),
  );
  await assert.rejects(
    jevAdapter({ fetch, backoffMs: noWait }).decide(source, "s", questions, new AbortController().signal),
    (e) => e instanceof MlError && e.kind === "rate_limited",
  );
  assert.equal(calls.length, 3);
});

test("three 529s in a row end as unavailable after three tries", async () => {
  const { fetch, calls } = scripted(new Response("", { status: 529 }), new Response("", { status: 529 }), new Response("", { status: 529 }));
  await assert.rejects(
    jevAdapter({ fetch, backoffMs: noWait }).decide(source, "s", questions, new AbortController().signal),
    (e) => e instanceof MlError && e.kind === "unavailable",
  );
  assert.equal(calls.length, 3);
});

test("a 401 or 403 is unauthorized", async () => {
  for (const status of [401, 403]) {
    const { fetch } = scripted(new Response("", { status }));
    await assert.rejects(
      jevAdapter({ fetch, backoffMs: noWait }).decide(source, "s", questions, new AbortController().signal),
      (e) => e instanceof MlError && e.kind === "unauthorized",
    );
  }
});

test("a 400 or 422 is invalid_request and carries the server's message", async () => {
  for (const status of [400, 422]) {
    const { fetch } = scripted(json({ error: { message: "questions.q1.type is unknown" } }, status));
    await assert.rejects(
      jevAdapter({ fetch, backoffMs: noWait }).decide(source, "s", questions, new AbortController().signal),
      (e) =>
        e instanceof MlError &&
        e.kind === "invalid_request" &&
        e.message.includes(`(${status})`) &&
        e.message.endsWith(": questions.q1.type is unknown"),
    );
  }
});

test("a 413 is input_too_large", async () => {
  const { fetch } = scripted(new Response("", { status: 413 }));
  await assert.rejects(
    jevAdapter({ fetch, backoffMs: noWait }).decide(source, "s", questions, new AbortController().signal),
    (e) => e instanceof MlError && e.kind === "input_too_large",
  );
});

test("other failing statuses are unavailable and name the status", async () => {
  const { fetch } = scripted(new Response("boom", { status: 500 }));
  await assert.rejects(
    jevAdapter({ fetch, backoffMs: noWait }).decide(source, "s", questions, new AbortController().signal),
    (e) => e instanceof MlError && e.kind === "unavailable" && e.message.includes("(500)") && e.message.endsWith(": boom"),
  );
});

test("a network failure is unavailable and says the source could not be reached", async () => {
  const { fetch } = scripted(new TypeError("fetch failed"));
  await assert.rejects(
    jevAdapter({ fetch, backoffMs: noWait }).decide(source, "s", questions, new AbortController().signal),
    (e) => e instanceof MlError && e.kind === "unavailable" && e.message.includes("could not be reached"),
  );
});

test("a reply that is not JSON is invalid_response", async () => {
  const { fetch } = scripted(new Response("<html>oops</html>", { status: 200 }));
  await assert.rejects(
    jevAdapter({ fetch, backoffMs: noWait }).decide(source, "s", questions, new AbortController().signal),
    (e) => e instanceof MlError && e.kind === "invalid_response",
  );
});

test("a reply without an answers object is invalid_response", async () => {
  const { fetch } = scripted(json({ model: "x" }));
  await assert.rejects(
    jevAdapter({ fetch, backoffMs: noWait }).decide(source, "s", questions, new AbortController().signal),
    (e) => e instanceof MlError && e.kind === "invalid_response",
  );
});

test("a reply missing one question's answer is invalid_response", async () => {
  const { fetch } = scripted(json({ answers: { q1: { noul: 0.5 } } }));
  await assert.rejects(
    jevAdapter({ fetch, backoffMs: noWait }).decide(source, "s", questions, new AbortController().signal),
    (e) => e instanceof MlError && e.kind === "invalid_response",
  );
});

test("an abort during the request rethrows the signal's reason as is", async () => {
  const controller = new AbortController();
  const reason = { why: "caller gave up" };
  const { fetch } = scripted((signal) => {
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const pending = jevAdapter({ fetch, backoffMs: noWait }).decide(source, "s", questions, controller.signal);
  controller.abort(reason);
  await assert.rejects(pending, (e) => e === reason);
});

test("an abort while waiting to retry rethrows the signal's reason as is", async () => {
  const controller = new AbortController();
  const reason = new Error("stop now");
  const { fetch, calls } = scripted(new Response("", { status: 429 }), json(goodReply));
  const adapter = jevAdapter({
    fetch,
    backoffMs: () => {
      controller.abort(reason);
      return 10_000;
    },
  });
  await assert.rejects(adapter.decide(source, "s", questions, controller.signal), (e) => e === reason);
  assert.equal(calls.length, 1);
});
