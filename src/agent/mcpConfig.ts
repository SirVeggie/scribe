import fs from "node:fs";
import { modeKeepsServer } from "./customModes.js";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { dataDir } from "../config.js";
import { workspaceKey } from "./prefs.js";
import type { Thread, ThreadMode } from "./types.js";
import { isPlainRecord } from "./types.js";

/**
 * Scribe's own MCP servers (data/agent/mcp.json): one list for Claude, Cursor and Native threads in
 * place of each provider's own config. The file has the usual { mcpServers: { name: config } } shape,
 * so it can be copied to or from another app's mcp.json, plus a layer per workspace:
 *
 *   { "mcpServers": { ... }, "workspaces": { "<folder>": { "mcpServers": { ... } } } }
 *
 * A workspace entry replaces the global server of the same name; { "enabled": false } alone turns a
 * global one off there. Scribe's own fields on a server: enabled, modes (which thread modes get it;
 * Code, Plan and Ask unless set), approve ("ask" each call, the default, or "auto") and tools (per-tool
 * "allow", which runs without asking, or "disable", which hides it from agents).
 * Code threads also inherit Keeper from Claude Code when Scribe has no Keeper entry, so the
 * user's Keeper skill can supervise test servers. An explicit Scribe entry takes precedence.
 */

export type McpApprove = "ask" | "auto";
/** One tool's own setting: allow runs it without asking, disable hides it from agents. Ask (the server's setting) when unset. */
export type McpToolPolicy = "allow" | "disable";

export type McpServer = {
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** http / sse */
  url?: string;
  headers?: Record<string, string>;
  type?: "stdio" | "http" | "sse";
  enabled?: boolean;
  modes?: ThreadMode[];
  approve?: McpApprove;
  tools?: Record<string, McpToolPolicy>;
  description?: string;
  timeout?: number;
};

export type McpLayer = { mcpServers: Record<string, McpServer> };
export type McpFile = McpLayer & { workspaces: Record<string, McpLayer & { path: string }> };

/** A server a thread gets, with Scribe's fields resolved and ${VAR} expanded. */
export type ResolvedMcpServer = {
  name: string;
  /** Where it came from: "global" or the workspace folder. */
  layer: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  approve: McpApprove;
  /** Per-tool settings; tools not listed follow approve. */
  tools?: Record<string, McpToolPolicy>;
  timeout?: number;
};

/** A tool's setting on a resolved server: "ask" when it has none of its own. */
export function toolPolicy(server: Pick<ResolvedMcpServer, "tools">, tool: string): McpToolPolicy | "ask" {
  return server.tools && Object.hasOwn(server.tools, tool) ? server.tools[tool] : "ask";
}

export const DEFAULT_MODES: ThreadMode[] = ["code"];
const MODES: ThreadMode[] = ["code", "board"];
/** The daemon's board server's name in Claude threads; a user server may not take it. */
const RESERVED = new Set(["agent-board", "scribe", "custom-user-tools"]);

export function mcpFilePath(): string {
  return path.join(dataDir(), "agent", "mcp.json");
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  return out;
}

/** One server entry from any app's mcp.json, keeping only fields Scribe knows. Null when it is not a server. */
export function cleanServer(value: unknown): McpServer | null {
  if (!isPlainRecord(value)) return null;
  const out: McpServer = {};
  if (typeof value.command === "string" && value.command.trim()) out.command = value.command;
  if (typeof value.url === "string" && value.url.trim()) out.url = value.url;
  // Claude's "streamable-http" and Pi's "streamableHttp" both mean http.
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  if (type === "sse") out.type = "sse";
  else if (type.includes("http")) out.type = "http";
  else if (type === "stdio") out.type = "stdio";
  const args = strings(value.args);
  if (args?.length) out.args = args;
  const env = stringMap(value.env);
  if (env && Object.keys(env).length) out.env = env;
  if (typeof value.cwd === "string" && value.cwd) out.cwd = value.cwd;
  const headers = stringMap(value.headers);
  if (headers && Object.keys(headers).length) out.headers = headers;
  if (typeof value.enabled === "boolean") out.enabled = value.enabled;
  // Cursor and Claude use "disabled".
  if (value.disabled === true) out.enabled = false;
  // An older "ask" entry: Ask threads are Board-rung threads now (#719).
  const modes = strings(value.modes)?.map((m) => (m === "ask" ? "board" : m)).filter((m): m is ThreadMode => MODES.includes(m as ThreadMode));
  if (modes) out.modes = [...new Set(modes)];
  if (value.approve === "auto" || value.approve === "ask") out.approve = value.approve;
  if (isPlainRecord(value.tools)) {
    const tools: Record<string, McpToolPolicy> = {};
    for (const [name, policy] of Object.entries(value.tools)) if (name && (policy === "allow" || policy === "disable")) tools[name] = policy;
    if (Object.keys(tools).length) out.tools = tools;
  }
  if (typeof value.description === "string" && value.description) out.description = value.description;
  if (typeof value.timeout === "number" && value.timeout > 0) out.timeout = value.timeout;
  // An override with only { enabled: false } is a server too: it turns a global one off in a workspace.
  if (!out.command && !out.url && out.enabled !== false) return null;
  return out;
}

