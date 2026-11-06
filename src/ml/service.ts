import { createHash } from "node:crypto";
import { log as writeLog } from "../log.js";
import { vault } from "../vault.js";
import { fakeAdapter } from "./adapters/fake.js";
import { jevAdapter } from "./adapters/jev.js";
import { ML_FEATURES, featureOn, fileStore, normalizeSource, sourceView, type MlStore } from "./settings.js";
import {
  MlError,
  SEND_KINDS,
  type AdapterReply,
  type DecideFailure,
  type DecideOk,
  type DecideOptions,
  type DecideResult,
  type MlAdapter,
  type MlDayUsage,
  type MlErrorKind,
  type MlQuestion,
  type MlQuestions,
  type MlSettings,
  type MlSource,
  type MlSourceView,
  type MlState,
  type SendKind,
} from "./types.js";

export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_TIMEOUT_MS = 30_000;
/** The Test button waits longer than a feature would: a first call may hit a cold backend. */
const TEST_TIMEOUT_MS = 15_000;
export const MAX_QUESTIONS = 32;
/** Jev allows 32k tokens of state; at about four characters to a token this stays under it. */
export const MAX_STATE_CHARS = 120_000;
const MAX_INSTRUCTION_CHARS = 4000;
const MAX_CHOICE_OPTIONS = 255;
const MAX_SCORE_LEVELS = 10;
const QUESTION_ID = /^[\w.-]{1,64}$/;
/** Requests at a backend at once; the rest wait their turn, up to MAX_WAITING. */
const MAX_CONCURRENT = 4;
const MAX_WAITING = 32;
const CACHE_ENTRIES = 200;
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Call times kept for the usage view's median and p95. */
const LATENCY_SAMPLES = 200;
/** Failures no backend was asked for; they are neither counted nor logged. */
const QUIET: MlErrorKind[] = ["disabled", "not_allowed", "no_source", "invalid_request", "input_too_large"];

export type MlSettingsView = {
  sources: MlSourceView[];
  defaultSource: string | null;
  features: Array<{ id: string; label: string; hint: string; on: boolean }>;
  send: Record<SendKind, boolean>;
  usage: MlUsageView;
};

export type MlUsageView = MlDayUsage & {
  /** Backend call times since the daemon started, in ms; null before the first call. */
  latency: { count: number; last: number; median: number; p95: number } | null;
};

type Request = { state: MlState; questions: MlQuestions };

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new MlError("invalid_request", `${what} must be text`);
  if (value.length > max) throw new MlError("invalid_request", `${what} is longer than ${max} characters`);
  return value.trim();
}

function validQuestion(id: string, raw: unknown): MlQuestion {
  const q = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const instructions = text(q.instructions, `Question "${id}": instructions`, MAX_INSTRUCTION_CHARS);
  if (q.type === "yesno") {
    const criteria = (typeof q.criteria === "object" && q.criteria !== null ? q.criteria : {}) as Record<string, unknown>;
    const yes = criteria.yes === undefined ? "" : text(criteria.yes, `Question "${id}": criteria.yes`, MAX_INSTRUCTION_CHARS);
    const no = criteria.no === undefined ? "" : text(criteria.no, `Question "${id}": criteria.no`, MAX_INSTRUCTION_CHARS);
    return { type: "yesno", instructions, ...(yes || no ? { criteria: { ...(yes ? { yes } : {}), ...(no ? { no } : {}) } } : {}) };
  }
  if (q.type === "choice") {
    const raw = typeof q.options === "object" && q.options !== null && !Array.isArray(q.options) ? Object.entries(q.options) : [];
    if (raw.length < 2 || raw.length > MAX_CHOICE_OPTIONS) {
      throw new MlError("invalid_request", `Question "${id}": a choice needs 2 to ${MAX_CHOICE_OPTIONS} options`);
    }
    const options: Record<string, string | null> = {};
    for (const [name, description] of raw) {
      if (!name.trim() || name.length > 200) throw new MlError("invalid_request", `Question "${id}": option names must be 1 to 200 characters`);
      options[name] = description === null || description === undefined ? null : text(description, `Question "${id}": option "${name}"`, MAX_INSTRUCTION_CHARS);
    }
    return { type: "choice", instructions, options };
  }
  if (q.type === "score") {
    if (!Array.isArray(q.levels) || q.levels.length < 2 || q.levels.length > MAX_SCORE_LEVELS) {
      throw new MlError("invalid_request", `Question "${id}": a score needs 2 to ${MAX_SCORE_LEVELS} levels`);
    }
    return { type: "score", instructions, levels: q.levels.map((level, i) => text(level, `Question "${id}": level ${i + 1}`, MAX_INSTRUCTION_CHARS)) };
  }
  throw new MlError("invalid_request", `Question "${id}": type must be yesno, choice or score`);
}

