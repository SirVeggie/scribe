import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "../config.js";
import { skillFolders } from "./harness.js";
import { createSkill, editableKind, instructionFiles } from "./harnessFiles.js";
import { HOOK_ACTIONS, HOOK_EVENTS, normalizeRules, RULE_MATCHES, type HookRule } from "./hooks.js";
import { cleanServer, mergedServers, setServerEnabled, validName, type McpFile, type McpServer } from "./mcpConfig.js";
import { workspaceKey } from "./prefs.js";
import { isPlainRecord } from "./types.js";

/**
 * Agent-assisted setup of the Scribe harness (#79): harness_docs explains how Scribe sets up every
 * chat (MCP servers, hook rules, skills, instruction files) and what is set now; harness_change
 * changes it. Every change goes through a violet approval in the chat, once or for the thread.
 * Changes are checked in full before anything is written, so a bad op leaves everything as it was.
 */

export type HarnessRoots = { workspace: string | null; home?: string; data?: string };

export type HarnessOp =
  | { op: "mcp_set"; name: string; scope: "global" | "workspace"; server: Record<string, unknown>; replace?: boolean }
  | { op: "mcp_remove"; name: string; scope: "global" | "workspace" }
  | { op: "mcp_enable"; name: string; on: boolean }
  | { op: "hook_set"; rule: Record<string, unknown> }
  | { op: "hook_remove"; id: string }
  | { op: "skill_create"; folder: string; name: string; description: string; text?: string }
  | { op: "file_write"; path: string; text: string };

const MAX_OPS = 20;
const MAX_TEXT = 200_000;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The ops from harness_change's input. Throws a message the agent can act on. */
export function parseHarnessOps(input: unknown): HarnessOp[] {
  const raw = isPlainRecord(input) && Array.isArray(input.changes) ? input.changes : [];
  if (!raw.length) throw new Error("Send changes: a list of ops (mcp_set, mcp_remove, mcp_enable, hook_set, hook_remove, skill_create, file_write). harness_docs describes them.");
  if (raw.length > MAX_OPS) throw new Error(`At most ${MAX_OPS} changes at a time.`);
  return raw.map((c, i): HarnessOp => {
    if (!isPlainRecord(c)) throw new Error(`Change ${i + 1} is not an object.`);
    const where = `Change ${i + 1} (${String(c.op)})`;
    const scope = c.scope === "workspace" ? "workspace" : c.scope === undefined || c.scope === "global" ? "global" : null;
    switch (c.op) {
      case "mcp_set": {
        if (!scope) throw new Error(`${where}: scope is global or workspace.`);
        if (!isPlainRecord(c.server)) throw new Error(`${where}: server is the server's config object.`);
        return { op: "mcp_set", name: str(c.name), scope, server: c.server, ...(c.replace === true ? { replace: true } : {}) };
      }
      case "mcp_remove":
        if (!scope) throw new Error(`${where}: scope is global or workspace.`);
        return { op: "mcp_remove", name: str(c.name), scope };
      case "mcp_enable":
        if (typeof c.on !== "boolean") throw new Error(`${where}: on is true or false.`);
        return { op: "mcp_enable", name: str(c.name), on: c.on };
      case "hook_set":
        if (!isPlainRecord(c.rule)) throw new Error(`${where}: rule is the hook rule object.`);
        return { op: "hook_set", rule: c.rule };
      case "hook_remove":
        return { op: "hook_remove", id: str(c.id) };
      case "skill_create":
        return { op: "skill_create", folder: str(c.folder), name: str(c.name), description: str(c.description), ...(typeof c.text === "string" ? { text: c.text } : {}) };
      case "file_write":
        if (typeof c.text !== "string") throw new Error(`${where}: text is the file's whole new content.`);
        return { op: "file_write", path: str(c.path), text: c.text };
      default:
        throw new Error(`Change ${i + 1}: unknown op ${JSON.stringify(c.op)}.`);
    }
  });
}

/** Env and header values can be secrets: the chat shows that one is set, not what it is. */
function masked(map: Record<string, string> | undefined): string {
  return Object.keys(map ?? {}).map((k) => `${k}=•••`).join(", ");
}