export function cleanLayer(value: unknown): McpLayer {
  const servers = isPlainRecord(value) && isPlainRecord(value.mcpServers) ? value.mcpServers : {};
  const out: Record<string, McpServer> = {};
  for (const [name, entry] of Object.entries(servers)) {
    const clean = cleanServer(entry);
    if (clean && validName(name)) out[name] = clean;
  }
  return { mcpServers: out };
}

export function validName(name: string): boolean {
  return /^[A-Za-z0-9_.-]{1,48}$/.test(name) && !RESERVED.has(name.toLowerCase());
}

export function cleanFile(value: unknown): McpFile {
  const workspaces: McpFile["workspaces"] = {};
  const raw = isPlainRecord(value) && isPlainRecord(value.workspaces) ? value.workspaces : {};
  for (const [dir, layer] of Object.entries(raw)) {
    const shown = isPlainRecord(layer) && typeof layer.path === "string" && layer.path ? layer.path : dir;
    const clean = cleanLayer(layer);
    if (Object.keys(clean.mcpServers).length) workspaces[workspaceKey(shown)] = { path: shown, ...clean };
  }
  return { ...cleanLayer(value), workspaces };
}

let cache: { file: string; mtime: number; value: McpFile } | null = null;

/** The file as saved, read again when it changes on disk (hand edits apply from a thread's next session). */
export function readMcpFile(file = mcpFilePath()): McpFile & { error?: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { mcpServers: {}, workspaces: {} };
  }
  if (cache && cache.file === file && cache.mtime === stat.mtimeMs) return cache.value;
  try {
    const value = cleanFile(JSON.parse(fs.readFileSync(file, "utf8")));
    cache = { file, mtime: stat.mtimeMs, value };
    return value;
  } catch (err) {
    return { mcpServers: {}, workspaces: {}, error: (err as Error).message };
  }
}

export function writeMcpFile(value: McpFile, file = mcpFilePath()): McpFile {
  const clean = cleanFile(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + "\n");
  fs.renameSync(tmp, file);
  cache = null;
  return clean;
}

/** The workspace a thread belongs to: the folder the user picked, not its worktree. */
export function threadWorkspace(thread: Pick<Thread, "cwd" | "worktree">): string | null {
  const wt = thread.worktree && !thread.worktree.closed ? thread.worktree : null;
  return wt?.home ?? thread.cwd ?? null;
}

/** Workspace layers that cover dir (the folder itself or a parent of it), outermost first. */
function layersFor(file: McpFile, dir: string | null): Array<McpLayer & { path: string }> {
  if (!dir) return [];
  const key = workspaceKey(dir);
  return Object.entries(file.workspaces)
    .filter(([k]) => key === k || key.startsWith(`${k}/`))
    .sort(([a], [b]) => a.length - b.length)
    .map(([, layer]) => layer);
}

/** Global servers with every workspace layer that covers dir applied, enabled or not. */
export function mergedServers(file: McpFile, dir: string | null): Array<{ name: string; layer: string; server: McpServer }> {
  const out = new Map<string, { name: string; layer: string; server: McpServer }>();
  for (const [name, server] of Object.entries(file.mcpServers)) out.set(name, { name, layer: "global", server });
  for (const layer of layersFor(file, dir)) {
    for (const [name, server] of Object.entries(layer.mcpServers)) {
      const base = out.get(name);
      // { enabled: false } on its own turns the global server off here and keeps the rest of it.
      if (!server.command && !server.url) {
        if (base) out.set(name, { ...base, server: { ...base.server, enabled: false } });
        continue;
      }
      out.set(name, { name, layer: layer.path, server });
    }
  }
  return [...out.values()];
}

/**
 * Turn a server on or off as the harness view shows it for dir. A server from Everywhere is turned
 * off for dir alone when there is one; otherwise the change is made where the server is defined.
 */
