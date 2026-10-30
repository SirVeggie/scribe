/**
 * Windows sandbox probes for #900 (no product change). One command matrix, run under each engine:
 *
 *   npx tsx tools/probe-windows-sandbox.ts codex [--modes mxc,unelevated,elevated] [--net] [--codex-cli <codex.js>]
 *   npx tsx tools/probe-windows-sandbox.ts codex-rpc [--codex-cli <codex.js>]
 *   npx tsx tools/probe-windows-sandbox.ts srt --pkg <dir of @anthropic-ai/sandbox-runtime> [--loopback] [--srt-win <exe>]
 *   npx tsx tools/probe-windows-sandbox.ts claude --pkg <dir> [--loopback] [--srt-win <exe>] [--config-dir <CLAUDE_CONFIG_DIR>]
 *                                         [--stdin-relay] [--prompt <text>] [--debug]
 *   npx tsx tools/probe-windows-sandbox.ts status --pkg <dir> [--loopback] [--srt-win <exe>]
 *
 * The Claude CLI under srt-win needs --stdin-relay (and so --loopback): srt-win passes neither stdin nor the
 * caller's environment. Write grants are kept between sessions and readable by every later sandboxed
 * session: run `srt-win acl forget --all` after probing with --config-dir.
 *
 * sandbox-runtime is not a dependency of the repo: install it in a scratch folder and pass --pkg.
 * srt needs its one-time elevated `windows-install` (`--loopback` must match `--allow-loopback` there), and
 * `--srt-win <path>` to a copy of srt-win.exe outside the user profile when the package is installed under it.
 * `--modes elevated` may run Codex's elevated setup (a UAC prompt) for Scribe's CODEX_HOME.
 * Output: one JSON line per probe with { ok, exit, out } (out is clipped; secrets print only a byte count).
 * The `claude` case sends one short model turn.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const require = createRequire(import.meta.url);
const cwd = process.cwd();
const scribeData = path.join(process.env.LOCALAPPDATA ?? os.homedir(), "scribe");
const daemonPort = Number(process.env.SCRIBE_PORT || 4747);

function gitCommonDir(): string {
  return path.resolve(cwd, spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).stdout.trim());
}

// A planted secret outside the workspace, denied to srt by path. Codex unelevated can't deny reads.
const secretDir = path.join(os.tmpdir(), "scribe-probe-secret");
const secretFile = path.join(secretDir, "secret.txt");
const outsideFile = path.join(os.homedir(), "scribe-probe-outside.txt");
// Helpers live in .scratch so no command carries nested quotes: Node quotes argv with \" and cmd.exe doesn't read that.
const helpers = {
  "probe-read.cjs": "try { console.log(require('fs').readFileSync(process.argv[2]).length + ' bytes') } catch (e) { console.log(e.code); process.exit(1) }",
  "probe-fetch.cjs": "fetch(process.argv[2]).then((r) => console.log(r.status), (e) => { console.log(String((e.cause && e.cause.code) || e)); process.exit(1) })",
  "probe-resolve.cjs": "console.log(require('fs').realpathSync(require.resolve('typescript')))",
};
const len = (file: string) => `node .scratch\\probe-read.cjs ${file}`;
const fetchJs = (url: string) => `node .scratch\\probe-fetch.cjs ${url}`;
const ps = (script: string) => `powershell -NoProfile -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;

/** Commands in cmd.exe syntax, run from the worktree. */
const probes: { name: string; cmd: string }[] = [
  { name: "whoami", cmd: "whoami" },
  { name: "write-cwd", cmd: "echo x> .scratch\\probe-cwd.txt && type .scratch\\probe-cwd.txt" },
  { name: "write-outside", cmd: `echo x> ${outsideFile}` },
  { name: "write-temp", cmd: "echo x> %TEMP%\\scribe-probe-temp.txt && echo %TEMP%" },
  { name: "git-status", cmd: "git status --short --branch" },
  { name: "write-gitdir", cmd: "git update-ref refs/scribe-probe/w HEAD && git rev-parse --short refs/scribe-probe/w" },
  { name: "node-version", cmd: "node --version" },
  { name: "read-junction", cmd: "node .scratch\\probe-resolve.cjs" },
  { name: "read-secret", cmd: len(secretFile) },
  { name: "read-scribe-token", cmd: len(path.join(scribeData, "local-token")) },
  { name: "read-codex-auth", cmd: len(path.join(os.homedir(), ".codex", "auth.json")) },
  // The same reads without Node: under srt-win, Node scripts in a worktree under the profile fail before reading.
  { name: "read-secret-cmd", cmd: `type ${secretFile}` },
  { name: "read-scribe-token-cmd", cmd: `type ${path.join(scribeData, "local-token")} > NUL && echo readable` },
  { name: "read-git-config-cmd", cmd: `type ${path.join(os.homedir(), ".gitconfig")} > NUL && echo readable` },
  { name: "net-node-allowed", cmd: fetchJs("https://registry.npmjs.org/") },
  { name: "net-node-other", cmd: fetchJs("https://www.iana.org") },
  { name: "net-curl-schannel", cmd: "%SystemRoot%\\System32\\curl.exe -sS -o NUL -w %{http_code} https://registry.npmjs.org/" },
  { name: "net-iwr", cmd: ps("(Invoke-WebRequest https://registry.npmjs.org/ -UseBasicParsing).StatusCode") },
  { name: "net-git-https", cmd: "git ls-remote https://github.com/git/git HEAD" },
  { name: "net-loopback-daemon", cmd: fetchJs(`http://127.0.0.1:${daemonPort}/`) },
];

