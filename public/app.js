(() => {
  const appearanceStorage = window.scribeAppearance || localStorage;
  const tabsEl = document.getElementById("tabs");
  const emptyEl = document.getElementById("empty");
  const startupEl = document.getElementById("startup");
  const startupMessage = document.getElementById("startup-message");
  const startupRetry = document.getElementById("startup-retry");
  const refreshOverlay = document.getElementById("refresh-overlay");
  const refreshOverlayToggle = document.getElementById("refresh-overlay-toggle");
  const REFRESH_OVERLAY_KEY = "scribe.refreshOverlay";
  let refreshOverlayTimer = setTimeout(() => dismissRefreshOverlay(), 5000);

  function dismissRefreshOverlay(fade = false) {
    clearTimeout(refreshOverlayTimer);
    if (refreshOverlay.hidden) return;
    if (fade && window.scribeMotion.enabled()) {
      refreshOverlay.classList.add("leaving");
      window.scribeMotion.reveal(refreshOverlay, false, { translate: "none", fill: "both" }).finished.then(() => { refreshOverlay.hidden = true; }).catch(() => {});
    } else {
      refreshOverlay.hidden = true;
    }
  }

  function finishRefreshOverlay() {
    if (refreshOverlay.hidden) return;
    clearTimeout(refreshOverlayTimer);
    // Let the restored shell settle before revealing it; fast refreshes get a brief, stable view.
    refreshOverlayTimer = setTimeout(() => dismissRefreshOverlay(true), Math.max(250, 700 - performance.now()));
  }
  const newPageEl = document.getElementById("newpage");
  const framesEl = document.getElementById("frames");
  const clearBtn = document.getElementById("clear");
  const libraryToggle = document.getElementById("library-toggle");
  const libraryBadge = document.getElementById("library-badge");
  const sidePane = document.getElementById("side-pane");
  const sideResizer = document.getElementById("side-resizer");
  const sidebarTabLibrary = document.getElementById("sidebar-tab-library");
  const sidebarTabTemplates = document.getElementById("sidebar-tab-templates");
  const sidebarPanelLibrary = document.getElementById("sidebar-panel-library");
  const sidebarPanelTemplates = document.getElementById("sidebar-panel-templates");
  const sidebarPanelTrash = document.getElementById("sidebar-panel-trash");
  const sidebarTabs = document.getElementById("sidebar-tabs");
  const sidebarBack = document.getElementById("sidebar-back");
  const trashBack = document.getElementById("trash-back");
  const templateCountEl = document.getElementById("template-count");
  const templateList = document.getElementById("template-list");
  const templateNone = document.getElementById("template-none");
  const builtinGroup = document.getElementById("builtin-group");
  const builtinHead = document.getElementById("builtin-head");
  const builtinCountEl = document.getElementById("builtin-count");
  const builtinList = document.getElementById("builtin-list");
  const templateEditBtn = document.getElementById("template-edit");
  const templateBlock = document.getElementById("template-block");
  const templateBlockReason = document.getElementById("template-block-reason");
  const templateModal = document.getElementById("template-modal");
  const templateModalBackdrop = document.getElementById("template-modal-backdrop");
  const templateModalTitle = document.getElementById("template-modal-title");
  const templateModalDesc = document.getElementById("template-modal-desc");
  const templateModalForm = document.getElementById("template-modal-form");
  const templateModalFields = document.getElementById("template-modal-fields");
  const templateModalError = document.getElementById("template-modal-error");
  const templateModalCancel = document.getElementById("template-modal-cancel");
  const templateModalSubmit = document.getElementById("template-modal-submit");
  const templateModalAgentHidden = document.getElementById("template-modal-agent-hidden");
  const confirmDlg = document.getElementById("confirm");
  const confirmMessage = document.getElementById("confirm-message");
  const choiceDlg = document.getElementById("choice");
  const choiceMessage = document.getElementById("choice-message");
  const choiceActions = document.getElementById("choice-actions");
  const paletteEl = document.getElementById("palette");
  const paletteBackdrop = document.getElementById("palette-backdrop");
  const paletteInput = document.getElementById("palette-input");
  const paletteModeEl = document.getElementById("palette-mode");
  const paletteList = document.getElementById("palette-list");
  const paletteEmpty = document.getElementById("palette-empty");
  const paletteEnterHint = document.getElementById("palette-enter-hint");
  const palettePrefixHint = document.getElementById("palette-prefix-hint");
  const palettePrefixListEl = document.getElementById("palette-prefix-list");
  const settingsEl = document.getElementById("settings");
  const settingsBackdrop = document.getElementById("settings-backdrop");
  const settingsToggle = document.getElementById("settings-toggle");
  const themeList = document.getElementById("theme-list");
  const smoothScrollToggle = document.getElementById("smooth-scroll");
  const spaceSuggestToggle = document.getElementById("space-suggest");
  const showClearToggle = document.getElementById("show-clear");
  const tightSmallToggle = document.getElementById("tight-small");
  const uiFxToggle = document.getElementById("ui-fx");
  const auroraEdgeToggle = document.getElementById("aurora-edge");
  const chromeFxTrack = document.getElementById("chrome-fx");
  const chromeFxWhenTrack = document.getElementById("chrome-fx-when");
  const agentSideTrack = document.getElementById("agent-side");
  const librarySideTrack = document.getElementById("library-side");
  const agentSideLabel = document.getElementById("agent-side-label");
  const librarySideLabel = document.getElementById("library-side-label");
  const importPageBtn = document.getElementById("import-page");
  const exportPageBtn = document.getElementById("export-page");
  const exportAllBtn = document.getElementById("export-all");
  const importFileInput = document.getElementById("import-file");
  const noticeEl = document.getElementById("notice");
  const noticeText = document.getElementById("notice-text");
  const noticeUndo = document.getElementById("notice-undo");
  const persistBanner = document.getElementById("persist-banner");
  const persistBannerDetail = document.getElementById("persist-banner-detail");
  const newTabBtn = document.getElementById("new-tab");
  const tabsWrap = tabsEl.parentElement;
  const mainEl = document.querySelector("main");
  const linkModeTrack = document.getElementById("link-mode");
  const popout = window.scribePopout;
  /** Set when this window shows one page on its own (popout.js): no strip, no sidebars, never another page. */
  const childId = popout.childId;
  /** A child window that shows the agent chat and no page (agent.js fills it). */
  const chatChild = popout.chatChild;

  const SANDBOX =
    "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";
  const EMBED_ALLOW = "fullscreen; clipboard-read; clipboard-write";
  const LIVE_FRAME_CAP = 5;
  const SIDE_OPEN_KEY = "scribe.archiveOpen";
  const SIDEBAR_TAB_KEY = "scribe.sidebarTab";
  const FILE_VIEWS_KEY = "scribe.fileViews";
  const SIDE_WIDTH_KEY = "scribe.archiveWidth";
  /** Must match VERSION in src/config.ts. */
  const BOARD_VERSION = "3.2.4";
  const BUILTIN_OPEN_KEY = "scribe.builtinTemplatesOpen";
  const TAB_CARD_DELAY = 450;
  const TEMPLATE_CARD_DELAY = 700;
  const TOGGLE_HOVER_OPEN_MS = 500;
  const THEME_KEY = "scribe.theme";
  const SMOOTH_SCROLL_KEY = "scribe.smoothScroll";
  const SPACE_SUGGEST_KEY = "scribe.spaceSuggest";
  /** Also read by the inline script in index.html so the first paint already hides Clear. */
  const SHOW_CLEAR_KEY = "scribe.showClear";
  /** What a page link without a mode or modifier does: "tab", "peek", or "split". */
  const LINK_MODE_KEY = "scribe.linkMode";
  const VIEWER_ID_KEY = "scribe.viewerId";
  const LINK_MODES = [
    { id: "tab", name: "Navigate" },
    { id: "peek", name: "Peek" },
    { id: "split", name: "Split" },
  ];
  /** Keep in sync with src/palettePrefixes.ts. Add a row when a new prefix ships. */
  const PALETTE_PREFIX_KEY = "scribe.palettePrefixes";
  const PALETTE_PREFIXES = [
    { id: "threads", label: "Threads", default: "=" },
    { id: "ai", label: "Ask AI", default: "?" },
    { id: "semantic", label: "By meaning", default: "~" },
  ];
  const PREFIX_MAX = 8;
  /** Answered `?` questions (#245), newest first, so asking again costs nothing. */
  const AI_RECENT_KEY = "scribe.aiSearchRecent";
  const AI_RECENT_MAX = 8;
  /** Shorter queries get no "Related" rows: a letter or two says too little to match by meaning. */
  const SEMANTIC_MIN_QUERY = 3;
  /** Also read by the inline script in index.html so the first paint already has the right spacing. */
  const TIGHT_SMALL_KEY = "scribe.tightSmall";
  const UI_FX_KEY = "scribe.uiEffects";
  /** Also read by aurora.js, which draws the title bar edge. */
  const AURORA_EDGE_KEY = "scribe.auroraEdge";
  /** Also read by newpage.js, which draws them. Stored as the chosen ids, comma-separated; nothing stored means all. */
  const NEWPAGE_BG_KEY = "scribe.newPageBackgrounds";
  const NEWPAGE_PROVIDER_KEY = "scribe.newPageProviderColors";
  const newPageProviderToggle = document.getElementById("newpage-provider-colors");
  const PAGE_INTENT_KEY = "scribe.pageIntent";
  const pageIntentToggle = document.getElementById("page-intent");
  /** How long the creating screen waits for the new page to open once its call is over, before it gives the old page back. */
  const PAGE_INTENT_GRACE_MS = 700;
  /**
   * The new page the floating chat is writing (agent.js reports the call): { itemId, title, origin, ending }.
   * origin is the page that was in front when it began, which the creating screen covers.
   */
  let pageIntent = null;
  /** The floating chat's turn may be about to write a new page (the classifier's guess): { turnId, origin }. Its page stays usable. */
  let pageHint = null;
  /** The turn whose creating screen the user clicked away: nothing more of that turn brings it back. */
  let pageIntentDismissed = null;
  const pageHintEl = document.getElementById("page-hint");
  const NEWPAGE_BGS = [
    { id: "nebula", name: "Nebula" },
    { id: "stardust", name: "Stardust" },
    { id: "aurora", name: "Aurora curtains" },
    { id: "caustics", name: "Caustics" },
    { id: "contours", name: "Contour map" },
    { id: "halftone", name: "Halftone" },
    { id: "bokeh", name: "Bokeh" },
  ];
  /** Also read by chromefx.js, which draws the title bar background. The first entry is the default. */
  const CHROME_FX_KEY = "scribe.chromeFx";
  const CHROME_FX_WHEN_KEY = "scribe.chromeFxWhen";
  const CHROME_FX_STYLES = [
    { id: "wash", name: "Aurora" },
    { id: "motes", name: "Motes" },
    { id: "rise", name: "Rising motes" },
    { id: "off", name: "Off" },
  ];
  const CHROME_FX_WHEN = [
    { id: "idle-still", name: "While working" },
    { id: "always", name: "Always" },
    { id: "busy", name: "Hidden when idle" },
  ];
  /** Also read by the inline script in index.html so the first paint already places the panes. */
  const AGENT_SIDE_KEY = "scribe.agentSide";
  const LIBRARY_SIDE_KEY = "scribe.librarySide";
  const PANE_SIDES = [
    { id: "left", name: "Left" },
    { id: "right", name: "Right" },
  ];
  const DEFAULT_THEME = "neutral";
  const THEMES = [
    { id: "neutral", name: "Neutral", swatch: "#c9c9d0", icon: "./favicon.svg?v=4" },
    { id: "ember", name: "Ember", swatch: "#d0a578", icon: "./favicon-ember.svg?v=4" },
    { id: "spectrum", name: "Spectrum", swatch: "#9db8a4", icon: "./favicon-spectrum.svg?v=4" },
    { id: "garnet", name: "Garnet", swatch: "#d56f6c", icon: "./favicon-garnet.svg?v=5" },
    { id: "dusk", name: "Dusk", swatch: "#b7a2dc", icon: "./favicon-dusk.svg?v=5" },
    { id: "cream", name: "Cream", swatch: "#f3ede1", icon: "./favicon-cream.svg?v=5" },
  ];
  const PIN_SVG =
    '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M9.6 1.4l5 5-1.4 1.4-.9-.2-2.3 2.3.2 2.5-1.5 1.5-2.4-2.4-3.1 3.1-.8-.8 3.1-3.1-2.4-2.4 1.5-1.5 2.5.2 2.3-2.3-.2-.9z" fill="currentColor"/></svg>';
  const FILE_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 2h7.5l3.5 3.5V14h-11z" fill="currentColor"/></svg>';
  const BUILTIN_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" d="M2.5 2h7.5l3.5 3.5V14h-11zM8 7.2l.9 1.8 2 .3-1.45 1.4.35 2L8 11.75l-1.8.95.35-2L5.1 9.3l2-.3z" fill="currentColor"/></svg>';
  const AGENT_HIDDEN_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const AGENT_HIDDEN_TITLE = "Restricted: only chats on this page reach it";
  // A temporary page (#655): a clock, since it lasts only while it is open.
  const TEMP_SVG =
    '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.4 1.6"/><path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const TEMP_TITLE = "Temporary: not in the Library, gone once closed";
  const FOLDER_INSTRUCTIONS_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 2.5h7.2L13 5.3V13.5H3z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.2 8h5.6M5.2 10.2h3.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  const UPDATE_SVG =
    '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zm-.8 3.2v4.1h1.6V4.7zm0 5.3v1.6h1.6V10z" fill="currentColor" fill-rule="evenodd"/></svg>';
  const UPDATE_TITLE = "Built-in template updated";
  const UPDATE_NOTE =
    "This copy wasn't updated automatically because it was edited or its page data format changed. Ask an agent to update it.";

  /** @type {{ tabs: Array<any>, closed: Array<any>, folders: Array<any>, templates: Array<any>, activeId: string | null, connected: boolean, sideOpen: boolean, sidebarTab: string, trashOpen: boolean }} */
  const state = {
    tabs: [],
    closed: [],
    folders: [],
    templates: [],
    /** Read-only templates shipped with the app. Opening one opens its local copy. */
    builtinTemplates: [],
    builtinOpen: localStorage.getItem(BUILTIN_OPEN_KEY) !== "0",
    activeId: null,
    connected: false,
    restored: false,
    sideOpen: !childId && localStorage.getItem(SIDE_OPEN_KEY) === "1",
    sidebarTab: localStorage.getItem(SIDEBAR_TAB_KEY) === "templates" ? "templates" : "library",
    /** The Trash view replaces the sidebar tabs until Back. */
    trashOpen: false,
    /** This window's New page while it is not a page yet: active, but with no tab in the strip. */
    draft: null,
    /** The tab that was in front when the draft opened, to go back to when it is closed. */
    draftFrom: null,
  };

  /** held: a template change waits while the page is on screen (see holdFrame). @type {Map<string, { el: HTMLIFrameElement, revision: number, held?: boolean }>} */
  const frames = new Map();
  /** @type {Set<string>} */
  const unread = new Set();
  /** Closed pages changed in the background; the blip shows on the Library button. */
  const unreadLibrary = new Set();

  /** @type {WebSocket | null} */
  let socket = null;
  let reconnectTimer = 0;
  let startupTimer = 0;
  /** The strip is known: before the first snapshot nothing can be said about a page's tab being gone. */
  let snapshotSeen = false;
  let lastInteractedAt = 0;
  let lastEditAt = 0;
  let viewerHidden = false;
  let paletteTimer = 0;
  let paletteReq = 0;
  /** "pages" or a prefix id from PALETTE_PREFIXES. */
  let paletteKind = "pages";
  /** The prefix mode lifted out of the input and shown as a chip beside it (#573): "pages" when none. */
  let paletteMode = "pages";
  /** Search by meaning (#372): the pack's state from /api/search/status, read when the palette opens. Null until known. */
  let semanticStatus = null;
  let semanticStatusReq = null;
  let relatedTimer = 0;
  /** "indexing 40 of 116 pages" while the index is building, else "". */
  let semanticProgress = "";
  /** The image pasted or dropped into the palette as the query: { url } of its preview. */
  let paletteImage = null;
  /** @type {Array<any>} */
  let paletteHits = [];
  let paletteIndex = 0;
  /** The palette's `?` question: { query, status: "busy" | "done" | "error", hits?, model?, ms?, error?, abort? }. */
  let aiAsk = null;
  /** The model the last answer came from, named on the Ask row. */
  let aiModel = "";
  /** The `?` query last shown, so a new one selects the Ask row again. */
  let aiShownQuery = null;
  /** User action in this window that should focus the resulting tab. Agent activate can still decline. */
  let pendingFocus = null;
  /** @type {number | null} */
  let tabScrollTarget = null;
  let tabScrollRaf = 0;
  /** @type {string | null} */
  let revealedTabId = null;
  let revealedTabShape = "";
  /** @type {Map<string, HTMLElement>} */
  const tabEls = new Map();
  /** @type {null | {
   *   id: string,
   *   pointerId: number,
   *   startX: number,
   *   startY: number,
   *   moved: boolean,
   *   originOrder: string[],
   *   groupPinned: boolean,
   *   offsetX: number,
   *   offsetY: number,
   *   width: number,
   *   el: HTMLElement,
   *   placeholder: HTMLElement,
   *   scrollDir: number
   * }} */
  let drag = null;
  let toggleHoverTimer = 0;
  let noticeTimer = 0;
  /** @type {null | { label: string, run: () => void }} */
  let noticeAction = null;
  /** @type {HTMLElement | null} */
  let stripSlotEl = null;

  /** The desktop app's child window has a title bar of its own: the page's title and the window buttons. */
  let popoutTitle = null;
  if (childId) {
    popoutTitle = document.createElement("div");
    popoutTitle.className = "popout-title";
    popoutTitle.setAttribute("data-tauri-drag-region", "");
    document.querySelector(".chrome").appendChild(popoutTitle);
    // The rest of .actions is hidden here; Edit template values still belongs to the page.
    popoutTitle.after(templateEditBtn);
  }

  const hoverCard = window.createHoverCard({
    describe: describeForCard,
    openThread: (id) => window.scribeChat?.openThread?.(id),
  });
  /** Set once createSpaces has run (the Library is made first). */
  let spacesReady = null;
  const library = window.createLibrary({
    pages: libraryPages,
    folders: () => state.folders,
    addFolder: (folder) => {
      if (!state.folders.some((item) => item.id === folder.id)) {
        state.folders = [...state.folders, folder];
      }
    },
    activeId: () => state.activeId,
    isOpen: (id) => state.tabs.some((tab) => tab.id === id),
    isUnread: (id) => unreadLibrary.has(id),
    findAny: findAnyTab,
    selectTab: (id) => selectTab(id, { fromUser: true }),
    openPage,
    focusWhenOpened,
    closeTab: (id) => closeTab(id),
    setPinned,
    keepPage,
    setAgentHidden,
    pickPageWorkspace,
    managePermissions: (id) => window.scribePermissions?.manage(id),
    copyTabKey,
    downloadExport,
    downloadFolderExport: (id) => downloadHref(`/api/export/folder/${encodeURIComponent(id)}`),
    downloadSelectionExport: (items) => {
      const query = new URLSearchParams();
      for (const item of items) query.append(item.kind === "folder" ? "folder" : "page", item.id);
      downloadHref(`/api/export?${query}`);
    },
    downloadAll: () => downloadExport(),
    showNotice,
    choose,
    confirm: (message, confirmLabel) => confirmDelete(message, confirmLabel),
    openTrash,
    setPaneOpen: (open) => {
      if (state.sidebarTab !== "library" || state.trashOpen) {
        setSidebarTab("library");
      }
      if (state.sideOpen !== open) {
        setSideOpen(open);
      }
    },
    paneOpen: libraryShown,
    rerender: () => render(),
    modeFromEvent: (event) => views.modeFromEvent(event),
    openIn: (id, mode) => views.open(id, mode),
    canSplit: () => Boolean(state.activeId),
    // The desktop app drags a tab out of the window instead.
    canPopOut: (id) => !popout.desktop && canPopOut(state.tabs.find((tab) => tab.id === id)),
    popOut: (id) => popOut(id),
    hoverCard,
    stripSlot,
    clearStripSlot,
    openThread: (id) => window.scribeChat?.openThread?.(id),
    pageStatus: (id) => window.scribeChat?.pageStatus?.(id) || null,
    pageThreads: (id) => window.scribeChat?.pageThreads?.(id) || 0,
    // Spaces are made below; the Library only asks once it draws.
    space: () => spacesReady?.current() || null,
    spaces: () => spacesReady?.list() || [],
    spaceColor: (space) => spacesReady?.colorOf(space) || null,
    applySpaces: (view) => spacesReady?.apply(view),
    newFile: (kind, folderId) => createFile(kind, folderId),
    fileSettings: () => fileSettings,
    setDeleteFiles: (mode) => saveFileSettings({ deleteFiles: mode }),
    icons: { file: FILE_SVG, pin: PIN_SVG, folderInstructions: FOLDER_INSTRUCTIONS_SVG },
  });
  const views = window.createViews({
    startPaneDrag,
    solo: Boolean(childId),
    mainEl,
    isPageOrigin,
    tabs: () => state.tabs,
    closed: () => state.closed,
    findAnyTab: (id) => findAnyTab(id) || (state.draft?.id === id ? state.draft : null),
    activeId: () => state.activeId,
    spaceId: () => spaces.activeId() || "default",
    spaceIds: () => spaces.ids().length ? spaces.ids() : ["default"],
    activeTab,
    isBlank,
    draftId: () => state.draft?.id || null,
    activate: activatePage,
    newPage,
    frame: (id) => frames.get(id) || null,
    frameIds: () => [...frames.keys()],
    ensureFrame,
    releaseFrame,
    discardFrame,
    selectTab: (id) => selectTab(id, { fromUser: true }),
    openPage,
    showNotice,
    linkMode,
    markSeen,
    render: () => render(),
  });
  const spaces = window.createSpaces({
    chipSlot: settingsToggle,
    findAnyTab,
    folderPath: (id) => library.pathOf(id),
    setHomeFolder: (space) => library.openHomeFolderPicker(space),
    showNotice,
    focusedTab: () => (childId ? null : state.activeId),
    beforeOpen: () => {
      closePalette();
      closeSettings();
      library.closeMenu();
      hoverCard.hide?.();
    },
  });
  spacesReady = spaces;
  const newPageView = window.createNewPage({
    templates: () => state.templates,
    builtins: () => state.builtinTemplates,
    pick: fillFromTemplate,
    fileTarget: () => newFileTarget(draftFolder()),
    createFile: (kind) => createFile(kind, draftFolder()),
    // The Files section says where a new file goes, which can follow a changed default.
    refreshFiles: () => void loadFileSettings().then(() => draftActive() && render()),
    threads: (id) => window.scribeChat?.pageThreads?.(id) || 0,
    working: (id) => window.scribeChat?.pageStatus?.(id) || null,
    openChat: () => window.scribeChat?.shortcut("dock"),
    workspaces: () => window.scribeChat?.recentWorkspaces?.() || [],
    openWorkspace: (dir) => window.scribeChat?.openWorkspace?.(dir),
    provider: () => window.scribeChat?.dockProvider?.(),
    intent: (id) => (pageIntent?.origin === id ? pageIntent : null),
    dismissIntent: () => {
      pageIntentDismissed = pageIntent?.turnId || null;
      endPageIntent();
    },
  });
  const trash = window.createTrash({
    showNotice,
    confirm: (message, confirmLabel) => confirmDelete(message, confirmLabel),
    openMenu: library.openMenu,
    closeMenu: library.closeMenu,
    icons: { file: FILE_SVG, ...library.icons },
  });

  applySideWidth(Number(localStorage.getItem(SIDE_WIDTH_KEY)) || 280);
  applyTheme(loadTheme(), false);
  applyFlag(smoothScrollToggle, SMOOTH_SCROLL_KEY, true);
  applyFlag(spaceSuggestToggle, SPACE_SUGGEST_KEY, false);
  applyFlag(showClearToggle, SHOW_CLEAR_KEY, true);
  applyFlag(tightSmallToggle, TIGHT_SMALL_KEY, true);
  document.documentElement.classList.toggle("hide-clear", !flagOn(showClearToggle));
  document.documentElement.classList.toggle("tight-small", flagOn(tightSmallToggle));
  applyFlag(uiFxToggle, UI_FX_KEY, true);
  applyFlag(refreshOverlayToggle, REFRESH_OVERLAY_KEY, true);
  if (!flagOn(refreshOverlayToggle)) dismissRefreshOverlay();
  refreshOverlayToggle.addEventListener("click", () => toggleFlag(refreshOverlayToggle, REFRESH_OVERLAY_KEY));
  bindSettingHint(
    document.getElementById("refresh-overlay-label"),
    "Briefly covers the shell while saved tabs and spaces settle after a refresh. Clears when a connection needs attention."
  );
  document.documentElement.classList.toggle("fx-off", !flagOn(uiFxToggle));
  applyFlag(auroraEdgeToggle, AURORA_EDGE_KEY, true);
  applyPaneSideAttr("agentSide", paneSide(AGENT_SIDE_KEY));
  applyPaneSideAttr("librarySide", paneSide(LIBRARY_SIDE_KEY));
  renderThemeList();
  renderLinkModes();
  renderPaneSides();
  renderChromeFx();
  renderNewPageBgs();
  applyFlag(newPageProviderToggle, NEWPAGE_PROVIDER_KEY, false);
  applyFlag(pageIntentToggle, PAGE_INTENT_KEY, true);
  renderPalettePrefixSettings();
  window.addEventListener("scribe:appearance", () => {
    applyTheme(loadTheme(), false);
    for (const [control, key] of [[tightSmallToggle, TIGHT_SMALL_KEY], [uiFxToggle, UI_FX_KEY], [auroraEdgeToggle, AURORA_EDGE_KEY], [newPageProviderToggle, NEWPAGE_PROVIDER_KEY]]) {
      applyFlag(control, key, key !== NEWPAGE_PROVIDER_KEY);
    }
    document.documentElement.classList.toggle("tight-small", flagOn(tightSmallToggle));
    document.documentElement.classList.toggle("fx-off", !flagOn(uiFxToggle));
    renderChromeFx();
    renderNewPageBgs();
    for (const event of ["scribe:ui-fx", "scribe:aurora", "scribe:chrome-fx", "scribe:newpage-bg"]) window.dispatchEvent(new Event(event));
  });
  bindSettingHint(agentSideLabel, "When both panes are on the same side, this one sits next to the page.");
  bindSettingHint(
    document.getElementById("ui-fx-label"),
    "Shader motion on controls like the floating chat orb whenever it is visible. Off, they hold a still frame. The New page background still moves."
  );
  bindSettingHint(
    document.getElementById("newpage-bgs-label"),
    "Each new blank page shows one of the backgrounds turned on here. They take turns in random order, so each comes up equally often."
  );
  bindSettingHint(
    document.getElementById("newpage-provider-colors-label"),
    "Use the selected floating chat provider's shape colours for the New page background, including your custom palette. Off restores the default background colours."
  );
  bindSettingHint(
    document.getElementById("page-intent-label"),
    "When an agent in the floating chat starts writing a new page, the page in front gives way to a New page background until the new page opens. Click the screen to get the page back. Before that, a glow at the page's edge shows a message that looks like it asks for a page (Settings, Classifier)."
  );
  bindSettingHint(
    document.getElementById("chrome-fx-label"),
    "A faint moving texture behind the tabs, in the theme's colours. It gets livelier while any agent chat runs."
  );
  bindSettingHint(
    document.getElementById("chrome-fx-when-label"),
    "While working: a still frame when idle, moving while an agent chat runs. Always: it also drifts slowly when idle, which keeps the GPU drawing. Hidden when idle: a plain bar until an agent chat runs. It pauses while the window is in the background."
  );
  bindSettingHint(
    document.getElementById("aurora-edge-label"),
    "A thin glow in the theme's colours drifts along the bottom of the title bar while any agent chat runs, and fades out when they're done. It pauses while the window is in the background."
  );
  bindSettingHint(librarySideLabel, "When both panes are on the same side, this one sits at the window edge.");

  function connect() {
    clearTimeout(reconnectTimer);
    if (socket && socket.readyState < WebSocket.CLOSING) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    socket = ws;
    if (!state.restored) {
      clearTimeout(startupTimer);
      startupTimer = setTimeout(() => {
        startupMessage.textContent = "Still connecting to Scribe. Retrying…";
        startupRetry.hidden = false;
        dismissRefreshOverlay();
        ws.close();
      }, 5000);
    }
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      state.connected = true;
      renderChrome();
      reportViewer();
      dispatchEvent(new CustomEvent("scribe:connection", { detail: { connected: true } }));
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      applyEvent(JSON.parse(event.data));
    });
    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      clearTimeout(startupTimer);
      if (socket === ws) {
        socket = null;
      }
      state.connected = false;
      if (!state.restored) {
        startupMessage.textContent = "Could not connect to Scribe. Retrying…";
        startupRetry.hidden = false;
        dismissRefreshOverlay();
      }
      renderChrome();
      dispatchEvent(new CustomEvent("scribe:connection", { detail: { connected: false } }));
      reconnectTimer = setTimeout(connect, 1000);
    });
  }

  startupRetry.addEventListener("click", () => {
    clearTimeout(startupTimer);
    clearTimeout(reconnectTimer);
    const previous = socket;
    socket = null;
    previous?.close();
    startupMessage.textContent = "Restoring your pages…";
    startupRetry.hidden = true;
    connect();
  });

  function reportViewer() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(
      JSON.stringify({
        type: "viewer_state",
        selectedId: state.activeId,
        lastInteractedAt,
        lastEditAt,
        hidden: viewerHidden,
      })
    );
  }

  /** The desktop app reports its window hidden in the tray, so agents open it instead of assuming it is seen. */
  window.scribeSetHidden = (hidden) => {
    viewerHidden = Boolean(hidden);
    reportViewer();
  };

  function noteEdit() {
    const now = Date.now();
    lastEditAt = now;
    lastInteractedAt = now;
    reportViewer();
  }

  function isClosedMeta(tab) {
    return Boolean(tab?.closedAt);
  }

  function applyEvent(msg) {
    if (msg.type === "appearance") {
      window.scribeAppearance?.receive(msg.settings, msg.revision);
      return;
    }
    if (typeof msg.type === "string" && msg.type.startsWith("agent_")) {
      dispatchEvent(new CustomEvent("scribe:agent-event", { detail: msg }));
      return;
    }
    if (msg.type === "snapshot") {
      clearTimeout(startupTimer);
      showVersionMismatch(msg.version);
      abortDrag(false);
      state.tabs = msg.tabs;
      state.closed = Array.isArray(msg.closed) ? msg.closed : [];
      state.folders = Array.isArray(msg.folders) ? msg.folders : [];
      state.templates = Array.isArray(msg.templates) ? msg.templates : [];
      state.builtinTemplates = Array.isArray(msg.builtinTemplates) ? msg.builtinTemplates : [];
      spaces.apply(msg.spaces);
      views.prune();
      // After a space switch the address still names the old space's tab: don't reopen it here.
      snapshotSeen = true;
      const hash = msg.reset || childId ? "" : location.hash.replace(/^#/, "");
      const fromOpen = hash ? state.tabs.find((tab) => tab.id === hash || tab.key === hash) : null;
      const fromClosed = hash ? state.closed.find((tab) => tab.id === hash || tab.key === hash) : null;
      if (state.draft && findAnyTab(state.draft.id)) {
        state.draft = null;
      }
      const keepDraft = !msg.reset && draftActive() && !fromOpen && !fromClosed;
      state.activeId = fromOpen ? fromOpen.id : keepDraft ? state.draft.id : msg.activeId;
      if (keepDraft) {
        // After a daemon restart the draft is gone there; bring it back under the same id.
        fetch("/api/drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: state.draft.id }) }).catch(() => undefined);
      }
      unread.clear();
      unreadLibrary.clear();
      syncHash();
      const firstSnapshot = !state.restored;
      state.restored = true;
      startupEl.hidden = true;
      render();
      if (firstSnapshot) {
        finishRefreshOverlay();
        document.documentElement.removeAttribute("data-restoring");
        window.dispatchEvent(new Event("scribe:restored"));
      }
      reportViewer();
      showPersistError(msg.persistError);
      if (fromClosed && !fromOpen) {
        openPage(fromClosed.id);
      }
      return;
    }
    if (msg.type === "spaces") {
      spaces.apply(msg.spaces);
      views.prune();
      invalidate();
      // A space's home folder or lens may have changed, and the chat list's This space filter.
      library.render();
      window.scribeChat?.spaceChanged?.();
      return;
    }
    if (msg.type === "page_permission") {
      if (msg.value !== "allow" && ((msg.perm === "audio.microphone" && pageAudioSessions.get(msg.id)?.mode !== "stream") ||
        (msg.perm === "audio.microphoneStream" && pageAudioSessions.get(msg.id)?.mode === "stream") ||
        (msg.perm === "audio.transcribe" && pageAudioSessions.get(msg.id)?.mode === "listen"))) cancelPageAudio(msg.id, "revoked");
      return;
    }
    if (msg.type === "plugin_event") {
      if(msg.registry){
        for(const [id,frame]of frames)frame.el.contentWindow?.postMessage({type:"scribe-plugin-availability"},pageOrigin(id));
        window.scribePluginSettings.refresh();
      }
      forwardPluginEvent(msg);
      return;
    }
    if (msg.type === "folders") {
      state.folders = Array.isArray(msg.folders) ? msg.folders : [];
      invalidate("chrome", "library");
      return;
    }
    if (msg.type === "trash") {
      trash.refresh();
      return;
    }
    if (msg.type === "persist_error") {
      showPersistError(msg.error);
      return;
    }
    if (msg.type === "persist_ok") {
      showPersistError(null);
      return;
    }
    if (msg.type === "page_asset_warning") {
      warnPageAssets(msg);
      return;
    }
    if (msg.type === "tab_upserted") {
      if (!findAnyTab(msg.tab.id)) {
        notePagesChanged();
      }
      if (state.draft?.id === msg.tab.id) {
        state.draft = null;
        state.draftFrom = null;
      }
      if (isClosedMeta(msg.tab)) {
        if (msg.template) holdFrame(msg.tab.id);
        upsertClosed(msg.tab, msg.structural, msg.markUnread);
        if (drag && drag.id === msg.tab.id) {
          abortDrag(false);
        }
        invalidate();
        library.refreshSearch();
        return;
      }
      const idx = state.tabs.findIndex((tab) => tab.id === msg.tab.id);
      const prev = idx === -1 ? null : state.tabs[idx];
      const structural = !prev || (msg.structural !== false && prev.revision !== msg.tab.revision);
      state.closed = state.closed.filter((tab) => tab.id !== msg.tab.id);
      unreadLibrary.delete(msg.tab.id);
      if (idx === -1) {
        const at = Number.isInteger(msg.index) ? Math.max(0, Math.min(msg.index, state.tabs.length)) : state.tabs.length;
        state.tabs.splice(at, 0, msg.tab);
      } else if (Number.isInteger(msg.index) && !drag?.moved) {
        state.tabs.splice(idx, 1);
        const at = Math.max(0, Math.min(msg.index, state.tabs.length));
        state.tabs.splice(at, 0, msg.tab);
      } else {
        state.tabs[idx] = msg.tab;
      }
      const focusedHere = claimPendingFocus(msg.tab);
      if (focusedHere) {
        state.activeId = msg.tab.id;
        lastInteractedAt = Date.now();
        syncHash();
      }
      if (msg.markUnread !== false && structural && !views.isShown(msg.tab.id) && !popout.has(msg.tab.id)) {
        unread.add(msg.tab.id);
      }
      if (structural) {
        if (msg.template) holdFrame(msg.tab.id);
        refreshFrame(msg.tab);
        library.refreshSearch();
      } else {
        syncFrameMeta(msg.tab);
      }
      if (!state.activeId && state.tabs.length) {
        state.activeId = msg.tab.id;
        unread.delete(msg.tab.id);
        syncHash();
      }
      if (state.activeId === msg.tab.id) {
        unread.delete(msg.tab.id);
      }
      if (drag?.moved) {
        const el = tabEls.get(msg.tab.id);
        if (el) {
          syncTabEl(el, msg.tab);
        }
        invalidate("chrome", "frames", "library");
      } else {
        invalidate();
      }
      if (focusedHere) {
        reportViewer();
      }
      return;
    }
    if (msg.type === "tab_deleted") {
      notePagesChanged();
      if (drag && drag.id === msg.id) {
        abortDrag(false);
      }
      const neighbor = neighborTabId(msg.id);
      views.onDeleted(msg.id);
      state.tabs = state.tabs.filter((tab) => tab.id !== msg.id);
      state.closed = state.closed.filter((tab) => tab.id !== msg.id);
      unread.delete(msg.id);
      unreadLibrary.delete(msg.id);
      discardFrame(msg.id);
      if (state.activeId === msg.id) {
        state.activeId = neighbor;
        if (state.activeId) {
          unread.delete(state.activeId);
        }
        syncHash();
      }
      library.refreshSearch();
      invalidate();
      reportViewer();
      return;
    }
    if (msg.type === "tab_focus_request") {
      if (childId) {
        // The daemon asked this window because it was used last; the page belongs in the main one.
        if (msg.id !== childId) {
          popout.request({ type: "focus-request", id: msg.id, thread: msg.thread });
        }
        return;
      }
      if (msg.thread) {
        window.scribeChat?.followThread?.(msg.thread, msg.id);
      }
      if (state.tabs.some((tab) => tab.id === msg.id)) {
        selectTab(msg.id, { fromUser: false });
      }
      return;
    }
    if (msg.type === "tab_state") {
      const tab = state.tabs.find((item) => item.id === msg.id);
      const closed = state.closed.find((item) => item.id === msg.id);
      for (const item of [tab, closed]) {
        if (item) {
          item.stateRevision = msg.stateRevision;
          item.stateUpdatedAt = Date.now();
        }
      }
      // A page an agent keeps writing to sends these many times a second: draw only the first.
      if (closed && !views.isShown(msg.id) && !unreadLibrary.has(msg.id)) {
        unreadLibrary.add(msg.id);
        invalidate("chrome", "library");
      }
      const entry = frames.get(msg.id);
      if (entry?.el.contentWindow) {
        entry.el.contentWindow.postMessage(
          {
            type: "scribe-state",
            id: msg.id,
            fromRevision: msg.fromRevision,
            stateRevision: msg.stateRevision,
            ops: msg.ops,
            client: msg.client,
            writeId: msg.writeId,
          },
          "*"
        );
      }
      if (tab && !views.isShown(msg.id) && !popout.has(msg.id) && !unread.has(msg.id)) {
        unread.add(msg.id);
        invalidate("tabs");
      }
      return;
    }
    if (msg.type === "template_upserted") {
      const idx = state.templates.findIndex((item) => item.id === msg.template.id);
      if (idx === -1) {
        state.templates.push(msg.template);
      } else {
        state.templates[idx] = msg.template;
      }
      state.templates.sort((a, b) => String(a.title).localeCompare(String(b.title)));
      invalidate("chrome", "templates");
      return;
    }
    if (msg.type === "template_deleted") {
      state.templates = state.templates.filter((item) => item.id !== msg.id);
      if (templateModal.dataset.templateId === msg.id) {
        closeTemplateModal();
      }
      invalidate("chrome", "templates");
      return;
    }
    if (msg.type === "builtin_templates") {
      state.builtinTemplates = Array.isArray(msg.templates) ? msg.templates : [];
      invalidate("templates");
    }
  }

  /** A page was created, deleted, or restored: live pages recheck their links (struck-through when missing). */
  let pagesChangedTimer = 0;
  function notePagesChanged() {
    clearTimeout(pagesChangedTimer);
    pagesChangedTimer = setTimeout(() => {
      for (const [id, entry] of frames) {
        if (id.startsWith("url:") || findAnyTab(id)?.embedUrl) {
          continue;
        }
        entry.el.contentWindow?.postMessage({ type: "scribe-pages-changed", id }, "*");
      }
    }, 150);
  }

  /** Return to the other split pane, then a previous open tab, then the right or left neighbor. */
  function neighborTabId(id) {
    const back = views.returnTarget(id);
    if (back) {
      return back;
    }
    if (state.activeId === id) {
      const previous = previousOpenTabId(id);
      if (previous) {
        return previous;
      }
    }
    const idx = state.tabs.findIndex((tab) => tab.id === id);
    if (idx === -1) {
      return state.tabs.length ? state.tabs[state.tabs.length - 1].id : null;
    }
    return (state.tabs[idx + 1] ?? state.tabs[idx - 1])?.id ?? null;
  }

  /** A page whose tab is closed. Blips the Library only when its content or state changed, not on moves or pins. */
  function upsertClosed(tab, structural, markUnread = true) {
    const wasOpen = state.tabs.some((item) => item.id === tab.id);
    const neighbor = neighborTabId(tab.id);
    state.tabs = state.tabs.filter((item) => item.id !== tab.id);
    unread.delete(tab.id);
    if (wasOpen) {
      views.onClosed(tab.id);
    }
    const shown = views.isShown(tab.id) && state.activeId !== tab.id;
    if (shown) {
      refreshFrame(tab);
    } else {
      discardFrame(tab.id);
    }
    const idx = state.closed.findIndex((item) => item.id === tab.id);
    if (idx === -1) {
      state.closed.push(tab);
      // New Library-only page (agent background create). Closing an open tab is not unread.
      if (markUnread && !shown && !wasOpen && structural !== false) {
        unreadLibrary.add(tab.id);
      }
    } else {
      const prev = state.closed[idx];
      if (markUnread && !shown && ((structural !== false && prev.revision !== tab.revision) || prev.stateRevision !== tab.stateRevision)) {
        unreadLibrary.add(tab.id);
      }
      state.closed[idx] = tab;
    }
    if (state.activeId === tab.id) {
      state.activeId = neighbor;
      if (state.activeId) {
        unread.delete(state.activeId);
      }
      syncHash();
    }
  }

  /** Every Library page: open tabs and closed pages, without the help page and temporary pages. */
  function libraryPages() {
    return [...state.tabs, ...state.closed].filter((tab) => tab.key !== "scribe:welcome" && !tab.temp);
  }

  /** Position of the current history entry among the board's own entries; see onHistoryStep. */
  let historyIndex = typeof history.state?.boardIndex === "number" ? history.state.boardIndex : 0;
  // The browser cannot read earlier entries synchronously. Mirror the entries we visit or write
  // so closing a tab can choose from the same history without navigating or reopening a page.
  const tabFocusHistory = new Map([[historyIndex, location.hash.replace(/^#/, "")]]);

  function previousOpenTabId(closingId) {
    let previous = null;
    let previousIndex = -Infinity;
    for (const [index, id] of tabFocusHistory) {
      if (index < historyIndex && index > previousIndex && id !== closingId &&
          state.tabs.some((tab) => tab.id === id) && !popout.has(id)) {
        previous = id;
        previousIndex = index;
      }
    }
    return previous;
  }

  function syncHash() {
    if (childId) {
      return;
    }
    if (!state.activeId) {
      tabFocusHistory.set(historyIndex, "");
      if (location.hash) {
        history.replaceState({ boardIndex: historyIndex }, "", location.pathname + location.search);
      }
      return;
    }
    const wanted = "#" + state.activeId;
    if (location.hash === wanted) {
      tabFocusHistory.set(historyIndex, state.activeId);
      return;
    }
    // Focus moving between open tabs adds a history entry, so the browser's Back and Forward step
    // through the tabs you were on. On first load, or when the previous tab has left the strip,
    // the entry is replaced instead.
    const prev = location.hash.replace(/^#/, "");
    if (prev && state.tabs.some((tab) => tab.id === prev)) {
      tabFocusHistory.set(historyIndex, prev);
      for (const index of tabFocusHistory.keys()) {
        if (index > historyIndex) tabFocusHistory.delete(index);
      }
      historyIndex += 1;
      history.pushState({ boardIndex: historyIndex }, "", wanted);
    } else {
      history.replaceState({ boardIndex: historyIndex }, "", wanted);
    }
    tabFocusHistory.set(historyIndex, state.activeId);
  }

  /**
   * Back or Forward onto one of the board's entries: focus that tab. An entry for the tab already in
   * front, or for a page that is closed or gone, is skipped in the same direction, so every press
   * lands on a different open tab. Entries the board did not make (a hash typed into the address
   * bar) are left to hashchange.
   */
  function onHistoryStep(event) {
    const index = event.state?.boardIndex;
    if (typeof index !== "number") {
      return;
    }
    const step = index < historyIndex ? -1 : 1;
    historyIndex = index;
    const id = location.hash.replace(/^#/, "");
    tabFocusHistory.set(index, id);
    const open = state.tabs.find((tab) => tab.id === id);
    if (open && open.id !== state.activeId) {
      selectTab(open.id, { fromUser: true });
      return;
    }
    history.go(step);
    // At either end of the history there is nothing to skip to: point the URL back at the tab in front.
    setTimeout(() => {
      if (historyIndex === index) {
        syncHash();
      }
    }, 150);
  }

  function activeTab() {
    return state.tabs.find((tab) => tab.id === state.activeId) || (state.draft?.id === state.activeId ? state.draft : null);
  }

  /** A New page, as a draft or a saved page that nothing has filled yet. */
  function isBlank(tab) {
    return Boolean(tab && (tab.draft || tab.blank));
  }

  function draftActive() {
    return Boolean(state.draft && state.activeId === state.draft.id);
  }

  /**
   * Ctrl+T: a New page in front (in the focused pane of a split), with no tab until a thread or a
   * template makes it a page. Resolves to whether a New page is in front.
   */
  async function newPage({ beforeRender } = {}) {
    if (childId) {
      return false;
    }
    // The one draft is already on screen, in front or in another pane of a split.
    if (state.draft && views.isShown(state.draft.id)) {
      if (!draftActive()) {
        activatePage(state.draft.id);
      }
      newPageView.focus();
      return true;
    }
    const res = await fetch("/api/drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    if (!data?.tab) {
      showNotice("Could not open a new page");
      return false;
    }
    const from = draftActive() ? state.draftFrom : state.activeId;
    state.draft = data.tab;
    state.draftFrom = from;
    state.activeId = data.tab.id;
    pendingFocus = null;
    lastInteractedAt = Date.now();
    syncHash();
    beforeRender?.();
    render();
    reportViewer();
    newPageView.focus();
    return true;
  }

  /**
   * Leaving a draft throws it away, unless it stays on screen as another pane of a split. The
   * request waits a moment: a chat that keeps its unsent text as a thread when you leave makes the
   * draft a page, and that has to reach the daemon first.
   */
  function dropLeftDraft() {
    if (!state.draft || state.activeId === state.draft.id || views.isShown(state.draft.id)) {
      return;
    }
    const id = state.draft.id;
    state.draft = null;
    state.draftFrom = null;
    setTimeout(() => {
      fetch(`/api/drafts/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    }, 3000);
  }

  function closeDraft() {
    const beside = views.otherPage()?.id;
    const inFront = draftActive();
    views.onClosed(state.draft.id);
    if (!inFront) {
      render();
      return;
    }
    const back = [beside, state.draftFrom].find((id) => id && state.tabs.some((tab) => tab.id === id)) ?? state.tabs[state.tabs.length - 1]?.id ?? null;
    state.activeId = back;
    syncHash();
    render();
    reportViewer();
  }

  /** A template picked on the New page screen fills this page; one with fields asks for them first. */
  function fillFromTemplate(template) {
    const tab = activeTab();
    if (!isBlank(tab)) {
      return;
    }
    if (template.fields?.length) {
      openTemplateModal(template, "fill", null, tab.id);
      return;
    }
    void openTemplate(template, {}, { into: tab.id }).then((error) => error && showNotice(error));
  }

  /** A template picked in the sidebar opens a new page; one with fields asks for them first. */
  function createFromTemplate(template) {
    if (template.fields?.length) {
      openTemplateModal(template, "create");
      return;
    }
    void openTemplate(template, {}, {}).then((error) => error && showNotice(error));
  }

  /** POST a template open; resolves to an error message, or null when it went through. */
  async function openTemplate(template, values, extra) {
    const res = await fetch(`/api/templates/${encodeURIComponent(template.id)}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values, ...extra }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) {
      return data.error || "Could not apply template";
    }
    if (!extra.into && data.tab?.id) {
      pendingFocus = { id: data.tab.id, key: data.tab.key };
    }
    if (data.copiedBuiltin) {
      showNotice(`Added “${template.title}” to your templates`);
    }
    return null;
  }

  function viewUrl(tab) {
    if (tab.embedUrl) {
      return tab.embedUrl;
    }
    return `${pageOrigin(tab.id)}/view/${encodeURIComponent(tab.id)}?r=${tab.revision}&viewer=${viewerId()}`;
  }

  /** Names this app or browser to pages, so scribe.local keeps one copy per place you view them from. */
  function viewerId() {
    let id = localStorage.getItem(VIEWER_ID_KEY);
    if (!id || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
      id = (window.__TAURI__ ? "desktop_" : "browser_") + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(VIEWER_ID_KEY, id);
    }
    return id;
  }

  /** Shared, data-free files and blobs; pages themselves run on pageOrigin. */
  function contentOrigin() {
    const port = location.port ? `:${location.port}` : "";
    return `${location.protocol}//127.0.0.2${port}`;
  }

  /** Each page runs on an origin of its own (#660), as src/config.ts pageHost names it. */
  function pageOrigin(id) {
    const port = location.port ? `:${location.port}` : "";
    const label = /^t_[0-9a-f]+$/.test(id) ? `t-${id.slice(2)}` : `x${Array.from(new TextEncoder().encode(id), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    return `${location.protocol}//${label}.localhost${port}`;
  }

  /** Whether a URL's origin is one of the board's page origins or the shared content origin. */
  function isPageOrigin(origin) {
    if (origin === contentOrigin()) {
      return true;
    }
    try {
      const url = new URL(origin);
      return url.protocol === location.protocol && url.port === location.port && /^(t-[0-9a-f]+|x[0-9a-f]+)\.localhost$/.test(url.hostname);
    } catch {
      return false;
    }
  }

  function setSideOpen(open) {
    state.sideOpen = Boolean(open) && !childId;
    if (!childId) {
      localStorage.setItem(SIDE_OPEN_KEY, state.sideOpen ? "1" : "0");
    }
    if (state.sideOpen) {
      library.refreshSearch();
    }
    renderChrome();
    library.render();
    renderTemplates();
  }

  function applySideWidth(px) {
    const width = Math.max(220, Math.min(480, px));
    document.documentElement.style.setProperty("--side-width", width + "px");
    return width;
  }

  function paneSide(key) {
    const stored = appearanceStorage.getItem(key);
    if (stored === "left" || stored === "right") return stored;
    return key === LIBRARY_SIDE_KEY ? "left" : "right";
  }

  function applyPaneSideAttr(attr, side) {
    if (side === "left") {
      document.documentElement.dataset[attr] = "left";
    } else {
      delete document.documentElement.dataset[attr];
    }
  }

  function setPaneSide(attr, key, side) {
    const value = side === "left" ? "left" : "right";
    appearanceStorage.setItem(key, value);
    applyPaneSideAttr(attr, value);
  }

  function renderPaneSide(track, attr, key) {
    if (!track) {
      return;
    }
    const current = paneSide(key);
    track.replaceChildren();
    for (const item of PANE_SIDES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.name;
      btn.setAttribute("aria-pressed", String(item.id === current));
      btn.addEventListener("click", () => {
        setPaneSide(attr, key, item.id);
        renderPaneSide(track, attr, key);
      });
      track.appendChild(btn);
    }
  }

  function renderPaneSides() {
    renderPaneSide(agentSideTrack, "agentSide", AGENT_SIDE_KEY);
    renderPaneSide(librarySideTrack, "librarySide", LIBRARY_SIDE_KEY);
  }

  /** A track of exclusive choices kept in localStorage; the first option is the default. */
  function renderChoiceTrack(track, options, key, event) {
    if (!track) {
      return;
    }
    const stored = appearanceStorage.getItem(key);
    const current = options.some((item) => item.id === stored) ? stored : options[0].id;
    track.replaceChildren();
    for (const item of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.name;
      btn.setAttribute("aria-pressed", String(item.id === current));
      btn.addEventListener("click", () => {
        appearanceStorage.setItem(key, item.id);
        renderChoiceTrack(track, options, key, event);
        window.dispatchEvent(new Event(event));
      });
      track.appendChild(btn);
    }
  }

  /** A picker where any number of backgrounds can be on, but never none. */
  function renderNewPageBgs() {
    const trigger = document.getElementById("newpage-bgs");
    trigger.onclick = openNewPageBgs;
  }

  function openNewPageBgs() {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm background-picker";
    dialog.setAttribute("aria-label", "New page backgrounds");
    const title = document.createElement("h3"); title.textContent = "New page backgrounds";
    const track = document.createElement("div"); track.className = "background-grid";
    const close = document.createElement("button"); close.type = "button"; close.className = "primary"; close.textContent = "Done";
    close.addEventListener("click", () => dialog.close());
    const actions = document.createElement("div"); actions.className = "confirm-actions";
    actions.append(close);
    dialog.append(title, track, actions);
    document.body.append(dialog);
    dialog.showModal();
    const effects = [];
    dialog.addEventListener("close", () => { effects.forEach(fx => fx?.destroy()); dialog.remove(); });
    dialog.addEventListener("click", event => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
    });
    const stored = (appearanceStorage.getItem(NEWPAGE_BG_KEY) || "").split(",");
    let on = NEWPAGE_BGS.map((item) => item.id).filter((id) => stored.includes(id));
    if (!on.length) on = NEWPAGE_BGS.map((item) => item.id);
    track.replaceChildren();
    for (const item of NEWPAGE_BGS) {
      const btn = document.createElement("button");
      btn.type = "button";
      const canvas = document.createElement("canvas"); canvas.setAttribute("aria-hidden", "true");
      const label = document.createElement("span"); label.textContent = item.name;
      btn.append(canvas, label);
      btn.setAttribute("aria-pressed", String(on.includes(item.id)));
      btn.addEventListener("click", () => {
        const next = on.includes(item.id) ? on.filter((id) => id !== item.id) : [...on, item.id];
        if (!next.length) return;
        appearanceStorage.setItem(NEWPAGE_BG_KEY, next.join(","));
        on = next;
        for (const [index, button] of [...track.children].entries()) button.setAttribute("aria-pressed", String(on.includes(NEWPAGE_BGS[index].id)));
        window.dispatchEvent(new Event("scribe:newpage-bg"));
      });
      track.appendChild(btn);
      effects.push(window.scribeNewPagePreview?.(canvas, item.id));
    }
  }

  function renderChromeFx() {
    renderChoiceTrack(chromeFxTrack, CHROME_FX_STYLES, CHROME_FX_KEY, "scribe:chrome-fx");
    renderChoiceTrack(chromeFxWhenTrack, CHROME_FX_WHEN, CHROME_FX_WHEN_KEY, "scribe:chrome-fx");
  }

  function bindSettingHint(el, description) {
    if (!el) {
      return;
    }
    el.dataset.hint = description;
    el.setAttribute("aria-description", description);
    hoverCard.bind(el, 700);
  }

  function loadTheme() {
    const stored = appearanceStorage.getItem(THEME_KEY);
    if (THEMES.some((theme) => theme.id === stored)) {
      return stored;
    }
    return DEFAULT_THEME;
  }

  function applyFavicon(href) {
    const prev = document.querySelector('link[rel="icon"]');
    if (prev && prev.getAttribute("href") === href) {
      return;
    }
    const link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.setAttribute("sizes", "any");
    link.href = href;
    prev?.remove();
    document.head.appendChild(link);
  }

  function applyTheme(id, persist = true) {
    const theme = THEMES.find((item) => item.id === id) || THEMES[0];
    document.documentElement.dataset.theme = theme.id;
    if (persist) appearanceStorage.setItem(THEME_KEY, theme.id);
    applyFavicon(theme.icon);
    highlightThemeOptions();
  }

  function renderThemeList() {
    themeList.replaceChildren();
    const current = loadTheme();
    for (const theme of THEMES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "theme-option";
      btn.role = "option";
      btn.dataset.theme = theme.id;
      btn.setAttribute("aria-selected", theme.id === current ? "true" : "false");
      const swatch = document.createElement("span");
      swatch.className = "theme-swatch";
      swatch.style.setProperty("--swatch", theme.swatch);
      const label = document.createElement("span");
      label.textContent = theme.name;
      btn.append(swatch, label);
      btn.addEventListener("click", () => applyTheme(theme.id));
      themeList.appendChild(btn);
    }
  }

  function highlightThemeOptions() {
    const current = document.documentElement.dataset.theme || DEFAULT_THEME;
    for (const btn of themeList.querySelectorAll(".theme-option")) {
      btn.setAttribute("aria-selected", btn.dataset.theme === current ? "true" : "false");
    }
  }

  function applyFlag(el, key, fallback = false) {
    const stored = appearanceStorage.getItem(key);
    const on = stored == null ? fallback : stored === "1";
    el.setAttribute("aria-checked", on ? "true" : "false");
  }

  function flagOn(el) {
    return el.getAttribute("aria-checked") === "true";
  }

  function toggleFlag(el, key) {
    const on = !flagOn(el);
    el.setAttribute("aria-checked", on ? "true" : "false");
    appearanceStorage.setItem(key, on ? "1" : "0");
    if (el === smoothScrollToggle && !on) {
      stopTabScroll();
    }
    if (el === showClearToggle) {
      document.documentElement.classList.toggle("hide-clear", !on);
    }
    if (el === tightSmallToggle) {
      document.documentElement.classList.toggle("tight-small", on);
    }
    if (el === uiFxToggle) {
      document.documentElement.classList.toggle("fx-off", !on);
      window.dispatchEvent(new Event("scribe:ui-fx"));
    }
    if (el === refreshOverlayToggle && !on) dismissRefreshOverlay();
    if (el === auroraEdgeToggle) {
      window.dispatchEvent(new Event("scribe:aurora"));
    }
  }

  function smoothTabScroll() {
    return flagOn(smoothScrollToggle) && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function stopTabScroll() {
    if (tabScrollRaf) {
      cancelAnimationFrame(tabScrollRaf);
      tabScrollRaf = 0;
    }
    tabScrollTarget = null;
  }

  function clampTabScroll(left) {
    return Math.max(0, Math.min(Math.max(0, tabsEl.scrollWidth - tabsEl.clientWidth), left));
  }

  function scrollTabsTo(left, smooth) {
    const target = clampTabScroll(left);
    if (!smooth) {
      stopTabScroll();
      tabsEl.scrollLeft = target;
      return;
    }
    tabScrollTarget = target;
    if (!tabScrollRaf) {
      tabScrollRaf = requestAnimationFrame(stepTabScroll);
    }
  }

  function stepTabScroll() {
    tabScrollRaf = 0;
    if (tabScrollTarget == null) {
      return;
    }
    const target = clampTabScroll(tabScrollTarget);
    tabScrollTarget = target;
    const current = tabsEl.scrollLeft;
    const delta = target - current;
    if (Math.abs(delta) < 1) {
      tabsEl.scrollLeft = target;
      tabScrollTarget = null;
      updateTabFade();
      return;
    }
    const step = Math.sign(delta) * Math.max(1, Math.abs(delta) * 0.22);
    tabsEl.scrollLeft = current + step;
    if (tabsEl.scrollLeft === current) {
      tabsEl.scrollLeft = target;
      tabScrollTarget = null;
      updateTabFade();
      return;
    }
    tabScrollRaf = requestAnimationFrame(stepTabScroll);
  }

  function isSettingsOpen() {
    return settingsCategories.isOpen();
  }

  const settingsSections = [...document.querySelectorAll("#settings-panel > .settings-section")];
  const desktopSettingsSection = window.__TAURI__?.core ? document.createElement("section") : null;
  if (desktopSettingsSection) {
    desktopSettingsSection.id = "desktop-settings";
    desktopSettingsSection.className = "settings-section";
  }
  const flairSection = document.createElement("section");
  flairSection.className = "settings-section";
  flairSection.innerHTML = "<h3>Visual flair</h3>";
  const layout = settingsSections[5];
  for (const row of [...layout.querySelectorAll(".setting-row")]) {
    if (!row.querySelector("#agent-side, #library-side, #tight-small")) flairSection.append(row);
  }
  const settingsCategories = window.scribeSettingsUI.mount(document.getElementById("settings-panel"), [
    { label: "Appearance", sections: [settingsSections[0], settingsSections[5], flairSection] },
    { label: "Navigation", sections: [settingsSections[1], settingsSections[2]] },
    { label: "Search", sections: [settingsSections[3], settingsSections[4]] },
    { label: "Classifier", sections: window.scribeMlSettings.sections },
    { label: "Audio", sections: window.scribeAudioSettings.sections },
    { label: "Plugins", sections: window.scribePluginSettings.sections },
    { label: "Integrations", sections: window.scribeIntegrations.sections },
    ...(desktopSettingsSection ? [{ label: "Desktop", sections: [desktopSettingsSection] }] : []),
    { label: "Files", sections: [settingsSections[7]] },
    { label: "Import / Export", sections: [settingsSections[6]] },
  ], {
    close: closeSettings,
    after: [
      { label: "Agent settings →", run: () => window.scribeChat?.openSettings() },
      // The full panel on what chats are given, with their MCP servers, skills and memories (harness.js).
      { label: "Agent harness →", run: () => {
        closeSettings();
        window.scribeHarness?.open();
      } },
    ],
  });

  const searchSwitch = document.getElementById("search-enabled");
  const searchPackStatus = document.getElementById("search-pack-status");
  const searchInstallPack = document.getElementById("search-install-pack");
  const searchPackFile = document.getElementById("search-pack-file");
  let installingSearchPack = false;
  function renderSearchSettings(result) {
    semanticStatus = result;
    if (!installingSearchPack) searchPackStatus.textContent = result.message;
    document.getElementById("search-pack-folder").textContent = result.folder;
    searchSwitch.disabled = installingSearchPack || result.status !== "ready";
    searchSwitch.setAttribute("aria-checked", String(result.enabled));
  }
  async function searchSettingsRequest(endpoint, body) {
    const response = await fetch(`/api/search/${endpoint}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Cannot update search settings");
    return result;
  }
  searchSwitch.addEventListener("click", async () => {
    const enabled = searchSwitch.getAttribute("aria-checked") !== "true";
    searchSwitch.disabled = true;
    try { renderSearchSettings(await searchSettingsRequest("settings", { enabled })); }
    catch (err) { searchPackStatus.textContent = err.message; searchSwitch.disabled = false; }
  });
  document.getElementById("search-open-folder").addEventListener("click", async () => {
    try { await searchSettingsRequest("open-folder", {}); }
    catch (err) { searchPackStatus.textContent = err.message; }
  });
  searchInstallPack.addEventListener("click", () => searchPackFile.click());
  searchPackFile.addEventListener("change", async () => {
    const file = searchPackFile.files[0];
    searchPackFile.value = "";
    if (!file || installingSearchPack) return;
    if (file.size > 2 * 1024 ** 3) { searchPackStatus.textContent = "Choose a search pack ZIP smaller than 2 GiB"; return; }
    installingSearchPack = true;
    searchInstallPack.disabled = true;
    searchSwitch.disabled = true;
    searchPackStatus.textContent = "Uploading search pack… 0%";
    let error;
    try {
      // XHR, not fetch: fetch reports no upload progress, and a pack is hundreds of MB.
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/search/install");
        xhr.setRequestHeader("Content-Type", "application/zip");
        xhr.responseType = "json";
        xhr.upload.onprogress = e => {
          if (e.lengthComputable) searchPackStatus.textContent = `Uploading search pack… ${Math.floor(e.loaded / e.total * 100)}%`;
        };
        xhr.upload.onload = () => { searchPackStatus.textContent = "Checking and installing search pack…"; };
        xhr.onload = () => xhr.status < 400 && xhr.response ? resolve(xhr.response) : reject(new Error(xhr.response?.error || "Cannot install search pack"));
        xhr.onerror = () => reject(new Error("Cannot install search pack"));
        xhr.send(file);
      });
      installingSearchPack = false;
      renderSearchSettings(result);
    } catch (err) { error = err.message; }
    finally {
      installingSearchPack = false;
      searchInstallPack.disabled = false;
      if (error) {
        try { renderSearchSettings(await searchSettingsRequest("status")); } catch {}
        searchPackStatus.textContent = error;
      }
    }
  });
  // The classifier's check of search results (#520): the same switch as Classifier, Features, where its source is set up.
  const rerankSwitch = document.getElementById("search-rerank");
  const rerankLabel = document.getElementById("search-rerank-label");
  function renderRerankSetting(view) {
    const feature = view.features.find((f) => f.id === "search-rerank");
    const ready = !!feature && view.sources.some((source) => source.id === view.defaultSource);
    const hint = (ready ? "" : "Add a classifier source first (Classifier). ") + (feature?.hint || "");
    rerankLabel.dataset.tooltip = hint;
    rerankLabel.setAttribute("aria-description", hint);
    rerankSwitch.disabled = !ready;
    rerankSwitch.setAttribute("aria-checked", String(ready && feature.on));
  }
  rerankSwitch.addEventListener("click", async () => {
    rerankSwitch.disabled = true;
    try { await window.scribeMlSettings.setFeature("search-rerank", rerankSwitch.getAttribute("aria-checked") !== "true"); }
    catch (err) { searchPackStatus.textContent = err.message; rerankSwitch.disabled = false; }
  });
  window.scribeMlSettings.init({ confirm: confirmDelete, view: renderRerankSetting });
  window.scribeAudioSettings.init({ confirm: confirmDelete });
  window.scribePluginSettings.init({confirm:confirmDelete});
  window.scribePluginSettings.refresh();
  function openSettings(category) {
    if (isPaletteOpen()) {
      closePalette();
    }
    settingsCategories.open();
    if (category === "Audio") settingsCategories.select(4);
    window.scribeAudioSettings.refresh();
    window.scribePluginSettings.refresh();
    searchSwitch.disabled = true;
    window.scribeIntegrations.refresh();
    searchSettingsRequest("status").then(renderSearchSettings).catch(err => { searchPackStatus.textContent = err.message; });
    window.scribeMlSettings.refresh();
  }

  function closeSettings() {
    window.scribeSettingsUI.close();
  }

  function toggleSettings() {
    if (isSettingsOpen()) {
      closeSettings();
      return;
    }
    openSettings();
  }

  function renderChrome() {
    clearBtn.disabled = !state.tabs.some((tab) => !tab.pinned);
    exportPageBtn.disabled = !state.activeId || draftActive();
    newTabBtn.classList.toggle("on", draftActive());
    exportAllBtn.disabled = libraryPages().length === 0;
    const blips = unreadLibrary.size;
    libraryBadge.hidden = blips === 0;
    libraryBadge.textContent = blips > 99 ? "99+" : String(blips);
    libraryToggle.setAttribute("aria-expanded", state.sideOpen ? "true" : "false");
    libraryToggle.classList.toggle("on", state.sideOpen);
    sidePane.classList.toggle("closed", !state.sideOpen);
    sidePane.setAttribute("aria-hidden", state.sideOpen ? "false" : "true");
    sidePane.toggleAttribute("inert", !state.sideOpen);
    syncSidebarTab();
    const active = activeTab();
    const bound = Boolean(active?.templateId);
    // Nothing to edit on a page whose template has no fields.
    templateEditBtn.hidden = !(bound && state.templates.find((item) => item.id === active.templateId)?.fields?.length);
    const blocked = bound && active.templateCompatible === false;
    const mainEl = document.querySelector("main");
    mainEl.classList.toggle("template-locked", blocked);
    templateBlock.hidden = !blocked;
    if (blocked) {
      templateBlockReason.textContent =
        active.templateIncompatibleReason ||
        "The template changed and this page's data no longer matches. Ask the agent to fix the data.";
    }
  }

  function revealTab(el, smooth, center = false) {
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    const viewLeft = tabsEl.scrollLeft;
    const viewRight = viewLeft + tabsEl.clientWidth;
    if (center && (left < viewLeft || right > viewRight)) {
      scrollTabsTo(left - (tabsEl.clientWidth - el.offsetWidth) / 2, smooth);
    } else if (left < viewLeft) {
      scrollTabsTo(left, smooth);
    } else if (right > viewRight) {
      scrollTabsTo(right - tabsEl.clientWidth, smooth);
    }
  }

  function updateTabFade() {
    const overflow = tabsEl.scrollWidth - tabsEl.clientWidth > 1;
    const moreToTheRight = tabsEl.scrollLeft + tabsEl.clientWidth < tabsEl.scrollWidth - 1;
    const moreToTheLeft = tabsEl.scrollLeft > 1;
    tabsEl.classList.toggle("fade-right", overflow && moreToTheRight);
    tabsEl.classList.toggle("fade-left", overflow && moreToTheLeft);
  }

  function lookupTab(el) {
    const id = el?.dataset?.id;
    return id ? state.tabs.find((tab) => tab.id === id) || null : null;
  }

  function syncTabEl(el, tab) {
    el.dataset.id = tab.id;
    el.className =
      "tab" +
      (tab.id === state.activeId ? " active" : "") +
      ((tab.id !== state.activeId && views.paneOf(tab.id)) || popout.has(tab.id) ? " beside" : "") +
      (popout.has(tab.id) ? " popped" : "") +
      (tab.pinned ? " pinned" : "") +
      (unread.has(tab.id) && tab.id !== state.activeId ? " updated" : "") +
      (window.scribeChat?.pageStatus(tab.id) ? ` agent-${window.scribeChat.pageStatus(tab.id)}` : "");
    if (drag?.moved && drag.id === tab.id) {
      el.classList.add("dragging");
    }
    const label = stripTitle(tab);
    el.setAttribute("aria-label", label);
    // A file page shows its kind (#707).
    const fileName = tab.file?.path || "";
    let fileBadge = el.querySelector(".file-badge:not(.browser-badge)");
    if ((fileBadge?.dataset.name || "") !== fileName) {
      fileBadge?.remove();
      if (fileName) {
        fileBadge = window.scribeFiles.badge(fileName);
        fileBadge.dataset.name = fileName;
        el.insertBefore(fileBadge, el.querySelector(".tab-title"));
      }
    }
    let browserBadge = el.querySelector(".browser-badge");
    if (tab.browser && !browserBadge) {
      browserBadge = document.createElement("span");
      browserBadge.className = "file-badge browser-badge";
      browserBadge.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>';
      el.insertBefore(browserBadge, el.querySelector(".tab-title"));
    } else if (!tab.browser) browserBadge?.remove();
    let pin = el.querySelector(".tab-pin");
    if (tab.pinned) {
      if (!pin) {
        pin = document.createElement("span");
        pin.className = "tab-pin";
        pin.innerHTML = PIN_SVG;
        el.insertBefore(pin, el.firstChild);
      }
    } else if (pin) {
      pin.remove();
    }
    let temp = el.querySelector(".tab-temp");
    if (tab.temp) {
      if (!temp) {
        temp = document.createElement("span");
        temp.className = "tab-temp";
        temp.setAttribute("aria-label", TEMP_TITLE);
        temp.dataset.tooltip = TEMP_TITLE;
        temp.innerHTML = TEMP_SVG;
        el.insertBefore(temp, el.firstChild);
      }
    } else if (temp) {
      temp.remove();
    }
    let hidden = el.querySelector(".tab-agent-hidden");
    if (tab.agentHidden) {
      if (!hidden) {
        hidden = document.createElement("span");
        hidden.className = "tab-agent-hidden";
        hidden.setAttribute("aria-label", AGENT_HIDDEN_TITLE);
        hidden.innerHTML = AGENT_HIDDEN_SVG;
        el.insertBefore(hidden, el.querySelector(".tab-title"));
      }
    } else if (hidden) {
      hidden.remove();
    }
    let dot = el.querySelector(".tab-updated");
    if (unread.has(tab.id) && tab.id !== state.activeId) {
      if (!dot) {
        dot = document.createElement("span");
        dot.className = "tab-updated";
        dot.setAttribute("aria-label", "Updated in the background");
        const titleEl = el.querySelector(".tab-title");
        el.insertBefore(dot, titleEl);
      }
    } else if (dot) {
      dot.remove();
    }
    const title = el.querySelector(".tab-title");
    if (title) {
      title.textContent = label;
    }
  }

  /** A New page in the strip is named by its threads: "New - <thread>" or "Draft - <unsent text>". */
  function stripTitle(tab) {
    return (isBlank(tab) && window.scribeChat?.blankPageTitle?.(tab.id)) || tab.title;
  }

  function createTabEl(tab) {
    const el = document.createElement("div");
    el.role = "tab";
    el.dataset.id = tab.id;
    const title = document.createElement("span");
    title.className = "tab-title";
    el.appendChild(title);
    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      const current = lookupTab(el);
      if (current) {
        closeTab(current.id, { permanent: event.shiftKey });
      }
    });
    el.appendChild(close);
    el.addEventListener("click", (event) => {
      const current = lookupTab(el);
      if (!current) {
        return;
      }
      if (event.detail > 1) {
        copyTabKey(current.id);
        return;
      }
      selectTab(current.id, { fromUser: true });
    });
    el.addEventListener("auxclick", (event) => {
      if (event.button !== 1) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const current = lookupTab(el);
      if (!current) {
        return;
      }
      if (event.shiftKey) {
        closeTab(current.id, { permanent: true });
        return;
      }
      closeTab(current.id);
    });
    el.addEventListener("mousedown", (event) => {
      if (event.button === 1) {
        event.preventDefault();
      }
    });
    el.addEventListener("pointerdown", (event) => onTabPointerDown(event, el));
    el.addEventListener("contextmenu", (event) => {
      const current = lookupTab(el);
      if (current) {
        library.pageMenu(event, current.id);
      }
    });
    hoverCard.bind(el, TAB_CARD_DELAY);
    syncTabEl(el, tab);
    return el;
  }

  function flipStrip(mutate) {
    const nodes = [...tabsEl.children];
    const first = new Map(nodes.map((node) => [node, node.getBoundingClientRect()]));
    mutate();
    const lastBoxes = new Map(nodes.map(node => [node, node.getBoundingClientRect()]));
    for (const node of nodes) {
      if (node.classList.contains("dragging") || node === drag?.placeholder) {
        continue;
      }
      const prev = first.get(node);
      if (!prev || !node.isConnected) {
        continue;
      }
      const last = lastBoxes.get(node);
      const dx = prev.left - last.left;
      if (Math.abs(dx) < 1) {
        continue;
      }
      node.style.transition = "none";
      node.style.transform = `translateX(${dx}px)`;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          node.style.transition = "";
          node.style.transform = "";
        });
      });
    }
  }

  function renderTabs() {
    if (drag?.moved) {
      for (const tab of state.tabs) {
        const el = tabEls.get(tab.id);
        if (el) {
          syncTabEl(el, tab);
        }
      }
      requestAnimationFrame(updateTabFade);
      return;
    }
    const seen = new Set();
    const ordered = [];
    const firstRender = tabEls.size === 0;
    let fresh = null;
    for (const tab of state.tabs) {
      let el = tabEls.get(tab.id);
      if (!el) {
        el = createTabEl(tab);
        tabEls.set(tab.id, el);
        if (!firstRender && (!fresh || tab.id === state.activeId)) {
          fresh = el;
        }
      } else {
        syncTabEl(el, tab);
      }
      seen.add(tab.id);
      ordered.push(el);
    }
    for (const [id, el] of tabEls) {
      if (seen.has(id)) {
        continue;
      }
      el.remove();
      tabEls.delete(id);
    }
    // Move only the tabs that are out of place: a tab put back in loses its hover and blinks (#407).
    let before = null;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const el = ordered[index];
      if (el.parentNode !== tabsEl || el.nextSibling !== before) {
        tabsEl.insertBefore(el, before);
      }
      before = el;
    }
    const active = tabsEl.querySelector(".tab.active");
    if (fresh && !drag && (fresh === active || !active)) {
      // A tab that just appeared: bring it to the middle of the strip if it is out of view (#861).
      revealTab(fresh, smoothTabScroll(), true);
      revealedTabId = state.activeId;
      revealedTabShape = ordered.length + ":" + tabsEl.clientWidth;
    } else if (active && !drag) {
      // Only when the active tab or the strip changed: any other render would pull a strip the user scrolled back.
      const shape = ordered.length + ":" + tabsEl.clientWidth;
      if (revealedTabId !== state.activeId || revealedTabShape !== shape) {
        const smooth = smoothTabScroll() && revealedTabId != null && revealedTabId !== state.activeId;
        revealTab(active, smooth);
        revealedTabId = state.activeId;
        revealedTabShape = shape;
      }
    } else if (!active) {
      revealedTabId = null;
    }
    requestAnimationFrame(updateTabFade);
  }

  function onTabPointerDown(event, el) {
    if (event.button !== 0 || drag) {
      return;
    }
    if (event.target.closest(".tab-close")) {
      return;
    }
    const tab = lookupTab(el);
    if (!tab) {
      return;
    }
    drag = {
      id: tab.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      originOrder: state.tabs.map((item) => item.id),
      groupPinned: tab.pinned,
      offsetX: 0,
      offsetY: 0,
      width: 0,
      el,
      placeholder: null,
      scrollDir: 0,
    };
    drag.controller = window.scribeDrag({ event, target: tabsWrap,
      onStart: beginTabDrag,
      onMove: move => { onTabPointerMove(move); return Boolean(drag?.scrollDir); },
      onDrop: onTabPointerUp,
      onCancel: () => abortDrag(),
      measure: api => { if (drag) { drag.strip = api.rect(tabsWrap); drag.toggle = api.rect(libraryToggle); } },
    });
  }

  function startPaneDrag(event, pane, head) {
    if (drag) return;
    drag = {
      pane, id: views.pageInPane(pane)?.id, sourceHead: head, el: head.cloneNode(true),
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      moved: false, originOrder: state.tabs.map((tab) => tab.id), scrollDir: 0,
    };
    drag.controller = window.scribeDrag({ event, target: tabsWrap,
      onStart: beginTabDrag,
      onMove: move => { onTabPointerMove(move); return Boolean(drag?.scrollDir); },
      onDrop: onTabPointerUp,
      onCancel: () => abortDrag(),
      measure: api => { if (drag) { drag.strip = api.rect(tabsWrap); drag.toggle = api.rect(libraryToggle); } },
    });
  }

  function onTabPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    if (!drag?.moved) {
      return;
    }
    event.preventDefault();
    positionDraggedTab(event.clientX, event.clientY);
    const strip = drag.strip;
    // Tabs can drift below the strip while reordering; pane headers keep their explicit close target.
    const overStrip = event.clientX >= strip.left && event.clientX <= strip.right && event.clientY >= strip.top && event.clientY <= strip.bottom + (drag.pane ? 0 : 28);
    drag.pageDrop = views.updatePageDrag(event.clientX, overStrip ? Number.NaN : event.clientY);
    drag.overStrip = overStrip;
    const closePane = drag.pane && overStrip && views.canCloseDraggedPane(drag.pane);
    tabsWrap.classList.toggle("pane-close-drop", Boolean(closePane));
    if (drag.pane) {
      if (closePane) drag.pageDrop = { strip: true };
      return;
    }
    trackToggleHover(event.clientX, event.clientY);
    const tab = state.tabs.find((item) => item.id === drag.id);
    const overLibrary = Boolean(tab && tab.key !== "scribe:welcome" && library.stripDragMove(tab, event.clientX, event.clientY));
    drag.el.classList.toggle("to-library", overLibrary);
    if (overLibrary || drag.pageDrop || !overStrip) {
      updateDragScroll(Number.NaN);
      return;
    }
    updateDragScroll(event.clientX);
    moveDropSlot();
  }

  /** Hovering the Library button mid-drag opens the Library so the tab can be filed. */
  function trackToggleHover(x, y) {
    const box = drag.toggle;
    const over = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    if (!over) {
      clearTimeout(toggleHoverTimer);
      toggleHoverTimer = 0;
      libraryToggle.classList.remove("drag-hover");
      return;
    }
    if (toggleHoverTimer || libraryShown()) {
      return;
    }
    libraryToggle.classList.add("drag-hover");
    toggleHoverTimer = window.setTimeout(() => {
      libraryToggle.classList.remove("drag-hover");
      if (drag?.moved) {
        setSidebarTab("library");
        setSideOpen(true);
        drag.controller.invalidate();
      }
    }, TOGGLE_HOVER_OPEN_MS);
  }

  function beginTabDrag(event) {
    if (!drag) {
      return;
    }
    const el = drag.el;
    const rect = (drag.sourceHead || el).getBoundingClientRect();
    drag.moved = true;
    stopTabScroll();
    drag.offsetX = drag.startX - rect.left;
    drag.offsetY = drag.startY - rect.top;
    drag.width = rect.width;
    if (!drag.pane) {
      const placeholder = document.createElement("div");
      placeholder.className = "tab-drop-slot";
      placeholder.style.width = rect.width + "px";
      placeholder.style.height = rect.height + "px";
      el.replaceWith(placeholder);
      drag.placeholder = placeholder;
    }
    el.classList.add("dragging");
    document.body.appendChild(el);
    el.style.position = "fixed";
    el.style.left = rect.left + "px";
    el.style.top = rect.top + "px";
    el.style.width = rect.width + "px";
    el.style.height = rect.height + "px";
    el.style.zIndex = "30";
    el.style.pointerEvents = "none";
    el.style.margin = "0";
    tabsEl.classList.add("reordering");
    document.body.classList.add("dragging-tab");
    hoverCard.suspend();
    views.beginPageDrag(drag.pane ? { pane: drag.pane } : { id: drag.id });
  }

  function positionDraggedTab(clientX, clientY) {
    if (!drag?.el) {
      return;
    }
    drag.x = clientX; drag.y = clientY;
    drag.el.style.transform = `translate(${clientX - drag.startX}px, ${clientY - drag.startY}px)`;
  }

  function groupLocalIndex(id) {
    let index = 0;
    for (const tab of state.tabs) {
      if (tab.pinned !== drag.groupPinned) {
        continue;
      }
      if (tab.id === id) {
        return index;
      }
      index += 1;
    }
    return -1;
  }

  /** Layout box, ignoring FLIP translate so hit-testing stays stable while siblings animate. */
  function layoutBox(el) {
    return window.scribeDrag.layout(el);
  }

  function groupOthers() {
    const others = [];
    for (const child of tabsEl.children) {
      if (child === drag.placeholder) {
        continue;
      }
      const tab = lookupTab(child);
      if (tab && tab.pinned === drag.groupPinned) {
        others.push(child);
      }
    }
    return others;
  }

  function absIndexForGroupTarget(target) {
    let seen = 0;
    let insertAbs = state.tabs.length;
    for (let i = 0; i < state.tabs.length; i += 1) {
      if (state.tabs[i].pinned !== drag.groupPinned) {
        continue;
      }
      if (seen === target) {
        return i;
      }
      seen += 1;
      insertAbs = i + 1;
    }
    return insertAbs;
  }

  function syncPlaceholder() {
    const placeholder = drag?.placeholder;
    if (!placeholder) {
      return;
    }
    const idx = state.tabs.findIndex((tab) => tab.id === drag.id);
    for (let i = idx - 1; i >= 0; i -= 1) {
      const el = tabEls.get(state.tabs[i].id);
      if (el && el.parentNode === tabsEl) {
        el.after(placeholder);
        return;
      }
    }
    for (let i = idx + 1; i < state.tabs.length; i += 1) {
      const el = tabEls.get(state.tabs[i].id);
      if (el && el.parentNode === tabsEl) {
        el.before(placeholder);
        return;
      }
    }
    tabsEl.appendChild(placeholder);
  }

  function moveDropSlot() {
    if (!drag?.placeholder || !drag.el) {
      return;
    }
    const ghostMid = drag.x - drag.offsetX + drag.width / 2;
    const others = groupOthers();
    // Read the stable positions once, choose the final index, then move the slot once.
    const target = others.filter(node => {
      const box = drag.controller.layout(node);
      return ghostMid > box.left + box.width / 2;
    }).length;
    const from = groupLocalIndex(drag.id);
    if (target === from || from < 0) return;
    flipStrip(() => {
      const fromAbs = state.tabs.findIndex(tab => tab.id === drag.id);
      const moving = state.tabs.splice(fromAbs, 1)[0];
      state.tabs.splice(absIndexForGroupTarget(target), 0, moving);
      syncPlaceholder();
    });
    drag.controller.invalidate();
  }

  function updateDragScroll(clientX) {
    if (!drag) {
      return;
    }
    const rect = drag.controller.rect(tabsEl);
    const edge = 36;
    let dir = 0;
    if (clientX < rect.left + edge) dir = -1;
    else if (clientX > rect.right - edge) dir = 1;
    const before = tabsEl.scrollLeft;
    if (dir) tabsEl.scrollLeft += dir * 14;
    drag.scrollDir = tabsEl.scrollLeft !== before ? dir : 0;
    if (drag.scrollDir) { drag.controller.invalidate(); updateTabFade(); }
  }

  function neighborBeforeId() {
    if (!drag) {
      return null;
    }
    const idx = state.tabs.findIndex((tab) => tab.id === drag.id);
    const next = state.tabs[idx + 1];
    if (next && next.pinned === drag.groupPinned) {
      return next.id;
    }
    return null;
  }

  function restoreTabOrder(order) {
    const byId = new Map(state.tabs.map((tab) => [tab.id, tab]));
    const next = [];
    for (const id of order) {
      const tab = byId.get(id);
      if (tab) {
        next.push(tab);
        byId.delete(id);
      }
    }
    for (const tab of byId.values()) {
      next.push(tab);
    }
    state.tabs = next;
  }

  function stopDragVisual() {
    drag?.controller?.dispose();
    views.endPageDrag();
    tabsWrap.classList.remove("pane-close-drop");
    clearTimeout(toggleHoverTimer);
    toggleHoverTimer = 0;
    libraryToggle.classList.remove("drag-hover");
    hoverCard.resume();
    tabsEl.classList.remove("reordering");
    document.body.classList.remove("dragging-tab");
    if (!drag) {
      return;
    }
    const el = drag.el;
    el.classList.remove("dragging", "to-library");
    el.style.position = "";
    el.style.left = "";
    el.style.top = "";
    el.style.width = "";
    el.style.height = "";
    el.style.zIndex = "";
    el.style.pointerEvents = "";
    el.style.margin = "";
    el.style.transform = "";
    el.style.transition = "";
    if (drag.pane) {
      el.remove();
      return;
    }
    if (drag.placeholder && drag.placeholder.isConnected) {
      drag.placeholder.replaceWith(el);
    } else if (!el.isConnected) {
      tabsEl.appendChild(el);
    }
  }

  function abortDrag(restore = true) {
    if (!drag) {
      return;
    }
    const origin = drag.originOrder;
    const moved = drag.moved;
    library.stripDragCancel();
    stopDragVisual();
    drag = null;
    if (restore && moved) {
      restoreTabOrder(origin);
    }
    if (restore) {
      renderTabs();
    }
  }

  async function onTabPointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    if (event.type === "pointercancel") {
      abortDrag();
      return;
    }
    const moved = drag.moved;
    const id = drag.id;
    const origin = drag.originOrder;
    const before = moved && !drag.pane ? neighborBeforeId() : null;
    const changed = moved && state.tabs.map((tab) => tab.id).join("\0") !== origin.join("\0");
    if (!moved) {
      drag = null;
      return;
    }
    const source = drag.pane ? { pane: drag.pane } : { id };
    const pageDrop = drag.pageDrop;
    const outside = !drag.overStrip && !pageDrop;
    const draggedTab = findAnyTab(id);
    // Let go outside the window (the desktop app): the page gets a window of its own there.
    const tornOff = Boolean(popout.desktop && outside && outsideWindow(event) && canPopOut(draggedTab));
    const filed = Boolean(!tornOff && !drag.pane && !pageDrop && draggedTab && library.stripDragDrop(draggedTab));
    library.stripDragCancel();
    stopDragVisual();
    drag = null;
    if (filed || pageDrop || source.pane || outside) {
      restoreTabOrder(origin);
    }
    renderTabs();
    if (tornOff) {
      await popOut(id, { x: event.screenX - TEAR_OFF_GRIP.x, y: event.screenY - TEAR_OFF_GRIP.y });
      return;
    }
    if (pageDrop || source.pane) {
      await views.dropPage(source, pageDrop);
      return;
    }
    if (filed) {
      tabEls.get(id)?.classList.add("filing");
      return;
    }
    if (!changed || outside) {
      return;
    }
    try {
      const res = await fetch(`/api/tabs/${encodeURIComponent(id)}/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ before }),
      });
      if (!res.ok) {
        restoreTabOrder(origin);
        renderTabs();
      }
    } catch {
      restoreTabOrder(origin);
      renderTabs();
    }
  }

  /** Where in the new window's title bar the pointer lands after a tab is dragged out. */
  const TEAR_OFF_GRIP = { x: 120, y: 18 };
  /** A drag has to leave the window by this much, so a slip past the edge of the strip is not a tear-off. */
  const TEAR_OFF_MARGIN = 12;

  function outsideWindow(event) {
    return (
      event.clientX < -TEAR_OFF_MARGIN ||
      event.clientY < -TEAR_OFF_MARGIN ||
      event.clientX > window.innerWidth + TEAR_OFF_MARGIN ||
      event.clientY > window.innerHeight + TEAR_OFF_MARGIN
    );
  }

  function canPopOut(tab) {
    return Boolean(popout.supported && tab && !isBlank(tab) && !popout.has(tab.id));
  }

  /** Give a page a window of its own. Its tab stays in the strip and stands for that window. */
  async function popOut(id, at) {
    let tab = findAnyTab(id);
    if (!canPopOut(tab)) {
      return;
    }
    // A Library page shown in a peek may not have a tab yet. Child windows need that tab.
    if (!state.tabs.some((item) => item.id === id)) {
      const res = await fetch(`/api/tabs/${encodeURIComponent(id)}/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activate: false }),
      }).catch(() => null);
      if (!res?.ok) return;
      tab = (await res.json()).tab;
      if (!canPopOut(tab)) return;
      // The socket may still be delivering the open event; keep the child alive in the meantime.
      if (!state.tabs.some((item) => item.id === id)) state.tabs.push(tab);
      state.closed = state.closed.filter((item) => item.id !== id);
    }
    if (!popout.open(tab, at)) {
      showNotice("The browser blocked the new window. Allow pop-ups for Scribe to open pages in their own windows.");
    }
  }

  /** The nearest tab to `id` that is not in a window of its own, right side first. */
  function freeNeighborId(id) {
    const idx = state.tabs.findIndex((tab) => tab.id === id);
    for (let step = 1; step < state.tabs.length; step += 1) {
      for (const tab of [state.tabs[idx + step], state.tabs[idx - step]]) {
        if (tab && !popout.has(tab.id)) {
          return tab.id;
        }
      }
    }
    return null;
  }

  /**
   * Windows and the strip agree before anything is drawn. A child window shows its page and closes
   * when that page's tab leaves the strip. In the main window a page in its own window is never the
   * one in front, and a window whose tab is gone is closed.
   */
  function settlePopouts() {
    if (!snapshotSeen) {
      return;
    }
    if (chatChild) {
      state.activeId = null;
      return;
    }
    if (childId) {
      state.activeId = state.tabs.some((tab) => tab.id === childId) ? childId : null;
      if (!state.activeId) {
        popout.closeSelf();
      }
      return;
    }
    for (const id of popout.ids()) {
      if (!state.tabs.some((tab) => tab.id === id)) {
        popout.close(id);
      }
    }
    if (state.activeId && popout.has(state.activeId)) {
      state.activeId = freeNeighborId(state.activeId);
      syncHash();
      reportViewer();
    }
  }

  /**
   * Library row dragged over the strip: shows a drop slot in the page's pin group.
   * Returns where it would open, or null when the pointer is not over the strip.
   */
  function stripSlot(x, y, page) {
    const box = window.scribeDrag.rect(tabsWrap);
    if (x < box.left || x > box.right || y < box.top - 10 || y > box.bottom + 10) {
      clearStripSlot();
      return null;
    }
    const pinned = Boolean(page.pinned);
    const group = state.tabs.filter((tab) => Boolean(tab.pinned) === pinned && tab.id !== page.id);
    const before =
      group.find((tab) => {
        const el = tabEls.get(tab.id);
        if (!el) {
          return false;
        }
        const r = layoutBox(el);
        return x < (r.left + r.right) / 2;
      }) || null;
    let anchor = before ? tabEls.get(before.id) : null;
    let after = null;
    if (!anchor) {
      const last = group[group.length - 1];
      after = last ? tabEls.get(last.id) : null;
      if (!after && pinned) {
        anchor = tabsEl.firstElementChild;
      }
    }
    if (!stripSlotEl) {
      stripSlotEl = document.createElement("div");
      stripSlotEl.className = "tab-drop-slot strip-open-slot";
    }
    const slot = stripSlotEl;
    const inPlace = after ? after.nextElementSibling === slot : anchor ? anchor.previousElementSibling === slot : slot.parentNode === tabsEl && !slot.nextElementSibling;
    if (!inPlace) {
      flipStrip(() => {
        if (after) {
          after.after(slot);
        } else if (anchor && anchor !== slot) {
          anchor.before(slot);
        } else {
          tabsEl.appendChild(slot);
        }
      });
      window.scribeDrag.invalidate();
    }
    tabsWrap.classList.add("strip-drop-over");
    return { before: before ? before.id : null };
  }

  function clearStripSlot() {
    tabsWrap.classList.remove("strip-drop-over");
    const slot = stripSlotEl;
    if (slot?.isConnected) {
      flipStrip(() => slot.remove());
      window.scribeDrag.invalidate();
    }
  }

  function libraryShown() {
    return state.sideOpen && state.sidebarTab === "library" && !state.trashOpen;
  }

  function syncSidebarTab() {
    const templates = state.sidebarTab === "templates";
    const inTrash = state.trashOpen;
    sidebarTabs.hidden = inTrash;
    sidebarBack.hidden = !inTrash;
    sidebarPanelTrash.hidden = !inTrash;
    sidebarTabLibrary.classList.toggle("on", !templates);
    sidebarTabTemplates.classList.toggle("on", templates);
    sidebarTabLibrary.setAttribute("aria-selected", templates ? "false" : "true");
    sidebarTabTemplates.setAttribute("aria-selected", templates ? "true" : "false");
    sidebarPanelLibrary.hidden = templates || inTrash;
    sidebarPanelTemplates.hidden = !templates || inTrash;
  }

  function openTrash() {
    library.closeMenu();
    state.trashOpen = true;
    syncSidebarTab();
    trash.setVisible(true);
    if (!state.sideOpen) {
      setSideOpen(true);
    }
    trash.focus();
  }

  function closeTrash() {
    if (!state.trashOpen) {
      return;
    }
    state.trashOpen = false;
    trash.setVisible(false);
    syncSidebarTab();
    if (state.sidebarTab === "library") {
      library.refreshSearch();
      library.render();
    } else {
      renderTemplates();
    }
  }

  function setSidebarTab(tab) {
    if (state.trashOpen) {
      state.trashOpen = false;
      trash.setVisible(false);
    }
    state.sidebarTab = tab === "templates" ? "templates" : "library";
    localStorage.setItem(SIDEBAR_TAB_KEY, state.sidebarTab);
    syncSidebarTab();
    if (state.sidebarTab === "library") {
      library.refreshSearch();
      library.render();
    }
    renderTemplates();
  }

  function renderTemplates() {
    const rows = state.templates.filter(t => !t.plugin);
    const builtins = state.builtinTemplates.filter(t => !t.plugin);
    const plugins = new Map();
    for (const template of [...state.templates, ...state.builtinTemplates]) {
      if (!template.plugin) continue;
      if (template.builtIn && template.localId) continue;
      const { id, name } = template.plugin;
      if (!plugins.has(id)) plugins.set(id, { id, name, templates: [] });
      plugins.get(id).templates.push(template);
    }
    const groups = [...plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
    const pluginCount = groups.reduce((count, group) => count + group.templates.length, 0);
    templateCountEl.textContent = String(rows.length + pluginCount);
    builtinCountEl.textContent = String(builtins.length);
    // The rows are drawn while the Templates tab shows, and only when they changed.
    const shown = state.sideOpen && state.sidebarTab === "templates" && !state.trashOpen;
    const sig = shown ? JSON.stringify([rows, builtins, groups, state.builtinOpen]) : templatesDrawn;
    if (sig !== templatesDrawn) {
      templatesDrawn = sig;
      window.scribeSyncChildren(templateList, [
        ...rows.map((template) => templateRow(template, false)),
        ...groups.map(group => {
          const section = document.createElement("section");
          section.className = "plugin-template-group";
          section.dataset.id = `plugin:${group.id}`;
          const heading = document.createElement("h3");
          heading.className = "plugin-template-head";
          heading.textContent = group.name;
          section.append(heading, ...group.templates.map(template => templateRow(template, Boolean(template.builtIn))));
          return section;
        }),
      ]);
      templateNone.hidden = rows.length + pluginCount > 0;
      builtinGroup.hidden = builtins.length === 0;
      builtinGroup.classList.toggle("open", state.builtinOpen);
      builtinHead.setAttribute("aria-expanded", state.builtinOpen ? "true" : "false");
      window.scribeSyncChildren(builtinList, builtins.map((template) => templateRow(template, true, !state.builtinOpen)));
    }
    if (freshTemplateId) {
      flashTemplateRow(freshTemplateId);
    }
    const active = activeTab();
    if (isBlank(active)) {
      newPageView.render(active);
    }
  }

  function templateRow(template, builtin, collapsed = false) {
    const live = () => findTemplateMeta(template.id);
    const el = document.createElement("div");
    el.className = builtin ? "side-row template-row builtin" : "side-row template-row";
    el.role = "button";
    el.tabIndex = collapsed ? -1 : 0;
    el.dataset.id = template.id;
    el.dataset.kind = "template";
    el.ariaLabel = template.title;
    el.addEventListener("click", () => live() && createFromTemplate(live()));
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        live() && createFromTemplate(live());
      }
    });

    const icon = document.createElement("span");
    icon.className = "fileicon";
    icon.innerHTML = builtin ? BUILTIN_SVG : FILE_SVG;
    el.appendChild(icon);

    const text = document.createElement("span");
    text.className = "tab-title";
    const name = document.createElement("span");
    name.className = "template-name";
    name.textContent = template.title;
    const line = document.createElement("span");
    line.className = "template-line";
    line.appendChild(name);
    if (template.builtinUpdate) {
      const update = document.createElement("span");
      update.className = "template-update";
      update.innerHTML = UPDATE_SVG;
      update.ariaLabel = `${UPDATE_TITLE}. ${UPDATE_NOTE}`;
      update.dataset.kind = "template-update";
      update.dataset.id = template.id;
      hoverCard.bind(update, 240);
      line.appendChild(update);
    }
    if (builtin || template.builtinSource) {
      const version = document.createElement("span");
      version.className = "template-version";
      version.textContent = `v${template.stateVersion}`;
      version.dataset.tooltip = template.plugin
        ? (builtin ? "Plugin template version" : "Copied from a plugin template")
        : (builtin ? "Built-in template version" : "Copied from a built-in template");
      line.appendChild(version);
    }
    text.appendChild(line);
    if (template.description) {
      const desc = document.createElement("span");
      desc.className = "template-desc";
      desc.textContent = template.description;
      text.appendChild(desc);
    }
    el.appendChild(text);

    el.addEventListener("contextmenu", (event) => live() && templateMenu(event, live(), el, builtin));
    if (!builtin) {
      const close = document.createElement("button");
      close.className = "tab-close";
      close.type = "button";
      close.textContent = "×";
      close.setAttribute("aria-label", "Delete template");
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        live() && deleteTemplate(live());
      });
      el.appendChild(close);
    }
    hoverCard.bind(el, TEMPLATE_CARD_DELAY);
    return el;
  }

  function templateMenu(event, template, el, builtin) {
    event.preventDefault();
    event.stopPropagation();
    el.classList.add("menu-on");
    library.openMenu({ x: event.clientX, y: event.clientY }, builtin ? [
      { label: template.fields?.length ? "Open…" : "Open", action: () => createFromTemplate(template) },
      template.localId
        ? { label: "Show my copy", action: () => flashTemplateRow(template.localId, true) }
        : { label: "Add to my templates", action: () => copyBuiltinTemplate(template) },
      "sep",
      { label: "Copy template ID", action: () => copyTemplateId(template.id) },
    ] : [
      { label: "Export", action: () => downloadHref(`/api/export/template/${encodeURIComponent(template.id)}`) },
      { label: "Copy template ID", action: () => copyTemplateId(template.id) },
      { label: "Delete", danger: true, action: () => deleteTemplate(template) },
    ]);
    // The shared menu has no close hook; drop the highlight on the next interaction.
    const clear = () => el.classList.remove("menu-on");
    setTimeout(() => {
      document.addEventListener("pointerdown", clear, { once: true, capture: true });
      document.addEventListener("keydown", clear, { once: true, capture: true });
    });
  }

  function toggleBuiltinGroup() {
    state.builtinOpen = !state.builtinOpen;
    try {
      localStorage.setItem(BUILTIN_OPEN_KEY, state.builtinOpen ? "1" : "0");
    } catch {
      /* private mode */
    }
    renderTemplates();
  }

  /** A template row that should flash once it exists (the upsert event and the fetch response race). */
  let freshTemplateId = null;
  /** What the template rows were last drawn from. */
  let templatesDrawn = "";

  function flashTemplateRow(id, scroll = false) {
    const row = templateList.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!row) {
      freshTemplateId = id;
      return;
    }
    freshTemplateId = null;
    row.classList.remove("fresh");
    void row.offsetWidth;
    row.classList.add("fresh");
    if (scroll) {
      row.scrollIntoView({ block: "nearest" });
    }
  }

  async function copyBuiltinTemplate(template) {
    const res = await fetch(`/api/templates/${encodeURIComponent(template.id)}/copy`, { method: "POST" }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok || !data.template) {
      showNotice(data.error || "Could not copy the template");
      return;
    }
    flashTemplateRow(data.template.id, true);
    showNotice(`Added “${data.template.title}” to your templates`);
  }

  async function copyTemplateId(id) {
    try {
      await navigator.clipboard.writeText(id);
      showNotice(`Copied ${id}`);
    } catch {
      showNotice("Could not copy to clipboard");
    }
  }

  function findTemplateMeta(id) {
    return state.templates.find((item) => item.id === id) || state.builtinTemplates.find((item) => item.id === id) || null;
  }

  let releaseTemplateTrap = null;
  function isTemplateModalOpen() {
    return !templateModal.hidden;
  }

  /** mode: create (a new page), edit (the active page's values), or fill (the blank page `into`). */
  function openTemplateModal(template, mode, values, into) {
    templateModal.dataset.templateId = template.id;
    templateModal.dataset.mode = mode;
    if (into) {
      templateModal.dataset.into = into;
    } else {
      delete templateModal.dataset.into;
    }
    templateModalTitle.textContent = template.title;
    const desc = template.description || "";
    templateModalDesc.hidden = !desc;
    templateModalDesc.textContent = desc;
    templateModalError.hidden = true;
    templateModalError.textContent = "";
    templateModalSubmit.textContent = mode === "edit" ? "Apply" : mode === "fill" ? "Create" : "Open";
    templateModalFields.replaceChildren();
    const current = values || {};
    for (const field of template.fields || []) {
      templateModalFields.appendChild(buildTemplateField(field, current[field.key]));
    }
    if (!template.fields?.length) {
      const empty = document.createElement("p");
      empty.className = "settings-hint";
      empty.textContent = "This template has no fields.";
      templateModalFields.appendChild(empty);
    }
    templateModalAgentHidden.checked = mode === "edit" && Boolean(activeTab()?.agentHidden);
    templateModal.hidden = false;
    const first = templateModalFields.querySelector("input, textarea, .select-button");
    first?.focus();
    releaseTemplateTrap?.();
    releaseTemplateTrap = window.scribeFocusTrap?.bind(templateModal.querySelector(".settings-panel"));
  }

  function closeTemplateModal() {
    if (templateModal.hidden) {
      return;
    }
    releaseTemplateTrap?.();
    releaseTemplateTrap = null;
    templateModal.hidden = true;
    delete templateModal.dataset.templateId;
    delete templateModal.dataset.mode;
    delete templateModal.dataset.into;
    templateModalFields.replaceChildren();
  }

  function buildTemplateField(field, value) {
    const wrap = document.createElement("div");
    wrap.className = "template-field";
    const id = "tpl-field-" + field.key;
    if (field.type === "checkbox") {
      const row = document.createElement("label");
      row.className = "template-check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      input.name = field.key;
      input.checked = value === true || value === "true" || (value == null && field.default === true);
      const label = document.createElement("span");
      label.textContent = field.label;
      row.append(input, label);
      wrap.appendChild(row);
    } else {
      const label = document.createElement("label");
      label.htmlFor = id;
      label.textContent = field.label + (field.required ? " *" : "");
      wrap.appendChild(label);
      let input;
      if (field.type === "textarea") {
        input = document.createElement("textarea");
      } else if (field.type === "select") {
        input = document.createElement("select");
        for (const option of field.options || []) {
          const opt = document.createElement("option");
          const item = typeof option === "string" ? { value: option, label: option } : option;
          opt.value = item.value;
          opt.textContent = item.label || item.value;
          input.appendChild(opt);
        }
      } else {
        input = document.createElement("input");
        input.type = field.type === "number" ? "number" : "text";
        if (field.type === "number") {
          if (field.min != null) input.min = String(field.min);
          if (field.max != null) input.max = String(field.max);
        }
      }
      input.id = id;
      input.name = field.key;
      if (field.placeholder) {
        input.placeholder = field.placeholder;
      }
      if (field.required && field.type !== "checkbox") {
        input.required = true;
      }
      const fallback = value == null ? field.default : value;
      if (fallback != null && field.type !== "checkbox") {
        input.value = String(fallback);
      }
      if (field.type === "select") {
        wrap.appendChild(window.createSelect(input));
        label.htmlFor = `${id}-button`;
      } else {
        wrap.appendChild(input);
      }
    }
    if (field.help) {
      const help = document.createElement("p");
      help.className = "help";
      help.textContent = field.help;
      wrap.appendChild(help);
    }
    return wrap;
  }

  function readTemplateForm(template) {
    const values = {};
    for (const field of template.fields || []) {
      const el = templateModalForm.elements.namedItem(field.key);
      if (!el) {
        continue;
      }
      if (field.type === "checkbox") {
        values[field.key] = Boolean(el.checked);
      } else if (field.type === "number") {
        values[field.key] = el.value === "" ? "" : Number(el.value);
      } else {
        values[field.key] = el.value;
      }
    }
    return values;
  }

  async function submitTemplateModal(event) {
    event.preventDefault();
    const id = templateModal.dataset.templateId;
    const mode = templateModal.dataset.mode;
    const template = findTemplateMeta(id);
    if (!template) {
      return;
    }
    templateModalError.hidden = true;
    const values = readTemplateForm(template);
    const agentHidden = templateModalAgentHidden.checked;
    const editing = mode === "edit" ? activeTab() : null;
    if (mode === "edit" && !editing) {
      return;
    }
    if (!editing) {
      const into = mode === "fill" ? templateModal.dataset.into : undefined;
      const error = await openTemplate(template, values, { agentHidden, ...(into ? { into } : {}) });
      if (error) {
        templateModalError.textContent = error;
        templateModalError.hidden = false;
        return;
      }
      closeTemplateModal();
      return;
    }
    try {
      const res = await fetch(`/api/tabs/${encodeURIComponent(editing.id)}/template-values`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        templateModalError.textContent = data.error || "Could not apply template";
        templateModalError.hidden = false;
        return;
      }
      if (Boolean(editing.agentHidden) !== agentHidden) {
        await setAgentHidden(editing.id, agentHidden);
      }
      closeTemplateModal();
    } catch {
      templateModalError.textContent = "Could not apply template";
      templateModalError.hidden = false;
    }
  }

  async function deleteTemplate(template) {
    const ok = await confirmDelete(
      `Delete template “${template.title}”? Pages created from it stay and become ordinary pages.`
    );
    if (!ok) {
      return;
    }
    await fetch(`/api/templates/${encodeURIComponent(template.id)}`, { method: "DELETE" });
  }

  function isPinned(id) {
    return Boolean(state.tabs.find((tab) => tab.id === id)?.pinned);
  }

  function touchFrame(id) {
    const entry = frames.get(id);
    if (!entry) {
      return;
    }
    frames.delete(id);
    frames.set(id, entry);
  }

  function unpinnedLiveCount() {
    let count = 0;
    for (const id of frames.keys()) {
      if (!isPinned(id)) {
        count += 1;
      }
    }
    return count;
  }

  function evictOverflow(keepId) {
    const keep = views.shownIds();
    keep.add(keepId);
    while (unpinnedLiveCount() > LIVE_FRAME_CAP) {
      const victim = [...frames.keys()].find((id) => !keep.has(id) && !isPinned(id));
      if (!victim) {
        break;
      }
      discardFrame(victim);
    }
  }

  function ensureFrame(tab) {
    let entry = frames.get(tab.id);
    if (!entry) {
      const el = document.createElement("iframe");
      el.title = tab.title;
      el.sandbox = SANDBOX;
      el.classList.add("frame-loading");
      el.addEventListener("load", () => {
        el.dataset.audioGeneration = String((Number(el.dataset.audioGeneration) || 0) + 1);
        cancelPageAudio(tab.id);
        el.dataset.loaded = "1";
        el.classList.remove("frame-loading");
      });
      loadFrame(el, tab);
      framesEl.appendChild(el);
      entry = { el, revision: tab.revision };
      frames.set(tab.id, entry);
    } else {
      if (entry.el.title !== tab.title) {
        entry.el.title = tab.title;
      }
      if (entry.revision !== tab.revision && !entry.held) {
        loadFrame(entry.el, tab);
        entry.revision = tab.revision;
      }
      touchFrame(tab.id);
      entry = frames.get(tab.id);
    }
    evictOverflow(tab.id);
    return entry;
  }

  /** Keep the iframe's title and stored revision in sync without reloading (pin, rename, Library move). */
  function syncFrameMeta(tab) {
    const entry = frames.get(tab.id);
    if (!entry) {
      return;
    }
    if (!entry.held) {
      entry.revision = tab.revision;
    }
    if (entry.el.title !== tab.title) {
      entry.el.title = tab.title;
      // The page isn't reloaded for a rename, so tell it (scribe.onTitle).
      entry.el.contentWindow?.postMessage({ type: "scribe-title", id: tab.id, title: tab.title }, "*");
    }
  }

  /**
   * A template change (a built-in reloaded after a merge, an agent's template_upsert) would reload
   * every page made from it. One on screen keeps running instead, so an open dialog or text being
   * typed survives; it loads the new HTML once it is hidden (releaseFrame).
   */
  function holdFrame(id) {
    const entry = frames.get(id);
    if (entry && views.isShown(id)) {
      entry.held = true;
    }
  }

  /** A held frame left the screen: load the revision it skipped. */
  function releaseFrame(id) {
    const entry = frames.get(id);
    if (!entry?.held) {
      return;
    }
    entry.held = false;
    const tab = findAnyTab(id);
    if (tab) {
      refreshFrame(tab);
    }
  }

  function refreshFrame(tab) {
    const entry = frames.get(tab.id);
    if (!entry) {
      return;
    }
    if (entry.revision !== tab.revision && !entry.held) {
      loadFrame(entry.el, tab);
      entry.revision = tab.revision;
    }
    if (entry.el.title !== tab.title) {
      entry.el.title = tab.title;
    }
  }

  /**
   * `allow` only applies to the next navigation, so it has to be set before src. A frame that has
   * loaded already reloads in place: changing src would add a history entry, and Back would then
   * step the frame through old revisions instead of going to the previous tab.
   */
  function loadFrame(el, tab) {
    cancelPageAudio(tab.id);
    delete el.dataset.loaded;
    el.allow = tab.embedUrl ? EMBED_ALLOW : "clipboard-write";
    // Scribe's own pages run the key script; the desktop app catches shortcuts natively in other frames.
    el.toggleAttribute("data-scribe-page", !tab.embedUrl);
    const url = viewUrl(tab);
    if (/^https?:\/\/w-it-[0-9a-f]{12}\.localhost(?::\d+)?\/component\//.test(url)) {
      el.sandbox = "allow-scripts";
      el.dataset.src = url;
      void window.ScribeComponents.attachUrl(el, url).catch(error => showNotice(error.message));
      return;
    }
    el.sandbox = SANDBOX;
    if (el.dataset.src && el.contentWindow) {
      try {
        el.contentWindow.location.replace(url);
        el.dataset.src = url;
        return;
      } catch {
        // Fall back to src below.
      }
    }
    el.dataset.src = url;
    el.src = url;
  }

  function discardFrame(id) {
    cancelPageAudio(id);
    const entry = frames.get(id);
    if (!entry) {
      return;
    }
    entry.el.remove();
    frames.delete(id);
  }

  /** The active tab, plus any pane beside it and a peek over it; views.js decides where each frame sits. */
  function renderFrames() {
    const tab = activeTab();
    emptyEl.hidden = !state.restored || Boolean(tab);
    document.title = tab ? (childId ? tab.title : tab.title + " · Scribe") : chatChild ? "Agent chat" : "Scribe";
    if (popoutTitle) {
      popoutTitle.textContent = chatChild ? "Agent chat" : tab?.title || "";
    }
    views.layout();
    checkPageAudioVisibility();
    // The New page screen stands in for a blank page's frame, in whichever pane the page is.
    const blank = isBlank(tab) ? tab : views.besidePages().find(isBlank) || null;
    const cover = !blank && tab && pageIntent?.origin === tab.id ? tab : null;
    const pane = blank ? views.paneOf(blank.id) : cover ? views.paneOf(cover.id) : "";
    mainEl.classList.toggle("blank-page", Boolean(blank));
    if (pane) newPageEl.dataset.pane = pane;
    else delete newPageEl.dataset.pane;
    if (blank) newPageView.render(blank);
    else if (cover) newPageView.render(cover, true);
    else if (tab) newPageView.replace(tab, frames.get(tab.id)?.el);
    else newPageView.render(null);
    const hinted = !blank && !cover && tab && pageHint?.origin === tab.id;
    pageHintEl.hidden = !hinted;
    const hintPane = hinted ? views.paneOf(tab.id) : "";
    if (hintPane) pageHintEl.dataset.pane = hintPane;
    else delete pageHintEl.dataset.pane;
  }

  function endPageIntent() {
    if (!pageIntent) return;
    clearTimeout(pageIntent.ending);
    pageIntent = null;
    renderFrames();
  }

  /** The floating chat began or stopped writing a new page. */
  function onPageIntent(intent) {
    if (!intent) {
      // The new page usually opens just as its call ends: hold the screen so it can dissolve into that page.
      if (pageIntent && !pageIntent.ending) pageIntent.ending = setTimeout(endPageIntent, PAGE_INTENT_GRACE_MS);
      return;
    }
    if (intent.turnId && intent.turnId === pageIntentDismissed) return;
    if (pageIntent && (pageIntent.itemId === intent.itemId || (intent.turnId && pageIntent.turnId === intent.turnId))) {
      // The same page, now seen as its page_show call: the screen stays over the page it began on.
      clearTimeout(pageIntent.ending);
      pageIntent.ending = 0;
      pageIntent.itemId = intent.itemId;
      pageIntent.title = intent.title || pageIntent.title;
    } else {
      clearTimeout(pageIntent?.ending);
      pageIntent = flagOn(pageIntentToggle) && !childId && state.activeId ? { itemId: intent.itemId, turnId: intent.turnId || null, title: intent.title, origin: state.activeId, ending: 0 } : null;
    }
    renderFrames();
  }

  /** The floating chat's turn looks like it will write a new page, or that guess is over. */
  function onPageHint(hint) {
    pageHint = hint && flagOn(pageIntentToggle) && !childId && state.activeId ? { turnId: hint.turnId, origin: state.activeId } : null;
    renderFrames();
  }

  /** Clear the unread blips of a page that is on screen in a peek or split. */
  function markSeen(id) {
    unread.delete(id);
    unreadLibrary.delete(id);
  }

  function linkMode() {
    const mode = localStorage.getItem(LINK_MODE_KEY);
    return LINK_MODES.some((item) => item.id === mode) ? mode : "tab";
  }

  function renderLinkModes() {
    const current = linkMode();
    linkModeTrack.replaceChildren();
    for (const item of LINK_MODES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.name;
      btn.setAttribute("aria-pressed", String(item.id === current));
      btn.addEventListener("click", () => {
        localStorage.setItem(LINK_MODE_KEY, item.id);
        renderLinkModes();
      });
      linkModeTrack.appendChild(btn);
    }
  }

  /** Keep in sync with src/palettePrefixes.ts. */
  function normalizePrefix(raw, fallback) {
    const value = String(raw ?? "").trim();
    if (!value || value.length > PREFIX_MAX || /\s/.test(value)) {
      return fallback;
    }
    return value;
  }

  function palettePrefixList(storedJson) {
    let parsed = {};
    if (storedJson) {
      try {
        const value = JSON.parse(storedJson);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          parsed = value;
        }
      } catch {
        parsed = {};
      }
    }
    return PALETTE_PREFIXES.map((def) => {
      const raw = parsed[def.id];
      return {
        ...def,
        prefix: normalizePrefix(typeof raw === "string" ? raw : "", def.default),
      };
    });
  }

  function serializePalettePrefixes(prefixes) {
    const out = {};
    for (const item of prefixes) {
      const value = normalizePrefix(item.prefix, item.default);
      if (value !== item.default) {
        out[item.id] = value;
      }
    }
    return JSON.stringify(out);
  }

  function takePalettePrefix(input, prefixes) {
    const text = String(input ?? "").trimStart();
    const ranked = prefixes
      .filter((item) => item.prefix)
      .slice()
      .sort((a, b) => b.prefix.length - a.prefix.length);
    for (const item of ranked) {
      if (!text.startsWith(item.prefix)) {
        continue;
      }
      const next = text[item.prefix.length];
      const word = /[0-9A-Za-z]/.test(item.prefix[item.prefix.length - 1]);
      if (word && (next === undefined || !/\s/.test(next))) {
        continue;
      }
      return { id: item.id, prefix: item.prefix, rest: text.slice(item.prefix.length).trimStart() };
    }
    return null;
  }

  function duplicatePrefixIds(prefixes) {
    const byPrefix = new Map();
    for (const item of prefixes) {
      if (!item.prefix) {
        continue;
      }
      const list = byPrefix.get(item.prefix) || [];
      list.push(item.id);
      byPrefix.set(item.prefix, list);
    }
    const dups = new Set();
    for (const ids of byPrefix.values()) {
      if (ids.length > 1) {
        for (const id of ids) {
          dups.add(id);
        }
      }
    }
    return dups;
  }

  function currentPalettePrefixes() {
    return palettePrefixList(localStorage.getItem(PALETTE_PREFIX_KEY));
  }

  function savePalettePrefixes(prefixes) {
    const json = serializePalettePrefixes(prefixes);
    if (json === "{}") {
      localStorage.removeItem(PALETTE_PREFIX_KEY);
    } else {
      localStorage.setItem(PALETTE_PREFIX_KEY, json);
    }
  }

  function renderPalettePrefixSettings() {
    if (!palettePrefixListEl) {
      return;
    }
    const prefixes = currentPalettePrefixes();
    const dups = duplicatePrefixIds(prefixes);
    palettePrefixListEl.replaceChildren();
    for (const def of prefixes) {
      const row = document.createElement("div");
      row.className = "setting-row";
      const label = document.createElement("span");
      label.id = "palette-prefix-" + def.id + "-label";
      label.textContent = def.label;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "palette-prefix-input" + (dups.has(def.id) ? " dup" : "");
      input.maxLength = PREFIX_MAX;
      input.spellcheck = false;
      input.autocomplete = "off";
      input.value = def.prefix;
      input.setAttribute("aria-labelledby", label.id);
      if (dups.has(def.id)) {
        input.dataset.tooltip = "Same as another prefix; the longer one wins, then list order.";
      }
      const commit = (raw) => {
        const next = currentPalettePrefixes().map((item) =>
          item.id === def.id ? { ...item, prefix: normalizePrefix(raw, item.default) } : item
        );
        savePalettePrefixes(next);
        renderPalettePrefixSettings();
        if (isPaletteOpen()) {
          runPaletteSearch();
        }
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          input.blur();
        }
      });
      input.addEventListener("change", () => commit(input.value));
      input.addEventListener("blur", () => commit(input.value));
      row.append(label, input);
      palettePrefixListEl.appendChild(row);
    }
  }

  /**
   * The shell draws in regions. Server events `invalidate` what they changed and one flush per
   * animation frame draws it, so a burst of events is one draw. `render()` invalidates everything and
   * draws now, for user actions that read the DOM right after.
   */
  const REGIONS = ["frames", "chrome", "tabs", "library", "templates"];
  const dirtyRegions = new Set();
  let flushRaf = 0;
  let flushTimer = 0;
  let flushing = false;

  function invalidate(...regions) {
    for (const region of regions.length ? regions : REGIONS) {
      dirtyRegions.add(region);
    }
    if (!flushRaf) {
      flushRaf = requestAnimationFrame(flush);
      // A hidden window gets no frames, and its pages still have to load (screenshots, agents).
      flushTimer = setTimeout(flush, 200);
    }
  }

  function flush() {
    cancelAnimationFrame(flushRaf);
    clearTimeout(flushTimer);
    flushRaf = 0;
    flushTimer = 0;
    if (flushing || !dirtyRegions.size) {
      return;
    }
    const regions = new Set(dirtyRegions);
    dirtyRegions.clear();
    flushing = true;
    try {
      settlePopouts();
      dropLeftDraft();
      if (regions.has("frames")) renderFrames();
      if (regions.has("chrome")) renderChrome();
      if (regions.has("tabs")) renderTabs();
      if (regions.has("library")) library.render();
      if (regions.has("templates")) renderTemplates();
    } finally {
      flushing = false;
    }
    dispatchEvent(new CustomEvent("scribe:render"));
  }

  function render() {
    invalidate();
    flush();
  }

  function matchesPendingFocus(tab) {
    if (!pendingFocus || !tab) {
      return false;
    }
    return (pendingFocus.id && pendingFocus.id === tab.id) || (pendingFocus.key && pendingFocus.key === tab.key);
  }

  function claimPendingFocus(tab) {
    if (!matchesPendingFocus(tab)) {
      return false;
    }
    pendingFocus = null;
    return true;
  }

  /** Put a page in front: a tab, or the New page when it sits in another pane of a split. */
  function activatePage(id) {
    if (state.draft?.id !== id) {
      selectTab(id, { fromUser: true });
      return;
    }
    if (state.activeId === id) {
      return;
    }
    views.onSelect(id);
    state.activeId = id;
    lastInteractedAt = Date.now();
    syncHash();
    render();
    reportViewer();
  }

  function selectTab(id, { fromUser } = {}) {
    if (childId) {
      if (id !== childId) {
        showInMain(id);
      }
      return;
    }
    if (!state.tabs.some((tab) => tab.id === id)) {
      return;
    }
    if (popout.has(id)) {
      // Its page is in a window of its own: the tab brings that window forward.
      if (fromUser) {
        popout.focus(id);
      }
      return;
    }
    if (fromUser) {
      views.onSelect(id);
    }
    if (state.activeId !== id) {
      state.activeId = id;
      unread.delete(id);
      syncHash();
      render();
    } else {
      unread.delete(id);
    }
    if (fromUser) {
      if (pendingFocus && !matchesPendingFocus({ id, key: state.tabs.find((tab) => tab.id === id)?.key })) {
        pendingFocus = null;
      }
      lastInteractedAt = Date.now();
    }
    reportViewer();
  }

  async function confirmDelete(message, confirmLabel = "Delete") {
    confirmMessage.textContent = message;
    const okBtn = confirmDlg.querySelector('button[value="ok"]');
    if (okBtn) okBtn.textContent = confirmLabel || "Delete";
    confirmDlg.returnValue = "cancel";
    confirmDlg.showModal();
    const cancelBtn = confirmDlg.querySelector('button[value="cancel"]');
    cancelBtn?.focus();
    return new Promise((resolve) => {
      confirmDlg.addEventListener(
        "close",
        () => {
          resolve(confirmDlg.returnValue === "ok");
        },
        { once: true }
      );
    });
  }

  /** Closing keeps the page in the Library; `permanent` deletes it (Ctrl+Z or the notice undoes it). */
  async function closeTab(id, { permanent = false } = {}) {
    if (state.draft?.id === id) {
      closeDraft();
      return;
    }
    const tab = findAnyTab(id);
    if (tab?.key === "scribe:welcome" || tab?.temp || !permanent) {
      await fetch(`/api/tabs/${encodeURIComponent(id)}`, { method: "DELETE" });
      return;
    }
    if (tab?.file) {
      await library.deletePage(id);
      return;
    }
    const res = await fetch(`/api/tabs/${encodeURIComponent(id)}?permanent=true`, { method: "DELETE" });
    if (res.ok) {
      showNotice(`Deleted “${tab?.title || "page"}”`, { undo: true });
    }
  }

  /** Gives a Library page a tab (or focuses it). `before` places it in the strip; null means the end of its group. */
  /** Pages already offered a space switch this session, so the offer comes once. */
  const spaceOffered = new Set();

  /**
   * Opening a page from another space's home folder offers to switch there (#260), when the user
   * turned that on. Only the offer: the page opens here either way.
   */
  function suggestSpace(id) {
    if (!flagOn(spaceSuggestToggle) || spaceOffered.has(id) || state.tabs.some((tab) => tab.id === id)) {
      return;
    }
    const page = findAnyTab(id);
    const folders = new Map(state.folders.map((folder) => [folder.id, folder]));
    const chain = new Set();
    for (let at = page?.folderId ? folders.get(page.folderId) : null; at && !chain.has(at.id); at = at.parentId ? folders.get(at.parentId) : null) {
      chain.add(at.id);
    }
    const active = spaces.activeId();
    const target = spaces.list().find((space) => space.id !== active && space.home && chain.has(space.home));
    if (!target || chain.has(spaces.current()?.home)) {
      return;
    }
    spaceOffered.add(id);
    showNotice(`“${page.title}” is in ${target.name}'s home folder`, {
      action: {
        label: `Switch to ${target.name}`,
        run: async () => {
          await closeTab(id);
          await spaces.switchTo(target.id);
          void openPage(id);
        },
      },
    });
  }

  async function openPage(id, { activate = true, before } = {}) {
    if (childId) {
      showInMain(id);
      return;
    }
    if (activate) {
      suggestSpace(id);
    }
    unreadLibrary.delete(id);
    if (activate) {
      pendingFocus = { id };
    }
    const body = { activate };
    if (before !== undefined) {
      body.before = before;
    }
    const res = await fetch(`/api/tabs/${encodeURIComponent(id)}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok) {
      if (pendingFocus?.id === id) {
        pendingFocus = null;
      }
      return;
    }
    if (activate && pendingFocus?.id === id && state.tabs.some((tab) => tab.id === id)) {
      pendingFocus = null;
      selectTab(id, { fromUser: true });
    }
    renderChrome();
    library.render();
  }

  /** A child window cannot show another page: the main window opens it, and comes forward where it can. */
  function showInMain(id) {
    popout.request({ type: "show", id });
    popout.focusMain();
  }

  function findAnyTab(id) {
    return state.tabs.find((tab) => tab.id === id) || state.closed.find((tab) => tab.id === id) || null;
  }

  function describeForCard(el) {
    if (el.dataset.hint) {
      return { title: el.textContent.trim(), description: el.dataset.hint, note: true };
    }
    if (el.dataset.kind === "template-update") {
      return { title: UPDATE_TITLE, description: UPDATE_NOTE, note: true };
    }
    if (el.dataset.kind === "template") {
      const template = findTemplateMeta(el.dataset.id);
      return template
        ? {
            title: template.title,
            id: template.id,
            description: template.description || "",
            createdAt: template.createdAt,
            updatedAt: template.updatedAt,
          }
        : null;
    }
    const tab = findAnyTab(el.dataset.id);
    if (!tab) {
      return null;
    }
    const madeBy = pageActorView(tab.provenance?.created);
    const changedBy = pageActorView(tab.provenance?.changed);
    return {
      title: tab.title,
      id: tab.key,
      createdAt: tab.createdAt,
      updatedAt: Math.max(tab.updatedAt || 0, tab.stateUpdatedAt || 0),
      folder: tab.folderId ? library.pathOf(tab.folderId) : "",
      ...(madeBy ? { madeBy } : {}),
      ...(changedBy ? { changedBy } : {}),
    };
  }

  function pageActorView(actor) {
    if (!actor) {
      return null;
    }
    if (!actor.thread) {
      return { text: "external agent", at: actor.at };
    }
    const name = window.scribeChat?.threadTitle?.(actor.thread) || actor.title || "thread";
    return { text: `agent · ${name}`, threadId: actor.thread, at: actor.at };
  }

  /** opts.check: { label, checked } adds a checkbox; its state is written back to opts.check.checked. */
  function choose(message, buttons, opts = {}) {
    choiceMessage.textContent = message;
    choiceActions.replaceChildren();
    choiceMessage.parentElement.querySelector(".choice-check")?.remove();
    let box = null;
    if (opts.check) {
      const label = document.createElement("label");
      label.className = "ag-check choice-check";
      box = document.createElement("input");
      box.type = "checkbox";
      box.checked = Boolean(opts.check.checked);
      const text = document.createElement("span");
      text.textContent = opts.check.label;
      label.append(box, text);
      choiceMessage.after(label);
    }
    const cancel = document.createElement("button");
    cancel.type = "submit";
    cancel.value = "cancel";
    cancel.textContent = "Cancel";
    choiceActions.appendChild(cancel);
    for (const item of buttons) {
      const btn = document.createElement("button");
      btn.type = "submit";
      btn.value = item.value;
      btn.textContent = item.label;
      if (item.danger) {
        btn.className = "danger";
      }
      choiceActions.appendChild(btn);
    }
    choiceDlg.returnValue = "cancel";
    choiceDlg.showModal();
    cancel.focus();
    return new Promise((resolve) => {
      choiceDlg.addEventListener(
        "close",
        () => {
          if (box) opts.check.checked = box.checked;
          resolve(choiceDlg.returnValue && choiceDlg.returnValue !== "cancel" ? choiceDlg.returnValue : null);
        },
        { once: true }
      );
    });
  }

  async function setAgentHidden(id, hidden) {
    await fetch(`/api/tabs/${encodeURIComponent(id)}/agent-hidden`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidden }),
    });
  }

  /** The folder new chat threads on this page start in. */
  async function pickPageWorkspace(id) {
    const tab = findAnyTab(id);
    const picked = await window.scribeChat?.pickWorkspace?.(tab?.workspace || "", {
      title: "Page workspace",
      hint: "New threads on this page start in this folder.",
      clear: tab?.workspace ? "No workspace" : null,
    });
    if (picked === null || picked === undefined) {
      return;
    }
    await fetch(`/api/tabs/${encodeURIComponent(id)}/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: picked || null }),
    });
  }

  /** Keep in Library: a temporary page becomes a page like any other (#655). */
  async function keepPage(id) {
    const res = await fetch(`/api/tabs/${encodeURIComponent(id)}/keep`, { method: "POST" }).catch(() => null);
    showNotice(res?.ok ? "Kept in the Library" : "Could not keep the page");
  }

  async function setPinned(id, pin) {
    await fetch(`/api/tabs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, activate: false }),
    });
  }

  /** Copies the key ("scribe:…"), not the id: keys survive export and import, and agents recognize them when pasted. */
  async function copyTabKey(id) {
    const key = findAnyTab(id)?.key;
    if (!key) {
      return;
    }
    try {
      await navigator.clipboard.writeText(key);
      showNotice(`Copied ${key}`);
    } catch {
      showNotice("Could not copy to clipboard");
    }
  }

  async function openWelcome() {
    const html = await fetch("./welcome.html").then((res) => res.text());
    pendingFocus = { key: "scribe:welcome" };
    const res = await fetch("/api/tabs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "scribe:welcome",
        title: "Welcome",
        html,
        activate: true,
      }),
    });
    if (!res.ok) {
      if (pendingFocus?.key === "scribe:welcome") {
        pendingFocus = null;
      }
      return;
    }
    const data = await res.json();
    const id = data?.tab?.id;
    if (id && pendingFocus?.key === "scribe:welcome" && state.tabs.some((tab) => tab.id === id)) {
      pendingFocus = null;
      selectTab(id, { fromUser: true });
    }
  }

  async function downloadHref(href) {
    if(href.startsWith("/api/export")){
      try{
        const url=new URL(href,location.href);url.searchParams.set("preview","1");
        const response=await fetch(url),preview=await response.json();if(!response.ok)throw new Error(preview.error||"Cannot export pages");
        if(preview.plugins?.length){const choices=await window.scribePluginSettings.exportChoices(preview.plugins);if(!choices)return;url.searchParams.delete("preview");url.searchParams.set("plugins",JSON.stringify(choices));href=url.pathname+url.search;}
      }catch(error){showNotice(error.message);return;}
    }
    const link = document.createElement("a");
    link.href = href;
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function downloadActive() {
    const tab = activeTab();
    if (!tab || isBlank(tab)) {
      return;
    }
    downloadHref(`/download/${encodeURIComponent(tab.id)}`);
  }

  function downloadExport(id) {
    if (id) {
      downloadHref(`/api/export/${encodeURIComponent(id)}`);
      return;
    }
    downloadHref("/api/export");
  }

  function importNotice(opened, closed, templates) {
    const parts = [];
    if (opened) {
      parts.push(opened === 1 ? "1 open tab" : `${opened} open tabs`);
    }
    if (closed) {
      parts.push(closed === 1 ? "1 page into the Library" : `${closed} pages into the Library`);
    }
    if (templates) {
      parts.push(templates === 1 ? "1 template" : `${templates} templates`);
    }
    const last = parts.pop();
    return "Imported " + (parts.length ? `${parts.join(", ")} and ${last}` : last);
  }

  /** `action` swaps the Undo button for another one, e.g. { label: "Restore", run }. */
  function showNotice(text, { undo = false, action = null } = {}) {
    noticeText.textContent = text;
    noticeAction = action;
    noticeUndo.textContent = action ? action.label : "Undo";
    noticeUndo.hidden = !undo && !action;
    noticeEl.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(
      () => {
        noticeEl.hidden = true;
      },
      undo || action ? 7000 : 4000
    );
  }

  /** A page nearing its asset storage limit. Once per page per 10 minutes; the page sees it on every save. */
  const assetWarnedAt = new Map();
  function warnPageAssets(msg) {
    const now = Date.now();
    if (!msg.usage || now - (assetWarnedAt.get(msg.id) || 0) < 10 * 60 * 1000) {
      return;
    }
    assetWarnedAt.set(msg.id, now);
    showNotice(`“${msg.title || "Page"}” is nearly out of asset storage: ${msg.usage.warning}.`);
  }

  function showVersionMismatch(version) {
    const banner = document.getElementById("version-banner");
    banner.hidden = version === BOARD_VERSION;
    document.getElementById("version-banner-detail").textContent =
      `Daemon: ${version || "1.9.0 or older"}. This page: ${BOARD_VERSION}.`;
  }

  function showPersistError(error) {
    const message = typeof error === "string" ? error.trim() : "";
    persistBanner.hidden = !message;
    persistBannerDetail.textContent = message;
  }

  async function importScribeFile(file,destination){
    const headers={"Content-Type":"application/octet-stream","X-Filename":encodeURIComponent(file.name||"import")};
    const previewResponse=await fetch(`/api/import?preview=1&destination=${encodeURIComponent(destination)}`,{method:"POST",headers,body:file});
    const preview=await previewResponse.json();if(!previewResponse.ok)throw new Error(preview.error||"Cannot inspect import");
    let pluginsInstalled=0;
    for(const plugin of preview.plugins??[])if(await window.scribePluginSettings.reviewPackage(plugin,plugin.archive,{allowOlder:/\.scribeplugin$/i.test(file.name)}))pluginsInstalled++;
    const response=await fetch(`/api/import?destination=${encodeURIComponent(destination)}`,{method:"POST",headers,body:file});
    const data=await response.json();if(!response.ok)throw new Error(data.error||"Import failed");return {...data,pluginsInstalled};
  }
  async function importFiles(fileList, destination) {
    const files = [...fileList].filter((file) => file && file.size);
    if (!files.length) {
      return;
    }
    let opened = 0;
    let closed = 0;
    let templates = 0;
    let pluginsInstalled=0;
    let focusedId = null;
    let error = null;
    for (const file of files) {
      try {
        const data=await importScribeFile(file,destination);
        pluginsInstalled+=data.pluginsInstalled;
        opened += data.opened || 0;
        closed += data.closed || 0;
        templates += data.templatesCreated || 0;
        if (data.focusedId) {
          focusedId = data.focusedId;
        }
      } catch (err) {
        error = err.message||"Import failed";
      }
    }
    if (focusedId) {
      pendingFocus = { id: focusedId };
      if (state.tabs.some((tab) => tab.id === focusedId)) {
        pendingFocus = null;
        selectTab(focusedId, { fromUser: true });
      }
    }
    if (opened || closed || templates) {
      showNotice(importNotice(opened, closed, templates));
    } else if (error) {
      showNotice(error);
    } else if(pluginsInstalled) {
      showNotice(`Installed ${pluginsInstalled} plugin${pluginsInstalled===1?"":"s"}`);
    }
  }

  function pickImportFile() {
    importFileInput.value = "";
    importFileInput.click();
  }

  function hasFiles(event) {
    const types = event.dataTransfer?.types;
    if (!types) {
      return false;
    }
    return [...types].includes("Files");
  }

  function bindFileDrop(el, destination) {
    el.addEventListener("dragenter", (event) => {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      el.classList.add("file-drop-over");
    });
    el.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    el.addEventListener("dragleave", (event) => {
      if (el.contains(event.relatedTarget)) {
        return;
      }
      el.classList.remove("file-drop-over");
    });
    el.addEventListener("drop", (event) => {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      el.classList.remove("file-drop-over");
      void dropFiles(event, destination);
    });
  }

  // ---------- dropped files and folders (#654) ----------
  // A Scribe export still imports its pages; any other file opens as a file page (a copy, since a
  // browser gives the bytes, not the path), and a folder as a Library folder of them. In the
  // desktop app dropped paths are known, so files and folders open linked to disk instead.
  const DROP_MAX_FILES = 1000;
  const DROP_SKIPPED = new Set(["node_modules", ".git", ".hg", ".svn", "__pycache__", ".venv", "venv"]);

  /** The Library folder under a drop: the folder row, or the folder of the page row. */
  function dropFolderOf(target) {
    const row = target?.closest?.(".lib-row");
    if (!row) return null;
    if (row.dataset.kind === "folder") return row.dataset.id || null;
    return libraryPages().find((page) => page.id === row.dataset.id)?.folderId || null;
  }

  async function uploadDropped(file, folderId, activate) {
    if(/\.(scribeplugin|scribe\.zip)$/i.test(file.name)){const result=await importScribeFile(file,activate?"meta":"closed");return {...result,kind:"export"};}
    const params = new URLSearchParams({ activate: activate ? "1" : "0" });
    if (folderId) params.set("folderId", folderId);
    const res = await fetch(`/api/files/upload?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name || "file") },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Could not open ${file.name}`);
    return data;
  }

  function entryFile(entry) {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
  }

  /** Every entry in a dropped folder (readEntries hands them out in batches). */
  async function entriesOf(dir) {
    const reader = dir.createReader();
    const all = [];
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      all.push(...batch);
    }
    return all.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  }

  /**
   * Disk paths for dropped File objects, in order (null where unknown). Only the desktop app can
   * tell (desktop/src/drops.rs); a browser resolves to all nulls.
   */
  let dropPathsAsked = 0;
  function dropPaths(files) {
    const webview = window.chrome?.webview;
    if (!files.length || typeof webview?.postMessageWithAdditionalObjects !== "function") return Promise.resolve(files.map(() => null));
    const id = String(++dropPathsAsked);
    return new Promise((resolve) => {
      const done = (paths) => {
        webview.removeEventListener("message", onMessage);
        clearTimeout(timer);
        resolve(files.map((_, index) => (typeof paths?.[index] === "string" ? paths[index] : null)));
      };
      const onMessage = (event) => {
        if (event.data?.type === "scribe-drop-paths" && event.data.id === id) done(event.data.paths);
      };
      // An older desktop build does not answer: upload as before.
      const timer = setTimeout(() => done(null), 1500);
      webview.addEventListener("message", onMessage);
      try {
        webview.postMessageWithAdditionalObjects(`scribe-drop-paths:${id}`, files);
      } catch {
        done(null);
      }
    });
  }

  async function dropFiles(event, destination) {
    const items = [...(event.dataTransfer.items || [])].filter((item) => item.kind === "file");
    // Entries must be taken while the drop event lasts; without them, plain files.
    const entries = items.map((item) => item.webkitGetAsEntry?.() || null);
    // Each dropped item's File (a folder's stands for the folder); the desktop app can tell their paths.
    const topFiles = items.map((item) => item.getAsFile());
    const files = [...event.dataTransfer.files];
    const library = destination === "closed";
    const folderId = library ? dropFolderOf(event.target) : null;
    const tally = { files: 0, folders: 0, imported: 0, plugins:0, focusedId: null, error: null, truncated: false };
    const openFile = async (file, parentId, activate, filePath = null) => {
      if (tally.files >= DROP_MAX_FILES) {
        tally.truncated = true;
        return;
      }
      try {
        // A file with a known path opens the file itself; an export still imports.
        const data = (filePath && !/\.(scribeplugin|scribe\.zip)$/i.test(file.name) && (await openOnDisk(filePath, parentId, activate))) || (await uploadDropped(file, parentId, activate));
        if (data.kind === "export") {
          tally.imported += (data.opened || 0) + (data.closed || 0);
          tally.plugins+=data.pluginsInstalled||0;
          if (data.focusedId) tally.focusedId = data.focusedId;
          return;
        }
        tally.files += 1;
        if (activate && data.tab) tally.focusedId = data.tab.id;
      } catch (err) {
        tally.error = err.message;
      }
    };
    const openDir = async (dir, parentId) => {
      const res = await fetch("/api/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: dir.name, parentId }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.folder) {
        tally.error = data.error || `Could not add the folder ${dir.name}`;
        return;
      }
      tally.folders += 1;
      if (!parentId) tally.topFolder = data.folder;
      for (const entry of await entriesOf(dir).catch(() => [])) {
        if (entry.name.startsWith(".") || tally.truncated) continue;
        if (entry.isDirectory) {
          if (!DROP_SKIPPED.has(entry.name.toLowerCase())) await openDir(entry, data.folder.id);
        } else {
          const file = await entryFile(entry).catch(() => null);
          if (file) await openFile(file, data.folder.id, false);
        }
      }
    };
    const openOnDisk = async (filePath, parentId, activate) => {
      const res = await fetch("/api/files/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: filePath, folderId: parentId, activate }) }).catch(() => null);
      const data = res ? await res.json().catch(() => ({})) : {};
      return res?.ok && data.tab ? data : null;
    };
    // A folder with a known path opens as a Library folder linked to it (#707), not as copies.
    const openLinked = async (dirPath, parentId) => {
      const res = await fetch("/api/files/open-folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: dirPath, folderId: parentId }) }).catch(() => null);
      const data = res ? await res.json().catch(() => ({})) : {};
      if (!res?.ok || !data.folder) return false;
      tally.folders += 1;
      tally.files += (data.pages || 0) + (data.reused || 0);
      if (data.truncated) tally.truncated = true;
      return true;
    };
    const withFile = topFiles.filter(Boolean);
    const found = await dropPaths(withFile);
    const pathOf = new Map(withFile.map((file, index) => [file, found[index]]));
    if (entries.length && entries.every(Boolean)) {
      for (const [index, entry] of entries.entries()) {
        const entryPath = (topFiles[index] && pathOf.get(topFiles[index])) || null;
        if (entry.isDirectory) {
          if (entryPath && (await openLinked(entryPath, folderId))) continue;
          await openDir(entry, folderId);
        } else {
          const file = await entryFile(entry).catch(() => null);
          if (file) await openFile(file, folderId, !library, entryPath);
        }
      }
    } else {
      for (const [index, file] of files.entries()) await openFile(file, folderId, !library, (topFiles[index] && pathOf.get(topFiles[index])) || null);
    }
    if (tally.focusedId) focusWhenOpened(tally.focusedId);
    if (tally.folders && !library) {
      if (state.sidebarTab !== "library" || state.trashOpen) setSidebarTab("library");
      if (!state.sideOpen) setSideOpen(true);
    }
    const parts = [];
    if (tally.files) parts.push(tally.files === 1 ? "1 file" : `${tally.files} files`);
    if (tally.folders) parts.push(tally.folders === 1 ? "1 folder" : `${tally.folders} folders`);
    if (tally.imported) parts.push(tally.imported === 1 ? "imported 1 page" : `imported ${tally.imported} pages`);
    if(tally.plugins)parts.push(`installed ${tally.plugins} plugin${tally.plugins===1?"":"s"}`);
    if (tally.error && !parts.length) showNotice(tally.error);
    else if (parts.length > 1 || tally.plugins || tally.folders || tally.truncated || tally.error) showNotice(`Opened ${parts.join(", ")}${tally.truncated ? " (stopped at the file limit)" : ""}${tally.error ? `. ${tally.error}` : ""}`);
  }

  async function undoClose() {
    const res = await fetch("/api/undo", { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showNotice(data.error || "Could not restore the page");
      return;
    }
    noticeEl.hidden = true;
    const data = await res.json();
    if (data?.tab && !data.tab.closedAt) {
      focusWhenOpened(data.tab.id);
    }
  }

  /* ---------- files on disk (#707) ---------- */

  const filesDefaultBtn = document.getElementById("files-default");
  const filesDeleteTrack = document.getElementById("files-delete");
  const DELETE_FILE_MODES = [
    { id: "", name: "Keep the file" },
    { id: "trash", name: "Delete the file too" },
  ];
  const NEW_FILE_NAMES = { md: "Untitled.md", txt: "Untitled.txt" };
  /** Where new files go and what deleting a file page does (the daemon keeps them). */
  let fileSettings = {};

  async function loadFileSettings() {
    const res = await fetch("/api/files/settings").catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    if (data?.settings) fileSettings = data.settings;
    renderFileSettings();
    return fileSettings;
  }

  async function saveFileSettings(patch) {
    const res = await fetch("/api/files/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) {
      showNotice(data.error || "Could not save the setting");
      return false;
    }
    fileSettings = data.settings || {};
    renderFileSettings();
    return true;
  }

  function renderFileSettings() {
    filesDefaultBtn.textContent = fileSettings.defaultLocation || "Choose…";
    filesDeleteTrack.replaceChildren(
      ...DELETE_FILE_MODES.map((item) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = item.name;
        btn.setAttribute("aria-pressed", String((fileSettings.deleteFiles === "trash" ? "trash" : "") === item.id));
        btn.addEventListener("click", () => void saveFileSettings({ deleteFiles: item.id || null }));
        return btn;
      })
    );
  }

  filesDefaultBtn.addEventListener("click", async () => {
    const current = fileSettings.defaultLocation || "";
    const dir = await window.scribeChat?.pickWorkspace?.(current, { title: "New files go to", hint: "", action: "Use folder", used: false, clear: current ? "No default" : undefined });
    if (dir === null || dir === undefined) return;
    await saveFileSettings({ defaultLocation: dir || null });
  });
  void loadFileSettings();

  /** The Library folder of the page that was in front when the New page opened. */
  function draftFolder() {
    return findAnyTab(state.draftFrom)?.folderId || null;
  }

  /** Where a new file in this Library folder lands: its disk location, else the default, else nowhere yet. */
  function newFileTarget(folderId) {
    const folder = folderId ? state.folders.find((item) => item.id === folderId) : null;
    const disk = folder ? window.scribeFiles.diskPath(state.folders, folder.id) : null;
    return { folderId: folder?.id || null, folder: folder?.name || null, disk, location: disk || fileSettings.defaultLocation || null };
  }

  async function postNewFile(body) {
    const res = await fetch("/api/files/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    return { res, data: res ? await res.json().catch(() => ({})) : {} };
  }

  /** Ask for a name and location before creating an empty file page. */
  async function createFile(kind, folderId) {
    const pick = window.scribeChat?.pickWorkspace;
    const target = newFileTarget(folderId);
    const name = NEW_FILE_NAMES[kind] || "Untitled.txt";
    const sep = /\\/.test(target.location || "") ? "\\" : "/";
    let start = target.location ? `${target.location.replace(/[\\/]+$/, "")}${sep}${name}` : name;
    const remember = !target.location ? { label: "Use this folder for new files from now on", checked: true } : undefined;
    let res, data;
    while (true) {
      const picked = await pick?.(start, { files: "save", title: "New file", hint: "", action: "Create", name, remember });
      if (!picked) return;
      ({ res, data } = await postNewFile({ folderId: target.folderId, file: picked, remember: remember?.checked === true }));
      if (res?.status !== 409 || !data.exists) break;
      showNotice(`${picked} already exists. Choose another filename.`);
      start = picked;
    }
    if (!res?.ok || !data.tab) {
      showNotice(data.error || "Could not create the file");
      return;
    }
    if (remember?.checked) void loadFileSettings();
    focusWhenOpened(data.tab.id);
  }

  /** The HTTP reply and the WebSocket upsert race; select now if the tab already arrived, else when it does. */
  function focusWhenOpened(id) {
    if (state.tabs.some((tab) => tab.id === id)) {
      pendingFocus = null;
      selectTab(id, { fromUser: true });
      return;
    }
    pendingFocus = { id };
  }

  function isTypingTarget(el) {
    if (!el || el === document.body) {
      return false;
    }
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      return true;
    }
    return Boolean(el.isContentEditable);
  }

  function isFindKey(event) {
    if (event.key === "/") {
      return true;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      return true;
    }
    return false;
  }

  /** Shortcuts the desktop app catches natively, so they also work while an embedded site has focus. */
  function runShortcut(action) {
    if (action === "reload-frame") {
      // F5 / Ctrl+R in an embedded site (desktop app): reload just that frame.
      const frame = document.activeElement;
      if (frame?.tagName === "IFRAME") {
        frame.src = frame.src;
      }
      return;
    }
    if (document.querySelector("dialog[open]")) {
      return;
    }
    if (childId) {
      // One page and the floating chat: the strip, Library, and palette shortcuts belong to the main window.
      if (action === "close-tab") {
        if (!views.closePeek()) {
          popout.closeSelf();
        }
      } else if (action === "download") {
        downloadActive();
      } else if (action.startsWith("agent-")) {
        window.scribeChat?.shortcut(action.slice("agent-".length));
      }
      return;
    }
    if (action === "settings") { openSettings(); return; }
    if (action === "agent-settings") { window.scribeChat?.openSettings(); return; }
    if (action === "palette") {
      togglePalette();
    } else if (action === "download") {
      downloadActive();
    } else if (action === "help") {
      openWelcome();
    } else if (action === "library") {
      setSideOpen(!state.sideOpen);
    } else if (action === "next-tab" || action === "prev-tab") {
      cycleTab(action === "next-tab" ? 1 : -1);
    } else if (action === "close-tab") {
      if (views.closePeek()) {
        return;
      }
      const tab = activeTab();
      if (tab) {
        closeTab(tab.id);
      }
    } else if (action === "reopen") {
      undoClose();
    } else if (action === "new-page") {
      void newPage();
    } else if (action === "spaces") {
      spaces.toggle();
    } else if (action === "next-space" || action === "prev-space") {
      void spaces.cycle(action === "next-space" ? 1 : -1);
    } else if (action.startsWith("agent-")) {
      window.scribeChat?.shortcut(action.slice("agent-".length));
    }
  }

  function cycleTab(step) {
    // Pages in their own windows are skipped: their tabs only bring those windows forward.
    const ring = state.tabs.filter((tab) => !popout.has(tab.id));
    const count = ring.length;
    if (count === 0) {
      return;
    }
    const at = ring.findIndex((tab) => tab.id === state.activeId);
    const next = at < 0 ? ring[step > 0 ? 0 : count - 1] : ring[(at + step + count) % count];
    selectTab(next.id, { fromUser: true });
  }

  /**
   * Escape closes one thing: the innermost open layer. It runs in the bubble phase so a
   * control that handles Escape itself (dictation, a menu, the @ picker, a rename, the
   * image preview) goes first and marks the key handled.
   */
  function onBoardEscape(event) {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) {
      return;
    }
    if (document.querySelector("dialog[open]")) {
      return;
    }
    if (childId) {
      if (window.scribeChat?.escape() || library.onEscape() || views.escape()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (spaces.onKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (window.scribeChat?.escape()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // The harness panel covers the board, so its own listener closes it rather than
    // the library, a peek or the sidebar underneath.
    if (window.scribeHarness?.isOpen() && !isSettingsOpen() && !isTemplateModalOpen()) {
      return;
    }
    if (library.onEscape()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (drag) {
      event.preventDefault();
      abortDrag();
      return;
    }
    if (isTemplateModalOpen()) {
      event.preventDefault();
      closeTemplateModal();
      return;
    }
    if (isSettingsOpen()) {
      event.preventDefault();
      closeSettings();
      return;
    }
    if (isPaletteOpen()) {
      event.preventDefault();
      closePalette();
      return;
    }
    if (views.escape()) {
      event.preventDefault();
      return;
    }
    if (state.sideOpen && state.trashOpen) {
      event.preventDefault();
      closeTrash();
      return;
    }
    if (state.sideOpen && library.searchFocused()) {
      event.preventDefault();
      library.clearSearch();
      return;
    }
    if (state.sideOpen) {
      event.preventDefault();
      setSideOpen(false);
    }
  }

  function onBoardShortcut(event) {
    // Escape is handled in the bubble phase (onBoardEscape).
    if (event.key === "Escape") {
      return;
    }
    // Ordinary typing has no board action. Only scan for dialogs when a shortcut
    // could run; the spaces overview also handles unmodified navigation keys.
    if (!event.ctrlKey && !event.metaKey && !isFindKey(event) && !spaces.isOpen()) {
      return;
    }
    if (document.querySelector("dialog[open]")) {
      return;
    }
    if (childId) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        downloadActive();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && ((event.altKey && event.key.toLowerCase() === "s") || (!event.altKey && (event.code === "Comma" || event.key === "," || event.key === "<")))) {
      event.preventDefault();
      runShortcut(event.shiftKey ? "agent-settings" : "settings");
      return;
    }
    if (spaces.onKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (spaces.isOpen()) {
      // The board is out of sight: its own shortcuts wait until the overview closes.
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const spaceAction =
        event.key.toLowerCase() === "e" && !event.shiftKey
          ? "spaces"
          : event.shiftKey && event.key === "PageUp"
            ? "prev-space"
            : event.shiftKey && event.key === "PageDown"
              ? "next-space"
              : "";
      if (spaceAction) {
        event.preventDefault();
        runShortcut(spaceAction);
        return;
      }
    }
    if (isFindKey(event) && libraryShown() && !isTypingTarget(event.target)) {
      event.preventDefault();
      library.focusSearch();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "b" && !event.shiftKey) {
      event.preventDefault();
      runShortcut("library");
      return;
    }
    if (key === "d" && !event.shiftKey) {
      event.preventDefault();
      togglePalette();
      return;
    }
    if (key === "s" && !event.shiftKey) {
      event.preventDefault();
      downloadActive();
      return;
    }
    if (key === "h" && !event.shiftKey) {
      event.preventDefault();
      openWelcome();
      return;
    }
    if ((key === "t" || key === "n") && !event.shiftKey) {
      event.preventDefault();
      runShortcut("new-page");
      return;
    }
    if (key === "z" && !event.shiftKey && !isTypingTarget(event.target)) {
      event.preventDefault();
      undoClose();
    }
  }

  function onTabsWheel(event) {
    if (drag?.moved) {
      return;
    }
    if (event.deltaY === 0 && event.deltaX === 0) {
      return;
    }
    event.preventDefault();
    const smooth = smoothTabScroll();
    const from = tabScrollTarget == null ? tabsEl.scrollLeft : tabScrollTarget;
    scrollTabsTo(from + event.deltaY + event.deltaX, smooth);
    if (!smooth) {
      updateTabFade();
    }
  }

  function frameByWindow(win) {
    const id = frameIdByWindow(win);
    return id ? frames.get(id) : null;
  }

  function frameIdByWindow(win) {
    for (const [id, entry] of frames) {
      if (entry.el.contentWindow === win) {
        return id;
      }
    }
    return null;
  }

  /**
   * Whether a click or key press just went to this page's frame. A page's activation also activates
   * the board, so a script cannot fake it; and the frame must have focus, so a click in one page does
   * not count for another page that asks at the same moment.
   */
  function frameActivated(frameId) {
    const active = !navigator.userActivation || navigator.userActivation.isActive;
    return active && Boolean(frameId) && document.activeElement === frames.get(frameId)?.el;
  }

  /**
   * scribe.agent from a page: threads of that page only, as found from the frame that asked (not from
   * anything the page says). Whether the click or key press reached the board is checked here: a
   * page's own activation also activates the board, so a script cannot fake it. agent.js decides
   * what the page may do with or without one (scribePermissions).
   */
  function onPageAgent(event) {
    const data = event.data;
    const reply = (result) => {
      event.source?.postMessage({ type: "scribe-open-result", id: data.id, reqId: data.reqId, result }, "*");
    };
    const frameId = frameIdByWindow(event.source);
    const tab = frameId ? findAnyTab(frameId) : null;
    if (!tab || tab.embedUrl) {
      reply({ ok: false, error: "not_a_page" });
      return;
    }
    const chat = window.scribeChat;
    if (!chat?.pageRequest) {
      reply({ ok: false, error: "no_agent" });
      return;
    }
    const activated = frameActivated(frameId);
    const frame = frames.get(frameId);
    if (data.op === "pickModel" && frame) {
      // The page measured its element in its own frame; the picker opens in this window.
      const box = frame.el.getBoundingClientRect();
      const scale = frame.el.offsetWidth ? box.width / frame.el.offsetWidth : 1;
      const r = data.rect || {};
      data.rect = { left: box.left + (Number(r.left) || 0) * scale, top: box.top + (Number(r.top) || 0) * scale, width: (Number(r.width) || 0) * scale, height: (Number(r.height) || 0) * scale };
    }
    chat.pageRequest(tab, data, { activated }).then(reply, (err) => reply({ ok: false, error: String(err?.message || err) }));
  }

  /**
   * scribe.reply from a page (#320): sends the form's answers to the page its agent wired it to
   * (replyTo), e.g. a comment on a Kanban card that goes on to the card's chat. Only after the
   * user's click reached the page's frame, and only to that target: the daemon looks it up.
   */
  function onPageReply(event) {
    const data = event.data;
    const reply = (result) => {
      event.source?.postMessage({ type: "scribe-open-result", id: data.id, reqId: data.reqId, result }, "*");
    };
    const frameId = frameIdByWindow(event.source);
    const tab = frameId ? findAnyTab(frameId) : null;
    if (!tab || tab.embedUrl) {
      reply({ ok: false, error: "not_a_page" });
      return;
    }
    if (!frameActivated(frameId)) {
      reply({ ok: false, error: "no_gesture" });
      return;
    }
    fetch(`/api/tabs/${encodeURIComponent(tab.id)}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: data.data, summary: data.summary }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          reply({ ok: false, error: String(body.error || `HTTP ${res.status}`) });
          return;
        }
        const num = Number(body.result?.num);
        showNotice(`Reply sent to ${body.target?.title || "its page"}${num ? ` #${num}` : ""}`);
        reply({ ok: true, target: body.target, delivered: body.delivered || null });
      })
      .catch((err) => reply({ ok: false, error: String(err?.message || err) }));
  }

  /**
   * scribe.file from a file page (#654): the file on that page's tab, as found from the frame that
   * asked. Saving needs the user's click or key press in the page; Save as asks where.
   */
  /** A file page's view settings by path (a PDF's zoom, #685), kept past the tab; the newest 200 files. */
  function fileView(path, value) {
    const key = String(path || "").replace(/\\/g, "/").toLowerCase();
    let views = {};
    try {
      views = JSON.parse(localStorage.getItem(FILE_VIEWS_KEY) || "{}") || {};
    } catch {
      views = {};
    }
    if (value === undefined) {
      return views[key]?.view ?? null;
    }
    delete views[key];
    if (value !== null) {
      views[key] = { view: value, at: Date.now() };
    }
    const kept = Object.entries(views).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0)).slice(0, 200);
    try {
      localStorage.setItem(FILE_VIEWS_KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch {
      /* browser storage disabled */
    }
    return value;
  }

  const browserPageWatches = new Map();
  async function onPageBrowser(event) {
    const data = event.data;
    const source = event.source;
    const frameId = frameIdByWindow(source);
    const tab = frameId ? findAnyTab(frameId) : null;
    const reply = result => source?.postMessage({ type: "scribe-open-result", id: data.id, reqId: data.reqId, result }, "*");
    if (!tab?.browser) { reply({ ok: false, error: "not_a_browser_page" }); return; }
    const threadId = tab.browser.threadId;
    const base = `/api/agent/threads/${encodeURIComponent(threadId)}/browser`;
    if (data.op === "info") { reply({ ok: true, threadId, key: tab.key, title: tab.title }); return; }
    const watchKey = `${frameId}:${data.watchId}`;
    if (data.op === "stop") { browserPageWatches.get(watchKey)?.(); reply({ ok: true }); return; }
    if (data.op === "watch") {
      browserPageWatches.get(watchKey)?.();
      const frame = [...document.querySelectorAll("iframe")].find(f => f.contentWindow === source);
      if (!frame) { reply({ ok: false, error: "frame_gone" }); return; }
      const stream = new EventSource(`${base}/live`);
      const stop = () => {
        stream.close(); clearInterval(check);
        browserPageWatches.delete(watchKey);
      };
      // A removed frame sends no pagehide: notice it on the next event, or within a few seconds on a still page.
      const check = setInterval(() => { if (!frame.isConnected) stop(); }, 5000);
      browserPageWatches.set(watchKey, stop);
      for (const type of ["frame", "view"]) stream.addEventListener(type, e => {
        if (!frame.isConnected) { stop(); return; }
        try {
          const payload = JSON.parse(e.data);
          source.postMessage({ type: "scribe-browser-event", id: tab.id, watchId: data.watchId, event: type === "frame" ? { type, ...payload } : { type, view: payload } }, "*");
        } catch { /* ignore a disconnected frame */ }
      });
      reply({ ok: true }); return;
    }
    if (!["input", "navigate", "tabs", "control", "fit", "close"].includes(data.op)) { reply({ ok: false, error: "unknown_browser_op" }); return; }
    try {
      const res = await fetch(`${base}/${data.op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data.options || {}) });
      const result = await res.json().catch(() => ({}));
      reply(res.ok ? { ...result, ok: true } : { ...result, ok: false, status: res.status, error: String(result.error || `HTTP ${res.status}`) });
    } catch (err) { reply({ ok: false, error: String(err.message || err) }); }
  }

  async function onPageFile(event) {
    const data = event.data;
    const source = event.source;
    const reply = (result, transfer) => {
      source?.postMessage({ type: "scribe-open-result", id: data.id, reqId: data.reqId, result }, "*", transfer || []);
    };
    const frameId = frameIdByWindow(source);
    const tab = frameId ? findAnyTab(frameId) : null;
    if (!tab?.file) {
      reply({ ok: false, error: "not_a_file_page" });
      return;
    }
    const url = `/api/tabs/${encodeURIComponent(tab.id)}/file`;
    const call = async (method, path, body) => {
      const res = await fetch(path, body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      return res.ok ? { ok: true, file: json } : { ok: false, status: res.status, ...json, error: String(json.error || `HTTP ${res.status}`) };
    };
    try {
      if (data.op === "view") {
        reply({ ok: true, view: fileView(tab.file.path, data.view) });
      } else if (data.op === "openLocation") {
        if (!frameActivated(frameId)) {
          reply({ ok: false, error: "no_gesture" });
          return;
        }
        reply(await call("POST", `${url}/open-location`, {}));
      } else if (data.op === "read") {
        reply(await call("GET", url));
      } else if (data.op === "image" || data.op === "asset") {
        const res = await fetch(data.op === "image" ? `${url}/raw` : `${url}/asset?src=${encodeURIComponent(String(data.src ?? ""))}`);
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          reply({ ok: false, error: String(json.error || `HTTP ${res.status}`) });
          return;
        }
        const buffer = await res.arrayBuffer();
        reply({ ok: true, buffer, type: res.headers.get("Content-Type") || "" }, [buffer]);
      } else if (data.op === "save" || data.op === "saveAs") {
        if (!frameActivated(frameId)) {
          reply({ ok: false, error: "no_gesture" });
          return;
        }
        const body = { text: String(data.text ?? ""), eol: data.eol === "\r\n" ? "\r\n" : "\n", bom: data.bom === true };
        if (data.op === "save") {
          reply(await call("PUT", url, { ...body, mtime: data.mtime, force: data.force === true }));
          return;
        }
        const target = await window.scribeChat?.pickWorkspace?.(tab.file.path, { files: "save", title: "Save as", hint: "", action: "Save", name: tab.title });
        if (!target) {
          reply({ ok: false, error: "cancelled" });
          return;
        }
        let result = await call("POST", `${url}/save-as`, { ...body, path: target });
        if (!result.ok && result.exists) {
          if (!(await confirmDelete(`${target} already exists. Replace it?`, "Replace"))) {
            reply({ ok: false, error: "cancelled" });
            return;
          }
          result = await call("POST", `${url}/save-as`, { ...body, path: target, overwrite: true });
        }
        if (result.ok) showNotice(`Saved as ${result.file.name}`);
        reply(result);
      } else {
        reply({ ok: false, error: "unknown_op" });
      }
    } catch (err) {
      reply({ ok: false, error: String(err?.message || err) });
    }
  }

  /** scribe.permissions from a page: read its own, or ask the user for one (after a click). */
  function onPagePermissions(event) {
    const data = event.data;
    const reply = (result) => {
      event.source?.postMessage({ type: "scribe-open-result", id: data.id, reqId: data.reqId, result }, "*");
    };
    const frameId = frameIdByWindow(event.source);
    const tab = frameId ? findAnyTab(frameId) : null;
    const perms = window.scribePermissions;
    if (!tab || tab.embedUrl || !perms) {
      reply({ ok: false, error: "not_a_page" });
      return;
    }
    if (data.op === "query") {
      perms.query(tab).then(reply);
      return;
    }
    if (data.op !== "request") {
      reply({ ok: false, error: "unknown_op" });
      return;
    }
    if (!frameActivated(frameId)) {
      reply({ ok: false, error: "no_gesture" });
      return;
    }
    const need = { perm: String(data.perm || "") };
    if (typeof data.folder === "string" && data.folder) need.folder = data.folder;
    if (typeof data.approval === "string" && data.approval) need.approval = data.approval;
    perms.ensure(tab, need, { explicit: true }).then(
      (result) => reply(result.ok ? { ok: true, granted: true } : { ok: true, granted: false }),
      (err) => reply({ ok: false, error: String(err?.message || err) })
    );
  }

  /**
   * scribe.ml from a page: questions for the classifier about the page's own text. The daemon checks
   * the page's ml.decide permission and its limits; the page is the one whose frame asked. Nothing
   * here asks the user: a page asks for the permission with scribe.permissions.request.
   */
  function onPageMl(event) {
    const data = event.data;
    const reply = (result) => {
      event.source?.postMessage({ type: "scribe-open-result", id: data.id, reqId: data.reqId, result }, "*");
    };
    const failed = (message) => reply({ ok: false, error: "unavailable", message });
    const frameId = frameIdByWindow(event.source);
    const tab = frameId ? findAnyTab(frameId) : null;
    if (!tab || tab.embedUrl) {
      reply({ ok: false, error: "not_a_page", message: "Only a Scribe page can ask the classifier" });
      return;
    }
    const base = `/api/ml/pages/${encodeURIComponent(tab.id)}`;
    let request;
    if (data.op === "capabilities") {
      request = fetch(`${base}/capabilities`);
    } else if (data.op === "decide") {
      request = fetch(`${base}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: data.state, questions: data.questions, timeoutMs: data.timeoutMs }),
      });
    } else {
      reply({ ok: false, error: "unknown_op", message: "Unknown scribe.ml call" });
      return;
    }
    request
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (res.ok && body && typeof body.ok === "boolean") reply(body);
        // A daemon from before scribe.ml answers 404: restart Scribe to get it.
        else failed(String(body?.error || `HTTP ${res.status}`));
      })
      .catch((err) => failed(String(err?.message || err)));
  }

  const pluginSubscriptions = new Map();
  async function onPagePlugin(event) {
    const data = event.data, frameId = frameIdByWindow(event.source), tab = frameId ? findAnyTab(frameId) : null;
    const activated=frameId?frameActivated(frameId):false;
    const reply = result => event.source?.postMessage({type:"scribe-open-result",id:data.id,reqId:data.reqId,result},event.origin);
    if (!tab || tab.embedUrl || !/^[a-z][a-z0-9-]{0,63}$/.test(data.plugin)) return reply({ok:false,error:"not_a_page"});
    try {
      const result = await window.scribePermissions.ensure(tab,{perm:`plugin.${data.plugin}`});
      if (!result.ok) return reply(result);
      if (data.op === "allow") return reply(result);
      if (data.op === "subscribe") {
        if (!pluginSubscriptions.has(frameId)) pluginSubscriptions.set(frameId,new Set());
        pluginSubscriptions.get(frameId).add(data.plugin);
        return reply({ok:true});
      }
      if (data.op === "repository" && data.plugin === "git-history") {
        if (!activated) return reply({ok:false,error:"no_gesture"});
        const resolvedResponse=await fetch(`/api/plugins/git-history/repositories/resolve?path=${encodeURIComponent(String(data.repository))}`),resolved=await resolvedResponse.json();
        if(!resolvedResponse.ok)return reply({ok:false,error:resolved.error});
        const accepted=await confirmDelete(`Allow “${tab.title}” to read Git history from ${resolved.repository}?`,"Allow");
        if (!accepted) return reply({ok:false,error:"denied"});
        const res=await fetch("/api/plugins/git-history/repositories",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({repository:resolved.repository})});
        return reply(await res.json());
      }
      reply({ok:false,error:"unknown_op"});
    } catch(error) {reply({ok:false,error:String(error.message||error)});}
  }
  async function forwardPluginEvent(message) {
    if (message.registry) window.ScribeComponents?.pluginChanged(message);
    for (const [id,subscriptions] of pluginSubscriptions) {
      const frame=frames.get(id);
      if (!frame) {pluginSubscriptions.delete(id);continue;}
      if (!subscriptions.has(message.plugin)) continue;
      try {
        const response=await fetch(`/api/tabs/${encodeURIComponent(id)}/permissions/check`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({perm:`plugin.${message.plugin}`})});
        if ((await response.json()).result !== "allow") continue;
        const data=message.name === "state" ? {key:message.data?.key,revision:message.data?.revision} : message.data;
        frame.el.contentWindow?.postMessage({type:"scribe-plugin-event",plugin:message.plugin,name:message.name,data},pageOrigin(id));
      }catch{}
    }
  }

  const pageAudioSessions = new Map();
  let pageAudioActive = null;
  const audioStop = document.createElement("button");
  audioStop.type = "button"; audioStop.className = "page-audio-stop";
  audioStop.textContent = "Stop recording"; audioStop.hidden = true;
  audioStop.addEventListener("click", () => {
    if (pageAudioActive?.capture) pageAudioActive.capture.stop("user");
    else if (pageAudioActive) cancelPageAudio(pageAudioActive.tabId, "user");
  });
  document.querySelector("header.chrome")?.append(audioStop);
  function pageAudioVisible(id) { return !document.hidden && views.shownIds().has(id) && !!frames.get(id)?.el.isConnected; }
  function paintPageAudio() {
    audioStop.hidden = !pageAudioActive;
    document.documentElement?.classList.toggle("page-audio-recording", !!pageAudioActive);
    for (const el of tabsEl.querySelectorAll(".tab")) {
      let marker = el.querySelector(".tab-recording");
      if (el.dataset.id === pageAudioActive?.tabId) {
        if (!marker) { marker = document.createElement("span"); marker.className = "tab-recording";
          marker.textContent = "●"; marker.setAttribute("aria-label", "Recording"); el.prepend(marker); }
      } else marker?.remove();
    }
  }
  function endPageAudioStream(session, reason) {
    if (session.mode !== "stream" || session.endReason) return;
    session.endReason = reason;
    session.port?.postMessage({ end: reason });
    session.port?.close(); session.port = null;
  }
  function cancelPageAudio(id, reason = "stopped") {
    const session = pageAudioSessions.get(id);
    if (!session) return;
    endPageAudioStream(session, reason);
    session.pagePort?.close(); session.pagePort = null;
    session.cancelled = true; session.controller.abort(); session.capture?.cancel(reason);
    window.scribeAudio?.cancel(session.owner);
    pageAudioSessions.delete(id);
    if (pageAudioActive === session) pageAudioActive = null;
    paintPageAudio();
  }
  function checkPageAudioVisibility() {
    for (const [id] of pageAudioSessions) if (!pageAudioVisible(id)) cancelPageAudio(id, "hidden");
  }
  document.addEventListener("visibilitychange", checkPageAudioVisibility);
  setInterval(checkPageAudioVisibility, 100);
  async function onPageAudio(event) {
    const deadline = Date.now() + 110000;
    const data = event.data, id = frameIdByWindow(event.source), tab = id ? findAnyTab(id) : null;
    const reply = result => {
      const transfer = result?.buffer instanceof ArrayBuffer ? [result.buffer] : [];
      if (result?.port) transfer.push(result.port);
      event.source?.postMessage({ type: "scribe-open-result", id: data.id, reqId: data.reqId, result }, event.origin, transfer);
    };
    const api = window.scribeAudio;
    try {
      if (!tab || tab.embedUrl || !api) return reply({ ok: false, error: "not_a_page" });
      const opts = { language: typeof data.language === "string" ? data.language.slice(0, 20) : undefined,
        prompt: typeof data.prompt === "string" ? data.prompt.slice(0, 2000) : undefined, tabId: id };
      if (data.op === "available") { await api.refresh(); return reply(api.available()); }
      if (data.op === "stop" || data.op === "cancel") {
        const session = pageAudioSessions.get(id);
        if (!session || session.id !== data.sessionId || session.source !== event.source) return reply({ ok: false, error: "cancelled" });
        if (data.op === "cancel") { cancelPageAudio(id); return reply({ ok: true }); }
        session.capture?.stop();
        const result = await session.ended;
        if (session.cancelled) return reply({ ok: false, error: "cancelled" });
        if (result.ok && result.blob) return reply({ ok: true, buffer: await result.blob.arrayBuffer(), mimeType: result.blob.type, durationMs: result.durationMs });
        return reply(result);
      }
      if (!["listen", "record", "stream", "transcribe"].includes(data.op)) return reply({ ok: false, error: "unknown_op" });
      if (data.op !== "transcribe" && !frameActivated(id)) return reply({ ok: false, error: "no_gesture" });
      if (data.op !== "transcribe" && !pageAudioVisible(id)) return reply({ ok: false, error: "hidden" });
      const entry = frames.get(id), revision = entry.revision, generation = entry.el.dataset?.audioGeneration;
      const need = data.op === "listen" ? [{ perm: "audio.microphone" }, { perm: "audio.transcribe" }]
        : { perm: data.op === "stream" ? "audio.microphoneStream" : data.op === "record" ? "audio.microphone" : "audio.transcribe" };
      // Uploaded clips can run without a gesture once granted; prompting still needs a click.
      if (data.op === "transcribe" && !frameActivated(id)) {
        const grants = await window.scribePermissions.query(tab);
        if (grants.permissions?.find(p => p.id === "audio.transcribe")?.value !== "allow")
          return reply({ ok: false, error: "denied", permission: "audio.transcribe" });
      }
      const permission = await window.scribePermissions.ensure(tab, need);
      if (!permission.ok) return reply(permission);
      if (frames.get(id) !== entry || entry.revision !== revision || entry.el.dataset?.audioGeneration !== generation) return reply({ ok: false, error: "cancelled" });
      if (data.op === "transcribe") {
        if (!(data.buffer instanceof ArrayBuffer) || data.buffer.byteLength > 25 * 1024 * 1024) return reply({ ok: false, error: "too_large" });
        return reply(await api.transcribe(new Blob([data.buffer], { type: data.mimeType }), opts));
      }
      if (!pageAudioVisible(id)) return reply({ ok: false, error: "hidden" });
      if (pageAudioActive) return reply({ ok: false, error: "busy" });
      if (!api.available().mic) return reply({ ok: false, error: "no_mic" });
      if (data.op === "listen") { await api.refresh(); if (!api.available().stt) return reply({ ok: false, error: "no_source" }); }
      if (frames.get(id) !== entry || entry.revision !== revision || entry.el.dataset?.audioGeneration !== generation) return reply({ ok: false, error: "cancelled" });
      if (Date.now() > deadline) return reply({ ok: false, error: "timeout" });
      if (!pageAudioVisible(id)) return reply({ ok: false, error: "hidden" });
      if (pageAudioActive) return reply({ ok: false, error: "busy" });
      cancelPageAudio(id);
      const session = { id: crypto.randomUUID(), tabId: id, mode: data.op, owner: { kind: "page", tabId: id }, source: event.source,
        controller: new AbortController(), cancelled: false, capture: null, ended: null };
      pageAudioSessions.set(id, session); pageAudioActive = session; paintPageAudio();
      const emit = payload => { if (!session.cancelled) event.source?.postMessage({ type: "scribe-audio-event", sessionId: session.id, ...payload }, event.origin); };
      // Listen streams like dictation when the source's live transcription is on (#841); live: false opts out.
      const streaming = data.op === "listen" && data.live !== false && Boolean(api.settings()?.streaming);
      const maxMs = Number.isFinite(data.maxMs) ? Math.min(300000, Math.max(1, data.maxMs)) : 300000;
      try {
        if (data.op === "stream") {
          const channel = new MessageChannel(); session.port = channel.port1; session.pagePort = channel.port2;
        }
        const pendingTimer = setTimeout(() => {
          if (pageAudioSessions.get(id) === session) cancelPageAudio(id);
        }, Math.max(1, deadline - Date.now()));
        try {
          session.capture = streaming ? await api.stream({ ...opts, owner: session.owner, preview: true, maxMs,
            onText: text => emit({ text }), onLevel: level => emit({ level }), onState: state => emit({ state }) })
            : await api.capture({ owner: session.owner,
            live: data.op === "stream", onFrame: buffer => session.port?.postMessage({ frame: buffer }, [buffer]), maxMs,
            onLevel: level => emit({ level }), onState: state => emit({ state }) });
        } finally { clearTimeout(pendingTimer); }
        if (session.cancelled || !pageAudioVisible(id)) {
          session.capture.cancel();
          if (pageAudioSessions.get(id) === session) cancelPageAudio(id);
          return reply({ ok: false, error: "cancelled" });
        }
        const started = Date.now(); let durationMs;
        if (data.op === "stream") {
          session.ended = session.capture.ended.then(reason => {
            endPageAudioStream(session, reason);
            if (pageAudioActive === session) pageAudioActive = null;
            paintPageAudio();
            return { ok: true, reason: session.endReason };
          });
          reply({ ok: true, sessionId: session.id, sampleRate: session.capture.sampleRate, port: session.pagePort });
          session.pagePort = null;
          return;
        }
        session.ended = session.capture.ended.then(async blob => {
          durationMs = Date.now() - started;
          if (pageAudioActive === session) pageAudioActive = null; paintPageAudio();
          if (session.cancelled) return { ok: false, error: "cancelled" };
          if (streaming) return blob; // already the transcript: { ok, text } or a failure
          if (data.op === "record") return { ok: true, blob, durationMs };
          emit({ state: "transcribing" });
          return api.transcribe(blob, { ...opts, signal: session.controller.signal });
        }).catch(() => ({ ok: false, error: "cancelled" })).then(result => {
          if (pageAudioActive === session) pageAudioActive = null; paintPageAudio();
          emit({ state: result.ok ? "stopped" : "cancelled" }); return result;
        });
        reply({ ok: true, sessionId: session.id, ...(streaming ? { live: true } : {}) });
      } catch (err) {
        const cancelled = session.cancelled;
        session.pagePort?.close();
        if (pageAudioSessions.get(id) === session) cancelPageAudio(id);
        reply({ ok: false, error: cancelled ? "cancelled" : err.audioError || "no_mic", message: err.message,
          ...(err.audioError === "denied" ? { permission: data.op === "stream" ? "audio.microphoneStream" : "audio.microphone" } : {}) });
      }
    } catch { reply({ ok: false, error: "unavailable" }); }
  }

  /**
   * scribe.preview from a page: the page sends the files' bytes, shown here in the shared viewer.
   * Like scribe.agent, it needs the click or key press to have reached the board.
   */
  /** The page's right-click menu: the frame sends where, and what text or link is under it. */
  function onPageContextMenu(event) {
    const id = frameIdByWindow(event.source);
    const frame = id ? frames.get(id) : null;
    const tab = id ? findAnyTab(id) : null;
    if (!frame || !tab) {
      return;
    }
    const data = event.data;
    const box = frame.el.getBoundingClientRect();
    const scale = frame.el.offsetWidth ? box.width / frame.el.offsetWidth : 1;
    const point = { x: box.left + (Number(data.x) || 0) * scale, y: box.top + (Number(data.y) || 0) * scale };
    const selection = typeof data.selection === "string" ? data.selection : "";
    const link = typeof data.link === "string" && /^https?:/i.test(data.link) ? data.link : "";
    // What the page marked under the cursor (data-scribe-context), for actions' own placeholders (#161).
    const context = data.context && typeof data.context === "object" && !Array.isArray(data.context) ? data.context : {};
    // The template's own agent actions (#152), for this selection or the whole page.
    const actions = (window.scribeChat?.pageActions?.(tab, "menu", context) || [])
      .filter((action) => (selection ? action.selection !== "none" : action.selection !== "required"))
      .map((action) => ({ label: action.label, action: () => window.scribeChat?.runAction(tab, action, { selection, context }) }));
    library.openMenu(point, [
      selection && { label: "Ask agent", action: () => window.scribeChat?.ask(selection, tab) },
      selection && { label: "Copy", action: () => copyText(selection, "Copied selection") },
      link && { label: "Copy link address", action: () => copyText(link, "Copied link") },
      {
        label: "Select all",
        action: () => {
          frame.el.focus();
          frame.el.contentWindow?.postMessage({ type: "scribe-select-all" }, pageOrigin(id));
        },
      },
      "sep",
      ...actions,
      "sep",
      !selection && { label: "Ask agent about this page", action: () => window.scribeChat?.ask("", tab) },
      { label: "Copy page key", action: () => copyTabKey(id) },
    ]);
  }

  /** The agent actions declared by a page's template (template metadata resolves a built-in copy's). */
  function templateActions(tab) {
    if (!tab?.templateId) {
      return [];
    }
    const template =
      state.templates.find((item) => item.id === tab.templateId) || state.builtinTemplates.find((item) => item.id === tab.templateId);
    return Array.isArray(template?.agentActions) ? template.agentActions : [];
  }

  async function copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      showNotice(done);
    } catch {
      showNotice("Could not copy to clipboard");
    }
  }

  function onPagePreview(event) {
    const data = event.data;
    const reply = (result) => {
      event.source?.postMessage({ type: "scribe-open-result", id: data.id, reqId: data.reqId, result }, "*");
    };
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      reply({ ok: false, error: "no_gesture" });
      return;
    }
    const files = (Array.isArray(data.files) ? data.files : [])
      .filter((f) => f && f.blob instanceof Blob)
      .map((f) => ({ name: String(f.name || "file"), mimeType: String(f.mimeType || f.blob.type || ""), size: f.blob.size, url: URL.createObjectURL(f.blob) }));
    const revoke = () => files.forEach((f) => URL.revokeObjectURL(f.url));
    if (!files.length || !window.scribePreview?.open(files, Number(data.index) || 0, { onClose: revoke })) {
      revoke();
      reply({ ok: false, error: "nothing_to_preview" });
      return;
    }
    reply({ ok: true });
  }

  /** scribe.setTitle in a page: rename that page (the one the message came from) and tell it the title it got. */
  /** A page's code block asks whether its file can open in the IDE, or opens it (scribe.ide). */
  async function onPageIde(event) {
    const data = event.data;
    const reply = (result) => event.source?.postMessage({ type: "scribe-open-result", id: data.id, reqId: data.reqId, result }, "*");
    const id = frameIdByWindow(event.source);
    const file = typeof data.file === "string" ? data.file : "";
    if (!id || !file || !window.scribeIntegrations?.pageFile) {
      reply({ ok: false, error: id ? "unavailable" : "unknown_page" });
      return;
    }
    const op = data.op === "open" ? "open" : "check";
    reply(await window.scribeIntegrations.pageFile(id, op, file, Number(data.line) || 1));
  }

  async function onPageTitle(event) {
    const data = event.data;
    const reply = (result) => {
      event.source?.postMessage({ type: "scribe-open-result", id: data.id, reqId: data.reqId, result }, "*");
    };
    const id = frameIdByWindow(event.source);
    if (!id) {
      reply({ ok: false, error: "unknown_page" });
      return;
    }
    try {
      const res = await fetch(`/api/tabs/${encodeURIComponent(id)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: String(data.title ?? "") }),
      });
      const body = await res.json().catch(() => ({}));
      reply(res.ok ? { ok: true, title: body.tab?.title } : { ok: false, error: body.error || "Could not rename" });
    } catch {
      reply({ ok: false, error: "Could not rename" });
    }
  }

  /** A link clicked inside a page: open it and tell the page how it went. */
  function onPageLink(event) {
    const data = event.data;
    const frameId = frameIdByWindow(event.source);
    const reply = (result) => {
      event.source?.postMessage({ type: "scribe-open-result", id: data.id, reqId: data.reqId, result }, "*");
    };
    if (data.type === "scribe-resolve") {
      reply({ ok: true, pages: views.resolve(data.targets) });
      return;
    }
    const mode = ["tab", "peek", "split"].includes(data.mode) ? data.mode : null;
    lastInteractedAt = Date.now();
    views
      .open(data.target, mode, {
        source: { role: views.roleOf(frameId), id: frameId },
        anchor: typeof data.anchor === "string" ? data.anchor : "",
        background: data.background === true,
      })
      .then(reply, (err) => reply({ ok: false, error: String(err?.message || err) }));
  }

  function isPaletteOpen() {
    return !paletteEl.hidden;
  }

  function togglePalette() {
    if (isPaletteOpen()) {
      closePalette();
      return;
    }
    openPalette();
  }

  let releasePaletteTrap = null;
  function openPalette() {
    closeSettings();
    paletteEl.hidden = false;
    paletteInput.value = "";
    setPaletteMode("pages");
    paletteIndex = 0;
    loadSemanticStatus();
    showLocalPaletteRows();
    paletteInput.focus();
    paletteInput.select();
    releasePaletteTrap?.();
    releasePaletteTrap = window.scribeFocusTrap?.bind(paletteEl.querySelector(".palette-panel"));
  }

  function closePalette() {
    releasePaletteTrap?.();
    releasePaletteTrap = null;
    paletteEl.hidden = true;
    clearPaletteImage();
    clearTimeout(paletteTimer);
    clearTimeout(relatedTimer);
    paletteReq += 1;
    aiShownQuery = null;
    if (aiAsk?.status === "busy") {
      aiAsk.abort?.abort();
    }
  }

  function setPaletteMode(id) {
    paletteMode = id;
    const def = id === "pages" ? null : PALETTE_PREFIXES.find((item) => item.id === id);
    paletteModeEl.textContent = def ? def.label : "";
    paletteModeEl.hidden = !def;
  }

  /** What the palette is asked: the mode chip's kind (or pages) and the text in the field. */
  function paletteQuery() {
    return { id: paletteMode, query: paletteInput.value.trim() };
  }

  /**
   * Lift a typed prefix out of the field into the mode chip (#573). In a mode, the chip's prefix still
   * counts as typed, so a longer prefix that starts with it (`=` then `=` for `==`) can take over.
   */
  function capturePalettePrefix() {
    const prefixes = currentPalettePrefixes();
    const held = paletteMode === "pages" ? "" : prefixes.find((item) => item.id === paletteMode)?.prefix || "";
    const taken = takePalettePrefix(held + paletteInput.value, prefixes);
    if (!taken || taken.id === paletteMode || taken.prefix.length <= held.length) {
      return;
    }
    const cut = paletteInput.value.length - taken.rest.length;
    const caret = Math.max(0, (paletteInput.selectionStart ?? paletteInput.value.length) - cut);
    paletteInput.value = taken.rest;
    paletteInput.setSelectionRange(caret, caret);
    setPaletteMode(taken.id);
  }

  function updatePaletteChrome(parsed) {
    const threads = parsed.id === "threads";
    const ai = parsed.id === "ai";
    paletteKind = parsed.id;
    const semantic = parsed.id === "semantic";
    paletteInput.placeholder = threads ? "Search threads" : ai ? "Ask about your pages" : semantic ? "Describe what you are looking for" : "Search every page";
    paletteEl
      .querySelector(".palette-panel")
      ?.setAttribute("aria-label", threads ? "Search threads" : ai ? "Ask AI about your pages" : semantic ? "Search pages by meaning" : "Search pages");
    if (paletteEnterHint) {
      paletteEnterHint.textContent = threads ? "open in chat" : ai ? "ask or open" : "open";
    }
    for (const el of paletteEl.querySelectorAll("[data-palette-page]")) {
      el.hidden = threads;
    }
    if (palettePrefixHint) {
      const parts = currentPalettePrefixes().map((item) => `${item.prefix} ${item.label.toLowerCase()}`);
      palettePrefixHint.textContent = parsed.id === "pages" && parts.length ? parts.join(" · ") : "";
      palettePrefixHint.hidden = !palettePrefixHint.textContent;
    }
  }

  function showLocalPaletteRows() {
    updatePaletteChrome({ id: "pages", query: "" });
    const recentClosed = state.closed.filter((tab) => !tab.temp).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, 15);
    paletteHits = [
      ...(window.scribeChat?.pendingAsks?.() || []),
      ...paletteActionRows(""),
      ...state.tabs.map((tab) => ({ ...tab, open: true })),
      ...recentClosed.map((tab) => ({ ...tab, open: false })),
    ];
    paletteIndex = 0;
    renderPalette();
  }

  function schedulePaletteSearch(delay = 80) {
    clearTimeout(paletteTimer);
    paletteTimer = setTimeout(runPaletteSearch, delay);
  }

  function applyPaletteHits(hits) {
    paletteHits = hits;
    if (paletteIndex >= paletteHits.length) {
      paletteIndex = 0;
    }
    renderPalette();
  }

  async function runThreadPaletteSearch(query) {
    const req = ++paletteReq;
    applyPaletteHits(window.scribeChat?.searchThreads?.(query) || []);
    // Titles match at once; threads found by what was said in them follow from the daemon.
    const fresh = await window.scribeChat?.searchThreadMessages?.(query);
    if (!fresh || req !== paletteReq || !isPaletteOpen()) {
      return;
    }
    applyPaletteHits(window.scribeChat.searchThreads(query));
  }

  window.addEventListener("scribe:thread-search-invalidated", () => {
    if (isPaletteOpen() && paletteQuery().id === "threads") void runThreadPaletteSearch(paletteQuery().query);
  });

  async function runPaletteSearch() {
    const parsed = paletteQuery();
    updatePaletteChrome(parsed);
    clearTimeout(relatedTimer);
    if (parsed.id === "pages" && !parsed.query) {
      paletteReq += 1;
      showLocalPaletteRows();
      return;
    }
    if (parsed.id === "semantic") {
      void runSemanticPaletteSearch(parsed.query);
      return;
    }
    if (parsed.id === "threads") {
      void runThreadPaletteSearch(parsed.query);
      return;
    }
    if (parsed.id === "ai") {
      void runAiPaletteSearch(parsed.query);
      return;
    }
    const req = ++paletteReq;
    const res = await fetch(`/api/search?query=${encodeURIComponent(parsed.query)}&limit=40`);
    if (req !== paletteReq || !isPaletteOpen()) {
      return;
    }
    if (!res.ok) {
      return;
    }
    const data = await res.json();
    applyPaletteHits([...spaces.search(parsed.query), ...paletteActionRows(parsed.query), ...(data.tabs || [])]);
    if (semanticStatus?.enabled && parsed.query.length >= SEMANTIC_MIN_QUERY) {
      relatedTimer = setTimeout(() => void addRelatedRows(parsed.query, req), 120);
    }
  }

  function loadSemanticStatus() {
    semanticStatusReq = fetch("/api/search/status")
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((status) => {
        semanticStatus = status;
      });
    return semanticStatusReq;
  }

  async function fetchSemantic(query, scope, limit = 8) {
    try {
      const res = await fetch(`/api/search/semantic?q=${encodeURIComponent(query.slice(0, 500))}&scope=${scope}&limit=${limit}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        return data;
      }
      if (data.status) {
        // 503 with the pack's state: search was switched off or the pack went away since the palette opened.
        semanticStatus = data;
      }
      return { error: data.error || `HTTP ${res.status}` };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }

  function indexProgress(index) {
    return index && (index.indexing || index.pendingPages > 0) && index.indexedPages < index.totalPages
      ? `indexing ${index.indexedPages} of ${index.totalPages} pages`
      : "";
  }

  /**
   * Where a hit opens its page. A section opens at its heading: by id when it has one, else by its place among
   * the page's h1 to h4. A record (a kanban card, a todo item) is passed to the page's scribe.onOpen.
   */
  function hitAnchor(at) {
    if (at.kind === "record") {
      return at.anchor ? `record=${encodeURIComponent(at.anchor)}` : "";
    }
    return at.kind === "section" ? at.headingId || (Number(at.anchor) > 0 ? `scribe-section:${at.anchor}` : "") : "";
  }

  /**
   * Palette rows for semantic hits: the page, with what matched (section heading or "#335 Card title") and a snippet.
   * An image hit shows its thumbnail and the card, item or section it sits on.
   */
  function semanticRows(hits) {
    return hits.map((hit) => {
      const tab = findAnyTab(hit.id) || { id: hit.id, title: hit.title, folderPath: hit.folder };
      const at = hit.kind === "image" ? hit.owner || {} : hit;
      const anchor = hitAnchor(at);
      return {
        ...tab,
        open: state.tabs.some((item) => item.id === hit.id),
        section: undefined,
        matchLabel: hit.label && hit.label !== tab.title ? hit.label : "",
        snippet: hit.snippet,
        anchor,
        // Page assets are served from the content origin only.
        thumb: hit.kind === "image" ? contentOrigin() + hit.image : "",
      };
    });
  }

  /**
   * Normal search (#372): pages found by meaning that the word search did not list, under a
   * "Related" divider. They are appended, so the rows above and the selection stay where they are.
   */
  async function addRelatedRows(query, req) {
    const data = await fetchSemantic(query, "pages");
    if (req !== paletteReq || !isPaletteOpen() || !data.hits) {
      return;
    }
    const listed = new Set(paletteHits.map((hit) => hit.id));
    const rows = semanticRows(data.hits.filter((hit) => !listed.has(hit.id)));
    if (!rows.length) {
      return;
    }
    const progress = indexProgress(data.index);
    rows[0].section = progress ? `Related · ${progress}` : "Related";
    paletteHits = [...paletteHits, ...rows];
    const top = paletteList.scrollTop;
    renderPalette();
    paletteList.scrollTop = top;
  }

  function semanticInfoRow(title, snippet, settings = false) {
    return { kind: "semantic-info", id: "semantic:info", title, snippet, settings };
  }

  function semanticOffRow() {
    const status = semanticStatus?.status;
    const how =
      status === "ready"
        ? "Switch it on in Settings → Search."
        : status === "wrong-version" || status === "invalid"
          ? `The search pack can't be used: ${semanticStatus.message}.`
          : "It needs the optional search pack: install its ZIP in Settings → Search, then switch it on there.";
    return semanticInfoRow("Search by meaning is off", `${how} Enter opens Settings.`, true);
  }

  /** The semantic prefix (#372): pages by meaning, then the sections and cards that matched. No word search. */
  async function runSemanticPaletteSearch(query) {
    const req = ++paletteReq;
    const stale = () => req !== paletteReq || !isPaletteOpen();
    if (!semanticStatus) {
      await (semanticStatusReq || loadSemanticStatus());
      if (stale()) {
        return;
      }
    }
    if (!semanticStatus?.enabled) {
      paletteIndex = 0;
      applyPaletteHits([semanticOffRow()]);
      return;
    }
    if (!query) {
      applyPaletteHits([]);
      const res = await fetch("/api/search/index/status").catch(() => null);
      const index = res?.ok ? await res.json() : null;
      if (!stale()) {
        semanticProgress = indexProgress(index);
        renderPalette();
      }
      return;
    }
    // Wait out fast typing: each query costs the model about 150 ms.
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (stale()) {
      return;
    }
    // The first search after a while loads the model (several seconds), so say that something is happening.
    const busy = setTimeout(() => {
      if (!stale()) {
        paletteIndex = 0;
        applyPaletteHits([{ ...semanticInfoRow("Searching by meaning…", "The first search loads the model, which takes a few seconds."), busy: true }]);
      }
    }, 400);
    const [pages, chunks, images] = await Promise.all([
      fetchSemantic(query, "pages"),
      fetchSemantic(query, "chunks"),
      fetchSemantic(query, "images", 4),
    ]);
    clearTimeout(busy);
    if (stale()) {
      return;
    }
    paletteIndex = 0;
    if (!pages.hits) {
      applyPaletteHits([semanticStatus?.enabled ? semanticInfoRow("Search by meaning failed", pages.error) : semanticOffRow()]);
      return;
    }
    semanticProgress = indexProgress(pages.index);
    // A page row already shows its best chunk; list the other matching sections and cards below.
    const key = (hit) => `${hit.id}|${hit.kind}|${hit.anchor}`;
    const reasons = new Set(pages.hits.map(key));
    const pageRows = semanticRows(pages.hits);
    const chunkRows = semanticRows((chunks.hits || []).filter((hit) => hit.kind !== "page" && !reasons.has(key(hit))));
    if (pageRows.length && semanticProgress) {
      pageRows[0].section = `Pages · ${semanticProgress}`;
    }
    if (chunkRows.length) {
      chunkRows[0].section = "Sections and cards";
    }
    const imageRows = semanticRows(images.hits || []);
    if (imageRows.length) {
      imageRows[0].section = "Images";
    }
    applyPaletteHits([...pageRows, ...chunkRows, ...imageRows]);
  }

  function clearPaletteImage() {
    if (paletteImage) {
      URL.revokeObjectURL(paletteImage.url);
      paletteImage = null;
    }
  }

  /** The first image file of a paste or drop, if it carries one. */
  function imageFileOf(transfer) {
    return [...(transfer?.files || [])].find((file) => /^image\/(png|jpeg|gif|webp|avif)$/.test(file.type)) || null;
  }

  /**
   * An image as the query (#373): pasted or dropped into the palette, it lists the indexed images that
   * look most like it, each with the card, item or section it sits on. Typing goes back to text search.
   */
  async function runImagePaletteSearch(file) {
    const req = ++paletteReq;
    const stale = () => req !== paletteReq || !isPaletteOpen();
    clearTimeout(paletteTimer);
    clearTimeout(relatedTimer);
    clearPaletteImage();
    paletteImage = { url: URL.createObjectURL(file) };
    paletteInput.value = "";
    setPaletteMode("pages");
    updatePaletteChrome({ id: "semantic", query: "" });
    paletteInput.placeholder = "Similar images. Type to search by text";
    const queryRow = (title, snippet, extra = {}) => ({ ...semanticInfoRow(title, snippet), thumb: paletteImage?.url, ...extra });
    paletteIndex = 0;
    if (!semanticStatus) {
      await (semanticStatusReq || loadSemanticStatus());
      if (stale()) {
        return;
      }
    }
    if (!semanticStatus?.enabled) {
      applyPaletteHits([semanticOffRow()]);
      return;
    }
    applyPaletteHits([queryRow("Looking for similar images…", "The first image search loads the vision model, which takes a few seconds.", { busy: true })]);
    let data;
    try {
      const res = await fetch("/api/search/semantic/image?limit=8", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.status) {
          semanticStatus = data;
        }
        data = { error: data.error || `HTTP ${res.status}` };
      }
    } catch (err) {
      data = { error: err.message || String(err) };
    }
    if (stale()) {
      return;
    }
    if (!data.hits) {
      applyPaletteHits([semanticStatus?.enabled ? queryRow("Image search failed", data.error) : semanticOffRow()]);
      return;
    }
    const rows = semanticRows(data.hits);
    const pending = data.index?.pendingImagePages > 0 ? " Images are still being indexed." : "";
    if (!rows.length) {
      applyPaletteHits([queryRow("No similar images", `No indexed image looks like this one.${pending}`)]);
      return;
    }
    rows[0].section = "Similar images";
    // The query's own row leads; the selection starts on the best match.
    paletteIndex = 1;
    applyPaletteHits([queryRow("Images like this one", `${file.name || "Pasted image"}.${pending}`), ...rows]);
  }

  /**
   * `?` (#245): the Ask AI row (or its answer) on top, the free text matches below. Nothing is
   * spent until Enter on the Ask row; an empty `?` lists recent questions with their saved answers.
   */
  async function runAiPaletteSearch(query) {
    const req = ++paletteReq;
    if (aiShownQuery !== query) {
      paletteIndex = 0;
      aiShownQuery = query;
    }
    if (!query) {
      applyPaletteHits(aiRecentRows());
      return;
    }
    const ask = aiAsk?.query === query ? aiAsk : null;
    const head = ask?.status === "done" ? aiResultRows(ask) : [aiAskRow(query, ask)];
    applyPaletteHits(head);
    const res = await fetch(`/api/search?query=${encodeURIComponent(query)}&limit=40`);
    if (req !== paletteReq || !isPaletteOpen() || !res.ok) {
      return;
    }
    const data = await res.json();
    const shown = new Set(head.map((hit) => hit.id));
    const text = (data.tabs || []).filter((tab) => !shown.has(tab.id));
    if (text.length) {
      text[0] = { ...text[0], section: "Text matches" };
    }
    applyPaletteHits([...head, ...text]);
  }

  function aiAskRow(query, ask) {
    const row = { kind: "ai-ask", id: "ai:ask", query, title: `Ask AI: “${query}”`, locationLabel: "AI", location: "ai" };
    if (ask?.status === "busy") {
      return { ...row, busy: true, title: aiModel ? `Searching your pages with ${aiModel}…` : "Searching your pages…", snippet: "Esc to stop" };
    }
    if (ask?.status === "error") {
      return { ...row, snippet: `That failed: ${ask.error}. Enter to try again.` };
    }
    return { ...row, snippet: aiModel ? `Enter to ask. One call to ${aiModel} over all your pages.` : "Enter to ask. One model call over all your pages." };
  }

  function aiResultRows(ask) {
    const rows = [];
    for (const hit of ask.hits || []) {
      const tab = findAnyTab(hit.id);
      if (tab) {
        // With semantic search on, a hit names the section or card the model picked.
        const anchor = hitAnchor(hit);
        const matchLabel = hit.label && hit.label !== tab.title ? hit.label : "";
        rows.push({ ...tab, open: state.tabs.some((item) => item.id === tab.id), snippet: hit.reason, matchLabel, anchor });
      }
    }
    const took = ask.ms ? ` · ${(ask.ms / 1000).toFixed(1)} s` : "";
    const section = `${rows.length ? "AI results" : "No pages fit"} · ${ask.model || "AI"}${took}`;
    if (rows.length) {
      rows[0] = { ...rows[0], section };
    }
    const chat = {
      kind: "ai-chat",
      id: "ai:chat",
      query: ask.query,
      title: "Ask in chat for a deeper search",
      snippet: "Opens a new thread with this question, ready to send",
      locationLabel: "Chat",
      location: "ai",
    };
    return [...rows, rows.length ? chat : { ...chat, section }];
  }

  function readAiRecent() {
    try {
      const list = JSON.parse(localStorage.getItem(AI_RECENT_KEY) || "[]");
      return Array.isArray(list) ? list.filter((item) => item && typeof item.query === "string" && Array.isArray(item.hits)) : [];
    } catch {
      return [];
    }
  }

  function saveAiRecent(ask) {
    const item = { query: ask.query, at: Date.now(), model: ask.model, ms: ask.ms, hits: ask.hits };
    const list = [item, ...readAiRecent().filter((old) => old.query !== ask.query)].slice(0, AI_RECENT_MAX);
    localStorage.setItem(AI_RECENT_KEY, JSON.stringify(list));
  }

  function aiRecentRows() {
    return readAiRecent().map((item, index) => ({
      kind: "ai-recent",
      id: `ai:recent:${index}`,
      title: item.query,
      snippet: `${item.hits.length === 1 ? "1 result" : `${item.hits.length} results`} · ${new Date(item.at).toLocaleString()}`,
      section: index === 0 ? "Recent questions" : undefined,
      item,
    }));
  }

  async function startAiAsk(query) {
    aiAsk?.abort?.abort();
    const abort = new AbortController();
    const ask = { query, status: "busy", abort };
    aiAsk = ask;
    runPaletteSearch();
    try {
      const res = await fetch("/api/agent/palette-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: abort.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      Object.assign(ask, { status: "done", hits: data.hits || [], model: data.model || "", ms: data.ms || 0 });
      aiModel = ask.model || aiModel;
      saveAiRecent(ask);
    } catch (err) {
      if (abort.signal.aborted) {
        if (aiAsk === ask) {
          aiAsk = null;
        }
      } else {
        Object.assign(ask, { status: "error", error: err.message || String(err) });
      }
    }
    ask.abort = null;
    if (aiAsk === ask || !aiAsk) {
      if (isPaletteOpen() && paletteKind === "ai") {
        paletteIndex = 0;
        runPaletteSearch();
      }
    }
  }

  /** The open page's template agent actions (#152) matching the query, listed above the pages. */
  function paletteActionRows(query) {
    const tab = activeTab();
    const q = query.trim().toLowerCase();
    return (window.scribeChat?.pageActions?.(tab, "palette") || [])
      .filter((action) => action.selection !== "required")
      .filter((action) => !q || `${action.label} ${action.description || ""}`.toLowerCase().includes(q))
      .map((action) => ({
        kind: "action",
        id: `action:${action.id}`,
        title: action.label,
        snippet: action.description || "",
        locationLabel: "Agent action",
        location: "action",
        tab,
        action,
      }));
  }

  function renderPalette() {
    paletteList.replaceChildren();
    const empty = paletteHits.length === 0;
    paletteEmpty.hidden = !empty;
    const parsed = paletteQuery();
    const threads = paletteKind === "threads";
    const semantic = paletteKind === "semantic";
    paletteEmpty.textContent = parsed.query
      ? threads
        ? "No matching threads"
        : semantic
          ? "Nothing close to that"
          : "No matching pages"
      : threads
        ? "No threads yet"
        : paletteKind === "ai"
          ? "Type a question about your pages and press Enter"
          : semantic
            ? "Describe what you are looking for. Pages, sections, cards and images are matched by meaning, not by their words. Paste or drop an image to find similar ones."
            : "No pages yet";
    if (semantic && semanticProgress) {
      paletteEmpty.textContent += ` Still ${semanticProgress}.`;
    }
    for (let index = 0; index < paletteHits.length; index += 1) {
      const tab = paletteHits[index];
      if (tab.section) {
        const head = document.createElement("div");
        head.className = "palette-section";
        head.textContent = tab.section;
        paletteList.appendChild(head);
      }
      const el = document.createElement("div");
      el.className = "palette-row" + (index === paletteIndex ? " active" : "") + (tab.busy ? " busy" : "");
      el.role = "option";
      el.setAttribute("aria-selected", index === paletteIndex ? "true" : "false");
      el.addEventListener("mouseenter", () => {
        paletteIndex = index;
        highlightPaletteRows();
      });
      el.addEventListener("mousedown", (event) => {
        event.preventDefault();
        activatePaletteHit(tab, views.modeFromEvent(event));
      });

      // A row with a thumbnail keeps its text in a column beside it.
      let body = el;
      if (tab.thumb) {
        el.classList.add("with-thumb");
        const thumb = document.createElement("img");
        thumb.className = "palette-thumb";
        thumb.src = tab.thumb;
        thumb.alt = "";
        thumb.loading = "lazy";
        body = document.createElement("div");
        body.className = "palette-row-text";
        el.append(thumb, body);
      }
      const main = document.createElement("div");
      main.className = "palette-row-main";
      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = tab.title;
      main.appendChild(title);

      const chips = document.createElement("div");
      chips.className = "palette-chips";
      if (tab.locationLabel) {
        chips.appendChild(paletteChip(tab.locationLabel, "location-" + tab.location));
      }
      if (tab.qualityLabel) {
        chips.appendChild(paletteChip(tab.qualityLabel));
      }
      if (tab.kind === "space") {
        if (tab.open) {
          chips.appendChild(paletteChip("Current"));
        }
      } else if (tab.kind === "thread" || tab.kind === "action" || tab.kind === "ask" || tab.kind?.startsWith("ai-") || tab.kind === "semantic-info") {
        if (tab.open) {
          chips.appendChild(paletteChip("Open"));
        }
      } else if (!tab.open) {
        chips.appendChild(paletteChip("Closed"));
      }
      const folder = tab.folderId ? library.pathOf(tab.folderId) : tab.folderPath || "";
      if (folder) {
        chips.appendChild(paletteChip(folder, "folder"));
      }
      if (chips.childElementCount) {
        main.appendChild(chips);
      }
      body.appendChild(main);

      if (tab.snippet || tab.matchLabel) {
        const snippet = document.createElement("div");
        snippet.className = "palette-snippet";
        if (tab.matchLabel) {
          const label = document.createElement("span");
          label.className = "palette-match";
          label.textContent = tab.matchLabel;
          snippet.appendChild(label);
        }
        snippet.append(tab.snippet || "");
        body.appendChild(snippet);
      }
      paletteList.appendChild(el);
    }
    const active = paletteList.querySelector(".palette-row.active");
    if (active) {
      active.scrollIntoView({ block: "nearest" });
    }
  }

  function paletteChip(label, extraClass) {
    const chip = document.createElement("span");
    chip.className = "palette-chip" + (extraClass ? " " + extraClass : "");
    chip.textContent = label;
    return chip;
  }

  function highlightPaletteRows() {
    const rows = paletteList.querySelectorAll(".palette-row");
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const on = i === paletteIndex;
      row.classList.toggle("active", on);
      row.setAttribute("aria-selected", on ? "true" : "false");
    }
    const active = paletteList.querySelector(".palette-row.active");
    if (active) {
      active.scrollIntoView({ block: "nearest" });
    }
  }

  function movePalette(delta) {
    if (!paletteHits.length) {
      return;
    }
    paletteIndex = (paletteIndex + delta + paletteHits.length) % paletteHits.length;
    highlightPaletteRows();
  }

  /** Enter or a click navigates; Ctrl also navigates, Shift splits, Alt peeks. Threads open in chat. */
  function activatePaletteHit(tab, mode = null) {
    if (!tab) {
      return;
    }
    if (tab.kind === "ask") {
      closePalette();
      if (tab.page?.id) {
        if (mode === "peek" || mode === "split") {
          views.open(tab.page.id, mode);
        } else if (state.tabs.some((item) => item.id === tab.page.id)) {
          selectTab(tab.page.id, { fromUser: true });
        } else {
          openPage(tab.page.id);
        }
      }
      if (!window.scribeChat?.openAsk?.(tab.threadId, tab.itemId)) {
        showNotice("Could not open that thread");
      }
      return;
    }
    if (tab.kind === "ai-ask") {
      if (aiAsk?.query !== tab.query || aiAsk.status !== "busy") {
        void startAiAsk(tab.query);
      }
      return;
    }
    if (tab.kind === "ai-chat") {
      closePalette();
      if (!window.scribeChat?.askInChat) {
        showNotice("The agent chat is not ready");
        return;
      }
      window.scribeChat.askInChat(tab.query);
      return;
    }
    if (tab.kind === "ai-recent") {
      aiAsk = { ...tab.item, status: "done" };
      setPaletteMode("ai");
      paletteInput.value = tab.item.query;
      runPaletteSearch();
      return;
    }
    if (tab.kind === "semantic-info") {
      if (tab.settings) {
        closePalette();
        settingsCategories.select(2);
        openSettings();
      }
      return;
    }
    if (tab.kind === "action") {
      closePalette();
      void window.scribeChat?.runAction(tab.tab, tab.action);
      return;
    }
    if (tab.kind === "space") {
      closePalette();
      void spaces.switchTo(tab.spaceId);
      return;
    }
    if (tab.kind === "thread") {
      closePalette();
      if (!window.scribeChat?.openThread?.(tab.id)) {
        showNotice("Could not open that thread");
      }
      return;
    }
    closePalette();
    if (tab.anchor) {
      // A section, card or item that matched: open the page at it.
      views.open(tab.id, mode === "peek" || mode === "split" ? mode : "tab", { anchor: tab.anchor });
      return;
    }
    if (mode === "peek" || mode === "split") {
      views.open(tab.id, mode);
      return;
    }
    if (!state.tabs.some((item) => item.id === tab.id)) {
      openPage(tab.id);
      return;
    }
    selectTab(tab.id, { fromUser: true });
  }

  tabsEl.parentElement.addEventListener("wheel", onTabsWheel, { passive: false });
  tabsEl.addEventListener("scroll", updateTabFade);
  window.addEventListener("resize", () => {
    if (tabScrollTarget != null) {
      tabScrollTarget = clampTabScroll(tabScrollTarget);
    }
    updateTabFade();
  });

  document.addEventListener(
    "pointerdown",
    () => {
      lastInteractedAt = Date.now();
      reportViewer();
    },
    true
  );

  window.addEventListener("keydown", onBoardShortcut, true);
  window.addEventListener("keydown", onBoardEscape);
  // Keep the empty palette's pending questions current while it is open.
  window.addEventListener("scribe:agent-status", () => {
    if (isPaletteOpen() && paletteKind === "pages" && !paletteQuery().query) {
      const current = paletteHits[paletteIndex]?.id;
      showLocalPaletteRows();
      const index = paletteHits.findIndex((hit) => hit.id === current);
      if (index > 0) {
        paletteIndex = index;
        highlightPaletteRows();
      }
    }
  });
  window.scribeShortcut = runShortcut;
  /** What the agent chat (agent.js) needs from the shell. */
  window.scribeApp = {
    templateActions,
    activeTab,
    findAnyTab: (id) => findAnyTab(id) || (state.draft?.id === id ? state.draft : null),
    tabs: () => state.tabs,
    /** Ids of the pages on screen in this window: the focused one, split panes and the peek. */
    shownIds: () => [...views.shownIds()],
    closed: () => state.closed,
    folders: () => state.folders,
    /** The active space, with its home folder (#260); null before spaces are used. */
    space: () => spaces.current(),
    connected: () => state.connected,
    openLink: (target, event, { anchor = "", mode = null } = {}) => views.open(target, views.modeFromEvent(event) || mode, { anchor, background: event?.button === 1 }),
    resolvePages: (targets) => views.resolve(targets),
    showNotice,
    confirm: confirmDelete,
    closeSettings,
    openSettings,
    /** Tell a page's frame (when it has one) about something, e.g. one of its agent threads changing. */
    postToPage: (id, message) => {
      frames.get(id)?.el.contentWindow?.postMessage({ ...message, id }, pageOrigin(id));
    },
  };
  window.addEventListener("message", (event) => {
    const frameId = frameIdByWindow(event.source);
    if (!frameId || event.origin !== pageOrigin(frameId)) {
      return;
    }
    if (event.data?.type === "scribe-download") {
      downloadActive();
    } else if (childId && ["scribe-undo", "scribe-help", "scribe-palette", "scribe-shortcut"].includes(event.data?.type)) {
      // The strip's and the Library's shortcuts stay with the main window.
    } else if (event.data?.type === "scribe-undo") {
      undoClose();
    } else if (event.data?.type === "scribe-help") {
      openWelcome();
    } else if (event.data?.type === "scribe-palette") {
      togglePalette();
    } else if (event.data?.type === "scribe-shortcut") {
      if (["spaces", "next-space", "prev-space", "library", "new-page", "settings", "agent-settings"].includes(event.data.action)) {
        runShortcut(event.data.action);
      }
    } else if (event.data?.type === "scribe-activity") {
      views.onFrameActive(frameIdByWindow(event.source));
      noteEdit();
    } else if (event.data?.type === "scribe-open" || event.data?.type === "scribe-resolve") {
      onPageLink(event);
    } else if (event.data?.type === "scribe-escape") {
      if (window.scribePreview?.close()) {
        return;
      }
      if (!window.scribeChat?.escape()) {
        views.escape();
      }
    } else if (event.data?.type === "scribe-agent") {
      onPageAgent(event);
    } else if (event.data?.type === "scribe-permissions") {
      onPagePermissions(event);
    } else if (event.data?.type === "scribe-ml") {
      onPageMl(event);
    } else if (event.data?.type === "scribe-plugin") {
      onPagePlugin(event);
    } else if (event.data?.type === "scribe-audio") {
      onPageAudio(event);
    } else if (event.data?.type === "scribe-reply") {
      onPageReply(event);
    } else if (event.data?.type === "scribe-browser") {
      void onPageBrowser(event);
    } else if (event.data?.type === "scribe-file") {
      void onPageFile(event);
    } else if (event.data?.type === "scribe-ide") {
      void onPageIde(event);
    } else if (event.data?.type === "scribe-title") {
      onPageTitle(event);
    } else if (event.data?.type === "scribe-preview") {
      onPagePreview(event);
    } else if (event.data?.type === "scribe-chat-key") {
      const action = String(event.data.action || "");
      const selection = typeof event.data.selection === "string" ? event.data.selection : "";
      const tab = selection ? findAnyTab(frameIdByWindow(event.source)) : null;
      if (tab && (action === "dock" || action === "side")) {
        window.scribeChat?.ask(selection, tab, action);
      } else {
        window.scribeChat?.shortcut(action);
      }
    } else if (event.data?.type === "scribe-context-menu") {
      onPageContextMenu(event);
    } else if (event.data?.type === "scribe-context-menu-close") {
      library.closeMenu();
    }
  });

  settingsToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleSettings();
  });
  settingsBackdrop.addEventListener("mousedown", (event) => {
    event.preventDefault();
    closeSettings();
  });
  importPageBtn.addEventListener("click", pickImportFile);
  exportPageBtn.addEventListener("click", () => {
    const tab = activeTab();
    if (tab) {
      downloadExport(tab.id);
    }
  });
  exportAllBtn.addEventListener("click", () => downloadExport());
  importFileInput.addEventListener("change", () => {
    importFiles(importFileInput.files, "meta");
    importFileInput.value = "";
  });
  noticeUndo.addEventListener("click", () => {
    const action = noticeAction;
    if (action) {
      noticeEl.hidden = true;
      noticeAction = null;
      action.run();
      return;
    }
    undoClose();
  });
  bindFileDrop(settingsEl, "meta");
  bindFileDrop(tabsWrap, "meta");
  bindFileDrop(sidePane, "closed");
  document.addEventListener("dragover", (event) => {
    if (hasFiles(event)) {
      event.preventDefault();
    }
  });
  document.addEventListener("drop", (event) => {
    if (hasFiles(event)) {
      event.preventDefault();
    }
  });
  smoothScrollToggle.addEventListener("click", () => toggleFlag(smoothScrollToggle, SMOOTH_SCROLL_KEY));
  spaceSuggestToggle.addEventListener("click", () => toggleFlag(spaceSuggestToggle, SPACE_SUGGEST_KEY));
  showClearToggle.addEventListener("click", () => toggleFlag(showClearToggle, SHOW_CLEAR_KEY));
  tightSmallToggle.addEventListener("click", () => toggleFlag(tightSmallToggle, TIGHT_SMALL_KEY));
  uiFxToggle.addEventListener("click", () => toggleFlag(uiFxToggle, UI_FX_KEY));
  newPageProviderToggle.addEventListener("click", () => {
    toggleFlag(newPageProviderToggle, NEWPAGE_PROVIDER_KEY);
    window.dispatchEvent(new Event("scribe:newpage-bg"));
  });
  pageIntentToggle.addEventListener("click", () => {
    toggleFlag(pageIntentToggle, PAGE_INTENT_KEY);
    if (!flagOn(pageIntentToggle)) {
      endPageIntent();
      onPageHint(null);
    }
  });
  window.addEventListener("scribe:page-intent", (event) => onPageIntent(event.detail));
  window.addEventListener("scribe:page-hint", (event) => onPageHint(event.detail));
  auroraEdgeToggle.addEventListener("click", () => toggleFlag(auroraEdgeToggle, AURORA_EDGE_KEY));
  clearBtn.addEventListener("click", async () => {
    await fetch("/api/tabs?filter=unpinned", { method: "DELETE" });
  });
  libraryToggle.addEventListener("click", () => setSideOpen(!state.sideOpen));
  newTabBtn.addEventListener("click", () => runShortcut("new-page"));
  // The New page screen leaves only its background once the page has a thread.
  window.addEventListener("scribe:agent-threads", () => {
    for (const tab of state.tabs) {
      const el = isBlank(tab) ? tabEls.get(tab.id) : null;
      if (el) {
        syncTabEl(el, tab);
      }
    }
    const tab = activeTab();
    if (isBlank(tab)) {
      newPageView.render(tab);
    }
  });
  sidebarTabLibrary.addEventListener("click", () => setSidebarTab("library"));
  sidebarTabTemplates.addEventListener("click", () => setSidebarTab("templates"));
  builtinHead.addEventListener("click", toggleBuiltinGroup);
  trashBack.addEventListener("click", () => {
    closeTrash();
    document.getElementById("library-more")?.focus({ preventScroll: true });
  });
  templateEditBtn.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab?.templateId) {
      return;
    }
    const template = state.templates.find((item) => item.id === tab.templateId);
    if (!template) {
      return;
    }
    openTemplateModal(template, "edit", tab.templateValues || {});
  });
  templateModalBackdrop.addEventListener("click", closeTemplateModal);
  templateModalCancel.addEventListener("click", closeTemplateModal);
  templateModalForm.addEventListener("submit", submitTemplateModal);
  paletteBackdrop.addEventListener("mousedown", (event) => {
    event.preventDefault();
    closePalette();
  });
  paletteInput.addEventListener("paste", (event) => {
    const file = imageFileOf(event.clipboardData);
    if (file) {
      event.preventDefault();
      void runImagePaletteSearch(file);
    }
  });
  paletteEl.addEventListener("drop", (event) => {
    const file = imageFileOf(event.dataTransfer);
    if (file) {
      event.preventDefault();
      void runImagePaletteSearch(file);
    }
  });
  paletteInput.addEventListener("input", () => {
    clearPaletteImage();
    const mode = paletteMode;
    capturePalettePrefix();
    if (paletteMode !== mode) {
      clearTimeout(paletteTimer);
      paletteIndex = 0;
      runPaletteSearch();
      return;
    }
    if (paletteMode === "pages" && !paletteInput.value.trim()) {
      showLocalPaletteRows();
      return;
    }
    schedulePaletteSearch();
  });
  paletteInput.addEventListener("keydown", (event) => {
    // A fresh Backspace at the start of the field drops the mode chip; a held one that got there does not.
    if (
      event.key === "Backspace" &&
      !event.repeat &&
      paletteMode !== "pages" &&
      paletteInput.selectionStart === 0 &&
      paletteInput.selectionEnd === 0
    ) {
      event.preventDefault();
      setPaletteMode("pages");
      clearTimeout(paletteTimer);
      paletteIndex = 0;
      runPaletteSearch();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      movePalette(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      movePalette(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activatePaletteHit(paletteHits[paletteIndex], views.modeFromEvent(event));
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (paletteKind === "ai" && aiAsk?.status === "busy") {
        aiAsk.abort?.abort();
        return;
      }
      closePalette();
    }
  });
  window.addEventListener("scribe:threads-ready", () => {
    if (isPaletteOpen() && paletteKind === "threads") {
      runPaletteSearch();
    }
  });

  sideResizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    const startX = event.clientX;
    const startWidth = sidePane.getBoundingClientRect().width;
    const dir = document.documentElement.dataset.librarySide === "left" ? 1 : -1;
    window.scribeDrag({ event, target: sideResizer, threshold: 0,
      onStart: () => document.body.classList.add("resizing-side"),
      onMove: move => { applySideWidth(startWidth + dir * (move.clientX - startX)); },
      onDrop: up => {
        document.body.classList.remove("resizing-side");
        localStorage.setItem(SIDE_WIDTH_KEY, String(applySideWidth(startWidth + dir * (up.clientX - startX))));
      },
      onCancel: () => { document.body.classList.remove("resizing-side"); applySideWidth(startWidth); },
    });
  });

  window.addEventListener("popstate", onHistoryStep);

  window.addEventListener("hashchange", () => {
    // Steps onto the board's own entries were handled by popstate.
    if (typeof history.state?.boardIndex === "number") {
      return;
    }
    const id = location.hash.replace(/^#/, "");
    if (!id) {
      return;
    }
    const open = state.tabs.find((item) => item.id === id || item.key === id);
    if (open && open.id !== state.activeId) {
      selectTab(open.id, { fromUser: true });
      return;
    }
    const closed = state.closed.find((item) => item.id === id || item.key === id);
    if (closed) {
      openPage(closed.id);
    }
  });

  window.addEventListener("scribe:threads-ready", () => invalidate("library"));

  popout.bindDocking({ views, findAnyTab, isDragging: () => Boolean(drag) });

  popout.onChange(() => {
    // A page that left for its own window gives up its pane, and its frame here.
    for (const id of popout.ids()) {
      views.onPopOut(id);
    }
    render();
    for (const id of popout.ids()) {
      if (!views.isShown(id)) {
        discardFrame(id);
      }
    }
  });
  popout.onRequest((request) => {
    if (childId || typeof request?.id !== "string") {
      return;
    }
    if (request.type === "focus-request") {
      applyEvent({ type: "tab_focus_request", id: request.id, thread: request.thread });
    } else if (request.type === "show") {
      if (state.tabs.some((tab) => tab.id === request.id)) {
        selectTab(request.id, { fromUser: true });
      } else if (findAnyTab(request.id)) {
        openPage(request.id);
      }
    }
  });

  setSideOpen(state.sideOpen);
  connect();
  render();
})();
