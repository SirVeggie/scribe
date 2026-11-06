import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_WEB_ALLOWLIST } from "../agent/webAccess.js";
import { categoryFlows, emptyState, mergeBody, outgoingBody, stampExtras, switchKey, type SyncCategory, type SyncState } from "./settingsSync.js";
import { applyAllowlists, applySources, describeExtra, snapshotAllowlists, snapshotSources, validExtra, type SourceLists } from "./syncExtras.js";
import { listOffers, mcpInventory, newOffers, emptyOffers } from "./syncOffers.js";

const A = { id: "aaa", name: "Laptop" };
const B = { id: "bbb", name: "Desktop" };

const lists = (partial: Partial<SourceLists> = {}): SourceLists => ({ model: [], ml: [], stt: [], tts: [], ...partial });
const openrouter = { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-1234", models: [] };
const lmstudio = { id: "lmstudio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", models: [] };

/** A device: its sync state and its source lists, joined to a group. */
type Device = { self: string; state: SyncState; lists: SourceLists };

function device(self: string, sourceLists: SourceLists, on: SyncCategory[] = []): Device {
  let state: SyncState = { ...emptyState(), joined: true };
  for (const [i, category] of on.entries()) state.records[switchKey(category)] = { v: "1", n: i + 1, d: self };
  state.n = on.length;
  state = stampExtras(state, self, snapshotSources(sourceLists));
  return { self, state, lists: sourceLists };
}

/** One way: `from` sends, `to` merges and applies what changed, then records its own lists again. */
function send(from: Device, to: Device) {
  const body = outgoingBody(from.state, false);
  const result = mergeBody(to.state, body, to.self, { id: from.self, name: from.self });
  to.state = result.state;
  const patch = Object.fromEntries(result.changed.filter((k) => !k.startsWith("sync:")).map((k) => [k, to.state.records[k].v]));
  const keysFlow = categoryFlows(to.state, "keys");
  applySources(to.lists, patch, (kind, id) => (keysFlow ? to.state.records[`srckey:${kind}:${id}`]?.v : undefined));
  to.state = stampExtras(to.state, to.self, snapshotSources(to.lists));
  return result.changed;
}

test("sources are opt-in, and a loopback source never leaves the device", () => {
  const a = device(A.id, lists({ model: [openrouter, lmstudio] }));
  const b = device(B.id, lists());
  assert.deepEqual(send(a, b), []);
  assert.equal(b.lists.model.length, 0);
  assert.equal(Object.keys(a.state.records).some((k) => k.includes("lmstudio")), false);
  assert.equal(validExtra("src:model:lmstudio", JSON.stringify(lmstudio)), false);
});

test("with Sources on, the endpoint syncs without its key unless Include keys is on too", () => {
  const a = device(A.id, lists({ model: [openrouter] }), ["sources"]);
  const b = device(B.id, lists(), ["sources"]);
  send(a, b);
  assert.equal(b.lists.model.length, 1);
  assert.equal(b.lists.model[0].baseUrl, openrouter.baseUrl);
  assert.equal(b.lists.model[0].apiKey, undefined);
  // B's missing key is not stamped as "no key", so it can't clear A's later.
  assert.equal(b.state.records["srckey:model:openrouter"], undefined);

  const a2 = device(A.id, lists({ model: [openrouter] }), ["sources", "keys"]);
  const b2 = device(B.id, lists(), ["sources", "keys"]);
  send(a2, b2);
  assert.equal(b2.lists.model[0].apiKey, "sk-or-1234");
  // The second exchange back changes nothing: what B applied is what B now records.
  assert.deepEqual(send(b2, a2), []);
});

test("a source removed on one device is removed on the others, and a local source with the same id stays", () => {
  const a = device(A.id, lists({ model: [openrouter] }), ["sources"]);
  const b = device(B.id, lists(), ["sources"]);
  send(a, b);
  a.lists.model = [];
  a.state = stampExtras(a.state, A.id, snapshotSources(a.lists));
  send(a, b);
  assert.equal(b.lists.model.length, 0);

  const c = device(B.id, lists({ model: [{ ...lmstudio, id: "openrouter" }] }), ["sources"]);
  const a3 = device(A.id, lists({ model: [openrouter] }), ["sources"]);
  send(a3, c);
  assert.equal(c.lists.model[0].baseUrl, lmstudio.baseUrl);
});

test("a speech source on a loopback model source stays local; a custom key is split out", () => {
  const stt = { id: "s1", name: "Whisper", source: "lmstudio", model: "whisper-1", language: "" };
  const custom = { id: "s2", name: "Groq", source: "__custom__", model: "whisper-large-v3", language: "", custom: { baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk-9999" } };
  const snap = snapshotSources(lists({ model: [lmstudio], stt: [stt, custom] }));
  assert.equal(snap.local.has("src:stt:s1"), true);
  assert.equal(JSON.parse(snap.values["src:stt:s2"]).custom.apiKey, undefined);
  assert.equal(snap.values["srckey:stt:s2"], "gsk-9999");
});

test("allowlists merge entry by entry; the starting web list needs no records", () => {
  const snap = snapshotAllowlists({ web: [...DEFAULT_WEB_ALLOWLIST, "example.org"], cmd: ["npm test"] });
  const stamped = stampExtras(emptyState(), A.id, snap);
  assert.deepEqual(Object.keys(stamped.records).sort(), ["allow:cmd:npm test", "allow:web:example.org"]);
  // Removing a starting entry is a change of its own.
  const removed = stampExtras(stamped, A.id, snapshotAllowlists({ web: DEFAULT_WEB_ALLOWLIST.slice(1), cmd: ["npm test"] }));
  assert.equal(removed.records[`allow:web:${DEFAULT_WEB_ALLOWLIST[0]}`].v, "");

  const here = { web: ["github.com"], cmd: ["git status"] };
  assert.deepEqual(applyAllowlists(here, { "allow:web:example.org": "1", "allow:cmd:git status": "" }).sort(), ["cmd", "web"]);
  assert.deepEqual(here, { web: ["github.com", "example.org"], cmd: [] });
});

test("Choose setup shows names and endpoints, never a key", () => {
  const row = describeExtra("srckey:model:openrouter", "sk-or-1234", "sk-or-5678");
  assert.equal(row.mine.includes("sk-or"), false);
  assert.equal(row.mine, "Key …1234");
  const source = describeExtra("src:model:openrouter", JSON.stringify(openrouter), "");
  assert.equal(source.label, "Model source: OpenRouter");
  assert.equal(source.theirs, "Removed");
});

test("offers: servers without secrets or folders, only what this device lacks, one notice each", () => {
  const offered = mcpInventory({
    github: { command: "npx", args: ["-y", "github-mcp"], env: { GITHUB_TOKEN: "ghp_secret", HOME_DIR: "${HOME}" }, cwd: "C:\\work" },
    keeper: { url: "http://127.0.0.1:7777/mcp" },
  }, false);
  assert.deepEqual(offered[0].server.env, { HOME_DIR: "${HOME}" });
  assert.deepEqual(offered[0].withheld, ["GITHUB_TOKEN"]);
  assert.equal(offered[0].server.cwd, undefined);
  assert.equal(mcpInventory({ github: { command: "npx", env: { T: "x" } } }, true)[0].server.env?.T, "x");

  const state = { ...emptyOffers(), devices: { [A.id]: { name: A.name, at: 1, inventory: { mcp: offered, plugins: [{ id: "git-history", name: "Git history", version: "1.3.0" }, { id: "jira", name: "Jira", version: "0.2.0" }] } } } };
  const has = (kind: string, id: string) => kind === "mcp" && id === "keeper";
  const offers = listOffers({ ...state, dismissed: ["plugin:jira"] }, has, (id) => (id === A.id ? A.name : undefined));
  assert.deepEqual(offers.map((o) => `${o.kind}:${o.id}`), ["mcp:github", "plugin:git-history"]);
  // A device no longer paired offers nothing.
  assert.equal(listOffers(state, has, () => undefined).length, 0);

  const first = newOffers(state, offers);
  assert.deepEqual(first.notices, [{ from: { id: A.id, name: A.name }, mcp: 1, plugins: 1 }]);
  assert.deepEqual(newOffers(first.state, offers).notices, []);
});
