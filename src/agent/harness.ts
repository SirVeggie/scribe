import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { dataDir } from "../config.js";
import type { ResolvedMcpServer } from "./mcpConfig.js";
import { mcpCall, toolUses, type ThreadStats, type ToolUse } from "./threadStats.js";
import type { Item, ProviderId, Thread, ThreadMode, Turn, TurnLatency, Usage } from "./types.js";
import { summarize, type LatencySummary } from "./latency.js";
import { threadToken } from "../callers.js";

export { mcpCall };

/**
 * The agent harness view (#456): what Scribe gives each chat at its start (instructions, tools, skills,
 * MCP servers) and what the stored threads say about how it is used. Everything here is read-only;
 * harnessFiles.ts holds what the view changes.
 */

/** Rough token count for text Scribe cannot count with a provider's tokenizer: four characters a token. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

// Approximate provider prompt and built-in tools, excluding Scribe's instructions and MCP tools.
// These are deliberately estimates; a provider's context reading replaces them when available.
const PROVIDER_SEED: Record<ProviderId, number> = { claude: 15000, codex: 15000, cursor: 15000, pi: 2000 };

export function seedTokens(provider: ProviderId, instructions: number, tools: Pick<ToolList, "tokens" | "instructionsChars">, files: Array<{ tokens: number }>): number {
  return PROVIDER_SEED[provider] + instructions + tools.tokens + estimateTokens(tools.instructionsChars) + files.reduce((sum, file) => sum + file.tokens, 0);
}

/** Tool schemas are JSON, which tokenizes denser than prose: Claude Code counts Scribe's own at about three characters a token. */
function schemaTokens(chars: number): number {
  return Math.ceil(chars / 3);
}

// ---------- seed context ----------

export type InstructionSection = { label: string; chars: number; tokens: number; text: string };

/** Lines of threadInstructions that carry on the section before them rather than starting one. */
const CONTINUES = /^(To say why|This is a git worktree|node_modules here|Shell commands already|Save one with|<memories>|<\/memories>|- \[|<folder_instructions|<\/folder_instructions>)/;
const LABELED = /^([A-Z][A-Za-z]+(?: [a-z]+){0,2}):\s/;

/** threadInstructions' text by topic, so the view can show what each part costs. */
export function instructionSections(text: string): InstructionSection[] {
  const sections: Array<{ label: string; lines: string[] }> = [];
  let inFolder = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const last = sections.at(-1);
    let label: string | null = null;
    if (inFolder || CONTINUES.test(line)) label = null;
    else if (!sections.length) label = "Scribe";
    else if (line.startsWith("Folder instructions")) label = "Folder instructions";
    else if (line.startsWith("This thread belongs")) label = "Thread scope";
    else if (line.startsWith("Web access is")) label = "Web";
    else label = LABELED.exec(line)?.[1] ?? null;
    if (line.startsWith("<folder_instructions")) inFolder = true;
    else if (line.startsWith("</folder_instructions>")) inFolder = false;
    if (label && last?.label !== label) sections.push({ label, lines: [line] });
    else if (last) last.lines.push(line);
    else sections.push({ label: "Scribe", lines: [line] });
  }
  return sections.map(({ label, lines }) => {
    const body = lines.join("\n");
    return { label, chars: body.length, tokens: estimateTokens(body.length), text: body };
  });
}

// ---------- MCP tool lists ----------

export type ToolCost = { name: string; description: string; chars: number; tokens: number };
export type ToolList = { tools: ToolCost[]; chars: number; tokens: number; instructionsChars: number; error?: string };

const PROBE_TIMEOUT_MS = 20_000;

function toolCosts(tools: Array<{ name: string; description?: string; inputSchema?: unknown }>): ToolCost[] {
  return tools
    .map((tool) => {
      // What a model is sent for a tool: its name, description and parameter schema.
      const chars = tool.name.length + (tool.description?.length ?? 0) + JSON.stringify(tool.inputSchema ?? {}).length;
      return { name: tool.name, description: (tool.description ?? "").split("\n")[0].slice(0, 200), chars, tokens: schemaTokens(chars) };
    })
    .sort((a, b) => b.chars - a.chars);
}