/** The request as it will be sent, or an MlError saying what is wrong with it. */
export function validateRequest(state: unknown, questions: unknown): Request {
  if (typeof state !== "string" && (typeof state !== "object" || state === null)) {
    throw new MlError("invalid_request", "state must be text, an object or an array");
  }
  let size: number;
  try {
    size = typeof state === "string" ? state.length : JSON.stringify(state).length;
  } catch {
    throw new MlError("invalid_request", "state must be plain JSON");
  }
  if (!size || (typeof state === "string" && !state.trim())) throw new MlError("invalid_request", "state is empty");
  if (size > MAX_STATE_CHARS) throw new MlError("input_too_large", `state is ${size} characters; the limit is ${MAX_STATE_CHARS}`);
  if (typeof questions !== "object" || questions === null || Array.isArray(questions)) {
    throw new MlError("invalid_request", "questions must be an object of questions by id");
  }
  const entries = Object.entries(questions);
  if (!entries.length || entries.length > MAX_QUESTIONS) throw new MlError("invalid_request", `Ask 1 to ${MAX_QUESTIONS} questions per call`);
  const out: MlQuestions = {};
  for (const [id, q] of entries) {
    if (!QUESTION_ID.test(id)) throw new MlError("invalid_request", `Question id "${id.slice(0, 80)}" must be 1 to 64 letters, digits, ".", "_" or "-"`);
    out[id] = validQuestion(id, q);
  }
  return { state: state as MlState, questions: out };
}

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export type MlServiceOptions = {
  store?: MlStore;
  adapter?: MlAdapter;
  now?: () => number;
  log?: (message: string, extra?: unknown) => void;
};

/**
 * decide(): validation, the feature and "what may be sent" switches, a small cache, a limit on
 * calls in flight, a timeout, and the day's token count, in front of one backend adapter.
 */
export class MlService {
  private readonly store: MlStore;
  private readonly adapter: MlAdapter;
  private readonly now: () => number;
  private readonly log: (message: string, extra?: unknown) => void;
  private readonly cache = new Map<string, { at: number; reply: AdapterReply }>();
  /** Identical requests already on their way share one backend call. */
  private readonly inFlight = new Map<string, Promise<AdapterReply>>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly latencies: number[] = [];
  private day: MlDayUsage | undefined;

  constructor(options: MlServiceOptions = {}) {
    this.store = options.store ?? fileStore();
    this.adapter = options.adapter ?? jevAdapter();
    this.now = options.now ?? Date.now;
    this.log = options.log ?? writeLog;
  }

  /* ---------- settings ---------- */

  view(): MlSettingsView {
    const settings = this.store.read();
    return {
      sources: settings.sources.map(sourceView),
      defaultSource: settings.defaultSource ?? null,
      features: ML_FEATURES.map(({ id, label, hint }) => ({ id, label, hint, on: featureOn(settings, id) })),
      send: settings.send,
      usage: this.usage(),
    };
  }

  /** Add a source (no id) or change one. The first source becomes the default. */
  saveSource(id: string | undefined, body: unknown): MlSourceView {
    const settings = this.store.read();
    const previous = id === undefined ? undefined : settings.sources.find((s) => s.id === id);
    if (id !== undefined && !previous) throw new Error(`No classifier source "${id}"`);
    const source = normalizeSource(body, previous, new Set(settings.sources.map((s) => s.id)));
    settings.sources = previous ? settings.sources.map((s) => (s.id === source.id ? source : s)) : [...settings.sources, source];
    settings.defaultSource ??= source.id;
    this.store.write(settings);
    this.cache.clear();
    return sourceView(source);
  }

  /** The sources with their keys, for settings sync (#1024). */
  sources(): MlSource[] {
    return this.store.read().sources;
  }

  /** Replace the sources (settings sync from another device); the default stays if it is still there. */
  replaceSources(sources: MlSource[]): void {
    const settings = this.store.read();
    settings.sources = sources;
    if (!sources.some((s) => s.id === settings.defaultSource)) settings.defaultSource = sources[0]?.id;
    this.store.write(settings);
    this.cache.clear();
  }

