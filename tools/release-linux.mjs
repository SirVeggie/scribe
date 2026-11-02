// Builds the headless Linux release (#942): dist, the UI, templates, production modules for linux-x64 and a
// Node for Linux, as scribe-<version>-linux-x64.tar.gz. Runs on Windows or Linux: modules come from npm for
// linux-x64 (npm ci --os=linux --cpu=x64), Node from nodejs.org (checked against its SHASUMS256.txt).
// Usage: node tools/release-linux.mjs <output folder>   (npm run build first; tools/release.mjs does both)
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME = ["dist", "public", "templates", "plugins", path.join(".cursor", "skills"), "package.json", "package-lock.json"];

export async function buildLinuxRelease(outDir, { nodeVersion = process.env.SCRIBE_LINUX_NODE_VERSION || process.version } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (!fs.existsSync(path.join(root, "dist", "index.js"))) throw new Error("dist/index.js is missing: run npm run build first");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-linux-"));
  const stage = path.join(work, "scribe");
  try {
    console.log(`Staging the Linux release in ${stage}`);
    for (const entry of RUNTIME) fs.cpSync(path.join(root, entry), path.join(stage, entry), { recursive: true });
    console.log("Installing production modules for linux-x64");
    run(process.execPath, [npmCli(), "ci", "--omit=dev", "--ignore-scripts", "--os=linux", "--cpu=x64", "--libc=glibc", "--no-audit", "--no-fund"], stage);
    fs.writeFileSync(path.join(stage, "install.json"), `${JSON.stringify({ kind: "standalone", target: "linux-x64-headless", version }, null, 2)}\n`);
    fs.mkdirSync(path.join(stage, "bin"));
    fs.writeFileSync(path.join(stage, "bin", "scribe"), '#!/bin/sh\n# Scribe headless release: the bundled Node runs the daemon and its CLI.\nDIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"\nexec "$DIR/node/bin/node" "$DIR/dist/index.js" "$@"\n');
    fs.mkdirSync(path.join(stage, "node", "bin"), { recursive: true });
    fs.copyFileSync(await linuxNode(nodeVersion, work), path.join(stage, "node", "bin", "node"));

    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `scribe-${version}-linux-x64.tar.gz`);
    console.log("Packing");
    fs.writeFileSync(file, gzipSync(tar(work, "scribe", (rel) => rel === "scribe/bin/scribe" || rel === "scribe/node/bin/node"), { level: 9 }));
    console.log(`Linux release: ${file} (${Math.round(fs.statSync(file).size / 1024 / 1024)} MB)`);
    return file;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Node's official linux-x64 build, checked against the release's SHASUMS256.txt. */
async function linuxNode(version, work) {
  const name = `node-${version}-linux-x64`;
  const base = `https://nodejs.org/dist/${version}`;
  console.log(`Downloading ${name}`);
  const sums = await (await get(`${base}/SHASUMS256.txt`)).text();
  const expected = sums.split("\n").find((line) => line.endsWith(`  ${name}.tar.gz`))?.split(" ")[0];
  if (!expected) throw new Error(`${base}/SHASUMS256.txt has no ${name}.tar.gz`);
  const archive = Buffer.from(await (await get(`${base}/${name}.tar.gz`)).arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== expected) throw new Error(`${name}.tar.gz does not match SHASUMS256.txt`);
  const file = path.join(work, `${name}.tar.gz`);
  fs.writeFileSync(file, archive);
  // Relative paths: Git for Windows' tar reads "C:" in a path as a remote host.
  run("tar", ["-xzf", path.basename(file), `${name}/bin/node`], work);
  return path.join(work, name, "bin", "node");
}

async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

/**
 * A tar of `dir/top`, written here rather than by the system tar so Unix modes are right when it is built on
 * Windows: 0755 for folders and the files `executable` picks, 0644 for the rest. PAX headers carry long paths.
 * Module command shims (node_modules/.bin) and musl builds are left out: nothing runs them.
 */
export function tar(dir, top, executable = () => false) {
  const blocks = [];
  const walk = (rel) => {
    const full = path.join(dir, rel);
    const stat = fs.lstatSync(full);
    const name = rel.split(path.sep).join("/");
    if (stat.isDirectory()) {
      if (path.basename(rel) === ".bin" && path.basename(path.dirname(rel)) === "node_modules") return;
      // npm installs both libc builds of some native packages; the release targets glibc.
      if (/[\\/]node_modules[\\/](@[^\\/]+[\\/])?[^\\/]+-musl$/.test(rel)) return;
      blocks.push(...entry(`${name}/`, 0o755, 0, "5"));
      for (const child of fs.readdirSync(full).sort()) walk(path.join(rel, child));
    } else if (stat.isFile()) {
      const data = fs.readFileSync(full);
      blocks.push(...entry(name, executable(name) ? 0o755 : 0o644, data.length, "0"), data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  };
  walk(top);
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function entry(name, mode, size, type) {
  const out = [];
  if (Buffer.byteLength(name) > 100) {
    const record = (body) => {
      // A PAX record's length counts its own digits.
      let len = Buffer.byteLength(body) + 3;
      while (`${len} ${body}\n`.length !== len) len = Buffer.byteLength(`${len} ${body}\n`);
      return `${len} ${body}\n`;
    };
    const pax = Buffer.from(record(`path=${name}`));
    out.push(header("././@PaxHeader", 0o644, pax.length, "x"), pax, Buffer.alloc((512 - (pax.length % 512)) % 512));
    name = name.slice(-100).replace(/^[^/]*\//, "") || name.slice(-100);
  }
  out.push(header(name, mode, size, type));
  return out;
}

function header(name, mode, size, type) {
  const block = Buffer.alloc(512);
  const field = (value, offset, length) => block.write(value, offset, length, "utf8");
  const octal = (value, offset, length) => field(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
  field(name, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(Math.floor(Date.now() / 1000), 136, 12);
  field("        ", 148, 8);
  field(type, 156, 1);
  field("ustar\0", 257, 6);
  field("00", 263, 2);
  let sum = 0;
  for (const byte of block) sum += byte;
  field(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(" ")} failed`);
}

function npmCli() {
  const cli = process.env.npm_execpath;
  if (cli?.endsWith(".js")) return cli;
  const beside = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(beside)) return beside;
  return execFileSync(process.platform === "win32" ? "where" : "which", ["npm-cli.js"], { encoding: "utf8" }).trim();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error("Usage: node tools/release-linux.mjs <output folder>");
    process.exit(1);
  }
  buildLinuxRelease(path.resolve(out)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
