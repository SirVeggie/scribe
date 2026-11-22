import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { RunSink, TurnInput, TurnResult } from "./providers/provider.js";
import type { Item, Thread } from "./types.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-session-lost-"));
process.env.SCRIBE_HOME = dir;
process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude-default");
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;
const runs: Array<{ nativeId: string | null; text: string }> = [];

before(() => {
  store.load();
  host = new AgentHost(() => {});
  (host as unknown as { providers: Record<string, unknown> }).providers.claude = {
    id: "claude",
    label: "Claude",
    status: async () => ({ id: "claude", label: "Claude", available: true, logout: true }),
    models: async () => [],
    complete: async () => "",
    prewarm: () => {},
    dispose: () => {},
    signedIn: () => true,
    fetchPlanUsage: async () => null,
    createSession: (created: Thread) => {
      let thread = created;
      return {
        warm: async () => {},
        update: (t: Thread) => { thread = t; },
        commands: async () => [],
        dispose: () => {},
        cancel: async () => {},
        run: async (input: TurnInput, sink: RunSink): Promise<TurnResult> => {
          runs.push({ nativeId: thread.nativeId, text: input.text });
          // Claude Code cannot find the transcript of the session it is asked to resume.
          if (thread.nativeId === "s1" && runs.length > 1) {
            return { status: "error", error: "No conversation found with session ID: s1", sessionLost: true };
          }
          sink.nativeId(runs.length === 1 ? "s1" : "s2");
          sink.text(`reply ${runs.length}`);
          return { status: "done" };
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
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "timed out");
}

const view = (id: string) => host.listThreads().find((t) => t.id === id)!;
const items = (id: string) => (host as unknown as { loadItems(id: string): Item[] }).loadItems(id);

test("a turn whose session is gone starts a new one with a recap instead of failing", async () => {
  const thread = host.createThread({ provider: "claude", approval: "full", cwd: dir, scope: { kind: "global", ref: null } });
  host.send(thread.id, { text: "first question" });
  await until(() => view(thread.id).status === "idle" && runs.length === 1);

  host.send(thread.id, { text: "go on" });
  await until(() => view(thread.id).status === "idle" && runs.length === 3);

  assert.equal(runs[1].nativeId, "s1");
  assert.equal(runs[2].nativeId, null, "the retry starts a new session");
  assert.match(runs[2].text, /earlier_conversation[\s\S]*first question[\s\S]*reply 1/);
  assert.match(runs[2].text, /go on/);
  assert.ok(items(thread.id).some((it) => it.kind === "notice" && /could not be found/.test(it.text)));
  assert.ok(!items(thread.id).some((it) => it.kind === "notice" && it.level === "error"), "no error shows");
});
