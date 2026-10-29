import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { AgentDb } from "./db.js";
import { DatabaseSync } from "node:sqlite";
import { matchMessages, searchWords } from "./threadSearch.js";
import type { Item, Thread } from "./types.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-thread-search-"));
const db = new AgentDb(path.join(dir, "agent.sqlite"));

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
const item = (threadId: string, body: Record<string, unknown>): Item => ({ id: `i${++seq}`, threadId, turnId: "turn", seq, ...body }) as unknown as Item;

const search = (q: string) => {
  const words = searchWords(q);
  return matchMessages(db.searchMessages(words), words);
};

test("thread search reads the user's messages and the agent's replies, word by word", () => {
  for (const id of ["a", "b", "c"]) db.saveThread({ id, title: id, activityAt: 1 } as unknown as Thread);
  db.saveItems([
    item("a", { kind: "user", text: "How do I Install\nllama.cpp here?" }),
    item("a", { kind: "text", text: "Use the H2O model: it is 100% \"ready\" for snake_case names." }),
    item("b", { kind: "tool", name: "shell", title: "h2o install", output: "h2o install" }),
    item("b", { kind: "text", text: "A subagent said h2o.", parentToolId: "tool" }),
    item("b", { kind: "user", text: "Dropped h2o message", dropped: true }),
    item("b", { kind: "text", text: "Nothing to install here." }),
    item("c", { kind: "user", text: "Älä unohda ääkkösiä" }),
  ]);

  // Words may sit in different messages, in any order and case.
  const both = search("h2o install");
  assert.deepEqual(both.map((hit) => [hit.id, [...hit.words].sort()]), [["a", ["h2o", "install"]], ["b", ["install"]]]);
  assert.equal(both[0].snippet, "How do I Install llama.cpp here?");

  // Tool calls, subagent text and dropped messages are not searched.
  assert.deepEqual(search("h2o").map((hit) => hit.id), ["a"]);

  // LIKE wildcards and JSON-escaped characters in a word are matched as written.
  assert.deepEqual(search("100%").map((hit) => hit.id), ["a"]);
  assert.deepEqual(search('"ready"').map((hit) => hit.id), ["a"]);
  assert.deepEqual(search("snake_case").map((hit) => hit.id), ["a"]);
  assert.deepEqual(search("snakeXcase"), []);
  assert.deepEqual(search("10_%"), []);

  // Letters outside ASCII match whatever their case.
  assert.deepEqual(search("älä ÄÄKKÖSIÄ").map((hit) => hit.words.length), [2]);
  assert.deepEqual(search(""), []);
});

test("short terms, technical names, and stopwords keep useful message matches", () => {
  db.saveThread({ id: "short", title: "Model setup", activityAt: 1 } as unknown as Thread);
  db.saveItems([item("short", { kind: "user", text: "llama.cpp H2O x" })]);
  assert.deepEqual(searchWords("please show my llama.cpp page"), ["llama.cpp"]);
  assert.deepEqual(searchWords("a"), ["a"]);
  assert.deepEqual(search("x").map((hit) => hit.id), ["short"]);
  assert.deepEqual(search("please show llama.cpp H2O x").map((hit) => [hit.id, hit.words]), [
    ["a", ["llama.cpp", "h2o"]], ["short", ["llama.cpp", "h2o", "x"]],
  ]);
});

test("later messages can complete a match and improve its snippet", () => {
  const rows = [
    { threadId: "t", text: "llama" },
    { threadId: "t", text: "h2o" },
    { threadId: "t", text: "llama and h2o together" },
    { threadId: "t", text: "llama h2o later" },
  ];
  assert.deepEqual(matchMessages(rows, ["llama", "h2o"]), [{ id: "t", words: ["llama", "h2o"], snippet: "llama and h2o together" }]);
});

test("the message text table follows edits, drops and deletes of items and threads", () => {
  db.saveThread({ id: "sync", title: "sync", activityAt: 1 } as unknown as Thread);
  const kept = item("sync", { kind: "user", text: "first draft of syncneedle" });
  const later = item("sync", { kind: "text", text: "partial" });
  db.saveItems([kept, later]);
  assert.deepEqual(search("syncneedle").map((hit) => hit.id), ["sync"]);

  // Streaming text grows by saving the item again.
  db.saveItems([{ ...later, text: "partial, then streamedneedle" } as Item]);
  assert.deepEqual(search("streamedneedle").map((hit) => hit.id), ["sync"]);

  // Dropping a message takes it out of search; undropping brings it back.
  db.saveItems([{ ...kept, dropped: true } as Item]);
  assert.deepEqual(search("syncneedle"), []);
  db.saveItems([kept]);
  assert.deepEqual(search("syncneedle").map((hit) => hit.id), ["sync"]);

  db.deleteItem(kept.id);
  assert.deepEqual(search("syncneedle"), []);
  db.deleteThread("sync");
  assert.deepEqual(search("streamedneedle"), []);
});

test("a database from before the message text table gets it filled on open", () => {
  const file = path.join(dir, "older.sqlite");
  const first = new AgentDb(file);
  first.saveThread({ id: "old", title: "old", activityAt: 1 } as unknown as Thread);
  first.saveItems([item("old", { kind: "user", text: "backfillneedle from long ago" }), item("old", { kind: "tool", name: "shell", output: "backfillneedle" })]);
  first.close();
  // What an older daemon left behind: the items, no table rows and no version mark.
  const raw = new DatabaseSync(file);
  raw.exec("DELETE FROM message_text; DELETE FROM meta WHERE k = 'message_text';");
  raw.close();

  const reopened = new AgentDb(file);
  try {
    const rows = [...reopened.searchMessages(["backfillneedle"])].map((row) => ({ ...row }));
    assert.deepEqual(rows, [{ threadId: "old", text: "backfillneedle from long ago" }]);
    assert.deepEqual([...reopened.messagesMentioning(["backfillneedle", "ago"])].length, 1);
    assert.deepEqual([...reopened.messagesMentioning(["backfillneedle", "missing"])], []);
  } finally {
    reopened.close();
  }
});