export function setServerEnabled(file: McpFile, name: string, dir: string | null, on: boolean): McpFile {
  const entry = mergedServers(file, dir).find((row) => row.name === name);
  if (!entry) throw new Error(`MCP server not found: ${name}`);
  const next: McpFile = {
    mcpServers: { ...file.mcpServers },
    workspaces: Object.fromEntries(Object.entries(file.workspaces).map(([key, layer]) => [key, { ...layer, mcpServers: { ...layer.mcpServers } }])),
  };
  const own = entry.layer === "global" ? next.mcpServers : next.workspaces[workspaceKey(entry.layer)].mcpServers;
  if (on) {
    // Workspace entries that only switch it off.
    for (const layer of layersFor(next, dir)) {
      const override = layer.mcpServers[name];
      if (override && !override.command && !override.url) delete layer.mcpServers[name];
    }
    if (own[name]?.enabled === false) {
      const { enabled: _off, ...rest } = own[name];
      own[name] = rest;
    }
  } else if (dir && entry.layer === "global") {
    const key = workspaceKey(dir);
    next.workspaces[key] ??= { path: dir, mcpServers: {} };
    next.workspaces[key].mcpServers[name] = { enabled: false };
  } else {
    own[name] = { ...own[name], enabled: false };
  }
  return next;
}

export function serverModes(server: McpServer): ThreadMode[] {
  return server.modes ?? DEFAULT_MODES;
}

/** ${VAR} and ${env:VAR} from the daemon's environment, as Claude Code and Cursor expand them. */
export function expandEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return text.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "");
}

function expandMap(map: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map ?? {})) out[k] = expandEnv(v);
  return out;
}

export function resolveServer(name: string, layer: string, server: McpServer): ResolvedMcpServer | null {
  const transport = server.url ? (server.type === "sse" ? "sse" : "http") : server.command ? "stdio" : null;
  if (!transport) return null;
  return {
    name,
    layer,
    transport,
    ...(server.command ? { command: expandEnv(server.command) } : {}),
    args: (server.args ?? []).map((a) => expandEnv(a)),
    env: expandMap(server.env),
    ...(server.cwd ? { cwd: expandEnv(server.cwd) } : {}),
    ...(server.url ? { url: expandEnv(server.url) } : {}),
    headers: expandMap(server.headers),
    approve: server.approve ?? "ask",
    ...(server.tools ? { tools: { ...server.tools } } : {}),
    ...(server.timeout ? { timeout: server.timeout } : {}),
  };
}

/** The servers a thread gets: enabled, allowed in its mode (and kept by its custom mode), from the global list and its workspace's. */
export function serversForThread(thread: Pick<Thread, "cwd" | "worktree" | "mode" | "custom">, file: McpFile = readMcpFile(), home: string | null = os.homedir()): ResolvedMcpServer[] {
  const workspace = threadWorkspace(thread);
  const servers = mergedServers(file, workspace);
  const keeperConfigured = [file, ...layersFor(file, workspace)].some((layer) => Object.hasOwn(layer.mcpServers, "keeper"));
  if (thread.mode === "code" && !keeperConfigured && home) {
    const keeper = claudeKeeper(workspace, home);
    if (keeper) servers.push(keeper);
  }
  return servers
    .filter(({ name, server }) => server.enabled !== false && serverModes(server).includes(thread.mode) && modeKeepsServer(thread, name))
    .flatMap(({ name, layer, server }) => resolveServer(name, layer, server) ?? []);
}

/** A stable key for a server list, so a session restarts when the servers it was given change. */
export function serversKey(servers: ResolvedMcpServer[]): string {
  // Tool settings only when there are some, so keys made before they existed stay the same.
  return JSON.stringify(servers.map((s) => [s.name, s.transport, s.command, s.args, s.env, s.cwd, s.url, s.headers, s.approve, s.timeout,
    ...(s.tools && Object.keys(s.tools).length ? [s.tools] : [])]));
}

/** Claude Agent SDK shape. */
export function claudeServerConfig(s: ResolvedMcpServer): Record<string, unknown> {
  if (s.transport === "stdio") return { type: "stdio", command: s.command, args: s.args, env: s.env };
  return { type: s.transport, url: s.url, headers: s.headers };
}