export function serverSummary(server: McpServer): string {
  const parts: string[] = [];
  if (server.command) parts.push(`runs: ${[server.command, ...(server.args ?? [])].join(" ")}`);
  if (server.url) parts.push(`${server.type ?? "http"}: ${server.url}`);
  if (server.cwd) parts.push(`in ${server.cwd}`);
  if (server.env && Object.keys(server.env).length) parts.push(`env ${masked(server.env)}`);
  if (server.headers && Object.keys(server.headers).length) parts.push(`headers ${masked(server.headers)}`);
  if (server.enabled === false) parts.push("off");
  if (server.modes) parts.push(`modes ${server.modes.join(", ")}`);
  if (server.approve) parts.push(`approve ${server.approve}`);
  if (server.tools && Object.keys(server.tools).length) parts.push(`tools ${Object.entries(server.tools).map(([t, p]) => `${t}: ${p}`).join(", ")}`);
  if (server.description) parts.push(`"${server.description}"`);
  return parts.join("; ");
}

/** Merge a partial server into the one there: a null value takes a field (or one env/header key) away. */
function mergeServer(base: McpServer | undefined, patch: Record<string, unknown>, replace: boolean): unknown {
  if (replace || !base) return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if ((key === "env" || key === "headers" || key === "tools") && isPlainRecord(value)) {
      const map: Record<string, unknown> = { ...((out[key] as Record<string, unknown> | undefined) ?? {}) };
      for (const [k, v] of Object.entries(value)) {
        if (v === null) delete map[k];
        else map[k] = v;
      }
      out[key] = map;
    } else out[key] = value;
  }
  return out;
}

function copyFile(file: McpFile): McpFile {
  return {
    mcpServers: { ...file.mcpServers },
    workspaces: Object.fromEntries(Object.entries(file.workspaces).map(([key, layer]) => [key, { ...layer, mcpServers: { ...layer.mcpServers } }])),
  };
}

export type HarnessPlan = {
  /** The MCP file to save, when an op changed it. */
  mcp?: McpFile;
  /** The hook rules to save, when an op changed them. */
  hookRules?: HookRule[];
  /** Files to write, in order. */
  files: Array<{ path: string; text: string }>;
  skills: Array<{ folder: string; name: string; description: string; text?: string }>;
  /** One line per op for the approval prompt and the result. */
  lines: string[];
};

