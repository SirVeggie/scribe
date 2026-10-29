import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { claudeToolsOff, customKey, scribeToolsOff } from "../customModes.js";
import { randomUUID } from "node:crypto";
import { ClaudeUsageDelta, claudeBillingSource, claudePlanSnapshot } from "../claudeUsage.js";
import { planLimitsFromRateLimitInfo } from "../planLimits.js";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { log } from "../../log.js";
import type { ModelOption, ProviderStatus, SlashCommand, TaskInfo, Thread, ToolKind } from "../types.js";
import { APPROVAL_LABEL, isPlainRecord, noPages, pagesReadsFiles } from "../types.js";
import { webCallAllowed, type WebCall } from "../webAccess.js";
import { claudeServerConfig, serversKey, toolPolicy, type ResolvedMcpServer } from "../mcpConfig.js";
import { McpPermissions, mcpApprovalOptions } from "../mcpPermissions.js";
import { SparePool, type AgentProvider, type ProviderSession, type RunSink, type SessionContext, type SteerInput, type TurnInput, type TurnResult } from "./provider.js";
import { threadToken } from "../../callers.js";
import { outputImages } from "../outputImages.js";
import { authCommand } from "./authCommand.js";

/**
 * Claude through the Claude Agent SDK. One long-lived query per thread in streaming-input mode,
 * so follow-up messages reuse the same Claude Code process. The SDK is loaded lazily so the
 * daemon starts without it.
 */

type Sdk = typeof import("@anthropic-ai/claude-agent-sdk");
type Query = import("@anthropic-ai/claude-agent-sdk").Query;
type Options = import("@anthropic-ai/claude-agent-sdk").Options;
type SDKMessage = import("@anthropic-ai/claude-agent-sdk").SDKMessage;
type SDKUserMessage = import("@anthropic-ai/claude-agent-sdk").SDKUserMessage;
type PermissionResult = import("@anthropic-ai/claude-agent-sdk").PermissionResult;
type PermissionMode = import("@anthropic-ai/claude-agent-sdk").PermissionMode;
type EffortLevel = import("@anthropic-ai/claude-agent-sdk").EffortLevel;
type HookJSONOutput = import("@anthropic-ai/claude-agent-sdk").HookJSONOutput;
type McpServerConfig = import("@anthropic-ai/claude-agent-sdk").McpServerConfig;

let sdkPromise: Promise<Sdk> | null = null;
function loadSdk(): Promise<Sdk> {
  sdkPromise ??= import("@anthropic-ai/claude-agent-sdk");
  return sdkPromise;
}

const IDLE_CLOSE_MS = 15 * 60 * 1000;
const MODELS_TTL_MS = 6 * 60 * 60 * 1000;
/** How long a signed-in answer from `claude auth status` is trusted; a signed-out one is asked again each time. */
const AUTH_TTL_MS = 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const BOARD_SERVER = "scribe";
/** Claude Code's read tools: a Pages thread with a workspace gets these and no others for files (#718). */
const PAGES_READ_TOOLS = ["Read", "Grep", "Glob"];

const EFFORT_LABELS: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/** Push-based async iterable feeding user messages into a streaming query. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(item: SDKUserMessage): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.items.length) {
          return Promise.resolve({ value: this.items.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

/** The Claude Code binary the SDK runs: its platform package, the same lookup the SDK makes. */
function claudeBinary(): string | null {
  const require = createRequire(import.meta.url);
  const base = "@anthropic-ai/claude-agent-sdk";
  const exe = process.platform === "win32" ? ".exe" : "";
  const arch = process.arch;
  const names = process.platform === "linux" ? [`${base}-linux-${arch}`, `${base}-linux-${arch}-musl`] : [`${base}-${process.platform}-${arch}`];
  for (const name of names) {
    try {
      return require.resolve(`${name}/claude${exe}`);
    } catch {
      /* next */
    }
  }
  return null;
}

type ClaudeAuth = { loggedIn: boolean; authMethod?: string; email?: string; apiProvider?: string; apiKeySource?: string };

/** The environment for an added account's config folder (#452). */
function accountEnv(dir: string): NodeJS.ProcessEnv {
  return { ...process.env, CLAUDE_CONFIG_DIR: dir };
}

