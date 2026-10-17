import { randomUUID } from "node:crypto";
import { cursorToolsOff, customKey, modeOff, scribeToolsOff } from "../customModes.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentOptions,
  InteractionUpdate,
  ModelListItem,
  ModelSelection,
  Run,
  SDKAgent,
  SDKCustomTool,
  SDKCustomToolContent,
  SDKCustomToolResult,
  SDKJsonValue,
  ToolName,
} from "@cursor/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dataDir } from "../../config.js";
import { log } from "../../log.js";
import type { ModelOption, ProviderStatus, SlashCommand, Thread, ToolKind, Usage } from "../types.js";
import { isPlainRecord, noPages } from "../types.js";
import { WEB_SEARCH_SCHEMA, gatedFetchText, gatedSearchText, webCallAllowed, webSearchDescription, type WebAccess, type WebCall } from "../webAccess.js";
import { clampTimeout, runCommand } from "../hostShell.js";
import { cursorAccessToken } from "./cursorAuth.js";
import { SqliteCursorStore } from "./cursorStore.js";
import { McpBridge } from "../mcpBridge.js";
import { serversKey } from "../mcpConfig.js";
import { SparePool, type AgentProvider, type ProviderSession, type RunSink, type SessionContext, type SteerInput, type TurnInput, type TurnResult } from "./provider.js";
import { threadToken } from "../../callers.js";

/**
 * Cursor through @cursor/sdk, in this process: one local SDK agent per thread, kept in a store under
 * Scribe's data folder. The SDK has no approval callback, so "ask", "edits" and "auto" all run with
 * Cursor's Auto-review classifier (it denies, it does not ask) and "full" runs everything.
 *
 * What a thread may touch is a real tool list, passed on every create and resume (the SDK does not
 * keep it): Pages gets the board tools only, Ask read and search tools, web off drops the web tools.
 * The board's tools reach the agent as SDK custom tools that call this daemon's board MCP server,
 * because Auto-review fails MCP server calls closed and custom tools are never sent to it.
 *
 * Host shell (experimental, Agent settings): in Code and Plan threads set to "ask" or "edits", the
 * built-in shell is off and a custom tool runs commands in this daemon after the user approves each
 * one, the only way to ask first that the SDK leaves open. Board workers keep the built-in shell.
 */

const IDLE_CLOSE_MS = 15 * 60 * 1000;
const MODELS_TTL_MS = 30 * 60 * 1000;
/** The MCP server the SDK files custom tools under; the board's tools appear there. */
export const BOARD_MCP = "custom-user-tools";
/** Cursor's backend (Connect RPC); the CLI and the SDK talk to the same host. */
const CURSOR_API = "https://api2.cursor.sh";
const NOT_LOGGED_IN = "Cursor is not logged in. Log in from Agent settings, or set CURSOR_API_KEY.";
/** Parameter ids that carry a model's reasoning level, most specific first. */
const EFFORT_PARAMS = ["effort", "reasoning_effort", "reasoning", "thought_level", "thinking"];
const WEB_TOOLS: ToolName[] = ["webSearch", "webFetch", "fetch", "xSearch"];
/** Tools that wait on an answer from the host; the SDK gives Scribe no way to answer them yet (#141). */
const NO_ANSWER_TOOLS: ToolName[] = ["askQuestion"];
/** What an Ask thread may use besides MCP and the web: reading and searching. */
const ASK_TOOLS: ToolName[] = ["read", "grep", "glob", "ls", "semSearch", "readLints", "updateTodos", "readTodos"];
/** The custom tool that stands in for the built-in shell when Scribe runs commands itself. */
export const HOST_SHELL = "run_command";

type Sdk = typeof import("@cursor/sdk");
let sdkLoad: Promise<Sdk> | null = null;
/** The SDK is large; load it on first use instead of with the daemon. */
function sdk(): Promise<Sdk> {
  sdkLoad ??= import("@cursor/sdk");
  return sdkLoad;
}

/** An agent nothing refers to may still be starting (a spare, a one-off answer) this long after it last ran. */
const PRUNE_GRACE_MS = 60 * 60 * 1000;
/** A thread idle this long loses its agent's checkpoints; its next turn starts a new agent with a recap. */
export const CHECKPOINT_IDLE_MS = 3 * 24 * 60 * 60 * 1000;

const storeDir = () => path.join(dataDir(), "cursor-agents");
let agentStore: Promise<SqliteCursorStore> | null = null;
/**
 * Scribe's own store, so threads don't mix with the Cursor IDE's or another SDK host's agents.
 * SQLite, not the SDK's JSONL store: that one rewrites whole files on every write (#212).
 */
function store(): Promise<SqliteCursorStore> {
  agentStore ??= (async () => {
    const dir = storeDir();
    const opened = new SqliteCursorStore(path.join(dir, "store.sqlite"), sdk);
    await opened.importJsonl(dir).catch((err) => log(`Cursor store: JSONL import failed: ${(err as Error).message}`));
    return opened;
  })().catch((err) => {
    agentStore = null;
    throw err;
  });
  return agentStore;
}

/** Local SDK agent ids; anything else in Thread.nativeId is an old ACP session id. */
export function isSdkAgentId(id: string | null | undefined): boolean {
  return Boolean(id && id.startsWith("agent-"));
}

function errorText(err: unknown): string {
  const name = (err as Error)?.name ?? "";
  if (name === "AuthenticationError" || /API key is required/i.test((err as Error)?.message ?? "")) return NOT_LOGGED_IN;
  return (err as Error)?.message || String(err);
}

export function mapModels(list: ModelListItem[]): ModelOption[] {
  return list.map((model) => {
    const params = model.parameters ?? [];
    const defaults = new Map((model.variants?.find((v) => v.isDefault)?.params ?? []).map((p) => [p.id, p.value]));
    const effort = EFFORT_PARAMS.map((id) => params.find((p) => p.id === id)).find(Boolean);
    const choice = (value: { value: string; displayName?: string }) => ({ id: value.value, label: (value.displayName || value.value).replace(/[​-‍]/g, "") });
    return {
      id: model.id,
      label: model.displayName || model.id,
      provider: "cursor",
      ...(model.description ? { description: model.description } : {}),
      efforts: (effort?.values ?? []).map(choice),
      defaultEffort: effort ? (defaults.get(effort.id) ?? null) : null,
      ...(effort ? { effortParam: effort.id } : {}),
      params: params
        .filter((p) => p !== effort)
        .map((p) => ({
          id: p.id,
          label: p.displayName || p.id,
          options: p.values.map(choice),
          default: defaults.get(p.id) ?? p.values[0]?.value ?? "",
        })),
    } satisfies ModelOption;
  });
}

