import { spawn, spawnSync } from "node:child_process";
import { sandboxedRun, type SandboxHooks } from "./sandbox.js";

/**
 * Shell commands Scribe runs itself on an agent's behalf, after the user approved them. Used where
 * a provider has no approval hook of its own (Cursor's SDK): its built-in shell is turned off and
 * this takes its place, so Scribe can ask before each command.
 */

export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_OUTPUT_CHARS = 30_000;

export type CommandResult = { output: string; exitCode: number | null; timedOut: boolean; cancelled: boolean };

/** The shell a command line runs in: PowerShell on Windows (as Cursor's own shell), $SHELL or sh elsewhere. */
export function shellFor(command: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === "win32") return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
  return { file: process.env.SHELL || "/bin/sh", args: ["-c", command] };
}

/** Long output keeps its start and its end, where errors and summaries usually are. */
export function clipOutput(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return `${text.slice(0, head)}\n… (${text.length - max} characters cut) …\n${text.slice(text.length - tail)}`;
}

export function clampTimeout(ms: unknown): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.round(ms), MAX_TIMEOUT_MS);
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * Run one command line to the end (or the timeout, or the signal), with stdout and stderr interleaved.
 * With the thread's sandbox (#899) it runs under srt, and what it refused is added to the output.
 */
export async function runCommand(opts: { command: string; cwd: string; timeoutMs?: number; signal?: AbortSignal; sandbox?: SandboxHooks | null }): Promise<CommandResult> {
  const { result, note } = await sandboxedRun(opts.sandbox, opts.command, { signal: opts.signal }, (line) => spawnCommand({ ...opts, command: line }));
  return note ? { ...result, output: clipOutput(`${result.output}${result.output ? "\n" : ""}${note}`) } : result;
}

function spawnCommand(opts: { command: string; cwd: string; timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const { file, args } = shellFor(opts.command);
    let output = "";
    let timedOut = false;
    let cancelled = false;
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: { ...process.env, CURSOR_AGENT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Its own process group, so a kill takes its children too.
      detached: process.platform !== "win32",
    });
    const take = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      // Never hold much more than the result can show.
      if (output.length > MAX_OUTPUT_CHARS * 4) output = clipOutput(output, MAX_OUTPUT_CHARS * 2);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => {
      cancelled = true;
      killTree(child.pid);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (exitCode: number | null, error?: Error) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (error) output += `${output ? "\n" : ""}${error.message}`;
      resolve({ output: clipOutput(output), exitCode, timedOut, cancelled });
    };
    child.on("error", (err) => done(null, err));
    child.on("close", (code) => done(code));
  });
}