/** Tool name for a bridged server's tool: "<server>__<tool>", within the 64 characters providers allow. */
export function bridgedToolName(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

// ---------- import from other apps ----------

export type McpImportSource = "claude" | "cursor" | "pi" | "codex";

export type McpImportCandidate = {
  source: McpImportSource;
  /** The file it was read from. */
  file: string;
  /** "global", or the workspace folder it applies to. */
  scope: string;
  name: string;
  server: McpServer;
  /** Scribe already has a server by this name in that layer. */
  exists: boolean;
  /** Exact Cursor file contents when offered, so cleanup refuses intervening edits. */
  revision?: string;
};

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Translate Codex's TOML tables without resolving secrets into the saved copy. */
function readCodexMcp(file: string): McpLayer {
  try {
    const config = parseToml(fs.readFileSync(file, "utf8"));
    const servers = isPlainRecord(config.mcp_servers) ? config.mcp_servers : {};
    const mcpServers: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(servers)) {
      if (!isPlainRecord(value)) continue;
      const server = { ...value };
      if (typeof value.bearer_token_env_var === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.bearer_token_env_var)) {
        server.headers = { ...stringMap(value.http_headers), Authorization: `Bearer \${${value.bearer_token_env_var}}` };
      } else if (isPlainRecord(value.http_headers)) {
        server.headers = value.http_headers;
      }
      mcpServers[name] = server;
    }
    return cleanLayer({ mcpServers });
  } catch {
    return { mcpServers: {} };
  }
}

/**
 * Servers in Claude Code (~/.claude.json, its per-project entries, a workspace's .mcp.json), Cursor
 * (~/.cursor/mcp.json, .cursor/mcp.json), Pi (~/.pi/agent/mcp.json, .pi/mcp.json) and Codex
 * (~/.codex/config.toml), for the user to
 * pick from. workspaces: folders to look in besides the per-project entries Claude keeps.
 */
export function importCandidates(workspaces: string[], current: McpFile = readMcpFile(), home = os.homedir()): McpImportCandidate[] {
  const out: McpImportCandidate[] = [];
  const add = (source: McpImportSource, file: string, scope: string, layer: unknown) => {
    for (const [name, server] of Object.entries(cleanLayer(layer).mcpServers)) {
      if (!server.command && !server.url) continue;
      const have = scope === "global" ? current.mcpServers : current.workspaces[workspaceKey(scope)]?.mcpServers ?? {};
      out.push({ source, file, scope, name, server, exists: name in have,
        ...(source === "cursor" ? { revision: cursorRevision(fs.readFileSync(file, "utf8")) } : {}) });
    }
  };
  const claudeFile = path.join(home, ".claude.json");
  const claude = readJson(claudeFile);
  add("claude", claudeFile, "global", claude);
  if (isPlainRecord(claude) && isPlainRecord(claude.projects)) {
    for (const [dir, project] of Object.entries(claude.projects)) {
      if (isPlainRecord(project) && isPlainRecord(project.mcpServers)) add("claude", claudeFile, path.normalize(dir), project);
    }
  }
  add("cursor", path.join(home, ".cursor", "mcp.json"), "global", readJson(path.join(home, ".cursor", "mcp.json")));
  add("pi", path.join(home, ".pi", "agent", "mcp.json"), "global", readJson(path.join(home, ".pi", "agent", "mcp.json")));
  const codexFile = path.join(home, ".codex", "config.toml");
  add("codex", codexFile, "global", readCodexMcp(codexFile));
  const seen = new Set<string>();
  for (const dir of workspaces) {
    const key = workspaceKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const [source, rel] of [
      ["claude", ".mcp.json"],
      ["cursor", path.join(".cursor", "mcp.json")],
      ["pi", path.join(".pi", "mcp.json")],
    ] as const) {
      const file = path.join(dir, rel);
      const json = readJson(file);
      if (json) add(source, file, dir, json);
    }
  }
  return out;
}

let claudeCache: { file: string; mtime: number; value: unknown } | null = null;

function readClaudeConfig(home: string): unknown {
  const file = path.join(home, ".claude.json");
  try {
    // Claude Code rewrites this file often and it grows large: parse it again only when it changed.
    const mtime = fs.statSync(file).mtimeMs;
    if (claudeCache?.file !== file || claudeCache.mtime !== mtime) claudeCache = { file, mtime, value: readJson(file) };
    return claudeCache.value;
  } catch {
    return null;
  }
}

/** Only Keeper is inherited; unrelated servers still require an import into Scribe's list. */
function claudeKeeper(workspace: string | null, home: string): { name: string; layer: string; server: McpServer } | null {
  const claude = readClaudeConfig(home);
  let server = cleanLayer(claude).mcpServers.keeper;
  let layer = path.join(home, ".claude.json");
  if (workspace) {
    const projects = isPlainRecord(claude) && isPlainRecord(claude.projects) ? claude.projects : {};
    const key = workspaceKey(workspace);
    for (const [dir, project] of Object.entries(projects)) {
      if (workspaceKey(dir) === key) server = cleanLayer(project).mcpServers.keeper ?? server;
    }
    const file = path.join(workspace, ".mcp.json");
    const shared = cleanLayer(readJson(file)).mcpServers.keeper;
    if (shared) { server = shared; layer = file; }
  }
  // Do not inherit automatic approval from another app's config.
  return server ? { name: "keeper", layer, server: { ...server, approve: "ask" } } : null;
}

