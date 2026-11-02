import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { newerSdkVersion } from "../agent/sdkUpdates.js";

/**
 * App updates (#942). An install is either a git checkout (new commits on its upstream branch: pull,
 * build, restart) or a standalone release (a release manifest: download the installer or archive for
 * this platform, check its hash, install it, restart). Release builds put `install.json` in the app
 * folder; a checkout has none. `mode` (Settings → Updates): auto installs once Scribe is idle, ask
 * shows a notice with Update / Skip version / Dismiss, ignore never checks on its own.
 */

export type UpdateMode = "auto" | "ask" | "ignore";
export const UPDATE_MODES: UpdateMode[] = ["auto", "ask", "ignore"];

/** Release targets: the asset names in the manifest. */
export type ReleaseTarget = "windows-x64-desktop" | "linux-x64-headless";

export const DEFAULT_MANIFEST_URL = "https://github.com/SirVeggie/scribe/releases/latest/download/latest.json";
const CHECK_EVERY_MS = 6 * 60 * 60_000;
const FIRST_CHECK_MS = 2 * 60_000;
const TICK_MS = 60_000;
/** Auto mode installs only after this long without input in any window and with no chat running. */
export const IDLE_MS = 15 * 60_000;
const MAX_DOWNLOAD_BYTES = 1024 ** 3;

export type InstallInfo = {
  kind: "git" | "standalone" | "unknown";
  root: string;
  /** package.json's version, or the release's. */
  version: string;
  target?: ReleaseTarget;
  /** Standalone: where the release manifest is. */
  manifestUrl?: string;
  branch?: string;
  upstream?: string;
  commit?: string;
};

export type Available = {
  /** What Skip version remembers: the release version, or the upstream commit. */
  id: string;
  label: string;
  notes?: string;
  commits?: { sha: string; subject: string }[];
  /** Set when it cannot be installed from here (local changes, a diverged branch, no asset). */
  blocked?: string;
};

export type UpdatePhase = "idle" | "checking" | "downloading" | "installing" | "restarting";

export type UpdateView = {
  mode: UpdateMode;
  install: InstallInfo;
  phase: UpdatePhase;
  checkedAt: number | null;
  error: string | null;
  available: Available | null;
  skipped: string | null;
  dismissed: string | null;
  /** Download progress 0..1. */
  progress: number | null;
  /** Auto mode: waiting for Scribe to be idle. */
  waitingForIdle: boolean;
  notes: string[];
};

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (command: string, args: string[], options: { cwd: string; timeoutMs?: number }) => Promise<RunResult>;

type Marker = { kind?: unknown; target?: unknown; version?: unknown; updateUrl?: unknown };

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function packageVersion(root: string): string {
  const pkg = readJson(path.join(root, "package.json")) as { version?: unknown } | null;
  return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
}

const TARGETS: ReleaseTarget[] = ["windows-x64-desktop", "linux-x64-headless"];

/** What kind of install `root` is. Git details are filled in by the check. */
export function detectInstall(root: string, env: NodeJS.ProcessEnv = process.env): InstallInfo {
  const marker = readJson(path.join(root, "install.json")) as Marker | null;
  if (marker && marker.kind === "standalone") {
    const target = TARGETS.find((t) => t === marker.target);
    const manifestUrl = env.SCRIBE_UPDATE_URL || (typeof marker.updateUrl === "string" && marker.updateUrl) || DEFAULT_MANIFEST_URL;
    return { kind: "standalone", root, version: typeof marker.version === "string" ? marker.version : packageVersion(root), ...(target ? { target } : {}), manifestUrl };
  }
  if (fs.existsSync(path.join(root, ".git"))) return { kind: "git", root, version: packageVersion(root) };
  return { kind: "unknown", root, version: packageVersion(root) };
}

/* ---------- release manifest ---------- */

export type ManifestAsset = { url: string; sha256: string; size?: number };
export type Manifest = { version: string; notes?: string; date?: string; assets: Partial<Record<ReleaseTarget, ManifestAsset>> };

