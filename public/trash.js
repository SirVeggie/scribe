/**
 * The Trash sidebar view: deleted pages and folders, kept for 7 days.
 * Rows restore to the Library (closed); the context menu can delete for good.
 */
window.createTrash = function createTrash(host) {
  const list = document.getElementById("trash-list");
  const none = document.getElementById("trash-none");
  const countEl = document.getElementById("trash-count");
  const emptyBtn = document.getElementById("trash-empty");

  const DAY = 24 * 60 * 60 * 1000;
  const RESTORE_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.2 6.2A5 5 0 1 1 3 9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M2.6 2.8v3.6h3.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /** @type {Array<any>} */
  let batches = [];
  const expanded = new Set();
  let visible = false;
  let loadReq = 0;

  async function load() {
    const req = ++loadReq;
    const res = await fetch("/api/trash").catch(() => null);
    if (req !== loadReq || !res?.ok) {
      return;
    }
    const data = await res.json();
    batches = Array.isArray(data.batches) ? data.batches : [];
    render();
  }

  function pageCount() {
    return batches.reduce((n, batch) => n + batch.tabs.length, 0);
  }

  function render() {
    const focused = rowKey(document.activeElement);
    // Rows are kept by key and patched in place (#430).
    const rows = [];
    countEl.textContent = String(pageCount());
    emptyBtn.disabled = batches.length === 0;
    none.hidden = batches.length > 0;
    list.hidden = batches.length === 0;
    for (const batch of batches) {
      const folderIds = new Set(batch.folders.map((folder) => folder.id));
      const note = describeAge(batch);
      for (const folder of batch.folders.filter((item) => !item.parentId || !folderIds.has(item.parentId))) {
        renderFolder(rows, batch, folder, 0, note);
      }
      for (const page of batch.tabs.filter((tab) => !tab.folderId || !folderIds.has(tab.folderId))) {
        rows.push(pageRow(page, 0, note));
      }
    }
    window.scribeKeyedList(list, rows);
    if (focused) {
      rowFor(focused.kind, focused.id)?.focus({ preventScroll: true });
    }
  }

  function renderFolder(rows, batch, folder, depth, note) {
    const open = expanded.has(folder.id);
    rows.push(folderRow(batch, folder, depth, open, note));
    if (!open) {
      return;
    }
    for (const child of batch.folders.filter((item) => item.parentId === folder.id).sort((a, b) => a.pos - b.pos)) {
      renderFolder(rows, batch, child, depth + 1, "");
    }
    for (const page of batch.tabs.filter((tab) => tab.folderId === folder.id).sort((a, b) => a.libPos - b.libPos)) {
      rows.push(pageRow(page, depth + 1, ""));
    }
  }

  function describeAge(batch) {
    const left = Math.max(0, batch.expiresAt - Date.now());
    const days = Math.ceil(left / DAY);
    const remaining = left < DAY ? "gone within a day" : `${days} day${days === 1 ? "" : "s"} left`;
    return `Deleted ${relative(batch.deletedAt)} · ${remaining}`;
  }

  function relative(at) {
    const diff = Date.now() - at;
    const minute = 60 * 1000;
    const hour = 60 * minute;
    if (diff < minute) {
      return "just now";
    }
    if (diff < hour) {
      return `${Math.floor(diff / minute)} min ago`;
    }
    if (diff < DAY) {
      const n = Math.floor(diff / hour);
      return `${n} hour${n === 1 ? "" : "s"} ago`;
    }
    const n = Math.floor(diff / DAY);
    return `${n} day${n === 1 ? "" : "s"} ago`;
  }

  function baseRow(kind, id) {
    const el = document.createElement("div");
    el.className = `side-row lib-row lib-${kind} trash-row`;
    el.role = "treeitem";
    el.tabIndex = 0;
    el.dataset.kind = kind;
    el.dataset.id = id;
    return el;
  }

  function updateRow(el, depth, label) {
    window.scribeAttr(el, "aria-label", label);
    window.scribeAttr(el, "aria-level", depth + 1);
    if (el.style.getPropertyValue("--depth") !== String(depth)) {
      el.style.setProperty("--depth", String(depth));
    }
  }

  function textBlock(titleText, note) {
    const text = document.createElement("span");
    text.className = "lib-text";
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = titleText;
    text.appendChild(title);
    if (note) {
      const path = document.createElement("span");
      path.className = "lib-path";
      path.textContent = note;
      text.appendChild(path);
    }
    return text;
  }

  function restoreButton() {
    const btn = document.createElement("button");
    btn.className = "tab-close trash-restore";
    btn.type = "button";
    btn.innerHTML = RESTORE_SVG;
    btn.dataset.tooltip = "Restore to the Library";
    btn.ariaLabel = "Restore";
    btn.tabIndex = -1;
    return btn;
  }

  function pageRow(page, depth, note) {
    return {
      key: `page:${page.id}`,
      create: () => baseRow("page", page.id),
      update: (el) => {
        updateRow(el, depth, page.title);
        window.scribeFill(el, JSON.stringify([page.title, note]), () => {
          const icon = document.createElement("span");
          icon.className = "fileicon";
          icon.innerHTML = host.icons.file;
          return [icon, textBlock(page.title, note), restoreButton()];
        });
      },
    };
  }

  function folderRow(batch, folder, depth, open, note) {
    return {
      key: `folder:${folder.id}`,
      create: () => baseRow("folder", folder.id),
      update: (el) => {
        updateRow(el, depth, `${folder.name} (folder)`);
        window.scribeClasses(el, { expanded: open });
        window.scribeAttr(el, "aria-expanded", open ? "true" : "false");
        const count = countIn(batch, folder.id);
        window.scribeFill(el, JSON.stringify([folder.name, note, count]), () => {
          const chevron = document.createElement("span");
          chevron.className = "lib-chevron";
          chevron.innerHTML = host.icons.chevron;
          const icon = document.createElement("span");
          icon.className = "lib-folder-icon";
          icon.innerHTML = host.icons.folder;
          const countEl = document.createElement("span");
          countEl.className = "lib-count";
          countEl.textContent = String(count);
          return [chevron, icon, textBlock(folder.name, note), countEl, restoreButton()];
        });
      },
    };
  }

  function countIn(batch, folderId) {
    const ids = new Set([folderId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const folder of batch.folders) {
        if (!ids.has(folder.id) && folder.parentId && ids.has(folder.parentId)) {
          ids.add(folder.id);
          grew = true;
        }
      }
    }
    return batch.tabs.filter((tab) => tab.folderId && ids.has(tab.folderId)).length;
  }

  function find(kind, id) {
    for (const batch of batches) {
      const item = kind === "folder" ? batch.folders.find((f) => f.id === id) : batch.tabs.find((t) => t.id === id);
      if (item) {
        return { batch, item, name: kind === "folder" ? item.name : item.title };
      }
    }
    return null;
  }

  function rowFor(kind, id) {
    return list.querySelector(`.trash-row[data-kind="${kind}"][data-id="${CSS.escape(id)}"]`);
  }

  function rowKey(el) {
    const row = el?.closest?.(".trash-row");
    return row && list.contains(row) ? { kind: row.dataset.kind, id: row.dataset.id } : null;
  }

  function send(method, url) {
    return fetch(url, { method }).catch(() => ({ ok: false }));
  }

  async function restore(kind, id) {
    const found = find(kind, id);
    const res = await send("POST", `/api/trash/${encodeURIComponent(id)}/restore`);
    if (!res.ok) {
      const data = await res.json?.().catch(() => ({}));
      host.showNotice(data?.error || "Could not restore");
      return;
    }
    host.showNotice(`Restored “${found?.name ?? (kind === "folder" ? "folder" : "page")}” to the Library`);
    load();
  }

  async function purge(kind, id) {
    const found = find(kind, id);
    if (!found) {
      return;
    }
    const pages = kind === "folder" ? countIn(found.batch, id) : 1;
    const what = kind === "folder" ? `the folder “${found.name}” and its ${pages === 1 ? "page" : `${pages} pages`}` : `“${found.name}”`;
    const ok = await host.confirm(`Permanently delete ${what}? This cannot be undone.`);
    if (!ok) {
      return;
    }
    const res = await send("DELETE", `/api/trash/${encodeURIComponent(id)}`);
    if (!res.ok) {
      const data = await res.json?.().catch(() => ({}));
      host.showNotice(data?.error || "Could not delete");
      return;
    }
    host.showNotice(`Permanently deleted “${found.name}”`);
    load();
  }

  async function emptyTrash() {
    const n = pageCount();
    if (!batches.length) {
      return;
    }
    const ok = await host.confirm(
      `Permanently delete ${n === 1 ? "1 page" : `${n} pages`} in the Trash? This cannot be undone.`
    );
    if (!ok) {
      return;
    }
    const res = await send("DELETE", "/api/trash");
    if (res.ok) {
      host.showNotice("Emptied the Trash");
      load();
    } else {
      const data = await res.json?.().catch(() => ({}));
      host.showNotice(data?.error || "Could not empty the Trash");
    }
  }

  function toggle(id) {
    if (!expanded.delete(id)) {
      expanded.add(id);
    }
    render();
  }

  function rowMenu(event, kind, id) {
    event.preventDefault();
    event.stopPropagation();
    const point =
      event.clientX || event.clientY
        ? { x: event.clientX, y: event.clientY }
        : (() => {
            const box = event.target.getBoundingClientRect();
            return { x: box.left, y: box.bottom + 4 };
          })();
    host.openMenu(point, [
      { label: "Restore", action: () => restore(kind, id) },
      "sep",
      { label: "Delete permanently…", danger: true, action: () => purge(kind, id) },
    ]);
  }

  list.addEventListener("click", (event) => {
    const row = event.target.closest(".trash-row");
    if (!row) {
      return;
    }
    const { kind, id } = row.dataset;
    if (event.target.closest(".trash-restore")) {
      event.stopPropagation();
      restore(kind, id);
      return;
    }
    if (kind === "folder") {
      toggle(id);
    }
  });
  list.addEventListener("contextmenu", (event) => {
    const row = event.target.closest(".trash-row");
    if (row) {
      rowMenu(event, row.dataset.kind, row.dataset.id);
    }
  });
  list.addEventListener("keydown", (event) => {
    const row = event.target.closest?.(".trash-row");
    if (!row || event.target !== row) {
      return;
    }
    const { kind, id } = row.dataset;
    const rows = [...list.querySelectorAll(".trash-row")];
    const at = rows.indexOf(row);
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
        return;
      case "ArrowRight":
      case "ArrowLeft":
        if (kind === "folder" && expanded.has(id) !== (event.key === "ArrowRight")) {
          event.preventDefault();
          toggle(id);
        }
        return;
      case "Enter":
        event.preventDefault();
        restore(kind, id);
        return;
      case "Delete":
        event.preventDefault();
        purge(kind, id);
        return;
      case "ContextMenu":
        rowMenu(event, kind, id);
        return;
      default:
        return;
    }
  });
  list.addEventListener("scroll", () => host.closeMenu());
  emptyBtn.addEventListener("click", emptyTrash);

  return {
    /** Called when the view is shown or hidden; loads fresh contents on show. */
    setVisible(on) {
      visible = on;
      if (on) {
        load();
      }
    },
    /** The server said the Trash changed. */
    refresh() {
      if (visible) {
        load();
      }
    },
    focus() {
      (list.querySelector(".trash-row") || emptyBtn).focus({ preventScroll: true });
    },
  };
};
