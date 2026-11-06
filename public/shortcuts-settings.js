/** Settings -> Shortcuts: remap the app's keyboard shortcuts (#1022). The table is public/keymap.js. */
(() => {
  "use strict";
  const keymap = window.scribeKeymap;
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const actions = keymap.actions();

  const sections = [];
  const groups = new Map();
  for (const action of actions) {
    if (!groups.has(action.group)) {
      const section = document.createElement("section");
      section.className = "settings-section shortcut-settings";
      const heading = document.createElement("h3");
      heading.textContent = action.group;
      const list = document.createElement("div");
      section.append(heading, list);
      if (!sections.length) {
        const hint = document.createElement("p");
        hint.className = "settings-hint";
        hint.textContent = "Click a key to change it, then press the new keys. Backspace removes it.";
        section.insertBefore(hint, list);
      }
      groups.set(action.group, list);
      sections.push(section);
    }
  }
  const footer = document.createElement("div");
  footer.className = "shortcut-footer";
  const status = document.createElement("p");
  status.className = "settings-hint";
  status.setAttribute("role", "status");
  const resetAll = document.createElement("button");
  resetAll.type = "button";
  resetAll.textContent = "Reset all";
  resetAll.addEventListener("click", () => {
    stopRecording();
    keymap.save({});
    say("All shortcuts are back to their defaults.");
  });
  footer.append(status, resetAll);
  sections[sections.length - 1].append(footer);

  let statusTimer = 0;
  function say(text) {
    status.textContent = text;
    clearTimeout(statusTimer);
    if (text) statusTimer = setTimeout(() => { status.textContent = ""; }, 6000);
  }

  /** Save every action's bindings, keeping an override only where they differ from the defaults. */
  function commit(next) {
    const overrides = {};
    for (const action of actions) {
      if (!same(next[action.id], action.keys)) overrides[action.id] = next[action.id];
    }
    keymap.save(overrides);
  }
  const current = () => Object.fromEntries(actions.map((a) => [a.id, keymap.bindings(a.id)]));

  /** Put `binding` at `index` of the action's keys (index past the end adds it); "" removes that key. */
  function assign(action, index, binding) {
    const next = current();
    const list = next[action.id];
    if (!binding) {
      list.splice(index, 1);
      commit(next);
      say(list.length ? "" : `${action.label} has no shortcut now.`);
      return;
    }
    const fixed = keymap.fixed(binding);
    if (fixed) return say(`${keymap.show(binding)} is kept for ${fixed}.`);
    if (!keymap.usable(binding)) return say("Use Ctrl or Alt with a key, or a function key.");
    let moved = "";
    for (const other of actions) {
      const at = next[other.id].indexOf(binding);
      if (at < 0 || (other.id === action.id && at === index)) continue;
      next[other.id].splice(at, 1);
      if (other.id === action.id && at < index) index -= 1;
      if (other.id !== action.id) moved = other.label;
    }
    if (index >= list.length) list.push(binding);
    else list[index] = binding;
    commit(next);
    say(moved ? `${keymap.show(binding)} moved here from ${moved}.` : "");
  }

  /* ---------- recording ---------- */
  let recording = null;
  /** The key button to focus again once the list is drawn anew. */
  let refocus = "";
  function startRecording(button, action, index) {
    stopRecording();
    recording = { button, action, index };
    button.classList.add("recording");
    button.textContent = "Press keys…";
    keymap.setRecording(true);
    window.addEventListener("keydown", onRecordKey, true);
    button.addEventListener("blur", stopRecording, { once: true });
  }
  function stopRecording() {
    if (!recording) return;
    window.removeEventListener("keydown", onRecordKey, true);
    const { button } = recording;
    recording = null;
    keymap.setRecording(false);
    button.classList.remove("recording");
    render();
  }
  function onRecordKey(event) {
    if (!recording) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(event.key)) return;
    const { action, index } = recording;
    refocus = `${action.id}:${index}`;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    if (plain && event.key === "Escape") return stopRecording();
    if (plain && (event.key === "Backspace" || event.key === "Delete")) {
      stopRecording();
      if (index < keymap.bindings(action.id).length) assign(action, index, "");
      return;
    }
    if (plain && event.key === "Tab") return stopRecording();
    const binding = keymap.fromEvent(event);
    if (!binding) return;
    stopRecording();
    assign(action, index, binding);
  }

  /* ---------- rows ---------- */
  function keyButton(action, index, binding) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "shortcut-key" + (binding ? "" : " shortcut-add");
    button.dataset.slot = `${action.id}:${index}`;
    button.textContent = binding ? keymap.show(binding) : "+";
    button.setAttribute("aria-label", binding ? `${action.label}: ${keymap.show(binding)}. Change` : `Add a shortcut for ${action.label}`);
    button.addEventListener("click", () => {
      if (recording?.button === button) stopRecording();
      else startRecording(button, action, index);
    });
    return button;
  }

  function render() {
    if (recording) return;
    // Drawing anew drops focus: keep it on the same key button.
    const active = document.activeElement;
    if (!refocus && active?.dataset?.slot && sections.some((section) => section.contains(active))) refocus = active.dataset.slot;
    for (const list of groups.values()) list.replaceChildren();
    for (const action of actions) {
      const keys = keymap.bindings(action.id);
      const row = document.createElement("div");
      row.className = "setting-row";
      const label = document.createElement("span");
      label.textContent = action.label;
      const keysEl = document.createElement("div");
      keysEl.className = "shortcut-keys";
      keys.forEach((binding, i) => keysEl.append(keyButton(action, i, binding)));
      if (keys.length < 2) keysEl.append(keyButton(action, keys.length, ""));
      if (!same(keys, action.keys)) {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "shortcut-reset";
        reset.textContent = "↺";
        reset.setAttribute("aria-label", `Reset ${action.label}`);
        reset.dataset.tooltip = `Reset to ${action.keys.map(keymap.show).join(", ") || "none"}`;
        reset.addEventListener("click", () => {
          const next = current();
          next[action.id] = [];
          commit(next);
          for (const binding of action.keys) assign(action, keymap.bindings(action.id).length, binding);
        });
        keysEl.append(reset);
      }
      row.append(label, keysEl);
      groups.get(action.group).append(row);
    }
    resetAll.disabled = !Object.keys(keymap.overrides()).length;
    if (refocus) {
      const [id, index] = refocus.split(":");
      refocus = "";
      const row = [...groups.values()].flatMap((list) => [...list.querySelectorAll(".shortcut-key")]);
      (row.find((b) => b.dataset.slot === `${id}:${index}`) || row.filter((b) => b.dataset.slot.startsWith(id + ":")).pop())?.focus();
    }
  }
  keymap.onChange(render);
  render();

  window.scribeShortcutSettings = { sections };
})();
