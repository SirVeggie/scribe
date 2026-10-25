import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");

test("workspace cycling visits every folder and none as thread counts and recency change", async () => {
  for (const existing of [true, false]) {
    const currentThread = { cwd: "C:/llm-chat" as string | null };
    const threads = new Map([
      ["current", currentThread],
      ["llm", { cwd: "C:/llm-chat" }],
      ["valheim", { cwd: "C:/valheim-wake" }],
      ["last", { cwd: "C:/z-last" }],
    ]);
    if (!existing) threads.delete("current");
    let recent = ["C:/y-recent", "c:\\LLM-CHAT\\"];
    const visited: (string | null)[] = [];
    const ctx = vm.createContext({
      S: { threads },
      hiddenWorkspaceKeys: () => new Set(),
      workspaceDir: (t: { cwd: string | null }) => t.cwd,
      dirKey: (dir: string) => (dir || "").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase(),
      prefs: () => ({ recentWorkspaces: recent }),
      notice: () => {}, R: { basename: (dir: string) => dir.split("/").at(-1) },
      targetView: () => ({
        settings: () => currentThread,
        setWorkspace: async (dir: string | null) => {
          currentThread.cwd = dir;
          if (dir) recent = [dir, ...recent.filter(item => item !== dir)];
          visited.push(dir);
        },
      }),
    });
    const workspaces = source.indexOf("  function threadWorkspaces()");
    vm.runInContext(source.slice(workspaces, source.indexOf("  /** What the presets", workspaces)), ctx);
    const cycle = source.indexOf("  function workspaceCycleList(");
    vm.runInContext(source.slice(cycle, source.indexOf("  /** Scribe access options", cycle)), ctx);
    for (let i = 0; i < 10; i++) await vm.runInContext("cycleWorkspace()", ctx);
    assert.deepEqual(visited, [
      "C:/valheim-wake", "C:/y-recent", "C:/z-last", null, "C:/llm-chat",
      "C:/valheim-wake", "C:/y-recent", "C:/z-last", null, "C:/llm-chat",
    ], existing ? "existing thread" : "draft");
  }
});

function fixture() {
  const calls: string[] = [];
  const root = (id: string) => ({ contains: (node: any) => node?.owner === id });
  const S = { fullOpen: false, sideOpen: true, dockShown: true, dockExpanded: false };
  const document = { activeElement: { owner: "page" }, querySelector: () => null as any };
  let onKey: any;
  const ctx = vm.createContext({
    S, document, SOLO: false, CHAT: false, openMenuAnchor: null, openMenuEl: null,
    dock: { root: root("dock"), titleBtn: {}, view: {}, setShown: () => calls.push("dock") },
    sidebar: { pane: root("side"), view: {}, setOpen: () => calls.push("side") },
    full: { root: root("full"), view: {} },
    allowlists: { close: () => false },
    agentSettings: { close: () => false }, modalStack: [],
    window: { addEventListener: (_: string, fn: any) => { onKey = fn; } },
  });
  const start = source.indexOf("  function shortcut(action)");
  const end = source.indexOf("  /* ---------- template agent actions", start);
  vm.runInContext(source.slice(start, end), ctx);
  const target = source.indexOf("  function targetView()");
  vm.runInContext(source.slice(target, source.indexOf("  /** Latest", target)), ctx);
  for (const [fn, action] of Object.entries({ cycleModel: "model", cycleEffort: "effort", cycleMode: "mode", cycleWorkspace: "workspace", cycleScope: "scope", newThread: "new", openThreads: "threads", chatUp: "up", chatDown: "down", enterFull: "full" })) {
    ctx[fn] = () => calls.push(action);
  }
  return { ctx, S, document, calls, key(key: string, code = "", shiftKey = false) {
    let prevented = false;
    onKey({ key, code, shiftKey, ctrlKey: true, preventDefault: () => { prevented = true; } });
    return prevented;
  } };
}

