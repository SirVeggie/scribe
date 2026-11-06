import assert from "node:assert/strict";
import { test } from "node:test";
import { Detectors, SUGGEST_OFF_MIN_MATCHES, patternProblem, type DetectorRecord, type DetectorStore } from "./detectors.js";
import { Vault } from "./vault.js";
import { maskSample, sampleMatches } from "./vaultHttp.js";

// Made-up values in each format (#1047). Built at run time so this file doesn't trip secret scanners.
const rand = (n: number, chars = "aZ3kQ9xW7mB2vN5pL8rT4yH6cJ1dF0gS") => Array.from({ length: n }, (_, i) => chars[(i * 7 + n) % chars.length]).join("");
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const SAMPLES: Record<string, string> = {
  anthropic: `sk-ant-api03-${rand(90)}`,
  openai: `sk-proj-${rand(48)}`,
  github: `ghp_${rand(36)}`,
  aws: `AKIA${"IOSFODNN7EXAMPL0".toUpperCase()}`,
  slack: `xoxb-1234567890-${rand(24)}`,
  google: `AIza${rand(35)}`,
  stripe: `sk_live_${rand(30)}`,
  pem: `-----BEGIN RSA PRIVATE KEY-----\n${rand(64)}\n${rand(64)}\n-----END RSA PRIVATE KEY-----`,
  jwt: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "1234567890", name: "Test" })}.${rand(43)}`,
};

function memoryStore(): DetectorStore & { records: Map<string, DetectorRecord>; hashes: Set<string> } {
  const records = new Map<string, DetectorRecord>();
  const hashes = new Set<string>();
  return {
    records,
    hashes,
    list: () => [...records.values()].map((r) => structuredClone(r)),
    save: (r) => void records.set(r.id, structuredClone(r)),
    remove: (id) => void records.delete(id),
    unflagged: () => [...hashes],
    addUnflagged: (hash) => void hashes.add(hash),
  };
}

test("built-in detectors find each format in surrounding text, and only that", () => {
  const detectors = new Detectors();
  for (const [id, value] of Object.entries(SAMPLES)) {
    const found = detectors.scan(`config: "${value}" (rotate)`);
    assert.deepEqual(found.map((m) => [m.detector.id, m.value]), [[id, value]], id);
  }
  const near = [
    "sk-ant-short",
    `ghp_${rand(20)}`,
    `xghp_${rand(36)}`,
    "AKIAlowercase0000000",
    // Three base64url parts whose header isn't JSON with alg.
    `eyJub3RqcG9u${rand(10)}.eyJzdWIiOiIxIn0${rand(4)}.${rand(30)}`,
    "the quick brown fox jumps over 040-19538242 or someone@example.org",
  ];
  for (const text of near) assert.deepEqual(detectors.scan(text), [], text);
});

test("phone and email detectors are opt-in", () => {
  const detectors = new Detectors();
  const text = "call +358 40 1953 8242 or mail someone@example.org";
  assert.deepEqual(detectors.scan(text), []);
  detectors.setEnabled("phone", true, "user");
  detectors.setEnabled("email", true, "user");
  assert.deepEqual(detectors.scan(text).map((m) => m.detector.id).sort(), ["email", "phone"]);
});

test("a detected value is protected as soon as it is redacted, and unflagging leaves it alone and counts", () => {
  const store = memoryStore();
  const vault = new Vault(undefined, undefined, new Detectors(store));
  const page = `token ${SAMPLES.github} here`;
  const shown = vault.redact(page);
  assert.match(shown, /^token ⟦p:[0-9a-f]+ GitHub token⟧ here$/);
  assert.equal(vault.redact(shown), shown, "redacting twice changes nothing");
  assert.equal(vault.restore(shown), page, "the token restores the value");
  const [fragment] = vault.list();
  assert.equal(fragment.source, "detector");
  assert.equal(fragment.detector, "github");
  assert.equal(vault.detectors.get("github")!.matches, 1);

  assert.equal(vault.remove(fragment.id), true);
  assert.equal(vault.redact(page), page, "an unflagged value is not detected again");
  const github = vault.detectors.get("github")!;
  assert.equal(github.unflags, 1);
  assert.equal(github.falseFlagRate, 1);
  assert.equal(store.hashes.size, 1);
  assert.ok(![...store.hashes][0].includes(SAMPLES.github.slice(4)), "only a hash is kept");

  // The counts and the unflagged value survive a restart.
  const again = new Vault(undefined, undefined, new Detectors(store));
  assert.equal(again.redact(page), page);
  assert.equal(again.detectors.get("github")!.unflags, 1);
});

test("a user-protected value that a detector would match stays alone after the user removes it", async () => {
  const vault = new Vault(undefined, undefined, new Detectors());
  const { fragment } = await vault.add({ value: SAMPLES.aws, hint: "ci key", source: "user", createdBy: "user" });
  vault.remove(fragment.id);
  assert.equal(vault.redact(`key ${SAMPLES.aws}`), `key ${SAMPLES.aws}`);
  assert.equal(vault.detectors.get("aws")!.unflags, 0, "only detector fragments count as false flags");
});

test("streaming text waits for a value at its very end", () => {
  const vault = new Vault(undefined, undefined, new Detectors());
  assert.equal(vault.detect(`here: ${SAMPLES.github.slice(0, 30)}`, { partial: true }), 0);
  assert.equal(vault.detect(`here: ${SAMPLES.github}`, { partial: true }), 0);
  assert.equal(vault.detect(`here: ${SAMPLES.github}.`, { partial: true, thread: "th_1" }), 1);
  assert.equal(vault.list()[0].createdThread, "th_1");
});

test("detectDeep looks in every string of an item or a page's state", () => {
  const vault = new Vault(undefined, undefined, new Detectors());
  assert.equal(vault.detectDeep({ cards: [{ title: "x", comments: [{ text: `use ${SAMPLES.stripe}` }] }], other: SAMPLES.slack }), 2);
  assert.equal(vault.detectDeep({ again: SAMPLES.slack }), 0, "a known value is not added twice");
});

test("a detector unflagged often is suggested for turning off", () => {
  const store = memoryStore();
  const vault = new Vault(undefined, undefined, new Detectors(store));
  const keys = Array.from({ length: SUGGEST_OFF_MIN_MATCHES }, (_, i) => `AKIA${String(i).padStart(16, "Q")}`);
  vault.redact(keys.join(" "));
  assert.equal(vault.detectors.get("aws")!.matches, SUGGEST_OFF_MIN_MATCHES);
  assert.equal(vault.detectors.get("aws")!.suggestOff, false);
  for (const fragment of vault.list().slice(0, 2)) vault.remove(fragment.id);
  assert.equal(vault.detectors.get("aws")!.suggestOff, true);
  vault.detectors.setEnabled("aws", false, "user");
  assert.equal(vault.detectors.get("aws")!.suggestOff, false, "not once it is off");
  assert.deepEqual(vault.detectors.get("aws")!.history.map((h) => [h.by, h.change]), [["user", "turned off"]]);
});

test("custom detectors: patterns are checked, built-ins only switch, changes record who made them", () => {
  assert.match(patternProblem("(a+)+b")!, /nested quantifier/);
  assert.match(patternProblem("a*")!, /empty/);
  assert.match(patternProblem("([")!, /compile/);
  assert.match(patternProblem("abc", "g")!, /flags/);
  assert.equal(patternProblem("tw_[A-Za-z0-9]{32}"), null);

  const store = memoryStore();
  const detectors = new Detectors(store);
  assert.throws(() => detectors.put({ id: "github", label: "x", hint: "x", kind: "x", pattern: "x{9}" }, "agent"), /built-in/);
  const made = detectors.put({ id: "twilio", label: "Twilio key", hint: "", kind: "api key", pattern: "tw_[A-Za-z0-9]{32}" }, "Opus (approved by the user)");
  assert.equal(made.hint, "Twilio key");
  assert.equal(made.enabled, true);
  const key = `tw_${rand(32)}`;
  assert.deepEqual(detectors.scan(`a ${key} b`).map((m) => m.detector.id), ["twilio"]);
  assert.equal(new Detectors(store).get("twilio")!.history[0].by, "Opus (approved by the user)");
  assert.equal(detectors.remove("twilio"), true);
  assert.equal(detectors.remove("github"), false);
  assert.deepEqual(detectors.scan(`a ${key} b`), []);
});

test("proposal samples are masked and counted per page", () => {
  const pages = [
    { id: "a", title: "Keys", html: `<p>${SAMPLES.github}</p>`, state: { x: SAMPLES.github } },
    { id: "b", title: "Notes", html: "<p>nothing</p>", state: {} },
  ] as never[];
  const found = sampleMatches("ghp_[A-Za-z0-9]{36}", undefined, pages);
  assert.equal(found.values, 1);
  assert.equal(found.pages, 1);
  assert.equal(found.samples[0].page, "Keys");
  assert.ok(!found.samples[0].text.includes(SAMPLES.github.slice(8, 30)), "the middle is hidden");
  assert.equal(maskSample("abcdefghijklmnop"), "abcdef…nop (16 chars)");
});
