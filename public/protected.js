/**
 * Protected data in the board window (#1046): the values (the user's own, never an agent's), blurred
 * spans across the board and chats, their right-click actions, the add/edit popup, and Settings →
 * Protected data. Built-in pages get their own values through the bridge (scribe.protect) and send
 * their right-clicks here. Removing a value only stops hiding it from then on.
 */
(() => {
  "use strict";
  const mark = window.scribeProtectedMark;
  const KINDS = ["secret", "password", "api key", "token", "phone number", "email", "address", "name", "personal", "other"];
  const SOURCE = { user: "you", agent: "agent", detector: "detector" };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };
  const button = (label, run, cls) => {
    const node = el("button", cls, label);
    node.type = "button";
    node.addEventListener("click", run);
    return node;
  };

  async function api(method, path = "", body) {
    const res = await fetch(`/api/vault${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  /** The values and their metadata; views redraw from here. */
  const store = {
    values: [],
    meta: [],
    matcher: null,
    error: "",
    views: new Set(),
    loading: null,
    load() {
      this.loading ??= Promise.all([api("GET", "/values"), api("GET")])
        .then(([values, meta]) => {
          this.values = values.fragments || [];
          this.meta = meta.fragments || [];
          this.matcher = mark.compile(this.values);
          this.error = "";
        })
        .catch((err) => {
          this.error = err.message;
        })
        .finally(() => {
          this.loading = null;
          for (const view of [...this.views]) if (view() === false) this.views.delete(view);
        });
      return this.loading;
    },
    get(id) {
      return this.values.find((f) => f.id === id) || null;
    },
  };

  /* ---------- blurred spans in the board window ---------- */

  let watcher = null;
  store.views.add(() => {
    if (!watcher && document.body) watcher = mark.watch(document.body, () => store.matcher);
    else watcher?.refresh();
  });

  /** Tell built-in pages the values changed, so they fetch theirs again. */
  function nudgePages() {
    const app = window.scribeApp;
    for (const id of app?.shownIds?.() || []) app.postToPage(id, { type: "scribe-protected-changed" });
  }

  /* ---------- the add / edit popup ---------- */

  /**
   * Add a value (fragment null, value given) or edit one. withValue shows the value field (Settings);
   * from a span or a selection the value is what was clicked.
   */
  function edit({ fragment = null, value = "", withValue = false, focus = "hint" } = {}) {
    const dialog = el("dialog", "confirm folder-instructions protected-edit");
    dialog.setAttribute("aria-label", fragment ? "Protected value" : "Protect text");
    const form = el("form");
    form.method = "dialog";
    const field = (label, control) => {
      const wrap = el("label", "folder-instructions-field");
      wrap.append(el("span", "ag-field-label", label), control);
      return wrap;
    };
    const valueInput = el("textarea", "ag-input protected-edit-value");
    valueInput.rows = 2;
    valueInput.value = fragment ? store.get(fragment.id)?.value || "" : value;
    valueInput.spellcheck = false;
    const hint = el("input", "ag-input");
    hint.maxLength = 40;
    hint.value = fragment?.hint || "";
    hint.placeholder = "What agents see instead, e.g. phone number";
    const kind = el("select");
    const kinds = fragment && !KINDS.includes(fragment.kind) ? [fragment.kind, ...KINDS] : KINDS;
    for (const k of kinds) kind.append(new Option(k, k));
    kind.value = fragment?.kind || "secret";
    const error = el("p", "ag-source-error");
    error.hidden = true;

    const fields = [];
    if (withValue || !fragment) fields.push(field("Value", valueInput));
    if (!withValue && !fragment) valueInput.readOnly = true;
    fields.push(field("Hint", hint));
    const kindField = el("div", "folder-instructions-field");
    kindField.append(el("span", "ag-field-label", "Kind"), kind);
    fields.push(kindField);

    const actions = el("div", "confirm-actions");
    const cancel = el("button", null, "Cancel");
    cancel.value = "cancel";
    const save = el("button", "primary", fragment ? "Save" : "Protect");
    save.type = "submit";
    save.value = "save";
    actions.append(cancel, save);
    form.append(el("h2", null, fragment ? "Protected value" : "Protect text"), ...fields, error, actions);
    dialog.append(form);
    document.body.append(dialog);
    window.createSelect?.(kind);
    dialog.addEventListener("close", () => dialog.remove());
    form.addEventListener("submit", async (event) => {
      if (event.submitter?.value !== "save") return;
      event.preventDefault();
      save.disabled = true;
      try {
        if (fragment) {
          const body = { hint: hint.value, kind: kind.value };
          if (withValue && valueInput.value !== store.get(fragment.id)?.value) body.value = valueInput.value;
          await api("PATCH", `/${fragment.id}`, body);
        } else {
          await api("POST", "/protect", { value: valueInput.value, hint: hint.value, kind: kind.value });
        }
        dialog.close();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        save.disabled = false;
      }
    });
    dialog.showModal();
    (focus === "value" ? valueInput : hint).focus();
  }

  /** Stop protecting a value. What agents read before keeps its placeholder; only later reads change. */
  async function unprotect(id) {
    const fragment = store.meta.find((f) => f.id === id) || store.get(id);
    if (!fragment) return;
    const ok = await window.scribeApp?.confirm?.(
      `Stop protecting “${fragment.hint}”? Agents see it in what they read from now on. Text they already read keeps the placeholder.`,
      "Unprotect"
    );
    if (ok === false) return;
    try {
      await api("DELETE", `/${id}`);
    } catch (err) {
      window.scribeApp?.showNotice?.(err.message);
    }
  }

  /** The menu items for a right-click on a protected span (its id) or on selected text. */
  function menuItems({ id = "", selection = "" } = {}) {
    const fragment = id ? store.meta.find((f) => f.id === id) || store.get(id) : null;
    const items = [];
    if (fragment) {
      items.push(
        { label: "Edit hint", action: () => edit({ fragment }) },
        { label: "Unprotect", action: () => void unprotect(fragment.id) }
      );
    }
    const text = selection.trim();
    if (text && !fragment && !/[⟦⟧]/.test(text)) items.push({ label: "Protect selection", action: () => edit({ value: text }) });
    return items;
  }

  // In the board window: right-click on a span, or on text selected in a chat, gets these actions.
  window.addEventListener(
    "contextmenu",
    (event) => {
      if (event.shiftKey || !(event.target instanceof Element)) return;
      if (event.target.closest("input, textarea, [contenteditable]:not([contenteditable='false']), iframe")) return;
      const span = event.target.closest(`.${mark.CLASS}`);
      const selection = String(window.getSelection?.() || "");
      const inChat = event.target.closest(".ag-transcript");
      if (!span && !(selection.trim() && inChat)) return;
      const items = menuItems({ id: span?.dataset.scribeProtected || "", selection: span ? "" : selection });
      if (!items.length || !window.scribeApp?.openMenu) return;
      event.preventDefault();
      event.stopPropagation();
      if (!span) items.unshift({ label: "Copy", action: () => navigator.clipboard?.writeText(selection) }, "sep");
      window.scribeApp.openMenu({ x: event.clientX, y: event.clientY }, items);
    },
    true
  );

  /* ---------- Settings → Protected data ---------- */

  const section = el("section", "settings-section protected-settings");
  section.dataset.scribeProtectSkip = "";
  section.append(el("h3", null, "Protected data"));
  section.append(
    el(
      "p",
      "settings-hint",
      "Agents see a hint in place of each value, in pages, cards and chats they read. Removing one only stops that from now on."
    )
  );
  const bar = el("div", "protected-bar");
  const search = el("input", "ag-input protected-search");
  search.type = "search";
  search.placeholder = "Search hints and kinds";
  search.setAttribute("aria-label", "Search protected values");
  search.addEventListener("input", () => render());
  bar.append(search, button("Add value", () => edit({ withValue: true, focus: "value" }), "primary"));
  const status = el("p", "settings-hint");
  status.setAttribute("role", "status");
  const list = el("div", "protected-list");
  section.append(bar, status, list);
  const shown = new Set();

  const day = (at) => (at ? new Date(at).toLocaleDateString() : "");
  const dots = (value) => "•".repeat(Math.min(12, Math.max(6, value.length)));

  function row(meta) {
    const value = store.get(meta.id)?.value || "";
    const item = el("div", "protected-row");
    const head = el("div", "protected-head");
    head.append(el("strong", "protected-hint", meta.hint), el("span", "protected-kind", meta.kind));
    const source = meta.source === "detector" && meta.detector ? `detector ${meta.detector}` : SOURCE[meta.source] || meta.source;
    const by = meta.source === "agent" && meta.createdBy ? `${meta.createdBy} (agent)` : meta.source === "user" ? "you" : source;
    const facts = el("div", "protected-meta", `Added by ${by}, ${day(meta.createdAt)}`);
    const open = shown.has(meta.id);
    const valueBox = el("div", "protected-value");
    const text = el("code", open ? "" : "masked", open ? value : dots(value));
    const reveal = button(open ? "Hide" : "Show", () => {
      if (shown.has(meta.id)) shown.delete(meta.id);
      else shown.add(meta.id);
      render();
    }, "protected-reveal");
    reveal.setAttribute("aria-label", `${open ? "Hide" : "Show"} ${meta.hint}`);
    valueBox.append(text, reveal);
    const where = el("div", "protected-where");
    if (!meta.pages) where.textContent = "Not on any page now";
    else {
      where.append(`On ${meta.pages} ${meta.pages === 1 ? "page" : "pages"}: `);
      (meta.where || []).forEach((page, i) => {
        if (i) where.append(", ");
        const link = button(page.title || page.id, () => window.scribeApp?.selectTab?.(page.id), "protected-page");
        where.append(link);
      });
      if (meta.pages > (meta.where || []).length) where.append(", …");
    }
    const actions = el("div", "protected-actions");
    actions.append(
      button("Edit", () => edit({ fragment: meta, withValue: true })),
      button("Delete", () => void unprotect(meta.id), "danger")
    );
    item.append(head, valueBox, facts, where, actions);
    return item;
  }

  function render() {
    if (store.error) status.textContent = store.error;
    else status.textContent = store.meta.length ? "" : "Nothing protected yet. Right-click selected text in a chat or page to protect it.";
    status.hidden = !status.textContent;
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = [...store.meta]
      .sort((a, b) => b.createdAt - a.createdAt)
      .filter((m) => words.every((w) => `${m.hint} ${m.kind} ${m.source} ${m.detector || ""} ${m.createdBy}`.toLowerCase().includes(w)));
    list.replaceChildren(...rows.map(row));
    if (store.meta.length && !rows.length) list.append(el("p", "settings-hint", "No value matches."));
  }
  store.views.add(() => {
    render();
    nudgePages();
  });

  void store.load();

  window.scribeProtected = {
    sections: [section],
    store,
    menuItems,
    edit,
    /** The vault changed somewhere (a socket event). */
    changed: () => void store.load(),
  };
})();
