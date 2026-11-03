import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { helpGuide, threadInstructions } from "./agent/prompt.js";
import type { Thread } from "./agent/types.js";
import { BoardStore } from "./store.js";

let dir = "";
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.SCRIBE_HOME;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-"));
  process.env.SCRIBE_HOME = dir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SCRIBE_HOME;
  else process.env.SCRIBE_HOME = prevHome;
  // The store keeps its database open; on Windows the folder may not go until the process ends.
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

function loaded(): BoardStore {
  const store = new BoardStore();
  store.load();
  return store;
}

test("a new install waits for the setup guide until it is finished", () => {
  const store = loaded();
  assert.deepEqual(store.onboarding(() => false), { done: false });
  // The first answer sticks: pages made afterwards do not end the guide.
  store.upsert({ title: "First page", html: "<p>hi</p>", activate: false });
  assert.deepEqual(store.onboarding(() => false), { done: false });
  store.setOnboarding(true);
  assert.deepEqual(store.onboarding(() => false), { done: true });
  store.setOnboarding(false);
  assert.deepEqual(store.onboarding(() => true), { done: false });
});

test("an install from before the guide, with pages or chats, counts as set up", () => {
  const withPages = loaded();
  withPages.upsert({ title: "Old page", html: "<p>old</p>", activate: false });
  assert.deepEqual(withPages.onboarding(() => false), { done: true });

  dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-"));
  process.env.SCRIBE_HOME = dir;
  const withChats = loaded();
  assert.deepEqual(withChats.onboarding(() => true), { done: true });
});

test("help threads get the guide and answer like a reference, not a conversation", () => {
  const thread = (over: Partial<Thread>): Thread =>
    ({ provider: "claude", mode: "board", approval: "readonly", cwd: null, scope: { kind: "global", ref: null }, ...over }) as Thread;
  const guide = helpGuide();
  assert.match(guide, /## Keyboard shortcuts/);
  const help = threadInstructions(thread({ help: true }), {});
  assert.match(help, /<scribe_help_guide>[\s\S]*## Keyboard shortcuts[\s\S]*<\/scribe_help_guide>/);
  assert.match(help, /settings_show/);
  assert.match(help, /no greeting/);
  assert.doesNotMatch(help, /Wrong thread:/);
  assert.doesNotMatch(threadInstructions(thread({}), {}), /scribe_help_guide/);
});
