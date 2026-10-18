import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { test } from "node:test";
import express from "express";
import { BoardDb } from "./db.js";
import { APPEARANCE_KEYS, appearanceRouter, type Appearance } from "./appearance.js";
import { contentOriginGate } from "./contentOrigin.js";

test("appearance API persists across restarts, merges profiles, and excludes functional settings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-appearance-"));
  const sqlite = path.join(dir, "scribe.sqlite");
  let db = BoardDb.open(sqlite, path.join(dir, "state.json"));
  const app = express();
  const updates: Appearance[] = [];
  app.use(contentOriginGate);
  app.use(express.json());
  app.use("/api/appearance", appearanceRouter({ read: () => db.readAppearance(), write: value => db.writeAppearance(value) }, value => updates.push(value)));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/appearance`;
  const put = (settings: Appearance, migrate = false) => fetch(base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings, migrate }) });
  try {
    assert.deepEqual(await (await fetch(base)).json(), {});
    assert.equal((await put({ "scribe.theme": "garnet", "scribe.uiEffects": "0" }, true)).status, 200);
    assert.deepEqual(await (await put({ "scribe.theme": "cream", "scribe.chromeFx": "rise" }, true)).json(), {
      "scribe.theme": "garnet", "scribe.uiEffects": "0", "scribe.chromeFx": "rise",
    });
    await put({ "scribe.theme": "dusk" });
    await put({ "scribe.chromeFxWhen": "obsolete", "scribe.auroraEdge": "0" }, true);
    db.close();
    db = BoardDb.open(sqlite, path.join(dir, "state.json"));
    assert.equal((await (await fetch(base)).json())["scribe.theme"], "dusk");
    const bootstrap = await fetch(base + "/bootstrap.js");
    assert.equal(bootstrap.headers.get("cache-control"), "no-store");
    assert.match(await bootstrap.text(), /scribeAppearanceSeed=.*dusk/);
    const invalidSettings: Appearance[] = [{ "scribe.agent.sendKey": "mod" }, { "scribe.theme": "wrong" }, { "scribe.uiEffects": "true" }, { "scribe.dock-appearance.v1": "null" }];
    for (const settings of invalidSettings) {
      assert.equal((await put(settings)).status, 400);
    }
    assert.equal(db.readAppearance()["scribe.auroraEdge"], "0");
    assert.equal(db.readAppearance()["scribe.chromeFxWhen"], undefined);
    assert.equal(updates.length, 4);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("client migrates only saved styling and fresh profiles read shared choices", async () => {
  let shared: Appearance = {};
  const writes: Array<{ settings: Appearance; migrate: boolean }> = [];
  function profile(saved: Record<string, string>) {
    const cache = new Map(Object.entries(saved));
    const listeners: Record<string, Function[]> = {};
    const window: any = {
      scribeAppearanceSeed: { keys: APPEARANCE_KEYS, settings: { ...shared } },
      addEventListener(name: string, callback: Function) { (listeners[name] ??= []).push(callback); },
      dispatchEvent(event: { type: string }) { for (const listener of listeners[event.type] ?? []) listener(event); },
    };
    const context = vm.createContext({ window, localStorage: { getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => cache.set(key, value) }, Event: class { constructor(public type: string) {} }, console, setTimeout, clearTimeout,
      fetch: async (_url: string, init?: any) => {
        if (init) {
          const payload = JSON.parse(init.body);
          writes.push(payload);
          for (const [key, value] of Object.entries(payload.settings)) {
            if (!payload.migrate || !Object.hasOwn(shared, key)) shared[key] = value as string;
          }
        }
        const snapshot = { ...shared };
        return { ok: true, headers: { get: () => String(writes.length) }, json: async () => snapshot };
      },
    });
    vm.runInContext(fs.readFileSync(new URL("../public/appearance.js", import.meta.url), "utf8"), context);
    return { window, cache };
  }
  const desktop = profile({ "scribe.theme": "garnet", "scribe.chromeFx": "rise", "scribe.agent.sendKey": "mod" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].migrate, true);
  assert.deepEqual(shared, { "scribe.theme": "garnet", "scribe.chromeFx": "rise" });
  const browser = profile({});
  const stale = profile({ "scribe.theme": "cream" });
  assert.equal(browser.window.scribeAppearance.getItem("scribe.theme"), "garnet");
  assert.equal(stale.window.scribeAppearance.getItem("scribe.theme"), "garnet");
  assert.equal(writes.length, 1, "opening fresh and stale browsers publishes no defaults");
  browser.window.scribeAppearance.setItem("scribe.uiEffects", "0");
  await new Promise(resolve => setImmediate(resolve));
  desktop.window.scribeAppearance.receive(shared);
  assert.equal(desktop.window.scribeAppearance.getItem("scribe.uiEffects"), "0");
  assert.equal(desktop.cache.get("scribe.agent.sendKey"), "mod");
  browser.window.scribeAppearance.setItem("scribe.agent.sendKey", "enter");
  assert.equal(writes.length, 2, "functional setting stays local");
  assert.equal(profile({}).window.scribeAppearance.getItem("scribe.uiEffects"), "0");
  desktop.window.scribeAppearance.receive({ ...shared, "scribe.theme": "dusk" }, 9);
  desktop.window.scribeAppearance.receive({ ...shared, "scribe.theme": "cream" }, 8);
  assert.equal(desktop.window.scribeAppearance.getItem("scribe.theme"), "dusk", "late save responses cannot revert newer shared choices");
});
