/**
 * Spaces: named sets of tabs (src/spaces.ts). The chip beside the logo names the current space;
 * it, or Ctrl+E, fades the board away to the space cards. Picking one swaps the whole strip.
 * Ctrl+Shift+PageUp / PageDown switches to the previous / next space without the overview.
 */
window.createSpaces = function createSpaces(host) {
  const COLORS = {
    slate: "#9aa3b5",
    blue: "#6ea8fe",
    teal: "#4fd1c5",
    green: "#7bd88f",
    amber: "#f2c46d",
    orange: "#f4a261",
    red: "#ef7d7d",
    pink: "#f58fc7",
    violet: "#b39dfa",
  };
  const STRIP_CHIPS = 6;
  const ICONS = {
    spaces:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.4" fill="currentColor"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="9" width="5.5" height="5.5" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    more: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>',
    plus: '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    pin: '<svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true"><path d="M9.6 1.4l5 5-1.4 1.4-.9-.2-2.3 2.3.2 2.5-1.5 1.5-2.4-2.4-3.1 3.1-.8-.8 3.1-3.1-2.4-2.4 1.5-1.5 2.5.2 2.3-2.3-.2-.9z" fill="currentColor"/></svg>',
    restore:
      '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M3 7.5A5 5 0 1 1 4.6 11.4M3 3.5v4h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  /** @type {{ spaces: Array<any>, activeId: string | null, deleted: Array<any> }} */
  let data = { spaces: [], activeId: null, deleted: [] };
  let open = false;
  let selected = 0;
  /** Space id whose name is being edited. */
  let renaming = null;
  let menu = null;
  let drag = null;
  let busy = false;
  // Set while a switch is on its way: the overview closes on the old view rather than redrawing the new one (#65).
  let switching = false;
  let animTimer = 0;

  /* ---------- DOM ---------- */

  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "space-chip";
  chip.setAttribute("aria-label", "Spaces");
  chip.setAttribute("aria-haspopup", "dialog");
  chip.addEventListener("click", () => toggle());
  host.chipSlot.after(chip);

  const root = el("div", "spaces");
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Spaces");
  const inner = el("div", "spaces-inner");
  const head = el("div", "spaces-head");
  const heading = el("h1", "spaces-title", "Spaces");
  const sub = el("p", "spaces-sub", "Each space keeps its own tabs. Pages stay in the Library.");
  head.append(heading, sub);
  const grid = el("div", "spaces-grid");
  grid.setAttribute("role", "listbox");
  grid.setAttribute("aria-label", "Spaces");
  const deletedRow = el("div", "spaces-deleted");
  const keys = el("div", "spaces-keys");
  keys.innerHTML =
    "<span><kbd>←</kbd><kbd>→</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>1</kbd>–<kbd>9</kbd> jump</span>" +
    "<span><kbd>N</kbd> new</span><span><kbd>F2</kbd> rename</span><span><kbd>Del</kbd> delete</span>" +
    "<span><kbd>Ctrl</kbd>+<kbd>Z</kbd> undo delete</span><span><kbd>Esc</kbd> back</span>";
  inner.append(head, grid, deletedRow, keys);
  root.append(inner);
  document.body.append(root);

  root.addEventListener("pointerdown", (event) => {
    if (menu && !menu.el.contains(event.target)) {
      closeMenu();
    }
    if (event.target === root || event.target === inner) {
      close();
    }
  });

  /* ---------- data ---------- */

  function apply(view) {
    if (!view || !Array.isArray(view.spaces)) {
      return;
    }
    data = { spaces: view.spaces, activeId: view.activeId ?? null, deleted: Array.isArray(view.deleted) ? view.deleted : [] };
    selected = Math.min(selected, Math.max(0, data.spaces.length - 1));
    renderChip();
    // Not while a name is being typed: a redraw would replace the input.
    if (open && !drag && !renaming && !switching) {
      render();
    }
  }

  function current() {
    return data.spaces.find((space) => space.id === data.activeId) || null;
  }

  async function call(method, url, body) {
    // The server only hears of tab clicks through this: a switch saves the tab in front (#74).
    const focused = host.focusedTab?.();
    if (focused) {
      body = { ...body, focused };
    }
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    apply(json);
    return json;
  }

  async function run(method, url, body) {
    try {
      return await call(method, url, body);
    } catch (err) {
      host.showNotice(String(err.message || err));
      return null;
    }
  }

  /* ---------- open / close ---------- */

  async function show() {
    if (open) {
      return;
    }
    host.beforeOpen?.();
    open = true;
    clearTimeout(animTimer);
    document.documentElement.classList.add("spaces-anim", "spaces-open");
    chip.setAttribute("aria-expanded", "true");
    root.hidden = false;
    // Two frames so the fade starts from the hidden state.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (open) root.classList.add("shown");
    }));
    await run("POST", "/api/spaces/ensure");
    selected = Math.max(0, data.spaces.findIndex((space) => space.id === data.activeId));
    render();
    focusSelected();
  }

  function close() {
    if (!open) {
      return;
    }
    open = false;
    renaming = null;
    closeMenu();
    endDrag(false);
    document.documentElement.classList.remove("spaces-open");
    chip.setAttribute("aria-expanded", "false");
    root.classList.remove("shown");
    clearTimeout(animTimer);
    animTimer = setTimeout(() => {
      if (!open) {
        root.hidden = true;
        grid.replaceChildren();
        document.documentElement.classList.remove("spaces-anim");
      }
    }, 300);
    host.afterClose?.();
  }

  function toggle() {
    if (open) {
      close();
    } else {
      void show();
    }
  }

  async function switchTo(id) {
    if (busy) {
      return;
    }
    if (id === data.activeId) {
      close();
      return;
    }
    busy = true;
    switching = true;
    grid.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add("chosen");
    try {
      await call("POST", `/api/spaces/${encodeURIComponent(id)}/switch`);
      close();
    } catch (err) {
      host.showNotice(String(err.message || err));
      grid.querySelector(".space-card.chosen")?.classList.remove("chosen");
    } finally {
      busy = false;
      switching = false;
    }
  }

  async function cycle(step) {
    if (busy) {
      return;
    }
    busy = true;
    try {
      await call("POST", "/api/spaces/cycle", { step });
      const space = current();
      if (space && !open) {
        host.showNotice(`Space: ${space.name}`);
      }
      if (open) {
        selected = Math.max(0, data.spaces.findIndex((item) => item.id === data.activeId));
        render();
      }
    } catch (err) {
      host.showNotice(String(err.message || err));
    } finally {
      busy = false;
    }
  }

  async function createSpace() {
    const view = await run("POST", "/api/spaces", {});
    if (view) {
      selected = data.spaces.length - 1;
      renaming = data.spaces[selected]?.id ?? null;
      render();
    }
  }

  async function duplicateCurrent() {
    const space = current();
    const view = await run("POST", "/api/spaces", { copyTabs: true, name: space ? `${space.name} copy` : undefined });
    if (view) {
      selected = data.spaces.length - 1;
      renaming = data.spaces[selected]?.id ?? null;
      render();
    }
  }

  async function deleteSpace(space) {
    if (data.spaces.length <= 1) {
      host.showNotice("The last space can't be deleted");
      return;
    }
    const view = await run("DELETE", `/api/spaces/${encodeURIComponent(space.id)}`);
    if (view) {
      render();
      focusSelected();
      host.showNotice(`Deleted space “${space.name}”. Its pages stay in the Library.`, {
        action: { label: "Undo", run: () => void restore(space.id) },
      });
    }
  }

  async function restore(id) {
    const view = await run("POST", "/api/spaces/restore", id ? { id } : {});
    if (view) {
      const at = data.spaces.findIndex((space) => space.id === id);
      if (at >= 0) {
        selected = at;
      }
      render();
      focusSelected();
    }
  }

  function rename(space, name) {
    renaming = null;
    const next = name.replace(/\s+/g, " ").trim();
    if (next && next !== space.name) {
      void run("PATCH", `/api/spaces/${encodeURIComponent(space.id)}`, { name: next });
    }
    render();
    focusSelected();
  }

  /* ---------- render ---------- */

  function renderChip() {
    const space = current();
    chip.replaceChildren();
    chip.classList.toggle("named", Boolean(space));
    if (space) {
      chip.style.setProperty("--space", colorOf(space));
      const dot = el("span", "space-chip-dot");
      const name = el("span", "space-chip-name", space.name);
      chip.append(dot, name);
      chip.dataset.tooltip = `Space: ${space.name} (Ctrl+E)`;
    } else {
      chip.innerHTML = ICONS.spaces;
      chip.removeAttribute("data-tooltip");
    }
  }

  function render() {
    if (drag?.moved) return;
    grid.replaceChildren();
    data.spaces.forEach((space, index) => grid.append(card(space, index)));
    const add = el("button", "space-card space-new");
    add.type = "button";
    add.innerHTML = `${ICONS.plus}<span>New space</span>`;
    add.addEventListener("click", () => void createSpace());
    grid.append(add);
    renderDeleted();
    const input = grid.querySelector(".space-rename");
    if (input) {
      input.focus();
      input.select();
    }
  }

  function card(space, index) {
    const item = el("div", "space-card");
    item.dataset.id = space.id;
    item.tabIndex = -1;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", index === selected ? "true" : "false");
    item.classList.toggle("active", space.id === data.activeId);
    item.classList.toggle("selected", index === selected);
    item.style.setProperty("--space", colorOf(space));
    item.style.setProperty("--i", String(index));

    const top = el("div", "space-top");
    const dot = el("span", "space-dot");
    top.append(dot);
    if (renaming === space.id) {
      const input = document.createElement("input");
      input.className = "space-rename";
      input.value = space.name;
      input.maxLength = 60;
      input.spellcheck = false;
      input.setAttribute("aria-label", "Space name");
      input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          rename(space, input.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          renaming = null;
          render();
          focusSelected();
        }
      });
      input.addEventListener("blur", () => {
        if (renaming === space.id) {
          rename(space, input.value);
        }
      });
      input.addEventListener("pointerdown", (event) => event.stopPropagation());
      top.append(input);
    } else {
      const name = el("span", "space-name", space.name);
      top.append(name);
    }
    if (space.id === data.activeId) {
      top.append(el("span", "space-badge", "Current"));
    }
    const more = el("button", "space-more");
    more.type = "button";
    more.innerHTML = ICONS.more;
    more.setAttribute("aria-label", `Options for ${space.name}`);
    more.addEventListener("pointerdown", (event) => event.stopPropagation());
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      openMenu(space, more);
    });
    top.append(more);

    const tabs = space.tabs.map((entry) => ({ entry, tab: host.findAnyTab(entry.id) })).filter((item) => item.tab);
    item.append(top);
    if (tabs.length) {
      item.append(strip(space, tabs));
    }
    item.append(focusLine(space, tabs), metaLine(space, tabs));
    if (index < 9) {
      item.append(el("span", "space-key", String(index + 1)));
    }

    item.addEventListener("pointerdown", (event) => startDrag(event, item, space));
    item.addEventListener("click", () => {
      void switchTo(space.id);
    });
    item.addEventListener("mouseenter", () => {
      if (!drag) {
        select(index, false);
      }
    });
    return item;
  }

  /** A miniature of the space's tab strip: pins as squares, the focused tab lit. */
  function strip(space, tabs) {
    const row = el("div", "space-strip");
    for (const { entry, tab } of tabs.slice(0, STRIP_CHIPS)) {
      const chipEl = el("span", "space-tab" + (entry.pinned ? " pinned" : "") + (entry.id === space.activeId ? " focused" : ""));
      if (entry.pinned) {
        chipEl.innerHTML = ICONS.pin;
        chipEl.dataset.tooltip = tab.title;
      } else {
        chipEl.textContent = tab.title;
      }
      row.append(chipEl);
    }
    if (tabs.length > STRIP_CHIPS) {
      row.append(el("span", "space-tab more", `+${tabs.length - STRIP_CHIPS}`));
    }
    return row;
  }

  function focusLine(space, tabs) {
    const focused = tabs.find((item) => item.entry.id === space.activeId)?.tab || tabs[0]?.tab;
    const line = el("div", "space-focus");
    line.textContent = focused ? focused.title : "No tabs yet. New pages open here while it's the current space.";
    line.classList.toggle("none", !focused);
    return line;
  }

  /** Tab count, the folders most of its tabs come from, and when it was last used. */
  function metaLine(space, tabs) {
    const line = el("div", "space-meta");
    const parts = [`${tabs.length} tab${tabs.length === 1 ? "" : "s"}`];
    const counts = new Map();
    for (const { tab } of tabs) {
      const path = tab.folderId ? host.folderPath(tab.folderId) : "";
      if (path) {
        const top = path.split("/")[0];
        counts.set(top, (counts.get(top) || 0) + 1);
      }
    }
    const folders = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name]) => name);
    if (folders.length) {
      parts.push(folders.join(", "));
    }
    if (space.id !== data.activeId) {
      parts.push(ago(space.usedAt));
    }
    line.textContent = parts.join(" · ");
    return line;
  }

  function renderDeleted() {
    deletedRow.replaceChildren();
    deletedRow.hidden = !data.deleted.length;
    if (!data.deleted.length) {
      return;
    }
    deletedRow.append(el("span", "spaces-deleted-label", "Recently deleted"));
    for (const space of data.deleted.slice(0, 5)) {
      const button = el("button", "spaces-restore");
      button.type = "button";
      button.style.setProperty("--space", COLORS[space.color] || COLORS.slate);
      button.innerHTML = ICONS.restore;
      button.append(document.createTextNode(` ${space.name}`));
      button.dataset.tooltip = `Restore “${space.name}” (${space.tabs} tab${space.tabs === 1 ? "" : "s"})`;
      button.addEventListener("click", () => void restore(space.id));
      deletedRow.append(button);
    }
  }

  /* ---------- menu ---------- */

  function openMenu(space, anchor) {
    closeMenu();
    const box = el("div", "space-menu");
    box.setAttribute("role", "menu");
    const swatches = el("div", "space-swatches");
    for (const [id, hex] of Object.entries(COLORS)) {
      const swatch = el("button", "space-swatch" + (space.color === id ? " on" : ""));
      swatch.type = "button";
      swatch.style.setProperty("--swatch", hex);
      swatch.dataset.tooltip = id[0].toUpperCase() + id.slice(1);
      swatch.addEventListener("click", () => {
        closeMenu();
        void run("PATCH", `/api/spaces/${encodeURIComponent(space.id)}`, { color: id });
      });
      swatches.append(swatch);
    }
    box.append(swatches);
    const item = (label, action, cls) => {
      const button = el("button", "space-menu-item" + (cls ? " " + cls : ""), label);
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.addEventListener("click", () => {
        closeMenu();
        action();
      });
      box.append(button);
    };
    item("Rename", () => {
      renaming = space.id;
      render();
    });
    item("Set home folder…", () => host.setHomeFolder(space));
    if (space.id === data.activeId) {
      item("Duplicate", () => void duplicateCurrent());
    }
    if (data.spaces.length > 1) {
      item("Delete", () => void deleteSpace(space), "danger");
    }
    box.addEventListener("pointerdown", (event) => event.stopPropagation());
    root.append(box);
    const rect = anchor.getBoundingClientRect();
    const width = box.offsetWidth;
    box.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`;
    box.style.top = `${Math.min(rect.bottom + 6, innerHeight - box.offsetHeight - 8)}px`;
    menu = { el: box };
  }

  function closeMenu() {
    menu?.el.remove();
    menu = null;
  }

  /* ---------- drag to reorder ---------- */

  function startDrag(event, item, space) {
    if (event.button !== 0 || renaming || busy || drag) {
      return;
    }
    drag = { id: space.id, item, startX: event.clientX, startY: event.clientY, pointerId: event.pointerId, moved: false };
    drag.controller = window.scribeDrag({ event, target: grid,
      measure: () => {
        if (!drag?.moved) return;
        const saved = drag.item.style.transform;
        drag.item.style.transform = "";
        drag.slots = [...grid.querySelectorAll(".space-card[data-id]")].map(card => card.getBoundingClientRect());
        drag.item.style.transform = saved;
      },
      onMove: onDragMove,
      onDrop: onDragUp,
      onCancel: onDragCancel,
    });
  }

  function onDragMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    if (!drag.moved) {
      drag.moved = true;
      const rect = drag.item.getBoundingClientRect();
      drag.grabX = drag.startX - rect.left;
      drag.grabY = drag.startY - rect.top;
      drag.slots = [...grid.querySelectorAll(".space-card[data-id]")].map(card => card.getBoundingClientRect());
      drag.item.classList.add("dragging");
      grid.classList.add("reordering");
      closeMenu();
    }
    // Move the card in the grid when the pointer is over another card, then keep it under the pointer.
    const cards = [...grid.querySelectorAll(".space-card[data-id]")];
    const over = cards.find((other) => {
      if (other === drag.item) {
        return false;
      }
      const rect = drag.slots[cards.indexOf(other)];
      return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    });
    if (over) {
      grid.insertBefore(drag.item, cards.indexOf(over) < cards.indexOf(drag.item) ? over : over.nextSibling);
    }
    const natural = drag.slots[[...grid.querySelectorAll(".space-card[data-id]")].indexOf(drag.item)];
    drag.item.style.transform = `translate(${event.clientX - drag.grabX - natural.left}px, ${event.clientY - drag.grabY - natural.top}px)`;
  }

  function onDragUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    endDrag(true);
  }

  function onDragCancel() {
    endDrag(false);
  }

  function endDrag(commit) {
    if (!drag) {
      return;
    }
    const { item, id, moved } = drag;
    drag.controller?.dispose();
    drag = null;
    if (!moved) {
      return;
    }
    item.classList.remove("dragging");
    item.style.transform = "";
    grid.classList.remove("reordering");
    const index = [...grid.querySelectorAll(".space-card[data-id]")].indexOf(item);
    const from = data.spaces.findIndex((space) => space.id === id);
    if (commit && index >= 0 && index !== from) {
      selected = index;
      void run("POST", `/api/spaces/${encodeURIComponent(id)}/move`, { index });
    } else {
      render();
    }
  }

  /* ---------- keys ---------- */

  function select(index, focus = true) {
    const count = data.spaces.length;
    if (!count) {
      return;
    }
    selected = (index + count) % count;
    for (const [i, item] of [...grid.querySelectorAll(".space-card[data-id]")].entries()) {
      item.classList.toggle("selected", i === selected);
      item.setAttribute("aria-selected", i === selected ? "true" : "false");
    }
    if (focus) {
      focusSelected();
    }
  }

  function focusSelected() {
    const item = grid.querySelectorAll(".space-card[data-id]")[selected];
    item?.focus({ preventScroll: true });
    item?.scrollIntoView({ block: "nearest" });
  }

  /** Columns in the grid now, so Up and Down move by a row. */
  function columns() {
    const cards = [...grid.querySelectorAll(".space-card")];
    if (cards.length < 2) {
      return 1;
    }
    const top = cards[0].getBoundingClientRect().top;
    const sameRow = cards.findIndex((item) => item.getBoundingClientRect().top > top + 4);
    return sameRow < 0 ? cards.length : sameRow;
  }

  /** Keys while the overview is open. True when handled. */
  function onKey(event) {
    if (!open || renaming) {
      return false;
    }
    if (menu && event.key === "Escape") {
      closeMenu();
      return true;
    }
    const space = data.spaces[selected];
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z") {
      if (data.deleted.length) {
        void restore(data.deleted[0].id);
      }
      return true;
    }
    if (ctrl && event.key.toLowerCase() === "e") {
      close();
      return true;
    }
    if (ctrl || event.altKey) {
      return false;
    }
    switch (event.key) {
      case "Escape":
        close();
        return true;
      case "ArrowRight":
        select(selected + 1);
        return true;
      case "ArrowLeft":
        select(selected - 1);
        return true;
      case "ArrowDown":
        select(Math.min(selected + columns(), data.spaces.length - 1));
        return true;
      case "ArrowUp":
        select(Math.max(selected - columns(), 0));
        return true;
      case "Home":
        select(0);
        return true;
      case "End":
        select(data.spaces.length - 1);
        return true;
      case "Enter":
      case " ":
        if (space) {
          void switchTo(space.id);
        }
        return true;
      case "F2":
        if (space) {
          renaming = space.id;
          render();
        }
        return true;
      case "Delete":
        if (space) {
          void deleteSpace(space);
        }
        return true;
      case "n":
      case "N":
        void createSpace();
        return true;
      default:
        if (/^[1-9]$/.test(event.key)) {
          const target = data.spaces[Number(event.key) - 1];
          if (target) {
            void switchTo(target.id);
          }
          return true;
        }
        return false;
    }
  }

  /** Palette rows for spaces whose name matches. */
  function search(query) {
    const q = query.trim().toLowerCase();
    if (!q || data.spaces.length < 2) {
      return [];
    }
    return data.spaces
      .filter((space) => space.name.toLowerCase().includes(q))
      .map((space) => ({
        kind: "space",
        id: `space:${space.id}`,
        spaceId: space.id,
        title: space.name,
        snippet: `${space.tabs.length} tab${space.tabs.length === 1 ? "" : "s"}`,
        locationLabel: "Space",
        location: "space",
        open: space.id === data.activeId,
      }));
  }

  /* ---------- helpers ---------- */

  function colorOf(space) {
    return COLORS[space.color] || COLORS.slate;
  }

  function ago(at) {
    const minutes = Math.round((Date.now() - (at || 0)) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return days === 1 ? "yesterday" : `${days} days ago`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  renderChip();

  return {
    activeId: () => data.activeId,
    ids: () => data.spaces.map((space) => space.id),
    /** The active space (with its home folder and lens, #260), or null before spaces are used. */
    current,
    list: () => data.spaces,
    colorOf,
    apply,
    show,
    close,
    toggle,
    cycle,
    switchTo,
    onKey,
    search,
    isOpen: () => open,
    /** Tabs and titles changed: redraw the cards if they are showing. */
    refresh: () => {
      if (open && !drag && !renaming) {
        render();
      }
    },
  };
};
