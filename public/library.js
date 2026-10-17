/**
 * The Library sidebar: every page on the board in user-ordered nested folders.
 * app.js owns board state and the tab strip; this owns the tree, its menus, and drag and drop.
 */
window.createLibrary = function createLibrary(host) {
  const list = document.getElementById("library-list");
  const none = document.getElementById("library-none");
  const search = document.getElementById("library-search");
  const countEl = document.getElementById("library-count");
  const newFolderBtn = document.getElementById("library-new-folder");
  const moreBtn = document.getElementById("library-more");
  const cleanupDlg = document.getElementById("cleanup");
  const cleanupAge = document.getElementById("cleanup-age");
  const cleanupUnit = document.getElementById("cleanup-unit");
  const cleanupBasis = document.getElementById("cleanup-basis");
  const cleanupBasisHelp = document.getElementById("cleanup-basis-help");
  const cleanupOpen = document.getElementById("cleanup-open");
  const cleanupPinned = document.getElementById("cleanup-pinned");
  const cleanupSummary = document.getElementById("cleanup-summary");
  const cleanupList = document.getElementById("cleanup-list");
  const cleanupSubmit = document.getElementById("cleanup-submit");

  const COLLAPSED_KEY = "scribe.libraryCollapsed";
  const ROW_CARD_DELAY = 700;
  const DRAG_THRESHOLD = 4;
  const EXPAND_DELAY = 600;
  const RECOLLAPSE_DELAY = 300;
  const SCROLL_EDGE = 40;
  const INDENT = 14;
  const ROW_PAD = 8;
  const CLEANUP_KEY = "scribe.cleanup";
  const CLEANUP_BASIS_HELP = {
    activity: "The latest of an edit, a data change, or closing the tab.",
    edited: "The last change to the page's content or data.",
    created: "When the page was first shown.",
    closed: "When the tab was closed. Open tabs have no close date, so they never match.",
  };
  const ROOT = "\u0000root";

  const FOLDER_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.5 3.5h4.2l1.5 1.5h7.3v8.5h-13z" fill="currentColor"/></svg>';
  const CHEVRON_SVG =
    '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M5.5 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const collapsed = new Set(loadCollapsed());
  /** Latest tree model; rebuilt on every render. */
  let model = buildModel();
  let query = "";
  /** @type {Array<any> | null} */
  let hits = null;
  let hitTotal = 0;
  let searchTimer = 0;
  let searchReq = 0;
  /** @type {null | { kind: string, id: string, input: HTMLInputElement }} */
  let renaming = null;
  /** @type {null | { kind: string, id: string }} */
  let pendingRename = null;
  let renderDeferred = false;
  /** @type {null | { kind: string, id: string, pointerId: number, startX: number, startY: number }} */
  let press = null;
  /** @type {any} */
  let drag = null;
  let cleanupReq = 0;
  let cleanupTimer = 0;

  const lineEl = document.createElement("div");
  lineEl.className = "lib-drop-line";

  const menu = document.createElement("div");
  menu.className = "tab-menu lib-menu";
  menu.role = "menu";
  menu.hidden = true;
  document.body.appendChild(menu);

  function loadCollapsed() {
    try {
      const parsed = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
    } catch {
      return [];
    }
  }

  function saveCollapsed() {
    const known = new Set(host.folders().map((folder) => folder.id));
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed].filter((id) => known.has(id))));
  }

  function buildModel() {
    const pages = host.pages();
    const folders = host.folders();
    const folderById = new Map(folders.map((folder) => [folder.id, folder]));
    const pageById = new Map(pages.map((page) => [page.id, page]));
    /** @type {Map<string | null, Array<any>>} */
    const pagesIn = new Map();
    /** @type {Map<string | null, Array<any>>} */
    const foldersIn = new Map();
    for (const page of pages) {
      const key = page.folderId && folderById.has(page.folderId) ? page.folderId : null;
      if (!pagesIn.has(key)) {
        pagesIn.set(key, []);
      }
      pagesIn.get(key).push(page);
    }
    for (const folder of folders) {
      const key = folder.parentId && folderById.has(folder.parentId) ? folder.parentId : null;
      if (!foldersIn.has(key)) {
        foldersIn.set(key, []);
      }
      foldersIn.get(key).push(folder);
    }
    for (const group of pagesIn.values()) {
      group.sort((a, b) => a.libPos - b.libPos);
    }
    for (const group of foldersIn.values()) {
      group.sort((a, b) => a.pos - b.pos);
    }
    return { pages, folders, folderById, pageById, pagesIn, foldersIn };
  }

  function pagesOf(folderId) {
    return model.pagesIn.get(folderId ?? null) || [];
  }

  function foldersOf(parentId) {
    return model.foldersIn.get(parentId ?? null) || [];
  }

  function folderOfPage(page) {
    return page.folderId && model.folderById.has(page.folderId) ? page.folderId : null;
  }

  function subtree(folderId) {
    const ids = new Set([folderId]);
    const stack = [folderId];
    while (stack.length) {
      for (const child of foldersOf(stack.pop())) {
        ids.add(child.id);
        stack.push(child.id);
      }
    }
    return ids;
  }

  /** The folder and every ancestor up to the root. */
  function chainOf(folderId) {
    const ids = new Set();
    let at = folderId ? model.folderById.get(folderId) : undefined;
    while (at && !ids.has(at.id)) {
      ids.add(at.id);
      at = at.parentId ? model.folderById.get(at.parentId) : undefined;
    }
    return ids;
  }

  function pathOf(folderId) {
    const names = [];
    const seen = new Set();
    let at = folderId ? model.folderById.get(folderId) : undefined;
    while (at && !seen.has(at.id)) {
      seen.add(at.id);
      names.unshift(at.name);
      at = at.parentId ? model.folderById.get(at.parentId) : undefined;
    }
    return names.join(" / ");
  }

  function countPages(folderId) {
    let n = 0;
    for (const id of subtree(folderId)) {
      n += pagesOf(id).length;
    }
    return n;
  }

  function hasUnreadPage(folderId) {
    for (const id of subtree(folderId)) {
      if (pagesOf(id).some((page) => host.isUnread(page.id))) {
        return true;
      }
    }
    return false;
  }

  function render(force = false) {
    if (drag && !force) { renderDeferred = true; return; }
    if (renaming) {
      renderDeferred = true;
      return;
    }
    renderDeferred = false;
    model = buildModel();
    countEl.textContent = String(model.pages.length);
    // A hidden Library keeps its model current; the rows are drawn when it is shown (setPaneOpen, tab switch).
    if (!host.paneOpen()) {
      return;
    }
    const focused = rowKey(document.activeElement);
    // Rows that did not change stay in the page: a rebuilt row loses its hover and blinks (#407).
    const rows = document.createDocumentFragment();
    if (query && hits) {
      renderHits(rows);
    } else {
      renderTree(rows, null, 0);
      const empty = model.pages.length === 0 && model.folders.length === 0;
      none.hidden = !empty;
      none.textContent = "Pages you show appear here";
    }
    window.scribeSyncChildren(list, [rows, lineEl]);
    invalidateLibrary();
    if (drag?.target) {
      paintTarget(drag.target);
    }
    if (focused) {
      rowFor(focused.kind, focused.id)?.focus({ preventScroll: true });
    }
    if (pendingRename && rowFor(pendingRename.kind, pendingRename.id)) {
      const { kind, id } = pendingRename;
      pendingRename = null;
      startRename(kind, id);
    }
  }

  function renderTree(out, folderId, depth) {
    for (const folder of foldersOf(folderId)) {
      const open = !collapsed.has(folder.id);
      out.appendChild(folderRow(folder, depth, open));
      if (open) {
        renderTree(out, folder.id, depth + 1);
      }
    }
    for (const page of pagesOf(folderId)) {
      out.appendChild(pageRow(page, depth));
    }
  }

  function renderHits(out) {
    const rows = hits || [];
    none.hidden = rows.length > 0;
    none.textContent = "No matching pages";
    if (rows.length) {
      const meta = document.createElement("div");
      meta.className = "side-meta";
      meta.textContent =
        rows.length < hitTotal
          ? `Showing ${rows.length} of ${hitTotal} matches`
          : `${hitTotal} matching page${hitTotal === 1 ? "" : "s"}`;
      out.appendChild(meta);
    }
    for (const hit of rows) {
      const live = model.pageById.get(hit.id) || hit;
      out.appendChild(pageRow(live, 0, { path: pathOf(folderOfPage(live)), snippet: hit.snippet }));
    }
  }

  function pageRow(page, depth, extra = {}) {
    const open = host.isOpen(page.id);
    const el = document.createElement("div");
    el.className =
      "side-row lib-row lib-page" +
      (open ? " open" : "") +
      (open && host.activeId() === page.id ? " active" : "") +
      (page.pinned ? " pinned" : "") +
      (host.pageStatus?.(page.id) ? ` agent-${host.pageStatus(page.id)}` : "") +
      (drag?.id === page.id && drag.kind === "page" ? " lib-drag-source" : "");
    el.role = "treeitem";
    el.tabIndex = 0;
    el.ariaLabel = page.title + (open ? " (open)" : "") + (page.pinned ? " (pinned)" : "");
    el.ariaLevel = String(depth + 1);
    el.dataset.kind = "page";
    el.dataset.id = page.id;
    el.dataset.depth = String(depth);
    el.style.setProperty("--depth", String(depth));

    const icon = document.createElement("span");
    icon.className = "fileicon";
    icon.innerHTML = page.agentHidden ? host.icons.agentHidden : host.icons.file;
    if (page.agentHidden) {
      icon.dataset.tooltip = host.icons.agentHiddenTitle;
    }
    el.appendChild(icon);

    if (host.isUnread(page.id)) {
      const dot = document.createElement("span");
      dot.className = "tab-updated";
      el.appendChild(dot);
    }

    const text = document.createElement("span");
    text.className = "lib-text";
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = page.title;
    text.appendChild(title);
    if (extra.path) {
      const path = document.createElement("span");
      path.className = "lib-path";
      path.textContent = extra.path;
      text.appendChild(path);
    }
    el.appendChild(text);

    if (page.pinned) {
      const pin = document.createElement("span");
      pin.className = "lib-pin";
      pin.innerHTML = host.icons.pin;
      el.appendChild(pin);
    }

    const del = document.createElement("button");
    del.className = "tab-close";
    del.type = "button";
    del.textContent = "×";
    del.setAttribute("aria-label", "Delete");
    del.tabIndex = -1;
    el.appendChild(del);

    host.hoverCard.bind(el, ROW_CARD_DELAY);

    if (!extra.snippet) {
      return el;
    }
    const wrap = document.createDocumentFragment();
    wrap.appendChild(el);
    const snippet = document.createElement("div");
    snippet.className = "side-snippet";
    snippet.textContent = extra.snippet;
    wrap.appendChild(snippet);
    return wrap;
  }

  function folderRow(folder, depth, open) {
    const el = document.createElement("div");
    const unreadInside = !open && hasUnreadPage(folder.id);
    el.className =
      "side-row lib-row lib-folder" +
      (open ? " expanded" : "") +
      (drag?.id === folder.id && drag.kind === "folder" ? " lib-drag-source" : "");
    el.role = "treeitem";
    el.tabIndex = 0;
    el.ariaLabel = `${folder.name} (folder)` + (unreadInside ? " (unread)" : "");
    el.ariaLevel = String(depth + 1);
    el.dataset.kind = "folder";
    el.dataset.id = folder.id;
    el.dataset.depth = String(depth);
    el.style.setProperty("--depth", String(depth));
    el.setAttribute("aria-expanded", open ? "true" : "false");

    const chevron = document.createElement("span");
    chevron.className = "lib-chevron";
    chevron.innerHTML = CHEVRON_SVG;
    el.appendChild(chevron);

    const icon = document.createElement("span");
    icon.className = "lib-folder-icon";
    icon.innerHTML = FOLDER_SVG;
    el.appendChild(icon);

    const text = document.createElement("span");
    text.className = "lib-text";
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = folder.name;
    text.appendChild(title);
    el.appendChild(text);

    if (unreadInside) {
      const dot = document.createElement("span");
      dot.className = "lib-unread-dot";
      dot.setAttribute("aria-label", "Has unread pages");
      el.appendChild(dot);
    }
    if (folder.description || folder.instructions) {
      const instructions = document.createElement("span");
      instructions.className = "lib-instructions-icon";
      instructions.innerHTML = host.icons.folderInstructions;
      instructions.setAttribute("aria-label", "Custom agent instructions");
      instructions.dataset.tooltip = "Custom agent instructions";
      el.appendChild(instructions);
    }
    const count = document.createElement("span");
    count.className = "lib-count";
    count.textContent = String(countPages(folder.id));
    el.appendChild(count);
    return el;
  }

  function rowFor(kind, id) {
    return list.querySelector(`.lib-row[data-kind="${kind}"][data-id="${CSS.escape(id)}"]`);
  }

  function rowKey(el) {
    const row = el?.closest?.(".lib-row");
    return row && list.contains(row) ? { kind: row.dataset.kind, id: row.dataset.id } : null;
  }

  function visibleRows() {
    return [...list.querySelectorAll(".lib-row")];
  }

  function flash(kind, id) {
    const row = rowFor(kind, id);
    if (!row) {
      return;
    }
    row.classList.remove("lib-flash");
    void row.offsetWidth;
    row.classList.add("lib-flash");
    row.addEventListener("animationend", () => row.classList.remove("lib-flash"), { once: true });
  }

  function toggleFolder(id, open = collapsed.has(id)) {
    if (open) {
      collapsed.delete(id);
    } else {
      collapsed.add(id);
    }
    saveCollapsed();
    render();
  }

  function expandChain(folderId) {
    let changed = false;
    for (const id of chainOf(folderId)) {
      changed = collapsed.delete(id) || changed;
    }
    if (changed) {
      saveCollapsed();
    }
  }

  /** Opens the Library on a page, optionally starting an inline rename. */
  function reveal(id, { rename = false } = {}) {
    const page = model.pageById.get(id) || host.pages().find((item) => item.id === id);
    if (!page) {
      return;
    }
    host.setPaneOpen(true);
    if (query) {
      clearSearch();
    }
    model = buildModel();
    expandChain(folderOfPage(page));
    render();
    const row = rowFor("page", id);
    if (!row) {
      return;
    }
    row.scrollIntoView({ block: "nearest" });
    row.focus({ preventScroll: true });
    if (rename) {
      startRename("page", id);
    } else {
      flash("page", id);
    }
  }

  function startRename(kind, id) {
    const row = rowFor(kind, id);
    const titleEl = row?.querySelector(".tab-title");
    if (!row || !titleEl) {
      return;
    }
    const item = kind === "page" ? model.pageById.get(id) : model.folderById.get(id);
    if (!item) {
      return;
    }
    const original = kind === "page" ? item.title : item.name;
    const input = document.createElement("input");
    input.className = "lib-rename";
    input.value = original;
    input.maxLength = kind === "page" ? 300 : 120;
    input.spellcheck = false;
    input.setAttribute("aria-label", kind === "page" ? "Page title" : "Folder name");
    titleEl.replaceWith(input);
    row.classList.add("renaming");
    renaming = { kind, id, input };
    input.focus();
    input.select();

    const finish = (commit) => {
      if (renaming?.input !== input) {
        return;
      }
      renaming = null;
      const value = input.value.trim();
      if (commit && value && value !== original) {
        commitRename(kind, item, value, original);
      }
      render();
      rowFor(kind, id)?.focus({ preventScroll: true });
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("dblclick", (event) => event.stopPropagation());
  }

  function cancelRename() {
    if (!renaming) {
      return false;
    }
    const { kind, id, input } = renaming;
    input.value = kind === "page" ? model.pageById.get(id)?.title ?? "" : model.folderById.get(id)?.name ?? "";
    input.blur();
    return true;
  }

  async function commitRename(kind, item, value, original) {
    if (kind === "page") {
      item.title = value;
    } else {
      item.name = value;
    }
    const res = await send(
      kind === "page" ? "POST" : "PATCH",
      kind === "page" ? `/api/tabs/${encodeURIComponent(item.id)}/rename` : `/api/folders/${encodeURIComponent(item.id)}`,
      kind === "page" ? { title: value } : { name: value }
    );
    if (!res.ok) {
      if (kind === "page") {
        item.title = original;
      } else {
        item.name = original;
      }
      host.showNotice("Could not rename");
      host.rerender();
    }
  }

  function send(method, url, body) {
    return fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => ({ ok: false, json: async () => ({}) }));
  }

  async function openFolderPages(id, firstId) {
    const res = await send("POST", `/api/folders/${encodeURIComponent(id)}/open`);
    if (res.ok && firstId) {
      host.focusWhenOpened(firstId);
    }
  }

  // ---------- files on disk (#654) ----------
  // Where the last Open file / Open folder dialog was, so the next one starts there.
  let lastDiskPath = "";

  /** Open a file from disk as a page (in folder parentId), and show it. */
  async function openDiskFile(parentId = null) {
    const picked = await window.scribeChat?.pickWorkspace?.(lastDiskPath, { files: "open", title: "Open file", hint: "", action: "Open" });
    if (!picked) {
      return;
    }
    lastDiskPath = picked;
    const res = await send("POST", "/api/files/open", { path: picked, folderId: parentId });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.tab) {
      host.showNotice(data.error || "Could not open the file");
      return;
    }
    if (parentId) {
      expandChain(parentId);
    }
    host.focusWhenOpened(data.tab.id);
  }

  /** Open a disk folder: a Library folder of file pages, one per file, with its subfolders. */
  async function openDiskFolder(parentId = null) {
    const picked = await window.scribeChat?.pickWorkspace?.(lastDiskPath, { title: "Open folder", hint: "", action: "Open folder", used: false });
    if (!picked) {
      return;
    }
    lastDiskPath = picked;
    const res = await send("POST", "/api/files/open-folder", { path: picked, folderId: parentId });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.folder) {
      host.showNotice(data.error || "Could not open the folder");
      return;
    }
    host.addFolder(data.folder);
    host.setPaneOpen(true);
    expandChain(data.folder.id);
    render();
    rowFor("folder", data.folder.id)?.scrollIntoView({ block: "nearest" });
    const count = data.pages + data.reused;
    host.showNotice(`Opened ${data.folder.name}: ${count === 1 ? "1 file" : `${count} files`}${data.truncated ? " (stopped at the file limit)" : ""}`);
  }

  async function createFolder(parentId = null) {
    if (query) {
      clearSearch();
    }
    const res = await send("POST", "/api/folders", { name: "New folder", parentId });
    if (!res.ok) {
      host.showNotice("Could not create a folder");
      return;
    }
    const { folder } = await res.json();
    host.addFolder(folder);
    host.setPaneOpen(true);
    if (parentId) {
      expandChain(parentId);
    }
    pendingRename = { kind: "folder", id: folder.id };
    render();
    rowFor("folder", folder.id)?.scrollIntoView({ block: "nearest" });
  }

  async function deletePage(id) {
    const page = model.pageById.get(id);
    const res = await send("DELETE", `/api/tabs/${encodeURIComponent(id)}?permanent=true`);
    if (res.ok) {
      host.showNotice(`Deleted “${page?.title ?? "page"}”`, { undo: true });
    }
  }

  async function deleteFolder(id) {
    const folder = model.folderById.get(id);
    if (!folder) {
      return;
    }
    const pages = countPages(id);
    const subfolders = subtree(id).size - 1;
    if (!pages && !subfolders) {
      await send("DELETE", `/api/folders/${encodeURIComponent(id)}?mode=lift`);
      return;
    }
    const what = describeContents(pages, subfolders);
    const choice = await host.choose(`Delete the folder “${folder.name}”? It holds ${what}.`, [
      { value: "lift", label: "Move contents up" },
      { value: "delete", label: "Delete all", danger: true },
    ]);
    if (!choice) {
      return;
    }
    const res = await send("DELETE", `/api/folders/${encodeURIComponent(id)}?mode=${choice}`);
    if (res.ok && choice === "delete") {
      host.showNotice(`Deleted “${folder.name}” with ${what}`, { undo: true });
    }
  }

  function describeContents(pages, subfolders) {
    const parts = [];
    if (pages) {
      parts.push(pages === 1 ? "1 page" : `${pages} pages`);
    }
    if (subfolders) {
      parts.push(subfolders === 1 ? "1 folder" : `${subfolders} folders`);
    }
    return parts.join(" and ");
  }

  /* ---------- clean up ---------- */

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  function loadCleanupPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(CLEANUP_KEY) || "{}");
      if (Number.isInteger(saved.age) && saved.age > 0) {
        cleanupAge.value = String(saved.age);
      }
      if ([...cleanupUnit.options].some((opt) => opt.value === String(saved.unit))) {
        cleanupUnit.value = String(saved.unit);
      }
      if (saved.basis in CLEANUP_BASIS_HELP) {
        cleanupBasis.value = saved.basis;
      }
    } catch {
      // Defaults from the markup stand.
    }
    for (const wrap of cleanupSelects) {
      wrap.syncSelect();
    }
  }

  function saveCleanupPrefs() {
    try {
      localStorage.setItem(
        CLEANUP_KEY,
        JSON.stringify({ age: Number(cleanupAge.value), unit: Number(cleanupUnit.value), basis: cleanupBasis.value })
      );
    } catch {
      // Only a convenience.
    }
  }

  /** Current dialog choices, or null while the age is not a whole number of at least 1. */
  function cleanupOptions() {
    const age = Number(cleanupAge.value);
    if (!Number.isInteger(age) || age < 1) {
      return null;
    }
    return {
      days: age * Number(cleanupUnit.value),
      basis: cleanupBasis.value,
      includeOpen: cleanupOpen.getAttribute("aria-checked") === "true",
      includePinned: cleanupPinned.getAttribute("aria-checked") === "true",
    };
  }

  function showCleanupPreview(pages) {
    cleanupList.replaceChildren();
    if (!pages) {
      cleanupSummary.textContent = "Enter an age of at least 1.";
      cleanupList.hidden = true;
      cleanupSubmit.disabled = true;
      cleanupSubmit.textContent = "Delete";
      return;
    }
    const n = pages.length;
    cleanupSubmit.disabled = n === 0;
    cleanupSubmit.textContent = n ? `Delete ${plural(n, "tab")}` : "Delete";
    cleanupList.hidden = n === 0;
    if (!n) {
      cleanupSummary.textContent = "No tabs match.";
      return;
    }
    const count = document.createElement("strong");
    count.textContent = plural(n, "tab");
    cleanupSummary.replaceChildren(count, " will be deleted. They stay in the Trash for 7 days.");
    for (const page of pages) {
      const li = document.createElement("li");
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = page.title;
      li.appendChild(title);
      const tags = [page.open && "open", page.pinned && "pinned"].filter(Boolean);
      if (tags.length) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = tags.join(", ");
        li.appendChild(tag);
      }
      cleanupList.appendChild(li);
    }
  }

  async function previewCleanup() {
    clearTimeout(cleanupTimer);
    cleanupBasisHelp.textContent = CLEANUP_BASIS_HELP[cleanupBasis.value] || "";
    const opts = cleanupOptions();
    const req = ++cleanupReq;
    if (!opts) {
      showCleanupPreview(null);
      return;
    }
    const res = await send("POST", "/api/library/cleanup", { ...opts, dryRun: true });
    if (req !== cleanupReq || !cleanupDlg.open) {
      return;
    }
    if (!res.ok) {
      cleanupSummary.textContent = "Could not check which tabs match.";
      cleanupList.hidden = true;
      cleanupSubmit.disabled = true;
      return;
    }
    const data = await res.json();
    if (req === cleanupReq) {
      showCleanupPreview(data.pages || []);
    }
  }

  function schedulePreview() {
    clearTimeout(cleanupTimer);
    cleanupTimer = window.setTimeout(previewCleanup, 150);
  }

  function openCleanup() {
    loadCleanupPrefs();
    cleanupOpen.setAttribute("aria-checked", "false");
    cleanupPinned.setAttribute("aria-checked", "false");
    cleanupSummary.textContent = "";
    cleanupList.hidden = true;
    cleanupSubmit.disabled = true;
    cleanupSubmit.textContent = "Delete";
    cleanupDlg.returnValue = "cancel";
    cleanupDlg.showModal();
    cleanupAge.focus();
    cleanupAge.select();
    previewCleanup();
  }

  async function runCleanup() {
    const opts = cleanupOptions();
    if (!opts) {
      return;
    }
    saveCleanupPrefs();
    const res = await send("POST", "/api/library/cleanup", opts);
    if (!res.ok) {
      host.showNotice("Could not clean up tabs");
      return;
    }
    const { deleted = [] } = await res.json();
    host.showNotice(deleted.length ? `Deleted ${plural(deleted.length, "tab")}` : "No tabs matched", {
      undo: deleted.length > 0,
    });
  }

  /** Local position for an insert at `index`, mirroring the server so the optimistic order is right. */
  function slotPos(positions, index) {
    if (!positions.length) {
      return 0;
    }
    if (index <= 0) {
      return positions[0] - 1;
    }
    if (index >= positions.length) {
      return positions[positions.length - 1] + 1;
    }
    return (positions[index - 1] + positions[index]) / 2;
  }

  /** Applies a page move locally, then on the server; snaps back if the server refuses. */
  async function movePage(id, folderId, index, { close = false } = {}) {
    const page = model.pageById.get(id) || host.pages().find((item) => item.id === id);
    if (!page) {
      return;
    }
    const before = { folderId: page.folderId, libPos: page.libPos };
    const siblings = pagesOf(folderId).filter((item) => item.id !== id);
    page.libPos = slotPos(
      siblings.map((item) => item.libPos),
      index
    );
    page.folderId = folderId || undefined;
    render();
    flash("page", id);
    const res = await send("POST", `/api/tabs/${encodeURIComponent(id)}/move`, { folderId, index, close });
    if (!res.ok) {
      page.folderId = before.folderId;
      page.libPos = before.libPos;
      host.showNotice("Could not move the page");
      host.rerender();
    }
  }

  async function moveFolder(id, parentId, index) {
    const folder = model.folderById.get(id);
    if (!folder) {
      return;
    }
    const before = { parentId: folder.parentId, pos: folder.pos };
    const siblings = foldersOf(parentId).filter((item) => item.id !== id);
    folder.pos = slotPos(
      siblings.map((item) => item.pos),
      index
    );
    folder.parentId = parentId;
    render();
    flash("folder", id);
    const res = await send("POST", `/api/folders/${encodeURIComponent(id)}/move`, { parentId, index });
    if (!res.ok) {
      folder.parentId = before.parentId;
      folder.pos = before.pos;
      host.showNotice("Could not move the folder");
      host.rerender();
    }
  }

  function nudge(kind, id, dir) {
    if (kind === "page") {
      const page = model.pageById.get(id);
      if (!page) {
        return;
      }
      const folderId = folderOfPage(page);
      const siblings = pagesOf(folderId);
      const at = siblings.indexOf(page);
      const to = Math.max(0, Math.min(siblings.length - 1, at + dir));
      if (to !== at) {
        movePage(id, folderId, to);
      }
      return;
    }
    const folder = model.folderById.get(id);
    if (!folder) {
      return;
    }
    const siblings = foldersOf(folder.parentId);
    const at = siblings.indexOf(folder);
    const to = Math.max(0, Math.min(siblings.length - 1, at + dir));
    if (to !== at) {
      moveFolder(id, folder.parentId, to);
    }
  }

  /** A click or Enter on a page row: Shift opens it in a split, Alt peeks, anything else navigates. */
  function openWith(id, event) {
    const mode = host.modeFromEvent(event);
    if (mode === "peek" || mode === "split") {
      host.openIn(id, mode);
      return;
    }
    activatePage(id, true);
  }

  function activatePage(id, activate = true) {
    if (host.isOpen(id)) {
      if (activate) {
        host.selectTab(id);
      }
      return;
    }
    host.openPage(id, { activate });
  }

  function clearSearch() {
    if (!search.value && !query) {
      return false;
    }
    search.value = "";
    query = "";
    hits = null;
    render();
    return true;
  }

  function scheduleSearch(delay = 200) {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(runSearch, delay);
  }

  async function runSearch() {
    query = search.value.trim();
    if (!query) {
      hits = null;
      render();
      return;
    }
    const req = ++searchReq;
    const res = await fetch(`/api/library?query=${encodeURIComponent(query)}&limit=200`).catch(() => null);
    if (req !== searchReq || !res?.ok) {
      return;
    }
    const data = await res.json();
    hits = data.tabs || [];
    hitTotal = data.matchCount ?? hits.length;
    render();
  }

  /* ---------- menus ---------- */

  function openMenu(point, items) {
    closeMenu();
    menu.replaceChildren();
    menu.classList.remove("lib-picker");
    let lastWasSep = true;
    for (const item of items) {
      if (!item) {
        continue;
      }
      if (item === "sep") {
        if (!lastWasSep) {
          const sep = document.createElement("div");
          sep.className = "menu-sep";
          menu.appendChild(sep);
          lastWasSep = true;
        }
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.role = "menuitem";
      btn.textContent = item.label;
      btn.disabled = Boolean(item.disabled);
      if (item.danger) {
        btn.classList.add("danger");
      }
      btn.addEventListener("click", () => {
        closeMenu();
        item.action();
      });
      menu.appendChild(btn);
      lastWasSep = false;
    }
    if (menu.lastElementChild?.classList.contains("menu-sep")) {
      menu.lastElementChild.remove();
    }
    showMenuAt(point);
  }

  function showMenuAt(point) {
    host.hoverCard.hide();
    menu.hidden = false;
    const margin = 8;
    const { offsetWidth: width, offsetHeight: height } = menu;
    const above = point.y + height > window.innerHeight - margin;
    const top = above ? Math.max(margin, point.y - height) : point.y;
    const left = Math.max(margin, Math.min(point.x, window.innerWidth - width - margin));
    menu.dataset.side = above ? "above" : "below";
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }

  function closeMenu() {
    if (menu.hidden) {
      return false;
    }
    menu.hidden = true;
    menu.replaceChildren();
    delete menu.dataset.owner;
    return true;
  }

  function pointFor(event) {
    if (event.clientX || event.clientY) {
      return { x: event.clientX, y: event.clientY };
    }
    const box = (event.currentTarget instanceof Element ? event.currentTarget : event.target).getBoundingClientRect();
    return { x: box.left, y: box.bottom + 4 };
  }

  function pageMenu(event, id) {
    event.preventDefault();
    event.stopPropagation();
    const tab = host.findAny(id);
    if (!tab) {
      return;
    }
    const point = pointFor(event);
    if (tab.key === "welcome") {
      openMenu(point, [
        { label: "Copy key", action: () => host.copyTabKey(id) },
      ]);
      return;
    }
    const fromStrip = Boolean(event.target.closest?.(".tab"));
    openMenu(point, [
      host.canPopOut?.(id) && { label: "Open in new window", action: () => host.popOut(id) },
      tab.temp
        ? { label: "Keep in Library", action: () => host.keepPage(id) }
        : { label: tab.pinned ? "Unpin" : "Pin", action: () => host.setPinned(id, !tab.pinned) },
      "sep",
      // Renaming happens in the Library row, which a temporary page doesn't have.
      !tab.temp && { label: "Rename", action: () => reveal(id, { rename: true }) },
      { label: "Move to…", action: () => openMovePicker({ kind: "page", id }, point) },
      fromStrip && !tab.temp && { label: "Show in Library", action: () => reveal(id) },
      "sep",
      { label: "Export", action: () => host.downloadExport(id) },
      { label: "Agent access…", action: () => editAgentAccess({ kind: "page", id }) },
      !tab.embedUrl && { label: "Permissions…", action: () => host.managePermissions(id) },
      { label: tab.workspace ? "Change workspace…" : "Set workspace…", action: () => host.pickPageWorkspace(id) },
      { label: "Copy key", action: () => host.copyTabKey(id) },
      "sep",
      { label: "Delete", danger: true, action: () => deletePage(id) },
    ]);
  }

  function editFolderInstructions(folder) {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm folder-instructions";
    dialog.setAttribute("aria-labelledby", "folder-instructions-title");
    const form = document.createElement("form");
    const title = document.createElement("h2");
    title.id = "folder-instructions-title";
    title.textContent = `${folder.name} instructions`;
    form.appendChild(title);
    const fields = [];
    for (const [key, label, rows] of [["description", "Description", 1], ["instructions", "Instructions", 5]]) {
      const wrap = document.createElement("div");
      wrap.className = "folder-instructions-field";
      const caption = document.createElement("label");
      caption.htmlFor = `folder-instructions-${key}`;
      caption.textContent = label;
      const input = document.createElement("textarea");
      input.id = caption.htmlFor;
      input.rows = rows;
      input.value = folder[key] || "";
      const resize = () => {
        input.style.height = "auto";
        input.style.height = `${input.scrollHeight + 2}px`;
      };
      input.addEventListener("input", resize);
      fields.push({ key, input, resize });
      wrap.append(caption, input);
      form.appendChild(wrap);
    }
    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => dialog.close());
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "primary";
    save.textContent = "Save";
    actions.append(cancel, save);
    form.appendChild(actions);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      const values = Object.fromEntries(fields.map(({ key, input }) => [key, input.value]));
      const res = await send("PUT", `/api/folders/${encodeURIComponent(folder.id)}/instructions`, values);
      save.disabled = false;
      if (!res.ok) {
        host.showNotice("Could not save folder instructions");
        return;
      }
      dialog.close();
    });
    dialog.appendChild(form);
    document.body.appendChild(dialog);
    const resize = () => fields.forEach((field) => field.resize());
    window.addEventListener("resize", resize);
    dialog.addEventListener("close", () => {
      window.removeEventListener("resize", resize);
      dialog.remove();
    }, { once: true });
    dialog.showModal();
    resize();
    fields[0].input.focus();
  }

  const ACCESS_LEVELS = [
    { id: "open", label: "Open", detail: "Chats in scope reach it; others ask." },
    { id: "ask", label: "Ask always", detail: "Every chat asks, even global ones." },
    { id: "trusted", label: "Trusted only", detail: "Only chats on trusted model sources." },
    { id: "restricted", label: "Restricted", detail: "Only chats on this exact page." },
  ];
  const LEVEL_RANK = { open: 0, ask: 1, trusted: 2, restricted: 3 };

  /** The strictest level among a folder and its parents (#269). */
  function inheritedLevel(folderId) {
    let level = "open";
    const seen = new Set();
    for (let at = folderId ? model.folderById.get(folderId) : null; at && !seen.has(at.id); at = at.parentId ? model.folderById.get(at.parentId) : null) {
      seen.add(at.id);
      const own = at.access?.level || "open";
      if (LEVEL_RANK[own] > LEVEL_RANK[level]) level = own;
    }
    return level;
  }

  function folderPathOf(id) {
    const names = [];
    const seen = new Set();
    for (let at = model.folderById.get(id); at && !seen.has(at.id); at = at.parentId ? model.folderById.get(at.parentId) : null) {
      seen.add(at.id);
      names.unshift(at.name);
    }
    return names.join("/") || id;
  }

  /** A page's or folder's agent access (#269): its level, where it came from, and the grants chats on it hold. */
  function editAgentAccess(target) {
    const current = () => (target.kind === "page" ? host.findAny(target.id) : model.folderById.get(target.id));
    if (!current()) return;
    const el = (tag, cls, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    };
    const nameOf = (t) => (t.kind === "page" ? `“${host.findAny(t.id)?.title || t.id}”` : `${folderPathOf(t.id)}/`);
    const dlg = el("dialog", "confirm permissions agent-access");
    const form = el("form");
    form.method = "dialog";
    const head = el("h2", "", "Agent access");
    const rows = el("div", "permissions-rows");
    const actions = el("div", "confirm-actions");
    const done = el("button", "", "Done");
    done.type = "submit";
    actions.append(done);
    form.append(head, rows, actions);
    dlg.append(form);

    const save = async (body) => {
      const url = target.kind === "page" ? `/api/tabs/${encodeURIComponent(target.id)}/access` : `/api/folders/${encodeURIComponent(target.id)}/access`;
      const res = await send("PUT", url, body);
      if (!res.ok) {
        host.showNotice((await res.json().catch(() => ({}))).error || "Could not change agent access");
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (target.kind === "folder" && data.folder) model.folderById.set(target.id, { ...current(), ...data.folder, access: data.folder.access });
      render(data.tab);
    };

    const render = (fresh) => {
      const item = fresh || current();
      if (!item) return;
      rows.replaceChildren();
      const own = target.kind === "page" ? (item.agentHidden ? "restricted" : item.access?.level || "open") : item.access?.level || "open";
      const inherited = inheritedLevel(target.kind === "page" ? item.folderId : item.parentId);
      const row = el("div", "permission-row");
      const text = el("div", "permission-text");
      const levels = target.kind === "page" ? ACCESS_LEVELS : ACCESS_LEVELS.map((l) => (l.id === "restricted" ? { ...l, detail: "Only chats on each page itself." } : l));
      // A stricter parent folder decides; say that instead of what this level alone would do.
      const detail = LEVEL_RANK[inherited] > LEVEL_RANK[own]
        ? `A parent folder makes it ${levels.find((l) => l.id === inherited).label}.`
        : levels.find((l) => l.id === own)?.detail || "";
      text.append(el("div", "permission-label", target.kind === "page" ? item.title : folderPathOf(target.id)), el("div", "permission-detail", detail));
      const select = el("select");
      select.setAttribute("aria-label", "Agent access level");
      for (const level of levels) {
        const opt = el("option", "", level.label);
        opt.value = level.id;
        select.append(opt);
      }
      select.value = own;
      select.addEventListener("change", () => save({ level: select.value }));
      row.append(text, window.createSelect ? window.createSelect(select) : select);
      rows.append(row);
      const origin = target.kind === "page" ? item.access?.origin : null;
      if (origin) rows.append(el("div", "permission-detail agent-access-origin", `Created from ${nameOf(origin)}`));
      const grants = item.access?.grants || [];
      if (grants.length) {
        rows.append(el("div", "permission-label agent-access-head", "Chats here also reach"));
        const list = el("div", "permission-folders");
        for (const grant of grants) {
          const line = el("div", "permission-folder");
          const remove = el("button", "permission-remove", "Remove");
          remove.type = "button";
          remove.addEventListener("click", () => save({ removeGrants: [grant] }));
          line.append(el("span", "permission-path", nameOf(grant)), remove);
          list.append(line);
        }
        rows.append(list);
      }
    };

    render();
    document.body.append(dlg);
    dlg.addEventListener("close", () => dlg.remove(), { once: true });
    dlg.showModal();
    done.focus();
  }

  function folderMenu(event, id) {
    event.preventDefault();
    event.stopPropagation();
    const folder = model.folderById.get(id);
    if (!folder) {
      return;
    }
    const point = pointFor(event);
    openMenu(point, [
      { label: "New folder", action: () => createFolder(id) },
      "sep",
      { label: "Rename", action: () => startRename("folder", id) },
      { label: "Move to…", action: () => openMovePicker({ kind: "folder", id }, point) },
      { label: "Open file here…", action: () => openDiskFile(id) },
      { label: "Open folder here…", action: () => openDiskFolder(id) },
      "sep",
      { label: "Export folder", action: () => host.downloadFolderExport(id) },
      { label: "Agent instructions", action: () => editFolderInstructions(folder) },
      { label: "Agent access…", action: () => editAgentAccess({ kind: "folder", id }) },
      "sep",
      { label: "Delete folder…", danger: true, action: () => deleteFolder(id) },
    ]);
  }

  function libraryMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    if (menu.dataset.owner === "library") {
      closeMenu();
      return;
    }
    const box = moreBtn.getBoundingClientRect();
    openMenu({ x: box.left, y: box.bottom + 4 }, [
      { label: "New folder", action: () => createFolder(null) },
      { label: "Open file…", action: () => openDiskFile(null) },
      { label: "Open folder…", action: () => openDiskFolder(null) },
      { label: "Expand all", disabled: model.folders.length === 0, action: () => setAllCollapsed(false) },
      { label: "Collapse all", disabled: model.folders.length === 0, action: () => setAllCollapsed(true) },
      "sep",
      { label: "Clean up tabs…", action: () => openCleanup() },
      { label: "Trash", action: () => host.openTrash() },
      "sep",
      { label: "Export all", action: () => host.downloadAll() },
    ]);
    menu.dataset.owner = "library";
  }

  function setAllCollapsed(value) {
    collapsed.clear();
    if (value) {
      for (const folder of model.folders) {
        collapsed.add(folder.id);
      }
    }
    saveCollapsed();
    render();
  }

  /** "Move to…": a filterable folder list; typing a new name offers to create it. */
  function openMovePicker(item, point) {
    closeMenu();
    const excluded = item.kind === "folder" ? subtree(item.id) : new Set();
    const currentParent =
      item.kind === "folder"
        ? model.folderById.get(item.id)?.parentId ?? null
        : folderOfPage(model.pageById.get(item.id) || {});
    const entries = [{ id: null, name: "Library", path: "", depth: 0 }];
    const walk = (parentId, depth) => {
      for (const folder of foldersOf(parentId)) {
        if (excluded.has(folder.id)) {
          continue;
        }
        entries.push({ id: folder.id, name: folder.name, path: pathOf(folder.id), depth });
        walk(folder.id, depth + 1);
      }
    };
    walk(null, 1);

    menu.replaceChildren();
    menu.classList.add("lib-picker");
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "Move to folder…";
    input.spellcheck = false;
    const results = document.createElement("div");
    results.className = "lib-picker-list";
    menu.append(input, results);

    let active = 0;
    let shown = [];
    const choose = async (entry) => {
      closeMenu();
      let target = entry.id;
      if (entry.create) {
        const res = await send("POST", "/api/folders", { name: entry.create, parentId: null });
        if (!res.ok) {
          host.showNotice("Could not create a folder");
          return;
        }
        const { folder } = await res.json();
        host.addFolder(folder);
        target = folder.id;
        model = buildModel();
      }
      expandChain(target);
      if (item.kind === "page") {
        await movePage(item.id, target, 0);
      } else {
        await moveFolder(item.id, target, Number.MAX_SAFE_INTEGER);
      }
    };
    const draw = () => {
      const text = input.value.trim().toLowerCase();
      shown = text ? entries.filter((entry) => entry.id && entry.path.toLowerCase().includes(text)) : entries.slice();
      if (text && !entries.some((entry) => entry.name.toLowerCase() === text)) {
        shown.push({ id: null, create: input.value.trim(), name: `New folder “${input.value.trim()}”`, depth: 0 });
      }
      active = Math.min(active, Math.max(0, shown.length - 1));
      results.replaceChildren();
      shown.forEach((entry, index) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.role = "menuitem";
        btn.className = "lib-picker-row" + (index === active ? " active" : "") + (entry.create ? " create" : "");
        btn.style.setProperty("--depth", String(text ? 0 : entry.depth));
        const here = !entry.create && entry.id === currentParent;
        btn.disabled = here;
        const icon = document.createElement("span");
        icon.className = "lib-folder-icon";
        icon.innerHTML = FOLDER_SVG;
        const label = document.createElement("span");
        label.className = "tab-title";
        label.textContent = text && entry.path ? entry.path : entry.name;
        btn.append(icon, label);
        if (here) {
          const note = document.createElement("span");
          note.className = "lib-picker-here";
          note.textContent = "current";
          btn.appendChild(note);
        }
        btn.addEventListener("mouseenter", () => {
          active = index;
          highlight();
        });
        btn.addEventListener("click", () => choose(entry));
        results.appendChild(btn);
      });
    };
    const highlight = () => {
      [...results.children].forEach((child, index) => child.classList.toggle("active", index === active));
      results.children[active]?.scrollIntoView({ block: "nearest" });
    };
    input.addEventListener("input", () => {
      active = 0;
      draw();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (shown.length) {
          active = (active + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
          highlight();
        }
      } else if (event.key === "Enter") {
        event.preventDefault();
        const entry = shown[active];
        if (entry && !(entry.id === currentParent && !entry.create)) {
          choose(entry);
        }
      }
    });
    draw();
    showMenuAt(point);
    input.focus();
  }

  /* ---------- drag and drop ---------- */

  function newDrag(kind, id, fromStrip) {
    return {
      kind,
      id,
      fromStrip,
      x: 0,
      y: 0,
      ghost: null,
      target: null,
      expandFor: null,
      expandTimer: 0,
      /** Folders the drag expanded; re-collapsed unless the drop lands inside them. */
      autoOpened: new Set(),
      recollapse: new Map(),
    };
  }

  function onPointerDown(event) {
    if (event.button !== 0 || renaming || drag || press) {
      return;
    }
    const row = event.target.closest(".lib-row");
    if (!row || event.target.closest(".tab-close, input") || (query && row.dataset.kind === "folder")) {
      return;
    }
    press = {
      kind: row.dataset.kind,
      id: row.dataset.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    press.controller = window.scribeDrag({ event, target: list,
      threshold: DRAG_THRESHOLD,
      onStart: beginDrag,
      measure: api => {
        if (!drag) return;
        drag.box = api.rect(list);
        drag.rows = visibleRows().map(row => ({ row, rect: api.rect(row), top: row.offsetTop, bottom: row.offsetTop + row.offsetHeight }));
      },
      onMove: onPointerMove,
      onDrop: onPointerUp,
      onCancel: () => { press = null; cancelDrag(); },
    });
  }

  function onPointerMove(event) {
    if (!press || event.pointerId !== press.pointerId) {
      return;
    }
    event.preventDefault();
    drag.x = event.clientX;
    drag.y = event.clientY;
    placeGhost();
    refreshTarget();
    return autoScroll();
  }

  function beginDrag(event) {
    drag = newDrag(press.kind, press.id, false);
    const item = press.kind === "page" ? model.pageById.get(press.id) : model.folderById.get(press.id);
    const ghost = document.createElement("div");
    ghost.className = "lib-ghost";
    const icon = document.createElement("span");
    icon.className = press.kind === "page" ? "fileicon" : "lib-folder-icon";
    icon.innerHTML = press.kind === "page" ? host.icons.file : FOLDER_SVG;
    const label = document.createElement("span");
    label.className = "tab-title";
    label.textContent = press.kind === "page" ? item?.title ?? "" : item?.name ?? "";
    ghost.append(icon, label);
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.x = event.clientX;
    drag.y = event.clientY;
    placeGhost();
    rowFor(press.kind, press.id)?.classList.add("lib-drag-source");
    host.hoverCard.suspend();
    closeMenu();
    document.body.classList.add("dragging-lib");
  }

  function placeGhost() {
    if (drag?.ghost) {
      drag.ghost.style.transform = `translate(${drag.x + 12}px, ${drag.y - 14}px)`;
    }
  }

  function refreshTarget() {
    if (!drag) {
      return;
    }
    let target = null;
    const page = drag.kind === "page" ? host.findAny(drag.id) : null;
    if (!drag.fromStrip && page) {
      const strip = host.stripSlot(drag.x, drag.y, page);
      if (strip) {
        target = { where: "strip", before: strip.before };
      }
    }
    if (!target) {
      if (!drag.fromStrip) {
        host.clearStripSlot();
      }
      const lib = libraryTarget(drag.x, drag.y);
      target = lib ? { where: "lib", ...lib } : null;
    }
    setTarget(target);
  }

  function measureLibrary() {
    if (!drag) return;
    const box = window.scribeDrag.rect(list);
    if (drag.rows && drag.box === box) return;
    drag.box = box;
    drag.rows = visibleRows().map(row => ({ row, rect: window.scribeDrag.rect(row), top: row.offsetTop, bottom: row.offsetTop + row.offsetHeight }));
  }
  function invalidateLibrary() {
    if (drag) drag.rows = null;
    window.scribeDrag.invalidate();
  }
  list.addEventListener("scroll", invalidateLibrary, { passive: true });

  function libraryTarget(x, y) {
    if (!host.paneOpen() || (query && hits)) {
      return null;
    }
    measureLibrary();
    const box = drag.box;
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) {
      return null;
    }
    const hit = drag.rows.find(entry => y >= entry.rect.top && y < entry.rect.bottom);
    const row = hit?.row;
    if (!row) {
      return drag.kind === "page"
        ? { folderId: null, index: pagesOf(null).filter((p) => p.id !== drag.id).length, into: ROOT }
        : { folderId: null, index: foldersOf(null).filter((f) => f.id !== drag.id).length, into: ROOT };
    }
    const r = hit.rect;
    const frac = (y - r.top) / r.height;
    const kind = row.dataset.kind;
    const id = row.dataset.id;
    const depth = Number(row.dataset.depth) || 0;
    const top = hit.top;
    const bottom = hit.bottom;

    if (drag.kind === "page") {
      if (kind === "folder") {
        return { folderId: id, index: 0, into: id };
      }
      if (id === drag.id) {
        return { noop: true };
      }
      const page = model.pageById.get(id);
      const folderId = folderOfPage(page);
      const siblings = pagesOf(folderId).filter((p) => p.id !== drag.id);
      const index = siblings.indexOf(page) + (frac >= 0.5 ? 1 : 0);
      return { folderId, index, line: { top: frac >= 0.5 ? bottom : top, depth } };
    }

    const own = subtree(drag.id);
    if (kind === "folder") {
      if (own.has(id)) {
        return { noop: true };
      }
      const folder = model.folderById.get(id);
      const parentId = folder.parentId && model.folderById.has(folder.parentId) ? folder.parentId : null;
      const siblings = foldersOf(parentId).filter((f) => f.id !== drag.id);
      const at = siblings.indexOf(folder);
      const expandedWithKids = !collapsed.has(id) && (pagesOf(id).length > 0 || foldersOf(id).length > 0);
      if (frac < 0.3) {
        return { folderId: parentId, index: at, line: { top, depth } };
      }
      if (frac > 0.7 && !expandedWithKids) {
        return { folderId: parentId, index: at + 1, line: { top: bottom, depth } };
      }
      const inner = foldersOf(id).filter((f) => f.id !== drag.id);
      return { folderId: id, index: frac > 0.7 ? 0 : inner.length, into: id };
    }
    const page = model.pageById.get(id);
    const folderId = folderOfPage(page);
    if (folderId && own.has(folderId)) {
      return { noop: true };
    }
    const index = foldersOf(folderId).filter((f) => f.id !== drag.id).length;
    return { folderId, index, into: folderId ?? ROOT };
  }

  function setTarget(target) {
    drag.target = target;
    paintTarget(target);
    syncAutoExpand(target);
  }

  function paintTarget(target) {
    list.querySelector(".lib-drop-into")?.classList.remove("lib-drop-into");
    list.classList.toggle("lib-drop-root", target?.where === "lib" && target.into === ROOT);
    if (target?.where === "lib" && target.into && target.into !== ROOT) {
      rowFor("folder", target.into)?.classList.add("lib-drop-into");
    }
    const line = target?.where === "lib" ? target.line : null;
    if (!line) {
      lineEl.classList.remove("on");
      return;
    }
    const left = ROW_PAD + line.depth * INDENT + 4;
    const fresh = !lineEl.classList.contains("on");
    if (fresh) {
      lineEl.style.transition = "none";
    }
    lineEl.style.transform = `translate(${left}px, ${line.top - 1}px)`;
    lineEl.style.width = `calc(100% - ${left + 10}px)`;
    lineEl.classList.add("on");
    if (fresh) {
      requestAnimationFrame(() => { lineEl.style.transition = ""; });
    }
  }

  function syncAutoExpand(target) {
    const into = target?.where === "lib" && target.into && target.into !== ROOT ? target.into : null;
    if (into && collapsed.has(into)) {
      if (drag.expandFor !== into) {
        clearTimeout(drag.expandTimer);
        drag.expandFor = into;
        drag.expandTimer = window.setTimeout(() => {
          if (!drag) {
            return;
          }
          drag.expandFor = null;
          collapsed.delete(into);
          drag.autoOpened.add(into);
          render(true);
        }, EXPAND_DELAY);
      }
    } else if (drag.expandFor) {
      clearTimeout(drag.expandTimer);
      drag.expandFor = null;
    }
    const keep = target?.where === "lib" ? chainOf(target.into && target.into !== ROOT ? target.into : target.folderId) : new Set();
    for (const id of drag.autoOpened) {
      if (keep.has(id)) {
        clearTimeout(drag.recollapse.get(id));
        drag.recollapse.delete(id);
      } else if (!drag.recollapse.has(id)) {
        drag.recollapse.set(
          id,
          window.setTimeout(() => {
            if (!drag) {
              return;
            }
            drag.recollapse.delete(id);
            drag.autoOpened.delete(id);
            collapsed.add(id);
            render(true);
          }, RECOLLAPSE_DELAY)
        );
      }
    }
  }

  function autoScroll() {
    if (!drag) return false;
    measureLibrary();
    const box = drag.box;
    if (drag.x < box.left || drag.x > box.right || !host.paneOpen()) return false;
    let dy = 0;
    if (drag.y < box.top + SCROLL_EDGE && drag.y > box.top - SCROLL_EDGE) dy = -Math.ceil(((box.top + SCROLL_EDGE - drag.y) / SCROLL_EDGE) * 12);
    else if (drag.y > box.bottom - SCROLL_EDGE && drag.y < box.bottom + SCROLL_EDGE) dy = Math.ceil(((drag.y - (box.bottom - SCROLL_EDGE)) / SCROLL_EDGE) * 12);
    const before = list.scrollTop;
    list.scrollTop += dy;
    if (list.scrollTop === before) return false;
    invalidateLibrary();
    return true;
  }

  function onPointerUp(event) {
    if (!press || event.pointerId !== press.pointerId) {
      return;
    }
    press = null;
    if (!drag) {
      return;
    }
    dropDrag();
  }

  /** Clears timers and markers; returns the finished drag. */
  function endDrag(keepChainOf) {
    const done = drag;
    if (!done) {
      return null;
    }
    clearTimeout(done.expandTimer);
    for (const timer of done.recollapse.values()) {
      clearTimeout(timer);
    }
    const keep = keepChainOf === undefined ? new Set() : chainOf(keepChainOf);
    for (const id of done.autoOpened) {
      if (!keep.has(id)) {
        collapsed.add(id);
      }
    }
    saveCollapsed();
    drag = null;
    lineEl.classList.remove("on");
    list.classList.remove("lib-drop-root");
    list.querySelector(".lib-drop-into")?.classList.remove("lib-drop-into");
    document.body.classList.remove("dragging-lib");
    host.hoverCard.resume();
    return done;
  }

  /**
   * The folder whose chain stays open after a drop. A drop onto a folder row leaves
   * that folder as it was before the drag, so only its ancestors are kept.
   */
  function keptFolder(target) {
    if (target.into && target.into !== ROOT) {
      return model.folderById.get(target.into)?.parentId ?? null;
    }
    return target.folderId;
  }

  function dropDrag() {
    const target = drag?.target;
    if (!target || target.noop) {
      cancelDrag();
      return;
    }
    const done = endDrag(target.where === "lib" ? keptFolder(target) : undefined);
    if (renderDeferred) render();
    if (target.where === "strip") {
      host.clearStripSlot();
      fadeGhost(done.ghost);
      host.openPage(done.id, { activate: true, before: target.before });
      render();
      return;
    }
    if (done.kind === "page") {
      movePage(done.id, target.folderId, target.index);
      landGhost(done.ghost, rowFor("page", done.id));
    } else {
      moveFolder(done.id, target.folderId, target.index);
      landGhost(done.ghost, rowFor("folder", done.id));
    }
  }

  /** Esc or a drop outside any target: the ghost glides back to where it came from. */
  function cancelDrag() {
    if (!drag) {
      return false;
    }
    press?.controller?.dispose();
    press = null;
    const done = endDrag();
    if (!done.fromStrip) {
      host.clearStripSlot();
    }
    render();
    landGhost(done.ghost, rowFor(done.kind, done.id));
    return true;
  }

  function landGhost(ghost, row) {
    if (!ghost) {
      return;
    }
    if (!row || !row.getClientRects().length) {
      fadeGhost(ghost);
      return;
    }
    const box = row.getBoundingClientRect();
    ghost.classList.add("landing");
    ghost.style.transform = `translate(${box.left + 6}px, ${box.top + (box.height - ghost.offsetHeight) / 2}px)`;
    ghost.style.opacity = "0";
    window.setTimeout(() => ghost.remove(), 180);
  }

  function fadeGhost(ghost) {
    if (!ghost) {
      return;
    }
    ghost.classList.add("landing");
    ghost.style.opacity = "0";
    window.setTimeout(() => ghost.remove(), 180);
  }

  /* strip tab dragged over the Library */

  function stripDragMove(tab, x, y) {
    if (!host.paneOpen() || (query && hits)) {
      if (drag?.fromStrip) {
        endDrag();
      }
      return false;
    }
    if (!drag) {
      drag = newDrag("page", tab.id, true);
      host.hoverCard.suspend();
    }
    drag.x = x;
    drag.y = y;
    const lib = libraryTarget(x, y);
    setTarget(lib ? { where: "lib", ...lib } : null);
    autoScroll();
    return Boolean(lib);
  }

  /** Files the dragged strip tab where the line points and closes it. False when not over the Library. */
  function stripDragDrop(tab) {
    const target = drag?.fromStrip ? drag.target : null;
    if (!target || target.where !== "lib" || target.noop) {
      stripDragCancel();
      return false;
    }
    endDrag(keptFolder(target));
    movePage(tab.id, target.folderId, target.index, { close: true });
    return true;
  }

  function stripDragCancel() {
    if (drag?.fromStrip) {
      endDrag();
      render();
    }
  }

  /* ---------- events ---------- */

  list.addEventListener("pointerdown", onPointerDown);
  list.addEventListener(
    "click",
    (event) => {
      const row = event.target.closest(".lib-row");
      if (!row || renaming) {
        return;
      }
      const { kind, id } = row.dataset;
      if (event.target.closest(".tab-close")) {
        event.stopPropagation();
        deletePage(id);
        return;
      }
      if (event.detail > 1) {
        return;
      }
      if (kind === "folder") {
        toggleFolder(id);
        return;
      }
      openWith(id, event);
    },
    true
  );
  list.addEventListener("dblclick", (event) => {
    const row = event.target.closest(".lib-row");
    if (!row || event.target.closest(".tab-close") || !event.target.closest(".tab-title, .lib-text")) {
      return;
    }
    if (row.dataset.kind === "folder") {
      toggleFolder(row.dataset.id);
    }
    startRename(row.dataset.kind, row.dataset.id);
  });
  list.addEventListener("auxclick", (event) => {
    const row = event.target.closest(".lib-row");
    if (event.button !== 1 || !row) {
      return;
    }
    event.preventDefault();
    if (row.dataset.kind === "page") {
      activatePage(row.dataset.id, false);
    }
  });
  list.addEventListener("mousedown", (event) => {
    const row = event.target.closest(".lib-row");
    // Middle click would autoscroll; Shift+click (open in split) would select text.
    if (row && (event.button === 1 || (event.button === 0 && event.shiftKey && row.dataset.kind === "page"))) {
      event.preventDefault();
    }
  });
  list.addEventListener("contextmenu", (event) => {
    const row = event.target.closest(".lib-row");
    if (!row || renaming) {
      return;
    }
    if (row.dataset.kind === "folder") {
      folderMenu(event, row.dataset.id);
    } else {
      pageMenu(event, row.dataset.id);
    }
  });
  list.addEventListener("keydown", (event) => {
    const row = event.target.closest?.(".lib-row");
    if (!row || event.target !== row) {
      return;
    }
    const { kind, id } = row.dataset;
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      if (!query) {
        nudge(kind, id, event.key === "ArrowUp" ? -1 : 1);
      }
      return;
    }
    const rows = visibleRows();
    const at = rows.indexOf(row);
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
        return;
      }
      case "Home":
      case "End": {
        event.preventDefault();
        (event.key === "Home" ? rows[0] : rows[rows.length - 1])?.focus();
        return;
      }
      case "ArrowRight": {
        if (kind === "folder") {
          event.preventDefault();
          if (collapsed.has(id)) {
            toggleFolder(id, true);
          } else {
            rows[at + 1]?.focus();
          }
        }
        return;
      }
      case "ArrowLeft": {
        event.preventDefault();
        if (kind === "folder" && !collapsed.has(id)) {
          toggleFolder(id, false);
          return;
        }
        const parent = kind === "folder" ? model.folderById.get(id)?.parentId : folderOfPage(model.pageById.get(id) || {});
        if (parent) {
          rowFor("folder", parent)?.focus();
        }
        return;
      }
      case "Enter":
      case " ": {
        event.preventDefault();
        if (kind === "folder") {
          toggleFolder(id);
        } else {
          openWith(id, event);
        }
        return;
      }
      case "F2": {
        event.preventDefault();
        startRename(kind, id);
        return;
      }
      case "Delete": {
        event.preventDefault();
        (rows[at + 1] || rows[at - 1])?.focus();
        if (kind === "folder") {
          deleteFolder(id);
        } else {
          deletePage(id);
        }
        return;
      }
      default:
        return;
    }
  });

  search.addEventListener("input", () => {
    if (!search.value.trim()) {
      clearTimeout(searchTimer);
      query = "";
      hits = null;
      render();
      return;
    }
    scheduleSearch();
  });
  newFolderBtn.addEventListener("click", () => createFolder(null));
  cleanupAge.addEventListener("input", schedulePreview);
  cleanupAge.addEventListener("keydown", (event) => {
    // The form's first submit button is Cancel, so Enter would otherwise dismiss the dialog.
    if (event.key === "Enter") {
      event.preventDefault();
    }
  });
  const cleanupSelects = [window.createSelect(cleanupUnit), window.createSelect(cleanupBasis)];
  cleanupUnit.addEventListener("change", previewCleanup);
  cleanupBasis.addEventListener("change", previewCleanup);
  for (const toggle of [cleanupOpen, cleanupPinned]) {
    toggle.addEventListener("click", () => {
      toggle.setAttribute("aria-checked", toggle.getAttribute("aria-checked") === "true" ? "false" : "true");
      previewCleanup();
    });
  }
  // A click on the backdrop lands on the dialog itself (the form fills everything inside it).
  let cleanupPressedOutside = false;
  cleanupDlg.addEventListener("pointerdown", (event) => {
    cleanupPressedOutside = event.target === cleanupDlg;
  });
  cleanupDlg.addEventListener("click", (event) => {
    if (cleanupPressedOutside && event.target === cleanupDlg) {
      cleanupDlg.close("cancel");
    }
    cleanupPressedOutside = false;
  });
  cleanupDlg.addEventListener("close", () => {
    clearTimeout(cleanupTimer);
    cleanupReq++;
    if (cleanupDlg.returnValue === "ok") {
      runCleanup();
    }
  });
  moreBtn.addEventListener("click", libraryMenu);
  menu.addEventListener("contextmenu", (event) => event.preventDefault());
  document.addEventListener("pointerdown", (event) => {
    // The "…" button toggles its own menu on click, so leave that to it.
    const toggling = menu.dataset.owner === "library" && moreBtn.contains(event.target);
    if (!menu.hidden && !menu.contains(event.target) && !toggling) {
      closeMenu();
    }
  });
  window.addEventListener("blur", closeMenu);
  window.addEventListener("resize", closeMenu);
  list.addEventListener("scroll", closeMenu);

  return {
    render,
    reveal,
    pageMenu,
    openMenu,
    closeMenu,
    icons: { folder: FOLDER_SVG, chevron: CHEVRON_SVG },
    menuOpen: () => !menu.hidden,
    clearSearch,
    focusSearch() {
      search.focus();
      search.select();
    },
    searchFocused: () => document.activeElement === search && Boolean(search.value),
    refreshSearch() {
      if (query) {
        scheduleSearch(250);
      }
    },
    /** Esc: menu, then an active drag, then an inline rename. True when consumed. */
    onEscape() {
      return closeMenu() || cancelDrag() || cancelRename();
    },
    dragging: () => Boolean(drag && !drag.fromStrip),
    stripDragMove,
    stripDragDrop,
    stripDragCancel,
    pathOf(folderId) {
      model = buildModel();
      return pathOf(folderId);
    },
  };
};