async function listTools(connect: (client: Client) => Promise<void>): Promise<ToolList> {
  const client = new Client({ name: "scribe-harness", version: "1" });
  try {
    await connect(client);
    const { tools } = await client.listTools(undefined, { timeout: PROBE_TIMEOUT_MS });
    const costs = toolCosts(tools);
    const chars = costs.reduce((sum, tool) => sum + tool.chars, 0);
    return { tools: costs, chars, tokens: schemaTokens(chars), instructionsChars: client.getInstructions()?.length ?? 0 };
  } catch (err) {
    return { tools: [], chars: 0, tokens: 0, instructionsChars: 0, error: (err as Error).message || String(err) };
  } finally {
    void client.close().catch(() => undefined);
  }
}

const boardToolCache = new Map<string, Promise<ToolList>>();

/**
 * Scribe's own MCP tools as a thread of this provider gets them, by starting the server the way a
 * session does and asking it. Kept for the daemon's life: the list only changes with the build.
 */
export function boardTools(spec: { command: string; args: string[]; env: Record<string, string> }, provider: ProviderId, pages: boolean): Promise<ToolList> {
  const key = `${provider}:${pages}`;
  let list = boardToolCache.get(key);
  if (!list) {
    const env = { ...(process.env as Record<string, string>), ...spec.env, SCRIBE_THREAD: "th_harness_probe", SCRIBE_THREAD_TOKEN: threadToken("th_harness_probe"), SCRIBE_PROVIDER: provider, ...(pages ? {} : { SCRIBE_PAGES: "off" }) };
    list = listTools((client) => client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env, stderr: "ignore" }), { timeout: PROBE_TIMEOUT_MS }));
    boardToolCache.set(key, list);
    void list.then((result) => {
      if (result.error) boardToolCache.delete(key);
    });
  }
  return list;
}

/** One of the user's MCP servers, started (or reached) just to list its tools. */
export function probeServer(server: ResolvedMcpServer, cwd: string): Promise<ToolList> {
  return listTools((client) => {
    if (server.transport === "stdio") {
      return client.connect(
        new StdioClientTransport({ command: server.command!, args: server.args, env: { ...(process.env as Record<string, string>), ...server.env }, cwd: server.cwd ?? cwd, stderr: "ignore" }),
        { timeout: PROBE_TIMEOUT_MS }
      );
    }
    const url = new URL(server.url!);
    const requestInit = Object.keys(server.headers).length ? { headers: server.headers } : undefined;
    return client.connect(server.transport === "sse" ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit }), { timeout: PROBE_TIMEOUT_MS });
  });
}

// ---------- skills ----------

export type SkillInfo = {
  name: string;
  description: string;
  /** The SKILL.md file. */
  file: string;
  /** The folder of skills it was found in. */
  folder: string;
  /** "user" for a provider's own folder, "workspace" for one in the project. */
  scope: "user" | "workspace";
  /** Providers whose threads look in this folder. */
  providers: ProviderId[];
  /** Every chat pays for the name and description; the body only when the skill is used. */
  indexTokens: number;
  bodyTokens: number;
  /** Other files in the skill's folder. */
  files: number;
};

/** name and description from a SKILL.md's frontmatter; folded and quoted values are read plainly. */
export function skillFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^﻿/, ""));
  if (!match) return {};
  const out: Record<string, string> = {};
  let key = "";
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (field) {
      key = field[1];
      out[key] = /^[>|][+-]?$/.test(field[2]) ? "" : field[2].replace(/^(["'])(.*)\1$/, "$2");
    } else if (key && /^\s+\S/.test(line)) {
      out[key] = `${out[key]} ${line.trim()}`.trim();
    }
  }
  return { ...(out.name ? { name: out.name } : {}), ...(out.description ? { description: out.description } : {}) };
}

/** Where each provider's threads find skills. Codex and Native run with Scribe's own home folders. */
export function skillFolders(workspace: string | null, home = os.homedir(), data = dataDir()): Array<{ dir: string; scope: "user" | "workspace"; providers: ProviderId[] }> {
  const folders: Array<{ dir: string; scope: "user" | "workspace"; providers: ProviderId[] }> = [
    { dir: path.join(home, ".agents", "skills"), scope: "user", providers: ["cursor", "codex", "pi"] },
    { dir: path.join(home, ".claude", "skills"), scope: "user", providers: ["claude"] },
    { dir: path.join(home, ".cursor", "skills"), scope: "user", providers: ["cursor"] },
    { dir: path.join(data, "agent", "codex", "skills"), scope: "user", providers: ["codex"] },
    { dir: path.join(data, "agent", "pi", "agent", "skills"), scope: "user", providers: ["pi"] },
  ];
  if (workspace) {
    folders.push(
      { dir: path.join(workspace, ".claude", "skills"), scope: "workspace", providers: ["claude"] },
      { dir: path.join(workspace, ".cursor", "skills"), scope: "workspace", providers: ["cursor"] },
      { dir: path.join(workspace, ".agents", "skills"), scope: "workspace", providers: ["cursor", "codex", "pi"] },
      { dir: path.join(workspace, ".pi", "skills"), scope: "workspace", providers: ["pi"] }
    );
  }
  return folders;
}

function countFiles(dir: string, limit = 500): number {
  let count = 0;
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (count >= limit) return;
      if (entry.isDirectory()) walk(path.join(folder, entry.name));
      else count += 1;
    }
  };
  try {
    walk(dir);
  } catch {
    /* unreadable folder */
  }
  return count;
}

