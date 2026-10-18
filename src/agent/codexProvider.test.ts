import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import type { ChildProcess } from "node:child_process";
import { CodexRpc, type RpcMessage } from "./providers/codexRpc.js";
import { CodexSession, readCodexPlanUsage, syncAuthFiles, guardianDenialEvent } from "./providers/codex.js";
import type { ApprovalDecision, ApprovalRequest, RunSink, SessionContext } from "./providers/provider.js";
import { FALLBACK_MODELS, gitCommonDir, loginEnv, loginUrlFromOutput, mapCodexModels, mapUsage, mcpConfig, sandboxFor, threadOptions, turnStartOverrides, turnPermissionOverrides, windowsSandboxConfig } from "./providers/codex.js";
import { codexPermissions, permissionBoundaryProblem, scribeToolAvailability, workerPermissionProblem } from "./effectivePermissions.js";
import type { Thread } from "./types.js";
import { McpBridge } from "./mcpBridge.js";
import type { ResolvedMcpServer } from "./mcpConfig.js";

const thread = (over: Partial<Thread> = {}): Pick<Thread, "model" | "effort" | "mode" | "approval" | "web" | "custom" | "cwd"> => ({
  model: "gpt-5-codex",
  effort: "medium",
  mode: "code",
  approval: "edits",
  web: "on",
  cwd: null,
  ...over,
});

test("sandboxFor: Read-only and Board are read-only; Full access drops the sandbox", () => {
  // The rung decides, even on a thread whose mode was not settled.
  assert.equal(sandboxFor(thread({ mode: "code", approval: "readonly" })), "read-only");
  assert.equal(sandboxFor(thread({ mode: "board" })), "read-only");
  assert.equal(sandboxFor(thread({ mode: "code", approval: "edits" })), "workspace-write");
  assert.equal(sandboxFor(thread({ mode: "code", approval: "auto" })), "workspace-write");
  assert.equal(sandboxFor(thread({ mode: "code", approval: "full" })), "danger-full-access");
});

test("threadOptions: the reading rungs keep Codex's shell only with a workspace (#722)", () => {
  const features = (over: Partial<Thread>) => (threadOptions(thread(over), "/work").config as Record<string, unknown>).features;
  assert.deepEqual(features({ mode: "board" }), { shell_tool: false, unified_exec: false });
  assert.equal(features({ mode: "board", cwd: "/work" }), undefined);
  assert.deepEqual(features({ mode: "board", cwd: "/work", custom: { id: "m", name: "M", off: ["shell"] } as Thread["custom"] }), { shell_tool: false, unified_exec: false });
  assert.equal(features({ mode: "code" }), undefined);
});

test("threadOptions maps app-server model, sandbox, web and interactive approvals", () => {
  const code = threadOptions(thread(), "/work");
  assert.equal(code.model, "gpt-5-codex");
  assert.equal(code.sandbox, "workspace-write");
  assert.equal(code.cwd, "/work");
  assert.equal((code.config as Record<string, unknown>).model_reasoning_effort, "medium");
  assert.equal(code.approvalPolicy, "on-request");
  assert.equal((code.config as Record<string, unknown>).web_search, "live");
  assert.equal((code.config as Record<string, unknown>)["sandbox_workspace_write.network_access"], true);

  const pages = threadOptions(thread({ model: "default", effort: null, mode: "board", web: "off" }), "/scratch");
  assert.equal(pages.model, undefined);
  assert.equal(pages.sandbox, "read-only");
  assert.equal((pages.config as Record<string, unknown>).web_search, "disabled");
  assert.equal((pages.config as Record<string, unknown>)["sandbox_workspace_write.network_access"], false);
  assert.equal((pages.config as Record<string, unknown>).model_reasoning_effort, undefined);
  assert.equal(threadOptions(thread({ approval: "full" }), "/work").approvalPolicy, "never");
  assert.equal((threadOptions(thread({ web: "limited" }), "/work").config as Record<string, unknown>).web_search, "disabled");
});