/** Every op checked and applied to copies; nothing is written. Throws on the first op that cannot work. */
export function planHarnessChange(ops: HarnessOp[], current: { mcp: McpFile; hookRules: HookRule[] }, roots: HarnessRoots): HarnessPlan {
  let mcp: McpFile | undefined;
  let rules: HookRule[] | undefined;
  const files: HarnessPlan["files"] = [];
  const skills: HarnessPlan["skills"] = [];
  const lines: string[] = [];
  const home = roots.home ?? os.homedir();
  const data = roots.data ?? dataDir();
  const workspace = roots.workspace;
  ops.forEach((op, i) => {
    const where = `Change ${i + 1} (${op.op})`;
    switch (op.op) {
      case "mcp_set":
      case "mcp_remove": {
        if (!validName(op.name)) throw new Error(`${where}: "${op.name}" is not a name Scribe takes: letters, digits, dot, dash or underscore, up to 48, and not scribe, agent-board or custom-user-tools.`);
        if (op.scope === "workspace" && !workspace) throw new Error(`${where}: this thread has no workspace folder; use scope global.`);
        mcp ??= copyFile(current.mcp);
        const key = op.scope === "workspace" ? workspaceKey(workspace!) : null;
        const layer = key ? (mcp.workspaces[key] ??= { path: workspace!, mcpServers: {} }).mcpServers : mcp.mcpServers;
        const label = op.scope === "workspace" ? `in ${workspace}` : "for every workspace";
        if (op.op === "mcp_remove") {
          if (!layer[op.name]) throw new Error(`${where}: no ${op.scope} server "${op.name}". harness_docs lists them.`);
          delete layer[op.name];
          if (key && !Object.keys(mcp.workspaces[key].mcpServers).length) delete mcp.workspaces[key];
          lines.push(`Remove MCP server "${op.name}" ${label}`);
          break;
        }
        const existed = Boolean(layer[op.name]);
        const server = cleanServer(mergeServer(layer[op.name], op.server, op.replace === true));
        if (!server) throw new Error(`${where}: a server needs command (stdio) or url (http or sse).`);
        layer[op.name] = server;
        lines.push(`${existed ? "Change" : "Add"} MCP server "${op.name}" ${label}: ${serverSummary(server)}`);
        break;
      }
      case "mcp_enable": {
        mcp = setServerEnabled(mcp ?? current.mcp, op.name, workspace, op.on);
        lines.push(`Turn MCP server "${op.name}" ${op.on ? "on" : "off"}${workspace ? ` in ${workspace}` : ""}`);
        break;
      }
      case "hook_set": {
        rules ??= [...current.hookRules];
        const id = str(op.rule.id);
        const at = id ? rules.findIndex((r) => r.id === id) : -1;
        const base = at >= 0 ? rules[at] : undefined;
        const merged = { ...(base ?? { enabled: true }), ...op.rule };
        let rule: HookRule;
        try {
          rule = normalizeRules([merged])[0];
        } catch (err) {
          throw new Error(`${where}: ${(err as Error).message}`);
        }
        if (!rule) throw new Error(`${where}: the rule needs a pattern and an action.`);
        if (at >= 0) rules[at] = { ...rule, id };
        else {
          // A new rule gets an id no other rule has.
          let n = rules.length + 1;
          let next = id || rule.id;
          while (rules.some((r) => r.id === next)) next = `rule-${n++}`;
          rules.push({ ...rule, id: next });
        }
        lines.push(`${at >= 0 ? "Change" : "Add"} hook rule: ${rule.enabled ? "" : "(off) "}${rule.match} "${rule.pattern}" on ${rule.event} → ${rule.action}${rule.text ? ` "${rule.text}"` : ""}`);
        break;
      }
      case "hook_remove": {
        rules ??= [...current.hookRules];
        const at = rules.findIndex((r) => r.id === op.id);
        if (at < 0) throw new Error(`${where}: no hook rule with id "${op.id}". harness_docs lists them.`);
        const [gone] = rules.splice(at, 1);
        lines.push(`Remove hook rule ${gone.match} "${gone.pattern}"`);
        break;
      }
      case "skill_create": {
        const folder = skillFolders(workspace, home, data).find((f) => path.resolve(f.dir).toLowerCase() === path.resolve(op.folder || ".").toLowerCase());
        if (!folder) throw new Error(`${where}: folder must be one of the skill folders harness_docs lists.`);
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(op.name)) throw new Error(`${where}: use lowercase letters, digits, dash or underscore for the name.`);
        if (!op.description) throw new Error(`${where}: say when an agent should use the skill; every chat is sent this description.`);
        if (fs.existsSync(path.join(folder.dir, op.name))) throw new Error(`${where}: there is already a ${op.name} folder in ${folder.dir}.`);
        if (op.text !== undefined && op.text.length > MAX_TEXT) throw new Error(`${where}: text is too large.`);
        skills.push({ folder: folder.dir, name: op.name, description: op.description, ...(op.text !== undefined ? { text: op.text } : {}) });
        lines.push(`Create skill "${op.name}" in ${folder.dir} (${folder.providers.join(", ")}): ${op.description}`);
        break;
      }
      case "file_write": {
        if (!path.isAbsolute(op.path)) throw new Error(`${where}: path must be absolute.`);
        const kind = editableKind(op.path, { workspace, home, data });
        if (!kind) throw new Error(`${where}: Scribe only writes skill files and the instruction files harness_docs lists here.`);
        if (op.text.length > MAX_TEXT) throw new Error(`${where}: text is too large.`);
        const exists = fs.existsSync(op.path);
        if (kind === "skill" && !exists && !fs.existsSync(path.dirname(op.path))) throw new Error(`${where}: that skill folder does not exist; create the skill with skill_create first.`);
        files.push({ path: op.path, text: op.text });
        lines.push(`${exists ? "Rewrite" : "Create"} ${kind === "skill" ? "skill file" : "instruction file"} ${op.path} (${op.text.length} characters)`);
        break;
      }
    }
  });
  return { ...(mcp ? { mcp } : {}), ...(rules ? { hookRules: rules } : {}), files, skills, lines };
}

/** Write a plan's skills and files. MCP servers and hook rules are the caller's to save. */
export function writeHarnessPlan(plan: HarnessPlan, roots: HarnessRoots): void {
  for (const skill of plan.skills) {
    const { file } = createSkill(skill.folder, skill.name, skill.description, roots);
    if (skill.text !== undefined) fs.writeFileSync(file, skill.text);
  }
  for (const f of plan.files) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.text);
  }
}

