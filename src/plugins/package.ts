import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import yauzl from "yauzl";

export const MAX_PACKAGE = 64 * 1024 ** 2;
export type PackageFiles = Record<string, Buffer>;
export function packagePath(root: string, name: string): string {
  if (!name || name.includes("\\") || name.includes(":") || name.startsWith("/") || name.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Invalid package path");
  const target = path.resolve(root, name);
  if (path.relative(root, target).startsWith("..")) throw new Error("Package path leaves its folder");
  return target;
}
export function readPackage(root: string): PackageFiles {
  const files: PackageFiles = Object.create(null);
  let bytes = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".git", "node_modules"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name), name = path.relative(root, full).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error("Plugin packages cannot contain links");
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const size = fs.statSync(full).size;
        bytes += size;
        if (bytes > MAX_PACKAGE || Object.keys(files).length >= 2000) throw new Error("Plugin package exceeds 64 MiB or 2000 files");
        files[name] = fs.readFileSync(full);
      }
    }
  };
  walk(root); return files;
}
export function packageHash(files: PackageFiles): string {
  const hash = createHash("sha256");
  for (const name of Object.keys(files).sort()) { hash.update(name); hash.update("\0"); hash.update(files[name]); hash.update("\0"); }
  return hash.digest("hex");
}
export function writePackage(root: string, files: PackageFiles): void {
  for (const [name, data] of Object.entries(files)) { const file = packagePath(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
}

export async function unzip(bytes: Buffer): Promise<PackageFiles> {
  if (bytes.length > MAX_PACKAGE) throw new Error("Archive exceeds 64 MiB");
  return new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, archive) => {
    if (error || !archive) { reject(error ?? new Error("Invalid zip")); return; }
    const files: PackageFiles = Object.create(null); let total = 0, count = 0;
    const fail = (error: Error) => { archive.close(); reject(error); };
    archive.on("error", fail);
    archive.on("entry", (entry: yauzl.Entry) => {
      try {
        if (++count > 2000) throw new Error("Archive has too many entries");
        const name = entry.fileName;
        if (name.endsWith("/")) { packagePath("/package", name.slice(0, -1)); archive.readEntry(); return; }
        packagePath("/package", name);
        if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new Error("Archive links are refused");
        if (Object.hasOwn(files, name)) throw new Error("Duplicate archive entry");
        total += entry.uncompressedSize;
        if (total > MAX_PACKAGE) throw new Error("Expanded archive exceeds 64 MiB");
        archive.openReadStream(entry, (error, stream) => {
          if (error || !stream) { fail(error ?? new Error("Cannot read zip entry")); return; }
          const chunks: Buffer[] = []; let size = 0;
          stream.on("data", (data: Buffer) => { size += data.length; if (size > entry.uncompressedSize || size > MAX_PACKAGE) { stream.destroy(); fail(new Error("Zip entry exceeds declared size")); } else chunks.push(data); });
          stream.on("error", fail);
          stream.on("end", () => { files[name] = Buffer.concat(chunks); archive.readEntry(); });
        });
      } catch (error) { fail(error as Error); }
    });
    archive.on("end", () => resolve(files)); archive.readEntry();
  }));
}

/** ZIP with stored entries: portable, readable by ordinary archive tools, no shell/dependencies. */
export function zip(files: PackageFiles): Buffer {
  const parts: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    packagePath("/package", name);
    const filename = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    parts.push(local, filename, data); directory.push(central, filename); offset += local.length + filename.length + data.length;
  }
  const index = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, index, end]);
}
function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
