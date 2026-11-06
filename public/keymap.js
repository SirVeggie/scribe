/**
 * App shortcuts and the user's remapping of them (#1022). The board, the agent chat, the desktop shell
 * and the key script in every page frame all match keys through this one table.
 *
 * A binding is text such as "Ctrl+Shift+K" or "Ctrl+,": modifiers in the order Ctrl, Alt, Shift, then
 * one key. Ctrl also matches Cmd. Letters match the character the layout types (as the shortcuts always
 * did); other keys match their position, named as on a US keyboard.
 *
 * The user's changes are one preference, scribe.shortcuts: { action: [binding, …] } for the actions
 * they changed only, so new defaults still reach everything else. [] turns an action off.
 *
 * http.ts inlines this file into the page key script, so it must not depend on the board's globals.
 */
(function (root) {
  "use strict";
  var PREF = "scribe.shortcuts";
  /** where: "board" runs through window.scribeShortcut; "chat" through scribeChat.shortcut. */
  var ACTIONS = [
    { id: "new-page", group: "Pages and tabs", label: "New page", keys: ["Ctrl+T", "Ctrl+N"] },
    { id: "close-tab", group: "Pages and tabs", label: "Close tab or peek", keys: ["Ctrl+W"], desktop: true },
    { id: "reopen", group: "Pages and tabs", label: "Reopen closed tab", keys: ["Ctrl+Shift+T"], desktop: true },
    { id: "next-tab", group: "Pages and tabs", label: "Next tab", keys: ["Ctrl+Tab"], desktop: true },
    { id: "prev-tab", group: "Pages and tabs", label: "Previous tab", keys: ["Ctrl+Shift+Tab"], desktop: true },
    { id: "download", group: "Pages and tabs", label: "Download page", keys: ["Ctrl+S"] },
    { id: "palette", group: "Navigation", label: "Search palette", keys: ["Ctrl+D"] },
    { id: "library", group: "Navigation", label: "Show or hide the Library", keys: ["Ctrl+B"] },
    { id: "spaces", group: "Navigation", label: "Spaces", keys: ["Ctrl+E"] },
    { id: "prev-space", group: "Navigation", label: "Previous space", keys: ["Ctrl+Shift+PageUp"] },
    { id: "next-space", group: "Navigation", label: "Next space", keys: ["Ctrl+Shift+PageDown"] },
    { id: "help", group: "Navigation", label: "Help", keys: ["Ctrl+H"] },
    { id: "settings", group: "Navigation", label: "Settings", keys: ["Ctrl+,", "Ctrl+Alt+S"] },
    { id: "agent-settings", group: "Navigation", label: "Agent settings", keys: ["Ctrl+Shift+,", "Ctrl+Alt+Shift+S"] },
    { id: "agent-dock", group: "Agent chat", label: "Floating chat", keys: ["Ctrl+K"] },
    { id: "agent-new", group: "Agent chat", label: "New thread", keys: ["Ctrl+Shift+K"] },
    { id: "agent-side", group: "Agent chat", label: "Chat sidebar", keys: ["Ctrl+L"] },
    { id: "agent-full", group: "Agent chat", label: "Full window chat", keys: ["Ctrl+Shift+L"] },
    { id: "agent-threads", group: "Agent chat", label: "Threads", keys: ["Ctrl+J"] },
    { id: "agent-model", group: "Agent chat", label: "Next favourite model", keys: ["Ctrl+'"] },
    { id: "agent-effort", group: "Agent chat", label: "Next reasoning level", keys: ["Ctrl+Alt+'"] },
    { id: "agent-mode", group: "Agent chat", label: "Next mode", keys: ["Ctrl+Shift+'"] },
    { id: "agent-workspace", group: "Agent chat", label: "Next workspace", keys: ["Ctrl+."] },
    { id: "agent-scope", group: "Agent chat", label: "Next Scribe access", keys: ["Ctrl+Shift+."] },
  ];
  var BY_ID = {};
  ACTIONS.forEach(function (a) { BY_ID[a.id] = a; });
  /** Keys the desktop app keeps for itself: they can't be given to an action. */
  var FIXED = { "Ctrl+R": "Reload", "Ctrl+Shift+R": "Reload", "F5": "Reload", "Ctrl+Shift+M": "Compact window" };

  /** event.code -> key name, for keys matched by position. */
  var CODE_KEYS = {
    Comma: ",", Period: ".", Quote: "'", Semicolon: ";", Slash: "/", Backslash: "\\", BracketLeft: "[", BracketRight: "]",
    Minus: "-", Equal: "=", Backquote: "`", IntlBackslash: "<", Space: "Space", Tab: "Tab", Enter: "Enter", Backspace: "Backspace",
    Delete: "Delete", Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
  };
  /** Key name -> Windows virtual key, for the desktop shell. Letters and digits are their ASCII codes. */
  var VK = {
    ",": 0xbc, ".": 0xbe, "'": 0xde, ";": 0xba, "/": 0xbf, "\\": 0xdc, "[": 0xdb, "]": 0xdd, "-": 0xbd, "=": 0xbb, "`": 0xc0, "<": 0xe2,
    Space: 0x20, Tab: 0x09, Enter: 0x0d, Backspace: 0x08, Delete: 0x2e, Insert: 0x2d, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
    ArrowUp: 0x26, ArrowDown: 0x28, ArrowLeft: 0x25, ArrowRight: 0x27,
  };
  /** How a key name reads in the UI. */
  var SHOWN = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", PageUp: "PgUp", PageDown: "PgDn" };

  function keyOf(event) {
    var code = event.code || "";
    var key = event.key || "";
    // Letters by the character the layout types; a non-Latin layout falls back to the key's position.
    if (/^[a-z]$/i.test(key)) return key.toUpperCase();
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    // The apostrophe key on Nordic layouts sits where US has backslash (the '* key next to Enter).
    if (code === "Backslash" && key !== "\\" && key !== "|") return "'";
    return CODE_KEYS[code] || "";
  }

  /** The binding text for a key event, or "" for a bare modifier or a key with no name. */
  function fromEvent(event) {
    var key = keyOf(event);
    if (!key) return "";
    var mods = [];
    if (event.ctrlKey || event.metaKey) mods.push("Ctrl");
    if (event.altKey) mods.push("Alt");
    if (event.shiftKey) mods.push("Shift");
    return mods.concat(key).join("+");
  }

  /** Normalise a binding's modifier order and spelling, or "" when it isn't one. */
  function normalize(text) {
    if (typeof text !== "string" || !text) return "";
    // The last part is the key (which may itself be "+").
    var parts = text.split("+");
    var key = parts.pop();
    if (key === "" && parts.length && parts[parts.length - 1] === "") { parts.pop(); key = "+"; }
    if (!key || !(/^[A-Z0-9]$/.test(key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key) || Object.prototype.hasOwnProperty.call(VK, key))) return "";
    var mods = { Ctrl: false, Alt: false, Shift: false };
    for (var i = 0; i < parts.length; i++) {
      var mod = parts[i] === "Cmd" || parts[i] === "Meta" ? "Ctrl" : parts[i];
      if (!Object.prototype.hasOwnProperty.call(mods, mod)) return "";
      mods[mod] = true;
    }
    var out = [];
    if (mods.Ctrl) out.push("Ctrl");
    if (mods.Alt) out.push("Alt");
    if (mods.Shift) out.push("Shift");
    return out.concat(key).join("+");
  }

  /** A binding may stand alone only on a function key; anything else needs Ctrl or Alt so typing is left alone. */
  function usable(binding) {
    if (!binding) return false;
    if (/(^|\+)(Ctrl|Alt)\+/.test(binding)) return true;
    return /^(Shift\+)?F([1-9]|1[0-9]|2[0-4])$/.test(binding);
  }

  var overrides = {};
  /** The preference text last loaded or saved here. */
  var saved = "";
  var table = {};
  var listeners = [];
  /** While Settings records a new key, nothing runs shortcuts (the desktop shell lets every key through). */
  var recording = false;

  function rebuild() {
    table = {};
    ACTIONS.forEach(function (a) {
      bindings(a.id).forEach(function (b) { if (!table[b]) table[b] = a.id; });
    });
  }

  /** Accept only known actions and valid bindings, so a bad preference can't break the keyboard. */
  function clean(value) {
    var out = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    Object.keys(value).forEach(function (id) {
      if (!BY_ID[id] || !Array.isArray(value[id])) return;
      var list = [];
      value[id].forEach(function (b) {
        var n = normalize(b);
        if (n && usable(n) && !FIXED[n] && list.indexOf(n) < 0) list.push(n);
      });
      out[id] = list.slice(0, 4);
    });
    return out;
  }

  function parse(text) {
    if (!text) return {};
    try { return clean(JSON.parse(text)); } catch (err) { return {}; }
  }

  function bindings(id) {
    if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id].slice();
    return BY_ID[id] ? BY_ID[id].keys.slice() : [];
  }

  function setOverrides(value) {
    overrides = clean(value);
    rebuild();
    listeners.forEach(function (fn) { try { fn(); } catch (err) { /* One listener must not stop the rest. */ } });
  }

  /** The action this key event runs, or "" (pass ids to only consider those). */
  function match(event, ids) {
    if (event.isComposing) return "";
    var id = table[fromEvent(event)] || "";
    if (id && ids && ids.indexOf(id) < 0) return "";
    return id;
  }

  /** Whether an event can be a shortcut at all: cheap enough for every keydown. */
  function maybe(event) {
    return Boolean(event.ctrlKey || event.metaKey || event.altKey || /^F([1-9]|1[0-9]|2[0-4])$/.test(event.code || ""));
  }

  function show(binding) {
    if (!binding) return "";
    var parts = binding.split("+");
    var key = parts.pop();
    if (key === "" ) { parts.pop(); key = "+"; }
    var mac = root.navigator && /Mac|iPhone|iPad/.test(root.navigator.platform || "");
    var mods = parts.map(function (m) { return mac ? ({ Ctrl: "⌘", Alt: "⌥", Shift: "⇧" })[m] : m; });
    return mods.concat(SHOWN[key] || key).join(mac ? "" : "+");
  }

  /** The first binding of an action as the UI shows it, e.g. for a tooltip; "" when it has none. */
  function label(id) {
    return show(bindings(id)[0] || "");
  }

  /** A tooltip with the action's key: "Library (Ctrl+B)", or just the text when it has none. */
  function tip(text, id) {
    var key = label(id);
    return key ? text + " (" + key + ")" : text;
  }

  /** The bindings the desktop shell catches natively, as virtual keys. */
  function nativeBindings() {
    var out = [];
    ACTIONS.forEach(function (a) {
      if (a.group === "Agent chat" && ["agent-dock", "agent-side", "agent-full"].indexOf(a.id) < 0) return;
      bindings(a.id).forEach(function (b) {
        var parts = b.split("+");
        var key = parts.pop();
        var vk = /^[A-Z0-9]$/.test(key) ? key.charCodeAt(0) : /^F\d+$/.test(key) ? 0x6f + Number(key.slice(1)) : VK[key];
        if (!vk) return;
        out.push({ action: a.id, key: vk, ctrl: parts.indexOf("Ctrl") >= 0, alt: parts.indexOf("Alt") >= 0, shift: parts.indexOf("Shift") >= 0 });
      });
    });
    return out;
  }

  rebuild();
  root.scribeKeymap = {
    PREF: PREF,
    actions: function () { return ACTIONS.map(function (a) { return { id: a.id, group: a.group, label: a.label, keys: a.keys.slice(), desktop: Boolean(a.desktop) }; }); },
    fixed: function (binding) { return FIXED[binding] || ""; },
    overrides: function () { return JSON.parse(JSON.stringify(overrides)); },
    parse: parse,
    setOverrides: setOverrides,
    bindings: bindings,
    fromEvent: fromEvent,
    normalize: normalize,
    usable: usable,
    match: match,
    maybe: maybe,
    show: show,
    label: label,
    tip: tip,
    nativeBindings: nativeBindings,
    onChange: function (fn) { listeners.push(fn); },
    isRecording: function () { return recording; },
    setRecording: function (on) {
      if (recording === Boolean(on)) return;
      recording = Boolean(on);
      listeners.forEach(function (fn) { try { fn(); } catch (err) { /* As in setOverrides. */ } });
    },
    /** Save the user's changes (the board only): { action: [binding, …] } for changed actions. */
    save: function (value) {
      setOverrides(value);
      saved = JSON.stringify(overrides);
      root.scribeAppearance && root.scribeAppearance.setItem(PREF, saved);
    },
  };
  // In the board: the saved changes, and later ones from another window or a paired device.
  if (root.scribeAppearance && root.addEventListener) {
    var load = function () {
      var text = root.scribeAppearance.getItem(PREF) || "";
      if (text === saved) return;
      saved = text;
      setOverrides(parse(text));
    };
    load();
    root.addEventListener("scribe:appearance", load);
  }
})(typeof window !== "undefined" ? window : globalThis);