export function parseManifest(input: unknown, base: string): Manifest {
  const raw = input as { version?: unknown; notes?: unknown; date?: unknown; assets?: unknown } | null;
  if (!raw || typeof raw.version !== "string" || newerSdkVersion(raw.version, "0.0.0") === null) throw new Error("The release manifest has no valid version");
  const assets: Manifest["assets"] = {};
  if (raw.assets && typeof raw.assets === "object") {
    for (const target of TARGETS) {
      const asset = (raw.assets as Record<string, { url?: unknown; sha256?: unknown; size?: unknown }>)[target];
      if (!asset || typeof asset.url !== "string" || typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(asset.sha256)) continue;
      const url = new URL(asset.url, base);
      if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "file:") continue;
      assets[target] = { url: url.href, sha256: asset.sha256.toLowerCase(), ...(typeof asset.size === "number" ? { size: asset.size } : {}) };
    }
  }
  return {
    version: raw.version,
    ...(typeof raw.notes === "string" ? { notes: raw.notes.slice(0, 20_000) } : {}),
    ...(typeof raw.date === "string" ? { date: raw.date } : {}),
    assets,
  };
}

/** Downloads `asset` into `dir`, checking its size and SHA-256. Returns the file. */
export async function downloadAsset(asset: ManifestAsset, dir: string, options: { fetch?: typeof fetch; progress?: (share: number) => void } = {}): Promise<string> {
  const name = path.basename(new URL(asset.url).pathname) || "update";
  const file = path.join(dir, name);
  if (fs.existsSync(file) && (await sha256File(file)) === asset.sha256) return file;
  fs.mkdirSync(dir, { recursive: true });
  const part = `${file}.part`;
  const response = await (options.fetch ?? fetch)(asset.url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || asset.size || 0;
  const hash = createHash("sha256");
  const out = fs.createWriteStream(part);
  let received = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength;
      if (received > MAX_DOWNLOAD_BYTES) throw new Error("The download is larger than 1 GB");
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      if (total) options.progress?.(Math.min(1, received / total));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw err;
  }
  if (hash.digest("hex") !== asset.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error("The download does not match the release's SHA-256");
  }
  fs.renameSync(part, file);
  return file;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/* ---------- git ---------- */

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never" };

export const runCommand: Runner = (command, args, { cwd, timeoutMs = 10 * 60_000 }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr || err.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });

