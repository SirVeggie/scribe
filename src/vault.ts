import crypto from "node:crypto";
import { defaultStores, loadMasterKey, open, seal, type KeyStore } from "./plugins/secrets.js";

/**
 * Protected data (#1045): fragments of text (passwords, keys, names) that no model reads. The daemon
 * swaps each one for a token, ⟦p:<id> <hint>⟧, in everything it hands an agent (redact), and swaps
 * the tokens an agent writes back to their values (restore). Values never leave this process: they
 * are sealed at rest with a key the OS keeps, and no agent-facing call returns them.
 */
export type FragmentSource = "user" | "agent" | "detector";
export type Fragment = {
  id: string;
  value: string;
  hint: string;
  kind: string;
  source: FragmentSource;
  detector?: string;
  createdBy: string;
  createdThread?: string;
  createdAt: number;
};
export type FragmentMeta = Omit<Fragment, "value">;

/** A row as kept in protected_fragments: the value sealed. */
export type StoredFragment = Omit<Fragment, "value"> & { sealed: string };
export interface VaultStore {
  list(): StoredFragment[];
  insert(row: StoredFragment): void;
  remove(id: string): boolean;
}

export class VaultTokenError extends Error {}

/** Shortest value an agent may protect, so an injected "protect the" can't scramble pages. */
export const AGENT_MIN_LENGTH = 6;
const MAX_VALUE = 4000;
const MAX_HINT = 40;
const STOP_WORDS = new Set([
  "about", "after", "again", "against", "always", "another", "because", "before", "between", "border", "button",
  "change", "changes", "client", "column", "comment", "content", "create", "default", "delete", "display", "during",
  "either", "enough", "except", "false", "family", "function", "having", "header", "height", "hidden", "import",
  "inside", "itself", "little", "margin", "method", "middle", "number", "object", "others", "padding", "people",
  "please", "public", "really", "return", "school", "script", "second", "select", "should", "server", "simple",
  "something", "source", "status", "string", "styles", "system", "through", "toward", "update", "values", "width",
  "window", "within", "without", "working", "message", "private", "protected", "password", "secret", "undefined",
]);

/** ⟦p:<id> <hint>⟧: the id names the fragment, the hint tells the agent what it stands for. */
export function tokenFor(fragment: Pick<Fragment, "id" | "hint">): string {
  return `⟦p:${fragment.id} ${fragment.hint}⟧`;
}
export const TOKEN = /⟦p:([^\s⟧]*)(?: ([^⟧]*))?⟧/g;

export function cleanHint(hint: unknown, kind: string): string {
  const text = typeof hint === "string" ? hint.replace(/[⟦⟧\p{Cc}]/gu, " ").replace(/\s+/g, " ").trim() : "";
  return (text || kind).slice(0, MAX_HINT).trim();
}

/**
 * Aho–Corasick over UTF-16 code units: one pass finds every pattern in a text, however many there are.
 * find returns non-overlapping matches, leftmost first and the longest at each start.
 */
export class Matcher<T> {
  private next: Map<number, number>[] = [new Map()];
  private fail: number[] = [0];
  private depth: number[] = [0];
  /** The pattern that ends at a node, if one does. */
  private own: (T | undefined)[] = [undefined];
  /** The nearest node down the fail chain where a pattern ends: every match at a position. */
  private dict: number[] = [-1];

  constructor(patterns: Iterable<{ text: string; ref: T }>) {
    for (const { text, ref } of patterns) {
      if (!text) continue;
      let node = 0;
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        let child = this.next[node].get(code);
        if (child === undefined) {
          child = this.next.length;
          this.next.push(new Map());
          this.fail.push(0);
          this.depth.push(this.depth[node] + 1);
          this.own.push(undefined);
          this.dict.push(-1);
          this.next[node].set(code, child);
        }
        node = child;
      }
      this.own[node] = ref;
    }
    const queue: number[] = [];
    for (const child of this.next[0].values()) queue.push(child);
    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head];
      const f = this.fail[node];
      this.dict[node] = this.own[f] !== undefined ? f : this.dict[f];
      for (const [code, child] of this.next[node]) {
        let back = f;
        while (back && !this.next[back].has(code)) back = this.fail[back];
        const to = this.next[back].get(code);
        this.fail[child] = to !== undefined && to !== child ? to : 0;
        queue.push(child);
      }
    }
  }

  get empty(): boolean {
    return this.next[0].size === 0;
  }

  find(text: string): { start: number; end: number; ref: T }[] {
    if (this.empty) return [];
    const found: { start: number; end: number; ref: T }[] = [];
    let node = 0;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      let to = this.next[node].get(code);
      while (to === undefined && node) {
        node = this.fail[node];
        to = this.next[node].get(code);
      }
      node = to ?? 0;
      for (let hit = this.own[node] !== undefined ? node : this.dict[node]; hit > 0; hit = this.dict[hit]) {
        found.push({ start: i + 1 - this.depth[hit], end: i + 1, ref: this.own[hit] as T });
      }
    }
    if (found.length < 2) return found;
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const picked: typeof found = [];
    let reach = 0;
    for (const match of found) {
      if (match.start < reach) continue;
      picked.push(match);
      reach = match.end;
    }
    return picked;
  }
}

