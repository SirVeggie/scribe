import crypto from "node:crypto";

/**
 * Detectors (#1047): regexes for secret formats with a low false-flag risk. A match becomes a vault
 * fragment (source: detector) the moment Scribe sees it, so it is redacted like one the user added.
 * The user can unflag a match (remove its fragment); that value is then left alone, and the count of
 * unflags per detector gives its estimated false-flag rate.
 */
export type DetectorDef = {
  id: string;
  label: string;
  /** What the agent sees in the token: ⟦p:<id> <hint>⟧. */
  hint: string;
  kind: string;
  pattern: string;
  /** Extra regex flags besides g (i, m, s, u). */
  flags?: string;
  /** Built-ins only: off unless the user turns it on (too noisy to be on by default). */
  optIn?: boolean;
};

export type DetectorChange = { at: number; by: string; change: string };

/** What the store keeps per detector: the user's switch, a custom detector's definition, and its counts. */
export type DetectorRecord = {
  id: string;
  enabled?: boolean;
  /** A custom detector (added by the user or an approved agent proposal). */
  custom?: Omit<DetectorDef, "id" | "optIn">;
  matches: number;
  unflags: number;
  history: DetectorChange[];
};

export interface DetectorStore {
  list(): DetectorRecord[];
  save(record: DetectorRecord): void;
  remove(id: string): void;
  unflagged(): string[];
  addUnflagged(hash: string, detector: string): void;
}

export type DetectorView = DetectorDef & {
  builtin: boolean;
  enabled: boolean;
  matches: number;
  unflags: number;
  /** unflags / matches, or null before any match. */
  falseFlagRate: number | null;
  /** The rate is high enough to suggest turning it off. */
  suggestOff: boolean;
  history: DetectorChange[];
};

/** A detector whose matches the user unflags this often (after enough of them) gets suggested for turning off. */
export const SUGGEST_OFF_RATE = 0.3;
export const SUGGEST_OFF_MIN_MATCHES = 4;
const MAX_HISTORY = 20;
const MAX_PATTERN = 400;
/** Matches shorter than this are never taken (an agent's protect has its own, smaller minimum). */
export const MIN_MATCH = 8;
const MAX_MATCH = 4000;

// Edges for tokens made of [A-Za-z0-9_-]: \b does not treat "-" as a word character.
const L = "(?<![A-Za-z0-9_-])";
const R = "(?![A-Za-z0-9_-])";

export const BUILTIN_DETECTORS: DetectorDef[] = [
  { id: "anthropic", label: "Anthropic API key", hint: "Anthropic API key", kind: "api key", pattern: `${L}sk-ant-[A-Za-z0-9_-]{32,}${R}` },
  { id: "openai", label: "OpenAI API key", hint: "OpenAI API key", kind: "api key", pattern: `${L}(?:sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})${R}` },
  { id: "github", label: "GitHub token", hint: "GitHub token", kind: "token", pattern: `${L}(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})${R}` },
  { id: "aws", label: "AWS access key id", hint: "AWS access key id", kind: "api key", pattern: `${L}(?:AKIA|ASIA)[0-9A-Z]{16}${R}` },
  { id: "slack", label: "Slack token", hint: "Slack token", kind: "token", pattern: `${L}xox[abprs]-[A-Za-z0-9-]{10,}${R}` },
  { id: "google", label: "Google API key", hint: "Google API key", kind: "api key", pattern: `${L}AIza[0-9A-Za-z_-]{35}${R}` },
  { id: "stripe", label: "Stripe live key", hint: "Stripe live key", kind: "api key", pattern: `${L}(?:sk|rk)_live_[0-9A-Za-z]{24,}${R}` },
  { id: "pem", label: "Private key (PEM)", hint: "private key", kind: "private key", pattern: "-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\\s\\S]{20,3900}?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----" },
  { id: "jwt", label: "JSON web token", hint: "JSON web token", kind: "token", pattern: `${L}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{16,}${R}` },
  { id: "email", label: "Email address", hint: "email address", kind: "email", pattern: "(?<![\\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}(?![\\w-])", optIn: true },
  { id: "phone", label: "Phone number", hint: "phone number", kind: "phone", pattern: "(?<![\\w+.-])\\+?\\d[\\d -]{6,14}\\d(?![\\w.-])", optIn: true },
];
const BUILTIN = new Map(BUILTIN_DETECTORS.map((def) => [def.id, def]));
/** Cheap first look: a text without any of these can skip every built-in but the opt-in ones. */
const QUICK = /sk-|gh[pousr]_|github_pat_|AKIA|ASIA|xox[abprs]-|AIza|_live_|PRIVATE KEY|eyJ/;

