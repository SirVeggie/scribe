/**
 * Shared agent memory (#104, #826, #840): the list of saved memories (titles only) and the popup
 * that adds, shows and edits one. Agent settings' Memory section and the Agent harness' Memories
 * tab both use it, so there is one design for both.
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
    const provider = memory.scope === "provider";
    if (provider && memory.workspace) return { key: `both:${targetKey(memory)}:${dirKey(memory.workspace)}`, label: `${targetLabel(memory)} only, in ${memory.workspace}`, path: true, order: 3 };
    if (provider) return { key: `provider:${targetKey(memory)}`, label: `${targetLabel(memory)} only`, order: 2 };
    if (memory.workspace) return { key: `workspace:${dirKey(memory.workspace)}`, label: memory.workspace, path: true, order: 1 };
    return { key: "", label: "Every chat", order: 0 };
  }

  /** The provider picker's value for a memory: "" for every provider. */
  const providerValue = (value) => (value.scope === "provider" ? targetKey(value) : "");

  function providerBody(value) {
    if (!value) return {};
    const [provider, source] = JSON.parse(value);
    return { scope: "provider", provider, ...(source ? { source } : {}) };
  }

  /** Whether a chat in `dir` (null: any) on `target` (a providerValue, "": any) gets the memory. */
  function reaches(memory, dir, target) {
    if (target && memory.scope === "provider" && targetKey(memory) !== target) return false;
    if (dir && memory.workspace) {
      const at = dirKey(dir);
      const home = dirKey(memory.workspace);
      if (at !== home && !at.startsWith(`${home}/`)) return false;
    }
    return true;
  }

  /** About what a memory costs in a chat's instructions: its line in the memory block, at 4 characters a token. */
  const memoryTokens = (memory) => Math.ceil((40 + (memory.title || "").length + memory.text.length) / 4);

  /** Workspace folders to offer: the caller's (recent ones) and those memories already use, without repeats. */
  function folders(extra = []) {
    return [
      ...new Map(
        [...extra, ...(store.list || []).map((m) => m.workspace)]
          .filter(Boolean)
          .map((dir) => [dirKey(dir), dir])
      ).values(),
    ];
  }

  /** Fill a select with options ([value, label]) and keep its value when it is still there. */
  function fill(select, options, fallback = "") {
    const value = select.value;
    select.replaceChildren(...options.map(([v, label]) => new Option(label, v)));
    select.value = options.some(([v]) => v === value) ? value : fallback;
    select.parentElement?.syncSelect?.();
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
   * A new one applies to every chat until the user picks a workspace or provider; opts.workspaces()
   * lists the folders to offer besides those memories already use.
   */
  function edit(memory, opts = {}) {
    const { panel, close } = openModal("ag-source ag-memory-edit");
    panel.setAttribute("aria-label", memory ? "Memory" : "New memory");
    // The themed picker is a button beside a hidden select, so its field is not a <label>.
    const field = (label, control, tag = "label") => {
      const wrap = el(tag, "ag-field");
      control.setAttribute("aria-label", label);
      wrap.append(el("span", "ag-field-label", label), control);
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

    const workspace = el("select");
    fill(workspace, [["", "Every workspace"], ...folders([memory?.workspace, ...(opts.workspaces?.() || [])]).map((dir) => [dir, dir])]);
    workspace.value = memory?.workspace || "";
    const provider = el("select");
    fill(provider, [["", "Every provider"], ...store.targets.map((t) => [targetKey(t), `${t.label} only`])]);
    provider.value = memory ? providerValue(memory) : "";

    const error = el("p", "ag-source-error");
    error.hidden = true;
    const fail = (message) => {
      error.textContent = message;
      error.hidden = false;
    };

    const save = async () => {
      if (!title.value.trim()) return title.focus();
      if (!text.value.trim()) return text.focus();
      const body = { title: title.value, text: text.value, workspace: workspace.value || null, ...providerBody(provider.value) };
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
    const place = el("div", "ag-memory-place");
    place.append(field("Workspace", workspace, "div"), field("Provider", provider, "div"));
    panel.append(...head, field("Title", title), field("Memory", text), place, error, actions);
    // The themed select wraps the element where it sits, so it has to be in the panel first.
    window.createSelect?.(workspace);
    window.createSelect?.(provider);
    (memory ? text : title).focus();
  }

  /**
   * The saved memories by where they apply, one line (the title) each; a click opens it. The
   * workspace and provider filters keep what a chat there gets, with its rough token cost.
   * opts.keep keeps it subscribed while detached (Agent settings keeps one and shows it again).
   */
  function browser(opts = {}) {
    const node = el("div", "ag-memory");
    const bar = el("div", "ag-memory-bar");
    const search = el("input", "ag-input ag-memory-search");
    search.type = "search";
    search.placeholder = "Search memories";
    search.setAttribute("aria-label", "Search memories");
    search.addEventListener("input", () => render());
    const workspace = el("select");
    workspace.setAttribute("aria-label", "Workspace");
    const provider = el("select");
    provider.setAttribute("aria-label", "Provider");
    for (const select of [workspace, provider]) select.addEventListener("change", () => render());
    const filters = el("div", "ag-memory-filters");
    filters.append(workspace, provider);
    bar.append(search, button("Add memory", "ag-btn primary", () => edit(null, opts)));
    const off = el("p", "ag-source-error");
    const total = el("p", "ag-memory-total");
    const list = el("div", "ag-memory-groups");
    node.append(bar, filters, off, total, list);
    window.createSelect?.(workspace);
    window.createSelect?.(provider);

    function row(memory) {
      const item = button("", "ag-memory-row", () => edit(memory, opts));
      const name = el("span", `ag-memory-name${memory.title ? "" : " untitled"}`, memory.title || memory.text.split("\n")[0]);
      item.append(name, el("span", "ag-memory-date", day(memory.updatedAt)));
      return item;
    }

    function render() {
      if (!opts.keep && !node.isConnected && node.dataset.shown) return false;
      off.textContent = opts.off?.() ? "Memory is off in Agent settings: chats get none of these and cannot save any." : "";
      off.hidden = !off.textContent;
      fill(workspace, [["", "All workspaces"], ...folders(opts.workspaces?.() || []).map((dir) => [dir, dir])]);
      fill(provider, [["", "All providers"], ...store.targets.map((t) => [targetKey(t), t.label])]);
      if (!store.list) {
        total.hidden = true;
        list.replaceChildren(el("p", "ag-muted", store.error || "Loading…"));
        return true;
      }
      node.dataset.shown = "1";
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      const shown = store.list.filter(
        (m) => reaches(m, workspace.value || null, provider.value) && words.every((w) => `${m.title || ""} ${m.text}`.toLowerCase().includes(w))
      );
      const tokens = shown.reduce((sum, m) => sum + memoryTokens(m), 0);
      total.textContent = `${shown.length} ${shown.length === 1 ? "memory" : "memories"} · ≈ ${tokens.toLocaleString()} tokens`;
      total.hidden = !shown.length;
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

  window.scribeMemories = { store, browser, edit };
})();