export class Vault {
  private fragments = new Map<string, Fragment>();
  private matcher = new Matcher<Fragment>([]);
  private listeners = new Set<() => void>();
  /** Bumped on every change, so caches of redacted text (search) know to redo theirs. */
  version = 0;

  private key?: Promise<Buffer>;

  constructor(private store?: VaultStore, private loadKey?: () => Promise<Buffer>) {}

  /**
   * The vault kept in `store`, its values sealed with a key the OS keeps under `root`. An empty vault
   * leaves the key alone until something is added (asking DPAPI or a keyring takes a moment).
   */
  static async open(root: string, store: VaultStore, options: { platform?: NodeJS.Platform; stores?: KeyStore[] } = {}): Promise<Vault> {
    const rows = store.list();
    const platform = options.platform ?? process.platform;
    const stores = options.stores ?? (platform === "win32" ? ["dpapi", "file"] : defaultStores(platform));
    const create = rows.length === 0;
    const vault: Vault = new Vault(store, () => loadMasterKey(root, { service: "Scribe protected data", label: "Protected data key", create, stores }));
    if (!rows.length) return vault;
    const key = await vault.masterKey();
    for (const row of rows) {
      const { sealed, ...meta } = row;
      vault.fragments.set(row.id, { ...meta, value: open(key, sealed) });
    }
    vault.rebuild();
    return vault;
  }

  private masterKey(): Promise<Buffer> {
    if (!this.loadKey) return Promise.reject(new Error("Protected data key is not available"));
    const loading = (this.key ??= this.loadKey());
    return loading.catch((err) => {
      if (this.key === loading) this.key = undefined;
      throw err;
    });
  }

  get size(): number {
    return this.fragments.size;
  }

