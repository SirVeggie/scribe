import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { planLimitsFromUsageReport, planLimitsFromCodexRateLimits } from "./planLimits.js";
import { windowStartBlocked } from "./usageWindowStarts.js";

// Execute the actual provider methods with SDK/filesystem doubles: no process,
// credentials, account reads or model traffic leave this fixture.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function method(provider: string, deps: Record<string, unknown>) {
  const source = fs.readFileSync(new URL(`./providers/${provider}.ts`, import.meta.url), "utf8");
  const body = /async startUsageWindow\(signal: AbortSignal(?:, dir\?: string)?\): Promise<void> \{([\s\S]*?)\n  \}\n\n  async complete/.exec(source)![1]
    .replaceAll('await import("../planLimits.js")', "parsers")
    .replaceAll('await import("../usageWindowStarts.js")', "guards");
  return new AsyncFunction("signal", "dir", ...Object.keys(deps), "parsers", "guards", body).bind(null);
}
const parsers = { planLimitsFromUsageReport, planLimitsFromCodexRateLimits };
const guards = { windowStartBlocked };

test("Claude releases one minimal message only after active-query subscription and usage checks", async () => {
  for (const source of ["subscription", "apiKey", "cloud", "exhausted", "unknown"]) {
    const messages: unknown[] = [];
    let options: any;
    const q = {
      accountInfo: async () => ({ apiProvider: source === "cloud" ? "bedrock" : "firstParty",
        apiKeySource: source === "apiKey" ? "env" : "none", subscriptionType: source === "unknown" ? undefined : "max" }),
      close() {},
      async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", is_error: false }; },
    };
    const deps = {
      loadSdk: async () => ({ query: (args: any) => { options = args.options; return q; } }),
      fs: { mkdtempSync: () => "isolated", rmSync() {} },
      path: { join: () => "temp" }, os: { tmpdir: () => "temp" },
      InputQueue: class { push(m: unknown) { messages.push(m); } close() {} },
      accountEnv: (dir: string) => ({ CLAUDE_CONFIG_DIR: dir }),
      queryPlanUsage: async () => ({ rate_limits: {
        five_hour: { utilization: 0, resets_at: new Date(Date.now() - 1000).toISOString() },
        seven_day: { utilization: source === "exhausted" ? 100 : 0, resets_at: new Date(Date.now() + 86400_000).toISOString() },
      } }),
    };
    const call = (dir?: string) => method("claude", deps)(new AbortController().signal, dir, ...Object.values(deps), parsers, guards);
    if (source === "subscription") {
      await call();
      assert.equal(options.env, undefined);
      assert.equal(messages.length, 1);
      assert.equal((messages[0] as any).message.content, "Hello. Reply only with hi.");
      assert.deepEqual(options.tools, []);
      assert.deepEqual(options.settingSources, []);
      assert.equal(options.cwd, "isolated");
      // An added account (#926): the same request, signed in from its own folder.
      await call("acc_dir");
      assert.equal(messages.length, 2);
      assert.equal(options.env.CLAUDE_CONFIG_DIR, "acc_dir");
    } else {
      await assert.rejects(call);
      assert.equal(messages.length, 0, source);
    }
  }
});

test("Codex uses only an available Luna model in an isolated home without API-key fallback", async () => {
  for (const scenario of ["allowed", "denied", "noLuna"]) {
    const requests: unknown[] = [];
    let clientOptions: any;
    let threadOptions: any;
    const deps = {
      syncCodexAuth() {}, syncAuthFiles() {},
      fs: { mkdtempSync: () => "isolated", mkdirSync() {}, copyFileSync() {}, rmSync() {} },
      path: { join: (...parts: string[]) => parts.join("/") }, os: { tmpdir: () => "temp" },
      scribeCodexHome: () => "original",
      cliEnv: () => ({ CODEX_API_KEY: "fixture", OPENAI_API_KEY: "fixture", OPENAI_BASE_URL: "fixture" }),
      withAppServer: async (_env: unknown, run: any) => run(async () => ({})),
      readCodexPlanUsage: async () => ({ ordinaryUsageAllowed: scenario === "allowed", rateLimits: {
        primary: { usedPercent: 0, windowDurationMins: 300 },
      } }),
      sdk: async () => ({ Codex: class {
        constructor(options: unknown) { clientOptions = options; }
        startThread(options: unknown) { threadOptions = options; return { run: async (prompt: unknown) => { requests.push(prompt); } }; }
      } }),
    };
    const invoke = new AsyncFunction("signal", ...Object.keys(deps), "parsers", "guards",
      /async startUsageWindow\(signal: AbortSignal\): Promise<void> \{([\s\S]*?)\n  \}\n\n  async complete/
        .exec(fs.readFileSync(new URL("./providers/codex.ts", import.meta.url), "utf8"))![1]
        .replaceAll('await import("../planLimits.js")', "parsers"));
    const call = () => invoke.call({ models: async () => scenario === "noLuna" ? [] : [{ id: "gpt-6-luna" }] },
      new AbortController().signal, ...Object.values(deps), parsers, guards);
    if (scenario === "allowed") {
      await call();
      assert.deepEqual(requests, ["Hello. Reply only with hi."]);
      assert.equal(clientOptions.env.CODEX_HOME, "isolated/home");
      assert.equal(clientOptions.env.CODEX_API_KEY, undefined);
      assert.equal(clientOptions.env.OPENAI_API_KEY, undefined);
      assert.equal(clientOptions.config.features.shell_tool, false);
      assert.equal(clientOptions.config.forced_login_method, "chatgpt");
      assert.equal(threadOptions.model, "gpt-6-luna");
      assert.equal(threadOptions.workingDirectory, "isolated");
    } else {
      await assert.rejects(call);
      assert.deepEqual(requests, []);
    }
  }
});
