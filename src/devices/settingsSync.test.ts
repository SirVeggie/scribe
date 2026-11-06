import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyState, groupOn, mergeBody, outgoingBody, resolvePending, stampLocal, switchKey, type SyncState } from "./settingsSync.js";

const A = { id: "aaa", name: "Laptop" };
const B = { id: "bbb", name: "Desktop" };
const C = { id: "ccc", name: "Server" };

/** One exchange as SettingsSync does it: `from` sends, `to` merges and answers, `from` merges the answer. */
function exchange(states: Record<string, SyncState>, from: typeof A, to: typeof A, relay: string[] = []) {
  const sent = outgoingBody(states[from.id], relay.includes(from.id));
  const there = mergeBody(states[to.id], sent, to.id, from, { relay: relay.includes(to.id) });
  states[to.id] = there.state;
  const reply = outgoingBody(states[to.id], relay.includes(to.id));
  const here = mergeBody(states[from.id], reply, from.id, to, { relay: relay.includes(from.id) });
  states[from.id] = here.state;
  return { changedThere: there.changed, changedHere: here.changed };
}

const set = (state: SyncState, self: string, values: Record<string, string>) => stampLocal(state, self, values, Object.keys(values));

test("first join: a set value beats a default, and only differing set values wait for the user", () => {
  const states: Record<string, SyncState> = {
    aaa: set(emptyState(), A.id, { "scribe.theme": "dusk", "scribe.linkMode": "peek", "scribe.agent.sendKey": "mod" }),
    bbb: set(emptyState(), B.id, { "scribe.theme": "garnet", "scribe.linkMode": "peek", "scribe.smoothScroll": "0" }),
  };
  const result = exchange(states, A, B);
  // B took A's send key (its own was a default); A took B's smooth scrolling.
  assert.deepEqual(result.changedThere, ["scribe.agent.sendKey"]);
  assert.deepEqual(result.changedHere, ["scribe.smoothScroll"]);
  // Exactly one side asks: the theme differs.
  const asking = [states.aaa, states.bbb].filter((s) => s.pending);
  assert.equal(asking.length, 1);
  assert.deepEqual(asking[0].pending!.rows.map((r) => r.key), ["scribe.theme"]);
  assert.equal(asking[0] === states.bbb ? states.aaa.joined : states.bbb.joined, true);
});

test("choosing settles both sides; after that the newest change wins", () => {
  const states: Record<string, SyncState> = {
    aaa: set(emptyState(), A.id, { "scribe.theme": "dusk" }),
    bbb: set(emptyState(), B.id, { "scribe.theme": "garnet" }),
  };
  exchange(states, A, B);
  const askerId = states.aaa.pending ? A.id : B.id;
  const other = askerId === A.id ? B : A;
  const asker = askerId === A.id ? A : B;
  // Keep this device's theme: it is stamped newer, and the group takes it.
  const resolved = resolvePending(states[askerId], askerId, { "scribe.theme": "mine" });
  states[askerId] = resolved.state;
  const mine = states[askerId].records["scribe.theme"].v;
  const result = exchange(states, asker, other);
  assert.deepEqual(result.changedThere, ["scribe.theme"]);
  assert.equal(states[other.id].records["scribe.theme"].v, mine);
  assert.equal(states.aaa.pending, null);
  assert.equal(states.bbb.pending, null);
  // Later changes: newest wins on both.
  states[other.id] = set(states[other.id], other.id, { "scribe.theme": "cream" });
  exchange(states, other, asker);
  assert.equal(states[askerId].records["scribe.theme"].v, "cream");
});

test("a newcomer is compared against the group, which keeps its value until the newcomer chooses", () => {
  const states: Record<string, SyncState> = {
    aaa: { ...set(emptyState(), A.id, { "scribe.theme": "dusk" }), joined: true },
    ccc: set(emptyState(), C.id, { "scribe.theme": "ember" }),
  };
  exchange(states, C, A);
  assert.equal(states.aaa.records["scribe.theme"].v, "dusk");
  assert.equal(states.ccc.pending?.from.id, A.id);
  states.ccc = resolvePending(states.ccc, C.id, { "scribe.theme": "theirs" }).state;
  assert.equal(states.ccc.records["scribe.theme"].v, "dusk");
  assert.equal(states.ccc.joined, true);
});

test("logical clocks: a higher counter wins regardless of which device sends", () => {
  const states: Record<string, SyncState> = {
    aaa: { ...emptyState(), joined: true },
    bbb: { ...emptyState(), joined: true },
  };
  states.aaa = set(states.aaa, A.id, { "scribe.linkMode": "split" });
  exchange(states, A, B);
  states.bbb = set(states.bbb, B.id, { "scribe.linkMode": "tab" });
  // A's stale copy does not undo B's newer change.
  exchange(states, A, B);
  assert.equal(states.aaa.records["scribe.linkMode"].v, "tab");
  assert.ok(states.bbb.records["scribe.linkMode"].n > 1);
});

test("a headless relay stores and passes on, so devices that are never on together still sync", () => {
  const states: Record<string, SyncState> = {
    aaa: { ...set(emptyState(), A.id, { "scribe.theme": "dusk" }), joined: true },
    bbb: { ...emptyState(), joined: true },
    ccc: emptyState(),
  };
  const relay = [C.id];
  exchange(states, A, C, relay);
  assert.equal(states.ccc.records["scribe.theme"].v, "dusk");
  exchange(states, B, C, relay);
  assert.equal(states.bbb.records["scribe.theme"].v, "dusk");
});

test("a category switched off stops for the group; keeping its own stops one device", () => {
  const states: Record<string, SyncState> = {
    aaa: { ...set(emptyState(), A.id, { "scribe.agent.sendKey": "mod", "scribe.theme": "dusk" }), joined: true },
    bbb: { ...emptyState(), joined: true },
  };
  states.aaa = { ...states.aaa, n: states.aaa.n + 1, records: { ...states.aaa.records, [switchKey("chat")]: { v: "0", n: states.aaa.n + 1, d: A.id } } };
  exchange(states, A, B);
  assert.equal(groupOn(states.bbb, "chat"), false);
  assert.equal(states.bbb.records["scribe.agent.sendKey"], undefined);
  assert.equal(states.bbb.records["scribe.theme"].v, "dusk");
  states.bbb = { ...states.bbb, keepOwn: ["appearance"] };
  states.aaa = set(states.aaa, A.id, { "scribe.theme": "ember" });
  exchange(states, A, B);
  assert.equal(states.bbb.records["scribe.theme"].v, "dusk");
  assert.equal(groupOn(states.bbb, "memories", false), false);
});

test("records with unknown keys or invalid values are dropped", () => {
  const result = mergeBody(emptyState(), { joined: true, settled: [], records: { "scribe.viewerId": { v: "x", n: 1, d: A.id }, "scribe.theme": { v: "<script>", n: 2, d: A.id } } }, B.id, A);
  assert.deepEqual(result.state.records, {});
});