  /** Remove a source. If it was the default, the first one left takes over. */
  deleteSource(id: string): void {
    const settings = this.store.read();
    if (!settings.sources.some((s) => s.id === id)) throw new Error(`No classifier source "${id}"`);
    settings.sources = settings.sources.filter((s) => s.id !== id);
    if (settings.defaultSource === id) settings.defaultSource = settings.sources[0]?.id;
    this.store.write(settings);
    this.cache.clear();
  }

  /** The default source, feature switches and "what may be sent" switches; only what the body names changes. */
  update(body: unknown): MlSettingsView {
    const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const settings = this.store.read();
    if (input.defaultSource !== undefined) {
      if (!settings.sources.some((s) => s.id === input.defaultSource)) throw new Error("The default must be one of the saved sources");
      settings.defaultSource = input.defaultSource as string;
    }
    const switches = (value: unknown, known: readonly string[], target: Record<string, boolean>, what: string) => {
      if (value === undefined) return;
      if (typeof value !== "object" || value === null) throw new Error(`${what} must be an object of switches`);
      for (const [key, on] of Object.entries(value)) {
        if (!known.includes(key)) throw new Error(`Unknown ${what} switch "${key}"`);
        if (typeof on !== "boolean") throw new Error(`${what}.${key} must be true or false`);
        target[key] = on;
      }
    };
    switches(input.features, ML_FEATURES.map((f) => f.id), settings.features, "features");
    switches(input.send, SEND_KINDS, settings.send, "send");
    this.store.write(settings);
    return this.view();
  }

  /** Whether a caller may put this kind of thread content in a request. */
  maySend(kind: SendKind): boolean {
    return this.store.read().send[kind];
  }

  /** Whether a feature's calls can go out at all: its switch is on, a source is set and these kinds may be sent. */
  ready(feature: string, sends: SendKind[] = []): boolean {
    const settings = this.store.read();
    return featureOn(settings, feature) && settings.sources.some((s) => s.id === settings.defaultSource) && sends.every((kind) => settings.send[kind]);
  }

  /* ---------- usage ---------- */

