import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { openFileForAgent } from "./openFile.js";
import type { Tab } from "../types.js";

let work = "";
let outside = "";

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-open-ws-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-open-out-"));
  fs.writeFileSync(path.join(work, "inside.txt"), "in");
  fs.writeFileSync(path.join(outside, "secret.txt"), "out");
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function fakeStore() {
  const calls: Array<{ path: string; temp?: boolean; activate?: boolean }> = [];
  return {
    calls,
    openFilePage(input: { path: string; temp?: boolean; activate?: boolean }) {
      calls.push(input);
      return { tab: { id: "t_00000001" } as Tab, created: true };
    },
  };
}

test("an agent opens a file in its workspace as a temporary page (#655)", async () => {
  const store = fakeStore();
  await openFileForAgent({ cwd: work, mode: "code", approval: "edits" }, store, { path: "inside.txt" });
  assert.deepEqual(store.calls, [{ path: path.join(work, "inside.txt"), temp: true, activate: true }]);
  await openFileForAgent({ cwd: work, mode: "board", approval: "board" }, store, { path: path.join(work, "inside.txt"), keep: true });
  assert.equal(store.calls[1].temp, false);
});

test("an agent can't open a file outside its read scope, unless Code mode has Full access (#655)", async () => {
  const store = fakeStore();
  const secret = path.join(outside, "secret.txt");
  await assert.rejects(openFileForAgent({ cwd: work, mode: "code", approval: "edits" }, store, { path: secret }), /denied/);
  await assert.rejects(openFileForAgent({ cwd: null, mode: "board", approval: "edits" }, store, { path: path.join(work, "inside.txt") }), /unavailable/);
  await assert.rejects(openFileForAgent(null, store, { path: secret }), /unavailable/);
  assert.equal(store.calls.length, 0);
  await openFileForAgent({ cwd: work, mode: "code", approval: "full" }, store, { path: secret });
  assert.equal(store.calls.length, 1);
});

test("an agent can't open a folder as a page (#655)", async () => {
  await assert.rejects(openFileForAgent({ cwd: work, mode: "code", approval: "full" }, fakeStore(), { path: outside }), /not a file/);
});
