import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Daemon/UI protocol version. Bump with any API or event change; public/app.js BOARD_VERSION must match. */
export const VERSION = "3.2.7";
/** The install (checkout) this process runs from: the folder above src/ or dist/. */
export const INSTALL_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
export const HOST = "127.0.0.1";
/** Loopback origin for data-free shared files (tooltip, vendor libraries) and blobs; pages run on their own (pageHost). */
export const CONTENT_HOST = "127.0.0.2";
export const PORT = Number(process.env.SCRIBE_PORT || 4747);
/** The peer link's TLS port (#904), on LAN and tailnet addresses only; the API above stays loopback. */
export const PEER_PORT = Number(process.env.SCRIBE_PEER_PORT || PORT + 1);
/**
 * Loopback port for Scribe chats' MCP only (#915): every caller there is an agent, so a sandbox can allow this
 * port and never the board's, where a forged browser header passes as the user. 0 turns it off (test daemons,
 * whose ports are picked next to each other): chats' MCP then calls the board port.
 */
export const AGENT_PORT = process.env.SCRIBE_AGENT_PORT ? Number(process.env.SCRIBE_AGENT_PORT) || 0 : PORT + 2;
/**
 * Loopback port for web access (#913): a TLS proxy (Caddy) on this machine sends <domain> and *.<domain>
 * here. It opens only once Settings → Devices → Web access names a domain; 0 keeps it closed.
 */
export const WEB_PORT = process.env.SCRIBE_WEB_PORT ? Number(process.env.SCRIBE_WEB_PORT) || 0 : PORT + 3;
/** Addresses to listen for peers on instead of the LAN and tailnet ones (comma separated), or "off". */
export function peerHostsOverride(): string[] | "off" | undefined {
  const value = process.env.SCRIBE_PEER_HOSTS?.trim();
  if (!value) return undefined;
  if (value === "off") return "off";
  return value.split(",").map((host) => host.trim()).filter(Boolean);
}
export const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_STATE_BYTES = 4 * 1024 * 1024;
/** Events each page keeps for waits to read; older ones drop off. */
export const MAX_PAGE_EVENTS = 500;
export const MAX_EVENT_DATA_BYTES = 4096;
/** Per-viewer page state (board.local): filters, open panels, drafts. */
export const MAX_LOCAL_STATE_BYTES = 64 * 1024;
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_ASSETS_PER_TAB = 16;
export const MAX_ASSETS_TOTAL_BYTES = 32 * 1024 * 1024;
/** Blobs a page saves from its own code (board.saveAsset), stored in scribe.sqlite. */
export const MAX_PAGE_ASSET_BYTES = 32 * 1024 * 1024;
export const MAX_PAGE_ASSETS_PER_TAB = 2000;
export const MAX_PAGE_ASSETS_TOTAL_BYTES = 256 * 1024 * 1024;
/** Share of either page asset limit at which the page and the board UI are warned. */
export const PAGE_ASSET_WARN_RATIO = 0.8;
/** How long a page asset may go unreferenced by the page's state and HTML before it is deleted. */
export const PAGE_ASSET_ORPHAN_GRACE_MS = 10 * 60 * 1000;
/** Safety-net sweep for orphaned assets, on top of the checks after each save. */
export const ASSET_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Kept under V8's ~512 MiB string cap, since the file is parsed as one JSON string. */
export const MAX_IMPORT_BYTES = 400 * 1024 * 1024;
/** Long on purpose: the user can interrupt the agent at any time, and a review page may take a while. */
export const DEFAULT_WAIT_MS = 2 * 60 * 60 * 1000;
/** Not a policy limit (the harness owns that): setTimeout's ~24.8-day ceiling, less room for the socket margins added on top. */
export const MAX_WAIT_MS = 2 ** 31 - 1 - 60_000;
/** How often page_wait reports progress, so the MCP client does not take the long silence for a hung server. */
export const WAIT_HEARTBEAT_MS = 60_000;
/** How long the server gives a client to send a whole request. */
export const REQUEST_TIMEOUT_MS = 10 * 60 * 1000 + 30_000;
/** The MCP marks its requests with this header so tabs hidden from the agent stay invisible to them. */
export const CLIENT_HEADER = "x-scribe-client";
export const AGENT_CLIENT = "agent";
/** One MCP server process; claims it holds stay live while it keeps calling. */
export const SESSION_HEADER = "x-scribe-session";
/** The Scribe chat thread an MCP server was started for (SCRIBE_THREAD in its environment). */
export const THREAD_HEADER = "x-scribe-thread";
/** Proves THREAD_HEADER: the token the daemon gave that chat's MCP (SCRIBE_THREAD_TOKEN, src/callers.ts). */
export const THREAD_TOKEN_HEADER = "x-scribe-token";
/** A local tool acting for the user sends the data folder's local-token file (src/callers.ts). */
export const LOCAL_TOKEN_HEADER = "x-scribe-local-token";
/** The MCP client's name, shown as the holder of a claim. */
export const AGENT_LABEL_HEADER = "x-scribe-agent";

