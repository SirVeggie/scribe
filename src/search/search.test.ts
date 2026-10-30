import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import express from "express";
import { detectSearchPack, searchPackDir, searchEnabled, setSearchEnabled, SEARCH_MODEL, SEARCH_RUNTIME } from "./pack.js";
import { tokenBatches } from "./batches.js";
import { SearchEmbedder } from "./embedder.js";
import { searchRouter } from "./routes.js";
import { searchIndex } from "./service.js";

// Exercise the real child and IPC, substituting only the optional model/runtime files.
const fakeRuntime = `
export const env = {};
const check = () => { if (env.allowRemoteModels !== false || !env.allowLocalModels || !env.localModelPath) throw new Error('not offline'); };
export const AutoConfig = { from_pretrained: async () => { check(); return { vision_config: {}, audio_config: {} }; } };
export const AutoTokenizer = { from_pretrained: async () => async (input, options) => {
  const texts = (Array.isArray(input) ? input : [input]).map(t => [...t].slice(0, options.max_length).join(''));
  const lengths = texts.map(t => Math.min(options.max_length, [...t].length));
  return { texts, input_ids: { dims: [texts.length, Math.max(...lengths)] } };
} };
export const AutoModel = { from_pretrained: async (_, options) => {
  check(); if (options.device !== 'cpu' || options.dtype !== 'q8' || options.config.audio_config !== null) throw new Error('wrong options');
  return async encoded => {
    if (encoded.texts?.some(t => t.includes('__fail__'))) throw new Error('fake inference failure');
    if (encoded.texts?.some(t => t.includes('__crash__'))) process.exit(7);
    if (encoded.texts?.some(t => t.includes('__slow__'))) await new Promise(r => setTimeout(r, 300));
    const texts = encoded.texts || ['image'];
    const padded = encoded.input_ids ? encoded.input_ids.dims[0] * encoded.input_ids.dims[1] : 280;
    if (padded > 6000 || texts.length > 32) throw new Error('batch overflow');
    return { sentence_embedding: { dims: [texts.length, 4], data: Float32Array.from(texts.flatMap(t => [t.length, padded, process.pid, options.config.vision_config === null ? 0 : 1])) } };
  };
} };
export const AutoProcessor = { from_pretrained: async () => async (_, image) => { if (!image) throw new Error('missing image'); return {}; } };
export const RawImage = { fromBlob: async blob => { if (!blob.size) throw new Error('empty image'); return {}; } };
`;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-search-test-"));
  const folder = searchPackDir(root);
  const names = [SEARCH_RUNTIME, ...["config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json", "processor_config.json", "onnx/model_quantized.onnx", "onnx/vision_encoder_quantized.onnx"].map(n => `models/${SEARCH_MODEL}/${n}`)];
  const files: Record<string, string> = {};
  for (const name of names) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    const content = name === SEARCH_RUNTIME ? fakeRuntime : "{}";
    fs.writeFileSync(path.join(folder, name), content);
    files[name] = createHash("sha256").update(content).digest("hex");
  }
  const manifest = { api: 1, version: "test", platform: process.platform, arch: process.arch, model: SEARCH_MODEL, dtype: "q8", files };
  const write = () => fs.writeFileSync(path.join(folder, "pack.json"), JSON.stringify(manifest));
  write();
  return { root, folder, manifest, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("pack status handles absent, incompatible, malformed and incomplete installs", () => {
  const f = fixture();
  try {
    assert.equal(detectSearchPack(f.root).status, "ready");
    assert.equal(searchEnabled(f.root), false);
    setSearchEnabled(true, f.root); assert.equal(searchEnabled(f.root), true);
    f.manifest.api = 2; f.write(); assert.equal(detectSearchPack(f.root).status, "wrong-version");
    assert.throws(() => setSearchEnabled(true, f.root));
    f.manifest.api = 1; f.write();
    assert.equal(detectSearchPack(f.root, "other" as NodeJS.Platform).status, "wrong-version");
    assert.equal(detectSearchPack(f.root, process.platform, "other" as NodeJS.Architecture).status, "wrong-version");
    f.manifest.files["../escape"] = "0".repeat(64); f.write();
    assert.equal(detectSearchPack(f.root).status, "invalid");
    delete f.manifest.files["../escape"]; f.write();
    fs.unlinkSync(path.join(f.folder, SEARCH_RUNTIME)); assert.equal(detectSearchPack(f.root).status, "invalid");
    fs.writeFileSync(path.join(f.folder, "pack.json"), "{"); assert.equal(detectSearchPack(f.root).status, "invalid");
    fs.unlinkSync(path.join(f.folder, "pack.json")); assert.equal(detectSearchPack(f.root).status, "not-installed");
    setSearchEnabled(false, f.root); assert.equal(searchEnabled(f.root), false);
  } finally { f.cleanup(); }
});
test("token batches respect padded budget and item cap", () => {
  const lengths = [5999, ...Array(90).fill(20), 3001, 3000, 6000];
  const batches = tokenBatches(lengths);
  assert.equal(batches.flat().length, lengths.length);
  assert.equal(new Set(batches.flat()).size, lengths.length);
  for (const b of batches) { assert.ok(b.length <= 32); assert.ok(Math.max(...b.map(i => lengths[i])) * b.length <= 6000); }
});
test("no pack stays inert, including disabled requests", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-search-absent-"));
  const embedder = new SearchEmbedder({ root });
  try {
    assert.equal(detectSearchPack(root).status, "not-installed");
    await assert.rejects(embedder.embedQuery("test"), /off/);
    assert.deepEqual(await embedder.embedDocuments([]), []);
    assert.equal(embedder.running, false);
  } finally { embedder.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
test("real IPC embeds offline, preserves document order, loads vision lazily and restarts after idle", async () => {
  const f = fixture(); setSearchEnabled(true, f.root);
  const embedder = new SearchEmbedder({ root: f.root, idleMs: 150 });
  try {
    assert.equal(embedder.running, false);
    const query = await embedder.embedQuery("hello");
    assert.ok(query instanceof Float32Array);
    assert.equal(query[0], "task: search result | query: hello".length);
    assert.equal(query[3], 0);
    await embedder.stopAndWait();
    assert.equal(embedder.running, false);
    const items = [{ title: "long", text: "x".repeat(5990) }, ...Array.from({ length: 70 }, (_, i) => ({ title: String(i), text: "y".repeat(i) }))];
    const vectors = await embedder.embedDocuments(items);
    assert.deepEqual(vectors.map(v => v[0]), items.map(it => Math.min(6000, `title: ${it.title} | text: ${it.text}`.length)));
    assert.ok(vectors.every(v => v[1] <= 6000));
    const image = await embedder.embedImage(Uint8Array.of(1, 2, 3)); assert.equal(image[3], 1);
    await assert.rejects(embedder.embedQuery("__fail__"), /fake inference failure/);
    assert.ok((await embedder.embedQuery("recovered"))[0] > 0);
    await delay(300); assert.equal(embedder.running, false);
    assert.throws(() => process.kill(query[2], 0), /ESRCH|not found/);
    const restarted = await embedder.embedQuery("again"); assert.notEqual(restarted[2], query[2]);
    await assert.rejects(embedder.embedQuery("__crash__"), /exited/);
    assert.ok((await embedder.embedQuery("after crash"))[0] > 0);
    embedder.dispose(); assert.equal(embedder.running, false);
    await assert.rejects(embedder.embedQuery("closed"), /disposed/);
  } finally { embedder.dispose(); await delay(100); f.cleanup(); }
});
test("stop and timeout reject pending requests and release the child", async () => {
  const f = fixture(); setSearchEnabled(true, f.root);
  const embedder = new SearchEmbedder({ root: f.root });
  const timed = new SearchEmbedder({ root: f.root, requestMs: 30 });
  try {
    await embedder.embedQuery("warm");
    const request = embedder.embedQuery("__slow__");
    embedder.stop(); await assert.rejects(request, /stopped/); assert.equal(embedder.running, false);
    await assert.rejects(timed.embedQuery("timeout"), /timed out/); assert.equal(timed.running, false);
  } finally { embedder.dispose(); timed.dispose(); await delay(100); f.cleanup(); }
});
test("Settings API reports no pack and persists on/off without loading a child", async () => {
  const f = fixture(); const oldHome = process.env.SCRIBE_HOME; process.env.SCRIBE_HOME = f.root;
  const app = express(); app.use(express.json()); app.use(searchRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const status = await (await fetch(url + "/status")).json(); assert.equal(status.status, "ready"); assert.equal(status.enabled, false); assert.equal(status.pack, undefined);
    const enable = await fetch(url + "/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    assert.equal(enable.status, 200); assert.equal((await enable.json()).enabled, true);
    const bad = await fetch(url + "/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: "yes" }) }); assert.equal(bad.status, 400);
    fs.unlinkSync(path.join(f.folder, "pack.json"));
    const absent = await (await fetch(url + "/status")).json(); assert.equal(absent.status, "not-installed"); assert.equal(absent.enabled, false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await searchIndex.close();
    if (oldHome === undefined) delete process.env.SCRIBE_HOME; else process.env.SCRIBE_HOME = oldHome;
    f.cleanup();
  }
});

test("daemon starts, serves the shell and stops normally without a search pack", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-search-daemon-"));
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../index.ts", import.meta.url)), "--daemon"], {
    env: { ...process.env, SCRIBE_HOME: root, SCRIBE_PORT: String(port), SCRIBE_AGENT_PORT: "0" }, windowsHide: true, stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  const url = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(url + "/api/health", { signal: AbortSignal.timeout(300) })).ok) { ready = true; break; } } catch { /* starting */ }
      if (child.exitCode !== null) throw new Error(`Daemon exited ${child.exitCode}`);
      await delay(100);
    }
    assert.equal(ready, true, "daemon became ready");
    const status = await (await fetch(url + "/api/search/status")).json();
    assert.equal(status.status, "not-installed"); assert.equal(status.enabled, false);
    assert.equal((await fetch(url + "/")).status, 200);
    const enable = await fetch(url + "/api/search/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) }); assert.equal(enable.status, 400);
    assert.equal((await fetch(url + "/api/shutdown", { method: "POST" })).status, 200);
    const code = await Promise.race([exited, delay(5000).then(() => "timeout")]); assert.equal(code, 0);
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