  usage(): MlUsageView {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      ...this.today(),
      latency: sorted.length
        ? { count: sorted.length, last: this.latencies[this.latencies.length - 1], median: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) }
        : null,
    };
  }

  private today(): MlDayUsage {
    const day = localDay(this.now());
    this.day ??= this.store.readUsage() ?? undefined;
    if (this.day?.day !== day) this.day = { day, calls: 0, cached: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
    return this.day;
  }

  private count(change: Partial<Omit<MlDayUsage, "day">>): void {
    const day = this.today();
    for (const [key, n] of Object.entries(change) as Array<[keyof Omit<MlDayUsage, "day">, number]>) day[key] += n;
    try {
      this.store.writeUsage(day);
    } catch {
      // The counters are a convenience; a full disk must not fail a call.
    }
  }

  /* ---------- decide ---------- */

  /**
   * Ask the questions about the state. Never throws: on any failure the result is
   * { ok: false, error, message } and the caller carries on without an answer.
   */
  async decide(state: unknown, questions: unknown, options: DecideOptions = {}): Promise<DecideResult> {
    const started = this.now();
    let source: MlSource | undefined;
    try {
      const settings = this.store.read();
      if (options.feature && !featureOn(settings, options.feature)) throw new MlError("disabled", `${options.feature} is switched off`);
      const blocked = (options.sends ?? []).find((kind) => !settings.send[kind]);
      if (blocked) throw new MlError("not_allowed", `Sending ${blocked} to the classifier is switched off`);
      source = this.pickSource(settings, options.source);
      // A classifier is a model too: protected values reach it as tokens (#1048).
      const request = vault().redactDeep(validateRequest(state, questions));
      const useCache = options.cache !== false;
      const key = createHash("sha256").update(JSON.stringify([source.id, source.baseUrl, source.model, request])).digest("hex");
      const hit = useCache ? this.cache.get(key) : undefined;
      if (hit && this.now() - hit.at < CACHE_TTL_MS) {
        this.count({ cached: 1 });
        return { ok: true, ...hit.reply, source: source.id, ms: 0, cached: true } satisfies DecideOk;
      }
      let call = useCache ? this.inFlight.get(key) : undefined;
      const shared = Boolean(call);
      if (!call) {
        call = this.call(source, request, this.timeout(options.timeoutMs));
        if (useCache) {
          this.inFlight.set(key, call);
          call.then(
            () => this.inFlight.delete(key),
            () => this.inFlight.delete(key),
          );
        }
      }
      const reply = await call;
      const ms = this.now() - started;
      if (shared) {
        this.count({ cached: 1 });
        return { ok: true, ...reply, source: source.id, ms, cached: true };
      }
      if (useCache) this.remember(key, reply);
      this.latencies.push(ms);
      if (this.latencies.length > LATENCY_SAMPLES) this.latencies.shift();
      this.count({ calls: 1, inputTokens: reply.usage.inputTokens, outputTokens: reply.usage.outputTokens });
      // Per call, so later cards can set their time budgets from real numbers.
      this.log("ml decide", { source: source.id, model: reply.model, ms, questions: Object.keys(request.questions).length, feature: options.feature, inputTokens: reply.usage.inputTokens });
      return { ok: true, ...reply, source: source.id, ms, cached: false };
    } catch (error) {
      const failure: DecideFailure = {
        ok: false,
        error: error instanceof MlError ? error.kind : "unavailable",
        message: error instanceof Error ? error.message : String(error),
        ms: this.now() - started,
      };
      if (!QUIET.includes(failure.error)) {
        this.count({ failed: 1 });
        this.log("ml decide failed", { source: source?.id, error: failure.error, message: failure.message, ms: failure.ms, feature: options.feature });
      }
      return failure;
    }
  }

  /** One real question through a source, for the Settings Test button. Uncached, and counted like any call. */
  test(id: string): Promise<DecideResult> {
    return this.decide(
      "The sky is clear and the sun is out.",
      { sunny: { type: "yesno", instructions: "Is the weather sunny?" } },
      { source: id, cache: false, timeoutMs: TEST_TIMEOUT_MS },
    );
  }

  private pickSource(settings: MlSettings, id: string | undefined): MlSource {
    const wanted = id ?? settings.defaultSource;
    const source = settings.sources.find((s) => s.id === wanted);
    if (!source) throw new MlError("no_source", id ? `No classifier source "${id}"` : "No classifier source is set up");
    return source;
  }

  private timeout(ms: number | undefined): number {
    return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  }

  private remember(key: string, reply: AdapterReply): void {
    this.cache.delete(key);
    this.cache.set(key, { at: this.now(), reply });
    // A Map keeps insertion order, so the first key is the oldest.
    while (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
  }

  /** One backend call under the concurrency limit; the timeout covers the wait for a slot too. */
  private async call(source: MlSource, request: Request, timeoutMs: number): Promise<AdapterReply> {
    const controller = new AbortController();
    const timeout = new MlError("timeout", `${source.name} did not answer within ${timeoutMs} ms`);
    const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(timeout), { once: true }));
    // Whichever side loses the race below must not surface as an unhandled rejection.
    aborted.catch(() => {});
    let held = false;
    try {
      await Promise.race([this.acquire(controller.signal), aborted]);
      held = true;
      const reply = this.adapter.decide(source, request.state, request.questions, controller.signal);
      reply.catch(() => {});
      return await Promise.race([reply, aborted]);
    } catch (error) {
      throw controller.signal.aborted ? timeout : error;
    } finally {
      clearTimeout(timer);
      if (held) this.release();
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (this.running < MAX_CONCURRENT) {
      this.running += 1;
      return Promise.resolve();
    }
    if (this.waiting.length >= MAX_WAITING) return Promise.reject(new MlError("busy", "Too many classifier calls are waiting"));
    return new Promise((resolve) => {
      // The slot is handed over by release(), so `running` stays as it is.
      const turn = () => {
        signal.removeEventListener("abort", leave);
        resolve();
      };
      const leave = () => {
        const at = this.waiting.indexOf(turn);
        if (at >= 0) this.waiting.splice(at, 1);
      };
      signal.addEventListener("abort", leave, { once: true });
      this.waiting.push(turn);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }
}

/** SCRIBE_FAKE_ML=1 answers from the fake backend: no network and no key, for trying the UI and features. */
export const FAKE_ML = process.env.SCRIBE_FAKE_ML === "1";

let service: MlService | undefined;

/** The daemon's one decision service. */
export function mlService(): MlService {
  return (service ??= new MlService(FAKE_ML ? { adapter: fakeAdapter({ script: process.env.SCRIBE_FAKE_ML_ANSWERS }) } : {}));
}