export function baseUrl(): string {
  return `http://${HOST}:${PORT}`;
}

/** Where a Scribe chat's MCP calls the daemon (AGENT_PORT). */
export function agentBaseUrl(): string {
  return `http://${HOST}:${AGENT_PORT}`;
}

/** Origins the board shell may be opened from: the desktop app uses baseUrl(), a browser may use localhost. */
export function shellOrigins(): string[] {
  return [baseUrl(), `http://localhost:${PORT}`];
}

/**
 * Each tab page runs on an origin of its own (#660): t-ab12cd34.localhost for t_ab12cd34. Pages on
 * one shared origin could reach each other's frames, so a per-frame token would not hold. Browsers
 * resolve *.localhost to loopback, where the board listens. Ids outside t_<hex> use x<hex of the id>.
 */
export const PAGE_HOST_SUFFIX = ".localhost";

/**
 * Another device's UI, through this daemon's gateway (#905): d-<device>.localhost is its board, and
 * <label>.d-<device>.localhost its page, preview and component origins, and c.d-<device>.localhost its
 * shared content origin (127.0.0.2 here). The remote daemon sees the same host names over the link and
 * builds its URLs with that suffix instead of .localhost; its UI reads the suffix from its own location.
 */
const GATEWAY_HOST = /^(?:([^.]+)\.)?d-([0-9a-f]{12})\.localhost$/;

export function gatewayHost(hostname: string): { device: string; label?: string } | undefined {
  const match = GATEWAY_HOST.exec(hostname.toLowerCase());
  return match ? { device: match[2], ...(match[1] ? { label: match[1] } : {}) } : undefined;
}

/** The page host suffix a host belongs to: .localhost, or .d-<device>.localhost behind the gateway. */
export function hostSuffixOf(hostname: string): string {
  const gateway = gatewayHost(hostname);
  return gateway ? `.d-${gateway.device}${PAGE_HOST_SUFFIX}` : PAGE_HOST_SUFFIX;
}

/** The first label of a page-style host (<label>.localhost or <label>.d-<device>.localhost). */
function hostLabel(hostname: string): string | undefined {
  const host = hostname.toLowerCase();
  if (GATEWAY_HOST.test(host)) return gatewayHost(host)?.label;
  return host.endsWith(PAGE_HOST_SUFFIX) ? host.slice(0, -PAGE_HOST_SUFFIX.length) : undefined;
}

/** Keep the full item prefix: w-<hex> is already a worktree preview. */
export function componentHost(itemId: string, suffix = PAGE_HOST_SUFFIX): string {
  if (!/^it_[0-9a-f]{12}$/.test(itemId)) throw new Error("Invalid component item id");
  return `w-it-${itemId.slice(3)}${suffix}`;
}

export function componentItemFromHost(hostname: string): string | undefined {
  const match = /^w-it-([0-9a-f]{12})$/.exec(hostLabel(hostname) ?? "");
  return match ? `it_${match[1]}` : undefined;
}

export function pageComponentHost(id: string, suffix = PAGE_HOST_SUFFIX): string {
  if (!/^pc_[0-9a-f]{16}$/.test(id)) throw new Error("Invalid page component id");
  return `w-pc-${id.slice(3)}${suffix}`;
}

export function pageComponentFromHost(hostname: string): string | undefined {
  const match = /^w-pc-([0-9a-f]{16})$/.exec(hostLabel(hostname) ?? "");
  return match ? `pc_${match[1]}` : undefined;
}

export function pageHost(id: string, suffix = PAGE_HOST_SUFFIX): string {
  const label = /^t_[0-9a-f]+$/.test(id) ? `t-${id.slice(2)}` : `x${Buffer.from(id, "utf8").toString("hex")}`;
  return label + suffix;
}

/** The tab id a page host names, or undefined for any other host. */
export function pageIdFromHost(hostname: string): string | undefined {
  const label = hostLabel(hostname);
  if (label === undefined) return undefined;
  if (/^t-[0-9a-f]{1,61}$/.test(label)) return `t_${label.slice(2)}`;
  if (/^x(?:[0-9a-f]{2}){1,31}$/.test(label)) return Buffer.from(label.slice(1), "hex").toString("utf8");
  return undefined;
}

