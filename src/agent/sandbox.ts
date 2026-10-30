import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkPath, type AccessPolicy } from "./access.js";
import { pathInside } from "./toolGrants.js";
import type { Thread } from "./types.js";
import { cleanAllowlist } from "./webAccess.js";

/**
 * The OS sandbox for commands Scribe spawns (#899, design in docs/sandboxing-design-891.md): Anthropic's
 * sandbox-runtime (srt) fed from the thread's access policy (access.ts). Linux only for now; on other
 * systems the shells run as before until #900 decides. Full access turns it off.
 *
 * srt keeps one configuration per process, so the per-thread parts go with each command: the
 * filesystem lists as the wrap's own config, the allowed hosts as a per-command allow list. Its
 * network filter has no "any public host" entry, so threads with web on use a second srt instance
 * whose filter allows every host the resolved-address check lets through (never loopback, link-local,
 * this machine's addresses or private ranges).
 */

export type SandboxNet = {
  /** Any public host (web on, or "all websites" granted). */
  open: boolean;
  /** srt allowedDomains entries: provider API hosts, the web allowlist or grants, Scribe's MCP port. */
  allow: string[];
};

export type SandboxSpec = { policy: AccessPolicy; net: SandboxNet };

/** One thing the sandbox refused a command, and what the user could allow for the thread. */
export type SandboxBlock = {
  op: "write" | "read" | "network";
  /** The path or host:port. */
  target: string;
  /** srt's own line, for logs. */
  line: string;
  grant?: { kind: "folder"; path: string } | { kind: "host"; host: string };
};

type SandboxThread = Pick<Thread, "mode" | "approval"> & Partial<Pick<Thread, "provider" | "model" | "web" | "webGrants">>;

/** Whether the thread's commands run in the OS sandbox: Code mode short of Full access, on Linux. */
export function sandboxed(thread: Pick<Thread, "mode" | "approval">, platform: NodeJS.Platform = process.platform): boolean {
  if (process.env.SCRIBE_SANDBOX === "off") return false;
  return platform === "linux" && thread.mode === "code" && thread.approval !== "full";
}

/** Never reachable through the sandbox's proxy, even by a name that resolves there (srt adds loopback, link-local and this host's own). */
export const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"];

const PROVIDER_HOSTS: Record<string, string[]> = {
  claude: ["anthropic.com", "claude.ai"],
  codex: ["openai.com", "chatgpt.com"],
  cursor: ["cursor.sh", "cursor.com"],
};

/** Native's model providers ("<provider>/<model>") and the API hosts they call. */
const PI_HOSTS: Record<string, string[]> = {
  anthropic: ["anthropic.com"],
  openai: ["openai.com"],
  "openai-codex": ["openai.com", "chatgpt.com"],
  google: ["generativelanguage.googleapis.com"],
  "google-gemini-cli": ["cloudcode-pa.googleapis.com", "oauth2.googleapis.com"],
  openrouter: ["openrouter.ai"],
  groq: ["api.groq.com"],
  xai: ["api.x.ai"],
  mistral: ["api.mistral.ai"],
  deepseek: ["api.deepseek.com"],
  cerebras: ["api.cerebras.ai"],
  "github-copilot": ["githubcopilot.com"],
};

/** A domain as srt entries: itself and its subdomains (srt rejects "*.com"-wide patterns, so a bare TLD stays bare). */
function domainEntries(domain: string): string[] {
  return domain.includes(".") ? [domain, `*.${domain}`] : [domain];
}

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

/** The API hosts a thread's own provider calls: reachable with web off. */
export function providerHosts(thread: Partial<Pick<Thread, "provider" | "model">>): string[] {
  if (thread.provider === "pi") {
    const at = thread.model?.indexOf("/") ?? -1;
    return at > 0 ? PI_HOSTS[thread.model!.slice(0, at)] ?? [] : [];
  }
  return thread.provider ? PROVIDER_HOSTS[thread.provider] ?? [] : [];
}

/**
 * The thread's network in the sandbox, from its Web setting and web grants. Loopback only to Scribe's agent port
 * (AGENT_PORT, #915), never the board's: there a forged browser header would pass as the user.
 */
