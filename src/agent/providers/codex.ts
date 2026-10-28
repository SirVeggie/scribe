import { codexPermissions, permissionBoundaryProblem, permissionSummary, scribeToolAvailability, workerPermissionProblem, type EffectivePermissions } from "../effectivePermissions.js";
import { codexReadOnly, customKey, readShell, scribeToolsOff } from "../customModes.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type {
  CodexOptions,
  McpToolCallItem,
  ModelReasoningEffort,
  SandboxMode,
  ThreadItem as SdkThreadItem,
  Usage as CodexUsage,
} from "@openai/codex-sdk";
import { dataDir } from "../../config.js";
import { log } from "../../log.js";
import type { ChatImage, ModelOption, ProviderStatus, SlashCommand, Thread, ToolKind, Usage } from "../types.js";
import { isPlainRecord, noPages, readsOnly } from "../types.js";
import { SparePool, type AgentProvider, type ProviderSession, type RunSink, type SessionContext, type SteerInput, type TurnInput, type TurnResult } from "./provider.js";
import { CodexRpc, type RpcMessage, type RpcRecord } from "./codexRpc.js";
import { McpBridge, type BridgeAsk, type BridgedTool } from "../mcpBridge.js";
import { serversKey } from "../mcpConfig.js";
import { threadToken } from "../../callers.js";
import { outputImages } from "../outputImages.js";

type ThreadItem = SdkThreadItem | { type: "image_generation"; id: string; status: string; savedPath?: string; result?: string; failure?: unknown };

/**
 * Codex interactive sessions use app-server; the SDK spawns `codex exec` for summaries. Sessions resume by
 * thread id under Scribe's own CODEX_HOME (data/agent/codex), using the user's ChatGPT login by
 * syncing ~/.codex/auth.json, newest login wins both ways (Agent settings Log in runs `codex login`). The model
 * picker is the live ChatGPT catalog from `codex app-server` `model/list` (same list as Codex web
 * work mode), with FALLBACK_MODELS only when that call fails. Interactive sessions use a persistent
 * app-server connection for approvals and steering; SDK exec is retained for tool-free summaries.
 * The board's tools reach the agent as a Codex MCP server named `scribe`. The user's MCP servers (Agent
 * settings) are bridged as dynamic tools named "<server>__<tool>", so Scribe asks before each call by the
 * server's setting rather than Codex's own MCP approvals. Codex stores a thread's dynamic tools with the
 * thread, so a resumed thread keeps the list it started with.
 */

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_URL_WAIT_MS = 15_000;
const MODELS_TTL_MS = 30 * 60 * 1000;
const APP_SERVER_TIMEOUT_MS = 20_000;

const IDLE_CLOSE_MS = 15 * 60 * 1000;
const EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
  persistent: "Persistent",
};
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"].map((id) => ({ id, label: EFFORT_LABELS[id] ?? id }));

type Sdk = typeof import("@openai/codex-sdk");
let sdkLoad: Promise<Sdk> | null = null;
/** The SDK pulls a large native binary; load it on first use instead of with the daemon. */
function sdk(): Promise<Sdk> {
  sdkLoad ??= import("@openai/codex-sdk");
  sdkLoad.catch(() => {
    sdkLoad = null;
  });
  return sdkLoad;
}

export function scribeCodexHome(): string {
  return path.join(dataDir(), "agent", "codex");
}

function userAuthFile(): string {
  return path.join(os.homedir(), ".codex", "auth.json");
}

/** Share the user's Codex login with Scribe's CODEX_HOME so ChatGPT auth works without mixing sessions. */
export function syncCodexAuth(): void {
  const home = scribeCodexHome();
  fs.mkdirSync(home, { recursive: true });
  syncAuthFiles(userAuthFile(), path.join(home, "auth.json"));
}

/** When a login was written: Codex's `last_refresh`, else the file time. Null when unreadable. */
function authStamp(file: string, text: string): number | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isPlainRecord(parsed) && typeof parsed.last_refresh === "string") {
      const at = Date.parse(parsed.last_refresh);
      if (Number.isFinite(at)) return at;
    }
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The ChatGPT account Codex is logged in to (Scribe's copy of the login, else the CLI's), or null. */
export function codexAccountId(): string | null {
  for (const file of [path.join(scribeCodexHome(), "auth.json"), userAuthFile()]) {
    const text = readText(file);
    if (text == null) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      const tokens = isPlainRecord(parsed) ? parsed.tokens : null;
      const id = isPlainRecord(tokens) ? tokens.account_id : null;
      if (typeof id === "string" && id) return id;
    } catch {
      // Unreadable: try the other copy.
    }
  }
  return null;
}

/** Replace through a temp file so a Codex process never reads half a login. */
function writeAuth(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(file, text, { mode: 0o600 });
  }
}

/**
 * Keep the newer of the two logins in both places. Refresh tokens rotate, so whichever side
 * refreshed last holds the only working one: copying the CLI's older file over Scribe's would
 * undo Scribe's refresh, and leaving the CLI's copy stale would sign the CLI out. A tie or an
 * unreadable Scribe copy goes to the CLI file, which `codex login` writes.
 */
export function syncAuthFiles(userFile: string, scribeFile: string): "none" | "toScribe" | "toUser" {
  const user = readText(userFile);
  if (user == null) return "none";
  const scribe = readText(scribeFile);
  if (scribe === user) return "none";
  const userAt = authStamp(userFile, user);
  const scribeAt = scribe == null ? null : authStamp(scribeFile, scribe);
  if (scribe != null && scribeAt != null && (userAt == null || scribeAt > userAt)) {
    writeAuth(userFile, scribe);
    return "toUser";
  }
  if (userAt == null) return "none";
  writeAuth(scribeFile, user);
  return "toScribe";
}

export function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.CODEX_HOME = scribeCodexHome();
  return env;
}

/** Login writes ~/.codex/auth.json; sessions still use Scribe's CODEX_HOME. */
export function loginEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key !== "CODEX_HOME") out[key] = value;
  }
  return out;
}

