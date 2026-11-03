import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * macOS: an app opened from Finder or the Dock, and a launchd agent, start with launchd's bare PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin). Homebrew's git and node, npx for MCP servers, and the CLIs agents
 * call are then missing. The daemon adds the PATH a login shell sets up (and Homebrew's usual folders
 * if that fails), keeping what it already had first.
 */
export function adoptLoginPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): void {
  if (platform !== "darwin") return;
  env.PATH = mergePath(env.PATH ?? "", [...loginShellPath(env), ...fallbackDirs()]);
}

/** `current` first, then the entries of `extra` it lacks. */
export function mergePath(current: string, extra: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...current.split(":"), ...extra]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out.join(":");
}

function loginShellPath(env: NodeJS.ProcessEnv): string[] {
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : "/bin/zsh";
  try {
    // Markers keep shell greetings and rc-file output out of the answer.
    const out = execFileSync(shell, ["-ilc", 'printf "__SCRIBE_PATH__%s__SCRIBE_PATH__" "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /__SCRIBE_PATH__(.*?)__SCRIBE_PATH__/s.exec(out);
    return match ? match[1].split(":") : [];
  } catch {
    return [];
  }
}

function fallbackDirs(): string[] {
  return ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin")].filter((dir) => fs.existsSync(dir));
}