export function discoverSkills(workspace: string | null, home = os.homedir(), data = dataDir()): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const folder of skillFolders(workspace, home, data)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = path.join(folder.dir, entry.name);
      const file = path.join(dir, "SKILL.md");
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const meta = skillFrontmatter(text);
      const name = meta.name ?? entry.name;
      const description = meta.description ?? "";
      out.push({
        name,
        description,
        file,
        folder: folder.dir,
        scope: folder.scope,
        providers: folder.providers,
        indexTokens: estimateTokens(name.length + description.length),
        bodyTokens: estimateTokens(text.length),
        files: Math.max(0, countFiles(dir) - 1),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
}

// ---------- statistics ----------

/**
 * Everything a turn sent to the model. Claude and Native report cached input apart from the rest;
 * Codex and Cursor count it inside inputTokens.
 */
export function promptTokens(provider: ProviderId, usage: Usage | undefined): number {
  if (!usage) return 0;
  const input = usage.inputTokens ?? 0;
  return provider === "claude" || provider === "pi" ? input + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : input;
}

type CostTotals = { costUsd: number; estimatedCostUsd?: number; reportedCostUsd?: number; pricedTurns?: number; unpricedTurns?: number; costPartial?: boolean };
export type TokenTotals = CostTotals & { turns: number; prompt: number; cached: number; output: number; reasoning: number; modelCalls?: number; modelCallTurns?: number };
/** Medians and p90s over finished turns with timing (latency.ts), plus where their time went in total. */
export type LatencyStats = { first?: LatencySummary; total: LatencySummary; model: LatencySummary; modelMs: number; toolMs: number; waitMs: number };
export type ToolRow = { name: string; kind: string; calls: number; errors: number; outputTokens: number; ms: number };

export type HarnessStats = {
  /** Start of the window (epoch ms), or null for all time. */
  since: number | null;
  threads: number;
  totals: TokenTotals & { toolCalls: number; toolErrors: number };
  outcomes: { done: number; error: number; cancelled: number };
  providers: Array<TokenTotals & { provider: ProviderId; threads: number; toolCalls: number; toolErrors: number; errors: number; latency?: LatencyStats }>;
  models: Array<TokenTotals & { provider: ProviderId; model: string; toolCalls: number; latency?: LatencyStats }>;
  days: Array<CostTotals & { day: string; prompt: Partial<Record<ProviderId, number>>; output: Partial<Record<ProviderId, number>>; turns: number }>;
  toolKinds: ToolRow[];
  tools: Array<ToolRow & { provider: ProviderId }>;
  mcp: Array<{ server: string; tool: string; calls: number; errors: number; outputTokens: number; providers: ProviderId[] }>;
  skills: Array<{ name: string; calls: number }>;
  /** First response prompts, falling back to old first turns without tools when response counts are unknown. */
  baselines: Array<{ provider: ProviderId; mode: ThreadMode; samples: number; min: number; median: number }>;
  heavy: Array<TokenTotals & { id: string; title: string; provider: ProviderId; model: string; toolCalls: number }>;
};

const emptyTotals = (): TokenTotals => ({ turns: 0, prompt: 0, cached: 0, output: 0, reasoning: 0, costUsd: 0 });

function addCost(into: CostTotals, usage: Usage | undefined): void {
  if (usage?.costUsd === undefined) into.unpricedTurns = (into.unpricedTurns ?? 0) + 1;
  else into.pricedTurns = (into.pricedTurns ?? 0) + 1;
  if (usage?.costPartial) into.costPartial = true;
  if (!usage) return;
  into.costUsd += usage.costUsd ?? 0;
  for (const key of ["estimatedCostUsd", "reportedCostUsd"] as const) if (usage[key] !== undefined) into[key] = (into[key] ?? 0) + usage[key];
}

function addUsage(into: TokenTotals, provider: ProviderId, usage: Usage | undefined): void {
  into.turns += 1;
  addCost(into, usage);
  if (!usage) return;
  if (usage.modelCalls !== undefined) {
    into.modelCalls = (into.modelCalls ?? 0) + usage.modelCalls;
    into.modelCallTurns = (into.modelCallTurns ?? 0) + 1;
  }
  into.prompt += promptTokens(provider, usage);
  into.cached += usage.cacheReadTokens ?? 0;
  into.output += usage.outputTokens ?? 0;
  into.reasoning += usage.reasoningTokens ?? 0;
}

function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function bump<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let value = map.get(key);
  if (!value) {
    value = make();
    map.set(key, value);
  }
  return value;
}

