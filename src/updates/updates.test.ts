import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IDLE_MS, UpdateService, applyGit, checkGit, detectInstall, downloadAsset, parseManifest, runCommand, windowsInstallScript, type Runner, type UpdateView } from "./updates.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scribe-updates-"));
}

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
}

function release(root: string, version: string, target = "windows-x64-desktop"): void {
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, "install.json"), JSON.stringify({ kind: "standalone", target, version }));
}

function response(body: unknown, init: { status?: number; url?: string } = {}): Response {
  const res = new Response(typeof body === "string" || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body), { status: init.status ?? 200 });
  if (init.url) Object.defineProperty(res, "url", { value: init.url });
  return res;
}

test("detectInstall tells releases, checkouts and other copies apart", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  assert.equal(detectInstall(dir).kind, "unknown");
  fs.mkdirSync(path.join(dir, ".git"));
  assert.deepEqual(detectInstall(dir), { kind: "git", root: dir, version: "1.2.3" });
  release(dir, "1.4.0", "linux-x64-headless");
  const info = detectInstall(dir, { SCRIBE_UPDATE_URL: "https://updates.example/latest.json" });
  assert.equal(info.kind, "standalone");
  assert.equal(info.version, "1.4.0");
  assert.equal(info.target, "linux-x64-headless");
  assert.equal(info.manifestUrl, "https://updates.example/latest.json");
  release(dir, "1.4.0", "macos-arm64-headless");
  assert.equal(detectInstall(dir).target, "macos-arm64-headless");
});

test("parseManifest resolves asset URLs against the manifest and drops bad entries", () => {
  const sha = "a".repeat(64);
  const manifest = parseManifest({
    version: "2.0.0",
    notes: "Fixes",
    assets: {
      "windows-x64-desktop": { url: "Scribe_2.0.0_x64-setup.exe", sha256: sha.toUpperCase(), size: 10 },
      "linux-x64-headless": { url: "scribe.tar.gz", sha256: "nope" },
      "macos-x64-headless": { url: "scribe-2.0.0-macos-x64.tar.gz", sha256: sha },
      other: { url: "x", sha256: sha },
    },
  }, "https://github.com/o/r/releases/download/v2.0.0/latest.json");
  assert.deepEqual(manifest.assets, {
    "windows-x64-desktop": { url: "https://github.com/o/r/releases/download/v2.0.0/Scribe_2.0.0_x64-setup.exe", sha256: sha, size: 10 },
    "macos-x64-headless": { url: "https://github.com/o/r/releases/download/v2.0.0/scribe-2.0.0-macos-x64.tar.gz", sha256: sha },
  });
  assert.throws(() => parseManifest({ version: "latest" }, "https://x/"), /valid version/);
});

test("downloadAsset checks the SHA-256 and keeps a verified file", async () => {
  const dir = tmp();
  const body = new TextEncoder().encode("installer bytes");
  const sha256 = createHash("sha256").update(body).digest("hex");
  let calls = 0;
  const fetch = (async () => { calls += 1; return response(body); }) as typeof globalThis.fetch;
  const file = await downloadAsset({ url: "https://x/setup.exe", sha256 }, dir, { fetch });
  assert.equal(fs.readFileSync(file, "utf8"), "installer bytes");
  await downloadAsset({ url: "https://x/setup.exe", sha256 }, dir, { fetch });
  assert.equal(calls, 1, "a verified download is not fetched again");
  await assert.rejects(downloadAsset({ url: "https://x/other.exe", sha256: "0".repeat(64) }, dir, { fetch }), /SHA-256/);
  assert.equal(fs.existsSync(path.join(dir, "other.exe")), false);
  assert.equal(fs.existsSync(path.join(dir, "other.exe.part")), false);
});