async function git(run: Runner, root: string, args: string[], timeoutMs?: number): Promise<string> {
  const result = await run("git", args, { cwd: root, timeoutMs });
  if (result.code !== 0) throw new Error(`git ${args[0]}: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${result.code}`}`);
  return result.stdout.trim();
}

export type GitCheck = { branch: string; upstream: string; commit: string; target: string; behind: number; ahead: number; dirty: boolean; commits: { sha: string; subject: string }[] };

/** Fetches the branch's upstream and compares. Null when the branch has no upstream. */
export async function checkGit(run: Runner, root: string): Promise<GitCheck | null> {
  const branch = await git(run, root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const upstreamResult = await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: root });
  if (upstreamResult.code !== 0) return null;
  const upstream = upstreamResult.stdout.trim();
  await git(run, root, ["fetch", "--quiet", "--no-tags"], 2 * 60_000);
  const [commit, target, behind, ahead, status, log] = await Promise.all([
    git(run, root, ["rev-parse", "HEAD"]),
    git(run, root, ["rev-parse", "@{u}"]),
    git(run, root, ["rev-list", "--count", "HEAD..@{u}"]),
    git(run, root, ["rev-list", "--count", "@{u}..HEAD"]),
    git(run, root, ["status", "--porcelain", "--untracked-files=no"]),
    git(run, root, ["log", "--format=%h%x09%s", "-n", "30", "HEAD..@{u}"]),
  ]);
  const commits = log ? log.split("\n").map((line) => { const [sha, ...rest] = line.split("\t"); return { sha, subject: rest.join("\t") }; }) : [];
  return { branch, upstream, commit, target, behind: Number(behind), ahead: Number(ahead), dirty: status.length > 0, commits };
}

/** npm's CLI beside this Node (Windows and Linux layouts), else `npm` on PATH. */
export function npmCommand(execPath = process.execPath): { command: string; args: string[] } {
  const dir = path.dirname(execPath);
  for (const cli of [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"), path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (fs.existsSync(cli)) return { command: execPath, args: [cli] };
  }
  return process.platform === "win32" ? { command: "cmd.exe", args: ["/d", "/s", "/c", "npm"] } : { command: "npm", args: [] };
}

/**
 * Fast-forwards to the upstream, installs dependencies when the lockfile changed, and builds. A failed
 * build goes back to the commit it started from and builds that again. Returns notes for the user.
 */
export async function applyGit(run: Runner, root: string, target: string, log: (line: string) => void = () => {}): Promise<string[]> {
  const before = await git(run, root, ["rev-parse", "HEAD"]);
  await git(run, root, ["merge", "--ff-only", target]);
  const changed = (await git(run, root, ["diff", "--name-only", before, "HEAD"])).split("\n").filter(Boolean);
  const npm = npmCommand();
  const npmRun = async (args: string[], label: string) => {
    log(`Update: ${label}`);
    const result = await run(npm.command, [...npm.args, ...args], { cwd: root, timeoutMs: 20 * 60_000 });
    if (result.code !== 0) throw new Error(`${label} failed: ${(result.stderr || result.stdout).trim().split("\n").slice(-4).join(" ")}`);
  };
  const notes: string[] = [];
  try {
    if (changed.some((file) => file === "package.json" || file === "package-lock.json")) {
      if (isLink(path.join(root, "node_modules"))) notes.push("Dependencies changed, but node_modules is a link to another checkout: install them there.");
      else await npmRun(["install", "--no-audit", "--no-fund"], "npm install");
    }
    await npmRun(["run", "build"], "npm run build");
  } catch (err) {
    log(`Update: ${(err as Error).message}; going back to ${before.slice(0, 7)}`);
    await git(run, root, ["reset", "--keep", before]).catch(() => {});
    await npmRun(["run", "build"], "Rebuilding the previous version").catch(() => {});
    throw err;
  }
  if (changed.some((file) => file.startsWith("desktop/"))) notes.push("The desktop app changed too: rebuild it with npm run desktop:install.");
  return notes;
}

function isLink(file: string): boolean {
  try {
    // Node reports a Windows junction (a worktree's node_modules) as a symbolic link too.
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/* ---------- standalone installs ---------- */

/**
 * Windows desktop: runs the release's installer silently, detached, once this daemon has handed off.
 * The installer stops the daemon and the desktop app itself (desktop/nsis-hooks.nsh) and, with /R,
 * starts the app again; without a desktop app open, the script starts the daemon afterwards.
 */
export function windowsInstallScript(installer: string, root: string, desktopRunning: boolean): string {
  const q = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const args = desktopRunning ? "'/S','/UPDATE','/R'" : "'/S','/UPDATE'";
  const node = path.join(root, "node", "node.exe");
  const entry = path.join(root, "dist", "index.js");
  return [
    "Start-Sleep -Seconds 2",
    `$p = Start-Process -FilePath ${q(installer)} -ArgumentList ${args} -Wait -PassThru`,
    desktopRunning ? "" : `Start-Process -FilePath ${q(node)} -ArgumentList ${q(`"${entry}" --ensure`)} -WindowStyle Hidden`,
  ].filter(Boolean).join("; ");
}

/** Linux headless: unpacks the archive beside the app folder and swaps the two. */
export async function swapLinuxRelease(run: Runner, archive: string, root: string): Promise<void> {
  const next = `${root}.new`;
  const old = `${root}.old`;
  fs.rmSync(next, { recursive: true, force: true });
  fs.mkdirSync(next, { recursive: true });
  const result = await run("tar", ["-xzf", archive, "-C", next, "--strip-components=1"], { cwd: path.dirname(root) });
  if (result.code !== 0) throw new Error(`Could not unpack the update: ${result.stderr.trim()}`);
  if (!fs.existsSync(path.join(next, "dist", "index.js")) || !fs.existsSync(path.join(next, "install.json"))) {
    fs.rmSync(next, { recursive: true, force: true });
    throw new Error("The update archive is not a Scribe release");
  }
  fs.rmSync(old, { recursive: true, force: true });
  fs.renameSync(root, old);
  try {
    fs.renameSync(next, root);
  } catch (err) {
    fs.renameSync(old, root);
    throw err;
  }
  fs.rmSync(old, { recursive: true, force: true });
}

/** The exit code a daemon under systemd restarts with after an update (the unit restarts on failure). */
export const UPDATE_RESTART_CODE = 75;

/** Whether the desktop app (scribe.exe) runs, so the installer starts it again afterwards. */
export function windowsAppRunning(): boolean {
  if (process.platform !== "win32") return false;
  try {
    return execFileSync("tasklist", ["/FI", "IMAGENAME eq scribe.exe", "/NH"], { encoding: "utf8", windowsHide: true }).toLowerCase().includes("scribe.exe");
  } catch {
    return false;
  }
}

/* ---------- the service ---------- */

export type UpdateDeps = {
  root: string;
  home: string;
  now?: () => number;
  fetch?: typeof fetch;
  run?: Runner;
  platform?: NodeJS.Platform;
  /** Chats with a turn running. */
  busy: () => number;
  /** The last input in any window, in epoch ms (0: none since the daemon started). */
  lastActivity: () => number;
  emit: (view: UpdateView) => void;
  /** Stop this daemon and start the installed one. */
  restart: () => Promise<void>;
  /** Hand off to a detached script (the Windows installer); the daemon is stopped by it. */
  detach: (command: string, args: string[]) => void;
  desktopRunning?: () => boolean;
  log?: (line: string) => void;
};

type Saved = { mode?: unknown; skipped?: unknown };

export class UpdateService {
  private mode: UpdateMode = "ask";
  private skipped: string | null = null;
  private dismissed: string | null = null;
  private install: InstallInfo;
  private phase: UpdatePhase = "idle";
  private checkedAt: number | null = null;
  private error: string | null = null;
  private available: Available | null = null;
  private progress: number | null = null;
  private notes: string[] = [];
  private manifest: Manifest | null = null;
  private gitTarget: string | null = null;
  private downloaded: string | null = null;
  private timers: NodeJS.Timeout[] = [];
  private readonly now: () => number;
  private readonly run: Runner;
  private readonly platform: NodeJS.Platform;
  private readonly log: (line: string) => void;
  private readonly file: string;

  constructor(private readonly deps: UpdateDeps) {
    this.now = deps.now ?? Date.now;
    this.run = deps.run ?? runCommand;
    this.platform = deps.platform ?? process.platform;
    this.log = deps.log ?? (() => {});
    this.file = path.join(deps.home, "updates.json");
    this.install = detectInstall(deps.root);
    const saved = readJson(this.file) as Saved | null;
    if (saved && UPDATE_MODES.includes(saved.mode as UpdateMode)) this.mode = saved.mode as UpdateMode;
    if (saved && typeof saved.skipped === "string") this.skipped = saved.skipped;
  }

  start(): void {
    if (this.install.kind === "unknown") return;
    this.timers.push(setTimeout(() => void this.scheduled(), FIRST_CHECK_MS));
    this.timers.push(setInterval(() => void this.scheduled(), CHECK_EVERY_MS));
    this.timers.push(setInterval(() => void this.tick(), TICK_MS));
    for (const timer of this.timers) timer.unref();
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  view(): UpdateView {
    return {
      mode: this.mode,
      install: this.install,
      phase: this.phase,
      checkedAt: this.checkedAt,
      error: this.error,
      available: this.available,
      skipped: this.skipped,
      dismissed: this.dismissed,
      progress: this.progress,
      waitingForIdle: this.mode === "auto" && this.installable() && this.phase === "idle",
      notes: this.notes,
    };
  }

  setMode(mode: unknown): UpdateView {
    if (!UPDATE_MODES.includes(mode as UpdateMode)) throw new Error("mode must be auto, ask or ignore");
    this.mode = mode as UpdateMode;
    this.save();
    this.changed();
    if (this.mode !== "ignore" && this.checkedAt === null) void this.check();
    return this.view();
  }

  /** Skip version: null takes the skip back. */
  skip(id: unknown): UpdateView {
    this.skipped = typeof id === "string" && id ? id.slice(0, 100) : null;
    this.save();
    this.changed();
    return this.view();
  }

  dismiss(id: unknown): UpdateView {
    this.dismissed = typeof id === "string" && id ? id.slice(0, 100) : null;
    this.changed();
    return this.view();
  }

  private save(): void {
    try {
      fs.mkdirSync(this.deps.home, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ mode: this.mode, ...(this.skipped ? { skipped: this.skipped } : {}) }, null, 2));
    } catch (err) {
      this.log(`Could not save update settings: ${(err as Error).message}`);
    }
  }

  private changed(): void {
    this.deps.emit(this.view());
  }

  private installable(): boolean {
    return !!this.available && !this.available.blocked && this.available.id !== this.skipped;
  }

  private async scheduled(): Promise<void> {
    if (this.mode !== "ignore") await this.check();
  }

  async check(): Promise<UpdateView> {
    if (this.phase !== "idle" || this.install.kind === "unknown") return this.view();
    this.phase = "checking";
    this.changed();
    try {
      this.available = this.install.kind === "git" ? await this.checkGitInstall() : await this.checkRelease();
      this.error = null;
    } catch (err) {
      this.error = (err as Error).message;
      this.log(`Update check failed: ${this.error}`);
    } finally {
      this.checkedAt = this.now();
      this.phase = "idle";
    }
    this.changed();
    void this.tick();
    return this.view();
  }

  private async checkGitInstall(): Promise<Available | null> {
    const result = await checkGit(this.run, this.install.root);
    if (!result) {
      this.install = { ...this.install, branch: undefined, upstream: undefined };
      throw new Error("This checkout's branch has no upstream to update from");
    }
    this.install = { ...this.install, version: packageVersion(this.install.root), branch: result.branch, upstream: result.upstream, commit: result.commit.slice(0, 7) };
    this.gitTarget = result.target;
    if (!result.behind) return null;
    const blocked = result.ahead
      ? `${result.branch} has ${result.ahead} commit${result.ahead === 1 ? "" : "s"} that ${result.upstream} does not; pull or merge it yourself`
      : result.dirty
        ? "The checkout has uncommitted changes; commit or discard them first"
        : undefined;
    return {
      id: result.target.slice(0, 12),
      label: `${result.behind} new commit${result.behind === 1 ? "" : "s"} on ${result.upstream}`,
      commits: result.commits,
      ...(blocked ? { blocked } : {}),
    };
  }

  private async checkRelease(): Promise<Available | null> {
    const url = this.install.manifestUrl ?? DEFAULT_MANIFEST_URL;
    const response = await (this.deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(response.status === 404 ? "No release has been published yet" : `The release check returned HTTP ${response.status}`);
    const manifest = parseManifest(await response.json(), response.url || url);
    if (!newerSdkVersion(manifest.version, this.install.version)) {
      this.manifest = null;
      return null;
    }
    this.manifest = manifest;
    const asset = this.install.target ? manifest.assets[this.install.target] : undefined;
    return {
      id: manifest.version,
      label: `Scribe ${manifest.version}`,
      ...(manifest.notes ? { notes: manifest.notes } : {}),
      ...(asset ? {} : { blocked: `Release ${manifest.version} has no download for ${this.install.target ?? "this install"}` }),
    };
  }

  /** Auto mode: download ahead, then install once nobody has used Scribe for a while and no chat runs. */
  async tick(): Promise<void> {
    if (this.mode !== "auto" || this.phase !== "idle" || !this.installable()) return;
    if (this.install.kind === "standalone" && !this.downloaded) {
      await this.download().catch(() => {});
      return;
    }
    if (this.deps.busy() > 0 || this.now() - this.deps.lastActivity() < IDLE_MS) return;
    this.log("Update: Scribe is idle; installing");
    await this.apply().catch(() => {});
  }

  private async download(): Promise<string> {
    const asset = this.manifest && this.install.target ? this.manifest.assets[this.install.target] : undefined;
    if (!asset || !this.manifest) throw new Error("There is nothing to download");
    this.phase = "downloading";
    this.progress = 0;
    this.changed();
    let last = 0;
    try {
      this.downloaded = await downloadAsset(asset, path.join(this.deps.home, "updates", this.manifest.version), {
        fetch: this.deps.fetch,
        progress: (share) => {
          this.progress = share;
          if (share - last >= 0.05 || share === 1) { last = share; this.changed(); }
        },
      });
      this.error = null;
      return this.downloaded;
    } catch (err) {
      this.error = (err as Error).message;
      throw err;
    } finally {
      this.phase = "idle";
      this.progress = null;
      this.changed();
    }
  }

  /** Update now: the notice's Update button, Settings, or auto mode once idle. */
  async apply(): Promise<UpdateView> {
    if (this.phase !== "idle") throw new Error("An update check or install is already running");
    if (!this.available) throw new Error("There is no update to install");
    if (this.available.blocked) throw new Error(this.available.blocked);
    try {
      if (this.install.kind === "git") {
        if (!this.gitTarget) throw new Error("Check for updates first");
        this.phase = "installing";
        this.changed();
        this.notes = await applyGit(this.run, this.install.root, this.gitTarget, this.log);
      } else {
        const file = this.downloaded ?? (await this.download());
        this.phase = "installing";
        this.changed();
        if (this.install.target === "windows-x64-desktop") {
          if (this.platform !== "win32") throw new Error("This release is for Windows");
          const script = windowsInstallScript(file, this.install.root, this.deps.desktopRunning?.() ?? false);
          this.phase = "restarting";
          this.changed();
          this.log(`Update: running the ${this.available.label} installer`);
          this.deps.detach("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", script]);
          return this.view();
        }
        if (this.install.target === "linux-x64-headless") await swapLinuxRelease(this.run, file, this.install.root);
        else throw new Error("This install cannot update itself");
      }
    } catch (err) {
      this.phase = "idle";
      this.error = (err as Error).message;
      this.log(`Update failed: ${this.error}`);
      this.changed();
      throw err;
    }
    this.phase = "restarting";
    this.error = null;
    this.changed();
    this.log(`Update: installed ${this.available.label}; restarting`);
    await this.deps.restart();
    return this.view();
  }
}