type LatencySamples = { first: number[]; total: number[]; model: number[]; modelMs: number; toolMs: number; waitMs: number };

function addLatency(map: Map<string, LatencySamples>, key: string, latency: TurnLatency): void {
  const into = bump(map, key, (): LatencySamples => ({ first: [], total: [], model: [], modelMs: 0, toolMs: 0, waitMs: 0 }));
  if (latency.firstMs !== undefined) into.first.push(latency.firstMs);
  into.total.push(latency.totalMs);
  into.model.push(latency.modelMs);
  into.modelMs += latency.modelMs;
  into.toolMs += latency.toolMs;
  into.waitMs += latency.waitMs;
}

function latencyStats(samples: LatencySamples | undefined): { latency?: LatencyStats } {
  const total = samples && summarize(samples.total);
  const model = samples && summarize(samples.model);
  if (!samples || !total || !model) return {};
  const first = summarize(samples.first);
  return { latency: { ...(first ? { first } : {}), total, model, modelMs: samples.modelMs, toolMs: samples.toolMs, waitMs: samples.waitMs } };
}

const newTool = (name: string, kind: string): ToolRow => ({ name, kind, calls: 0, errors: 0, outputTokens: 0, ms: 0 });

/**
 * deleted: what was kept of the threads deleted with their workspace (threadStats.ts). They count in
 * every total; only the heaviest-threads list leaves them out, as there is nothing left to open.
 */
