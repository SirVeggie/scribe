import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const between = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

const slashAt = vm.runInNewContext(`${between("  function slashAt(", "  function chipKey(")}\nslashAt`);

test("slash commands require start or whitespace and follow the caret without matching paths", () => {
  for (const text of ["/here", "draft /here", "draft\n/here", "draft\t/here"]) {
    const at = slashAt(text, text.length);
    assert.equal(at.query, "here");
    assert.equal(text.slice(at.start, at.end), "/here");
  }
  const text = "draft /workspace next";
  const at = slashAt(text, 9);
  assert.equal(at.query, "wo");
  assert.equal(text.slice(at.start, at.end), "/workspace");
  for (const text of ["draft/here", "https://here", " /usr/bin", " /here,", "draft /here "]) {
    assert.equal(slashAt(text, text.length), null, text);
  }
  assert.equal(slashAt(" /usr/bin", 5), null);
});

function slashView(text: string, cursor = text.length, commands: any[] = []) {
  const rows: any[] = [];
  const view = vm.runInNewContext(`${between("  function slashAt(", "  function chipKey(")}\nnew (class {${between("    async updatePicker()", "    showMentions(")}})()`, {
    S: { commands: new Map([["test", commands]]) },
    LOCAL_SLASH: [{ name: "here" }, { name: "clear" }],
    loadScribeSkills: async () => [],
    activeTab: () => null, pageActions: () => [{ id: "summarise", label: "Summarise" }],
    mentionAt: () => null,
    button: (_label: string, _className: string, click: () => void) => ({ click, append() {} }),
    el: () => ({}),
  });
  view.input = { value: text, selectionStart: cursor, selectionEnd: cursor,
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; } };
  view.settings = () => ({ provider: "test" });
  view.slash = { hidden: true, replaceChildren() { rows.length = 0; }, append(row: any) { rows.push(row); } };
  view.mentionGen = 0;
  view.hidePicker = () => { view.mentionGen++; view.slash.hidden = true; };
  view.autosize = view.focus = () => {};
  return { view, rows };
}

test("picking an inline local command removes only its token and preserves the caret", async () => {
  const { view, rows } = slashView("draft /here next", 11);
  let applied = "";
  view.applyLocalSlash = async (name: string) => { applied = name; };
  await view.updatePicker();
  await rows[0].click();
  assert.equal(applied, "here");
  assert.equal(view.input.value, "draft  next");
  assert.equal(view.input.selectionStart, 6);
});

test("inline /clear carries draft text, files and mentions into the new thread", async () => {
  const { view, rows } = slashView("draft /clear");
  const attachments = [{ name: "notes.txt" }];
  const mentions = [{ kind: "page", id: "page" }];
  view.composerContent = () => ({ text: view.input.value, attachments, mentions });
  view.emptyComposer = () => { view.input.value = ""; };
  view.applyLocalSlash = async (name: string) => { assert.equal(name, "clear"); assert.equal(view.input.value, ""); };
  view.fillComposer = (content: any) => {
    assert.equal(content.attachments, attachments);
    assert.equal(content.mentions, mentions);
    view.input.value = content.text;
  };
  await view.updatePicker();
  await rows[0].click();
  assert.equal(view.input.value, "draft ");
});

test("provider and page commands keep the draft as command input", async () => {
  for (const name of ["compact", "summarise"]) {
    const { view, rows } = slashView(`before /${name} after`, 8 + name.length, [{ name: "compact" }]);
    await view.updatePicker();
    await rows[0].click();
    assert.equal(view.input.value, `/${name} before  after`);
  }
});