test("chat settings, thread actions and resizing require chat focus", () => {
  const f = fixture();
  for (const owner of ["page", "library", "settings", "iframe"]) {
    f.document.activeElement = { owner };
    for (const action of ["model", "effort", "mode", "workspace", "scope", "new", "threads", "up", "down"]) {
      assert.equal(vm.runInContext(`shortcut('${action}')`, f.ctx), false, `${owner}: ${action}`);
    }
    assert.equal(f.key(".", "Period"), false);
    assert.equal(f.key("'", "Quote"), false);
    assert.equal(f.key("j"), false);
    assert.equal(f.key("K", "KeyK", true), false);
  }
  assert.deepEqual(f.calls, []);
  for (const owner of ["side", "dock", "full"]) {
    f.S.fullOpen = owner === "full";
    f.document.activeElement = { owner };
    assert.equal(f.key(".", "Period"), true);
    assert.equal(f.key(">", "Period", true), true);
    assert.equal(f.key("'", "Quote"), true);
    assert.equal(f.key("j"), true);
    assert.equal(f.key("K", "KeyK", true), true);
    assert.deepEqual(f.calls.splice(0), ["workspace", "scope", "model", "threads", "new"]);
  }
});

test("opening chat stays global, and dialogs block chat shortcuts", () => {
  const f = fixture();
  f.S.dockShown = false;
  assert.equal(f.key("k"), true);
  assert.equal(f.key("l"), true);
  assert.equal(f.key("L", "KeyL", true), true);
  assert.deepEqual(f.calls.splice(0), ["dock", "side", "full"]);
  f.document.querySelector = () => ({});
  f.document.activeElement = { owner: "side" };
  assert.equal(f.key(".", "Period"), false);
  assert.equal(f.key("k"), false);
  assert.deepEqual(f.calls, []);
});

test("floating thread picker keeps its chat ownership with the sidebar also open", () => {
  const f = fixture();
  f.ctx.openMenuAnchor = f.ctx.dock.titleBtn;
  f.ctx.openMenuEl = { contains: (node: any) => node?.owner === "picker" };
  f.document.activeElement = { owner: "picker" };
  assert.equal(vm.runInContext("focusedChat()", f.ctx), "dock");
  assert.equal(vm.runInContext("shortcutChat()", f.ctx), "dock");
  assert.equal(vm.runInContext("targetView() === dock.view", f.ctx), true);
  assert.equal(f.key("j"), true);
});

test("Escape leaves an unfocused chat and its helper alone", () => {
  const f = fixture();
  f.S.dockExpanded = true;
  f.ctx.dock.view.helperView = { visible: () => true };
  f.ctx.dock.view.closeHelper = () => f.calls.push("closeHelper");
  assert.equal(vm.runInContext("escape()", f.ctx), false);
  assert.deepEqual(f.calls, []);
  f.document.activeElement = { owner: "dock" };
  assert.equal(vm.runInContext("escape()", f.ctx), true);
  assert.deepEqual(f.calls, ["closeHelper"]);
});

test("page frames forward chat opening shortcuts and leave thread shortcuts untouched", () => {
  const http = fs.readFileSync(new URL("../http.ts", import.meta.url), "utf8");
  const start = http.indexOf("    var chatKey = event.key.toLowerCase();");
  const handler = http.slice(start, http.indexOf("\n  });", start));
  for (const [key, code, shiftKey, expected] of [
    [".", "Period", false, ""], [">", "Period", true, ""],
    ["'", "Quote", false, ""], ["j", "KeyJ", false, ""], ["K", "KeyK", true, ""],
    ["k", "KeyK", false, "dock"], ["l", "KeyL", false, "side"], ["L", "KeyL", true, "full"],
  ] as const) {
    let prevented = false;
    const messages: any[] = [];
    vm.runInNewContext(handler, {
      event: { key, code, shiftKey, preventDefault: () => { prevented = true; } },
      selectedText: () => "", parent: { postMessage: (message: any) => messages.push(message) },
    });
    assert.equal(prevented, Boolean(expected), key);
    assert.deepEqual(messages.map(m => m.action), expected ? [expected] : [], key);
  }
});
