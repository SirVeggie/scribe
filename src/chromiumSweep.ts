import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cleans up after Playwright browsers whose owner was killed (a test run or agent stopped
 * partway). Playwright closes its browser on a normal exit, but a hard kill can leave the
 * browser's child processes running without their main process (seen spinning a CPU core
 * each for a day) and always leaves its `playwright_chromiumdev_profile-*` folder in the
 * temp dir. The sweep kills child groups whose main browser process is gone and removes
 * profile folders no running process uses.
 */

export const PROFILE_PREFIX = "playwright_chromiumdev_profile-";
/** Unused profile folders younger than this are left alone: a launch may be about to use one. */
const PROFILE_MIN_AGE_MS = 60 * 60 * 1000;
/** One sweep per this interval across all processes on the machine (tests launch many). */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export interface ProcInfo { pid: number; commandLine: string }

/** The Playwright profile folder a process was started with, or undefined. */
export function profileDirOf(commandLine: string): string | undefined {
  const match = commandLine.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/);
  const dir = match?.[1] ?? match?.[2];
  // Either separator: path.basename on Linux would not split a Windows path (#909).
  return dir && (dir.split(/[\\/]/).pop() ?? "").startsWith(PROFILE_PREFIX) ? dir : undefined;
}

/**
 * Splits Playwright browser processes into orphans (every process of a profile is a
 * `--type=` child: its main browser process is gone) and the profile folders still in use.
 */
export function classifyProcesses(procs: ProcInfo[]): { orphanPids: number[]; liveDirs: Set<string> } {
  const groups = new Map<string, ProcInfo[]>();
  for (const proc of procs) {
    const dir = profileDirOf(proc.commandLine);
    if (!dir) continue;
    const key = path.resolve(dir).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), proc]);
  }
  const orphanPids: number[] = [];
  const liveDirs = new Set<string>();
  for (const [dir, members] of groups) {
    if (members.some(proc => !/\s--type=/.test(proc.commandLine))) liveDirs.add(dir);
    else orphanPids.push(...members.map(proc => proc.pid));
  }
  return { orphanPids, liveDirs };
}

let lastSweep = 0;

/** Starts a sweep in the background unless one ran recently (in any process). Never throws. */
export function sweepChromiumLeftovers(now = Date.now()): void {
  if (process.env.SCRIBE_CHROMIUM_SWEEP === "0" || now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  const marker = path.join(os.tmpdir(), "scribe-chromium-sweep");
  try {
    if (now - fs.statSync(marker).mtimeMs < SWEEP_INTERVAL_MS) return;
  } catch { /* first sweep */ }
  try { fs.writeFileSync(marker, String(now)); } catch { /* best effort */ }
  void sweepNow(now).catch(() => undefined);
}

export async function sweepNow(now = Date.now()): Promise<void> {
  const procs = await listBrowserProcesses();
  if (!procs) return;
  const { orphanPids, liveDirs } = classifyProcesses(procs);
  for (const pid of orphanPids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  const tmp = os.tmpdir();
  let names: string[];
  try { names = await fs.promises.readdir(tmp); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const dir = path.join(tmp, name);
    if (liveDirs.has(path.resolve(dir).toLowerCase())) continue;
    try {
      const stat = await fs.promises.stat(dir);
      if (!stat.isDirectory() || now - stat.mtimeMs < PROFILE_MIN_AGE_MS) continue;
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 1 });
    } catch { /* in use or gone: next sweep */ }
  }
}

/** Processes whose command line names a Playwright profile; undefined when listing failed. */
function listBrowserProcesses(): Promise<ProcInfo[] | undefined> {
  return new Promise(resolve => {
    if (process.platform === "win32") {
      const script =
        `Get-CimInstance Win32_Process -Filter "CommandLine like '%${PROFILE_PREFIX}%'" | ` +
        "ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; commandLine = $_.CommandLine } } | ConvertTo-Json -Compress";
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
          if (err) return resolve(undefined);
          try {
            const parsed = stdout.trim() ? JSON.parse(stdout) : [];
            resolve((Array.isArray(parsed) ? parsed : [parsed]).filter(p => p && typeof p.commandLine === "string"));
          } catch { resolve(undefined); }
        });
    } else {
      execFile("ps", ["-axo", "pid=,args="], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(undefined);
        resolve(stdout.split("\n").flatMap(line => {
          const match = line.match(/^\s*(\d+)\s+(.*)$/);
          return match && match[2].includes(PROFILE_PREFIX) ? [{ pid: Number(match[1]), commandLine: match[2] }] : [];
        }));
      });
    }
  });
}
