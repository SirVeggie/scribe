import { MlError, type AdapterReply, type MlAdapter, type MlAnswer, type MlAnswers, type MlQuestion, type MlQuestions } from "../types.js";

/** Tries per request: the first, then retries of 429 (rate limit) and 529 (overloaded). */
const ATTEMPTS = 3;
const BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 4000;

/** Rounding a backend may leave on a score at either end of the scale. */
const SCORE_SLACK = 1e-6;

type Fetch = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Jev's names: a yes/no question is a "noul", and every type keeps its details under `criteria`. */
export function jevQuestion(q: MlQuestion): Record<string, unknown> {
  if (q.type === "yesno") {
    const criteria = {
      ...(q.criteria?.yes ? { true: q.criteria.yes } : {}),
      ...(q.criteria?.no ? { false: q.criteria.no } : {}),
    };
    return { type: "noul", instructions: q.instructions, ...(Object.keys(criteria).length ? { criteria } : {}) };
  }
  if (q.type === "choice") return { type: "choice", instructions: q.instructions, criteria: q.options };
  return { type: "score", instructions: q.instructions, criteria: q.levels };
}

function probabilities(value: unknown, id: string): Record<string, number> {
  if (!isRecord(value)) throw new MlError("invalid_response", `Answer "${id}" has no probabilities`);
  const out: Record<string, number> = {};
  for (const [key, p] of Object.entries(value)) {
    if (!isProbability(p)) throw new MlError("invalid_response", `Answer "${id}" has a probability that is not 0 to 1`);
    out[key] = p;
  }
  return out;
}

/** One answer in Scribe's shape, checked against the question it answers. */
export function jevAnswer(id: string, q: MlQuestion, raw: unknown): MlAnswer {
  if (!isRecord(raw)) throw new MlError("invalid_response", `No answer for "${id}"`);
  if (q.type === "yesno") {
    if (!isProbability(raw.noul)) throw new MlError("invalid_response", `Answer "${id}" is not a yes/no probability`);
    return { type: "yesno", yes: raw.noul };
  }
  const confidence = isProbability(raw.confidence) ? raw.confidence : 0;
  if (q.type === "choice") {
    if (typeof raw.choice !== "string" || !Object.hasOwn(q.options, raw.choice)) {
      throw new MlError("invalid_response", `Answer "${id}" is not one of the options`);
    }
    return { type: "choice", choice: raw.choice, probabilities: probabilities(raw.probabilities, id), confidence };
  }
  if (typeof raw.score !== "number" || !Number.isFinite(raw.score)) {
    throw new MlError("invalid_response", `Answer "${id}" has no score`);
  }
  // Levels count from 0 in both the score and the probability keys (llama.cpp and Jev agree); check
  // that rather than pass a reply on another numbering through one level off.
  const last = q.levels.length - 1;
  const levels = probabilities(raw.probabilities, id);
  const keys = Object.keys(levels);
  if (keys.length !== q.levels.length || q.levels.some((_, i) => !Object.hasOwn(levels, String(i)))) {
    throw new MlError("invalid_response", `Answer "${id}" does not give a probability for each level 0 to ${last}`);
  }
  if (raw.score < -SCORE_SLACK || raw.score > last + SCORE_SLACK) {
    throw new MlError("invalid_response", `Answer "${id}" has a score outside 0 to ${last}`);
  }
  return { type: "score", score: Math.min(Math.max(raw.score, 0), last), probabilities: levels, confidence };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The server's Retry-After (seconds) when it gives one, else doubling from BACKOFF_MS with jitter. */
function backoff(attempt: number, res: Response): number {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, MAX_BACKOFF_MS);
  return Math.min(BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS) * (0.75 + Math.random() * 0.5);
}

/** The error body's own words when it has any, cut short: a 422 names the offending field. */
async function errorText(res: Response): Promise<string> {
  let text = "";
  try {
    text = (await res.text()).trim();
  } catch {
    // The status alone will do.
  }
  try {
    const body = JSON.parse(text) as unknown;
    const inner = isRecord(body) ? body.error ?? body.message ?? body.detail : undefined;
    const message = isRecord(inner) ? inner.message : inner;
    if (typeof message === "string" && message) text = message;
  } catch {
    // Not JSON.
  }
  return text.slice(0, 300);
}

/**
 * TypeSafe's Jev API (docs.typesafe.ai/api), and any server that speaks it: one POST with the state
 * and every question, each answered independently.
 */
export function jevAdapter(options: { fetch?: Fetch; backoffMs?: (attempt: number, res: Response) => number } = {}): MlAdapter {
  const doFetch = options.fetch ?? fetch;
  const wait = options.backoffMs ?? backoff;
  return {
    async decide(source, state, questions: MlQuestions, signal): Promise<AdapterReply> {
      const body = JSON.stringify({
        model: source.model,
        state,
        questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, jevQuestion(q)])),
      });
      let res: Response | undefined;
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        try {
          res = await doFetch(`${source.baseUrl}/v1/systemone`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(source.apiKey ? { Authorization: `Bearer ${source.apiKey}` } : {}),
            },
            body,
            signal,
          });
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          throw new MlError("unavailable", `${source.name} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (res.status !== 429 && res.status !== 529) break;
        if (attempt === ATTEMPTS - 1) break;
        await res.body?.cancel().catch(() => {});
        await sleep(wait(attempt, res), signal);
      }
      if (!res) throw new MlError("unavailable", `${source.name} gave no response`);
      if (!res.ok) {
        const text = await errorText(res);
        const detail = text ? `: ${text}` : "";
        if (res.status === 401 || res.status === 403) throw new MlError("unauthorized", `${source.name} refused the API key (${res.status})${detail}`);
        if (res.status === 422 || res.status === 400) throw new MlError("invalid_request", `${source.name} rejected the request (${res.status})${detail}`);
        if (res.status === 413) throw new MlError("input_too_large", `${source.name} says the request is too large${detail}`);
        if (res.status === 429) throw new MlError("rate_limited", `${source.name} is rate limiting (429)${detail}`);
        throw new MlError("unavailable", `${source.name} failed (${res.status})${detail}`);
      }
      let reply: unknown;
      try {
        reply = await res.json();
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw new MlError("invalid_response", `${source.name} did not answer with JSON`);
      }
      if (!isRecord(reply) || !isRecord(reply.answers)) throw new MlError("invalid_response", `${source.name} sent no answers`);
      const answers: MlAnswers = {};
      for (const [id, q] of Object.entries(questions)) answers[id] = jevAnswer(id, q, reply.answers[id]);
      const usage = isRecord(reply.usage) ? reply.usage : {};
      return {
        answers,
        model: typeof reply.model === "string" && reply.model ? reply.model : source.model,
        usage: {
          inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
          outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
        },
      };
    },
  };
}