test("windowsSandboxConfig selects the unelevated sandbox and opens a worktree's git dir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-codex-git-"));
  try {
    const main = path.join(root, "main");
    const wtGit = path.join(main, ".git", "worktrees", "wt");
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, "commondir"), "../..\n");
    const wt = path.join(root, "wt");
    fs.mkdirSync(path.join(wt, "src"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtGit}\n`);

    assert.equal(gitCommonDir(path.join(wt, "src")), path.join(main, ".git"));
    assert.equal(gitCommonDir(main), path.join(main, ".git"));
    assert.deepEqual(windowsSandboxConfig("workspace-write", wt, "win32"), {
      "windows.sandbox": "unelevated",
      "sandbox_workspace_write.writable_roots": [path.join(main, ".git")],
    });
    assert.deepEqual(windowsSandboxConfig("workspace-write", wt, "linux"), {});
    assert.deepEqual(windowsSandboxConfig("read-only", wt, "win32"), { "windows.sandbox": "unelevated" });
    assert.deepEqual(windowsSandboxConfig("danger-full-access", wt, "win32"), {});
    const config = threadOptions(thread({ approval: "auto" }), wt, "win32").config as Record<string, unknown>;
    assert.equal(config["windows.sandbox"], "unelevated");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("turnStartOverrides always send model and effort; Default is JSON null", () => {
  assert.deepEqual(turnStartOverrides(thread()), { model: "gpt-5-codex", effort: "medium" });
  assert.deepEqual(turnStartOverrides(thread({ model: "gpt-6.1-sol", effort: "ultra" })), { model: "gpt-6.1-sol", effort: "ultra" });
  assert.deepEqual(turnStartOverrides(thread({ model: "default", effort: null })), { model: null, effort: null });
  assert.deepEqual(turnStartOverrides(thread({ model: "", effort: "unknown" })), { model: null, effort: null });
});

test("mcpConfig registers the board server as scribe with the thread id", () => {
  const config = mcpConfig({ boardMcp: { command: "node", args: ["dist/index.js"], env: { SCRIBE_PORT: "4747" } } }, "th_abc", true);
  const server = (config.mcp_servers as { scribe: { command: string; args: string[]; env: Record<string, string> } }).scribe;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["dist/index.js"]);
  assert.equal(server.env.SCRIBE_PORT, "4747");
  assert.equal(server.env.SCRIBE_THREAD, "th_abc");
  assert.equal(server.env.SCRIBE_PROVIDER, "codex");
  assert.equal(server.env.SCRIBE_PAGES, undefined);
  // Codex must not ask about Scribe's own tools: with approvals "never" under a sandbox it refuses instead (#583).
  assert.equal((server as { default_tools_approval_mode?: string }).default_tools_approval_mode, "approve");

  const none = mcpConfig({ boardMcp: { command: "node", args: [], env: {} } }, "th_none", false);
  const env = (none.mcp_servers as { scribe: { env: Record<string, string> } }).scribe.env;
  assert.equal(env.SCRIBE_PAGES, "off");
  assert.equal(env.SCRIBE_THREAD, "th_none");
});

test("Codex approval modes select the native reviewer without widening the mode sandbox", () => {
  for (const mode of ["code", "board"] as const) {
    for (const approval of ["edits", "auto", "full"] as const) {
      const opts = threadOptions(thread({ mode, approval }), "/work");
      assert.equal(opts.approvalsReviewer, approval === "auto" ? "auto_review" : "user");
      assert.equal(opts.approvalPolicy, approval === "full" ? "never" : "on-request");
      assert.equal(opts.sandbox, mode !== "code" ? "read-only" : approval === "full" ? "danger-full-access" : "workspace-write");
    }
  }
});

test("mapUsage copies Codex exec token fields", () => {
  assert.deepEqual(
    mapUsage({
      input_tokens: 10,
      cached_input_tokens: 3,
      cache_write_input_tokens: 2,
      output_tokens: 4,
      reasoning_output_tokens: 5,
    }),
    { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 5 }
  );
});

test("fallback models include Default (omit --model) and Codex ids", () => {
  assert.equal(FALLBACK_MODELS[0]?.id, "default");
  assert.ok(FALLBACK_MODELS.some((m) => m.id === "gpt-5-codex"));
  assert.ok(FALLBACK_MODELS.every((m) => m.provider === "codex" && m.efforts.length));
});

test("mapCodexModels keeps the live Plus catalog and drops hidden rows", () => {
  const models = mapCodexModels([
    {
      id: "gpt-reserve",
      model: "gpt-reserve",
      displayName: "GPT-Reserve",
      hidden: true,
      supportedReasoningEfforts: ["low", "medium"],
    },
    {
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      hidden: false,
      isDefault: false,
      description: "Older Sol",
      supportedReasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "low",
    },
    {
      id: "gpt-6.1-sol",
      model: "gpt-6.1-sol",
      displayName: "GPT-6.1-Sol",
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "low",
    },
    { id: "down", model: "down", hidden: false, isCurrentlyUnavailable: true },
  ]);
  assert.deepEqual(
    models.map((m) => m.id),
    ["gpt-6.1-sol", "gpt-5.6-sol"]
  );
  assert.equal(models[0]?.label, "GPT-6.1-Sol");
  assert.equal(models[0]?.defaultEffort, "low");
  assert.ok(models[0]?.efforts.some((e) => e.id === "ultra" && e.label === "Ultra"));
  assert.equal(models[1]?.description, "Older Sol");
});

test("threadOptions passes a live catalog id such as gpt-6.1-sol", () => {
  const opts = threadOptions(thread({ model: "gpt-6.1-sol", effort: "ultra" }), "/work");
  assert.equal(opts.model, "gpt-6.1-sol");
  assert.equal((opts.config as Record<string, unknown>).model_reasoning_effort, "ultra");
});

test("loginUrlFromOutput picks the ChatGPT HTTPS URL and skips localhost", () => {
  assert.equal(
    loginUrlFromOutput("Starting login server on http://127.0.0.1:1455\nOpening https://auth.openai.com/oauth/authorize?client_id=abc\n"),
    "https://auth.openai.com/oauth/authorize?client_id=abc"
  );
  assert.equal(loginUrlFromOutput("If the browser did not open, visit:\nhttps://chatgpt.com/auth/login?foo=bar.\n"), "https://chatgpt.com/auth/login?foo=bar");
  assert.equal(loginUrlFromOutput("\x1b[32mhttps://auth.openai.com/start\x1b[0m"), "https://auth.openai.com/start");
  assert.equal(loginUrlFromOutput("only http://localhost:1455/callback"), null);
  assert.equal(loginUrlFromOutput("no urls here"), null);
});

test("loginEnv drops CODEX_HOME so ChatGPT auth lands in ~/.codex", () => {
  const env = loginEnv({ PATH: "/bin", CODEX_HOME: "/tmp/scribe" });
  assert.equal(env.CODEX_HOME, undefined);
  assert.equal(env.PATH, "/bin");
});

function rpcFixture(onMessage: (message: RpcMessage) => void, onClose: (error: Error) => void) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const sent: RpcMessage[] = [];
  child.stdin.on("data", (data: Buffer) => { sent.push(JSON.parse(data.toString())); });
  const rpc = new CodexRpc(child as unknown as ChildProcess, onMessage, onClose);
  return { rpc, child, sent, emit(message: unknown) { child.stdout.write(JSON.stringify(message) + "\n"); } };
}

test("Codex RPC separates server requests from responses with the same id and decodes split UTF-8", async () => {
  const incoming: RpcMessage[] = [];
  const f = rpcFixture((message) => incoming.push(message), () => {});
  const result = f.rpc.call("initialize");
  f.emit({ id: 1, method: "item/fileChange/requestApproval", params: {} });
  assert.equal(incoming.length, 1);
  f.rpc.reply(1, { decision: "decline" });
  f.emit({ id: 1, result: { ready: true } });
  assert.deepEqual(await result, { ready: true });
  const data = Buffer.from(JSON.stringify({ method: "warning", params: { text: "🙂" } }) + "\n");
  const split = data.indexOf(Buffer.from("🙂")) + 1;
  f.child.stdout.write(data.subarray(0, split));
  f.child.stdout.write(data.subarray(split));
  assert.equal(incoming[1].params?.text, "🙂");
  f.rpc.close();
});

test("Codex RPC rejects outstanding calls on process exit", async () => {
  let closed = "";
  const f = rpcFixture(() => {}, (error) => { closed = error.message; });
  const result = f.rpc.call("thread/start");
  f.child.emit("exit", 1);
  await assert.rejects(result, /exited/);
  assert.match(closed, /exited/);
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function sessionFixture(nativeId: string | null = null, approval: Thread["approval"] = "edits", limits?: SessionContext["limits"],
  mcp?: { servers: ResolvedMcpServer[]; bridge: ConstructorParameters<typeof CodexSession>[6] },
  worker = false, scope: Thread["scope"] = { kind: "page", ref: "board" }) {
  let f: ReturnType<typeof rpcFixture>;
  const reviews: unknown[] = [];
  const session = new CodexSession({ ...thread({ approval }), id: "scribe-thread", nativeId, cwd: "/work", scope } as Thread,
    { scratchDir: "/scratch", boardMcp: { command: "node", args: [], env: {} }, webAllowlist: () => [], limits, isWorker: () => worker,
      ...(mcp ? { mcpServers: () => mcp.servers } : {}) } as SessionContext,
    () => {}, (message, close) => { f = rpcFixture(message, close); return f.rpc; }, () => {}, (_message, extra) => { reviews.push(extra); }, mcp?.bridge);
  const seen = { text: "", steered: [] as string[], approvals: [] as string[], output: "", tools: [] as string[], reviews, notices: [] as Array<{ level: string; text: string }> };
  const sink: RunSink = {
    nativeId() {}, text(delta) { seen.text += delta; }, reasoning() {}, breakBlock() {}, toolStart(tool) { seen.tools.push(tool.toolId); },
    toolUpdate(_id, patch) { if (patch.output !== undefined) seen.output = patch.output; }, beforeWrite: async () => {},
    approval: async (req) => { seen.approvals.push(req.tool); return { optionId: "decline" }; },
    question: async () => ({ answers: { q: ["Yes"] } }),
    todos() {}, usage() {}, notice(level, text) { seen.notices.push({ level, text }); }, commands() {}, title() {}, steered(id) { seen.steered.push(id); },
  };
  async function start(policy: Record<string, unknown> = {}, tools: Record<string, unknown> = { page_action: {}, page_show: {} }) {
    const run = session.run({ text: "hello", images: [], documents: [], instructions: "Scribe instructions" }, sink);
    await tick();
    const init = f!.sent.find((message) => message.method === "initialize")!;
    f!.emit({ id: init.id, result: {} });
    await tick();
    assert.ok(f!.sent.some((message) => message.method === "initialized"));
    const start = f!.sent.find((message) => message.method === (nativeId ? "thread/resume" : "thread/start"))!;
    assert.equal(start.params?.approvalPolicy, approval === "full" ? "never" : "on-request");
    assert.equal(start.params?.approvalsReviewer, approval === "auto" ? "auto_review" : "user");
    assert.equal(start.params?.sandbox, approval === "full" ? "danger-full-access" : "workspace-write");
    f!.emit({ id: start.id, result: { thread: { id: "native-thread" }, ...policy } });
    await tick();
    if (worker && scope.kind !== "workspace") {
      const inventory = f!.sent.find((message) => message.method === "mcpServerStatus/list")!;
      assert.ok(inventory);
      assert.equal(inventory.params?.threadId, "native-thread");
      assert.equal(inventory.params?.serverName, "scribe");
      f!.emit({ id: inventory.id, result: { data: [{ name: "scribe", tools }], nextCursor: null } });
      await tick();
    }
    const turn = f!.sent.find((message) => message.method === "turn/start");
    if (!turn) return { run };
    f!.emit({ method: "turn/started", params: { threadId: "native-thread", turn: { id: "turn-1" } } });
    f!.emit({ id: turn.id, result: { turn: { id: "turn-1" } } });
    await tick();
    return { run };
  }
  return { session, seen, sink, start, get f() { return f!; }, complete(status = "completed") {
    f!.emit({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "turn-1", status } } });
  } };
}

test("Codex quota reader checks auth without forcing refresh and reads only account quota", async () => {
  const calls: Array<[string, unknown]> = [];
  const report = { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 25 } } };
  assert.equal(await readCodexPlanUsage(async (method, params) => {
    calls.push([method, params]);
    return method === "account/read" ? { account: { type: "chatgpt" } } : report;
  }), report);
  assert.deepEqual(calls, [["account/read", { refreshToken: false }], ["account/rateLimits/read", undefined]]);
  await assert.rejects(readCodexPlanUsage(async () => ({ account: null })), /authentication required/);
  await assert.rejects(readCodexPlanUsage(async () => ({ account: { type: "apiKey" } })), /ChatGPT login/);
  await assert.rejects(readCodexPlanUsage(async () => { throw new Error("401 expired"); }), /401 expired/);
});

test("Codex account quota notifications are forwarded even between turns", async () => {
  const reports: unknown[] = [];
  const f = sessionFixture(null, "edits", (provider, info) => { assert.equal(provider, "codex"); reports.push(info); });
  const { run } = await f.start();
  const first = { rateLimits: { limitId: "codex", primary: { usedPercent: 30 } } };
  f.f.emit({ method: "account/rateLimits/updated", params: first });
  f.complete();
  await run;
  const second = { rateLimits: { limitId: "other", primary: { usedPercent: 40 } } };
  f.f.emit({ method: "account/rateLimits/updated", params: second });
  assert.deepEqual(reports, [first, second]);
  f.session.dispose();
});

test("Codex app-server streams text once, forwards approval replies and marks steering only on user item", async () => {
  const f = sessionFixture();
  const { run } = await f.start();
  f.f.emit({ method: "item/agentMessage/delta", params: { threadId: "native-thread", turnId: "turn-1", itemId: "a", delta: "Hello" } });
  f.f.emit({ method: "item/completed", params: { threadId: "native-thread", turnId: "turn-1", item: { id: "a", type: "agentMessage", text: "Hello world" } } });
  assert.equal(f.seen.text, "Hello world");
  f.f.emit({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: "native-thread", turnId: "turn-1", itemId: "shell", command: "echo hello" } });
  await tick();
  assert.deepEqual(f.seen.approvals, ["execute"]);
  assert.deepEqual(f.f.sent.find((message) => message.id === "approval")?.result, { decision: "decline" });
  const id = f.session.steer({ text: "focus on tests", images: [], documents: [] });
  await tick();
  const steer = f.f.sent.find((message) => message.method === "turn/steer")!;
  assert.equal(steer.params?.expectedTurnId, "turn-1");
  f.f.emit({ id: steer.id, result: { turnId: "turn-1" } });
  await tick();
  assert.deepEqual(f.seen.steered, []);
  f.f.emit({ method: "item/started", params: { threadId: "native-thread", turnId: "turn-1", item: { id: "u", type: "userMessage", clientId: id } } });
  assert.deepEqual(f.seen.steered, [id]);
  f.complete();
  assert.deepEqual(await run, { status: "done" });
  f.session.dispose();
});

test("Codex allowed reviews stay out of chat while normal tool activity and full diagnostics remain", async () => {
  const f = sessionFixture(null, "auto");
  const { run } = await f.start();
  const params = { threadId: "native-thread", turnId: "turn-1", reviewId: "r1", targetItemId: "mcp",
    action: { type: "mcpToolCall", server: "scribe", toolName: "page_action" } };
  f.f.emit({ method: "item/started", params: { threadId: "native-thread", turnId: "turn-1",
    item: { id: "mcp", type: "mcpToolCall", server: "scribe", tool: "page_action", arguments: {}, status: "inProgress" } } });
  const started = { ...params, review: { status: "inProgress" } };
  const approved = { ...params, review: { status: "approved", rationale: "Routine page update", riskLevel: "low", userAuthorization: "high" } };
  const warning = { threadId: "native-thread", message: "Approved: Routine page update. Risk: low; authorization: high." };
  f.f.emit({ method: "item/autoApprovalReview/started", params: started });
  f.f.emit({ method: "guardianWarning", params: warning });
  f.f.emit({ method: "item/autoApprovalReview/completed", params: approved });
  assert.deepEqual(f.seen.notices.filter((n) => !n.text.startsWith("Codex permissions:")), []);
  assert.deepEqual(f.seen.tools, ["mcp"]);
  assert.deepEqual(f.seen.reviews, [
    { scribeThreadId: "scribe-thread", method: "item/autoApprovalReview/started", ...started },
    { scribeThreadId: "scribe-thread", method: "guardianWarning", ...warning },
    { scribeThreadId: "scribe-thread", method: "item/autoApprovalReview/completed", ...approved },
  ]);
  assert.deepEqual(f.seen.approvals, []);
  assert.equal(f.f.sent.filter((message) => message.result && !message.method).length, 0);
  f.complete();
  assert.equal((await run).status, "done");
  f.session.dispose();
});

test("Codex denials and review failures show one compact notice per review without granting access", async () => {
  const f = sessionFixture(null, "auto");
  const { run } = await f.start();
  const params = { threadId: "native-thread", turnId: "turn-1", targetItemId: "shell",
    action: { type: "command", command: "echo hello", cwd: "/work" } };
  const reason = "Explicit permission required.\n" + "Risk and authorization detail. ".repeat(40);
  const denied = { ...params, reviewId: "denied", review: { status: "denied", rationale: reason } };
  f.f.emit({ method: "item/autoApprovalReview/started", params: denied });
  f.f.emit({ method: "guardianWarning", params: { threadId: "native-thread", message: reason } });
  f.f.emit({ method: "item/autoApprovalReview/completed", params: denied });
  f.f.emit({ method: "item/autoApprovalReview/completed", params: denied });
  for (const status of ["timedOut", "aborted", "futureStatus"]) {
    const payload = { ...params, reviewId: status, review: { status } };
    f.f.emit({ method: "item/autoApprovalReview/completed", params: payload });
    f.f.emit({ method: "item/autoApprovalReview/completed", params: payload });
  }
  f.f.emit({ method: "item/autoApprovalReview/completed", params: { ...params, reviewId: "network", targetItemId: null,
    action: { type: "networkAccess", target: "example.com:443" }, review: { status: "denied" } } });
  const count = f.seen.notices.length;
  const logCount = f.seen.reviews.length;
  f.f.emit({ method: "item/autoApprovalReview/completed", params: { ...denied, threadId: "other" } });
  f.f.emit({ method: "item/autoApprovalReview/completed", params: { ...denied, turnId: "old" } });
  assert.equal(f.seen.notices.length, count);
  assert.equal(f.seen.reviews.length, logCount);
  assert.deepEqual(f.seen.notices.filter((n) => !n.text.startsWith("Codex permissions:")).map((n) => n.level), ["warn", "error", "error", "error", "warn"]);
  const reviewNotices = f.seen.notices.filter((n) => !n.text.startsWith("Codex permissions:"));
  assert.match(reviewNotices[0].text, /denied: echo hello: Explicit permission required/);
  assert.ok(reviewNotices[0].text.length < 350);
  assert.ok(!reviewNotices[0].text.includes("\n"));
  assert.deepEqual(f.seen.reviews[2], { scribeThreadId: "scribe-thread", method: "item/autoApprovalReview/completed", ...denied });
  assert.match(reviewNotices[1].text, /timed out.*Retry/);
  assert.match(reviewNotices[2].text, /aborted/);
  assert.match(reviewNotices[3].text, /failed.*diagnostic log/);
  assert.match(reviewNotices[4].text, /denied: example.com:443/);
  assert.deepEqual(f.seen.approvals, ["execute", "fetch"]);
  assert.equal(f.f.sent.filter((message) => message.result && !message.method).length, 0);
  f.complete();
  assert.equal((await run).status, "done");
  // Deduplication is scoped to one run, even if the server reuses a review id.
  const next = f.session.run({ text: "again", images: [], documents: [], instructions: "Scribe instructions" }, f.sink);
  await tick();
  const turn = f.f.sent.filter((m) => m.method === "turn/start").at(-1)!;
  f.f.emit({ id: turn.id, result: { turn: { id: "turn-2" } } });
  await tick();
  f.f.emit({ method: "item/autoApprovalReview/completed", params: { ...denied, turnId: "turn-2" } });
  assert.equal(f.seen.notices.length, count + 1);
  f.f.emit({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "turn-2", status: "completed" } } });
  assert.equal((await next).status, "done");
  f.session.dispose();
});

const denial = (over: Record<string, unknown> = {}) => ({ threadId: "native-thread", turnId: "turn-1",
  reviewId: "review-1", targetItemId: "shell", decisionSource: "agent",
  action: { type: "command", source: "unifiedExec", command: "echo hello", cwd: "/work" },
  review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "This needs explicit authorization." }, ...over });

function pendingDenial(f: ReturnType<typeof sessionFixture>) {
  let resolve!: (decision: ApprovalDecision) => void;
  let request!: ApprovalRequest;
  let signal: AbortSignal | undefined;
  f.sink.approval = (req, abort) => {
    request = req;
    signal = abort;
    return new Promise((res, reject) => {
      resolve = res;
      abort?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  };
  f.f.emit({ method: "item/autoApprovalReview/completed", params: denial() });
  return { resolve: (optionId: string) => resolve({ optionId }), get request() { return request; }, get signal() { return signal; } };
}

test("Codex denial approval survives native completion, records one exact retry, and retries through Auto-review", async () => {
  const f = sessionFixture(null, "auto");
  const { run } = await f.start();
  const pending = pendingDenial(f);
  const usages: unknown[] = [];
  f.sink.usage = (usage) => usages.push({ ...usage });
  f.f.emit({ method: "thread/tokenUsage/updated", params: { threadId: "native-thread", tokenUsage: { last: { inputTokens: 10, outputTokens: 3 } } } });
  assert.equal(pending.request.humanOnly, true);
  assert.match(pending.request.detail!, /echo hello[\s\S]*Risk: high[\s\S]*explicit authorization/);
  assert.deepEqual(pending.request.options.map((o) => o.id), ["approveRetry", "keepDenied"]);
  f.f.emit({ method: "item/autoApprovalReview/completed", params: denial() });
  let finished = false;
  void run.then(() => { finished = true; });
  f.complete();
  await tick();
  assert.equal(finished, false);
  assert.equal(pending.signal?.aborted, false);
  assert.equal(f.f.sent.some((m) => m.method === "thread/approveGuardianDeniedAction"), false);
  pending.resolve("approveRetry");
  await tick();
  const approval = f.f.sent.find((m) => m.method === "thread/approveGuardianDeniedAction")!;
  assert.deepEqual(approval.params, { threadId: "native-thread", event: {
    id: "review-1", target_item_id: "shell", status: "denied", decision_source: "agent",
    action: { type: "command", source: "unified_exec", command: "echo hello", cwd: "/work" },
    risk_level: "high", user_authorization: "low", rationale: "This needs explicit authorization.",
  } });
  assert.equal(f.f.sent.filter((m) => m.method === "turn/start").length, 1);
  f.f.emit({ id: approval.id, result: {} });
  await tick();
  const retry = f.f.sent.filter((m) => m.method === "turn/start").at(-1)!;
  assert.equal(f.f.sent.filter((m) => m.method === "turn/start").length, 2);
  assert.match(JSON.stringify(retry.params?.input), /review-1.*Native Auto-review still applies/);
  assert.equal(f.f.sent.filter((m) => m.method === "thread/start").length, 1);
  f.f.emit({ method: "turn/started", params: { threadId: "native-thread", turn: { id: "turn-2" } } });
  f.f.emit({ id: retry.id, result: { turn: { id: "turn-2" } } });
  f.f.emit({ method: "thread/tokenUsage/updated", params: { threadId: "native-thread", tokenUsage: { last: { inputTokens: 20, outputTokens: 4 } } } });
  f.f.emit({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "turn-2", status: "completed" } } });
  assert.deepEqual(await run, { status: "done" });
  assert.deepEqual(usages.at(-1), { inputTokens: 30, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
  f.session.dispose();
});

test("Codex reports the context after each model request and counts every request of a turn", async () => {
  const f = sessionFixture();
  const { run } = await f.start();
  const usages: Array<Record<string, unknown>> = [];
  f.sink.usage = (usage) => usages.push({ ...usage });
  const counts = (inputTokens: number, cachedInputTokens: number, outputTokens: number) =>
    ({ totalTokens: inputTokens + outputTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens: 0, outputTokens, reasoningOutputTokens: 0 });
  const report = (total: unknown, last: unknown) =>
    f.f.emit({ method: "thread/tokenUsage/updated", params: { threadId: "native-thread", turnId: "turn-1", tokenUsage: { total, last, modelContextWindow: 272000 } } });
  report(counts(1000, 0, 50), counts(1000, 0, 50));
  assert.deepEqual(usages.at(-1), { contextTokens: 1050, contextWindow: 272000 });
  report(counts(2300, 1000, 80), counts(1300, 1000, 30));
  assert.deepEqual(usages.at(-1), { contextTokens: 1330, contextWindow: 272000 });
  // The same report again (Codex repeats it with rate limit updates) adds nothing.
  report(counts(2300, 1000, 80), counts(1300, 1000, 30));
  f.complete();
  assert.deepEqual(await run, { status: "done" });
  assert.deepEqual(usages.at(-1), { inputTokens: 2300, outputTokens: 80, cacheReadTokens: 1000, cacheWriteTokens: 0, reasoningTokens: 0 });
  f.session.dispose();
});

test("Codex Keep denied, cancellation, and override errors never retry", async () => {
  for (const decision of ["keepDenied", "cancel", "error"]) {
    const f = sessionFixture(null, "auto");
    const { run } = await f.start();
    const pending = pendingDenial(f);
    f.complete();
    await tick();
    if (decision === "cancel") await f.session.cancel();
    else pending.resolve(decision === "error" ? "approveRetry" : "keepDenied");
    await tick();
    const approval = f.f.sent.find((m) => m.method === "thread/approveGuardianDeniedAction");
    if (decision === "error") {
      assert.ok(approval);
      f.f.emit({ id: approval.id, error: { message: "Denial expired" } });
    } else assert.equal(approval, undefined);
    assert.equal((await run).status, decision === "cancel" ? "cancelled" : "done");
    assert.equal(f.f.sent.filter((m) => m.method === "turn/start").length, 1);
    if (decision === "error") assert.ok(f.seen.notices.some((n) => n.level === "error" && /Denial expired/.test(n.text)));
    f.session.dispose();
  }
});

test("Codex denial event serialization preserves scoped native actions", () => {
  for (const [action, expected] of [
    [{ type: "applyPatch", cwd: "/work", files: ["a.ts"] }, { type: "apply_patch", cwd: "/work", files: ["a.ts"] }],
    [{ type: "networkAccess", target: "example.com:443", host: "example.com", protocol: "socks5Tcp", port: 443 },
      { type: "network_access", target: "example.com:443", host: "example.com", protocol: "socks5_tcp", port: 443 }],
    [{ type: "mcpToolCall", server: "scribe", toolName: "page_read", connectorId: null, connectorName: null, toolTitle: null },
      { type: "mcp_tool_call", server: "scribe", tool_name: "page_read", connector_id: null, connector_name: null, tool_title: null }],
    [{ type: "requestPermissions", reason: "test", permissions: { fileSystem: { read: ["/work"] }, network: null } },
      { type: "request_permissions", reason: "test", permissions: { file_system: { read: ["/work"] }, network: null } }],
  ]) assert.deepEqual(guardianDenialEvent(denial({ action })).action, expected);
  assert.throws(() => guardianDenialEvent(denial({ action: { type: "futureAction" } })), /Unsupported/);
  assert.throws(() => guardianDenialEvent(denial({ review: { status: "approved" } })), /Invalid/);
  const cwd = path.resolve(".");
  assert.deepEqual(guardianDenialEvent(denial({ action: { type: "writeStdin", approvalId: "a", processId: "p", stdin: "hello", cwd } })).action,
    { type: "write_stdin", approval_id: "a", process_id: "p", stdin: "hello", cwd: pathToFileURL(cwd).href });
});

test("Codex a kept denial after native failure and a disconnect never retry", async () => {
  for (const reason of ["failed", "disconnected"]) {
    const f = sessionFixture(null, "auto");
    const { run } = await f.start();
    const pending = pendingDenial(f);
    if (reason === "failed") {
      f.complete("failed");
      await tick();
      assert.equal(pending.signal?.aborted, false);
      pending.resolve("keepDenied");
    }
    else {
      f.complete();
      await tick();
      f.f.child.emit("exit", 1);
    }
    assert.equal((await run).status, "error");
    assert.equal(pending.signal?.aborted, true);
    assert.equal(f.f.sent.some((m) => m.method === "thread/approveGuardianDeniedAction"), false);
    f.session.dispose();
  }
});

test("Codex can approve a denial retry even when the native turn failed", async () => {
  const f = sessionFixture(null, "auto");
  const { run } = await f.start();
  const pending = pendingDenial(f);
  f.complete("failed");
  await tick();
  pending.resolve("approveRetry");
  await tick();
  const approval = f.f.sent.find((m) => m.method === "thread/approveGuardianDeniedAction")!;
  f.f.emit({ id: approval.id, result: {} });
  await tick();
  const retry = f.f.sent.filter((m) => m.method === "turn/start").at(-1)!;
  assert.equal(f.f.sent.filter((m) => m.method === "turn/start").length, 2);
  f.f.emit({ method: "turn/started", params: { threadId: "native-thread", turn: { id: "turn-2" } } });
  f.f.emit({ id: retry.id, result: { turn: { id: "turn-2" } } });
  f.f.emit({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "turn-2", status: "completed" } } });
  assert.equal((await run).status, "done");
  f.session.dispose();
});

test("Codex cancellation while native override acknowledgement is pending cannot start a retry", async () => {
  const f = sessionFixture(null, "auto");
  const { run } = await f.start();
  const pending = pendingDenial(f);
  f.complete();
  pending.resolve("approveRetry");
  await tick();
  const approval = f.f.sent.find((m) => m.method === "thread/approveGuardianDeniedAction")!;
  assert.ok(approval);
  await f.session.cancel();
  assert.equal((await run).status, "cancelled");
  f.f.emit({ id: approval.id, result: {} });
  await tick();
  assert.equal(f.f.sent.filter((m) => m.method === "turn/start").length, 1);
  f.session.dispose();
});

test("Codex start and resume retain Auto-review and Full policies", async () => {
  for (const nativeId of [null, "native-thread"]) {
    for (const approval of ["auto", "full"] as const) {
      const f = sessionFixture(nativeId, approval);
      const { run } = await f.start();
      f.complete();
      assert.equal((await run).status, "done");
      f.session.dispose();
    }
  }
});

test("Codex rejected steer remains unacknowledged for host requeue, and pending approval aborts on completion", async () => {
  const f = sessionFixture();
  let aborted = false;
  f.sink.approval = (_req, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
  });
  const { run } = await f.start();
  f.f.emit({ id: "approval", method: "item/fileChange/requestApproval", params: { threadId: "native-thread", turnId: "turn-1", itemId: "edit" } });
  const id = f.session.steer({ text: "new input", images: [], documents: [] });
  await tick();
  const steer = f.f.sent.find((message) => message.method === "turn/steer")!;
  f.f.emit({ id: steer.id, error: { message: "No active turn" } });
  f.complete();
  assert.equal((await run).status, "done");
  assert.deepEqual(f.seen.steered, []);
  assert.equal(aborted, true);
  assert.equal(await f.session.withdrawSteer(id), false);
  f.session.dispose();
});

test("Codex interruption sends the active turn id and returns cancelled", async () => {
  const f = sessionFixture();
  const { run } = await f.start();
  const cancel = f.session.cancel();
  const interrupt = f.f.sent.find((message) => message.method === "turn/interrupt")!;
  assert.equal(interrupt.params?.turnId, "turn-1");
  f.f.emit({ id: interrupt.id, result: {} });
  f.complete("interrupted");
  await cancel;
  assert.equal((await run).status, "cancelled");
  f.session.dispose();
});

test("Codex resumes an existing SDK thread and reuses the connection for subsequent turns", async () => {
  const f = sessionFixture("native-thread");
  const first = await f.start();
  assert.equal(f.f.sent.find((message) => message.method === "thread/resume")?.params?.threadId, "native-thread");
  f.complete();
  await first.run;
  const next = f.session.run({ text: "continue", images: [], documents: [], instructions: "Scribe instructions" }, f.sink);
  await tick();
  assert.equal(f.f.sent.filter((message) => message.method === "initialize").length, 1);
  const turn = f.f.sent.filter((message) => message.method === "turn/start").at(-1)!;
  // Completion can precede the turn/start response on the same transport.
  f.f.emit({ method: "turn/started", params: { threadId: "native-thread", turn: { id: "turn-2" } } });
  f.f.emit({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "turn-2", status: "completed" } } });
  f.f.emit({ id: turn.id, result: { turn: { id: "turn-2" } } });
  assert.equal((await next).status, "done");
  f.session.dispose();
});

test("Codex applies a same-session model change on the next turn/start without reconnecting", async () => {
  const f = sessionFixture();
  const first = await f.start();
  const opened = f.f.sent.find((message) => message.method === "turn/start")!;
  assert.equal(opened.params?.model, "gpt-5-codex");
  assert.equal(opened.params?.effort, "medium");
  f.complete();
  await first.run;

  f.session.update({ ...thread({ model: "gpt-5.2-codex", effort: "high" }), id: "scribe-thread", nativeId: "native-thread", cwd: "/work", scope: { kind: "page", ref: "board" } } as Thread);
  const next = f.session.run({ text: "continue", images: [], documents: [], instructions: "Scribe instructions" }, f.sink);
  await tick();
  const changed = f.f.sent.filter((message) => message.method === "turn/start").at(-1)!;
  assert.equal(f.f.sent.filter((message) => message.method === "initialize").length, 1);
  assert.equal(changed.params?.model, "gpt-5.2-codex");
  assert.equal(changed.params?.effort, "high");
  f.f.emit({ method: "turn/started", params: { threadId: "native-thread", turn: { id: "turn-2" } } });
  f.f.emit({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "turn-2", status: "completed" } } });
  f.f.emit({ id: changed.id, result: { turn: { id: "turn-2" } } });
  assert.equal((await next).status, "done");

  f.session.update({ ...thread({ model: "default", effort: null }), id: "scribe-thread", nativeId: "native-thread", cwd: "/work", scope: { kind: "page", ref: "board" } } as Thread);
  const reset = f.session.run({ text: "reset", images: [], documents: [], instructions: "Scribe instructions" }, f.sink);
  await tick();
  const cleared = f.f.sent.filter((message) => message.method === "turn/start").at(-1)!;
  assert.equal(f.f.sent.filter((message) => message.method === "initialize").length, 1);
  assert.equal(cleared.params?.model, null);
  assert.equal(cleared.params?.effort, null);
  f.f.emit({ method: "turn/started", params: { threadId: "native-thread", turn: { id: "turn-3" } } });
  f.f.emit({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "turn-3", status: "completed" } } });
  f.f.emit({ id: cleared.id, result: { turn: { id: "turn-3" } } });
  assert.equal((await reset).status, "done");
  f.session.dispose();
});

test("Codex approval changes and warm-ups reuse one connection and verify each policy before work", async () => {
  const f = sessionFixture(null, "full");
  try {
    const first = await f.start({ sandbox: { type: "dangerFullAccess" }, approvalPolicy: "never", approvalsReviewer: "user" });
    f.complete();
    await first.run;
    const connection = f.f;
    let turnNumber = 1;
    for (const approval of ["edits", "auto", "full", "edits"] as const) {
      const updated = { ...thread({ approval }), id: "scribe-thread", nativeId: "native-thread", cwd: "/work", scope: { kind: "page", ref: "board" } } as Thread;
      f.session.update(updated);
      await f.session.warm("Scribe instructions");
      const previousTurns = connection.sent.filter(m => m.method === "turn/start").length;
      const previousUpdates = connection.sent.filter(m => m.method === "thread/settings/update").length;
      const run = f.session.run({ text: "continue", images: [], documents: [], instructions: "Scribe instructions" }, f.sink);
      await tick();
      const permission = turnPermissionOverrides(updated, "/work");
      if (connection.sent.filter(m => m.method === "thread/settings/update").length > previousUpdates) {
        const update = connection.sent.filter(m => m.method === "thread/settings/update").at(-1)!;
        assert.deepEqual(update.params, { threadId: "native-thread", ...permission });
        connection.emit({ id: update.id, result: {} });
        await tick();
        assert.equal(connection.sent.filter(m => m.method === "turn/start").length, previousTurns);
        connection.emit({ method: "thread/settings/updated", params: { threadId: "native-thread", threadSettings: permission } });
        await tick();
      }
      assert.equal(f.f, connection);
      assert.equal(connection.sent.filter(m => m.method === "initialize").length, 1);
      assert.equal(connection.sent.filter(m => m.method === "thread/resume").length, 0);
      const turn = connection.sent.filter(m => m.method === "turn/start").at(-1)!;
      assert.equal(connection.sent.filter(m => m.method === "turn/start").length, previousTurns + 1);
      assert.deepEqual(turn.params?.sandboxPolicy, permission.sandboxPolicy);
      assert.equal(turn.params?.approvalsReviewer, permission.approvalsReviewer);
      assert.equal(turn.params?.approvalPolicy, permission.approvalPolicy);
      const id = `turn-${++turnNumber}`;
      connection.emit({ id: turn.id, result: { turn: { id } } });
      connection.emit({ method: "turn/completed", params: { threadId: "native-thread", turn: { id, status: "completed" } } });
      assert.equal((await run).status, "done");
    }
  } finally { f.session.dispose(); }
});

test("Codex policy update errors or broader observations stop before the next turn", async () => {
  for (const scenario of ["error", "broader", "missing", "cancel"] as const) {
    const f = sessionFixture(null, "full");
    try {
      const first = await f.start({ sandbox: { type: "dangerFullAccess" }, approvalPolicy: "never", approvalsReviewer: "user" });
      f.complete();
      await first.run;
      f.session.update({ ...thread(), id: "scribe-thread", nativeId: "native-thread", cwd: "/work", scope: { kind: "page", ref: "board" } } as Thread);
      const run = f.session.run({ text: "continue", images: [], documents: [], instructions: "Scribe instructions" }, f.sink);
      await tick();
      const update = f.f.sent.find(m => m.method === "thread/settings/update")!;
      if (scenario === "error") f.f.emit({ id: update.id, error: { message: "unsupported update" } });
      else if (scenario === "cancel") await f.session.cancel();
      else {
        f.f.emit({ id: update.id, result: {} });
        f.f.emit({ method: "thread/settings/updated", params: { threadId: "native-thread", threadSettings: scenario === "missing" ? {} : { sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "on-request", approvalsReviewer: "user" } } });
      }
      const outcome = await run;
      assert.equal(outcome.status, scenario === "cancel" ? "cancelled" : "error");
      if (scenario !== "cancel") assert.match(outcome.error!, scenario === "error" ? /unsupported/ : scenario === "missing" ? /did not confirm/ : /broader/);
      assert.equal(f.f.sent.filter(m => m.method === "turn/start").length, 1);
    } finally { f.session.dispose(); }
  }
});

test("Codex per-turn sandbox keeps mode restrictions, networking and worktree git writes", () => {
  for (const mode of ["code", "board"] as const) {
    for (const approval of ["edits", "auto", "full"] as const) {
      const overrides = turnPermissionOverrides(thread({ mode, approval, web: "off" }), process.cwd());
      const sandbox = overrides.sandboxPolicy as Record<string, unknown>;
      assert.equal(sandbox.type, mode !== "code" ? "readOnly" : approval === "full" ? "dangerFullAccess" : "workspaceWrite");
      if (sandbox.type !== "dangerFullAccess") assert.equal(sandbox.networkAccess, false);
      if (sandbox.type === "workspaceWrite" && process.platform === "win32") assert.ok((sandbox.writableRoots as string[]).includes(gitCommonDir(process.cwd())!));
    }
  }
  const config = threadOptions(thread({ approval: "full" }), process.cwd(), "win32").config as Record<string, unknown>;
  assert.equal(config["windows.sandbox"], "unelevated");
});

test("Codex turn overrides retain custom mode read-only restrictions at every approval level", () => {
  for (const off of ["edit", "shell"] as const) {
    for (const approval of ["edits", "auto", "full"] as const) {
      const limited = { ...thread({ approval }), custom: { id: "cm_test", name: "Limited", off: [off], mcp: "all" as const, instructions: "" } };
      assert.deepEqual(turnPermissionOverrides(limited, "/work").sandboxPolicy, { type: "readOnly", networkAccess: false });
      const config = threadOptions(limited, "/work", "win32").config as Record<string, unknown>;
      assert.equal(config["sandbox_workspace_write.network_access"], false);
      assert.equal(config["windows.sandbox"], "unelevated");
    }
  }
});

test("Codex user input answers include freeform notes; unsupported permission grants fail closed", async () => {
  const f = sessionFixture();
  f.sink.question = async () => ({ answers: { q: ["Yes"] }, notes: { q: "Use the small scope" } });
  const { run } = await f.start();
  f.f.emit({ id: "q", method: "item/tool/requestUserInput", params: { threadId: "native-thread", turnId: "turn-1", questions: [{ id: "q", question: "Proceed?", options: [{ label: "Yes" }] }] } });
  f.f.emit({ id: "permissions", method: "item/permissions/requestApproval", params: { threadId: "native-thread", turnId: "turn-1", permissions: { network: { enabled: true } } } });
  await tick();
  assert.deepEqual(f.f.sent.find((message) => message.id === "q")?.result, { answers: { q: { answers: ["Yes", "Use the small scope"] } } });
  assert.deepEqual(f.f.sent.find((message) => message.id === "permissions")?.result, { permissions: {}, scope: "turn" });
  f.complete();
  await run;
  f.session.dispose();
});

test("Codex MCP tool approval requests reach Scribe's approval, and only other requests are declined", async () => {
  const f = sessionFixture();
  const requests: Array<{ boardTool?: boolean; title: string; detail?: string; options: string[] }> = [];
  f.sink.approval = async (req) => {
    requests.push({ boardTool: req.boardTool, title: req.title, detail: req.detail, options: req.options.map((option) => option.id) });
    // The host answers its own board tools without asking (autoApproval).
    return { optionId: req.boardTool ? "accept" : requests.length === 2 ? "acceptForSession" : "decline" };
  };
  const { run } = await f.start();
  const ask = (id: string, serverName: string, _meta: unknown) => f.f.emit({ id, method: "mcpServer/elicitation/request", params: {
    threadId: "native-thread", turnId: "turn-1", serverName, mode: "form", _meta, message: `Allow the ${serverName} MCP server to run tool "t"?`, requestedSchema: { type: "object", properties: {} } } });
  const approval = { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_params: { key: "demo" } };
  ask("board", "scribe", approval);
  ask("session", "other", approval);
  ask("declined", "other", { codex_approval_kind: "mcp_tool_call" });
  ask("form", "other", null);
  await tick();
  const result = (id: string) => f.f.sent.find((message) => message.id === id)?.result;
  assert.deepEqual(result("board"), { action: "accept", content: {}, _meta: null });
  assert.deepEqual(result("session"), { action: "accept", content: {}, _meta: { persist: "session" } });
  assert.deepEqual(result("declined"), { action: "decline", content: null, _meta: null });
  assert.deepEqual(result("form"), { action: "decline", content: null, _meta: null });
  assert.deepEqual(requests.map((req) => req.boardTool), [true, false, false]);
  assert.deepEqual(requests.map((req) => req.options), [["accept", "acceptForSession", "decline"], ["accept", "acceptForSession", "decline"], ["accept", "decline"]]);
  assert.match(requests[1]!.detail!, /Allow the other MCP server[\s\S]*"key":"demo"/);
  // Only the form Scribe cannot show is declined by Scribe itself, and it says so.
  assert.deepEqual(f.seen.notices.filter((notice) => /declined/.test(notice.text)).map((notice) => notice.level), ["warn"]);
  f.complete();
  await run;
  f.session.dispose();
});

function bridgeFixture(approve: ResolvedMcpServer["approve"]) {
  const server: ResolvedMcpServer = { name: "files", layer: "global", transport: "stdio", command: "files-mcp", args: [], env: {}, headers: {}, approve };
  const calls: unknown[] = [];
  const client = { callTool: async (req: { arguments: unknown }) => {
    calls.push(req.arguments);
    return { content: [{ type: "text", text: "hello" }, { type: "image", data: "AAAA", mimeType: "image/png" }] };
  } };
  let closed = 0;
  class FakeBridge extends McpBridge {
    override tools() {
      return Promise.resolve([{ name: "files__read", server: "files", tool: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } },
        call: (args: Record<string, unknown>, opts: { toolCallId?: string; signal?: AbortSignal }) =>
          (this as unknown as { call: (...a: unknown[]) => Promise<{ content: unknown[]; isError: boolean }> }).call(client, server, "read", args, opts) }]);
    }
    override close() { closed++; }
  }
  return { servers: [server], calls, get closed() { return closed; }, bridge: (...args: ConstructorParameters<typeof McpBridge>) => new FakeBridge(...args) };
}

test("Codex offers the user's MCP servers as dynamic tools and asks before a call", async () => {
  const mcp = bridgeFixture("ask");
  const f = sessionFixture(null, "edits", undefined, mcp);
  const { run } = await f.start();
  const start = f.f.sent.find((message) => message.method === "thread/start")!;
  assert.deepEqual(start.params?.dynamicTools, [{ type: "function", name: "files__read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }]);
  f.f.emit({ method: "item/started", params: { threadId: "native-thread", turnId: "turn-1",
    item: { id: "call-1", type: "dynamicToolCall", namespace: null, tool: "files__read", arguments: { path: "a.txt" }, status: "inProgress", contentItems: null, success: null } } });
  assert.deepEqual(f.seen.tools, ["call-1"]);
  // The fixture's sink declines approvals.
  f.f.emit({ id: "call", method: "item/tool/call", params: { threadId: "native-thread", turnId: "turn-1", callId: "call-1", namespace: null, tool: "files__read", arguments: { path: "a.txt" } } });
  await tick();
  await tick();
  assert.deepEqual(f.seen.approvals, ["other"]);
  assert.deepEqual(mcp.calls, []);
  assert.equal((f.f.sent.find((message) => message.id === "call")?.result as { success: boolean }).success, false);
  f.sink.approval = async () => ({ optionId: "allow" });
  f.f.emit({ id: "call2", method: "item/tool/call", params: { threadId: "native-thread", turnId: "turn-1", callId: "call-2", namespace: null, tool: "files__read", arguments: { path: "b.txt" } } });
  f.f.emit({ id: "gone", method: "item/tool/call", params: { threadId: "native-thread", turnId: "turn-1", callId: "call-3", namespace: null, tool: "old__tool", arguments: {} } });
  await tick();
  await tick();
  assert.deepEqual(mcp.calls, [{ path: "b.txt" }]);
  assert.deepEqual(f.f.sent.find((message) => message.id === "call2")?.result,
    { success: true, contentItems: [{ type: "inputText", text: "hello" }, { type: "inputImage", imageUrl: "data:image/png;base64,AAAA" }] });
  const gone = f.f.sent.find((message) => message.id === "gone")?.result as { success: boolean; contentItems: Array<{ text: string }> };
  assert.equal(gone.success, false);
  assert.match(gone.contentItems[0]!.text, /not available/);
  f.complete();
  await run;
  f.session.dispose();
  assert.equal(mcp.closed, 1);
});

test("Codex bridged calls skip the prompt for auto servers; a resumed thread gets no new tool list", async () => {
  const mcp = bridgeFixture("auto");
  const f = sessionFixture("native-thread", "edits", undefined, mcp);
  const { run } = await f.start();
  assert.equal(f.f.sent.find((message) => message.method === "thread/resume")?.params?.dynamicTools, undefined);
  f.f.emit({ id: "call", method: "item/tool/call", params: { threadId: "native-thread", turnId: "turn-1", callId: "c", namespace: null, tool: "files__read", arguments: { path: "a.txt" } } });
  await tick();
  await tick();
  assert.deepEqual(f.seen.approvals, []);
  assert.deepEqual(mcp.calls, [{ path: "a.txt" }]);
  f.complete();
  await run;
  f.session.dispose();
});

test("syncAuthFiles keeps the newer Codex login in both places", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-"));
  const user = path.join(dir, "user.json");
  const scribe = path.join(dir, "scribe.json");
  const login = (token: string, at: string) => JSON.stringify({ tokens: { refresh_token: token }, last_refresh: at });
  try {
    assert.equal(syncAuthFiles(user, scribe), "none");

    fs.writeFileSync(user, login("a", "2026-01-01T00:00:00Z"));
    assert.equal(syncAuthFiles(user, scribe), "toScribe");
    assert.equal(fs.readFileSync(scribe, "utf8"), login("a", "2026-01-01T00:00:00Z"));
    assert.equal(syncAuthFiles(user, scribe), "none");

    // Scribe's app-server refreshed: the CLI gets the rotated token instead of overwriting it.
    fs.writeFileSync(scribe, login("b", "2026-01-02T00:00:00Z"));
    assert.equal(syncAuthFiles(user, scribe), "toUser");
    assert.equal(fs.readFileSync(user, "utf8"), login("b", "2026-01-02T00:00:00Z"));

    // A fresh `codex login` or CLI refresh is newer again and wins.
    fs.writeFileSync(user, login("c", "2026-01-03T00:00:00Z"));
    assert.equal(syncAuthFiles(user, scribe), "toScribe");
    assert.equal(fs.readFileSync(scribe, "utf8"), login("c", "2026-01-03T00:00:00Z"));

    // A broken Scribe copy is replaced; a broken CLI file is never copied over a good login.
    fs.writeFileSync(scribe, "{");
    assert.equal(syncAuthFiles(user, scribe), "toScribe");
    fs.writeFileSync(user, "{");
    assert.equal(syncAuthFiles(user, scribe), "toUser");
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("effective policy parsing never substitutes requested permissions for missing observations", () => {
  const requested = { sandbox: "workspace-write", approvalPolicy: "on-request" };
  const missing = codexPermissions({}, requested);
  assert.equal(missing.sandbox, "unknown");
  assert.equal(missing.approval, "unknown");
  const policy = codexPermissions({ sandbox: { type: "readOnly" }, approvalPolicy: "never", approvalsReviewer: "auto_review" }, requested);
  assert.equal(policy.sandbox, "read-only");
  assert.equal(policy.approval, "never");
  assert.equal(permissionBoundaryProblem(policy), null);
  assert.match(permissionBoundaryProblem({ ...policy, sandbox: "danger-full-access" })!, /broader/);
  assert.deepEqual(scribeToolAvailability({ mcp__scribe__page_action: {}, page_patch: {} }), { boardActions: "available", reports: "missing" });
  const board = { mode: "board", scope: { kind: "page", ref: "board" } } as Thread;
  assert.equal(workerPermissionProblem(board, { ...policy, requestedSandbox: "read-only", approval: "on-request", boardActions: "available", reports: "available" }), null);
});

for (const nativeId of [null, "saved-thread"]) {
  test(`Codex ${nativeId ? "resume" : "start"} stops incompatible workers before any model turn`, async () => {
    for (const [policy, tools, error] of [
      [{ sandbox: { type: "readOnly" }, approvalPolicy: "never" }, { page_action: {}, page_show: {} }, /read-only/],
      [{ sandbox: { type: "workspaceWrite" }, approvalPolicy: "on-request" }, { page_show: {} }, /page_action/],
      [{ sandbox: { type: "workspaceWrite" }, approvalPolicy: "on-request" }, { page_action: {} }, /page_show/],
      [{}, { page_action: {}, page_show: {} }, /did not report/],
      [{ sandbox: { type: "workspaceWrite" }, approvalPolicy: "never" }, { page_action: {}, page_show: {} }, /approval policy different/],
      [{ sandbox: { type: "dangerFullAccess" }, approvalPolicy: "on-request" }, { page_action: {}, page_show: {} }, /broader/],
    ] as Array<[Record<string, unknown>, Record<string, unknown>, RegExp]>) {
      const f = sessionFixture(nativeId, "auto", undefined, undefined, true);
      try {
        const { run } = await f.start(policy, tools);
        const outcome = await run;
        assert.equal(outcome.status, "error");
        assert.match(outcome.error!, error);
        assert.equal(f.f.sent.some((m) => m.method === "turn/start"), false);
        assert.ok(f.seen.notices.some((n) => /requested/.test(n.text)));
      } finally { f.session.dispose(); }
    }
  });
}

test("Codex compatible worker inventories board actions and reports without mutating pages", async () => {
  const f = sessionFixture(null, "edits", undefined, undefined, true);
  try {
    const { run } = await f.start({ sandbox: { type: "workspaceWrite" }, approvalPolicy: "on-request", approvalsReviewer: "user" });
    assert.ok(f.f.sent.some((m) => m.method === "turn/start"));
    assert.equal(f.f.sent.some((m) => /tools\/call/.test(m.method ?? "")), false);
    f.complete();
    assert.equal((await run).status, "done");
  } finally { f.session.dispose(); }
});

test("Codex worker with App scope None stops before a turn or MCP inventory", async () => {
  const f = sessionFixture(null, "edits", undefined, undefined, true, { kind: "workspace", ref: "/work" });
  try {
    const { run } = await f.start({ sandbox: { type: "workspaceWrite" }, approvalPolicy: "on-request" });
    assert.match((await run).error!, /App scope None/);
    assert.equal(f.f.sent.some((m) => m.method === "turn/start" || m.method === "mcpServerStatus/list"), false);
  } finally { f.session.dispose(); }
});