/** harness_docs: how Scribe's harness works, and what is set for this thread now. */
export function harnessDocs(current: { mcp: McpFile & { error?: string }; hookRules: HookRule[]; classifier: boolean }, roots: HarnessRoots): string {
  const home = roots.home ?? os.homedir();
  const data = roots.data ?? dataDir();
  const workspace = roots.workspace;
  const servers = mergedServers(current.mcp, workspace);
  const out: string[] = [];
  out.push(
    "# Scribe's agent harness",
    "",
    "Scribe sets up every chat thread itself: its own instructions, its MCP tools (the `scribe` server), the user's MCP servers, hook rules, skills and the providers' instruction files. You can change the user's part of it with harness_change. The user is asked first, in a violet card in the chat: once, or for the rest of this thread. Changes apply from each thread's next session (a new turn after the setup changed); this turn keeps the tools it started with.",
    "Prefer settings_find and settings_show for anything that is a simple switch or choice in Scribe's settings: the user clicks it in the chat. Use harness_change for setup that takes more than a click (adding a server with its command, args and env, writing a hook rule or a skill).",
    "",
    "## MCP servers",
    `Scribe keeps one list for Claude, Cursor and Native threads (Codex and Pi get them bridged) in ${path.join(data, "agent", "mcp.json")}, in the usual { mcpServers: { name: config } } shape plus a layer per workspace folder. A workspace entry replaces the global server of the same name; { enabled: false } alone turns a global one off in that workspace. Don't edit the file by hand: harness_change keeps it valid.`,
    "Server fields: command, args, env, cwd (stdio); url, headers, type http or sse (remote); enabled; modes (which thread modes get it: code, board; default code only); approve (ask each call, the default, or auto); tools ({ toolName: allow | disable }: allow runs it without asking, disable hides it); description; timeout (ms). ${VAR} in values expands from Scribe's environment, so keep secrets in environment variables when the user can.",
    "Ops: { op: mcp_set, name, scope: global | workspace, server, replace? } adds a server or merges the fields you pass into the one there (null removes a field, or one env/header/tools key); replace: true writes server as the whole entry. { op: mcp_remove, name, scope }. { op: mcp_enable, name, on } turns a server on or off for this workspace as the harness view does.",
    "",
    "## Hook rules",
    "Hook rules watch what agents do in every thread. A rule matches a keyword, a regex, a tool (name or title contains it) or a yes/no question for the classifier, on one event or any. Its action: signal (a named signal), flag (marks the turn), context (tells the agent text), ask (the user approves the tool call) or block.",
    `Rule fields: id, enabled, match (${RULE_MATCHES.join(" | ")}), pattern, event (${[...HOOK_EVENTS, "any"].join(" | ")}), action (${HOOK_ACTIONS.join(" | ")}), text (the signal name, flag label, context for the agent, or the reason for ask and block), threshold (question: 0.5 to 1).${current.classifier ? "" : " Question rules need the classifier, which is off now (ML settings)."}`,
    "Ops: { op: hook_set, rule } adds a rule, or changes the one with rule.id (fields you leave out stay). { op: hook_remove, id }.",
    "",
    "## Skills",
    "A skill is a folder with a SKILL.md: frontmatter name and description (every chat is sent the description), then what the agent should do. Each provider reads its own folders:",
    ...skillFolders(workspace, home, data).map((f) => `- ${f.dir} (${f.scope}; ${f.providers.join(", ")})`),
    "Ops: { op: skill_create, folder, name, description, text? } makes the skill folder and its SKILL.md (text replaces the starter content; keep the frontmatter). { op: file_write, path, text } writes a file inside an existing skill's folder.",
    "",
    "## Instruction files",
    "Files the providers load into every session by themselves. { op: file_write, path, text } writes one (the whole file); read it first if it exists.",
    ...instructionFiles(workspace, home).map((f) => `- ${f}${fs.existsSync(f) ? "" : " (not there yet)"}`),
    "",
    "## Now",
    current.mcp.error ? `mcp.json could not be read: ${current.mcp.error}. Changing servers would overwrite it; tell the user first.` : "",
    workspace ? `Workspace: ${workspace}` : "This thread has no workspace folder: MCP changes go to the global list.",
    servers.length ? "MCP servers for this workspace:" : "No MCP servers of the user's yet.",
    ...servers.map((s) => `- ${s.name} [${s.layer === "global" ? "global" : "workspace"}${s.server.enabled === false ? ", off" : ""}]: ${serverSummary(s.server)}`),
    current.hookRules.length ? "Hook rules:" : "No hook rules yet.",
    ...current.hookRules.map((r) => `- ${r.id}${r.enabled ? "" : " (off)"}: ${r.match} "${r.pattern}" on ${r.event} → ${r.action}${r.text ? ` "${r.text}"` : ""}`)
  );
  return out.filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n");
}
