/**
 * Shared agent memory (#104, #826): the list of saved memories (titles only), the popup that adds,
 * shows and edits one, and the summary in Agent settings. Agent settings' Memories dialog and the
 * Agent harness' Memories tab both use it, so there is one design for both.
 */
(() => {
  const PROVIDER_LABEL = { claude: "Claude", cursor: "Cursor", codex: "Codex", pi: "Native" };
  const TITLE_MAX = 100;
  const TEXT_MAX = 1500;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function button(label, cls, onClick) {
    const node = el("button", cls, label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  async function api(method, path, payload) {
    const write = method !== "GET";
    const res = await fetch(`/api/agent${path}`, {
      method,
      headers: write ? { "Content-Type": "application/json" } : {},
      body: write ? JSON.stringify(payload ?? {}) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
  }

  const dirKey = (dir) => String(dir || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const byLabel = (by) => (by === "user" ? "you" : PROVIDER_LABEL[by] || by);
  const day = (at) => (at ? new Date(at).toLocaleDateString() : "");

  /** The saved memories and the provider targets, loaded once and shared by every view. */
  const store = {
    list: null,
    targets: [],
    error: "",
    views: new Set(),
    loading: null,
    load() {
      this.loading ??= api("GET", "/memories")
        .then((result) => {
          this.list = result.memories || [];
          this.targets = result.targets || [];
          this.error = "";
        })
        .catch((err) => {
          this.error = err.message;
        })
        .finally(() => {
          this.loading = null;
          this.changed();
        });
      return this.loading;
    },
    /** Views drop out once they return false (their node left the page). */
    changed() {
      for (const view of [...this.views]) if (view() === false) this.views.delete(view);
    },
  };

  const targetKey = (value) => JSON.stringify([value.provider, value.source || ""]);
  const targetLabel = (value) =>
    store.targets.find((t) => t.provider === value.provider && (t.source || "") === (value.source || ""))?.label ||
    `${PROVIDER_LABEL[value.provider] || value.provider}${value.source ? `: ${value.source}` : ""}`;

  /** Where a memory applies: a group key, its heading, and the order groups are shown in. */
  function placeOf(memory) {
    if (memory.scope === "provider") return { key: `provider:${targetKey(memory)}`, label: `${targetLabel(memory)} only`, order: 2 };
    if (memory.workspace) return { key: `workspace:${dirKey(memory.workspace)}`, label: memory.workspace, path: true, order: 1 };
    return { key: "", label: "Every chat", order: 0 };
  }

  /** The value the "Applies to" picker uses for a memory or draft. */
  const placeValue = (value) => (value.scope === "provider" ? `provider:${targetKey(value)}` : value.workspace ? `workspace:${value.workspace}` : "");

  function placeBody(value) {
    if (value.startsWith("provider:")) {
      const [provider, source] = JSON.parse(value.slice(9));
      return { scope: "provider", provider, ...(source ? { source } : {}) };
    }
    return { workspace: value.startsWith("workspace:") ? value.slice(10) : null };
  }

  /** The agent chat's modal when it is there (it keeps Escape in order); a plain one otherwise. */
  function openModal(cls) {
    const shared = window.scribeChat?.modal;
    if (shared) return shared(cls);
    const root = el("div", `ag-modal ${cls}`);
    const backdrop = el("div", "ag-modal-backdrop");
    const panel = el("div", "ag-modal-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    root.append(backdrop, panel);
    let release = null;
    const close = () => {
      release?.();
      root.remove();
    };
    backdrop.addEventListener("mousedown", (event) => {
      event.preventDefault();
      close();
    });
    panel.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    });
    document.body.append(root);
    requestAnimationFrame(() => root.isConnected && (release = window.scribeFocusTrap?.bind(panel)));
    return { root, panel, close };
  }

  /**
   * Add (memory null) or show and edit one memory in its own popup.
   * opts.here is the workspace a new memory starts in; opts.workspaces() lists more folders to offer.
   */
  function edit(memory, opts = {}) {
    const { panel, close } = openModal("ag-source ag-memory-edit");
    panel.setAttribute("aria-label", memory ? "Memory" : "New memory");
    // The themed picker is a button beside a hidden select, so its field is not a <label>.
    const field = (label, control, hint, tag = "label") => {
      const wrap = el(tag, "ag-field");
      const caption = el("span", "ag-field-label", label);
      if (hint) {
        caption.classList.add("ag-hinted");
        caption.dataset.tooltip = hint;
        caption.setAttribute("aria-description", hint);
      }
      control.setAttribute("aria-label", label);
      wrap.append(caption, control);
      return wrap;
    };

    const title = el("input", "ag-input ag-memory-title-input");
    title.value = memory?.title || "";
    title.maxLength = TITLE_MAX;
    title.placeholder = "A few words, e.g. Tests run with npm test";
    const text = el("textarea", "ag-input ag-memory-text-input");
    text.rows = 7;
    text.value = memory?.text || "";
    text.maxLength = TEXT_MAX;
    text.placeholder = "What a later chat should know, e.g. Run the tests with npm test, not pnpm: the lockfile is npm's.";

    const scope = el("select", "hx-select");
    const dirs = [
      ...new Map(
        [memory?.workspace, opts.here, ...(opts.workspaces?.() || []), ...(store.list || []).map((m) => m.workspace)]
          .filter(Boolean)
          .map((dir) => [dirKey(dir), dir])
      ).values(),
    ];
    scope.append(new Option("Every chat", ""));
    for (const dir of dirs) scope.append(new Option(dir, `workspace:${dir}`));
    for (const target of store.targets) scope.append(new Option(`${target.label} only`, `provider:${targetKey(target)}`));
    scope.value = memory ? placeValue(memory) : opts.here ? `workspace:${dirs.find((d) => dirKey(d) === dirKey(opts.here)) || opts.here}` : "";

    const error = el("p", "ag-source-error");
    error.hidden = true;
    const fail = (message) => {
      error.textContent = message;
      error.hidden = false;
    };

    const save = async () => {
      if (!title.value.trim()) return title.focus();
      if (!text.value.trim()) return text.focus();
      const body = { title: title.value, text: text.value, ...placeBody(scope.value) };
      try {
        await api(memory ? "PUT" : "POST", memory ? `/memories/${memory.id}` : "/memories", body);
      } catch (err) {
        return fail(err.message);
      }
      close();
      await store.load();
    };
    for (const box of [title, text]) {
      box.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey || box === title)) {
          event.preventDefault();
          void save();
        }
      });
    }

    const actions = el("div", "ag-modal-actions");
    if (memory) {
      // A second click deletes, so a stray one does not.
      const remove = button("Delete", "ag-btn ghost danger", async () => {
        if (!remove.classList.contains("armed")) {
          remove.classList.add("armed");
          remove.textContent = "Delete for good";
          return;
        }
        try {
          await api("DELETE", `/memories/${memory.id}`);
        } catch (err) {
          return fail(err.message);
        }
        close();
        await store.load();
      });
      actions.append(remove);
    }
    actions.append(el("span", "ag-grow"), button("Cancel", "ag-btn ghost", close), button(memory ? "Save" : "Add", "ag-btn primary", () => void save()));

    const head = [el("h2", "ag-modal-title", memory ? "Memory" : "New memory")];
    if (memory) head.push(el("p", "ag-modal-hint", `Saved by ${byLabel(memory.by)}, ${day(memory.updatedAt)}`));
    const scopeField = field("Applies to", scope, "Every chat, chats in a workspace folder and below it, or only one provider's chats (Native: one model source).", "div");
    panel.append(...head, field("Title", title), field("Memory", text), scopeField, error, actions);
    // The themed select wraps the element where it sits, so it has to be in the panel first.
    window.createSelect?.(scope);
    (memory ? text : title).focus();
  }

  /** The saved memories by where they apply, one line (the title) each; a click opens it. */
  function browser(opts = {}) {
    const node = el("div", "ag-memory");
    const bar = el("div", "ag-memory-bar");
    const search = el("input", "ag-input ag-memory-search");
    search.type = "search";
    search.placeholder = "Search memories";
    search.setAttribute("aria-label", "Search memories");
    search.addEventListener("input", () => render());
    bar.append(search, button("Add memory", "ag-btn primary", () => edit(null, opts)));
    const off = el("p", "ag-source-error");
    const list = el("div", "ag-memory-groups");
    node.append(bar, off, list);

    function row(memory) {
      const item = button("", "ag-memory-row", () => edit(memory, opts));
      const name = el("span", `ag-memory-name${memory.title ? "" : " untitled"}`, memory.title || memory.text.split("\n")[0]);
      item.append(name, el("span", "ag-memory-date", day(memory.updatedAt)));
      return item;
    }

    function render() {
      if (!node.isConnected && node.dataset.shown) return false;
      off.textContent = opts.off?.() ? "Memory is off in Agent settings: chats get none of these and cannot save any." : "";
      off.hidden = !off.textContent;
      if (!store.list) {
        list.replaceChildren(el("p", "ag-muted", store.error || "Loading…"));
        return true;
      }
      node.dataset.shown = "1";
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      const shown = store.list.filter((m) => words.every((w) => `${m.title || ""} ${m.text}`.toLowerCase().includes(w)));
      const groups = new Map();
      for (const memory of [...shown].sort((a, b) => b.updatedAt - a.updatedAt)) {
        const place = placeOf(memory);
        if (!groups.has(place.key)) groups.set(place.key, { ...place, items: [] });
        groups.get(place.key).items.push(memory);
      }
      const ordered = [...groups.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
      list.replaceChildren(
        ...(ordered.length ? [] : [el("p", "ag-muted", store.list.length ? "No memory matches." : "Nothing saved yet.")]),
        ...ordered.map((group) => {
          const box = el("section", "ag-memory-group");
          const head = el("h4", `ag-memory-group-head${group.path ? " path" : ""}`);
          head.append(el("span", null, group.label), el("span", "ag-memory-count", String(group.items.length)));
          box.append(head, ...group.items.map(row));
          return box;
        })
      );
      return true;
    }

    store.views.add(render);
    render();
    void store.load();
    return node;
  }

  /** What is saved, at a glance: counts by where memories apply and who saved them. */
  function stats(opts = {}) {
    const node = el("div", "ag-keys ag-memory-stats");
    // Agent settings keeps one and shows it again, so it stays subscribed while detached.
    const render = () => {
      const list = store.list;
      if (!list) {
        node.replaceChildren(el("span", null, store.error || "Loading…"));
        return true;
      }
      const rows = [];
      const add = (label, value) => rows.push(el("span", null, label), el("span", "ag-memory-stat", value));
      const count = (filter) => list.filter(filter).length;
      const folders = new Set(list.filter((m) => m.workspace).map((m) => dirKey(m.workspace)));
      const tally = (key) => {
        const by = new Map();
        for (const m of list) {
          const name = key(m);
          if (name) by.set(name, (by.get(name) || 0) + 1);
        }
        return [...by].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`).join(", ");
      };
      add("Saved", list.length ? `${list.length} ${list.length === 1 ? "memory" : "memories"}` : "None yet");
      if (list.length) {
        add("Every chat", String(count((m) => m.scope === "global")));
        const inFolders = count((m) => m.scope === "workspace");
        add("Workspaces", inFolders ? `${inFolders} in ${folders.size} ${folders.size === 1 ? "folder" : "folders"}` : "0");
        add("One provider", tally((m) => (m.scope === "provider" ? targetLabel(m) : "")) || "0");
        add("Saved by", tally((m) => byLabel(m.by)));
        const newest = [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        add("Last change", `${day(newest.updatedAt)}: ${newest.title || newest.text.split("\n")[0]}`);
        const untitled = count((m) => !m.title);
        if (untitled) add("Untitled", String(untitled));
      }
      node.replaceChildren(...rows);
      return true;
    };
    store.views.add(render);
    render();
    if (opts.load !== false) void store.load();
    return node;
  }

  window.scribeMemories = { store, browser, edit, stats };
})();
