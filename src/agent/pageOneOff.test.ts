import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { BOARD_BRIDGE_JS } from "../bridge.js";
import { customKey, settleNoTools } from "./customModes.js";
import { NO_TOOLS_CONFIG } from "./providers/codex.js";
import { threadInstructions } from "./prompt.js";
import type { Thread } from "./types.js";

// One-off page chats (#729): images on start and send, threads without tools, and deleting them.

const chat = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");

function fn(source: string, name: string): string {
  const match = source.match(new RegExp(`^  function ${name}\\([^]*?^  }`, "m"));
  assert.ok(match, name);
  return match[0];
}

function pageContext(threads: Array<[string, unknown]> = []) {
  const calls: any[] = [];
  const settings: any[] = [];
  const context = vm.createContext({
    S: { threads: new Map(threads), details: new Map(), ready: true }, PAGE_PROMPT_MAX: 20000,
    loadStartupData: async () => {},
    pageThreadSettings: (data: any) => (settings.push(data), { approval: data.approval ?? "board", cwd: data.cwd ?? "" }),
    pageMayWrite: async () => ({ ok: true }), pageMayUseFolder: async () => ({ ok: true }), pageFolder: () => null,
    ensureDetail: async () => {}, pageSentAt: new Map(), showPageThread: () => {},
    api: async (method: string, url: string, body: any) => {
      calls.push({ method, url, body });
      return url === "/threads" ? { thread: { id: "new" } } : {};
    },
  });
  vm.runInContext([fn(BOARD_BRIDGE_JS, "agentSettings"), fn(chat, "pageImages"), fn(chat, "ownedBy")].join("\n"), context);
  vm.runInContext(chat.match(/^  async function pageRequest\([^]*?^  }/m)![0], context);
  return { context, calls, settings };
}

test("start with tools: false makes a thread without tools, and its images go with the first message", async () => {
  const { context, calls, settings } = pageContext();
  const images = [{ name: "shot.png", mimeType: "image/png", data: "aGk=" }, { name: "x.txt", mimeType: "text/plain", data: "aGk=" }];
  context.images = images;
  const result = await vm.runInContext(
    "pageRequest({ id: 'ocr' }, { ...agentSettings({ tools: false, approval: 'full', cwd: 'C:/work', web: 'on', helpers: true }), op: 'start', prompt: 'Read it', images })",
    context
  );
  assert.equal(result.ok, true);
  // Whatever the page asked for, the thread reads only, with no folder or web.
  assert.equal(settings[0].approval, "readonly");
  assert.equal(settings[0].cwd, undefined);
  assert.equal(settings[0].web, "off");
  assert.equal(settings[0].helpers, false);
  assert.equal(calls[0].url, "/threads");
  assert.equal(calls[0].body.noTools, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body.scope)), { kind: "page", ref: "ocr" });
  assert.equal(calls[1].url, "/threads/new/messages");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].body.images)), [images[0]]);
});

test("send takes images, and a page deletes only its own threads", async () => {
  const own = { id: "mine", scope: { kind: "page", ref: "ocr" } };
  const other = { id: "theirs", scope: { kind: "page", ref: "elsewhere" } };
  const { context, calls } = pageContext([["mine", own], ["theirs", other]]);
  await vm.runInContext("pageRequest({ id: 'ocr' }, { op: 'send', threadId: 'mine', prompt: 'Again', images: [{ name: 'a.png', mimeType: 'image/png', data: 'aGk=' }] })", context);
  assert.equal(calls[0].body.images.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(await vm.runInContext("pageRequest({ id: 'ocr' }, { op: 'delete', threadId: 'theirs' })", context))), { ok: false, error: "not_found" });
  assert.equal(calls.length, 1);
  assert.equal((await vm.runInContext("pageRequest({ id: 'ocr' }, { op: 'delete', threadId: 'mine' })", context)).ok, true);
  assert.deepEqual([calls[1].method, calls[1].url], ["DELETE", "/threads/mine"]);
});

test("a page asking for its saved thread as Scribe starts waits for the thread list (#883)", async () => {
  const own = { id: "mine", scope: { kind: "page", ref: "lab" }, status: "idle" };
  const { context } = pageContext();
  context.S.ready = false;
  context.lastReply = async () => ({ reply: "Done", images: [] });
  context.pageBrief = (t: any) => ({ id: t.id, status: t.status });
  context.loadStartupData = async () => { context.S.threads = new Map([["mine", own]]); context.S.ready = true; };
  const got = await vm.runInContext("pageRequest({ id: 'lab' }, { op: 'get', threadId: 'mine' })", context);
  assert.equal(got.ok, true);
  assert.equal(got.reply, "Done");
  // Still no list (Scribe offline): the page hears it is unavailable, not that its thread is gone.
  context.S.ready = false;
  context.loadStartupData = async () => { throw new Error("offline"); };
  assert.equal((await vm.runInContext("pageRequest({ id: 'lab' }, { op: 'get', threadId: 'mine' })", context)).error, "unavailable");
});

