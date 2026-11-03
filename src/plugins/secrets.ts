import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

/** Where the AES key for non-Windows secrets lives. */
export type KeyStore = "keychain" | "libsecret" | "file";
const SERVICE = "Scribe plugin secrets", ACCOUNT = "master-key";

/**
 * Secret payloads never appear in settings, agent tools, logs or exports.
 * Windows encrypts each value with DPAPI. Elsewhere a random AES-256-GCM key encrypts them;
 * the key sits in the macOS Keychain, libsecret on a Linux desktop, or a 0600 key file
 * (headless servers). The store picked first is recorded in key.json, so a keyring that is
 * locked later fails loudly instead of a new key orphaning the saved secrets.
 */
export class PluginSecrets {
  private key?: Promise<Buffer>;
  constructor(private root: string, private options: { platform?: NodeJS.Platform; stores?: KeyStore[] } = {}) {}
  private get platform(): NodeJS.Platform { return this.options.platform ?? process.platform; }
  private file(id: string, key: string): string { return path.join(this.root, `${id}.${key}.secret`); }
  async set(id: string, key: string, value: string): Promise<void> {
    if (!value) { fs.rmSync(this.file(id, key), { force: true }); return; }
    const encrypted = this.platform === "win32" ? await dpapi(value, false) : seal(await this.masterKey(true), value);
    fs.mkdirSync(this.root, { recursive: true }); fs.writeFileSync(this.file(id, key), encrypted, { mode: 0o600 });
  }
  has(id: string, key: string): boolean { return fs.existsSync(this.file(id, key)); }
  remove(id:string):void {if(fs.existsSync(this.root))for(const name of fs.readdirSync(this.root))if(name.startsWith(`${id}.`)&&name.endsWith(".secret"))fs.rmSync(path.join(this.root,name),{force:true});}
  async get(id: string, key: string): Promise<string | null> {
    if (!this.has(id, key)) return null;
    const data = fs.readFileSync(this.file(id, key), "utf8");
    return this.platform === "win32" ? dpapi(data, true) : open(await this.masterKey(false), data);
  }
  private masterKey(create: boolean): Promise<Buffer> {
    const loaded = this.key ??= this.loadKey(create);
    return loaded.catch(error => { if (this.key === loaded) this.key = undefined; throw error; });
  }
  private async loadKey(create: boolean): Promise<Buffer> {
    const record = path.join(this.root, "key.json");
    if (fs.existsSync(record)) {
      const store = (JSON.parse(fs.readFileSync(record, "utf8")) as { store: KeyStore }).store;
      const hex = await readKey(store, this.root).catch(() => null);
      if (!hex || !/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Plugin secret key not available from ${storeName(store)}`);
      return Buffer.from(hex, "hex");
    }
    if (!create) throw new Error("Plugin secret key is missing");
    const hex = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(this.root, { recursive: true });
    for (const store of this.options.stores ?? defaultStores(this.platform)) {
      try { await writeKey(store, this.root, hex); if (await readKey(store, this.root) !== hex) continue; } catch { continue; }
      fs.writeFileSync(record, JSON.stringify({ store }), { mode: 0o600 });
      return Buffer.from(hex, "hex");
    }
    throw new Error("No place to keep the plugin secret key");
  }
}

function defaultStores(platform: NodeJS.Platform): KeyStore[] {
  if (platform === "darwin") return ["keychain", "file"];
  return process.env.DBUS_SESSION_BUS_ADDRESS ? ["libsecret", "file"] : ["file"];
}
function storeName(store: KeyStore): string { return store === "keychain" ? "the macOS Keychain" : store === "libsecret" ? "the Secret Service (libsecret)" : "key file"; }

async function readKey(store: KeyStore, root: string): Promise<string> {
  if (store === "file") return fs.readFileSync(path.join(root, "master.key"), "utf8").trim();
  if (store === "keychain") return (await run("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"])).trim();
  return (await run("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT])).trim();
}
async function writeKey(store: KeyStore, root: string, hex: string): Promise<void> {
  if (store === "file") { const file = path.join(root, "master.key"); fs.writeFileSync(file, hex, { mode: 0o600 }); fs.chmodSync(file, 0o600); return; }
  // `security -i` reads its command from stdin, so the key never shows in argv.
  if (store === "keychain") { await run("security", ["-i"], `add-generic-password -U -s "${SERVICE}" -a ${ACCOUNT} -w ${hex}\n`); return; }
  await run("secret-tool", ["store", `--label=${SERVICE}`, "service", SERVICE, "account", ACCOUNT], hex);
}

function seal(key: Buffer, value: string): string {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return "v1:" + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}
function open(key: Buffer, payload: string): string {
  if (!payload.startsWith("v1:")) throw new Error("Unknown plugin secret format");
  const raw = Buffer.from(payload.slice(3), "base64"), decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

function run(command: string, args: string[], input = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = []; child.stdout.on("data", (data: Buffer) => chunks.push(data));
    child.on("error", () => reject(new Error(`${command} unavailable`)));
    child.on("close", code => code === 0 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error(`${command} failed`)));
    child.stdin.end(input, "utf8");
  });
}
function dpapi(value: string, decrypt: boolean): Promise<string> {
  const script = `[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=${decrypt ? "[Convert]::FromBase64String($v)" : "[Text.Encoding]::UTF8.GetBytes($v)"}; $r=[Security.Cryptography.ProtectedData]::${decrypt ? "Unprotect" : "Protect"}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write(${decrypt ? "[Text.Encoding]::UTF8.GetString($r)" : "[Convert]::ToBase64String($r)"})`;
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], value).catch(() => { throw new Error("DPAPI failed"); });
}
