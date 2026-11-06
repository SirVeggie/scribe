import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Matcher, Vault, VaultTokenError, agentValueProblem, setVault, tokenFor, type StoredFragment, type VaultStore } from "./vault.js";
import { searchLibrary } from "./librarySearch.js";
import { chunkPage } from "./search/chunker.js";
import type { Tab } from "./types.js";

function memoryStore(): VaultStore & { rows: StoredFragment[] } {
  const rows: StoredFragment[] = [];
  return {
    rows,
    list: () => [...rows],
    insert: (row) => void rows.push(row),
    update: (row) => {
      const at = rows.findIndex((other) => other.id === row.id);
      if (at >= 0) rows[at] = row;
    },
    remove: (id) => {
      const at = rows.findIndex((row) => row.id === id);
      if (at >= 0) rows.splice(at, 1);
      return at >= 0;
    },
  };
}

async function vaultWith(...values: string[]): Promise<{ vault: Vault; tokens: string[] }> {
  const vault = new Vault();
  const tokens: string[] = [];
  for (const value of values) tokens.push(tokenFor((await vault.add({ value, hint: `hint ${tokens.length}`, source: "user", createdBy: "user" })).fragment));
  return { vault, tokens };
}

test("the matcher finds every pattern, leftmost and longest, without overlaps", () => {
  const m = new Matcher([
    { text: "he", ref: "he" },
    { text: "she", ref: "she" },
    { text: "hers", ref: "hers" },
    { text: "his", ref: "his" },
  ]);
  assert.deepEqual(m.find("ushers").map((x) => x.ref), ["she"]);
  assert.deepEqual(m.find("ahishers").map((x) => [x.ref, x.start]), [["his", 1], ["hers", 4]]);
  // A shorter pattern after an overlapped longer one is still found (a value must never slip through).
  const n = new Matcher([{ text: "abcde", ref: 1 }, { text: "defg", ref: 2 }, { text: "fg", ref: 3 }]);
  assert.deepEqual(n.find("abcdefg").map((x) => x.ref), [1, 3]);
  assert.deepEqual(new Matcher<number>([]).find("anything"), []);
});

test("redact swaps values for tokens, restore swaps them back, and redacting twice changes nothing", async () => {
  const { vault, tokens } = await vaultWith("hunter2-password", "sk-live-abcdef123456");
  const text = "<p>db: hunter2-password, key sk-live-abcdef123456.</p>";
  const redacted = vault.redact(text);
  assert.equal(redacted, `<p>db: ${tokens[0]}, key ${tokens[1]}.</p>`);
  assert.equal(vault.redact(redacted), redacted);
  assert.equal(vault.restore(redacted), text);
  const deep = vault.redactDeep({ cards: [{ title: "x", description: "use hunter2-password" }], n: 3 });
  assert.deepEqual(deep, { cards: [{ title: "x", description: `use ${tokens[0]}` }], n: 3 });
  assert.deepEqual(vault.restoreDeep(deep), { cards: [{ title: "x", description: "use hunter2-password" }], n: 3 });
});

test("an unknown, edited or cut-short token is refused instead of saved", async () => {
  const { vault, tokens } = await vaultWith("hunter2-password");
  const id = /⟦p:(\w+)/.exec(tokens[0])![1];
  assert.throws(() => vault.restore("x ⟦p:ffffffffff guess⟧"), VaultTokenError);
  assert.throws(() => vault.restore(`x ⟦p:${id} other hint⟧`), /was changed/);
  assert.throws(() => vault.restore(`x ${tokens[0].slice(0, -3)}`), /cut short/);
  assert.equal(vault.restore("no tokens here"), "no tokens here");
  // An empty vault still refuses tokens rather than saving them as text.
  assert.throws(() => new Vault().restoreDeep({ html: "⟦p:abc x⟧" }), VaultTokenError);
});

test("adds dedupe values, keep hints free of values, and check what agents may protect", async () => {
  const vault = new Vault();
  const first = await vault.add({ value: "hunter2-password", hint: "db", source: "agent", createdBy: "Opus" });
  const again = await vault.add({ value: "hunter2-password", hint: "other", source: "agent", createdBy: "Opus" });
  assert.equal(again.existed, true);
  assert.equal(again.fragment.id, first.fragment.id);
  await assert.rejects(vault.add({ value: "zzz-another", hint: "has hunter2-password in it", source: "user", createdBy: "user" }), /hint/);
  await assert.rejects(vault.add({ value: "a⟦b", source: "user", createdBy: "user" }), /⟦/);
  assert.equal("value" in vault.list()[0], false);
  assert.match(agentValueProblem("the")!, /at least/);
  assert.match(agentValueProblem("function")!, /common word/);
  assert.match(agentValueProblem("------")!, /letters or digits/);
  assert.equal(agentValueProblem("hunter2-password"), null);
});

test("values are sealed at rest and open again with the recorded key", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-vault-"));
  try {
    const store = memoryStore();
    const vault = await Vault.open(root, store, { platform: "linux", stores: ["file"] });
    await vault.add({ value: "hunter2-password", hint: "db", source: "user", createdBy: "user" });
    assert.equal(JSON.stringify(store.rows).includes("hunter2"), false);
    const reopened = await Vault.open(root, store, { platform: "linux", stores: ["file"] });
    assert.equal(reopened.redact("pw hunter2-password"), `pw ${tokenFor(reopened.list()[0])}`);
    // A lost key fails loudly; the daemon then refuses agents instead of showing values.
    fs.rmSync(path.join(root, "master.key"));
    await assert.rejects(Vault.open(root, store, { platform: "linux", stores: ["file"] }), /not available/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("search can't be used as an oracle: values are out of the words and semantic indexes", async () => {
  const { vault } = await vaultWith("hunter2-password");
  setVault(vault);
  try {
    const tab = { id: "t_1", key: "scribe:creds", title: "Creds", html: "<p>The staging login is hunter2-password for now, rotate it soon please.</p>", state: {}, revision: 1, stateRevision: 1, updatedAt: 1 } as unknown as Tab;
    assert.equal(searchLibrary([tab], "hunter2", 0, 10).matchCount, 0);
    assert.equal(searchLibrary([tab], "hunter2-password", 0, 10).matchCount, 0);
    const hit = searchLibrary([tab], "staging", 0, 10).hits[0];
    assert.ok(hit);
    assert.doesNotMatch(hit.snippet ?? "", /hunter2/);
    assert.equal(chunkPage(tab).some((chunk) => chunk.text.includes("hunter2") || chunk.snippet.includes("hunter2")), false);
    // A value added later drops out of cached text too.
    await vault.add({ value: "rotate it soon", source: "user", createdBy: "user" });
    assert.equal(searchLibrary([tab], "rotate", 0, 10).matchCount, 0);
  } finally {
    setVault(new Vault());
  }
});

test("redaction with ~5k fragments stays fast", async () => {
  const vault = new Vault();
  for (let i = 0; i < 5000; i += 1) await vault.add({ value: `secret-${i.toString(36)}-${(i * 7919).toString(36)}x`, source: "user", createdBy: "user" });
  const words = Array.from({ length: 40000 }, (_, i) => (i % 997 === 0 ? `secret-${(i % 5000).toString(36)}-${((i % 5000) * 7919).toString(36)}x` : `word${i % 113}`));
  const text = words.join(" ");
  const started = performance.now();
  const out = vault.redact(text);
  const took = performance.now() - started;
  assert.doesNotMatch(out, /secret-/);
  assert.ok(took < 500, `redacting ${text.length} characters took ${took.toFixed(0)} ms`);
});
