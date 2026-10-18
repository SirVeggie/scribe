import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { TurnInput as RunInput, SteerInput, TurnResult } from "./providers/provider.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-queued-edit-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
let host: InstanceType<typeof AgentHost>;
// Memory makes a Native turn look up its model first; these tests time turns by the tick.
before(() => { store.load(); host = new AgentHost(() => {}); host.setPrefs({ memory: false }); });
after(() => { host.dispose(); store.closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const users = (id: string) => host.threadDetail(id)!.items.filter((it) => it.kind === "user");

function setup(withdraw: () => Promise<boolean> = async () => true) {
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null } });
  const inputs: RunInput[] = [];
  const results: Array<(result: TurnResult) => void> = [];
  const steers: SteerInput[] = [];
  const session = {
    update() {}, dispose() {},
    run(input: RunInput) { inputs.push(input); return new Promise<TurnResult>((resolve) => results.push(resolve)); },
    steer(input: SteerInput) { steers.push(input); return `steer-${steers.length}`; },
    withdrawSteer: withdraw,
  };
  (host as unknown as { sessions: Map<string, unknown> }).sessions.set(thread.id, session);
  host.send(thread.id, { text: "running" });
  return { id: thread.id, inputs, results, steers };
}

test("cancel targets an older message, and targeted steering still attaches to the right item", async () => {
  const f = setup();
  const old = host.send(f.id, { text: "old" }).item;
  const middle = host.send(f.id, { text: "middle" }).item;
  const newest = host.send(f.id, { text: "newest" }).item;
  assert.equal((await host.withdraw(f.id, old.id)).text, "old");
  assert.ok(!users(f.id).some((it) => it.id === old.id));
  await host.steer(f.id, newest.id);
  assert.equal(users(f.id).find((it) => it.id === newest.id)?.steer, "waiting");
  assert.equal(users(f.id).find((it) => it.id === middle.id)?.steer, undefined);
  assert.equal((await host.withdraw(f.id)).text, "middle");
  assert.equal((await host.withdraw(f.id)).text, "newest");
});

test("editing the queue head holds subsequent sends after turn completion and saves in place", async () => {
  const f = setup();
  const edited = host.send(f.id, { text: "original", context: [{ kind: "page", id: "t_missing", key: "scribe:missing", title: "Context" }] }).item;
  const second = host.send(f.id, { text: "second" }).item;
  const { token } = await host.beginQueuedEdit(f.id, edited.id);
  await assert.rejects(host.steer(f.id, second.id), /Finish editing/);
  f.results[0]({ status: "done" });
  await tick();
  assert.equal(f.inputs.length, 1);
  assert.equal(host.send(f.id, { text: "third" }).queued, true);
  assert.equal(f.inputs.length, 1);
  host.finishQueuedEdit(f.id, edited.id, token, "revised");
  assert.match(f.inputs[1].text, /revised/);
  const item = users(f.id).find((it) => it.id === edited.id)!;
  assert.equal(item.text, "revised");
  assert.equal(item.editing, undefined);
  const context = item.context?.[0];
  assert.ok(context?.kind === "page");
  assert.equal(context.id, "t_missing");
  f.results[1]({ status: "done" });
  await tick();
  assert.match(f.inputs[2].text, /second/);
});

test("an edited later message keeps its place and Cancel restores the original", async () => {
  const f = setup();
  host.send(f.id, { text: "first" });
  const edited = host.send(f.id, { text: "original second" }).item;
  const { token } = await host.beginQueuedEdit(f.id, edited.id);
  f.results[0]({ status: "done" });
  await tick();
  assert.match(f.inputs[1].text, /first/);
  f.results[1]({ status: "done" });
  await tick();
  assert.equal(f.inputs.length, 2);
  host.finishQueuedEdit(f.id, edited.id, token);
  assert.match(f.inputs[2].text, /original second/);
});

test("a waiting steer is withdrawn for editing and restored with its revised text", async () => {
  const f = setup();
  const edited = host.send(f.id, { text: "old steer" }).item;
  await host.steer(f.id, edited.id);
  const { token } = await host.beginQueuedEdit(f.id, edited.id);
  assert.equal(f.steers.length, 1);
  assert.equal(users(f.id).find((it) => it.id === edited.id)?.editing, true);
  await assert.rejects(host.steer(f.id, edited.id), /Finish editing/);
  host.finishQueuedEdit(f.id, edited.id, token, "new steer");
  assert.equal(f.steers.length, 2);
  assert.match(f.steers[1].text, /new steer/);
});

test("provider refusal leaves the pending steer intact", async () => {
  const f = setup(async () => false);
  const edited = host.send(f.id, { text: "pending" }).item;
  await host.steer(f.id, edited.id);
  await assert.rejects(host.beginQueuedEdit(f.id, edited.id), /handed to the agent/);
  assert.equal(users(f.id).find((it) => it.id === edited.id)?.steer, "waiting");
  assert.equal(users(f.id).find((it) => it.id === edited.id)?.editing, undefined);
});

test("turn completion waits for a steer withdrawal before adopting the next turn", async () => {
  let resolveWithdrawal!: (ok: boolean) => void;
  const f = setup(() => new Promise<boolean>((resolve) => { resolveWithdrawal = resolve; }));
  const edited = host.send(f.id, { text: "pending" }).item;
  await host.steer(f.id, edited.id);
  const editing = host.beginQueuedEdit(f.id, edited.id);
  f.results[0]({ status: "done", next: "steer-1" });
  await tick();
  assert.equal(f.inputs.length, 1);
  resolveWithdrawal(true);
  const { token } = await editing;
  await tick();
  assert.equal(f.inputs.length, 1);
  host.finishQueuedEdit(f.id, edited.id, token, "completed edit");
  assert.match(f.inputs[1].text, /completed edit/);
});

test("reopening an edit invalidates stale popup tokens and blank saves keep the hold", async () => {
  const f = setup();
  const edited = host.send(f.id, { text: "original" }).item;
  const first = await host.beginQueuedEdit(f.id, edited.id);
  const recovered = await host.beginQueuedEdit(f.id, edited.id, true);
  assert.throws(() => host.finishQueuedEdit(f.id, edited.id, first.token), /no longer active/);
  assert.throws(() => host.finishQueuedEdit(f.id, edited.id, recovered.token, "  "), /Empty message/);
  assert.equal(users(f.id).find((it) => it.id === edited.id)?.editing, true);
  host.finishQueuedEdit(f.id, edited.id, recovered.token);
});

test("popup edits preserve attachments, and withdrawal returns their original bytes", async () => {
  const f = setup();
  const file = { name: "notes.txt", mimeType: "text/plain", data: Buffer.from("attached text").toString("base64") };
  const edited = host.send(f.id, { text: "original", files: [file] }).item;
  const ref = users(f.id).find((it) => it.id === edited.id)!.files![0];
  const { token } = await host.beginQueuedEdit(f.id, edited.id);
  host.finishQueuedEdit(f.id, edited.id, token, "revised");
  assert.deepEqual(users(f.id).find((it) => it.id === edited.id)!.files![0], ref);
  const withdrawn = await host.withdraw(f.id, edited.id);
  assert.equal(withdrawn.text, "revised");
  assert.deepEqual(withdrawn.files, [file]);
});
