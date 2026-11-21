// Linux side of npm run desktop:install: a per-user install with no root. The exe goes in
// ~/.local/share/scribe-desktop, with a menu entry, hicolor icons and a ~/.local/bin/scribe-desktop link.
// Launch at startup stays a setting in the app (desktop/src/startup.rs writes ~/.config/autostart/scribe.desktop).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ICONS = [
  ["32x32", "32x32.png"],
  ["128x128", "128x128.png"],
  ["256x256", "128x128@2x.png"],
  ["512x512", "icon.png"],
];
const ICON_NAME = "scribe";
const DESKTOP_FILE = "scribe.desktop";
const LINK = "scribe-desktop";

function xdg(name, fallback) {
  const dir = process.env[name];
  return dir && path.isAbsolute(dir) ? dir : path.join(os.homedir(), fallback);
}
const dataHome = () => xdg("XDG_DATA_HOME", path.join(".local", "share"));
const configHome = () => xdg("XDG_CONFIG_HOME", ".config");
const binDir = () => path.join(os.homedir(), ".local", "bin");
const menuEntry = () => path.join(dataHome(), "applications", DESKTOP_FILE);
const autostartEntry = () => path.join(configHome(), "autostart", DESKTOP_FILE);

export function defaultFolder() {
  return path.join(dataHome(), "scribe-desktop");
}

/** The daemon's data folder (src/config.ts) is not a place for the program. */
export function checkFolder(folder) {
  const data = [process.env.SCRIBE_HOME, path.join(dataHome(), "scribe"), path.join(os.homedir(), "scribe")].filter(Boolean);
  if (data.some((dir) => path.resolve(dir) === folder)) {
    console.error(`${folder} is Scribe's data folder; install the app somewhere else (default ${defaultFolder()}).`);
    process.exit(1);
  }
}

export function isInside(file, dir) {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Running copies of the app: [{ pid, exe }] from /proc, by executable name. */
export function runningApps(names) {
  const apps = [];
  for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    let exe;
    try {
      exe = fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      continue;
    }
    // A copy whose file was replaced since it started reads "<path> (deleted)".
    exe = exe.replace(/ \(deleted\)$/, "");
    if (names.includes(path.basename(exe))) apps.push({ pid: Number(pid), exe });
  }
  return apps;
}

export function signal(apps, sig) {
  for (const { pid } of apps) {
    try {
      process.kill(pid, sig);
    } catch {}
  }
}

/** Menu entry, icons and a command-line link for the installed exe. */
export function integrate(root, installed) {
  const icons = path.join(dataHome(), "icons", "hicolor");
  for (const [size, file] of ICONS) {
    const dir = path.join(icons, size, "apps");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(root, "desktop", "icons", file), path.join(dir, `${ICON_NAME}.png`));
  }
  writeAtomic(menuEntry(), [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Scribe",
    "GenericName=Page hub",
    "Comment=A local hub of HTML pages that you and your agents share",
    `Exec=${execArg(installed)}`,
    `TryExec=${keyString(installed)}`,
    `Icon=${ICON_NAME}`,
    // Tauri's GTK window class is the binary name, so docks and Wayland compositors match it to this entry.
    "StartupWMClass=scribe",
    "Terminal=false",
    "Categories=Utility;",
    "",
  ].join("\n"));
  fs.mkdirSync(binDir(), { recursive: true });
  const link = path.join(binDir(), LINK);
  fs.rmSync(link, { force: true });
  fs.symlinkSync(installed, link);
  quiet("gtk-update-icon-cache", ["-q", "-t", "-f", icons]);
  quiet("update-desktop-database", ["-q", path.dirname(menuEntry())]);
  console.log(`Menu entry: ${menuEntry()}`);
  console.log(`Icons: ${icons}/*/apps/${ICON_NAME}.png`);
  console.log(`Command: ${link}`);
  if (!(process.env.PATH ?? "").split(path.delimiter).includes(binDir())) {
    console.log(`(${binDir()} is not on PATH; the menu entry works regardless.)`);
  }
}

/** Removes what install and the app's launch-at-startup setting added. Leaves the data folder alone. */
export function uninstall(folder = defaultFolder()) {
  folder = path.resolve(folder);
  checkFolder(folder);
  const exe = path.join(folder, "scribe");
  const running = runningApps(["scribe"]).filter((app) => app.exe === exe);
  if (running.length) {
    console.error(`Close the running app first (${exe}, pid ${running.map((app) => app.pid).join(", ")}).`);
    process.exit(1);
  }
  const link = path.join(binDir(), LINK);
  let linked = false;
  try {
    linked = fs.readlinkSync(link) === exe;
  } catch {}
  const icons = path.join(dataHome(), "icons", "hicolor");
  const files = [
    exe,
    menuEntry(),
    ...ICONS.map(([size]) => path.join(icons, size, "apps", `${ICON_NAME}.png`)),
    ...(linked ? [link] : []),
    ...(isOurAutostart(exe) ? [autostartEntry()] : []),
  ];
  for (const file of files) {
    if (fs.existsSync(file) || isSymlink(file)) {
      fs.rmSync(file, { force: true });
      console.log(`Removed ${file}`);
    }
  }
  try {
    fs.rmdirSync(folder);
  } catch {}
  quiet("gtk-update-icon-cache", ["-q", "-t", "-f", icons]);
  quiet("update-desktop-database", ["-q", path.dirname(menuEntry())]);
}

function isOurAutostart(exe) {
  try {
    return fs.readFileSync(autostartEntry(), "utf8").includes(keyString(exe));
  } catch {
    return false;
  }
}

function isSymlink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staged = `${file}.tmp`;
  fs.writeFileSync(staged, text);
  fs.renameSync(staged, file);
}

/** A key file string value: backslashes doubled (Desktop Entry spec). */
function keyString(value) {
  return value.replace(/\\/g, "\\\\");
}

/** One quoted Exec argument, the same quoting as desktop/src/startup.rs. */
function execArg(arg) {
  return keyString(`"${arg.replace(/["`$\\]/g, "\\$&").replace(/%/g, "%%")}"`);
}

function quiet(command, args) {
  spawnSync(command, args, { stdio: "ignore" });
}
