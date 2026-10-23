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
  const lensBtn = document.getElementById("library-lens");
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
  // A folder on disk (#707): the folder with a slot.
  const DISK_FOLDER_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" d="M1.5 3.5h4.2l1.5 1.5h7.3v8.5h-13zM5 8.5v2.6h6V8.5z" fill="currentColor"/></svg>';
  const CHEVRON_SVG =
    '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M5.5 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // Agent access level markers on rows (#727); Normal ("open") has none.
  const accessSvg = (d) => `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`;
  const ACCESS_SVG = {
    public: accessSvg("M4.5 7V5a3.5 3.5 0 0 1 6.8-1.2l-1.4.5A2 2 0 0 0 6 5v2h6.5A1.5 1.5 0 0 1 14 8.5v4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-4A1.5 1.5 0 0 1 3.5 7z"),
    ask: accessSvg("M5 8V3.2a1 1 0 0 1 2 0V7h.4V2.2a1 1 0 0 1 2 0V7h.4V3a1 1 0 0 1 2 0v5.2l.6-1.2a1 1 0 0 1 1.8.9l-1.9 4.3A3.5 3.5 0 0 1 9.1 14.5H8A4 4 0 0 1 4 10.5V5a1 1 0 0 1 1-1z"),
    trusted: accessSvg("M8 1.5l5.5 2.2v4.1c0 3.3-2.4 5.7-5.5 7-3.1-1.3-5.5-3.7-5.5-7V3.7z"),
    restricted: accessSvg("M4.5 7V5a3.5 3.5 0 0 1 7 0v2h1A1.5 1.5 0 0 1 14 8.5v4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-4A1.5 1.5 0 0 1 3.5 7zM6 7h4V5a2 2 0 0 0-4 0z"),
  };

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
  let selecting = false;
  const selected = new Map();
  let selectionAnchor = null;
  let selectionRangeBase = null;
  const itemKey = (item) => `${item.kind}:${item.id}`;
  let cleanupReq = 0;
  let cleanupTimer = 0;
  /** The active space's lens as last drawn (#260): which pages it shows, or null while it is off. */
  let lensView = null;
  /** Search past the lens for the current query ("Search all pages"). */
  let searchAll = false;
  /** About answers by phrase: { ids: Set | null, at, loading, error }. The daemon caches them per index version too. */
  const aboutCache = new Map();
  const ABOUT_TTL = 30000;

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
    for (const [key, item] of selected) {
      if (!(item.kind === "folder" ? model.folderById : model.pageById).has(item.id)) selected.delete(key);
    }
    if (selecting && selectionAnchor && !selected.size) selecting = false;
    list.classList.toggle("lib-selecting", selecting);
    list.setAttribute("aria-multiselectable", String(selecting));
    countEl.textContent = String(model.pages.length);
    renderLensButton();
    // A hidden Library keeps its model current; the rows are drawn when it is shown (setPaneOpen, tab switch).
    if (!host.paneOpen()) {
      return;
    }
    lensView = computeLens();
    const focused = rowKey(document.activeElement);
    // Rows that did not change stay in the page: a rebuilt row loses its hover and blinks (#407).
    const rows = document.createDocumentFragment();
    if (query && hits) {
      renderHits(rows);
    } else if (lensView) {
      renderLensTree(rows);
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

  /** The folder tree; with a lens, only the folders and pages it shows. */
  function renderTree(out, folderId, depth, lens = null) {
    for (const folder of foldersOf(folderId)) {
      if (lens && !lens.folders.has(folder.id)) {
        continue;
      }
      const open = !collapsed.has(folder.id);
      out.appendChild(folderRow(folder, depth, open));
      if (open) {
        renderTree(out, folder.id, depth + 1, lens);
      }
    }
    for (const page of pagesOf(folderId)) {
      if (!lens || lens.ids.has(page.id)) {
        out.appendChild(pageRow(page, depth));
      }
    }
  }

  /* ---------- lens (#260) ---------- */

  function currentSpace() {
    return window.scribeLens ? host.space?.() || null : null;
  }

  /** The active space's lens while it is on: the pages it shows and the folders on their way. */
  function computeLens() {
    const space = currentSpace();
    const lens = space && window.scribeLens.lensOf(space);
    if (!lens?.on) {
      return null;
    }
    const subtrees = new Map();
    const levels = new Map();
    const home = space.home && model.folderById.has(space.home) ? space.home : null;
    const ctx = {
      spaceId: space.id,
      home,
      now: Date.now(),
      subtree: (id) => {
        if (!subtrees.has(id)) subtrees.set(id, subtree(id));
        return subtrees.get(id);
      },
      folderOf: (pageId) => model.pageById.get(pageId)?.folderId || null,
      isUnread: (id) => host.isUnread(id),
      chats: (id) => host.pageThreads?.(id) || 0,
      access: (page) => {
        const key = page.folderId || "";
        if (!levels.has(key)) levels.set(key, inheritedLevel(page.folderId));
        return window.scribeLens.accessOf(page, levels.get(key));
      },
      about: aboutIds,
    };
    const ids = new Set(model.pages.filter((page) => window.scribeLens.matches(page, lens, ctx)).map((page) => page.id));
    const folders = new Set();
    for (const id of ids) {
      for (const folderId of chainOf(folderOfPage(model.pageById.get(id)))) folders.add(folderId);
    }
    // The home folder stays in sight, empty or not, so pages can be dropped into it.
    if (home && lens.conditions.some((cond) => cond.type === "home" && !cond.not)) {
      for (const folderId of chainOf(home)) folders.add(folderId);
    }
    const waiting = lens.conditions.some((cond) => cond.type === "about" && !aboutCache.get(cond.text)?.ids);
    const aboutError = lens.conditions.map((cond) => cond.type === "about" && aboutCache.get(cond.text)?.error).find(Boolean) || null;
    return { space, lens, ids, folders, waiting, aboutError };
  }

  /** Pages about a phrase, as the daemon last answered; null until it has. */
  function aboutIds(text) {
    const entry = aboutCache.get(text);
    if (!entry || (!entry.loading && Date.now() - entry.at > ABOUT_TTL)) {
      void fetchAbout(text);
    }
    return entry?.ids || null;
  }

  async function fetchAbout(text) {
    const entry = aboutCache.get(text) || { ids: null, at: 0, loading: false, error: null };
    entry.loading = true;
    aboutCache.set(text, entry);
    const res = await fetch(`/api/search/about?q=${encodeURIComponent(text)}`).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    entry.loading = false;
    entry.at = Date.now();
    if (res?.ok && Array.isArray(data.ids)) {
      entry.ids = new Set(data.ids);
      entry.error = null;
    } else {
      entry.error = data.error || "Semantic search is unavailable";
    }
    render();
  }

  function renderLensButton() {
    if (!lensBtn) {
      return;
    }
    const space = currentSpace();
    lensBtn.hidden = !space;
    const on = Boolean(space && window.scribeLens.lensOf(space).on);
    lensBtn.classList.toggle("on", on);
    lensBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  /** The line over a lensed Library: whose lens, how much it shows, and the way out. */
  function lensLine(shown) {
    const line = document.createElement("div");
    line.className = "lib-lens-line";
    line.style.setProperty("--space", host.spaceColor?.(lensView.space) || "var(--accent)");
    const text = document.createElement("span");
    text.className = "lib-lens-text";
    text.textContent = `${lensView.space.name} · ${shown} of ${model.pages.length} pages`;
    if (lensView.waiting && !lensView.aboutError) {
      text.textContent += " · finding pages…";
    }
    const all = document.createElement("button");
    all.type = "button";
    all.className = "lib-lens-link";
    all.textContent = "Show all";
    all.addEventListener("click", () => void setLensOn(false));
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "lib-lens-link";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openLensEditor());
    line.append(text, all, edit);
    return line;
  }

  function renderLensTree(out) {
    out.appendChild(lensLine(lensView.ids.size));
    if (lensView.aboutError) {
      const meta = document.createElement("div");
      meta.className = "side-meta";
      meta.textContent = `About: ${lensView.aboutError}`;
      out.appendChild(meta);
    }
    renderTree(out, null, 0, lensView);
    // The strip is never filtered, so its tabs that the lens leaves out are listed under it.
    const open = model.pages.filter((page) => host.isOpen(page.id) && !page.temp && !lensView.ids.has(page.id));
    if (open.length) {
      const meta = document.createElement("div");
      meta.className = "side-meta lib-lens-group";
      meta.textContent = "Open in this space";
      out.appendChild(meta);
      for (const page of open) {
        out.appendChild(pageRow(page, 0, { path: pathOf(folderOfPage(page)) }));
      }
    }
    none.hidden = lensView.ids.size > 0 || open.length > 0 || lensView.folders.size > 0;
    none.textContent = lensView.waiting ? "Finding pages…" : "No pages match this space's lens";
  }

  async function saveSpace(patch, space = currentSpace()) {
    if (!space) {
      return false;
    }
    const res = await send("PATCH", `/api/spaces/${encodeURIComponent(space.id)}`, patch);
    if (!res.ok) {
      host.showNotice((await res.json().catch(() => ({}))).error || "Could not save the space");
      return false;
    }
    host.applySpaces?.(await res.json());
    render();
    return true;
  }

  function setLensOn(on) {
    const space = currentSpace();
    if (!space) {
      return Promise.resolve(false);
    }
    return saveSpace({ lens: { ...window.scribeLens.lensOf(space), on } });
  }

  function openHomeFolderPicker(space) {
    model = buildModel();
    const dialog = document.createElement("dialog");
    dialog.className = "confirm";
    dialog.setAttribute("aria-labelledby", "home-folder-title");
    const form = document.createElement("form");
    const title = document.createElement("h2");
    title.id = "home-folder-title";
    title.textContent = `${space.name} home folder`;
    const select = selectOf([["", "None"], ...folderOptions()], space.home && model.folderById.has(space.home) ? space.home : "", "Home folder");
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
    form.append(title, select, actions);
    dialog.append(form);
    document.body.append(dialog);
    window.createSelect?.(select);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      const ok = await saveSpace({ home: select.value || null }, space);
      save.disabled = false;
      if (ok) dialog.close();
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
  }

  const CONDITION_TYPES = [
    ["home", "In the home folder"],
    ["folder", "In a folder"],
    ["madeIn", "Made in a space"],
    ["madeBy", "Made by"],
    ["madeFrom", "Made from a page or folder"],
    ["workspace", "Workspace"],
    ["age", "Age"],
    ["kind", "Kind of page"],
    ["about", "About (semantic)"],
    ["access", "Agent access"],
    ["flag", "Pinned, unread or has chats"],
  ];

  function selectOf(options, value, label) {
    const select = document.createElement("select");
    select.setAttribute("aria-label", label);
    for (const [id, text] of options) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = text;
      select.appendChild(option);
    }
    if (value !== undefined && options.some(([id]) => id === value)) {
      select.value = value;
    }
    return select;
  }

  function folderOptions() {
    const out = [];
    const walk = (parentId) => {
      for (const folder of foldersOf(parentId)) {
        out.push([folder.id, pathOf(folder.id)]);
        walk(folder.id);
      }
    };
    walk(null);
    return out;
  }

  /** One condition's controls in the lens editor; read() gives the condition back, or null. */
  function conditionRow(cond, space) {
    const row = document.createElement("div");
    row.className = "lens-cond";
    const name = document.createElement("span");
    name.className = "lens-cond-name";
    name.textContent = CONDITION_TYPES.find(([type]) => type === cond.type)?.[1] || cond.type;
    const controls = document.createElement("div");
    controls.className = "lens-cond-controls";
    const selects = [];
    const addSelect = (options, value, label) => {
      const select = selectOf(options, value, label);
      controls.appendChild(select);
      selects.push(select);
      return select;
    };
    const addInput = (type, value, label) => {
      const input = document.createElement("input");
      input.type = type;
      input.value = value ?? "";
      input.setAttribute("aria-label", label);
      input.spellcheck = false;
      controls.appendChild(input);
      return input;
    };
    let read = () => ({ type: cond.type });
    const L = window.scribeLens;
    switch (cond.type) {
      case "home": {
        const note = document.createElement("span");
        note.className = "lens-cond-note";
        const home = space.home && model.folderById.has(space.home) ? pathOf(space.home) : null;
        note.textContent = home || "No home folder set";
        controls.appendChild(note);
        break;
      }
      case "folder": {
        const select = addSelect(folderOptions(), cond.folders?.[0], "Folder");
        read = () => (select.value ? { type: "folder", folders: [select.value] } : null);
        break;
      }
      case "madeIn": {
        const spaces = (host.spaces?.() || []).filter((item) => item.id !== space.id).map((item) => [item.id, item.name]);
        const select = addSelect([["this", "This space"], ...spaces], cond.spaces?.[0], "Space");
        read = () => ({ type: "madeIn", spaces: [select.value] });
        break;
      }
      case "madeBy": {
        const select = addSelect([["me", "You"], ["agent", "An agent"]], cond.by, "Made by");
        read = () => ({ type: "madeBy", by: select.value });
        break;
      }
      case "madeFrom": {
        // Boards and other template pages are where agent work usually starts from.
        const pages = model.pages.filter((page) => page.templateId).map((page) => [`page:${page.id}`, page.title]);
        const folders = folderOptions().map(([id, path]) => [`folder:${id}`, `${path}/`]);
        const value = cond.target ? `${cond.target.kind}:${cond.target.id}` : undefined;
        const select = addSelect([...pages, ...folders], value, "Page or folder");
        read = () => {
          const [kind, ...rest] = select.value.split(":");
          return select.value ? { type: "madeFrom", target: { kind, id: rest.join(":") } } : null;
        };
        break;
      }
      case "workspace": {
        const known = [...new Set(model.pages.map((page) => page.workspace).filter(Boolean))].sort();
        if (known.length) {
          const select = addSelect(known.map((path) => [path, path]), cond.path, "Workspace");
          read = () => (select.value ? { type: "workspace", path: select.value } : null);
        } else {
          const input = addInput("text", cond.path, "Workspace folder");
          input.placeholder = "Folder on disk";
          read = () => (input.value.trim() ? { type: "workspace", path: input.value.trim() } : null);
        }
        break;
      }
      case "age": {
        const basis = addSelect(Object.entries(L.BASIS_LABEL), cond.basis || "activity", "Based on");
        const days = addInput("number", cond.days ?? 30, "Days");
        days.min = "1";
        days.className = "lens-days";
        const unit = document.createElement("span");
        unit.className = "lens-cond-note lens-unit";
        unit.textContent = "days";
        controls.appendChild(unit);
        read = () => (Number(days.value) > 0 ? { type: "age", basis: basis.value, days: Number(days.value) } : null);
        break;
      }
      case "kind": {
        const select = addSelect(Object.entries(L.KIND_LABEL), cond.kinds?.[0], "Kind");
        read = () => ({ type: "kind", kinds: [select.value] });
        break;
      }
      case "about": {
        const input = addInput("text", cond.text, "Topic");
        input.placeholder = "A topic, e.g. audio";
        read = () => (input.value.trim() ? { type: "about", text: input.value.trim() } : null);
        break;
      }
      case "access": {
        const select = addSelect(Object.entries(L.LEVEL_LABEL), cond.levels?.[0], "Access level");
        read = () => ({ type: "access", levels: [select.value] });
        break;
      }
      case "flag": {
        const select = addSelect(Object.entries(L.FLAG_LABEL), cond.flag, "Flag");
        read = () => ({ type: "flag", flag: select.value });
        break;
      }
    }
    const not = document.createElement("button");
    not.type = "button";
    not.className = "lens-not";
    not.textContent = "Not";
    not.setAttribute("aria-pressed", cond.not ? "true" : "false");
    not.addEventListener("click", () => not.setAttribute("aria-pressed", not.getAttribute("aria-pressed") === "true" ? "false" : "true"));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "lens-remove";
    remove.setAttribute("aria-label", "Remove condition");
    remove.textContent = "×";
    remove.addEventListener("click", () => row.remove());
    row.append(name, controls, not, remove);
    for (const select of selects) {
      window.createSelect?.(select);
    }
    row.read = () => {
      const value = read();
      return value && (not.getAttribute("aria-pressed") === "true" ? { ...value, not: true } : value);
    };
    return row;
  }

  /** The active space's lens and home folder (#260). */
  function openLensEditor() {
    closeMenu();
    const space = currentSpace();
    if (!space) {
      return;
    }
    const lens = window.scribeLens.lensOf(space);
    const dialog = document.createElement("dialog");
    dialog.className = "confirm lens-editor";
    dialog.setAttribute("aria-labelledby", "lens-editor-title");
    const form = document.createElement("form");
    const title = document.createElement("h2");
    title.id = "lens-editor-title";
    title.textContent = `${space.name} lens`;
    const fields = document.createElement("div");
    fields.className = "lens-fields";

    const onRow = document.createElement("div");
    onRow.className = "setting-row";
    const onLabel = document.createElement("span");
    onLabel.id = "lens-on-label";
    onLabel.textContent = "Show only matching pages";
    const onToggle = document.createElement("button");
    onToggle.type = "button";
    onToggle.className = "pill-toggle";
    onToggle.role = "switch";
    onToggle.setAttribute("aria-labelledby", onLabel.id);
    // Setting a lens up for the first time is asking to see it.
    onToggle.setAttribute("aria-checked", lens.on || !space.lens ? "true" : "false");
    onToggle.addEventListener("click", () => onToggle.setAttribute("aria-checked", onToggle.getAttribute("aria-checked") === "true" ? "false" : "true"));
    onRow.append(onLabel, onToggle);

    const homeField = document.createElement("div");
    homeField.className = "template-field";
    const homeLabel = document.createElement("label");
    homeLabel.textContent = "Home folder";
    const homeSelect = selectOf([["", "None"], ...folderOptions()], space.home && model.folderById.has(space.home) ? space.home : "", "Home folder");
    homeField.append(homeLabel, homeSelect);
    const homeHelp = document.createElement("p");
    homeHelp.className = "help";
    homeHelp.textContent = "Pages made in this space go here when no folder is given.";
    homeField.appendChild(homeHelp);

    const matchField = document.createElement("div");
    matchField.className = "template-field";
    const matchLabel = document.createElement("label");
    matchLabel.textContent = "Show pages that match";
    const matchSelect = selectOf([["all", "All conditions"], ["any", "Any condition"]], lens.match, "Show pages that match");
    matchField.append(matchLabel, matchSelect);

    const list = document.createElement("div");
    list.className = "lens-conds";
    for (const cond of lens.conditions) {
      list.appendChild(conditionRow(cond, space));
    }
    const add = selectOf([["", "Add condition…"], ...CONDITION_TYPES], "", "Add condition");
    const addWrap = document.createElement("div");
    addWrap.className = "lens-add";
    addWrap.appendChild(add);

    fields.append(onRow, homeField, matchField, list, addWrap);
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
    form.append(title, fields, actions);
    dialog.appendChild(form);
    document.body.appendChild(dialog);
    const homeWrap = window.createSelect?.(homeSelect);
    window.createSelect?.(matchSelect);
    const addSelectWrap = window.createSelect?.(add);
    add.addEventListener("change", () => {
      if (!add.value) {
        return;
      }
      list.appendChild(conditionRow({ type: add.value }, { ...space, home: homeSelect.value || null }));
      add.value = "";
      addSelectWrap?.syncSelect?.();
    });
    homeSelect.addEventListener("change", () => homeWrap?.syncSelect?.());
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const conditions = [...list.children].map((row) => row.read()).filter(Boolean);
      save.disabled = true;
      const ok = await saveSpace({
        home: homeSelect.value || null,
        lens: { on: onToggle.getAttribute("aria-checked") === "true", match: matchSelect.value, conditions },
      });
      save.disabled = false;
      if (ok) {
        dialog.close();
      }
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
  }

  function renderHits(out) {
    let rows = hits || [];
    const lensed = Boolean(lensView && !searchAll);
    if (lensed) {
      rows = rows.filter((hit) => lensView.ids.has(hit.id));
    }
    none.hidden = rows.length > 0 || lensed;
    none.textContent = "No matching pages";
    if (rows.length) {
      const meta = document.createElement("div");
      meta.className = "side-meta";
      meta.textContent = lensed
        ? `${rows.length} matching page${rows.length === 1 ? "" : "s"} in ${lensView.space.name}`
        : rows.length < hitTotal
          ? `Showing ${rows.length} of ${hitTotal} matches`
          : `${hitTotal} matching page${hitTotal === 1 ? "" : "s"}`;
      out.appendChild(meta);
    }
    for (const hit of rows) {
      const live = model.pageById.get(hit.id) || hit;
      out.appendChild(pageRow(live, 0, { path: pathOf(folderOfPage(live)), snippet: hit.snippet }));
    }
    if (lensed) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "lib-lens-all";
      const outside = (hits || []).length - rows.length;
      more.textContent = rows.length ? `Search all pages${outside ? ` (${outside} more)` : ""}` : `No matches in ${lensView.space.name} · Search all pages`;
      more.addEventListener("click", () => {
        searchAll = true;
        render();
      });
      out.appendChild(more);
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
      (drag?.items.some((item) => item.id === page.id && item.kind === "page") ? " lib-drag-source" : "");
    el.role = "treeitem";
    el.tabIndex = 0;
    el.ariaLabel = page.title + (open ? " (open)" : "") + (page.pinned ? " (pinned)" : "");
    el.ariaLevel = String(depth + 1);
    el.dataset.kind = "page";
    el.dataset.id = page.id;
    el.dataset.depth = String(depth);
    el.style.setProperty("--depth", String(depth));
    selectionControl(el, { kind: "page", id: page.id }, page.title);

    if (page.file) {
      // A file page shows its kind instead of the page icon (#707).
      el.appendChild(window.scribeFiles.badge(page.file.path));
    } else {
      const icon = document.createElement("span");
      icon.className = "fileicon";
      icon.innerHTML = host.icons.file;
      el.appendChild(icon);
    }

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

    const access = accessMarker(page.agentHidden ? "restricted" : page.access?.level, page.folderId);
    if (access) el.appendChild(access);
    if(page.plugins?.length){
      const plugin=document.createElement("span");plugin.className="lib-plugin";plugin.textContent="⌁";
      plugin.dataset.tooltip=`Plugins: ${page.plugins.join(", ")}`;plugin.setAttribute("aria-label",plugin.dataset.tooltip);el.appendChild(plugin);
    }

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
    const onDisk = Boolean(window.scribeFiles.diskPath(model.folders, folder.id));
    el.className =
      "side-row lib-row lib-folder" +
      (open ? " expanded" : "") +
      (onDisk ? " on-disk" : "") +
      (drag?.items.some((item) => item.id === folder.id && item.kind === "folder") ? " lib-drag-source" : "");
    el.role = "treeitem";
    el.tabIndex = 0;
    el.ariaLabel = `${folder.name} (folder${onDisk ? " on disk" : ""})` + (unreadInside ? " (unread)" : "");
    el.ariaLevel = String(depth + 1);
    el.dataset.kind = "folder";
    el.dataset.id = folder.id;
    el.dataset.depth = String(depth);
    el.style.setProperty("--depth", String(depth));
    el.setAttribute("aria-expanded", open ? "true" : "false");
    selectionControl(el, { kind: "folder", id: folder.id }, folder.name);

    const chevron = document.createElement("span");
    chevron.className = "lib-chevron";
    chevron.innerHTML = CHEVRON_SVG;
    el.appendChild(chevron);

    const icon = document.createElement("span");
    icon.className = "lib-folder-icon";
    icon.innerHTML = onDisk ? DISK_FOLDER_SVG : FOLDER_SVG;
    el.appendChild(icon);

    const text = document.createElement("span");
    text.className = "lib-text";
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = folder.name;
    text.appendChild(title);
    el.appendChild(text);
    if (folder.disk) {
      const chip = document.createElement("span");
      chip.className = "lib-disk-path";
      chip.textContent = folder.disk;
      el.appendChild(chip);
    }

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
    const access = accessMarker(folder.access?.level, folder.parentId);
    if (access) el.appendChild(access);
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

  // Descendants remain covered even when a selected folder is collapsed or filtered out.
  function coveredBySelection(item) {
    const value = (item.kind === "folder" ? model.folderById : model.pageById).get(item.id);
    const parent = item.kind === "folder" ? value?.parentId : value?.folderId;
    return [...chainOf(parent)].some((id) => selected.has(`folder:${id}`));
  }

  function selectionItems() {
    const ordered = [];
    const walk = (parent) => {
      for (const folder of foldersOf(parent)) {
        const item = { kind: "folder", id: folder.id };
        if (selected.has(itemKey(item))) ordered.push(item);
        else walk(folder.id);
      }
      for (const page of pagesOf(parent)) {
        const item = { kind: "page", id: page.id };
        if (selected.has(itemKey(item))) ordered.push(item);
      }
    };
    walk(null);
    return ordered;
  }

  function selectionControl(row, item, name) {
    if (!selecting) return;
    const covered = coveredBySelection(item);
    const checked = covered || selected.has(itemKey(item));
    row.classList.toggle("lib-selected", checked && !covered);
    row.classList.toggle("lib-covered", covered);
    row.setAttribute("aria-selected", String(checked));
    const check = document.createElement("button");
    check.type = "button";
    check.className = "lib-check";
    check.role = "checkbox";
    check.tabIndex = -1;
    check.setAttribute("aria-label", `Select ${name}`);
    check.setAttribute("aria-checked", String(checked));
    check.setAttribute("aria-disabled", String(covered));
    row.appendChild(check);
  }

  function clearSelection() {
    if (!selecting) return false;
    selected.clear();
    selectionAnchor = null;
    selectionRangeBase = null;
    selecting = false;
    render();
    return true;
  }

  function selectItem(item, event) {
    selecting = true;
    if (event.shiftKey && selectionAnchor) {
      const rows = visibleRows().map((row) => ({ kind: row.dataset.kind, id: row.dataset.id }));
      const from = rows.findIndex((row) => itemKey(row) === itemKey(selectionAnchor));
      const to = rows.findIndex((row) => itemKey(row) === itemKey(item));
      if (from >= 0 && to >= 0) {
        selectionRangeBase ||= new Map(selected);
        selected.clear();
        for (const [key, value] of selectionRangeBase) selected.set(key, value);
        const range = rows.slice(Math.min(from, to), Math.max(from, to) + 1);
        const keys = new Set(range.map(itemKey));
        for (const entry of range) {
          // A range must include the entire subtree before it may select its folder.
          if (entry.kind === "folder" && [...subtree(entry.id)].some((id) =>
            !keys.has(`folder:${id}`) || pagesOf(id).some((page) => !keys.has(`page:${page.id}`)))) {
            selected.delete(itemKey(entry));
            continue;
          }
          selected.set(itemKey(entry), entry);
        }
      }
    } else {
      selectionRangeBase = null;
      if (!coveredBySelection(item)) {
        const key = itemKey(item);
        if (selected.has(key)) selected.delete(key);
        else selected.set(key, item);
      }
      selectionAnchor = item;
    }
    if (!selected.size) {
      selecting = false;
      selectionAnchor = null;
    }
    host.hoverCard.hide();
    render();
    rowFor(item.kind, item.id)?.focus({ preventScroll: true });
  }

  function selectedPages(items) {
    const folders = new Set(items.filter((item) => item.kind === "folder").flatMap((item) => [...subtree(item.id)]));
    const pages = new Set(items.filter((item) => item.kind === "page").map((item) => item.id));
    return model.pages.filter((page) => pages.has(page.id) || folders.has(page.folderId));
  }

  async function setSelectionWorkspace(items) {
    const pages = selectedPages(items);
    if (!pages.length) return;
    const picked = await window.scribeChat?.pickWorkspace?.(pages[0].workspace || "", {
      title: "Selected pages workspace", clear: "No workspace",
    });
    if (picked === null || picked === undefined) return;
    for (const page of pages) {
      const res = await send("POST", `/api/tabs/${encodeURIComponent(page.id)}/workspace`, { workspace: picked || null });
      if (!res.ok) host.showNotice(`Could not set workspace for “${page.title}”`);
    }
  }

  async function deleteSelection(items) {
    const files = selectedPages(items).filter((page) => page.file && !page.file.copy);
    const check = fileDeletionCheck(files);
    const message = `Delete ${plural(items.length, "selected item")} and all contents of selected folders?`;
    const accepted = check
      ? await host.choose(message, [{ value: "delete", label: "Delete", danger: true }], { check })
      : await host.confirm(message, "Delete");
    if (!accepted) return;
    const recycle = check?.checked ? files.map((page) => page.id) : [];
    const res = await send("POST", "/api/library/delete", {
      pages: [...new Set([...items.filter((item) => item.kind === "page").map((item) => item.id), ...recycle])],
      folders: items.filter((item) => item.kind === "folder").map((item) => item.id),
      recycle,
    });
    if (!res.ok) {
      host.showNotice((await res.json().catch(() => ({}))).error || "Could not delete the selected items");
      return;
    }
    clearSelection();
    render();
    host.showNotice(`Deleted ${plural(items.length, "item")}`, { undo: true });
  }

  function selectionActions(point) {
    const items = selectionItems();
    const folders = items.filter((item) => item.kind === "folder").map((item) => model.folderById.get(item.id));
    return [
      { label: `${plural(items.length, "item")} selected`, disabled: true },
      { label: "Move to…", action: () => openMovePicker(items, point) },
      { label: "Export", action: () => host.downloadSelectionExport(items) },
      { label: "Agent access", submenu: () => ACCESS_LEVELS.map((level) => ({
        label: level.label, detail: level.detail,
        action: async () => {
          for (const item of items) {
            const res = await send("PUT", `/api/${item.kind === "folder" ? "folders" : "tabs"}/${encodeURIComponent(item.id)}/access`, { level: level.id });
            if (!res.ok) host.showNotice("Could not change agent access");
          }
        },
      })) },
      folders.length > 0 && { label: "Agent instructions", action: () => editFolderInstructions(folders[0], folders) },
      { label: "Set workspace…", disabled: !selectedPages(items).length, action: () => setSelectionWorkspace(items) },
      "sep",
      { label: "Delete…", danger: true, action: () => deleteSelection(items) },
    ];
  }

  function selectionMenu(event, item) {
    if (!selecting) return false;
    if (!selected.has(itemKey(item)) && !coveredBySelection(item)) {
      selected.clear();
      selected.set(itemKey(item), item);
      selectionAnchor = item;
      selectionRangeBase = null;
      render();
    }
    event.preventDefault();
    event.stopPropagation();
    const point = pointFor(event);
    openMenu(point, selectionActions(point));
    return true;
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

  /** The New file submenu: an empty file of that kind in the folder (its disk location, else the default). */
  function newFileItems(folderId) {
    return [
      { label: "Markdown", action: () => host.newFile("md", folderId) },
      { label: "Text", action: () => host.newFile("txt", folderId) },
      { label: "Other…", action: () => host.newFile("other", folderId) },
    ];
  }

  /** Link a Library folder to a disk folder (#707); files already there get pages. */
  async function linkDiskFolder(id) {
    const folder = model.folderById.get(id);
    const picked = await window.scribeChat?.pickWorkspace?.(folder?.disk || lastDiskPath, { title: "Link to disk folder", hint: "", action: "Link", used: false });
    if (!picked) {
      return;
    }
    lastDiskPath = picked;
    const res = await send("PUT", `/api/folders/${encodeURIComponent(id)}/disk`, { path: picked });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.folderId) {
      const choice = await host.choose(`${data.error}. A disk folder can have one Library folder.`, [{ value: "go", label: "Go to that folder" }]);
      if (choice === "go") {
        revealFolder(data.folderId);
      }
      return;
    }
    if (!res.ok) {
      host.showNotice(data.error || "Could not link the folder");
      return;
    }
    await rescanDiskFolder(id, true);
  }

  async function unlinkDiskFolder(id) {
    const res = await send("PUT", `/api/folders/${encodeURIComponent(id)}/disk`, { path: null });
    if (!res.ok) {
      host.showNotice("Could not unlink the folder");
    }
  }

  async function rescanDiskFolder(id, quiet = false) {
    const res = await send("POST", `/api/folders/${encodeURIComponent(id)}/rescan`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      host.showNotice(data.error || "Could not rescan the folder");
      return;
    }
    if (data.added || !quiet) {
      host.showNotice(data.added ? `Added ${data.added === 1 ? "1 file" : `${data.added} files`} from disk` : "No new files on disk");
    }
  }

  function revealFolder(id) {
    host.setPaneOpen(true);
    expandChain(id);
    render();
    rowFor("folder", id)?.scrollIntoView({ block: "nearest" });
    flash("folder", id);
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

  function fileDeletionCheck(files) {
    return files.length ? {
      label: files.length === 1 ? "Also delete the file (Undo restores it)" : `Also delete ${files.length} files (Undo restores them)`,
      checked: host.fileSettings().deleteFiles === "trash",
    } : undefined;
  }

  async function deletePage(id) {
    const page = model.pageById.get(id);
    let recycle = false;
    // Always confirm filesystem deletion; keep the file unless the checkbox is selected.
    if (page?.file && !page.file.copy) {
      const check = fileDeletionCheck([page]);
      const choice = await host.choose(`Delete “${page.title}”?`, [
        { value: "delete", label: "Delete", danger: true },
      ], { check });
      if (!choice) return;
      recycle = check.checked;
    }
    const res = await send("DELETE", `/api/tabs/${encodeURIComponent(id)}?permanent=true${recycle ? "&file=trash" : ""}`);
    if (res.ok) {
      host.showNotice(`Deleted “${page?.title ?? "page"}”${recycle ? " and its file" : ""}`, { undo: true });
    } else if (recycle) {
      const data = await res.json().catch(() => ({}));
      host.showNotice(data.error || "Could not delete the page");
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
    const files = selectedPages([{ kind: "folder", id }]).filter((page) => page.file && !page.file.copy);
    const check = fileDeletionCheck(files);
    const choice = await host.choose(`Delete the folder “${folder.name}”? It holds ${what}.`, [
      { value: "lift", label: "Move contents up" },
      { value: "delete", label: "Delete all", danger: true },
    ], { check });
    if (!choice) {
      return;
    }
    const recycle = check?.checked && choice === "delete" ? files.map((page) => page.id) : [];
    const res = recycle.length
      ? await send("POST", "/api/library/delete", { pages: recycle, folders: [id], recycle })
      : await send("DELETE", `/api/folders/${encodeURIComponent(id)}?mode=${choice}`);
    if (res.ok && choice === "delete") {
      host.showNotice(`Deleted “${folder.name}” with ${what}`, { undo: true });
    } else if (!res.ok) {
      host.showNotice((await res.json().catch(() => ({}))).error || "Could not delete the folder");
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
    let res = await send("POST", `/api/tabs/${encodeURIComponent(id)}/move`, { folderId, index, close });
    if (res.status === 409 && page.file) {
      // The file moves with the page (#707), and one of that name is already there.
      const data = await res.json().catch(() => ({}));
      const choice = await host.choose(data.error || "A file of that name is already in that folder.", [{ value: "both", label: "Keep both" }]);
      if (choice === "both") {
        res = await send("POST", `/api/tabs/${encodeURIComponent(id)}/move`, { folderId, index, close, keepBoth: true });
      }
      if (!res.ok) {
        page.folderId = before.folderId;
        page.libPos = before.libPos;
        if (choice) host.showNotice("Could not move the page");
        host.rerender();
      }
      return;
    }
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

  /** Insert each kind as a block, using a live next sibling so source positions cannot shift the drop. */
  async function moveItems(items, folderId, indices) {
    const excluded = new Set(items.filter((item) => item.kind === "folder").flatMap((item) => [...subtree(item.id)]));
    if (folderId && excluded.has(folderId)) return;
    for (const kind of ["folder", "page"]) {
      const moving = items.filter((item) => item.kind === kind);
      const ids = new Set(moving.map((item) => item.id));
      const siblings = () => kind === "folder" ? foldersOf(folderId) : pagesOf(folderId);
      const remaining = siblings().filter((item) => !ids.has(item.id));
      let next = remaining[Math.min(indices[kind] ?? remaining.length, remaining.length)]?.id;
      for (const item of moving.slice().reverse()) {
        const live = siblings().filter((entry) => entry.id !== item.id);
        const at = next ? live.findIndex((entry) => entry.id === next) : live.length;
        if (kind === "folder") await moveFolder(item.id, folderId, at < 0 ? live.length : at);
        else await movePage(item.id, folderId, at < 0 ? live.length : at);
        model = buildModel();
        next = item.id;
      }
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
    searchAll = false;
    render();
    return true;
  }

  function scheduleSearch(delay = 200) {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(runSearch, delay);
  }

  async function runSearch() {
    if (search.value.trim() !== query) {
      searchAll = false;
    }
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
    fillMenu(menu, items);
    showMenuAt(point);
  }

  function fillMenu(container, items) {
    container.onkeydown = (event) => {
      if (event.target.closest('[role="menu"]') !== container) return;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...container.querySelectorAll("button:not(:disabled)")].filter((button) => button.closest('[role="menu"]') === container);
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    let lastWasSep = true;
    for (const item of items) {
      if (!item) {
        continue;
      }
      if (item === "sep") {
        if (!lastWasSep) {
          const sep = document.createElement("div");
          sep.className = "menu-sep";
          container.appendChild(sep);
          lastWasSep = true;
        }
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.role = "menuitem";
      btn.textContent = item.label;
      if (item.checked != null) {
        btn.role = "menuitemradio";
        btn.setAttribute("aria-label", item.label);
        btn.setAttribute("aria-checked", String(item.checked));
        btn.classList.add("lib-menu-choice");
      }
      if (item.detail) {
        btn.dataset.tooltip = item.detail;
        btn.setAttribute("aria-description", item.detail);
      }
      btn.disabled = Boolean(item.disabled);
      if (item.danger) {
        btn.classList.add("danger");
      }
      if (item.submenu) {
        const wrap = document.createElement("div");
        wrap.className = "lib-menu-branch";
        const arrow = document.createElement("span");
        arrow.className = "lib-menu-arrow";
        arrow.innerHTML = CHEVRON_SVG;
        btn.append(arrow);
        btn.setAttribute("aria-haspopup", "menu");
        btn.setAttribute("aria-expanded", "false");
        const sub = document.createElement("div");
        sub.className = "tab-menu lib-submenu";
        sub.role = "menu";
        sub.setAttribute("aria-label", item.label);
        sub.hidden = true;
        const hide = () => { sub.hidden = true; btn.setAttribute("aria-expanded", "false"); };
        const show = () => {
          if (!sub.hidden) return;
          sub.replaceChildren();
          fillMenu(sub, item.submenu());
          sub.hidden = false;
          btn.setAttribute("aria-expanded", "true");
          const box = btn.getBoundingClientRect();
          const width = sub.offsetWidth;
          sub.style.left = Math.max(8, box.right + width > window.innerWidth - 8 ? box.left - width : box.right) + "px";
          sub.style.top = Math.max(8, Math.min(box.top - 4, window.innerHeight - sub.offsetHeight - 8)) + "px";
        };
        btn.addEventListener("click", show);
        wrap.addEventListener("pointerenter", show);
        wrap.addEventListener("pointerleave", hide);
        wrap.addEventListener("focusout", (event) => { if (!wrap.contains(event.relatedTarget)) hide(); });
        btn.addEventListener("keydown", (event) => {
          if (event.key !== "ArrowRight") return;
          event.preventDefault();
          show();
          sub.querySelector("button:not(:disabled)")?.focus();
        });
        sub.addEventListener("keydown", (event) => {
          if (event.key !== "ArrowLeft" && event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          btn.focus();
          hide();
        });
        wrap.append(btn, sub);
        container.append(wrap);
      } else {
        btn.addEventListener("click", () => {
          closeMenu();
          item.action?.();
        });
        container.appendChild(btn);
      }
      lastWasSep = false;
    }
    if (container.lastElementChild?.classList.contains("menu-sep")) {
      container.lastElementChild.remove();
    }
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
    if (list.contains(event.target) && selectionMenu(event, { kind: "page", id })) return;
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
      { label: "Agent access", submenu: () => agentAccessItems({ kind: "page", id }) },
      !tab.embedUrl && { label: "Permissions…", action: () => host.managePermissions(id) },
      { label: tab.workspace ? "Change workspace…" : "Set workspace…", action: () => host.pickPageWorkspace(id) },
      { label: "Copy key", action: () => host.copyTabKey(id) },
      "sep",
      { label: "Delete", danger: true, action: () => deletePage(id) },
    ]);
  }

  function editFolderInstructions(folder, targets = [folder]) {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm folder-instructions";
    dialog.setAttribute("aria-labelledby", "folder-instructions-title");
    const form = document.createElement("form");
    const title = document.createElement("h2");
    title.id = "folder-instructions-title";
    title.textContent = targets.length > 1 ? `Instructions for ${targets.length} folders` : `${folder.name} instructions`;
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
      const same = targets.every((target) => (target[key] || "") === (folder[key] || ""));
      input.value = same ? folder[key] || "" : "";
      if (!same) input.placeholder = "Mixed values";
      let changed = false;
      input.addEventListener("input", () => { changed = true; });
      const resize = () => {
        input.style.height = "auto";
        input.style.height = `${input.scrollHeight + 2}px`;
      };
      input.addEventListener("input", resize);
      fields.push({ key, input, resize, changed: () => changed });
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
      let ok = true;
      for (const target of targets) {
        const values = Object.fromEntries(fields.map(({ key, input, changed }) => [key,
          targets.length === 1 || changed() ? input.value : target[key] || ""]));
        const res = await send("PUT", `/api/folders/${encodeURIComponent(target.id)}/instructions`, values);
        if (!res.ok) ok = false;
      }
      save.disabled = false;
      if (!ok) {
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

  // public is "Open" to the user (#723); open, the default, is "Normal".
  const ACCESS_LEVELS = [
    { id: "public", label: "Open", detail: "Every chat reaches it without asking." },
    { id: "open", label: "Normal", detail: "Chats in scope reach it; others ask." },
    { id: "ask", label: "Ask always", detail: "Every chat asks, even global ones." },
    { id: "trusted", label: "Trusted only", detail: "Only chats on trusted model sources." },
    { id: "restricted", label: "Restricted", detail: "Only chats on this exact page." },
  ];
  const LEVEL_RANK = { public: 0, open: 1, ask: 2, trusted: 3, restricted: 4 };

  /** The strictest level set on a folder and its parents (#269), or null when none sets one. */
  function inheritedLevel(folderId) {
    let level = null;
    const seen = new Set();
    for (let at = folderId ? model.folderById.get(folderId) : null; at && !seen.has(at.id); at = at.parentId ? model.folderById.get(at.parentId) : null) {
      seen.add(at.id);
      const own = at.access?.level;
      if (own && (!level || LEVEL_RANK[own] > LEVEL_RANK[level])) level = own;
    }
    return level;
  }

  /** The row's access icon (#727): the effective level, dimmed when it comes from a parent folder; null for Normal. */
  function accessMarker(own, parentId) {
    const inherited = inheritedLevel(parentId);
    const fromParent = Boolean(inherited && (!own || LEVEL_RANK[inherited] > LEVEL_RANK[own]));
    const level = fromParent ? inherited : own;
    if (!level || level === "open") return null;
    const label = ACCESS_LEVELS.find((l) => l.id === level).label + (fromParent ? " (from parent folder)" : "");
    const marker = document.createElement("span");
    marker.className = "lib-access" + (fromParent ? " inherited" : "");
    marker.innerHTML = ACCESS_SVG[level];
    marker.setAttribute("aria-label", `Agent access: ${label}`);
    marker.dataset.tooltip = `Agent access: ${label}`;
    return marker;
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

  /** Access levels and existing grants, shared by page and folder context menus. */
  function agentAccessItems(target) {
    const item = target.kind === "page" ? host.findAny(target.id) : model.folderById.get(target.id);
    if (!item) return [];
    const nameOf = (t) => (t.kind === "page" ? `“${host.findAny(t.id)?.title || t.id}”` : `${folderPathOf(t.id)}/`);
    const save = async (body) => {
      const url = target.kind === "page" ? `/api/tabs/${encodeURIComponent(target.id)}/access` : `/api/folders/${encodeURIComponent(target.id)}/access`;
      const res = await send("PUT", url, body);
      if (!res.ok) {
        host.showNotice((await res.json().catch(() => ({}))).error || "Could not change agent access");
      }
    };
    const set = target.kind === "page" && item.agentHidden ? "restricted" : item.access?.level;
    const inherited = inheritedLevel(target.kind === "page" ? item.folderId : item.parentId);
    const own = set || (inherited === "public" ? "public" : "open");
    const items = ACCESS_LEVELS.map((level) => ({
      label: level.label,
      checked: level.id === own,
      detail: target.kind === "folder" && level.id === "restricted" ? "Only chats on each page itself." : level.detail,
      action: () => save({ level: level.id }),
    }));
    if (inherited && (set ? LEVEL_RANK[inherited] > LEVEL_RANK[set] : inherited !== "open")) {
      items.push("sep", { label: `Parent folder: ${ACCESS_LEVELS.find((l) => l.id === inherited).label}`, disabled: true });
    }
    if (target.kind === "page" && item.access?.origin) {
      items.push("sep", { label: `Created from ${nameOf(item.access.origin)}`, disabled: true });
    }
    if (item.access?.grants?.length) {
      items.push("sep", {
        label: "Chats here also reach",
        submenu: () => item.access.grants.map((grant) => ({
          label: `Remove ${nameOf(grant)}`,
          action: () => save({ removeGrants: [grant] }),
        })),
      });
    }
    return items;
  }

  function folderMenu(event, id) {
    if (selectionMenu(event, { kind: "folder", id })) return;
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
      { label: "New file here", submenu: () => newFileItems(id) },
      "sep",
      { label: folder.disk ? "Change disk folder…" : "Link to disk folder…", action: () => linkDiskFolder(id) },
      folder.disk && { label: "Unlink from disk", action: () => unlinkDiskFolder(id) },
      window.scribeFiles.diskPath(model.folders, id) && { label: "Rescan disk folder", action: () => rescanDiskFolder(id) },
      "sep",
      { label: "Export folder", action: () => host.downloadFolderExport(id) },
      { label: "Agent instructions", action: () => editFolderInstructions(folder) },
      { label: "Agent access", submenu: () => agentAccessItems({ kind: "folder", id }) },
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
    const point = { x: box.left, y: box.bottom + 4 };
    openMenu(point, [
      ...(selecting && selected.size ? [...selectionActions(point), "sep"] : []),
      { label: selecting ? "Cancel selection" : "Select…", action: () => {
        if (selecting) clearSelection();
        else { selecting = true; selectionAnchor = null; selectionRangeBase = null; render(); visibleRows()[0]?.focus(); }
      } },
      "sep",
      { label: "Open file…", action: () => openDiskFile(null) },
      { label: "Open folder…", action: () => openDiskFolder(null) },
      { label: "New file", submenu: () => newFileItems(null) },
      { label: "Expand all", disabled: model.folders.length === 0, action: () => setAllCollapsed(false) },
      { label: "Collapse all", disabled: model.folders.length === 0, action: () => setAllCollapsed(true) },
      currentSpace() && { label: "Edit lens…", action: () => openLensEditor() },
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
    const items = Array.isArray(item) ? item : [item];
    const excluded = new Set(items.filter((entry) => entry.kind === "folder").flatMap((entry) => [...subtree(entry.id)]));
    const parents = items.map((entry) => entry.kind === "folder" ? model.folderById.get(entry.id)?.parentId ?? null
      : folderOfPage(model.pageById.get(entry.id) || {}));
    const currentParent = parents.every((id) => id === parents[0]) ? parents[0] : undefined;
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
      await moveItems(items, target, { page: 0, folder: Number.MAX_SAFE_INTEGER });
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
      items: [{ kind, id }],
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
    if (!row || event.target.closest(".tab-close, .lib-check, .lib-chevron, input") || (query && row.dataset.kind === "folder")) {
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
    if (selecting) {
      const item = { kind: press.kind, id: press.id };
      if (!selected.has(itemKey(item)) && !coveredBySelection(item)) {
        selected.clear();
        selected.set(itemKey(item), item);
        selectionAnchor = item;
        selectionRangeBase = null;
      }
      drag.items = selectionItems();
      const primary = drag.items.find((entry) => entry.kind === "folder") || drag.items[0];
      drag.kind = primary.kind;
      drag.id = primary.id;
    }
    const item = press.kind === "page" ? model.pageById.get(press.id) : model.folderById.get(press.id);
    const ghost = document.createElement("div");
    ghost.className = "lib-ghost";
    const icon = document.createElement("span");
    icon.className = press.kind === "page" ? "fileicon" : "lib-folder-icon";
    icon.innerHTML = press.kind === "page" ? host.icons.file : FOLDER_SVG;
    const label = document.createElement("span");
    label.className = "tab-title";
    label.textContent = drag.items.length > 1 ? plural(drag.items.length, "item")
      : press.kind === "page" ? item?.title ?? "" : item?.name ?? "";
    ghost.append(icon, label);
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.x = event.clientX;
    drag.y = event.clientY;
    placeGhost();
    for (const item of drag.items) rowFor(item.kind, item.id)?.classList.add("lib-drag-source");
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
    const page = drag.items.every((item) => item.kind === "page") ? host.findAny(drag.id) : null;
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
    const moving = new Set(drag.items.map((item) => item.id));
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) {
      return null;
    }
    const hit = drag.rows.find(entry => y >= entry.rect.top && y < entry.rect.bottom);
    const row = hit?.row;
    if (!row) {
      return drag.kind === "page"
        ? { folderId: null, index: pagesOf(null).filter((p) => !moving.has(p.id)).length, into: ROOT }
        : { folderId: null, index: foldersOf(null).filter((f) => !moving.has(f.id)).length, into: ROOT };
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
      if (moving.has(id)) {
        return { noop: true };
      }
      const page = model.pageById.get(id);
      const folderId = folderOfPage(page);
      const siblings = pagesOf(folderId).filter((p) => !moving.has(p.id));
      const index = siblings.indexOf(page) + (frac >= 0.5 ? 1 : 0);
      return { folderId, index, line: { top: frac >= 0.5 ? bottom : top, depth } };
    }

    const own = new Set(drag.items.filter((item) => item.kind === "folder").flatMap((item) => [...subtree(item.id)]));
    if (kind === "folder") {
      if (own.has(id)) {
        return { noop: true };
      }
      const folder = model.folderById.get(id);
      const parentId = folder.parentId && model.folderById.has(folder.parentId) ? folder.parentId : null;
      const siblings = foldersOf(parentId).filter((f) => !moving.has(f.id));
      const at = siblings.indexOf(folder);
      const expandedWithKids = !collapsed.has(id) && (pagesOf(id).length > 0 || foldersOf(id).length > 0);
      if (frac < 0.3) {
        return { folderId: parentId, index: at, line: { top, depth } };
      }
      if (frac > 0.7 && !expandedWithKids) {
        return { folderId: parentId, index: at + 1, line: { top: bottom, depth } };
      }
      const inner = foldersOf(id).filter((f) => !moving.has(f.id));
      return { folderId: id, index: frac > 0.7 ? 0 : inner.length, into: id };
    }
    const page = model.pageById.get(id);
    const folderId = folderOfPage(page);
    if (moving.has(id) || (folderId && own.has(folderId))) {
      return { noop: true };
    }
    const index = foldersOf(folderId).filter((f) => !moving.has(f.id)).length;
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
    for (const row of visibleRows()) row.classList.remove("lib-drag-source");
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
      for (const item of done.items) host.openPage(item.id, { activate: true, before: target.before });
      render();
      return;
    }
    if (done.items.length > 1) {
      void moveItems(done.items, target.folderId, { [done.kind]: target.index });
      fadeGhost(done.ghost);
    } else if (done.kind === "page") {
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
      if (event.target.closest(".lib-chevron")) {
        toggleFolder(id);
        return;
      }
      if (selecting || event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        if (event.detail <= 1) selectItem({ kind, id }, event);
        return;
      }
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
    if (selecting || event.ctrlKey || event.metaKey) return;
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
    if (row && (event.button === 1 || (event.button === 0 && (selecting || event.ctrlKey || event.metaKey || event.shiftKey)))) {
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
    if ((event.key === " " || event.key === "Enter") && (selecting || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      selectItem({ kind, id }, event);
      return;
    }
    if (event.key === "Delete" && selecting && selected.size) {
      event.preventDefault();
      void deleteSelection(selectionItems());
      return;
    }
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
      searchAll = false;
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
  lensBtn?.addEventListener("click", () => {
    const space = currentSpace();
    if (space) {
      void setLensOn(!window.scribeLens.lensOf(space).on);
    }
  });
  lensBtn?.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openLensEditor();
  });
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
    openHomeFolderPicker,
    deletePage(id) { model = buildModel(); return deletePage(id); },
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
    /** Esc cancels a drag or rename; otherwise it closes the menu and leaves selection mode. */
    onEscape() {
      if (cancelDrag() || cancelRename()) return true;
      const closed = closeMenu();
      return clearSelection() || closed;
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
