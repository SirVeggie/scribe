import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { runnerSource } from "./runner.js";
import { reservedEnv } from "./manifest.js";

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer?: NodeJS.Timeout; cancel?: () => void };
export type CallOptions = { timeoutMs?: number; signal?: AbortSignal };
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const IDLE_MS = 10 * 60_000, PING_MS = 5_000, MAX_LEASES = 64;
export class PluginRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private opening?: Promise<void>;
  private pending = new Map<number, Pending>();
  /** Work a backend runs after its call returned (ctx.busy): the idle stop waits for it. */
  private leases = new Map<string, string>();
  private next = 0;
  private crashes: number[] = [];
  private idle?: NodeJS.Timeout;
  private stopping = false;
  private generation = 0;
  readonly logs: string[] = [];
  constructor(private config: { entry: string; dataDir: string; settings: Record<string, unknown>; env?: string[] }, private host: (method: string, params: Record<string, unknown>) => Promise<unknown>, private keepAlive = false, private idleMs = IDLE_MS) {}
  status(): string { return this.crashes.length >= 3 ? "failing" : this.child ? "running" : "idle"; }
  /** Labels of the work in progress after its calls returned. */
  busy(): string[] { return [...this.leases.values()]; }
  private log(line: string): void { this.logs.push(`${new Date().toISOString()} ${line.slice(0, 4000)}`); if (this.logs.length > 200) this.logs.shift(); }
  async start(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.child) return;
    this.crashes = this.crashes.filter(t => t > Date.now() - 120_000);
    if (this.crashes.length >= 3) throw new Error("Plugin failed three times in two minutes; restart it in Settings");
    const generation=this.generation;
    this.opening = (async () => {
      if (this.crashes.length) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** this.crashes.length));
      if(generation!==this.generation)throw new Error("Plugin startup was cancelled");
      this.stopping = false;
      // No inherited Scribe tokens, API keys, NODE_OPTIONS or provider credentials, apart from the variables the user approved in access.env.
      const names = ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", ...(this.config.env ?? []).filter(name => !reservedEnv(name))];
      const env = Object.fromEntries(names.flatMap(k => process.env[k] ? [[k, process.env[k]!]] : []));
      const child = spawn(process.execPath, ["--input-type=module", "-e", runnerSource], { cwd: this.config.dataDir, windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      child.stdin.on("error",error=>{this.log(`RPC input closed: ${error.message}`);void this.stop();});
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      let bytes = 0;
      child.stdout.on("data", (data: Buffer) => { bytes += data.length; if (bytes > 16 * 1024 ** 2) { this.log("RPC output limit exceeded"); this.stop(); } });
      lines.on("line", line => { bytes = 0; void this.receive(child, line); });
      const errors = createInterface({ input: child.stderr });
      let errorBytes=0;child.stderr.on("data",(data:Buffer)=>{errorBytes+=data.length;if(errorBytes>256*1024){this.log("Backend log line exceeded its limit");void this.stop();}});
      errors.on("line", line => {errorBytes=0;this.log(line);});
      child.on("error", error => this.log(error.message));
      child.on("close", (code, signal) => {
        if (this.child !== child) return;
        this.child = undefined;
        if (!this.stopping) this.crashes.push(Date.now());
        this.log(`Stopped (${signal ?? code})`);
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.cancel?.(); p.reject(new Error("Plugin backend stopped")); }
        this.pending.clear(); this.leases.clear();
      });
      try{await this.request("init", this.config);}catch(error){if(this.child===child)this.crashes.push(Date.now());await this.stop();throw error;}
      this.log("Started");
    })().finally(() => { this.opening = undefined; });
    return this.opening;
  }
  private async receive(child: ChildProcessWithoutNullStreams, line: string): Promise<void> {
    try {
      const message = JSON.parse(line);
      if (typeof message.id === "string" && message.id.startsWith("child:") && typeof message.method === "string") {
        try { child.stdin.write(JSON.stringify({ id: message.id, result: message.method === "busy" ? this.lease(message.params ?? {}) : await this.host(message.method, message.params ?? {}) }) + "\n"); }
        catch (error) { child.stdin.write(JSON.stringify({ id: message.id, error: String((error as Error).message) }) + "\n"); }
        return;
      }
      const p = this.pending.get(message.id);
      if (!p) return;
      this.settle(message.id);
      message.error ? p.reject(new Error(String(message.error))) : p.resolve(message.result);
    } catch { this.log("Invalid backend RPC output"); }
  }
  private lease(params: Record<string, unknown>): true {
    const id = String(params.lease);
    if (params.done) this.leases.delete(id);
    else { if (this.leases.size >= MAX_LEASES) throw new Error("Plugin has too much work in progress"); this.leases.set(id, String(params.label ?? "").slice(0, 200)); }
    this.scheduleIdle();
    return true;
  }
  private scheduleIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    if (this.keepAlive || this.pending.size || this.leases.size || !this.child) return;
    this.idle = setTimeout(() => this.stop(), this.idleMs); this.idle.unref();
  }
  private settle(id: number): void {
    const p = this.pending.get(id); if (!p) return;
    this.pending.delete(id); clearTimeout(p.timer); p.cancel?.();
    this.scheduleIdle();
  }
  /** Ends one call without stopping the backend: the call's ctx.signal aborts so the plugin can clean up. */
  private abandon(id: number, error: Error): void {
    const p = this.pending.get(id); if (!p) return;
    this.settle(id); p.reject(error);
    this.child?.stdin.write(JSON.stringify({ method: "cancel", params: { id } }) + "\n", () => {});
  }
  /** A backend that does not answer a ping within five seconds has a blocked event loop: stop it. */
  private async check(): Promise<void> {
    const child = this.child; if (!child) return;
    const alive = await this.request("ping", {}, { timeoutMs: PING_MS }).then(() => true, () => false);
    if (!alive && this.child === child) { this.log("Backend did not answer after a timed-out call; stopping it"); void this.stop(); }
  }
  private request(method: string, params: unknown, options: CallOptions = {}): Promise<unknown> {
    const child = this.child;
    if (!child||this.stopping) return Promise.reject(new Error("Plugin is not running"));
    if (this.pending.size >= 32) return Promise.reject(new Error("Plugin has too many pending calls"));
    if (options.signal?.aborted) return Promise.reject(new Error("Plugin call was cancelled"));
    const id = ++this.next, timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    if (this.idle) clearTimeout(this.idle);
    return new Promise((resolve, reject) => {
      const p: Pending = { resolve, reject };
      p.timer = setTimeout(() => { this.abandon(id, new Error(`Plugin call timed out after ${Math.round(timeoutMs / 1000)} s`)); if (method !== "ping") void this.check(); }, timeoutMs);
      if (options.signal) { const abort = () => this.abandon(id, new Error("Plugin call was cancelled")), signal = options.signal; signal.addEventListener("abort", abort, { once: true }); p.cancel = () => signal.removeEventListener("abort", abort); }
      this.pending.set(id, p);
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n", err => { if (err && this.pending.has(id)) { this.settle(id); reject(err); } });
    });
  }
  async call(method: string, params: unknown, options?: CallOptions): Promise<unknown> { await this.start(); return this.request(method, params, options); }
  stop(): Promise<void> {
    this.stopping = true;this.generation++;if(this.idle)clearTimeout(this.idle);
    const child=this.child;if(!child)return Promise.resolve();
    return new Promise(resolve=>{
      child.once("close",()=>resolve());
      if(process.platform==="win32"&&child.pid){const killer=spawn("taskkill",["/pid",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});killer.on("error",()=>child.kill());}
      else child.kill();
    });
  }
  restart(): void { this.crashes = []; this.stop(); }
}