/** Extra checks that a match is the format and not something shaped like it. */
const CHECKS: Record<string, (match: string) => boolean> = {
  jwt: (match) => {
    try {
      const header = JSON.parse(Buffer.from(match.split(".")[0], "base64url").toString("utf8")) as unknown;
      return Boolean(header && typeof header === "object" && "alg" in header);
    } catch {
      return false;
    }
  },
  phone: (match) => match.replace(/\D/g, "").length >= 8,
};

export function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Why a pattern can't be a detector, or null when it can: it must compile, stay short, not match
 * empty text, and avoid nested quantifiers (JavaScript regexes can't be stopped once running).
 */
export function patternProblem(pattern: string, flags = ""): string | null {
  if (!pattern || typeof pattern !== "string") return "pattern is required";
  if (pattern.length > MAX_PATTERN) return `pattern is longer than ${MAX_PATTERN} characters`;
  if (/[^imsu]/.test(flags)) return "flags may only be i, m, s and u";
  let re: RegExp;
  try {
    re = new RegExp(pattern, `g${flags}`);
  } catch (err) {
    return `pattern doesn't compile: ${(err as Error).message}`;
  }
  if (re.test("")) return "pattern matches empty text";
  // (x+)+, (x*)*, (x+)*, (x{2,})+ and the like can take forever on some texts.
  if (/\((?:[^()\\]|\\.)*[+*}]\)[+*{]/.test(pattern)) return "pattern has a nested quantifier such as (a+)+, which can hang on some texts";
  return null;
}

export type DetectorMatch = { value: string; detector: DetectorView };

export class Detectors {
  private records = new Map<string, DetectorRecord>();
  private unflaggedHashes = new Set<string>();
  private compiled: { view: DetectorView; re: RegExp; quick: boolean }[] = [];
  private views: DetectorView[] = [];

  constructor(private store?: DetectorStore) {
    if (store) {
      for (const record of store.list()) this.records.set(record.id, record);
      for (const hash of store.unflagged()) this.unflaggedHashes.add(hash);
    }
    this.rebuild();
  }

  list(): DetectorView[] {
    return this.views;
  }

  /** Any detector is on. */
  get active(): boolean {
    return this.compiled.length > 0;
  }

  mayMatch(text: string): boolean {
    return this.compiled.length > 0 && text.length >= MIN_MATCH;
  }

  get(id: string): DetectorView | undefined {
    return this.views.find((view) => view.id === id);
  }

  /** Every enabled detector's matches in text that pass its checks, minus values the user unflagged. */
  scan(text: string, opts: { partial?: boolean } = {}): DetectorMatch[] {
    if (!text || text.length < MIN_MATCH || !this.compiled.length) return [];
    const quick = QUICK.test(text);
    const found: { start: number; end: number; match: DetectorMatch }[] = [];
    for (const { view, re, quick: needsQuick } of this.compiled) {
      if (needsQuick && !quick) continue;
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (!m[0]) {
          re.lastIndex += 1;
          continue;
        }
        const value = m[0];
        const end = m.index + value.length;
        // Text still being written (a streaming reply) may not have the whole value yet.
        if (opts.partial && end === text.length) continue;
        if (value.length < MIN_MATCH || value.length > MAX_MATCH) continue;
        if (CHECKS[view.id] && BUILTIN.has(view.id) && !CHECKS[view.id](value)) continue;
        if (this.unflaggedHashes.has(hashValue(value))) continue;
        found.push({ start: m.index, end, match: { value, detector: view } });
      }
    }
    if (found.length < 2) return found.map((item) => item.match);
    // Where two detectors overlap, the leftmost, then longest, wins.
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const out: DetectorMatch[] = [];
    let reach = 0;
    const seen = new Set<string>();
    for (const item of found) {
      if (item.start < reach) continue;
      reach = item.end;
      if (seen.has(item.match.value)) continue;
      seen.add(item.match.value);
      out.push(item.match);
    }
    return out;
  }

  /** A new fragment came from this detector. */
  counted(id: string): void {
    const record = this.record(id);
    record.matches += 1;
    this.save(record);
  }

  /** The user unflagged a match: leave that value alone from now on, and count it against the detector. */
  unflag(id: string | undefined, value: string): void {
    const hash = hashValue(value);
    if (!this.unflaggedHashes.has(hash)) {
      this.unflaggedHashes.add(hash);
      this.store?.addUnflagged(hash, id ?? "");
    }
    if (!id) return;
    const record = this.record(id);
    record.unflags += 1;
    this.save(record);
  }

  isUnflagged(value: string): boolean {
    return this.unflaggedHashes.has(hashValue(value));
  }

  setEnabled(id: string, enabled: boolean, by: string): DetectorView {
    const view = this.get(id);
    if (!view) throw new Error(`No detector ${id}`);
    const record = this.record(id);
    record.enabled = enabled;
    this.note(record, by, enabled ? "turned on" : "turned off");
    this.save(record);
    return this.get(id)!;
  }

  /** Add a custom detector, or change one; built-ins only switch on and off. */
  put(def: DetectorDef, by: string): DetectorView {
    if (BUILTIN.has(def.id)) throw new Error(`${def.id} is a built-in detector: it can only be turned on or off. Add a new one instead.`);
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(def.id)) throw new Error("id must be 2–40 characters: lowercase letters, digits and -");
    const problem = patternProblem(def.pattern, def.flags);
    if (problem) throw new Error(problem);
    const existed = this.records.get(def.id)?.custom;
    const record = this.record(def.id);
    record.custom = {
      label: def.label.trim().slice(0, 60) || def.id,
      hint: def.hint.trim().slice(0, 40) || def.label.trim().slice(0, 40) || def.id,
      kind: def.kind.trim().slice(0, 30) || "secret",
      pattern: def.pattern,
      ...(def.flags ? { flags: def.flags } : {}),
    };
    if (record.enabled === undefined) record.enabled = true;
    this.note(record, by, existed ? `changed to /${def.pattern}/${def.flags ?? ""}` : `added /${def.pattern}/${def.flags ?? ""}`);
    this.save(record);
    return this.get(def.id)!;
  }

  /** Remove a custom detector. Fragments it made stay in the vault. */
  remove(id: string): boolean {
    const record = this.records.get(id);
    if (!record?.custom) return false;
    this.records.delete(id);
    this.store?.remove(id);
    this.rebuild();
    return true;
  }

  private record(id: string): DetectorRecord {
    let record = this.records.get(id);
    if (!record) {
      record = { id, matches: 0, unflags: 0, history: [] };
      this.records.set(id, record);
    }
    return record;
  }

  private note(record: DetectorRecord, by: string, change: string): void {
    record.history = [...record.history, { at: Date.now(), by: by.slice(0, 80), change: change.slice(0, 500) }].slice(-MAX_HISTORY);
  }

  private save(record: DetectorRecord): void {
    this.store?.save(record);
    this.rebuild();
  }

  private rebuild(): void {
    const views: DetectorView[] = [];
    const defs = [...BUILTIN_DETECTORS, ...[...this.records.values()].filter((r) => r.custom && !BUILTIN.has(r.id)).map((r) => ({ id: r.id, ...r.custom! }))];
    for (const def of defs) {
      const record = this.records.get(def.id);
      const builtin = BUILTIN.has(def.id);
      const matches = record?.matches ?? 0;
      const unflags = record?.unflags ?? 0;
      const rate = matches ? Math.min(1, unflags / matches) : null;
      const enabled = record?.enabled ?? !BUILTIN.get(def.id)?.optIn;
      views.push({
        ...def,
        builtin,
        enabled,
        matches,
        unflags,
        falseFlagRate: rate,
        suggestOff: enabled && rate !== null && matches >= SUGGEST_OFF_MIN_MATCHES && rate >= SUGGEST_OFF_RATE,
        history: record?.history ?? [],
      });
    }
    this.views = views;
    this.compiled = [];
    for (const view of views) {
      if (!view.enabled) continue;
      try {
        this.compiled.push({ view, re: new RegExp(view.pattern, `g${view.flags ?? ""}`), quick: Boolean(view.builtin && !BUILTIN.get(view.id)?.optIn) });
      } catch {
        /* a stored pattern this engine can't compile is skipped, not fatal */
      }
    }
  }
}