/**
 * A worktree's UI preview runs on an origin of its own (#703): w-ab12cd34.localhost for chat
 * th_ab12cd34. Its scripts are an agent's, so they must not run as the board; that origin gets the
 * worktree's files and the data-free shared ones, nothing else. Other ids use wx<hex of the id>.
 */
export function previewHost(threadId: string, suffix = PAGE_HOST_SUFFIX): string {
  const label = /^th_[0-9a-f]+$/.test(threadId) ? `w-${threadId.slice(3)}` : `wx${Buffer.from(threadId, "utf8").toString("hex")}`;
  return label + suffix;
}

/** The chat a preview host names, or undefined for any other host. */
export function previewThreadFromHost(hostname: string): string | undefined {
  const label = hostLabel(hostname);
  if (label === undefined) return undefined;
  if (/^w-[0-9a-f]{1,61}$/.test(label)) return `th_${label.slice(2)}`;
  if (/^wx(?:[0-9a-f]{2}){1,30}$/.test(label)) return Buffer.from(label.slice(2), "hex").toString("utf8");
  return undefined;
}

export function pageOrigin(id: string): string {
  return `http://${pageHost(id)}:${PORT}`;
}

/** The page on its own origin, outside the board's frame. */
export function pageViewUrl(id: string): string {
  return `${pageOrigin(id)}/view/${encodeURIComponent(id)}`;
}

export function dataDir(): string {
  if (process.env.SCRIBE_HOME) {
    return process.env.SCRIBE_HOME;
  }
  const root = process.env.LOCALAPPDATA || process.env.HOME || process.cwd();
  return path.join(root, "scribe");
}

/** Where data lived before the app was renamed from Agent Board to Scribe. */
function legacyDataDir(): string | null {
  if (process.env.SCRIBE_HOME) {
    return null;
  }
  const root = process.env.LOCALAPPDATA || process.env.HOME || process.cwd();
  return path.join(root, "agent-board");
}

/**
 * One-time move of an Agent Board data folder to Scribe's, run by the daemon before it opens
 * anything. The new folder may already exist (an MCP process writes its log there first), so
 * entries move one by one and nothing already in the new folder is overwritten. board.sqlite
 * (and its -wal / -shm files) becomes scribe.sqlite.
 */
export function migrateLegacyData(log: (line: string) => void): void {
  const dir = dataDir();
  const legacy = legacyDataDir();
  if (legacy && fs.existsSync(legacy) && !fs.existsSync(dbPath())) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(legacy)) {
      const from = path.join(legacy, name);
      const to = path.join(dir, name);
      if (fs.existsSync(to)) {
        continue;
      }
      try {
        fs.renameSync(from, to);
      } catch (err) {
        // Something still holds it open (a leftover process in the scratch folder): copy instead,
        // so Scribe starts with the data and the old copy stays behind.
        log(`Could not move ${from} (${(err as Error).message}); copying it instead`);
        fs.cpSync(from, to, { recursive: true });
      }
    }
    if (!fs.readdirSync(legacy).length) {
      fs.rmdirSync(legacy);
    }
    log(`Moved data from ${legacy} to ${dir}`);
    // Claude Code keys its sessions by working folder, so Pages-mode threads (which run in the
    // scratch folder) resume only if their session folder is copied to the new path's name.
    const projects = path.join(os.homedir(), ".claude", "projects");
    const encode = (folder: string) => folder.replace(/[^a-zA-Z0-9]/g, "-");
    const from = path.join(projects, encode(path.join(legacy, "agent", "scratch")));
    const to = path.join(projects, encode(path.join(dir, "agent", "scratch")));
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.cpSync(from, to, { recursive: true });
    }
  }
  if (!fs.existsSync(dbPath()) && fs.existsSync(path.join(dir, "board.sqlite"))) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const from = path.join(dir, `board.sqlite${suffix}`);
      if (fs.existsSync(from)) {
        fs.renameSync(from, `${dbPath()}${suffix}`);
      }
    }
    log("Renamed board.sqlite to scribe.sqlite");
  }
}

export function statePath(): string {
  return path.join(dataDir(), "state.json");
}

export function dbPath(): string {
  return path.join(dataDir(), "scribe.sqlite");
}

export function logPath(): string {
  return path.join(dataDir(), "daemon.log");
}