/** The thread's model and the parameters that model takes; unknown ones would be rejected. */
export function modelSelection(thread: Pick<Thread, "model" | "effort" | "modelParams">, models: ModelOption[]): ModelSelection {
  const known = models.find((m) => m.id === thread.model);
  const id = !thread.model || thread.model === "default" ? (models[0]?.id ?? "auto") : thread.model;
  if (!known) return { id };
  const params: Array<{ id: string; value: string }> = [];
  for (const param of known.params) {
    const value = thread.modelParams[param.id];
    if (value !== undefined && param.options.some((o) => o.id === value)) params.push({ id: param.id, value });
  }
  if (known.effortParam && thread.effort && known.efforts.some((e) => e.id === thread.effort)) {
    params.push({ id: known.effortParam, value: thread.effort });
  }
  return params.length ? { id, params } : { id };
}

/** Built-in tools for a thread: an allowlist (tools) or what to drop from the default set (disallowedTools). */
export function toolLists(thread: Pick<Thread, "mode" | "web" | "custom">, hostShell = false): { tools?: ToolName[]; disallowedTools?: ToolName[] } {
  const web = thread.web === "on" ? WEB_TOOLS : [];
  // A custom mode's tool groups come off either list.
  const off = cursorToolsOff(thread);
  const keep = (tools: ToolName[]) => tools.filter((name) => !off.includes(name));
  if (thread.mode === "board") return { tools: keep(["mcp", "updateTodos", "readTodos", ...web]) };
  if (thread.mode === "ask") return { tools: keep([...ASK_TOOLS, "mcp", ...web]) };
  // Not "mcp": that would take the custom tools, the host shell among them, away too.
  return { disallowedTools: [...new Set([...NO_ANSWER_TOOLS, ...(hostShell ? (["shell"] as ToolName[]) : []), ...(thread.web === "on" ? [] : WEB_TOOLS), ...off])] };
}

/** The creation-time review setting; the SDK has no per-send override. */
export function cursorAutoReview(thread: Pick<Thread, "mode" | "approval">): boolean {
  return thread.mode !== "board" && thread.approval !== "full";
}

/** Whether Scribe runs this thread's shell commands itself, asking first: only where the user would be asked. */
export function wantsHostShell(thread: Pick<Thread, "mode" | "approval" | "custom">, enabled: boolean): boolean {
  return enabled && !modeOff(thread, "shell") && (thread.mode === "code" || thread.mode === "plan") && (thread.approval === "ask" || thread.approval === "edits");
}

export class CursorProvider implements AgentProvider {
  readonly id = "cursor" as const;
  readonly label = "Cursor";
  private modelCache: { at: number; models: ModelOption[] } | null = null;
  private modelLoad: Promise<ModelOption[]> | null = null;
  private sessions = new Set<CursorSession>();
  private spares = new SparePool<CursorSession>();
  private login: { url: string | null; done: Promise<void> } | null = null;

  async status(): Promise<ProviderStatus> {
    if (process.env.CURSOR_API_KEY?.trim()) return { id: this.id, label: this.label, available: true, detail: "CURSOR_API_KEY" };
    try {
      const { Cursor } = await sdk();
      const auth = await Cursor.auth.status();
      if (auth.status === "logged-in") {
        return { id: this.id, label: this.label, available: true, detail: auth.email ? `SDK · ${auth.email}` : "SDK" };
      }
      return { id: this.id, label: this.label, available: false, detail: this.login ? "Finish the login in your browser" : "Not logged in", login: true };
    } catch (err) {
      return { id: this.id, label: this.label, available: false, detail: `Cursor SDK failed to load: ${(err as Error).message}` };
    }
  }

  /**
   * Start a browser login (Cursor.auth.login). It mints a user API key into ~/.cursor/sdk/auth.json
   * that the SDK uses from then on. Resolves with the login URL as soon as there is one; the poll
   * goes on in the background.
   */
  async startLogin(): Promise<{ url: string | null }> {
    if (!this.login) {
      const { Cursor } = await sdk();
      let gotUrl: (url: string) => void = () => {};
      const urlReady = new Promise<string>((resolve) => (gotUrl = resolve));
      const entry: { url: string | null; done: Promise<void> } = { url: null, done: Promise.resolve() };
      entry.done = Cursor.auth
        .login({
          apiKeyName: "Scribe",
          // Scribe's settings open the URL in the user's browser.
          openBrowser: false,
          onLoginUrl: (url) => {
            entry.url = url;
            gotUrl(url);
          },
          signal: AbortSignal.timeout(10 * 60 * 1000),
        })
        .then((result) => {
          log(`Cursor SDK login done${result.email ? ` (${result.email})` : ""}`);
          this.modelCache = null;
        })
        .catch((err) => log(`Cursor SDK login failed: ${(err as Error).message}`))
        .finally(() => {
          if (this.login === entry) this.login = null;
        });
      this.login = entry;
      await Promise.race([urlReady, entry.done, new Promise((resolve) => setTimeout(resolve, 15_000))]);
    }
    return { url: this.login?.url ?? null };
  }

