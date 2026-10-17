/**
 * Live probe for #583. Codex asks before an MCP tool without a read-only annotation runs
 * (mcpServer/elicitation/request, _meta.codex_approval_kind); a declined request reaches the
 * model as "user rejected MCP tool call". Declines the first request and accepts the next.
 * PROBE_SANDBOX=read-only PROBE_POLICY=never is Pages mode with Full access: Codex refuses the tool
 * without asking. PROBE_APPROVE=1 adds default_tools_approval_mode "approve", as Scribe's chats do.
 * Uses scratch Scribe data and an ephemeral Codex thread.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CodexRpc, type RpcMessage } from "../src/agent/providers/codexRpc.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-approval-probe-"));
const cwd = path.join(root, "workspace");
await fs.mkdir(cwd);
await fs.writeFile(path.join(cwd, "allowed.txt"), "alpha\nbeta\ngamma\n");
await fs.writeFile(path.join(root, "outside.txt"), "OUTSIDE_FIXTURE\n");
const socket = net.createServer();
await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = (socket.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
const env = { ...process.env, SCRIBE_HOME: path.join(root, "data"), SCRIBE_PORT: String(port) };
const daemon = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "--daemon"], {
  cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
});
let daemonErrors = "";
daemon.stderr.on("data", (chunk: Buffer) => { daemonErrors = (daemonErrors + chunk.toString()).slice(-2000); });
const base = `http://127.0.0.1:${port}`;
// The daemon treats requests without this token as an anonymous agent. It is read from the scratch
// data folder once the daemon is up, because the daemon creates the file at startup.
async function localToken(home: string): Promise<string> {
  return (await fs.readFile(path.join(home, "local-token"), "utf8").catch(() => "")).trim();
}
let rpc: CodexRpc | undefined;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* starting */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Scratch daemon failed: ${daemonErrors}`);
  const response = await fetch(`${base}/api/agent/threads`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-scribe-local-token": await localToken(path.join(root, "data")) },
    body: JSON.stringify({ provider: "codex", mode: "code", approval: "ask", cwd, useWorktree: false, remember: false }),
  });
  const created = await response.json() as { thread: { id: string } };
  assert.ok(created.thread?.id, JSON.stringify(created));
  const tools: Record<string, unknown>[] = [];
  const elicitations: Record<string, unknown>[] = [];
  let finished!: (message: RpcMessage) => void;
  const done = new Promise<RpcMessage>((resolve) => { finished = resolve; });
  const timer = setTimeout(() => finished({ error: { message: "Live turn timed out" } }), 180_000);
  const require = createRequire(import.meta.url);
  rpc = CodexRpc.launch(require.resolve("@openai/codex/bin/codex.js"),
    Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    (message) => {
      if (message.id != null && message.method) {
        console.log(JSON.stringify({ request: message.method, params: message.params }));
        if (message.method !== "mcpServer/elicitation/request") { rpc!.reject(message.id, "No approvals or additional input in this probe"); return; }
        elicitations.push(message.params ?? {});
        rpc!.reply(message.id, elicitations.length === 1 ? { action: "decline", content: null, _meta: null } : { action: "accept", content: {}, _meta: null });
        return;
      }
      if (message.method === "item/completed") {
        const item = message.params?.item as Record<string, unknown> | undefined;
        if (item?.type === "agentMessage") console.log(JSON.stringify({ text: item.text }));
        if (item?.type === "mcpToolCall" || item?.type === "commandExecution") {
          tools.push(item);
          console.log(JSON.stringify({ type: item.type, tool: item.tool, arguments: item.arguments, result: item.result, error: item.error }));
        }
      }
      if (message.method === "turn/completed") finished(message);
    }, (error) => finished({ error: { message: error.message } }));
  try {
    await rpc.call("initialize", { clientInfo: { name: "scribe-approval-probe", version: "1" }, capabilities: { experimentalApi: true } });
    rpc.notify("initialized");
    const started = await rpc.call("thread/start", {
      cwd, sandbox: process.env.PROBE_SANDBOX ?? "workspace-write", approvalPolicy: process.env.PROBE_POLICY ?? "on-request", approvalsReviewer: "user", ephemeral: true,
      developerInstructions: "This is a dedicated MCP acceptance test. Use only the scribe page_show tool. Do not run shell commands or other tools.",
      config: { web_search: "disabled", mcp_servers: { scribe: {
        command: process.execPath, args: ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, path.resolve("src/index.ts")],
        env: { SCRIBE_HOME: env.SCRIBE_HOME, SCRIBE_PORT: env.SCRIBE_PORT, SCRIBE_THREAD: created.thread.id, SCRIBE_PROVIDER: "codex" },
        ...(process.env.PROBE_APPROVE ? { default_tools_approval_mode: "approve" } : {}),
      } } },
    }) as { thread: { id: string } };
    await rpc.call("turn/start", { threadId: started.thread.id, input: [{ type: "text",
      text: "Call scribe page_show with key approval-probe, title Approval probe, html <p>probe</p> and background true. If the call fails, make the same call exactly once more. Then report both results verbatim. Do not use a shell.", text_elements: [] }] });
    const completion = await done;
    assert.equal(completion.error, undefined, completion.error?.message);
    assert.equal((completion.params?.turn as { status: string })?.status, "completed");
    const shows = tools.filter((item) => item.type === "mcpToolCall" && item.tool === "page_show");
    if (process.env.PROBE_APPROVE) {
      assert.equal(elicitations.length, 0, "A pre-approved server must not be asked about");
      assert.match(JSON.stringify(shows[0]?.result), /approval-probe/);
      console.log("PASS: with default_tools_approval_mode approve, page_show runs without an approval request.");
    } else if (process.env.PROBE_POLICY === "never") {
      assert.equal(elicitations.length, 0);
      assert.match(JSON.stringify(shows[0]), /requires approval, but approval policy is never/);
      console.log("PASS: approvals never under a sandbox refuses the tool without asking.");
    } else {
      assert.equal(elicitations.length, 2, "Expected one approval request per page_show call");
      assert.equal(shows.length, 2, "Expected exactly two page_show calls");
      assert.match(JSON.stringify(shows[0]), /user rejected MCP tool call/);
      assert.match(JSON.stringify(shows[1].result), /approval-probe/);
      console.log("PASS: a declined approval request is reported as a user rejection; an accepted one runs the tool.");
    }
  } finally { clearTimeout(timer); }
} finally {
  rpc?.close();
  try { await fetch(`${base}/api/shutdown`, { method: "POST", headers: { "x-scribe-local-token": await localToken(path.join(root, "data")) } }); } catch { /* already stopped */ }
  daemon.kill();
  // Scratch directory is left for inspection. Never touch the user's production daemon or data.
  console.log(`Scratch evidence: ${root}`);
}
