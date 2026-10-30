import type { PageReader, ThreadPageGrant } from "../pageAccess.js";
import { normalizeThreadPageGrants } from "../pageAccess.js";

/**
 * Agents on other devices (#911). A paired device is the user, so this gate is not about the device:
 * it keeps agents on device A from using that trust. Each device decides what A's agents may do on it
 * (Settings → Devices: read pages, change pages, run helpers; all off until the user turns them on),
 * and treats them like its own chats with no scope: search lists what they could ask for, and a page
 * opens with the user's answer in A's chat (page_access), a page key the user wrote there, or an Open
 * to all agents level. A's chat holds those grants and sends them along; B applies its own page levels.
 *
 * - A chat's MCP names the device with DEVICE_HEADER. A's daemon forwards only the calls in
 *   remoteRequestKind over the link, with REMOTE_AGENT_HEADER describing the chat.
 * - On B, a link request with REMOTE_AGENT_HEADER is an agent (callers.ts), never the user, and
 *   remoteAgentGate checks B's grant for that device before any route sees it.
 */

/** From a chat's MCP to its own daemon: the device (id or name) the call is for. */
export const DEVICE_HEADER = "x-scribe-device";
/** From A's daemon to B over the link: the chat the call comes from (base64url JSON, RemoteAgent). */
export const REMOTE_AGENT_HEADER = "x-scribe-remote-agent";
/** From B back to A: the page read was Trusted only or Restricted, so A's chat is tainted (#269). */
export const TAINT_HEADER = "x-scribe-taint";

/** What a device lets another device's agents do on it. */
export type AgentGrant = { read?: boolean; write?: boolean; run?: boolean };

/** The chat on A behind a request, as B sees it. */
export type RemoteAgent = {
  thread: string;
  title?: string;
  /** Whether A trusts the chat's model (#269): B's Trusted only pages follow it. */
  trusted: boolean;
  /** The chat read Trusted only content: untrusted helpers it starts need the user. */
  tainted?: boolean;
  /** A chat with no page tools here (a workspace helper): it reaches no pages there either. */
  noPages?: boolean;
  /** The chat's access rung; read-only chats change nothing. */
  rung: string;
  /** Pages and folders on B the user let the chat reach (page_access in A's chat). */
  grants: ThreadPageGrant[];
  /** Page keys on B the user wrote in the chat (scribe:@device/key): it may read them (#818). */
  keys: string[];
};

export type RemoteKind = "read" | "write" | "action" | "run";

const TAB = "/api/tabs/[^/]+";

const ROUTES: Array<{ method: string; path: RegExp; kind: RemoteKind }> = [
  { method: "GET", path: /^\/api\/library$/, kind: "read" },
  { method: "GET", path: /^\/api\/search\/(semantic|status)$/, kind: "read" },
  { method: "GET", path: /^\/api\/folders\/tree$/, kind: "read" },
  { method: "GET", path: new RegExp(`^${TAB}(/state|/guide)?$`), kind: "read" },
  { method: "POST", path: /^\/api\/remote-agent\/page$/, kind: "read" },
  { method: "POST", path: new RegExp(`^${TAB}/action$`), kind: "action" },
  { method: "POST", path: new RegExp(`^${TAB}/patch$`), kind: "write" },
  { method: "PUT", path: new RegExp(`^${TAB}/state$`), kind: "write" },
  { method: "POST", path: /^\/api\/helper\/(run|models)$/, kind: "run" },
];

/** Which grant a call from another device's agent needs, or null for calls that never cross devices. */
export function remoteRequestKind(method: string, pathname: string): RemoteKind | null {
  const route = ROUTES.find((r) => r.method === method && r.path.test(pathname));
  return route?.kind ?? null;
}

export function encodeRemoteAgent(agent: RemoteAgent): string {
  return Buffer.from(JSON.stringify(agent), "utf8").toString("base64url");
}

export function decodeRemoteAgent(value: unknown): RemoteAgent | undefined {
  if (typeof value !== "string" || !value || value.length > 64_000) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const thread = typeof r.thread === "string" ? r.thread.trim().slice(0, 60) : "";
  if (!thread) return undefined;
  const keys = Array.isArray(r.keys) ? r.keys.filter((k): k is string => typeof k === "string").map((k) => k.slice(0, 200)).slice(0, 200) : [];
  return {
    thread,
    ...(typeof r.title === "string" && r.title.trim() ? { title: r.title.trim().slice(0, 120) } : {}),
    trusted: r.trusted === true,
    ...(r.tainted === true ? { tainted: true } : {}),
    ...(r.noPages === true ? { noPages: true } : {}),
    rung: typeof r.rung === "string" ? r.rung.slice(0, 20) : "readonly",
    grants: normalizeThreadPageGrants(r.grants)?.filter((g) => !g.mention) ?? [],
    keys,
  };
}

/** How B names A's chat: never one of its own thread ids, so it owns no page and holds no card here. */
export function remoteThreadId(device: string, thread: string): string {
  return `@${device}/${thread}`;
}

/**
 * B's page reader for A's chat: no scope here (nothing reaches it by place), its grants from A, and
 * the keys the user wrote in that chat as read-only grants. A key that names no page is skipped.
 */
export function remoteReader(device: string, agent: RemoteAgent, pageId: (key: string) => string | undefined): PageReader {
  const keyed = agent.keys.flatMap((key): ThreadPageGrant[] => {
    const id = pageId(key);
    return id ? [{ kind: "page", id, read: true }] : [];
  });
  return {
    thread: remoteThreadId(device, agent.thread),
    scope: agent.noPages ? { kind: "workspace", ref: null } : { kind: "folder", ref: null },
    trusted: agent.trusted,
    grants: [...agent.grants, ...keyed],
  };
}

/** Why B refuses the call, or null when its grant covers it. */
export function remoteRefusal(kind: RemoteKind, grant: AgentGrant, rung: string, name: string): string | null {
  const where = `The user can turn it on in ${name}'s Settings → Devices.`;
  if (kind === "run") return grant.run ? null : `${name} does not let agents on this device run helpers there. ${where}`;
  if (!grant.read) return `${name} does not let agents on this device read its pages. ${where}`;
  if (kind === "write" && !grant.write) return `${name} does not let agents on this device change its pages. ${where}`;
  if (kind === "write" && rung === "readonly") return "This chat is Read-only, so it changes no pages on other devices.";
  return null;
}

/** For a board action: why its changes are refused (the action still answers reads), or null. */
export function remoteActionReadOnly(grant: AgentGrant, rung: string, name: string): string | null {
  if (rung === "readonly") return "This chat is Read-only, so this action, which changes the page, was refused.";
  if (!grant.write) return `${name} does not let agents on this device change its pages, so this action, which changes the page, was refused. The user can turn it on in ${name}'s Settings → Devices.`;
  return null;
}

/** Page keys on other devices in a text (scribe:@laptop/notes), with the device as written. */
export function deviceKeysInText(text: string): Array<{ device: string; key: string }> {
  return [...text.matchAll(/scribe:@([^/\s#)\]|]+)\/([a-z0-9._:-]+)/gi)].map((m) => ({
    device: m[1].toLowerCase(),
    key: `scribe:${m[2].toLowerCase().replace(/^(scribe:)+/, "").replace(/[.:-]+$/, "")}`,
  }));
}