/** `claude auth status --json`: the login the SDK will use (claude.ai, API key, or a cloud provider). */
function claudeAuthStatus(binary: string, dir?: string): Promise<ClaudeAuth | null> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["auth", "status", "--json"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, ...(dir ? { env: accountEnv(dir) } : {}) });
    let out = "";
    const timer = setTimeout(() => stopChild(child), 15_000);
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      try {
        const parsed: unknown = JSON.parse(out);
        resolve(isPlainRecord(parsed) && typeof parsed.loggedIn === "boolean" ? (parsed as ClaudeAuth) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

function authDetail(auth: ClaudeAuth): string {
  return ["Claude Agent SDK", auth.apiProvider, auth.authMethod,
    auth.apiKeySource && auth.apiKeySource !== "none" ? `API key: ${auth.apiKeySource}` : undefined, auth.email].filter(Boolean).join(" · ");
}

function stopChild(child: ChildProcess): void {
  if (!child.pid || child.exitCode != null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
}

/** Claude Code's /usage control request. The method name is still experimental in the SDK. */
async function queryPlanUsage(q: Query): Promise<unknown | null> {
  const rec = q as unknown as Record<string, unknown>;
  const fn = rec.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET ?? rec.getUsage;
  if (typeof fn !== "function") return null;
  try {
    return await (fn as (opts?: { skipBehaviors?: boolean }) => Promise<unknown>).call(q, { skipBehaviors: true });
  } catch (err) {
    log(`Claude usage fetch failed: ${(err as Error).message}`);
    return null;
  }
}

/** Claude Code's own count of a session's context before the first message. */
export type ContextMeasure = {
  model: string;
  totalTokens: number;
  maxTokens: number;
  /** deferred: tool schemas listed by name only, loaded when the agent asks for them. */
  categories: Array<{ name: string; tokens: number; deferred: boolean }>;
  mcpTools: Array<{ name: string; server: string; tokens: number; loaded: boolean }>;
  memoryFiles: Array<{ path: string; type: string; tokens: number }>;
  skills: Array<{ name: string; source: string; tokens: number }>;
  systemTools: Array<{ name: string; tokens: number }>;
  systemPromptSections: Array<{ name: string; tokens: number }>;
};

export class ClaudeProvider implements AgentProvider {
  readonly id = "claude" as const;
  readonly label = "Claude";
  readonly forks = true;
  private modelCache: { at: number; models: ModelOption[] } | null = null;
  private modelLoad: Promise<ModelOption[]> | null = null;
  private sessions = new Set<ClaudeSession>();
  private spares = new SparePool<ClaudeSession>();
  private auth: { at: number; value: ClaudeAuth } | null = null;
  private login: Promise<void> | null = null;
  private loginAbort: AbortController | null = null;

  async status(): Promise<ProviderStatus> {
    try {
      await loadSdk();
    } catch (err) {
      return { id: this.id, label: this.label, available: false, detail: `Claude Agent SDK is not installed: ${(err as Error).message}` };
    }
    const auth = await this.authStatus();
    // No answer (an older binary, a spawn error): leave it to the SDK, as before.
    if (!auth) return { id: this.id, label: this.label, available: true, detail: "Claude Agent SDK" };
    if (auth.loggedIn) return { id: this.id, label: this.label, available: true, detail: authDetail(auth),
      logout: auth.authMethod === "claude.ai" || auth.apiKeySource === "/login managed key" };
    return {
      id: this.id,
      label: this.label,
      available: false,
      detail: this.login ? "Finish the login in your browser" : "Not logged in (log in, or set ANTHROPIC_API_KEY)",
      login: true,
    };
  }

  private async authStatus(): Promise<ClaudeAuth | null> {
    if (this.auth?.value.loggedIn && Date.now() - this.auth.at < AUTH_TTL_MS) return this.auth.value;
    const binary = claudeBinary();
    const value = binary ? await claudeAuthStatus(binary) : null;
    if (!value) return null;
    // Models listed while signed out have generic names ("Opus"); list them again once signed in.
    if (value.loggedIn && this.auth && !this.auth.value.loggedIn) this.modelCache = null;
    this.auth = { at: Date.now(), value };
    return value;
  }

  /**
   * `claude auth login`: Claude Code opens the browser itself and takes the sign-in on its own
   * localhost callback, so there is no URL to hand back (the one it prints wants a code pasted).
   */
  async startLogin(): Promise<{ url: string | null }> {
    // Closing the browser does not end `claude auth login`: logging in again starts a fresh one.
    this.loginAbort?.abort();
    const abort = new AbortController();
    this.loginAbort = abort;
    const login: Promise<void> = this.runLogin(undefined, abort.signal).then(() => undefined).finally(() => {
      if (this.login !== login) return;
      this.auth = null;
      this.modelCache = null;
      this.login = null;
      this.loginAbort = null;
    });
    this.login = login;
    return { url: null };
  }

  /** Sign an added account's config folder in (#452). Resolves whether the sign-in went through. */
  loginAccount(dir: string, signal?: AbortSignal): Promise<boolean> {
    return this.runLogin(dir, signal);
  }

  /** signal: stop the sign-in (the user closed the browser and starts again, or cancels). */
  private runLogin(dir?: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    const binary = claudeBinary();
    if (!binary) return Promise.reject(new Error("The Claude Code binary for this platform is not installed."));
    const child = spawn(binary, ["auth", "login"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...(dir ? { env: accountEnv(dir) } : {}) });
    let output = "";
    const take = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4000);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => stopChild(child), LOGIN_TIMEOUT_MS);
    timer.unref?.();
    const stop = () => stopChild(child);
    signal?.addEventListener("abort", stop, { once: true });
    return new Promise<boolean>((resolve) => {
      child.once("error", (err) => {
        log(`Claude login failed: ${err.message}`);
        resolve(false);
      });
      child.once("exit", (code) => {
        if (code === 0) {
          log("Claude login done");
        } else {
          const tail = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
          log(`Claude login failed (exit ${code ?? "null"})${tail ? `: ${tail}` : ""}`);
        }
        resolve(code === 0 && !signal?.aborted);
      });
    }).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    });
  }

  /** `claude auth status` for an added account's folder; null when it gives no answer. */
  accountStatus(dir: string): Promise<{ loggedIn: boolean; email?: string } | null> {
    const binary = claudeBinary();
    return binary ? claudeAuthStatus(binary, dir) : Promise.resolve(null);
  }

  /** Log an added account out (#452). Its sessions are the host's to close first. */
  async logoutAccount(id: string, dir: string): Promise<void> {
    const binary = claudeBinary();
    if (!binary) throw new Error("The Claude Code binary for this platform is not installed.");
    this.spares.drop((key) => key.endsWith(`,${JSON.stringify(id)}]`));
    await authCommand(binary, ["auth", "logout"], accountEnv(dir), "Claude log out");
  }

  async logout(): Promise<void> {
    if (this.login) throw new Error("Finish the Claude login before logging out.");
    const binary = claudeBinary();
    if (!binary) throw new Error("The Claude Code binary for this platform is not installed.");
    await this.modelLoad;
    this.dispose();
    await authCommand(binary, ["auth", "logout"], process.env, "Claude log out");
    // Signed out until a status check says otherwise (a signed-out answer is never trusted for long).
    this.auth = { at: Date.now(), value: { loggedIn: false } };
    this.modelCache = null;
  }

  /** The default folder's login changed hands (#452): check it again, and drop spares started with the old one. */
  loginSwapped(): void {
    this.auth = null;
    this.modelCache = null;
    this.spares.dispose();
  }

  /** Whether the default login was signed in when last checked; null before the first check (#452). */
  signedIn(): boolean | null {
    return this.auth ? this.auth.value.loggedIn : null;
  }

  models(refresh = false): Promise<ModelOption[]> {
    if (!refresh && this.modelCache && Date.now() - this.modelCache.at < MODELS_TTL_MS) {
      return Promise.resolve(this.modelCache.models);
    }
    if (this.modelLoad) {
      return this.modelLoad;
    }
    this.modelLoad = this.loadModels().finally(() => {
      this.modelLoad = null;
    });
    return this.modelLoad;
  }

  cachedModels(): ModelOption[] {
    return this.modelCache?.models ?? [];
  }

  setModelCache(models: ModelOption[]): void {
    if (models.length) this.modelCache = { at: Date.now(), models };
  }

  private async loadModels(): Promise<ModelOption[]> {
    const sdk = await loadSdk();
    const input = new InputQueue();
    const abortController = new AbortController();
    const q = sdk.query({ prompt: input, options: { settingSources: [], tools: [], persistSession: false, abortController } });
    try {
      const infos = await q.supportedModels();
      const models: ModelOption[] = infos.map((info) => ({
        id: info.value,
        label: info.displayName || info.value,
        provider: "claude",
        description: info.description,
        efforts: (info.supportedEffortLevels ?? []).map((level) => ({ id: level, label: EFFORT_LABELS[level] ?? level })),
        defaultEffort: null,
        params: [],
      }));
      this.setModelCache(models);
      return models;
    } catch (err) {
      log(`Claude model list failed: ${(err as Error).message}`);
      return this.modelCache?.models ?? [];
    } finally {
      input.close();
      try {
        q.close();
      } catch {
        abortController.abort();
      }
    }
  }

  /**
   * What a session of this thread holds before its first message, counted by Claude Code itself
   * (its /context report). plain: Claude Code as it runs on its own in the same folder, without
   * Scribe's instructions, tools or MCP list, to compare against. Starts a process; calls no model.
   */
  async measureContext(thread: Thread, instructions: string, ctx: SessionContext, plain = false): Promise<ContextMeasure> {
    const sdk = await loadSdk();
    const input = new InputQueue();
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 90_000);
    const session = new ClaudeSession({ ...thread, nativeId: null }, ctx, () => undefined);
    const scribe = session.measureOptions(instructions);
    const options: Options = plain
      ? {
          cwd: scribe.cwd,
          ...(scribe.model ? { model: scribe.model } : {}),
          settingSources: ["user", "project", "local"],
          settings: { disableAllHooks: true },
          systemPrompt: { type: "preset", preset: "claude_code" },
          tools: { type: "preset", preset: "claude_code" },
        }
      : scribe;
    const q = sdk.query({ prompt: input, options: { ...options, persistSession: false, abortController } });
    try {
      // MCP servers connect after the process starts; a count taken before that misses their tools.
      for (let i = 0; i < 60; i += 1) {
        const servers = await q.mcpServerStatus();
        if (!servers.some((server) => server.status === "pending")) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const usage = await q.getContextUsage();
      return {
        model: usage.model,
        totalTokens: usage.totalTokens,
        maxTokens: usage.rawMaxTokens,
        categories: usage.categories.filter((c) => c.kind === "used" || c.kind === "deferred").map((c) => ({ name: c.name, tokens: c.tokens, deferred: c.kind === "deferred" })),
        mcpTools: usage.mcpTools.map((t) => ({ name: t.name, server: t.serverName, tokens: t.tokens, loaded: t.isLoaded !== false })),
        memoryFiles: usage.memoryFiles.map((f) => ({ path: f.path, type: f.type, tokens: f.tokens })),
        skills: (usage.skills?.skillFrontmatter ?? []).map((s) => ({ name: s.name, source: s.source, tokens: s.tokens })),
        systemTools: (usage.systemTools ?? []).map((t) => ({ name: t.name, tokens: t.tokens })),
        systemPromptSections: (usage.systemPromptSections ?? []).map((t) => ({ name: t.name, tokens: t.tokens })),
      };
    } finally {
      clearTimeout(timer);
      input.close();
      try {
        q.close();
      } catch {
        abortController.abort();
      }
    }
  }

  /** A single context-free subscription request; check the active query before releasing its input. */
  async startUsageWindow(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const sdk = await loadSdk();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-window-claude-"));
    const input = new InputQueue();
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let q;
    try {
      q = sdk.query({ prompt: input, options: {
        cwd, model: "haiku", systemPrompt: "Reply only with hi.", settingSources: [], tools: [],
        mcpServers: {}, persistSession: false, maxTurns: 1, abortController,
        thinking: { type: "disabled" },
      } });
      const account = await q.accountInfo();
      if (account.apiProvider !== "firstParty" || (account.apiKeySource && account.apiKeySource !== "none") ||
          !/^(pro|max|team|enterprise)/i.test(account.subscriptionType ?? "")) {
        throw new Error("Claude subscription source unavailable");
      }
      const usage = await queryPlanUsage(q);
      const { planLimitsFromUsageReport } = await import("../planLimits.js");
      const { windowStartBlocked } = await import("../usageWindowStarts.js");
      const limits = planLimitsFromUsageReport(usage, Date.now());
      if (!limits || windowStartBlocked("claude", limits, Date.now()) || limits.windows.some((w) =>
        w.id === "five_hour" && w.utilization >= 1 && (!w.resetsAt || w.resetsAt > Date.now()))) {
        throw new Error("Claude included usage unavailable");
      }
      signal.throwIfAborted();
      input.push({ type: "user", message: { role: "user", content: "Hello. Reply only with hi." },
        parent_tool_use_id: null, session_id: "" });
      for await (const msg of q) {
        if (msg.type !== "result") continue;
        if (msg.subtype === "success" && !msg.is_error) return;
        throw new Error("Claude window request failed");
      }
      throw new Error("Claude sent no result");
    } finally {
      signal.removeEventListener("abort", abort);
      input.close();
      try { q?.close(); } catch { abort(); }
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  async complete(prompt: string, model: string, signal?: AbortSignal): Promise<string> {
    const sdk = await loadSdk();
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const q = sdk.query({
      prompt,
      options: { ...(model && model !== "default" ? { model } : {}), settingSources: [], tools: [], persistSession: false, maxTurns: 1, abortController },
    });
    try {
      for await (const msg of q) {
        if (msg.type !== "result") continue;
        if (msg.subtype === "success") {
          if (msg.is_error) throw new Error(msg.result || "Claude reported an error");
          return msg.result;
        }
        throw new Error(msg.errors?.join("\n") || `Claude stopped: ${msg.subtype}`);
      }
      throw new Error("Claude sent no answer");
    } finally {
      signal?.removeEventListener("abort", abort);
      try {
        q.close();
      } catch {
        abortController.abort();
      }
    }
  }

  createSession(thread: Thread, ctx: SessionContext): ProviderSession {
    const spare = thread.nativeId ? null : this.spares.take(claudeSpareKey(thread), thread.id);
    if (spare) {
      spare.update(thread);
      return spare;
    }
    const session = new ClaudeSession(thread, ctx, () => this.sessions.delete(session));
    this.sessions.add(session);
    return session;
  }

  spareThreadId(thread: Thread): string | null {
    return this.spares.get(claudeSpareKey(thread))?.scribeThreadId() ?? null;
  }

  prewarm(draft: Thread, instructions: string, ctx: SessionContext): void {
    const key = claudeSpareKey(draft);
    let spare = this.spares.get(key);
    if (spare) {
      spare.update(draft);
    } else {
      const session = new ClaudeSession(draft, ctx, () => this.sessions.delete(session));
      this.sessions.add(session);
      this.spares.put(key, session);
      spare = session;
    }
    void spare.warm(instructions);
  }

  dispose(): void {
    this.spares.dispose();
    for (const session of this.sessions) {
      session.dispose();
    }
  }

  /**
   * Default-environment plan usage without a model message. Thread queries report
   * separately so project credentials never overwrite this default snapshot.
   */
  async fetchPlanUsage(dir?: string): Promise<unknown | null> {
    return this.fetchPlanUsageStandalone(dir);
  }

  /** dir: an added account's config folder (#452). */
  private async fetchPlanUsageStandalone(dir?: string): Promise<unknown | null> {
    const sdk = await loadSdk();
    const input = new InputQueue();
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 45_000);
    const q = sdk.query({ prompt: input, options: { settingSources: ["user"], tools: [], persistSession: false, abortController,
      ...(dir ? { env: { ...accountEnv(dir), CLAUDE_AGENT_SDK_CLIENT_APP: "scribe/1" } } : {}) } });
    try {
      const source = await q.accountInfo().then(claudeBillingSource, () => ({}));
      return { report: await queryPlanUsage(q), billingSource: source };
    } catch (err) {
      log(`Claude usage fetch failed: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
      input.close();
      try {
        q.close();
      } catch {
        abortController.abort();
      }
    }
  }
}

/** What a running Claude process cannot change: its tools, folder, and instructions (which follow the scope). */
function claudeSpareKey(thread: Thread): string {
  return JSON.stringify([thread.mode, customKey(thread), thread.web, thread.cwd, thread.scope.kind, thread.scope.ref, thread.claudeAccount ?? null]);
}

export function permissionModeFor(thread: Pick<Thread, "mode" | "approval">): PermissionMode {
  if (thread.mode === "board") return "dontAsk";
  switch (thread.approval) {
    case "edits":
      return "acceptEdits";
    case "auto":
      return "auto";
    case "full":
      return "bypassPermissions";
    default:
      return "default";
  }
}

/**
 * The label for applying Claude's suggested permission rules: they last for the session when every
 * one is kept in the session, and otherwise go into a settings file.
 */
export function suggestionsLabel(suggestions: unknown[]): string {
  return suggestions.every((s) => isPlainRecord(s) && s.destination === "session") ? "Allow for this session" : "Always allow";
}

const SUGGESTION_PLACE: Record<string, string> = {
  session: "for this session",
  cliArg: "for this session",
  localSettings: "in this project's local settings",
  projectSettings: "in this project's shared settings",
  userSettings: "in your user settings (every project)",
};

/** What applying Claude's suggested permission rules does, in one line per change: the rules and where they go. */
export function suggestionsDescription(suggestions: unknown[]): string {
  const rule = (r: unknown) => {
    if (!isPlainRecord(r) || typeof r.toolName !== "string") return "";
    return typeof r.ruleContent === "string" && r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;
  };
  const lines: string[] = [];
  for (const s of suggestions) {
    if (!isPlainRecord(s)) continue;
    const place = SUGGESTION_PLACE[String(s.destination)] ?? "";
    const rules = Array.isArray(s.rules) ? s.rules.map(rule).filter(Boolean).join(", ") : "";
    const dirs = Array.isArray(s.directories) ? s.directories.filter((d) => typeof d === "string").join(", ") : "";
    // Allow rules go under an "Always allow" label, so they need no verb of their own.
    const verb = s.behavior === "deny" ? "Deny " : s.behavior === "ask" ? "Ask for " : "";
    let line = "";
    if (s.type === "addRules" && rules) line = `${verb}${rules}`;
    else if (s.type === "replaceRules" && rules) line = `${verb || "Allow "}only ${rules}`;
    else if (s.type === "removeRules" && rules) line = `Remove ${rules}`;
    else if (s.type === "addDirectories" && dirs) line = `Allow access to ${dirs}`;
    else if (s.type === "removeDirectories" && dirs) line = `Remove access to ${dirs}`;
    else if (s.type === "setMode" && typeof s.mode === "string") line = `Switch to ${s.mode} mode`;
    if (line) lines.push(place ? `${line} ${place}` : line);
  }
  return lines.join("\n");
}

function toolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "mcp";
  switch (name) {
    case "Read":
    case "NotebookRead":
      return "read";
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    case "Bash":
    case "BashOutput":
    case "KillShell":
    case "KillBash":
    case "PowerShell":
      return "execute";
    case "Grep":
    case "Glob":
    case "LS":
    case "ToolSearch":
      return "search";
    case "WebSearch":
    case "WebFetch":
      return "fetch";
    case "Task":
    case "Agent":
      return "task";
    case "TodoWrite":
      return "todo";
    default:
      return "other";
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function relPath(file: string, cwd: string | null): string {
  if (!cwd) return file;
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.replaceAll("\\", "/") : file;
}

/** A short title and optional detail line for a tool call, from its input. */
export function describeTool(name: string, input: unknown, cwd: string | null): { title: string; detail?: string; paths?: string[] } {
  const inp = isPlainRecord(input) ? input : {};
  const file = str(inp.file_path) ?? str(inp.notebook_path) ?? str(inp.path);
  if (name.startsWith("mcp__")) {
    const [, server, ...rest] = name.split("__");
    const tool = rest.join("__");
    const key = str(inp.key) ?? str(inp.title) ?? str(inp.query) ?? str(inp.q) ?? str(inp.thread);
    return { title: `${server === BOARD_SERVER ? "Scribe" : server}: ${tool}${key ? ` · ${key}` : ""}` };
  }
  switch (name) {
    case "Read":
      return { title: `Read ${file ? relPath(file, cwd) : "file"}`, paths: file ? [file] : undefined };
    case "Write":
      return { title: `Write ${file ? relPath(file, cwd) : "file"}`, paths: file ? [file] : undefined };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { title: `Edit ${file ? relPath(file, cwd) : "file"}`, paths: file ? [file] : undefined };
    case "Bash":
    case "PowerShell":
      return { title: str(inp.description) ?? "Run command", detail: str(inp.command) };
    case "Grep":
      return { title: `Search ${JSON.stringify(str(inp.pattern) ?? "")}${str(inp.path) ? ` in ${relPath(str(inp.path)!, cwd)}` : ""}` };
    case "Glob":
      return { title: `Find ${str(inp.pattern) ?? "files"}` };
    case "LS":
      return { title: `List ${file ? relPath(file, cwd) : "directory"}` };
    case "WebSearch":
      return { title: `Web search: ${str(inp.query) ?? ""}` };
    case "WebFetch":
      return { title: `Fetch ${str(inp.url) ?? ""}`, detail: str(inp.prompt) };
    case "Task":
    case "Agent":
      return { title: `Subagent: ${str(inp.description) ?? str(inp.subagent_type) ?? "task"}`, detail: str(inp.prompt) };
    case "TodoWrite":
      return { title: "Update todos" };
    case "Skill":
      return { title: `Skill: ${str(inp.skill) ?? str(inp.name) ?? ""}` };
    default:
      return { title: name };
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (isPlainRecord(block) && block.type === "text" && typeof block.text === "string") return block.text;
      if (isPlainRecord(block) && block.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

class ClaudeSession implements ProviderSession {
  private accounting = new ClaudeUsageDelta();
  private queryReady: Promise<void> = Promise.resolve();
  private queryLimits = claudePlanSnapshot(null, {});
  private query: Query | null = null;
  private input: InputQueue | null = null;
  private abortController: AbortController | null = null;
  private sink: RunSink | null = null;
  private finish: ((result: TurnResult) => void) | null = null;
  private cancelled = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private live: { model: string; effort: string | null; permission: PermissionMode; key: string } | null = null;
  private sessionId: string | null;
  private commandList: SlashCommand[] = [];
  private stderrTail = "";
  private instructions = "";
  /** Streamed tool_use blocks by content index for the current message. */
  private streamTools = new Map<number, string>();
  /** page_show calls whose input is still streaming, by block index: the JSON so far, until its head is reported. */
  private streamPageShows = new Map<number, string>();
  private streamedText = false;
  /** What a slash command Claude Code ran itself (/context, /autocompact) answered; shown when its turn ends well. */
  private commandOutput = "";
  /**
   * Steering. Claude Code queues a message sent mid-turn and folds it into the running turn between
   * tool rounds; one it could not fold runs as its own turn as soon as the current one ends. Its
   * command_lifecycle frames say which: "started" while the turn is open means folded.
   */
  private steers = new Map<string, "pending" | "dropped">();
  /** Between run() handing a message over and its result. */
  private turnOpen = false;
  /** A steered message running (or about to run) as its own turn; its frames wait in `buffer` until the host adopts it. */
  private carry: string | null = null;
  private buffer: SDKMessage[] = [];
  /** A dropped steer that started anyway: interrupted, and its frames ignored until its result. */
  private swallowing: string | null = null;
  /**
   * Tool calls started in the current turn. Subagent frames whose parent is not among them belong
   * to a subagent from an earlier turn, still working in the background: only its task row updates.
   */
  private turnTools = new Set<string>();
  /** Tokens in the context after the latest main-thread model call. */
  private contextTokens = 0;
  private modelCalls = new Set<string>();
  /** Live tasks (subagents, background commands) by task id, to the tool call that started them. */
  private tasks = new Map<string, string>();
  /** Background tasks still working; while there are any, the idle timer leaves the process alone. */
  private backgroundLive = new Set<string>();

  constructor(
    private thread: Thread,
    private ctx: SessionContext,
    private onDispose: () => void
  ) {
    this.sessionId = thread.nativeId;
  }

  scribeThreadId(): string {
    return this.thread.id;
  }

  /** The options a new session of this thread starts with, for measuring its context. */
  measureOptions(instructions: string): Options {
    this.instructions = instructions;
    return this.buildOptions();
  }

  /** Options that need a new process when they change. */
  private restartKey(thread: Thread): string {
    return JSON.stringify([thread.id, thread.mode, customKey(thread), thread.web, thread.cwd, noPages(thread.scope), this.instructions, this.ctx.claudeHooks?.() ?? false, serversKey(this.userServers()), thread.claudeAccount ?? null]);
  }

  update(thread: Thread): void {
    this.thread = thread;
    const q = this.query;
    if (!q || !this.live) return;
    if (this.live.key !== this.restartKey(thread)) {
      // Background agents would die with the process; the next turn restarts it instead.
      if (!this.sink && !this.carry && !this.backgroundLive.size) this.close();
      return;
    }
    if (thread.model !== this.live.model) {
      this.live.model = thread.model;
      void q.setModel(thread.model === "default" ? undefined : thread.model).catch((err) => log(`Claude setModel failed: ${err}`));
    }
    if (thread.effort !== this.live.effort) {
      this.live.effort = thread.effort;
      void q.applyFlagSettings({ effortLevel: (thread.effort as EffortLevel) ?? null }).catch((err) => log(`Claude effort change failed: ${err}`));
    }
    const permission = permissionModeFor(thread);
    if (permission !== this.live.permission) {
      this.live.permission = permission;
      void q.setPermissionMode(permission).catch((err) => log(`Claude permission mode change failed: ${err}`));
    }
  }

  async commands(): Promise<SlashCommand[]> {
    if (this.query && !this.commandList.length) {
      try {
        const list = await this.query.supportedCommands();
        this.commandList = list.map((cmd) => ({ name: cmd.name, description: cmd.description, hint: cmd.argumentHint }));
      } catch {
        /* not ready */
      }
    }
    return this.commandList;
  }

  private cwd(): string {
    return this.thread.cwd || this.ctx.scratchDir;
  }

  /** The user's servers from Agent settings; with them, Claude Code's own MCP config is left out (strictMcpConfig). */
  private userServers(): ResolvedMcpServer[] {
    return this.ctx.mcpServers?.(this.thread) ?? [];
  }

  private buildOptions(): Options {
    const thread = this.thread;
    const board = thread.mode === "board";
    // Always there: with web off or limited, gateWeb asks the user before a call goes out.
    const webTools = ["WebSearch", "WebFetch"];
    const { command, args } = this.ctx.boardMcp;
    // The thread id lets Scribe tie claims on cards to this thread and release them if it stops.
    const env = { ...this.ctx.boardMcp.env, SCRIBE_THREAD: thread.id, SCRIBE_THREAD_TOKEN: threadToken(thread.id), SCRIBE_PROVIDER: "claude", ...(noPages(thread.scope) ? { SCRIBE_PAGES: "off" } : {}), ...scribeToolsOff(thread) };
    const permissionMode = permissionModeFor(thread);
    const userServers = this.userServers();
    // Servers set to run without asking; the rest go through canUseTool like any tool.
    const autoServers = userServers.filter((s) => s.approve === "auto").map((s) => `mcp__${s.name}__*`);
    // Tools set to Allow run without asking; Disable takes them out of the model's tool list.
    const toolsWith = (policy: string) => userServers.flatMap((s) => Object.entries(s.tools ?? {}).filter(([, p]) => p === policy).map(([tool]) => `mcp__${s.name}__${tool}`));
    autoServers.push(...toolsWith("allow"));
    const disabledTools = toolsWith("disable");
    const options: Options = {
      cwd: this.cwd(),
      model: thread.model === "default" ? undefined : thread.model,
      ...(thread.effort ? { effort: thread.effort as EffortLevel } : {}),
      thinking: { type: "adaptive", display: "summarized" },
      includePartialMessages: true,
      // Subagents: their text shows nested under the tool call that started them, with a live one-line
      // summary, and Stop spares background agents (each has its own stop button).
      forwardSubagentText: true,
      agentProgressSummaries: true,
      perTaskStopAffordance: true,
      mcpServers: {
        ...Object.fromEntries(userServers.map((s) => [s.name, claudeServerConfig(s) as McpServerConfig])),
        [BOARD_SERVER]: { type: "stdio", command, args, env },
      },
      // The host resolves Scribe's list and the Code-mode Keeper fallback. Do not load other servers
      // from ~/.claude.json, .mcp.json or plugins alongside them.
      strictMcpConfig: true,
      settingSources: board && !thread.cwd ? ["user"] : ["user", "project", "local"],
      // Hooks from settings files and plugins are written for the user's own Claude Code sessions; a
      // fail-closed one (a plugin posting to a sidecar) denies every tool here for reasons the chat never
      // shows. Off unless the user turns them on. Scribe's own hooks below are callbacks and still run.
      ...(this.ctx.claudeHooks?.() ? {} : { settings: { disableAllHooks: true } }),
      systemPrompt: { type: "preset", preset: "claude_code", append: this.instructions },
      permissionMode,
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: (name, input, opts) => this.canUseTool(name, input, opts),
      hooks: {
        PreToolUse: [
          {
            matcher: "Write|Edit|MultiEdit|NotebookEdit",
            hooks: [
              async (hookInput) => {
                const inp = hookInput as { tool_name?: string; tool_input?: unknown; tool_use_id?: string };
                const file = isPlainRecord(inp.tool_input) ? str(inp.tool_input.file_path) ?? str(inp.tool_input.notebook_path) : undefined;
                if (file && inp.tool_use_id && this.sink) {
                  await this.sink.beforeWrite(inp.tool_use_id, file).catch(() => undefined);
                }
                return { continue: true };
              },
            ],
          },
          {
            // Web off or limited: calls the setting does not cover ask the user (see gateWeb).
            // A hook, so it also holds where tools pass without asking (allowedTools, full access).
            matcher: "WebSearch|WebFetch",
            // It can wait on the user for hours (a necessary request); the turn's own stop still aborts it.
            timeout: 7 * 24 * 60 * 60,
            hooks: [async (hookInput, _toolUseId, { signal }) => this.gateWeb(hookInput as { tool_name?: string; tool_input?: unknown }, signal)],
          },
          {
            // Scribe's hooks (Agent settings, Hooks): every tool call asks the host first, also under
            // Full access. An ask waits on the user, so it gets the web gate's long timeout.
            timeout: 7 * 24 * 60 * 60,
            hooks: [async (hookInput, _toolUseId, { signal }) => this.gateHooks(hookInput as { tool_name?: string; tool_input?: unknown; tool_use_id?: string }, signal)],
          },
        ],
      },
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "scribe/1", ...this.ctx.claudeEnv?.(this.thread) },
      stderr: (data) => {
        this.stderrTail = (this.stderrTail + data).slice(-4000);
      },
      ...(this.sessionId ? { resume: this.sessionId } : {}),
      // After a rewind: a new session that holds the conversation only up to the kept turn.
      ...(this.sessionId && thread.rewind?.at ? { resumeSessionAt: thread.rewind.at, forkSession: true } : {}),
    };
    if (board) {
      // Read-only and Board: with a workspace, they read and search files there (#718), with no shell (#733).
      const reads = pagesReadsFiles(thread) ? PAGES_READ_TOOLS : [];
      options.tools = [...reads, ...webTools, "Skill", "TodoWrite"];
      options.allowedTools = [`mcp__${BOARD_SERVER}__*`, ...autoServers, ...reads, ...webTools, "Skill", "TodoWrite"];
    } else {
      options.tools = { type: "preset", preset: "claude_code" };
      options.allowedTools = [`mcp__${BOARD_SERVER}__*`, ...autoServers];
      // Scribe makes worktrees itself; a session moving into its own would slip past turn snapshots.
      // Plans are Scribe's plan turns (#721), so Claude's own plan mode stays off.
      options.disallowedTools = ["EnterWorktree", "ExitWorktree", "EnterPlanMode", "ExitPlanMode"];
    }
    if (disabledTools.length) {
      options.allowedTools = options.allowedTools?.filter((name) => !disabledTools.includes(name));
      options.disallowedTools = [...(options.disallowedTools ?? []), ...disabledTools];
    }
    // A custom mode's tool groups: gone from the model's tool list, whatever the approval level.
    const off = claudeToolsOff(thread);
    if (off.length) {
      if (Array.isArray(options.tools)) options.tools = options.tools.filter((name) => !off.includes(name));
      options.allowedTools = options.allowedTools?.filter((name) => !off.includes(name));
      options.disallowedTools = [...(options.disallowedTools ?? []), ...off];
    }
    if (thread.noTools) {
      // No tools at all (#729): no built-ins, no MCP servers, no skills or commands from settings
      // files, and a hook that refuses anything that still turns up.
      const reason = "This thread has no tools. Answer from the conversation alone.";
      options.tools = [];
      options.allowedTools = [];
      options.mcpServers = {};
      options.settingSources = [];
      options.hooks = { PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })] }] };
      options.canUseTool = async () => ({ behavior: "deny", message: reason });
    }
    return options;
  }

  /**
   * PreToolUse for web tools. Web off, or a call off the limited allowlist: the user is asked (once,
   * for the domain, or for the thread) and grants are kept on the thread. The allowlist and grants
   * are the user's approval, so calls they cover run without asking.
   */
  private async gateWeb(inp: { tool_name?: string; tool_input?: unknown }, signal?: AbortSignal): Promise<HookJSONOutput> {
    const thread = this.thread;
    if (thread.web === "on") return { continue: true };
    const input = isPlainRecord(inp.tool_input) ? inp.tool_input : {};
    const allow = (updatedInput?: Record<string, unknown>): HookJSONOutput => ({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", ...(updatedInput ? { updatedInput } : {}) },
    });
    const deny = (reason: string): HookJSONOutput => ({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    });
    const allowlist = thread.web === "limited" ? this.ctx.webAllowlist() : [];
    const grants = thread.webGrants;
    const asked = Array.isArray(input.allowed_domains) ? input.allowed_domains.filter((d): d is string => typeof d === "string") : [];
    const call: WebCall = inp.tool_name === "WebFetch" ? { kind: "fetch", url: str(input.url) ?? "" } : { kind: "search", query: str(input.query), domains: asked };
    if (webCallAllowed(call, thread.web, allowlist, grants)) return allow();
    // Limited: a search that names no domains covers the allowlist (and granted domains) without asking.
    const reach = [...allowlist, ...(grants?.domains ?? [])];
    if (call.kind === "search" && !asked.length && reach.length) {
      const { blocked_domains: _blocked, ...rest } = input;
      return allow({ ...rest, allowed_domains: reach });
    }
    if (!this.ctx.webRequest) return deny("Web access is off for this thread.");
    const result = await this.ctx.webRequest(thread.id, call, { signal });
    return result.allowed ? allow() : deny(result.message ?? "The user did not allow this web request.");
  }

  /**
   * PreToolUse for every tool: Scribe's hooks may deny the call or have the user approve it first.
   * It never allows one: a call that passes goes on to the permission check as before.
   */
  private async gateHooks(inp: { tool_name?: string; tool_input?: unknown; tool_use_id?: string }, signal?: AbortSignal): Promise<HookJSONOutput> {
    const name = inp.tool_name;
    if (!this.ctx.toolGate || !name) return { continue: true };
    try {
      const described = describeTool(name, inp.tool_input, this.thread.cwd);
      const result = await this.ctx.toolGate(
        this.thread.id,
        { ...(inp.tool_use_id ? { toolId: inp.tool_use_id } : {}), name, tool: toolKind(name), title: described.title, ...(described.detail ? { detail: described.detail } : {}), input: inp.tool_input, ...(described.paths ? { paths: described.paths } : {}) },
        signal
      );
      if (result.allowed) return { continue: true };
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: result.reason } };
    } catch {
      // A hook that fails must not take the tool away (fail open).
      return { continue: true };
    }
  }

  private async ensureQuery(): Promise<Query> {
    if (this.query && this.live?.key === this.restartKey(this.thread)) {
      const existing = this.query;
      await this.queryReady;
      if (this.query !== existing) throw new Error("Claude query closed during initialization");
      return existing;
    }
    this.close();
    const sdk = await loadSdk();
    this.input = new InputQueue();
    this.abortController = new AbortController();
    const options = { ...this.buildOptions(), abortController: this.abortController };
    const q = sdk.query({ prompt: this.input, options });
    this.query = q;
    this.accounting = new ClaudeUsageDelta();
    this.live = { model: this.thread.model, effort: this.thread.effort, permission: permissionModeFor(this.thread), key: this.restartKey(this.thread) };
    void this.readLoop(q);
    this.queryReady = (async () => {
      const source = await q.accountInfo().then(claudeBillingSource, () => ({}));
      const requestedAt = Date.now();
      const report = await queryPlanUsage(q);
      if (this.query !== q) return;
      this.accounting.baseline(report);
      this.queryLimits = claudePlanSnapshot(report, source, requestedAt, this.queryLimits);
      this.ctx.claudeLimits?.(this.thread.id, this.queryLimits);
    })();
    await this.queryReady;
    if (this.query !== q) throw new Error("Claude query closed during initialization");
    return q;
  }

  private async readLoop(q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        if (this.query !== q) break;
        this.onMessage(msg);
      }
      if (this.query === q) {
        // The process ended; the next turn starts a new one and resumes the session.
        this.query = null;
        this.live = null;
        this.endTurn({ status: this.cancelled ? "cancelled" : "error", error: this.cancelled ? undefined : `Claude stopped unexpectedly. ${this.stderrTail.slice(-600)}`.trim() });
      }
    } catch (err) {
      if (this.query === q) {
        const message = (err as Error).message || String(err);
        this.query = null;
        this.live = null;
        this.endTurn({ status: this.cancelled ? "cancelled" : "error", error: this.cancelled ? undefined : `${message} ${this.stderrTail.slice(-600)}`.trim() });
      }
    }
  }

  private endTurn(result: TurnResult): void {
    this.turnOpen = false;
    // A steered message the turn did not take in runs as its own turn next; the host adopts it.
    const waiting = this.query ? [...this.steers].find(([, state]) => state === "pending")?.[0] : undefined;
    if (waiting) {
      this.steers.delete(waiting);
      this.carry = waiting;
      this.buffer = [];
      result = { ...result, next: waiting };
    }
    const finish = this.finish;
    this.finish = null;
    finish?.(result);
  }

  steer(input: SteerInput): string {
    const id = randomUUID();
    this.steers.set(id, "pending");
    const content: unknown[] = [{ type: "text", text: input.text }];
    for (const image of input.images) {
      content.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
    }
    for (const doc of input.documents) {
      content.push({ type: "document", title: doc.name, source: { type: "base64", media_type: doc.mimeType, data: doc.data } });
    }
    this.input?.push({
      type: "user",
      message: { role: "user", content: content as never },
      parent_tool_use_id: null,
      origin: { kind: "human" },
      uuid: id,
      priority: "next",
    } as SDKUserMessage);
    return id;
  }

  dropSteer(steerId: string): void {
    if (this.steers.get(steerId) !== "pending") return;
    this.steers.set(steerId, "dropped");
    // Take it off Claude Code's queue when possible; otherwise it is interrupted when it starts.
    void this.cancelQueued(steerId).then((cancelled) => {
      if (cancelled) this.steers.delete(steerId);
    });
  }

  async withdrawSteer(steerId: string): Promise<boolean> {
    if (this.steers.get(steerId) !== "pending") return false;
    const cancelled = await this.cancelQueued(steerId);
    if (cancelled) this.steers.delete(steerId);
    return cancelled;
  }

  /** Claude Code's cancel_async_message control request; the SDK has it at runtime but not in its types yet. */
  private async cancelQueued(uuid: string): Promise<boolean> {
    const q = this.query as unknown as { cancelAsyncMessage?: (uuid: string) => Promise<boolean> } | null;
    if (typeof q?.cancelAsyncMessage !== "function") return false;
    try {
      return (await q.cancelAsyncMessage(uuid)) === true;
    } catch {
      return false;
    }
  }

  private onLifecycle(m: Record<string, unknown>): void {
    const id = typeof m.command_uuid === "string" ? m.command_uuid : "";
    const state = this.steers.get(id);
    if (!state) return;
    if (m.state === "started") {
      this.steers.delete(id);
      if (this.turnOpen) {
        if (state === "pending") this.sink?.steered?.(id);
      } else if (state === "dropped") {
        this.swallowing = id;
        void this.query?.interrupt().catch(() => undefined);
      }
    } else if (m.state === "completed" || m.state === "cancelled") {
      this.steers.delete(id);
    }
  }

  /** Start Claude Code ahead of the first message; it waits for input without calling the API. */
  async warm(instructions: string): Promise<void> {
    if (this.sink) return;
    this.instructions = instructions;
    try {
      await this.ensureQuery();
    } catch (err) {
      log(`Claude warm-up failed: ${(err as Error).message}`);
    }
    this.armIdle();
  }

  /** Close the process after a quiet spell, but not while background agents are still working in it. */
  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.backgroundLive.size || this.sink) this.armIdle();
      else this.close();
    }, IDLE_CLOSE_MS);
  }

  async run(input: TurnInput, sink: RunSink, opts?: { adopt?: string }): Promise<TurnResult> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.instructions = input.instructions;
    this.cancelled = false;
    this.sink = sink;
    this.turnTools.clear();
    this.modelCalls.clear();
    if (opts?.adopt) return this.adopt(opts.adopt);
    this.carry = null;
    this.buffer = [];
    try {
      await this.ensureQuery();
      sink.usage({ billingSource: this.queryLimits.billingSource, costPartial: true });
      // The init message may have arrived during a warm-up, before there was a sink to tell.
      if (this.sessionId) sink.nativeId(this.sessionId);
      const content: unknown[] = [{ type: "text", text: input.text }];
      for (const image of input.images) {
        content.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
      }
      for (const doc of input.documents) {
        content.push({ type: "document", title: doc.name, source: { type: "base64", media_type: doc.mimeType, data: doc.data } });
      }
      const done = new Promise<TurnResult>((resolve) => {
        this.finish = resolve;
      });
      this.turnOpen = true;
      this.input!.push({
        type: "user",
        message: { role: "user", content: content as never },
        parent_tool_use_id: null,
        origin: { kind: "human" },
      } as SDKUserMessage);
      return await done;
    } catch (err) {
      return { status: "error", error: (err as Error).message };
    } finally {
      this.sink = null;
      this.armIdle();
    }
  }

  /** Follow the turn Claude Code started for a steered message, replaying what it sent before the host got here. */
  private async adopt(steerId: string): Promise<TurnResult> {
    try {
      if (this.carry !== steerId || !this.query) return { status: "error", error: "The steered message was lost." };
      if (this.sessionId) this.sink?.nativeId(this.sessionId);
      this.sink?.usage({ billingSource: this.queryLimits.billingSource, costPartial: true });
      const done = new Promise<TurnResult>((resolve) => {
        this.finish = resolve;
      });
      this.turnOpen = true;
      this.carry = null;
      const buffered = this.buffer;
      this.buffer = [];
      for (const msg of buffered) this.onMessage(msg);
      return await done;
    } finally {
      this.sink = null;
      this.armIdle();
    }
  }

  async stopTask(taskId: string): Promise<void> {
    if (!this.query) throw new Error("The agent is not running");
    await this.query.stopTask(taskId);
  }

  async backgroundTask(toolId: string): Promise<boolean> {
    if (!this.query) return false;
    return this.query.backgroundTasks(toolId);
  }

  /** Subagent and background-command lifecycle frames, turned into updates on the tool call that started each one. */
  private onTask(m: Record<string, unknown>): void {
    const taskId = typeof m.task_id === "string" ? m.task_id : "";
    const toolId = typeof m.tool_use_id === "string" ? m.tool_use_id : taskId ? this.tasks.get(taskId) : undefined;
    const report = (patch: Partial<TaskInfo>) => {
      if (toolId) this.ctx.task?.(this.thread.id, toolId, patch);
    };
    const usage = isPlainRecord(m.usage) ? m.usage : null;
    const usagePatch: Partial<TaskInfo> = usage
      ? {
          ...(typeof usage.total_tokens === "number" ? { tokens: usage.total_tokens } : {}),
          ...(typeof usage.tool_uses === "number" ? { toolUses: usage.tool_uses } : {}),
          ...(typeof usage.duration_ms === "number" ? { durationMs: usage.duration_ms } : {}),
        }
      : {};
    switch (m.subtype) {
      case "task_started": {
        // Housekeeping tasks (watchers and the like) are not shown.
        if (m.skip_transcript === true || m.ambient === true || !taskId || !toolId) return;
        this.tasks.set(taskId, toolId);
        const type = m.task_type === "local_agent" ? "agent" : m.task_type === "local_bash" ? "command" : String(m.task_type ?? "agent");
        report({ id: taskId, type, status: "running", background: m.is_backgrounded === true });
        return;
      }
      case "task_progress":
        if (!this.tasks.has(taskId)) return;
        report({ ...(typeof m.summary === "string" && m.summary ? { summary: m.summary } : {}), ...(typeof m.last_tool_name === "string" ? { lastTool: m.last_tool_name } : {}), ...usagePatch });
        return;
      case "task_updated": {
        if (!this.tasks.has(taskId) || !isPlainRecord(m.patch)) return;
        const patch = m.patch;
        const status = patch.status === "completed" ? "done" : patch.status === "failed" ? "error" : patch.status === "killed" ? "stopped" : undefined;
        report({
          ...(typeof patch.is_backgrounded === "boolean" ? { background: patch.is_backgrounded } : {}),
          ...(status ? { status, endedAt: Date.now() } : {}),
          ...(typeof patch.error === "string" && patch.error ? { summary: patch.error } : {}),
        });
        return;
      }
      case "task_notification": {
        if (!this.tasks.has(taskId)) return;
        this.tasks.delete(taskId);
        const status = m.status === "completed" ? "done" : m.status === "failed" ? "error" : "stopped";
        report({ status, endedAt: Date.now(), ...(typeof m.summary === "string" && m.summary ? { summary: m.summary } : {}), ...usagePatch });
        return;
      }
      case "background_tasks_changed":
        this.backgroundLive = new Set(
          (Array.isArray(m.tasks) ? m.tasks : []).filter((t) => isPlainRecord(t) && t.ambient !== true && typeof t.task_id === "string").map((t) => String((t as Record<string, unknown>).task_id))
        );
        return;
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    const q = this.query;
    if (!q) return;
    try {
      await q.interrupt();
    } catch {
      this.close();
      this.endTurn({ status: "cancelled" });
    }
  }

  private close(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const q = this.query;
    this.query = null;
    // Process lifetime does not invalidate the last reported quota observation.
    this.live = null;
    this.input?.close();
    this.input = null;
    this.steers.clear();
    this.carry = null;
    this.buffer = [];
    this.swallowing = null;
    this.turnOpen = false;
    for (const toolId of this.tasks.values()) {
      this.ctx.task?.(this.thread.id, toolId, { status: "stopped", summary: "Stopped: the agent's process ended", endedAt: Date.now() });
    }
    this.tasks.clear();
    this.backgroundLive.clear();
    if (q) {
      try {
        q.close();
      } catch {
        this.abortController?.abort();
      }
    }
  }

  dispose(): void {
    this.cancelled = true;
    this.endTurn({ status: "cancelled" });
    this.close();
    this.onDispose();
  }

  private async canUseTool(
    name: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: unknown[]; title?: string; decisionReason?: string; toolUseID?: string; blockedPath?: string }
  ): Promise<PermissionResult> {
    const sink = this.sink;
    // Between turns (a background agent at work) the host answers from the thread's rules alone.
    const ask: RunSink["approval"] | undefined = sink ? (req, signal) => sink.approval(req, signal) : this.ctx.approval ? (req) => this.ctx.approval!(this.thread.id, req) : undefined;
    if (!ask || (!sink && name === "AskUserQuestion")) return { behavior: "deny", message: "No active turn: the user is not there to answer." };
    if (name === "AskUserQuestion") {
      const raw = Array.isArray(input.questions) ? input.questions : [];
      const questions = raw.filter(isPlainRecord).map((q, index) => ({
        id: String(index),
        prompt: String(q.question ?? ""),
        header: str(q.header),
        multi: q.multiSelect === true,
        options: (Array.isArray(q.options) ? q.options : []).filter(isPlainRecord).map((o, i) => ({
          id: String(i),
          label: String(o.label ?? ""),
          description: str(o.description),
        })),
      }));
      try {
        const answer = await sink!.question({ questions }, opts.signal);
        if ("skipped" in answer) {
          return { behavior: "deny", message: answer.reason || "The user skipped these questions. Continue with your best judgement." };
        }
        const answers: Record<string, string> = {};
        for (const q of questions) {
          const picked = (answer.answers[q.id] ?? []).map((id) => q.options.find((o) => o.id === id)?.label ?? id);
          const note = answer.notes?.[q.id];
          answers[q.prompt] = [...picked, ...(note ? [note] : [])].join(", ");
        }
        return { behavior: "allow", updatedInput: { ...input, answers } };
      } catch {
        return { behavior: "deny", message: "The question was cancelled." };
      }
    }
    if (this.thread.mode === "board" && !name.startsWith(`mcp__${BOARD_SERVER}__`) && !["WebSearch", "WebFetch", "Skill", "TodoWrite", ...(pagesReadsFiles(this.thread) ? PAGES_READ_TOOLS : [])].includes(name)) {
      return { behavior: "deny", message: pagesReadsFiles(this.thread) ? `This thread is on the ${APPROVAL_LABEL[this.thread.approval]} rung: only board tools, file reads and web search are available.` : `This thread is on the ${APPROVAL_LABEL[this.thread.approval]} rung: only board tools and web search are available.` };
    }
    const described = describeTool(name, input, this.thread.cwd);
    const mcpServer = this.userServers().find((server) => name.startsWith(`mcp__${server.name}__`));
    const mcpTool = mcpServer ? name.slice(`mcp__${mcpServer.name}__`.length) : undefined;
    const permissions = new McpPermissions();
    if (mcpServer && mcpTool && toolPolicy(mcpServer, mcpTool) === "disable") return { behavior: "deny", message: "This tool is disabled in Scribe's MCP settings." };
    if (mcpServer && mcpTool && toolPolicy(mcpServer, mcpTool) === "allow") return { behavior: "allow", updatedInput: input };
    if (mcpServer && mcpTool && permissions.allows(mcpServer, mcpTool, this.thread.id)) return { behavior: "allow", updatedInput: input };
    const options = mcpServer ? mcpApprovalOptions : [
      { id: "allow", label: "Allow once", kind: "allow_once" as const },
      ...(opts.suggestions && opts.suggestions.length ? [{ id: "always", label: suggestionsLabel(opts.suggestions), description: suggestionsDescription(opts.suggestions) || undefined, kind: "allow_always" as const }] : []),
      { id: "deny", label: "Deny", kind: "reject_once" as const },
    ];
    const detail = [described.detail ?? (name === "Edit" || name === "Write" ? undefined : summarizeInput(input)), opts.decisionReason, opts.blockedPath ? `Path: ${opts.blockedPath}` : undefined]
      .filter(Boolean)
      .join("\n");
    try {
      const decision = await ask(
        {
          toolId: opts.toolUseID,
          tool: toolKind(name),
          title: opts.title || described.title,
          detail: detail || undefined,
          // Searches name their folder, and a call outside the allowed folders its blocked path: Scribe's folder grants need them (#743).
          paths: described.paths ?? (str(input.path) ? [str(input.path)!] : opts.blockedPath ? [opts.blockedPath] : undefined),
          options,
          // Only the in-process registration counts, not a same-named server from the user's config.
          boardTool: name.startsWith(`mcp__${BOARD_SERVER}__`) && (opts as { mcpServer?: { source?: string } }).mcpServer?.source === "sdk",
        },
        opts.signal
      );
      if (mcpServer && mcpTool ? !permissions.grant(mcpServer, mcpTool, this.thread.id, decision.optionId) : decision.optionId === "deny") {
        return { behavior: "deny", message: decision.note ? `The user denied this: ${decision.note}` : "The user denied this tool call." };
      }
      return {
        behavior: "allow",
        updatedInput: input,
        ...(decision.optionId === "always" && opts.suggestions ? { updatedPermissions: opts.suggestions as never } : {}),
      };
    } catch {
      return { behavior: "deny", message: "The approval was cancelled." };
    }
  }

  private onMessage(msg: SDKMessage): void {
    const sink = this.sink;
    const m = msg as Record<string, unknown> & { type: string; subtype?: string };
    if (m.type === "command_lifecycle") {
      this.onLifecycle(m);
      return;
    }
    if (m.type === "rate_limit_event") {
      const limits = planLimitsFromRateLimitInfo(m.rate_limit_info, Date.now(), this.queryLimits);
      if (limits) {
        this.queryLimits = { ...limits, source: "claude", availability: "available", billingSource: this.queryLimits.billingSource };
        this.ctx.claudeLimits?.(this.thread.id, this.queryLimits);
      }
      return;
    }
    if (m.type === "system" && (m.subtype === "task_started" || m.subtype === "task_progress" || m.subtype === "task_updated" || m.subtype === "task_notification" || m.subtype === "background_tasks_changed")) {
      this.onTask(m);
      return;
    }
    if (this.swallowing) {
      if (m.type === "result") {
        this.accounting.result(m);
        this.swallowing = null;
      }
      return;
    }
    // Between turns, Claude Code starts one of its own when a background agent it is waiting on
    // finishes. The host runs it like a steered message; its frames wait in buffer until it does.
    if (!this.turnOpen && !this.carry && this.query && (m.type === "assistant" || m.type === "stream_event") && !m.parent_tool_use_id) {
      const id = `follow:${randomUUID()}`;
      this.carry = id;
      this.buffer = [msg];
      if (this.ctx.followUp?.(this.thread.id, id)) return;
      // The host is busy starting a turn of its own: these frames belong to it.
      this.carry = null;
      this.buffer = [];
    }
    if (!this.turnOpen && this.carry) {
      this.buffer.push(msg);
      return;
    }
    if (m.type === "system" && m.subtype === "init") {
      if (typeof m.session_id === "string") {
        this.sessionId = m.session_id;
        sink?.nativeId(m.session_id);
      }
      if (Array.isArray(m.slash_commands) && !this.commandList.length) {
        this.commandList = (m.slash_commands as string[]).map((name) => ({ name }));
        void this.commands().then((list) => sink?.commands(list));
      }
      return;
    }
    if (!sink) {
      if (m.type === "result" && !m.parent_tool_use_id) this.accounting.result(m);
      return;
    }
    const parent = typeof m.parent_tool_use_id === "string" ? m.parent_tool_use_id : null;
    if (parent && !this.turnTools.has(parent)) return;
    if (!parent && (m.type === "assistant" || m.type === "user") && typeof m.uuid === "string") sink.checkpoint?.(m.uuid);
    switch (m.type) {
      case "stream_event":
        this.onStream(m as never);
        return;
      case "assistant":
        this.onAssistant(m as never);
        return;
      case "user":
        this.onUser(m as never);
        return;
      case "result": {
        if (parent) return; // modelUsage already includes SDK subagent calls.
        sink.usage({ ...this.accounting.result(m), billingSource: this.queryLimits.billingSource, ...(this.contextTokens ? { contextTokens: this.contextTokens } : {}) });
        const activeQuery = this.query;
        // Stamp the reading with its request time, so a slow read cannot supersede a newer
        // observation, and drop it when this query reported again while it was in flight.
        const requestedAt = Date.now();
        const beforeRead = this.queryLimits;
        if (activeQuery) void queryPlanUsage(activeQuery).then((report) => {
          if (this.query !== activeQuery || this.queryLimits !== beforeRead) return;
          const current = this.queryLimits;
          this.queryLimits = { ...claudePlanSnapshot(report, current.billingSource ?? {}, requestedAt, current),
            ...(current.overageAt ? { overage: current.overage, overageAt: current.overageAt } : {}) };
          this.ctx.claudeLimits?.(this.thread.id, this.queryLimits);
        });
        // A steer this turn took in, in case its lifecycle frame went missing.
        for (const id of Array.isArray(m.user_message_uuids) ? (m.user_message_uuids as string[]) : []) {
          if (this.steers.get(id) === "pending") {
            this.steers.delete(id);
            sink.steered?.(id);
          }
        }
        // An API error is written the same way, but the result carries that one as the turn's error.
        if (m.subtype === "success" && !m.is_error && this.commandOutput && !this.cancelled) sink.text(this.commandOutput);
        this.commandOutput = "";
        if (m.subtype === "success") {
          this.endTurn({ status: this.cancelled ? "cancelled" : m.is_error ? "error" : "done", error: m.is_error ? String(m.result ?? "Claude reported an error") : undefined });
        } else {
          const errors = Array.isArray(m.errors) ? (m.errors as string[]).join("\n") : "";
          this.endTurn({ status: this.cancelled ? "cancelled" : "error", error: this.cancelled ? undefined : errors || String(m.subtype) });
        }
        return;
      }
      case "system":
        if (m.subtype === "compact_boundary") sink.notice("info", "Context compacted");
        else if (m.subtype === "api_retry") sink.notice("warn", `API retry${typeof m.attempt === "number" ? ` (attempt ${m.attempt})` : ""}${typeof m.error === "string" ? `: ${m.error}` : ""}`);
        return;
      default:
        return;
    }
  }

  private onStream(msg: { event: Record<string, unknown>; parent_tool_use_id: string | null }): void {
    const sink = this.sink!;
    const event = msg.event;
    const parent = msg.parent_tool_use_id ?? undefined;
    if (event.type === "message_start") {
      this.streamTools.clear();
      this.streamPageShows.clear();
      return;
    }
    if (event.type === "content_block_start" && isPlainRecord(event.content_block)) {
      const block = event.content_block;
      if (block.type === "text" || block.type === "thinking") {
        sink.breakBlock();
      } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        this.streamTools.set(Number(event.index), block.id);
        this.turnTools.add(block.id);
        if (block.name === "AskUserQuestion") return;
        const described = describeTool(block.name, {}, this.thread.cwd);
        sink.toolStart({ toolId: block.id, name: block.name, tool: toolKind(block.name), title: block.name.startsWith("mcp__") ? described.title : block.name, status: "pending", parentToolId: parent });
        if (!parent && /(^|__)page_show$/.test(block.name)) this.streamPageShows.set(Number(event.index), "");
      }
      return;
    }
    if (event.type === "content_block_delta" && isPlainRecord(event.delta)) {
      const delta = event.delta;
      if (parent) return;
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        // A page's HTML takes a while to write: say which page it is as soon as the call names it.
        const index = Number(event.index);
        const json = this.streamPageShows.get(index);
        const toolId = this.streamTools.get(index);
        if (json === undefined || !toolId) return;
        const head = pageShowHead(json + delta.partial_json);
        if (head) {
          this.streamPageShows.delete(index);
          sink.toolUpdate(toolId, { input: head });
        } else this.streamPageShows.set(index, json + delta.partial_json);
        return;
      }
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        this.streamedText = true;
        sink.text(delta.text);
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        sink.reasoning(delta.thinking);
      }
    }
  }

  private onAssistant(msg: { message: { id?: string; content?: unknown[]; usage?: unknown; model?: unknown }; parent_tool_use_id: string | null }): void {
    const sink = this.sink!;
    const parent = msg.parent_tool_use_id ?? undefined;
    // Claude Code writes a slash command's answer itself: one whole message, with no stream before it.
    if (!parent && msg.message.model === "<synthetic>") {
      for (const block of msg.message.content ?? []) {
        if (isPlainRecord(block) && block.type === "text" && typeof block.text === "string") this.commandOutput += block.text;
      }
      return;
    }
    // The context in use is what the latest main-thread call read and wrote, cache included.
    const u = msg.message.usage;
    if (!parent && isPlainRecord(u)) {
      const n = (key: string) => (typeof u[key] === "number" ? (u[key] as number) : 0);
      const tokens = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens") + n("output_tokens");
      if (tokens) this.contextTokens = tokens;
      // The SDK may deliver several content blocks with the same response id.
      if (msg.message.id && !this.modelCalls.has(msg.message.id)) {
        this.modelCalls.add(msg.message.id);
        const prompt = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
        sink.usage({ modelCalls: this.modelCalls.size, ...(this.modelCalls.size === 1 ? { firstPromptTokens: prompt } : {}) });
      }
    }
    for (const block of msg.message.content ?? []) {
      if (!isPlainRecord(block)) continue;
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        const name = block.name;
        this.turnTools.add(block.id);
        if (name === "AskUserQuestion") continue;
        const described = describeTool(name, block.input, this.thread.cwd);
        sink.toolStart({ toolId: block.id, name, tool: toolKind(name), title: described.title, detail: described.detail, input: block.input, paths: described.paths, status: "running", parentToolId: parent });
        sink.toolUpdate(block.id, { title: described.title, detail: described.detail, input: block.input, paths: described.paths, status: "running" });
        if (name === "TodoWrite" && isPlainRecord(block.input) && Array.isArray(block.input.todos)) {
          sink.todos(
            block.input.todos.filter(isPlainRecord).map((todo) => ({
              content: String(todo.content ?? ""),
              status: todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "in_progress" : "pending",
            }))
          );
        }
      } else if (parent && block.type === "text" && typeof block.text === "string") {
        sink.text(block.text, parent);
      } else if (parent && block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
        sink.reasoning(block.thinking, parent);
      }
    }
  }

  private onUser(msg: { message: { content?: unknown }; tool_use_result?: unknown }): void {
    const sink = this.sink!;
    const content = msg.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isPlainRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const structured = isPlainRecord(msg.tool_use_result) ? msg.tool_use_result : null;
      let output = resultText(block.content);
      let exitCode: number | undefined;
      if (structured && (typeof structured.stdout === "string" || typeof structured.stderr === "string")) {
        output = [str(structured.stdout), str(structured.stderr)].filter(Boolean).join("\n");
        if (structured.interrupted === true) output += "\n[interrupted]";
      }
      if (block.is_error === true) exitCode = 1;
      sink.toolUpdate(block.tool_use_id, { status: block.is_error === true ? "error" : "done", output, ...(exitCode !== undefined ? { exitCode } : {}) });
      sink.images?.(block.tool_use_id, outputImages(block.content));
    }
  }
}

function summarizeInput(input: Record<string, unknown>): string {
  try {
    const text = JSON.stringify(input, null, 2);
    return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
  } catch {
    return "";
  }
}

/**
 * Read a streaming page_show only once its foreground/background choice is known.
 * Without an explicit background field before the content, wait for the complete input:
 * background may come after a long HTML string. Parse JSON so nested/quoted fields cannot
 * be mistaken for the call's own fields.
 */
export function pageShowHead(json: string): { key?: string; id?: string; title?: string; background?: boolean } | null {
  let input: unknown;
  // Usually still incomplete; avoid parsing the growing HTML on every delta.
  if (json.trimEnd().endsWith("}")) {
    try { input = JSON.parse(json); } catch { /* Try the fields before the content. */ }
  }
  if (input === undefined) {
    const content = /"html(Path)?"\s*:/.exec(json);
    if (!content) return null;
    try { input = JSON.parse(json.slice(0, content.index).replace(/,\s*$/, "") + "}"); }
    catch { return null; }
    if (!isPlainRecord(input) || typeof input.background !== "boolean") return null;
  }
  if (!isPlainRecord(input)) return null;
  const head: { key?: string; id?: string; title?: string; background?: boolean } = {};
  for (const field of ["key", "id", "title"] as const) {
    if (typeof input[field] === "string") head[field] = input[field];
  }
  if (typeof input.background === "boolean") head.background = input.background;
  return head;
}