  list(): FragmentMeta[] {
    return [...this.fragments.values()].map(({ value: _value, ...meta }) => meta).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Add a fragment; one whose value is already kept comes back as that one. */
  async add(input: { value: string; hint?: string; kind?: string; source: FragmentSource; detector?: string; createdBy: string; createdThread?: string }): Promise<{ fragment: FragmentMeta; existed: boolean }> {
    const value = input.value;
    if (!value.trim()) throw new Error("value is empty");
    if (value.length > MAX_VALUE) throw new Error(`value is longer than ${MAX_VALUE} characters`);
    if (/[⟦⟧]/.test(value)) throw new Error("value can't contain ⟦ or ⟧");
    const same = [...this.fragments.values()].find((fragment) => fragment.value === value);
    if (same) return { fragment: metaOf(same), existed: true };
    const kind = cleanKind(input.kind);
    const hint = cleanHint(input.hint, kind);
    if (hint.includes(value) || [...this.fragments.values()].some((fragment) => hint.includes(fragment.value))) {
      throw new Error("hint can't contain a protected value");
    }
    const fragment: Fragment = {
      id: this.newId(),
      value,
      hint,
      kind,
      source: input.source,
      ...(input.detector ? { detector: input.detector } : {}),
      createdBy: input.createdBy.slice(0, 80),
      ...(input.createdThread ? { createdThread: input.createdThread } : {}),
      createdAt: Date.now(),
    };
    if (this.store) {
      const key = await this.masterKey();
      // Another add of the same value may have gone in while the key loaded.
      const raced = [...this.fragments.values()].find((other) => other.value === value);
      if (raced) return { fragment: metaOf(raced), existed: true };
      const { value: plain, ...meta } = fragment;
      this.store.insert({ ...meta, sealed: seal(key, plain) });
    }
    this.fragments.set(fragment.id, fragment);
    this.changed();
    return { fragment: metaOf(fragment), existed: false };
  }

  remove(id: string): boolean {
    if (!this.fragments.has(id)) return false;
    this.store?.remove(id);
    this.fragments.delete(id);
    this.changed();
    return true;
  }

  /**
   * A fragment's value, for the daemon's own use only: the user's reveal route and swapping a reference
   * in where a command runs (secretRefs.ts). Never put what this returns in anything an agent reads.
   */
  reveal(id: string): string | undefined {
    return this.fragments.get(id)?.value;
  }

  meta(id: string): FragmentMeta | undefined {
    const fragment = this.fragments.get(id);
    return fragment ? metaOf(fragment) : undefined;
  }

  /**
   * Fragments whose hint, kind or id match a query, best first: an exact id or hint, then hints that hold
   * every word. Matches metadata only, so an agent can't use it to test a guess at a value.
   */
  find(query: string): FragmentMeta[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const exact = this.fragments.get(q.replace(/^⟦p:/, "").split(/[\s⟧]/)[0]);
    if (exact) return [metaOf(exact)];
    const words = q.split(/\s+/);
    const scored: { meta: FragmentMeta; score: number }[] = [];
    for (const fragment of this.fragments.values()) {
      const hint = fragment.hint.toLowerCase();
      const text = `${hint} ${fragment.kind.toLowerCase()}`;
      if (!words.every((word) => text.includes(word))) continue;
      scored.push({ meta: metaOf(fragment), score: hint === q ? 2 : hint.startsWith(q) ? 1 : 0 });
    }
    return scored.sort((a, b) => b.score - a.score || b.meta.createdAt - a.meta.createdAt).map((entry) => entry.meta);
  }

  /** How often each fragment shows up in these texts: id → number of texts that contain it. */
  count(texts: Iterable<string>): Map<string, number> {
    const counts = new Map<string, number>();
    for (const text of texts) {
      const seen = new Set<string>();
      for (const match of this.matcher.find(text)) seen.add(match.ref.id);
      for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }

  /** Each protected value in text as its token. Tokens already in it stay as they are, so redacting twice changes nothing. */
  redact(text: string): string {
    if (this.matcher.empty || !text) return text;
    if (text.includes("⟦p:")) {
      let out = "";
      let at = 0;
      for (const token of text.matchAll(TOKEN)) {
        out += this.redactPlain(text.slice(at, token.index)) + token[0];
        at = token.index + token[0].length;
      }
      return out + this.redactPlain(text.slice(at));
    }
    return this.redactPlain(text);
  }

  private redactPlain(text: string): string {
    if (!text) return text;
    const matches = this.matcher.find(text);
    if (!matches.length) return text;
    let out = "";
    let at = 0;
    for (const match of matches) {
      out += text.slice(at, match.start) + tokenFor(match.ref);
      at = match.end;
    }
    return out + text.slice(at);
  }

  /** Every string in a JSON-like value (keys too), redacted; the value itself is left alone. */
  redactDeep<T>(value: T): T {
    if (this.matcher.empty) return value;
    return mapStrings(value, (text) => this.redact(text)) as T;
  }

  /**
   * Swap the tokens in what an agent writes back to their values. A token that names no fragment, or
   * one changed since it was read (another hint, cut short), is refused: saving it would lose the value.
   */
  restore(text: string): string {
    if (!text.includes("⟦p:")) return text;
    const out = text.replace(TOKEN, (token, id: string) => {
      const fragment = this.fragments.get(id);
      if (!fragment) throw new VaultTokenError(`${token} is not a protected value this Scribe knows. Leave protected-value tokens out, or copy them exactly as you read them.`);
      if (token !== tokenFor(fragment)) throw new VaultTokenError(`${token} was changed: write it as ${tokenFor(fragment)} (read the page again if its hint changed).`);
      return fragment.value;
    });
    if (out.includes("⟦p:")) throw new VaultTokenError("A protected-value token (⟦p:…⟧) is cut short. Copy each token whole, from ⟦ to ⟧, or leave it out.");
    return out;
  }

  restoreDeep<T>(value: T): T {
    if (!this.fragments.size && !JSON.stringify(value ?? null).includes("⟦p:")) return value;
    return mapStrings(value, (text) => this.restore(text)) as T;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.rebuild();
    this.version += 1;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* a listener's problem is its own */
      }
    }
  }

  private rebuild(): void {
    this.matcher = new Matcher([...this.fragments.values()].map((fragment) => ({ text: fragment.value, ref: fragment })));
  }

  private newId(): string {
    for (;;) {
      const id = crypto.randomBytes(5).toString("hex");
      if (!this.fragments.has(id)) return id;
    }
  }
}

/** Why an agent may not protect this value, or null when it may. */
export function agentValueProblem(value: string): string | null {
  const text = value.trim();
  if (text.length < AGENT_MIN_LENGTH) return `value must be at least ${AGENT_MIN_LENGTH} characters`;
  if (STOP_WORDS.has(text.toLowerCase())) return "value is a common word; ask the user to protect it if it really is sensitive";
  if (!/[\p{L}\p{N}]/u.test(text)) return "value has no letters or digits";
  return null;
}

function cleanKind(kind: unknown): string {
  const text = typeof kind === "string" ? kind.toLowerCase().replace(/[^a-z0-9 _-]/g, "").trim() : "";
  return text.slice(0, 30) || "secret";
}

function metaOf({ value: _value, ...meta }: Fragment): FragmentMeta {
  return meta;
}

function mapStrings(value: unknown, fn: (text: string) => string, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return fn(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    // Dates and the like serialise through toJSON; leave them as they are.
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) out[fn(key)] = mapStrings(child, fn, seen);
  return out;
}

let active = new Vault();
let unavailable: string | null = null;

/** Why the vault could not open (its key is gone or locked), or null. Agents get nothing while it is set. */
export function vaultUnavailable(): string | null {
  return unavailable;
}

export function setVaultUnavailable(reason: string | null): void {
  unavailable = reason;
}

/** The daemon's vault; an empty one until the daemon opens its store. */
export function vault(): Vault {
  return active;
}

export function setVault(next: Vault): void {
  active = next;
}
