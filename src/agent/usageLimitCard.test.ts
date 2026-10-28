import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { RunSink, TurnInput, TurnResult } from "./providers/provider.js";
import type { Item, Thread } from "./types.js";

// The host keeps its data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-limit-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
const { DEFAULT_RESUME_PROMPT } = await import("./pageRuns.js");

let host: InstanceType<typeof AgentHost>;
const runs: Array<{ threadId: string; text: string }> = [];
/** The next turn's result; later turns end done. */
let next: TurnResult | null = null;

before(() => {
  store.load();
  host = new AgentHost(() => {});
  (host as unknown as { providers: Record<string, unknown> }).providers.pi = {
    id: "pi",
    label: "Native",
    status: async () => ({ id: "pi", label: "Native", available: true }),
    models: async () => [],
    complete: async () => "",
    prewarm: () => {},
    dispose: () => {},
    createSession: (created: Thread) => {
      let thread = created;
      return {
        warm: async () => {},
        update: (t: Thread) => { thread = t; },
        commands: async () => [],
        dispose: () => {},
        cancel: async () => {},
        run: async (input: TurnInput, sink: RunSink): Promise<TurnResult> => {
          runs.push({ threadId: thread.id, text: input.text });
          const result = next ?? { status: "done" as const };
          next = null;
          if (result.status === "done") sink.text("ok");
          return result;
        },
      };
    },
  };
});

after(() => {
  host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "timed out");
}

const view = (id: string) => host.listThreads().find((t) => t.id === id)!;
const items = (id: string) => (host as unknown as { loadItems(id: string): Item[] }).loadItems(id);
const card = (id: string) => items(id).find((it): it is Extract<Item, { kind: "usage_limit" }> => it.kind === "usage_limit");
const limitError = (resetsAt: number): TurnResult => ({ status: "error", error: `Claude AI usage limit reached|${Math.floor(resetsAt / 1000)}` });

async function limited(resetsAt: number) {
  const thread = host.createThread({ provider: "pi", approval: "full", cwd: dir, scope: { kind: "global", ref: null } });
  next = limitError(resetsAt);
  host.send(thread.id, { text: "do the thing" });
  await until(() => view(thread.id).status === "idle" && Boolean(card(thread.id)));
  return thread.id;
}

test("a usage limit asks in the thread, and Continue sends it on once the limit has reset", async () => {
  const id = await limited(Date.now() - 5 * 60 * 1000);
  assert.equal(card(id)?.status, "pending");
  assert.equal(view(id).asking?.kind, "limit");
  host.resolveUsageLimit(id, card(id)!.id, true);
  await until(() => runs.filter((r) => r.threadId === id).length === 2 && view(id).status === "idle");
  assert.equal(runs.filter((r) => r.threadId === id)[1].text.includes(DEFAULT_RESUME_PROMPT), true);
  assert.equal(card(id)?.status, "resumed");
  assert.equal(view(id).asking, undefined);
});

test("Continue before the reset waits, and a message the user sends meanwhile retires the card", async () => {
  const id = await limited(Date.now() + 60 * 60 * 1000);
  host.resolveUsageLimit(id, card(id)!.id, true);
  assert.equal(card(id)?.status, "queued");
  assert.equal(runs.filter((r) => r.threadId === id).length, 1);
  host.send(id, { text: "never mind, try this" });
  await until(() => runs.filter((r) => r.threadId === id).length === 2 && view(id).status === "idle");
  assert.equal(card(id)?.status, "expired");
  assert.equal((host as unknown as { limitResumes: Map<string, string> }).limitResumes.has(id), false);
});

test("Dismiss leaves the thread as it is", async () => {
  const id = await limited(Date.now() - 5 * 60 * 1000);
  host.resolveUsageLimit(id, card(id)!.id, false);
  assert.equal(card(id)?.status, "dismissed");
  assert.equal(view(id).asking, undefined);
  assert.throws(() => host.resolveUsageLimit(id, card(id)!.id, true), /no longer waiting/);
});
