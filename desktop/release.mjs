// Builds a Windows installer that bundles the desktop app with the daemon, its modules and Node, so it runs
// on a PC without Node or a Scribe checkout. Usage: npm run desktop:release
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireToolchain, tauriCli } from "./cargo-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "desktop");
// The app folder the installer puts beside scribe.exe (desktop/src/board.rs looks for it there). Kept on a
// short path: makensis cannot open files past 260 characters, and some module paths are long.
const stage = path.join(os.tmpdir(), "scribe-release-app");
const RUNTIME = ["dist", "public", "templates", "plugins", path.join(".cursor", "skills"), "package.json", "package-lock.json"];
const MIN_NODE = [22, 19];

if (process.platform !== "win32") {
  console.error("Release installers are built for Windows only for now.");
  process.exit(1);
}
const env = requireToolchain(root);
const node = process.env.SCRIBE_NODE || process.execPath;
checkNode(node);

run("Building the daemon", process.execPath, [npmCli(), "run", "build"], root);

console.log(`Staging the app in ${stage}`);
fs.rmSync(stage, { recursive: true, force: true });
for (const entry of RUNTIME) {
  fs.cpSync(path.join(root, entry), path.join(stage, entry), { recursive: true });
}
console.log("Copying node_modules");
// In a worktree node_modules is a junction to the main checkout's.
fs.cpSync(fs.realpathSync(path.join(root, "node_modules")), path.join(stage, "node_modules"), { recursive: true, filter: runtimeModuleFile });
run("Removing dev dependencies", process.execPath, [npmCli(), "prune", "--omit=dev", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], stage);
fs.mkdirSync(path.join(stage, "node"));
fs.copyFileSync(node, path.join(stage, "node", "node.exe"));

const config = {
  bundle: {
    resources: { [stage + path.sep]: "app/" },
    windows: { nsis: { installerHooks: "./nsis-hooks.nsh" } },
  },
};
run("Building the installer", process.execPath, [tauriCli(root), "build", "--config", JSON.stringify(config)], root, env);
fs.rmSync(stage, { recursive: true, force: true });

const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--manifest-path", path.join(desktop, "Cargo.toml"), "--format-version", "1", "--no-deps"], { cwd: root, env, encoding: "utf8" }));
const bundleDir = path.join(metadata.target_directory, "release", "bundle", "nsis");
for (const name of fs.readdirSync(bundleDir).filter((name) => name.endsWith(".exe"))) {
  const file = path.join(bundleDir, name);
  console.log(`Installer: ${file} (${Math.round(fs.statSync(file).size / 1024 / 1024)} MB)`);
}

function run(label, command, args, cwd, runEnv = process.env) {
  console.log(label);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: runEnv });
  if (result.status !== 0) {
    console.error(`${label} failed`);
    process.exit(result.status ?? 1);
  }
}

function npmCli() {
  const cli = process.env.npm_execpath;
  if (cli?.endsWith(".js")) return cli;
  return path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
}

function checkNode(file) {
  const version = execFileSync(file, ["--version"], { encoding: "utf8" }).trim();
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    console.error(`${file} is ${version}; the bundle needs Node ${MIN_NODE.join(".")} or newer. Set SCRIBE_NODE to another node.exe.`);
    process.exit(1);
  }
  console.log(`Bundling Node ${version} from ${file}`);
}

/** Skips type declarations and source maps, which only tools read, and the half-renamed package folders npm
 * leaves behind after failed updates (`node_modules/@scope/.name-XXXX`). */
function runtimeModuleFile(src) {
  const name = path.basename(src);
  if (/\.d\.[cm]?ts$|\.map$/.test(name)) return false;
  if (!name.startsWith(".")) return true;
  const parent = path.basename(path.dirname(src));
  return parent !== "node_modules" && !parent.startsWith("@");
}
