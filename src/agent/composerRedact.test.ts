import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { TurnInput } from "./providers/provider.js";
import type { Item, ProviderId, Thread } from "./types.js";

// Protected data in messages (#1048): the transcript keeps what was written, the provider reads tokens.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-composer-redact-"));
process.env.SCRIBE_HOME = dir;
process.env.SCRIBE_FAKE_AGENTS = "1";
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
const { Vault, setVault, tokenFor } = await import("../vault.js");

type Internals = { fakes: Record<string, unknown>; runs: Map<string, unknown>; queues: Map<string, unknown[]>; loadItems(threadId: string): Item[] };

let host: InstanceType<typeof AgentHost>;
const inputs: TurnInput[] = [];
const internals = () => host as unknown as Internals;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send, then what the provider got for it once the turn is over. */
async function sent(id: string, input: Parameters<InstanceType<typeof AgentHost>["send"]>[1]): Promise<TurnInput> {
  const before = inputs.length;
  host.send(id, input);
  for (const end = Date.now() + 3000; inputs.length === before || internals().runs.has(id); ) {
    if (Date.now() > end) throw new Error("Timed out waiting for the turn");
    await sleep(10);
  }
  return inputs[inputs.length - 1];
}

function thread(): string {
  return host.createThread({ provider: "claude", mode: "code", approval: "full", cwd: null, scope: { kind: "global", ref: null } }).id;
}

const userText = (id: string) => internals().loadItems(id).filter((it) => it.kind === "user").map((it) => (it as { text: string }).text);

before(() => {
  store.load();
  host = new AgentHost(() => {});
  const stub = (id: ProviderId) => ({
    id,
    label: id,
    status: async () => ({ id, label: id, available: true }),
    models: async () => [],
    complete: async () => "",
    prewarm: () => {},
    dispose: () => {},
    createSession: (_t: Thread) => ({
      warm: async () => {},
      update: () => {},
      commands: async () => [],
      dispose: () => {},
      cancel: async () => {},
      run: async (input: TurnInput) => {
        inputs.push(input);
        return { status: "done" as const };
      },
    }),
  });
  for (const id of ["claude", "codex", "cursor", "pi"] as const) internals().fakes[id] = stub(id);
});

after(async () => {
  await sleep(100);
  host.dispose();
  store.closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // left for the OS to clean up
  }
});

test("composer and page messages: the provider gets tokens, the transcript the values, Send as is the values", async () => {
  const v = new Vault();
  setVault(v);
  const secret = "hunter2-staging-pw";
  const { fragment } = await v.add({ value: secret, hint: "staging password", source: "user", createdBy: "user" });
  const token = tokenFor(fragment);

  const typed = thread();
  const first = await sent(typed, { text: `log in with ${secret}` });
  assert.ok(first.text.includes(token), "the provider reads the token");
  assert.ok(!first.text.includes(secret), "and never the value");
  assert.deepEqual(userText(typed), [`log in with ${secret}`]);

  // An attached text file goes as a token too.
  const file = { name: "notes.txt", mimeType: "text/plain", data: Buffer.from(`pw: ${secret}`).toString("base64") };
  const withFile = await sent(typed, { text: "see the file", files: [file] });
  assert.ok(withFile.text.includes(`pw: ${token}`) && !withFile.text.includes(secret));

  // Send as is: the user's choice, for their own message only.
  assert.ok((await sent(typed, { text: `as typed: ${secret}`, asIs: true })).text.includes(`as typed: ${secret}`));
  const page = await sent(typed, { text: `from a page: ${secret}`, from: "page", asIs: true });
  assert.ok(page.text.includes(`from a page: ${token}`) && !page.text.includes(secret), "a page can't send as is");
  assert.ok(userText(typed).includes(`from a page: ${secret}`), "the transcript keeps the page's text as written");
});

test("a detected secret in a message is protected, then sent as its token", async () => {
  const v = new Vault();
  setVault(v);
  const key = `ghp_${"a1B2c3D4e5".repeat(3)}abcdef`;
  assert.equal(v.hits([`token ${key}`]).detected.length, 1, "the composer's check sees it");
  assert.equal(v.list().length, 0, "the check protects nothing by itself");
  const id = thread();
  const input = await sent(id, { text: `use ${key}` });
  assert.ok(!input.text.includes(key));
  const [fragment] = v.list();
  assert.equal(fragment?.detector, "github");
  assert.ok(input.text.includes(tokenFor(fragment)));
  assert.deepEqual(v.hits([`token ${key}`]), { fragments: [{ ...fragment }], detected: [] });
});