function clip(text: string) {
  const t = text.replace(/\r/g, "").trim();
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeout = 60_000): Promise<{ exit: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { out += " [timeout]"; child.kill(); }, timeout);
    child.on("error", (err) => { clearTimeout(timer); resolve({ exit: null, out: err.message }); });
    child.on("close", (exit) => { clearTimeout(timer); resolve({ exit, out }); });
  });
}

function setup() {
  fs.mkdirSync(path.join(cwd, ".scratch"), { recursive: true });
  for (const [name, code] of Object.entries(helpers)) fs.writeFileSync(path.join(cwd, ".scratch", name), code);
  fs.mkdirSync(secretDir, { recursive: true });
  fs.writeFileSync(secretFile, "planted secret\n");
}

function cleanup() {
  fs.rmSync(outsideFile, { force: true });
  spawnSync("git", ["update-ref", "-d", "refs/scribe-probe/w"], { cwd });
}

async function report(engine: string, exec: (cmd: string) => Promise<{ exit: number | null; out: string }>) {
  for (const probe of probes) {
    cleanup();
    const { exit, out } = await exec(probe.cmd);
    console.log(JSON.stringify({ engine, probe: probe.name, ok: exit === 0, exit, out: clip(out) }));
  }
  cleanup();
}

// ---------- Codex ----------

async function codex() {
  const cli = opt("codex-cli") ?? require.resolve("@openai/codex/bin/codex.js");
  const env = { ...process.env, CODEX_HOME: process.env.CODEX_HOME ?? path.join(scribeData, "agent", "codex") };
  const modes = (opt("modes") ?? "mxc,unelevated").split(",");
  const gitDir = gitCommonDir().replace(/\\/g, "/");
  for (const mode of modes) {
    // MXC only takes permission profiles; the legacy modes take the sandbox_mode keys Scribe sends today.
    const config = mode === "mxc"
      ? ["-c", "windows.sandbox=mxc", "--permission-profile", ":workspace"]
      : ["-c", `windows.sandbox=${mode}`, "-c", "sandbox_mode=workspace-write",
         "-c", `sandbox_workspace_write.writable_roots=["${gitDir}"]`,
         "-c", `sandbox_workspace_write.network_access=${flag("net")}`];
    await report(`codex-${mode}`, (cmd) => run(process.execPath, [cli, "sandbox", ...config, "--", "cmd.exe", "/d", "/c", cmd], env));
  }
}