export function harnessStats(
  threads: Thread[],
  turnsOf: (id: string) => Turn[],
  itemsOf: (id: string) => Item[],
  since: number | null = null,
  deleted: ThreadStats[] = []
): HarnessStats {
  const totals = { ...emptyTotals(), toolCalls: 0, toolErrors: 0 };
  const outcomes = { done: 0, error: 0, cancelled: 0 };
  const providers = new Map<ProviderId, HarnessStats["providers"][number]>();
  const models = new Map<string, HarnessStats["models"][number]>();
  const days = new Map<string, HarnessStats["days"][number]>();
  const toolKinds = new Map<string, ToolRow>();
  const tools = new Map<string, ToolRow & { provider: ProviderId }>();
  const mcp = new Map<string, { server: string; tool: string; calls: number; errors: number; outputTokens: number; providers: Set<ProviderId> }>();
  const skills = new Map<string, number>();
  const baselines = new Map<string, { provider: ProviderId; mode: ThreadMode; values: number[] }>();
  const heavy: HarnessStats["heavy"] = [];
  const latencies = new Map<string, LatencySamples>();
  let counted = 0;

  type Source = {
    thread: { id: string; provider: ProviderId; model: string; title?: string };
    forked: boolean;
    turns: Array<Pick<Turn, "id" | "seq" | "status" | "model" | "mode" | "startedAt" | "usage" | "reverted">>;
    tools: () => ToolUse[];
  };
  const sources: Source[] = [
    ...threads.map((thread): Source => ({ thread, forked: Boolean(thread.fork), turns: turnsOf(thread.id), tools: () => toolUses(itemsOf(thread.id)) })),
    ...deleted.map((kept): Source => ({ thread: { id: kept.id, provider: kept.provider, model: kept.model }, forked: kept.forked, turns: kept.turns, tools: () => kept.tools })),
  ];

  for (const source of sources) {
    const { thread } = source;
    const provider = thread.provider;
    const turns = source.turns.filter((turn) => !turn.reverted && (since === null || turn.startedAt >= since));
    if (!turns.length) continue;
    counted += 1;
    const row = bump(providers, provider, () => ({ ...emptyTotals(), provider, threads: 0, toolCalls: 0, toolErrors: 0, errors: 0 }));
    row.threads += 1;
    const own = { ...emptyTotals(), toolCalls: 0 };
    const kept = new Set(turns.map((turn) => turn.id));
    const toolTurns = new Set<string>();

    for (const use of source.tools()) {
      if (!kept.has(use.turnId)) continue;
      toolTurns.add(use.turnId);
      const add = (into: { calls: number; errors: number; outputTokens: number; ms?: number }) => {
        into.calls += use.calls;
        into.errors += use.errors;
        into.outputTokens += use.outputTokens;
        if (into.ms !== undefined) into.ms += use.ms;
      };
      totals.toolCalls += use.calls;
      row.toolCalls += use.calls;
      own.toolCalls += use.calls;
      totals.toolErrors += use.errors;
      row.toolErrors += use.errors;
      const model = turns.find((turn) => turn.id === use.turnId)?.model ?? thread.model;
      bump(models, `${provider}\n${model}`, () => ({ ...emptyTotals(), provider, model, toolCalls: 0 })).toolCalls += use.calls;
      add(bump(toolKinds, use.tool, () => newTool(use.tool, use.tool)));
      add(bump(tools, `${provider}\n${use.name}`, () => ({ ...newTool(use.name, use.tool), provider })));
      if (use.mcp) {
        const call = use.mcp;
        const entry = bump(mcp, `${call.server}\n${call.tool}`, () => ({ ...call, calls: 0, errors: 0, outputTokens: 0, providers: new Set<ProviderId>() }));
        add(entry);
        entry.providers.add(provider);
      }
      if (use.skill) skills.set(use.skill, (skills.get(use.skill) ?? 0) + use.calls);
    }

    for (const turn of turns) {
      addUsage(totals, provider, turn.usage);
      addUsage(row, provider, turn.usage);
      addUsage(own, provider, turn.usage);
      addUsage(bump(models, `${provider}\n${turn.model}`, () => ({ ...emptyTotals(), provider, model: turn.model, toolCalls: 0 })), provider, turn.usage);
      if (turn.status === "done" || turn.status === "error" || turn.status === "cancelled") outcomes[turn.status] += 1;
      if (turn.status === "error") row.errors += 1;
      // Finished turns only: a failed or stopped one would skew the times, and its retry is a turn of its own.
      if (turn.status === "done" && turn.usage?.latency) {
        addLatency(latencies, provider, turn.usage.latency);
        addLatency(latencies, `${provider}\n${turn.model}`, turn.usage.latency);
      }
      const prompt = promptTokens(provider, turn.usage);
      const day = bump(days, dayKey(turn.startedAt), (): HarnessStats["days"][number] => ({ day: dayKey(turn.startedAt), prompt: {}, output: {}, turns: 0, costUsd: 0 }));
      day.turns += 1;
      addCost(day, turn.usage);
      day.prompt[provider] = (day.prompt[provider] ?? 0) + prompt;
      day.output[provider] = (day.output[provider] ?? 0) + (turn.usage?.outputTokens ?? 0);
      const firstPrompt = turn.usage?.firstPromptTokens ??
        (!toolTurns.has(turn.id) && (turn.usage?.modelCalls === undefined || turn.usage.modelCalls === 1) ? prompt : 0);
      if (turn.seq === 1 && turn.status === "done" && firstPrompt > 0 && !source.forked) {
        bump(baselines, `${provider}\n${turn.mode}`, () => ({ provider, mode: turn.mode, values: [] as number[] })).values.push(firstPrompt);
      }
    }
    if (thread.title !== undefined) {
      heavy.push({ ...own, id: thread.id, title: thread.title, provider, model: thread.model });
    }
  }

  const byCalls = <T extends { calls: number }>(rows: Iterable<T>) => [...rows].sort((a, b) => b.calls - a.calls);
  return {
    since,
    threads: counted,
    totals,
    outcomes,
    providers: [...providers.values()].map((p) => ({ ...p, ...latencyStats(latencies.get(p.provider)) })).sort((a, b) => b.prompt - a.prompt),
    models: [...models.values()].filter((m) => m.turns > 0).map((m) => ({ ...m, ...latencyStats(latencies.get(`${m.provider}\n${m.model}`)) })).sort((a, b) => b.prompt - a.prompt).slice(0, 20),
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    toolKinds: byCalls(toolKinds.values()),
    tools: byCalls(tools.values()).slice(0, 60),
    mcp: byCalls(mcp.values()).map((entry) => ({ ...entry, providers: [...entry.providers] })),
    skills: [...skills].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls),
    baselines: [...baselines.values()]
      .map(({ provider, mode, values }) => {
        const sorted = [...values].sort((a, b) => a - b);
        return { provider, mode, samples: sorted.length, min: sorted[0], median: sorted[sorted.length >> 1] };
      })
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.mode.localeCompare(b.mode)),
    heavy: heavy.sort((a, b) => b.prompt - a.prompt).slice(0, 12),
  };
}

