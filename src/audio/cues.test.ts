import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { AudioService } from "./service.js";
import { memoryStore, normalizeOutput } from "./settings.js";

function rules() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL("../../public/audio-cues.js", import.meta.url), "utf8"), context);
  return context.scribeAudioCues;
}

test("cues sound only for user-level threads the user is not watching", () => {
  const { cueFor } = rules();
  const user = { id: "a" };
  assert.equal(cueFor(user, "finish"), "thread-finish");
  assert.equal(cueFor(user, "ask"), "thread-ask");
  assert.equal(cueFor(user, "other"), null);
  assert.equal(cueFor({ ...user, helperOf: "parent" }, "finish"), null);
  // Board workers' chats and page chats both carry fromPage.
  assert.equal(cueFor({ ...user, fromPage: true }, "ask"), null);
  assert.equal(cueFor({ ...user, archived: true }, "finish"), null);
  assert.equal(cueFor(user, "finish", { watching: true }), null);
});

test("cues within 1.5 s merge into one", () => {
  const { merger } = rules();
  const merge = merger();
  assert.equal(merge.admit(1000), true);
  assert.equal(merge.admit(1800), false);
  assert.equal(merge.admit(2499), false);
  assert.equal(merge.admit(2500), true);
});

test("one window plays: the focused one, else the one open longest", () => {
  const { elected, PEER_STALE_MS } = rules();
  const now = 100_000;
  const me = { id: "b", since: 50, focused: false };
  assert.equal(elected(me, [], now), true);
  assert.equal(elected({ ...me, focused: true }, [{ id: "a", since: 10, focused: true, at: now }], now), true);
  assert.equal(elected(me, [{ id: "a", since: 99, focused: true, at: now }], now), false);
  assert.equal(elected(me, [{ id: "a", since: 10, focused: false, at: now }], now), false);
  assert.equal(elected(me, [{ id: "c", since: 60, focused: false, at: now }], now), true);
  assert.equal(elected(me, [{ id: "a", since: 50, focused: false, at: now }], now), false, "ties go to the lower id");
  assert.equal(elected(me, [{ id: "a", since: 10, focused: true, at: now - PEER_STALE_MS }], now), true, "a silent window is gone");
});

test("sounds are off by default; each cue has its own switch", () => {
  const { cueEnabled } = rules();
  const output = normalizeOutput(undefined);
  assert.deepEqual(output, { sounds: false, volume: 0.6, cues: { "thread-finish": true, "thread-ask": true } });
  assert.equal(cueEnabled(output, "thread-finish"), false);
  assert.equal(cueEnabled({ ...output, sounds: true }, "thread-finish"), true);
  assert.equal(cueEnabled({ ...output, sounds: true, volume: 0 }, "thread-finish"), false);
  assert.equal(cueEnabled({ ...output, sounds: true, cues: { "thread-finish": false } }, "thread-finish"), false);
  assert.equal(normalizeOutput({ volume: 7 }).volume, 1);
});

test("saving sound settings keeps the rest and tells open windows", () => {
  const pushed: unknown[] = [];
  const service = new AudioService({ sources: () => [], store: memoryStore({ input: { sendAfterDictation: true } }), onOutput: o => pushed.push(o) });
  service.update({ output: { sounds: true } });
  service.update({ output: { cues: { "thread-ask": false } } });
  const view = service.view();
  assert.deepEqual(view.output, { sounds: true, volume: 0.6, cues: { "thread-finish": true, "thread-ask": false } });
  assert.equal(view.input.sendAfterDictation, true);
  assert.equal(pushed.length, 2);
  service.update({ input: { pushToTalk: false } });
  assert.equal(pushed.length, 2, "other settings do not push sound settings");
});