export function sandboxNet(thread: SandboxThread, webAllowlist: string[], agentPort: number): SandboxNet {
  const open = thread.web === "on" || Boolean(thread.webGrants?.all);
  const domains = cleanAllowlist([...providerHosts(thread), ...(thread.web === "limited" ? webAllowlist : []), ...(thread.webGrants?.domains ?? [])]);
  return { open, allow: uniq([...domains.flatMap(domainEntries), `127.0.0.1:${agentPort}`, `localhost:${agentPort}`]) };
}

function inAny(roots: string[], target: string): boolean {
  return roots.some((root) => pathInside(root, target));
}

/**
 * The policy as srt's filesystem lists. Reads: srt allows everything but denyRead, with allowRead
 * opening a folder inside a denied one again, and a more specific deny (a credential file) closing it
 * once more. Reads outside the read roots ask in Scribe's own gates; the OS sandbox cannot ask, so it
 * holds the protected paths only. Writes: only the write roots, never the worktree's links or a
 * protected path inside a root.
 */
export function srtFilesystem(policy: AccessPolicy): { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] } {
  return {
    denyRead: uniq([...policy.deny, ...policy.secrets]),
    allowRead: uniq(policy.denyExcept),
    allowWrite: uniq(policy.writeRoots),
    denyWrite: uniq([...policy.readOnly, ...policy.secrets, ...policy.deny.filter((p) => inAny(policy.writeRoots, p) && !inAny(policy.denyExcept, p))]),
  };
}

/** Claude's own sandbox (SDK options.sandbox) for the same policy: its Bash runs under srt too. */
export function claudeSandbox(spec: SandboxSpec) {
  return {
    enabled: true,
    // Unavailable (no bubblewrap): Claude runs its commands unsandboxed, and Scribe says "not enforced".
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: false,
    // No dangerouslyDisableSandbox way out of it.
    allowUnsandboxedCommands: false,
    // Web on: hosts off the list ask through Claude's own prompt. Off or limited: the list is the limit.
    network: { allowedDomains: spec.net.allow, ...(spec.net.open ? {} : { strictAllowlist: true }) },
    filesystem: srtFilesystem(spec.policy),
  };
}

/** The folder to offer for a blocked write: the path itself when it is a folder, else the folder it is in. */
function grantFolder(target: string): string {
  try {
    if (fs.statSync(target).isDirectory()) return target;
  } catch {
    // Not there (the command failed to create it): its parent.
  }
  return path.dirname(target);
}

/**
 * srt's violation lines for one command as blocks. On Linux its monitor reports every write outside
 * the session's own (empty) write list, so writes are checked against the thread's policy here and
 * only the ones it refuses are kept. A protected path offers no grant: no grant opens it.
 */
