import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/** DPAPI payloads never appear in settings, agent tools, logs or exports. */
export class PluginSecrets {
  constructor(private root: string) {}
  private file(id: string, key: string): string { return path.join(this.root, `${id}.${key}.secret`); }
  async set(id: string, key: string, value: string): Promise<void> {
    if (process.platform !== "win32") throw new Error("Plugin secrets currently require Windows DPAPI");
    if (!value) { fs.rmSync(this.file(id, key), { force: true }); return; }
    const encrypted = await dpapi(value, false);
    fs.mkdirSync(this.root, { recursive: true }); fs.writeFileSync(this.file(id, key), encrypted, { mode: 0o600 });
  }
  has(id: string, key: string): boolean { return fs.existsSync(this.file(id, key)); }
  remove(id:string):void {if(fs.existsSync(this.root))for(const name of fs.readdirSync(this.root))if(name.startsWith(`${id}.`)&&name.endsWith(".secret"))fs.rmSync(path.join(this.root,name),{force:true});}
  async get(id: string, key: string): Promise<string | null> {
    if (!this.has(id, key)) return null;
    return dpapi(fs.readFileSync(this.file(id, key), "utf8"), true);
  }
}
function dpapi(value: string, decrypt: boolean): Promise<string> {
  const script = `[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=${decrypt ? "[Convert]::FromBase64String($v)" : "[Text.Encoding]::UTF8.GetBytes($v)"}; $r=[Security.Cryptography.ProtectedData]::${decrypt ? "Unprotect" : "Protect"}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write(${decrypt ? "[Text.Encoding]::UTF8.GetString($r)" : "[Convert]::ToBase64String($r)"})`;
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = []; child.stdout.on("data", (data: Buffer) => chunks.push(data));
    child.on("error", () => reject(new Error("DPAPI unavailable")));
    child.on("close", code => code === 0 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error("DPAPI failed")));
    child.stdin.end(value, "utf8");
  });
}