/** What thread/start reports for an MXC permission profile, the shape Scribe would send (config only, no turn). */
async function codexRpc() {
  const { CodexRpc } = await import("../src/agent/providers/codexRpc.js");
  const cli = opt("codex-cli") ?? require.resolve("@openai/codex/bin/codex.js");
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-mxc-probe-"));
  const profile = (network: boolean) => ({
    "windows.sandbox": "mxc",
    default_permissions: "scribe",
    permissions: { scribe: {
      extends: ":workspace",
      workspace_roots: { [gitCommonDir().replace(/\\/g, "/")]: true },
      network: { enabled: network },
      filesystem: { [path.join(scribeData, "local-token").replace(/\\/g, "/")]: "deny" },
    } },
  });
  const cases = [
    { name: "mxc-profile-offline", config: profile(false) },
    { name: "mxc-profile-online", config: profile(true) },
    { name: "mxc-profile-env-set", config: { ...profile(false), shell_environment_policy: { inherit: "all", set: { SYSTEMROOT: process.env.SYSTEMROOT ?? "C:\\WINDOWS" } } } },
    { name: "mxc-profile-empty-cwd", config: profile(false), cwd: fs.mkdtempSync(path.join(os.tmpdir(), "scribe-mxc-cwd-")) },
    // Scribe sends `sandbox` today; with a profile it wins silently (writableRoots [] and the profile is dropped).
    { name: "mxc-profile-plus-sandbox-mode", config: profile(false), sandbox: "workspace-write" },
  ] as { name: string; config: Record<string, unknown>; sandbox?: string; cwd?: string }[];
  const rpc = CodexRpc.launch(cli, env, () => {}, () => {});
  try {
    await rpc.call("initialize", { clientInfo: { name: "scribe-sandbox-probe", version: "1" }, capabilities: { experimentalApi: true } });
    rpc.notify("initialized");
    for (const test of cases) {
      try {
        const result = await rpc.call("thread/start", {
          cwd: test.cwd ?? cwd, approvalPolicy: "on-request", ephemeral: true, ...(test.sandbox ? { sandbox: test.sandbox } : {}),
          config: { web_search: "disabled", ...test.config },
        }) as Record<string, unknown>;
        console.log(JSON.stringify({ engine: "codex-rpc", probe: test.name, sandbox: result.sandbox, permissions: result.permissions ?? result.permissionProfile }));
      } catch (error) {
        console.log(JSON.stringify({ engine: "codex-rpc", probe: test.name, error: (error as Error).message }));
      }
    }
  } finally {
    rpc.close();
  }
}

// ---------- srt ----------

type Srt = typeof import("@anthropic-ai/sandbox-runtime");

async function loadSrt(): Promise<Srt> {
  const dir = opt("pkg");
  if (!dir) throw new Error("--pkg <dir of @anthropic-ai/sandbox-runtime> is required");
  return import(pathToFileURL(path.join(dir, "dist", "index.js")).href) as Promise<Srt>;
}

/** The sandbox user starts srt-win's runner, so the exe must sit where it can read it: not under the user's profile. */
function srtWinPath(lib: Srt) {
  return opt("srt-win") ?? lib.VENDORED_SRT_WIN_EXE;
}

/** A worktree's node_modules is a junction into the main checkout, whose dist/ the MCP bridge runs from. */
function mainCheckoutDir() {
  return path.dirname(fs.realpathSync(path.join(cwd, "node_modules")));
}

