import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INSTALL_ROOT } from "./config.js";

/**
 * `scribe service install | uninstall | status` (#909): run the daemon at boot (Linux) or logon
 * (Windows) with no desktop shell, for an always-on or headless device. It runs as the user who
 * installs it, not as root or SYSTEM: the data folder, provider logins (Claude, Codex, Cursor) and
 * worktrees are all that user's.
 *
 * Linux: a systemd user unit, plus lingering so it starts at boot without a login session.
 * Windows: a Task Scheduler task at logon (a real Windows service would run as SYSTEM, or need the
 * user's password), started hidden through conhost --headless, and restarted if it fails.
 */

export const SERVICE_NAME = "scribe";
const WINDOWS_TASK = "Scribe";

export type ServicePlan = {
  node: string;
  entry: string;
  cwd: string;
  /** Settings the daemon was installed with (SCRIBE_HOME, SCRIBE_PORT, SCRIBE_PEER_PORT, …). */
  env: Record<string, string>;
};

/** The command line and settings the service runs with: this install's node and dist/index.js. */
export function servicePlan(env: NodeJS.ProcessEnv = process.env): ServicePlan {
  const kept = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => /^SCRIBE_(HOME|PORT|PEER_PORT|PEER_HOSTS|PAGE_HOST|AGENT_PORT)$/.test(entry[0]) && !!entry[1])
  );
  return { node: process.execPath, entry: path.join(INSTALL_ROOT, "dist", "index.js"), cwd: INSTALL_ROOT, env: kept };
}

function systemdQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The systemd user unit. A clean exit (`scribe --stop`, a restart for an update) is not restarted. */
export function systemdUnit(plan: ServicePlan): string {
  return [
    "[Unit]",
    "Description=Scribe daemon (headless)",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdQuote(plan.cwd)}`,
    `ExecStart=${systemdQuote(plan.node)} ${systemdQuote(plan.entry)} --daemon`,
    ...Object.entries(plan.env).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`),
    // Agents' tools (git, npx) come from the PATH the user had when installing.
    `Environment=${systemdQuote(`PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`)}`,
    "Restart=on-failure",
    "RestartSec=5",
    // Agent chats and their tools are the daemon's children; stopping the service stops them too.
    "KillMode=mixed",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The PowerShell that registers the Windows logon task. */
export function windowsTaskScript(plan: ServicePlan, user: string): string {
  const quoted = (value: string) => `"${value}"`;
  const daemon = [quoted(plan.node), quoted(plan.entry), "--daemon"].join(" ");
  // The task's environment is the user's; settings the install was made with go in through cmd's set,
  // inside the headless console so no window shows.
  const sets = Object.entries(plan.env).map(([key, value]) => `set "${key}=${value}"&&`).join(" ");
  const argument = sets ? `--headless cmd.exe /d /c ${sets} ${daemon}` : `--headless ${daemon}`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${psQuote(argument)} -WorkingDirectory ${psQuote(plan.cwd)}`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User ${psQuote(user)}`,
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew",
    `Register-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK)} -Description 'Scribe daemon (headless)' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
  ].join("\n");
}

function unitPath(): string {
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(config, "systemd", "user", `${SERVICE_NAME}.service`);
}

function run(command: string, args: string[], options: { quiet?: boolean } = {}): string {
  return execFileSync(command, args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", options.quiet ? "ignore" : "pipe"] });
}

function tryRun(command: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: run(command, args, { quiet: true }) };
  } catch (err) {
    const out = (err as { stdout?: string }).stdout ?? "";
    return { ok: false, out };
  }
}

function powershell(script: string): string {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
}

function requireBuild(plan: ServicePlan): void {
  if (!fs.existsSync(plan.entry)) throw new Error(`${plan.entry} is missing. Build Scribe first (npm run build).`);
}

/** Install and start the service. Returns what to tell the user. */
export function installService(): string {
  const plan = servicePlan();
  requireBuild(plan);
  if (process.platform === "linux") {
    const file = unitPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, systemdUnit(plan));
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", `${SERVICE_NAME}.service`]);
    const lines = [`Installed ${file} and started it.`];
    // Lingering starts the user's services at boot, before (or without) a login.
    const linger = tryRun("loginctl", ["show-user", os.userInfo().username, "--property=Linger", "--value"]);
    if (linger.out.trim() !== "yes" && !tryRun("loginctl", ["enable-linger", os.userInfo().username]).ok) {
      lines.push(`To start it at boot without logging in, run: sudo loginctl enable-linger ${os.userInfo().username}`);
    }
    lines.push("Pair it with: scribe pair <code>   (the code Settings → Devices → Add device shows on another device)");
    return lines.join("\n");
  }
  if (process.platform === "win32") {
    const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username;
    powershell(windowsTaskScript(plan, user));
    powershell(`Start-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK)}`);
    return [
      `Registered the "${WINDOWS_TASK}" task (at logon, hidden, restarted if it fails) and started it.`,
      "To have it start at boot without logging in, set it to \"Run whether user is logged on or not\" in Task Scheduler (it asks for your password).",
      "Pair it with: scribe pair <code>",
    ].join("\n");
  }
  throw new Error("scribe service supports Linux (systemd) and Windows. On macOS, run npm start under launchd yourself.");
}

export function uninstallService(): string {
  if (process.platform === "linux") {
    const file = unitPath();
    tryRun("systemctl", ["--user", "disable", "--now", `${SERVICE_NAME}.service`]);
    const existed = fs.existsSync(file);
    fs.rmSync(file, { force: true });
    tryRun("systemctl", ["--user", "daemon-reload"]);
    return existed ? `Stopped and removed ${file}.` : "The service was not installed.";
  }
  if (process.platform === "win32") {
    const name = psQuote(WINDOWS_TASK);
    const out = powershell(
      `$task = Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue; if ($task) { Stop-ScheduledTask -TaskName ${name}; Unregister-ScheduledTask -TaskName ${name} -Confirm:$false; 'removed' }`
    );
    return out.includes("removed") ? `Removed the "${WINDOWS_TASK}" task. A daemon it started keeps running until scribe --stop.` : "The service was not installed.";
  }
  throw new Error("scribe service supports Linux (systemd) and Windows.");
}

export function serviceStatus(): string {
  if (process.platform === "linux") {
    if (!fs.existsSync(unitPath())) return "Not installed.";
    const active = tryRun("systemctl", ["--user", "is-active", `${SERVICE_NAME}.service`]).out.trim() || "unknown";
    const enabled = tryRun("systemctl", ["--user", "is-enabled", `${SERVICE_NAME}.service`]).out.trim() || "unknown";
    const linger = tryRun("loginctl", ["show-user", os.userInfo().username, "--property=Linger", "--value"]).out.trim();
    return `Installed (${unitPath()}): ${active}, ${enabled}${linger === "yes" ? ", starts at boot" : ", starts at login"}.`;
  }
  if (process.platform === "win32") {
    const out = powershell(
      `$task = Get-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK)} -ErrorAction SilentlyContinue; if ($task) { $task.State } else { 'missing' }`
    ).trim();
    return out === "missing" ? "Not installed." : `Installed (task "${WINDOWS_TASK}"): ${out.toLowerCase()}.`;
  }
  return "Not supported on this platform.";
}
