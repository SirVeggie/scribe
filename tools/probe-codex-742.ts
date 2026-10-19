/** One-shot diagnostic for #742. No model turn. Does not print tokens. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { CodexRpc } from "../src/agent/providers/codexRpc.js";
import { cliEnv, scribeCodexHome, syncCodexAuth } from "../src/agent/providers/codex.js";

const require = createRequire(import.meta.url);
const cli = require.resolve("@openai/codex/bin/codex.js");

function fileMeta(file: string) {
  try {
    const st = fs.statSync(file);
    return { exists: true, mtime: st.mtime.toISOString(), size: st.size };
  } catch (error) {
    return { exists: false, error: (error as Error).message };
  }
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 8).map(sanitize);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|password|authorization|cookie|jwt|apiKey|api_key/i.test(key)) {
      out[key] = typeof entry === "string" ? `[redacted ${entry.length} chars]` : "[redacted]";
      continue;
    }
    out[key] = sanitize(entry);
  }
  return out;
}

function grepLog(file: string, needles: string[]) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/).filter((line) => needles.some((n) => line.includes(n)));
    return lines.slice(-30);
  } catch (error) {
    return [`log read failed: ${(error as Error).message}`];
  }
}

const userAuth = path.join(os.homedir(), ".codex", "auth.json");
const scribeAuth = path.join(scribeCodexHome(), "auth.json");
const daemonLog = path.join(process.env.LOCALAPPDATA || "", "scribe", "daemon.log");

const report: Record<string, unknown> = {
  now: new Date().toISOString(),
  cli,
  userAuth: fileMeta(userAuth),
  scribeAuth: fileMeta(scribeAuth),
  daemonLog: fileMeta(daemonLog),
};

try {
  const exe = require.resolve("@openai/codex-win32-x64/package.json");
  const bin = path.join(path.dirname(exe), "vendor", "x86_64-pc-windows-msvc", "codex.exe");
  report.native = { path: bin, ...fileMeta(bin) };
} catch (error) {
  report.native = { error: (error as Error).message };
}

syncCodexAuth();
const env = cliEnv();
for (const key of ["CODEX_API_KEY", "OPENAI_API_KEY"]) {
  report[`${key}_set`] = Boolean(process.env[key]?.trim());
}

const rpc = CodexRpc.launch(cli, env, (message) => {
  if (message.method === "error" || message.method === "account/rateLimits/updated") {
    console.error(JSON.stringify({ notify: message.method, params: sanitize(message.params) }));
  }
}, (error) => {
  console.error(JSON.stringify({ closed: error.message }));
});

try {
  const init = await rpc.call("initialize", {
    clientInfo: { name: "scribe-742-probe", title: "Scribe", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  report.initialize = sanitize(init);
  rpc.notify("initialized");

  try {
    const account = await rpc.call("account/read", { refreshToken: false });
    const rec = account && typeof account === "object" ? account as Record<string, unknown> : {};
    const acc = rec.account && typeof rec.account === "object" ? rec.account as Record<string, unknown> : null;
    report.account = acc ? { type: acc.type, email: typeof acc.email === "string" ? acc.email.replace(/.(?=.*@)/g, "*") : undefined, keys: Object.keys(acc) } : sanitize(account);
  } catch (error) {
    report.accountError = (error as Error).message;
  }

  try {
    report.rateLimits = sanitize(await rpc.call("account/rateLimits/read"));
  } catch (error) {
    report.rateLimitsError = (error as Error).message;
  }

  try {
    const models = await rpc.call("model/list", { includeHidden: false, limit: 20 });
    const rec = models && typeof models === "object" ? models as Record<string, unknown> : {};
    const data = Array.isArray(rec.data) ? rec.data : [];
    report.models = { count: data.length, ids: data.slice(0, 8).map((row) => (row && typeof row === "object" ? (row as { model?: unknown }).model : null)) };
  } catch (error) {
    report.modelsError = (error as Error).message;
  }
} finally {
  rpc.close();
}

report.daemonHits = grepLog(daemonLog, [
  "workspace routing",
  "unauthorized (401)",
  "Codex model list failed",
  "Codex login failed",
  "Codex app-server",
  "authentication required",
]);

console.log(JSON.stringify(report, null, 2));
