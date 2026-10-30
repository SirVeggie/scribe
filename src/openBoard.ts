import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";

/** Written by the desktop app on every launch; its setting decides where agents open the board. */
type DesktopRegistration = { exe?: unknown; openFromAgents?: unknown };

/** Open the board at `url` in the desktop app when it is set up for that, else in the default browser. */
export function openBoard(url: string): void {
  const exe = desktopExe();
  if (exe) {
    quiet(spawn(exe, ["--open", url], { detached: true, stdio: "ignore" }));
    return;
  }
  openBrowser(url);
}

function desktopExe(): string | null {
  let registration: DesktopRegistration;
  try {
    registration = JSON.parse(fs.readFileSync(path.join(dataDir(), "desktop.json"), "utf8")) as DesktopRegistration;
  } catch {
    return null;
  }
  if (registration.openFromAgents === false || typeof registration.exe !== "string") {
    return null;
  }
  return fs.existsSync(registration.exe) ? registration.exe : null;
}

/** The default browser. A headless Linux box has none: the board is reached through a paired device (#909). */
function openBrowser(url: string): void {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  const [command, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  quiet(spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }));
}

/** A missing opener is not worth an uncaught error. */
function quiet(child: ChildProcess): void {
  child.once("error", () => {});
  child.unref();
}