// ---------- what a provider loads on its own ----------

export type OwnContext = {
  /** How Scribe's instructions reach the model. */
  delivery: string;
  /** How the user's MCP servers reach the model. */
  mcpDelivery: string;
  /** What the provider reads by itself, beside what Scribe sends. */
  loads: string[];
  /** Instruction files found for this workspace that the provider reads into every session. */
  files: Array<{ path: string; tokens: number }>;
};

function instructionFile(file: string): Array<{ path: string; tokens: number }> {
  try {
    return [{ path: file, tokens: estimateTokens(fs.statSync(file).size) }];
  } catch {
    return [];
  }
}

/** Not Scribe's doing, but part of every session: the provider's own prompt, settings and instruction files. */
export function ownContext(thread: Pick<Thread, "provider" | "mode" | "cwd">, opts: { claudeHooks: boolean }, home = os.homedir()): OwnContext {
  const pages = thread.mode === "board";
  // A Pages thread with a workspace runs there to read files (#718).
  const ws = thread.cwd ?? null;
  const agentsMd = ws ? instructionFile(path.join(ws, "AGENTS.md")) : [];
  switch (thread.provider) {
    case "claude":
      return {
        delivery: "Appended to Claude Code's own system prompt.",
        mcpDelivery: "Passed to Claude Code as MCP servers; its own MCP config is left out.",
        loads: [
          "Claude Code's system prompt and its built-in tools" + (pages ? (ws ? " (Pages mode: Read, Grep, Glob, web, Skill and TodoWrite)" : " (Pages mode: web, Skill and TodoWrite only)") : ""),
          pages && !ws ? "User settings only (~/.claude): CLAUDE.md, skills, permissions" : "User, project and local settings: CLAUDE.md files, skills, agents, permissions",
          opts.claudeHooks ? "Hooks from settings files and plugins" : "No hooks from settings files or plugins (off in Agent harness → Hooks)",
        ],
        files: [...instructionFile(path.join(home, ".claude", "CLAUDE.md")), ...(ws ? [...instructionFile(path.join(ws, "CLAUDE.md")), ...instructionFile(path.join(ws, "CLAUDE.local.md")), ...instructionFile(path.join(ws, ".claude", "CLAUDE.md"))] : [])],
      };
    case "cursor":
      return {
        delivery: "Sent as an <instructions> block ahead of the first message, and again when it changes.",
        mcpDelivery: "Scribe connects to each server and hands its tools on as custom tools, so it can ask before a call.",
        loads: [
          "Cursor's own system prompt and built-in tools",
          pages ? "No Cursor settings (Pages mode)" : "User and project settings: rules, skills, and the servers in ~/.cursor/mcp.json and .cursor/mcp.json",
        ],
        files: pages ? [] : [...agentsMd, ...(ws ? instructionFile(path.join(ws, ".cursorrules")) : [])],
      };
    case "codex":
      return {
        delivery: "Sent as Codex developer instructions.",
        mcpDelivery: "Scribe connects to each server and hands its tools on as custom tools, so it can ask before a call.",
        loads: ["Codex's own system prompt and built-in tools", "A Codex home folder of Scribe's own, not ~/.codex: your Codex config and skills there are not read", ...(ws ? ["AGENTS.md files of the workspace"] : [])],
        files: agentsMd,
      };
    case "pi":
      return {
        delivery: "Appended to the Native harness's system prompt.",
        mcpDelivery: "Scribe connects to each server and hands its tools on as custom tools, so it can ask before a call.",
        loads: ["The Native harness's system prompt and tools, all of them Scribe's", ...(ws ? ["AGENTS.md and skills of the workspace"] : [])],
        files: agentsMd,
      };
  }
}