test("checkGit and applyGit fast-forward a checkout to its upstream", async () => {
  const dir = tmp();
  const origin = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  const clone = path.join(dir, "clone");
  execFileSync("git", ["init", "--bare", "-q", "-b", "master", origin]);
  execFileSync("git", ["clone", "-q", origin, work]);
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ version: "1.0.0" }));
  gitIn(work, "add", ".");
  gitIn(work, "commit", "-qm", "first");
  gitIn(work, "push", "-q", "origin", "HEAD:master");
  execFileSync("git", ["clone", "-q", origin, clone]);

  assert.equal((await checkGit(runCommand, clone))?.behind, 0);
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ version: "1.1.0" }));
  fs.mkdirSync(path.join(work, "desktop"));
  fs.writeFileSync(path.join(work, "desktop", "main.rs"), "");
  gitIn(work, "add", ".");
  gitIn(work, "commit", "-qm", "second");
  gitIn(work, "push", "-q", "origin", "HEAD:master");

  const result = await checkGit(runCommand, clone);
  assert.ok(result);
  assert.equal(result.behind, 1);
  assert.equal(result.ahead, 0);
  assert.equal(result.dirty, false);
  assert.deepEqual(result.commits.map((c) => c.subject), ["second"]);

  const npm: string[][] = [];
  const run: Runner = (command, args, options) => (command === "git" ? runCommand(command, args, options) : (npm.push(args.slice(-2)), Promise.resolve({ code: 0, stdout: "", stderr: "" })));
  const notes = await applyGit(run, clone, result.target);
  assert.equal(gitIn(clone, "rev-parse", "HEAD"), result.target);
  assert.deepEqual(npm, [["--no-audit", "--no-fund"], ["run", "build"]]);
  assert.match(notes.join(" "), /desktop app changed/);
});

test("applyGit goes back to the previous commit when the build fails", async () => {
  const dir = tmp();
  const origin = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  const clone = path.join(dir, "clone");
  execFileSync("git", ["init", "--bare", "-q", "-b", "master", origin]);
  execFileSync("git", ["clone", "-q", origin, work]);
  fs.writeFileSync(path.join(work, "a.txt"), "1");
  gitIn(work, "add", ".");
  gitIn(work, "commit", "-qm", "first");
  gitIn(work, "push", "-q", "origin", "HEAD:master");
  execFileSync("git", ["clone", "-q", origin, clone]);
  const before = gitIn(clone, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(work, "a.txt"), "2");
  gitIn(work, "commit", "-qam", "second");
  gitIn(work, "push", "-q", "origin", "HEAD:master");
  const result = await checkGit(runCommand, clone);
  let builds = 0;
  const run: Runner = (command, args, options) => (command === "git" ? runCommand(command, args, options) : Promise.resolve({ code: builds++ === 0 ? 1 : 0, stdout: "", stderr: "TS2304: broken" }));
  await assert.rejects(applyGit(run, clone, result!.target), /npm run build failed: TS2304/);
  assert.equal(gitIn(clone, "rev-parse", "HEAD"), before);
  assert.equal(builds, 2, "the previous version is built again");
});

test("Update on a checkout fetches again and installs commits pushed after the check", async () => {
  const dir = tmp();
  const origin = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  const clone = path.join(dir, "clone");
  execFileSync("git", ["init", "--bare", "-q", "-b", "master", origin]);
  execFileSync("git", ["clone", "-q", origin, work]);
  const push = (n: string) => {
    fs.writeFileSync(path.join(work, "a.txt"), n);
    gitIn(work, "add", ".");
    gitIn(work, "commit", "-qm", n);
    gitIn(work, "push", "-q", "origin", "HEAD:master");
  };
  push("first");
  execFileSync("git", ["clone", "-q", origin, clone]);
  push("second");
  const run: Runner = (command, args, options) => (command === "git" ? runCommand(command, args, options) : Promise.resolve({ code: 0, stdout: "", stderr: "" }));
  let restarts = 0;
  const { svc } = service(clone, tmp(), { run, restart: async () => { restarts++; } });
  assert.equal((await svc.check()).available?.label, "1 new commit on origin/master");
  push("third");
  await svc.apply();
  assert.equal(gitIn(clone, "rev-parse", "HEAD"), gitIn(work, "rev-parse", "HEAD"));
  assert.equal(svc.view().available?.label, "2 new commits on origin/master");
  assert.equal(restarts, 1);
});

