import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import vm from "node:vm";
import { BOARD_BRIDGE_JS } from "../bridge.js";
import { flyoutSections } from "./flyoutList.js";

// A page's temporary chats (#970): out of the thread lists, gone when the daemon starts.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-temp-threads-"));
process.env.SCRIBE_HOME = dir;
process.env.SCRIBE_FAKE_AGENTS = "1";
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;

before(() => {
  store.load();
  host = new AgentHost(() => undefined);
});

after(() => {
  host.dispose();
  store.closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // left for the OS to clean up
  }
});

const chat = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");

function fn(source: string, name: string): string {
  const match = source.match(new RegExp(`^  function ${name}\\([^]*?^  }`, "m"));
  assert.ok(match, name);
  return match[0];
}

test("start({ temporary: true }) asks for a temporary thread", async () => {
  const calls: any[] = [];
  const context = vm.createContext({
    S: { threads: new Map(), details: new Map(), ready: true }, PAGE_PROMPT_MAX: 20000,
    loadStartupData: async () => {},
    pageThreadSettings: (data: any) => ({ approval: data.approval ?? "board" }),
    pageMayWrite: async () => ({ ok: true }), pageMayUseFolder: async () => ({ ok: true }),
    pageSentAt: new Map(), showPageThread: () => {},
    api: async (method: string, url: string, body: any) => (calls.push({ method, url, body }), url === "/threads" ? { thread: { id: "new" } } : {}),
  });
  vm.runInContext([fn(BOARD_BRIDGE_JS, "agentSettings"), fn(chat, "pageImages")].join("\n"), context);
  vm.runInContext(chat.match(/^  async function pageRequest\([^]*?^  }/m)![0], context);
  await vm.runInContext("pageRequest({ id: 'studio' }, { ...agentSettings({ temporary: true }), op: 'start', prompt: 'Draw a cat' })", context);
  assert.equal(calls[0].body.temporary, true);
  await vm.runInContext("pageRequest({ id: 'studio' }, { ...agentSettings({ temporary: 'yes' }), op: 'start', prompt: 'Draw a dog' })", context);
  assert.equal(calls[2].body.temporary, undefined);
});

test("a temporary thread never shows under Recent, but does while it runs", () => {
  const now = Date.now();
  const sections = flyoutSections(
    [
      { id: "kept", status: "idle", activityAt: now - 1000 },
      { id: "temp", status: "idle", activityAt: now - 500, temporary: true },
      { id: "temp-run", status: "running", activityAt: now, temporary: true },
    ],
    { now }
  );
  assert.deepEqual(sections.recent.map((t) => t.id), ["kept"]);
  assert.deepEqual(sections.active.map((t) => t.id), ["temp-run"]);
});

test("temporary threads are deleted when the daemon starts", () => {
  const pageId = store.upsert({ key: "studio", title: "Studio", html: "<p>studio</p>" }).tab.id;
  const scope = { kind: "page" as const, ref: pageId };
  const temp = host.createThread({ provider: "claude", scope, temporary: true }, { remember: false });
  const kept = host.createThread({ provider: "claude", scope }, { remember: false });
  assert.equal(temp.temporary, true);
  assert.equal(kept.temporary, undefined);

  host.dispose();
  host = new AgentHost(() => undefined);
  const after = host.listThreads().map((t) => t.id);
  assert.ok(after.includes(kept.id));
  assert.ok(!after.includes(temp.id));
});
