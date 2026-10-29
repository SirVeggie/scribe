// Shared by the desktop build scripts: find the Tauri CLI and a Rust toolchain.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cargoBin = path.join(os.homedir(), ".cargo", "bin");

export function tauriCli(root) {
  return path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
}

/** Exits with instructions when the Tauri CLI or cargo is missing; otherwise returns an env with cargo on PATH. */
export function requireToolchain(root) {
  const env = envWithCargo();
  if (!fs.existsSync(tauriCli(root))) {
    console.error("The Tauri CLI is not installed (missing node_modules/@tauri-apps/cli).");
    console.error("Run npm install in this repo, then retry.");
    process.exit(1);
  }
  if (!commandExists("cargo", env)) {
    console.error("cargo was not found. The desktop app is a Rust/Tauri binary; npm install does not install Rust.");
    console.error("Install a toolchain from https://rustup.rs/ (Windows: MSVC, plus Visual Studio C++ build tools), then retry.");
    process.exit(1);
  }
  return env;
}

function envWithCargo() {
  const env = { ...process.env };
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const current = env[key] ?? "";
  if (fs.existsSync(cargoBin) && !current.split(path.delimiter).includes(cargoBin)) {
    env[key] = `${cargoBin}${path.delimiter}${current}`;
  }
  return env;
}

function commandExists(name, env) {
  const file = process.platform === "win32" && !name.endsWith(".exe") ? `${name}.exe` : name;
  const key = Object.keys(env).find((n) => n.toLowerCase() === "path");
  const dirs = key ? env[key].split(path.delimiter) : [];
  return dirs.some((dir) => dir && fs.existsSync(path.join(dir, file)));
}