test("windowsInstallScript runs the installer silently and restarts what was running", () => {
  const withApp = windowsInstallScript("C:\\Temp\\Scribe's setup.exe", "C:\\Programs\\Scribe\\app", true);
  assert.match(withApp, /'C:\\Temp\\Scribe''s setup\.exe' -ArgumentList '\/S','\/UPDATE','\/R'/);
  assert.doesNotMatch(withApp, /--ensure/);
  const headless = windowsInstallScript("C:\\setup.exe", "C:\\Programs\\Scribe\\app", false);
  assert.match(headless, /'\/S','\/UPDATE' -Wait/);
  assert.match(headless, /node\.exe' -ArgumentList '"C:\\Programs\\Scribe\\app\\dist\\index\.js" --ensure'/);
});

function service(root: string, home: string, overrides: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  const views: UpdateView[] = [];
  const detached: string[][] = [];
  let now = 1_000_000_000;
  const svc = new UpdateService({
    root,
    home,
    now: () => now,
    platform: "win32",
    busy: () => 0,
    lastActivity: () => 0,
    emit: (view) => views.push(view),
    restart: async () => {},
    detach: (command, args) => detached.push([command, ...args]),
    desktopRunning: () => true,
    ...overrides,
  });
  return { svc, views, detached, advance: (ms: number) => { now += ms; } };
}

function releaseFetch(version: string, body: Uint8Array): typeof fetch {
  const sha256 = createHash("sha256").update(body).digest("hex");
  return (async (url: string | URL) =>
    String(url).endsWith("latest.json")
      ? response({ version, assets: { "windows-x64-desktop": { url: "setup.exe", sha256 } } }, { url: "https://dl.example/latest.json" })
      : response(body)) as typeof fetch;
}

test("ask mode offers a newer release, and skip and dismiss are remembered", async () => {
  const root = tmp();
  const home = tmp();
  release(root, "1.0.0");
  const { svc } = service(root, home, { fetch: releaseFetch("1.1.0", new Uint8Array([1])) });
  const view = await svc.check();
  assert.equal(view.available?.id, "1.1.0");
  assert.equal(view.available?.blocked, undefined);
  assert.equal(view.waitingForIdle, false);
  svc.skip("1.1.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "updates.json"), "utf8")).skipped, "1.1.0");
  assert.equal(service(root, home).svc.view().skipped, "1.1.0", "a skipped version stays skipped after a restart");
  assert.equal(svc.dismiss("1.1.0").dismissed, "1.1.0");

  const { svc: same } = service(root, tmp(), { fetch: releaseFetch("1.0.0", new Uint8Array([1])) });
  assert.equal((await same.check()).available, null);
});

test("auto mode downloads ahead and installs only once Scribe is idle", async () => {
  const root = tmp();
  const home = tmp();
  release(root, "1.0.0");
  let busy = 1;
  let lastActivity = 1_000_000_000;
  const { svc, detached, advance } = service(root, home, { fetch: releaseFetch("1.2.0", new Uint8Array([7, 7])), busy: () => busy, lastActivity: () => lastActivity });
  svc.setMode("auto");
  await svc.check();
  await svc.tick();
  assert.ok(fs.existsSync(path.join(home, "updates", "1.2.0", "setup.exe")), "downloaded while waiting");
  advance(IDLE_MS + 1);
  await svc.tick();
  assert.equal(detached.length, 0, "a running chat holds the install");
  busy = 0;
  lastActivity += IDLE_MS;
  await svc.tick();
  assert.equal(detached.length, 0, "recent input holds the install");
  advance(IDLE_MS);
  await svc.tick();
  assert.equal(detached.length, 1);
  assert.equal(detached[0][0], "powershell.exe");
  assert.match(detached[0].at(-1)!, /setup\.exe' -ArgumentList '\/S','\/UPDATE','\/R'/);
  assert.equal(svc.view().phase, "restarting");
});

test("a release without this platform's download is shown but cannot be installed", async () => {
  const root = tmp();
  release(root, "1.0.0", "linux-x64-headless");
  const { svc } = service(root, tmp(), { fetch: releaseFetch("1.1.0", new Uint8Array([1])) });
  const view = await svc.check();
  assert.match(view.available?.blocked ?? "", /no download for linux-x64-headless/);
  await assert.rejects(svc.apply(), /no download/);
});