function srtConfig(lib: Srt) {
  const gitDir = gitCommonDir();
  const mainCheckout = mainCheckoutDir();
  const nodeDir = path.dirname(fs.realpathSync(process.execPath));
  return {
    network: {
      allowedDomains: ["registry.npmjs.org", "github.com", "*.github.com", "api.anthropic.com", "*.anthropic.com", "claude.ai", "*.claude.ai"],
      deniedDomains: [],
      allowLocalBinding: flag("loopback"),
    },
    filesystem: {
      denyRead: [secretDir, path.join(scribeData, "local-token")],
      // The worktree's node_modules is a junction into the main checkout; srt grants the real target.
      allowRead: [cwd, mainCheckout, nodeDir, ...(opt("config-dir") ? [opt("config-dir")!] : [])],
      allowWrite: [cwd, gitDir, ...(opt("config-dir") ? [opt("config-dir")!] : [])],
      denyWrite: [],
    },
    windows: { srtWin: { path: srtWinPath(lib) } },
  };
}

async function srt() {
  const lib = await loadSrt();
  await lib.SandboxManager.initialize(srtConfig(lib) as never);
  try {
    await report("srt-win", async (cmd) => {
      const wrapped = await lib.SandboxManager.wrapWithSandboxArgv(cmd, "cmd", undefined, undefined, cwd);
      return run(wrapped.argv[0], wrapped.argv.slice(1), wrapped.env);
    });
  } finally {
    await lib.SandboxManager.reset();
  }
}

async function status() {
  const lib = await loadSrt();
  const srtWin = { exe: srtWinPath(lib), prependArgs: [] };
  console.log(JSON.stringify(await lib.checkWindowsSandboxStatusAsync({ srtWin })));
  console.log(JSON.stringify(await lib.verifyWindowsWfpEgress({ srtWin, allowLoopback: flag("loopback") } as never)));
}

// ---------- Claude under srt ----------