export function sandboxBlocks(lines: string[], policy: AccessPolicy): SandboxBlock[] {
  const out: SandboxBlock[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const netMatch = /^deny (?:network-outbound|socks-tunnel) (\S+?):(\d+)(?: \((.*)\))?$/.exec(line) ?? /^deny http-request \S+ (?:https?:\/\/)?([^/:\s]+)(?::(\d+))?\S* ?(?:\((.*)\))?$/.exec(line);
    if (netMatch) {
      const host = netMatch[1].replace(/^\[|\]$/g, "").toLowerCase();
      const target = netMatch[2] ? `${host}:${netMatch[2]}` : host;
      if (seen.has(`n:${target}`)) continue;
      seen.add(`n:${target}`);
      // A name that resolved to loopback or a private address, or an IP literal: no grant reaches it.
      const reason = netMatch[3] ?? "";
      const grantable = !net.isIP(host) && host !== "localhost" && !/resolved to|private|loopback/i.test(reason);
      out.push({ op: "network", target, line, ...(grantable ? { grant: { kind: "host" as const, host } } : {}) });
      continue;
    }
    const fsMatch = /^deny (\S+) (.+)$/.exec(line);
    if (!fsMatch || !path.isAbsolute(fsMatch[2])) continue;
    // Linux's monitor reports write-intent syscalls only (openat, mkdirat, unlinkat, renameat2, …).
    const op = /^file-read/.test(fsMatch[1]) ? "read" : "write";
    const target = fsMatch[2];
    const check = checkPath(policy, target, op);
    if (check.verdict === "allow") continue;
    const key = `${op}:${check.real ?? target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ op, target: check.real ?? target, line, ...(check.verdict === "ask" && op === "write" ? { grant: { kind: "folder" as const, path: grantFolder(check.real ?? target) } } : {}) });
  }
  return out.slice(0, 20);
}

/** The short reason the agent gets back with the command's output. */
export function blockSummary(blocks: SandboxBlock[]): string {
  const parts = blocks.slice(0, 5).map((b) => (b.op === "network" ? `connect to ${b.target}` : `${b.op} ${b.target}`));
  const more = blocks.length > 5 ? ` and ${blocks.length - 5} more` : "";
  return `The sandbox blocked: ${parts.join("; ")}${more}.`;
}

// ---------- srt at run time ----------

/** The parts of srt's SandboxManager Scribe uses (loaded on demand: it is only needed on Linux). */
type SrtManager = {
  initialize(config: unknown, ask?: (p: { host: string; port: number | undefined }) => Promise<boolean | { allow: false; reason: string }>, enableLogMonitor?: boolean): Promise<void>;
  isSupportedPlatform(): boolean;
  checkDependencies(): { errors: string[]; warnings: string[] };
  wrapWithSandbox(command: string, binShell?: string, customConfig?: unknown, abortSignal?: AbortSignal, options?: { commandId?: string; commandText?: string }): Promise<string>;
  registerCommandNetworkLists(commandId: string, lists: { allowedDomains?: string[] }): void;
  unregisterCommandNetworkLists(commandId: string): void;
  getSandboxViolationStore(): { getViolationsForCommand(command: string): Array<{ line: string }> };
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
  readonly askCallbackDenyReason?: true;
};

const blockedRanges = new net.BlockList();
for (const range of ["127.0.0.0/8", "0.0.0.0/8", "169.254.0.0/16", ...PRIVATE_RANGES.filter((r) => !r.includes(":"))]) {
  const [addr, bits] = range.split("/");
  blockedRanges.addSubnet(addr, Number(bits), "ipv4");
}
for (const range of ["::1/128", "fe80::/10", "fc00::/7", "::/128"]) {
  const [addr, bits] = range.split("/");
  blockedRanges.addSubnet(addr, Number(bits), "ipv6");
}

/** Web on: any host by name (srt's resolved-address check still refuses loopback and private answers), and IP literals that are public. */
export function openHostAllowed(host: string): boolean {
  const literal = host.replace(/^\[|\]$/g, "");
  const kind = net.isIP(literal);
  if (!kind) return host.toLowerCase() !== "localhost" && !host.toLowerCase().endsWith(".localhost");
  return !blockedRanges.check(literal, kind === 6 ? "ipv6" : "ipv4");
}

const managers = new Map<"restricted" | "open", Promise<SrtManager>>();
let unavailable: string | null = null;

async function loadManager(kind: "restricted" | "open"): Promise<SrtManager> {
  // Windows (srt-win) and macOS wait for #900.
  if (process.platform !== "linux") throw new Error("the sandbox runs on Linux only for now");
  // All of srt's state is in this one module: a second import under another URL is a second, separate instance.
  const entry = createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime");
  const file = path.join(path.dirname(entry), "sandbox", "sandbox-manager.js");
  const mod = (await import(pathToFileURL(file).href + (kind === "open" ? "?instance=open" : ""))) as { SandboxManager: SrtManager };
  const manager = mod.SandboxManager;
  if (!manager.isSupportedPlatform()) throw new Error("this system is not supported by sandbox-runtime");
  const deps = manager.checkDependencies();
  if (deps.errors.length) throw new Error(deps.errors.join("; "));
  const deny = (reason: string) => (manager.askCallbackDenyReason ? { allow: false as const, reason } : false);
  await manager.initialize(
    {
      network: { allowedDomains: [], deniedDomains: [], deniedResolvedAddresses: PRIVATE_RANGES },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    },
    async ({ host }) => {
      if (kind === "restricted") return deny("not allowed by this thread's Web setting");
      return openHostAllowed(host) ? true : deny("loopback and private addresses are never reachable from the sandbox");
    },
    true,
  );
  return manager;
}

function managerFor(kind: "restricted" | "open"): Promise<SrtManager> {
  let m = managers.get(kind);
  if (!m) {
    m = loadManager(kind);
    managers.set(kind, m);
    m.catch((err: unknown) => {
      unavailable = (err as Error).message;
    });
  }
  return m;
}

/** Why the sandbox cannot run here, once a start failed (missing bubblewrap or socat); null while it works or is untried. */
export function sandboxUnavailable(): string | null {
  return unavailable;
}

export type WrappedCommand = {
  /** The command line to run with the same shell instead of the original. */
  command: string;
  /** After the command ends: what the sandbox refused it. Call once. */
  done(): SandboxBlock[];
};

/**
 * Wrap one command line for the sandbox. Throws when srt cannot run here; callers then run the command
 * as before and say the sandbox is not enforced.
 */
export async function wrapCommand(spec: SandboxSpec, command: string, opts: { shell?: string; signal?: AbortSignal } = {}): Promise<WrappedCommand> {
  const manager = await managerFor(spec.net.open ? "open" : "restricted");
  // The id is the only thing tying a connection to this command's allow list: unguessable, per run.
  const id = randomBytes(16).toString("base64url");
  manager.registerCommandNetworkLists(id, { allowedDomains: spec.net.allow });
  let wrapped: string;
  try {
    wrapped = await manager.wrapWithSandbox(command, opts.shell, { filesystem: srtFilesystem(spec.policy) }, opts.signal, { commandId: id, commandText: command });
  } catch (err) {
    manager.unregisterCommandNetworkLists(id);
    throw err;
  }
  let finished = false;
  return {
    command: wrapped,
    done: () => {
      if (finished) return [];
      finished = true;
      const lines = manager.getSandboxViolationStore().getViolationsForCommand(id).map((v) => v.line);
      manager.unregisterCommandNetworkLists(id);
      manager.cleanupAfterCommand();
      return sandboxBlocks(lines, spec.policy);
    },
  };
}

/** Stop srt's proxies (daemon shutdown). */
export async function resetSandbox(): Promise<void> {
  const all = [...managers.values()];
  managers.clear();
  for (const m of all) await m.then((manager) => manager.reset()).catch(() => undefined);
}

/** What a provider's shell needs from the host for one thread (SessionContext.sandbox). */
export type SandboxHooks = {
  /** The thread's sandbox now (grants made since count), or null when it no longer applies. */
  spec(): SandboxSpec | null;
  /** What the sandbox refused a command: one chat row, and the short reason for the agent. */
  blocked(command: string, blocks: SandboxBlock[], signal?: AbortSignal): Promise<string>;
  /** srt could not start here: the command runs without it, and the chat says so once. */
  missing(reason: string): void;
};

/**
 * Run one command line through the thread's sandbox when it has one. `run` gets the line to execute
 * with the same shell; `note` is the reason to add to the command's output when the sandbox refused
 * something.
 */
export async function sandboxedRun<R>(hooks: SandboxHooks | null | undefined, command: string, opts: { shell?: string; signal?: AbortSignal }, run: (line: string) => Promise<R>): Promise<{ result: R; note?: string }> {
  const spec = hooks?.spec() ?? null;
  if (!hooks || !spec) return { result: await run(command) };
  let wrapped: WrappedCommand;
  try {
    wrapped = await wrapCommand(spec, command, opts);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    hooks.missing((err as Error).message);
    return { result: await run(command) };
  }
  let blocks: SandboxBlock[] = [];
  let result: R;
  try {
    result = await run(wrapped.command);
  } finally {
    blocks = wrapped.done();
  }
  if (!blocks.length) return { result };
  return { result, note: await hooks.blocked(command, blocks, opts.signal).catch(() => blockSummary(blocks)) };
}
