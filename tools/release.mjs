// Makes a Scribe release (#942): bumps the version, builds the Windows installer and the headless Linux
// archive, writes the update manifest (latest.json), commits and tags. --publish then pushes the commit and
// tag and creates the GitHub release with gh, which is what installed copies update from.
//
//   npm run release -- <version> [--notes <file>] [--publish] [--skip-windows] [--skip-linux]
//   npm run release -- --publish-only <version>     publish a release built earlier
//
// The files land in release/<version>/ (gitignored). The .claude/skills/release skill walks an agent through it.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLinuxRelease } from "./release-linux.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "SirVeggie/scribe";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const positional = argv.filter((arg, i) => !arg.startsWith("--") && !["--notes"].includes(argv[i - 1]));
const version = positional[0]?.replace(/^v/, "");

if (!version || !SEMVER.test(version)) {
  console.error("Usage: npm run release -- <version> [--notes <file>] [--publish] [--skip-windows] [--skip-linux]\n       npm run release -- --publish-only <version>");
  process.exit(1);
}
const tag = `v${version}`;
const out = path.join(root, "release", version);

try {
  if (flag("--publish-only")) publish();
  else {
    await build();
    if (flag("--publish")) publish();
    else console.log(`\nBuilt and tagged ${tag} locally. Publish it with: npm run release -- --publish-only ${version}`);
  }
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}

async function build() {
  const current = readJson("package.json").version;
  if (!newer(version, current)) throw new Error(`${version} is not newer than the current version ${current}`);
  if (git("status", "--porcelain", "--untracked-files=no")) throw new Error("The checkout has uncommitted changes: commit or stash them first");
  if (git("tag", "--list", tag)) throw new Error(`Tag ${tag} already exists`);
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "master") console.warn(`Warning: releasing from ${branch}, not master`);
  const notesFile = option("--notes");
  const notes = notesFile ? fs.readFileSync(notesFile, "utf8").trim() : defaultNotes(current);

  console.log(`Releasing ${current} → ${version}`);
  setVersion(version);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const assets = {};
  try {
    // desktop/release.mjs builds the daemon too.
    if (!flag("--skip-windows")) assets["windows-x64-desktop"] = buildWindows();
    else run("Building the daemon", process.execPath, [npmCli(), "run", "build"]);
    if (!flag("--skip-linux")) assets["linux-x64-headless"] = asset(await buildLinuxRelease(out));
  } catch (err) {
    console.error("Build failed; putting the old version back");
    setVersion(current);
    throw err;
  }
  if (!Object.keys(assets).length) throw new Error("Nothing was built");
  fs.copyFileSync(path.join(root, "tools", "install-linux.sh"), path.join(out, "install-linux.sh"));
  fs.writeFileSync(path.join(out, "notes.md"), `${notes}\n`);
  // Asset URLs are relative: they resolve against wherever latest.json is served (a GitHub release, or a server).
  const manifest = { version, date: new Date().toISOString(), notes, assets };
  fs.writeFileSync(path.join(out, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  git("add", "package.json", "package-lock.json", "desktop/tauri.conf.json", "desktop/Cargo.toml", "desktop/Cargo.lock");
  git("commit", "-m", `Release ${tag}`);
  git("tag", "-a", tag, "-m", `Scribe ${version}`);
  console.log(`\nRelease files in ${out}:`);
  for (const name of fs.readdirSync(out)) console.log(`  ${name}`);
}

function publish() {
  const files = fs.existsSync(out) ? fs.readdirSync(out).filter((name) => name !== "notes.md").map((name) => path.join(out, name)) : [];
  if (!files.some((file) => path.basename(file) === "latest.json")) throw new Error(`${out} has no latest.json: build the release first`);
  if (!git("tag", "--list", tag)) throw new Error(`Tag ${tag} does not exist`);
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  run(`Pushing ${branch} and ${tag}`, "git", ["push", "origin", branch, tag]);
  run("Creating the GitHub release", "gh", ["release", "create", tag, ...files, "--repo", REPO, "--title", `Scribe ${version}`, "--notes-file", path.join(out, "notes.md"), ...(version.includes("-") ? ["--prerelease"] : ["--latest"])]);
  console.log(`Published https://github.com/${REPO}/releases/tag/${tag}`);
}

/** The Windows installer, built by desktop/release.mjs and copied here. */
function buildWindows() {
  if (process.platform !== "win32") throw new Error("The Windows installer builds on Windows; pass --skip-windows here");
  run("Building the Windows installer", process.execPath, [path.join(root, "desktop", "release.mjs")]);
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--manifest-path", path.join(root, "desktop", "Cargo.toml"), "--format-version", "1", "--no-deps"], { cwd: root, encoding: "utf8" }));
  const bundle = path.join(metadata.target_directory, "release", "bundle", "nsis");
  const built = fs.readdirSync(bundle).find((name) => name.endsWith(".exe") && name.includes(`_${version}_`));
  if (!built) throw new Error(`No installer for ${version} in ${bundle}`);
  const file = path.join(out, `Scribe_${version}_x64-setup.exe`);
  fs.copyFileSync(path.join(bundle, built), file);
  return asset(file);
}

function asset(file) {
  const data = fs.readFileSync(file);
  return { url: path.basename(file), sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
}

/** Commit subjects since the last release tag, as the default notes. */
function defaultNotes(current) {
  const last = git("tag", "--list", "v*", "--sort=-v:refname").split("\n").find(Boolean);
  const range = last ? `${last}..HEAD` : "HEAD";
  const subjects = git("log", "--format=- %s", "--no-merges", "-n", "200", range);
  return `## Scribe ${version}\n\n${last ? `Changes since ${last}:` : `Changes up to ${version} (from ${current}):`}\n\n${subjects}`;
}

function setVersion(next) {
  const pkg = readJson("package.json");
  pkg.version = next;
  writeJson("package.json", pkg);
  const lock = readJson("package-lock.json");
  lock.version = next;
  if (lock.packages?.[""]) lock.packages[""].version = next;
  writeJson("package-lock.json", lock);
  const tauri = readJson("desktop/tauri.conf.json");
  tauri.version = next;
  writeJson("desktop/tauri.conf.json", tauri);
  edit("desktop/Cargo.toml", (text) => text.replace(/^version = "[^"]*"/m, `version = "${next}"`));
  edit("desktop/Cargo.lock", (text) => text.replace(/(name = "scribe-desktop"\r?\nversion = )"[^"]*"/, `$1"${next}"`));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
}

function edit(file, change) {
  const full = path.join(root, file);
  fs.writeFileSync(full, change(fs.readFileSync(full, "utf8")));
}

function newer(a, b) {
  const parse = (v) => v.split("-")[0].split(".").map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return b.includes("-") && !a.includes("-");
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function run(label, command, args) {
  console.log(label);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${label} failed`);
}

function npmCli() {
  const cli = process.env.npm_execpath;
  if (cli?.endsWith(".js")) return cli;
  return path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
}
