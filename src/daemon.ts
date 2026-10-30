import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { AGENT_CLIENT, AGENT_LABEL_HEADER, CLIENT_HEADER, INSTALL_ROOT, LOCAL_TOKEN_HEADER, SESSION_HEADER, THREAD_HEADER, THREAD_TOKEN_HEADER, VERSION, baseUrl, dataDir } from "./config.js";

/** Identifies this MCP process to the daemon, so claims can tell a live agent from one that stopped. */
const SESSION_ID = randomBytes(6).toString("hex");
let agentLabel = "";

/** The MCP client's name (e.g. "claude-code"), once the client has introduced itself. */
export function setAgentLabel(label: string): void {
  agentLabel = label.replace(/[^\x20-\x7e]/g, "").slice(0, 60);
}
import { log } from "./log.js";

/** The data folder's local token (src/callers.ts), read each time: the daemon makes it when it starts. */
function localHeader(): Record<string, string> {
  try {
    const token = fs.readFileSync(path.join(dataDir(), "local-token"), "utf8").trim();
    return /^[0-9a-f]{64}$/.test(token) ? { [LOCAL_TOKEN_HEADER]: token } : {};
  } catch {
    return {};
  }
}

type Health = {
  ok: boolean;
  version?: string;
  root?: string;
  url: string;
  viewers: number;
  tabs: number;
  activeId: string | null;
};

export async function health(): Promise<Health | null> {
  try {
    const res = await fetch(`${baseUrl()}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

/**
 * Starts the daemon if none is running. A running daemon of another version is replaced only when it runs from this
 * install (an update), or always with `replace` (the desktop app's --ensure launch). An MCP process from another
 * checkout (a worktree, a test, a tool script) uses the running daemon instead of killing the live board.
 */
export async function ensureDaemon(options: { replace?: boolean } = {}): Promise<string> {
  const url = baseUrl();
  const running = await health();
  if (running?.version === VERSION) {
    return url;
  }
  // Older daemons don't report their root; treat them as this install's, as before.
  if (running && !options.replace && running.root && !sameInstall(running.root)) {
    log(`Using scribe daemon ${running.version ?? "unknown"} from ${running.root}; this process is ${VERSION} from ${INSTALL_ROOT}`);
    return url;
  }
  if (running) {
    log(`Replacing scribe daemon ${running.version ?? "unknown"} with ${VERSION}`);
    await stopDaemon();
  }
  log("Starting scribe daemon");
  const args = process.argv.slice(1).filter((arg) => arg !== "--daemon" && arg !== "--stop" && arg !== "--ensure");
  args.push("--daemon");
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  for (let i = 0; i < 25; i += 1) {
    await sleep(120);
    if (await health()) {
      return url;
    }
  }
  throw new Error(`Scribe daemon did not start at ${url}`);
}

function sameInstall(root: string): boolean {
  const norm = (dir: string) => (process.platform === "win32" ? path.resolve(dir).toLowerCase() : path.resolve(dir));
  return norm(root) === norm(INSTALL_ROOT);
}

/** A daemon from another build answers health but speaks a different API, so it must be replaced. */
async function stopDaemon(): Promise<void> {
  try {
    await api("POST", "/api/shutdown", undefined, { timeoutMs: 2000 });
  } catch {
    /* it may exit before answering */
  }
  for (let i = 0; i < 40; i += 1) {
    await sleep(100);
    if (!(await health())) {
      return;
    }
  }
  throw new Error(`Scribe daemon at ${baseUrl()} did not stop`);
}

/** node:http rather than fetch: fetch gives up on a response after 5 minutes, which would cut page_wait short. */
export async function api(
  method: string,
  pathname: string,
  body?: unknown,
  /** `user`: a command the person runs (`scribe pair`): the local token, without the agent header. */
  options?: { timeoutMs?: number; signal?: AbortSignal; user?: boolean }
): Promise<{ status: number; data: unknown }> {
  const signals = [options?.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined, options?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined
  );
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request(
      `${baseUrl()}${pathname}`,
      {
        method,
        headers: {
          ...(options?.user
            ? localHeader()
            : {
                [CLIENT_HEADER]: AGENT_CLIENT,
                [SESSION_HEADER]: SESSION_ID,
                ...(process.env.SCRIBE_THREAD ? { [THREAD_HEADER]: process.env.SCRIBE_THREAD } : {}),
                ...(process.env.SCRIBE_THREAD_TOKEN ? { [THREAD_TOKEN_HEADER]: process.env.SCRIBE_THREAD_TOKEN } : {}),
                // An MCP with no Scribe chat proves it runs as the user's own client (#682).
                ...(process.env.SCRIBE_THREAD ? {} : localHeader()),
                ...(agentLabel ? { [AGENT_LABEL_HEADER]: agentLabel } : {}),
              }),
          ...(payload === undefined
            ? {}
            : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
        },
        signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  return { status, data };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
