// Builds the release desktop app and copies the exe into a folder, replacing a running copy.
// Usage: npm run desktop:install -- <target folder>
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installRelease } from "./install-release.mjs";
import { requireToolchain, tauriCli } from "./cargo-env.mjs";

const EXE = "scribe.exe";
const PREVIOUS_EXES = ["agent-board-desktop.exe", "board.exe"];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const target = process.argv[2];
if (!target) {
  console.error("Usage: npm run desktop:install -- <target folder>");
  process.exit(1);
}
const installed = path.join(path.resolve(target), EXE);

const env = requireToolchain(root);
const tauriJs = tauriCli(root);

// Cargo may use CARGO_TARGET_DIR or a configured target-dir (including in worktrees).
const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--manifest-path", path.join(root, "desktop", "Cargo.toml"), "--format-version", "1", "--no-deps"], { cwd: root, env, encoding: "utf8" }));
const built = path.join(metadata.target_directory, "release", EXE);

console.log("Building the release app");
const build = spawnSync(process.execPath, [tauriJs, "build", "--no-bundle"], { cwd: root, stdio: "inherit", env });
if (build.status !== 0) {
  console.error("Release build failed");
  process.exit(build.status ?? 1);
}

try {
  await installRelease({ built, installed, runningApps, stop: stopApp, restart: restartApp });
} catch (error) {
  console.error("Desktop installation failed:", error);
  process.exit(1);
}
for (const name of PREVIOUS_EXES) {
  const leftover = path.join(path.dirname(installed), name);
  if (fs.existsSync(leftover)) {
    try {
      fs.unlinkSync(leftover);
    } catch (error) {
      console.warn(`Could not remove ${leftover}: ${error.message}`);
    }
  }
}
console.log(`Copied to ${installed}`);

function processNames() {
  return [EXE, ...PREVIOUS_EXES];
}

function isImageRunning(name) {
  const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/NH"], { encoding: "utf8" });
  return out.toLowerCase().includes(name.toLowerCase());
}

function isRunning() {
  return processNames().some(isImageRunning);
}

// Capture the actual paths, including an older executable name or another install folder.
function runningApps() {
  const names = processNames().map((name) => `'${path.parse(name).name}'`).join(",");
  const script = `$ErrorActionPreference = 'Stop'; $apps = @(Get-Process -Name ${names} -ErrorAction SilentlyContinue); $paths = @($apps | ForEach-Object { if (!$_.Path) { throw 'Cannot read the running desktop executable path' }; $_.Path } | Select-Object -Unique); ConvertTo-Json -InputObject $paths -Compress`;
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }));
}

// Launching also points agents at this copy (it rewrites desktop.json on start).
async function restartApp(executable, recovering) {
  if (recovering && runningApps().some((app) => app.toLowerCase() === executable.toLowerCase())) return;
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
  console.log(recovering ? `Restarted the previous desktop app: ${executable}` : "Restarted the desktop app");
}

/** Ask the window to close first so it saves its layout; force it only if that does not work. */
function stopApp() {
  console.log("Closing the desktop app");
  for (const name of processNames().filter(isImageRunning)) {
    spawnSync("taskkill", ["/IM", name], { stdio: "ignore" });
  }
  if (waitForExit(5000)) {
    return;
  }
  for (const name of processNames().filter(isImageRunning)) {
    spawnSync("taskkill", ["/IM", name, "/F"], { stdio: "ignore" });
  }
  if (!waitForExit(5000)) {
    throw new Error("The desktop app is still running; close it and try again");
  }
}

function waitForExit(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!isRunning()) {
      return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return !isRunning();
}