/** HTTPS login page from `codex login` stdout; skip localhost (the OAuth callback). */
export function loginUrlFromOutput(text: string): string | null {
  const plain = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const matches = plain.match(/https:\/\/[^\s<>"'\\]+/g) ?? [];
  let fallback: string | null = null;
  for (const raw of matches) {
    const href = raw.replace(/[.,);]+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:") continue;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") continue;
    if (host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "auth.openai.com" || host.endsWith(".openai.com")) {
      return parsed.href;
    }
    fallback ??= parsed.href;
  }
  return fallback;
}

function codexCliJs(): string {
  return createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
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

type AppServerCall = (method: string, params?: unknown) => Promise<unknown>;

/** Stops for the one-shot app-servers still running, so disposing the provider leaves no child behind. */
const appServerStops = new Set<() => void>();

/** One `codex app-server --stdio` process for a handful of JSON-RPC calls, then killed. */
function withAppServer<T>(env: Record<string, string>, run: (call: AppServerCall) => Promise<T>, timeoutMs = APP_SERVER_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [codexCliJs(), "app-server", "--stdio"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let buf = "";
    let nextId = 1;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
    let settled = false;

    const finish = (err?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      appServerStops.delete(stop);
      clearTimeout(timeout);
      stopChild(child);
      for (const wait of pending.values()) wait.reject(err ?? new Error("Codex app-server closed"));
      pending.clear();
      if (err) reject(err);
      else resolve(value as T);
    };

    const timeout = setTimeout(() => finish(new Error("Codex app-server timed out")), timeoutMs);
    timeout.unref?.();
    const stop = () => finish(new Error("Codex app-server stopped"));
    appServerStops.add(stop);

    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(buf[nl] === "\r" ? nl + 2 : nl + 1);
        if (!line.startsWith("{")) continue;
        let msg: { id?: unknown; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue;
        }
        if (msg.id == null) continue;
        const wait = pending.get(Number(msg.id));
        if (!wait) continue;
        pending.delete(Number(msg.id));
        if (msg.error) wait.reject(new Error(msg.error.message || "Codex RPC error"));
        else wait.resolve(msg.result);
      }
    });
    child.once("error", (err) => finish(err));
    child.once("exit", () => {
      if (!settled) finish(new Error("Codex app-server exited"));
    });

    const call: AppServerCall = async (method, params) => {
      const result = await new Promise((res, rej) => {
        if (settled) {
          rej(new Error("Codex app-server closed"));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`);
      });
      if (method === "initialize") child.stdin?.write(`${JSON.stringify({ method: "initialized" })}\n`);
      return result;
    };

    run(call)
      .then((value) => finish(undefined, value))
      .catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}

function hasApiKey(): string | null {
  if (process.env.CODEX_API_KEY?.trim()) return "CODEX_API_KEY";
  if (process.env.OPENAI_API_KEY?.trim()) return "OPENAI_API_KEY";
  return null;
}

function hasAuthFile(): boolean {
  return fs.existsSync(path.join(scribeCodexHome(), "auth.json")) || fs.existsSync(userAuthFile());
}

export const FALLBACK_MODELS: ModelOption[] = [
  { id: "default", label: "Default", provider: "codex", description: "Codex CLI default", efforts: EFFORTS, defaultEffort: null, params: [] },
  { id: "gpt-5.2-codex", label: "GPT-5.2 Codex", provider: "codex", efforts: EFFORTS, defaultEffort: null, params: [] },
  { id: "gpt-5.2", label: "GPT-5.2", provider: "codex", efforts: EFFORTS, defaultEffort: null, params: [] },
  { id: "gpt-5-codex", label: "GPT-5 Codex", provider: "codex", efforts: EFFORTS, defaultEffort: null, params: [] },
  { id: "gpt-5.1-codex", label: "GPT-5.1 Codex", provider: "codex", efforts: EFFORTS, defaultEffort: null, params: [] },
  { id: "gpt-5.1", label: "GPT-5.1", provider: "codex", efforts: EFFORTS, defaultEffort: null, params: [] },
  { id: "gpt-5", label: "GPT-5", provider: "codex", efforts: EFFORTS, defaultEffort: null, params: [] },
  { id: "o3", label: "o3", provider: "codex", efforts: EFFORTS, defaultEffort: null, params: [] },
];

function effortChoices(ids: string[]): Array<{ id: string; label: string }> {
  return ids.map((id) => ({ id, label: EFFORT_LABELS[id] ?? id }));
}

/** ChatGPT catalog rows from `model/list` → picker options. Hidden and unavailable models are dropped. */
export function mapCodexModels(rows: unknown[]): ModelOption[] {
  type Row = {
    id?: unknown;
    model?: unknown;
    displayName?: unknown;
    description?: unknown;
    hidden?: unknown;
    isDefault?: unknown;
    isCurrentlyUnavailable?: unknown;
    supportedReasoningEfforts?: unknown;
    defaultReasoningEffort?: unknown;
  };
  const parsed: Row[] = [];
  for (const row of rows) {
    if (isPlainRecord(row)) parsed.push(row);
  }
  parsed.sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  for (const row of parsed) {
    if (row.hidden || row.isCurrentlyUnavailable) continue;
    const id = String(row.model || row.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rawEfforts = Array.isArray(row.supportedReasoningEfforts)
      ? row.supportedReasoningEfforts.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    const option: ModelOption = {
      id,
      label: String(row.displayName || id).trim(),
      provider: "codex",
      efforts: rawEfforts.length ? effortChoices(rawEfforts) : EFFORTS,
      defaultEffort: typeof row.defaultReasoningEffort === "string" ? row.defaultReasoningEffort : null,
      params: [],
    };
    if (typeof row.description === "string" && row.description.trim()) option.description = row.description.trim();
    out.push(option);
  }
  return out;
}

/** Live ChatGPT catalog via experimental `codex app-server` JSON-RPC. Same list as Codex web work mode. */
export async function fetchCodexModels(): Promise<ModelOption[]> {
  const env = fs.existsSync(userAuthFile()) ? loginEnv() : cliEnv();
  return withAppServer(env, async (call) => {
    await call("initialize", {
      clientInfo: { name: "scribe", title: "Scribe", version: "1.0.0" },
      capabilities: { experimentalApi: false },
    });
    const rows: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await call("model/list", {
        includeHidden: false,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!isPlainRecord(result) || !Array.isArray(result.data)) break;
      rows.push(...result.data);
      const next = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : "";
      if (!next) break;
      cursor = next;
    }
    return mapCodexModels(rows);
  });
}

/** Account quota only: no thread or model turn is created. Use the same auth as sessions. */
export async function readCodexPlanUsage(call: AppServerCall): Promise<unknown> {
  // Let managed auth refresh when needed; polling must not force token rotation.
  const account = await call("account/read", { refreshToken: false });
  if (!isPlainRecord(account) || !isPlainRecord(account.account)) throw new Error("Codex authentication required");
  if (account.account.type === "apiKey") throw new Error("Codex subscription quota requires a ChatGPT login; API-key quota is unavailable");
  return call("account/rateLimits/read");
}

export async function fetchCodexPlanUsage(): Promise<unknown> {
  syncCodexAuth();
  const env = cliEnv();
  const apiKey = apiKeyOption().apiKey;
  if (apiKey) env.CODEX_API_KEY = apiKey;
  return withAppServer(env, async (call) => {
    await call("initialize", { clientInfo: { name: "scribe", title: "Scribe", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    return readCodexPlanUsage(call);
  });
}

/** Read-only, Board and Plan stay read-only; Full access drops the sandbox; otherwise workspace-write. */
export function sandboxFor(thread: Pick<Thread, "mode" | "approval" | "custom">): SandboxMode {
  if (thread.mode === "board" || readsOnly(thread.approval) || codexReadOnly(thread)) return "read-only";
  if (thread.approval === "full") return "danger-full-access";
  return "workspace-write";
}

/**
 * The repository git dir behind `cwd` when it lies outside `cwd`'s own `.git`, so commits work
 * in a sandbox. A worktree's `.git` is a file pointing into the main checkout's `.git/worktrees`,
 * and git also writes the shared objects and refs there.
 */
export function gitCommonDir(cwd: string): string | null {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    let stat: fs.Stats;
    try { stat = fs.statSync(dotGit); } catch { if (path.dirname(dir) === dir) return null; continue; }
    if (stat.isDirectory()) return dotGit;
    try {
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"));
      if (!match) return null;
      const gitDir = path.resolve(dir, match[1]);
      let common = gitDir;
      try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim()); } catch { /* not a linked worktree */ }
      return common;
    } catch { return null; }
  }
}

/**
 * Codex config for a sandboxed thread on Windows. Without a selected Windows sandbox Codex
 * silently turns workspace-write into read-only (#322); the unelevated one needs no admin setup.
 * Read-only selects it too, so the reading rungs' commands run sandboxed without asking (#720).
 */
export function windowsSandboxConfig(sandbox: SandboxMode, cwd: string, platform: NodeJS.Platform = process.platform): RpcRecord {
  if (platform !== "win32" || sandbox === "danger-full-access") return {};
  if (sandbox === "read-only") return { "windows.sandbox": "unelevated" };
  const gitDir = gitCommonDir(cwd);
  return {
    "windows.sandbox": "unelevated",
    ...(gitDir ? { "sandbox_workspace_write.writable_roots": [gitDir] } : {}),
  };
}

export function threadOptions(thread: Pick<Thread, "model" | "effort" | "mode" | "approval" | "web" | "custom" | "cwd">, cwd: string, platform: NodeJS.Platform = process.platform): RpcRecord {
  const effort = thread.effort && thread.effort in EFFORT_LABELS ? (thread.effort as ModelReasoningEffort) : undefined;
  const sandbox = sandboxFor(thread);
  return {
    ...(thread.model && thread.model !== "default" ? { model: thread.model } : {}),
    sandbox,
    cwd,
    approvalPolicy: thread.approval === "full" ? "never" : "on-request",
    // Native review only handles actions that need approval; keep the mode's sandbox.
    approvalsReviewer: thread.approval === "auto" ? "auto_review" : "user",
    config: {
      ...(effort ? { model_reasoning_effort: effort } : {}),
      web_search: thread.web === "on" ? "live" : "disabled",
      "sandbox_workspace_write.network_access": thread.web === "on" && thread.mode === "code" && !codexReadOnly(thread),
      // Keep Windows ready for a later sandboxed turn after Full access.
      ...windowsSandboxConfig(thread.mode === "code" && !codexReadOnly(thread) ? "workspace-write" : sandbox, cwd, platform),
      // The reading rungs keep the shell only with a workspace (#722): without one the thread runs in
      // the scratch folder and has no file access, and a custom mode can turn it off.
      ...(thread.mode === "board" && !readShell({ ...thread, provider: "codex" }) ? { features: { shell_tool: false, unified_exec: false } } : {}),
    },
  };
}

/**
 * Model and effort for `turn/start`. Always sent so a picker change applies on the next turn
 * without restarting the app-server thread. Scribe "Default" is JSON `null`: omit on thread
 * start/resume (CLI/config default), and send null here so a previous named override is cleared.
 */
export function turnStartOverrides(thread: Pick<Thread, "model" | "effort">): { model: string | null; effort: string | null } {
  return {
    model: thread.model && thread.model !== "default" ? thread.model : null,
    effort: thread.effort && thread.effort in EFFORT_LABELS ? thread.effort : null,
  };
}

/** Explicit policies replace sticky turn settings, including a previous Full access turn. */
export function turnPermissionOverrides(thread: Pick<Thread, "mode" | "approval" | "web" | "custom">, cwd: string): RpcRecord {
  const sandbox = sandboxFor(thread);
  const gitDir = process.platform === "win32" ? gitCommonDir(cwd) : null;
  return {
    approvalPolicy: thread.approval === "full" ? "never" : "on-request",
    approvalsReviewer: thread.approval === "auto" ? "auto_review" : "user",
    sandboxPolicy: sandbox === "danger-full-access" ? { type: "dangerFullAccess" }
      : sandbox === "read-only" ? { type: "readOnly", networkAccess: false }
      : { type: "workspaceWrite", writableRoots: gitDir ? [gitDir] : [],
        networkAccess: thread.web === "on" && thread.mode === "code", excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  };
}

/** The board MCP server, registered as Codex MCP server `scribe`. */
export function mcpConfig(ctx: Pick<SessionContext, "boardMcp">, threadId: string, pages: boolean, toolsOff: Record<string, string> = {}): NonNullable<CodexOptions["config"]> {
  return {
    mcp_servers: {
      scribe: {
        command: ctx.boardMcp.command,
        args: ctx.boardMcp.args,
        env: {
          ...ctx.boardMcp.env,
          SCRIBE_THREAD: threadId,
          SCRIBE_THREAD_TOKEN: threadToken(threadId),
          SCRIBE_PROVIDER: "codex",
          ...(pages ? {} : { SCRIBE_PAGES: "off" }),
          ...toolsOff,
        },
        // Scribe gates its own tools (mode limits, hooks). Left to ask, Codex refuses the unannotated
        // ones outright when approvals are "never" under a sandbox, as in Pages mode with Full access.
        default_tools_approval_mode: "approve",
      },
    },
  };
}

/**
 * A thread without tools (#729): no Scribe MCP server, and Codex's own tools turned off. Codex keeps
 * a few tools no setting removes (exec, apply_patch, agents), all reached through code mode: with
 * its host off, code mode fails closed and they return an error. The read-only sandbox with no
 * network backs that up, and Scribe refuses any approval or question such a thread sends.
 */
export const NO_TOOLS_CONFIG: RpcRecord = {
  features: Object.fromEntries(
    ["shell_tool", "unified_exec", "code_mode", "code_mode_host", "view_image", "image_generation", "multi_agent", "multi_agent_v2", "apps", "plugins", "goals", "memories", "hooks",
      "sleep_tool", "tool_suggest", "skill_search", "browser_use", "browser_use_external", "computer_use", "in_app_browser", "workspace_dependencies", "request_permissions_tool"].map((name) => [name, false])
  ),
  apps: { _default: { enabled: false } },
};

/** Codex's note that code mode fails closed: expected in a thread without tools, so not shown there. */
const CODE_MODE_OFF = /code-mode host is disabled/i;

/** A bridged tool as a Codex dynamic tool for `thread/start`. */
export function dynamicToolSpec(tool: Pick<BridgedTool, "name" | "server" | "tool" | "description" | "inputSchema">): RpcRecord {
  return { type: "function", name: tool.name, description: tool.description || `${tool.server}: ${tool.tool}`, inputSchema: tool.inputSchema };
}

/** MCP tool result content as Codex dynamic tool output items. */
export function dynamicToolContent(content: unknown[]): RpcRecord[] {
  return content.filter(isPlainRecord).map((block) => {
    if (block.type === "text" && typeof block.text === "string") return { type: "inputText", text: block.text };
    if (block.type === "image" && typeof block.data === "string") {
      return { type: "inputImage", imageUrl: `data:${typeof block.mimeType === "string" ? block.mimeType : "image/png"};base64,${block.data}` };
    }
    return { type: "inputText", text: JSON.stringify(block) };
  });
}

type TokenCounts = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number };
const TOKEN_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const;

/** An app-server TokenUsageBreakdown as Scribe's counts. */
function tokenCounts(u: RpcRecord): TokenCounts {
  return { inputTokens: Number(u.inputTokens) || 0, outputTokens: Number(u.outputTokens) || 0,
    cacheReadTokens: Number(u.cachedInputTokens) || 0, cacheWriteTokens: Number(u.cacheWriteInputTokens) || 0,
    reasoningTokens: Number(u.reasoningOutputTokens) || 0 };
}

export function mapUsage(usage: CodexUsage): Usage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cached_input_tokens,
    cacheWriteTokens: usage.cache_write_input_tokens,
    reasoningTokens: usage.reasoning_output_tokens,
  };
}

export class CodexProvider implements AgentProvider {
  readonly id = "codex" as const;
  readonly label = "Codex";
  private modelCache: { at: number; models: ModelOption[] } | null = null;
  private modelLoad: Promise<ModelOption[]> | null = null;
  private sessions = new Set<CodexSession>();
  private spares = new SparePool<CodexSession>();
  private login: { url: string | null; done: Promise<void> } | null = null;

  async status(): Promise<ProviderStatus> {
    try {
      await sdk();
    } catch (err) {
      return { id: this.id, label: this.label, available: false, detail: `Codex SDK failed to load: ${(err as Error).message}` };
    }
    const key = hasApiKey();
    if (key) return { id: this.id, label: this.label, available: true, detail: key };
    if (hasAuthFile()) return { id: this.id, label: this.label, available: true, detail: "codex login" };
    return {
      id: this.id,
      label: this.label,
      available: false,
      detail: this.login ? "Finish the login in your browser" : "Not logged in",
      login: true,
    };
  }

  /**
   * Start ChatGPT login via the bundled `codex login`. The CLI opens a browser and prints a URL;
   * Scribe's settings also open that URL. Auth lands in ~/.codex/auth.json, then is copied into
   * Scribe's CODEX_HOME. Resolves with the URL as soon as there is one; the wait goes on in the
   * background.
   */
  async startLogin(onLogin?: () => void): Promise<{ url: string | null }> {
    if (!this.login) {
      let gotUrl: (url: string) => void = () => {};
      const urlReady = new Promise<string>((resolve) => (gotUrl = resolve));
      const entry: { url: string | null; done: Promise<void> } = { url: null, done: Promise.resolve() };
      let output = "";
      const child = spawn(process.execPath, [codexCliJs(), "login"], {
        env: loginEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const take = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.length > 32_000) output = output.slice(-16_000);
        if (entry.url) return;
        const url = loginUrlFromOutput(output);
        if (url) {
          entry.url = url;
          gotUrl(url);
        }
      };
      child.stdout?.on("data", take);
      child.stderr?.on("data", take);
      const timeout = setTimeout(() => stopChild(child), LOGIN_TIMEOUT_MS);
      timeout.unref?.();
      entry.done = new Promise<void>((resolve) => {
        child.once("error", (err) => {
          clearTimeout(timeout);
          log(`Codex login failed: ${err.message}`);
          resolve();
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          if (code === 0) {
            syncCodexAuth();
            this.modelCache = null;
            log("Codex login done");
            onLogin?.();
          } else {
            const tail = output.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(" ");
            log(`Codex login failed (exit ${code ?? "null"})${tail ? `: ${tail}` : ""}`);
          }
          resolve();
        });
      }).finally(() => {
        if (this.login === entry) this.login = null;
      });
      this.login = entry;
      await Promise.race([urlReady, entry.done, new Promise((resolve) => setTimeout(resolve, LOGIN_URL_WAIT_MS))]);
    }
    return { url: this.login?.url ?? null };
  }

  models(refresh = false): Promise<ModelOption[]> {
    const cached = this.modelCache?.models.length ? this.modelCache.models : null;
    const fetchedAt = this.modelCache?.at ?? 0;
    const stale = !cached || Date.now() - fetchedAt >= MODELS_TTL_MS;
    // A real fetch (at > 0) that aged out is still close enough to show; refresh behind.
    // A restart seed (at === 0) may be the old hardcoded list — wait for the live catalog.
    if (!refresh && cached && !stale) return Promise.resolve(cached);
    if (!refresh && cached && fetchedAt > 0) {
      if (!this.modelLoad) void this.models(true);
      return Promise.resolve(cached);
    }
    if (this.modelLoad) return this.modelLoad;
    this.modelLoad = this.loadModels().finally(() => {
      this.modelLoad = null;
    });
    return this.modelLoad;
  }

  cachedModels(): ModelOption[] {
    return this.modelCache?.models ?? FALLBACK_MODELS;
  }

  /** Seed from the saved list so the first turn after a restart does not wait. Marked stale. */
  setModelCache(models: ModelOption[]): void {
    if (models.length && !this.modelCache) this.modelCache = { at: 0, models };
  }

  private async loadModels(): Promise<ModelOption[]> {
    if (!hasAuthFile() && !hasApiKey()) {
      return this.modelCache?.models.length ? this.modelCache.models : FALLBACK_MODELS;
    }
    try {
      syncCodexAuth();
      const models = await fetchCodexModels();
      if (models.length) {
        this.modelCache = { at: Date.now(), models };
        return models;
      }
    } catch (err) {
      log(`Codex model list failed: ${(err as Error).message}`);
    }
    return this.modelCache?.models.length ? this.modelCache.models : FALLBACK_MODELS;
  }

  /** Isolated from the user's config, MCP servers, skills and project instructions. */
  async startUsageWindow(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    syncCodexAuth();
    const models = await this.models();
    const model = models.find((m) => /luna/i.test(m.id));
    if (!model) throw new Error("Codex Luna is unavailable");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-window-codex-"));
    const home = path.join(cwd, "home");
    fs.mkdirSync(home);
    const authFile = path.join(scribeCodexHome(), "auth.json");
    const isolatedAuth = path.join(home, "auth.json");
    try {
      fs.copyFileSync(authFile, isolatedAuth);
      const env = cliEnv();
      env.CODEX_HOME = home;
      for (const key of ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) delete env[key];
      const report = await withAppServer(env, async (call) => {
        await call("initialize", { clientInfo: { name: "scribe", version: "1.0.0" }, capabilities: { experimentalApi: true } });
        return readCodexPlanUsage(call);
      });
      const { planLimitsFromCodexRateLimits } = await import("../planLimits.js");
      const limits = planLimitsFromCodexRateLimits(report, Date.now());
      if (limits?.ordinaryUsageAllowed !== true) throw new Error("Codex included usage unavailable");
      signal.throwIfAborted();
      const { Codex } = await sdk();
      const client = new Codex({ env, config: {
        forced_login_method: "chatgpt", model_provider: "openai", project_doc_max_bytes: 0,
        developer_instructions: "Reply only with hi.",
        features: { shell_tool: false, multi_agent: false, hooks: false, memories: false, goals: false, plugins: false },
        tools: { view_image: false },
        apps: { _default: { enabled: false } },
      } });
      const handle = client.startThread({ model: model.id, skipGitRepoCheck: true,
        sandboxMode: "read-only", approvalPolicy: "never", webSearchEnabled: false,
        modelReasoningEffort: "low", workingDirectory: cwd });
      await handle.run("Hello. Reply only with hi.", { signal });
    } finally {
      // Preserve any provider-managed token refresh before removing the isolated home.
      try { syncAuthFiles(authFile, isolatedAuth); } catch { /* retain original login */ }
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  async complete(prompt: string, model: string, signal?: AbortSignal): Promise<string> {
    syncCodexAuth();
    const { Codex } = await sdk();
    const client = new Codex({ env: cliEnv(), ...(apiKeyOption()) });
    const handle = client.startThread({
      ...(model && model !== "default" ? { model } : {}),
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      webSearchEnabled: false,
      workingDirectory: os.tmpdir(),
    });
    const turn = await handle.run(prompt, { signal });
    return turn.finalResponse;
  }

  createSession(thread: Thread, ctx: SessionContext): ProviderSession {
    const spare = thread.nativeId ? null : this.spares.take(spareKey(thread, ctx), thread.id);
    if (spare) {
      spare.update(thread);
      return spare;
    }
    return this.newSession(thread, ctx);
  }

  private newSession(thread: Thread, ctx: SessionContext): CodexSession {
    const session = new CodexSession(thread, ctx, () => this.sessions.delete(session));
    this.sessions.add(session);
    return session;
  }

  spareThreadId(thread: Thread, ctx: SessionContext): string | null {
    return this.spares.get(spareKey(thread, ctx))?.scribeThreadId() ?? null;
  }

  prewarm(draft: Thread, instructions: string, ctx: SessionContext): void {
    const key = spareKey(draft, ctx);
    let spare = this.spares.get(key);
    if (spare) {
      spare.update(draft);
    } else {
      spare = this.newSession(draft, ctx);
      this.spares.put(key, spare);
    }
    void spare.warm(instructions);
  }

  dispose(): void {
    this.spares.dispose();
    for (const session of [...this.sessions]) session.dispose();
    for (const stop of [...appServerStops]) stop();
  }
}

function apiKeyOption(): Pick<CodexOptions, "apiKey"> {
  const key = process.env.CODEX_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  return key ? { apiKey: key } : {};
}

function spareKey(thread: Thread, ctx: SessionContext): string {
  const where = !thread.cwd ? `board:${ctx.scratchDir}` : `cwd:${path.normalize(thread.cwd).toLowerCase()}`;
  return JSON.stringify([where, thread.mode, customKey(thread), thread.web, thread.approval, noPages(thread.scope)]);
}

function toolKind(item: ThreadItem): ToolKind {
  switch (item.type) {
    case "command_execution":
      return "execute";
    case "file_change":
      return "edit";
    case "mcp_tool_call":
      return "mcp";
    case "web_search":
      return "fetch";
    case "todo_list":
      return "todo";
    default:
      return "other";
  }
}

function mcpText(item: McpToolCallItem): string {
  if (item.error?.message) return item.error.message;
  const content = item.result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isPlainRecord(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "image" || String(block.type) === "inputImage") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Keep normal chat compact; the diagnostic log retains the unabridged payload. */
function compactReviewText(text: string, limit: number): string {
  const plain = text.replace(/\s+/g, " ").trim();
  return plain.length > limit ? `${plain.slice(0, limit - 3)}...` : plain;
}

/** Normalize app-server v2 items into the existing Scribe tool renderer. */
export function appServerItem(item: RpcRecord): ThreadItem | null {
  const id = String(item.id ?? "");
  switch (item.type) {
    case "imageGeneration": return { type: "image_generation", id, status: String(item.status ?? ""),
      ...(typeof item.savedPath === "string" ? { savedPath: item.savedPath } : {}),
      ...(typeof item.result === "string" ? { result: item.result } : {}), failure: item.failure };
    case "agentMessage": return { type: "agent_message", id, text: String(item.text ?? "") };
    case "plan": return { type: "agent_message", id, text: String(item.text ?? "") };
    case "reasoning": return { type: "reasoning", id, text: [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])].join("\n") };
    case "commandExecution": return { type: "command_execution", id, command: String(item.command ?? ""), aggregated_output: String(item.aggregatedOutput ?? ""),
      ...(typeof item.exitCode === "number" ? { exit_code: item.exitCode } : {}), status: item.status === "completed" ? "completed" : item.status === "failed" || item.status === "declined" ? "failed" : "in_progress" };
    case "fileChange": return { type: "file_change", id, changes: (Array.isArray(item.changes) ? item.changes.filter(isPlainRecord) : []).map((change) => ({ path: String(change.path), kind: isPlainRecord(change.kind) ? change.kind.type === "add" ? "add" : change.kind.type === "delete" ? "delete" : "update" : "update" })), status: item.status === "failed" || item.status === "declined" ? "failed" : "completed" };
    case "mcpToolCall": return { type: "mcp_tool_call", id, server: String(item.server), tool: String(item.tool), arguments: item.arguments,
      ...(isPlainRecord(item.result) ? { result: item.result as McpToolCallItem["result"] } : {}),
      ...(isPlainRecord(item.error) ? { error: { message: String(item.error.message) } } : {}),
      status: item.status === "completed" ? "completed" : item.status === "failed" ? "failed" : "in_progress" };
    case "webSearch": return { type: "web_search", id, query: String(item.query ?? "") };
    // A bridged MCP tool (Codex dynamic tool): no server here; the session titles it from its bridge.
    case "dynamicToolCall": {
      const content = (Array.isArray(item.contentItems) ? item.contentItems.filter(isPlainRecord) : [])
        .flatMap((c) => c.type === "inputText" && typeof c.text === "string" ? [{ type: "text", text: c.text }] : c.type === "inputImage" ? [c] : []);
      const status = item.status === "failed" || item.success === false ? "failed" : item.status === "completed" ? "completed" : "in_progress";
      return { type: "mcp_tool_call", id, server: "", tool: String(item.tool ?? ""), arguments: item.arguments,
        ...(status !== "in_progress" ? { result: { content, structured_content: null } as unknown as McpToolCallItem["result"] } : {}),
        status };
    }
    default: return null;
  }
}

function writeImages(images: ChatImage[]): { paths: string[]; cleanup: () => void } {
  if (!images.length) return { paths: [], cleanup: () => undefined };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-codex-"));
  const paths = images.map((image, i) => {
    const mime = image.mimeType.toLowerCase();
    const ext = mime.includes("png") ? ".png" : mime.includes("webp") ? ".webp" : mime.includes("gif") ? ".gif" : ".jpg";
    const file = path.join(dir, `img-${i}${ext}`);
    fs.writeFileSync(file, Buffer.from(image.data, "base64"));
    return file;
  });
  return {
    paths,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/** Reconstruct the core assessment consumed by approveGuardianDeniedAction (CLI 0.162.0). */
export function guardianDenialEvent(p: RpcRecord): RpcRecord {
  if (typeof p.reviewId !== "string" || !isPlainRecord(p.review) || p.review.status !== "denied" || !isPlainRecord(p.action)) {
    throw new Error("Invalid Codex Auto-review denial");
  }
  const types: Record<string, string> = { command: "command", execve: "execve", writeStdin: "write_stdin",
    applyPatch: "apply_patch", networkAccess: "network_access", mcpToolCall: "mcp_tool_call", requestPermissions: "request_permissions" };
  const type = types[String(p.action.type)];
  if (!type) throw new Error(`Unsupported Codex Auto-review action: ${p.action.type}`);
  const snake = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(snake);
    if (!isPlainRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), snake(v)]));
  };
  const action = snake(p.action) as RpcRecord;
  action.type = type;
  // Core write_stdin uses PathUri, while app-server exposes the legacy path string.
  if (type === "write_stdin" && typeof action.cwd === "string" &&
      (path.isAbsolute(action.cwd) || path.win32.isAbsolute(action.cwd))) action.cwd = pathToFileURL(action.cwd).href;
  if (action.source === "unifiedExec") action.source = "unified_exec";
  if (action.protocol === "socks5Tcp") action.protocol = "socks5_tcp";
  if (action.protocol === "socks5Udp") action.protocol = "socks5_udp";
  return { id: p.reviewId, status: "denied", action, target_item_id: p.targetItemId ?? null,
    risk_level: p.review.riskLevel ?? null, user_authorization: p.review.userAuthorization ?? null,
    rationale: p.review.rationale ?? null, decision_source: p.decisionSource ?? "agent" };
}

export class CodexSession implements ProviderSession {
  private rpc: CodexRpc | null = null;
  private opening: Promise<void> | null = null;
  private activeTurn: string | null = null;
  private finishTurn: ((result: TurnResult) => void) | null = null;
  private steers = new Map<string, { input: SteerInput; state: "queued" | "sending" | "accepted"; cleanup?: () => void }>();
  /** Tokens of the model requests in the native turn so far. */
  private turnUsage: TokenCounts | null = null;
  /** The native thread's running total at the last report, to take each report's share from. */
  private usageTotal: TokenCounts | null = null;
  private steerCleanups: Array<() => void> = [];
  private requests = new Map<string | number, AbortController>();
  private outputs = new Map<string, string>();
  private sessionKey: string | null = null;
  private effectivePermissions: EffectivePermissions | null = null;
  private permissionKey: string | null = null;
  private settingsUpdated: ((settings: RpcRecord) => void) | null = null;
  private permissionNotice: string | null = null;
  private nativeId: string | null;
  private reported: string | null = null;
  private sink: RunSink | null = null;
  private running = false;
  private cancelled = false;
  private abort: AbortController | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private instructions = "";
  /** How much of each streaming item we already sent, so updates become deltas. */
  private streamed = new Map<string, number>();
  private tools = new Set<string>();
  private reviewNotices = new Set<string>();
  private bridge: Pick<McpBridge, "servers" | "cwd" | "tools" | "close"> | null = null;
  /** Bridged user tools by dynamic tool name. */
  private bridged = new Map<string, BridgedTool>();
  private reviewedDenials = new Set<string>();
  private reviewApprovals = new Set<Promise<void>>();
  private approvedRetries: string[] = [];
  private nativeTurnCompleted = false;
  private runUsage: Usage = {};

  constructor(
    private thread: Thread,
    private ctx: SessionContext,
    private onDispose: () => void,
    private launch: (onMessage: (message: RpcMessage) => void, onClose: (error: Error) => void) => CodexRpc =
      (onMessage, onClose) => {
        const env = cliEnv();
        const apiKey = apiKeyOption().apiKey;
        if (apiKey) env.CODEX_API_KEY = apiKey;
        return CodexRpc.launch(codexCliJs(), env, onMessage, onClose);
      },
    private prepare: () => void = syncCodexAuth,
    private reviewLog: typeof log = log,
    private makeBridge: (...args: ConstructorParameters<typeof McpBridge>) => Pick<McpBridge, "servers" | "cwd" | "tools" | "close"> =
      (...args) => new McpBridge(...args),
  ) {
    this.nativeId = thread.nativeId;
  }

  scribeThreadId(): string {
    return this.thread.id;
  }

  update(thread: Thread): void {
    const was = this.thread;
    this.thread = thread;
    if (this.reported && thread.nativeId !== this.reported && !this.running) {
      this.reported = null;
      this.nativeId = thread.nativeId;
      this.rpc?.close();
      this.rpc = null;
      this.sessionKey = null;
    }
    if (this.sessionKey !== null && this.sessionKey !== this.key() && !this.running) {
      this.rpc?.close();
      this.rpc = null;
      this.sessionKey = null;
    }
    if (was.id !== thread.id) {
      this.rpc?.close();
      this.rpc = null;
      this.sessionKey = null;
    }
  }

  async commands(): Promise<SlashCommand[]> {
    return [];
  }

  private cwd(): string {
    if (!this.thread.cwd) return this.ctx.scratchDir;
    return this.thread.cwd;
  }

  /** Model, effort and approvals are turn settings; changes reuse the connection. */
  private key(): string {
    const t = this.thread;
    return JSON.stringify([t.id, t.mode, customKey(t), t.web, this.cwd(), noPages(t.scope), this.instructions, serversKey(this.ctx.mcpServers?.(t) ?? [])]);
  }

  private asker(): BridgeAsk | undefined {
    const sink = this.sink;
    if (sink) return (req, signal) => sink.approval(req, signal);
    const approval = this.ctx.approval;
    return approval ? (req) => approval(this.thread.id, req) : undefined;
  }

  /** The user's MCP servers (Agent settings), connected by Scribe and offered to Codex as dynamic tools. */
  private async userTools(): Promise<BridgedTool[]> {
    const servers = this.ctx.mcpServers?.(this.thread) ?? [];
    if (this.bridge && (serversKey(this.bridge.servers) !== serversKey(servers) || this.bridge.cwd !== this.cwd())) {
      this.bridge.close();
      this.bridge = null;
    }
    this.bridged.clear();
    if (!servers.length) return [];
    this.bridge ??= this.makeBridge(servers, this.cwd(), () => this.thread, () => this.asker(),
      (name, message) => this.sink?.notice("warn", `MCP server ${name} did not start: ${message}`));
    const tools = await this.bridge.tools();
    for (const tool of tools) this.bridged.set(tool.name, tool);
    return tools;
  }

  private async ensureHandle(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.openHandle().finally(() => { this.opening = null; });
    return this.opening;
  }

  private async openHandle(): Promise<void> {
    const key = this.key();
    if (this.rpc?.alive && this.sessionKey === key) return;
    this.rpc?.close();
    this.prepare();
    const rpc = this.launch((message) => this.onRpc(message, rpc), (error) => {
      if (this.rpc !== rpc) return;
      this.sessionKey = null;
      const finish = this.finishTurn;
      this.finishTurn = null;
      this.abort?.abort();
      finish?.({ status: this.cancelled ? "cancelled" : "error", error: error.message });
    });
    this.rpc = rpc;
    try {
      await rpc.call("initialize", { clientInfo: { name: "scribe", title: "Scribe", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      rpc.notify("initialized");
      const none = Boolean(this.thread.noTools);
      const tools = none ? [] : await this.userTools();
      // thread/resume takes no tool list: a resumed thread keeps the dynamic tools it started with.
      const dynamicTools = tools.length ? { dynamicTools: tools.map(dynamicToolSpec) } : {};
      const options = {
        ...threadOptions(this.thread, this.cwd()),
        developerInstructions: this.instructions,
        config: {
          ...(none ? NO_TOOLS_CONFIG : mcpConfig(this.ctx, this.thread.id, !noPages(this.thread.scope), scribeToolsOff(this.thread))),
          ...threadOptions(this.thread, this.cwd()).config as RpcRecord,
        },
      };
      let result: unknown;
      if (this.nativeId) {
        try { result = await rpc.call("thread/resume", { ...options, threadId: this.nativeId }); }
        catch (error) {
          if (!/not found|unknown thread|no rollout/i.test((error as Error).message)) throw error;
          this.sink?.notice("warn", "Could not resume the Codex thread; this turn starts a new one without the earlier conversation.");
          this.nativeId = null;
          this.usageTotal = null;
          result = await rpc.call("thread/start", { ...options, ...dynamicTools });
        }
      } else result = await rpc.call("thread/start", { ...options, ...dynamicTools });
      if (!isPlainRecord(result) || !isPlainRecord(result.thread) || typeof result.thread.id !== "string") throw new Error("Invalid Codex thread response");
      this.nativeId = result.thread.id;
      this.effectivePermissions = codexPermissions(result, options);
      this.permissionKey = JSON.stringify(turnPermissionOverrides(this.thread, this.cwd()));
      this.ctx.permissions?.(this.thread.id, this.effectivePermissions);
      this.sessionKey = key;
    } catch (error) {
      rpc.close();
      throw error;
    }
  }

  async warm(instructions: string): Promise<void> {
    if (this.sink) return;
    this.instructions = instructions;
    try {
      await this.ensureHandle();
    } catch (err) {
      log(`Codex warm-up failed: ${(err as Error).message}`);
    }
    this.armIdle();
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  async run(input: TurnInput, sink: RunSink, opts?: { adopt?: string }): Promise<TurnResult> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (opts?.adopt) this.steers.delete(opts.adopt);
    this.sink = sink;
    this.cancelled = false;
    this.streamed.clear();
    this.tools.clear();
    this.outputs.clear();
    this.reviewNotices.clear();
    this.turnUsage = null;
    this.runUsage = {};
    this.reviewedDenials.clear();
    this.approvedRetries = [];
    this.instructions = input.instructions;
    const images = writeImages(input.images);
    this.abort = new AbortController();
    const payload = this.turnInput(input.text, images.paths);
    try {
      let outcome = await this.streamTurn(payload, sink);
      while (outcome.status !== "cancelled" && this.approvedRetries.length && this.rpc?.alive && !this.cancelled) {
        const retries = this.approvedRetries.splice(0);
        this.turnUsage = null;
        outcome = await this.streamTurn(this.turnInput(
          `The user approved one retry of these exact Auto-review denials through Scribe: ${retries.join(", ")}. ` +
          "Retry only the approved actions. Native Auto-review still applies; do not broaden the actions or bypass the reviewer.", []), sink);
      }
      return this.cancelled ? { status: "cancelled" } : outcome;
    } catch (err) {
      if (this.cancelled || (err as Error)?.name === "AbortError") return { status: "cancelled" };
      return { status: "error", error: (err as Error).message || String(err) };
    } finally {
      this.running = false;
      this.activeTurn = null;
      this.finishTurn = null;
      this.abort?.abort();
      this.abort = null;
      this.sink = null;
      this.reviewApprovals.clear();
      for (const steer of this.steers.values()) steer.cleanup?.();
      for (const cleanup of this.steerCleanups) cleanup();
      this.steerCleanups = [];
      // The host requeues any steer not acknowledged through sink.steered.
      this.steers.clear();
      images.cleanup();
      this.armIdle();
    }
  }

  private turnInput(text: string, imagePaths: string[]): RpcRecord[] {
    return [{ type: "text", text, text_elements: [] }, ...imagePaths.map((file) => ({ type: "localImage", path: file }))];
  }

  private async streamTurn(payload: RpcRecord[], sink: RunSink): Promise<TurnResult> {
    await this.ensureHandle();
    const permissions = turnPermissionOverrides(this.thread, this.cwd());
    const permissionKey = JSON.stringify(permissions);
    if (permissionKey !== this.permissionKey) {
      // The start response has no policy observation. Update first and await the native
      // settings notification so worker preflight never relies on a previous turn's policy.
      const signal = this.abort!.signal;
      let timeout: NodeJS.Timeout | undefined;
      let abort!: () => void;
      const observed = new Promise<RpcRecord>((resolve, reject) => {
        this.settingsUpdated = resolve;
        abort = () => reject(new Error("Codex settings update cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        timeout = setTimeout(() => reject(new Error("Codex did not report updated permissions")), APP_SERVER_TIMEOUT_MS);
        timeout.unref?.();
        if (signal.aborted) abort();
      });
      try {
        const [, settings] = await Promise.all([
          this.rpc!.call("thread/settings/update", { threadId: this.nativeId, ...permissions }), observed,
        ]);
        this.effectivePermissions = codexPermissions(settings, threadOptions(this.thread, this.cwd()));
        if (this.effectivePermissions.sandbox === "unknown" || this.effectivePermissions.approval !== permissions.approvalPolicy
          || this.effectivePermissions.reviewer !== permissions.approvalsReviewer) {
          throw new Error("Codex did not confirm the requested turn permissions");
        }
        this.permissionKey = permissionKey;
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        this.settingsUpdated = null;
      }
    }
    if (this.nativeId) {
      sink.nativeId(this.nativeId);
      this.reported = this.nativeId;
    }
    const policy = this.effectivePermissions!;
    const worker = this.ctx.isWorker?.(this.thread.id) === true;
    if (worker && !noPages(this.thread.scope)) {
      // This inventories tools; it never creates a page or mutates a card to test permission.
      try {
        let cursor: string | null = null;
        let tools: RpcRecord = {};
        const cursors = new Set<string>();
        do {
          const status = await this.rpc!.call("mcpServerStatus/list", { cursor, limit: 100, threadId: this.nativeId, serverName: "scribe", detail: "toolsAndAuthOnly" });
          if (!isPlainRecord(status) || !Array.isArray(status.data)) throw new Error("Invalid MCP status response");
          const server = status.data.find((entry) => isPlainRecord(entry) && entry.name === "scribe");
          if (isPlainRecord(server) && isPlainRecord(server.tools)) tools = { ...tools, ...server.tools };
          cursor = typeof status.nextCursor === "string" ? status.nextCursor : null;
          if (cursor && cursors.has(cursor)) throw new Error("Repeated MCP status cursor");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        Object.assign(policy, scribeToolAvailability(tools));
      } catch (error) {
        sink.notice("warn", `Could not verify Scribe worker tools: ${(error as Error).message}`);
        policy.boardActions = "unchecked";
        policy.reports = "unchecked";
      }
    }
    this.ctx.permissions?.(this.thread.id, { ...policy });
    const mismatch = policy.sandbox !== policy.requestedSandbox || policy.approval !== policy.requestedApproval;
    const summary = permissionSummary(policy);
    if (this.permissionNotice !== summary) {
      sink.notice(mismatch ? "warn" : "info", summary);
      this.permissionNotice = summary;
    }
    const boundaryProblem = permissionBoundaryProblem(policy);
    if (boundaryProblem) return { status: "error", error: boundaryProblem };
    if (worker) {
      const problem = workerPermissionProblem(this.thread, policy);
      if (problem) return { status: "error", error: problem };
    }
    if (this.cancelled) return { status: "cancelled" };
    this.running = true;
    this.nativeTurnCompleted = false;
    const done = new Promise<TurnResult>((resolve) => { this.finishTurn = resolve; });
    const result = await this.rpc!.call("turn/start", {
      threadId: this.nativeId, input: payload, ...turnStartOverrides(this.thread), ...permissions,
    });
    if (!isPlainRecord(result) || !isPlainRecord(result.turn) || typeof result.turn.id !== "string") throw new Error("Invalid Codex turn response");
    // A completion notification can arrive before the turn/start response.
    if (this.finishTurn && !this.nativeTurnCompleted) this.activeTurn = result.turn.id;
    for (const id of this.steers.keys()) this.sendSteer(id);
    if (this.cancelled && this.activeTurn) await this.interrupt();
    return await done;
  }

  steer(input: SteerInput): string {
    const id = randomUUID();
    this.steers.set(id, { input, state: "queued" });
    // The host records the returned id before delivery can be acknowledged.
    queueMicrotask(() => this.sendSteer(id));
    return id;
  }

  private sendSteer(id: string): void {
    const steer = this.steers.get(id);
    const rpc = this.rpc;
    if (!steer || steer.state !== "queued" || !this.activeTurn || !rpc?.alive || this.cancelled) return;
    const images = writeImages(steer.input.images);
    this.steerCleanups.push(images.cleanup);
    steer.cleanup = images.cleanup;
    steer.state = "sending";
    void rpc.call("turn/steer", {
      threadId: this.nativeId, expectedTurnId: this.activeTurn,
      clientUserMessageId: id, input: this.turnInput(steer.input.text, images.paths),
    }).then(() => {
      if (this.steers.get(id) === steer) steer.state = "accepted";
    }).catch((error) => {
      if (this.steers.get(id) === steer) steer.state = "queued";
      log(`Codex steer failed: ${(error as Error).message}`);
    });
  }

  dropSteer(id: string): void {
    const steer = this.steers.get(id);
    // Once sent, the server owns the input; it cannot safely be withdrawn locally.
    if (steer?.state === "queued") { steer.cleanup?.(); this.steers.delete(id); }
  }

  async withdrawSteer(id: string): Promise<boolean> {
    if (this.steers.get(id)?.state !== "queued") return false;
    this.dropSteer(id);
    return true;
  }

  private onRpc(message: RpcMessage, rpc: CodexRpc): void {
    if (this.rpc !== rpc) return;
    if (message.id !== undefined && message.method) {
      void this.onRequest(message, rpc).catch((error) => {
        rpc.reject(message.id!, (error as Error).message);
      });
      return;
    }
    const p = message.params ?? {};
    if (message.method === "account/rateLimits/updated") {
      this.ctx.limits?.("codex", p);
      return;
    }
    const sink = this.sink;
    if (message.method === "thread/settings/updated" && p.threadId === this.nativeId && isPlainRecord(p.threadSettings)) {
      this.settingsUpdated?.(p.threadSettings);
      return;
    }
    if (!sink || (p.threadId && p.threadId !== this.nativeId)) return;
    if (p.turnId && this.activeTurn && p.turnId !== this.activeTurn) return;
    switch (message.method) {
      case "turn/started":
        if (isPlainRecord(p.turn) && typeof p.turn.id === "string") {
          this.activeTurn = p.turn.id;
          for (const id of this.steers.keys()) this.sendSteer(id);
        }
        break;
      case "turn/completed": {
        const turn = isPlainRecord(p.turn) ? p.turn : {};
        if (this.nativeTurnCompleted || (this.activeTurn && turn.id !== this.activeTurn)) return;
        this.nativeTurnCompleted = true;
        this.activeTurn = null;
        if (this.turnUsage) {
          const usage = this.turnUsage;
          for (const key of TOKEN_KEYS) this.runUsage[key] = (this.runUsage[key] ?? 0) + usage[key];
          sink.usage(this.runUsage);
        }
        const error = isPlainRecord(turn.error) ? String(turn.error.message || "Codex turn failed") : undefined;
        const outcome: TurnResult = this.cancelled || turn.status === "interrupted" ? { status: "cancelled" }
          : turn.status === "failed" ? { status: "error", error: error || "Codex turn failed" } : { status: "done" };
        for (const request of this.requests.values()) request.abort();
        if (outcome.status === "cancelled") this.abort?.abort();
        // Native denial review is an explicit Scribe interaction. Keep it alive
        // after native completion, then retry approved actions in a new native turn.
        const finish = this.finishTurn;
        const signal = this.abort?.signal;
        const finishReview = () => {
          if (this.finishTurn !== finish) return;
          signal?.removeEventListener("abort", finishReview);
          finish?.(this.cancelled ? { status: "cancelled" } : outcome);
          this.finishTurn = null;
        };
        if (signal?.aborted) finishReview();
        else {
          signal?.addEventListener("abort", finishReview, { once: true });
          void Promise.all([...this.reviewApprovals]).then(finishReview);
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        const report = p.tokenUsage;
        if (!isPlainRecord(report) || !isPlainRecord(report.last)) break;
        const last = tokenCounts(report.last);
        // `last` is one model request, `total` the whole native thread: a turn of several requests is the growth of the total.
        if (isPlainRecord(report.total)) {
          const total = tokenCounts(report.total);
          const before = this.usageTotal;
          this.usageTotal = total;
          // A report outside a turn (replayed on resume) only sets the total to count from.
          if (this.activeTurn) {
            const turn = this.turnUsage ?? tokenCounts({});
            // A total that went down belongs to another native thread: only this request is known.
            const base = before && TOKEN_KEYS.every((key) => total[key] >= before[key]) ? before : null;
            for (const key of TOKEN_KEYS) turn[key] += base ? total[key] - base[key] : last[key];
            this.turnUsage = turn;
          }
        } else this.turnUsage = last;
        // The last request's input and output are what the next one starts from.
        const context = Number(report.last.totalTokens) || last.inputTokens + last.outputTokens;
        const window = Number(report.modelContextWindow) || 0;
        if (context || window) sink.usage({ ...(context ? { contextTokens: context } : {}), ...(window ? { contextWindow: window } : {}) });
        break;
      }
      case "item/started":
      case "item/completed": {
        if (!isPlainRecord(p.item)) return;
        const item = p.item;
        if (item.type === "userMessage" && typeof item.clientId === "string" && this.steers.has(item.clientId)) {
          this.steers.delete(item.clientId);
          sink.steered?.(item.clientId);
        }
        const converted = appServerItem(item);
        if (converted) this.onItem(converted, message.method === "item/completed", sink);
        break;
      }
      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const id = String(p.itemId);
        const delta = String(p.delta ?? "");
        if (!this.streamed.has(id)) sink.breakBlock();
        if (message.method.includes("reasoning")) sink.reasoning(delta);
        else sink.text(delta);
        this.streamed.set(id, (this.streamed.get(id) ?? 0) + delta.length);
        break;
      }
      case "item/commandExecution/outputDelta":
        this.outputs.set(String(p.itemId), (this.outputs.get(String(p.itemId)) ?? "") + String(p.delta ?? ""));
        sink.toolUpdate(String(p.itemId), { output: this.outputs.get(String(p.itemId)) });
        break;
      case "serverRequest/resolved":
        if (typeof p.requestId === "string" || typeof p.requestId === "number") this.requests.get(p.requestId)?.abort();
        break;
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed": {
        // Log every native review; only denials offer a human-approved retry.
        this.reviewLog("Codex Auto-review", { scribeThreadId: this.thread.id, method: message.method, ...p });
        const review = isPlainRecord(p.review) ? p.review : {};
        const action = isPlainRecord(p.action) ? p.action : {};
        const status = message.method.endsWith("/started") ? "inProgress" : review.status;
        if (status === "inProgress" || status === "approved") break;
        const key = typeof p.reviewId === "string" ? p.reviewId
          : JSON.stringify([p.turnId, p.targetItemId, action]);
        if (this.reviewNotices.has(key)) break;
        this.reviewNotices.add(key);
        const detail = typeof action.command === "string" ? action.command
          : action.type === "execve" ? [action.program, ...(Array.isArray(action.argv) ? action.argv : [])].join(" ")
          : action.type === "writeStdin" ? `stdin for process ${action.processId ?? "unknown"}`
          : action.type === "applyPatch" && Array.isArray(action.files) ? `edit ${action.files.join(", ")}`
          : action.type === "networkAccess" ? String(action.target ?? action.host ?? "network access")
          : action.type === "mcpToolCall" ? `${action.server ?? "MCP"}/${action.toolName ?? "tool"}`
          : action.type === "requestPermissions" ? "additional permissions"
          : typeof action.type === "string" ? action.type : "action";
        const labels: Record<string, string> = { denied: "denied", timedOut: "timed out", aborted: "aborted" };
        const reason = typeof review.rationale === "string" && review.rationale.trim() ? review.rationale
          : status === "denied" ? "The reviewer did not authorize this action. Revise it or request explicit permission."
          : status === "timedOut" ? "The reviewer did not respond in time. Retry the action."
          : status === "aborted" ? "The review was cancelled."
          : "The reviewer returned an unknown status. Check the diagnostic log.";
        sink.notice(status === "denied" ? "warn" : "error",
          `Auto-review ${labels[String(status)] ?? "failed"}: ${compactReviewText(detail, 160)}: ${compactReviewText(reason, 300)}`);
        if (status === "denied" && message.method.endsWith("/completed") &&
            !this.nativeTurnCompleted && typeof p.reviewId === "string" && !this.reviewedDenials.has(p.reviewId)) {
          this.reviewedDenials.add(p.reviewId);
          const approval = this.approveReviewDenial(p, detail, rpc, sink);
          this.reviewApprovals.add(approval);
          void approval.finally(() => this.reviewApprovals.delete(approval));
        }
        break;
      }
      case "guardianWarning":
        // This unstructured explanation also repeats allowed and denied review details.
        // Keep it for diagnostics; structured completion above is the chat's only review notice.
        this.reviewLog("Codex Auto-review", { scribeThreadId: this.thread.id, method: message.method, ...p });
        break;
      case "turn/plan/updated":
        if (Array.isArray(p.plan)) sink.todos(p.plan.filter(isPlainRecord).map((step) => ({ content: String(step.step ?? ""), status: step.status === "completed" ? "completed" : step.status === "inProgress" ? "in_progress" : "pending" })));
        break;
      case "error": {
        const text = isPlainRecord(p.error) ? String(p.error.message) : "Codex error";
        if (!(this.thread.noTools && CODE_MODE_OFF.test(text))) sink.notice("error", text);
        break;
      }
    }
  }

  private async approveReviewDenial(p: RpcRecord, detail: string, rpc: CodexRpc, sink: RunSink): Promise<void> {
    const action = isPlainRecord(p.action) ? p.action : {};
    const review = isPlainRecord(p.review) ? p.review : {};
    const signal = this.abort!.signal;
    const threadId = this.nativeId;
    const tool: ToolKind = action.type === "applyPatch" ? "edit"
      : action.type === "networkAccess" ? "fetch" : action.type === "mcpToolCall" ? "mcp" : "execute";
    try {
      const event = guardianDenialEvent(p);
      const decision = await sink.approval({
        humanOnly: true, tool,
        ...(typeof p.targetItemId === "string" ? { toolId: p.targetItemId } : {}),
        title: "Codex Auto-review denied this action",
        detail: [detail, typeof action.cwd === "string" ? `Directory: ${action.cwd}` : "",
          ["execve", "writeStdin", "requestPermissions"].includes(String(action.type)) ? JSON.stringify(action, null, 2) : "",
          typeof review.riskLevel === "string" ? `Risk: ${review.riskLevel}` : "",
          typeof review.rationale === "string" ? review.rationale : "",
          "Approve one retry? Codex will review it again and may still deny it."].filter(Boolean).join("\n"),
        options: [{ id: "approveRetry", label: "Approve one retry", kind: "allow_once" },
          { id: "keepDenied", label: "Deny", kind: "reject_once" }],
      }, signal);
      if (signal.aborted || this.cancelled || this.rpc !== rpc || this.nativeId !== threadId) return;
      if (decision.optionId !== "approveRetry") {
        return;
      }
      // The endpoint expects the core protocol's snake_case assessment event,
      // rather than the app-server's camelCase notification payload.
      await rpc.call("thread/approveGuardianDeniedAction", { threadId, event });
      if (signal.aborted || this.cancelled || this.rpc !== rpc) return;
      this.approvedRetries.push(String(p.reviewId));
      sink.notice("info", `Approved one retry of Codex Auto-review denial ${p.reviewId}; the retry still goes through Auto-review.`);
    } catch (error) {
      if (!signal.aborted && !this.cancelled) sink.notice("error", `Could not approve the Codex Auto-review retry: ${(error as Error).message}`);
    }
  }

  private async onRequest(message: RpcMessage, rpc: CodexRpc): Promise<void> {
    const controller = new AbortController();
    this.requests.set(message.id!, controller);
    const signal = this.abort ? AbortSignal.any([controller.signal, this.abort.signal]) : controller.signal;
    try { await this.handleRequest(message, rpc, signal); }
    finally { this.requests.delete(message.id!); }
  }

  private async handleRequest(message: RpcMessage, rpc: CodexRpc, signal: AbortSignal): Promise<void> {
    const p = message.params ?? {};
    const id = message.id!;
    const sink = this.sink;
    if (!sink || (p.threadId && p.threadId !== this.nativeId) || (p.turnId && p.turnId !== this.activeTurn)) {
      rpc.reject(id, "No matching active Scribe turn");
      return;
    }
    if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
      const file = message.method.includes("fileChange");
      const decision = await sink.approval({
        toolId: String(p.itemId), tool: file ? "edit" : "execute",
        title: file ? "Edit files" : "Run command",
        detail: [p.command, p.reason, p.cwd].filter((value) => typeof value === "string").join("\n"),
        options: [{ id: "accept", label: "Allow once", kind: "allow_once" },
          { id: "acceptForSession", label: "Allow for this session", kind: "allow_always" },
          { id: "decline", label: "Deny", kind: "reject_once" }],
      }, signal).catch(() => ({ optionId: "cancel" }));
      rpc.reply(id, { decision: ["accept", "acceptForSession", "decline"].includes(decision.optionId) ? decision.optionId : "cancel" });
      return;
    }
    if (message.method === "item/tool/requestUserInput") {
      // A thread without tools asks nobody (#729).
      if (this.thread.noTools) return rpc.reply(id, { answers: {} });
      const questions = Array.isArray(p.questions) ? p.questions.filter(isPlainRecord) : [];
      const answer = await sink.question({ questions: questions.map((q) => ({ id: String(q.id), header: String(q.header ?? ""), prompt: String(q.question), multi: false,
        options: Array.isArray(q.options) ? q.options.filter(isPlainRecord).map((o) => ({ id: String(o.label), label: String(o.label), description: String(o.description ?? "") })) : [],
      })) }, signal).catch(() => ({ skipped: true as const }));
      const answers: Record<string, { answers: string[] }> = {};
      if (!("skipped" in answer)) for (const q of questions) {
        const qid = String(q.id);
        answers[qid] = { answers: [...(answer.answers[qid] ?? []), ...(answer.notes?.[qid] ? [answer.notes[qid]] : [])] };
      }
      rpc.reply(id, { answers });
      return;
    }
    if (message.method === "item/tool/call") {
      const fail = (text: string) => rpc.reply(id, { success: false, contentItems: [{ type: "inputText", text }] });
      const tool = this.bridged.get(String(p.tool));
      if (!tool) {
        fail(`The tool ${String(p.tool)} is not available: its MCP server was removed or did not start. A new chat picks up changed MCP servers.`);
        return;
      }
      const callId = String(p.callId ?? "");
      try {
        // The approval sits on the call's row when the stream already showed it.
        const result = await tool.call(isPlainRecord(p.arguments) ? p.arguments : {}, { ...(this.tools.has(callId) ? { toolCallId: callId } : {}), signal });
        rpc.reply(id, { success: !result.isError, contentItems: dynamicToolContent(result.content) });
      } catch (error) {
        fail((error as Error).message || "The tool failed.");
      }
      return;
    }
    // Unsupported permission grants and MCP elicitations fail closed, never silently grant access.
    if (message.method === "item/permissions/requestApproval") { rpc.reply(id, { permissions: {}, scope: "turn" }); return; }
    if (message.method === "mcpServer/elicitation/request") {
      const meta = isPlainRecord(p._meta) ? p._meta : {};
      const server = typeof p.serverName === "string" ? p.serverName : "MCP";
      if (meta.codex_approval_kind !== "mcp_tool_call") {
        // Codex tells the agent "user rejected" for any decline, so say who declined.
        sink.notice("warn", `Scribe declined a request for input from the ${server} MCP server: it cannot show MCP forms. The agent is told the user rejected it.`);
        rpc.reply(id, { action: "decline", content: null, _meta: null });
        return;
      }
      // Codex asks this way before an MCP tool without a read-only annotation runs, Scribe's page tools included.
      const session = Array.isArray(meta.persist) && meta.persist.includes("session");
      const decision = await sink.approval({
        tool: "mcp", boardTool: server === "scribe",
        title: `${server} MCP tool`,
        detail: [p.message, isPlainRecord(meta.tool_params) ? compactReviewText(JSON.stringify(meta.tool_params), 600) : ""]
          .filter((value) => typeof value === "string" && value).join("\n"),
        options: [{ id: "accept", label: "Allow once", kind: "allow_once" },
          ...(session ? [{ id: "acceptForSession", label: "Allow for this session", kind: "allow_always" as const }] : []),
          { id: "decline", label: "Deny", kind: "reject_once" }],
      }, signal).catch(() => ({ optionId: "cancel" }));
      rpc.reply(id, decision.optionId === "accept" || decision.optionId === "acceptForSession"
        ? { action: "accept", content: {}, _meta: decision.optionId === "acceptForSession" ? { persist: "session" } : null }
        : { action: decision.optionId === "decline" ? "decline" : "cancel", content: null, _meta: null });
      return;
    }
    rpc.reject(id, `Unsupported Codex request: ${message.method}`);
  }

  private stream(id: string, text: string, kind: "text" | "reasoning", sink: RunSink): void {
    const prev = this.streamed.get(id) ?? 0;
    const next = text.slice(prev);
    if (!next) {
      this.streamed.set(id, text.length);
      return;
    }
    if (kind === "text") sink.text(next);
    else sink.reasoning(next);
    this.streamed.set(id, text.length);
  }

  private onItem(item: ThreadItem, finished: boolean, sink: RunSink): void {
    switch (item.type) {
      case "image_generation": {
        if (!this.tools.has(item.id)) {
          this.tools.add(item.id);
          sink.toolStart({ toolId: item.id, name: "image_generation", tool: "other", title: "Generate image", status: "running" });
        }
        if (!finished) return;
        const failed = item.status === "failed" || Boolean(item.failure);
        sink.toolUpdate(item.id, { status: failed ? "error" : "done" });
        if (failed) sink.notice("error", "Image generation failed.");
        else if (item.result) sink.images?.(item.id, [{ data: item.result }]);
        else if (item.savedPath) sink.images?.(item.id, [{ path: item.savedPath }]);
        else sink.notice("warn", "The provider completed image generation without accessible image data.");
        return;
      }
      case "agent_message":
        if (!this.streamed.has(item.id)) sink.breakBlock();
        this.stream(item.id, item.text, "text", sink);
        return;
      case "reasoning":
        if (!this.streamed.has(item.id)) sink.breakBlock();
        this.stream(item.id, item.text, "reasoning", sink);
        if (finished) sink.breakBlock();
        return;
      case "todo_list":
        sink.todos(item.items.map((todo) => ({ content: todo.text, status: todo.completed ? "completed" : "pending" })));
        return;
      case "error":
        if (!(this.thread.noTools && CODE_MODE_OFF.test(item.message))) sink.notice("error", item.message);
        return;
      case "command_execution":
      case "file_change":
      case "mcp_tool_call":
      case "web_search":
        this.onTool(item, finished, sink);
        return;
      default:
        return;
    }
  }

  private onTool(item: Extract<ThreadItem, { type: "command_execution" | "file_change" | "mcp_tool_call" | "web_search" }>, finished: boolean, sink: RunSink): void {
    const title = this.toolTitle(item);
    const detail = item.type === "command_execution" ? item.command : item.type === "web_search" ? item.query : undefined;
    const paths = item.type === "file_change" ? item.changes.map((change) => change.path) : undefined;
    const input = item.type === "mcp_tool_call" ? item.arguments : undefined;
    if (!this.tools.has(item.id)) {
      this.tools.add(item.id);
      sink.breakBlock();
      sink.toolStart({
        toolId: item.id,
        name: item.type,
        tool: toolKind(item),
        title,
        ...(detail ? { detail } : {}),
        ...(input !== undefined ? { input } : {}),
        ...(paths?.length ? { paths } : {}),
        status: "running",
        // Scribe's own tools ask its hooks from the MCP process (mcp.ts), before they do anything.
        ...(item.type === "mcp_tool_call" && item.server === "scribe" ? { held: true } : {}),
      });
    } else if (!finished) {
      const output = item.type === "command_execution" ? item.aggregated_output : undefined;
      sink.toolUpdate(item.id, {
        title,
        ...(detail ? { detail } : {}),
        ...(input !== undefined ? { input } : {}),
        ...(paths?.length ? { paths } : {}),
        ...(output ? { output } : {}),
      });
    }
    if (!finished) return;
    const failed =
      (item.type === "command_execution" && item.status === "failed") ||
      (item.type === "file_change" && item.status === "failed") ||
      (item.type === "mcp_tool_call" && item.status === "failed");
    const output =
      item.type === "command_execution"
        ? item.aggregated_output
        : item.type === "mcp_tool_call"
          ? mcpText(item)
          : undefined;
    const quiet = item.type === "file_change" && !failed;
    sink.toolUpdate(item.id, {
      title,
      ...(paths?.length ? { paths } : {}),
      status: failed ? "error" : "done",
      ...(!quiet && output ? { output } : {}),
      ...(item.type === "command_execution" && item.exit_code !== undefined ? { exitCode: item.exit_code } : {}),
    });
    if (item.type === "mcp_tool_call") sink.images?.(item.id, outputImages(item.result?.content));
  }

  private toolTitle(item: ThreadItem): string {
    switch (item.type) {
      case "command_execution":
        return "Shell";
      case "file_change":
        return item.changes.length === 1 ? `Edit ${item.changes[0]?.path ?? "file"}` : `Edit ${item.changes.length} files`;
      case "mcp_tool_call":
        if (!item.server) {
          const tool = this.bridged.get(item.tool);
          return tool ? `${tool.server}: ${tool.tool}` : item.tool;
        }
        return item.server === "scribe" ? `Scribe: ${item.tool}` : `${item.server}: ${item.tool}`;
      case "web_search":
        return `Search ${item.query}`.trim();
      default:
        return item.type;
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.abort?.abort();
    if (this.activeTurn) await this.interrupt();
  }

  private async interrupt(): Promise<void> {
    try { await this.rpc?.call("turn/interrupt", { threadId: this.nativeId, turnId: this.activeTurn }, 5000); }
    catch { this.rpc?.close(); }
  }

  private stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.running) return;
    this.rpc?.close();
    this.rpc = null;
    this.sessionKey = null;
    this.bridge?.close();
    this.bridge = null;
  }

  dispose(): void {
    void this.cancel();
    this.running = false;
    this.stop();
    this.onDispose();
  }
}