  /**
   * The plan's usage this billing period, from the private dashboard API the CLI's /usage calls
   * (the SDK's getUsage reports tokens and cost per agent, not the plan's windows). The token is the
   * Cursor app's own login (see cursorAuth). Null without a token or when the call fails. Brittle by
   * nature: a Cursor update can move it.
   */
  async fetchPlanUsage(): Promise<unknown | null> {
    const auth = cursorAccessToken();
    if (!auth) return null;
    const { token } = auth;
    try {
      const res = await fetch(`${CURSOR_API}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, {
        method: "POST",
        headers: { "content-type": "application/json", "connect-protocol-version": "1", authorization: `Bearer ${token}` },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        log(`Cursor usage fetch failed: HTTP ${res.status} (token from ${auth.source === "env" ? "CURSOR_ACCESS_TOKEN" : "the Cursor app's login"})`);
        return null;
      }
      return await res.json();
    } catch (err) {
      log(`Cursor usage fetch failed: ${(err as Error).message}`);
      return null;
    }
  }

  models(refresh = false): Promise<ModelOption[]> {
    if (!refresh && this.modelCache) {
      // A stale list is still right for nearly every model; refresh behind the caller.
      if (Date.now() - this.modelCache.at >= MODELS_TTL_MS && !this.modelLoad) void this.models(true);
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

  /** Seed from the saved list so the first turn after a restart does not wait for a model list. Marked stale. */
  setModelCache(models: ModelOption[]): void {
    if (models.length && !this.modelCache) this.modelCache = { at: 0, models };
  }

  private async loadModels(): Promise<ModelOption[]> {
    try {
      const { Cursor } = await sdk();
      const models = mapModels(await Cursor.models.list());
      if (models.length) {
        this.modelCache = { at: Date.now(), models };
      }
      return models;
    } catch (err) {
      log(`Cursor model list failed: ${errorText(err)}`);
      return this.modelCache?.models ?? [];
    }
  }

  /** A throwaway agent in a temp folder with no tools: the model can only answer in text. */
  async complete(prompt: string, model: string, signal?: AbortSignal): Promise<string> {
    const { Agent } = await sdk();
    const models = this.cachedModels().length ? this.cachedModels() : await this.models();
    const agent = await Agent.create({
      model: modelSelection({ model, effort: null, modelParams: {} }, models),
      tools: [],
      local: { cwd: os.tmpdir(), settingSources: [], store: await store() },
    }).catch((err) => {
      throw new Error(errorText(err));
    });
    try {
      const run = await agent.send(prompt);
      const cancel = () => void run.cancel().catch(() => undefined);
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const result = await run.wait();
        if (signal?.aborted || result.status === "cancelled") throw new Error("cancelled");
        if (result.status === "error") throw new Error(result.error?.message || "Cursor run failed");
        return result.result ?? "";
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    } finally {
      agent.close();
    }
  }

  createSession(thread: Thread, ctx: SessionContext): ProviderSession {
    const spare = thread.nativeId ? null : this.spares.take(spareKey(thread, ctx), thread.id);
    if (spare) {
      spare.update(thread);
      return spare;
    }
    const session = new CursorSession(this, thread, ctx, () => this.sessions.delete(session));
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
      const session = new CursorSession(this, draft, ctx, () => this.sessions.delete(session));
      this.sessions.add(session);
      this.spares.put(key, session);
      spare = session;
    }
    void spare.warm(instructions);
  }

  /** False when the thread's agent is gone or prune dropped its checkpoints: the next turn needs a recap. */
  async resumable(nativeId: string): Promise<boolean> {
    if (!isSdkAgentId(nativeId)) return false;
    return (await store()).resumable(nativeId);
  }

  /** Drop the agents of deleted and rewound threads, and the checkpoints of idle ones (#214). */
  async prune(keep: ReadonlySet<string>): Promise<void> {
    // Nothing to do (and no need to open the store) before Cursor was ever used.
    if (!agentStore && !fs.existsSync(path.join(storeDir(), "store.sqlite"))) return;
    const open = new Set([...this.sessions].map((s) => s.openAgentId()).filter((id): id is string => Boolean(id)));
    const started = Date.now();
    const result = (await store()).prune((id) => keep.has(id), { graceMs: PRUNE_GRACE_MS, idleMs: CHECKPOINT_IDLE_MS, open: (id) => open.has(id) });
    if (result.agents || result.expired) {
      log(`Cursor store: removed ${result.agents} agents, dropped the checkpoints of ${result.expired} idle ones in ${Date.now() - started} ms`);
    }
  }

  dispose(): void {
    this.spares.dispose();
    for (const session of this.sessions) {
      session.dispose();
    }
  }
}

/** A spare is bound to what its agent was opened with. */
function spareKey(thread: Thread, ctx: SessionContext): string {
  const where = thread.mode === "board" || !thread.cwd ? `board:${ctx.scratchDir}` : `cwd:${path.normalize(thread.cwd).toLowerCase()}`;
  return JSON.stringify([where, thread.mode, customKey(thread), thread.web, thread.approval, noPages(thread.scope), ctx.webSearchUrl?.() ?? ""]);
}

/**
 * The board MCP server's tools as SDK custom tools: one MCP client per session, started with the
 * thread's id so card claims point at it.
 */
class BoardTools {
  private client: Client | null = null;
  private opening: Promise<Record<string, SDKCustomTool>> | null = null;

  constructor(
    private spec: SessionContext["boardMcp"],
    readonly threadId: string,
    /** Page tools; off for a thread with no Scribe scope. */
    readonly pages = true,
    /** Tool groups the thread's custom mode turns off (SCRIBE_TOOLS_OFF). */
    readonly toolsOff: Record<string, string> = {}
  ) {}

  tools(): Promise<Record<string, SDKCustomTool>> {
    this.opening ??= this.open().catch((err) => {
      this.opening = null;
      throw err;
    });
    return this.opening;
  }

  private async open(): Promise<Record<string, SDKCustomTool>> {
    const client = new Client({ name: "scribe-cursor", version: "1" });
    const env = { ...(process.env as Record<string, string>), ...this.spec.env, SCRIBE_THREAD: this.threadId, SCRIBE_THREAD_TOKEN: threadToken(this.threadId), SCRIBE_PROVIDER: "cursor", ...(this.pages ? {} : { SCRIBE_PAGES: "off" }), ...this.toolsOff };
    await client.connect(new StdioClientTransport({ command: this.spec.command, args: this.spec.args, env, stderr: "ignore" }));
    this.client = client;
    const { tools } = await client.listTools();
    const out: Record<string, SDKCustomTool> = {};
    for (const tool of tools) {
      out[tool.name] = {
        description: tool.description ?? "",
        inputSchema: tool.inputSchema as Record<string, SDKJsonValue>,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        execute: async (args) => {
          const result = await client.callTool({ name: tool.name, arguments: args });
          return { content: mcpContent(result.content), isError: result.isError === true };
        },
      };
    }
    return out;
  }

  close(): void {
    void this.client?.close().catch(() => undefined);
    this.client = null;
    this.opening = null;
  }
}

function mcpContent(content: unknown): SDKCustomToolContent[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isPlainRecord).map((block): SDKCustomToolContent => {
    if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if (block.type === "image" && typeof block.data === "string") return { type: "image", data: block.data, ...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}) };
    return { type: "text", text: JSON.stringify(block) };
  });
}

/**
 * Web off or limited: the built-in web tools are off and this fetch takes their place. A URL (or
 * redirect) the thread's web setting does not cover goes through gate, which asks the user.
 * Search comes from gatedSearch when a SearXNG instance is set.
 */
function gatedFetch(gate: (url: string) => Promise<{ allowed: boolean; message?: string }>, search: boolean): SDKCustomTool {
  return {
    description: `Fetch a web page or file over HTTP(S) and return its text. Sites the user has not allowed ask the user first, who may refuse.${search ? "" : " Web search is not available."}`,
    inputSchema: { type: "object", properties: { url: { type: "string", description: "Absolute http(s) URL" } }, required: ["url"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const { text, isError } = await gatedFetchText(args.url, gate);
      return { content: [{ type: "text", text }], isError };
    },
  };
}

/** Web off or limited, with a SearXNG instance set: web_search in place of Cursor's own search. */
function gatedSearch(baseUrl: string, web: WebAccess, access: Parameters<typeof gatedSearchText>[2]): SDKCustomTool {
  return {
    description: webSearchDescription(web),
    inputSchema: WEB_SEARCH_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const { text, isError } = await gatedSearchText(baseUrl, args, access);
      return { content: [{ type: "text", text }], isError };
    },
  };
}

type Steer = { text: string; state: "queued" | "sending" | "delivered" | "dropped"; settled?: Promise<void> };

function toolKind(type: string): ToolKind {
  switch (type) {
    case "shell":
      return "execute";
    case "read":
    case "ls":
    case "readLints":
      return "read";
    case "grep":
    case "glob":
    case "semSearch":
      return "search";
    case "edit":
    case "write":
      return "edit";
    case "delete":
      return "delete";
    case "mcp":
      return "mcp";
    case "webSearch":
    case "webFetch":
    case "fetch":
    case "xSearch":
      return "fetch";
    default:
      return "other";
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

class CursorSession implements ProviderSession {
  private agent: SDKAgent | null = null;
  /** What the open agent was created or resumed with; a change reopens it before the next turn. */
  private agentKey: string | null = null;
  private opening: Promise<SDKAgent> | null = null;
  /**
   * The open agent was resumed and has not sent yet. Agent.create queues the first run and only that
   * agent object knows to use it, so a resumed agent (a spare reopened for its thread, or one a crash
   * left mid-run) still has an active run on record and its first send is refused without force.
   */
  private resumed = false;
  private agentId: string | null;
  /** The agent id last reported to the host; the host clearing it (rewind) means start over. */
  private reported: string | null = null;
  private board: BoardTools | null = null;
  private bridge: McpBridge | null = null;
  /** Bridged user tools' display titles ("server: tool"), by custom tool name. */
  private bridgedLabels = new Map<string, string>();
  private current: Run | null = null;
  private sink: RunSink | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private cancelled = false;
  private lastInstructions = "";
  private warming: Promise<void> | null = null;
  private steers = new Map<string, Steer>();
  /** Steered message the last turn did not take in; the host adopts it as the next turn. */
  private carry: string | null = null;
  private lastUsage: Usage | null = null;
  private tools = new Map<string, string>();
  /** A plan the agent wrote this turn (Plan mode), offered to the user when the turn ends. */
  private plan: string | null = null;
  /** Host shell calls seen in the stream (call id to command), and whether a run has been matched to each. */
  private shellCalls = new Map<string, { command: string; taken: boolean; exitCode?: number | null }>();
  /** Host shell commands waiting on approval or running; cancel stops them. */
  private shellRuns = new Set<AbortController>();

  constructor(
    private provider: CursorProvider,
    private thread: Thread,
    private ctx: SessionContext,
    private onDispose: () => void
  ) {
    this.agentId = isSdkAgentId(thread.nativeId) ? thread.nativeId : null;
  }

  scribeThreadId(): string {
    return this.thread.id;
  }

  /** The agent this session has open (or is opening); prune leaves it alone. */
  openAgentId(): string | null {
    return this.agent || this.opening ? this.agentId : null;
  }

  update(thread: Thread): void {
    this.thread = thread;
    if (this.reported && thread.nativeId !== this.reported && !this.current) {
      // The host dropped the session (a rewind): start a new agent.
      this.reported = null;
      this.agentId = isSdkAgentId(thread.nativeId) ? thread.nativeId : null;
      this.closeAgent();
    }
    if (this.agentKey !== null && this.agentKey !== this.key() && !this.current) this.closeAgent();
  }

  async commands(): Promise<SlashCommand[]> {
    return [];
  }

  private cwd(): string {
    if (this.thread.mode === "board" || !this.thread.cwd) {
      return this.ctx.scratchDir;
    }
    return this.thread.cwd;
  }

  private key(): string {
    const t = this.thread;
    // The SDK fixes Auto-review at open time. Ask/Edits/Auto share that setting;
    // hostShell below still reconnects when an approval change changes the tool setup.
    return JSON.stringify([t.id, t.mode, customKey(t), t.web, cursorAutoReview(t), this.cwd(), this.hostShell(), noPages(t.scope), serversKey(this.ctx.mcpServers?.(t) ?? []), this.ctx.webSearchUrl?.() ?? ""]);
  }

  /**
   * The user's MCP servers (Agent settings) as custom tools named "<server>__<tool>": Auto-review would
   * fail their calls closed as MCP servers, and this way Scribe asks first by the server's setting.
   */
  private async userTools(): Promise<Record<string, SDKCustomTool>> {
    const servers = this.ctx.mcpServers?.(this.thread) ?? [];
    if (this.bridge && (serversKey(this.bridge.servers) !== serversKey(servers) || this.bridge.cwd !== this.cwd())) {
      this.bridge.close();
      this.bridge = null;
    }
    if (!servers.length) return {};
    this.bridge ??= new McpBridge(
      servers,
      this.cwd(),
      () => this.thread,
      () => {
        const sink = this.sink;
        if (sink) return (req, signal) => sink.approval(req, signal);
        const approval = this.ctx.approval;
        return approval ? (req) => approval(this.thread.id, req) : undefined;
      },
      (name, message) => this.sink?.notice("warn", `MCP server ${name} did not start: ${message}`)
    );
    const out: Record<string, SDKCustomTool> = {};
    for (const tool of await this.bridge.tools()) {
      this.bridgedLabels.set(tool.name, `${tool.server}: ${tool.tool}`);
      out[tool.name] = {
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, SDKJsonValue>,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        execute: async (args, context) => {
          // The stream reports the call under the same id when it already showed it; the approval then sits on that row.
          const toolCallId = context.toolCallId && this.tools.has(context.toolCallId) ? context.toolCallId : undefined;
          const result = await tool.call(args, { toolCallId });
          return { content: mcpContent(result.content), isError: result.isError };
        },
      };
    }
    return out;
  }

  /** Board workers (threads only a page has written to) keep Cursor's own shell; the host says which these are. */
  /** A fetch through web_fetch: the allowlist (limited) and the thread's grants, else the user is asked. */
  private async gateFetch(url: string): Promise<{ allowed: boolean; message?: string }> {
    const call = { kind: "fetch" as const, url };
    if (this.webCovered(call)) return { allowed: true };
    return this.askWeb(call);
  }

  private webCovered(call: WebCall): boolean {
    const allowlist = this.thread.web === "limited" ? this.ctx.webAllowlist() : [];
    return webCallAllowed(call, this.thread.web, allowlist, this.thread.webGrants);
  }

  private async askWeb(call: WebCall): Promise<{ allowed: boolean; message?: string }> {
    if (!this.ctx.webRequest) return { allowed: false, message: "web access is off for this thread." };
    return this.ctx.webRequest(this.thread.id, call);
  }

  private hostShell(): boolean {
    return wantsHostShell(this.thread, this.ctx.cursorHostShell?.(this.thread.id) ?? false);
  }

  private async options(): Promise<AgentOptions> {
    const t = this.thread;
    const models = this.provider.cachedModels().length ? this.provider.cachedModels() : await this.provider.models();
    this.board ??= new BoardTools(this.ctx.boardMcp, t.id, !noPages(t.scope), scribeToolsOff(t));
    // Scribe runs these itself, so its hooks can hold them (the board tools ask from their own process, see mcp.ts).
    const own: Record<string, SDKCustomTool> = await this.userTools();
    const searchUrl = t.web !== "on" ? (this.ctx.webSearchUrl?.() ?? "") : "";
    if (t.web !== "on") own.web_fetch = gatedFetch((url) => this.gateFetch(url), Boolean(searchUrl));
    if (searchUrl) {
      own.web_search = gatedSearch(searchUrl, t.web, {
        allowed: (call) => this.webCovered(call),
        reach: () => [...(t.web === "limited" ? this.ctx.webAllowlist() : []), ...(this.thread.webGrants?.domains ?? [])],
        ask: (call) => this.askWeb(call),
      });
    }
    const hostShell = this.hostShell();
    if (hostShell) own[HOST_SHELL] = this.hostShellTool();
    const customTools: Record<string, SDKCustomTool> = { ...(await this.board.tools()) };
    for (const [name, tool] of Object.entries(own)) customTools[name] = this.hooked(name, tool);
    return {
      model: modelSelection(t, models),
      ...toolLists(t, hostShell),
      mode: t.mode === "plan" ? "plan" : "agent",
      local: {
        cwd: this.cwd(),
        store: await store(),
        // Pages: nothing from Cursor's own config, so a user MCP server can't bring file tools in.
        settingSources: t.mode === "board" ? [] : ["user", "project"],
        autoReview: cursorAutoReview(t),
        customTools,
        // Subagents get the same tool restrictions as the thread, and with the host shell no shell of their own.
        subagentInherit: hostShell ? { resourceProviderOptions: { suppressDefaultShellExecutor: true } } : {},
      },
    };
  }

  private async ensureAgent(): Promise<SDKAgent> {
    const key = this.key();
    if (this.agent && this.agentKey === key) return this.agent;
    if (this.opening) return this.opening;
    this.opening = this.open(key).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async open(key: string): Promise<SDKAgent> {
    this.closeAgent();
    if (this.board && (this.board.threadId !== this.thread.id || this.board.pages === noPages(this.thread.scope) || JSON.stringify(this.board.toolsOff) !== JSON.stringify(scribeToolsOff(this.thread)))) {
      this.board.close();
      this.board = null;
    }
    const { Agent } = await sdk();
    const options = await this.options();
    let agent: SDKAgent | null = null;
    if (this.agentId) {
      try {
        agent = await Agent.resume(this.agentId, options);
        this.resumed = true;
        this.lastInstructions = "";
      } catch (err) {
        log(`Cursor agent resume failed, starting a new agent: ${errorText(err)}`);
        this.sink?.notice("warn", "Could not resume the Cursor agent; this turn starts a new one without the earlier conversation.");
        this.agentId = null;
      }
    }
    if (!agent) {
      agent = await Agent.create(options).catch((err) => {
        throw new Error(errorText(err));
      });
      this.agentId = agent.agentId;
      this.resumed = false;
      this.lastInstructions = "";
    }
    this.agent = agent;
    this.agentKey = key;
    return agent;
  }

  private closeAgent(): void {
    this.agent?.close();
    this.agent = null;
    this.agentKey = null;
  }

  async warm(_instructions: string): Promise<void> {
    if (this.sink) return;
    this.warming ??= this.ensureAgent()
      .then(() => undefined)
      .catch((err) => log(`Cursor warm-up failed: ${errorText(err)}`))
      .finally(() => {
        this.warming = null;
      });
    this.armIdle();
    return this.warming;
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stopAgent(), IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  /** Inject a message into the running turn (run.steer). Without a run yet, or with images, it waits for the next turn. */
  steer(input: SteerInput): string {
    const id = randomUUID();
    this.steers.set(id, { text: input.text, state: "queued" });
    if (!input.images.length && !input.documents.length) this.sendSteer(id);
    return id;
  }

  private sendSteer(id: string): void {
    const steer = this.steers.get(id);
    const run = this.current;
    if (!steer || steer.state !== "queued" || !run?.steer || !run.supports("stream")) return;
    steer.state = "sending";
    steer.settled = run
      .steer(steer.text)
      .then((outcome) => {
        if (steer.state === "dropped") return;
        if (outcome === "complete_delivered") {
          steer.state = "delivered";
          this.steers.delete(id);
          this.sink?.steered?.(id);
        } else {
          steer.state = "queued";
        }
      })
      .catch((err) => {
        log(`Cursor steer failed: ${(err as Error).message}`);
        if (steer.state === "sending") steer.state = "queued";
      });
  }

  dropSteer(steerId: string): void {
    const steer = this.steers.get(steerId);
    if (steer && steer.state !== "delivered") steer.state = "dropped";
  }

  async withdrawSteer(steerId: string): Promise<boolean> {
    const steer = this.steers.get(steerId);
    if (!steer || steer.state !== "queued") return false;
    this.steers.delete(steerId);
    return true;
  }

  async run(input: TurnInput, sink: RunSink, opts?: { adopt?: string }): Promise<TurnResult> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.sink = sink;
    this.cancelled = false;
    this.tools.clear();
    this.shellCalls.clear();
    this.plan = null;
    if (this.lastUsage) sink.usage(this.lastUsage);
    try {
      if (this.warming) await this.warming;
      if (opts?.adopt) {
        if (this.carry !== opts.adopt) return { status: "error", error: "The steered message was lost." };
        this.carry = null;
      }
      const agent = await this.ensureAgent();
      sink.nativeId(agent.agentId);
      this.reported = agent.agentId;
      if (this.cancelled) return this.endTurn({ status: "cancelled" });
      const sendInstructions = Boolean(input.instructions && input.instructions !== this.lastInstructions);
      const text = sendInstructions ? `<instructions>\n${input.instructions}\n</instructions>\n\n${input.text}` : input.text;
      const models = this.provider.cachedModels();
      const run = await agent.send(
        { text, images: input.images.map((image) => ({ data: image.data, mimeType: image.mimeType })) },
        {
          model: modelSelection(this.thread, models),
          mode: this.thread.mode === "plan" ? "plan" : "agent",
          onDelta: ({ update }) => this.onDelta(update, sink),
          ...(this.resumed ? { local: { force: true } } : {}),
        }
      );
      this.resumed = false;
      this.current = run;
      this.lastInstructions = input.instructions;
      for (const id of this.steers.keys()) this.sendSteer(id);
      if (this.cancelled) await run.cancel().catch(() => undefined);
      const result = await run.wait();
      if (result.usage) this.takeUsage(result.usage, sink);
      await this.addCost(agent, sink);
      if (result.status === "cancelled" || this.cancelled) return this.endTurn({ status: "cancelled" });
      if (result.status === "error") return this.endTurn({ status: "error", error: result.error?.message || "Cursor run failed" });
      if (this.plan && this.thread.mode === "plan") {
        // The host continues in Code mode when the user accepts.
        await sink.plan({ title: "Plan", text: this.plan }).catch(() => undefined);
      }
      return this.endTurn({ status: "done" });
    } catch (err) {
      if (this.cancelled) return this.endTurn({ status: "cancelled" });
      return this.endTurn({ status: "error", error: errorText(err) });
    } finally {
      this.current = null;
      this.sink = null;
      this.armIdle();
    }
  }

  /** The agent's billed cost so far is known only after the turn; take the newest turn's. */
  private async addCost(agent: SDKAgent, sink: RunSink): Promise<void> {
    try {
      const usage = await Promise.race([agent.getUsage(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 4_000))]);
      const cost = usage?.runs.at(-1)?.cost;
      if (cost) sink.usage({ costUsd: cost.rawCostCents / 100, reportedCostUsd: cost.rawCostCents / 100 });
    } catch (err) {
      log(`Cursor getUsage failed: ${(err as Error).message}`);
    }
  }

  /** A steered message the turn did not take in runs as its own turn next; the host adopts it. */
  private async endTurn(result: TurnResult): Promise<TurnResult> {
    const settling = [...this.steers.values()].map((s) => s.settled).filter(Boolean);
    if (settling.length) await Promise.race([Promise.all(settling), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    for (const [id, steer] of this.steers) {
      if (steer.state === "dropped" || steer.state === "delivered") this.steers.delete(id);
    }
    const waiting = [...this.steers].find(([, steer]) => steer.state === "queued")?.[0];
    if (waiting) {
      this.steers.delete(waiting);
      this.carry = waiting;
      return { ...result, next: waiting };
    }
    return result;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    for (const run of this.shellRuns) run.abort();
    await this.current?.cancel().catch(() => undefined);
  }

  private stopAgent(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.current) return;
    this.closeAgent();
    this.board?.close();
    this.board = null;
    this.bridge?.close();
    this.bridge = null;
  }

  dispose(): void {
    void this.cancel();
    this.steers.clear();
    this.carry = null;
    this.current = null;
    this.stopAgent();
    this.onDispose();
  }

  private takeUsage(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens?: number }, sink: RunSink): void {
    this.lastUsage = {
      ...(this.lastUsage ?? {}),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    };
    sink.usage(this.lastUsage);
  }

  private onDelta(update: InteractionUpdate, sink: RunSink): void {
    if (this.sink !== sink) return;
    switch (update.type) {
      case "text-delta":
        sink.text(update.text);
        return;
      case "thinking-delta":
        sink.reasoning(update.text);
        return;
      case "thinking-completed":
        sink.breakBlock();
        return;
      case "tool-call-started":
      case "partial-tool-call":
        this.onTool(update.callId, update.toolCall, false, sink);
        return;
      case "tool-call-completed":
        this.onTool(update.callId, update.toolCall, true, sink);
        return;
      case "summary":
        sink.notice("info", "Cursor summarized the conversation to make room.");
        return;
      default:
        return;
    }
  }

  private onTool(callId: string, raw: unknown, finished: boolean, sink: RunSink): void {
    const call = isPlainRecord(raw) ? raw : {};
    const type = typeof call.type === "string" ? call.type : "tool";
    const args = isPlainRecord(call.args) ? call.args : {};
    if (type === "createPlan") {
      if (finished && typeof args.plan === "string") this.plan = args.plan;
      return;
    }
    if (type === "updateTodos" && Array.isArray(args.todos)) {
      sink.todos(
        args.todos.filter(isPlainRecord).map((todo) => ({
          content: String(todo.content ?? ""),
          status: todo.status === "completed" ? "completed" : todo.status === "inProgress" ? "in_progress" : "pending",
        }))
      );
      if (!this.tools.has(callId)) this.tools.set(callId, type);
      return;
    }
    const filePath = str(args.path);
    const paths = filePath ? [filePath] : undefined;
    const mcpServer = str(args.providerIdentifier);
    const isBoard = type === "mcp" && mcpServer === BOARD_MCP;
    if (isBoard && args.toolName === HOST_SHELL) return this.onHostShell(callId, isPlainRecord(args.args) ? args.args : {}, finished, call.result, sink);
    const title = this.toolTitle(type, args, mcpServer, isBoard);
    const detail = type === "shell" ? str(args.command) : undefined;
    const input = type === "mcp" ? (isPlainRecord(args.args) ? args.args : undefined) : Object.keys(args).length ? args : undefined;
    if (!this.tools.has(callId)) {
      this.tools.set(callId, type);
      sink.toolStart({ toolId: callId, name: type, tool: toolKind(type), title, detail, input, paths, status: "running", ...(isBoard ? { held: true } : {}) });
    }
    if (!finished) {
      sink.toolUpdate(callId, { title, ...(detail ? { detail } : {}), ...(input ? { input } : {}), ...(paths ? { paths } : {}) });
      return;
    }
    const result = isPlainRecord(call.result) ? call.result : null;
    const ok = result?.status === "success";
    const value = result && isPlainRecord(result.value) ? result.value : null;
    const out = this.toolOutput(type, value, result);
    sink.toolUpdate(callId, {
      title,
      ...(paths ? { paths } : {}),
      status: ok ? "done" : "error",
      ...out,
    });
  }

  /** The host shell shows as a shell call, not as a board tool. */
  private onHostShell(callId: string, input: Record<string, unknown>, finished: boolean, rawResult: unknown, sink: RunSink): void {
    const command = str(input.command) ?? "";
    let call = this.shellCalls.get(callId);
    if (!call) {
      call = { command, taken: false };
      this.shellCalls.set(callId, call);
    } else if (command) {
      call.command = command;
    }
    if (!this.tools.has(callId)) {
      this.tools.set(callId, "shell");
      sink.toolStart({ toolId: callId, name: "shell", tool: "execute", title: "Shell", ...(command ? { detail: command } : {}), status: "running", held: true });
    } else if (command) {
      sink.toolUpdate(callId, { detail: command });
    }
    if (!finished) return;
    const result = isPlainRecord(rawResult) ? rawResult : null;
    const value = result && isPlainRecord(result.value) ? result.value : null;
    const ok = result?.status === "success" && value?.isError !== true && (call.exitCode === undefined || call.exitCode === 0);
    sink.toolUpdate(callId, { status: ok ? "done" : "error", ...this.toolOutput("mcp", value, result), ...(typeof call.exitCode === "number" ? { exitCode: call.exitCode } : {}) });
  }

  /** The stream's call id for a host shell run: the SDK's id when the stream has it, else the oldest unmatched call with this command. */
  private shellCallId(id: string | undefined, command: string): string | undefined {
    const known = id ? this.shellCalls.get(id) : undefined;
    if (id && known) {
      known.taken = true;
      return id;
    }
    for (const [callId, call] of this.shellCalls) {
      if (!call.taken && call.command === command) {
        call.taken = true;
        return callId;
      }
    }
    return id;
  }

  /** A custom tool that asks Scribe's hooks first (SessionContext.toolGate): they may deny the call or have the user approve it. */
  private hooked(name: string, tool: SDKCustomTool): SDKCustomTool {
    return {
      ...tool,
      execute: async (args, context) => {
        const gate = this.ctx.toolGate;
        if (gate) {
          const shell = name === HOST_SHELL;
          const command = shell && typeof args.command === "string" ? args.command.trim() : "";
          // The id the stream shows the call under, so a hook's flag and approval sit on that row.
          const toolId = context.toolCallId && this.tools.has(context.toolCallId) ? context.toolCallId : undefined;
          const held = await gate(this.thread.id, {
            ...(toolId ? { toolId } : {}),
            name,
            tool: shell ? "execute" : name === "web_fetch" || name === "web_search" ? "fetch" : "mcp",
            title: shell ? "Run command" : this.bridgedLabels.get(name) ?? name,
            ...(command ? { detail: command } : {}),
            input: args,
          }).catch(() => null);
          if (held && !held.allowed) return { content: [{ type: "text", text: held.reason }], isError: true };
        }
        const result = await tool.execute(args, context);
        // Scribe's page tools scan their own results where they run (mcp.ts); the web tools run here.
        if ((name !== "web_fetch" && name !== "web_search") || !this.ctx.scanResult) return result;
        if (!isPlainRecord(result) || !Array.isArray(result.content) || result.isError === true) return result;
        const content = result.content as Array<{ type: string; text?: string }>;
        const toolId = context.toolCallId && this.tools.has(context.toolCallId) ? context.toolCallId : undefined;
        const text = content.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : "")).join("\n");
        const note = await this.ctx.scanResult(this.thread.id, { ...(toolId ? { toolId } : {}), name, tool: "fetch", text }).catch(() => null);
        return note ? ({ ...result, content: [{ type: "text", text: note }, ...content] } as typeof result) : result;
      },
    };
  }

  private hostShellTool(): SDKCustomTool {
    return {
      description:
        "Run a command line in the workspace's shell (PowerShell on Windows, sh elsewhere) and return its combined output and exit code. Cursor's built-in shell is off in this thread: use this for every terminal command. The user may be asked to approve each command first and can deny it with a note; follow the note.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command line to run." },
          working_directory: { type: "string", description: "Folder to run it in, absolute or relative to the workspace. Defaults to the workspace." },
          timeout_ms: { type: "number", description: "Stop it after this many milliseconds (default 120000, at most 600000)." },
        },
        required: ["command"],
      },
      annotations: { title: "Shell", destructiveHint: true, openWorldHint: true },
      execute: (args, context) => this.runHostShell(args, context.toolCallId),
    };
  }

  private async runHostShell(args: Record<string, SDKJsonValue>, sdkCallId: string | undefined): Promise<SDKCustomToolResult> {
    const fail = (text: string): SDKCustomToolResult => ({ content: [{ type: "text", text }], isError: true });
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return fail("No command given.");
    const dir = typeof args.working_directory === "string" ? args.working_directory.trim() : "";
    const cwd = dir ? path.resolve(this.cwd(), dir) : this.cwd();
    const sink = this.sink;
    // Between turns (a background subagent) the host answers from the thread's rules alone.
    const ask: RunSink["approval"] | undefined = sink ? (req, signal) => sink.approval(req, signal) : this.ctx.approval ? (req) => this.ctx.approval!(this.thread.id, req) : undefined;
    if (!ask) return fail("No active turn: nobody is there to approve this command.");
    const toolId = this.shellCallId(sdkCallId, command);
    const abort = new AbortController();
    this.shellRuns.add(abort);
    try {
      const decision = await ask(
        {
          ...(toolId ? { toolId } : {}),
          tool: "execute",
          title: "Run command",
          detail: dir ? `${command}\nin ${cwd}` : command,
          options: [
            { id: "allow", label: "Allow", kind: "allow_once" },
            { id: "deny", label: "Deny", kind: "reject_once" },
          ],
        },
        abort.signal
      );
      if (decision.optionId !== "allow") return fail(decision.note ? `The user denied this command: ${decision.note}` : "The user denied this command.");
      const result = await runCommand({ command, cwd, timeoutMs: clampTimeout(args.timeout_ms), signal: abort.signal });
      const call = toolId ? this.shellCalls.get(toolId) : undefined;
      if (call) call.exitCode = result.exitCode;
      const status = result.cancelled ? "Cancelled by the user." : result.timedOut ? "Timed out and stopped." : `Exit code: ${result.exitCode ?? "none"}`;
      return { content: [{ type: "text", text: `${result.output || "(no output)"}\n\n${status}` }], isError: result.exitCode !== 0 };
    } catch (err) {
      return fail(abort.signal.aborted ? "Cancelled by the user." : `Could not run the command: ${(err as Error).message}`);
    } finally {
      this.shellRuns.delete(abort);
    }
  }

  private toolTitle(type: string, args: Record<string, unknown>, mcpServer: string | undefined, isBoard: boolean): string {
    const rel = (p: unknown) => (typeof p === "string" ? this.shortenPaths(p) : "");
    switch (type) {
      case "shell":
        return "Shell";
      case "read":
        return `Read ${rel(args.path)}`;
      case "edit":
        return `Edit ${rel(args.path)}`;
      case "write":
        return `Write ${rel(args.path)}`;
      case "delete":
        return `Delete ${rel(args.path)}`;
      case "ls":
        return `List ${rel(args.path) || "."}`;
      case "grep":
        return `Grep ${str(args.pattern) ?? ""}`.trim();
      case "glob":
        return `Glob ${str(args.globPattern) ?? ""}`.trim();
      case "semSearch":
        return `Search ${str(args.query) ?? ""}`.trim();
      case "readLints":
        return "Read lints";
      case "task":
        return `Subagent: ${str(args.description) ?? "task"}`;
      case "mcp": {
        const tool = str(args.toolName) ?? "tool";
        return isBoard ? this.bridgedLabels.get(tool) ?? `Scribe: ${tool}` : `${mcpServer ?? "MCP"}: ${tool}`;
      }
      case "webSearch":
        return `Web search: ${str(args.query) ?? str(args.searchTerm) ?? ""}`.trim();
      case "webFetch":
      case "fetch":
        return `Fetch ${str(args.url) ?? ""}`.trim();
      default:
        return type;
    }
  }

  private toolOutput(type: string, value: Record<string, unknown> | null, result: Record<string, unknown> | null): { output?: string; exitCode?: number } {
    if (!result) return {};
    if (result.status !== "success") {
      const error = result.error;
      const message = isPlainRecord(error) && typeof error.message === "string" ? error.message : typeof error === "string" ? error : JSON.stringify(result);
      return { output: message };
    }
    if (!value) return {};
    if (type === "shell") {
      const stdout = typeof value.stdout === "string" ? value.stdout : "";
      const stderr = typeof value.stderr === "string" ? value.stderr : "";
      return { output: [stdout, stderr].filter(Boolean).join("\n"), ...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}) };
    }
    if (type === "mcp" && Array.isArray(value.content)) {
      const texts = value.content.filter(isPlainRecord).map((block) => (isPlainRecord(block.text) && typeof block.text.text === "string" ? block.text.text : block.image ? "[image]" : ""));
      return { output: texts.filter(Boolean).join("\n") };
    }
    // Reads, edits and writes: the file and the host's diff say it better than the tool's echo.
    if (type === "read" || type === "edit" || type === "write" || type === "delete") return {};
    try {
      return { output: JSON.stringify(value, null, 2) };
    } catch {
      return {};
    }
  }

  /** Tool titles carry absolute paths; show them relative to the workspace. */
  private shortenPaths(text: string): string {
    const root = this.cwd().replaceAll("\\", "/").replace(/\/$/, "");
    if (!root) return text;
    let out = text;
    for (const prefix of [root + "/", root.replaceAll("/", "\\") + "\\"]) {
      let at = out.toLowerCase().indexOf(prefix.toLowerCase());
      while (at >= 0) {
        out = out.slice(0, at) + out.slice(at + prefix.length);
        at = out.toLowerCase().indexOf(prefix.toLowerCase());
      }
    }
    return out;
  }
}