test("a selection or escaped picker leaves literal commands untouched", async () => {
  const { view, rows } = slashView("draft /here");
  view.input.selectionEnd--;
  await view.updatePicker();
  assert.equal(rows.length, 0);
  view.input.selectionEnd++;
  await view.updatePicker();
  const keys = vm.runInNewContext(`({${between("    onKey(event)", "    async updatePicker()")}})`);
  view.slash.querySelectorAll = () => [];
  keys.onKey.call(view, { key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.equal(view.slash.hidden, true);
  assert.equal(view.input.value, "draft /here");
});

test("a delayed command response cannot reopen a dismissed picker or use an old caret", async () => {
  for (const dismiss of [true, false]) {
    const { view, rows } = slashView("draft /here");
    let resolve!: (value: any) => void;
    const response = new Promise((done) => { resolve = done; });
    // Use the real method with a deferred provider request.
    view.showSlash = vm.runInNewContext(`({${between("    async showSlash(", "    showMentions(")}}).showSlash`, {
      slashAt, S: { commands: new Map() }, api: () => response, loadScribeSkills: async () => [],
    });
    view.threadId = "thread";
    const pending = view.updatePicker();
    if (dismiss) view.hidePicker();
    else view.input.setSelectionRange(0, 0);
    resolve({ commands: [] });
    await pending;
    assert.equal(rows.length, 0);
    assert.equal(view.slash.hidden, true);
  }
});

test("/clear opens a page-default draft in each chat layout without inheriting thread settings", async () => {
  for (const variant of ["side", "dock", "full"]) {
    for (const tab of [{ id: "current-page" }, null]) {
      const calls: string[] = [];
      const context = vm.createContext({
        activeTab: () => tab,
        app: () => null,
        setDockPick: (id: string, thread: string | null) => {
          assert.equal(thread, null);
          calls.push(`clear:${id}`);
        },
        dock: { renderTitle: () => calls.push("dock-title") },
        full: { renderList: () => calls.push("full-list") },
        sidebar: { listOpen: true, toggleList: () => calls.push("hide-list") },
        notice: () => {},
        inheritSettings: () => { throw new Error("Must not inherit settings"); },
      });
      vm.runInContext(between("  function defaultScope()", "  /* ---------- full window")
        + between("  function newThread(fromView", "  async function cycleMode()"), context);
      const view = vm.runInContext(`({${between("    async applyLocalSlash(name)", "    /** The thread's workspace folder")}})`, context);
      view.variant = variant;
      view.settings = () => { throw new Error("Must not read old thread settings"); };
      view.startDraft = (scope: unknown, settings: unknown) => {
        assert.deepEqual(JSON.parse(JSON.stringify(scope)), tab ? { kind: "page", ref: tab.id } : { kind: "global", ref: null });
        assert.deepEqual(JSON.parse(JSON.stringify(settings)), {});
        calls.push("draft");
      };
      await view.applyLocalSlash("clear");
      assert.ok(calls.includes("draft"));
      assert.equal(calls.includes("hide-list"), variant === "side");
      assert.equal(calls.includes("full-list"), variant === "full");
      assert.equal(calls.includes("clear:current-page"), variant === "dock" && Boolean(tab));
    }
  }
});

test("a reset page draft resolves workspace, mode and model from defaults", () => {
  // The access ladder's helpers come from the shipped source, so the draft follows the real rungs.
  const rungs = between("  /** A rung from older data", "  /** Tool groups a custom mode") + between("  const APPROVALS = [", "  const WEB_MODES = [");
  const view = vm.runInNewContext(`${rungs}\n({${between("    settings() {", "\n    /** Whether patch moves a tainted thread")}})`, {
    prefs: () => ({ provider: "codex", models: { codex: "preferred-model" }, mode: "code", web: "on", recentWorkspaces: ["other-workspace"] }),
    providerAvailable: () => true,
    modelChoice: () => ({ effort: "high", modelParams: {} }),
    pageWorkspace: (id: string) => id === "current-page" ? "page-workspace" : null,
    approvalFor: () => "auto",
    customModes: () => [],
    webMode: (value: string, fallback: string) => value || fallback,
    dirKey: (value: string) => value,
  });
  view.thread = () => null;
  view.draft = { scope: { kind: "page", ref: "current-page" }, settings: {} };
  const settings = view.settings();
  assert.equal(settings.provider, "codex");
  assert.equal(settings.model, "preferred-model");
  assert.equal(settings.effort, "high");
  assert.equal(settings.cwd, "page-workspace");
  // Page threads start on the Board rung (#719).
  assert.equal(settings.approval, "board");
  assert.equal(settings.mode, "board");
  view.draft = { scope: { kind: "global", ref: null }, settings: {} };
  const global = view.settings();
  assert.equal(global.cwd, "other-workspace");
  assert.equal(global.approval, "auto");
  assert.equal(global.mode, "code");
});

test("sending /clear consumes the command locally, including with attachments", async () => {
  for (const text of ["/clear", " /CLEAR \n"]) {
    const view = vm.runInNewContext(`({${between("    async send() {", "\n  }\n\n  /** Markdown to one plain line")}})`, {});
    const calls: string[] = [];
    view.input = { value: text };
    view.attachments = [{ name: "notes.txt" }];
    view.hidePicker = () => calls.push("hide");
    view.autosize = () => {};
    view.applyLocalSlash = async (name: string) => calls.push(name);
    view.syncComposerDraft = () => calls.push("sync");
    await view.send();
    assert.equal(view.input.value, "");
    assert.deepEqual(calls, ["hide", "clear", "sync"]);
  }
});

test("the regular new-thread action still inherits the current chat settings", () => {
  const current = { scope: { kind: "workspace", ref: "workspace" }, model: "existing-model" };
  const view = {
    variant: "full",
    settings: () => current,
    startDraft: (scope: unknown, settings: unknown) => {
      assert.deepEqual(JSON.parse(JSON.stringify(scope)), current.scope);
      assert.equal(settings, current);
    },
  };
  const context = vm.createContext({ full: { renderList() {} }, inheritSettings: () => current, notice() {}, view });
  vm.runInContext(between("  function newThread(fromView", "  async function cycleMode()") + "newThread(view);", context);
});

test("user-created floating threads move the composer; other layouts and automatic drafts park it", () => {
  for (const variant of ["dock", "side", "full"]) {
    for (const userInitiated of [true, false]) {
      for (const existingThread of [true, false]) {
        const saved: any[] = [];
        const S = { composers: new Map() };
        const context = vm.createContext({
          S, activeTab: () => ({ id: "page" }), setDockPick() {}, setTimeout() {}, notice() {},
          dock: { bindFeed() {}, renderTitle() {} }, full: { renderList() {} }, sidebar: { listOpen: false },
          inheritSettings: (view: any) => view.settings(),
          syncThreadDraft: (thread: any, content: any) => { thread.draft = content; },
          saveDraftThread: (_settings: any, content: any) => saved.push(content),
        });
        const view = vm.runInContext(`new (class {
          ${between("    startDraft(scope", "    /** Hand this chat")}
          ${between("    composerContent()", "    visible()")}
        })()`, context);
        const scope = { kind: "page", ref: "page" };
        const thread = { id: "old", draft: { text: "saved copy" } };
        Object.assign(view, {
          variant, threadId: existingThread ? thread.id : null, draft: { scope, settings: {} },
          input: { value: "Unsent text" }, mentions: [{ kind: "page", id: "mentioned" }],
          attachments: [{ name: "notes.txt", preview: "blob:preview" }],
          settings: () => ({ scope }), thread: () => view.threadId ? thread : null,
          closeHelper() {}, autosize() {}, renderContext() {}, renderAll() {},
        });
        const content = view.composerContent();
        context.view = view;
        if (userInitiated) {
          vm.runInContext(between("  function newThread(fromView", "  async function cycleMode()") + "newThread(view);", context);
        } else {
          view.startDraft(scope);
        }
        const moved = variant === "dock" && userInitiated;
        assert.equal(view.input.value, moved ? "Unsent text" : "");
        assert.equal(view.attachments.length, moved ? 1 : 0);
        assert.equal(view.mentions.length, moved ? 1 : 0);
        if (moved) assert.equal(view.attachments, content.attachments);
        if (existingThread) {
          assert.deepEqual(thread.draft, moved ? null : content);
          assert.deepEqual(S.composers.get("old"), moved ? undefined : content);
        } else {
          assert.equal(saved.length, moved ? 0 : 1);
          if (!moved) assert.deepEqual(saved[0], content);
        }
      }
    }
  }
});

test("the floating thread menu explicitly moves the composer", () => {
  let items: any[] = [];
  let args: any[] = [];
  const menu = source.slice(source.lastIndexOf("    threadMenu(anchor) {"), source.indexOf("    pick(id) {", source.lastIndexOf("    threadMenu(anchor) {")));
  const dock = vm.runInNewContext(`({${menu}})`, {
    S: { threads: new Map() }, activeTab: () => ({ id: "page" }),
    hiddenWorkspaceKeys: () => new Set(), setDockPick() {}, spaceFilterId: () => null, dockCompact: () => false,
    recentOn: () => false, recentThreads: () => [], clearTimeout() {},
    openMenu: (_anchor: any, entries: any[]) => { items = entries; },
  });
  dock.view = { startDraft: (...values: any[]) => { args = values; } };
  dock.renderTitle = () => {};
  dock.threadMenu({});
  items.find((item) => item.label === "New thread").run();
  assert.equal(args[2], true);
});
