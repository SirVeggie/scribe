import type { PlanLimits } from "./types.js";

export type WindowProvider = "claude" | "codex";
export type WindowStarts = Record<WindowProvider, boolean>;
/** A login whose 5-hour window is started: the default Claude login, Codex, or an added Claude account (#926). */
export type WindowKey = WindowProvider | `claude:${string}`;
export const windowProvider = (key: WindowKey): WindowProvider => key === "codex" ? "codex" : "claude";
export const START_DELAY_MS = 10 * 60_000;
type Entry = { reset?: number; attempted?: number; checked?: number; result?: string };
export type WindowStartState = Partial<Record<WindowKey, Entry>>;

export function cleanWindowStarts(value: unknown): WindowStarts {
  const v = value as Partial<WindowStarts> | null;
  return { claude: v?.claude === true, codex: v?.codex === true };
}

export function fiveHourReset(provider: WindowProvider, limits: PlanLimits): number | undefined {
  const window = limits.windows.find((w) => provider === "claude" ? w.id === "five_hour" :
    w.id === "codex:codex:primary" && /(?:^| · )5-hour$/.test(w.label));
  return window?.resetsAt && Number.isFinite(window.resetsAt) ? window.resetsAt : undefined;
}

export function windowStartBlocked(provider: WindowProvider, limits: PlanLimits, now: number): boolean {
  if (!limits.windows.some((w) => w.id === (provider === "claude" ? "five_hour" : "codex:codex:primary"))) return true;
  if (limits.availability && limits.availability !== "available") return true;
  if (provider === "codex" && limits.ordinaryUsageAllowed !== true) return true;
  return limits.windows.some((w) => w.utilization >= 1 && (!w.resetsAt || w.resetsAt > now) &&
    (provider === "claude" ? w.id === "seven_day" || w.id === "seven_day_oauth_apps" : w.id === "codex:codex:secondary"));
}

/** Server timestamps only. An attempt is saved before sending, including failures. */
export class UsageWindowStarts {
  private busy = new Set<WindowKey>();
  private generations = new Map<WindowKey, number>();
  private controllers = new Map<WindowKey, AbortController>();
  private closed = false;
  constructor(private deps: {
    now(): number;
    enabled(): WindowStarts;
    /** Added Claude accounts, checked alongside the default login. */
    accounts?(): WindowKey[];
    running(key: WindowKey): boolean;
    read(key: WindowKey): Promise<PlanLimits | null>;
    start(key: WindowKey, signal: AbortSignal): Promise<void>;
    save(state: WindowStartState): void;
  }, private state: WindowStartState = {}) {}

  view(key: WindowKey): Entry | undefined { return this.state[key]; }

  /** An account change invalidates pending probes and the old account's reset. */
  reset(key: WindowKey): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.controllers.get(key)?.abort();
    delete this.state[key];
    this.deps.save(this.state);
  }

  observe(key: WindowKey, limits: PlanLimits): void {
    if (this.closed) return;
    const reset = fiveHourReset(windowProvider(key), limits);
    const entry = this.state[key] ?? {};
    if (reset && (!entry.reset || reset > entry.reset)) {
      this.state = { ...this.state, [key]: { ...entry, reset } };
      this.deps.save(this.state);
    }
  }

  settingsChanged(): void {
    for (const [key, controller] of this.controllers) if (!this.deps.enabled()[windowProvider(key)]) controller.abort();
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.closed) return;
    const keys: WindowKey[] = ["claude", "codex", ...(this.deps.accounts?.() ?? [])];
    await Promise.all(keys.map((key) => this.check(key)));
  }

  private async check(key: WindowKey): Promise<void> {
    const provider = windowProvider(key);
    if (!this.deps.enabled()[provider] || this.busy.has(key)) return;
    let entry = this.state[key] ?? {};
    const now = this.deps.now();
    const due = entry.reset && entry.attempted !== entry.reset && now >= entry.reset + START_DELAY_MS;
    if (entry.checked && now - entry.checked < 5 * 60_000 &&
        (!due || entry.checked >= (entry.reset ?? 0) + START_DELAY_MS)) return;
    this.busy.add(key);
    const generation = this.generations.get(key);
    try {
      this.state = { ...this.state, [key]: { ...entry, checked: now } };
      this.deps.save(this.state);
      const report = await this.deps.read(key);
      if (this.closed || !this.deps.enabled()[provider] || generation !== this.generations.get(key)) return;
      if (report) this.observe(key, report);
      entry = this.state[key] ?? {};
      const reset = entry.reset;
      if (!reset || entry.attempted === reset || this.deps.now() < reset + START_DELAY_MS) return;
      // Missing quota is never permission to send. Recheck later without a model request.
      if (!report) return;
      const result = this.deps.running(key) ? "Skipped: provider is working" :
        windowStartBlocked(provider, report, this.deps.now()) ? "Skipped: included usage unavailable" : "Sending";
      this.record(key, reset, result);
      if (result !== "Sending") return;
      const controller = new AbortController();
      this.controllers.set(key, controller);
      const deadline = setTimeout(() => controller.abort(), 60_000);
      deadline.unref?.();
      try {
        await this.deps.start(key, controller.signal);
        if (!this.closed && generation === this.generations.get(key)) this.record(key, reset, "Sent");
      } catch {
        if (!this.closed && generation === this.generations.get(key)) this.record(key, reset, "Failed or cancelled; no retry this window");
      } finally {
        clearTimeout(deadline);
        this.controllers.delete(key);
      }
      if (!this.closed && this.deps.enabled()[provider] && generation === this.generations.get(key)) {
        const after = await this.deps.read(key);
        if (after && !this.closed && generation === this.generations.get(key)) this.observe(key, after);
      }
    } catch {
      // Quota failures may be read again; they never trigger a model request.
    } finally { this.busy.delete(key); }
  }

  private record(key: WindowKey, attempted: number, result: string): void {
    this.state = { ...this.state, [key]: { ...this.state[key], attempted, result } };
    this.deps.save(this.state);
  }

  dispose(): void {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
  }
}
