/* Phone layout (#928): below PHONE_WIDTH the board shows one pane at a time (Library, page or chat) with a
 * switcher at the bottom, and the tab strip becomes a list. It drives the real Library and chat toggles, so
 * each pane keeps its own state and a wider window gets the usual layout back. */
(() => {
  if (document.documentElement.classList.contains("popout")) return;
  const query = window.matchMedia("(max-width: 640px)");
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);
  const sidePane = $("side-pane");
  const agentPane = $("agent-pane");
  const libraryToggle = $("library-toggle");
  const agentToggle = $("agent-toggle");
  const tabsEl = $("tabs");
  const newTab = $("new-tab");
  if (!sidePane || !agentPane || !libraryToggle || !agentToggle || !tabsEl) return;

  const icon = (body) => `<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    library: icon('<rect x="1.5" y="2" width="13" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="2.5" width="4.5" height="11" fill="currentColor"/>'),
    page: icon('<path d="M4 1.8h5.2L12.5 5v9.2H4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 2v3.3h3.3" fill="none" stroke="currentColor" stroke-width="1.3"/>'),
    chat: agentToggle.querySelector("svg")?.outerHTML.replace(/width="15" height="15"/, 'width="18" height="18"') || "",
  };

  /* ---------- bottom switcher ---------- */

  const nav = document.createElement("nav");
  nav.className = "phone-nav";
  nav.setAttribute("aria-label", "Panes");
  const buttons = {};
  for (const [pane, label] of [["library", "Library"], ["page", "Pages"], ["chat", "Chat"]]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "phone-nav-btn";
    btn.dataset.pane = pane;
    btn.innerHTML = `${ICONS[pane]}<span class="phone-nav-label">${label}</span><span class="badge" hidden></span>`;
    btn.addEventListener("click", () => pick(pane));
    nav.append(btn);
    buttons[pane] = btn;
  }
  document.body.append(nav);

  /* ---------- tab list ---------- */

  const titleBtn = document.createElement("button");
  titleBtn.type = "button";
  titleBtn.className = "phone-title";
  titleBtn.setAttribute("aria-haspopup", "dialog");
  titleBtn.setAttribute("aria-expanded", "false");
  titleBtn.innerHTML = '<span class="phone-title-text"></span><span class="phone-title-count"></span>';
  titleBtn.addEventListener("click", () => setSheet(!sheetOpen));
  tabsEl.parentElement.before(titleBtn);

  const sheet = document.createElement("div");
  sheet.className = "phone-tabs";
  sheet.hidden = true;
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "Open pages");
  const list = document.createElement("div");
  list.className = "phone-tabs-list";
  list.setAttribute("role", "list");
  sheet.append(list);
  sheet.addEventListener("click", (event) => {
    if (event.target === sheet) setSheet(false);
  });
  document.body.append(sheet);
  let sheetOpen = false;

  function setSheet(open) {
    sheetOpen = open && query.matches;
    sheet.hidden = !sheetOpen;
    root.classList.toggle("phone-tabs-open", sheetOpen);
    titleBtn.setAttribute("aria-expanded", sheetOpen ? "true" : "false");
    if (sheetOpen) {
      renderList();
      list.querySelector(".phone-tab.active")?.scrollIntoView({ block: "nearest" });
    }
  }

  const realTabs = () => [...tabsEl.querySelectorAll(":scope > .tab")];
  const tabTitle = (tab) => tab.querySelector(".tab-title")?.textContent.trim() || "Untitled";

  function renderList() {
    const rows = [];
    const add = document.createElement("button");
    add.type = "button";
    add.className = "phone-tab phone-tab-new";
    add.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><span>New page</span>';
    add.addEventListener("click", () => {
      setSheet(false);
      newTab?.click();
    });
    rows.push(add);
    for (const tab of realTabs()) {
      const row = document.createElement("div");
      row.className = "phone-tab";
      row.setAttribute("role", "listitem");
      row.classList.toggle("active", tab.classList.contains("active"));
      row.classList.toggle("pinned", tab.classList.contains("pinned"));
      const open = document.createElement("button");
      open.type = "button";
      open.className = "phone-tab-open";
      open.textContent = tabTitle(tab);
      if (tab.classList.contains("active")) open.setAttribute("aria-current", "page");
      open.addEventListener("click", () => {
        setSheet(false);
        tab.click();
        show("page");
      });
      const close = document.createElement("button");
      close.type = "button";
      close.className = "phone-tab-close";
      close.setAttribute("aria-label", `Close ${tabTitle(tab)}`);
      close.textContent = "×";
      close.addEventListener("click", () => tab.querySelector(".tab-close")?.click());
      row.append(open, close);
      rows.push(row);
    }
    list.replaceChildren(...rows);
  }

  /* ---------- panes ---------- */

  const isOpen = (pane) => !pane.classList.contains("closed");
  const current = () => (isOpen(sidePane) ? "library" : isOpen(agentPane) ? "chat" : "page");

  function show(pane) {
    if (!query.matches) return;
    if ((pane === "library") !== isOpen(sidePane)) libraryToggle.click();
    if ((pane === "chat") !== isOpen(agentPane)) agentToggle.click();
  }

  function pick(pane) {
    reopenLibrary = false;
    if (pane === "page" && current() === "page") {
      setSheet(!sheetOpen);
      return;
    }
    setSheet(false);
    show(pane);
  }

  /* One pane at a time: the one that just opened wins, whichever button or shortcut opened it. */
  let was = { library: isOpen(sidePane), chat: isOpen(agentPane) };
  function sync() {
    const now = { library: isOpen(sidePane), chat: isOpen(agentPane) };
    if (query.matches && now.library && now.chat) {
      if (!was.chat) libraryToggle.click();
      else agentToggle.click();
      return;
    }
    was = now;
    const pane = current();
    root.dataset.phonePane = pane;
    for (const [name, btn] of Object.entries(buttons)) {
      btn.classList.toggle("on", name === pane);
      btn.setAttribute("aria-pressed", name === pane ? "true" : "false");
    }
    if (pane !== "page") setSheet(false);
  }

  /* The page, the tab count and the toggles' badges and busy state, mirrored on the switcher. */
  let activeId = null;
  let userInPane = 0;
  for (const pane of [sidePane, agentPane]) {
    pane.addEventListener("pointerdown", () => { userInPane = Date.now(); }, true);
  }
  function syncTabs() {
    const tabs = realTabs();
    const active = tabs.find((tab) => tab.classList.contains("active"));
    titleBtn.querySelector(".phone-title-text").textContent = active ? tabTitle(active) : "No page";
    titleBtn.querySelector(".phone-title-count").textContent = tabs.length > 1 ? String(tabs.length) : "";
    const id = active?.dataset.id || null;
    // A page picked in the Library, or a link the user followed in the chat, brings the page up.
    if (query.matches && id && id !== activeId && activeId !== null && current() !== "page" && Date.now() - userInPane < 1500) show("page");
    activeId = id;
    if (sheetOpen) renderList();
  }
  function mirror(from, to) {
    const badge = from.querySelector(".badge");
    const own = to.querySelector(".badge");
    own.hidden = !badge || badge.hidden;
    own.textContent = badge?.textContent || "";
    own.className = badge ? badge.className : "badge";
    for (const name of ["busy", "waiting"]) to.classList.toggle(name, from.classList.contains(name));
  }

  new MutationObserver(sync).observe(sidePane, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(sync).observe(agentPane, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(syncTabs).observe(tabsEl, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  const mirrorObserver = (from, to) => {
    mirror(from, to);
    new MutationObserver(() => mirror(from, to)).observe(from, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "hidden"] });
  };
  mirrorObserver(libraryToggle, buttons.library);
  mirrorObserver(agentToggle, buttons.chat);

  let reopenLibrary = false;
  function applyQuery() {
    root.classList.toggle("phone", query.matches);
    if (!query.matches) {
      setSheet(false);
      // The Library the narrow window closed comes back with the width, if the chat is still beside it.
      if (reopenLibrary && isOpen(agentPane) && !isOpen(sidePane)) libraryToggle.click();
      reopenLibrary = false;
      return;
    }
    // Coming from a wide window with both open: keep the chat.
    if (isOpen(sidePane) && isOpen(agentPane)) {
      libraryToggle.click();
      reopenLibrary = true;
    }
    sync();
  }
  query.addEventListener("change", applyQuery);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sheetOpen) {
      event.stopPropagation();
      setSheet(false);
    }
  }, true);
  applyQuery();
  syncTabs();
  sync();
})();
