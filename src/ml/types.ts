/**
 * The decision service: small typed questions about a piece of state, answered by a classifier
 * (docs/intent-detection-hooks-design.md). Callers never get an exception: a failure is a typed
 * result and they carry on without the answer (fail open).
 */

/** What is being judged: text, or JSON the backend reads as is. */
export type MlState = string | Record<string, unknown> | unknown[];

export type MlQuestion =
  /** Yes or no. `criteria` says what counts as each, when the instructions alone leave it open. */
  | { type: "yesno"; instructions: string; criteria?: { yes?: string; no?: string } }
  /** One of `options` (name → description, null when the name says it all). */
  | { type: "choice"; instructions: string; options: Record<string, string | null> }
  /** A place on an ordered scale; `levels` describes each step, lowest first. */
  | { type: "score"; instructions: string; levels: string[] };

/** Questions by an id the caller picks; answers come back under the same ids. Each is answered on its own. */
export type MlQuestions = Record<string, MlQuestion>;

export type MlAnswer =
  /** `yes` is the probability of yes, 0 to 1. */
  | { type: "yesno"; yes: number }
  /** `confidence` comes from the whole distribution; it is not the probability of `choice`. */
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  /**
   * `score` is probability-weighted, so it can fall between levels. 0 is the first level, as are the
   * keys of `probabilities` ("0" to levels − 1).
   */
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

export type MlAnswers = Record<string, MlAnswer>;

export type MlUsage = { inputTokens: number; outputTokens: number };

export type MlErrorKind =
  /** No source is set up, or the one asked for does not exist. */
  | "no_source"
  /** The feature's switch is off. */
  | "disabled"
  /** A "what may be sent" switch is off for something in this request. */
  | "not_allowed"
  | "invalid_request"
  | "input_too_large"
  | "unauthorized"
  | "rate_limited"
  /** Too many calls are already waiting. */
  | "busy"
  | "timeout"
  | "unavailable"
  | "invalid_response";

export class MlError extends Error {
  constructor(
    readonly kind: MlErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "MlError";
  }
}

export type DecideOk = {
  ok: true;
  answers: MlAnswers;
  source: string;
  /** The model that answered, as the backend names it (an alias like jev-latest resolves to a version). */
  model: string;
  /** Wall time of this call, queueing and retries included. 0 for a cached answer. */
  ms: number;
  cached: boolean;
  usage: MlUsage;
};

export type DecideFailure = { ok: false; error: MlErrorKind; message: string; ms: number };

export type DecideResult = DecideOk | DecideFailure;

/** The kinds of thread content a caller may put in a request; each has a switch in Settings. */
export const SEND_KINDS = ["messages", "agentText", "toolCalls", "toolResults"] as const;
export type SendKind = (typeof SEND_KINDS)[number];

export type DecideOptions = {
  /** Source id; the default source when left out. */
  source?: string;
  /** The feature asking. Refused with "disabled" while its switch is off. */
  feature?: string;
  /** What the state holds. Refused with "not_allowed" when any of these is switched off. */
  sends?: SendKind[];
  timeoutMs?: number;
  /** false: neither read nor fill the cache. */
  cache?: boolean;
};

/** A Jev-API-compatible endpoint: the hosted one, or a local server speaking the same API. */
export type MlSource = {
  id: string;
  name: string;
  /** Without the version path: requests go to {baseUrl}/v1/systemone. */
  baseUrl: string;
  apiKey?: string;
  model: string;
};

/** What the board UI gets: no key, only whether there is one. */
export type MlSourceView = Omit<MlSource, "apiKey"> & { hasKey: boolean };

export type MlSettings = {
  sources: MlSource[];
  /** Id of the source calls use when they name none. */
  defaultSource?: string;
  /** Feature id → on. A feature missing here uses its own default. */
  features: Record<string, boolean>;
  send: Record<SendKind, boolean>;
};

export type MlDayUsage = {
  /** Local date, YYYY-MM-DD. */
  day: string;
  /** Requests that reached a backend and were answered. */
  calls: number;
  cached: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
};

/** What a backend returns for one request. */
export type AdapterReply = { answers: MlAnswers; model: string; usage: MlUsage };

export type MlAdapter = {
  /** Throws MlError. `signal` aborts on the caller's timeout. */
  decide(source: MlSource, state: MlState, questions: MlQuestions, signal: AbortSignal): Promise<AdapterReply>;
};

/** A feature built on the service; each gets a switch in Settings. */
export type MlFeature = { id: string; label: string; hint: string; default: boolean };
