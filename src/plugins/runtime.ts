import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { runnerSource } from "./runner.js";

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
export class PluginRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private opening?: Promise<void>;
  private pending = new Map<number, Pending>();
  private next = 0;
  private crashes: number[] = [];
  private idle?: NodeJS.Timeout;
  private stopping = false;
  private generation = 0;
  readonly logs: string[] = [];
  constructor(private config: { entry: string; dataDir: string; settings: Record<string, unknown> }, private host: (method: string, params: Record<string, unknown>) => Promise<unknown>, private keepAlive = false) {}
  status(): string { return this.crashes.length >= 3 ? "failing" : this.child ? "running" : "idle"; }
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
      // No inherited Scribe tokens, API keys, NODE_OPTIONS or provider credentials.
      const env = Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA"].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : []));
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
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Plugin backend stopped")); }
        this.pending.clear();
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
        try { child.stdin.write(JSON.stringify({ id: message.id, result: await this.host(message.method, message.params ?? {}) }) + "\n"); }
        catch (error) { child.stdin.write(JSON.stringify({ id: message.id, error: String((error as Error).message) }) + "\n"); }
        return;
      }
      const p = this.pending.get(message.id);
      if (!p) return;
      this.pending.delete(message.id); clearTimeout(p.timer);
      message.error ? p.reject(new Error(String(message.error))) : p.resolve(message.result);
    } catch { this.log("Invalid backend RPC output"); }
  }
  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child||this.stopping) return Promise.reject(new Error("Plugin is not running"));
    if (this.pending.size >= 32) return Promise.reject(new Error("Plugin has too many pending calls"));
    const id = ++this.next;
    if (this.idle) clearTimeout(this.idle);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.stop(); reject(new Error("Plugin call timed out")); }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n", err => { if (err) { clearTimeout(timer); this.pending.delete(id); reject(err); } });
    }).finally(() => {
      if (!this.keepAlive && !this.pending.size) { this.idle = setTimeout(() => this.stop(), 10 * 60_000); this.idle.unref(); }
    });
  }
  async call(method: string, params: unknown): Promise<unknown> { await this.start(); return this.request(method, params); }
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
