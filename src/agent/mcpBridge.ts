import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { log } from "../log.js";
import { bridgedToolName, toolPolicy, type ResolvedMcpServer } from "./mcpConfig.js";
import type { ApprovalDecision, ApprovalRequest } from "./providers/provider.js";
import type { Thread } from "./types.js";
import { isPlainRecord } from "./types.js";
import { McpPermissions, mcpApprovalOptions } from "./mcpPermissions.js";

/**
 * The user's MCP servers (mcpConfig.ts) for providers that take tools from the host rather than MCP
 * servers it would trust: Native (Pi) and Cursor, whose Auto-review fails MCP server calls closed.
 * Scribe connects to each server itself and hands its tools on as the provider's custom tools,
 * asking the user before each call the server's approve setting and the thread's approval cover.
 */

export type BridgedTool = {
  /** "<server>__<tool>" */
  name: string;
  server: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  call(args: Record<string, unknown>, opts: { toolCallId?: string; signal?: AbortSignal }): Promise<{ content: unknown[]; isError: boolean }>;
};

export type BridgeAsk = (req: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>;

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function transportFor(server: ResolvedMcpServer, cwd: string): Transport {
  if (server.transport === "stdio") {
    return new StdioClientTransport({
      command: server.command!,
      args: server.args,
      env: { ...(process.env as Record<string, string>), ...server.env },
      cwd: server.cwd ?? cwd,
      stderr: "ignore",
    });
  }
  const url = new URL(server.url!);
  const requestInit = Object.keys(server.headers).length ? { headers: server.headers } : undefined;
  return server.transport === "sse" ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit });
}

/** Whether a call to this server's tool waits for the user: never with full access, a server set to run without asking, or a tool set to Allow. */
export function bridgeAsks(thread: Pick<Thread, "approval">, server: Pick<ResolvedMcpServer, "approve" | "tools">, tool?: string): boolean {
  return thread.approval !== "full" && server.approve !== "auto" && !(tool && toolPolicy(server, tool) === "allow");
}

function summarizeArgs(args: Record<string, unknown>): string {
  const text = JSON.stringify(args, null, 2);
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

export class McpBridge {
  private clients: Client[] = [];
  private opening: Promise<BridgedTool[]> | null = null;

  constructor(
    readonly servers: ResolvedMcpServer[],
    /** Folder stdio servers start in when they name none. */
    readonly cwd: string,
    private thread: () => Pick<Thread, "approval"> & Partial<Pick<Thread, "id">>,
    private ask: () => BridgeAsk | undefined,
    /** A server that could not start; the session goes on without it. */
    private onError?: (server: string, message: string) => void,
    private permissions = new McpPermissions()
  ) {}

  tools(): Promise<BridgedTool[]> {
    this.opening ??= this.open();
    return this.opening;
  }

  private async open(): Promise<BridgedTool[]> {
    const lists = await Promise.all(this.servers.map((server) => this.connect(server)));
    const out: BridgedTool[] = [];
    const taken = new Set<string>();
    for (const tool of lists.flat()) {
      if (taken.has(tool.name)) continue;
      taken.add(tool.name);
      out.push(tool);
    }
    return out;
  }

  private async connect(server: ResolvedMcpServer): Promise<BridgedTool[]> {
    const client = new Client({ name: "scribe", version: "1" });
    try {
      await client.connect(transportFor(server, this.cwd), { timeout: CONNECT_TIMEOUT_MS });
      this.clients.push(client);
      const { tools } = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
      // Disabled tools are left out, so agents never see them.
      return tools.filter((tool) => toolPolicy(server, tool.name) !== "disable").map((tool) => ({
        name: bridgedToolName(server.name, tool.name),
        server: server.name,
        tool: tool.name,
        description: tool.description ?? "",
        inputSchema: { ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} },
        ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {}),
        call: (args, opts) => this.call(client, server, tool.name, args, opts),
      }));
    } catch (err) {
      void client.close().catch(() => undefined);
      const message = (err as Error).message || String(err);
      log(`MCP server ${server.name} did not start: ${message}`);
      this.onError?.(server.name, message);
      return [];
    }
  }

  private async call(
    client: Client,
    server: ResolvedMcpServer,
    tool: string,
    args: Record<string, unknown>,
    opts: { toolCallId?: string; signal?: AbortSignal }
  ): Promise<{ content: unknown[]; isError: boolean }> {
    const fail = (text: string) => ({ content: [{ type: "text", text }], isError: true });
    if (toolPolicy(server, tool) === "disable") return fail("This tool is disabled in Scribe's MCP settings.");
    if (bridgeAsks(this.thread(), server, tool) && !this.permissions.allows(server, tool, this.thread().id)) {
      const ask = this.ask();
      if (!ask) return fail("No active turn: nobody is there to approve this tool call.");
      try {
        const decision = await ask(
          {
            ...(opts.toolCallId ? { toolId: opts.toolCallId } : {}),
            tool: "other",
            title: `${server.name}: ${tool}`,
            detail: summarizeArgs(args),
            options: mcpApprovalOptions,
          },
          opts.signal
        );
        if (!this.permissions.grant(server, tool, this.thread().id, decision.optionId)) return fail(`The user denied this tool call${decision.note ? `: ${decision.note}` : "."}`);
      } catch (err) {
        return fail((err as Error).message || "Not allowed.");
      }
    }
    const timeout = server.timeout ?? CALL_TIMEOUT_MS;
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { signal: opts.signal, timeout, resetTimeoutOnProgress: true });
    return { content: Array.isArray(result.content) ? result.content.filter(isPlainRecord) : [], isError: result.isError === true };
  }

  close(): void {
    for (const client of this.clients) void client.close().catch(() => undefined);
    this.clients = [];
    this.opening = null;
  }
}
