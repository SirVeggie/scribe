import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { deflateRawSync } from "node:zlib";
import express from "express";
import { installSearchPack } from "./install.js";
import { detectSearchPack, SEARCH_MODEL, SEARCH_RUNTIME, searchEnabled, setSearchEnabled } from "./pack.js";
import { searchRouter } from "./routes.js";

type File = { name: string; data: string; mode?: number };
// Small standard ZIP fixtures, including deflated entries, without another dependency.
function zip(files: File[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), data = Buffer.from(file.data), compressed = deflateRawSync(data);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((file.mode ?? 0x81a4) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const end = Buffer.alloc(22), directory = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function fixture(version = "new", overrides = {}) {
  const files = [SEARCH_RUNTIME, ...["config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json", "processor_config.json", "onnx/model_quantized.onnx", "onnx/vision_encoder_quantized.onnx"].map(n => `models/${SEARCH_MODEL}/${n}`)].map(name => ({ name, data: "{}" }));
  const manifest = { api: 1, version, platform: process.platform, arch: process.arch, model: SEARCH_MODEL, dtype: "q8", files: Object.fromEntries(files.map(f => [f.name, createHash("sha256").update(f.data).digest("hex")])), ...overrides };
  return [...files, { name: "pack.json", data: JSON.stringify(manifest) }];
}
const input = (files: File[]) => Readable.from(zip(files));

test("installs and replaces a ZIP, preserves enabled setting and cleans staging", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-pack-install-"));
  try {
    await installSearchPack(input(fixture("old")), root);
    setSearchEnabled(true, root);
    let stopped = false;
    await installSearchPack(input(fixture()), root, async () => { stopped = true; assert.equal(detectSearchPack(root).pack?.version, "old"); });
    assert.equal(stopped, true); assert.equal(detectSearchPack(root).pack?.version, "new");
    assert.equal(searchEnabled(root), true);
    assert.deepEqual(fs.readdirSync(path.join(root, "packs")), ["search"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("invalid, incompatible, corrupt and unsafe ZIPs leave the current pack intact", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-pack-invalid-"));
  try {
    await installSearchPack(input(fixture("old")), root);
    const corrupt = fixture(); corrupt[0].data = "corrupted";
    const cases = [
      { files: fixture("new", { api: 99 }), error: /API/ },
      { files: fixture("new", { platform: "other" }), error: /Requires a/ },
      { files: fixture().slice(1), error: /Incomplete/ },
      { files: fixture().map(f => ({ ...f, name: `wrapper/${f.name}` })), error: /root/ },
      { files: corrupt, error: /checksum/ },
      { files: [...fixture(), { name: "../escape", data: "bad" }], error: /invalid relative path|Unsafe/ },
      { files: [...fixture(), { name: "link", data: "outside", mode: 0xa1ff }], error: /Unsafe/ },
      { files: [...fixture(), { name: "PACK.JSON", data: "{}" }], error: /Duplicate/ },
      { files: [...fixture(), { name: "file:stream", data: "bad" }], error: /Unsafe/ },
    ];
    for (const c of cases) {
      await assert.rejects(installSearchPack(input(c.files), root, async () => assert.fail("must validate first")), c.error);
      assert.equal(detectSearchPack(root).pack?.version, "old");
      assert.deepEqual(fs.readdirSync(path.join(root, "packs")), ["search"]);
    }
    await assert.rejects(installSearchPack(Readable.from("not a ZIP"), root));
    await assert.rejects(installSearchPack(input(fixture()), root, async () => { throw new Error("stop failed"); }), /stop failed/);
    assert.equal(detectSearchPack(root).pack?.version, "old");
    assert.equal(fs.existsSync(path.join(root, "escape")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("simultaneous install is rejected and interrupted upload is cleaned", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-pack-concurrent-"));
  let unblock!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { unblock = r; }), ready = new Promise<void>(r => { entered = r; });
  try {
    const first = installSearchPack(input(fixture()), root, async () => { entered(); await gate; });
    await ready;
    await assert.rejects(installSearchPack(input(fixture()), root), /already in progress/);
    unblock(); await first;
    const broken = new Readable({ read() { this.destroy(new Error("upload interrupted")); } });
    await assert.rejects(installSearchPack(broken, root), /interrupted/);
    assert.deepEqual(fs.readdirSync(path.join(root, "packs")), ["search"]);
  } finally { unblock(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed replacement restores the old pack; failed rollback preserves its backup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-pack-rollback-"));
  const rename = fsp.rename;
  try {
    await installSearchPack(input(fixture("old")), root);
    for (const rollbackFails of [false, true]) {
      let calls = 0;
      const patched = mock.method(fsp, "rename", async (...args: Parameters<typeof rename>) => {
        calls++;
        if (calls === 2 || (rollbackFails && calls === 3)) throw new Error("rename failed");
        return rename(...args);
      });
      try {
        await assert.rejects(installSearchPack(input(fixture()), root), rollbackFails ? /preserved at/ : /rename failed/);
      } finally { patched.mock.restore(); }
      if (rollbackFails) {
        const temp = fs.readdirSync(path.join(root, "packs")).find(n => n.startsWith(".search-install-"))!;
        assert.equal(JSON.parse(fs.readFileSync(path.join(root, "packs", temp, "previous", "pack.json"), "utf8")).version, "old");
      } else {
        assert.equal(detectSearchPack(root).pack?.version, "old");
        assert.deepEqual(fs.readdirSync(path.join(root, "packs")), ["search"]);
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("HTTP ZIP upload returns refreshed settings and handles invalid archives", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-pack-http-"));
  const previous = process.env.SCRIBE_HOME; process.env.SCRIBE_HOME = root;
  const app = express(); app.use(express.json()); app.use("/api/search", searchRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/search`;
  try {
    const response = await fetch(`${url}/install`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: new Uint8Array(zip(fixture())) });
    assert.equal(response.status, 200);
    const status = await response.json(); assert.equal(status.status, "ready"); assert.equal(status.enabled, false); assert.equal(status.version, "new");
    const invalid = await fetch(`${url}/install`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: "invalid" });
    assert.equal(invalid.status, 400); assert.ok((await invalid.json()).error);
    assert.equal((await fetch(`${url}/install`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 400);
    assert.equal(detectSearchPack(root).status, "ready");
  } finally {
    await new Promise<void>((r, j) => server.close(err => err ? j(err) : r()));
    if (previous === undefined) delete process.env.SCRIBE_HOME; else process.env.SCRIBE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