test("the bridge reads data: URLs and refuses images that won't do before calling the board", async () => {
  const sent: any[] = [];
  const context = vm.createContext({
    Blob: class {},
    assetUrl: (v: string) => "/blob/" + v,
    agentCall: (message: any) => (sent.push(message), Promise.resolve({ ok: true })),
  });
  const bridge = BOARD_BRIDGE_JS;
  const constants = bridge.match(/^  var AGENT_MAX_IMAGES[^]*?AGENT_MAX_IMAGE_BYTES = [^;]*;/m)![0];
  vm.runInContext([constants, fn(bridge, "agentImage"), fn(bridge, "withImages")].join("\n"), context);
  const ok = await vm.runInContext("withImages({ op: 'start' }, ['data:image/png;base64,aGk='])", context);
  assert.equal(ok.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].images)), [{ name: "image", mimeType: "image/png", data: "aGk=" }]);
  assert.equal((await vm.runInContext("withImages({ op: 'start' }, ['data:text/plain;base64,aGk='])", context)).error, "not_an_image");
  assert.equal((await vm.runInContext("withImages({ op: 'start' }, new Array(11).fill('data:image/png;base64,aGk='))", context)).error, "too_many_images");
  assert.equal((await vm.runInContext("withImages({ op: 'start' }, [42])", context)).error, "not_an_image");
  assert.equal(sent.length, 1);
  await vm.runInContext("withImages({ op: 'start' }, undefined)", context);
  assert.equal(sent[1].images, undefined);
});

test("a thread without tools stays Read-only with no folder or web, and is told it has no tools", () => {
  const thread = {
    id: "th_1", provider: "claude", mode: "code", approval: "full", web: "on", cwd: "C:/work", useWorktree: true, planNext: true, helpersAllowed: true,
    custom: { id: "cm_x", name: "X", off: [], mcp: "all", instructions: "" }, scope: { kind: "page", ref: "ocr" }, noTools: true,
  } as unknown as Thread;
  settleNoTools(thread);
  assert.deepEqual(
    { mode: thread.mode, approval: thread.approval, web: thread.web, cwd: thread.cwd, useWorktree: thread.useWorktree, custom: thread.custom, planNext: thread.planNext, helpersAllowed: thread.helpersAllowed },
    { mode: "board", approval: "readonly", web: "off", cwd: null, useWorktree: false, custom: undefined, planNext: undefined, helpersAllowed: undefined }
  );
  // A session with tools is never reused for it.
  assert.equal(customKey(thread), ";readonly;notools");
  const text = threadInstructions(thread, { page: { key: "scribe:ocr", title: "OCR" }, memories: [] } as never);
  assert.match(text, /this thread has none/);
  assert.doesNotMatch(text, /page_read|ask_user|thread_list|memory_save|This thread belongs/);
});

test("Codex without tools: no Scribe server, no shell, and code mode fails closed", () => {
  const features = NO_TOOLS_CONFIG.features as Record<string, boolean>;
  for (const name of ["shell_tool", "unified_exec", "code_mode_host", "view_image", "multi_agent", "apps"]) assert.equal(features[name], false, name);
  assert.equal("mcp_servers" in NO_TOOLS_CONFIG, false);
});

test("the latest turn's own images reach the page as its assets, once each (#890)", async () => {
  const calls: string[] = [];
  const file = (id: string) => ({ id, name: "image.png", mimeType: "image/png", size: 3 });
  const detail = {
    turns: new Map([["t1", { id: "t1", seq: 1, status: "done" }], ["t2", { id: "t2", seq: 2, status: "done" }]]),
    items: [
      { kind: "images", turnId: "t1", images: [file("out-old")] },
      { kind: "text", turnId: "t2", text: "Here it is." },
      { kind: "images", turnId: "t2", sourceId: "a", images: [file("out-a")] },
      { kind: "images", turnId: "t2", sourceId: "b", images: [file("out-a")] },
      { kind: "images", turnId: "t2", parentToolId: "sub", images: [file("out-sub")] },
    ],
  };
  const context = vm.createContext({
    ensureDetail: async () => detail,
    console,
    api: async (_method: string, url: string) => (calls.push(url), { asset: { id: "pa_1", url: "/blob/pa_1" } }),
  });
  vm.runInContext(chat.match(/^  async function lastReply\([^]*?^  }/m)![0], context);
  const last = await vm.runInContext("lastReply('th')", context);
  assert.equal(last.reply, "Here it is.");
  assert.deepEqual(calls, ["/threads/th/files/out-a/page-asset"]);
  assert.equal(last.images[0].url, "/blob/pa_1");
});
