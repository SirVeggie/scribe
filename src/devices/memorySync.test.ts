import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { mergeMemories, saveMemory, type Memory } from "../agent/memory.js";
import { incoming, normalizeRemote, outgoing, repoIdentity, repoOf } from "./memorySync.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-memsync-"));
after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const mem = (id: string, updatedAt: number, extra: Partial<Memory> = {}): Memory => ({ id, scope: "global", text: id, by: "user", createdAt: 1, updatedAt, ...extra });

test("merge: the later edit wins, local-only ones stay put, and settled sides change nothing", () => {
  const here = [mem("a", 10, { text: "old" }), mem("b", 50), mem("c", 5, { local: true })];
  const there = [mem("a", 20, { text: "new", thread: "th_x" }), mem("b", 40, { text: "stale" }), mem("c", 99, { text: "other" }), mem("d", 30)];
  const merged = mergeMemories(here, [], there, [], 1000);
  assert.equal(merged.changed, true);
  const byId = new Map(merged.memories.map((m) => [m.id, m]));
  assert.equal(byId.get("a")!.text, "new");
  assert.equal(byId.get("a")!.thread, undefined, "thread ids stay on their device");
  assert.equal(byId.get("b")!.text, "b");
  assert.equal(byId.get("c")!.text, "c");
  assert.ok(byId.has("d"));
  assert.equal(mergeMemories(merged.memories, [], merged.memories.filter((m) => !m.local), [], 1000).changed, false);
});

test("merge: a tombstone deletes older copies on either side, but not a later edit", () => {
  const here = [mem("a", 10), mem("b", 10)];
  const merged = mergeMemories(here, [{ id: "a", at: 15 }], [mem("a", 12), mem("b", 30)], [{ id: "b", at: 20 }], 1000);
  assert.deepEqual(merged.memories.map((m) => m.id), ["b"]);
  assert.equal(merged.memories[0].updatedAt, 30);
  assert.deepEqual(merged.tombstones.map((t) => t.id).sort(), ["a", "b"]);
});

test("a synced memory made local gets a new id and retires the old one", () => {
  const first = saveMemory([], { title: "T", text: "machine fact", scope: "global", by: "user" }, 1);
  const local = saveMemory(first.memories, { id: first.memory.id, text: "machine fact", scope: "global", local: true, by: "user" }, 2);
  assert.equal(local.retired, first.memory.id);
  assert.notEqual(local.memory.id, first.memory.id);
  assert.equal(local.memory.local, true);
  assert.equal(local.memories.length, 1);
  // Kept local on a later edit that does not say.
  const again = saveMemory(local.memories, { id: local.memory.id, text: "machine fact 2", scope: "global", by: "user" }, 3);
  assert.equal(again.memory.local, true);
  assert.equal(again.retired, undefined);
});

test("remotes match across SSH and HTTPS", () => {
  const forms = ["git@github.com:User/Repo.git", "https://github.com/user/repo.git", "https://token@github.com/user/repo", "ssh://git@github.com/user/repo.git/"];
  for (const url of forms) assert.equal(normalizeRemote(url), "github.com/user/repo", url);
  assert.equal(repoIdentity(["b", "a"], forms[0]), repoIdentity(["a", "b"], forms[1]));
  assert.notEqual(repoIdentity(["a"], forms[0]), repoIdentity(["a"], "https://github.com/fork/repo"));
});

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

test("workspace memories travel by repository and land in the other clone", async () => {
  const origin = path.join(dir, "laptop", "proj");
  fs.mkdirSync(path.join(origin, "pkg"), { recursive: true });
  run(origin, "init", "-q");
  run(origin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "root");
  run(origin, "remote", "add", "origin", "git@github.com:me/proj.git");
  const clone = path.join(dir, "desktop", "code", "proj");
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  run(path.dirname(clone), "clone", "-q", origin, clone);
  run(clone, "remote", "set-url", "origin", "https://github.com/me/proj");
  const plain = path.join(dir, "plain");
  fs.mkdirSync(plain);

  const memories = [
    mem("g", 1),
    mem("w", 1, { scope: "workspace", workspace: origin }),
    mem("sub", 1, { scope: "workspace", workspace: path.join(origin, "pkg") }),
    mem("p", 1, { scope: "provider", provider: "codex", workspace: origin }),
    mem("nogit", 1, { scope: "workspace", workspace: plain }),
    mem("mine", 1, { local: true }),
  ];
  const body = await outgoing(memories, [{ id: "x", at: Date.now() }]);
  assert.deepEqual(body.memories.map((m) => m.id), ["g", "w", "sub", "p"]);
  assert.equal(body.memories[2].repo?.path, "pkg");
  assert.equal(JSON.stringify(body).includes(dir.replace(/\\/g, "\\\\")), false, "no local paths go out");

  const wire = JSON.parse(JSON.stringify(body));
  const there = await incoming(wire, [clone]);
  const byId = new Map(there.memories.map((m) => [m.id, m]));
  assert.equal(byId.get("w")!.workspace, path.normalize(fs.realpathSync(clone)));
  assert.equal(byId.get("sub")!.workspace, path.join(fs.realpathSync(clone), "pkg"));
  assert.equal(byId.get("p")!.provider, "codex");
  assert.equal(there.tombstones.length, 1);

  // A device without the repository takes only the rest.
  const none = await incoming(wire, [plain]);
  assert.deepEqual(none.memories.map((m) => m.id), ["g"]);
  assert.equal((await repoOf(plain)), null);
});