/**
 * Names of the servers Claude Code itself would load in a workspace (~/.claude.json, its entry for the
 * folder, the folder's .mcp.json). Claude threads get Scribe's list in their place, so a skill written
 * for one of these finds its tools missing unless the user imported it (or it is Code-mode Keeper).
 */
export function claudeOwnServers(workspace: string | null, home = os.homedir()): string[] {
  const claude = readClaudeConfig(home);
  const names = new Set(Object.keys(cleanLayer(claude).mcpServers));
  if (workspace) {
    const key = workspaceKey(workspace);
    const projects = isPlainRecord(claude) && isPlainRecord(claude.projects) ? claude.projects : {};
    for (const [dir, project] of Object.entries(projects)) {
      if (workspaceKey(dir) === key) for (const name of Object.keys(cleanLayer(project).mcpServers)) names.add(name);
    }
    for (const name of Object.keys(cleanLayer(readJson(path.join(workspace, ".mcp.json"))).mcpServers)) names.add(name);
  }
  return [...names];
}

/** Add picked candidates to the file (a name already there is replaced). */
export function applyImport(file: McpFile, picked: Array<{ scope: string; name: string; server: unknown }>): McpFile {
  const next: McpFile = { mcpServers: { ...file.mcpServers }, workspaces: { ...file.workspaces } };
  for (const item of picked) {
    const server = cleanServer(item.server);
    if (!server || !validName(item.name)) continue;
    if (item.scope === "global") {
      next.mcpServers[item.name] = server;
    } else {
      const key = workspaceKey(item.scope);
      const layer = next.workspaces[key] ?? { path: item.scope, mcpServers: {} };
      next.workspaces[key] = { ...layer, mcpServers: { ...layer.mcpServers, [item.name]: server } };
    }
  }
  return next;
}

function cursorRevision(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Remove only confirmed, imported Cursor entries. Each file keeps an exact backup before editing. */
export function removeCursorImports(picked: McpImportCandidate[], current: McpFile, home = os.homedir()): Array<{ file: string; backup?: string; names?: string[]; error?: string }> {
  const groups = new Map<string, McpImportCandidate[]>();
  for (const item of picked) {
    const file = path.join(item.scope === "global" ? home : item.scope, ".cursor", "mcp.json");
    if (item.source !== "cursor" || path.resolve(item.file) !== path.resolve(file)) throw new Error("Not a Cursor MCP import file");
    groups.set(file, [...(groups.get(file) ?? []), item]);
  }
  return [...groups].map(([file, items]) => {
    let backup: string | undefined;
    try {
      const original = fs.readFileSync(file, "utf8");
      const json: unknown = JSON.parse(original);
      if (!isPlainRecord(json) || !isPlainRecord(json.mcpServers)) throw new Error("No mcpServers object");
      for (const item of items) {
        if (!item.revision || item.revision !== cursorRevision(original)) throw new Error("Cursor's file changed. Import again before removing its entries.");
        const saved = item.scope === "global" ? current.mcpServers : current.workspaces[workspaceKey(item.scope)]?.mcpServers;
        const imported = cleanServer(item.server);
        if (!validName(item.name) || !Object.hasOwn(json.mcpServers, item.name) || !imported ||
          JSON.stringify(cleanServer(json.mcpServers[item.name])) !== JSON.stringify(imported) ||
          JSON.stringify(saved?.[item.name]) !== JSON.stringify(imported)) {
          throw new Error(`Scribe's imported copy of ${item.name} no longer matches. Import again before removing it.`);
        }
      }
      const names = [...new Set(items.map((item) => item.name))];
      for (const name of names) delete json.mcpServers[name];
      backup = `${file}.scribe-backup-${randomUUID()}`;
      const mode = fs.statSync(file).mode;
      fs.writeFileSync(backup, original, { flag: "wx", mode });
      const tmp = `${backup}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + "\n", { flag: "wx", mode });
        if (fs.readFileSync(file, "utf8") !== original) throw new Error("Cursor's file changed during cleanup; it was left alone.");
        fs.renameSync(tmp, file);
      } finally {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      }
      return { file, backup, names };
    } catch (err) {
      return { file, ...(backup && fs.existsSync(backup) ? { backup } : {}), error: (err as Error).message };
    }
  });
}
