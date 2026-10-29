import type { PlanLimits } from "./types.js";

export type WindowProvider = "claude" | "codex";
export type WindowStarts = Record<WindowProvider, boolean>;
export const START_DELAY_MS = 10 * 60_000;
type Entry = { reset?: number; attempted?: number; checked?: number; result?: string };
export type WindowStartState = Partial<Record<WindowProvider, Entry>>;

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
  private busy = new Set<WindowProvider>();
  private generations = new Map<WindowProvider, number>();
  private controllers = new Map<WindowProvider, AbortController>();
  private closed = false;
  constructor(private deps: {
    now(): number;
    enabled(): WindowStarts;
    running(provider: WindowProvider): boolean;
    read(provider: WindowProvider): Promise<PlanLimits | null>;
    start(provider: WindowProvider, signal: AbortSignal): Promise<void>;
    save(state: WindowStartState): void;
  }, private state: WindowStartState = {}) {}

  view(provider: WindowProvider): Entry | undefined { return this.state[provider]; }

  /** An account change invalidates pending probes and the old account's reset. */
  reset(provider: WindowProvider): void {
    this.generations.set(provider, (this.generations.get(provider) ?? 0) + 1);
    this.controllers.get(provider)?.abort();
    delete this.state[provider];
    this.deps.save(this.state);
  }

  observe(provider: WindowProvider, limits: PlanLimits): void {
    if (this.closed) return;
    const reset = fiveHourReset(provider, limits);
    const entry = this.state[provider] ?? {};
    if (reset && (!entry.reset || reset > entry.reset)) {
      this.state = { ...this.state, [provider]: { ...entry, reset } };
      this.deps.save(this.state);
    }
  }

  settingsChanged(): void {
    for (const [provider, controller] of this.controllers) if (!this.deps.enabled()[provider]) controller.abort();
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.closed) return;
    await Promise.all((["claude", "codex"] as const).map((provider) => this.check(provider)));
  }

  private async check(provider: WindowProvider): Promise<void> {
    if (!this.deps.enabled()[provider] || this.busy.has(provider)) return;
    let entry = this.state[provider] ?? {};
    const now = this.deps.now();
    const due = entry.reset && entry.attempted !== entry.reset && now >= entry.reset + START_DELAY_MS;
    if (entry.checked && now - entry.checked < 5 * 60_000 &&
        (!due || entry.checked >= (entry.reset ?? 0) + START_DELAY_MS)) return;
    this.busy.add(provider);
    const generation = this.generations.get(provider);
    try {
      this.state = { ...this.state, [provider]: { ...entry, checked: now } };
      this.deps.save(this.state);
      const report = await this.deps.read(provider);
      if (this.closed || !this.deps.enabled()[provider] || generation !== this.generations.get(provider)) return;
      if (report) this.observe(provider, report);
      entry = this.state[provider] ?? {};
      const reset = entry.reset;
      if (!reset || entry.attempted === reset || this.deps.now() < reset + START_DELAY_MS) return;
      // Missing quota is never permission to send. Recheck later without a model request.
      if (!report) return;
      const result = this.deps.running(provider) ? "Skipped: provider is working" :
        windowStartBlocked(provider, report, this.deps.now()) ? "Skipped: included usage unavailable" : "Sending";
      this.record(provider, reset, result);
      if (result !== "Sending") return;
      const controller = new AbortController();
      this.controllers.set(provider, controller);
      const deadline = setTimeout(() => controller.abort(), 60_000);
      deadline.unref?.();
      try {
        await this.deps.start(provider, controller.signal);
        if (!this.closed && generation === this.generations.get(provider)) this.record(provider, reset, "Sent");
      } catch {
        if (!this.closed && generation === this.generations.get(provider)) this.record(provider, reset, "Failed or cancelled; no retry this window");
      } finally {
        clearTimeout(deadline);
        this.controllers.delete(provider);
      }
      if (!this.closed && this.deps.enabled()[provider] && generation === this.generations.get(provider)) {
        const after = await this.deps.read(provider);
        if (after && !this.closed && generation === this.generations.get(provider)) this.observe(provider, after);
      }
    } catch {
      // Quota failures may be read again; they never trigger a model request.
    } finally { this.busy.delete(provider); }
  }

  private record(provider: WindowProvider, attempted: number, result: string): void {
    this.state = { ...this.state, [provider]: { ...this.state[provider], attempted, result } };
    this.deps.save(this.state);
  }

  dispose(): void {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
  }
}
