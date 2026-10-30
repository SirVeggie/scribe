/** Live acceptance probe for #297. Uses scratch Scribe data and an ephemeral Codex thread. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CodexRpc, type RpcMessage } from "../src/agent/providers/codexRpc.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-read-probe-"));
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
// The board UI's headers: a local tool acts as the user with them on the board port (src/callers.ts, #916).
const user = { "sec-fetch-site": "same-origin", origin: base };
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
    method: "POST", headers: { "Content-Type": "application/json", ...user },
    body: JSON.stringify({ provider: "codex", mode: "ask", approval: "ask", cwd,
      scope: { kind: "workspace", ref: cwd }, useWorktree: false, remember: false }),
  });
  const created = await response.json() as { thread: { id: string } };
  assert.ok(created.thread?.id, JSON.stringify(created));
  const tools: Record<string, unknown>[] = [];
  let finished!: (message: RpcMessage) => void;
  const done = new Promise<RpcMessage>((resolve) => { finished = resolve; });
  const timer = setTimeout(() => finished({ error: { message: "Live turn timed out" } }), 180_000);
  const require = createRequire(import.meta.url);
  rpc = CodexRpc.launch(require.resolve("@openai/codex/bin/codex.js"),
    Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    (message) => {
      if (message.id != null && message.method) {
        console.log(JSON.stringify({ request: message.method, params: message.params }));
        rpc!.reject(message.id, "No approvals or additional input in this probe"); return;
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
    await rpc.call("initialize", { clientInfo: { name: "scribe-read-probe", version: "1" }, capabilities: { experimentalApi: true } });
    rpc.notify("initialized");
    const started = await rpc.call("thread/start", {
      cwd, sandbox: "read-only", approvalPolicy: "on-request", ephemeral: true,
      developerInstructions: "This is a dedicated MCP acceptance test. Use only scribe read_file. Do not run shell commands or other tools. Do not request approvals. Execute all three requested reads even when the outside read fails.",
      config: { web_search: "disabled", mcp_servers: { scribe: {
        command: process.execPath, args: ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, path.resolve("src/index.ts")],
        env: { SCRIBE_HOME: env.SCRIBE_HOME, SCRIBE_PORT: env.SCRIBE_PORT, SCRIBE_THREAD: created.thread.id, SCRIBE_PAGES: "off" },
      } } },
    }) as { thread: { id: string } };
    const status = await rpc.call("mcpServerStatus/list", { threadId: started.thread.id, serverName: "scribe" }) as { data: Array<{ name: string; tools: Record<string, unknown>; runtimeStatus?: unknown }> };
    console.log(JSON.stringify({ mcp: status.data.map((server) => ({ name: server.name, tools: Object.keys(server.tools), runtimeStatus: server.runtimeStatus })) }));
    assert.ok(status.data.some((server) => server.name === "scribe" && server.tools.read_file), "read_file must be discovered before starting a model turn");
    await rpc.call("turn/start", { threadId: started.thread.id, input: [{ type: "text",
      text: "Call scribe read_file three times: allowed.txt with offset 1 limit 2, then allowed.txt with offset 3 limit 2, then ../outside.txt. Report the results. The third call must be denied. Do not use a shell.", text_elements: [] }] });
    const completion = await done;
    assert.equal(completion.error, undefined, completion.error?.message);
    assert.equal((completion.params?.turn as { status: string })?.status, "completed");
    assert.ok(!tools.some((item) => item.type === "commandExecution"), "Probe used a shell");
    const reads = tools.filter((item) => item.type === "mcpToolCall" && item.tool === "read_file");
    assert.equal(reads.length, 3, "Expected exactly three read_file calls");
    const results = reads.map((item) => JSON.stringify(item.result));
    assert.match(results[0], /alpha/);
    assert.match(results[0], /nextOffset/);
    assert.match(results[1], /gamma/);
    assert.match(results[2], /outside the workspace scope/);
    assert.ok(!results[2].includes("OUTSIDE_FIXTURE"));
    console.log("PASS: live Codex read_file allowed, paginated, and denied outside scope; no shell calls.");
  } finally { clearTimeout(timer); }
} finally {
  rpc?.close();
  try { await fetch(`${base}/api/shutdown`, { method: "POST", headers: { ...user } }); } catch { /* already stopped */ }
  daemon.kill();
  // Scratch directory is left for inspection. Never touch the user's production daemon or data.
  console.log(`Scratch evidence: ${root}`);
}