async function claude() {
  const lib = await loadSrt();
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  await lib.SandboxManager.initialize(srtConfig(lib) as never);
  // cmd.exe, not PowerShell: Windows PowerShell 5.1 does not hand its redirected stdin to a native child, so the CLI
  // never gets its stream-json input. Arguments are quoted for the CLI's own (msvcrt) parser.
  const quote = (arg: string) => /[\s"]/.test(arg) ? `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"` : arg;
  const configDir = opt("config-dir");
  // srt-win exec does not forward a piped stdin (0.0.81), and the CLI takes its stream-json input there. With
  // --stdin-relay a small Node relay inside the sandbox reads it from a loopback socket instead (needs --loopback).
  const net = await import("node:net");
  const relayFile = path.join(cwd, ".scratch", "stdin-relay.cjs");
  fs.writeFileSync(relayFile, RELAY);
  try {
    const entry = path.join(mainCheckoutDir(), "dist", "index.js");
    const messages = query({
      prompt: opt("prompt") ?? "Run the Bash command `whoami && echo SANDBOX_BASH_OK` and reply with its output only.",
      options: {
        cwd,
        model: "haiku",
        maxTurns: 3,
        persistSession: false,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: { scribe: { type: "stdio", command: process.execPath, args: [entry], env: { SCRIBE_PORT: String(daemonPort) } } },
        env: { ...process.env, ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) },
        stderr: (line) => process.stderr.write(`[claude stderr] ${line}`),
        spawnClaudeCodeProcess: (o) => {
          let relayPort = 0;
          const server = flag("stdin-relay") ? net.createServer((socket) => { stdin.pipe(socket); socket.on("error", () => {}); server!.close(); }) : undefined;
          const listening = server ? new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => { relayPort = (server.address() as { port: number }).port; resolve(); })) : Promise.resolve();
          // node --preserve-symlinks-main: the relay sits in the worktree, under the profile, whose parents the sandbox user cannot stat.
          // srt-win gives the child the sandbox user's environment plus only srt's own overlay, so the relay sets the
          // variables the SDK added (CLAUDE_CONFIG_DIR, its entrypoint flags) from a file.
          const envFile = path.join(cwd, ".scratch", "claude-env.json");
          fs.writeFileSync(envFile, JSON.stringify(Object.fromEntries(Object.entries(o.env).filter(([k, v]) => v !== undefined && process.env[k] !== v))));
          const commandFor = () => [...(server ? [process.execPath, "--preserve-symlinks-main", "--preserve-symlinks", relayFile, String(relayPort), envFile] : []), o.command, ...o.args].map(quote).join(" ");
          let command = "";
          let child: ReturnType<typeof spawn> | undefined;
          // wrapWithSandboxArgv is async; hand the SDK a process whose streams are wired once it starts.
          const { PassThrough } = require("node:stream") as typeof import("node:stream");
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
          const proxy = {
            stdin, stdout, killed: false, exitCode: null as number | null,
            kill: () => { child?.kill(); return true; },
            on: (event: string, fn: (...a: unknown[]) => void) => { (listeners[event] ??= []).push(fn); },
            once: (event: string, fn: (...a: unknown[]) => void) => { (listeners[event] ??= []).push(fn); },
            off: () => {},
          };
          void listening.then(() => { command = commandFor(); return lib.SandboxManager.wrapWithSandboxArgv(command, "cmd", undefined, undefined, o.cwd ?? cwd); }).then((w) => {
            // srt's proxy variables win over the SDK's copy of the environment.
            child = spawn(w.argv[0], w.argv.slice(1), { cwd: o.cwd ?? cwd, env: { ...o.env, ...w.env }, windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
            if (flag("debug")) {
              console.error(`[probe] spawned ${w.argv[0]} (${w.argv.length} args), CLI command ${command.length} chars`);
              fs.writeFileSync(path.join(cwd, ".scratch", "claude-argv.json"), JSON.stringify({ command, argv: w.argv.map((a) => a.replace(/srt:[^@]*@/, "srt:<token>@")) }, null, 1));
            }
            if (!server) stdin.pipe(child.stdin!);
            child.stdout!.pipe(stdout);
            child.on("exit", (code, sig) => { if (flag("debug")) console.error(`[probe] claude exit ${code} ${sig}`); proxy.exitCode = code; for (const fn of listeners.exit ?? []) fn(code, sig); });
            child.on("error", (err) => { for (const fn of listeners.error ?? []) fn(err); });
          }, (err) => { for (const fn of listeners.error ?? []) fn(err); });
          return proxy as never;
        },
      },
    });
    for await (const m of messages) {
      const msg = m as Record<string, unknown>;
      if (msg.type === "system" && msg.subtype === "init") console.log(JSON.stringify({ engine: "claude-srt", init: { apiKeySource: msg.apiKeySource, mcp: msg.mcp_servers, model: msg.model } }));
      if (msg.type === "user") console.log(JSON.stringify({ engine: "claude-srt", toolResult: clip(JSON.stringify((msg.message as { content: unknown }).content)) }));
      if (msg.type === "result") console.log(JSON.stringify({ engine: "claude-srt", result: msg.subtype, text: clip(String(msg.result ?? "")), error: msg.is_error }));
    }
  } finally {
    await lib.SandboxManager.reset();
  }
}

/** Runs inside the sandbox: connect to the host's port, pipe it into the command's stdin, pass stdout and stderr through. */
const RELAY = `const net = require("net"), { spawn } = require("child_process");
const [port, envFile, file, ...args] = process.argv.slice(2);
const env = { ...process.env, ...JSON.parse(require("fs").readFileSync(envFile, "utf8")) };
const child = spawn(file, args, { env, stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
const socket = net.connect(Number(port), "127.0.0.1", () => socket.pipe(child.stdin));
socket.on("error", (e) => { console.error("relay: " + e.message); child.kill(); });
child.on("exit", (code) => { socket.destroy(); process.exit(code ?? 1); });
`;

setup();
const engine = argv[0];
if (engine === "codex") await codex();
else if (engine === "codex-rpc") await codexRpc();
else if (engine === "srt") await srt();
else if (engine === "claude") await claude();
else if (engine === "status") await status();
else console.error("usage: probe-windows-sandbox.ts codex|srt|claude|status [options]");
