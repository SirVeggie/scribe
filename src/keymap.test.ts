import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

/** public/keymap.js the way the page key script loads it: on an object of its own. */
function load() {
  const root: Record<string, any> = {};
  vm.runInNewContext(`(function (window) {${fs.readFileSync(new URL("../public/keymap.js", import.meta.url), "utf8")}\n})(root);`, { root, globalThis: root });
  return root.scribeKeymap;
}
const key = (key: string, code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) => ({
  key, code, ctrlKey: Boolean(mods.ctrl), shiftKey: Boolean(mods.shift), altKey: Boolean(mods.alt), metaKey: Boolean(mods.meta), isComposing: false,
});

test("default keys match as before", () => {
  const k = load();
  assert.equal(k.match(key("k", "KeyK", { ctrl: true })), "agent-dock");
  assert.equal(k.match(key("K", "KeyK", { ctrl: true, shift: true })), "agent-new");
  assert.equal(k.match(key("k", "KeyK", { ctrl: true, alt: true })), "");
  assert.equal(k.match(key("t", "KeyT", { meta: true })), "new-page");
  assert.equal(k.match(key("n", "KeyN", { ctrl: true })), "new-page");
  assert.equal(k.match(key("<", "Comma", { ctrl: true, shift: true })), "agent-settings");
  assert.equal(k.match(key("s", "KeyS", { ctrl: true, alt: true })), "settings");
  // The apostrophe: US by position, Nordic on the key next to Enter (with Shift it types *).
  assert.equal(k.match(key('"', "Quote", { ctrl: true, shift: true })), "agent-mode");
  assert.equal(k.match(key("*", "Backslash", { ctrl: true, shift: true })), "agent-mode");
  assert.equal(k.match(key(":", "Period", { ctrl: true, shift: true })), "agent-scope");
  // Letters by what the layout types; a Cyrillic layout falls back to the position.
  assert.equal(k.match(key("л", "KeyK", { ctrl: true })), "agent-dock");
  assert.equal(k.match(key("PageUp", "PageUp", { ctrl: true, shift: true })), "prev-space");
  assert.equal(k.match(key("b", "KeyB", { ctrl: true }), ["agent-dock"]), "");
});

test("overrides replace an action's keys and drop bad entries", () => {
  const k = load();
  k.setOverrides(k.parse(JSON.stringify({ "agent-dock": ["Ctrl+Shift+Space"], library: [], bogus: ["Ctrl+Q"], help: ["Q", "Ctrl+R", "Ctrl+Alt+H"] })));
  assert.equal(k.match(key("k", "KeyK", { ctrl: true })), "");
  assert.equal(k.match(key(" ", "Space", { ctrl: true, shift: true })), "agent-dock");
  assert.equal(k.match(key("b", "KeyB", { ctrl: true })), "");
  assert.equal(JSON.stringify(k.bindings("help")), JSON.stringify(["Ctrl+Alt+H"]));
  assert.deepEqual(k.overrides().bogus, undefined);
  assert.equal(k.parse("not json").library, undefined);
});

test("bindings normalise and show", () => {
  const k = load();
  assert.equal(k.normalize("Shift+Ctrl+k"), "");
  assert.equal(k.normalize("Shift+Ctrl+K"), "Ctrl+Shift+K");
  assert.equal(k.normalize("Cmd+Alt+'"), "Ctrl+Alt+'");
  assert.equal(k.fromEvent(key("F2", "F2")), "F2");
  assert.equal(k.usable("F2"), true);
  assert.equal(k.usable("Shift+K"), false);
  assert.equal(k.show("Ctrl+Shift+PageDown"), "Ctrl+Shift+PgDn");
  assert.equal(k.tip("Library", "library"), "Library (Ctrl+B)");
});

test("the desktop shell gets virtual keys for its board actions only", () => {
  const k = load();
  const native = k.nativeBindings();
  assert.ok(native.some((b: any) => b.action === "settings" && b.key === 0xbc && b.ctrl && !b.shift));
  assert.ok(native.some((b: any) => b.action === "next-tab" && b.key === 0x09));
  assert.ok(native.some((b: any) => b.action === "agent-full" && b.key === 0x4c && b.shift));
  assert.ok(!native.some((b: any) => b.action === "agent-model"));
});
