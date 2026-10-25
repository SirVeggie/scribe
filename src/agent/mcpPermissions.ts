import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { dataDir } from "../config.js";
import { serversKey, type ResolvedMcpServer } from "./mcpConfig.js";
import type { ApprovalOption } from "./types.js";

export const mcpApprovalOptions: ApprovalOption[] = [
  { id: "allow", label: "Allow once", kind: "allow_once" },
  { id: "mcp", label: "Allow this server for this thread", description: "Every tool from this MCP server.", kind: "allow_always" },
  { id: "whitelist", label: "Always allow this tool", description: "In every thread, for this MCP server.", kind: "allow_always" },
  { id: "reject", label: "Deny", kind: "reject_once" },
];

type ServerLabel = { name: string; layer: string };
type Grants = { tools: string[]; threads: Record<string, string[]>; servers?: Record<string, ServerLabel> };
export type McpGrant = { key: string; tool?: string; thread?: string; server: ServerLabel | null };
export class McpPermissions {
  constructor(private file = path.join(dataDir(), "agent", "mcp-permissions.json")) {}

  private read(): Grants {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(value.tools) && value.tools.every((v: unknown) => typeof v === "string") && value.threads && typeof value.threads === "object" &&
        Object.values(value.threads).every((list) => Array.isArray(list) && list.every((v) => typeof v === "string"))) return value;
      throw new Error("Invalid MCP permissions file.");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return { tools: [], threads: {} };
  }

  private key(server: ResolvedMcpServer): string {
    return createHash("sha256").update(serversKey([{ ...server, approve: "ask" }])).digest("hex");
  }

  private write(grants: Grants): void {
    // Keep only display metadata for configurations that still have grants.
    const keys = new Set([...grants.tools.map((entry) => entry.split(":")[0]), ...Object.values(grants.threads).flat()]);
    if (grants.servers) for (const key of Object.keys(grants.servers)) if (!keys.has(key)) delete grants.servers[key];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(grants, null, 2) + "\n");
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  list(servers: ResolvedMcpServer[] = []): McpGrant[] {
    const grants = this.read();
    const labels = new Map(servers.map((server) => [this.key(server), { name: server.name, layer: server.layer }]));
    const server = (key: string) => labels.get(key) ?? grants.servers?.[key] ?? null;
    return [
      ...grants.tools.map((entry) => {
        const colon = entry.indexOf(":");
        const key = entry.slice(0, colon);
        return { key, tool: entry.slice(colon + 1), server: server(key) };
      }),
      ...Object.entries(grants.threads).flatMap(([thread, keys]) => keys.map((key) => ({ key, thread, server: server(key) }))),
    ];
  }

  revoke(key: string, tool?: string, thread?: string): void {
    const grants = this.read();
    if (thread) {
      const remaining = grants.threads[thread]?.filter((entry) => entry !== key) ?? [];
      if (remaining.length) grants.threads[thread] = remaining;
      else delete grants.threads[thread];
    } else if (tool) grants.tools = grants.tools.filter((entry) => entry !== `${key}:${tool}`);
    else throw new Error("A tool or thread is required.");
    this.write(grants);
  }

  pruneThreads(existing: Iterable<string>): void {
    const grants = this.read(), keep = new Set(existing);
    const stale = Object.keys(grants.threads).filter((thread) => !keep.has(thread));
    if (!stale.length) return;
    for (const thread of stale) delete grants.threads[thread];
    this.write(grants);
  }

  allows(server: ResolvedMcpServer, tool: string, thread?: string): boolean {
    const grants = this.read(), key = this.key(server);
    return grants.tools.includes(`${key}:${tool}`) || Boolean(thread && grants.threads[thread]?.includes(key));
  }

  grant(server: ResolvedMcpServer, tool: string, thread: string | undefined, option: string): boolean {
    if (option === "allow") return true;
    if (option !== "whitelist" && option !== "mcp") return false;
    if (option === "mcp" && !thread) return false;
    const grants = this.read(), key = this.key(server);
    const list = option === "whitelist" ? grants.tools : (grants.threads[thread!] ??= []);
    const entry = option === "whitelist" ? `${key}:${tool}` : key;
    if (!list.includes(entry)) list.push(entry);
    (grants.servers ??= {})[key] = { name: server.name, layer: server.layer };
    this.write(grants);
    return true;
  }
}
