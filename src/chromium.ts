import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { sweepChromiumLeftovers } from "./chromiumSweep.js";
import { log } from "./log.js";

const CHANNELS = ["msedge", "chrome"] as const;
const CHROMIUM_EXES = ["msedge.exe", "chrome.exe", "brave.exe"] as const;
const CHROMIUM_RELS = [
  path.join("Microsoft", "Edge", "Application", "msedge.exe"),
  path.join("Google", "Chrome", "Application", "chrome.exe"),
  path.join("BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
];

/**
 * Launches the user's installed Chromium (Edge, Chrome, or Brave): Scribe ships no browser
 * download. `purpose` names it in the log and in the error when none can start.
 */
export async function launchChromium(options: { headless: boolean; args: string[]; purpose: string }): Promise<Browser> {
  const { headless, args, purpose } = options;
  sweepChromiumLeftovers();
  const errors: string[] = [];
  for (const channel of CHANNELS) {
    try {
      const opened = await chromium.launch({ channel, headless, args });
      log(`${purpose} browser launched (${channel})`);
      return opened;
    } catch (err) {
      errors.push(`${channel}: ${(err as Error).message}`);
    }
  }
  for (const executablePath of chromiumExecutables()) {
    try {
      const opened = await chromium.launch({ executablePath, headless, args });
      log(`${purpose} browser launched (${executablePath})`);
      return opened;
    } catch (err) {
      errors.push(`${executablePath}: ${(err as Error).message}`);
    }
  }
  throw new Error(
    `Could not launch a Chromium browser (${purpose}). Install Microsoft Edge, Google Chrome, or Brave. ${errors.join("; ")}`
  );
}

function chromiumExecutables(): string[] {
  const found = new Set<string>();
  const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter(
    (value): value is string => Boolean(value)
  );
  for (const root of roots) {
    for (const rel of CHROMIUM_RELS) {
      const candidate = path.join(root, rel);
      if (fs.existsSync(candidate)) {
        found.add(candidate);
      }
    }
  }
  for (const exe of CHROMIUM_EXES) {
    const fromReg = appPath(exe);
    if (fromReg && fs.existsSync(fromReg)) {
      found.add(fromReg);
    }
  }
  return [...found];
}

function appPath(exe: string): string | undefined {
  const keys = [
    `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\${exe}`,
    `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\${exe}`,
  ];
  for (const key of keys) {
    const result = spawnSync("reg", ["query", key, "/ve"], { encoding: "utf8", windowsHide: true });
    const match = result.stdout?.match(/REG_SZ\s+(.+\.exe)/i);
    if (match) {
      return match[1].trim().replace(/^"|"$/g, "");
    }
  }
  return undefined;
}
