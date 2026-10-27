import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// scribe.agent.pickModel (#732): a page opens the app's own model picker and gets the choice back.

const chat = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");

function fn(source: string, name: string): string {
  const match = source.match(new RegExp(`^  (?:async )?function ${name}\\([^]*?^  }`, "m"));
  assert.ok(match, name);
  return match[0];
}

function pickContext() {
  const opened: any[] = [];
  const context: any = vm.createContext({
    S: { threads: new Map(), details: new Map() },
    setTimeout,
    openMenuAnchor: null,
    modelInfo: (provider: string, id: string) => (id === "opus" ? { label: "Opus" } : null),
    openModelMenu(anchor: any, current: any, pick: any, opts: any) {
      context.openMenuAnchor = anchor;
      const menu = { tabIndex: 0, querySelector: () => null, focus: () => {} };
      opened.push({ anchor, current, pick, onClose: opts.onClose, menu });
      return menu;
    },
  });
  vm.runInContext([fn(chat, "pagePickModel"), fn(chat, "pageRequest")].join("\n"), context);
  return { context, opened };
}

const close = (context: any, entry: any) => {
  context.openMenuAnchor = null;
  entry.onClose();
};

test("menus accept page rectangle anchors and retain modal dialog placement", () => {
  const body: any[] = [];
  const dialog: any[] = [];
  const context: any = vm.createContext({
    openMenuEl: null, openMenuAnchor: null, openMenuOnClose: null,
    closeMenu() {}, onMenuOutside() {}, setTimeout() {},
    window: { innerHeight: 800, innerWidth: 1280 },
    document: { body: { append: (menu: any) => body.push(menu) } },
    el: () => ({ style: {}, offsetHeight: 100, append() {}, replaceChildren() {}, querySelectorAll: () => [] }),
  });
  vm.runInContext(fn(chat, "openMenu"), context);
  const anchor = { isConnected: true, getBoundingClientRect: () => ({ left: 10, top: 20, bottom: 60 }) };
  const menu = context.openMenu(anchor, []);
  assert.equal(body[0], menu);
  assert.equal(menu.style.top, "66px");
  context.openMenuEl = null;
  const modalMenu = context.openMenu({ ...anchor, closest: () => ({ append: (m: any) => dialog.push(m) }) }, []);
  assert.equal(dialog[0], modalMenu);
  assert.equal(body.length, 1);
});

test("a pick resolves with the model and its label, below the page's element", async () => {
  const { context, opened } = pickContext();
  const result = context.pageRequest({ id: "p" }, { op: "pickModel", rect: { left: 10, top: 20, width: 30, height: 40 }, provider: "claude", model: "sonnet" });
  await new Promise((r) => setTimeout(r, 0));
  const entry = opened[0];
  assert.deepEqual({ ...entry.anchor.getBoundingClientRect() }, { left: 10, top: 20, right: 40, bottom: 60, width: 30, height: 40 });
  assert.deepEqual({ ...entry.current }, { provider: "claude", model: "sonnet" });
  // openMenu closes the menu before it runs the pick.
  close(context, entry);
  entry.pick("claude", "opus");
  assert.deepEqual({ ...(await result) }, { ok: true, provider: "claude", model: "opus", label: "Opus" });
});

test("closing without a pick cancels, but opening the full list does not", async () => {
  const { context, opened } = pickContext();
  const result = context.pageRequest({ id: "p" }, { op: "pickModel", rect: {} });
  await new Promise((r) => setTimeout(r, 0));
  const first = opened[0];
  // "Show all models": the menu closes, and the full list opens on the same anchor at once.
  context.openMenuAnchor = null;
  first.onClose();
  context.openMenuAnchor = first.anchor;
  let settled = false;
  result.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(settled, false);
  close(context, first);
  assert.deepEqual({ ...(await result) }, { ok: false, error: "cancelled" });
});

test("only a click on the page opens it", async () => {
  const { context, opened } = pickContext();
  const result = await context.pageRequest({ id: "p" }, { op: "pickModel", rect: {} }, { activated: false });
  assert.deepEqual({ ...result }, { ok: false, error: "no_gesture" });
  assert.equal(opened.length, 0);
});
