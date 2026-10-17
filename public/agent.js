/* Agent chat: sidebar pane, floating dock, and full-window views over one set of threads. */
(() => {
  const R = window.AgentRender;
  const { el, icon, button } = R;
  const app = () => window.scribeApp;

  const LS = {
    side: "scribe.agent.sideOpen",
    width: "scribe.agent.width",
    current: "scribe.agent.current",
    dock: "scribe.agent.dockShown",
    dockPicks: "scribe.agent.dockPicks",
    filter: "scribe.agent.filter",
    reasoning: "scribe.agent.reasoningOpen",
    button: "scribe.agent.showButton",
    emptyEnter: "scribe.agent.emptyEnter",
    sendKey: "scribe.agent.sendKey",
    tips: "scribe.agent.showTips",
    presets: "scribe.agent.showPresets",
    hidePage: "scribe.agent.hidePageThreads",
    compact: "scribe.agent.compactThreads",
    collapsed: "scribe.agent.collapsedGroups",
    fullSide: "scribe.agent.fullSideWidth",
  };
  /** What Enter on an empty composer does with a queued message while a turn runs. */
  const EMPTY_ENTER = [
    { id: "steer", label: "Steer, then send" },
    { id: "send", label: "Send now" },
  ];

  /** Plain Enter sends, or only Ctrl+Enter. Shift+Enter is always a new line; Ctrl+Enter always sends. */
  const SEND_KEY = [
    { id: "enter", label: "Enter" },
    { id: "mod", label: "Ctrl+Enter" },
  ];

  /** The thread list shows only each thread's title and status dot (Agent settings). */
  function compactThreads() {
    return localStorage.getItem(LS.compact) === "1";
  }

  function emptyEnter() {
    return localStorage.getItem(LS.emptyEnter) === "send" ? "send" : "steer";
  }

  /** Empty Enter acts on the waiting steered message, else the first queued one. */
  function emptyEnterTarget(threadId) {
    const items = S.details.get(threadId)?.items || [];
    if (items.some((it) => it.kind === "user" && it.editing)) return null;
    const waiting = items.find((it) => it.kind === "user" && it.steer === "waiting");
    if (waiting) return { id: waiting.id, action: "send-now" };
    const queued = items.find((it) => it.kind === "user" && it.turnId == null && !it.dropped && !it.steer);
    if (queued) return { id: queued.id, action: emptyEnter() === "send" ? "send-now" : "steer" };
    return null;
  }

  /** What the hover button on this queued or waiting message does. None while another is already steering. */
  function queuedItemAction(threadId, item) {
    if ((S.details.get(threadId)?.items || []).some((it) => it.kind === "user" && it.editing)) return null;
    if (item.steer === "waiting") return "send-now";
    if (item.steer || item.dropped || item.turnId) return null;
    const items = S.details.get(threadId)?.items || [];
    if (items.some((it) => it.kind === "user" && it.steer === "waiting")) return null;
    return emptyEnter() === "send" ? "send-now" : "steer";
  }

  function sendKey() {
    return localStorage.getItem(LS.sendKey) === "mod" ? "mod" : "enter";
  }

  function composerSendHint() {
    return sendKey() === "mod" ? "Ctrl+Enter to send · Shift+Enter for a new line" : "Enter to send · Shift+Enter for a new line";
  }

  function approvalFor(provider, p = prefs()) {
    return p.approvals?.[provider] || p.approval || "ask";
  }

  const MODES = [
    { id: "code", label: "Code", detail: "Read, edit files and run commands in the workspace" },
    { id: "ask", label: "Ask", detail: "Read-only: answer, read and search, no edits" },
    { id: "plan", label: "Plan", detail: "Investigate and propose a plan before changing anything" },
    { id: "board", label: "Pages", detail: "Scribe pages and web only, no shell or file edits" },
  ];
  /** Tool groups a custom mode can turn off (ModeCapability in src/agent/customModes.ts). */
  const MODE_TOOLS = [
    { id: "edit", label: "Edit files" },
    { id: "shell", label: "Shell commands" },
    { id: "web", label: "Web search and fetch" },
    { id: "subagents", label: "Subagents" },
    { id: "helpers", label: "Helper agents" },
    { id: "browser", label: "Browser tools" },
    { id: "threads", label: "Read other threads" },
  ];
  const APPROVALS = [
    { id: "ask", label: "Ask first", detail: "Ask before edits and commands that are not allowlisted" },
    { id: "edits", label: "Auto-edit", detail: "Accept file edits, ask before commands" },
    { id: "auto", label: "Auto review", detail: "A classifier approves safe calls and asks for the rest (Claude)" },
    { id: "full", label: "Full access", detail: "Approve everything automatically" },
  ];
  const WEB_MODES = [
    { id: "on", label: "Full", detail: "Web search and fetch on any site" },
    { id: "limited", label: "Limited", detail: "The web allowlist's domains without asking; the agent asks for others" },
    { id: "off", label: "Off", detail: "The agent asks before each web search or fetch" },
  ];
  /** Providers that actually apply Limited and Off. */
  function webEnforced(provider) {
    return provider === "claude" || provider === "cursor" || provider === "codex" || provider === "pi";
  }
  /** How long the transcript's spring takes to settle at the bottom, independent of the CSS entry duration. */
  const STICK_SPRING_MS = 600;
  /** How close to the bottom counts as pinned. Opening the queue dock shrinks the scroll by the dock's height, so this must be the hide/show hysteresis too. */
  const STICK_PX = 80;
  const WEB_UNENFORCED = "Not enforced on this provider: its own web tools stay on.";
  /** Cursor and Pi have no Limited search unless a SearXNG instance is set: the allowlist covers a fetch tool only. */
  const CURSOR_LIMITED = "Fetch from the web allowlist's domains; the agent asks for others; no web search";
  const SEARXNG_LIMITED = "Search and fetch the web allowlist's domains (search through your SearXNG); the agent asks for others";
  function scribeLimited() {
    return prefs().searxngUrl ? SEARXNG_LIMITED : CURSOR_LIMITED;
  }
  /** The Cursor SDK has no approval callback: every mode but Full access runs Cursor's Auto-review, which denies instead of asking. */
  const CURSOR_ASK = "Would ask first; Cursor Auto-reviews instead (can't ask yet)";
  const CURSOR_EDITS = "Would auto-edit; Cursor Auto-reviews instead (can't ask yet)";
  const CURSOR_REVIEW = "Auto-review approves safe calls and denies the rest; Cursor can't ask you yet";
  const CODEX_ASK = "Ask you when an action requires approval; actions allowed by the sandbox run normally";
  const CODEX_EDITS = "Approve file edits automatically; ask you for other actions that require approval";
  const CODEX_REVIEW = "Codex reviews actions that require approval; if denied, you can approve one retry through Auto-review. Actions allowed by the sandbox run normally; the mode's sandbox stays in place.";
  const CODEX_LIMITED = "Web search is off; Codex has no gated fetch for the allowlist";
  /** With the experimental host shell (Agent settings), Scribe runs Cursor's shell commands and asks first. */
  const CURSOR_HOST_ASK = "Would ask first; Cursor asks before each shell command, Auto-reviews other tools";
  const CURSOR_HOST_EDITS = "Would auto-edit; Cursor asks before each shell command, Auto-reviews other tools";
  function approvalDetail(a, provider) {
    if (provider === "cursor" && a.id === "ask" && prefs().cursorHostShell) return CURSOR_HOST_ASK;
    if (provider === "cursor" && a.id === "edits" && prefs().cursorHostShell) return CURSOR_HOST_EDITS;
    if (provider === "cursor" && a.id === "ask") return CURSOR_ASK;
    if (provider === "cursor" && a.id === "edits") return CURSOR_EDITS;
    if (provider === "cursor" && a.id === "auto") return CURSOR_REVIEW;
    if (provider === "codex" && a.id === "ask") return CODEX_ASK;
    if (provider === "codex" && a.id === "edits") return CODEX_EDITS;
    if (provider === "codex" && a.id === "auto") return CODEX_REVIEW;
    if (a.id === "auto" && provider === "pi") return "Workspace edits run automatically; the configured classifier reviews commands and asks when unsure or unavailable. Commands have no OS sandbox.";
    if (a.id === "auto" && provider !== "claude") return "Claude only";
    return a.detail;
  }
  const EXPLORE = new Set(["read", "search", "think"]);
  const SCOPE_KIND = { page: "Page", folder: "Folder", workspace: "Workspace", global: "Global" };
  const SCOPE_CHIP_TITLE = "Page, folder, or workspace this thread belongs to (Ctrl+. next workspace · Ctrl+Shift+. next Scribe access)";
  const LOCAL_SLASH = [
    { name: "clear", description: "New thread with the current page's default chat settings" },
    { name: "here", description: "This thread belongs to the current page" },
    { name: "folder", description: "This thread belongs to the current page's folder" },
    { name: "workspace", description: "Set the workspace folder" },
    { name: "global", description: "Not tied to a page or folder" },
  ];
  const PROVIDER_LABEL = { claude: "Claude", cursor: "Cursor", codex: "Codex", pi: "Native" };
  // The same symbols used by the floating chat orb, drawn as crisp static marks.
  const PROVIDER_MARK = {
    claude: '<path d="M12 3v18M3 12h18M7.5 4.2l9 15.6M4.2 7.5l15.6 9M7.5 19.8l9-15.6M4.2 16.5l15.6-9"/>',
    cursor: '<path d="m12 2 8.7 5v10L12 22l-8.7-5V7L12 2Zm0 10L3.3 7m8.7 5 8.7-5M12 12v10"/>',
    codex: '<path d="m4 6 6 6-6 6m10 0h6"/>',
    pi: '<path d="m4 7 16-.5M9 7 7.5 20M15 7v11l2.5 2"/>',
  };
  function providerIcon(provider) {
    const mark = el("span", `ag-prov p-${provider}`);
    mark.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("focusable", "false");
    svg.innerHTML = PROVIDER_MARK[provider] || '<circle cx="12" cy="12" r="8"/>';
    mark.append(svg);
    return mark;
  }
  const PROVIDERS = ["cursor", "claude", "codex", "pi"];

  /* ---------- state ---------- */

  /** A page in a window of its own (popout.js) has no sidebar: every chat there is the floating one. */
  const SOLO = Boolean(window.scribePopout?.childId);
  /** A child window that is the agent chat on its own (#505): the full window layout, always open, and no floating chat. */
  const CHAT = SOLO && Boolean(window.scribePopout.chatChild);

  const S = {
    config: { providers: [], prefs: null, models: { claude: [], cursor: [], codex: [], pi: [] } },
    threads: new Map(),
    details: new Map(),
    loading: new Map(),
    commands: new Map(),
    current: localStorage.getItem(LS.current) || null,
    sideOpen: !SOLO && localStorage.getItem(LS.side) === "1",
    fullOpen: false,
    dockShown: !CHAT && localStorage.getItem(LS.dock) === "1",
    dockExpanded: false,
    /** Thread the dock uses per page id, when the user picked one. Survives refresh. */
    dockPicks: loadDockPicks(),
    /**
     * Unsent composers of threads no view is showing: { text, mentions, attachments }. The text and
     * chips are saved on the thread too (thread.draft); attached files only live here.
     */
    composers: new Map(),
    filter: ["here", "workspaces", "all", "archived"].includes(localStorage.getItem(LS.filter)) ? localStorage.getItem(LS.filter) : "here",
    search: "",
    hidePageThreads: localStorage.getItem(LS.hidePage) !== "0",
    /** Extra rows revealed per grouping key via "Show 10 more". */
    groupExtra: new Map(),
    /** Grouping keys of the thread list groups the user folded shut. */
    collapsedGroups: new Set(loadCollapsedGroups()),
    lastActiveId: null,
    ready: false,
    /** Forks whose offer to archive the thread they came from was answered or dismissed. */
    forkArchiveSeen: new Set(),
    /** threadId -> the thread's open agent browser: { threadId, tabs: [{ tab, url, title, current }] }. */
    browsers: new Map(),
    /** Workspace folders that are gone: [{ path, threads, found, dismissed }]. found is where a renamed one went. */
    missing: [],
  };

  async function api(method, path, body) {
    const write = method !== "GET";
    const res = await fetch(`/api/agent${path}`, {
      method,
      headers: write ? { "Content-Type": "application/json" } : {},
      body: write ? JSON.stringify(body ?? {}) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      throw new Error(data?.error || `${method} ${path} failed (${res.status})`);
    }
    return data;
  }

  function notice(text) {
    // The toast sits on the floating chat. Skip it when that chat is the one in use.
    if (S.dockShown && !S.fullOpen && (dockFocused() || !S.sideOpen)) return;
    app()?.showNotice?.(text);
  }

  /* ----- moved workspace folders (#338) ----- */

  let missingAt = 0;
  async function loadMissing() {
    missingAt = Date.now();
    try {
      const data = await api("GET", "/workspaces/missing");
      const before = JSON.stringify(S.missing);
      S.missing = data.missing || [];
      if (JSON.stringify(S.missing) !== before) renderLists();
    } catch {
      /* the next check tries again */
    }
  }
  // A folder is usually renamed in another window: look again when this one is used next.
  window.addEventListener("focus", () => {
    if (Date.now() - missingAt > 15000) loadMissing();
  });

  /** The missing folder dir is, or is inside. */
  function missingFor(dir) {
    const key = dirKey(dir);
    return key ? S.missing.find((m) => key === dirKey(m.path) || key.startsWith(`${dirKey(m.path)}/`)) || null : null;
  }

  /** Point every thread and setting of the folder `from` at `to`. */
  async function relocateWorkspace(from, to) {
    try {
      const res = await api("POST", "/workspaces/relocate", { from, to });
      if (res.prefs) S.config.prefs = res.prefs;
      notice([`${R.basename(from)} is now ${R.basename(to)}: ${res.threads === 1 ? "1 thread" : `${res.threads} threads`} updated.`, ...(res.notes || [])].join(" "));
    } catch (err) {
      notice(err.message);
    }
    await loadMissing();
    requestRender();
  }

  /** Ask where a missing folder went, starting at the folder Scribe found or where it used to be. */
  async function locateWorkspace(dir) {
    const entry = missingFor(dir);
    const from = entry?.path || dir;
    const to = await pickWorkspace(entry?.found || from.replace(/[\\/][^\\/]+[\\/]?$/, ""), {
      title: "Where is this folder now?",
      hint: `${from} is gone. Pick the folder it became: its threads, settings and Claude sessions follow.`,
      used: false,
    });
    if (to) await relocateWorkspace(from, to);
  }

  /** "Folder renamed" rows for the top of a thread list: one click updates everything that used the old path. */
  function movedBanners() {
    return S.missing.filter((m) => m.found && !m.dismissed).map((m) => {
      const row = el("div", "ag-ws-moved");
      const text = el("span", "ag-ws-moved-text");
      const was = el("b", null, R.basename(m.path));
      was.dataset.tooltip = m.path;
      const now = el("b", null, R.basename(m.found));
      now.dataset.tooltip = m.found;
      text.append(was, " is now ", now);
      const update = button(m.threads === 1 ? "Update 1 thread" : m.threads ? `Update ${m.threads} threads` : "Update", "ag-btn small primary", () => relocateWorkspace(m.path, m.found), "Threads, settings, worker folders and Claude sessions that used the old path move to the new one");
      const other = button("Other…", "ag-btn small ghost", () => locateWorkspace(m.path), "Pick a different folder");
      const no = button("Ignore", "ag-btn small ghost", async () => {
        await api("POST", "/workspaces/dismiss", { path: m.path }).catch((err) => notice(err.message));
        loadMissing();
      }, "Not the same folder. Its threads keep the old path");
      row.append(text, update, other, no);
      return row;
    });
  }

  /** "working" / "in background" / "done" / "failed" / "stopped" for a task badge. */
  function taskStatusLabel(task) {
    if (task.status === "running") return task.background ? "in background" : "working";
    if (task.status === "error") return "failed";
    return task.status;
  }

  /* ----- attached files ----- */

  /** Same limits as src/agent/attachments.ts, checked here first so a file is refused before it is read. */
  const FILE_LIMITS = { count: 10, image: 8 * 1024 * 1024, file: 20 * 1024 * 1024, total: 50 * 1024 * 1024 };
  const MENTION_LIMIT = 20;

  /** The @ or # token around the caret. Keep in sync with src/agent/mention.ts. query is the typed prefix; start/end cover the whole token. */
  function mentionAt(value, cursor, prefix = "@") {
    const before = value.slice(0, cursor);
    const m = (prefix === "#" ? /(^|[\s])#([^\s#]*)$/ : /(^|[\s])@([^\s@]*)$/).exec(before);
    if (!m) return null;
    const start = before.length - 1 - m[2].length;
    const rest = (prefix === "#" ? /^[^\s#]*/ : /^[^\s@]*/).exec(value.slice(cursor))?.[0] || "";
    return { start, end: cursor + rest.length, query: m[2] };
  }

  /** A slash token at the caret, bounded by whitespace so paths stay ordinary text. */
  function slashAt(value, cursor) {
    const match = /(^|\s)\/([\w:.-]*)$/.exec(value.slice(0, cursor));
    if (!match) return null;
    const rest = /^[\w:.-]*/.exec(value.slice(cursor))[0];
    const end = cursor + rest.length;
    if (end < value.length && !/\s/.test(value[end])) return null;
    return { start: cursor - match[2].length - 1, end, query: match[2] };
  }

  function chipKey(chip) {
    if (chip.kind === "thread") return `thread:${chip.id}`;
    if (chip.kind === "page") return `page:${chip.id}`;
    if (chip.kind === "folder") return `folder:${chip.id}`;
    if (chip.kind === "file") return `file:${chip.path}`;
    return null;
  }

  function chipIcon(chip) {
    if (chip.kind === "thread") return "chat";
    if (chip.kind === "page") return "page";
    if (chip.kind === "folder") return "folder";
    if (chip.kind === "selection") return "quote";
    return "read";
  }

  function chipLabel(chip) {
    if (chip.kind === "thread") return chip.title || "Thread";
    if (chip.kind === "page") return chip.title || chip.key || "Page";
    if (chip.kind === "folder") return chip.path || "Folder";
    if (chip.kind === "file") return R.basename(chip.path) || chip.path;
    if (chip.kind === "selection") {
      const text = String(chip.text || "").replace(/\s+/g, " ");
      return text ? `“${text.slice(0, 40)}${text.length > 40 ? "…" : ""}”` : "Selection";
    }
    return chip.kind;
  }

  function chipTitle(chip) {
    if (chip.kind === "thread") return `Read access to this thread: ${chip.title || chip.id}`;
    if (chip.kind === "selection") return chip.text.length > 600 ? `${chip.text.slice(0, 600)}…` : chip.text;
    return chip.path || chip.key || "";
  }

  function sentFileUrl(threadId, fileId) {
    return `/api/agent/threads/${encodeURIComponent(threadId)}/files/${encodeURIComponent(fileId)}`;
  }

  function base64Url(data, mimeType) {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: mimeType || "application/octet-stream" }));
  }

  /** A file as a chip: a thumbnail for images, an icon and size for the rest. Click previews it. */
  function fileChip(file, onOpen) {
    const isImage = (file.mimeType || "").startsWith("image/");
    // A span, not a button: the composer puts a remove button inside it.
    const chip = el("span", `ag-chip small file${isImage ? " img" : ""}`);
    chip.tabIndex = 0;
    chip.setAttribute("role", "button");
    chip.addEventListener("click", onOpen);
    chip.addEventListener("keydown", (event) => {
      if (event.target !== chip || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      onOpen();
    });
    if (isImage) {
      const thumb = el("img");
      thumb.src = file.url;
      thumb.alt = "";
      thumb.addEventListener("error", () => thumb.replaceWith(icon("image")));
      chip.append(thumb);
    } else {
      chip.append(icon("read"));
    }
    chip.append(el("span", "ag-chip-name", file.name));
    const size = window.scribePreview?.sizeLabel(file.size);
    if (!isImage && size) chip.append(el("span", "ag-chip-size", size));
    return chip;
  }

  function loadCollapsedGroups() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS.collapsed) || "[]");
      return Array.isArray(saved) ? saved.filter((key) => typeof key === "string") : [];
    } catch {
      return [];
    }
  }

  /** The user's own modes (Agent settings, Chat). */
  function customModes() {
    return prefs().customModes || [];
  }

  /** One line on a custom mode (or a thread's copy of one): its base mode and what it turns off. */
  function customDetail(custom, baseId) {
    const base = MODES.find((m) => m.id === baseId) || MODES[0];
    const off = MODE_TOOLS.filter((tool) => (custom.off || []).includes(tool.id)).map((tool) => tool.label.toLowerCase());
    return `${base.label} mode${off.length ? `, without: ${off.join(", ")}` : ""}`;
  }

  /** Where a provider cannot follow a mode as written. Same rules as providerNotes in src/agent/customModes.ts. */
  function customModeNotes(off) {
    const has = (id) => off.includes(id);
    const notes = [];
    if (has("edit") && !has("shell")) notes.push("Claude, Cursor and Native: shell commands can still change files.");
    if (has("edit") && has("shell")) notes.push("Codex keeps its shell for reading, in its read-only sandbox.");
    else if (has("edit") || has("shell")) notes.push(`Codex cannot turn off ${has("edit") ? "edits" : "the shell"} alone: it runs in its read-only sandbox.`);
    if (has("subagents")) notes.push("Codex and Native have no subagents to turn off.");
    return notes;
  }

  function prefs() {
    return S.config.prefs || { provider: "cursor", models: {}, efforts: {}, modelParams: {}, modelSettings: {}, mode: "code", approval: "ask", approvals: {}, web: "on", recentWorkspaces: [], scopeWorkspaces: {} };
  }

  /** The effort and params last picked for this model, else its defaults. Same as modelChoice in src/agent/prefs.ts. */
  function modelChoice(provider, model, p = prefs()) {
    const saved = p.modelSettings?.[`${provider}:${model}`];
    if (saved) return { effort: saved.effort ?? null, modelParams: { ...(saved.modelParams || {}) } };
    return { effort: null, modelParams: provider === "cursor" ? { fast: "false" } : {} };
  }

  /** "on" | "limited" | "off". Older threads and prefs, and pages, may pass a boolean. */
  function webMode(value, fallback = "on") {
    if (value === true || value === "on") return "on";
    if (value === false || value === "off") return "off";
    if (value === "limited") return "limited";
    return fallback;
  }

  function providerAvailable(id) {
    return S.config.providers.some((p) => p.id === id && p.available);
  }

  function modelsOf(provider) {
    return S.config.models[provider] || [];
  }

  /** Keep Native models together by source, in the source list's original order. */
  function modelMenuItems(provider, models, row, suffix = "") {
    const header = `${PROVIDER_LABEL[provider]}${suffix}`;
    if (provider !== "pi" || !models.length) return [{ header, provider }, ...models.map(row)];
    const sources = new Map();
    for (const model of models) {
      // Native ids start with the source/provider id; the model itself may contain slashes.
      const source = model.id.split("/")[0];
      if (!sources.has(source)) sources.set(source, { name: model.description || source, models: [] });
      sources.get(source).models.push(model);
    }
    return [...sources].flatMap(([source, group]) => [
      { header, provider, sourceName: group.name, suffix },
      ...group.models.map((model) => ({ ...row(model), nativeSource: source })),
    ]);
  }

  function modelInfo(provider, id) {
    return modelsOf(provider).find((m) => m.id === id) || null;
  }

  async function loadConfig() {
    try {
      S.config = await api("GET", "/config");
    } catch {
      return;
    }
    loadMissing();
    armUsageTick();
    pageLimitsChanged();
    const models = await Promise.all(PROVIDERS.filter(providerAvailable).map(async (provider) => {
      try { return [provider, await api("GET", `/models?provider=${provider}`)]; }
      catch { return [provider, null]; }
    }));
    for (const [provider, data] of models) {
      if (data?.models?.length) S.config.models[provider] = data.models;
    }
    agentSettings.renderSummarizer();
    requestRender();
  }

  async function loadThreads() {
    try {
      const data = await api("GET", "/threads");
      S.threads = new Map(data.threads.map((t) => [t.id, t]));
      invalidateMessageSearch(); // Reconnects may have missed message events.
    } catch {
      return;
    }
    S.ready = true;
    pruneDockPicks();
    for (const id of [...S.details.keys()]) {
      if (!S.threads.has(id)) S.details.delete(id);
    }
    // A reconnect may have missed events: refresh the details we show.
    const shown = new Set([...views().map((view) => view.threadId).filter(Boolean), ...pageStepWatch.keys()]);
    for (const id of shown) S.details.delete(id);
    requestRender();
    for (const id of shown) {
      if (!S.threads.has(id)) continue;
      ensureDetail(id).then(() => {
        for (const view of views()) if (view.threadId === id) view.renderAll();
        if (dock.view.threadId === id) dock.bindFeed(true);
        pageStepsChanged(id);
      });
    }
  }

  async function ensureDetail(id) {
    if (!id) return null;
    if (S.details.has(id)) return S.details.get(id);
    if (S.loading.has(id)) return S.loading.get(id);
    const load = api("GET", `/threads/${encodeURIComponent(id)}`)
      .then((data) => {
        const detail = { items: data.items, byId: new Map(data.items.map((it) => [it.id, it])), turns: new Map(data.turns.map((t) => [t.id, t])) };
        S.details.set(id, detail);
        S.threads.set(id, data.thread);
        noteWindows(data.thread.provider, data.turns);
        return detail;
      })
      .catch(() => null)
      .finally(() => S.loading.delete(id));
    S.loading.set(id, load);
    return load;
  }

  /* ---------- events ---------- */

  let startupData = null;
  // Boot and the first socket open share one load. Later connections refresh missed data.
  function loadStartupData() {
    return startupData ||= Promise.all([loadConfig(), loadThreads(), loadBrowsers()]);
  }

  window.addEventListener("scribe:agent-event", (event) => onEvent(event.detail));
  window.addEventListener("scribe:connection", (event) => {
    if (event.detail?.connected) {
      loadStartupData();
    } else startupData = null;
  });
  window.addEventListener("scribe:render", () => {
    const active = app()?.activeTab?.()?.id || null;
    if (active !== S.lastActiveId) {
      S.lastActiveId = active;
      dock.syncThread();
      renderLists();
      for (const view of views()) {
        view.renderContext();
        // The presets name the page in front.
        if (!view.thread() && view.transcript?.querySelector(".ag-presets")) view.renderTranscript();
      }
    }
  });

  function onEvent(msg) {
    // Search includes unloaded threads too; handle changes before detail-cache early returns.
    if (msg.type === "agent_item") {
      const prev = S.details.get(msg.item.threadId)?.byId.get(msg.item.id);
      if (!prev || searchableMessageText(prev) !== searchableMessageText(msg.item) || prev.seq !== msg.item.seq) invalidateMessageSearch();
    } else if (msg.type === "agent_delta") {
      const item = S.details.get(msg.threadId)?.byId.get(msg.itemId);
      if (msg.append && (!item || searchableMessageText(item) !== null)) invalidateMessageSearch();
    } else if (msg.type === "agent_item_deleted" || msg.type === "agent_thread_deleted") {
      invalidateMessageSearch();
    }
    switch (msg.type) {
      case "agent_thread": {
        const prev = S.threads.get(msg.thread.id);
        S.threads.set(msg.thread.id, msg.thread);
        for (const view of views()) {
          if (view.threadId === msg.thread.id) view.onThread(msg.thread, prev);
          else if (msg.thread.helperOf && view.threadId === msg.thread.helperOf) view.onHelper(msg.thread);
        }
        if (dockFollowsThread(msg.thread, prev)) dock.syncThread();
        renderLists();
        renderBadge();
        pageThreadChanged(msg.thread, prev);
        if (prev?.status !== msg.thread.status) pageStepsChanged(msg.thread.id);
        return;
      }
      case "agent_thread_deleted": {
        S.threads.delete(msg.id);
        S.details.delete(msg.id);
        S.composers.delete(msg.id);
        for (const view of views()) {
          if (view.threadId === msg.id) view.setThread(null);
          else if (view.helpersBusy) view.renderHelperDock();
        }
        if (S.current === msg.id) setCurrent(null);
        forgetDockThread(msg.id);
        clearTimeout(pageStepWatch.get(msg.id));
        pageStepWatch.delete(msg.id);
        renderLists();
        renderBadge();
        return;
      }
      case "agent_item": {
        const detail = S.details.get(msg.item.threadId);
        if (!detail) return;
        const prev = detail.byId.get(msg.item.id);
        if (prev) {
          const moved = prev.seq !== msg.item.seq;
          Object.assign(prev, msg.item);
          for (const key of Object.keys(prev)) {
            if (!(key in msg.item)) delete prev[key];
          }
          // A steered message moves to the point in the turn where the agent read it.
          if (moved) detail.items.sort((a, b) => a.seq - b.seq);
        } else {
          detail.items.push(msg.item);
          detail.byId.set(msg.item.id, msg.item);
          detail.items.sort((a, b) => a.seq - b.seq);
        }
        for (const view of views()) {
          if (view.threadId === msg.item.threadId) view.onItem(detail.byId.get(msg.item.id), !prev);
        }
        dock.onItem(msg.item);
        pageStepsChanged(msg.item.threadId);
        return;
      }
      case "agent_page_show": {
        // A chat Scribe started for a page (a Kanban worker's card), set to show: only where that page is in front.
        if (app()?.activeTab?.()?.id === msg.pageId) showPageThread(msg.threadId, msg.where);
        return;
      }
      case "agent_limits": {
        S.config.limits = msg.limits || {};
        pageLimitsChanged();
        for (const view of views()) view.renderComposerBar();
        agentSettings.renderUsage();
        armUsageTick();
        return;
      }
      case "agent_item_deleted": {
        const detail = S.details.get(msg.threadId);
        const item = detail?.byId.get(msg.id);
        if (!item) return;
        detail.byId.delete(msg.id);
        detail.items.splice(detail.items.indexOf(item), 1);
        for (const view of views()) {
          if (view.threadId === msg.threadId) view.onItem(item, false);
        }
        return;
      }
      case "agent_delta": {
        const detail = S.details.get(msg.threadId);
        const item = detail?.byId.get(msg.itemId);
        if (!item) return;
        item.text = (item.text || "") + msg.append;
        for (const view of views()) {
          if (view.threadId === msg.threadId) view.onDelta(item);
        }
        dock.onDelta(item);
        pageStepsChanged(msg.threadId);
        return;
      }
      case "agent_intent": {
        // A hook's signal (hooks.ts): for whatever part of the shell acts on that kind of intent.
        const { type: _type, ...intent } = msg;
        window.dispatchEvent(new CustomEvent("scribe:agent-intent", { detail: intent }));
        dock.onIntent(intent);
        return;
      }
      case "agent_browser": {
        if (msg.view) S.browsers.set(msg.threadId, msg.view);
        else S.browsers.delete(msg.threadId);
        for (const view of views()) {
          if (view.threadId === msg.threadId) view.renderHeader();
        }
        return;
      }
      case "agent_turn_deleted": {
        const detail = S.details.get(msg.threadId);
        if (!detail) return;
        detail.turns.delete(msg.id);
        for (const view of views()) {
          if (view.threadId === msg.threadId) view.onTurn({ id: msg.id, threadId: msg.threadId, status: "deleted" });
        }
        return;
      }
      case "agent_turn": {
        const detail = S.details.get(msg.turn.threadId);
        if (!detail) return;
        detail.turns.set(msg.turn.id, msg.turn);
        for (const view of views()) {
          if (view.threadId === msg.turn.threadId) view.onTurn(msg.turn);
        }
        dock.onTurn(msg.turn);
        pageStepsChanged(msg.turn.threadId);
        return;
      }
      default:
        return;
    }
  }

  /* ---------- scope helpers ---------- */

  function activeTab() {
    return app()?.activeTab?.() || null;
  }

  function folderPath(folderId) {
    if (!folderId) return null;
    const folders = app()?.folders?.() || [];
    const byId = new Map(folders.map((f) => [f.id, f]));
    const parts = [];
    let cur = byId.get(folderId);
    let guard = 0;
    while (cur && guard++ < 50) {
      parts.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    return parts.length ? parts.join("/") : null;
  }

  function scopeLabel(scope) {
    if (!scope || scope.kind === "global") return { icon: "globe", text: "Global" };
    if (scope.kind === "page") {
      const tab = app()?.findAnyTab?.(scope.ref);
      return { icon: "page", text: tab ? tab.title : "Missing page" };
    }
    if (scope.kind === "folder") return { icon: "folder", text: folderPath(scope.ref) || "Missing folder" };
    // No Scribe scope: the thread is only tied to its workspace, if any.
    if (!scope.ref) return { icon: "close", text: "No scope" };
    return { icon: "box", text: R.basename(scope.ref) || scope.ref };
  }

  /**
   * Scribe access, then the workspace folder when that is a separate pick (not already the scope).
   * With both, the Scribe part sits in .ag-scope-main so a tight spot (the dock) can drop it and keep the workspace.
   */
  function fillScopeDisplay(node, scope, cwd) {
    const sc = scopeLabel(scope);
    const dir = cwd || (scope?.kind === "workspace" ? scope.ref : null);
    if (!dir || scope?.kind === "workspace") {
      node.replaceChildren(icon(sc.icon), el("span", null, sc.text));
      return;
    }
    const main = el("span", "ag-scope-main");
    main.append(icon(sc.icon), el("span", "ag-scope-text", sc.text), el("span", "ag-scope-sep", "·"));
    node.replaceChildren(main, icon("box"), el("span", null, R.basename(dir) || dir));
  }

  function dirKey(dir) {
    return String(dir || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  /**
   * The transcript group an item renders in: its turn, or the queued group pinned to the end. A note
   * outside any turn (a worktree merge) is its own group where it happened, so it does not stay
   * pinned under every later turn.
   */
  function itemGroupKey(item) {
    if (item.turnId) return item.turnId;
    if (item.dropped) return `dropped:${item.id}`;
    return item.kind === "user" ? "pending" : `note:${item.id}`;
  }

  /** The thread's worktree while it is open. */
  function openWorktree(t) {
    return t?.worktree && !t.worktree.closed ? t.worktree : null;
  }

  /** The folder a thread works on in the main checkout, also while it runs in a worktree. */
  function homeDir(t) {
    return openWorktree(t)?.home || t?.cwd || null;
  }

  /** Keep in step with src/agent/pageChat.ts. Last AI reply older than this: opening the floating chat on a page starts a new thread. */
  const PAGE_CHAT_STALE_MS = 2 * 60 * 60 * 1000;

  /** Workspace for a new thread on this page: the page's own (from the thread that made it, or set by the user). */
  function pageWorkspace(pageId) {
    return (pageId && app()?.findAnyTab?.(pageId)?.workspace) || null;
  }

  function pageThreadIsStale(t, now) {
    if (!t || t.status === "running" || t.status === "waiting") return false;
    if (!t.finishedAt) return false;
    return t.finishedAt < now - PAGE_CHAT_STALE_MS;
  }

  /**
   * Which thread the floating chat should show on this page, or null to start a new one. `pick` is
   * the user's choice there ({ id, at }; id null for a new thread they started), fresh for two hours from `at`.
   */
  function pageDockThreadId(tabId, pick, now) {
    if (pick && pick.id === null) return null;
    const picked = pick?.id ? S.threads.get(pick.id) : null;
    if (picked && !picked.archived) {
      const last = Math.max(picked.finishedAt || 0, pick.at || 0);
      return pageThreadIsStale({ status: picked.status, finishedAt: last || undefined }, now) ? null : picked.id;
    }
    if (!tabId) return null;
    const t = [...S.threads.values()].filter((x) => !x.archived && x.scope.kind === "page" && x.scope.ref === tabId).sort((a, b) => b.activityAt - a.activityAt)[0];
    return t && !pageThreadIsStale(t, now) ? t.id : null;
  }

  function deletePrompt(t) {
    const wt = openWorktree(t);
    const extra = wt ? ` Its worktree folder is removed too; the work stays on branch ${wt.branch}, with uncommitted changes committed there first.` : "";
    return `Delete “${t.title}”? This removes its transcript from Scribe.${extra}`;
  }

  function archiveThread(t) {
    api("PATCH", `/threads/${t.id}`, { archived: !t.archived }).catch((e) => notice(e.message));
  }

  /** A new thread that goes on from this one; `open` shows it. */
  async function forkThread(t, open, patch = {}) {
    try {
      const { thread } = await api("POST", `/threads/${encodeURIComponent(t.id)}/fork`, patch);
      S.threads.set(thread.id, thread);
      S.details.set(thread.id, { items: [], byId: new Map(), turns: new Map() });
      open(thread.id);
    } catch (err) {
      notice(err.message);
    }
  }

  async function deleteThread(t) {
    if (!(await app().confirm(deletePrompt(t)))) return;
    await api("DELETE", `/threads/${t.id}`).catch((e) => notice(e.message));
  }

  /** A thread whose composer has something unsent in it, here or saved on the thread. */
  function hasDraft(t) {
    return Boolean(t.draft || S.composers.has(t.id));
  }

  /**
   * Save an unsent composer's text and chips on its thread, so the list can mark it and a reload
   * keeps it. A draft thread that was emptied again goes away.
   */
  function syncThreadDraft(t, content) {
    const draft = content ? { text: content.text, context: content.mentions } : null;
    const was = t.draft ? JSON.stringify({ text: t.draft.text, context: t.draft.context || [] }) : null;
    if (was === (draft && JSON.stringify(draft))) return;
    const unsentOnly = Boolean(t.draft) && !draft && t.stats.turns === 0 && !t.queued && t.status === "idle";
    t.draft = draft;
    if (unsentOnly) api("DELETE", `/threads/${encodeURIComponent(t.id)}`).catch(() => undefined);
    else api("PATCH", `/threads/${encodeURIComponent(t.id)}`, { draft }).catch(() => undefined);
    renderLists();
  }

  /** Keep a new thread the user wrote in and left unsent as a draft thread. Its files stay in this window. */
  async function saveDraftThread(s, content, tab) {
    try {
      const { thread } = await api("POST", "/threads", {
        provider: s.provider,
        model: s.model,
        effort: s.effort,
        modelParams: s.modelParams,
        mode: s.mode,
        customMode: s.custom?.id ?? null,
        approval: s.approval,
        web: s.web,
        cwd: s.cwd,
        useWorktree: Boolean(s.useWorktree),
        scope: s.scope,
        draft: { text: content.text, context: content.mentions },
        remember: false,
      });
      S.threads.set(thread.id, thread);
      S.composers.set(thread.id, content);
      // The floating chat comes back to it on that page, unless it has moved on to another thread there.
      if (tab && !S.dockPicks.get(tab)?.id && !(dock.view.draft && dock.view.draftTab === tab)) setDockPick(tab, thread.id);
      renderLists();
    } catch (err) {
      notice(`Could not keep the unsent thread: ${err.message}`);
    }
  }

  /** Last used folders, with `prefer` first when it is not already among them. */
  function recentWorkspaceDirs(prefer) {
    const out = [];
    const seen = new Set();
    const add = (dir) => {
      if (!dir) return;
      const key = dirKey(dir);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(dir);
    };
    add(prefer);
    const hidden = hiddenWorkspaceKeys();
    for (const dir of prefs().recentWorkspaces || []) if (!hidden.has(dirKey(dir))) add(dir);
    return out.slice(0, 3);
  }

  /**
   * Disk folder a thread belongs to: the one it works in (the main checkout's, for a worktree), else
   * its workspace scope. Keep in step with threadFolder in src/agent/host.ts.
   */
  function workspaceDir(t) {
    return homeDir(t) || (t.scope?.kind === "workspace" ? t.scope.ref : null) || null;
  }

  /** Workspace folders the user hid (the group's menu in the thread list), by dirKey. */
  function hiddenWorkspaceKeys() {
    return new Set((prefs().hiddenWorkspaces || []).map(dirKey));
  }

  /**
   * A thread its hidden workspace takes out of the lists. A page's or folder's own threads stay with
   * that page or folder; only the Workspaces list drops them.
   */
  function inHiddenWorkspace(t, hidden = hiddenWorkspaceKeys(), every = false) {
    if (!hidden.size || !(every || t.scope.kind === "global" || t.scope.kind === "workspace")) return false;
    const dir = workspaceDir(t);
    return Boolean(dir) && hidden.has(dirKey(dir));
  }

  /** Threads of a workspace folder, archived ones and helpers included. */
  function workspaceThreads(dir) {
    const key = dirKey(dir);
    return [...S.threads.values()].filter((t) => {
      const own = workspaceDir(t);
      return Boolean(own) && dirKey(own) === key;
    });
  }

  async function setWorkspaceHidden(dir, hidden) {
    try {
      const data = await api("POST", "/workspaces/hide", { path: dir, hidden });
      S.config.prefs = data.prefs;
      renderLists();
      if (hidden) notice(`Hid ${R.basename(dir) || dir}. It is listed under Archived, and a search still finds its threads.`);
    } catch (err) {
      notice(err.message);
    }
  }

  async function deleteWorkspace(dir) {
    const threads = workspaceThreads(dir);
    const n = threads.length;
    const running = threads.filter((t) => t.status !== "idle").length;
    const worktrees = threads.some((t) => openWorktree(t));
    const parts = [
      `Delete the workspace “${R.basename(dir) || dir}” from Scribe?`,
      n ? `${n === 1 ? "Its thread is" : `Its ${n} threads are`} deleted for good, with ${n === 1 ? "its transcript" : "their transcripts"}.` : "It has no threads left.",
      running ? `${running === 1 ? "1 of them is" : `${running} of them are`} still working and will be stopped.` : "",
      worktrees ? "Their worktree folders are removed; the work stays on their branches." : "",
      "Token, cost and usage numbers are kept for statistics. The folder on disk is not touched.",
    ];
    if (!(await app().confirm(parts.filter(Boolean).join(" "), "Delete workspace"))) return;
    try {
      const data = await api("POST", "/workspaces/delete", { path: dir });
      S.config.prefs = data.prefs;
      renderLists();
    } catch (err) {
      notice(err.message);
    }
  }

  /** Hide or delete a workspace, from the ⋯ button next to it. */
  function workspaceMenu(anchor, dir) {
    const hidden = hiddenWorkspaceKeys().has(dirKey(dir));
    openMenu(anchor, [
      { header: R.basename(dir) || dir },
      hidden
        ? { label: "Show workspace", detail: "Back in the thread list and the workspace menus", run: () => setWorkspaceHidden(dir, false) }
        : { label: "Hide workspace", detail: "Out of the thread list and the workspace menus. A search still finds its threads.", run: () => setWorkspaceHidden(dir, true) },
      { separator: true },
      { label: "Delete workspace…", detail: "Deletes all its threads for good", danger: true, run: () => deleteWorkspace(dir) },
    ], { width: 280 });
  }

  /** Unique disk folders that existing (non-archived) threads are attached to. Hidden workspaces are left out. */
  function threadWorkspaces() {
    const byKey = new Map();
    const hidden = hiddenWorkspaceKeys();
    for (const t of S.threads.values()) {
      if (t.archived) continue;
      const dir = workspaceDir(t);
      if (!dir || hidden.has(dirKey(dir))) continue;
      const key = dirKey(dir);
      const cur = byKey.get(key);
      if (cur) cur.n++;
      else byKey.set(key, { path: dir, n: 1 });
    }
    return [...byKey.values()].sort((a, b) => b.n - a.n || a.path.localeCompare(b.path));
  }

  /** What the presets in an empty chat set (Agent settings turns them off). */
  const PAGE_PRESET = { mode: "board", web: "on" };
  const WORKSPACE_PRESET = { mode: "code", approval: "auto", web: "limited", useWorktree: false };

  /** Workspaces offered as presets: last used first, then the other folders threads are attached to. */
  function presetWorkspaces() {
    const byKey = new Map();
    const hidden = hiddenWorkspaceKeys();
    for (const dir of [...(prefs().recentWorkspaces || []), ...threadWorkspaces().map((w) => w.path)]) {
      if (dir && !hidden.has(dirKey(dir)) && !byKey.has(dirKey(dir))) byKey.set(dirKey(dir), dir);
    }
    return [...byKey.values()].slice(0, 6);
  }

  function sameScope(a, b) {
    return a && b && a.kind === b.kind && (a.ref || null) === (b.ref || null);
  }

  /** The dock should stay on this chat after it moved onto the page now in front. */
  function dockFollowsThread(thread, prev) {
    if (!prev && dock.draftMatches(thread)) return true;
    const tab = activeTab();
    if (!tab || thread.archived) return false;
    if (thread.scope.kind !== "page" || thread.scope.ref !== tab.id) return false;
    const wasHere = prev && prev.scope.kind === "page" && prev.scope.ref === tab.id;
    if (wasHere) return false;
    return dock.view.threadId === thread.id || dock.draftMatches(thread) || !dock.view.threadId;
  }

  /**
   * The Here group a thread falls in, or null when it is not relevant to what the user is looking at:
   * this page (its threads and the one that made it), its folders, the page's workspace, and global.
   * A thread shows once, in the first of those that fits.
   */
  function hereGroup(thread, tab = activeTab()) {
    const scope = thread.scope;
    if (tab && ((scope.kind === "page" && scope.ref === tab.id) || thread.id === tab.provenance?.created?.thread)) return `page:${tab.id}`;
    if (tab && scope.kind === "folder") {
      const folders = app()?.folders?.() || [];
      const byId = new Map(folders.map((f) => [f.id, f]));
      let cur = tab.folderId ? byId.get(tab.folderId) : null;
      while (cur) {
        if (cur.id === scope.ref) return `folder:${scope.ref}`;
        cur = cur.parentId ? byId.get(cur.parentId) : null;
      }
    }
    const dir = tab?.workspace ? workspaceDir(thread) : null;
    if (dir && dirKey(dir) === dirKey(tab.workspace)) return `ws:${dirKey(dir)}`;
    return scope.kind === "global" ? "global" : null;
  }

  function hereMatch(thread) {
    return hereGroup(thread) !== null;
  }

  function threadRank(t) {
    return (t.pinned ? 1e15 : 0) + t.activityAt;
  }

  /** Title, scope label, and workspace path — same haystack the thread list search uses. */
  function threadSearchHaystack(t) {
    return `${t.title} ${scopeLabel(t.scope).text} ${workspaceDir(t) || ""}`.toLowerCase();
  }

  /** Keep in sync with src/agent/threadSearch.ts */
  const QUERY_STOPWORDS = new Set(["a", "an", "the", "my", "me", "your", "our", "page", "pages", "tab", "tabs", "board", "html", "list", "lists", "updated", "update", "please", "show"]);
  function searchWords(q) {
    const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    const useful = words.filter((word) => !QUERY_STOPWORDS.has(word));
    return [...new Set(useful.length ? useful : words)].slice(0, 10);
  }

  /** What the daemon found in threads' messages, by query. The list itself only knows titles. */
  const messageSearch = { cache: new Map(), last: new Map(), timer: 0, cancel: null, generation: 0, refreshTimer: 0 };

  /** Match the searchable-text exclusions in src/agent/db.ts. */
  function searchableMessageText(item) {
    return (item.kind === "user" || item.kind === "text") && !item.dropped && item.parentToolId == null ? item.text ?? "" : null;
  }

  function cancelMessageSearch() {
    ++messageSearch.generation;
    clearTimeout(messageSearch.timer);
    messageSearch.cancel?.();
    messageSearch.cancel = null;
  }

  function invalidateMessageSearch() {
    cancelMessageSearch();
    messageSearch.cache.clear();
    messageSearch.last = new Map();
    // Coalesce streaming changes; refresh visible searches after the burst settles.
    clearTimeout(messageSearch.refreshTimer);
    messageSearch.refreshTimer = setTimeout(() => {
      renderLists();
      if (S.search) void searchMessages(S.search).then((fresh) => fresh && renderLists());
      window.dispatchEvent(new CustomEvent("scribe:thread-search-invalidated"));
    }, 180);
  }

  /** Ask the daemon which threads' messages mention the words. Resolves true when there are new hits to show. */
  function searchMessages(q) {
    const key = searchWords(q).join(" ");
    cancelMessageSearch();
    const generation = messageSearch.generation;
    const had = messageSearch.cache.get(key);
    if (!key) return Promise.resolve(false);
    if (had && Date.now() - had.at < 30_000) {
      messageSearch.last = had.hits;
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      messageSearch.cancel = () => resolve(false);
      messageSearch.timer = setTimeout(async () => {
        try {
          const data = await api("GET", `/thread-search?q=${encodeURIComponent(key)}`);
          if (generation !== messageSearch.generation) return resolve(false);
          const hits = new Map((data.hits || []).map((hit) => [hit.id, hit]));
          messageSearch.cache.delete(key);
          messageSearch.cache.set(key, { at: Date.now(), hits });
          if (messageSearch.cache.size > 8) messageSearch.cache.delete(messageSearch.cache.keys().next().value);
          messageSearch.last = hits;
          messageSearch.cancel = null;
          resolve(true);
        } catch {
          if (generation === messageSearch.generation) messageSearch.cancel = null;
          resolve(false);
        }
      }, 180);
    });
  }

  let preparedThreadQuery = null;
  function threadQuery(q) {
    if (preparedThreadQuery?.q !== q) {
      const words = searchWords(q);
      preparedThreadQuery = { q, words, phrase: words.join(" "), sequence: words.join("") };
    }
    return { ...preparedThreadQuery, hits: messageSearch.cache.get(preparedThreadQuery.phrase)?.hits || messageSearch.last };
  }

  function titleSequence(title, sequence) {
    if (!sequence || sequence.length > title.length) return false;
    let at = 0;
    for (const ch of title) {
      if (ch === sequence[at] && ++at === sequence.length) return true;
    }
    return false;
  }

  /** Title matches outrank scope/message matches; pinning and recency only break ties. */
  function threadMatch(t, query) {
    const { words, phrase, sequence, hits } = query;
    if (!words.length) return { score: 0, snippet: "" };
    const title = t.title.toLowerCase();
    const inTitle = words.filter((word) => title.includes(word)).length;
    if (inTitle === words.length) return { score: title === phrase ? 100 : 80, snippet: "" };
    if (titleSequence(title, sequence)) return { score: 55, snippet: "" };
    const hay = threadSearchHaystack(t);
    const hit = hits.get(t.id);
    if (!words.every((word) => hay.includes(word) || hit?.words.includes(word))) return null;
    const inMetadata = words.every((word) => hay.includes(word));
    return { score: (inMetadata ? 25 : 10) + 20 * inTitle / words.length, snippet: !inMetadata && hit ? hit.snippet : "" };
  }

  /** Prepare once and score each thread once, outside the sort comparator. */
  function rankedThreads(threads, q) {
    const query = threadQuery(q);
    return threads.map((thread) => ({ thread, match: threadMatch(thread, query) }))
      .filter((row) => row.match)
      .sort((a, b) => b.match.score - a.match.score || threadRank(b.thread) - threadRank(a.thread));
  }

  /** The message text that made a search find a thread; "" when its title or metadata matches. */
  function threadMatchSnippet(t, q) {
    return threadMatch(t, threadQuery(q))?.snippet || "";
  }

  /** Keep in sync with src/agent/threadList.ts */
  const LIST_PAGE = 10;
  const LIST_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

  function windowGroup(threads, { extra = 0, now, currentId, searching, hidePage }) {
    const hide = Boolean(hidePage) && !searching;
    const activeWorker = (t) => t.fromPage && (t.status === "running" || t.status === "waiting");
    const pool = hide ? threads.filter((t) => !t.fromPage || activeWorker(t) || t.pinned || t.id === currentId) : threads;
    if (searching) return { visible: pool, hidden: 0 };
    const keep = new Set();
    for (const t of pool) {
      if (activeWorker(t) || t.pinned || t.id === currentId) keep.add(t.id);
    }
    const recent = [];
    const older = [];
    for (const t of pool) {
      if (now - threadWhenMs(t) <= LIST_RECENT_MS) recent.push(t);
      else older.push(t);
    }
    const base = recent.slice(0, LIST_PAGE);
    const seen = new Set(base.map((t) => t.id));
    const rest = [];
    for (const t of [...recent, ...older]) {
      if (!seen.has(t.id)) rest.push(t);
    }
    for (const t of [...base, ...rest.slice(0, extra)]) keep.add(t.id);
    const visible = pool.filter((t) => keep.has(t.id));
    return { visible, hidden: pool.length - visible.length };
  }

  function setCurrent(id) {
    S.current = id;
    if (id) localStorage.setItem(LS.current, id);
    else localStorage.removeItem(LS.current);
  }

  /** Per page: the floating chat's thread the user chose there, { id, at }, with id null for a new thread. */
  function loadDockPicks() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LS.dockPicks) || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
      const out = new Map();
      for (const [tabId, v] of Object.entries(parsed)) {
        // Older saves kept only the thread id.
        if (typeof v === "string" && v) out.set(tabId, { id: v, at: 0 });
        else if (v && typeof v === "object" && (v.id === null || typeof v.id === "string")) out.set(tabId, { id: v.id || null, at: Number(v.at) || 0 });
      }
      return out;
    } catch {
      return new Map();
    }
  }

  function saveDockPicks() {
    localStorage.setItem(LS.dockPicks, JSON.stringify(Object.fromEntries(S.dockPicks)));
  }

  /** The user chose this thread (null: a new thread) in the floating chat on this page; it stays for two hours from now. */
  function setDockPick(tabId, threadId) {
    if (!tabId || threadId === undefined || threadId === "") return;
    S.dockPicks.set(tabId, { id: threadId, at: Date.now() });
    saveDockPicks();
  }

  function forgetDockThread(threadId) {
    let changed = false;
    for (const [tabId, pick] of [...S.dockPicks]) {
      if (pick.id === threadId) {
        S.dockPicks.delete(tabId);
        changed = true;
      }
    }
    if (changed) saveDockPicks();
  }

  function pruneDockPicks() {
    let changed = false;
    for (const [tabId, pick] of [...S.dockPicks]) {
      if (pick.id && !S.threads.has(pick.id)) {
        S.dockPicks.delete(tabId);
        changed = true;
      }
    }
    if (changed) saveDockPicks();
  }

  /* ---------- generic popover menu ---------- */

  let openMenuEl = null;
  let openMenuAnchor = null;

  function closeMenu() {
    if (openMenuEl) {
      openMenuEl.remove();
      openMenuEl = null;
      openMenuAnchor = null;
      document.removeEventListener("mousedown", onMenuOutside, true);
    }
  }

  function onMenuOutside(event) {
    if (!openMenuEl || openMenuEl.contains(event.target)) return;
    // A left press on the menu's own button is left to its click, which toggles the menu shut.
    if (event.button === 0 && openMenuAnchor?.contains(event.target)) return;
    if (event.button === 0 && !openMenuAnchor?.isConnected && openMenuAnchor?.className && event.target.closest?.("button")?.className === openMenuAnchor.className) return;
    closeMenu();
  }
  // Clicks inside a page iframe never reach this document; they do take focus, so blur closes the menu
  // and collapses the floating chat's expanded conversation.
  window.addEventListener("blur", () => {
    closeMenu();
    for (const view of views()) {
      if (view.hidePicker) view.hidePicker();
      else if (view.slash) view.slash.hidden = true;
    }
    queueMicrotask(() => {
      if (document.activeElement?.tagName === "IFRAME") dock.collapseOutside(document.activeElement);
    });
  });

  /**
   * items: { label, detail?, checked?, icon?, danger?, disabled?, run?, header?, separator? }
   * Opening again from the anchor whose menu is already open closes it instead.
   */
  function openMenu(anchor, items, { search = false, width = 260, placeholder = "Search", pageSize = Infinity } = {}) {
    // A re-render can swap the menu's button for a new one of the same kind while the menu stays open.
    if (openMenuEl && (openMenuAnchor === anchor || (!openMenuAnchor?.isConnected && openMenuAnchor?.className === anchor.className))) {
      closeMenu();
      return null;
    }
    closeMenu();
    const menu = el("div", `ag-menu${search ? " ag-menu-keyed" : ""}`);
    menu.style.width = `${width}px`;
    const list = el("div", "ag-menu-list");
    let filter = "";
    let visibleLimit = pageSize;
    let active = 0;
    let lastPointer = { x: -1, y: -1 };
    const rows = () => [...list.querySelectorAll(".ag-menu-item:not(:disabled)")];
    const highlight = (scroll = true) => {
      const items = rows();
      if (!items.length) return;
      active = ((active % items.length) + items.length) % items.length;
      items.forEach((row, i) => row.classList.toggle("ag-menu-active", i === active));
      if (scroll) items[active]?.scrollIntoView({ block: "nearest" });
    };
    const renderItems = () => {
      list.replaceChildren();
      const q = filter.trim().toLowerCase();
      // searchOnly: a row left out of the plain list that a search still finds.
      const matches = items.filter((item) => item.header || item.separator || (!q ? !item.searchOnly :
        `${item.label} ${item.detail || ""} ${item.search || ""}`.toLowerCase().includes(q)));
      let count = 0;
      const visible = matches.filter((item) => item.header || item.separator || item.fixed || ++count <= visibleLimit);
      const nativeSources = new Set(visible.map((item) => item.nativeSource).filter(Boolean));
      if (count > visibleLimit) visible.push({
        label: "Show more",
        more: true,
        keep: true,
        run: () => { visibleLimit += pageSize; },
      });
      let lastHeader = null;
      for (const item of visible) {
        if (item.header) {
          const heading = item.sourceName && nativeSources.size > 1
            ? `Native (${item.sourceName})${item.suffix || ""}` : item.header;
          lastHeader = el("div", "ag-menu-head", heading);
          if (item.provider) lastHeader.prepend(providerIcon(item.provider));
          continue;
        }
        if (item.separator) {
          if (!q) list.append(el("div", "ag-menu-sep"));
          continue;
        }
        if (!item.more && lastHeader) {
          list.append(lastHeader);
          lastHeader = null;
        }
        const row = el("button", `ag-menu-item${item.checked ? " on" : ""}${item.danger ? " danger" : ""}${item.sub && !q ? " sub" : ""}`);
        row.type = "button";
        row.disabled = Boolean(item.disabled);
        if (search) row.tabIndex = -1;
        if (item.icon) row.append(icon(item.icon));
        const text = el("span", "ag-menu-text");
        const labelEl = el("span", "ag-menu-label", item.label);
        text.append(labelEl);
        if (item.detail) text.append(el("span", "ag-menu-detail", item.detail));
        row.append(text);
        // Ellipsis on the label or hint: hover shows the full string.
        row.addEventListener("pointerover", () => {
          const cut = (node) => node && node.scrollWidth > node.clientWidth + 1;
          const detailEl = text.querySelector(".ag-menu-detail");
          if (cut(detailEl)) row.dataset.tooltip = item.detail;
          else if (cut(labelEl)) row.dataset.tooltip = item.label;
          else row.removeAttribute("data-tooltip");
        });
        if (item.checked) row.append(icon("check", "ag-ico ag-menu-check"));
        if (item.star) {
          const star = el("span", `ag-star${item.star.on ? " on" : ""}`, item.star.on ? "★" : "☆");
          star.dataset.tooltip = item.star.on ? "Remove from favourites" : "Add to favourites (Ctrl+' cycles them)";
          star.addEventListener("click", (event) => {
            // Starring keeps the menu open.
            event.stopPropagation();
            event.preventDefault();
            item.star.on = !item.star.on;
            star.classList.toggle("on", item.star.on);
            star.textContent = item.star.on ? "★" : "☆";
            item.star.toggle(item.star.on);
          });
          row.append(star);
        }
        row.addEventListener("click", () => {
          if (!item.keep) {
            closeMenu();
            item.run?.();
            return;
          }
          // A pick in a group (one of several in the menu) keeps the menu open for the others.
          for (const other of items) if (other.group && other.group === item.group) other.checked = other === item;
          item.run?.();
          renderItems();
        });
        if (item.keep) row.addEventListener("dblclick", () => closeMenu());
        if (search) {
          // The pointer moves the one highlight; a list scrolling under a still pointer doesn't.
          row.addEventListener("pointermove", (event) => {
            if (event.clientX === lastPointer.x && event.clientY === lastPointer.y) return;
            lastPointer = { x: event.clientX, y: event.clientY };
            const at = rows().indexOf(row);
            if (at < 0 || at === active) return;
            active = at;
            highlight(false);
          });
        }
        list.append(row);
      }
      if (!list.childElementCount) list.append(el("div", "ag-menu-empty", "Nothing matches"));
      if (search) {
        active = 0;
        highlight();
      }
      if (menu.isConnected) positionMenu();
    };
    if (search) {
      const input = el("input", "ag-menu-search");
      input.type = "search";
      input.placeholder = placeholder;
      input.addEventListener("input", () => {
        filter = input.value;
        visibleLimit = pageSize;
        renderItems();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const items = rows();
          if (!items.length) return;
          active += event.key === "ArrowDown" ? 1 : -1;
          highlight();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          const items = rows();
          (items[active] || items[0])?.click();
        }
      });
      menu.append(input);
      setTimeout(() => input.focus(), 0);
    }
    menu.append(list);
    renderItems();
    document.body.append(menu);
    function positionMenu() {
      menu.style.maxHeight = `${window.innerHeight - 24}px`;
      const rect = anchor.getBoundingClientRect();
      const mh = Math.min(menu.offsetHeight, window.innerHeight - 24);
      let top = rect.bottom + 6;
      if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 6);
      const left = Math.min(rect.left, window.innerWidth - width - 8);
      menu.style.top = `${Math.max(8, top)}px`;
      menu.style.left = `${Math.max(8, left)}px`;
    }
    positionMenu();
    openMenuEl = menu;
    openMenuAnchor = anchor;
    setTimeout(() => document.addEventListener("mousedown", onMenuOutside, true), 0);
    return menu;
  }

  /* ---------- modal helper ---------- */

  function modal(cls, onClose, canClose) {
    const root = el("div", `ag-modal ${cls}`);
    const backdrop = el("div", "ag-modal-backdrop");
    const panel = el("div", "ag-modal-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    root.append(backdrop, panel);
    let releaseTrap = null;
    const close = () => {
      if (!root.isConnected || (canClose && !canClose())) return;
      releaseTrap?.();
      releaseTrap = null;
      root.remove();
      modalStack.splice(modalStack.indexOf(close), 1);
      onClose?.();
    };
    backdrop.addEventListener("mousedown", (event) => {
      event.preventDefault();
      close();
    });
    modalStack.push(close);
    document.body.append(root);
    requestAnimationFrame(() => {
      if (!root.isConnected) return;
      releaseTrap = window.scribeFocusTrap?.bind(panel);
    });
    return { root, panel, close };
  }
  const modalStack = [];

  /* ---------- questions: ask_user and the providers' own ---------- */

  /** What the user has entered so far, per question item: kept across re-renders and the form dialog. */
  const questionDrafts = new Map();
  const questionForms = new Map();
  function questionDraft(id) {
    let draft = questionDrafts.get(id);
    if (!draft) questionDrafts.set(id, (draft = { picks: new Map(), values: new Map(), notes: new Map(), onChange: null }));
    return draft;
  }
  const questionType = (q) => q.type || "choice";
  function questionAnswered(q, draft) {
    if (questionType(q) === "choice") return (draft.picks.get(q.id) || []).length > 0 || Boolean(draft.notes.get(q.id)?.trim());
    return Boolean((draft.values.get(q.id) || "").trim());
  }
  /** An answer as the user gave it: option labels for choices, the value otherwise. */
  function questionAnswerText(q, values) {
    return questionType(q) === "choice" ? values.map((id) => q.options.find((o) => o.id === id)?.label || id) : values.filter((v) => v.trim());
  }

  /** The questions as fields that write into the draft. */
  function questionFields(it, draft, onChange, numbered) {
    const list = el("div", "ag-q-list");
    it.questions.forEach((q, index) => {
      const block = el("div", "ag-q");
      block.dataset.q = q.id;
      const changed = () => {
        block.classList.remove("missing");
        onChange?.();
        draft.onChange?.();
      };
      const top = el("div", "ag-q-top");
      if (numbered) top.append(el("span", "ag-q-num", String(index + 1)));
      if (q.header) top.append(el("span", "ag-q-header", q.header));
      if (q.optional) top.append(el("span", "ag-q-optional", "Optional"));
      if (top.childElementCount) block.append(top);
      block.append(el("div", "ag-q-prompt", q.prompt));
      const type = questionType(q);
      if (type === "choice") {
        const opts = el("div", `ag-q-opts${q.multi ? " multi" : ""}`);
        const sync = () => {
          const cur = new Set(draft.picks.get(q.id) || []);
          for (const x of opts.children) {
            x.classList.toggle("on", cur.has(x.dataset.opt));
            x.setAttribute("aria-pressed", String(cur.has(x.dataset.opt)));
          }
        };
        for (const o of q.options) {
          const b = button("", "ag-q-opt", () => {
            const cur = new Set(draft.picks.get(q.id) || []);
            if (q.multi) {
              if (cur.has(o.id)) cur.delete(o.id);
              else cur.add(o.id);
            } else {
              const was = cur.has(o.id);
              cur.clear();
              if (!was) cur.add(o.id);
            }
            draft.picks.set(q.id, [...cur]);
            sync();
            changed();
          });
          b.dataset.opt = o.id;
          b.append(el("span", "ag-q-mark"));
          const text = el("span", "ag-q-opt-text");
          text.append(el("span", "ag-q-label", o.label));
          if (o.description) text.append(el("span", "ag-q-desc", o.description));
          b.append(text);
          opts.append(b);
        }
        sync();
        block.append(opts);
      } else if (type === "scale") {
        const min = q.min ?? 1;
        const max = q.max ?? 5;
        const row = el("div", "ag-q-scale");
        row.style.setProperty("--steps", String(max - min + 1));
        const sync = () => {
          for (const x of row.children) x.classList.toggle("on", x.dataset.value === draft.values.get(q.id));
        };
        for (let v = min; v <= max; v++) {
          const b = button(String(v), "ag-q-step", () => {
            draft.values.set(q.id, draft.values.get(q.id) === String(v) ? "" : String(v));
            sync();
            changed();
          });
          b.dataset.value = String(v);
          row.append(b);
        }
        sync();
        block.append(row);
        if (q.minLabel || q.maxLabel) {
          const ends = el("div", "ag-q-scale-ends");
          ends.append(el("span", null, q.minLabel || ""), el("span", null, q.maxLabel || ""));
          block.append(ends);
        }
      } else {
        const long = type === "text" && q.long;
        const input = el(long ? "textarea" : "input", "ag-input ag-q-input");
        if (long) input.rows = 4;
        if (type === "number") {
          input.type = "number";
          input.step = "any";
          if (q.min !== undefined) input.min = String(q.min);
          if (q.max !== undefined) input.max = String(q.max);
        }
        input.placeholder = q.placeholder || (type === "number" ? "A number" : "Your answer");
        input.value = draft.values.get(q.id) || "";
        input.addEventListener("input", () => {
          draft.values.set(q.id, input.value);
          changed();
        });
        block.append(input);
      }
      if (type !== "text") {
        const other = el("input", "ag-input small ag-q-note");
        other.placeholder = type === "choice" ? "Other / add detail" : "Add detail";
        other.value = draft.notes.get(q.id) || "";
        other.addEventListener("input", () => {
          draft.notes.set(q.id, other.value);
          changed();
        });
        block.append(other);
      }
      list.append(block);
    });
    return list;
  }

  /** Sends the answers; marks unanswered required questions instead. Resolves true once sent. */
  async function submitQuestion(it, draft, root) {
    const missing = it.questions.filter((q) => !q.optional && !questionAnswered(q, draft));
    if (missing.length) {
      for (const q of missing) root.querySelector(`.ag-q[data-q="${CSS.escape(q.id)}"]`)?.classList.add("missing");
      root.querySelector(".ag-q.missing")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return false;
    }
    const answers = Object.fromEntries(
      it.questions.map((q) => [q.id, questionType(q) === "choice" ? draft.picks.get(q.id) || [] : [(draft.values.get(q.id) || "").trim()].filter(Boolean)])
    );
    const notes = Object.fromEntries(it.questions.map((q) => [q.id, (draft.notes.get(q.id) || "").trim()]).filter(([, v]) => v));
    try {
      await api("POST", `/questions/${encodeURIComponent(it.requestId)}`, { answers, notes });
      questionDrafts.delete(it.id);
      return true;
    } catch (err) {
      notice(err.message);
      return false;
    }
  }

  /** Many questions (ask_user's dialog display): the form over the app. Closing keeps the draft. */
  function openQuestionForm(it) {
    if (it.status !== "pending") return;
    questionForms.get(it.id)?.();
    const draft = questionDraft(it.id);
    const { panel, close } = modal("ag-qform", () => questionForms.delete(it.id));
    questionForms.set(it.id, close);
    panel.setAttribute("aria-label", it.title || "Questions");
    const head = el("div", "ag-qform-head");
    const titles = el("div", "ag-qform-titles");
    titles.append(el("h2", "ag-modal-title", it.title || "The agent has questions"), el("p", "ag-modal-hint", `${it.questions.length} questions`));
    head.append(icon("question", "ag-qform-ico"), titles, button(icon("close"), "ag-icon-btn small", () => close(), "Close (your answers are kept)"));
    const progress = el("div", "ag-qform-progress");
    const bar = el("span", "ag-qform-bar");
    const fill = el("span", "ag-qform-fill");
    const count = el("span", "ag-qform-count");
    bar.append(fill);
    progress.append(bar, count);
    const update = () => {
      const done = it.questions.filter((q) => questionAnswered(q, draft)).length;
      fill.style.width = `${(done / it.questions.length) * 100}%`;
      count.textContent = `${done} of ${it.questions.length} answered`;
    };
    update();
    const body = el("div", "ag-qform-body");
    body.append(questionFields(it, draft, update, true));
    const submit = async () => {
      if (await submitQuestion(it, draft, body)) close();
    };
    const actions = el("div", "ag-modal-actions ag-qform-actions");
    actions.append(
      progress,
      button("Skip all", "ag-btn small ghost", async () => {
        await api("POST", `/questions/${encodeURIComponent(it.requestId)}`, { skip: true }).then(close, (err) => notice(err.message));
      }),
      button("Submit", "ag-btn primary", submit)
    );
    panel.append(head, body, actions);
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submit();
      }
    });
    requestAnimationFrame(() => body.querySelector("button, input, textarea")?.focus({ preventScroll: true }));
  }
  function closeQuestionForm(id) {
    questionForms.get(id)?.();
    questionDrafts.delete(id);
  }


  /* ---------- rewind confirmation ---------- */

  /** Resolves { keepChanges } to go ahead, or null. Only asked when the rewind would drop more than the one turn. */
  function confirmRewind({ turns, files, page, resend }) {
    return new Promise((resolve) => {
      const { panel, close } = modal("ag-confirm");
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        close();
        resolve(value);
      };
      modalStack[modalStack.length - 1] = () => finish(null);
      const later = turns - 1;
      panel.append(
        el("h2", "ag-modal-title", resend ? "Retry this message?" : "Edit this message?"),
        el("p", "ag-modal-hint", `The chat goes back to just before it${later ? `: this turn and the ${later} after it are removed` : ": its reply is removed"}.`)
      );
      let undo = null;
      if (files || page) {
        const what = [files ? `${files} file${files === 1 ? "" : "s"}` : "", page ? "the page" : ""].filter(Boolean).join(" and ");
        const label = el("label", "ag-check");
        undo = el("input");
        undo.type = "checkbox";
        undo.checked = true;
        label.append(undo, el("span", null, `Also undo their changes to ${what}`));
        panel.append(label);
      }
      const actions = el("div", "ag-modal-actions");
      actions.append(
        el("span", "ag-grow"),
        button("Cancel", "ag-btn small", () => finish(null)),
        button(resend ? "Retry" : "Edit", "ag-btn small primary", () => finish({ keepChanges: undo ? !undo.checked : false }))
      );
      panel.append(actions);
      actions.lastElementChild.focus();
    });
  }

  /* ---------- workspace picker ---------- */

  /**
   * opts.files: "open" lists files too and picks one; "save" picks where to save (input holds the
   * full path, and browsing keeps its file name; opts.name is the fallback). opts.action names the button.
   */
  function pickWorkspace(initial, opts = {}) {
    const files = opts.files === "open" || opts.files === "save" ? opts.files : "";
    const sep = (dir) => (/\\/.test(dir) || /^[A-Za-z]:/.test(dir) ? "\\" : "/");
    const joinPath = (dir, name) => (dir ? dir.replace(/[\\/]+$/, "") + sep(dir) + name : name);
    return new Promise((resolve) => {
      const { panel, close: closeModal } = modal("ag-ws");
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        closeModal();
        resolve(value);
      };
      const title = el("h2", "ag-modal-title", opts.title || "Workspace folder");
      const hint = el("p", "ag-modal-hint", opts.hint ?? "Where the agent reads, edits, and runs commands for this thread.");
      const row = el("div", "ag-ws-row");
      const input = el("input", "ag-input");
      input.type = "text";
      input.placeholder = files ? "C:\\path\\to\\file.txt" : "C:\\path\\to\\project";
      input.value = initial || prefs().recentWorkspaces[0] || "";
      const use = button(opts.action || "Use folder", "ag-btn primary", () => finish(input.value.trim() || null));
      row.append(input, use);
      const used = el("div", "ag-ws-used");
      const withThreads = opts.used === false || files ? [] : threadWorkspaces();
      if (withThreads.length) {
        const usedHeading = helpHeading("Workspaces with threads", "Counts include all non-archived threads, including inactive workers and helpers nested under their parent threads. With Show workers off, a workspace containing only inactive workers can be absent from the thread list. Search for the folder path in the Workspaces thread list to find its threads, including workers, helpers, and older threads.");
        usedHeading.classList.add("ag-ws-used-label");
        used.append(usedHeading);
        for (const { path: dir, n } of withThreads) {
          const item = button("", "ag-ws-used-item", () => finish(dir), dir);
          item.append(icon("box"), el("span", "ag-ws-used-name", R.basename(dir)), el("span", "ag-ws-used-count", n === 1 ? "1 thread" : `${n} threads`));
          if (missingFor(dir)) item.append(el("span", "ag-tag", "missing"));
          used.append(item);
        }
      }
      const browser = el("div", "ag-ws-browser");
      const crumbs = el("div", "ag-ws-path");
      const list = el("div", "ag-ws-list");
      browser.append(crumbs, list);
      const load = async (dir) => {
        list.replaceChildren(el("div", "ag-muted ag-ws-loading", "Loading…"));
        try {
          const data = files ? await listFiles(dir) : await api("GET", `/fs?path=${encodeURIComponent(dir || "")}`);
          crumbs.replaceChildren();
          if (data.parent !== null && data.parent !== undefined) {
            crumbs.append(button("↑", "ag-btn ghost small", () => load(data.parent), "Up", false));
          }
          crumbs.append(el("span", "ag-ws-cur", data.path || "This PC"));
          if (data.repo) crumbs.append(el("span", "ag-tag", "git"));
          if (data.path) input.value = files === "save" ? joinPath(data.path, R.basename(input.value) || opts.name || "untitled.txt") : data.path;
          list.replaceChildren();
          for (const d of data.dirs) {
            const item = button(d.name, "ag-ws-dir", () => load(d.path));
            item.prepend(icon("folder"));
            if (!files) item.addEventListener("dblclick", () => finish(d.path));
            list.append(item);
          }
          for (const f of files ? data.files || [] : []) {
            const item = button(f.name, "ag-ws-dir ag-ws-file", () => {
              input.value = f.path;
              for (const other of list.querySelectorAll(".ag-ws-file.is-picked")) other.classList.remove("is-picked");
              item.classList.add("is-picked");
            });
            item.prepend(icon("read"));
            item.addEventListener("dblclick", () => finish(f.path));
            list.append(item);
          }
          if (!list.childElementCount) list.append(el("div", "ag-muted ag-ws-loading", data.exists === false ? "Folder not found" : files ? "Empty folder" : "No subfolders"));
        } catch (err) {
          list.replaceChildren(el("div", "ag-muted", err.message));
        }
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") finish(input.value.trim() || null);
        if (event.key === "Escape") finish(null);
      });
      const actions = el("div", "ag-modal-actions");
      // With files, a file's path browses its folder (the daemon lists the parent).
      actions.append(button("Browse here", "ag-btn ghost", () => load(input.value.trim())), el("span", "ag-grow"));
      // opts.clear: a button that resolves "" (no folder), apart from Cancel's null.
      if (opts.clear) actions.append(button(opts.clear, "ag-btn", () => finish("")));
      actions.append(button("Cancel", "ag-btn", () => finish(null)));
      panel.append(...(hint.textContent ? [title, hint, row] : [title, row]));
      if (used.childElementCount) panel.append(used);
      panel.append(browser, actions);
      load(input.value.trim());
      setTimeout(() => input.focus(), 0);
      // Esc from the modal stack resolves as cancel.
      modalStack[modalStack.length - 1] = () => finish(null);
    });
  }

  /** Files and folders in a folder (the board's file API, not the agent one). */
  async function listFiles(dir) {
    const res = await fetch(`/api/files/list?path=${encodeURIComponent(dir || "")}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  /* ---------- Hook rules (Agent settings → Hooks) ---------- */

  const HOOK_MATCH = { keyword: "contains", regex: "regex", tool: "tool name", question: "question" };
  const HOOK_EVENT = { any: "anything", prompt: "your message", text: "agent text", reasoning: "agent thinking", tool_call: "tool call", tool_result: "tool result", turn_end: "end of turn" };
  const HOOK_ACTION = {
    flag: { label: "Flag", text: "Label", hint: "Shown on the item. Leave empty to show the pattern.", placeholder: "e.g. Force push" },
    context: { label: "Tell the agent", text: "Message to the agent", hint: "Sent into the running turn, once per turn.", placeholder: "e.g. Never push to main; open a pull request instead." },
    ask: { label: "Ask me first", text: "Why", hint: "Shown with the approval.", placeholder: "Optional" },
    block: { label: "Block", text: "Reason", hint: "The agent is told this when the call is denied.", placeholder: "Optional" },
    signal: { label: "Signal", text: "Signal name", hint: "Sent to Scribe's own UI as an agent_intent event. For building on hooks; the chat shows nothing.", placeholder: "e.g. deploy" },
  };

  function hookRules() {
    return prefs().hookRules || [];
  }

  async function saveHookRules(rules) {
    const view = await api("PUT", "/hooks", { rules });
    S.config.prefs = { ...prefs(), hookRules: view.rules };
    return view;
  }

  /** Add (rule null) or edit one of the user's hook rules. `rules` is the list it is in. */
  function editHookRule(rule, rules = hookRules()) {
    const { panel, close } = modal("ag-source ag-hook");
    const field = (label, control, hint) => {
      const wrap = el("label", "ag-field");
      const caption = el("span", "ag-field-label", label);
      control.setAttribute("aria-label", label);
      if (hint) { caption.dataset.tooltip = hint; caption.setAttribute("aria-description", hint); }
      wrap.append(caption, control);
      return { wrap, caption };
    };
    const select = (options, value) => {
      const node = el("select", "ag-input");
      for (const [id, label] of options) {
        const opt = el("option", null, label);
        opt.value = id;
        node.append(opt);
      }
      node.value = value;
      return node;
    };
    const match = select(
      [["keyword", "Contains the text"], ["regex", "Matches the regular expression"], ["tool", "Tool name contains"], ["question", "Question for the classifier"]],
      rule?.match || "keyword"
    );
    const pattern = el("input", "ag-input");
    pattern.value = rule?.pattern || "";
    pattern.spellcheck = false;
    const event = select(Object.entries(HOOK_EVENT).map(([id, label]) => [id, label[0].toUpperCase() + label.slice(1)]), rule?.event || "any");
    const action = select(["flag", "context", "ask", "block", "signal"].map((id) => [id, HOOK_ACTION[id].label]), rule?.action || "flag");
    const text = el("input", "ag-input");
    text.value = rule?.text || "";
    const threshold = el("input", "ag-input");
    threshold.type = "number";
    threshold.min = "50";
    threshold.max = "100";
    threshold.step = "5";
    threshold.value = String(Math.round((rule?.threshold ?? 0.7) * 100));
    const textField = field("Label", text);
    const thresholdField = field("Match when at least this sure (%)", threshold, "How sure the classifier must be that the answer is yes. Higher matches less often.");
    const patternField = field("Pattern", pattern);
    const note = el("p", "ag-muted ag-hook-note");
    const sync = () => {
      const question = match.value === "question";
      patternField.caption.textContent = question ? "Question" : match.value === "tool" ? "Tool name" : "Pattern";
      pattern.placeholder = question ? "A yes/no question, e.g. Does this delete files outside the workspace?" : match.value === "regex" ? "e.g. rm\\s+-rf|git push .*--force" : match.value === "tool" ? "e.g. Bash, page_show" : "e.g. --force";
      thresholdField.wrap.hidden = !question;
      // A tool name is only there on a tool call or its result.
      for (const opt of event.options) opt.hidden = match.value === "tool" && opt.value !== "tool_call" && opt.value !== "tool_result";
      if (match.value === "tool" && event.selectedOptions[0]?.hidden) event.value = "tool_call";
      const what = HOOK_ACTION[action.value];
      textField.caption.textContent = what.text;
      textField.caption.dataset.tooltip = what.hint;
      textField.caption.setAttribute("aria-description", what.hint);
      text.setAttribute("aria-label", what.text);
      text.placeholder = what.placeholder;
      const gating = action.value === "ask" || action.value === "block";
      const onCall = event.value === "tool_call" || event.value === "any";
      note.textContent = !gating
        ? ""
        : onCall
          ? "Holds the call on Claude and Native. On Codex and Cursor only some calls can be held (see below the rules)."
          : action.value === "block"
            ? "Nothing can be held here, so a match stops the turn."
            : "Nothing can be held here, so a match only marks the item.";
      note.hidden = !note.textContent;
    };
    for (const control of [match, event, action]) control.addEventListener("change", sync);
    sync();
    const error = el("p", "ag-source-error");
    error.hidden = true;
    const done = async (next) => {
      try {
        await saveHookRules(next);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        return;
      }
      close();
      void agentSettings.renderHooks();
    };
    const save = () => {
      const edited = {
        ...(rule ? { id: rule.id } : {}),
        enabled: rule ? rule.enabled : true,
        match: match.value,
        pattern: pattern.value,
        event: event.value,
        action: action.value,
        text: text.value,
        ...(match.value === "question" ? { threshold: Number(threshold.value) / 100 } : {}),
      };
      return done(rule ? rules.map((r) => (r === rule ? edited : r)) : [...rules, edited]);
    };
    const actions = el("div", "ag-modal-actions");
    if (rule) actions.append(button("Remove", "ag-btn ghost danger", () => done(rules.filter((r) => r !== rule))));
    actions.append(el("span", "ag-grow"), button("Cancel", "ag-btn ghost", close), button(rule ? "Save" : "Add", "ag-btn primary", save));
    panel.append(el("h3", null, rule ? "Edit hook rule" : "New hook rule"), field("When", event).wrap, field("Match", match).wrap, patternField.wrap, thresholdField.wrap, field("Then", action).wrap, textField.wrap, note, error, actions);
    pattern.focus();
  }

  /* ---------- Custom modes (Agent harness, Modes) ---------- */

  /** Add (mode null) or edit one of the user's modes. changed runs once it is saved or removed. */
  async function editCustomMode(mode, changed) {
    const all = customModes();
    const { panel, close } = modal("ag-source ag-mode");
    const field = (label, control, hint) => {
      const wrap = el("label", "ag-field");
      const caption = el("span", "ag-field-label", label);
      control.setAttribute("aria-label", label);
      if (hint) { caption.dataset.tooltip = hint; caption.setAttribute("aria-description", hint); }
      wrap.append(caption, control);
      return wrap;
    };
    const select = (options, value) => {
      const node = el("select", "ag-input");
      for (const [id, label] of options) {
        const opt = el("option", null, label);
        opt.value = id;
        node.append(opt);
      }
      node.value = value;
      return node;
    };
    const checks = (options, isOn) => {
      const wrap = el("div", "ag-mcp-modes");
      const boxes = options.map(([id, label]) => {
        const box = el("input");
        box.type = "checkbox";
        box.value = id;
        box.checked = isOn(id);
        const row = el("label", "ag-check");
        row.append(box, el("span", null, label));
        wrap.append(row);
        return box;
      });
      return { wrap, boxes };
    };
    const name = el("input", "ag-input");
    name.value = mode?.name || "";
    name.maxLength = 40;
    name.placeholder = "e.g. Review";
    const description = el("input", "ag-input");
    description.value = mode?.description || "";
    description.maxLength = 200;
    description.placeholder = "Shown in the mode menu";
    const base = select(MODES.map((m) => [m.id, `${m.label}: ${m.detail}`]), mode?.base || "code");
    const off = mode?.off || [];
    const tools = checks(MODE_TOOLS.map((tool) => [tool.id, tool.label]), (id) => !off.includes(id));
    const toolsField = el("div", "ag-field");
    const toolsLabel = el("span", "ag-field-label", "Tools");
    toolsLabel.dataset.tooltip = "Unticked tools are taken away from the agent in this mode, whatever the approval level. A mode cannot add what its base mode does not have.";
    toolsLabel.setAttribute("aria-description", toolsLabel.dataset.tooltip);
    const note = el("p", "ag-muted ag-hook-note");
    toolsField.append(toolsLabel, tools.wrap, note);
    const mcp = select([["all", "All that the base mode gets"], ["none", "None"], ["pick", "Only these"]], Array.isArray(mode?.mcp) ? "pick" : mode?.mcp || "all");
    // Scribe's own MCP list: the global servers and every workspace's.
    let known = [];
    try {
      const { file } = await api("GET", "/mcp");
      known = [...Object.keys(file?.mcpServers || {}), ...Object.values(file?.workspaces || {}).flatMap((layer) => Object.keys(layer?.mcpServers || {}))];
    } catch {
      /* the mode's own picks still show */
    }
    const picked = Array.isArray(mode?.mcp) ? mode.mcp : [];
    const names = [...new Set([...known, ...picked])].sort();
    const servers = checks(names.map((n) => [n, n]), (n) => picked.includes(n));
    if (!names.length) servers.wrap.append(el("span", "ag-muted", "No MCP servers set up."));
    const instructions = el("textarea", "ag-input ag-mode-text");
    instructions.value = mode?.instructions || "";
    instructions.placeholder = "e.g. You are a reviewer: report findings, never fix them.";
    const approval = select([["", "Leave as it is"], ...APPROVALS.map((a) => [a.id, a.label])], mode?.approval || "");
    const web = select([["", "Leave as it is"], ...WEB_MODES.map((w) => [w.id, w.label])], mode?.web || "");
    const offNow = () => tools.boxes.filter((box) => !box.checked).map((box) => box.value);
    const sync = () => {
      servers.wrap.hidden = mcp.value !== "pick";
      note.textContent = customModeNotes(offNow()).join(" ");
      note.hidden = !note.textContent;
      web.disabled = offNow().includes("web");
    };
    mcp.addEventListener("change", sync);
    for (const box of tools.boxes) box.addEventListener("change", sync);
    sync();
    const error = el("p", "ag-source-error");
    error.hidden = true;
    const done = async (next) => {
      try {
        S.config.prefs = await api("PUT", "/prefs", { customModes: next });
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        return;
      }
      close();
      changed?.();
      for (const view of views()) view.renderComposerBar();
    };
    const save = () => {
      if (!name.value.trim()) {
        error.textContent = "Give the mode a name.";
        error.hidden = false;
        return;
      }
      const edited = {
        id: mode?.id || `cm_${Math.random().toString(36).slice(2, 10).padEnd(8, "0")}`,
        name: name.value,
        description: description.value,
        base: base.value,
        off: offNow(),
        mcp: mcp.value === "pick" ? servers.boxes.filter((box) => box.checked).map((box) => box.value) : mcp.value,
        instructions: instructions.value,
        ...(approval.value ? { approval: approval.value } : {}),
        ...(web.value && !web.disabled ? { web: web.value } : {}),
      };
      return done(mode ? all.map((m) => (m.id === mode.id ? edited : m)) : [...all, edited]);
    };
    const actions = el("div", "ag-modal-actions");
    if (mode) actions.append(button("Remove", "ag-btn ghost danger", () => done(all.filter((m) => m.id !== mode.id))));
    actions.append(el("span", "ag-grow"), button("Cancel", "ag-btn ghost", close), button(mode ? "Save" : "Add", "ag-btn primary", save));
    panel.append(
      el("h3", null, mode ? "Edit mode" : "New mode"),
      field("Name", name),
      field("Description", description),
      field("Based on", base, "The built-in mode this one starts from. It keeps that mode's own behaviour, such as Plan's accept step or Pages working without a folder."),
      toolsField,
      field("MCP servers", mcp, "Which servers from Scribe's MCP list a thread in this mode gets. Cursor also loads the servers in its own settings."),
      servers.wrap,
      field("Instructions", instructions, "Added to what the agent is told in every thread in this mode."),
      field("Approval when picked", approval, "Set on a thread when this mode is picked. It can still be changed on the thread."),
      field("Web when picked", web, "Set on a thread when this mode is picked. It can still be changed on the thread, unless the mode turns web tools off."),
      error,
      actions
    );
    name.focus();
  }

  /* ---------- Native harness model sources ---------- */

  /** Add (source null) or edit an endpoint. The API key field only sends a new key; it never shows the old one. */
  function editSource(source) {
    const { panel, close } = modal("ag-source");
    const field = (label, input, hint) => {
      const wrap = el("label", "ag-field");
      const caption = el("span", "ag-field-label", label);
      input.setAttribute("aria-label", label);
      if (hint) { caption.dataset.tooltip = hint; caption.setAttribute("aria-description", hint); }
      wrap.append(caption, input);
      return wrap;
    };
    const input = (value, placeholder, type = "text") => {
      const node = el("input", "ag-input");
      node.type = type;
      node.value = value || "";
      node.placeholder = placeholder;
      node.spellcheck = false;
      return node;
    };
    const name = input(source?.name, "e.g. OpenRouter");
    const baseUrl = input(source?.baseUrl, "https://api.openai.com/v1");
    const key = input("", source?.hasKey ? "Saved (type to replace)" : "sk-…", "password");
    key.autocomplete = "off";
    const models = el("textarea", "ag-input ag-source-models");
    models.value = (source?.models || []).join("\n");
    models.placeholder = "One model id per line. Leave empty to list the endpoint's models.";
    const reasoningBox = el("input");
    reasoningBox.type = "checkbox";
    reasoningBox.checked = Boolean(source?.reasoning);
    const reasoning = el("label", "ag-check");
    reasoning.append(reasoningBox, el("span", null, "Offer reasoning levels (sent as reasoning_effort)"));
    const trustedBox = el("input");
    trustedBox.type = "checkbox";
    trustedBox.checked = Boolean(source?.trusted);
    const trusted = el("label", "ag-check");
    trusted.append(trustedBox, el("span", null, "Trusted: its models may read Trusted only pages"));
    const priceRows = [];
    const priceList = el("div");
    function priceRow(model = "", saved) {
      const row = el("div", "ag-field");
      const id = input(model, "Exact model ID, e.g. vendor/model");
      const mode = el("select", "ag-input");
      for (const [value, label] of [["automatic", "Automatic"], ["custom", "Custom fixed prices"], ["unknown", "Unknown (no estimate)"]]) {
        const opt = el("option", null, label); opt.value = value; mode.append(opt);
      }
      mode.value = saved?.mode || "automatic";
      const rates = {};
      const fields = el("div");
      for (const [key, label] of [["input", "Uncached input"], ["output", "Output"], ["cacheRead", "Cache read"], ["cacheWrite", "Cache write"]]) {
        rates[key] = input(saved?.rates?.[key] ?? "", key === "input" || key === "output" ? "Required for custom prices" : "Unknown if blank");
        rates[key].inputMode = "decimal";
        fields.append(field(label, rates[key], "USD per 1M tokens. Zero means free; blank cache prices leave those tokens unpriced."));
      }
      const sync = () => { fields.hidden = mode.value !== "custom"; };
      mode.addEventListener("change", sync); sync();
      const entry = { id, mode, rates };
      priceRows.push(entry);
      row.append(field("Model ID", id), field("Pricing", mode), fields);
      if (saved?.updatedAt) row.append(el("span", "ag-muted", `Prices entered ${new Date(saved.updatedAt).toLocaleDateString()}`));
      row.append(button("Remove price entry", "ag-btn ghost", () => { priceRows.splice(priceRows.indexOf(entry), 1); row.remove(); }));
      priceList.append(row);
    }
    for (const [model, saved] of Object.entries(source?.pricing || {})) priceRow(model, saved);
    const reconfirm = el("input"); reconfirm.type = "checkbox";
    const reconfirmRow = el("label", "ag-check");
    reconfirmRow.append(reconfirm, el("span", null, "Apply these prices to the changed endpoint"));
    reconfirmRow.hidden = true;
    baseUrl.addEventListener("input", () => { reconfirmRow.hidden = !source || baseUrl.value.trim().replace(/\/+$/, "") === source.baseUrl; });
    const error = el("p", "ag-source-error");
    error.hidden = true;
    const save = async () => {
      const body = { name: name.value, baseUrl: baseUrl.value, models: models.value, reasoning: reasoningBox.checked, trusted: trustedBox.checked };
      if (key.value.trim()) body.apiKey = key.value.trim();
      try {
        const pricing = {};
        const seen = new Set();
        for (const row of priceRows) {
          const model = row.id.value.trim();
          if (!model || seen.has(model)) throw new Error("Price entries need unique, exact model IDs");
          seen.add(model);
          if (row.mode.value === "automatic") continue;
          const entry = { mode: row.mode.value };
          if (entry.mode === "custom") entry.rates = Object.fromEntries(Object.entries(row.rates).map(([key, node]) => [key, node.value.trim()]));
          Object.defineProperty(pricing, model, { value: entry, enumerable: true });
        }
        body.pricing = pricing;
        body.pricingConfirmed = reconfirm.checked;
        if (source) await api("PUT", `/model-sources/${encodeURIComponent(source.id)}`, body);
        else await api("POST", "/model-sources", body);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        return;
      }
      close();
      await sourcesChanged();
    };
    const actions = el("div", "ag-modal-actions");
    if (source) {
      actions.append(
        button("Remove", "ag-btn ghost danger", async () => {
          if (!(await app()?.confirm?.(`Remove “${source.name}”? Threads that use its models can't continue until you add it again.`, "Remove"))) return;
          await api("DELETE", `/model-sources/${encodeURIComponent(source.id)}`).catch((err) => notice(err.message));
          close();
          await sourcesChanged();
        })
      );
      if (source.hasKey) actions.append(button("Clear key", "ag-btn ghost", async () => {
        await api("PUT", `/model-sources/${encodeURIComponent(source.id)}`, { apiKey: "" }).catch((err) => notice(err.message));
        close();
        await sourcesChanged();
      }));
    }
    actions.append(el("span", "ag-grow"), button("Cancel", "ag-btn", close), button(source ? "Save" : "Add", "ag-btn primary", save));
    panel.append(
      el("h2", "ag-modal-title", source ? `Edit ${source.name}` : "Add a model source"),
      el("p", "ag-modal-hint", "Any endpoint that speaks the OpenAI Chat Completions API. Its models run through the native harness. The key is stored on this PC and never shown again."),
      field("Name", name),
      field("Base URL", baseUrl, "Up to the version, e.g. …/v1. The native harness calls /chat/completions under it, and Scribe /models when the list below is empty."),
      field("API key", key, source?.hasKey ? "Leave empty to keep the saved key." : "Leave empty for local servers that need none."),
      field("Models", models),
      reasoning,
      trusted,
      helpHeading("Model prices · USD per 1M tokens", "Automatic uses available catalog prices; verification dates and tariff discounts are unknown. Custom fixed prices replace the whole rate set. Unknown disables estimation. Removing an entry restores Automatic. Changes apply on the next turn; recorded estimates keep their original rates."),
      priceList,
      button("Add model price", "ag-btn", () => priceRow()),
      reconfirmRow,
      error,
      actions
    );
    setTimeout(() => (source ? baseUrl : name).focus(), 0);
  }

  /** Sources changed: the provider's status and model list follow them. */
  async function sourcesChanged() {
    await loadConfig();
    const data = await api("GET", "/models?provider=pi&refresh=1").catch(() => null);
    S.config.models.pi = data?.models || [];
    agentSettings.renderStatus();
    void agentSettings.renderSources();
    requestRender();
  }

  /* ---------- agent browser ---------- */

  async function loadBrowsers() {
    try {
      const data = await api("GET", "/browsers");
      S.browsers = new Map(data.browsers.map((view) => [view.threadId, view]));
    } catch {
      return;
    }
    for (const view of views()) view.renderHeader();
  }

  /** A KeyboardEvent as a Playwright key, or null for a lone modifier. */
  function browserKey(event) {
    if (["Shift", "Control", "Alt", "Meta", "Dead", "Unidentified", "Process"].includes(event.key)) return null;
    const printable = event.key.length === 1;
    const mods = [];
    if (event.ctrlKey) mods.push("Control");
    if (event.altKey) mods.push("Alt");
    if (event.metaKey) mods.push("Meta");
    // A printable key already carries Shift ("A", "!"); named keys need it spelled out.
    if (event.shiftKey && (!printable || mods.length)) mods.push("Shift");
    return [...mods, printable && mods.length ? event.key.toLowerCase() : event.key].join("+");
  }

  /**
   * The thread's headless agent browser, live: screencast frames of its current tab, with the
   * user's clicks, scrolls, and keys sent back to it. The agent keeps driving it meanwhile.
   */
  function openBrowser(threadId) {
    const base = `/threads/${encodeURIComponent(threadId)}/browser`;
    const source = new EventSource(`/api/agent${base}/live`);
    const { panel, close } = modal("ag-browserview", () => source.close());
    const thread = S.threads.get(threadId);
    const title = el("h2", "ag-modal-title", thread ? `Browser · ${thread.title}` : "Agent browser");
    const address = el("span", "ag-browser-url");
    const head = el("div", "ag-browser-head");
    head.append(
      title,
      address,
      el("span", "ag-grow"),
      button("Close browser", "ag-btn ghost", () => api("POST", `${base}/close`).catch((err) => notice(err.message)), "Close the agent's browser and its tabs"),
      button(icon("close"), "ag-icon-btn", () => close(), "Close this view (Esc)", false)
    );
    const stage = el("div", "ag-browser-stage");
    const screen = el("img", "ag-browser-screen");
    screen.alt = "";
    screen.tabIndex = 0;
    screen.draggable = false;
    screen.hidden = true;
    const empty = el("div", "ag-muted ag-pad", "Waiting for the page…");
    stage.append(screen, empty);
    panel.append(head, stage, el("div", "ag-modal-hint", "Click, scroll, and type to use the page; Ctrl+V pastes into it. The agent drives it too. Esc closes this view."));

    let frame = null;
    source.addEventListener("frame", (event) => {
      frame = JSON.parse(event.data);
      screen.src = `data:image/jpeg;base64,${frame.data}`;
      screen.hidden = false;
      empty.hidden = true;
    });
    source.addEventListener("view", (event) => {
      const view = JSON.parse(event.data);
      const tab = view?.tabs.find((t) => t.current);
      address.textContent = tab ? tab.url : "";
      address.dataset.tooltip = tab ? `${tab.title}\n${tab.url}` : "";
      if (!tab) {
        frame = null;
        screen.hidden = true;
        empty.hidden = false;
        empty.textContent = "The agent has no browser open. It shows here when the agent opens a page.";
      }
    });

    // Inputs go one at a time, in order; a mouse move is dropped while another is on its way.
    let queue = Promise.resolve();
    let movePending = false;
    const send = (input) => {
      if (!frame) return;
      if (input.kind === "move") {
        if (movePending) return;
        movePending = true;
      }
      const body = { tab: frame.tab, ...input };
      queue = queue
        .then(() => api("POST", `${base}/input`, body))
        .catch(() => undefined)
        .finally(() => {
          if (input.kind === "move") movePending = false;
        });
    };
    const at = (event) => {
      const rect = screen.getBoundingClientRect();
      const x = Math.min(rect.right, Math.max(rect.left, event.clientX));
      const y = Math.min(rect.bottom, Math.max(rect.top, event.clientY));
      return {
        x: Math.round(((x - rect.left) * frame.width) / rect.width),
        y: Math.round(((y - rect.top) * frame.height) / rect.height),
      };
    };
    const BUTTONS = ["left", "middle", "right"];
    let pressed = false;
    screen.addEventListener("mousedown", (event) => {
      event.preventDefault();
      screen.focus();
      if (!frame) return;
      pressed = true;
      send({ kind: "down", ...at(event), button: BUTTONS[event.button] || "left", clickCount: event.detail || 1 });
    });
    screen.addEventListener("mousemove", (event) => {
      if (frame) send({ kind: "move", ...at(event) });
    });
    const onUp = (event) => {
      if (!screen.isConnected) {
        window.removeEventListener("mouseup", onUp);
        return;
      }
      if (!pressed || !frame) return;
      pressed = false;
      send({ kind: "up", ...at(event), button: BUTTONS[event.button] || "left", clickCount: event.detail || 1 });
    };
    window.addEventListener("mouseup", onUp);
    screen.addEventListener("contextmenu", (event) => event.preventDefault());
    screen.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        if (!frame) return;
        const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
        send({ kind: "wheel", ...at(event), dx: event.deltaX * scale, dy: event.deltaY * scale });
      },
      { passive: false }
    );
    screen.addEventListener("keydown", (event) => {
      if (event.key === "Escape") return;
      // Ctrl+V: the paste event brings the text across, since the headless page can't read our clipboard.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
      event.preventDefault();
      event.stopPropagation();
      const key = browserKey(event);
      if (key) send({ kind: "key", key });
    });
    screen.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain");
      if (text) send({ kind: "text", text });
    });
  }

  /** Merge, leave or discard a thread's worktree after asking; true once it is done. */
  async function finishThreadWorktree(threadId, wt, how) {
    let st = null;
    try {
      ({ status: st } = await api("GET", `/threads/${encodeURIComponent(threadId)}/worktree`));
    } catch (err) {
      notice(err.message);
      return false;
    }
    if (how === "merge" && st) {
      if (st.dirty.length) {
        notice(`The worktree has ${st.dirty.length} uncommitted file${st.dirty.length === 1 ? "" : "s"}. Ask the agent to commit them, or use Leave branch.`);
        return false;
      }
      if (st.mainBranch !== wt.base) {
        notice(`The main checkout is on ${st.mainBranch || "a detached HEAD"}. Switch it to ${wt.base} to merge.`);
        return false;
      }
    }
    const question =
      how === "merge"
        ? st?.ahead
          ? `Merge ${st.ahead} commit${st.ahead === 1 ? "" : "s"} from ${wt.branch} into ${wt.base} in the main checkout, and remove the worktree folder?`
          : `${wt.branch} has no new commits. Remove the worktree folder and the branch?`
        : how === "discard"
          ? `Discard all committed and uncommitted work on ${wt.branch}, delete the branch, and remove its worktree folder? This cannot be undone. The main checkout is unchanged.`
          : `Remove the worktree folder and keep the work on ${wt.branch}?${st?.dirty.length ? ` Its ${st.dirty.length} uncommitted file${st.dirty.length === 1 ? " is" : "s are"} committed there first.` : ""}`;
    const after =
      how === "merge"
        ? `A new message to the thread then opens a worktree again from ${wt.base} as it is then, and goes on in the same agent session.`
        : "This thread and any other threads sharing the worktree then continue in the main checkout, in fresh agent sessions.";
    if (!(await app().confirm(`${question}\n\n${after}`, how === "merge" ? "Merge" : how === "discard" ? "Discard worktree" : "Leave"))) return false;
    try {
      const res = await api("POST", `/threads/${encodeURIComponent(threadId)}/worktree`, { action: how });
      notice(res.message);
      return true;
    } catch (err) {
      notice(err.message);
      return false;
    }
  }

  /* ---------- diff viewer ---------- */

  /** source: { kind: "turn"|"thread"|"git", threadId?, turnId?, cwd?, path? } */
  async function openDiff(source) {
    const { panel, close } = modal("ag-diffview");
    const head = el("div", "ag-diff-head");
    const title = el("h2", "ag-modal-title", "Changes");
    const tabs = el("div", "ag-seg");
    const actions = el("div", "ag-diff-actions");
    head.append(title, el("span", "ag-grow"), actions, tabs, button(icon("close"), "ag-icon-btn", () => close(), "Close (Esc)", false));
    const body = el("div", "ag-diff-body");
    const side = el("div", "ag-diff-files");
    const main = el("div", "ag-diff-main");
    body.append(side, main);
    panel.append(head, body);

    const thread = source.threadId ? S.threads.get(source.threadId) : null;
    const cwd = source.cwd || thread?.cwd || null;
    const kinds = [];
    if (source.turnId) kinds.push({ id: "turn", label: "This turn" });
    if (source.threadId) kinds.push({ id: "thread", label: "Thread" });
    if (cwd) kinds.push({ id: "git", label: openWorktree(thread) && !source.cwd ? "Branch" : "Git working tree" });
    let current = source.kind;

    const renderTabs = () => {
      tabs.replaceChildren();
      for (const k of kinds) {
        const b = button(k.label, `ag-seg-btn${k.id === current ? " on" : ""}`, () => {
          current = k.id;
          renderTabs();
          load();
        });
        tabs.append(b);
      }
    };

    const load = async () => {
      side.replaceChildren(el("div", "ag-muted ag-pad", "Loading…"));
      main.replaceChildren();
      actions.replaceChildren();
      let files = [];
      let patch = "";
      let truncated = false;
      try {
        if (current === "git") {
          // A worktree thread shows everything on its branch: commits and uncommitted changes since it started.
          const wt = openWorktree(thread);
          const base = wt && !source.cwd ? `&base=${wt.baseCommit}` : "";
          const info = await api("GET", `/git?cwd=${encodeURIComponent(cwd)}${base}`);
          if (!info.repo) {
            side.replaceChildren(el("div", "ag-muted ag-pad", "Not a git repository"));
            return;
          }
          title.textContent = `Changes · ${info.branch || R.basename(info.repo)}${base ? ` since ${wt.base || "it started"}` : ""}`;
          files = info.files || [];
          if (files.length) {
            const p = await api("GET", `/git/patch?repo=${encodeURIComponent(info.repo)}&from=${info.head}&to=${info.tree}`);
            patch = p.patch;
            truncated = p.truncated;
          }
          actions.append(button("Refresh", "ag-btn small", () => load()));
        } else {
          const turnQ = current === "turn" ? `?turn=${encodeURIComponent(source.turnId)}` : "";
          const info = await api("GET", `/threads/${encodeURIComponent(source.threadId)}/changes${turnQ}`);
          files = info.files || [];
          const p = await api("GET", `/threads/${encodeURIComponent(source.threadId)}/patch${turnQ}`);
          patch = p.patch;
          truncated = p.truncated;
          title.textContent = current === "turn" ? "Changes in this turn" : `Changes in “${thread?.title || "thread"}”`;
          if (current === "turn") {
            const turn = S.details.get(source.threadId)?.turns.get(source.turnId);
            if (turn?.beforeTree && !turn.reverted) {
              actions.append(
                button("Revert turn", "ag-btn small danger", async () => {
                  if (!(await app().confirm("Undo this turn's file changes in the working copy?", "Revert"))) return;
                  try {
                    const res = await api("POST", `/threads/${encodeURIComponent(source.threadId)}/turns/${encodeURIComponent(source.turnId)}/revert`);
                    if (res.ok) {
                      notice("Reverted the turn's changes");
                      close();
                    } else notice(res.error || "Could not revert");
                  } catch (err) {
                    notice(err.message);
                  }
                })
              );
            }
          }
        }
      } catch (err) {
        side.replaceChildren(el("div", "ag-muted ag-pad", err.message));
        return;
      }
      const parsed = R.parsePatch(patch);
      side.replaceChildren();
      const totals = files.reduce((acc, f) => ({ a: acc.a + (f.added || 0), r: acc.r + (f.removed || 0) }), { a: 0, r: 0 });
      const sum = el("div", "ag-diff-sum");
      sum.append(el("span", null, `${files.length} file${files.length === 1 ? "" : "s"}`), R.counts(totals.a, totals.r));
      side.append(sum);
      if (!files.length) {
        main.append(el("div", "ag-empty-diff", "No changes"));
        return;
      }
      const sections = new Map();
      for (const f of files) {
        const row = button("", "ag-diff-filebtn", () => {
          const target = sections.get(f.path);
          target?.scrollIntoView({ block: "start" });
          for (const b of side.querySelectorAll(".ag-diff-filebtn")) b.classList.toggle("on", b === row);
        });
        row.append(el("span", `ag-fstat s-${f.status || "M"}`, f.status || "M"), el("span", "ag-fname", R.basename(f.path)), el("span", "ag-fdir", R.dirname(f.path)), R.counts(f.added, f.removed));
        row.dataset.tooltip = f.path;
        side.append(row);
      }
      for (const f of files) {
        const pf = parsed.find((p) => p.path === f.path) || parsed.find((p) => p.path.endsWith(f.path));
        const section = el("section", "ag-diff-section");
        const sh = el("div", "ag-diff-section-head");
        sh.append(el("span", `ag-fstat s-${f.status || "M"}`, f.status || "M"), el("span", "ag-fpath", f.oldPath ? `${f.oldPath} → ${f.path}` : f.path), R.counts(f.added, f.removed));
        section.append(sh);
        if (pf) section.append(R.renderDiffFile(pf));
        else section.append(el("div", "ag-muted ag-pad", f.binary ? "Binary file" : "No text diff"));
        sections.set(f.path, section);
        main.append(section);
      }
      if (truncated) main.append(el("div", "ag-muted ag-pad", "The diff was cut off because it is very large."));
      if (source.path) sections.get(source.path)?.scrollIntoView({ block: "start" });
    };
    renderTabs();
    load();
  }

  /* ---------- chat view ---------- */

  class ChatView {
    /** variant: "side" | "full" | "dock" | "helper"; floating helpers keep the dock layout. */
    constructor(variant, floating = variant === "dock") {
      this.variant = variant;
      this.floating = floating;
      this.threadId = null;
      /** A thread that does not exist yet: { scope, settings }. */
      this.draft = null;
      this.expanded = new Set();
      this.dirtyTurns = new Set();
      this.dirtyAll = false;
      this.raf = 0;
      this.mdTimers = new Map();
      /** Built transcript steps by item id: { sig, node }. A step whose sig is unchanged is kept as it is (#431). */
      this.itemNodes = new Map();
      /** Files waiting in the composer: { name, mimeType, size, data (base64), url (blob: for previews) }. */
      this.attachments = [];
      /** The page tab the floating chat's draft belongs to (it follows the active page). */
      this.draftTab = null;
      /** The composer moved to another layout; what is left here is not the user's to save. */
      this.handedOff = false;
      this.mentions = [];
      this.mentionGen = 0;
      this.mentionTimer = 0;
      this.mentionLoading = false;

      this.root = el("div", `ag-view ag-view-${variant}`);
      this.header = el("div", "ag-thead");
      this.scroll = el("div", "ag-scroll");
      this.transcript = el("div", "ag-transcript");
      this.scroll.append(this.transcript);
      // Queued messages sit below the scroll, so rows arriving above never push them around.
      this.queueDock = el("div", "ag-queue-dock");
      this.queueList = el("div", "ag-transcript ag-queue");
      const queueClip = el("div", "ag-queue-clip");
      queueClip.append(this.queueList);
      this.queueDock.append(queueClip);
      this.composer = this.buildComposer();
      if (variant !== "dock") this.root.append(this.header);
      this.root.append(this.scroll, this.queueDock, this.composer);
      if (variant === "helper" && floating) {
        this.root.classList.add("ag-helper-floating");
        const head = el("div", "dock-head");
        const out = el("div", "dock-out");
        const history = el("div", "dock-history");
        history.append(this.scroll, this.queueDock);
        out.append(this.header, history);
        head.append(out);
        const input = el("div", "dock-input");
        this.helperOrb = button("", "dock-orb", (event) => this.modelMenu(event.currentTarget));
        this.helperOrbFx = window.scribeOrb?.create(this.helperOrb, input);
        input.append(this.helperOrb, this.composer, this.sendSlot);
        const bar = el("div", "dock-bar");
        const right = el("div", "dock-bar-right");
        right.append(this.bar);
        bar.append(right);
        this.root.replaceChildren(head, input, bar);
        this.helperBackground = [head, input, bar];
      }
      this.stick = true;
      this.stickAnim = 0;
      this.stickLock = false;
      this.stickY = 0;
      this.stickV = 0;
      this.stickTarget = -1;
      this.queueShown = true;
      this.transcriptThreadId = null;
      this.transcriptHadContent = false;
      this.scroll.addEventListener("scroll", () => {
        this.updateScrollFade();
        if (!(this.stickLock || this.stickAnim)) {
          const dist = this.bottomDist();
          // Pin from distance alone. Coupling this to the dock hiding left the view unpinned
          // one dock-height from the bottom, which is where opening the dock always lands.
          if (dist < STICK_PX) this.stick = true;
          else if (this.queueShown) this.stick = false;
        }
        this.updateQueueDock();
        if (this.helpersBusy) this.renderHelperDock();
      });
      const releaseStick = () => {
        this.stopStickAnim();
        if (this.bottomDist() >= STICK_PX) this.stick = false;
      };
      this.scroll.addEventListener("wheel", releaseStick, { passive: true });
      this.scroll.addEventListener("touchstart", releaseStick, { passive: true });
      this.scroll.addEventListener("pointerdown", releaseStick);
      this.stickRo = new ResizeObserver(() => {
        this.measureUserMessages();
        if (this.stick) this.scrollToEnd();
      });
      this.stickRo.observe(this.transcript);
      this.stickRo.observe(this.queueList);
      // The scroll shrinks while the queue dock opens; stay at the bottom through it.
      this.stickRo.observe(this.scroll);
      this.root.addEventListener("click", (event) => onLinkClick(event));
      this.root.addEventListener("auxclick", (event) => onLinkClick(event));
      this.root.addEventListener("mousedown", preventLinkAutoscroll);
    }

    thread() {
      return this.threadId ? S.threads.get(this.threadId) || null : null;
    }

    /** Settings shown in the composer: the thread's, or the draft's. */
    settings() {
      const t = this.thread();
      if (t) return this.pendingFork ? { ...t, ...this.pendingFork.settings } : t;
      const p = prefs();
      const d = this.draft || { scope: { kind: "global", ref: null }, settings: {} };
      const provider = d.settings.provider || (providerAvailable(p.provider) ? p.provider : S.config.providers.find((x) => x.available)?.id || "cursor");
      const scopeKey = d.scope.kind === "global" ? "global" : `${d.scope.kind}:${d.scope.ref}`;
      const cwd =
        d.settings.cwd !== undefined
          ? d.settings.cwd
          : d.scope.kind === "workspace"
            ? d.scope.ref
            : d.scope.kind === "page"
              ? pageWorkspace(d.scope.ref)
              : p.scopeWorkspaces?.[scopeKey] || p.recentWorkspaces?.[0] || null;
      const model = d.settings.model || p.models?.[provider] || "default";
      const choice = modelChoice(provider, model, p);
      const scoped = d.scope.kind === "page" || d.scope.kind === "folder";
      // The custom mode picked for the draft, else the last one picked when the draft names no mode.
      const customId = d.settings.customMode !== undefined ? d.settings.customMode : d.settings.mode || scoped ? null : p.customMode;
      const custom = (customId && customModes().find((m) => m.id === customId)) || null;
      return {
        id: null,
        provider,
        model,
        effort: d.settings.effort !== undefined ? d.settings.effort : choice.effort,
        modelParams: d.settings.modelParams || choice.modelParams,
        mode: custom ? custom.base : d.settings.mode || (scoped ? "board" : p.mode || "code"),
        ...(custom ? { custom } : {}),
        approval: d.settings.approval || approvalFor(provider),
        web: custom?.off.includes("web") ? "off" : webMode(d.settings.web, webMode(p.web)),
        cwd,
        // Last choice made in this workspace.
        useWorktree: d.settings.useWorktree !== undefined ? d.settings.useWorktree : Boolean(cwd && p.worktrees?.[dirKey(cwd)]),
        scope: d.scope,
        title: "New thread",
        status: "idle",
        stats: { turns: 0, files: 0, added: 0, removed: 0 },
      };
    }

    /** Whether patch moves a tainted thread (#269: it read Trusted only or Restricted pages) to a model the user does not trust. */
    async untrustedSwitch(t, patch) {
      if (!t?.tainted || !(patch.provider || patch.model)) return false;
      const provider = patch.provider || t.provider;
      const model = patch.model || prefs().models?.[provider] || "default";
      if (provider === t.provider && model === t.model) return false;
      const source = provider === "pi" ? model.split("/")[0] : "";
      if (!source.startsWith("src-")) return true;
      const sources = (await api("GET", "/model-sources").catch(() => ({}))).sources || [];
      return !sources.some((s) => s.id === source.slice(4) && s.trusted);
    }

    async updateSettings(patch, checked = false) {
      const t = this.thread();
      if (!checked && (await this.untrustedSwitch(t, patch))) {
        const ok = await app()?.confirm?.("This thread has read Trusted only or Restricted pages. The new model is not trusted and will see that content.", "Switch");
        if (!ok) return;
      }
      if (t && (this.pendingFork || (patch.provider && patch.provider !== t.provider && t.stats.turns > 0))) {
        const pending = this.pendingFork || { settings: {}, archive: false };
        Object.assign(pending.settings, patch);
        if (patch.provider || patch.model) {
          const provider = pending.settings.provider || t.provider;
          const model = patch.model || prefs().models?.[provider] || modelsOf(provider)[0]?.id || "default";
          const choice = modelChoice(provider, model, prefs());
          pending.settings.model = model;
          if (patch.effort === undefined) pending.settings.effort = choice.effort;
          if (patch.modelParams === undefined) pending.settings.modelParams = choice.modelParams;
          if (patch.provider && patch.approval === undefined) pending.settings.approval = approvalFor(provider);
        }
        if (pending.settings.provider === t.provider) {
          this.pendingFork = null;
          return this.updateSettings(pending.settings, true);
        }
        this.pendingFork = pending;
        this.renderComposerBar();
        this.renderHeader();
        return;
      }
      if (!t) {
        this.draft = this.draft || { scope: { kind: "global", ref: null }, settings: {} };
        Object.assign(this.draft.settings, patch);
        const p = prefs();
        if (patch.provider) {
          this.draft.settings.model = patch.model || p.models?.[patch.provider] || modelsOf(patch.provider)[0]?.id || "default";
          if (patch.approval === undefined) this.draft.settings.approval = approvalFor(patch.provider, p);
        }
        if (patch.provider || patch.model) {
          // Each model comes back with the effort and fast setting last picked for it.
          const s = this.settings();
          const choice = modelChoice(s.provider, s.model, p);
          if (patch.effort === undefined) this.draft.settings.effort = choice.effort;
          if (patch.modelParams === undefined) this.draft.settings.modelParams = choice.modelParams;
        }
        await this.rememberDraftPrefs();
        this.renderComposerBar();
        this.renderHeader();
        return;
      }
      try {
        const { thread } = await api("PATCH", `/threads/${encodeURIComponent(t.id)}`, patch);
        S.threads.set(thread.id, thread);
        this.renderComposerBar();
        this.renderHeader();
        loadConfig();
      } catch (err) {
        notice(err.message);
      }
    }

    /** Write this draft's visible settings so the next new thread starts with them. */
    async rememberDraftPrefs() {
      const cur = this.settings();
      try {
        const data = await api("POST", "/prefs/remember", {
          provider: cur.provider,
          model: cur.model,
          effort: cur.effort,
          modelParams: cur.modelParams,
          mode: cur.mode,
          customMode: cur.custom?.id ?? null,
          approval: cur.approval,
          web: cur.web,
          cwd: cur.cwd,
          useWorktree: Boolean(cur.useWorktree),
          scope: cur.scope,
        });
        if (data.prefs) S.config.prefs = data.prefs;
      } catch {
        /* the composer still shows the draft's settings */
      }
    }

    setThread(id) {
      if (this.threadId === id && id) return;
      this.audioComposer?.cancel();
      this.closeHelper();
      this.parkComposer();
      this.pendingFork = null;
      this.archiveOnSend = null;
      this.threadId = id;
      if (id) this.draft = null;
      this.expanded.clear();
      this.helpersOpen = false;
      this.loadComposer();
      if (this.variant === "dock") dock.invalidateFeed();
      this.renderAll();
      if (id) {
        const had = S.details.has(id);
        ensureDetail(id).then(() => {
          if (this.threadId === id) {
            this.stick = true;
            if (!had) this.renderAll();
            if (this.variant === "dock") dock.bindFeed();
            const t = S.threads.get(id);
            if (t?.unread && this.visible()) api("POST", `/threads/${encodeURIComponent(id)}/read`).catch(() => undefined);
          }
        });
      }
    }

    /** Show a thread here, and make it the one this view comes back to. */
    openThread(id) {
      if (this.variant === "helper") { this.setThread(id); return; }
      if (this.variant !== "dock") setCurrent(id);
      else dock.remember(id);
      this.setThread(id);
    }

    openHelper(id) {
      if (this.variant === "dock") dock.setExpanded(true);
      if (!this.helperView) {
        this.helperView = new ChatView("helper", this.floating);
        this.helperView.owner = this;
      }
      for (const node of this.helperBackground || [this.header, this.scroll, this.queueDock, this.composer]) node.inert = true;
      (this.helperHost || this.root).append(this.helperView.root);
      this.helperView.setThread(id);
      this.helperView.focus();
    }

    closeHelper() {
      if (!this.helperView?.root.isConnected) return;
      this.helperView.parkComposer();
      this.helperView.root.remove();
      this.helperView.threadId = null;
      for (const node of this.helperBackground || [this.header, this.scroll, this.queueDock, this.composer]) node.inert = false;
      this.focus();
    }

    /** Start a new thread, parking the old composer unless a user action explicitly moves it. */
    startDraft(scope, settings = {}, moveComposer = false) {
      this.audioComposer?.cancel();
      this.closeHelper();
      const content = moveComposer ? this.composerContent() : null;
      if (content) this.emptyComposer();
      this.parkComposer();
      this.pendingFork = null;
      this.archiveOnSend = null;
      this.threadId = null;
      this.draft = { scope, settings: { ...settings } };
      this.draftTab = this.variant === "dock" ? activeTab()?.id || null : null;
      this.loadComposer();
      if (content) this.fillComposer(content);
      this.renderAll();
      if (this.variant === "dock") {
        dock.bindFeed();
        dock.renderTitle();
      }
      setTimeout(() => this.focus(), 0);
    }

    /** Hand this chat to another layout as it is: its thread or unsent draft, and the composer with its files. */
    takeChat() {
      const snap = {
        threadId: this.threadId,
        draft: this.threadId || !this.draft ? null : { scope: { ...this.draft.scope }, settings: { ...this.draft.settings } },
        composer: this.composerContent(),
        pendingFork: this.pendingFork,
        archiveOnSend: this.archiveOnSend,
      };
      this.emptyComposer();
      this.handedOff = true;
      this.renderContext();
      return snap;
    }

    giveChat(snap) {
      if (snap.threadId) this.setThread(snap.threadId);
      else this.startDraft(snap.draft?.scope || defaultScope(), snap.draft?.settings || {});
      this.handedOff = false;
      this.pendingFork = snap.pendingFork || null;
      this.archiveOnSend = snap.archiveOnSend || null;
      // What setThread loaded is an older copy of the same composer.
      if (snap.composer) this.fillComposer(snap.composer);
      this.renderComposerBar();
      if (this.variant === "dock") {
        dock.remember(snap.threadId || null);
        dock.renderTitle();
      }
    }

    /** What the user has written and not sent, or null when the composer is empty. */
    composerContent() {
      if (!this.input) return null;
      const text = this.input.value;
      if (!text.trim() && !this.attachments.length && !this.mentions.length) return null;
      return { text, mentions: this.mentions.map((c) => ({ ...c })), attachments: this.attachments };
    }

    /** Clear the composer without freeing its files' previews: they went with the content. */
    emptyComposer() {
      if (!this.input) return;
      this.input.value = "";
      this.mentions = [];
      this.attachments = [];
      this.autosize();
    }

    fillComposer(content) {
      this.input.value = content.text || "";
      this.mentions = (content.mentions || []).map((c) => ({ ...c }));
      this.attachments = content.attachments || [];
      this.autosize();
      this.renderContext();
    }

    /**
     * Keep what is being written before this view shows something else: on its thread, or for an
     * unsent new thread, as a draft thread the list marks with a pen.
     */
    parkComposer() {
      this.audioComposer?.cancel();
      if (this.handedOff) {
        this.handedOff = false;
        return;
      }
      const content = this.composerContent();
      this.emptyComposer();
      const t = this.thread();
      if (t) {
        if (content) S.composers.set(t.id, content);
        else S.composers.delete(t.id);
        syncThreadDraft(t, content);
      } else if (!this.threadId && this.draft && content) {
        void saveDraftThread(this.settings(), content, this.variant === "dock" ? this.draftTab : null);
      }
    }

    /** Show the thread's unsent composer: the one left in this window, else the text saved on the thread. */
    loadComposer() {
      if (!this.input) return;
      const t = this.thread();
      const kept = t ? S.composers.get(t.id) : null;
      if (kept) S.composers.delete(t.id);
      this.fillComposer(kept || (t?.draft ? { text: t.draft.text, mentions: t.draft.context || [] } : {}));
    }

    visible() {
      // A closed sidebar is only clipped to no width.
      if (this.variant === "side" && !S.sideOpen) return false;
      return this.root.isConnected && this.root.offsetParent !== null;
    }

    /**
     * Whether this view's transcript is on screen. A hidden one is not drawn: it is marked stale and drawn once
     * when it is shown (wake). The collapsed floating chat shows its step feed instead, and the full window
     * covers the sidebar and the floating chat.
     */
    shown() {
      if (!this.root.isConnected) return false;
      switch (this.variant) {
        case "helper":
          return Boolean(this.owner?.shown());
        case "side":
          return S.sideOpen && !S.fullOpen;
        case "dock":
          return S.dockShown && S.dockExpanded && !S.fullOpen;
        default:
          return S.fullOpen;
      }
    }

    /** Draw the transcript if it changed while hidden and is on screen now. */
    wake() {
      if (this.stale && this.shown()) this.renderTranscript();
      if (this.helperView?.root.isConnected) this.helperView.wake();
    }

    focus() {
      this.input?.focus({ preventScroll: true });
    }

    /* ----- rendering ----- */

    renderAll() {
      this.renderHeader();
      this.renderTranscript();
      this.renderHelperDock();
      this.renderComposerBar();
      this.renderContext();
    }

    /** renderAll but the transcript. */
    renderChrome() {
      this.renderHeader();
      this.renderHelperDock();
      this.renderComposerBar();
      this.renderContext();
    }

    renderHeader() {
      if (this.variant === "dock") return;
      const t = this.thread();
      const helper = this.variant === "helper" || !!t?.helperOf;
      const s = this.settings();
      if (this.helperOrb) {
        this.helperOrbFx?.setProvider(s.provider);
        this.helperOrb.setAttribute("aria-label", `Model: ${modelLabel(s.provider, s.model)}`);
      }
      this.header.replaceChildren();
      const top = el("div", "ag-thead-top");
      if (this.variant === "side") {
        top.append(
          button(icon("list"), `ag-icon-btn${sidebar.listOpen ? " on" : ""}`, () => sidebar.toggleList(), "Threads", false)
        );
      }
      const title = el("div", "ag-title", t ? t.title : "New thread");
      title.dataset.tooltip = t && !helper ? "Double-click to rename" : "";
      if (t && !helper) title.addEventListener("dblclick", () => this.rename(title));
      top.append(title);
      const acts = el("div", "ag-thead-actions");
      if (!helper && s.cwd && s.mode !== "board") {
        const onBranch = openWorktree(t);
        acts.append(button(icon("git"), "ag-icon-btn", () => openDiff({ kind: "git", threadId: t?.id, ...(onBranch ? {} : { cwd: s.cwd }) }), onBranch ? `Changes on ${onBranch.branch}` : "Git working tree changes"));
      }
      if (t && S.browsers.has(t.id)) acts.append(button(icon("browser"), "ag-icon-btn", () => openBrowser(t.id), "Agent browser: watch it, click and type into it"));
      if (t) acts.append(button(icon("more"), "ag-icon-btn", (event) => this.threadMenu(event.currentTarget), "Thread actions"));
      if (!helper) {
        const settingsButton = button(icon("gear"), "ag-icon-btn", () => agentSettings.open(), "Agent settings (Ctrl+Shift+,)");
        settingsButton.setAttribute("aria-description", "Agent settings (Ctrl+Shift+,)");
        acts.append(settingsButton);
        acts.append(button(icon("plus"), "ag-icon-btn", () => newThread(this), "New thread (Ctrl+Shift+K)"));
      }
      if (!SOLO && window.scribePopout?.supported && (this.variant === "side" || this.variant === "full")) {
        acts.append(button(icon("popout"), "ag-icon-btn", () => popOutChat(), "Open as a window"));
      }
      if (this.variant === "side") {
        acts.append(button(icon("expand"), "ag-icon-btn", () => enterFull("side"), "Full window (Ctrl+Shift+L)"));
        acts.append(button(icon("close"), "ag-icon-btn", () => sidebar.setOpen(false), "Close (Ctrl+L)", false));
      } else if (this.variant === "full" && CHAT) {
        acts.append(button(icon("collapse"), "ag-icon-btn", () => returnChatToMain(), "Back to the main window", false));
      } else if (this.variant === "full") {
        acts.append(button(icon("collapse"), "ag-icon-btn", () => leaveFull(), "Back to Scribe (Esc)", false));
      } else if (this.variant === "helper") {
        acts.append(button(icon("close"), "ag-icon-btn", () => this.owner.closeHelper(), "Close helper and return to parent chat", false));
      }
      top.append(acts);
      this.header.append(top);
      const meta = el("div", "ag-thead-meta");
      const scope = button("", "ag-scope-chip", (event) => this.scopeMenu(event.currentTarget), SCOPE_CHIP_TITLE);
      fillScopeDisplay(scope, s.scope, t ? workspaceDir(t) : s.cwd);
      meta.append(scope);
      if (t && t.stats.files) {
        const ch = button("", "ag-stat-chip", () => openDiff({ kind: "thread", threadId: t.id }), "Files changed in this thread");
        ch.append(icon("diff"), el("span", null, `${t.stats.files} file${t.stats.files === 1 ? "" : "s"}`), R.counts(t.stats.added, t.stats.removed));
        meta.append(ch);
      }
      this.header.append(meta);
    }

    rename(titleEl) {
      const t = this.thread();
      if (!t) return;
      const input = el("input", "ag-rename");
      input.value = t.title;
      titleEl.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        if (save && input.value.trim() && input.value.trim() !== t.title) {
          await api("PATCH", `/threads/${encodeURIComponent(t.id)}`, { title: input.value.trim() }).catch((err) => notice(err.message));
        }
        this.renderHeader();
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") finish(true);
        if (event.key === "Escape") {
          event.stopPropagation();
          finish(false);
        }
      });
      input.addEventListener("blur", () => finish(true));
    }

    /**
     * Two picks in one menu: the app scope (page, folder, global, or none) and the workspace (a folder,
     * or none). A click picks one and keeps the menu open for the other; a double click also closes it.
     */
    scopeMenu(anchor) {
      const s = this.settings();
      const tab = activeTab();
      const app_ = (scope, rest) => ({ group: "app", keep: true, checked: sameScope(s.scope, scope), run: () => this.setScope(scope), ...rest });
      const items = [{ header: "Scribe access" }];
      if (tab) items.push(app_({ kind: "page", ref: tab.id }, { label: tab.title, detail: "This page", icon: "page" }));
      if (tab?.folderId) items.push(app_({ kind: "folder", ref: tab.folderId }, { label: folderPath(tab.folderId), detail: "This page's folder", icon: "folder" }));
      // A page or folder thread opened elsewhere keeps its own scope in the list.
      if ((s.scope.kind === "page" && s.scope.ref !== tab?.id) || (s.scope.kind === "folder" && s.scope.ref !== tab?.folderId)) {
        const sc = scopeLabel(s.scope);
        items.push(app_({ ...s.scope }, { label: sc.text, detail: s.scope.kind === "page" ? "Its page" : "Its folder", icon: sc.icon }));
      }
      items.push(app_({ kind: "global", ref: null }, { label: "Global", detail: "All pages, not tied to one", icon: "globe" }));
      items.push(app_({ kind: "workspace", ref: s.cwd || null }, { label: "None", detail: "No Scribe pages", icon: "close", checked: s.scope.kind === "workspace" }));
      items.push({ header: "Workspace" });
      const currentWs = s.cwd || null;
      for (const dir of recentWorkspaceDirs(currentWs)) {
        items.push({
          group: "ws",
          keep: true,
          label: R.basename(dir),
          detail: dir,
          icon: "box",
          checked: Boolean(currentWs && dirKey(dir) === dirKey(currentWs)),
          run: () => this.setWorkspace(dir),
        });
      }
      items.push({
        label: "Another workspace…",
        detail: "Browse or pick a folder with threads",
        icon: "folder",
        run: () => this.pickOtherWorkspace(),
      });
      items.push({ group: "ws", keep: true, label: "None", detail: "No files or shell", icon: "close", checked: !currentWs, run: () => this.setWorkspace(null) });
      if (s.scope.kind === "page" && s.scope.ref !== tab?.id && s.scope.ref) {
        items.push({ separator: true }, { label: "Open its page", icon: "page", run: () => app()?.openLink(s.scope.ref) });
      }
      openMenu(anchor, items, { width: 280 });
    }

    /** App scope. None is stored as a workspace scope (a thread only tied to its workspace, or to nothing). */
    async setScope(scope) {
      const cur = this.settings();
      if (scope.kind === "workspace") scope = { kind: "workspace", ref: cur.cwd || null };
      if (sameScope(cur.scope, scope)) return;
      const t = this.thread();
      if (!t) {
        this.draft = { scope, settings: this.draft?.settings || {} };
        this.renderAll();
        if (this.variant === "dock") dock.renderTitle();
        return;
      }
      await this.updateSettings({ scope });
    }

    async applyLocalSlash(name) {
      if (name === "clear") {
        newThread(this, true);
        return;
      }
      const tab = activeTab();
      if (name === "here") {
        if (!tab) {
          notice("Open a page first");
          return;
        }
        await this.setScope({ kind: "page", ref: tab.id });
        return;
      }
      if (name === "folder") {
        if (!tab?.folderId) {
          notice(tab ? "This page is not in a folder" : "Open a page first");
          return;
        }
        await this.setScope({ kind: "folder", ref: tab.folderId });
        return;
      }
      if (name === "workspace") {
        await this.pickOtherWorkspace();
        return;
      }
      if (name === "global") {
        await this.setScope({ kind: "global", ref: null });
      }
    }

    /** The thread's workspace folder, or null for none. A thread with no app scope keeps its scope's ref in step. */
    async setWorkspace(dir) {
      dir = dir || null;
      const cur = this.settings();
      if (dirKey(cur.cwd) === dirKey(dir)) return;
      const scope = cur.scope.kind === "workspace" ? { kind: "workspace", ref: dir } : cur.scope;
      // Code and Plan keep their mode with no workspace: the agent starts in a scratch folder (#273).
      const t = this.thread();
      if (!t) {
        this.draft = { scope, settings: { ...(this.draft?.settings || {}), cwd: dir } };
        this.renderAll();
        if (this.variant === "dock") dock.renderTitle();
        if (dir) await this.rememberDraftPrefs();
        return;
      }
      const wt = openWorktree(t);
      if (wt) {
        if (t.status === "running") {
          notice("Stop the running turn before changing the workspace.");
          return;
        }
        const warning = `Change workspace to ${dir || "none"}? This discards uncommitted changes, deletes branch ${wt.branch}, and removes its worktree folder. Other threads sharing this worktree return to the main checkout.`;
        if (!(await app().confirm(warning, "Discard and change workspace"))) return;
        try {
          const res = await api("POST", `/threads/${encodeURIComponent(t.id)}/worktree`, { action: "discard" });
          notice(res.message);
        } catch (err) {
          notice(err.message);
          return;
        }
      }
      await this.updateSettings({ scope, cwd: dir });
    }

    async pickOtherWorkspace() {
      const dir = await pickWorkspace(homeDir(this.settings()));
      if (dir) await this.setWorkspace(dir);
      this.focus();
    }

    /** Turn a new git worktree on or off for this thread, before its first message. Remembered per workspace. */
    async setWorktree(on) {
      const s = this.settings();
      if (s.cwd && !this.thread()) {
        // Existing threads remember it on the server when patched.
        const p = prefs();
        p.worktrees = { ...(p.worktrees || {}), [dirKey(s.cwd)]: on };
        api("PUT", "/prefs", { worktrees: p.worktrees }).catch(() => undefined);
      }
      await this.updateSettings({ useWorktree: on });
    }

    worktreeMenu(anchor) {
      const t = this.thread();
      const wt = openWorktree(t);
      if (!wt) return;
      const state = [wt.ahead ? `${wt.ahead} commit${wt.ahead === 1 ? "" : "s"}` : "No commits yet", wt.dirty ? "uncommitted changes" : ""].filter(Boolean).join(", ");
      openMenu(
        anchor,
        [
          { header: wt.branch },
          { label: "Changes on this branch", detail: state, icon: "diff", run: () => openDiff({ kind: "git", threadId: t.id }) },
          { label: "Copy worktree path", detail: wt.path, icon: "folder", run: () => navigator.clipboard?.writeText(wt.path) },
          { label: "Preview UI", detail: "Open this worktree’s public/ with the running daemon", icon: "globe", run: () => window.open(`/preview/${encodeURIComponent(t.id)}/`, "_blank", "noopener") },
          { separator: true },
          {
            label: wt.base ? `Merge into ${wt.base}` : "Merge",
            detail: wt.base ? "In the main checkout, then remove the worktree" : "Made from a detached HEAD; nothing to merge into",
            icon: "git",
            disabled: !wt.base || t.status !== "idle",
            run: () => this.finishWorktree("merge"),
          },
          { label: "Leave branch", detail: "Keep the work on the branch, remove the folder", disabled: t.status !== "idle", run: () => this.finishWorktree("leave") },
          { label: "Discard worktree…", detail: "Delete the branch and all its changes", danger: true, disabled: t.status !== "idle", run: () => this.finishWorktree("discard") },
        ],
        { width: 300 }
      );
    }

    /** What the user granted the thread while it ran (web requests, thread access); picking one takes it back. */
    permissionsMenu(anchor) {
      const t = this.thread();
      if (!t?.grants?.length) return;
      const row = (g) => ({
        label: g.label,
        detail: "Remove",
        icon: g.kind === "web" ? "globe" : g.kind === "helpers" ? "task" : g.kind === "pages" ? "page" : "shield",
        run: () =>
          api("PATCH", `/threads/${encodeURIComponent(t.id)}`, { revokeGrant: g.key })
            .then(() => notice(`Removed: ${g.label}`))
            .catch((e) => notice(e.message)),
      });
      const web = t.grants.filter((g) => g.kind === "web");
      const threads = t.grants.filter((g) => g.kind === "threads");
      const helpers = t.grants.filter((g) => g.kind === "helpers");
      const pages = t.grants.filter((g) => g.kind === "pages");
      openMenu(
        anchor,
        [
          ...(web.length ? [{ header: "Web access" }, ...web.map(row)] : []),
          ...(threads.length ? [{ header: "Can read other threads" }, ...threads.map(row)] : []),
          ...(pages.length ? [{ header: "Pages outside its Scribe access" }, ...pages.map(row)] : []),
          ...(helpers.length ? [{ header: "Helper agents" }, ...helpers.map(row)] : []),
        ],
        { width: 320 }
      );
    }

    async finishWorktree(how) {
      const t = this.thread();
      const wt = openWorktree(t);
      if (wt) await finishThreadWorktree(t.id, wt, how);
    }

    threadMenu(anchor) {
      const t = this.thread();
      if (!t) return;
      const helper = this.variant === "helper" || !!t.helperOf;
      openMenu(anchor, [
        ...(!helper ? [
          { label: "Rename", run: () => { const ti = this.header.querySelector(".ag-title"); if (ti) this.rename(ti); } },
          { label: t.pinned ? "Unpin" : "Pin", run: () => api("PATCH", `/threads/${t.id}`, { pinned: !t.pinned }).catch((e) => notice(e.message)) },
        ] : []),
        { label: t.archived ? "Unarchive" : "Archive", run: () => archiveThread(t) },
        ...(!helper && t.stats.turns ? [{ label: "Fork thread", detail: "Continue in a new thread", run: () => forkThread(t, (id) => this.openThread(id)) }] : []),
        { label: "Changes in this thread", icon: "diff", run: () => openDiff({ kind: "thread", threadId: t.id }) },
        ...(openWorktree(t) ? [{ label: "Worktree…", detail: openWorktree(t).branch, icon: "git", run: () => this.worktreeMenu(anchor) }] : []),
        // Only worth a row once there are hooks to turn off; a thread that has them off can always turn them back on.
        ...(hookRules().some((rule) => rule.enabled) || t.hooksOff
          ? [{ label: t.hooksOff ? "Turn detection on" : "Turn detection off", detail: t.hooksOff ? "Hooks ignore this thread" : "Hooks watch this thread", icon: "shield", run: () => api("PATCH", `/threads/${t.id}`, { hooksOff: !t.hooksOff }).catch((e) => notice(e.message)) }]
          : []),
        ...(t.grants?.length ? [{ label: "Permissions…", detail: `${t.grants.length} granted`, icon: "shield", run: () => this.permissionsMenu(anchor) }] : []),
        ...(t.nativeId ? [{ label: "Copy session id", detail: t.nativeId, run: () => navigator.clipboard?.writeText(t.nativeId) }] : []),
        { separator: true },
        {
          label: "Delete thread",
          danger: true,
          run: () => deleteThread(t),
        },
      ]);
    }

    groups(detail) {
      const groups = [];
      const byTurn = new Map();
      for (const item of detail.items) {
        const key = itemGroupKey(item);
        let g = byTurn.get(key);
        if (!g) {
          g = { key, turn: item.turnId ? detail.turns.get(item.turnId) || null : null, items: [] };
          byTurn.set(key, g);
          groups.push(g);
        }
        g.items.push(item);
      }
      // Queued messages always sit at the end.
      const pending = byTurn.get("pending");
      if (pending) {
        groups.splice(groups.indexOf(pending), 1);
        groups.push(pending);
      }
      return groups;
    }

    renderTranscript() {
      if (!this.shown()) {
        this.stale = true;
        this.dirtyTurns.clear();
        return;
      }
      this.stale = false;
      const id = this.threadId;
      const keepPlace = this.transcriptThreadId === id && this.transcriptHadContent && !this.stick;
      const savedTop = keepPlace ? this.scroll.scrollTop : 0;
      this.itemNodes.clear();
      this.transcript.replaceChildren();
      this.queueList.replaceChildren();
      this.queueShown = true;
      const t = this.thread();
      if (!t) {
        this.transcript.append(this.emptyState());
        this.transcriptThreadId = id;
        this.transcriptHadContent = false;
        return;
      }
      const detail = S.details.get(t.id);
      if (!detail) {
        this.transcript.append(el("div", "ag-loading", "Loading…"));
        this.transcriptThreadId = id;
        this.transcriptHadContent = false;
        return;
      }
      if (!detail.items.length) {
        this.transcript.append(this.emptyState());
        this.transcriptThreadId = id;
        this.transcriptHadContent = false;
        return;
      }
      if (this.variant === "dock") {
        const sc = scopeLabel(t.scope);
        const mark = el("div", "ag-scope-mark");
        if (t.scope.kind === "global") mark.append(icon(sc.icon), el("span", null, "Global thread"));
        else if (t.scope.kind === "workspace" && !t.scope.ref) mark.append(icon(sc.icon), el("span", null, "Thread with no scope"));
        else mark.append(icon(sc.icon), el("span", null, `${SCOPE_KIND[t.scope.kind] || "Global"} thread · `), el("b", null, sc.text));
        const dir = workspaceDir(t);
        if (dir && t.scope.kind !== "workspace") {
          mark.append(el("span", "ag-scope-sep", "·"), icon("box"), el("b", null, R.basename(dir) || dir));
        }
        this.transcript.append(mark);
      }
      for (const group of this.groups(detail)) {
        this.groupHost(group.key).append(this.renderGroup(group));
      }
      this.adoptItemNodes(this.transcript);
      this.adoptItemNodes(this.queueList);
      this.markLatest();
      this.measureUserMessages();
      this.updateQueueDock();
      this.transcriptThreadId = id;
      this.transcriptHadContent = true;
      if (keepPlace) this.scroll.scrollTop = savedTop;
      else this.scrollToEnd(true);
    }

    /** Queued messages render into the dock below the scroll; every other turn into the transcript. */
    groupHost(key) {
      return key === "pending" ? this.queueList : this.transcript;
    }

    emptyState() {
      const s = this.settings();
      const box = el("div", "ag-empty");
      const star = el("span", "ag-empty-star");
      star.append(icon("sparkle", "ag-empty-ico"));
      // One shader star per view, moved into each new empty state.
      if (this.starFx === undefined) this.starFx = window.scribeStarFx?.create() || null;
      this.starFx?.mount(star);
      box.append(star);
      box.append(el("div", "ag-empty-title", this.variant === "dock" ? "Ask about this page" : "New thread"));
      const meta = el("div", "ag-empty-meta");
      fillScopeDisplay(meta, s.scope, this.thread() ? workspaceDir(this.thread()) : s.cwd);
      box.append(meta);
      if (this.variant !== "dock" && !this.thread() && localStorage.getItem(LS.presets) !== "0") box.append(this.presetList(s));
      if (localStorage.getItem(LS.tips) === "0") return box;
      const tips =
        s.mode === "board"
          ? ["Summarize this page", "Add a table of the key points", "Find related pages in the Library"]
          : ["Explain how this project is structured", "Find and fix the failing test", "Review my uncommitted changes"];
      const list = el("div", "ag-tips");
      for (const tip of tips) {
        list.append(
          button(tip, "ag-tip", () => {
            this.input.value = tip;
            this.autosize();
            this.focus();
          })
        );
      }
      box.append(list);
      return box;
    }

    /**
     * Quick settings for a new thread: the page in front in Pages mode, or a workspace in Code mode.
     * A pick changes the draft in place, so what is already written stays.
     */
    presetList(s) {
      const list = el("div", "ag-presets");
      const row = (ico, title, detail, tip, on, scope, settings) => {
        const b = button(null, `ag-preset${on ? " on" : ""}`, () => {
          this.draft = { scope, settings: { ...(this.draft?.settings || {}), ...settings } };
          this.renderAll();
          if (this.variant === "dock") dock.renderTitle();
          this.focus();
        }, tip);
        b.append(icon(ico), el("b", null, title), el("span", "ag-preset-detail", detail));
        b.setAttribute("aria-pressed", String(on));
        list.append(b);
      };
      const tab = activeTab();
      if (tab) {
        const scope = { kind: "page", ref: tab.id };
        const on = sameScope(s.scope, scope) && s.mode === PAGE_PRESET.mode && s.web === PAGE_PRESET.web;
        row("page", tab.title, "Pages · full web", "This page: Pages mode, full web access, scoped to this page", on, scope, PAGE_PRESET);
      }
      const dirs = presetWorkspaces();
      if (dirs.length) list.append(el("div", "ag-preset-sep", "Workspaces"));
      for (const dir of dirs) {
        const on =
          s.scope.kind === "global" &&
          dirKey(s.cwd) === dirKey(dir) &&
          !s.useWorktree &&
          Object.keys(WORKSPACE_PRESET).every((key) => key === "useWorktree" || s[key] === WORKSPACE_PRESET[key]);
        row("box", R.basename(dir) || dir, "Code · auto review", `Code mode, Auto review, limited web, no worktree\n${dir}`, on, { kind: "global", ref: null }, { ...WORKSPACE_PRESET, cwd: dir });
      }
      return list;
    }

    renderGroup(group) {
      const wrap = el("div", "ag-turn");
      wrap.dataset.turn = group.key;
      // A message steered into the turn stays where the agent read it, among the steps.
      const opens = (it) => it.kind === "user" && it.steer !== "folded";
      const users = group.items.filter(opens);
      for (const user of users) wrap.append(this.renderUser(user, !group.turn && !user.dropped));
      const body = el("div", "ag-turn-body");
      const rest = group.items.filter((it) => !opens(it));
      const answers = rest.filter((it) => it.kind === "text" && !it.parentToolId);
      const lastAnswer = answers[answers.length - 1];
      const byParent = new Map();
      for (const it of rest) {
        if (it.parentToolId) {
          const list = byParent.get(it.parentToolId) || [];
          list.push(it);
          byParent.set(it.parentToolId, list);
        }
      }
      // Consecutive steps (reasoning, tools) hang on a rail of dots.
      const railed = true;
      let rail = null;
      const put = (node) => {
        const step = railed && !node.classList.contains("ag-helper-call") && (node.classList.contains("ag-reason") || node.classList.contains("ag-tool") || node.classList.contains("ag-group"));
        if (!step) {
          rail = null;
          body.append(node);
          return;
        }
        if (!rail) {
          rail = el("div", "ag-rail");
          body.append(rail);
        }
        rail.append(node);
      };
      let explore = [];
      const flush = () => {
        if (!explore.length) return;
        put(explore.length === 1 ? this.itemNode(explore[0], byParent, group.key, () => this.renderTool(explore[0], byParent)) : this.renderExplore(explore, byParent, group.key));
        explore = [];
      };
      for (const it of rest) {
        if (it.parentToolId) continue;
        // The todos card already shows todo updates.
        if (it.kind === "tool" && it.tool === "todo") continue;
        if (it.kind === "tool" && EXPLORE.has(it.tool) && it.status !== "error") {
          explore.push(it);
          continue;
        }
        flush();
        const node = this.itemNode(it, byParent, group.key, () => this.renderItem(it, byParent, group.turn));
        if (node) {
          if (it.kind === "text" && it !== lastAnswer) node.classList.add("ag-answer-earlier");
          put(node);
        }
      }
      flush();
      if (railed) {
        const rails = body.querySelectorAll(":scope > .ag-rail");
        rails[rails.length - 1]?.lastElementChild?.classList.add("ag-step-last");
        if (this.turnIsLive(group.key)) wrap.classList.add("running");
        // Earlier turns fold their steps and earlier answers into one expandable summary.
        if ((rails.length || answers.length > 1) && group.turn) {
          const key = `s:${group.key}`;
          wrap.classList.toggle("open", this.expanded.has(key));
          // Through closest(): the button can end up in the turn already in the page (dom-sync.js).
          const sum = button("", "ag-sum", (event) => this.toggle(key, event.currentTarget.closest(".ag-turn")), "Show the steps", false);
          sum.append(...this.stepSummary(group), icon("chevron", "ag-ico ag-chev"));
          body.prepend(sum);
        }
      }
      if (body.childElementCount) wrap.append(body);
      if (group.turn) wrap.append(this.renderTurnFooter(group.turn, group.items));
      return wrap;
    }

    /**
     * A step for a turn being drawn again: a stand-in for the node already in the page when nothing it shows
     * changed (scribeKeep), so the step keeps its hover, selection, animations and what was typed in it.
     */
    itemNode(it, byParent, groupKey, build) {
      // Helper calls also show their helper's thread, and a message its place in the queue.
      if (it.kind === "user" || (it.kind === "tool" && helperCall(it))) return build();
      const sig = itemSig(it, byParent);
      const had = this.itemNodes.get(it.id);
      if (had?.sig === sig && had.node.isConnected && had.node.closest(".ag-turn")?.dataset.turn === groupKey && this.root.contains(had.node)) {
        const stub = window.scribeKeep(had.node);
        stub.classList.remove(...PLACE_CLASSES);
        return stub;
      }
      const node = build();
      if (node) {
        // scribeKeep requires a keyed node; some renderers (notices, todos) do not set one themselves.
        node.dataset.itemId = it.id;
        this.itemNodes.set(it.id, { sig, node });
      }
      return node;
    }

    /** After a turn is drawn: the cache points at the steps in the page, which may be earlier copies dom-sync kept. */
    adoptItemNodes(root) {
      for (const node of root.querySelectorAll("[data-item-id]")) {
        const had = this.itemNodes.get(node.dataset.itemId);
        if (had) had.node = node;
      }
    }

    /** "Read 2 files · edited agent.css +8 −6 · 6s" for a turn whose steps are folded away. */
    stepSummary(group) {
      const tools = group.items.filter((it) => it.kind === "tool" && !it.parentToolId);
      const count = (tool) => tools.filter((it) => it.tool === tool).length;
      const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      const parts = [];
      const reads = count("read");
      const searches = count("search");
      const commands = count("execute");
      const thoughts = group.items.filter((it) => it.kind === "reasoning").length;
      if (reads) parts.push(`read ${plural(reads, "file", "files")}`);
      if (searches) parts.push(plural(searches, "search", "searches"));
      if (commands) parts.push(`ran ${plural(commands, "command", "commands")}`);
      const files = group.turn?.files || [];
      const out = [];
      const push = (node) => {
        if (out.length) out.push(el("span", "ag-sum-sep", "·"));
        out.push(node);
      };
      for (const p of parts) push(el("span", null, p));
      if (files.length) {
        const edit = el("span", "ag-sum-edit");
        edit.append(el("span", null, "edited "), el("span", "ag-fname", files.length === 1 ? R.basename(files[0].path) : `${files.length} files`));
        edit.append(R.counts(files.reduce((a, f) => a + (f.added || 0), 0), files.reduce((a, f) => a + (f.removed || 0), 0)));
        push(edit);
      } else if (!parts.length) {
        push(el("span", null, thoughts ? "thought it through" : plural(tools.length, "step", "steps")));
      }
      const turn = group.turn;
      if (turn?.endedAt) {
        push(el("span", null, R.duration(turn.endedAt - turn.startedAt)));
        push(finishStamp(turn.endedAt));
      }
      const first = out[0];
      if (first?.firstChild?.nodeType === Node.TEXT_NODE) first.textContent = first.textContent.charAt(0).toUpperCase() + first.textContent.slice(1);
      else if (first?.firstElementChild) first.firstElementChild.textContent = "Edited ";
      return out;
    }

    /** Every turn but the latest folds its steps; this marks that one after each render. */
    markLatest() {
      const turns = [...this.transcript.querySelectorAll(".ag-turn")].filter((n) => !/^(pending|dropped|note)/.test(n.dataset.turn));
      const last = turns[turns.length - 1];
      for (const n of turns) {
        n.classList.toggle("latest", n === last);
        if (n !== last) n.classList.remove("running");
      }
      // The current-step dot is orange while this turn is live, green once it is not.
      if (last) last.classList.toggle("running", this.turnIsLive(last.dataset.turn));
    }

    /** Orange last-step glow: this turn is still running, or the thread is busy and the turn object has not arrived yet. */
    turnIsLive(turnId) {
      if (!turnId || /^(pending|dropped|note)/.test(turnId)) return false;
      const turn = S.details.get(this.threadId)?.turns.get(turnId);
      if (turn) return turn.status === "running";
      const t = this.thread();
      return Boolean(t && (t.status === "running" || t.status === "waiting"));
    }

    /** Measure rendered height so wrapped paragraphs fold just like multiline messages. */
    measureUserMessages() {
      for (const root of [this.transcript, this.queueList]) {
        for (const content of root.querySelectorAll(".ag-user-content")) {
          const text = content.querySelector(".ag-user-text");
          if (!text.clientWidth) continue;
          const limit = parseFloat(getComputedStyle(text).fontSize) * 16;
          content.classList.toggle("long", text.scrollHeight > limit + 1);
        }
      }
    }

    renderUser(item, queued) {
      const row = el("div", `ag-user${queued ? " queued" : ""}`);
      row.dataset.itemId = item.id;
      const bubble = el("div", "ag-user-bubble");
      if (item.context?.length || item.images?.length || item.files?.length) {
        const chips = el("div", "ag-chips");
        for (const c of item.context || []) {
          const chip = el("span", "ag-chip small");
          chip.dataset.tooltip = chipTitle(c);
          chip.append(icon(chipIcon(c)), el("span", null, chipLabel(c)));
          chips.append(chip);
        }
        const sent = [...(item.images || []), ...(item.files || [])];
        const previews = sent.filter((f) => f.id).map((f) => ({ ...f, url: sentFileUrl(item.threadId, f.id) }));
        for (const file of sent) {
          if (!file.id) {
            // Sent before files were kept: only the name is known.
            const chip = el("span", "ag-chip small");
            chip.append(icon(file.mimeType?.startsWith("image/") ? "image" : "read"), el("span", null, file.name));
            chips.append(chip);
            continue;
          }
          const at = previews.findIndex((f) => f.id === file.id);
          chips.append(fileChip(previews[at], () => window.scribePreview?.open(previews, at)));
        }
        bubble.append(chips);
      }
      const expandedKey = `user:${item.id}`;
      const content = el("div", `ag-user-content${this.expanded.has(expandedKey) ? " expanded" : ""}`);
      const text = el("div", "ag-user-text", item.text);
      const toggle = el("span", "ag-user-expand", this.expanded.has(expandedKey) ? "Show less" : "Click to expand");
      toggle.setAttribute("role", "button");
      toggle.tabIndex = 0;
      const toggleExpanded = () => {
        const expanded = !content.classList.contains("expanded");
        content.classList.toggle("expanded", expanded);
        if (expanded) this.expanded.add(expandedKey);
        else this.expanded.delete(expandedKey);
        toggle.textContent = expanded ? "Show less" : "Click to expand";
        toggle.setAttribute("aria-expanded", String(expanded));
      };
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleExpanded();
      });
      toggle.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggleExpanded();
      });
      content.addEventListener("click", () => {
        if (content.classList.contains("long") && !content.classList.contains("expanded") && !window.getSelection()?.toString()) toggleExpanded();
      });
      toggle.setAttribute("aria-expanded", String(this.expanded.has(expandedKey)));
      content.append(text, toggle);
      bubble.append(content);
      if (item.card) bubble.prepend(el("div", "ag-from-page", item.card.reply ? `Reply on card #${item.card.num}` : item.card.resume ? `Continue card #${item.card.num}` : `Comment on card #${item.card.num}`));
      else if (item.from === "page") bubble.prepend(el("div", "ag-from-page", "Sent by the page"));
      else if (item.from === "scribe") bubble.prepend(el("div", "ag-from-page", "Sent by Scribe"));
      else if (item.from === "hook") bubble.prepend(el("div", "ag-from-page", "Sent by a hook"));
      const flags = hookFlags(item);
      if (flags) bubble.prepend(flags);
      else if (item.from === "agent") bubble.prepend(el("div", "ag-from-page", "Brief from the agent that started this helper"));
      // Your turn is marked with an arrow instead of a bubble.
      row.append(icon("you", "ag-ico ag-you"));
      row.append(bubble);
      const actions = el("div", "ag-user-actions");
      if (item.text) {
        const copy = button(icon("copy"), "ag-icon-btn ag-user-copy", () => {
          navigator.clipboard?.writeText(item.text)?.then(() => {
            copy.classList.add("done");
            setTimeout(() => copy.classList.remove("done"), 1200);
          });
        }, "Copy message");
        actions.append(copy);
      }
      if (item.turnId && !queued && !item.dropped && !item.steer) {
        actions.append(
          button(icon("revert"), "ag-icon-btn", () => this.rewindTo(item, true), "Retry message"),
          button(icon("edit"), "ag-icon-btn", () => this.rewindTo(item, false), "Change sent message")
        );
      }
      if (!item.dropped && !item.turnId && item.steer !== "folded" && !item.editing) {
        actions.append(
          button(icon("close"), "ag-icon-btn", () => this.queueAction("withdraw", item.id), "Cancel message"),
          button(icon("edit"), "ag-icon-btn", () => this.editQueued(item), "Edit message", false)
        );
      }
      if (item.editing) actions.append(button(icon("edit"), "ag-icon-btn", () => this.editQueued(item), "Resume editing message"));
      if (actions.childElementCount) row.append(actions);
      if (item.editing) {
        row.append(el("div", "ag-queued", "Editing — delivery paused"));
      } else if (item.steer === "waiting") {
        row.classList.add("steering");
        const target = emptyEnterTarget(this.threadId);
        const text = target?.id === item.id ? "Steering — waiting for a safe stop · Enter again to send it now" : "Steering — waiting for a safe stop";
        row.append(this.queuedHint(item, text, queuedItemAction(this.threadId, item)));
      } else if (item.steer === "folded") {
        row.classList.add("steered");
        row.append(el("div", "ag-queued", "Steered in"));
      } else if (queued) {
        const target = emptyEnterTarget(this.threadId);
        const send = emptyEnter() === "send";
        const text = target?.id === item.id ? `Queued · Enter again ${send ? "sends it now" : "steers it in"}` : "Queued";
        row.append(this.queuedHint(item, text, queuedItemAction(this.threadId, item)));
      }
      if (item.dropped) {
        row.classList.add("dropped");
        const again = el("div", "ag-queued");
        again.append(el("span", null, "Not sent — stopped before it ran · "), button("Send again", "ag-btn tiny", () => {
          this.input.value = item.text;
          this.autosize();
          this.send();
        }));
        row.append(again);
      }
      return row;
    }

    queuedHint(item, text, action) {
      const hint = el("div", "ag-queued");
      hint.append(el("span", null, text));
      if (action) {
        const send = action === "send-now";
        const btn = button(
          "",
          "ag-queued-act",
          () => this.queueAction(action, item.id),
          send ? "Stop the turn and send this message now" : "Hand this message to the running turn"
        );
        btn.append(icon(send ? "send" : "steer"), el("span", null, send ? "Send now" : "Steer"));
        hint.append(btn);
      }
      return hint;
    }

    renderItem(it, byParent, turn) {
      switch (it.kind) {
        case "user":
          return this.renderUser(it, false);
        case "text": {
          const node = el("div", "ag-md");
          node.dataset.itemId = it.id;
          // The text is re-rendered as it streams, so its flags sit on the node (CSS shows them above it).
          if (it.flags?.length) node.dataset.flags = it.flags.map((flag) => flag.label).join(" · ");
          R.renderMarkdown(node, it.text, mdCtx);
          return node;
        }
        case "reasoning":
          return this.renderReasoning(it);
        case "tool":
          return this.renderTool(it, byParent);
        case "approval":
          return this.renderApproval(it);
        case "question":
          return this.renderQuestion(it);
        case "plan":
          return this.renderPlan(it);
        case "settings":
          return this.renderSettings(it);
        case "todos":
          return this.renderTodos(it);
        case "notice": {
          const n = el("div", `ag-notice ${it.level}`);
          n.append(el("span", null, it.text));
          if (it.level === "error" && /^(Folder not found|Not a folder|Cannot access folder): /.test(it.text)) {
            const recovery = button("Choose folder", "ag-btn small", async () => {
              try {
                if (openWorktree(this.thread())) {
                  await this.finishWorktree("leave");
                  if (openWorktree(this.thread())) return;
                }
                await this.pickOtherWorkspace();
              } catch (err) {
                notice(err.message);
              }
            });
            n.append(document.createTextNode(" "), recovery);
            const gone = /^Folder not found: (.+)$/.exec(it.text)?.[1];
            if (gone) {
              n.append(document.createTextNode(" "), button("Locate moved folder…", "ag-btn small", () => locateWorkspace(gone), "If the folder was renamed or moved: pick where it is now, and every thread and setting that used it follows"));
              if (Date.now() - missingAt > 2000) loadMissing();
            }
          }
          return n;
        }
        default:
          return null;
      }
    }

    toggle(key, node, cls = "open") {
      if (this.expanded.has(key)) this.expanded.delete(key);
      else this.expanded.add(key);
      node.classList.toggle(cls, this.expanded.has(key));
    }

    /**
     * Back to just before a message: later turns leave the chat and their changes are undone. Then
     * the message is sent again (retry) or put back in the composer (edit).
     */
    async rewindTo(item, resend) {
      const t = this.thread();
      if (!t) return;
      if (t.status !== "idle" || t.queued) return notice("Stop the running turn first");
      const detail = S.details.get(t.id);
      const from = detail?.turns.get(item.turnId);
      if (!from) return;
      const later = [...detail.turns.values()].filter((x) => x.seq >= from.seq);
      const files = new Set(later.filter((x) => !x.reverted).flatMap((x) => (x.files || []).map((f) => f.path)));
      const page = later.some((x) => x.page?.after && !x.page.reverted);
      let keepChanges = false;
      if (later.length > 1 || files.size || page) {
        const choice = await confirmRewind({ turns: later.length, files: files.size, page, resend });
        if (!choice) return;
        keepChanges = choice.keepChanges;
      }
      let msg;
      try {
        msg = await api("POST", `/threads/${encodeURIComponent(t.id)}/rewind`, { itemId: item.id, keepChanges });
      } catch (err) {
        notice(err.message);
        return;
      }
      if (resend) {
        this.stick = true;
        await api("POST", `/threads/${encodeURIComponent(t.id)}/messages`, { text: msg.text, images: msg.images, files: msg.files, context: msg.context }).catch((err) => notice(err.message));
        return;
      }
      this.input.value = msg.text || "";
      this.clearAttachments();
      this.attachments = [...(msg.images || []), ...(msg.files || [])].map((f) => ({ ...f, size: Math.floor((f.data.length * 3) / 4), url: base64Url(f.data, f.mimeType) }));
      this.restoreContextChips(msg.context);
      this.renderContext();
      this.autosize();
      this.focus();
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    }

    renderReasoning(it) {
      const running = !it.endedAt;
      const openDefault = localStorage.getItem(LS.reasoning) === "1";
      const key = `r:${it.id}`;
      const isOpen = this.expanded.has(key) !== openDefault;
      const node = el("div", `ag-reason${isOpen ? " open" : ""}${running ? " live" : ""}`);
      node.dataset.itemId = it.id;
      const head = button("", "ag-reason-head", () => {
        this.toggle(key, node);
        if (node.classList.contains("open")) fillLazy(node);
      });
      const secs = it.endedAt && it.endedAt - it.startedAt >= 1000 ? R.duration(it.endedAt - it.startedAt) : "";
      head.append(icon("think"), el("span", "ag-reason-label", running ? "Thinking" : `Thought${secs ? ` for ${secs}` : ""}`), el("span", "ag-reason-preview", lastLine(it.text)), ...[hookFlags(it)].filter(Boolean), icon("chevron", "ag-ico ag-chev"));
      const body = el("div", "ag-reason-body ag-md");
      const fill = () => R.renderMarkdown(body, it.text, mdCtx);
      if (isOpen) fill();
      else lazyBodies.set(node, fill);
      node.append(head, body);
      return node;
    }

    renderExplore(items, byParent, groupKey) {
      const key = `g:${items[0].id}`;
      const running = items.some((it) => it.status === "running" || it.status === "pending");
      const node = el("div", `ag-group${this.expanded.has(key) ? " open" : ""}${running ? " live" : ""}`);
      const reads = items.filter((it) => it.tool === "read").length;
      const searches = items.filter((it) => it.tool === "search").length;
      const other = items.length - reads - searches;
      const parts = [];
      if (reads) parts.push(`${reads} file${reads === 1 ? "" : "s"}`);
      if (searches) parts.push(`${searches} search${searches === 1 ? "" : "es"}`);
      if (other) parts.push(`${other} step${other === 1 ? "" : "s"}`);
      node.dataset.key = key;
      const head = button("", "ag-group-head", (event) => this.toggle(key, event.currentTarget.closest(".ag-group")));
      head.dataset.key = key;
      head.append(
        running ? el("span", "ag-spin") : icon("search"),
        el("span", "ag-group-label", `${running ? "Exploring" : "Explored"} ${parts.join(", ")}`),
        el("span", "ag-group-preview", items[items.length - 1].title),
        icon("chevron", "ag-ico ag-chev")
      );
      const body = el("div", "ag-group-body");
      for (const it of items) body.append(this.itemNode(it, byParent, groupKey, () => this.renderTool(it, byParent)));
      node.append(head, body);
      return node;
    }

    renderTool(it, byParent) {
      const helper = helperCall(it);
      if (helper && !helper.existing) return this.renderHelperCall(it, helper);
      const key = `t:${it.id}`;
      const task = it.task;
      const open = this.expanded.has(key);
      const node = el("div", `ag-tool k-${it.tool} s-${it.status}${task ? ` has-task ts-${task.status}` : ""}${open ? " open" : ""}`);
      node.dataset.itemId = it.id;
      if (helper) {
        node.classList.add("ag-helper-action");
        if (helper.id) node.dataset.helper = helper.id;
      }
      const head = button("", "ag-tool-head", () => {
        this.toggle(key, node);
        if (node.classList.contains("open")) fillLazy(node);
      });
      // A task outlives its tool call: a background agent is still working after the call returned.
      const busy = task ? task.status === "running" : it.status === "running" || it.status === "pending";
      const failed = task ? task.status === "error" : it.status === "error";
      const status = busy ? el("span", "ag-spin") : failed ? icon("cross", "ag-ico ag-st-err") : icon(helper ? "task" : it.tool, "ag-ico");
      head.append(status);
      const label = el("span", "ag-tool-label");
      const page = pageTool(it);
      const fileSummary = fileToolSummary(it);
      if (helper) {
        const action = helper.input.stop === true ? "Stop helper" : typeof helper.input.task === "string" && helper.input.task.trim() ? "Follow up helper" : "Wait for helper";
        label.append(el("span", "ag-tool-verb", action), el("span", "ag-tool-title", helper.thread ? helperName(helper.thread) : helper.id));
      } else if (page) {
        label.append(...this.pageToolLabel(page));
      } else if (fileSummary) {
        const title = el("span", "ag-tool-title", fileSummary);
        title.dataset.tooltip = fileSummary;
        title.setAttribute("aria-description", fileSummary);
        label.append(title);
      } else if ((it.tool === "edit" || it.tool === "delete") && (it.files?.length || it.paths?.length)) {
        const files = it.files?.length ? it.files : it.paths.map((p) => ({ path: p }));
        label.append(el("span", "ag-tool-verb", it.tool === "delete" ? "Delete" : files.some((f) => f.status === "A") ? "Create" : "Edit"));
        for (const f of files.slice(0, 3)) {
          const chip = el("span", "ag-file");
          chip.append(el("span", "ag-fname", R.basename(f.path)));
          if (f.added !== undefined) chip.append(R.counts(f.added, f.removed));
          chip.dataset.tooltip = f.path;
          label.append(chip);
        }
        if (files.length > 3) label.append(el("span", "ag-muted", `+${files.length - 3} more`));
      } else if (it.tool === "execute") {
        label.append(el("code", "ag-cmd", it.detail || it.title));
        if (it.detail && it.title && it.title !== it.detail && !it.title.startsWith("`")) label.dataset.tooltip = it.title;
      } else {
        label.append(el("span", "ag-tool-title", it.title));
      }
      head.append(label);
      const flags = hookFlags(it);
      if (flags) head.append(flags);
      if (task) head.append(el("span", `ag-task-badge ts-${task.status}`, taskStatusLabel(task)));
      if (it.exitCode !== undefined && it.tool === "execute") head.append(el("span", `ag-exit${it.exitCode === 0 ? " ok" : " bad"}`, it.exitCode === 0 ? "exit 0" : `exit ${it.exitCode}`));
      if (it.endedAt && it.startedAt && it.endedAt - it.startedAt > 1500) head.append(el("span", "ag-muted ag-dur", R.duration(it.endedAt - it.startedAt)));
      head.append(icon("chevron", "ag-ico ag-chev"));
      node.append(head);
      if (task) node.append(this.renderTaskLine(it));
      const children = byParent.get(it.toolId);
      const steps = children ? children.filter((c) => c.kind === "tool").length : 0;
      if (steps) label.append(el("span", "ag-muted", ` · ${steps} ${steps === 1 ? "step" : "steps"}`));
      const body = el("div", "ag-tool-body");
      const fill = () => {
        if (page) {
          this.pageToolBody(body, it, page);
        } else if (it.tool === "execute") {
          if (it.detail && it.title && !it.title.startsWith("`") && it.title !== it.detail) body.append(el("div", "ag-tool-desc", it.title));
          // The head cuts the command to one line; the body has all of it.
          if (it.detail) body.append(el("pre", "ag-pre small ag-cmd-full", it.detail));
        } else if (it.detail && it.tool !== "execute" && !(it.tool === "task" && typeof it.input?.prompt === "string")) body.append(el("pre", "ag-pre small", it.detail));
        if (it.diff) {
          const files = R.parsePatch(it.diff);
          for (const f of files) {
            const fh = el("div", "ag-inline-diff-head");
            fh.append(el("span", "ag-fpath", f.path), R.counts(f.added, f.removed), button("Open", "ag-btn tiny", () => openDiff({ kind: "turn", threadId: it.threadId, turnId: it.turnId, path: f.path })));
            body.append(fh, R.renderDiffFile(f, { collapsedAfter: 160 }));
          }
        } else if (it.tool === "task" && typeof it.input?.prompt === "string") {
          // The brief the agent gave its subagent, readable rather than as JSON.
          const brief = el("div", "ag-task-brief");
          brief.append(el("div", "ag-task-brief-label", it.input.subagent_type ? `Brief for ${it.input.subagent_type}` : "Brief"));
          const md = el("div", "ag-md small");
          R.renderMarkdown(md, it.input.prompt, mdCtx);
          brief.append(md);
          body.append(brief);
        } else if (it.input && (it.tool === "mcp" || it.tool === "other" || it.tool === "fetch" || it.tool === "task")) {
          body.append(el("pre", "ag-pre small", jsonText(it.input)));
        }
        // A background task's tool result is only the launch receipt; its outcome is on the task line.
        if (it.output && it.tool !== "read" && !task?.background && !page) {
          const out = el("pre", "ag-pre ag-out", it.output.length > 6000 ? `${it.output.slice(0, 6000)}\n…` : it.output);
          body.append(out);
        }
        if (children?.length) {
          const sub = el("div", "ag-subtools");
          for (const child of children) {
            const n = child.kind === "tool" ? this.renderTool(child, byParent) : this.renderItem(child, byParent);
            if (n) sub.append(n);
          }
          body.append(sub);
        }
      };
      // A collapsed step builds its body (diffs, briefs, output) the first time it is opened.
      if (open || page) fill();
      else if (toolHasBody(it, children)) lazyBodies.set(node, fill);
      if (body.childElementCount || lazyBodies.has(node)) node.append(body);
      else node.classList.add("bare");
      return node;
    }

    /**
     * A helper launch as a task row: the helper and its model in the head, under it what the helper
     * is doing now (or how it ended) with a way into its thread, and the brief and report in the body.
     */
    renderHelperCall(it, call) {
      const key = `t:${it.id}`;
      const h = call.thread;
      const state = call.state;
      const node = el("div", `ag-tool ag-helper-call has-task ts-${state === "waiting" ? "running" : state} s-${it.status}${this.expanded.has(key) ? " open" : ""}`);
      node.dataset.itemId = it.id;
      if (call.id) node.dataset.helper = call.id;
      if (call.live) node.dataset.live = "1";
      const head = button("", "ag-tool-head", () => h ? this.openHelper(h.id) : this.toggle(key, node));
      head.append(call.live ? el("span", "ag-spin") : state === "error" ? icon("cross", "ag-ico ag-st-err") : icon("task", "ag-ico"));
      const label = el("span", "ag-tool-label");
      const task = typeof call.input.task === "string" ? call.input.task.trim() : "";
      const name = h ? helperName(h) : task.split("\n")[0] || "Helper agent";
      const title = el("span", "ag-tool-title", name);
      title.dataset.tooltip = name;
      label.append(el("span", "ag-tool-verb", "Helper"), title);
      const model = h ? modelLabel(h.provider, h.model) : [call.input.provider, call.input.model].filter((v) => typeof v === "string" && v).join(" · ");
      head.append(label);
      if (model) {
        const chip = el("span", "ag-muted ag-helper-model");
        if (h) chip.append(providerIcon(h.provider));
        chip.append(el("span", null, model));
        head.append(chip);
      }
      head.append(el("span", `ag-task-badge ts-${state}`, { running: "working", waiting: "needs you", done: "done", error: "failed", stopped: "stopped" }[state]));
      if (it.endedAt && it.startedAt && it.endedAt - it.startedAt > 1500) head.append(el("span", "ag-muted ag-dur", R.duration(it.endedAt - it.startedAt)));
      if (h) head.setAttribute("aria-label", `Open helper: ${name}`);
      node.append(head);

      const line = el("div", "ag-task-line");
      const files = Array.isArray(call.result?.files) ? call.result.files : [];
      const what = call.live
        ? h
          ? helperStep(h)
          : "Waiting to start…"
        : state === "error"
          ? String(call.result?.error || it.output || "").trim().split("\n")[0]
          : files.length
            ? `Changed ${files.length} ${files.length === 1 ? "file" : "files"}`
            : "";
      if (what) {
        const text = el("span", "ag-task-summary", what);
        text.dataset.tooltip = what;
        line.append(text);
      }
      const tokens = (call.result?.tokens?.input || 0) + (call.result?.tokens?.output || 0);
      if (tokens) line.append(el("span", "ag-task-usage", `${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tokens`));
      if (h) {
        const actions = el("span", "ag-task-actions");
        const summaryLabel = el("span", null, this.expanded.has(key) ? "Hide summary" : "Show summary");
        const summary = button("", "ag-btn small ghost ag-helper-summary", (event) => {
          event.stopPropagation();
          this.toggle(key, node);
          summaryLabel.textContent = this.expanded.has(key) ? "Hide summary" : "Show summary";
          summary.setAttribute("aria-expanded", String(this.expanded.has(key)));
        });
        summary.append(icon("chevron", "ag-ico ag-chev"), summaryLabel);
        summary.setAttribute("aria-expanded", String(this.expanded.has(key)));
        actions.append(summary);
        if (call.live && h.status !== "idle") {
          actions.append(
            button(icon("stop"), "ag-send stop ag-helper-stop", (event) => {
              event.stopPropagation();
              event.currentTarget.disabled = true;
              api("POST", `/threads/${encodeURIComponent(h.id)}/cancel`).catch((err) => notice(err.message));
            }, "Stop this helper")
          );
          actions.lastChild.setAttribute("aria-label", "Stop this helper");
        }
        line.append(actions);
      }
      if (line.childElementCount) node.append(line);
      if (h) node.addEventListener("click", (event) => {
        if (!event.target.closest("button, a, input, .ag-tool-body")) this.openHelper(h.id);
      });

      const body = el("div", "ag-tool-body");
      const part = (heading, text) => {
        const wrap = el("div", "ag-task-brief");
        wrap.append(el("div", "ag-task-brief-label", heading));
        const md = el("div", "ag-md small");
        R.renderMarkdown(md, text, mdCtx);
        wrap.append(md);
        body.append(wrap);
      };
      if (task) part(typeof call.input.thread === "string" && call.input.thread ? "Follow-up" : "Brief", task);
      if (typeof call.result?.reply === "string" && call.result.reply) part("Report", call.result.reply);
      if (files.length) body.append(el("pre", "ag-pre small", files.join("\n")));
      if (!call.result && it.output) body.append(el("pre", "ag-pre ag-out", it.output.length > 6000 ? `${it.output.slice(0, 6000)}\n…` : it.output));
      if (body.childElementCount) node.append(body);
      else node.classList.add("bare");
      return node;
    }

    /** A helper of this thread changed: bring its rows in the transcript and the strip above the input up to date. */
    onHelper(helper) {
      if (helper.status === "idle" && !S.details.has(helper.id) && !S.loading.has(helper.id)) {
        ensureDetail(helper.id).then((detail) => { if (detail) this.onHelper(S.threads.get(helper.id) || helper); });
      }
      const detail = S.details.get(this.threadId);
      for (const node of this.transcript.querySelectorAll(".ag-helper-call, .ag-helper-action")) {
        if (node.dataset.helper && node.dataset.helper !== helper.id) continue;
        const it = detail?.byId.get(node.dataset.itemId);
        const call = it && helperCall(it);
        if (call && call.id === helper.id) node.replaceWith(this.renderTool(it, new Map()));
      }
      this.renderHelperDock();
    }

    /** True while a working helper's row in the transcript is in view: the strip above the input then leaves it out. */
    helperRowInView(id) {
      const view = this.scroll.getBoundingClientRect();
      if (!view.height) return false;
      for (const node of this.transcript.querySelectorAll(".ag-helper-call[data-live]")) {
        if (node.dataset.helper !== id) continue;
        const rect = node.getBoundingClientRect();
        if (rect.height && rect.bottom > view.top + 8 && rect.top < view.bottom - 8) return true;
      }
      return false;
    }

    /**
     * Above the input: this thread's helpers that are working, each with its live step, a click into
     * its thread and a stop button. Ones whose row in the transcript is in view are left out, and
     * more than fit fold into one line.
     */
    renderHelperDock() {
      const box = this.helperDock;
      const busy = this.threadId ? helpersOf(this.threadId).filter((t) => t.status !== "idle" && !t.archived) : [];
      const approvals = busy.filter((t) => t.asking?.kind === "approval");
      const approvalKey = JSON.stringify(approvals.map((t) => [t.id, t.title, t.model, t.asking]));
      if (approvalKey !== this.helperApprovalKey) {
        this.helperApprovalKey = approvalKey;
        this.helperApprovals.replaceChildren();
        this.helperApprovals.hidden = !approvals.length;
        for (const t of approvals) {
          const wrap = el("div", "ag-helper-approval");
          wrap.append(button(`Helper · ${helperName(t)} · ${modelLabel(t.provider, t.model)}`, "ag-helper-approval-name", () => this.openHelper(t.id)));
          wrap.append(this.renderApproval({ ...t.asking, id: t.asking.itemId, requestId: t.asking.itemId, options: t.asking.options || [], status: "pending" }));
          this.helperApprovals.append(wrap);
        }
      }
      this.helpersBusy = busy.length;
      const shown = busy.filter((t) => !this.helperRowInView(t.id));
      const limit = this.variant === "dock" ? 1 : 3;
      const fold = shown.length > limit;
      const open = fold && this.helpersOpen;
      const key = JSON.stringify([open, shown.map((t) => [t.id, t.status, helperStep(t), t.title])]);
      if (key === this.helperDockKey) return;
      this.helperDockKey = key;
      box.replaceChildren();
      box.hidden = !shown.length;
      if (!shown.length) return;
      if (fold) {
        const waiting = shown.filter((t) => t.status === "waiting").length;
        const sum = button("", `ag-helper-row ag-helper-sum${open ? " open" : ""}`, () => {
          this.helpersOpen = !this.helpersOpen;
          this.renderHelperDock();
        }, open ? "Show one line" : "Show each helper");
        sum.append(
          waiting ? el("span", "ag-dot s-waiting") : el("span", "ag-spin"),
          el("span", "ag-helper-name", `${shown.length} helpers working`),
          el("span", "ag-helper-step", waiting ? `${waiting} ${waiting === 1 ? "needs" : "need"} your answer` : helperStep(shown[shown.length - 1])),
          icon("chevron", "ag-ico ag-chev")
        );
        box.append(sum);
        if (!open) return;
      }
      for (const t of shown) {
        const item = el("div", "ag-helper-item");
        const row = button("", "ag-helper-row", () => this.openHelper(t.id), "Open the helper's thread");
        row.append(
          t.status === "waiting" ? el("span", "ag-dot s-waiting") : el("span", "ag-spin"),
          providerIcon(t.provider),
          el("span", "ag-helper-name", helperName(t)),
          el("span", "ag-helper-step", helperStep(t))
        );
        item.append(
          row,
          button(icon("stop"), "ag-icon-btn small ag-helper-stop", (event) => {
            event.stopPropagation();
            api("POST", `/threads/${encodeURIComponent(t.id)}/cancel`).catch((err) => notice(err.message));
          }, "Stop this helper")
        );
        item.lastChild.setAttribute("aria-label", "Stop this helper");
        box.append(item);
      }
    }

    /** A Scribe page write's head: what it did, and the page as a chip that opens it. */
    pageToolLabel(page) {
      const parts = [];
      const chip = page.ref ? this.pageChip(page) : null;
      if (page.name === "page_action") {
        if (chip) parts.push(chip);
        const text = el("span", "ag-tool-verb ag-tool-title", page.summary);
        text.dataset.tooltip = page.summary;
        parts.push(text);
        return parts;
      }
      parts.push(el("span", "ag-tool-verb", page.verb));
      if (chip) parts.push(chip);
      if (page.summary) parts.push(el("span", "ag-muted ag-tool-title", page.summary));
      return parts;
    }

    pageChip(page) {
      const chip = el("span", "ag-page-chip", page.title);
      chip.setAttribute("role", "link");
      const open = (event) => {
        if (event.type === "auxclick" && event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        app()?.openLink(page.ref, event, { mode: "peek" });
      };
      chip.addEventListener("click", open);
      chip.addEventListener("auxclick", open);
      chip.addEventListener("mousedown", (event) => { if (event.button === 1) event.preventDefault(); });
      return chip;
    }

    /** A Scribe page write's body: open the page, then what changed in a readable form, and the raw call one click away. */
    pageToolBody(body, it, page) {
      const input = isRecord(it.input) ? it.input : {};
      if (page.ref) {
        const actions = el("div", "ag-page-tool-actions");
        const open = (mode) => (event) => {
          event.stopPropagation();
          app()?.openLink(page.ref, mode ? null : event, { mode });
        };
        actions.append(button("Open", "ag-btn tiny", open(null)), button("Peek", "ag-btn tiny", open("peek")), button("Split", "ag-btn tiny", open("split")));
        body.append(actions);
      }
      if (it.status === "error" && it.output) body.append(el("pre", "ag-pre ag-out", it.output.slice(0, 2000)));
      if (page.name === "page_show") {
        if (typeof input.htmlPath === "string") body.append(el("div", "ag-tool-desc", `Loaded HTML from ${input.htmlPath}`));
      } else if (page.name === "page_patch") {
        const edits = Array.isArray(input.edits) ? input.edits.filter(isRecord) : [];
        edits.forEach((edit, i) => {
          const file = snippetDiff(String(edit.oldString ?? ""), String(edit.newString ?? ""));
          const head = el("div", "ag-inline-diff-head");
          const name = edits.length > 1 ? `Edit ${i + 1}${edit.replaceAll ? " (all matches)" : ""}` : edit.replaceAll ? "All matches" : "Edit";
          head.append(el("span", "ag-fpath", name), R.counts(file.added, file.removed));
          body.append(head, R.renderDiffFile(file, { collapsedAfter: 80 }));
        });
        if (typeof input.htmlPath === "string") body.append(el("div", "ag-tool-desc", `Replaced the HTML with ${input.htmlPath}`));
        if (typeof input.title === "string") body.append(el("div", "ag-tool-desc", `Renamed to “${input.title}”`));
      } else if (page.name === "page_update") {
        const ops = Array.isArray(input.ops) ? input.ops.filter(isRecord) : [];
        if (ops.length) {
          const list = el("div", "ag-page-ops");
          for (const op of ops.slice(0, 40)) list.append(el("div", "ag-page-op", opLine(op)));
          if (ops.length > 40) list.append(el("div", "ag-muted", `+${ops.length - 40} more`));
          body.append(list);
        }
      } else if (page.name === "page_action") {
        const args = isRecord(input.args) ? input.args : {};
        const text = [args.text, args.summary, args.note, args.description].find((v) => typeof v === "string" && v.trim());
        if (text) {
          const md = el("div", "ag-md small ag-page-tool-text");
          R.renderMarkdown(md, text, mdCtx);
          body.append(md);
        }
      }
      const rawKey = `raw:${it.id}`;
      const raw = el("div", `ag-page-raw${this.expanded.has(rawKey) ? " open" : ""}`);
      const toggle = button("Raw call", "ag-btn tiny ag-page-raw-toggle", (event) => {
        event.stopPropagation();
        this.toggle(rawKey, raw);
      });
      const shown = { ...input };
      if (typeof shown.html === "string" && shown.html.length > 600) shown.html = `${shown.html.slice(0, 600)}… (${shown.html.length} chars)`;
      const rawBody = el("div", "ag-page-raw-body");
      rawBody.append(el("pre", "ag-pre small", jsonText(shown)));
      if (it.output && it.status !== "error") rawBody.append(el("pre", "ag-pre ag-out", it.output.length > 6000 ? `${it.output.slice(0, 6000)}\n…` : it.output));
      raw.append(toggle, rawBody);
      body.append(raw);
    }

    /** Under a task's head, always visible: what it is doing now (or how it ended), its usage, and its controls. */
    renderTaskLine(it) {
      const task = it.task;
      const line = el("div", "ag-task-line");
      const running = task.status === "running";
      const what = task.summary || (running ? (task.lastTool ? `Using ${task.lastTool}` : "Starting…") : "");
      // A stopped task reports its own description as the summary; the head already says it.
      if (what && !(it.title || "").endsWith(what)) {
        const text = el("span", "ag-task-summary", what);
        text.dataset.tooltip = what;
        line.append(text);
      }
      const usage = [];
      if (task.toolUses) usage.push(`${task.toolUses} ${task.toolUses === 1 ? "tool use" : "tool uses"}`);
      if (task.tokens) usage.push(`${task.tokens >= 1000 ? `${Math.round(task.tokens / 1000)}k` : task.tokens} tokens`);
      if (task.durationMs) usage.push(R.duration(task.durationMs));
      if (usage.length) line.append(el("span", "ag-task-usage", usage.join(" · ")));
      if (running) {
        const actions = el("span", "ag-task-actions");
        const call = (action, label) =>
          button(label, "ag-btn tiny", async (event) => {
            event.stopPropagation();
            event.currentTarget.disabled = true;
            try {
              const result = await api("POST", `/threads/${encodeURIComponent(it.threadId)}/tasks/${encodeURIComponent(it.id)}/${action}`);
              if (action === "background" && result && result.moved === false) notice("It already finished or is not running in the foreground");
            } catch (err) {
              notice(err.message);
              event.currentTarget.disabled = false;
            }
          });
        // Only a call the turn is still waiting on can move to the background.
        if (!task.background && (it.status === "running" || it.status === "pending")) actions.append(call("background", "Run in background"));
        actions.append(call("stop", "Stop"));
        line.append(actions);
      }
      if (!line.childElementCount) line.hidden = true;
      return line;
    }

    renderApproval(it) {
      const node = el("div", `ag-card ag-approval s-${it.status}`);
      node.dataset.itemId = it.id;
      if (it.status !== "pending") {
        cardNotes.delete(`approval:${it.id}`);
        const opt = it.options.find((o) => o.id === it.decision);
        const allowed = opt ? opt.kind.startsWith("allow") : false;
        node.classList.add("done");
        node.append(icon(it.status === "expired" ? "other" : allowed ? "check" : "cross", `ag-ico ${allowed ? "ag-st-ok" : "ag-st-err"}`), el("span", "ag-card-line", `${it.status === "expired" ? "Not answered" : opt?.label || it.decision}: ${it.title}`));
        if (it.note) node.append(el("span", "ag-muted", ` — ${it.note}`));
        return node;
      }
      const head = el("div", "ag-card-head");
      head.append(icon("shield"), el("span", "ag-card-title", it.title));
      node.append(head);
      if (it.detail) node.append(el("pre", "ag-pre small", it.detail));
      const note = keepNote(el("input", "ag-input small"), `approval:${it.id}`);
      note.placeholder = "Note for the agent (optional, sent with Deny)";
      const actions = el("div", "ag-card-actions");
      for (const opt of it.options) {
        const primary = opt.kind === "allow_once";
        const b = button(opt.label, `ag-btn small${primary ? " primary" : ""}${opt.kind.startsWith("reject") ? " danger" : ""}`, async () => {
          for (const x of actions.querySelectorAll("button")) x.disabled = true;
          try {
            await api("POST", `/approvals/${encodeURIComponent(it.requestId)}`, { optionId: opt.id, note: opt.kind.startsWith("reject") ? note.value : undefined });
          } catch (err) {
            notice(err.message);
            for (const x of actions.querySelectorAll("button")) x.disabled = false;
          }
        });
        if (opt.description) {
          b.dataset.tooltip = opt.description;
          b.setAttribute("aria-description", opt.description);
        }
        actions.append(b);
      }
      node.append(note, actions);
      return node;
    }

    renderQuestion(it) {
      if (it.page) return this.renderPageQuestion(it);
      const node = el("div", `ag-card ag-question s-${it.status}`);
      node.dataset.itemId = it.id;
      if (it.status !== "pending") {
        closeQuestionForm(it.id);
        node.classList.add("done");
        const parts = it.questions.map((q) => {
          const given = questionAnswerText(q, it.answers?.[q.id] || []);
          const note = it.notes?.[q.id];
          const answer = given.length ? given.join(", ") : it.status === "skipped" ? "Skipped" : "—";
          return `${q.prompt}: ${answer}${note ? ` (${note})` : ""}`;
        });
        const line = el("span", "ag-card-line", parts.join(" · ") || (it.status === "skipped" ? "Skipped" : "Not answered"));
        line.dataset.tooltip = line.textContent;
        node.append(
          icon(it.status === "answered" ? "check" : "cross", `ag-ico ${it.status === "answered" ? "ag-st-ok" : "ag-st-err"}`),
          line
        );
        return node;
      }
      const head = el("div", "ag-card-head");
      head.append(icon("question"), el("span", "ag-card-title", it.title || (it.questions.length > 1 ? "The agent has questions" : "The agent has a question")));
      node.append(head);
      const draft = questionDraft(it.id);
      const skip = button("Skip", "ag-btn small", async () => {
        await api("POST", `/questions/${encodeURIComponent(it.requestId)}`, { skip: true }).catch((err) => notice(err.message));
      });
      const actions = el("div", "ag-card-actions");
      if (it.display === "dialog") {
        // Many questions: a banner here, the form in a dialog.
        node.classList.add("ag-q-banner");
        const status = el("div", "ag-q-banner-line");
        const count = () => {
          const done = it.questions.filter((q) => questionAnswered(q, draft)).length;
          status.textContent = `${it.questions.length} questions${done ? ` · ${done} answered` : ""}`;
        };
        count();
        draft.onChange = count;
        node.append(status);
        actions.append(button("Answer", "ag-btn small primary ag-q-open", () => openQuestionForm(it)), skip);
      } else {
        const fields = questionFields(it, draft, null, false);
        node.append(fields);
        actions.append(
          button("Submit", "ag-btn small primary", () => submitQuestion(it, draft, node)),
          skip
        );
        node.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submitQuestion(it, draft, node);
          }
        });
      }
      node.append(actions);
      return node;
    }

    /** settings_show: the settings dialogs' own rows, lent to the chat (settings-ui.js), so they work here too. */
    renderSettings(it) {
      const node = el("div", "ag-card ag-settings-card");
      node.dataset.itemId = it.id;
      if (it.title) {
        const head = el("div", "ag-card-head");
        head.append(icon("gear"), el("span", "ag-card-title", it.title));
        node.append(head);
      }
      const body = el("div");
      const { missing } = window.scribeSettingsUI.lend(body, it.ids);
      node.append(body);
      if (missing.length) node.append(el("div", "ag-muted", missing.length === it.ids.length ? "These settings are no longer in Scribe." : `Not found any more: ${missing.join(", ")}`));
      return node;
    }

    /** page_ask: the user answers on a form page; its submit event resumes the turn. */
    renderPageQuestion(it) {
      const node = el("div", `ag-card ag-question ag-page-ask s-${it.status}`);
      node.dataset.itemId = it.id;
      const pageTitle = app()?.resolvePages?.([it.page.key])?.[it.page.key]?.title || it.page.title;
      const open = (event) => app()?.openLink(it.page.key, event, { mode: "peek" });
      const pageLink = el("a", "ag-board-link", pageTitle);
      pageLink.tabIndex = 0;
      const onOpen = (event) => {
        if (event.type === "auxclick" && event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        open(event);
      };
      pageLink.addEventListener("click", onOpen);
      pageLink.addEventListener("auxclick", onOpen);
      if (it.status !== "pending") {
        cardNotes.delete(`ask:${it.id}`);
        node.classList.add("done");
        const answered = it.status === "answered";
        const text = answered ? "Answered on " : it.status === "skipped" ? "Skipped · " : "Not answered · ";
        const line = el("span", "ag-card-line");
        line.append(text, pageLink);
        node.append(icon(answered ? "check" : "cross", `ag-ico ${answered ? "ag-st-ok" : "ag-st-err"}`), line);
        return node;
      }
      const head = el("div", "ag-card-head");
      head.append(icon("question"), el("span", "ag-card-title", it.title || "The agent needs your answer"));
      node.append(head);
      const body = el("div", "ag-q-prompt");
      body.append("Answer on ", pageLink, ". The agent carries on when you submit it.");
      node.append(body);
      const note = keepNote(el("input", "ag-input small"), `ask:${it.id}`);
      note.placeholder = "Note for the agent (for Skip)";
      const actions = el("div", "ag-card-actions");
      actions.append(
        button("Open", "ag-btn small primary", (event) => open(event)),
        button("Skip", "ag-btn small", async () => {
          await api("POST", `/questions/${encodeURIComponent(it.requestId)}`, { skip: true, reason: note.value.trim() || undefined }).catch((err) => notice(err.message));
        })
      );
      node.append(note, actions);
      return node;
    }

    renderPlan(it) {
      const node = el("div", `ag-card ag-plan s-${it.status}`);
      node.dataset.itemId = it.id;
      const head = el("div", "ag-card-head");
      head.append(icon("todo"), el("span", "ag-card-title", it.title || "Plan"));
      if (it.status !== "pending") head.append(el("span", `ag-tag ${it.status === "accepted" ? "ok" : ""}`, it.status === "accepted" ? "Accepted" : it.status === "rejected" ? "Changes requested" : "Proposed"));
      node.append(head);
      const body = el("div", "ag-md ag-plan-body");
      R.renderMarkdown(body, it.text, mdCtx);
      node.append(body);
      if (it.status !== "pending") cardNotes.delete(`plan:${it.id}`);
      else {
        const note = keepNote(el("textarea", "ag-input small"), `plan:${it.id}`);
        note.rows = 2;
        note.placeholder = "What should change? (for Request changes)";
        const actions = el("div", "ag-card-actions");
        actions.append(
          button("Accept and build", "ag-btn small primary", () => api("POST", `/plans/${encodeURIComponent(it.requestId)}`, { accepted: true }).catch((err) => notice(err.message))),
          button("Request changes", "ag-btn small", () => api("POST", `/plans/${encodeURIComponent(it.requestId)}`, { accepted: false, note: note.value }).catch((err) => notice(err.message)))
        );
        node.append(note, actions);
      }
      return node;
    }

    renderTodos(it) {
      const node = el("div", "ag-todos");
      node.dataset.itemId = it.id;
      const done = it.todos.filter((t) => t.status === "completed").length;
      const head = el("div", "ag-todos-head");
      head.append(icon("todo"), el("span", null, `Todos ${done}/${it.todos.length}`));
      node.append(head);
      for (const todo of it.todos) {
        const row = el("div", `ag-todo ${todo.status}`);
        row.append(el("span", "ag-todo-box", todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "•" : ""), el("span", null, todo.content));
        node.append(row);
      }
      return node;
    }

    renderTurnFooter(turn, items) {
      const foot = el("div", `ag-turn-foot s-${turn.status}`);
      if (turn.status === "running") {
        const waiting = items.some((it) => (it.kind === "approval" || it.kind === "question" || it.kind === "plan") && it.status === "pending");
        foot.append(el("span", "ag-spin"), el("span", "ag-foot-label", waiting ? "Waiting for you" : "Working"), elapsed(turn.startedAt));
        foot.append(button(icon("stop"), "ag-btn tiny", () => this.stop(), "Stop", false));
        return foot;
      }
      const parts = el("span", "ag-foot-meta");
      if (turn.status === "error") parts.append(el("span", "ag-st-err", "Failed"));
      else if (turn.status === "cancelled") parts.append(el("span", "ag-muted", "Stopped"));
      if (turn.endedAt) {
        parts.append(el("span", null, R.duration(turn.endedAt - turn.startedAt)));
        parts.append(finishStamp(turn.endedAt));
      }
      const usage = turn.usage || {};
      if (usage.plan?.length) parts.append(el("span", null, usage.plan.map((w) => `${planPct(w.used)} of ${planWindowShort(w)}`).join(" · ")));
      else if (usage.costUsd !== undefined || usage.costRecords?.length || usage.billingSource) {
        const label = usage.costUsd === undefined ? "Cost unknown" : `${usage.costPartial ? "Partial" : usage.estimatedCostUsd !== undefined ? "Estimated" : usage.reportedCostUsd !== undefined ? "Provider-reported" : "Recorded"} $${usage.costUsd.toFixed(usage.costUsd < 0.1 ? 3 : 2)}`;
        const cost = el("span", null, label);
        const detail = () => (usage.costRecords || []).map((r) => {
          const rates = r.rate.rates ? Object.entries(r.rate.rates).map(([key, price]) => `${key}: $${price}`).join(", ") : "No prices";
          const timing = r.timing ? `\nMessage ended ${new Date(r.timing.endedAt).toISOString()}; HTTP attempt timing unavailable` : "";
          const tariff = r.tariff ? `\nTariff unresolved · ${r.tariff.profile.id} · reviewed ${new Date(r.tariff.profile.verifiedAt).toLocaleDateString()}${Date.now() - r.tariff.profile.verifiedAt > 30 * 86400000 ? "; review prices" : ""}\nCalendar ${r.tariff.profile.calendar.id} (${r.tariff.profile.calendar.coverageFrom} to ${r.tariff.profile.calendar.coverageTo}, end excluded); holiday timezone unconfirmed${r.tariff.observedWindow ? "\nObserved window: " + r.tariff.observedWindow + "; boundary: " + r.tariff.boundary : ""}${r.tariffCandidatesUsd ? "\nReviewed rate candidates: $" + r.tariffCandidatesUsd.lower.toFixed(6) + "–$" + r.tariffCandidatesUsd.upper.toFixed(6) + "; catalog estimate retained" : ""}` : "";
          return `${r.rate.provider}/${r.rate.model} · ${r.rate.origin} · ${rates} per 1M tokens\n${r.rate.endpoint || ""}\n${r.rate.updatedAt ? "Entered " + new Date(r.rate.updatedAt).toLocaleDateString() + (Date.now() - r.rate.updatedAt > 30 * 86400000 ? "; review prices" : "") : "Verification date unknown"}${r.rate.origin === "catalog" ? "; tariff discounts not applied" : ""}${timing}${tariff}${r.missing.length ? "\n" + r.missing.join("; ") : ""}`;
        }).join("\n\n") || (usage.billingSource ? `${claudeSourceLabel(usage.billingSource)}\nSDK estimate; actual charges and credit balances unavailable.${usage.costPartial ? "\nAccounting baseline or result unavailable; totals may be incomplete." : ""}` : usage.reportedCostUsd !== undefined ? "Amount supplied by the provider adapter." : "Recorded cost; rate and origin unavailable.");
        cost.setAttribute("aria-description", detail());
        bindHoverTip(cost, () => noteTip(detail()));
        parts.append(cost);
      }
      if (usage.outputTokens) parts.append(el("span", null, `${fmtTokens((usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0))} in · ${fmtTokens(usage.outputTokens)} out`));
      parts.append(el("span", "ag-muted", modelLabel(S.threads.get(turn.threadId)?.provider, turn.model)));
      foot.append(parts);
      if (turn.page?.after) {
        foot.append(el("span", "ag-grow"));
        const pageBtn = button(
          "",
          `ag-page-chip${turn.page.reverted ? " reverted" : ""}`,
          async () => {
            if (turn.page.reverted) return;
            if (!(await app().confirm(`Put “${turn.page.title}” back to how it was before this turn?`, "Revert"))) return;
            const res = await api("POST", `/threads/${encodeURIComponent(turn.threadId)}/turns/${encodeURIComponent(turn.id)}/revert-page`).catch((err) => ({ ok: false, error: err.message }));
            if (!res.ok) notice(res.error || "Could not revert the page");
          },
          turn.page.reverted ? "Reverted" : "Undo this turn's page edit"
        );
        pageBtn.append(icon("page"), el("span", null, turn.page.reverted ? "Page reverted" : "Page edited"));
        if (!turn.page.reverted) pageBtn.append(icon("revert"));
        foot.append(pageBtn);
      }
      const files = turn.files || [];
      if (files.length) {
        const added = files.reduce((a, f) => a + (f.added || 0), 0);
        const removed = files.reduce((a, f) => a + (f.removed || 0), 0);
        const changes = el("div", `ag-changes${turn.reverted ? " reverted" : ""}`);
        const top = button("", "ag-changes-head", () => openDiff({ kind: "turn", threadId: turn.threadId, turnId: turn.id }), "Review diff");
        top.append(icon("diff"), el("span", null, `${turn.reverted ? "Reverted · " : ""}${files.length} file${files.length === 1 ? "" : "s"} changed`), R.counts(added, removed), el("span", "ag-grow"), el("span", "ag-link", "Review"));
        changes.append(top);
        const list = el("div", "ag-changes-list");
        for (const f of files.slice(0, 12)) {
          const row = button("", "ag-change-row", () => openDiff({ kind: "turn", threadId: turn.threadId, turnId: turn.id, path: f.path }));
          row.append(el("span", `ag-fstat s-${f.status}`, f.status), el("span", "ag-fname", R.basename(f.path)), el("span", "ag-fdir", R.dirname(f.path)), R.counts(f.added, f.removed));
          row.dataset.tooltip = f.path;
          list.append(row);
        }
        if (files.length > 12) list.append(el("div", "ag-muted small ag-pad-x", `and ${files.length - 12} more`));
        changes.append(list);
        const wrap = el("div", "ag-turn-end");
        wrap.append(changes, foot);
        return wrap;
      }
      return foot;
    }

    /* ----- live updates ----- */

    onThread(thread, prev) {
      if (!prev || prev.title !== thread.title || prev.scope?.ref !== thread.scope?.ref || prev.stats?.files !== thread.stats?.files || prev.stats?.added !== thread.stats?.added) this.renderHeader();
      if (!prev || prev.status !== thread.status || prev.mode !== thread.mode || JSON.stringify(prev.custom) !== JSON.stringify(thread.custom) || prev.model !== thread.model || prev.effort !== thread.effort || prev.cwd !== thread.cwd || prev.approval !== thread.approval || prev.queued !== thread.queued || prev.background !== thread.background || JSON.stringify(prev.worktree) !== JSON.stringify(thread.worktree) || prev.stats?.turns !== thread.stats?.turns || JSON.stringify(prev.effectivePermissions) !== JSON.stringify(thread.effectivePermissions)) {
        this.renderComposerBar();
        if (prev && prev.cwd !== thread.cwd) this.renderHeader();
      }
      // Status can change without a turn event; keep the current-step dot orange or green to match.
      if (prev && prev.status !== thread.status) this.markLatest();
      if (thread.unread && this.visible()) api("POST", `/threads/${encodeURIComponent(thread.id)}/read`).catch(() => undefined);
    }

    onItem(item, isNew) {
      if (isNew && item.kind === "user" && item.turnId === null) this.stick = true;
      if (this.shown()) {
        this.dirtyTurns.add(itemGroupKey(item));
        // A queued message that starts a turn or is steered into one leaves the queued group.
        if ((isNew && item.turnId) || item.kind === "user") this.dirtyTurns.add("pending");
        this.schedule();
      } else this.stale = true;
      if (item.kind === "user") this.renderContext();
      this.refreshContextMeter();
    }

    onTurn(turn) {
      if (this.shown()) {
        this.dirtyTurns.add(turn.id);
        this.schedule();
      } else this.stale = true;
      this.refreshContextMeter();
      // The strip's run clock starts from the running turn, which can arrive after the thread's status.
      if (this.status && turn.status === "running" && !this.status.querySelector(".ag-clock")) this.renderComposerBar();
    }

    /** Redraw the context meter when its reading changed; streaming items come in bursts, so at most twice a second. */
    refreshContextMeter() {
      if (this.ctxTimer) return;
      this.ctxTimer = setTimeout(() => {
        this.ctxTimer = null;
        if (!this.ctxMeter?.isConnected) return;
        const next = contextMeter(this);
        if (next._sig === this.ctxMeter._sig) return;
        this.ctxMeter.replaceWith(next);
        this.ctxMeter = next;
      }, 500);
    }

    onDelta(item) {
      if (!this.shown()) {
        this.stale = true;
        return;
      }
      const node = this.transcript.querySelector(`[data-item-id="${item.id}"]`);
      if (!node) {
        this.dirtyTurns.add(itemGroupKey(item));
        this.schedule();
        return;
      }
      // Thinking/text streams skip a full re-render; restore the orange last-step if it went green too soon.
      const wrap = node.closest(".ag-turn");
      if (wrap?.classList.contains("latest") && this.turnIsLive(item.turnId || wrap.dataset.turn)) wrap.classList.add("running");
      if (item.kind === "reasoning") {
        const prev = node.querySelector(".ag-reason-preview");
        if (prev) prev.textContent = lastLine(item.text);
      }
      if (this.mdTimers.has(item.id)) return;
      this.mdTimers.set(
        item.id,
        setTimeout(() => {
          this.mdTimers.delete(item.id);
          const target = item.kind === "reasoning" ? node.querySelector(".ag-reason-body") : node;
          // A collapsed thought renders when it is opened.
          if (target && target.isConnected && !lazyBodies.has(node)) {
            const stick = this.stick;
            R.renderMarkdownStream(target, item.text, mdCtx);
            // The step in the page shows this text now: a turn drawn again before the next item event keeps it.
            const had = this.itemNodes.get(item.id);
            if (had?.node === node) had.sig = itemSig(item, NO_CHILDREN);
            if (stick) this.scrollToEnd();
          }
        }, 70)
      );
    }

    schedule() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.flush();
      });
    }

    flush() {
      const t = this.thread();
      const detail = t && S.details.get(t.id);
      if (!detail) return;
      if (this.stale || !this.shown()) {
        // Hidden since the turn was marked, or a whole redraw is owed: draw all of it (now or when shown).
        this.renderTranscript();
        return;
      }
      const keys = new Set(this.dirtyTurns);
      this.dirtyTurns.clear();
      if (this.transcript.querySelector(".ag-empty")) {
        this.renderTranscript();
        return;
      }
      const stick = this.stick;
      const groups = this.groups(detail);
      for (const key of keys) {
        const group = groups.find((g) => g.key === key);
        const host = this.groupHost(key);
        const existing = host.querySelector(`.ag-turn[data-turn="${key}"]`);
        if (!group) {
          existing?.remove();
          continue;
        }
        const fresh = this.renderGroup(group);
        const known = existing && new Set([...existing.querySelectorAll("[data-item-id]")].map((n) => n.dataset.itemId));
        // The turn stays in the page and takes what changed: a replaced step loses its hover and blinks (#443).
        const live = existing ? window.scribeMorph(existing, fresh, { atomic: isItemNode }) : fresh;
        if (!existing) {
          const idx = groups.indexOf(group);
          const nextGroup = groups.slice(idx + 1).map((g) => host.querySelector(`.ag-turn[data-turn="${g.key}"]`)).find(Boolean);
          if (nextGroup) nextGroup.before(fresh);
          else host.append(fresh);
        }
        this.adoptItemNodes(live);
        this.markEntering(live, known);
      }
      this.markLatest();
      this.measureUserMessages();
      this.updateQueueDock();
      if (stick) this.scrollToEnd();
      if (this.helpersBusy) this.renderHelperDock();
    }

    /** Only newly inserted rows request the shared one-shot entry. */
    markEntering(root, known) {
      for (const node of root.querySelectorAll("[data-item-id]")) {
        if (known?.has(node.dataset.itemId) || node.hasAttribute("data-fx-enter") || node.parentElement?.closest("[data-fx-enter]")) continue;
        window.scribeMotion.enter(node);
      }
    }

    bottomDist() {
      const el = this.scroll;
      return el.scrollHeight - el.scrollTop - el.clientHeight;
    }

    updateScrollFade() {
      if (this.variant === "dock") this.scroll.classList.toggle("scrolled", this.scroll.scrollTop > 0);
    }

    /** The queue dock slides away while you read further up, and comes back at the bottom. */
    updateQueueDock() {
      const dock = this.queueDock;
      const has = this.queueList.childElementCount > 0;
      dock.classList.toggle("has", has);
      this.scroll.classList.toggle("queued", has);
      // Line up with the transcript, which the scrollbar narrows.
      if (has) dock.style.paddingRight = `${this.scroll.offsetWidth - this.scroll.clientWidth}px`;
      // Stay visible while pinned: opening the dock leaves you about its own height from the
      // bottom, which used to look like "scrolled up" and hide it for good.
      if (!has || this.stick || this.stickAnim) this.queueShown = true;
      else {
        const dist = this.bottomDist();
        const qh = Math.max(this.queueList.scrollHeight, this.queueList.offsetHeight);
        if (this.queueShown && dist > qh + STICK_PX) this.queueShown = false;
        else if (!this.queueShown && dist < STICK_PX) this.queueShown = true;
      }
      dock.classList.toggle("away", !this.queueShown);
    }

    /** Snap when opening a thread; otherwise a critically damped spring follows the bottom and keeps its speed as more rows arrive. */
    scrollToEnd(instant) {
      const el = this.scroll;
      if (!el) return;
      this.stick = true;
      // New content or a resize: the running spring reads the bottom again on its next frame.
      this.stickTarget = -1;
      const max = () => Math.max(0, el.scrollHeight - el.clientHeight);
      const reduce = instant || !window.scribeMotion.enabled();
      if (reduce) {
        this.stopStickAnim();
        this.jumpScroll(max());
        return;
      }
      if (this.stickAnim || max() - el.scrollTop <= 0.5) return;
      const omega = 4.6 / (STICK_SPRING_MS / 1000);
      this.stickY = el.scrollTop;
      let last = performance.now();
      const tick = (now) => {
        if (!this.stick) {
          this.stopStickAnim();
          return;
        }
        const dt = Math.min(0.05, Math.max(0, now - last) / 1000);
        last = now;
        // Reading scrollHeight every frame forces a layout before the turn's own DOM writes.
        if (this.stickTarget < 0) this.stickTarget = max();
        const target = this.stickTarget;
        // Something else moved the scroll (a snap, a layout change): carry on from there.
        if (Math.abs(el.scrollTop - this.stickY) > 2) this.stickY = el.scrollTop;
        this.stickV += (omega * omega * (target - this.stickY) - 2 * omega * this.stickV) * dt;
        this.stickY = Math.min(target, this.stickY + this.stickV * dt);
        if (this.stickY >= target) this.stickV = Math.min(this.stickV, 0);
        // Caught up: the sub-pixel tail would only repaint the transcript. New content starts it again.
        if (target - this.stickY < 1 && Math.abs(this.stickV) < 20) {
          this.jumpScroll(target);
          this.stopStickAnim();
          return;
        }
        // Only whole device pixels move the view; skip frames that would not.
        const dpr = window.devicePixelRatio || 1;
        const top = Math.round(this.stickY * dpr) / dpr;
        if (Math.abs(top - el.scrollTop) * dpr >= 1) this.jumpScroll(top);
        this.stickAnim = requestAnimationFrame(tick);
      };
      this.stickAnim = requestAnimationFrame(tick);
    }

    jumpScroll(top) {
      this.stickLock = true;
      this.scroll.scrollTop = top;
      this.updateScrollFade();
      this.stickLock = false;
    }

    stopStickAnim() {
      this.stickV = 0;
      if (!this.stickAnim) return;
      cancelAnimationFrame(this.stickAnim);
      this.stickAnim = 0;
    }

    /* ----- composer ----- */

    buildComposer() {
      const box = el("div", "ag-composer");
      this.ctxRow = el("div", "ag-ctx");
      this.input = el("textarea", "ag-textarea");
      this.input.rows = 1;
      this.input.placeholder = this.variant === "dock" ? "Ask or make a change…" : "Message the agent…";
      this.input.addEventListener("input", () => {
        this.autosize();
        this.updatePicker();
        this.warm();
      });
      this.input.addEventListener("keydown", (event) => this.onKey(event));
      this.input.addEventListener("keyup", (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") this.updatePicker();
      });
      this.input.addEventListener("click", () => this.updatePicker());
      this.input.addEventListener("paste", (event) => this.onPaste(event));
      this.input.addEventListener("focus", () => {
        this.renderContext();
        this.warm();
      });
      this.bar = el("div", "ag-bar");
      window.scribeAudio.notice = notice;
      this.audioComposer = window.scribeAudio.bindComposer(this);
      this.slash = el("div", "ag-slash");
      this.slash.hidden = true;
      // The send button sits beside the input. The dock places it and the settings bar itself;
      // the sidebar and full window put a strip under the input with the run status and the settings.
      this.sendSlot = el("div", "ag-send-slot");
      this.forkNote = el("div", "ag-fork-note");
      this.forkNote.hidden = true;
      // Working helpers of this thread, above the input.
      this.helperDock = el("div", "ag-helpers");
      this.helperDock.hidden = true;
      this.helperApprovals = el("div", "ag-helper-approvals");
      this.helperApprovals.hidden = true;
      box.append(this.slash, this.helperApprovals, this.helperDock, this.forkNote, this.ctxRow);
      if (this.floating) {
        box.append(this.input);
      } else {
        const row = el("div", "ag-compose-row");
        row.append(this.input, this.sendSlot);
        this.status = el("span", "dock-status");
        const strip = el("div", "ag-compose-bar");
        strip.append(this.status, this.bar);
        box.append(row, strip);
      }
      // Files dropped anywhere on the composer are attached; the outline shows where a drop lands.
      let dragDepth = 0;
      const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
      box.addEventListener("dragenter", (event) => {
        if (!hasFiles(event)) return;
        dragDepth += 1;
        box.classList.add("drop-target");
      });
      box.addEventListener("dragleave", () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) box.classList.remove("drop-target");
      });
      box.addEventListener("dragover", (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      });
      box.addEventListener("drop", (event) => {
        dragDepth = 0;
        box.classList.remove("drop-target");
        const files = [...(event.dataTransfer?.files || [])];
        if (!files.length) return;
        event.preventDefault();
        this.addFiles(files);
        this.focus();
      });
      return box;
    }

    /**
     * Ask the daemon to start the provider before the message is sent: the process, the session, and
     * the model options take seconds, which would otherwise all come after Enter. Repeats only when
     * the settings change or a minute has passed.
     */
    warm() {
      const s = this.settings();
      const t = this.thread();
      if (t && t.status !== "idle") return;
      const key = JSON.stringify([this.threadId || `draft:${this.variant}`, s.provider, s.model, s.effort, s.modelParams, s.mode, s.custom?.id, s.web, s.cwd, s.scope, s.useWorktree]);
      const now = Date.now();
      if (this.lastWarm && this.lastWarm.key === key && now - this.lastWarm.at < 60_000) return;
      this.lastWarm = { key, at: now };
      if (t) {
        api("POST", `/threads/${encodeURIComponent(t.id)}/warm`).catch(() => undefined);
      } else {
        api("POST", "/warm", { provider: s.provider, model: s.model, effort: s.effort, modelParams: s.modelParams, mode: s.mode, customMode: s.custom?.id ?? null, approval: s.approval, web: s.web, cwd: s.cwd, scope: s.scope, useWorktree: Boolean(s.useWorktree) }).catch(() => undefined);
      }
    }

    /**
     * Size the composer to its text without collapsing it to one line first.
     * height:auto on the live field shrinks the flex chat, which grows the transcript
     * pane and clamps scrollTop; stick-to-bottom then springs back from that snap.
     */
    autosize() {
      const node = this.input;
      if (!node) return;
      const max = this.variant === "full" ? 320 : 220;
      const sizer = this.inputSizer?.isConnected ? this.inputSizer : (this.inputSizer = this.makeInputSizer());
      const width = node.offsetWidth;
      if (width) sizer.style.width = `${width}px`;
      sizer.value = node.value;
      const needed = sizer.scrollHeight;
      const next = `${Math.min(max, needed)}px`;
      node.style.overflowY = needed > max ? "auto" : "hidden";
      if (node.style.height === next) return;
      const pinned = this.stick;
      node.style.height = next;
      if (pinned) this.jumpScroll(Math.max(0, this.scroll.scrollHeight - this.scroll.clientHeight));
    }

    makeInputSizer() {
      const sizer = el("textarea", this.input.className);
      sizer.rows = 1;
      sizer.tabIndex = -1;
      sizer.ariaHidden = "true";
      sizer.style.position = "absolute";
      sizer.style.left = "0";
      sizer.style.top = "0";
      sizer.style.height = "auto";
      sizer.style.maxHeight = "none";
      sizer.style.overflow = "hidden";
      sizer.style.visibility = "hidden";
      sizer.style.pointerEvents = "none";
      this.input.parentElement.append(sizer);
      return sizer;
    }

    renderContext() {
      const row = this.ctxRow;
      if (!row) return;
      row.replaceChildren();
      this.mentions.forEach((chip, index) => {
        const node = el("span", "ag-chip small");
        node.dataset.tooltip = chipTitle(chip);
        node.append(icon(chipIcon(chip)), el("span", null, chipLabel(chip)));
        node.append(button(icon("close"), "ag-chip-x", (event) => {
          event.stopPropagation();
          this.mentions.splice(index, 1);
          this.renderContext();
        }, "Remove"));
        row.append(node);
      });
      this.attachments.forEach((file, index) => {
        const chip = fileChip(file, () => window.scribePreview?.open(this.attachments, index));
        chip.append(button(icon("close"), "ag-chip-x", (event) => {
          event.stopPropagation();
          const [gone] = this.attachments.splice(index, 1);
          if (gone?.url) URL.revokeObjectURL(gone.url);
          this.renderContext();
        }, "Remove"));
        row.append(chip);
      });
      row.hidden = !row.childElementCount;
    }

    /** True when this page is already the thread's scope or was attached on an earlier message. */
    pageInThread(tab) {
      if (!tab) return false;
      const s = this.settings();
      if (s.scope?.kind === "page" && s.scope.ref === tab.id) return true;
      const items = S.details.get(this.threadId)?.items || [];
      return items.some((it) => it.kind === "user" && !it.dropped && (it.context || []).some((c) => c.kind === "page" && c.id === tab.id));
    }

    /** Pages, folders and files already on this message or earlier in the thread. */
    knownMentionKeys() {
      const keys = new Set();
      const add = (chip) => {
        const key = chipKey(chip);
        if (key) keys.add(key);
      };
      for (const chip of this.mentions) add(chip);
      const tab = activeTab();
      if (tab && this.pageInThread(tab)) keys.add(`page:${tab.id}`);
      const items = S.details.get(this.threadId)?.items || [];
      for (const it of items) {
        if (it.kind !== "user" || it.dropped) continue;
        for (const chip of it.context || []) if (chip.kind !== "thread") add(chip);
      }
      return keys;
    }

    /** The chips sent with text: the picked mentions, plus the current page for a bare @this. */
    composerContext(text = "") {
      const chips = [];
      const seen = new Set();
      const push = (chip) => {
        const key = chipKey(chip);
        if (key) {
          if (seen.has(key)) return;
          seen.add(key);
        }
        chips.push(chip);
      };
      for (const chip of this.mentions) {
        if (chip.kind === "page" && this.pageInThread(chip)) continue;
        push(chip);
      }
      const tab = activeTab();
      if (tab && /(^|\s)@this(?=[\s.,;:!?]|$)/i.test(text) && !this.pageInThread(tab)) {
        push({ kind: "page", id: tab.id, key: tab.key, title: tab.title });
      }
      return chips;
    }

    restoreContextChips(context) {
      this.mentions = Array.isArray(context) ? context.map((c) => ({ ...c })) : [];
    }

    hidePicker() {
      this.slash.hidden = true;
      this.slash.classList.remove("loading");
      this.slash.removeAttribute("aria-busy");
      this.mentionLoading = false;
      this.mentionGen += 1;
      clearTimeout(this.mentionTimer);
    }

    onPaste(event) {
      const files = [...(event.clipboardData?.files || [])];
      if (!files.length) return;
      // Office apps put a picture of the copied text beside the text itself: paste the text then.
      const text = event.clipboardData.getData("text/plain");
      if (text.trim() && files.every((f) => f.type.startsWith("image/"))) return;
      event.preventDefault();
      this.addFiles(files);
    }

    /** Attach pasted or dropped files, within the limits the daemon applies too. */
    addFiles(files) {
      for (const file of files) {
        const image = file.type.startsWith("image/");
        const max = image ? FILE_LIMITS.image : FILE_LIMITS.file;
        if (this.attachments.length >= FILE_LIMITS.count) return notice(`Up to ${FILE_LIMITS.count} files per message`);
        if (file.size > max) {
          notice(`${file.name || "That file"} is too big: ${image ? "images" : "files"} must be under ${max / 1024 / 1024} MB`);
          continue;
        }
        const total = this.attachments.reduce((sum, f) => sum + f.size, 0);
        if (total + file.size > FILE_LIMITS.total) {
          notice(`A message's files must add up to under ${FILE_LIMITS.total / 1024 / 1024} MB`);
          continue;
        }
        const entry = {
          name: file.name || (image ? `pasted.${(file.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/\+.*/, "")}` : "pasted file"),
          mimeType: file.type || "",
          size: file.size,
          data: null,
          url: URL.createObjectURL(file),
        };
        this.attachments.push(entry);
        const reader = new FileReader();
        reader.onload = () => {
          entry.data = String(reader.result).split(",")[1] || "";
        };
        reader.readAsDataURL(file);
      }
      this.renderContext();
    }

    /** Drop the composer's files, freeing their preview URLs. */
    clearAttachments() {
      for (const file of this.attachments) if (file.url) URL.revokeObjectURL(file.url);
      this.attachments = [];
    }

    renderComposerBar() {
      const s = this.settings();
      const t = this.thread();
      const bar = document.createDocumentFragment();
      this.renderForkNote(t);
      const info = modelInfo(s.provider, s.model);
      const model = button("", "ag-pill", (event) => this.modelMenu(event.currentTarget), "Model", false);
      model.append(providerIcon(s.provider), el("span", null, info?.label || s.model));
      bar.append(model);
      const hasEffort = info?.efforts?.length || info?.params?.some((p) => p.id !== CONTEXT_PARAM);
      if (hasEffort) {
        const effortLabel = s.effort ? info.efforts.find((e) => e.id === s.effort)?.label || s.effort : info.defaultEffort ? `${info.efforts.find((e) => e.id === info.defaultEffort)?.label || info.defaultEffort}` : "Default";
        const fast = info.params?.find((p) => p.id === "fast");
        const fastOn = fast ? (s.modelParams?.fast ?? fast.default) === "true" : false;
        const eff = button("", "ag-pill", (event) => this.effortMenu(event.currentTarget), "Reasoning and model options", false);
        eff.append(icon("think"), el("span", null, info.efforts.length ? effortLabel : "Options"));
        if (fastOn) eff.append(el("span", "ag-tag tiny", "fast"));
        bar.append(eff);
      }
      const mode = MODES.find((m) => m.id === s.mode) || MODES[0];
      const modeBtn = button("", `ag-pill mode-${mode.id}`, (event) => this.modeMenu(event.currentTarget), s.custom ? customDetail(s.custom, mode.id) : mode.detail);
      modeBtn.append(el("span", null, s.custom ? s.custom.name : mode.label));
      bar.append(modeBtn);
      if (s.mode === "code") {
        const ap = APPROVALS.find((a) => a.id === s.approval) || APPROVALS[0];
        const apBtn = button("", `ag-pill ap-${ap.id}`, (event) => this.approvalMenu(event.currentTarget), approvalDetail(ap, s.provider));
        apBtn.append(icon("shield"), el("span", null, ap.label));
        bar.append(apBtn);
      }
      if (t?.effectivePermissions?.provider === s.provider) {
        const p = t.effectivePermissions;
        const mismatch = p.sandbox !== p.requestedSandbox || p.approval !== p.requestedApproval;
        const detail = `Filesystem: ${p.sandbox} (requested ${p.requestedSandbox}). Approvals: ${p.approval} (requested ${p.requestedApproval}). Reviewer: ${p.reviewer}. Board actions: ${p.boardActions}. Report pages: ${p.reports}. Tool availability is separate from filesystem access; provider approval still applies to page mutations.`;
        const policy = button(`${mismatch ? "! " : ""}${p.sandbox}`, "ag-pill", (event) => placeHoverTip(event.currentTarget, noteTip(detail), 280));
        policy.setAttribute("aria-label", `Effective permissions: ${p.sandbox}`);
        policy.setAttribute("aria-description", detail);
        policy.dataset.permissions = detail;
        bindHoverTip(policy, () => noteTip(detail));
        bar.append(policy);
      }
      const wt = openWorktree(t);
      if (wt) {
        const wtBtn = button("", `ag-pill ag-wt ag-wt-icon${wt.ahead || wt.dirty ? " pending" : ""}`, (event) => this.worktreeMenu(event.currentTarget));
        wtBtn.append(icon("git"));
        wtBtn.setAttribute("aria-label", `Worktree ${wt.branch}`);
        bindHoverTip(wtBtn, () => worktreeTip(openWorktree(this.thread()) || wt));
        bar.append(wtBtn);
      } else if ((s.mode === "code" || s.mode === "plan") && s.cwd && !t?.stats.turns) {
        const wtBtn = button("", `ag-pill ag-wt-icon toggle${s.useWorktree ? " on" : ""}`, () => this.setWorktree(!this.settings().useWorktree));
        wtBtn.append(icon("git"));
        wtBtn.setAttribute("aria-label", s.useWorktree ? "Worktree on first message. Click to turn off." : "Works in the folder. Click to use a worktree.");
        bindHoverTip(wtBtn, () => worktreePendingTip(this.settings().useWorktree));
        bar.append(wtBtn);
      }
      {
        const wm = WEB_MODES.find((w) => w.id === webMode(s.web)) || WEB_MODES[0];
        const unenforced = wm.id !== "on" && !webEnforced(s.provider);
        const detail = unenforced ? WEB_UNENFORCED : wm.id === "limited" && s.provider === "codex" ? CODEX_LIMITED : wm.id === "limited" && s.provider !== "claude" ? scribeLimited() : wm.detail;
        const web = button(
          "",
          `ag-pill toggle web-${wm.id}${wm.id !== "off" ? " on" : ""}${unenforced ? " web-unenforced" : ""}`,
          (event) => this.webMenu(event.currentTarget),
          detail
        );
        web.append(icon(wm.id === "limited" ? "fetchLimited" : "fetch"));
        // The floating chat is narrow: the icon alone, with the mode in its tooltip and style.
        if (this.variant !== "dock") web.append(el("span", null, wm.label));
        else web.classList.add("ag-web-icon");
        web.setAttribute("aria-label", `${wm.label}: ${detail}`);
        bar.append(web);
      }
      const meter = usageChip(s.provider, this.variant !== "full", s.model, this.thread());
      const mic = button("", "ag-pill ag-mic", () => this.audioComposer.toggle(), "Dictate (Ctrl+Shift+Space)", false);
      mic.append(icon("mic"), el("span"));
      mic.setAttribute("aria-label", "Dictate (Ctrl+Shift+Space)");
      bar.append(mic);
      if (meter) bar.append(meter);
      this.ctxMeter = contextMeter(this);
      bar.append(this.ctxMeter);
      const tail = document.createDocumentFragment();
      if (this.status) {
        // Status dot and run time at the start of the strip, as in the floating chat.
        const status = t?.status || "idle";
        const start = status !== "idle" ? [...(S.details.get(t.id)?.turns.values() || [])].find((x) => x.status === "running")?.startedAt : null;
        this.status.className = `dock-status s-${status}`;
        const sig = `${status}:${start || ""}`;
        if (this.status._sig !== sig) {
          this.status._sig = sig;
          this.status.replaceChildren(el("span", "dock-dot"));
          if (start) this.status.append(setClock(el("span", "ag-clock"), start));
        }
      }
      if (t?.queued) tail.append(el("span", "ag-tag", `${t.queued} queued`));
      if (t?.background) tail.append(el("span", "ag-tag", `${t.background} in background`));
      const running = t && t.status !== "idle";
      if (running) {
        tail.append(button(icon("stop"), "ag-send stop", () => this.stop(), "Stop (Esc twice)", false));
      }
      tail.append(button(icon("send"), "ag-send", () => this.send(), running ? "Queue message" : sendKey() === "mod" ? "Send (Ctrl+Enter)" : "Send (Enter)"));
      window.scribeSyncChildren(this.bar, [bar]);
      this.audioComposer.paint();
      this.ctxMeter = this.bar.lastChild;
      window.scribeSyncChildren(this.sendSlot, [tail]);
    }

    /**
     * Above the input of a fork that has not run yet: how the earlier conversation comes along, and an
     * offer to archive the thread it came from. Both go once the first message is sent.
     */
    renderForkNote(t) {
      const note = this.forkNote;
      note.replaceChildren();
      if (t && this.pendingFork) {
        note.hidden = false;
        const pending = this.pendingFork;
        const line = el("div", "ag-fork-line");
        line.append(icon("git"), el("span", null, `Sending will fork this conversation into a new ${PROVIDER_LABEL[pending.settings.provider]} thread.`));
        const actions = el("div", "ag-fork-line");
        actions.append(button("New thread", "ag-fork-act", () => {
            const content = this.composerContent();
            const settings = { ...this.settings(), customMode: pending.settings.customMode !== undefined ? pending.settings.customMode : t.custom?.id ?? null };
            this.emptyComposer();
            this.startDraft(t.scope, settings);
            if (content) this.fillComposer(content);
          }));
        note.append(line, actions);
        if (!t.archived) {
          const archive = button(pending.archive ? "Archive on send ✓" : "Archive on send", "ag-fork-act", () => {
            pending.archive = !pending.archive;
            this.renderForkNote(t);
          });
          archive.setAttribute("aria-pressed", String(pending.archive));
          actions.append(archive);
        }
        return;
      }
      const fork = t && !t.stats.turns ? t.fork : null;
      note.hidden = !fork;
      if (!fork) return;
      const from = S.threads.get(fork.from);
      const fromName = `“${from?.title || fork.title}”`;
      if (t.carry?.how === "summary") {
        const switched = t.provider !== fork.provider;
        const how = t.carry.summarizer
          ? `its first and last messages, and a summary of the rest written by ${t.carry.summarizer}`
          : "its messages and the last reply";
        const line = el("div", "ag-fork-line warn");
        line.append(icon("git"), el("span", null, `${switched ? `${PROVIDER_LABEL[t.provider]} can't continue a ${PROVIDER_LABEL[fork.provider]} session` : "This starts a new session"}, so ${fromName} comes along as ${how}.`));
        note.append(line);
      } else {
        const line = el("div", "ag-fork-line");
        line.append(icon("git"), el("span", null, `Continues ${fromName} with its whole conversation, in a session of its own.`));
        note.append(line);
      }
      if (from && !from.archived && !S.forkArchiveSeen.has(t.id)) {
        const line = el("div", "ag-fork-line");
        line.append(
          el("span", null, `Archive ${fromName}?`),
          button(this.archiveOnSend === from.id ? "Archive on send ✓" : "Archive on send", "ag-fork-act", () => {
            this.archiveOnSend = this.archiveOnSend === from.id ? null : from.id;
            this.renderForkNote(this.thread());
          }),
          button(icon("close"), "ag-icon-btn small", () => {
            S.forkArchiveSeen.add(t.id);
            this.archiveOnSend = null;
            this.renderForkNote(this.thread());
          }, "Dismiss")
        );
        note.append(line);
      }
    }

    /** Starred models only, plus the current one; "Show all models" opens the full, searchable list. */
    modelMenu(anchor, { all = false } = {}) {
      const s = this.settings();
      const favs = new Set(favoriteModels());
      const showAll = all || !favs.size;
      const items = [];
      for (const provider of PROVIDERS) {
        const status = S.config.providers.find((p) => p.id === provider);
        const models = modelsOf(provider).filter((m) => showAll || favs.has(modelKey(provider, m.id)) || (s.provider === provider && s.model === m.id));
        if (!showAll && !models.length) continue;
        if (!models.length) {
          items.push({ header: `${PROVIDER_LABEL[provider]}${status && !status.available ? " — unavailable" : ""}`, provider });
          items.push({ label: status?.available ? "Loading models…" : status?.detail || "Not available", disabled: true });
          continue;
        }
        items.push(...modelMenuItems(provider, models, (m) => ({
          label: m.label,
          detail: m.id !== m.label ? m.id : m.description,
          search: `${provider} ${PROVIDER_LABEL[provider] || ""} ${m.id}`,
          checked: s.provider === provider && s.model === m.id,
          disabled: !status?.available,
          star: { on: favs.has(modelKey(provider, m.id)), toggle: (on) => setFavorite(provider, m.id, on) },
          run: () => this.updateSettings(provider === s.provider ? { model: m.id } : { provider, model: m.id }),
        }), status && !status.available ? " — unavailable" : ""));
      }
      if (!showAll) {
        items.push({ separator: true }, { label: "Show all models", icon: "more", run: () => this.modelMenu(anchor, { all: true }) });
      }
      openMenu(anchor, items, { search: showAll, width: 300, placeholder: "Search models · ☆ to favourite" });
    }

    effortMenu(anchor) {
      const s = this.settings();
      const info = modelInfo(s.provider, s.model);
      if (!info) return;
      const items = [];
      if (info.efforts.length) {
        items.push({ header: "Reasoning" });
        items.push({ label: "Default", detail: info.defaultEffort ? `Model default (${info.defaultEffort})` : "Model default", checked: !s.effort, run: () => this.updateSettings({ effort: null }) });
        for (const e of info.efforts) items.push({ label: e.label, checked: s.effort === e.id, run: () => this.updateSettings({ effort: e.id }) });
      }
      for (const param of info.params || []) {
        if (param.id === CONTEXT_PARAM) continue;
        items.push({ header: param.label });
        const cur = s.modelParams?.[param.id] ?? param.default;
        for (const o of param.options) {
          items.push({ label: o.label, detail: param.id === "fast" && o.id === "true" ? param.description : undefined, checked: cur === o.id, run: () => this.updateSettings({ modelParams: { ...(s.modelParams || {}), [param.id]: o.id } }) });
        }
      }
      openMenu(anchor, items, { width: 240 });
    }

    modeMenu(anchor) {
      const s = this.settings();
      const items = MODES.map((m) => ({ label: m.label, detail: m.detail, checked: !s.custom && s.mode === m.id, run: () => this.updateSettings({ mode: m.id, customMode: null }) }));
      const custom = customModes();
      if (custom.length || s.custom) items.push({ separator: true });
      for (const m of custom) {
        items.push({
          label: m.name,
          detail: m.description || customDetail(m, m.base),
          checked: s.custom?.id === m.id,
          // The mode's own approval and web are where a thread starts; they can be changed on the thread after.
          run: () => this.updateSettings({ mode: m.base, customMode: m.id, ...(m.approval ? { approval: m.approval } : {}), ...(m.web ? { web: m.web } : {}) }),
        });
      }
      // A deleted mode: the thread keeps what it took away until another mode is picked.
      if (s.custom && !custom.some((m) => m.id === s.custom.id)) items.push({ label: s.custom.name, detail: `Deleted. ${customDetail(s.custom, s.mode)}`, checked: true, disabled: true });
      items.push({ separator: true }, { label: "Edit modes…", icon: "gear", run: () => window.scribeHarness?.open("modes") });
      openMenu(anchor, items, { width: 290 });
    }

    approvalMenu(anchor) {
      const s = this.settings();
      openMenu(
        anchor,
        APPROVALS.map((a) => ({
          label: a.label,
          detail: approvalDetail(a, s.provider),
          checked: s.approval === a.id,
          danger: a.id === "full",
          run: () => this.updateSettings({ approval: a.id }),
        })),
        { width: 300 }
      );
    }

    webMenu(anchor) {
      const s = this.settings();
      const cur = webMode(s.web);
      const items = WEB_MODES.map((w) => ({
        label: w.label,
        detail: w.id !== "on" && !webEnforced(s.provider) ? WEB_UNENFORCED : w.id === "limited" && s.provider === "codex" ? CODEX_LIMITED : w.id === "limited" && s.provider !== "claude" ? scribeLimited() : w.detail,
        checked: cur === w.id,
        run: () => this.updateSettings({ web: w.id }),
      }));
      items.push({ separator: true }, { label: "Edit web allowlist…", icon: "shield", run: () => allowlists.open() });
      openMenu(anchor, items, { width: 300 });
    }

    onKey(event) {
      if (!this.slash.hidden) {
        const items = [...this.slash.querySelectorAll(".ag-slash-item")];
        const at = items.findIndex((i) => i.classList.contains("on"));
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!items.length) return;
          const next = event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
          items.forEach((i, n) => i.classList.toggle("on", n === next));
          items[next]?.scrollIntoView({ block: "nearest" });
          return;
        }
        if ((event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) || event.key === "Tab") {
          if (this.mentionLoading) {
            event.preventDefault();
            return;
          }
          if (items.length) {
            event.preventDefault();
            (items[at >= 0 ? at : 0]).click();
            return;
          }
          if (this.mentionLoading || event.key === "Tab") {
            event.preventDefault();
            return;
          }
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.hidePicker();
          return;
        }
      }
      // Shift+Enter always inserts a line. Ctrl+Enter always sends. Plain Enter follows Chat settings.
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        const mod = event.ctrlKey || event.metaKey;
        if (mod || sendKey() === "enter") {
          event.preventDefault();
          if (!this.input.value.trim() && !this.attachments.length && !this.mentions.length && this.pushQueued()) return;
          this.send();
        }
        return;
      }
      if (event.key === "ArrowUp" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !this.input.value && !this.attachments.length && !this.mentions.length && this.withdrawQueued()) {
        event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        const t = this.thread();
        if (t && t.status !== "idle") {
          const now = Date.now();
          if (this.lastEsc && now - this.lastEsc < 800) {
            event.preventDefault();
            event.stopPropagation();
            this.stop();
            this.lastEsc = 0;
            return;
          }
          this.lastEsc = now;
        }
      }
    }

    async updatePicker() {
      const value = this.input.value;
      const cur = this.input.selectionStart ?? value.length;
      const slash = this.input.selectionEnd === cur ? slashAt(value, cur) : null;
      if (slash) {
        this.hidePicker();
        await this.showSlash(slash.query);
        return;
      }
      const threadMention = mentionAt(value, cur, "#");
      const mention = threadMention ? { ...threadMention, thread: true } : mentionAt(value, cur);
      if (mention) {
        this.showMentions(mention);
        return;
      }
      if (!this.slash.hidden || this.mentionLoading) this.hidePicker();
    }

    async showSlash(typed) {
      const gen = this.mentionGen;
      const s = this.settings();
      let list = S.commands.get(s.provider);
      if (this.threadId || !list) {
        try {
          const data = await api("GET", this.threadId ? `/threads/${encodeURIComponent(this.threadId)}/commands` : `/commands?provider=${s.provider}`);
          if (data.commands?.length) {
            list = data.commands;
            S.commands.set(s.provider, list);
          }
        } catch {
          /* keep cache */
        }
      }
      if (gen !== this.mentionGen) return;
      const token = slashAt(this.input.value, this.input.selectionStart ?? this.input.value.length);
      if (!token || token.query !== typed || this.input.selectionEnd !== this.input.selectionStart) return;
      const q = typed.toLowerCase();
      const local = LOCAL_SLASH.filter((c) => c.name.includes(q)).map((c) => ({ ...c, local: true }));
      // The open page's template actions (#152): /<id>, with any text after it as {{input}}.
      const page = pageActions(activeTab(), "slash")
        .filter((a) => !LOCAL_SLASH.some((c) => c.name === a.id) && (a.id.includes(q) || a.label.toLowerCase().includes(q)))
        .map((a) => ({ name: a.id, description: a.description ? `${a.label}: ${a.description}` : a.label }));
      const remote = (list || []).filter(
        (c) => c.name.toLowerCase().includes(q) && !LOCAL_SLASH.some((s) => s.name === c.name.toLowerCase()) && !page.some((a) => a.name === c.name.toLowerCase())
      );
      const hits = [...local, ...page, ...remote].slice(0, 40);
      this.slash.replaceChildren();
      if (!hits.length) {
        this.slash.hidden = true;
        return;
      }
      hits.forEach((c, i) => {
        const row = button("", `ag-slash-item${i === 0 ? " on" : ""}`, async () => {
          const value = this.input.value;
          const current = slashAt(value, this.input.selectionStart ?? value.length);
          if (!current || current.start !== token.start || current.end !== token.end || current.query !== typed) return;
          const remaining = value.slice(0, current.start) + value.slice(current.end);
          if (c.local) {
            this.input.value = remaining;
            this.input.setSelectionRange(current.start, current.start);
            this.hidePicker();
            this.autosize();
            if (c.name === "clear") {
              // Move the unsent content to the new thread instead of parking it on the old one.
              const content = this.composerContent();
              this.emptyComposer();
              await this.applyLocalSlash(c.name);
              if (content) this.fillComposer(content);
              this.input.setSelectionRange(current.start, current.start);
            } else {
              void this.applyLocalSlash(c.name);
            }
            this.focus();
            return;
          }
          // Provider and page commands are interpreted at the start when the message is sent.
          this.input.value = `/${c.name} ${remaining.trim()}`;
          this.input.setSelectionRange(this.input.value.length, this.input.value.length);
          this.hidePicker();
          this.autosize();
          this.focus();
        });
        row.append(el("span", "ag-slash-name", `/${c.name}`), el("span", "ag-slash-desc", c.description || c.hint || ""));
        this.slash.append(row);
      });
      this.slash.hidden = false;
    }

    showMentions(mention) {
      const gen = ++this.mentionGen;
      this.mentionLoading = true;
      if (!this.slash.hidden && this.slash.hasAttribute("aria-busy")) {
        this.slash.classList.add("loading");
        this.slash.setAttribute("aria-busy", "true");
      }
      clearTimeout(this.mentionTimer);
      this.mentionTimer = setTimeout(() => {
        void this.loadMentions(mention, gen);
      }, mention.query ? 70 : 0);
    }

    async loadMentions(mention, gen) {
      if (gen !== this.mentionGen) return;
      const q = mention.query;
      const taken = this.knownMentionKeys();
      if (mention.thread) {
        if (this.slash.hidden || !this.slash.hasAttribute("aria-busy")) {
          this.renderMentionPicker({ threads: [], mention, loading: true });
        }
        let threads = [];
        try {
          const data = await api("GET", "/threads");
          const words = q.toLowerCase().split(/\s+/).filter(Boolean);
          threads = (data.threads || [])
            .filter((t) => t.id !== this.threadId && !taken.has(`thread:${t.id}`) && words.every((w) => `${t.title} ${t.id}`.toLowerCase().includes(w)))
            .slice(0, 20)
            .map((t) => ({ kind: "thread", id: t.id, title: t.title }));
        } catch { /* The picker shows an empty result if the thread list is unavailable. */ }
        if (gen !== this.mentionGen) return;
        this.mentionLoading = false;
        this.renderMentionPicker({ threads, mention, loading: false });
        return;
      }
      const s = this.settings();
      const folders = this.localFolderMentions(q, taken);
      const wantFiles = (s.mode === "code" || s.mode === "plan") && s.cwd;
      // Keep the previous results (and scroll position) until the latest search completes.
      if (this.slash.hidden || !this.slash.hasAttribute("aria-busy")) {
        this.renderMentionPicker({ pages: [], folders, files: [], mention, loading: true });
      }
      try {
        const [pages, folderHits, files] = await Promise.all([
          this.searchPageMentions(q, taken),
          folders.length ? Promise.resolve(folders) : this.fetchFolderMentions(q, taken),
          wantFiles ? this.searchFileMentions(s.cwd, q, taken) : Promise.resolve([]),
        ]);
        if (gen !== this.mentionGen) return;
        this.mentionLoading = false;
        this.renderMentionPicker({ pages, folders: folderHits, files, mention, loading: false });
      } catch {
        if (gen !== this.mentionGen) return;
        this.mentionLoading = false;
        this.renderMentionPicker({ pages: [], folders, files: [], mention, loading: false });
      }
    }

    localFolderMentions(query, taken) {
      const q = query.toLowerCase();
      return (app()?.folders?.() || [])
        .map((f) => ({ kind: "folder", id: f.id, path: folderPath(f.id) || f.name }))
        .filter((f) => f.path && !taken.has(`folder:${f.id}`) && (!q || f.path.toLowerCase().includes(q)))
        .slice(0, 8);
    }

    async fetchFolderMentions(query, taken) {
      try {
        const res = await fetch("/api/folders/tree");
        if (!res.ok) return [];
        const data = await res.json();
        const q = query.toLowerCase();
        return (data.folders || [])
          .filter((f) => f.path && !taken.has(`folder:${f.id}`) && (!q || String(f.path).toLowerCase().includes(q)))
          .slice(0, 8)
          .map((f) => ({ kind: "folder", id: f.id, path: f.path }));
      } catch {
        return [];
      }
    }

    async searchPageMentions(query, taken) {
      try {
        const url = `/api/search?limit=16${query ? `&query=${encodeURIComponent(query)}` : ""}`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.tabs || [])
          .filter((t) => t.id && t.key && !taken.has(`page:${t.id}`))
          .slice(0, 12)
          .map((t) => ({ kind: "page", id: t.id, key: t.key, title: t.title, folder: t.folder || "" }));
      } catch {
        return [];
      }
    }

    async searchFileMentions(cwd, query, taken) {
      try {
        const data = await api("GET", `/fs/files?cwd=${encodeURIComponent(cwd)}&query=${encodeURIComponent(query)}&limit=16`);
        return (data.files || [])
          .filter((f) => f.path && !taken.has(`file:${f.path}`))
          .slice(0, 12)
          .map((f) => ({ kind: "file", path: f.path, name: f.name || R.basename(f.path) }));
      } catch {
        return [];
      }
    }

    /** The current page (also @this) and its folder, when the query still fits them. */
    hereMentions(query, taken) {
      const tab = activeTab();
      if (!tab) return [];
      const q = query.toLowerCase();
      const items = [];
      if (!taken.has(`page:${tab.id}`) && (!q || "this".startsWith(q) || String(tab.title || "").toLowerCase().includes(q))) {
        items.push({ kind: "page", id: tab.id, key: tab.key, title: tab.title, folder: "@this" });
      }
      const path = tab.folderId ? folderPath(tab.folderId) : "";
      if (path && !taken.has(`folder:${tab.folderId}`) && (!q || path.toLowerCase().includes(q))) {
        items.push({ kind: "folder", id: tab.folderId, path });
      }
      return items;
    }

    renderMentionPicker({ pages = [], folders = [], files = [], threads = [], mention, loading }) {
      this.slash.classList.toggle("loading", loading);
      this.slash.setAttribute("aria-busy", String(loading));
      this.slash.replaceChildren();
      const here = mention.thread ? [] : this.hereMentions(mention.query, this.knownMentionKeys());
      const hereKeys = new Set(here.map(chipKey));
      const sections = [
        { title: "Here", items: here },
        { title: "Threads", items: threads },
        { title: "Pages", items: pages.filter((p) => !hereKeys.has(chipKey(p))) },
        { title: "Folders", items: folders.filter((f) => !hereKeys.has(chipKey(f))) },
        { title: "Files", items: files },
      ];
      let first = true;
      for (const section of sections) {
        if (!section.items.length) continue;
        this.slash.append(el("div", "ag-slash-head", section.title));
        for (const item of section.items) {
          const on = first;
          first = false;
          const row = button("", `ag-slash-item${on ? " on" : ""}`, () => this.pickMention(item, mention));
          row.addEventListener("mousedown", (event) => event.preventDefault());
          const name = item.kind === "thread" ? item.title || "Thread" : item.kind === "page" ? item.title : item.kind === "folder" ? item.path : item.name || R.basename(item.path);
          const detail = item.kind === "thread" ? item.id : item.kind === "page" ? item.folder : item.kind === "file" ? R.dirname(item.path) : "";
          row.append(icon(chipIcon(item)), el("span", "ag-slash-title", name));
          if (detail) row.append(el("span", "ag-slash-desc", detail));
          row.dataset.tooltip = item.kind === "thread" ? `Give this chat read access to ${item.title || item.id}` : item.kind === "file" ? item.path : item.kind === "page" ? item.key : item.path;
          if (item.kind === "thread") row.setAttribute("aria-description", row.dataset.tooltip);
          this.slash.append(row);
        }
      }
      if (!this.slash.querySelector(".ag-slash-item")) {
        this.slash.append(el("div", "ag-slash-empty", loading ? "Searching…" : mention.thread ? "No matching threads" : "No matching pages, folders or files"));
      }
      this.slash.hidden = false;
    }

    pickMention(item, mention) {
      if (this.mentionLoading) return;
      const chip =
        item.kind === "thread"
          ? { kind: "thread", id: item.id, title: item.title }
          : item.kind === "page"
          ? { kind: "page", id: item.id, key: item.key, title: item.title }
          : item.kind === "folder"
            ? { kind: "folder", id: item.id, path: item.path }
            : { kind: "file", path: item.path };
      const value = this.input.value;
      const cur = this.input.selectionStart ?? value.length;
      const at = mention || mentionAt(value, cur);
      if (at) {
        const next = `${value.slice(0, at.start)}${value.slice(at.end)}`;
        this.input.value = next;
        this.input.setSelectionRange(at.start, at.start);
      }
      const key = chipKey(chip);
      if (key && this.knownMentionKeys().has(key)) {
        this.hidePicker();
        this.autosize();
        this.focus();
        return;
      }
      if (this.mentions.length >= MENTION_LIMIT) {
        notice(`Up to ${MENTION_LIMIT} mentions per message`);
        this.hidePicker();
        this.autosize();
        this.focus();
        return;
      }
      this.mentions.push(chip);
      this.hidePicker();
      this.renderContext();
      this.autosize();
      this.focus();
    }

    async stop() {
      const t = this.thread();
      if (!t) return;
      await api("POST", `/threads/${encodeURIComponent(t.id)}/cancel`).catch((err) => notice(err.message));
    }

    /**
     * Enter on an empty composer while a turn runs: steer the first queued message into the turn,
     * or, when one is already steering (or Settings say so), stop the turn and send it now.
     */
    pushQueued() {
      const t = this.thread();
      if (!t || t.status === "idle") return false;
      const target = emptyEnterTarget(t.id);
      if (!target) return false;
      this.queueAction(target.action, target.id);
      return true;
    }

    queueAction(action, itemId) {
      const t = this.thread();
      if (!t) return;
      api("POST", `/threads/${encodeURIComponent(t.id)}/${action}`, { itemId }).catch((err) => notice(err.message));
    }

    /** Up on an empty composer: take the latest queued or waiting steered message back into the input. */
    withdrawQueued(itemId) {
      const t = this.thread();
      if (!t || this.withdrawing) return false;
      const steering = (S.details.get(t.id)?.items || []).some((it) => it.kind === "user" && it.steer === "waiting");
      if (!t.queued && !steering) return false;
      this.withdrawing = true;
      this.input.readOnly = true;
      api("POST", `/threads/${encodeURIComponent(t.id)}/withdraw`, { itemId })
        .then((msg) => {
          const attachments = [...(msg.images || []), ...(msg.files || [])].map((f) => ({ ...f, size: Math.floor((f.data.length * 3) / 4), url: base64Url(f.data, f.mimeType) }));
          if (this.threadId !== t.id) {
            const content = { text: msg.text || "", attachments, mentions: msg.context || [] };
            S.composers.set(t.id, content);
            syncThreadDraft(t, content);
            return;
          }
          this.input.value = msg.text || "";
          this.clearAttachments();
          this.attachments = attachments;
          this.restoreContextChips(msg.context);
          this.renderContext();
          this.autosize();
          this.focus();
          this.input.setSelectionRange(this.input.value.length, this.input.value.length);
        })
        .catch((err) => notice(err.message))
        .finally(() => { this.withdrawing = false; this.input.readOnly = false; });
      return true;
    }

    async editQueued(item) {
      const threadId = this.threadId;
      const pending = (S.details.get(threadId)?.items || []).filter((it) => it.kind === "user" && !it.turnId && !it.dropped && it.steer !== "folded");
      if (!item.editing && pending[pending.length - 1]?.id === item.id && !this.composerContent()) {
        this.withdrawQueued(item.id);
        return;
      }
      const path = `/threads/${encodeURIComponent(threadId)}/queued/${encodeURIComponent(item.id)}`;
      let token;
      try { ({ token } = await api("POST", `${path}/edit`, { recover: Boolean(item.editing) })); }
      catch (err) { notice(err.message); return; }
      let finished = false;
      let saving = false;
      const { panel, close } = modal("ag-queued-edit", () => {
        if (!finished) api("POST", `${path}/edit-finish`, { token }).catch((err) => notice(err.message));
      }, () => finished || !saving);
      panel.setAttribute("aria-label", "Edit pending message");
      panel.append(el("h2", "ag-modal-title", "Edit message"));
      const input = el("textarea", "ag-input ag-queued-editor");
      input.value = item.text || "";
      input.setAttribute("aria-label", "Message");
      const actions = el("div", "ag-modal-actions");
      const save = button("Save", "ag-btn small primary", async () => {
        if (saving) return;
        saving = true;
        save.disabled = true;
        try {
          await api("POST", `${path}/edit-finish`, { token, text: input.value });
          finished = true;
          close();
        } catch (err) { notice(err.message); }
        finally { saving = false; save.disabled = false; }
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save.click(); }
      });
      actions.append(el("span", "ag-grow"), button("Cancel", "ag-btn small", close), save);
      panel.append(input, actions);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }

    async send() {
      if (this.withdrawing || this.sending) return;
      const text = this.input.value.trim();
      const localCmd = /^\/(clear|here|folder|workspace|global)$/i.exec(text);
      if (localCmd && (localCmd[1].toLowerCase() === "clear" || !this.attachments.length)) {
        this.input.value = "";
        this.hidePicker();
        this.autosize();
        await this.applyLocalSlash(localCmd[1].toLowerCase());
        return;
      }
      const actionCmd = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text);
      const actionTab = actionCmd ? activeTab() : null;
      const action = actionTab ? pageActions(actionTab, "slash").find((a) => a.id === actionCmd[1]) : null;
      if (action) {
        // A selection attached from the page (Ask agent) becomes the action's {{selection}}.
        const selection = this.mentions
          .filter((c) => c.kind === "selection")
          .map((c) => c.text)
          .join("\n\n");
        if (action.selection === "required" && !selection) {
          notice(`${action.label}: select text on the page first`);
          return;
        }
        this.input.value = "";
        this.hidePicker();
        this.autosize();
        if (action.selection !== "none") this.mentions = this.mentions.filter((c) => c.kind !== "selection");
        this.renderContext();
        await runAction(actionTab, action, { selection: action.selection === "none" ? "" : selection, input: actionCmd[2] || "", view: this });
        return;
      }
      if (!text && !this.attachments.length) return;
      if (this.attachments.some((f) => f.data === null)) {
        // Still being read (a large file just dropped): try again in a moment.
        setTimeout(() => this.send(), 100);
        return;
      }
      this.sending = true;
      const context = this.composerContext(text);
      const sending = this.attachments.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
      const images = sending.filter((f) => f.mimeType.startsWith("image/"));
      const files = sending.filter((f) => !f.mimeType.startsWith("image/"));
      const held = this.attachments;
      const heldMentions = this.mentions;
      this.attachments = [];
      this.mentions = [];
      this.input.value = "";
      this.autosize();
      this.renderContext();
      this.hidePicker();
      const sent = this.thread();
      let archiveAfterSend = this.archiveOnSend;
      if (sent) {
        // Sent, so no longer a draft; the daemon clears its copy when the message arrives.
        sent.draft = null;
        S.composers.delete(sent.id);
      }
      try {
        let id = this.threadId;
        if (id && this.pendingFork) {
          const pending = this.pendingFork;
          const { thread } = await api("POST", `/threads/${encodeURIComponent(id)}/fork`, pending.settings);
          S.threads.set(thread.id, thread);
          S.details.set(thread.id, { items: [], byId: new Map(), turns: new Map() });
          this.threadId = id = thread.id;
          this.pendingFork = null;
          this.archiveOnSend = pending.archive ? sent.id : null;
          archiveAfterSend = this.archiveOnSend;
          if (this.variant !== "dock") setCurrent(id);
          else dock.remember(id);
          // The fork endpoint chooses the provider/model; apply other pending composer settings too.
          await this.updateSettings(pending.settings);
          this.renderAll();
        }
        if (!id) {
          const cur = this.settings();
          const { thread } = await api("POST", "/threads", {
            provider: cur.provider,
            model: cur.model,
            effort: cur.effort,
            modelParams: cur.modelParams,
            mode: cur.mode,
            customMode: cur.custom?.id ?? null,
            approval: cur.approval,
            web: cur.web,
            cwd: cur.cwd,
            useWorktree: Boolean(cur.useWorktree),
            scope: cur.scope,
          });
          S.threads.set(thread.id, thread);
          S.details.set(thread.id, { items: [], byId: new Map(), turns: new Map() });
          id = thread.id;
          this.threadId = id;
          this.draft = null;
          if (this.variant !== "dock") setCurrent(id);
          else dock.remember(id);
          this.renderAll();
        }
        this.stick = true;
        // dock: the host watches a floating-chat turn for a new page on its way (pageIntent.ts).
        await api("POST", `/threads/${encodeURIComponent(id)}/messages`, { text, images, files, context, ...(this.variant === "dock" ? { dock: true } : {}) });
        if (archiveAfterSend) {
          const from = archiveAfterSend;
          if (this.threadId === id) this.archiveOnSend = null;
          api("PATCH", `/threads/${encodeURIComponent(from)}`, { archived: true }).catch((err) => notice(err.message));
        }
        for (const file of held) if (file.url) URL.revokeObjectURL(file.url);
        this.renderContext();
      } catch (err) {
        notice(err.message);
        if (!this.input.value && !this.attachments.length && !this.mentions.length) {
          this.input.value = text;
          this.attachments = held;
          this.mentions = heldMentions;
          this.autosize();
          this.renderContext();
        } else {
          for (const file of held) if (file.url) URL.revokeObjectURL(file.url);
        }
      } finally {
        this.sending = false;
      }
    }
  }

  /** Markdown to one plain line for previews: link labels kept, markup dropped. */
  function plain(text) {
    return String(text || "")
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, key, label) => label || key)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`#>~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function lastLine(text) {
    const s = String(text || "").trimEnd();
    const i = s.lastIndexOf("\n");
    return plain(i < 0 ? s : s.slice(i + 1)).slice(0, 160);
  }

  /** One live step as the collapsed dock and pages' step feeds show it: { kind, text }, or null. */
  function liveStep(item) {
    if (item.kind === "tool") {
      const helper = helperCall(item);
      if (helper) return { kind: `k-${item.tool}`, text: helperLine(helper) };
      const text = item.tool === "edit" && item.files?.length ? `Edited ${item.files.map((f) => `${R.basename(f.path)} +${f.added} −${f.removed}`).join(", ")}` : item.detail && item.tool === "execute" ? `$ ${item.detail}` : item.title;
      return { kind: `k-${item.tool}`, text };
    }
    if (item.kind === "notice") return { kind: item.level, text: item.text };
    if (item.kind === "reasoning") return { kind: "reason", text: lastLine(item.text) || "Thinking…" };
    if (item.kind === "text") return { kind: "text", text: lastLine(item.text) };
    return null;
  }

  const PAGE_WRITE_TOOLS = new Set(["page_show", "page_patch", "page_update", "page_action"]);

  /**
   * A page_show call still under way that makes a page there isn't one of yet, in front: { title }.
   * A call with no input yet says nothing about which page it is for, so it has to wait.
   */
  function newPageCall(item) {
    if (item.kind !== "tool" || item.parentToolId || (item.status !== "pending" && item.status !== "running")) return null;
    if (!isRecord(item.input) || item.input.background === true) return null;
    const page = pageTool(item);
    if (page?.name !== "page_show") return null;
    if (page.ref && app()?.resolvePages?.([page.ref])?.[page.ref]) return null;
    return { title: typeof item.input.title === "string" ? item.input.title.trim() : "" };
  }

  /** A finished page_show call that put a page in front of the user. */
  function shownPageCall(item) {
    if (item.kind !== "tool" || item.parentToolId || (item.status !== "done" && item.status !== "error")) return false;
    return pageTool(item)?.name === "page_show" && !(isRecord(item.input) && item.input.background === true);
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * A call to one of Scribe's page-writing tools, read for the chat: { name, ref, title, verb, summary }.
   * Claude names it mcp__scribe__page_show; Cursor and Pi title it "Scribe: page_show".
   */
  function pageTool(it) {
    if (it.tool !== "mcp") return null;
    const name = /^Scribe:\s+(page_\w+)/.exec(it.title || "")?.[1] || (PAGE_WRITE_TOOLS.has(it.name) ? it.name : "");
    if (!PAGE_WRITE_TOOLS.has(name)) return null;
    const input = isRecord(it.input) ? it.input : {};
    const result = parseToolJson(it.output);
    const ref = [input.key, input.id, result?.key, result?.id].find((v) => typeof v === "string" && v.trim()) || "";
    const resolved = ref ? app()?.resolvePages?.([ref])?.[ref] : null;
    const title = resolved?.title || result?.title || (typeof input.title === "string" && input.title) || ref.replace(/^scribe:/, "") || "page";
    const done = it.status === "done";
    const page = { name, ref, title, verb: "", summary: "" };
    if (name === "page_show") {
      page.verb = done ? (result?.created ? "Created" : "Showed") : it.status === "error" ? "Show" : "Showing";
      if (typeof input.htmlPath === "string") page.summary = "from file";
    } else if (name === "page_patch") {
      page.verb = done ? "Edited" : it.status === "error" ? "Edit" : "Editing";
      const n = Array.isArray(input.edits) ? input.edits.length : 0;
      page.summary = n ? `${n} ${n === 1 ? "edit" : "edits"}` : typeof input.htmlPath === "string" ? "whole page" : typeof input.title === "string" ? "title" : "";
    } else if (name === "page_update") {
      page.verb = done ? "Updated" : it.status === "error" ? "Update" : "Updating";
      const ops = Array.isArray(input.ops) ? input.ops.filter(isRecord) : [];
      page.summary = ops.length === 1 ? opLine(ops[0]) : ops.length ? `${ops.length} changes` : "";
    } else page.summary = actionSummary(typeof input.action === "string" ? input.action : "", isRecord(input.args) ? input.args : {}, result?.result, done);
    return page;
  }

  /** Keep the target and search terms visible without opening a file tool's JSON. */
  function fileToolSummary(it) {
    if (it.tool !== "mcp") return null;
    const name = /^Scribe:\s+(read_file|grep_files|list_files)\b/.exec(it.title || "")?.[1]
      || /^mcp__scribe__(read_file|grep_files|list_files)$/.exec(it.name || "")?.[1];
    if (!name || !isRecord(it.input)) return null;
    const input = it.input;
    const path = typeof input.path === "string" && input.path.trim() ? input.path : ".";
    const parts = [];
    if (name === "read_file") {
      if (typeof input.path !== "string" || !input.path.trim()) return null;
      parts.push(`Read ${path}`);
      if (Number.isInteger(input.offset) || Number.isInteger(input.limit)) {
        const start = Number.isInteger(input.offset) && input.offset > 0 ? input.offset : 1;
        const limit = Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 1000) : 200;
        const result = parseToolJson(it.output);
        if (result?.kind !== "directory") parts.push(`from line ${start}, up to ${limit} lines`);
      }
    } else if (name === "grep_files") {
      if (typeof input.pattern !== "string") return null;
      parts.push(`Search “${input.pattern}” in ${path}`);
    } else parts.push(`List files in ${path}`);
    if (typeof input.glob === "string" && input.glob) parts.push(input.glob);
    if (name === "grep_files" && input.fixedStrings) parts.push("literal");
    if (name === "grep_files" && input.ignoreCase) parts.push("ignore case");
    if (name !== "read_file" && Number.isInteger(input.offset) && input.offset > 1) parts.push(`from result ${input.offset}`);
    return parts.join(" · ");
  }

  /** A thread's helper threads (agent_run), oldest first. */
  function helpersOf(id) {
    return [...S.threads.values()].filter((t) => t.helperOf === id).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Threads whose earlier helpers the list shows in full. */
  const helpersShown = new Set();

  /** A helper the thread list shows under the thread that started it (archived together, so they share a list). */
  function nestsUnder(t) {
    const parent = t.helperOf ? S.threads.get(t.helperOf) : null;
    return Boolean(parent && parent.archived === t.archived);
  }

  /** A helper's name without the "Helper:" its title starts with. */
  function helperName(t) {
    return t.title.replace(/^Helper:\s*/, "") || t.title;
  }

  /** What a working helper is at: the question it waits on, or its live step. */
  function helperStep(t) {
    if (t.status === "waiting") return t.asking?.title ? `Needs your answer: ${t.asking.title}` : "Needs your answer";
    return t.activity?.line || "Starting…";
  }

  /** An agent_run call as one live step: the helper and its model, not the tool's name. Keep in sync with src/agent/activity.ts */
  function helperLine(call) {
    const h = call.thread;
    const task = typeof call.input.task === "string" ? call.input.task.trim().split("\n")[0] : "";
    const name = (h ? helperName(h) : task).slice(0, 120);
    const model = h ? modelLabel(h.provider, h.model) : [call.input.model, call.input.provider].find((v) => typeof v === "string" && v.trim()) || "";
    return ["Helper", name, model].filter(Boolean).join(" · ");
  }

  /** Helpers appear through their parent in the active list, including between parent turns. */
  function activeThreads() {
    return [...S.threads.values()].filter((t) => !t.helperOf).map((t) => {
      const busy = helpersOf(t.id).filter((h) => !h.archived && h.status !== "idle");
      const helper = busy.find((h) => h.status === "waiting") || busy[0];
      if (!helper || t.status === "waiting" || (t.status === "running" && helper.status !== "waiting")) return t;
      return { ...t, status: helper.status, asking: undefined, activity: { line: `Helper · ${helperName(helper)}: ${helperStep(helper)}` } };
    });
  }

  /** An agent_run tool call: its input, its result, and the helper thread it started or sent on (once known). */
  function helperCall(it) {
    if (it.kind !== "tool" || !(/agent_run$/.test(it.name || "") || /agent_run$/.test(it.title || ""))) return null;
    const input = isRecord(it.input) ? it.input : {};
    const existing = typeof input.thread === "string" && Boolean(input.thread.trim());
    let result = parseToolJson(it.output);
    const id = [it.helper, input.thread, result?.thread].find((v) => typeof v === "string" && v.trim()) || "";
    const thread = id ? S.threads.get(id) || null : null;
    const live = thread ? thread.status !== "idle" : it.status === "running" || it.status === "pending";
    // A background launch returns a receipt; the finished helper supplies the report.
    if (!existing && result?.status === "running" && thread?.status === "idle") {
      const detail = S.details.get(id);
      const turn = detail && [...detail.turns.values()].at(-1);
      result = {
        ...result, status: turn?.status || "done", error: turn?.error,
        reply: detail?.items.filter((item) => item.turnId === turn?.id && item.kind === "text").at(-1)?.text,
        files: turn?.files?.map((file) => `${file.status} ${file.path}`),
        tokens: { input: turn?.usage?.inputTokens || 0, output: turn?.usage?.outputTokens || 0 },
      };
    }
    const ended = it.status === "error" || result?.status === "error" ? "error" : result?.status && result.status !== "done" ? "stopped" : "done";
    return { id, input, result, thread, live, existing, state: live ? (thread?.status === "waiting" ? "waiting" : "running") : ended };
  }

  /** The JSON object a page tool returned; its text may carry a guide or note after it. */
  function parseToolJson(output) {
    const text = String(output || "").trim();
    if (!text.startsWith("{")) return null;
    for (const end of [text.length, text.indexOf("\n}") + 2]) {
      if (end < 2) continue;
      try {
        const value = JSON.parse(text.slice(0, end));
        if (isRecord(value)) return value;
      } catch {
        /* try the next cut */
      }
    }
    return null;
  }

  /** One line for a page_action call, e.g. "Moved #12 to Done". Written for Kanban and todo pages; other actions read as "Action #12". */
  function actionSummary(action, args, result, done) {
    const ref = (v) => (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)) ? `#${v}` : typeof v === "string" ? v : "");
    const item = ref(args.card ?? args.item);
    const quote = (v) => {
      const text = typeof v === "string" ? v.trim() : "";
      return text ? `“${text.length > 60 ? `${text.slice(0, 60)}…` : text}”` : "";
    };
    const pick = (past, now) => (done ? past : now);
    switch (action) {
      case "list": {
        const filters = ["column", "label", "assignee", "q"].filter((k) => typeof args[k] === "string" && args[k]).map((k) => `${k} ${args[k]}`);
        return `${pick("Listed", "Listing")} ${args.archived ? "archived " : ""}items${filters.length ? ` · ${filters.join(", ")}` : ""}`;
      }
      case "get":
        return `${pick("Read", "Reading")} ${item}`.trim();
      case "create":
        return [pick("Created", "Creating"), done && isRecord(result) && result.num ? `#${result.num}` : "", quote(args.title), typeof args.column === "string" ? `in ${args.column}` : ""].filter(Boolean).join(" ");
      case "update": {
        if (args.status === null) return `${pick("Cleared the status of", "Clearing the status of")} ${item}`;
        if (isRecord(args.status) && typeof args.status.text === "string") return `${item} status: ${args.status.text}`;
        const fields = Object.keys(args).filter((k) => k !== "card" && k !== "item");
        return `${pick("Updated", "Updating")} ${item}${fields.length ? ` · ${fields.join(", ")}` : ""}`;
      }
      case "comment":
        return `${pick("Commented on", "Commenting on")} ${item}`;
      case "move":
        return `${pick("Moved", "Moving")} ${item}${args.to ? ` to ${args.to}` : ""}`;
      case "claim":
        return `${pick("Claimed", "Claiming")} ${item}${typeof args.text === "string" ? ` · ${args.text}` : ""}`;
      case "release":
        return `${pick("Released", "Releasing")} ${item}${args.to ? ` to ${args.to}` : ""}`;
      case "finish":
        return `${pick("Finished", "Finishing")} ${item}${args.to ? ` to ${args.to}` : ""}`;
      default: {
        const words = action.replace(/[_-]+/g, " ").trim() || "action";
        return `${words[0].toUpperCase()}${words.slice(1)}${item ? ` ${item}` : ""}`;
      }
    }
  }

  /** One page_update op in a short form: "merge cards/num=31 · status, title". */
  function opLine(op) {
    const path = typeof op.path === "string" ? op.path || "(whole state)" : "?";
    const brief = (v) => {
      let text;
      try {
        text = JSON.stringify(v);
      } catch {
        text = String(v);
      }
      return text === undefined ? "" : text.length > 60 ? `${text.slice(0, 60)}…` : text;
    };
    switch (op.op) {
      case "merge":
        return `merge ${path}${isRecord(op.value) ? ` · ${Object.keys(op.value).join(", ")}` : ""}`;
      case "set":
        return `set ${path} = ${brief(op.value)}`;
      case "insert":
        return `insert into ${path}${isRecord(op.value) && (op.value.title || op.value.text) ? ` · ${brief(op.value.title || op.value.text)}` : ""}`;
      case "remove":
        return `remove ${path}`;
      case "move":
        return `move ${path}${op.before ? ` before ${op.before}` : op.after ? ` after ${op.after}` : op.at !== undefined ? ` to ${op.at}` : ""}`;
      case "test":
        return `check ${path} = ${brief(op.value)}`;
      default:
        return `${op.op || "op"} ${path}`;
    }
  }

  /** An old → new snippet pair as a diff file for R.renderDiffFile, with shared leading and trailing lines as context. */
  function snippetDiff(oldText, newText) {
    const a = oldText.split("\n");
    const b = newText === "" ? [] : newText.split("\n");
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
    const lines = [];
    let oldNo = 1;
    let newNo = 1;
    for (let i = 0; i < head; i += 1) lines.push({ kind: "ctx", text: a[i], oldNo: oldNo++, newNo: newNo++ });
    for (let i = head; i < a.length - tail; i += 1) lines.push({ kind: "del", text: a[i], oldNo: oldNo++ });
    for (let i = head; i < b.length - tail; i += 1) lines.push({ kind: "add", text: b[i], newNo: newNo++ });
    for (let i = a.length - tail; i < a.length; i += 1) lines.push({ kind: "ctx", text: a[i], oldNo: oldNo++, newNo: newNo++ });
    return { path: "", lines, added: b.length - tail - head, removed: a.length - tail - head, binary: false, status: "M" };
  }

  function jsonText(value) {
    try {
      const text = JSON.stringify(value, null, 2);
      return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
    } catch {
      return String(value);
    }
  }

  function fmtTokens(n) {
    if (!n) return "0";
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }

  function modelLabel(provider, id) {
    return modelInfo(provider, id)?.label || id || "";
  }

  function elapsed(start) {
    const span = el("span", "ag-elapsed", R.duration(Date.now() - start));
    span.dataset.start = String(start);
    return span;
  }

  /** Clock time of a finished turn; tooltip has the full datetime. */
  function finishStamp(ms) {
    const span = el("span", "ag-muted", R.finishTime(ms));
    span.dataset.tooltip = new Date(ms).toLocaleString();
    return span;
  }

  /** Idle threads show when the last turn finished; running ones stay relative. */
  function threadWhenMs(t) {
    return t.status === "idle" && t.finishedAt ? t.finishedAt : t.activityAt;
  }

  function threadWhenText(t) {
    const ms = threadWhenMs(t);
    return t.status === "idle" && t.finishedAt ? R.finishTime(ms) : R.timeAgo(ms);
  }

  function threadWhen(t) {
    const ms = threadWhenMs(t);
    const span = el("span", null, threadWhenText(t));
    span.dataset.tooltip = new Date(ms).toLocaleString();
    return span;
  }

  /** Points a stopwatch span at a start time, or clears it. Returns the span. */
  function setClock(span, start) {
    if (start) {
      span.dataset.start = String(start);
      span.textContent = clockText(Date.now() - start);
    } else {
      delete span.dataset.start;
      span.textContent = "";
    }
    return span;
  }

  /** Elapsed time as a stopwatch, "0:42" or "1:05:09". */
  function clockText(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  setInterval(() => {
    for (const span of document.querySelectorAll(".ag-elapsed[data-start]")) {
      span.textContent = R.duration(Date.now() - Number(span.dataset.start));
    }
    for (const span of document.querySelectorAll(".ag-clock[data-start]")) {
      span.textContent = clockText(Date.now() - Number(span.dataset.start));
    }
  }, 1000);

  /** A chat step: kept or replaced whole when its turn is re-rendered, since its handlers close over its own nodes. */
  const isItemNode = (node) => node.hasAttribute("data-item-id");

  /** A collapsed step's body, built the first time it is opened: node -> fill(). */
  const lazyBodies = new WeakMap();

  function fillLazy(node) {
    const fill = lazyBodies.get(node);
    if (!fill) return;
    lazyBodies.delete(node);
    fill();
  }

  /** Whether a tool step that is not a page write has a body to open: the same tests renderTool's body makes. */
  function toolHasBody(it, children) {
    const brief = it.tool === "task" && typeof it.input?.prompt === "string";
    if (it.detail && !brief) return true;
    if (it.diff || brief || children?.length) return true;
    if (it.input && (it.tool === "mcp" || it.tool === "other" || it.tool === "fetch" || it.tool === "task")) return true;
    return Boolean(it.output && it.tool !== "read" && !it.task?.background);
  }

  const NO_CHILDREN = new Map();

  /** Classes renderGroup sets by where a step sits; a kept step's stand-in takes them again. */
  const PLACE_CLASSES = ["ag-step-last", "ag-answer-earlier"];

  /** What an item's step shows, as a string: equal strings render the same. */
  function itemSig(it, byParent) {
    const children = it.kind === "tool" && it.toolId ? byParent.get(it.toolId) : null;
    const page = it.kind === "tool" ? pageTool(it) : null;
    return JSON.stringify([it, page?.title, children?.map((child) => itemSig(child, byParent))]);
  }

  /** Text typed into a waiting card (an approval's or a page ask's note, a plan's change request), kept across re-renders. */
  const cardNotes = new Map();

  function keepNote(input, key) {
    input.value = cardNotes.get(key) || "";
    input.addEventListener("input", () => {
      if (input.value) cardNotes.set(key, input.value);
      else cardNotes.delete(key);
    });
    return input;
  }

  const mdCtx = { resolvePages: (targets) => app()?.resolvePages?.(targets) || {} };

  function onLinkClick(event) {
    if (event.defaultPrevented || (event.type === "auxclick" ? event.button !== 1 : event.button !== 0)) return;
    const board = event.target.closest?.(".ag-board-link");
    if (board) {
      event.preventDefault();
      app()?.openLink(board.dataset.boardTarget, event);
      return;
    }
    const web = event.target.closest?.("a.ag-web-link");
    if (web) {
      event.preventDefault();
      app()?.openLink(web.dataset.webHref, event);
    }
  }

  function preventLinkAutoscroll(event) {
    if (event.button === 1 && event.target.closest?.(".ag-board-link, a.ag-web-link")) event.preventDefault();
  }

  /* ---------- thread list ---------- */

  function newThreadMenu(anchor, view) {
    const tab = activeTab();
    const items = [{ header: "New thread for" }];
    if (tab) items.push({ label: tab.title, detail: "This page (Pages mode)", icon: "page", run: () => view.startDraft({ kind: "page", ref: tab.id }) });
    if (tab?.folderId) items.push({ label: folderPath(tab.folderId), detail: "This folder", icon: "folder", run: () => view.startDraft({ kind: "folder", ref: tab.folderId }) });
    items.push({ label: "Global", detail: "Not tied to a page or folder", icon: "globe", run: () => view.startDraft({ kind: "global", ref: null }) });
    items.push({ separator: true });
    for (const dir of recentWorkspaceDirs(null)) {
      items.push({ label: R.basename(dir), detail: dir, icon: "box", run: () => view.startDraft({ kind: "global", ref: null }, { cwd: dir, mode: "code" }) });
    }
    items.push({
      label: "Another workspace…",
      icon: "folder",
      run: async () => {
        const dir = await pickWorkspace(null);
        if (dir) view.startDraft({ kind: "global", ref: null }, { cwd: dir, mode: "code" });
      },
    });
    openMenu(anchor, items, { width: 280 });
  }

  function groupKey(thread) {
    if (S.filter === "workspaces") {
      const dir = workspaceDir(thread);
      return dir ? `ws:${dirKey(dir)}` : "ws";
    }
    if (S.filter === "here") return hereGroup(thread) || "global";
    const s = thread.scope;
    if (s.kind === "global") return "global";
    return `${s.kind}:${s.ref}`;
  }

  function groupTitle(thread) {
    if (S.filter === "workspaces") {
      const dir = workspaceDir(thread);
      return { icon: dir ? "box" : "close", text: dir ? R.basename(dir) || dir : "No workspace", kind: "Workspace" };
    }
    // Here keeps the page's own group for the thread that made it, and groups the page's workspace by folder.
    const here = S.filter === "here" ? hereGroup(thread) : null;
    if (here?.startsWith("ws:")) {
      const dir = activeTab()?.workspace;
      return { icon: "box", text: R.basename(dir) || dir, kind: "Workspace" };
    }
    const s = here?.startsWith("page:") ? { kind: "page", ref: here.slice(5) } : thread.scope;
    const label = scopeLabel(s);
    const kind = s.kind === "page" ? "Page" : s.kind === "folder" ? "Folder" : s.kind === "workspace" ? "Workspace" : "Global";
    return { icon: label.icon, text: s.kind === "global" ? "Global" : label.text, kind };
  }

  /**
   * Draft for a new thread in a list group: the group's Scribe scope, with the settings of the
   * group's latest thread (threads a person started win over page-launched ones). Workspace groups
   * start Global (page tools, all-thread access) in Code mode with that folder as cwd; app scope
   * None is opt-in.
   */
  function groupDraft(key) {
    const members = [...S.threads.values()].filter((t) => !t.archived && groupKey(t) === key);
    const last = (members.some((t) => !t.fromPage) ? members.filter((t) => !t.fromPage) : members).sort((a, b) => b.activityAt - a.activityAt)[0];
    if (!last) return null;
    const dir = S.filter === "workspaces" ? workspaceDir(last) : key.startsWith("ws:") ? activeTab()?.workspace || null : null;
    const scope = dir ? { kind: "global", ref: null } : key.startsWith("page:") ? { kind: "page", ref: key.slice(5) } : { ...last.scope };
    const settings = { mode: dir ? "code" : last.mode, customMode: dir ? null : last.custom?.id ?? null, web: last.web, cwd: dir || homeDir(last), useWorktree: Boolean(last.useWorktree) };
    if (providerAvailable(last.provider)) {
      Object.assign(settings, { provider: last.provider, model: last.model, effort: last.effort, modelParams: { ...(last.modelParams || {}) }, approval: last.approval });
    }
    return { scope, settings };
  }

  function renderThreadList(container, { onPick, currentId, onNew, onNewIn }) {
    // Thread updates re-render the list; typing in its search box keeps the focus and the highlighted row.
    const oldSearch = container.querySelector(".ag-list-top input[type=search]");
    const hadFocus = Boolean(oldSearch) && document.activeElement === oldSearch;
    const caret = hadFocus ? [oldSearch.selectionStart, oldSearch.selectionEnd] : null;
    const top = container.querySelector(":scope > .ag-list-top") || el("div", "ag-list-top");
    const search = oldSearch || el("input", "ag-input small");
    search.type = "search";
    search.placeholder = "Search threads";
    search.value = S.search;
    search.oninput = () => {
      S.search = search.value;
      container.dataset.activeId = "";
      container.agFill();
      void searchMessages(S.search).then((fresh) => fresh && renderLists());
    };
    // Up and Down move a highlight through the rows; Enter opens the highlighted thread. The highlight
    // shows from the first arrow press until the search box next gets the focus.
    const rows = () => [...list.querySelectorAll("button.ag-row")];
    const highlight = (at, scroll = true) => {
      const items = rows();
      if (!items.length) return;
      const i = ((at % items.length) + items.length) % items.length;
      items.forEach((row, j) => row.classList.toggle("ag-row-active", j === i));
      container.dataset.activeId = items[i].dataset.id;
      if (scroll) items[i].scrollIntoView({ block: "nearest" });
    };
    search.onkeydown = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = rows();
        if (!container.classList.contains("ag-list-kb")) {
          container.classList.add("ag-list-kb");
          // The first press shows the row Enter opens before it moves on.
          const shown = items.findIndex((row) => row.classList.contains("ag-row-active"));
          if (shown >= 0) {
            items[shown].scrollIntoView({ block: "nearest" });
            return;
          }
        }
        const at = items.findIndex((row) => row.classList.contains("ag-row-active"));
        highlight(at < 0 ? (event.key === "ArrowDown" ? 0 : -1) : at + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const items = rows();
        (items.find((row) => row.classList.contains("ag-row-active")) || items[0])?.click();
      }
    };
    const seg = el("div", "ag-seg small");
    for (const [id, label] of [
      ["here", "Here"],
      ["workspaces", "Workspaces"],
      ["all", "All"],
      ["archived", "Archived"],
    ]) {
      seg.append(
        button(label, `ag-seg-btn${S.filter === id ? " on" : ""}`, () => {
          S.filter = id;
          localStorage.setItem(LS.filter, id);
          renderLists();
        })
      );
    }
    const newBtn = button("", "ag-btn small primary ag-new", (event) => onNew(event.currentTarget));
    newBtn.append(icon("plus"), el("span", null, "New"));
    // Toolbox row above the threads: list toggles that change which rows show, or how.
    const tools = el("div", "ag-list-tools");
    const workers = button("", "ag-switch-btn", (event) => {
      S.hidePageThreads = !S.hidePageThreads;
      localStorage.setItem(LS.hidePage, S.hidePageThreads ? "1" : "0");
      event.currentTarget.setAttribute("aria-checked", String(!S.hidePageThreads));
      container.agFill();
    }, "Running workers and workers waiting for input always show. This also shows inactive threads started by a page (board workers).");
    workers.setAttribute("role", "switch");
    workers.setAttribute("aria-checked", String(!S.hidePageThreads));
    workers.append(el("span", "ag-switch"), el("span", null, "Show workers"));
    const compact = button("", "ag-switch-btn", () => {
      localStorage.setItem(LS.compact, compactThreads() ? "0" : "1");
      renderLists();
    }, "Each thread shows only its title and status, in a smaller font with less spacing");
    compact.setAttribute("role", "switch");
    compact.setAttribute("aria-checked", String(compactThreads()));
    compact.append(el("span", "ag-switch"), el("span", null, "Compact"));
    tools.append(workers, compact);
    const oldTools = top.querySelector(".ag-list-tools");
    if (oldTools) window.scribeSyncChildren(oldTools, [...tools.childNodes]);
    window.scribeSyncChildren(top, [search, seg, newBtn, oldTools || tools, ...movedBanners()]);
    // The list and its unchanged rows stay in the page: a rebuilt row loses its hover and blinks (#407).
    const list = container.querySelector(":scope > .ag-list") || el("div", "ag-list");
    list.className = `ag-list${compactThreads() ? " compact" : ""}`;
    window.scribeSyncChildren(container, [top, list]);
    const fill = () => {
      for (const row of list.querySelectorAll(".ag-row-active")) row.classList.remove("ag-row-active");
      const out = [];
      collect(out);
      // Rows are patched where they stand, so a running thread's row keeps its hover as its status changes (#443).
      window.scribeSyncChildren(list, out, { patch: true });
      const at = rows().findIndex((row) => row.dataset.id === container.dataset.activeId);
      highlight(Math.max(0, at), false);
    };
    // A kept row's button outlives this render, so it fills through the latest one.
    container.agFill = fill;
    const collect = (out) => {
      const q = S.search.trim().toLowerCase();
      let threads = [...S.threads.values()].filter((t) => (S.filter === "archived" ? t.archived : !t.archived));
      if (S.filter === "here") threads = threads.filter(hereMatch);
      // Threads with no scope at all group here too, under No workspace.
      if (S.filter === "workspaces") threads = threads.filter((t) => workspaceDir(t) || t.scope.kind === "workspace");
      const hiddenDirs = hiddenWorkspaceKeys();
      if (q) threads = rankedThreads(threads, q).map((row) => row.thread);
      // A hidden workspace's threads only come up in a search.
      else threads = threads.filter((t) => !inHiddenWorkspace(t, hiddenDirs, S.filter === "workspaces"));
      // A helper sits under the thread that started it. A search lists them like any thread.
      if (!q) threads = threads.filter((t) => !nestsUnder(t));
      if (!q) threads.sort((a, b) => threadRank(b) - threadRank(a));
      // Archived starts with the hidden workspaces: the folders alone, to show again or delete.
      const hiddenList = S.filter === "archived" && !q ? prefs().hiddenWorkspaces || [] : [];
      if (hiddenList.length) {
        const head = el("div", "ag-list-group");
        head.dataset.key = "group:hidden-workspaces";
        head.append(icon("box"), el("span", "ag-list-group-kind", "Hidden workspaces"));
        out.push(head);
        for (const dir of hiddenList) {
          const n = workspaceThreads(dir).length;
          const row = el("div", "ag-hidden-ws");
          row.dataset.key = `hidden-ws:${dirKey(dir)}`;
          row.dataset.tooltip = dir;
          const acts = el("div", "ag-hidden-ws-acts");
          acts.append(
            button("Show", "ag-btn small", () => setWorkspaceHidden(dir, false), "Back in the thread list and the workspace menus"),
            button(icon("more"), "ag-icon-btn small", (event) => workspaceMenu(event.currentTarget, dir), "Workspace actions")
          );
          row.append(el("span", "ag-hidden-ws-name", R.basename(dir) || dir), el("span", "ag-hidden-ws-count", n === 1 ? "1 thread" : `${n} threads`), acts);
          out.push(row);
        }
      }
      const open = S.threads.get(currentId);
      const keepId = !q && open && nestsUnder(open) ? open.helperOf : currentId;
      const helperRows = (parent) => {
        const all = q ? [] : helpersOf(parent.id).filter((h) => h.archived === parent.archived);
        if (!all.length) return;
        // Working ones and the open one always show; of the rest, the latest two until asked for more.
        const must = (h) => h.status !== "idle" || h.id === currentId;
        const latest = all.filter((h) => !must(h)).slice(-2);
        const keep = helpersShown.has(parent.id) ? all : all.filter((h) => must(h) || latest.includes(h));
        const box = el("div", "ag-row-helpers");
        box.dataset.key = `helpers:${parent.id}`;
        for (const h of keep) box.append(threadRow(h, h.id === currentId, onPick, helperName(h)));
        const hidden = all.length - keep.length;
        if (hidden || (helpersShown.has(parent.id) && all.length > 2)) {
          const more = button("", "ag-list-more", () => {
            if (hidden) helpersShown.add(parent.id);
            else helpersShown.delete(parent.id);
            container.agFill();
          });
          more.append(el("span", null, hidden ? `Show ${hidden} earlier ${hidden === 1 ? "helper" : "helpers"}` : "Show fewer helpers"));
          box.append(more);
        }
        out.push(box);
      };
      if (!threads.length) {
        if (hiddenList.length) return;
        out.push(
          el(
            "div",
            "ag-list-empty",
            S.filter === "here"
              ? "No threads for this page yet. Threads for its folder, its workspace and global threads show here too."
              : S.filter === "workspaces"
                ? "No threads belonging to a workspace yet."
                : "No threads"
          )
        );
        return;
      }
      // Grouping would put weaker hits from one workspace above stronger hits from another.
      if (q) {
        for (const t of threads) out.push(threadRow(t, t.id === currentId, onPick));
        return;
      }
      const order = [];
      const groups = new Map();
      for (const t of threads) {
        const key = groupKey(t);
        if (!groups.has(key)) {
          groups.set(key, []);
          order.push(key);
        }
        groups.get(key).push(t);
      }
      const kindRank = { page: 0, folder: 1, workspace: 2, global: 3 };
      const keyKind = (key) => (key.startsWith("ws:") ? "workspace" : key.split(":")[0]);
      if (S.filter === "here") order.sort((a, b) => kindRank[keyKind(a)] - kindRank[keyKind(b)]);
      const now = Date.now();
      let shown = 0;
      for (const key of order) {
        const members = groups.get(key);
        const { visible, hidden } = windowGroup(members, {
          extra: S.groupExtra.get(key) || 0,
          now,
          currentId: keepId,
          searching: Boolean(q),
          hidePage: S.hidePageThreads,
        });
        // Keep older-only groups reachable through their Show more button.
        if (!visible.length && !hidden) continue;
        shown++;
        const first = visible[0] || members[0];
        const gt = groupTitle(first);
        // A search shows what it found, whatever is folded.
        const folded = !q && S.collapsedGroups.has(key);
        const head = el("div", `ag-list-group foldable${folded ? " folded" : ""}`);
        head.dataset.key = `group:${key}`;
        head.setAttribute("role", "button");
        head.tabIndex = 0;
        head.setAttribute("aria-expanded", String(!folded));
        // The header is kept across renders, so its handlers read the fold as it is now.
        const fold = () => {
          if (S.collapsedGroups.has(key)) S.collapsedGroups.delete(key);
          else S.collapsedGroups.add(key);
          localStorage.setItem(LS.collapsed, JSON.stringify([...S.collapsedGroups]));
          renderLists();
        };
        head.addEventListener("click", (event) => {
          if (!event.target.closest("button")) fold();
        });
        head.addEventListener("keydown", (event) => {
          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          fold();
        });
        const name = gt.kind === "Global" ? "" : gt.text;
        head.append(icon("chevron", "ag-ico ag-chev"), icon(gt.icon), el("span", "ag-list-group-kind", gt.kind), el("span", "ag-list-group-name", name));
        if (folded) head.append(el("span", "ag-list-group-count", String(members.length)));
        // The folder a workspace group stands for: every group of the Workspaces list, and app scope None elsewhere.
        const dir = S.filter === "workspaces" ? workspaceDir(first) : key.startsWith("ws:") ? activeTab()?.workspace : first.scope.kind === "workspace" ? first.scope.ref : null;
        if (dir) head.dataset.tooltip = dir;
        const acts = el("span", "ag-list-group-acts");
        if (dir) acts.append(button(icon("more"), "ag-icon-btn small ag-list-group-new", (event) => workspaceMenu(event.currentTarget, dir), "Hide or delete this workspace"));
        if (S.filter !== "archived") {
          const add = button(icon("plus"), "ag-icon-btn small ag-list-group-new", () => {
            const draft = groupDraft(key);
            if (draft) onNewIn(draft.scope, draft.settings);
          }, `New thread here, with the settings of its latest thread`);
          acts.append(add);
        }
        if (acts.childNodes.length) head.append(acts);
        out.push(head);
        if (folded) continue;
        for (const t of visible) {
          out.push(threadRow(t, t.id === currentId, onPick));
          helperRows(t);
        }
        if (hidden) {
          const more = button("", "ag-list-more", () => {
            S.groupExtra.set(key, (S.groupExtra.get(key) || 0) + LIST_PAGE);
            container.agFill();
          });
          more.dataset.key = `more:${key}`;
          more.append(el("span", null, visible.length ? "Show 10 more" : "Show older threads"), el("span", "ag-list-more-count", hidden === 1 ? "1 hidden" : `${hidden} hidden`));
          out.push(more);
        }
      }
      if (!shown) {
        out.push(
          el(
            "div",
            "ag-list-empty",
            S.hidePageThreads
              ? "No recent threads. Worker and older threads are hidden."
              : "No recent threads. Older threads are hidden."
          )
        );
      }
    };
    fill();
    search.onfocus = () => container.classList.remove("ag-list-kb");
    if (hadFocus) {
      // A re-render while typing keeps the highlight shown or hidden.
      const kb = container.classList.contains("ag-list-kb");
      search.focus();
      container.classList.toggle("ag-list-kb", kb);
      search.setSelectionRange(caret[0], caret[1]);
    }
  }

  /** The line under a thread's title: provider, model, when, page, changes and worktree branch. */
  function threadRowMeta(t) {
    const meta = el("span", "ag-row-meta");
    meta.append(providerIcon(t.provider), el("span", null, modelLabel(t.provider, t.model)), el("span", null, "·"), threadWhen(t));
    if (t.fromPage) meta.append(el("span", null, "·"), el("span", null, "page"));
    if (t.helperOf) meta.append(el("span", "ag-row-helper-tag", "· helper"));
    if (t.stats.files) meta.append(el("span", null, "·"), R.counts(t.stats.added, t.stats.removed));
    const wt = openWorktree(t);
    if (wt) {
      const branch = el("span", `ag-row-branch${wt.ahead || wt.dirty ? " pending" : ""}`);
      branch.append(icon("git"), el("span", null, wt.branch.replace(/^agent\//, "")));
      branch.dataset.tooltip = `${wt.branch}${wt.ahead || wt.dirty ? ": work not merged yet" : ""}`;
      meta.append(branch);
    }
    return meta;
  }

  /** label: the title to show instead of the thread's own (a helper under its thread drops the "Helper:"). */
  function threadRow(t, current, onPick, label) {
    const row = button("", `ag-row${current ? " on" : ""}${t.unread && !t.fromPage ? " unread" : ""}`, () => onPick(t.id));
    row.dataset.id = t.id;
    const quiet = t.status === "idle" && !t.background && !(t.unread && !t.fromPage);
    const dot = quiet && hasDraft(t) ? icon("pen", "ag-row-pen") : el("span", `ag-dot s-${t.status === "idle" && t.background ? "running" : t.status}`);
    if (t.background) dot.dataset.tooltip = `${t.background} background ${t.background === 1 ? "task" : "tasks"} running`;
    const main = el("span", "ag-row-main");
    // Draft threads are all "New thread" until sent: tell them apart by what was written.
    const name = !t.titleLocked && !t.stats.turns && t.draft?.text.trim() ? t.draft.text.trim().split("\n")[0].slice(0, 120) : label || t.title;
    const title = el("span", "ag-row-title", name);
    if (compactThreads()) main.append(title);
    else main.append(title, threadRowMeta(t));
    const found = threadMatchSnippet(t, S.search);
    if (found) main.append(el("span", "ag-row-found", found));
    row.append(dot, main);
    if (t.pinned) row.append(el("span", "ag-pin", "•"));
    row.dataset.tooltip = name;
    const wrap = el("div", `ag-row-wrap${current ? " on" : ""}`);
    wrap.dataset.key = t.id;
    // The row stays in the list and is patched as the thread changes, so its handlers read the thread as it is now.
    const id = t.id;
    const first = t;
    wrap.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const t = S.threads.get(id) || first;
      openMenu(wrap, [
        { label: t.pinned ? "Unpin" : "Pin", run: () => api("PATCH", `/threads/${t.id}`, { pinned: !t.pinned }).catch((e) => notice(e.message)) },
        { label: t.archived ? "Unarchive" : "Archive", run: () => archiveThread(t) },
        ...(t.stats.turns ? [{ label: "Fork thread", run: () => forkThread(t, onPick) }] : []),
        ...(t.stats.files ? [{ label: "Changes in this thread", icon: "diff", run: () => openDiff({ kind: "thread", threadId: t.id }) }] : []),
        { separator: true },
        {
          label: "Delete thread",
          danger: true,
          run: () => deleteThread(t),
        },
      ], { width: 220 });
    });
    const acts = el("div", "ag-row-actions");
    acts.append(
      button(icon("archive"), "ag-icon-btn small", (e) => {
        e.stopPropagation();
        archiveThread(S.threads.get(id) || first);
      }, t.archived ? "Unarchive" : "Archive"),
      button(icon("trash"), "ag-icon-btn small danger", (e) => {
        e.stopPropagation();
        void deleteThread(S.threads.get(id) || first);
      }, "Delete thread"),
    );
    wrap.append(row, acts);
    return wrap;
  }

  /* ---------- sidebar pane ---------- */

  const sidebar = {
    pane: null,
    view: new ChatView("side"),
    listEl: el("div", "ag-listview"),
    listOpen: false,
    mount() {
      const pane = document.getElementById("agent-pane");
      if (!pane) return;
      this.pane = pane;
      const inner = pane.querySelector(".agent-inner");
      inner.append(this.view.root, this.listEl);
      this.listEl.hidden = true;
      const resizer = pane.querySelector(".agent-resizer");
      applyWidth(Number(localStorage.getItem(LS.width)) || 420);
      resizer.addEventListener("pointerdown", (event) => {
        const startX = event.clientX, startW = pane.getBoundingClientRect().width;
        const dir = document.documentElement.dataset.agentSide === "left" ? 1 : -1;
        window.scribeDrag({ event, target: resizer, threshold: 0,
          onStart: () => document.body.classList.add("resizing-side"),
          onMove: move => { applyWidth(startW + dir * (move.clientX - startX)); },
          onDrop: () => { document.body.classList.remove("resizing-side"); localStorage.setItem(LS.width, String(Math.round(pane.getBoundingClientRect().width))); },
          onCancel: () => { document.body.classList.remove("resizing-side"); applyWidth(startW); },
        });
      });
      this.apply();
    },
    setOpen(open) {
      if (SOLO) {
        if (open && !S.dockShown) dock.setShown(true);
        return;
      }
      S.sideOpen = open;
      localStorage.setItem(LS.side, open ? "1" : "0");
      this.apply();
      if (open) {
        this.ensureThread();
        setTimeout(() => this.view.focus(), 50);
      }
    },
    apply() {
      if (!this.pane) return;
      if (!S.sideOpen) this.view.audioComposer?.cancel();
      this.pane.classList.toggle("closed", !S.sideOpen);
      this.pane.toggleAttribute("inert", !S.sideOpen);
      this.pane.setAttribute("aria-hidden", S.sideOpen ? "false" : "true");
      document.getElementById("agent-toggle")?.setAttribute("aria-expanded", S.sideOpen ? "true" : "false");
      this.view.wake();
    },
    ensureThread() {
      if (this.view.threadId || this.view.draft) return;
      if (S.current && S.threads.has(S.current)) this.view.setThread(S.current);
      else this.view.startDraft(defaultScope());
    },
    toggleList() {
      this.listOpen = !this.listOpen;
      this.listEl.hidden = !this.listOpen;
      this.view.scroll.hidden = this.listOpen;
      this.view.queueDock.hidden = this.listOpen;
      this.view.composer.hidden = this.listOpen;
      this.view.root.classList.toggle("listing", this.listOpen);
      this.view.renderHeader();
      this.renderList();
    },
    renderList() {
      if (!this.listOpen) return;
      renderThreadList(this.listEl, {
        currentId: this.view.threadId,
        onPick: (id) => {
          setCurrent(id);
          this.view.setThread(id);
          this.toggleList();
          this.view.focus();
        },
        onNew: (anchor) => newThreadMenu(anchor, { startDraft: (scope, settings) => this.startDraft(scope, settings) }),
        onNewIn: (scope, settings) => this.startDraft(scope, settings),
      });
    },
    startDraft(scope, settings) {
      this.view.startDraft(scope, settings);
      if (this.listOpen) this.toggleList();
    },
  };

  function applyWidth(px) {
    const width = Math.max(320, Math.min(900, px));
    document.documentElement.style.setProperty("--agent-width", `${width}px`);
  }

  function defaultScope() {
    const tab = activeTab();
    return tab ? { kind: "page", ref: tab.id } : { kind: "global", ref: null };
  }

  /* ---------- full window ---------- */

  const full = {
    root: null,
    list: el("div", "ag-full-list"),
    view: new ChatView("full"),
    mount() {
      const root = el("div", "agent-full");
      root.hidden = true;
      const side = el("aside", "ag-full-side");
      const resizer = el("div", "ag-full-resizer");
      side.append(this.list, resizer);
      const main = el("div", "ag-full-main");
      main.append(this.view.root);
      root.append(side, main);
      document.body.append(root);
      this.root = root;
      const setWidth = (w) => root.style.setProperty("--ag-full-side", `${Math.round(Math.max(220, Math.min(w, window.innerWidth * 0.6)))}px`);
      const saved = Number(localStorage.getItem(LS.fullSide));
      if (saved) setWidth(saved);
      resizer.addEventListener("pointerdown", (event) => {
        const startX = event.clientX, startW = side.getBoundingClientRect().width;
        window.scribeDrag({ event, target: resizer, threshold: 0,
          onStart: () => document.body.classList.add("resizing-side"),
          onMove: move => { setWidth(startW + move.clientX - startX); },
          onDrop: () => { document.body.classList.remove("resizing-side"); localStorage.setItem(LS.fullSide, String(Math.round(side.getBoundingClientRect().width))); },
          onCancel: () => { document.body.classList.remove("resizing-side"); setWidth(startW); },
        });
      });
      resizer.addEventListener("dblclick", () => {
        root.style.removeProperty("--ag-full-side");
        localStorage.removeItem(LS.fullSide);
      });
      document.addEventListener(
        "click",
        (event) => {
          if (S.fullOpen && event.target.closest?.(".tabs .tab") && !event.target.closest(".tab-close")) leaveFull();
        },
        true
      );
    },
    /** snap: what ChatView.takeChat handed over. */
    open(snap) {
      S.fullOpen = true;
      this.root.hidden = false;
      document.body.classList.add("agent-full-open");
      this.view.giveChat(snap);
      this.view.wake();
      this.renderList();
      setTimeout(() => this.view.focus(), 50);
    },
    /** Use leaveFull, which moves the chat back to the layout it came from. */
    close() {
      S.fullOpen = false;
      this.view.audioComposer?.cancel();
      this.root.hidden = true;
      document.body.classList.remove("agent-full-open");
      sidebar.view.wake();
      dock.view.wake();
    },
    renderList() {
      if (!S.fullOpen) return;
      renderThreadList(this.list, {
        currentId: this.view.threadId,
        onPick: (id) => {
          setCurrent(id);
          this.view.setThread(id);
          this.renderList();
          this.view.focus();
        },
        onNew: (anchor) => newThreadMenu(anchor, this.view),
        onNewIn: (scope, settings) => {
          this.view.startDraft(scope, settings);
          this.renderList();
        },
      });
    },
  };

  /* ---------- floating dock ---------- */

  const dock = {
    root: null,
    view: new ChatView("dock"),
    feed: el("div", "dock-feed"),
    handle: null,
    feedLines: new Map(),
    /** When each thread's current run started, for threads whose turn list is not loaded. */
    starts: new Map(),
    /** The page_show call writing a new page in this chat: { itemId, threadId, title }. */
    pageIntent: null,
    pageHint: null,
    mount() {
      const main = document.querySelector(".workspace main");
      if (!main) return;
      const view = this.view;
      const root = el("div", "agent-dock");
      const panel = el("div", "dock-panel");
      // Output: the conversation when expanded, the live step feed when collapsed.
      const out = el("div", "dock-out");
      const history = el("div", "dock-history");
      history.append(view.scroll, view.queueDock);
      out.append(history, this.feed, el("span", "dock-sweep"));
      this.orb = button("", "dock-orb", (event) => view.modelMenu(event.currentTarget));
      const input = el("div", "dock-input");
      this.orbFx = window.scribeOrb?.create(this.orb, input);
      flyout.bind(this.orb, "orb");
      input.append(this.orb, view.composer, view.sendSlot);
      this.status = el("span", "dock-status");
      this.titleBtn = button("", "dock-title", (event) => this.threadMenu(event.currentTarget), "Switch thread", false);
      this.scopeBtn = button("", "dock-scope", (event) => view.scopeMenu(event.currentTarget), SCOPE_CHIP_TITLE);
      const topLeft = el("div", "dock-top-tab dock-top-left");
      topLeft.append(this.status, this.titleBtn);
      const topRight = el("div", "dock-top-tab dock-top-right");
      topRight.append(
        this.scopeBtn,
        el("span", "dock-top-sep"),
        button(icon("list"), "ag-icon-btn small dock-toggle", () => this.setExpanded(!S.dockExpanded), "Show conversation (Ctrl+↑)"),
        button(icon("expand"), "ag-icon-btn small", () => {
          const id = this.view.threadId;
          if (SOLO) {
            if (id) {
              window.scribePopout.request({ type: "open-thread", id });
              window.scribePopout.focusMain();
            }
            return;
          }
          closeMenu();
          const snap = this.view.takeChat();
          if (S.fullOpen) leaveFull("side");
          sidebar.view.closeHelper();
          sidebar.view.giveChat(snap);
          if (id) setCurrent(id);
          if (sidebar.listOpen) sidebar.toggleList();
          sidebar.setOpen(true);
        }, "Open in the sidebar"),
        button(icon("close"), "ag-icon-btn small dock-close", () => this.setShown(false), "Hide (Esc)", false)
      );
      const top = el("div", "dock-top");
      top.append(topLeft, topRight);
      new ResizeObserver(() => this.fitScope()).observe(top);
      const head = el("div", "dock-head");
      head.append(out, top);
      const right = el("div", "dock-bar-right");
      right.append(view.bar);
      const bar = el("div", "dock-bar");
      bar.append(right);
      panel.append(head, input, bar);
      view.helperHost = panel;
      view.helperBackground = [head, input, bar];
      const handle = button("", "dock-handle", () => this.setShown(true), "Agent (Ctrl+K)", false);
      this.handleClock = el("span", "ag-clock dock-handle-clock");
      this.handleText = el("span", "dock-handle-text");
      handle.append(icon("sparkle", "ag-ico dock-handle-ico"), el("span", "dock-dot"), this.handleClock, el("span", "dock-handle-sep"), this.handleText, el("kbd", null, "Ctrl K"));
      this.handle = handle;
      root.append(panel, handle);
      main.append(root);
      this.root = root;
      this.history = history;
      this.view.root = root;
      window.addEventListener("scribe:orb-appearance", () => this.renderSweep());
      this.view.root.addEventListener("click", (event) => onLinkClick(event));
      this.view.root.addEventListener("auxclick", (event) => onLinkClick(event));
      this.view.root.addEventListener("mousedown", preventLinkAutoscroll);
      this.feed.addEventListener("click", () => this.setExpanded(true));
      this.apply();
      document.addEventListener("pointerdown", (event) => this.collapseOutside(event.target), true);
    },
    /** Menus, tips and dialogs from this chat sit on document.body, not inside the dock. */
    owns(node) {
      if (!(node instanceof Node)) return false;
      if (this.root?.contains(node)) return true;
      const el = node.nodeType === 1 ? node : node.parentElement;
      return Boolean(el?.closest?.(".ag-menu, .ag-fly, .ag-fly-peek, .ag-usage-tip, .ag-modal, .ag-settings-dialog, .ag-perm-dialog, .ag-toasts, .pv, .select-menu"));
    },
    /** Collapse the conversation when the pointer leaves the dock; keep the compact composer. */
    collapseOutside(target) {
      if (!S.dockShown || !S.dockExpanded || S.fullOpen) return;
      if (modalStack.length || agentSettings.isOpen() || allowlists.isOpen() || memoryDialog.isOpen() || window.scribePreview?.isOpen?.()) return;
      if (this.owns(target)) return;
      this.setExpanded(false);
    },
    apply() {
      if (!this.root) return;
      this.root.classList.toggle("shown", S.dockShown);
      if (!S.dockShown) this.view.audioComposer?.cancel();
      this.root.classList.toggle("expanded", S.dockShown && S.dockExpanded);
      this.renderHandle();
      this.view.wake();
      requestAnimationFrame(() => this.view.autosize());
    },
    setShown(shown) {
      if (CHAT) return;
      S.dockShown = shown;
      localStorage.setItem(LS.dock, shown ? "1" : "0");
      if (shown) this.syncThread();
      this.apply();
      if (shown) {
        this.bindFeed();
        setTimeout(() => this.view.focus(), 60);
      } else this.view.input.blur();
    },
    setExpanded(expanded) {
      if (!expanded) this.view.closeHelper();
      S.dockExpanded = expanded;
      if (expanded) {
        this.clearFeedLines();
        // Drawn afresh when it opens (apply wakes it), at the bottom.
        this.view.stale = true;
      }
      this.apply();
      if (!expanded) this.bindFeed();
    },
    remember(id) {
      const tab = activeTab();
      if (tab) setDockPick(tab.id, id);
      this.renderTitle();
    },
    /** Keep this conversation on a page it just opened, so syncThread does not start a draft. */
    followThread(threadId, tabId) {
      const t = S.threads.get(threadId);
      if (!t || t.archived) return;
      if (this.view.threadId === threadId || this.draftMatches(t) || !this.view.threadId) {
        setDockPick(tabId, threadId);
        if (activeTab()?.id === tabId) this.syncThread();
      }
    },
    /** The dock follows the active page: its picked thread, else its newest page thread, else a draft. A last AI reply older than two hours starts a new thread. */
    syncThread() {
      if (!this.root) return;
      const tab = activeTab();
      const id = pageDockThreadId(tab?.id || null, tab ? S.dockPicks.get(tab.id) : null, Date.now());
      if (id) {
        if (this.view.threadId !== id) this.view.setThread(id);
      } else {
        const scope = tab ? { kind: "page", ref: tab.id } : { kind: "global", ref: null };
        // Already on this page's new thread: keep it as the user set it up (mode, scope, text).
        if (this.view.threadId || !this.view.draft || this.view.draftTab !== (tab?.id || null)) this.view.startDraft(scope);
      }
      this.renderTitle();
    },
    draftMatches(thread) {
      return !this.view.threadId && this.view.draft && sameScope(this.view.draft.scope, thread.scope);
    },
    renderTitle() {
      if (!this.titleBtn) return;
      const t = this.view.thread();
      const s = this.view.settings();
      this.titleBtn.replaceChildren(icon(t ? "sparkle" : "plus"), el("span", null, t ? t.title : "New thread"), icon("chevron", "ag-ico ag-chev-down"));
      fillScopeDisplay(this.scopeBtn, s.scope, t ? workspaceDir(t) : s.cwd);
      this.scopeBtn.dataset.tooltip = SCOPE_CHIP_TITLE;
      this.fitScope();
      this.orbFx?.setProvider(s.provider);
      this.renderSweep();
      if (this.provider !== s.provider) {
        this.provider = s.provider;
        window.dispatchEvent(new CustomEvent("scribe:dock-provider", { detail: { provider: s.provider } }));
      }
      // Hovering the orb opens the threads flyout, so it has no plain tooltip.
      this.orb.setAttribute("aria-label", `Model: ${modelLabel(s.provider, s.model)}`);
      this.renderHandle();
    },
    /** Use the provider's midtones for the running accent, omitting the brightest highlight. */
    renderSweep() {
      const colors = window.scribeOrb?.colors(this.view.settings().provider);
      if (colors) this.root.style.setProperty("--dock-sweep-palette", `${colors[1]} 30%, ${colors[2]} 70%`);
      else this.root.style.removeProperty("--dock-sweep-palette");
    },
    /** With both a Scribe scope and a workspace, show only the workspace once either name would be cut off. */
    fitScope() {
      const btn = this.scopeBtn;
      if (!btn) return;
      btn.classList.remove("tight");
      if (!btn.querySelector(".ag-scope-main")) return;
      const cut = (node) => node && node.scrollWidth > node.clientWidth + 1;
      if (cut(btn) || cut(btn.querySelector(".ag-scope-text")) || cut(btn.lastElementChild)) btn.classList.add("tight");
    },
    /** When the thread's current run started: its running turn, else when the dock first saw it running. */
    runStart(t) {
      const turn = [...(S.details.get(t.id)?.turns.values() || [])].find((x) => x.status === "running");
      if (turn) return turn.startedAt;
      if (!this.starts.has(t.id)) this.starts.set(t.id, Date.now());
      return this.starts.get(t.id);
    },
    renderHandle() {
      if (!this.handle) return;
      const t = this.view.thread();
      const status = t?.status || "idle";
      if (status === "idle" && t) this.starts.delete(t.id);
      const start = t && status !== "idle" ? this.runStart(t) : null;
      for (const node of [this.handle, this.root]) {
        node?.classList.toggle("busy", status === "running");
        node?.classList.toggle("waiting", status === "waiting");
      }
      this.orbFx?.setBusy(status === "running");
      setClock(this.handleClock, status === "running" ? start : null);
      // Status dot and run time at the start of the bar.
      this.status.className = `dock-status s-${status}`;
      const sig = `${status}:${start || ""}`;
      if (this.status._sig !== sig) {
        this.status._sig = sig;
        this.status.replaceChildren(el("span", "dock-dot"));
        if (start) this.status.append(setClock(el("span", "ag-clock"), start));
      }
      if (status === "running") this.setHandleText(this.live?.text || "Working…", this.live?.key || "working");
      else this.setHandleText(status === "waiting" ? "Needs your answer" : t?.unread && !t.fromPage ? "Reply ready" : "Ask the agent", status);
    },
    /** CSS transitions retarget text mid-swap, retaining the slide and blur of rapid updates. */
    setHandleText(text, key) {
      const box = this.handleText;
      const cur = box.querySelector(".dock-handle-line:not(.out)");
      if (cur && box.dataset.key === key) {
        if (cur.textContent !== text) cur.textContent = text;
        return;
      }
      box.dataset.key = key;
      const next = el("span", "dock-handle-line", text);
      const animate = cur && window.scribeMotion.enabled() && !this.feedQuiet && !S.dockShown && this.handle.classList.contains("busy");
      if (!animate) {
        box.replaceChildren(next);
        return;
      }
      next.classList.add("in");
      box.append(next);
      void next.offsetWidth;
      next.classList.remove("in");
      cur.classList.add("out");
      // Cleanup must also run when the window is hidden and transitions stall.
      setTimeout(() => cur.remove(), 560);
      const outs = box.querySelectorAll(".dock-handle-line.out");
      for (let i = 0; i < outs.length - 2; i++) outs[i].remove();
    },
    /** About 1.75 pills' worth of characters: enough streamed text to fill the pill and cut it at the ellipsis. */
    pillChars() {
      return Math.round(((this.handleText?.clientWidth || 220) / 6.5) * 1.75);
    },
    /** Streamed text waits until it fills the pill, then shows that prefix and stays put, so the pill never
        types along with the model and a swap is never disturbed by deltas. A short reply shows after a pause. */
    queueLive(key, text) {
      if (this.live?.key === key) return;
      const need = this.pillChars();
      if (text.length >= need) {
        this.setLive(key, text.slice(0, need));
        return;
      }
      this.pendingLive = { key, text };
      if (this._liveWaitKey === key) return;
      clearTimeout(this._liveWait);
      this._liveWaitKey = key;
      this._liveWait = setTimeout(() => {
        const p = this.pendingLive;
        if (p?.key === key) this.setLive(key, p.text.slice(0, need) || "Thinking…");
      }, 900);
    },
    setLive(key, text) {
      clearTimeout(this._liveWait);
      this._liveWaitKey = null;
      this.pendingLive = null;
      this.live = { key, text };
      if (this.view.thread()?.status === "running") this.renderHandle();
    },
    threadMenu(anchor) {
      const tab = activeTab();
      // A helper sits under the thread that started it, as in the thread list.
      const threads = [...S.threads.values()].filter((t) => !t.archived && !nestsUnder(t)).sort((a, b) => threadRank(b) - threadRank(a));
      const pageThreads = tab ? threads.filter((t) => t.scope.kind === "page" && t.scope.ref === tab.id) : [];
      const others = threads.filter((t) => !pageThreads.includes(t));
      const items = [];
      const currentId = this.view.threadId;
      const hiddenDirs = hiddenWorkspaceKeys();
      const add = (t, detail) => {
        items.push({ label: t.title, detail, checked: t.id === currentId, searchOnly: t.id !== currentId && inHiddenWorkspace(t, hiddenDirs), run: () => this.pick(t.id) });
        const helpers = helpersOf(t.id).filter((h) => !h.archived);
        // Working ones and the open one always show; of the rest, the latest two. A search finds them all.
        const must = (h) => h.status !== "idle" || h.id === currentId;
        const latest = helpers.filter((h) => !must(h)).slice(-2);
        for (const h of helpers) {
          items.push({ label: helperName(h), detail: `Helper · ${threadWhenText(h)}`, search: t.title, sub: true, searchOnly: !must(h) && !latest.includes(h), checked: h.id === currentId, run: () => this.pick(h.id) });
        }
      };
      items.push({ label: "New thread", fixed: true, icon: "plus", run: () => { if (tab) setDockPick(tab.id, null); this.view.startDraft(tab ? { kind: "page", ref: tab.id } : { kind: "global", ref: null }, {}, true); this.renderTitle(); } });
      if (pageThreads.length) items.push({ header: "This page" });
      for (const t of pageThreads) add(t, threadWhenText(t));
      if (others.length) items.push({ header: "Recent" });
      for (const t of others) add(t, `${scopeLabel(t.scope).text} · ${threadWhenText(t)}`);
      openMenu(anchor, items, { search: true, width: 320, placeholder: "Search all threads", pageSize: 10 });
    },
    pick(id) {
      this.remember(id);
      this.view.setThread(id);
      this.renderTitle();
      // The picker is a popover: closing it drops the focused search field, and focus would
      // land on the title button. Put it in the composer, as the sidebar and full window do.
      if (S.dockShown) setTimeout(() => this.view.focus(), 0);
    },
    /* Collapsed feed is bound to the composer thread: that thread's latest reply, or empty
       when none is selected. Live steps cap at 4 while it runs, then fade once it stops. */
    clearFeedLines() {
      clearTimeout(this._settle);
      for (const node of this.feed.children) node._fade?.cancel();
      this.feed.replaceChildren();
      this.feedLines.clear();
      this.feed.classList.remove("deep");
    },
    /** Drop feed lines and live-handle text so another thread cannot leak into this one. */
    resetFeed() {
      this.clearFeedLines();
      this.live = null;
      this.pendingLive = null;
      clearTimeout(this._liveWait);
      this._liveWaitKey = null;
    },
    /** Clear now and drop any in-flight paint, so a switch never keeps the previous thread's reply. */
    invalidateFeed() {
      this.resetFeed();
      this.feedPainted = null;
      this.feedSeq = (this.feedSeq || 0) + 1;
      this.renderHandle();
    },
    /**
     * Paint the collapsed feed for the thread in the composer, or clear it when there is none.
     * A generation counter drops a paint that started before a later bind (switch, show, collapse).
     */
    bindFeed(force) {
      const id = this.view.threadId || null;
      if (!force && id && this.feedPainted === id && S.dockShown && !S.dockExpanded && this.feed.childElementCount) return;
      this.invalidateFeed();
      const seq = this.feedSeq;
      if (!id || S.dockExpanded || !S.dockShown) return;
      const paint = () => {
        if (seq !== this.feedSeq || this.view.threadId !== id) return;
        this.resetFeed();
        this.paintFeed(id);
        if (S.details.has(id)) this.feedPainted = id;
        this.renderHandle();
      };
      if (S.details.has(id)) paint();
      else ensureDetail(id).then(paint);
    },
    paintFeed(id) {
      const detail = S.details.get(id);
      const t = S.threads.get(id);
      if (!detail || !t) return;
      this.feedQuiet = true;
      try {
        if (t.status === "running") {
          const turn = [...detail.turns.values()].find((x) => x.status === "running");
          if (!turn) return;
          for (const item of detail.items) {
            if (item.turnId === turn.id && !item.parentToolId) this.paintLiveItem(item);
          }
          return;
        }
        const lastText = [...detail.items].reverse().find((it) => it.kind === "text" && !it.parentToolId && String(it.text || "").trim());
        if (lastText) {
          this.line(`${lastText.turnId || lastText.id}:done`, "check", plain(lastText.text).slice(0, 220), { cls: "text done" });
          return;
        }
        const lastTurn = [...detail.turns.values()].sort((a, b) => b.seq - a.seq)[0];
        if (lastTurn?.status === "error") {
          this.line(`${lastTurn.id}:err`, "cross", lastTurn.error || "The turn failed", { cls: "error", keep: true });
        }
      } finally {
        this.feedQuiet = false;
      }
    },
    paintLiveItem(item) {
      const step = liveStep(item);
      if (!step) return;
      const pill = item.kind === "reasoning" || item.kind === "text" ? plain(item.text) : undefined;
      this.line(item.id, item.tool || item.kind, step.text, { cls: step.kind, pill });
    },
    line(key, _icon, text, { cls = "", keep = false, pill } = {}) {
      if (!this.root) return;
      const hold = keep || /\btext\b/.test(cls);
      if (!/\b(done|files|error)\b/.test(cls)) {
        if (pill !== undefined) this.queueLive(key, pill);
        else this.setLive(key, text);
      }
      if (S.dockExpanded || !S.dockShown) return;
      let line = this.feedLines.get(key);
      if (!line) {
        line = el("div", `dock-line ${cls}`);
        line.append(el("span", "dock-dot"), el("span", "dock-line-text"));
        const before = [...this.feed.children];
        this.feed.append(line);
        if (!this.feedQuiet) window.scribeMotion.enter(line);
        this.feedLines.set(key, line);
        if (!this.feedQuiet && window.scribeMotion.enabled()) {
          const lift = line.offsetHeight + 2;
          for (const node of before) if (node.isConnected) window.scribeMotion.animate(node, [{ transform: `translateY(${lift}px)` }, { transform: "none" }], { token: "slow" });
        }
      }
      line.className = `dock-line ${cls}${hold ? " keep" : ""}`;
      line.querySelector(".dock-line-text").textContent = text;
      line._fade?.cancel();
      line.classList.remove("fading");
      if (hold) {
        for (const node of [...this.feed.children]) {
          if (node === line || !node.classList.contains("keep")) continue;
          node.remove();
          for (const [k, v] of this.feedLines) if (v === node) this.feedLines.delete(k);
        }
      }
      while (this.feed.childElementCount > 4) {
        const drop = [...this.feed.children].find((n) => n !== line && !n.classList.contains("keep")) || [...this.feed.children].find((n) => n !== line);
        if (!drop) break;
        drop.remove();
        for (const [k, v] of this.feedLines) if (v === drop) this.feedLines.delete(k);
      }
      this.feed.classList.toggle("deep", this.feed.childElementCount >= 4);
    },
    settleFeed() {
      clearTimeout(this._settle);
      this._settle = setTimeout(() => {
        for (const node of [...this.feed.children]) {
          if (node.classList.contains("keep")) continue;
          node.classList.add("fading");
          node._fade?.cancel();
          const leaving = node._fade = window.scribeMotion.reveal(node, false, { translate: "none", token: "fade", fill: "both" });
          leaving.finished.then(() => {
            node.remove();
            this.feed.classList.toggle("deep", this.feed.childElementCount >= 4);
            for (const [k, v] of this.feedLines) if (v === node) this.feedLines.delete(k);
            leaving.cancel();
          }).catch(() => {});
        }
      }, 1400);
    },
    /** Tell the shell (its creating screen) which new page this chat is writing, or that it stopped. */
    setPageIntent(intent) {
      const prev = this.pageIntent;
      if (!intent && !prev) return;
      if (intent && prev && prev.itemId === intent.itemId && prev.title === intent.title) return;
      this.pageIntent = intent;
      if (intent) this.setPageHint(null);
      window.dispatchEvent(new CustomEvent("scribe:page-intent", { detail: intent }));
    },
    /** The lighter state: this chat's turn may be about to write a new page (the classifier's guess from the message). */
    setPageHint(hint) {
      if (!hint && !this.pageHint) return;
      this.pageHint = hint;
      window.dispatchEvent(new CustomEvent("scribe:page-hint", { detail: hint }));
    },
    /** A hook's page_create signal (pageIntent.ts): a hint from the user's message, or the agent's own word that a page is coming. */
    onIntent(intent) {
      if (intent.name !== "page_create" || !intent.turnId || intent.threadId !== this.view.threadId) return;
      // A classifier answer can come after its turn is over.
      if (S.details.get(intent.threadId)?.turns.get(intent.turnId)?.status !== "running") return;
      if (intent.stage === "hint") {
        if (!this.pageIntent) this.setPageHint({ threadId: intent.threadId, turnId: intent.turnId });
        return;
      }
      if (intent.stage !== "confirmed") return;
      // A page_show call already on screen knows more (its title, whether the page is new).
      if (this.pageIntent && !this.pageIntent.announced) return;
      const title = intent.title || this.pageIntent?.title || "";
      this.setPageIntent({ itemId: `intent:${intent.turnId}`, threadId: intent.threadId, turnId: intent.turnId, title, announced: true });
    },
    onItem(item) {
      const intent = this.pageIntent;
      // Followed by the call, not the thread on show: the chat moves to the new page while it is still being written.
      if (intent?.itemId === item.id || item.threadId === this.view.threadId || (intent?.announced && item.threadId === intent.threadId)) {
        const call = newPageCall(item);
        if (call) this.setPageIntent({ itemId: item.id, threadId: item.threadId, turnId: item.turnId, title: call.title || (intent?.announced ? intent.title : "") });
        else if (intent?.itemId === item.id) this.setPageIntent(null);
        // The announced page has been shown, by a call this chat never saw as a new page (its key was already there by then).
        else if (intent?.announced && item.threadId === intent.threadId && shownPageCall(item)) this.setPageIntent(null);
      }
      if (item.threadId !== this.view.threadId) return;
      if ((item.kind === "approval" || item.kind === "question" || item.kind === "plan") && item.status === "pending") {
        if (!S.dockShown) this.setShown(true);
        this.setExpanded(true);
        return;
      }
      this.paintLiveItem(item);
      this.renderHandle();
    },
    onDelta(item) {
      if (item.threadId !== this.view.threadId) return;
      this.paintLiveItem(item);
    },
    onTurn(turn) {
      if (turn.status !== "running" && turn.threadId === this.pageIntent?.threadId) this.setPageIntent(null);
      if (turn.status !== "running" && turn.threadId === this.pageHint?.threadId) this.setPageHint(null);
      if (turn.threadId !== this.view.threadId) return;
      if (turn.status !== "running") this.live = null;
      this.renderHandle();
      if (turn.status === "running") {
        clearTimeout(this._settle);
        return;
      }
      const detail = S.details.get(turn.threadId);
      const lastText = detail ? [...detail.items].reverse().find((it) => it.turnId === turn.id && it.kind === "text" && !it.parentToolId) : null;
      const files = turn.files || [];
      if (files.length) {
        const added = files.reduce((a, f) => a + f.added, 0);
        const removed = files.reduce((a, f) => a + f.removed, 0);
        this.line(`${turn.id}:files`, "diff", `${files.length} file${files.length === 1 ? "" : "s"} changed  +${added} −${removed}`, { cls: "files", keep: !lastText });
      }
      if (lastText) {
        this.feedLines.get(lastText.id)?.remove();
        this.feedLines.delete(lastText.id);
        this.line(`${turn.id}:done`, "check", plain(lastText.text).slice(0, 220), { cls: "text done" });
      } else if (turn.status === "error") this.line(`${turn.id}:err`, "cross", turn.error || "The turn failed", { cls: "error", keep: true });
      this.settleFeed();
    },
  };

  // The dock's view renders its transcript into the history panel and its composer at the bottom.
  dock.view.renderHeader = () => dock.renderTitle();

  /* ---------- chrome badge ---------- */

  let lastAsks = "";

  function renderBadge() {
    const btn = document.getElementById("agent-toggle");
    if (!btn) return;
    const threads = activeThreads();
    const waiting = threads.some((t) => t.status === "waiting");
    const running = threads.filter((t) => t.status === "running").length;
    const unread = threads.filter((t) => t.unread && !t.archived && !t.fromPage).length;
    btn.classList.toggle("busy", running > 0);
    window.scribeAurora?.setBusy(running > 0);
    window.scribeChromeFx?.setBusy(running > 0);
    btn.classList.toggle("waiting", waiting);
    const badge = document.getElementById("agent-badge");
    if (badge) {
      badge.hidden = !(waiting || unread);
      badge.textContent = waiting ? "!" : unread ? String(unread) : "";
      badge.classList.toggle("warn", waiting);
    }
    dock.renderHandle();
    for (const rowEl of document.querySelectorAll(".tab[data-id], .lib-page[data-id]")) {
      const status = pageStatus(rowEl.dataset.id);
      rowEl.classList.toggle("agent-running", status === "running");
      rowEl.classList.toggle("agent-waiting", status === "waiting");
    }
    const asks = threads
      .filter((t) => t.status === "waiting")
      .map((t) => `${t.id}:${t.asking?.itemId || ""}`)
      .join(",");
    if (asks !== lastAsks) {
      lastAsks = asks;
      window.dispatchEvent(new Event("scribe:agent-status"));
    }
    window.dispatchEvent(new Event("scribe:agent-threads"));
    flyout.render();
    toasts.update();
  }

  /**
   * "waiting" or "running" when a thread for this page is at work, for the tab strip and Library.
   * A page another thread is asking with (page_ask) also shows as waiting.
   */
  function pageStatus(tabId) {
    let status = null;
    for (const t of S.threads.values()) {
      if (t.status === "waiting" && t.asking?.page?.id === tabId) return "waiting";
      if (t.scope.kind !== "page" || t.scope.ref !== tabId || t.status === "idle") continue;
      if (t.status === "waiting") return "waiting";
      status = "running";
    }
    return status;
  }

  /** How many threads (not archived) belong to this page. */
  function pageThreads(tabId) {
    let count = 0;
    for (const t of S.threads.values()) {
      if (!t.archived && t.scope.kind === "page" && t.scope.ref === tabId) count += 1;
    }
    return count;
  }

  /** Questions, approvals and plans the user still has to answer, newest thread first, for the palette. */
  function pendingAsks() {
    const label = { approval: "Approval", question: "Question", plan: "Plan" };
    return [...S.threads.values()]
      .filter((t) => t.status === "waiting" && !t.archived)
      .sort((a, b) => threadRank(b) - threadRank(a))
      .map((t) => ({
        kind: "ask",
        id: `ask:${t.id}`,
        threadId: t.id,
        itemId: t.asking?.itemId || "",
        page: t.asking?.page || null,
        title: t.asking?.title || "Needs your answer",
        snippet: t.title,
        locationLabel: label[t.asking?.kind] || "Waiting",
        location: "ask",
      }));
  }

  /** Open a waiting thread in the sidebar and bring its question into view. */
  function openAsk(threadId, itemId, openForm) {
    if (!openThread(threadId)) return false;
    if (itemId) revealItem(() => (S.fullOpen ? full.view : sidebar.view).root, itemId, openForm);
    return true;
  }

  /** Scrolls to an item once its thread has rendered; openForm also opens a question's form dialog. */
  function revealItem(root, itemId, openForm) {
    let tries = 0;
    const reveal = () => {
      const node = root()?.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`);
      if (!node) {
        if (++tries < 20) setTimeout(reveal, 50);
        return;
      }
      node.scrollIntoView({ block: "center" });
      if (openForm) node.querySelector(".ag-q-open")?.click();
    };
    requestAnimationFrame(reveal);
  }

  /* ---------- activity flyout and needs-you toasts ---------- */

  const FLYOUT_HOLD_MS = 5 * 60 * 1000;
  const FLYOUT_SOFT_CAP = 10;
  const FLYOUT_CAP = 10;
  const TOAST_CAP = 3;
  const FINISH_TOAST_MS = 8000;
  /** Keep in sync with src/agent/flyoutList.ts */
  const flyoutHold = { checkedAt: new Map(), listed: new Set() };
  let flyoutHoldTimer = 0;

  function flyoutLive(t) {
    if (t.archived) return false;
    if (t.status === "waiting" || t.status === "running") return true;
    return t.status === "idle" && t.unread && !t.fromPage;
  }

  /** Stamp checkedAt when an unread idle thread is read. Returns the next expiry, or null. */
  function syncFlyoutHold(threads, now) {
    const known = new Set();
    for (const t of threads) {
      known.add(t.id);
      if (t.archived) {
        flyoutHold.listed.delete(t.id);
        flyoutHold.checkedAt.delete(t.id);
        continue;
      }
      if (flyoutLive(t)) {
        flyoutHold.checkedAt.delete(t.id);
        if (t.status === "idle") flyoutHold.listed.add(t.id);
        else flyoutHold.listed.delete(t.id);
        continue;
      }
      if (flyoutHold.listed.has(t.id)) {
        if (!flyoutHold.checkedAt.has(t.id)) flyoutHold.checkedAt.set(t.id, now);
        flyoutHold.listed.delete(t.id);
      }
    }
    for (const id of [...flyoutHold.listed]) if (!known.has(id)) flyoutHold.listed.delete(id);
    for (const [id, at] of flyoutHold.checkedAt) {
      if (!known.has(id) || now - at >= FLYOUT_HOLD_MS) flyoutHold.checkedAt.delete(id);
    }
    let next = null;
    for (const at of flyoutHold.checkedAt.values()) {
      const until = at + FLYOUT_HOLD_MS;
      if (next == null || until < next) next = until;
    }
    return next;
  }

  /**
   * Waiting, running and unread, plus checked threads held for five minutes.
   * Orb (opens up): checked at the top, newest/running/waiting at the bottom, nearest the pointer.
   * The top-bar button opens down, so that order is reversed.
   */
  function flyoutSnapshot(from) {
    const now = Date.now();
    const threads = activeThreads();
    const next = syncFlyoutHold(threads, now);
    clearTimeout(flyoutHoldTimer);
    if (next != null) flyoutHoldTimer = setTimeout(() => renderBadge(), Math.max(0, next - now) + 30);
    const all = threads.filter((t) => !t.archived).sort((a, b) => threadRank(b) - threadRank(a));
    const live = [
      ...all.filter((t) => t.status === "waiting"),
      ...all.filter((t) => t.status === "running"),
      ...all.filter((t) => t.status === "idle" && t.unread && !t.fromPage),
    ];
    const liveIds = new Set(live.map((t) => t.id));
    let held = all.filter((t) => {
      const at = flyoutHold.checkedAt.get(t.id);
      return !liveIds.has(t.id) && at != null && now - at < FLYOUT_HOLD_MS;
    });
    held.sort((a, b) => (flyoutHold.checkedAt.get(a.id) || 0) - (flyoutHold.checkedAt.get(b.id) || 0));
    if (live.length + held.length > FLYOUT_SOFT_CAP) {
      const room = Math.max(0, FLYOUT_SOFT_CAP - live.length);
      held = [...held].sort((a, b) => (flyoutHold.checkedAt.get(b.id) || 0) - (flyoutHold.checkedAt.get(a.id) || 0)).slice(0, room);
      held.sort((a, b) => (flyoutHold.checkedAt.get(a.id) || 0) - (flyoutHold.checkedAt.get(b.id) || 0));
    }
    const orb = [...held.map((thread) => ({ thread, checked: true })), ...[...live].reverse().map((thread) => ({ thread, checked: false }))];
    const ordered = from === "button" ? [...orb].reverse() : orb;
    const hidden = Math.max(0, ordered.length - FLYOUT_CAP);
    const rows = from === "button" ? ordered.slice(0, FLYOUT_CAP) : ordered.slice(Math.max(0, ordered.length - FLYOUT_CAP));
    return {
      rows,
      hidden,
      waiting: live.filter((t) => t.status === "waiting").length,
      running: live.filter((t) => t.status === "running").length,
      ready: live.filter((t) => t.status === "idle").length,
    };
  }

  /** The thread is open in the dock, the sidebar or the full window. */
  function threadOnScreen(id) {
    return (S.dockShown && dock.view.threadId === id) || (S.sideOpen && sidebar.view.threadId === id) || (S.fullOpen && full.view.threadId === id);
  }

  /** Allow / Deny for a waiting approval, through the same route as the transcript card. */
  function approvalButtons(t, onDone) {
    const ask = t.asking;
    const options = ask?.kind === "approval" ? ask.options || [] : [];
    const allow = options.find((o) => o.kind === "allow_once") || options.find((o) => o.kind.startsWith("allow"));
    const deny = options.find((o) => o.kind === "reject_once") || options.find((o) => o.kind.startsWith("reject"));
    const box = el("span", "ag-act-btns");
    if (!allow || !deny) return box;
    for (const [opt, label, cls] of [[allow, "Allow", " primary"], [deny, "Deny", " danger"]]) {
      box.append(
        button(label, `ag-btn tiny${cls}`, async (event) => {
          event.stopPropagation();
          for (const b of box.querySelectorAll("button")) b.disabled = true;
          try {
            await api("POST", `/approvals/${encodeURIComponent(ask.itemId)}`, { optionId: opt.id });
            onDone?.();
          } catch (err) {
            notice(err.message);
            for (const b of box.querySelectorAll("button")) b.disabled = false;
          }
        }, opt.label)
      );
    }
    return box;
  }

  /** One line on what the thread is doing, for flyout rows. */
  function activityLine(t) {
    if (t.status === "waiting") {
      const kind = { approval: "Approve", question: "Question", plan: "Plan" }[t.asking?.kind] || "Waiting";
      return t.asking ? `${kind}: ${t.asking.title}` : "Needs your answer";
    }
    return t.activity?.line || (t.status === "running" ? "Working…" : "Reply ready");
  }

  /**
   * Hover the island orb or the top-bar agent button: waiting, running and unread threads,
   * plus recently checked ones (dim, no status dot) for five minutes.
   * Right-click opens the same list at once, without the hover delay.
   * The anchor, the panel and its peek are one hover group, so the pointer can move onto the list.
   */
  const flyout = {
    node: null,
    peek: null,
    anchor: null,
    from: null,
    showTimer: 0,
    hideTimer: 0,
    peekTimer: 0,
    peekId: null,
    bind(anchor, from) {
      const showNow = () => {
        clearTimeout(this.hideTimer);
        clearTimeout(this.showTimer);
        if (this.node && this.anchor === anchor) return;
        this.open(anchor, from);
      };
      anchor.addEventListener("pointerenter", (event) => {
        if (event.pointerType !== "mouse" || event.buttons) return;
        clearTimeout(this.hideTimer);
        if (this.node && this.anchor === anchor) return;
        clearTimeout(this.showTimer);
        this.showTimer = setTimeout(() => this.open(anchor, from), 180);
      });
      anchor.addEventListener("pointerleave", () => {
        clearTimeout(this.showTimer);
        this.hideSoon();
      });
      // A left click keeps its own job (model menu, sidebar). Right-click opens the list at once.
      anchor.addEventListener("pointerdown", (event) => {
        if (event.button === 2) {
          showNow();
          return;
        }
        if (event.button !== 0) return;
        clearTimeout(this.showTimer);
        this.close();
      });
      anchor.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showNow();
      });
    },
    hold(node) {
      node.addEventListener("pointerenter", () => clearTimeout(this.hideTimer));
      node.addEventListener("pointerleave", () => this.hideSoon());
    },
    hideSoon() {
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => this.close(), 200);
    },
    open(anchor, from) {
      if (openMenuEl || !anchor.isConnected || anchor.offsetParent === null) return;
      if (!flyoutSnapshot(from).rows.length) return;
      this.close();
      this.anchor = anchor;
      this.from = from;
      // Keep the plain tip out of the flyout.
      anchor.dataset.flyTitle = anchor.dataset.tooltip;
      anchor.removeAttribute("data-tooltip");
      hideHoverTip();
      this.node = el("div", `ag-fly from-${from}`);
      this.hold(this.node);
      document.body.append(this.node);
      this.render();
    },
    close() {
      clearTimeout(this.hideTimer);
      clearTimeout(this.peekTimer);
      this.node?.remove();
      this.peek?.remove();
      this.node = this.peek = this.peekId = this.sig = null;
      if (this.anchor && this.anchor.dataset.flyTitle !== undefined) {
        this.anchor.dataset.tooltip = this.anchor.dataset.flyTitle;
        delete this.anchor.dataset.flyTitle;
      }
      this.anchor = null;
    },
    render() {
      if (!this.node) return;
      const { rows, hidden, waiting, running, ready } = flyoutSnapshot(this.from);
      if (!rows.length) return this.close();
      // Running threads resend every second or so; rebuild only when a row would change.
      const sig = JSON.stringify(rows.map((r) => [r.thread.id, r.checked, r.thread.status, r.thread.title, activityLine(r.thread), r.thread.activity?.lastText, r.thread.asking?.detail]).concat(hidden, waiting, running, ready));
      if (sig === this.sig && this.node.childElementCount) return;
      this.sig = sig;
      const counts = [];
      if (waiting) counts.push(`${waiting} need${waiting === 1 ? "s" : ""} you`);
      if (running) counts.push(`${running} running`);
      if (ready) counts.push(`${ready} ready`);
      const head = el("div", "ag-fly-head");
      head.append(el("b", null, "Active"), el("span", null, counts.join(" · ")));
      this.node.replaceChildren(head);
      for (const entry of rows) this.node.append(this.row(entry));
      if (hidden && !SOLO) {
        this.node.append(
          button(`+${hidden} in the sidebar`, "ag-fly-more", () => {
            this.close();
            sidebar.setOpen(true);
            if (!sidebar.listOpen) sidebar.toggleList();
          })
        );
      }
      this.place();
      if (this.peekId) {
        const t = S.threads.get(this.peekId);
        const rowEl = this.node.querySelector(`[data-thread="${CSS.escape(this.peekId)}"]`);
        if (t && rowEl) this.showPeek(t, rowEl);
        else this.hidePeek();
      }
    },
    row(entry) {
      const t = entry.thread;
      const row = el("div", `ag-fly-row s-${entry.checked ? "checked" : t.status}`);
      row.dataset.thread = t.id;
      row.tabIndex = 0;
      row.role = "button";
      const meta = el("span", "ag-fly-meta");
      meta.append(el("span", "ag-fly-title", t.title), el("span", "ag-fly-line", activityLine(t)));
      row.append(el("span", entry.checked ? "ag-dot" : `ag-dot s-${t.status === "idle" ? "ready" : t.status}`), meta);
      if (t.status === "waiting" && t.asking?.kind === "approval") row.append(approvalButtons(t));
      else if (t.status === "waiting") {
        row.append(
          button("Open", "ag-btn tiny", (event) => {
            event.stopPropagation();
            this.go(t);
          })
        );
      }
      row.addEventListener("click", () => this.go(t));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter") this.go(t);
      });
      row.addEventListener("pointerenter", () => {
        clearTimeout(this.peekTimer);
        this.peekTimer = setTimeout(() => this.showPeek(S.threads.get(t.id) || t, row), this.peek ? 60 : 220);
      });
      return row;
    },
    /** Row click: the island orb switches the dock to it; the agent button too while the dock is up, else the sidebar. */
    go(t) {
      const inDock = this.from === "orb" || S.dockShown;
      this.close();
      openActive(t, inDock);
    },
    showPeek(t, rowEl) {
      if (!this.node) return;
      this.peekId = t.id;
      for (const r of this.node.querySelectorAll(".ag-fly-row")) r.classList.toggle("on", r === rowEl);
      const peek = el("div", "ag-fly-peek");
      const state = rowEl.classList.contains("s-checked") ? "Seen" : t.status === "waiting" ? "Waiting" : t.status === "running" ? "Running" : "Reply ready";
      peek.append(el("p", "ag-fly-peek-head", `${state} · ${t.title}`));
      if (t.status === "waiting" && t.asking) {
        peek.append(el("p", "ag-fly-peek-title", t.asking.title));
        if (t.asking.detail) peek.append(el("pre", "ag-pre small", t.asking.detail));
      } else if (t.status === "running" && t.activity?.line) {
        peek.append(el("p", "ag-fly-peek-title", t.activity.line));
      }
      if (t.activity?.lastText) peek.append(el("p", "ag-fly-peek-quote", t.activity.lastText));
      if (t.status === "waiting" && t.asking?.kind === "approval") peek.append(approvalButtons(t));
      this.hold(peek);
      this.peek?.remove();
      this.peek = peek;
      document.body.append(peek);
      // Beside the panel, level with the row; on the other side when there is no room.
      const box = this.node.getBoundingClientRect();
      const r = rowEl.getBoundingClientRect();
      const w = Math.min(300, window.innerWidth - 16);
      peek.style.width = `${w}px`;
      let left = box.right + 8;
      if (left + w > window.innerWidth - 8) left = box.left - w - 8;
      const top = Math.min(r.top, window.innerHeight - peek.offsetHeight - 8);
      peek.style.left = `${Math.max(8, left)}px`;
      peek.style.top = `${Math.max(8, top)}px`;
    },
    hidePeek() {
      this.peek?.remove();
      this.peek = this.peekId = null;
    },
    place() {
      const rect = this.anchor.getBoundingClientRect();
      const w = Math.min(340, window.innerWidth - 16);
      this.node.style.width = `${w}px`;
      if (this.from === "orb") {
        this.node.style.left = `${Math.min(Math.max(8, rect.left - 8), window.innerWidth - w - 8)}px`;
        this.node.style.bottom = `${window.innerHeight - rect.top + 10}px`;
      } else {
        this.node.style.left = `${Math.min(Math.max(8, rect.right - w), window.innerWidth - w - 8)}px`;
        this.node.style.top = `${rect.bottom + 8}px`;
      }
    },
    /** From a toast's "+N more": at the orb while the floating chat is up, else at the agent button. */
    openAnywhere() {
      if (S.dockShown && dock.orb) this.open(dock.orb, "orb");
      else {
        const btn = document.getElementById("agent-toggle");
        if (btn) this.open(btn, "button");
      }
    },
  };

  /** Open a thread from the flyout or a toast: in the dock (expanded), else in the sidebar at its question. */
  function openActive(t, inDock) {
    const ask = t.status === "waiting" && t.asking ? t.asking : null;
    if (inDock) {
      showPageThread(t.id, "dock", { reveal: true });
      dock.setExpanded(true);
      if (ask?.form) revealItem(() => dock.view.root, ask.itemId, true);
    } else if (ask) openAsk(t.id, ask.itemId, ask.form);
    else openThread(t.id);
  }

  /**
   * Needs-you toasts: a thread starts waiting, or a user-level thread finishes, while it is not on
   * screen. × snoozes that request (or that finish); a new request toasts again.
   */
  const toasts = {
    box: null,
    shown: new Map(),
    snoozed: new Set(),
    seen: new Map(),
    mount() {
      const main = document.querySelector(".workspace main");
      if (!main) return;
      this.box = el("div", "ag-toasts");
      main.append(this.box);
    },
    update() {
      if (!this.box) return;
      const live = new Set();
      for (const t of S.threads.values()) {
        const prev = this.seen.get(t.id);
        const ask = t.status === "waiting" && t.asking ? t.asking.itemId : null;
        this.seen.set(t.id, { ask, finishedAt: t.finishedAt || 0 });
        if (t.archived) continue;
        // Threads seen for the first time (the list loading) do not toast.
        if (ask) {
          const key = `ask:${ask}`;
          live.add(key);
          if (prev && prev.ask !== ask && !threadOnScreen(t.id) && !this.snoozed.has(key)) this.add(key, t, "ask");
        }
        if (t.status === "idle" && t.unread && !t.fromPage && t.finishedAt) {
          const key = `fin:${t.id}:${t.finishedAt}`;
          live.add(key);
          if (prev && prev.finishedAt !== t.finishedAt && !threadOnScreen(t.id)) this.add(key, t, "finish");
        }
      }
      for (const id of this.seen.keys()) if (!S.threads.has(id)) this.seen.delete(id);
      // Answered, opened or gone: drop its toast. A snooze ends with its request.
      for (const [key, entry] of this.shown) {
        if (!live.has(key) || threadOnScreen(entry.threadId)) this.drop(key);
      }
      for (const key of this.snoozed) if (!live.has(key)) this.snoozed.delete(key);
      if (this.signature() !== this.sig) this.render();
    },
    add(key, t, kind) {
      if (this.shown.has(key)) return;
      const entry = { key, threadId: t.id, kind, at: Date.now() };
      if (kind === "finish") entry.timer = setTimeout(() => this.remove(key), FINISH_TOAST_MS);
      this.shown.set(key, entry);
    },
    drop(key) {
      clearTimeout(this.shown.get(key)?.timer);
      this.shown.delete(key);
    },
    remove(key) {
      if (!this.shown.has(key)) return;
      this.drop(key);
      this.render();
    },
    /** What the toasts show; the thread list resends running threads often, and most resends change nothing here. */
    signature() {
      return JSON.stringify(
        [...this.shown.values()].map((e) => {
          const t = S.threads.get(e.threadId);
          return [e.key, t?.title, t?.asking?.title, t?.activity?.lastText];
        })
      );
    },
    dismiss(key) {
      if (key.startsWith("ask:")) this.snoozed.add(key);
      this.remove(key);
    },
    /** The daily stale worktrees reminder (#686): not a thread's, so kept apart from shown. */
    stale: 0,
    showStale(count) {
      this.stale = count;
      this.render();
    },
    hideStale() {
      if (!this.stale) return;
      this.stale = 0;
      this.render();
    },
    staleToast() {
      const node = el("div", "ag-toast k-stale");
      const body = elWith("div", "ag-toast-body", el("b", null, `${this.stale} stale worktree${this.stale === 1 ? "" : "s"}`), el("span", "ag-toast-text", "With changes and no turns for over 2 days."));
      const open = () => void staleWorktrees.open();
      body.append(elWith("div", "ag-toast-actions", button("Review", "ag-btn tiny", open)));
      node.addEventListener("click", (event) => {
        if (!event.target.closest("button, a")) open();
      });
      node.append(el("span", "ag-dot s-waiting"), body, button(icon("close"), "ag-icon-btn small ag-toast-x", () => this.hideStale(), "Dismiss"));
      return node;
    },
    render() {
      if (!this.box) return;
      this.sig = this.signature();
      // Waiting before finished, newest first.
      const entries = [...this.shown.values()].sort((a, b) => (a.kind === b.kind ? b.at - a.at : a.kind === "ask" ? -1 : 1));
      this.box.replaceChildren();
      if (this.stale) this.box.append(this.staleToast());
      for (const entry of entries.slice(0, TOAST_CAP)) {
        const t = S.threads.get(entry.threadId);
        if (t) this.box.append(this.toast(entry, t));
      }
      if (entries.length > TOAST_CAP) {
        this.box.append(button(`+${entries.length - TOAST_CAP} more`, "ag-toast-more", () => flyout.openAnywhere()));
      }
    },
    toast(entry, t) {
      const node = el("div", `ag-toast k-${entry.kind}`);
      const body = el("div", "ag-toast-body");
      const title = el("b", null, t.title);
      const actions = el("div", "ag-toast-actions");
      if (entry.kind === "ask") {
        const what = { approval: "wants to:", question: "asks:", plan: "has a plan:" }[t.asking?.kind] || "needs you";
        body.append(title, ` ${what} `, el("span", "ag-toast-what", t.asking?.title || ""));
        if (t.asking?.detail) body.append(el("code", "ag-toast-detail", t.asking.detail));
        if (t.asking?.kind === "approval") actions.append(approvalButtons(t, () => this.remove(entry.key)));
      } else {
        body.append(title, " finished");
        if (t.activity?.lastText) body.append(el("span", "ag-toast-text", t.activity.lastText));
      }
      const open = () => {
        this.remove(entry.key);
        openActive(t, S.dockShown);
      };
      actions.append(button(entry.kind === "ask" && t.asking?.form ? "Answer" : "Open", "ag-btn tiny", open));
      body.append(actions);
      // A click anywhere else on the toast does what Open does: the thread, or a question's form.
      node.addEventListener("click", (event) => {
        if (!event.target.closest("button, a, input, textarea, select")) open();
      });
      node.append(
        el("span", `ag-dot s-${entry.kind === "ask" ? "waiting" : "ready"}`),
        body,
        button(icon("close"), "ag-icon-btn small ag-toast-x", () => this.dismiss(entry.key), entry.kind === "ask" ? "Dismiss for now (it stays in the orb's list)" : "Dismiss")
      );
      return node;
    },
  };

  /* ---------- stale worktrees (#686) ---------- */

  const STALE_CHECK_MS = 3 * 60 * 60 * 1000;

  /** el with children. */
  function elWith(tag, cls, ...kids) {
    const node = el(tag, cls);
    node.append(...kids);
    return node;
  }

  const staleWorktrees = {
    timer: null,
    /** Asks the daemon about once a day per Scribe (not per window) whether to bring them up. */
    start() {
      if (this.timer) return;
      const check = () => this.check(true);
      this.timer = setInterval(check, STALE_CHECK_MS);
      setTimeout(check, 60 * 1000);
    },
    async check(remind) {
      try {
        const res = await api("GET", `/worktrees/stale${remind ? "?remind=1" : ""}`);
        if (res.remind) toasts.showStale(res.worktrees.length);
        return res.worktrees;
      } catch {
        return null;
      }
    },
    async open() {
      toasts.hideStale();
      const { panel, close } = modal("ag-stale");
      const list = el("div", "ag-stale-list");
      panel.append(
        elWith("div", "ag-stale-head", el("h2", "ag-modal-title", "Stale worktrees"), el("span", "ag-grow"), button(icon("close"), "ag-icon-btn", () => close(), "Close (Esc)", false)),
        el("p", "ag-modal-hint", "Worktrees with changes that have had no turns for over 2 days."),
        list
      );
      const render = async () => {
        const items = await this.check(false);
        if (!panel.isConnected) return;
        list.replaceChildren();
        if (!items) return list.append(el("p", "ag-stale-empty", "Could not load the worktrees."));
        if (!items.length) return list.append(el("p", "ag-stale-empty", "No stale worktrees."));
        const groups = new Map();
        for (const w of items) groups.set(w.home, [...(groups.get(w.home) || []), w]);
        for (const [home, rows] of groups) {
          const group = el("section", "ag-stale-group");
          group.append(elWith("h3", "ag-stale-ws", el("span", null, home.split(/[\\/]/).filter(Boolean).pop() || home), el("span", "ag-stale-path", home)));
          for (const w of rows) {
            const state = [w.ahead ? `${w.ahead} commit${w.ahead === 1 ? "" : "s"}` : "", w.dirty ? "uncommitted changes" : ""].filter(Boolean).join(", ");
            const row = el("div", "ag-stale-row");
            const info = elWith("div", "ag-stale-info", el("b", null, w.title), el("span", "ag-stale-meta", `${w.branch} · ${state} · last used ${R.timeAgo(w.usedAt)} ago`));
            const done = async (how) => {
              if (await finishThreadWorktree(w.threadId, w, how)) void render();
            };
            const actions = elWith(
              "div",
              "ag-stale-actions",
              button("Changes", "ag-btn tiny", () => openDiff({ kind: "git", threadId: w.threadId })),
              button("Open thread", "ag-btn tiny", () => {
                close();
                openThread(w.threadId);
              }),
              button(w.base ? `Merge into ${w.base}` : "Merge", "ag-btn tiny", () => done("merge")),
              button("Delete", "ag-btn tiny danger", () => done("discard"))
            );
            if (!w.base) actions.children[2].disabled = true;
            row.append(info, actions);
            group.append(row);
          }
          list.append(group);
        }
      };
      list.append(el("p", "ag-stale-empty", "Loading…"));
      await render();
    },
  };

  function views() {
    const roots = [sidebar.view, full.view, dock.view];
    return roots.flatMap((view) => view.helperView?.root.isConnected ? [view, view.helperView] : [view]);
  }

  function renderLists() {
    sidebar.renderList();
    full.renderList();
  }

  function renderAll(scope = "all") {
    for (const view of views()) {
      if (view.threadId && !S.threads.has(view.threadId)) {
        view.threadId = null;
      }
      if (scope === "all") view.renderAll();
      else view.renderChrome();
    }
    dock.renderTitle();
    renderLists();
    renderBadge();
  }

  /** The widest scope asked for since the last frame: "all", or "chrome" (everything but the transcripts). */
  let renderScope = null;

  /**
   * Draw the chat views and lists again on the next frame, once however many settings changes, reloads and
   * reconnects asked for it. "chrome" leaves the transcripts as they are, for changes they do not show.
   */
  function requestRender(scope = "all") {
    const queued = renderScope;
    renderScope = queued === "all" || scope === "all" ? "all" : "chrome";
    if (queued) return;
    requestAnimationFrame(() => {
      const next = renderScope;
      renderScope = null;
      renderAll(next);
    });
  }

  /* ---------- favourite models and cycling ---------- */

  function modelKey(provider, id) {
    return `${provider}:${id}`;
  }

  function favoriteModels() {
    const list = prefs().favoriteModels;
    return Array.isArray(list) ? list : [];
  }

  async function setFavorite(provider, id, on) {
    const key = modelKey(provider, id);
    const list = favoriteModels().filter((k) => k !== key);
    if (on) list.push(key);
    S.config.prefs = { ...prefs(), favoriteModels: list };
    try {
      S.config.prefs = await api("PUT", "/prefs", { favoriteModels: list });
    } catch (err) {
      notice(err.message);
    }
  }

  /** The chat a cycling shortcut applies to: the one in focus, else the most prominent one open. */
  function targetView() {
    if (S.fullOpen) return full.view;
    if (S.dockShown && (focusedChat() === "dock" || !S.sideOpen)) return dock.view;
    if (S.sideOpen) return sidebar.view;
    return dock.view;
  }

  /** Latest non-favourite model per chat, kept in that chat's cycle until another replaces it. */
  const cycleExtras = new Map();

  async function cycleModel() {
    const view = targetView();
    const s = view.settings();
    const t = view.thread();
    // A thread with messages keeps its provider, so only that provider's favourites apply.
    const locked = Boolean(t && t.stats.turns > 0);
    const usable = (f) => providerAvailable(f.provider) && modelInfo(f.provider, f.id) && (!locked || f.provider === s.provider);
    const candidates = new Set(favoriteModels());
    const current = modelKey(s.provider, s.model);
    const chatKey = view.threadId || `draft:${view.variant}`;
    if (!candidates.has(current)) cycleExtras.set(chatKey, { provider: s.provider, id: s.model });
    const extra = cycleExtras.get(chatKey);
    if (extra && usable(extra)) candidates.add(modelKey(extra.provider, extra.id));
    // Use the picker's provider, model and Native source order, regardless of when stars were added.
    const list = PROVIDERS.flatMap((provider) => {
      const models = modelsOf(provider).filter((m) => candidates.has(modelKey(provider, m.id)) && usable({ provider, id: m.id }));
      return modelMenuItems(provider, models, (m) => ({ provider, id: m.id })).filter((item) => !item.header);
    });
    if (list.length < 2) {
      notice(favoriteModels().length ? "Star another model to cycle between them" : "Star models in the model picker to cycle them with Ctrl+'");
      return;
    }
    const at = list.findIndex((f) => modelKey(f.provider, f.id) === current);
    const next = list[(at + 1) % list.length];
    await view.updateSettings(next.provider === s.provider ? { model: next.id } : { provider: next.provider, model: next.id });
    notice(`Model: ${modelInfo(next.provider, next.id)?.label || next.id}`);
  }

  async function cycleEffort() {
    const view = targetView();
    const s = view.settings();
    const info = modelInfo(s.provider, s.model);
    if (!info?.efforts?.length) {
      notice(`${info?.label || s.model} has no reasoning levels`);
      return;
    }
    const levels = [null, ...info.efforts.map((e) => e.id)];
    const next = levels[(levels.indexOf(s.effort ?? null) + 1) % levels.length];
    await view.updateSettings({ effort: next });
    const label = next ? info.efforts.find((e) => e.id === next)?.label || next : `Default${info.defaultEffort ? ` (${info.efforts.find((e) => e.id === info.defaultEffort)?.label || info.defaultEffort})` : ""}`;
    notice(`Reasoning: ${label}`);
  }

  function applyButton() {
    const btn = document.getElementById("agent-toggle");
    if (btn) btn.hidden = localStorage.getItem(LS.button) === "0";
  }

  /* ---------- plan usage ---------- */

  function usageLevel(utilization) {
    return utilization >= 0.9 ? "high" : utilization >= 0.75 ? "warn" : "ok";
  }

  function percent(utilization) {
    return `${Math.round(utilization * 100)}%`;
  }

  function planPct(used) {
    const p = used * 100;
    if (p < 0.1) return "<0.1%";
    if (p < 1) return `${p.toFixed(1)}%`;
    return `${Math.round(p)}%`;
  }

  function planWindowShort(w) {
    if (w.id === "five_hour") return "5h";
    if (w.id === "seven_day") return "wk";
    if (w.id === "seven_day_opus") return "wk Opus";
    if (w.id === "seven_day_sonnet") return "wk Sonnet";
    if (w.id === "seven_day_overage_included") return "wk extra";
    if (w.id === "overage") return "extra";
    if (w.id === "cursor_auto") return "auto";
    if (w.id === "cursor_api") return "api";
    if (w.id === "cursor_on_demand") return "on-demand";
    return w.label;
  }

  /** "in 2 h 10 min" / "Sat 10:00" for a window's reset time. */
  function resetText(at) {
    if (!at) return "";
    const ms = at - Date.now();
    if (ms <= 0) return "";
    if (ms < 24 * 3600 * 1000) {
      const h = Math.floor(ms / 3600000);
      const m = Math.round((ms % 3600000) / 60000);
      return `resets in ${h ? `${h} h ` : ""}${m} min`;
    }
    return `resets ${new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
  }

  function liveWindows(windows) {
    const now = Date.now();
    return (windows || []).map((w) => (w.resetsAt && w.resetsAt <= now ? { ...w, utilization: 0 } : w));
  }

  function planLimits(provider, thread = null) {
    const limits = provider === "claude" && thread ? thread.claudeLimits : S.config.limits?.[provider];
    if (!limits) return null;
    return { ...limits, windows: provider === "codex" || provider === "claude" ? limits.windows || [] : liveWindows(limits.windows) };
  }

  function claudeSourceLabel(source) {
    const s = source || {};
    const backend = s.apiProvider === "firstParty" ? "Anthropic" : s.apiProvider || "Backend unknown";
    const auth = s.apiKeySource && s.apiKeySource !== "none" ? `API key (${s.apiKeySource})` :
      s.tokenSource && s.tokenSource !== "none" ? `Token (${s.tokenSource})` : "Auth source unknown";
    return [backend, auth, s.email, s.organization, s.subscriptionType].filter(Boolean).join(" · ");
  }

  function claudeQuotaNotes(limits) {
    const notes = [];
    if (limits.availability === "unavailable") notes.push(limits.detail || "Claude quota unavailable");
    if (Date.now() - limits.at > 5 * 60_000) notes.push("Quota snapshot is stale");
    const e = limits.extraUsage;
    if (e && (e.usedCredits !== undefined || e.monthlyLimit !== undefined)) {
      const amount = (n) => {
        if (!e.currency) return `${n} minor units (currency unavailable)`;
        try {
          const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency: e.currency });
          const digits = formatter.resolvedOptions().maximumFractionDigits;
          return formatter.format(n / 10 ** digits);
        } catch { return `${n} minor units (${e.currency})`; }
      };
      if (e.usedCredits !== undefined) notes.push(`Billing-period spend: ${amount(e.usedCredits)}${e.monthlyLimit !== undefined ? ` / ${amount(e.monthlyLimit)} cap` : ""}`);
      else notes.push(`Billing-period cap: ${amount(e.monthlyLimit)}`);
      if (e.at && Date.now() - e.at > 5 * 60_000) notes.push(`Extra-usage snapshot is stale · reported ${R.timeAgo(e.at)}`);
    }
    if (limits.overage && limits.overageAt && Date.now() - limits.overageAt <= 5 * 60_000) {
      notes.push("Last request: using subscription extra usage");
    }
    return notes;
  }

  function quotaPercent(provider, utilization) {
    return percent(utilization);
  }

  function quotaReset(provider, at) {
    return at && at <= Date.now() ? "Reset passed · awaiting update" : resetText(at);
  }

  function codexQuotaNotes(limits) {
    if (limits.detail) return [limits.detail];
    const notes = [];
    if (limits.ordinaryUsageAllowed === false) notes.push("Included usage is blocked. Workers wait for Codex to confirm recovery.");
    else if (limits.ordinaryUsageAllowed == null) notes.push("Included usage permission is unavailable. Worker recovery needs confirmation from Codex.");
    for (const bucket of limits.buckets || []) {
      const c = bucket.credits;
      if (c && (c.unlimited || (c.balance != null ? Number(c.balance) > 0 : c.hasCredits))) {
        notes.push(`${bucket.label}: ${c.unlimited ? "unlimited credits" : c.balance != null ? `${c.balance} credits` : "credits available"}`);
      }
    }
    return notes;
  }

  let usageTick = 0;

  function refreshUsageUi() {
    for (const view of views()) view.renderComposerBar();
    agentSettings.renderUsage();
    pageLimitsChanged();
  }

  function soonestFutureReset(limits) {
    const now = Date.now();
    let next = null;
    for (const entry of Object.values(limits || {})) {
      for (const w of entry?.windows || []) {
        if (typeof w.resetsAt === "number" && w.resetsAt > now && (next == null || w.resetsAt < next)) next = w.resetsAt;
      }
    }
    return next;
  }

  function armUsageTick() {
    clearTimeout(usageTick);
    const next = soonestFutureReset(S.config?.limits);
    if (next == null) return;
    usageTick = setTimeout(() => {
      refreshUsageUi();
      armUsageTick();
    }, Math.min(Math.max(50, next - Date.now()), 24 * 3600 * 1000));
  }

  let hoverTipEl = null;
  let hoverTipTimer = 0;
  window.addEventListener("scribe-tooltip-show", hideHoverTip);

  function hideHoverTip() {
    clearTimeout(hoverTipTimer);
    hoverTipEl?.remove();
    hoverTipEl = null;
  }

  /** `start`: the tip's left edge at the anchor's, for a small anchor at the start of a line; otherwise its right edges. */
  function placeHoverTip(anchor, tip, width = 280, start = false) {
    window.scribeTooltip?.hide();
    hideHoverTip();
    document.body.append(tip);
    const rect = anchor.getBoundingClientRect();
    const tw = Math.min(width, window.innerWidth - 16);
    tip.style.width = `${tw}px`;
    let top = rect.top - tip.offsetHeight - 8;
    if (top < 8) top = rect.bottom + 8;
    const left = Math.min(Math.max(8, start ? rect.left : rect.right - tw), window.innerWidth - tw - 8);
    tip.style.top = `${Math.max(8, top)}px`;
    tip.style.left = `${left}px`;
    hoverTipEl = tip;
  }

  function bindHoverTip(anchor, build, { delay = 320, start = false } = {}) {
    anchor.dataset.richTooltip = "";
    anchor.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse") return;
      clearTimeout(hoverTipTimer);
      hoverTipTimer = setTimeout(() => {
        const node = build();
        if (node) placeHoverTip(anchor, node, 280, start);
      }, delay);
    });
    anchor.addEventListener("pointerleave", () => {
      clearTimeout(hoverTipTimer);
      hoverTipTimer = setTimeout(hideHoverTip, 120);
    });
    anchor.addEventListener("pointerdown", hideHoverTip);
  }

  function worktreePendingTip(on) {
    const tip = el("div", "ag-usage-tip ag-wt-tip");
    tip.append(el("div", "ag-usage-tip-title", "Worktree"));
    tip.append(
      el(
        "div",
        "ag-usage-tip-note",
        on ? "New git worktree on a branch of its own, made on the first message. Click to turn off." : "Works in the folder. Click to use a new git worktree instead."
      )
    );
    return tip;
  }

  function worktreeTip(wt) {
    const tip = el("div", "ag-usage-tip ag-wt-tip");
    tip.append(el("div", "ag-usage-tip-title", wt.branch));
    const rows = el("dl", "ag-wt-tip-rows");
    const add = (label, value, cls) => {
      rows.append(el("dt", null, label), el("dd", cls, value));
    };
    add("From", wt.base || "detached HEAD");
    const state = [wt.ahead ? `${wt.ahead} commit${wt.ahead === 1 ? "" : "s"} ahead` : "No new commits"];
    if (wt.dirty) state.push("uncommitted changes");
    add("State", state.join(" · "));
    add("Path", wt.path, "ag-wt-tip-path");
    if (wt.links?.length) add("Linked", wt.links.join(", "));
    tip.append(rows);
    return tip;
  }

  function hideUsageTip() {
    hideHoverTip();
  }

  function usageTip(provider, thread = null) {
    const limits = planLimits(provider, thread);
    if (!limits) return null;
    const tip = el("div", "ag-usage-tip");
    tip.append(el("div", "ag-usage-tip-title", `${PROVIDER_LABEL[provider] || provider} plan usage`));
    for (const w of detailWindows(limits)) {
      const row = el("div", `ag-usage-tip-row lvl-${usageLevel(w.utilization)}`);
      const bar = el("div", "ag-meter-bar");
      const fill = el("div", "ag-meter-fill");
      fill.style.width = `${Math.min(100, Math.round(w.utilization * 100))}%`;
      bar.append(fill);
      row.append(el("span", "ag-usage-tip-label", w.label), bar, el("span", "ag-usage-tip-pct", quotaPercent(provider, w.utilization)));
      if (w.resetsAt) row.append(el("span", "ag-usage-tip-reset", quotaReset(provider, w.resetsAt)));
      tip.append(row);
    }
    if (provider === "claude") for (const note of claudeQuotaNotes(limits)) tip.append(el("div", "ag-usage-tip-note", note));
    else if (limits.overage) tip.append(el("div", "ag-usage-tip-note", "Using extra usage"));
    if (provider === "codex") for (const note of codexQuotaNotes(limits)) tip.append(el("div", "ag-usage-tip-note", note));
    return tip;
  }

  /* ----- context window ----- */

  /** Cursor's model parameter for the context window size ("272k", "1m"). */
  const CONTEXT_PARAM = "context";

  function tokenCount(n) {
    if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
  }

  /** "272k" or "1m" as tokens. */
  function sizeTokens(value) {
    const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(String(value || "").trim());
    if (!m) return 0;
    return Math.round(parseFloat(m[1]) * (m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2] ? 1000 : 1));
  }

  /** Window sizes providers have reported, by provider and model, for chats that have no report of their own yet. */
  const knownWindows = new Map();

  function noteWindows(provider, turns) {
    for (const turn of turns) {
      if (turn.usage?.contextWindow) knownWindows.set(`${provider}:${turn.model}`, turn.usage.contextWindow);
    }
  }

  /** Fetch once per composer setup; never start a provider session or probe user MCP servers. */
  function contextSeed(view, s) {
    const input = { provider: s.provider, model: s.model, mode: s.mode, cwd: s.cwd, scope: s.scope, web: s.web, custom: s.custom, customMode: s.customMode, approval: s.approval };
    const threadId = view.pendingFork ? undefined : view.thread()?.id;
    const key = JSON.stringify({ ...input, threadId });
    if (view.contextSeedKey !== key) {
      view.contextSeedKey = key;
      view.contextSeedValue = null;
      void api("POST", "/context/seed", { ...input, threadId }).then((value) => {
        if (view.contextSeedKey !== key) return;
        view.contextSeedValue = value;
        view.refreshContextMeter();
      }).catch(() => {});
    }
    return view.contextSeedValue;
  }

  /** Characters an item puts in the model's context. A subagent's own items stay out of it, and shown reasoning is not what the model keeps. */
  function itemContextChars(item) {
    if (item.parentToolId) return 0;
    if (item.kind === "user") return item.dropped ? 0 : (item.text || "").length + (item.images?.length || 0) * 4000;
    if (item.kind === "text" || item.kind === "plan") return (item.text || "").length;
    if (item.kind === "tool") {
      let input = 0;
      try {
        input = item.input == null ? (item.detail || "").length : JSON.stringify(item.input).length;
      } catch {}
      return input + (item.output || "").length + (item.diff || "").length;
    }
    return 0;
  }

  /**
   * Tokens of the items the provider has not counted, at four characters a token: everything after the turn
   * that last reported its context, or after the last summary when no turn has.
   */
  function estimateContext(detail, measured) {
    if (!detail) return 0;
    let items = detail.items;
    if (measured) {
      items = items.filter((item) => {
        const turn = item.turnId ? detail.turns.get(item.turnId) : null;
        return turn ? turn.seq > measured.seq : !item.turnId;
      });
    } else {
      const cut = items.findLastIndex((item) => item.kind === "notice" && /summarized the conversation|Context compacted/.test(item.text));
      if (cut >= 0) items = items.slice(cut + 1);
    }
    let chars = 0;
    for (const item of items) chars += itemContextChars(item);
    return Math.ceil(chars / 4);
  }

  /**
   * The context of a chat: the latest turn's usage, an estimate for what came after it (or for all of it when the
   * provider reports none, as Cursor), and the size option when the model has one.
   */
  function contextInfo(view) {
    const s = view.settings();
    const t = view.thread();
    const info = modelInfo(s.provider, s.model);
    const param = info?.params?.find((p) => p.id === CONTEXT_PARAM) || null;
    const size = param ? (s.modelParams?.[CONTEXT_PARAM] ?? param.default) : null;
    const detail = t ? S.details.get(t.id) : null;
    const seed = contextSeed(view, s);
    const turns = detail ? [...detail.turns.values()].sort((a, b) => a.seq - b.seq) : [];
    if (t) noteWindows(t.provider, turns);
    const last = turns.findLast((x) => x.usage?.contextWindow || x.usage?.contextTokens);
    const usage = last?.usage || null;
    const measured = turns.findLast((x) => x.usage?.contextTokens) || null;
    const window = sizeTokens(size) || usage?.contextWindow || knownWindows.get(`${s.provider}:${s.model}`) || seed?.window || 0;
    const estimate = estimateContext(detail, measured) + (measured ? 0 : seed?.tokens || 0);
    const used = (measured?.usage.contextTokens || 0) + estimate;
    return { s, param, size, usage, used, window, estimate, measured: Boolean(measured), fraction: window ? Math.min(1, used / window) : 0 };
  }

  /** A ring that fills as the context does. Click picks the window size where the model has one; hover gives details. */
  function contextMeter(view) {
    const ctx = contextInfo(view);
    const level = usageLevel(ctx.fraction);
    const meter = button("", `ag-ctx-meter lvl-${level}${ctx.param ? "" : " fixed"}`, (event) => {
      const ctx = contextInfo(view);
      if (!ctx.param) return;
      hideUsageTip();
      const cur = ctx.size;
      openMenu(
        event.currentTarget,
        [
          { header: "Context window" },
          ...ctx.param.options.map((o) => ({
            label: o.label,
            detail: sizeTokens(o.id) > sizeTokens(ctx.param.default) ? "Uses more credits per message" : undefined,
            checked: cur === o.id,
            run: () => view.updateSettings({ modelParams: { ...(ctx.s.modelParams || {}), [CONTEXT_PARAM]: o.id } }),
          })),
        ],
        { width: 240 }
      );
    });
    meter.setAttribute("aria-label", ctx.window ? `Context ${ctx.estimate ? "about " : ""}${percent(ctx.fraction)} of ${tokenCount(ctx.window)}` : "Context");
    meter._sig = `${level}:${ctx.fraction.toFixed(3)}:${ctx.window}:${ctx.param ? ctx.size : ""}`;
    // Two circles: the track and an arc whose dash length is the share in use.
    const r = 6;
    const length = 2 * Math.PI * r;
    meter.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="${r}" class="ag-ctx-track"/>${ctx.fraction > 0 ? `<circle cx="8" cy="8" r="${r}" class="ag-ctx-fill" stroke-dasharray="${(ctx.fraction * length).toFixed(2)} ${length.toFixed(2)}" transform="rotate(-90 8 8)"/>` : ""}</svg>`;
    bindHoverTip(meter, () => contextTip(contextInfo(view)));
    return meter;
  }

  function contextTip(ctx) {
    const tip = el("div", "ag-usage-tip");
    tip.append(el("div", "ag-usage-tip-title", "Context"));
    // "~" marks a reading that is partly Scribe's own estimate.
    const about = ctx.estimate ? "~" : "";
    if (ctx.window && (ctx.used > 0 || ctx.usage?.contextTokens != null)) {
      const row = el("div", `ag-usage-tip-row lvl-${usageLevel(ctx.fraction)}`);
      const bar = el("div", "ag-meter-bar");
      const fill = el("div", "ag-meter-fill");
      fill.style.width = `${Math.round(ctx.fraction * 100)}%`;
      bar.append(fill);
      row.append(el("span", "ag-usage-tip-label", `${about}${tokenCount(ctx.used)} of ${tokenCount(ctx.window)}`), bar, el("span", "ag-usage-tip-pct", percent(ctx.fraction)));
      tip.append(row);
      if (!ctx.measured) tip.append(el("div", "ag-usage-tip-note", ctx.s.provider === "cursor" ? "Estimated from startup instructions, tools and chat text; Cursor does not report context." : "Estimated from startup instructions, tools and chat text until the next reply."));
    } else if (ctx.used > 0) {
      tip.append(el("div", "ag-usage-tip-note", `${about}${tokenCount(ctx.used)} tokens, including estimated startup instructions and tools. The window size is not known yet.`));
    } else {
      const note = !ctx.window
        ? "Shows how full the context is after the first reply."
        : ctx.s.provider === "cursor" && !ctx.usage
          ? `Window: ${tokenCount(ctx.window)}. Cursor does not report how full it is.`
          : `Window: ${tokenCount(ctx.window)}. Shows how full it is after the first reply.`;
      tip.append(el("div", "ag-usage-tip-note", note));
    }
    const u = ctx.usage;
    if (u && (u.inputTokens || u.outputTokens)) {
      const parts = [u.inputTokens ? `${tokenCount(u.inputTokens)} in` : "", u.cacheReadTokens ? `${tokenCount(u.cacheReadTokens)} cached` : "", u.outputTokens ? `${tokenCount(u.outputTokens)} out` : ""].filter(Boolean);
      tip.append(el("div", "ag-usage-tip-note", `Last turn: ${parts.join(" · ")}`));
    }
    if (ctx.param) tip.append(el("div", "ag-usage-tip-note", "Click to change the window size. A bigger window costs more credits per message."));
    return tip;
  }

  /** Detailed usage excludes Cursor's estimated combined value. */
  function detailWindows(limits) {
    return limits.windows.filter((w) => w.id !== "cursor_included");
  }

  /** Windows the full chip lists: on-demand only once used. */
  function chipWindows(limits) {
    return detailWindows(limits).filter((w) => w.id !== "cursor_on_demand" || w.utilization > 0);
  }

  /** Cursor exposes no usage bucket in our model list; infer it from the selected id or display name. */
  function cursorUsageWindow(model) {
    const info = !model || model === "default" ? modelsOf("cursor")[0] : modelInfo("cursor", model);
    const names = [info?.id || (!model || model === "default" ? "auto" : model), info?.label || ""];
    return names.some((name) => /^auto$/i.test(name.trim()) || /grok|composer/i.test(name)) ? "cursor_auto" : "cursor_api";
  }

  /** Compact chip: Cursor's selected model bucket, Claude/Codex's 5-hour, else the fullest listed window. */
  function compactWindow(limits, provider, model) {
    if (provider === "cursor") {
      const selected = limits.windows.find((w) => w.id === cursorUsageWindow(model));
      const included = limits.windows.find((w) => w.id === "cursor_included");
      if (selected || included) return selected || included;
    }
    const listed = chipWindows(limits);
    return limits.windows.find((w) => w.id === "five_hour") || limits.windows.find((w) => w.id === "codex:codex:primary") || listed.reduce((a, b) => (a.utilization >= b.utilization ? a : b), listed[0]) || null;
  }

  /** Plan usage on the composer: one percent in the floating chat and sidebar, or "5h 84%" windows in the full window. Nothing until the provider has reported. */
  function usageChip(provider, compact = false, model = null, thread = null) {
    const limits = planLimits(provider, thread);
    if (!limits) return null;
    if ((provider === "codex" || provider === "claude") && limits.availability !== "available") {
      const source = limits.billingSource || {};
      const backend = source.apiProvider && source.apiProvider !== "firstParty" ? source.apiProvider : source.apiKeySource && source.apiKeySource !== "none" ? "API" : source.tokenSource && source.tokenSource !== "none" ? "Token" : "Source unknown";
      const chip = button(provider === "claude" ? `${backend} · quota unavailable` : "Quota unavailable", "ag-usage", () => agentSettings.open(), "");
      chip.setAttribute("aria-label", limits.detail || `${PROVIDER_LABEL[provider]} quota unavailable`);
      bindHoverTip(chip, () => usageTip(provider, thread));
      return chip;
    }
    const listed = chipWindows(limits);
    const one = compact ? compactWindow(limits, provider, model) : null;
    if (!(compact ? one : listed.length)) return null;
    const top = one ? one.utilization : Math.max(...listed.map((w) => w.utilization));
    const chip = button("", `ag-usage lvl-${usageLevel(top)}`, () => {
      hideUsageTip();
      agentSettings.open();
    }, "");
    if (compact) {
      chip.append(el("span", `ag-usage-w lvl-${usageLevel(one.utilization)}`, quotaPercent(provider, one.utilization)));
      chip.setAttribute("aria-label", `${PROVIDER_LABEL[provider] || provider} plan usage ${quotaPercent(provider, one.utilization)} of ${one.label}`);
    } else {
      chip.setAttribute("aria-label", `${PROVIDER_LABEL[provider] || provider} plan usage`);
      for (const w of listed) chip.append(el("span", `ag-usage-w lvl-${usageLevel(w.utilization)}`, `${planWindowShort(w)} ${quotaPercent(provider, w.utilization)}`));
    }
    bindHoverTip(chip, () => usageTip(provider, thread));
    return chip;
  }

  /** Full meters for the settings dialog. */
  function usageMeters(provider) {
    const box = el("div", "ag-meters");
    const limits = planLimits(provider);
    const head = el("div", "ag-meter-head");
    head.append(el("strong", null, PROVIDER_LABEL[provider] || provider));
    if (limits) head.append(el("span", "ag-muted", ` · updated ${R.timeAgo(limits.at)}${provider !== "claude" && limits.overage ? " · using extra usage" : ""}`));
    box.append(head);
    if (!limits) {
      box.append(
        el(
          "p",
          "ag-muted ag-meter-none",
          provider === "codex" ? "Checking Codex subscription quota…" : provider === "claude" ? "Shows after the next Claude turn. After that, Scribe checks again when a usage window resets." : "Shows after the next Cursor turn, then refreshes after turns at most every 10 minutes. Uses the Cursor app's login on this PC, so the Cursor app must be installed and signed in."
        )
      );
      return box;
    }
    for (const w of detailWindows(limits)) {
      const row = el("div", `ag-meter lvl-${usageLevel(w.utilization)}`);
      const bar = el("div", "ag-meter-bar");
      const fill = el("div", "ag-meter-fill");
      fill.style.width = `${Math.min(100, Math.round(w.utilization * 100))}%`;
      bar.append(fill);
      row.append(el("span", "ag-meter-label", w.label), bar, el("span", "ag-meter-pct", quotaPercent(provider, w.utilization)), el("span", "ag-meter-reset", quotaReset(provider, w.resetsAt)));
      box.append(row);
    }
    if (provider === "codex") for (const note of codexQuotaNotes(limits)) box.append(el("p", "ag-muted ag-meter-none", note));
    if (provider === "claude") for (const note of claudeQuotaNotes(limits)) box.append(el("p", "ag-muted ag-meter-none", note));
    return box;
  }

  /* ---------- agent settings: their own dialog, opened from the chat header or the board's Settings ---------- */

  const KEYS = [
    ["Ctrl+Alt+S / Ctrl+,", "General settings"],
    ["Ctrl+Alt+Shift+S / Ctrl+Shift+,", "Agent settings"],
    ["Ctrl+L", "Sidebar chat"],
    ["Ctrl+K", "Floating chat"],
    ["Ctrl+Shift+L", "Full window"],
    ["Ctrl+↑ / Ctrl+↓", "From a chat into the full window and back; expand, collapse, or hide the floating chat"],
    ["Ctrl+J", "Threads"],
    ["Ctrl+Shift+K", "New thread with this chat's agent settings"],
    ["Ctrl+'", "Next starred model"],
    ["Ctrl+Alt+'", "Next reasoning level"],
    ["Ctrl+Shift+'", "Next mode"],
    ["Ctrl+.", "Next workspace, then none"],
    ["Ctrl+Shift+.", "Next Scribe access (this page, its folder, global, none)"],
    ["Enter", "Send (or a new line, from Chat settings)"],
    ["Ctrl+Enter", "Always send"],
    ["Shift+Enter", "Always a new line"],
    ["Enter on an empty box", "Steer in, or send, the first queued message"],
    ["↑ on an empty box", "Edit the last queued message"],
    ["Esc Esc", "Stop the agent"],
  ];

  /** A short explanation in the shared hover tip. */
  function noteTip(text) {
    return el("div", "ag-usage-tip ag-note-tip", text);
  }

  const FLAG_WORD = { flag: "Flagged", ask: "Asked first", block: "Blocked" };

  /** A hook's marks on a transcript item (item.flags), as small tags. Null when it has none. */
  function hookFlags(it) {
    if (!it.flags?.length) return null;
    const wrap = el("span", "ag-flags");
    for (const flag of it.flags) {
      const tag = el("span", `ag-tag ag-flag a-${flag.action}`, flag.label);
      const tip = `${FLAG_WORD[flag.action] || "Flagged"} by a hook${flag.reason ? `: ${flag.reason}` : "."}`;
      tag.dataset.tooltip = tip;
      tag.setAttribute("aria-description", tip);
      wrap.append(tag);
    }
    return wrap;
  }

  /**
   * A section heading with a ? that shows its explanation at once, for help that isn't one setting's.
   * Help for one setting goes on its label instead (settingRow's `hint`), so neither takes room in the dialog.
   */
  function helpHeading(text, help) {
    const head = el("h3", "ag-help-head", text);
    const b = el("button", "ag-help");
    b.type = "button";
    b.textContent = "?";
    b.setAttribute("aria-label", `About ${text}`);
    b.setAttribute("aria-description", help);
    bindHoverTip(b, () => noteTip(help), { delay: 0, start: true });
    const show = () => placeHoverTip(b, noteTip(help), 280, true);
    b.addEventListener("click", show);
    b.addEventListener("focus", () => b.matches(":focus-visible") && show());
    b.addEventListener("blur", hideHoverTip);
    head.append(b);
    return head;
  }

  /** A labelled setting row with its control on the right. `hint` explains it in a hover tip on the label. */
  function settingRow(text, control, { id, hint } = {}) {
    const row = el("div", "setting-row");
    const label = el("span", null, text);
    if (hint) {
      label.classList.add("ag-hinted");
      label.setAttribute("aria-description", hint);
      bindHoverTip(label, () => noteTip(hint), { delay: 700, start: true });
    }
    if (id) {
      label.id = id;
      control.setAttribute("aria-labelledby", id);
    }
    row.append(label, control);
    return row;
  }

  function switchControl(isOn, toggle) {
    const b = el("button", "pill-toggle");
    b.type = "button";
    b.setAttribute("role", "switch");
    const sync = () => b.setAttribute("aria-checked", String(isOn()));
    b.addEventListener("click", () => {
      toggle();
      sync();
    });
    sync();
    return b;
  }

  function choiceTrack(options, current, pick) {
    const track = el("div", "button-track text-track");
    track.setAttribute("role", "group");
    const sync = () => {
      for (const b of track.children) b.setAttribute("aria-pressed", String(b.dataset.value === current()));
    };
    for (const option of options) {
      const b = button(option.label, null, () => {
        pick(option.id);
        sync();
      });
      b.dataset.value = option.id;
      track.append(b);
    }
    sync();
    return track;
  }

  /* ---------- allowlists: the providers' own allow / ask / deny rules ---------- */

  const RULE_HELP = {
    claude: "Tool name, optionally with a pattern: Bash(npm test:*), Bash(git status), Read(./src/**), Edit, WebFetch(domain:docs.rs), mcp__server__tool.",
    cursor: "Shell(git status) allows that command (prefix match), Read(**/*.md), Write(src/**), Mcp(server:tool), WebFetch(docs.rs).",
  };
  const SCOPE_LABEL = { user: "Everywhere (user)", project: "This workspace (shared)", local: "This workspace (only you)" };
  const KIND_LABEL = { allow: "Allow", ask: "Always ask", deny: "Deny" };

  const allowlists = {
    root: null,
    body: null,
    picker: null,
    cwd: null,
    mount() {
      const root = el("div", "settings ag-perm-dialog");
      root.hidden = true;
      const backdrop = el("div", "settings-backdrop");
      backdrop.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.close();
      });
      const panel = el("div", "settings-panel");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-labelledby", "ag-perm-title");
      const title = el("h2", "settings-title", "Allowlists");
      title.id = "ag-perm-title";
      this.web = el("section", "settings-section ag-web-allow");
      this.hooks = el("section", "settings-section");
      const commands = el("section", "settings-section");
      const pick = el("div", "setting-row");
      const label = el("span", null, "Workspace");
      label.id = "ag-perm-ws-label";
      this.picker = el("select");
      this.picker.setAttribute("aria-labelledby", label.id);
      this.picker.addEventListener("change", () => {
        this.cwd = this.picker.value || null;
        void this.load();
      });
      pick.append(label, this.picker);
      commands.append(
        helpHeading(
          "Commands",
          "The rules Claude Code and Cursor apply before they ask you. They live in the providers' own config files; Scribe only edits their permission lists. \"Always allow\" on an approval adds a rule here too."
        ),
        pick
      );
      this.body = el("div", "ag-perm-body");
      panel.append(title, this.web, this.hooks, commands, this.body);
      root.append(backdrop, panel);
      document.body.append(root);
      this.root = root;
      this.pickerWrap = window.createSelect ? window.createSelect(this.picker) : null;
    },
    isOpen() {
      return Boolean(this.root && !this.root.hidden);
    },
    open() {
      if (!this.root) return;
      const current = targetView().settings().cwd || null;
      const dirs = [...new Set([current, ...(prefs().recentWorkspaces || [])].filter(Boolean))];
      this.picker.replaceChildren(...dirs.map((dir) => el("option", null, dir)), el("option", null, "No workspace: user rules only"));
      [...this.picker.options].forEach((option, i) => (option.value = i < dirs.length ? dirs[i] : ""));
      this.cwd = dirs[0] || null;
      this.picker.value = this.cwd || "";
      this.pickerWrap?.syncSelect?.();
      this.renderWeb();
      this.renderHooks();
      this.root.hidden = false;
      this.releaseTrap?.();
      this.releaseTrap = window.scribeFocusTrap?.bind(this.root.querySelector(".settings-panel"));
      void this.load();
    },
    /** Domains for Limited web access. Scribe's own list (prefs), the same for every workspace. */
    renderWeb() {
      const list = prefs().webAllowlist || [];
      const rows = el("div", "ag-perm-rules");
      for (const domain of list) {
        const row = el("span", "ag-perm-rule");
        row.append(el("code", null, domain), button(icon("close"), "ag-chip-x", () => this.saveWeb(list.filter((d) => d !== domain)), `Remove ${domain}`));
        rows.append(row);
      }
      const input = el("input", "ag-input small ag-perm-add");
      input.placeholder = "Add a domain, e.g. example.com";
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || !input.value.trim()) return;
        event.preventDefault();
        void this.saveWeb([...list, input.value.trim()]);
      });
      rows.append(input);
      const actions = el("div", "settings-actions");
      actions.append(button("Reset to defaults", null, () => this.saveWeb(null)));
      const search = el("input", "ag-input small");
      search.value = prefs().searxngUrl || "";
      search.placeholder = "http://192.168.1.20:8080";
      search.spellcheck = false;
      const saveSearch = async () => {
        const value = search.value.trim();
        if (value === (prefs().searxngUrl || "")) return;
        try {
          S.config.prefs = await api("PUT", "/prefs", { searxngUrl: value });
          search.value = prefs().searxngUrl || "";
        } catch (err) {
          notice(err.message);
        }
      };
      search.addEventListener("change", () => void saveSearch());
      search.addEventListener("keydown", (event) => {
        if (event.key === "Enter") search.blur();
      });
      this.web.replaceChildren(
        helpHeading(
          "Web",
          "With web set to Limited, threads may search and fetch only these domains and their subdomains, without asking. Anything else asks you first."
        ),
        rows,
        actions,
        settingRow("SearXNG search", search, {
          hint: "Your SearXNG instance's address. Native threads, and Cursor threads with web Limited or Off, get a web_search tool through it, gated by the thread's web setting. The instance must allow JSON results (search.formats in its settings.yml). Leave empty for no search. Applies to new sessions.",
        })
      );
    },
    /** Whether Claude threads run the hooks from Claude Code's settings files and plugins (prefs). */
    renderHooks() {
      const label = el("label", "ag-check");
      const box = el("input");
      box.type = "checkbox";
      box.checked = Boolean(prefs().claudeHooks);
      box.addEventListener("change", async () => {
        try {
          S.config.prefs = await api("PUT", "/prefs", { claudeHooks: box.checked });
        } catch (err) {
          box.checked = !box.checked;
          notice(err.message);
        }
      });
      label.append(box, el("span", null, "Run Claude Code hooks in Claude threads"));
      this.hooks.replaceChildren(
        helpHeading(
          "Hooks",
          "Hooks from your Claude Code settings files and plugins are written for your own terminal sessions. One that fails closed, such as a plugin that checks each tool call with a local service, can deny every tool in Scribe without saying why. Off by default; Scribe's own checks run either way. Applies from a thread's next message."
        ),
        label
      );
    },
    async saveWeb(list) {
      try {
        S.config.prefs = await api("PUT", "/prefs", { webAllowlist: list });
        this.renderWeb();
        this.web.querySelector(".ag-perm-add")?.focus();
      } catch (err) {
        notice(err.message);
      }
    },
    close() {
      if (!this.isOpen()) return false;
      this.releaseTrap?.();
      this.releaseTrap = null;
      this.root.hidden = true;
      hideHoverTip();
      return true;
    },
    async load() {
      this.body.replaceChildren(el("div", "ag-muted", "Loading…"));
      try {
        const { sets } = await api("GET", `/permissions${this.cwd ? `?cwd=${encodeURIComponent(this.cwd)}` : ""}`);
        this.render(sets);
      } catch (err) {
        this.body.replaceChildren(el("div", "ag-muted", err.message));
      }
    },
    render(sets) {
      this.body.replaceChildren();
      for (const provider of ["claude", "cursor"]) {
        const mine = sets.filter((set) => set.provider === provider);
        if (!mine.length) continue;
        const section = el("section", "settings-section");
        section.append(el("h3", null, PROVIDER_LABEL[provider]), el("p", "settings-hint ag-perm-help", RULE_HELP[provider]));
        for (const set of mine) section.append(this.renderSet(set));
        this.body.append(section);
      }
    },
    renderSet(set) {
      const box = el("div", "ag-perm-set");
      box.dataset.key = `${set.provider}:${set.scope}`;
      const head = el("div", "ag-perm-head");
      head.append(el("strong", null, SCOPE_LABEL[set.scope]), el("span", "ag-perm-path", set.path + (set.exists ? "" : " (created when you add a rule)")));
      box.append(head);
      if (set.error) {
        box.append(el("div", "ag-perm-error", `Can't read this file, so it is left alone: ${set.error}`));
        return box;
      }
      for (const kind of set.kinds) {
        const list = set[kind] || [];
        const group = el("div", `ag-perm-kind k-${kind}`);
        group.append(el("span", "ag-perm-kind-label", KIND_LABEL[kind]));
        const rows = el("div", "ag-perm-rules");
        for (const rule of list) {
          const row = el("span", "ag-perm-rule");
          row.append(el("code", null, rule), button(icon("close"), "ag-chip-x", () => this.save(set, kind, list.filter((r) => r !== rule)), `Remove ${rule}`));
          rows.append(row);
        }
        const input = el("input", "ag-input small ag-perm-add");
        input.placeholder = list.length ? "Add a rule" : kind === "allow" ? (set.provider === "claude" ? "e.g. Bash(npm test:*)" : "e.g. Shell(npm test)") : "Add a rule";
        input.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" || !input.value.trim()) return;
          event.preventDefault();
          void this.save(set, kind, [...list, input.value.trim()]);
        });
        rows.append(input);
        group.append(rows);
        box.append(group);
      }
      return box;
    },
    async save(set, kind, rules) {
      try {
        const { set: next } = await api("PUT", "/permissions", { provider: set.provider, scope: set.scope, cwd: this.cwd, kind, rules });
        const old = this.body.querySelector(`.ag-perm-set[data-key="${set.provider}:${set.scope}"]`);
        const fresh = this.renderSet(next);
        old?.replaceWith(fresh);
        fresh.querySelector(`.k-${kind} .ag-perm-add`)?.focus();
      } catch (err) {
        notice(err.message);
      }
    },
  };

  /* ---------- memories: the notes every chat gets in its instructions (#104) ---------- */

  const memoryDialog = {
    root: null,
    body: null,
    list: [],
    /** Id of the memory being edited. */
    editing: null,
    mount() {
      const root = el("div", "settings ag-perm-dialog ag-mem-dialog");
      root.hidden = true;
      const backdrop = el("div", "settings-backdrop");
      backdrop.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.close();
      });
      const panel = el("div", "settings-panel");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-labelledby", "ag-mem-title");
      const title = el("h2", "settings-title", "Memories");
      title.id = "ag-mem-title";
      const section = el("section", "settings-section");
      this.adder = el("div", "ag-mem-form");
      this.body = el("div", "ag-mem-list");
      section.append(
        helpHeading(
          "Shared memory",
          "Short notes that every chat gets in its instructions, whatever its provider: corrections you gave, mistakes to avoid, facts about a project. Agents save them as they work, and each save shows as a note in that chat. A workspace's memories reach chats in that folder and below it. Changes apply from a thread's next message."
        ),
        this.adder,
        this.body
      );
      panel.append(title, section);
      root.append(backdrop, panel);
      document.body.append(root);
      this.root = root;
    },
    isOpen() {
      return Boolean(this.root && !this.root.hidden);
    },
    open() {
      if (!this.root) return;
      this.editing = null;
      this.here = targetView().settings().cwd || null;
      this.root.hidden = false;
      this.releaseTrap?.();
      this.releaseTrap = window.scribeFocusTrap?.bind(this.root.querySelector(".settings-panel"));
      this.body.replaceChildren(el("div", "ag-muted", "Loading…"));
      this.renderAdder();
      // Not the heading's ?, which shows its tip when focused.
      setTimeout(() => this.adder.querySelector("textarea")?.focus(), 0);
      void this.load();
    },
    close() {
      if (!this.isOpen()) return false;
      this.releaseTrap?.();
      this.releaseTrap = null;
      this.root.hidden = true;
      hideHoverTip();
      return true;
    },
    async load() {
      try {
        this.list = (await api("GET", "/memories")).memories || [];
        this.render();
      } catch (err) {
        this.body.replaceChildren(el("div", "ag-muted", err.message));
      }
    },
    /** A text box and a scope picker; workspace "" is every chat. */
    form(text, workspace, submitLabel, submit, cancel) {
      const box = el("textarea", "ag-input ag-mem-input");
      box.rows = 2;
      box.value = text;
      box.placeholder = "Add a memory, e.g. Run the tests with npm test, not pnpm.";
      box.setAttribute("aria-label", "Memory");
      const scope = el("select");
      scope.setAttribute("aria-label", "Applies to");
      const dirs = [...new Map([workspace, this.here, ...(prefs().recentWorkspaces || []), ...this.list.map((m) => m.workspace)].filter(Boolean).map((dir) => [dirKey(dir), dir])).values()];
      scope.append(el("option", null, "Every chat"), ...dirs.map((dir) => el("option", null, dir)));
      [...scope.options].forEach((option, i) => (option.value = i ? dirs[i - 1] : ""));
      scope.value = workspace || "";
      const go = async () => {
        if (!box.value.trim()) return box.focus();
        try {
          await submit({ text: box.value, workspace: scope.value || null });
        } catch (err) {
          notice(err.message);
        }
      };
      box.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void go();
        }
      });
      const row = el("div", "ag-mem-form-row");
      row.append(scope, el("span", "ag-grow"));
      if (cancel) row.append(button("Cancel", "ag-btn small", cancel));
      row.append(button(submitLabel, "ag-btn small primary", () => void go()));
      const wrap = el("div", "ag-mem-form");
      wrap.append(box, row);
      // The themed select wraps the element where it sits, so it has to be in the form first.
      window.createSelect?.(scope);
      return wrap;
    },
    renderAdder() {
      const fresh = this.form("", this.here, "Add", async (body) => {
        await api("POST", "/memories", body);
        this.renderAdder();
        await this.load();
      });
      this.adder.replaceWith(fresh);
      this.adder = fresh;
    },
    render() {
      this.body.replaceChildren();
      if (!this.list.length) {
        this.body.append(el("div", "ag-muted", "Nothing saved yet."));
        return;
      }
      const groups = new Map();
      for (const memory of [...this.list].sort((a, b) => b.updatedAt - a.updatedAt)) {
        const key = memory.workspace ? dirKey(memory.workspace) : "";
        if (!groups.has(key)) groups.set(key, { title: memory.workspace || "Every chat", items: [] });
        groups.get(key).items.push(memory);
      }
      const keys = [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
      for (const key of keys) {
        const group = groups.get(key);
        const box = el("div", "ag-perm-set");
        const head = el("div", "ag-perm-head");
        head.append(key ? el("span", "ag-perm-path", group.title) : el("strong", null, group.title));
        box.append(head);
        for (const memory of group.items) box.append(this.renderMemory(memory));
        this.body.append(box);
      }
    },
    renderMemory(memory) {
      if (this.editing === memory.id) {
        return this.form(
          memory.text,
          memory.workspace || null,
          "Save",
          async (body) => {
            await api("PUT", `/memories/${memory.id}`, body);
            this.editing = null;
            await this.load();
          },
          () => {
            this.editing = null;
            this.render();
          }
        );
      }
      const row = el("div", "ag-mem");
      const by = memory.by === "user" ? "you" : PROVIDER_LABEL[memory.by] || memory.by;
      const meta = el("div", "ag-mem-meta");
      meta.append(
        el("span", null, `Saved by ${by}, ${new Date(memory.updatedAt).toLocaleDateString()}`),
        el("span", "ag-grow"),
        button("Edit", "ag-btn small", () => {
          this.editing = memory.id;
          this.render();
          this.body.querySelector(".ag-mem-input")?.focus();
        }),
        button("Remove", "ag-btn small", async () => {
          try {
            await api("DELETE", `/memories/${memory.id}`);
            await this.load();
          } catch (err) {
            notice(err.message);
          }
        })
      );
      row.append(el("div", "ag-mem-text", memory.text), meta);
      return row;
    },
  };

  /* ---------- MCP servers: Scribe's one list for every provider (data/agent/mcp.json) ---------- */

  const MCP_SOURCE_LABEL = { claude: "Claude Code", cursor: "Cursor", pi: "Pi", codex: "Codex" };

  /** One line about where a server runs: its command line or URL. */
  function mcpTarget(server) {
    if (server.url) return server.url;
    return [server.command, ...(server.args || [])].filter(Boolean).join(" ");
  }

  function mcpModes(server, defaults) {
    const ids = server.modes || defaults;
    return MODES.filter((m) => ids.includes(m.id)).map((m) => m.label).join(", ") || "no modes";
  }

  const mcpServers = {
    view: null,
    scope: "global",
    panel: null,
    candidates: [],
    discoveryError: null,
    close: () => {},
    /** Told after each saved change, when the harness page opened a dialog here. */
    changed: null,
    async open({ onClose } = {}) {
      const { panel, close } = modal("ag-mcp", onClose);
      this.panel = panel;
      this.close = close;
      this.changed = null;
      this.current = targetView().settings().cwd || null;
      this.scope = "global";
      this.candidates = [];
      this.discoveryError = null;
      panel.append(el("h2", "ag-modal-title", "MCP servers"), el("div", "ag-muted", "Loading…"));
      try {
        this.view = await api("GET", "/mcp");
      } catch (err) {
        panel.replaceChildren(el("h2", "ag-modal-title", "MCP servers"), el("p", "ag-source-error", err.message));
        return;
      }
      this.render();
      try {
        this.candidates = (await this.findImports()).filter((c) => c.source === "claude");
      } catch (err) {
        this.discoveryError = err.message;
      }
      this.render();
    },
    /** One server's dialog on its own, for the harness page. scope is "global" or a workspace folder; no name adds a server. */
    async editFrom(scope, name, changed) {
      try {
        this.view = await api("GET", "/mcp");
      } catch (err) {
        notice(err.message);
        return;
      }
      this.panel = null;
      this.scope = scope || "global";
      this.changed = changed;
      if (name && !this.layer()[name]) return notice(`${name} is no longer in Scribe's list.`);
      this.edit(name || null);
    },
    async permissionsDialog() {
      const { panel } = modal("ag-mcp");
      const heading = () => helpHeading("Saved MCP permissions", "Revoking a grant applies to future permission checks; full access and servers set to run without asking still bypass approval. Older grants whose configuration no longer matches appear as unavailable servers. Grants for deleted threads are removed automatically.");
      const render = (grants) => {
        const list = el("div", "ag-mcp-list");
        if (!grants.length) list.append(el("div", "ag-muted", "No saved permissions."));
        for (const grant of grants) {
          const row = el("div", "setting-row ag-mcp-row");
          const label = el("span", "ag-mcp-label");
          const name = grant.server?.name || `Unavailable server (${grant.key.slice(0, 12)})`;
          label.append(el("strong", null, name),
            el("span", "ag-mcp-target", grant.tool ? `Tool: ${grant.tool} · All threads` : `All tools · Thread: ${grant.threadTitle || grant.thread}`));
          if (grant.server) label.append(el("span", "ag-mcp-target", grant.server.layer === "global" ? "Everywhere" : grant.server.layer));
          const revoke = button("Revoke", "ag-btn small", async () => {
            revoke.disabled = true;
            try {
              const result = await api("DELETE", "/mcp/permissions", { key: grant.key, tool: grant.tool, thread: grant.thread });
              render(result.grants);
            } catch (err) { notice(err.message); revoke.disabled = false; }
          });
          revoke.setAttribute("aria-label", `Revoke ${name}: ${grant.tool || "all tools"} for ${grant.thread ? grant.threadTitle || grant.thread : "all threads"}`);
          row.append(label, revoke);
          list.append(row);
        }
        panel.replaceChildren(heading(), list);
      };
      panel.append(heading(), el("div", "ag-muted", "Loading…"));
      try { render((await api("GET", "/mcp/permissions")).grants); }
      catch (err) { panel.replaceChildren(heading(), el("p", "ag-source-error", err.message)); }
    },
    async findImports() {
      const query = this.workspaces().map((d) => `cwd=${encodeURIComponent(d)}`).join("&");
      return (await api("GET", `/mcp/import${query ? `?${query}` : ""}`)).candidates || [];
    },
    /** Workspaces to choose from: the current one, recent ones, and any with servers of their own. */
    workspaces() {
      const layers = Object.values(this.view.file.workspaces).map((w) => w.path);
      const discovered = this.candidates.filter((c) => c.scope !== "global").map((c) => c.scope);
      const dirs = [this.current, ...(prefs().recentWorkspaces || []), ...layers, ...discovered].filter(Boolean);
      const seen = new Set();
      return dirs.filter((dir) => {
        const key = dirKey(dir);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    layer() {
      if (this.scope === "global") return this.view.file.mcpServers;
      const key = dirKey(this.scope);
      return Object.values(this.view.file.workspaces).find((w) => dirKey(w.path) === key)?.mcpServers || {};
    },
    async save(servers) {
      try {
        this.view = await api("PUT", "/mcp/layer", { scope: this.scope, servers });
        this.render();
        this.changed?.();
        return true;
      } catch (err) {
        notice(err.message);
        return false;
      }
    },
    render() {
      if (!this.panel?.isConnected) return;
      const view = this.view;
      const picker = el("select");
      picker.setAttribute("aria-label", "Where the servers apply");
      const dirs = this.workspaces();
      picker.append(el("option", null, "Everywhere"), ...dirs.map((dir) => el("option", null, dir)));
      [...picker.options].forEach((option, i) => (option.value = i ? dirs[i - 1] : "global"));
      picker.value = this.scope;
      picker.addEventListener("change", () => {
        this.scope = picker.value;
        this.render();
      });
      const pick = el("div", "setting-row");
      pick.append(el("span", null, "Applies"), picker);

      const own = this.layer();
      const ownNames = Object.keys(own).filter((name) => own[name].command || own[name].url);
      const list = el("div", "ag-mcp-list");
      if (view.error) list.append(el("p", "ag-source-error", `${view.path} does not parse, so Scribe won't change it: ${view.error}`));
      if (!ownNames.length) list.append(el("div", "ag-muted", this.scope === "global" ? "No servers yet." : "No servers of this workspace's own."));
      for (const name of ownNames) list.append(this.row(name, own[name], own));

      const body = [
        helpHeading(
          "Servers",
          "One list for Claude, Cursor and Native threads, in place of each app's own MCP config. Code chats also inherit Keeper from Claude Code when Scribe has no Keeper entry; Cursor threads still load ~/.cursor/mcp.json as well. A workspace's servers apply in that folder and its subfolders, and replace a server of the same name from Everywhere. Changes apply from a thread's next session."
        ),
        pick,
        list,
      ];

      if (this.scope !== "global") {
        const box = el("div", "ag-mcp-list");
        for (const [name, server] of Object.entries(view.file.mcpServers)) {
          if (ownNames.includes(name)) continue;
          const off = own[name]?.enabled === false;
          const row = el("div", "setting-row ag-mcp-row");
          const label = el("span", "ag-mcp-label");
          label.append(el("strong", null, name), el("span", "ag-muted", ` · ${server.enabled === false ? "off everywhere" : mcpModes(server, view.defaultModes)}`));
          const toggle = switchControl(
            () => !off,
            () => {
              const next = { ...own };
              if (off) delete next[name];
              else next[name] = { enabled: false };
              void this.save(next);
            }
          );
          toggle.setAttribute("aria-label", `Use ${name} in this workspace`);
          row.append(label, toggle);
          box.append(row);
        }
        if (box.children.length) body.push(helpHeading("From Everywhere", "Turn a server off for this workspace only. It stays on everywhere else."), box);
      }

      const available = this.candidates.filter((c) =>
        dirKey(c.scope) === dirKey(this.scope) && !Object.hasOwn(own, c.name));
      if (available.length || this.discoveryError) {
        const box = el("div", "ag-mcp-list");
        if (this.discoveryError) box.append(el("p", "ag-source-error", `Could not check Claude Code's servers: ${this.discoveryError}`));
        for (const c of available) {
          const row = el("div", "setting-row ag-mcp-row");
          const label = el("span", "ag-mcp-label");
          label.append(el("strong", null, c.name), el("code", "ag-mcp-target", c.file), el("code", "ag-mcp-target", mcpTarget(c.server)));
          const importButton = button("Import", "ag-btn small", async () => {
            importButton.disabled = true;
            try {
              this.view = await api("POST", "/mcp/import", { items: [{ scope: c.scope, name: c.name, server: { ...c.server, approve: "ask" } }] });
              this.render();
              notice(`Imported ${c.name}. It asks before each call unless the chat has full access.`);
            } catch (err) {
              notice(err.message);
              importButton.disabled = false;
            }
          });
          importButton.setAttribute("aria-label", `Import ${c.name} from ${c.file}`);
          row.append(label, importButton);
          box.append(row);
        }
        body.push(helpHeading("Found in Claude Code", "These servers are not in Scribe's list for this scope. Import copies a server here and leaves Claude Code's file unchanged. Imported servers ask before each call, including worker calls, unless the chat has full access; change this in the server's Edit dialog."), box);
      }

      const actions = el("div", "ag-modal-actions");
      actions.append(
        button("Add server…", "ag-btn", () => this.edit(null)),
        button("Import…", "ag-btn", () => void this.importDialog()),
        button("Edit JSON…", "ag-btn ghost", () => this.editJson()),
        button("Saved permissions…", "ag-btn ghost", () => void this.permissionsDialog()),
        el("span", "ag-grow"),
        button("Done", "ag-btn primary", () => this.close())
      );
      this.panel.replaceChildren(el("h2", "ag-modal-title", "MCP servers"), ...body, el("p", "ag-modal-hint ag-mcp-path", view.path), actions);
      window.createSelect?.(picker);
    },
    row(name, server, layer) {
      const row = el("div", "setting-row ag-mcp-row");
      const label = el("span", "ag-mcp-label");
      const meta = [mcpModes(server, this.view.defaultModes), server.approve === "auto" ? "runs without asking" : null].filter(Boolean).join(" · ");
      label.append(el("strong", null, name), el("span", "ag-muted", ` · ${meta}`), el("code", "ag-mcp-target", mcpTarget(server)));
      const toggle = switchControl(
        () => server.enabled !== false,
        () => void this.save({ ...layer, [name]: { ...server, enabled: server.enabled === false } })
      );
      toggle.setAttribute("aria-label", `Use ${name}`);
      const controls = el("span", "ag-mcp-controls");
      controls.append(toggle, button("Edit", "ag-btn small", () => this.edit(name)));
      row.append(label, controls);
      return row;
    },
    /** Add or change one server in the chosen layer. */
    edit(name) {
      const layer = this.layer();
      const server = name ? layer[name] : { modes: this.view.defaultModes };
      const { panel, close } = modal("ag-source ag-mcp-edit");
      const field = (label, input, hint) => {
        const wrap = el("label", "ag-field");
        wrap.append(el("span", "ag-field-label", label), input);
        if (hint) wrap.append(el("span", "ag-muted ag-field-hint", hint));
        return wrap;
      };
      const input = (value, placeholder) => {
        const node = el("input", "ag-input");
        node.value = value || "";
        node.placeholder = placeholder;
        node.spellcheck = false;
        return node;
      };
      const area = (value, placeholder) => {
        const node = el("textarea", "ag-input ag-source-models");
        node.value = value;
        node.placeholder = placeholder;
        node.spellcheck = false;
        return node;
      };
      const pairs = (map, sep) =>
        Object.entries(map || {})
          .map(([k, v]) => `${k}${sep}${v}`)
          .join("\n");
      const parsePairs = (text, sep) => {
        const out = {};
        for (const line of text.split("\n")) {
          const at = line.indexOf(sep);
          if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + sep.length).trim();
        }
        return out;
      };
      const nameInput = input(name, "e.g. github");
      let kind = server.url ? "url" : "command";
      const command = input(server.command, "e.g. npx");
      const args = area((server.args || []).join("\n"), "One argument per line");
      const env = area(pairs(server.env, "="), "KEY=value, one per line");
      const url = input(server.url, "https://example.com/mcp");
      const sse = el("input");
      sse.type = "checkbox";
      sse.checked = server.type === "sse";
      const sseLabel = el("label", "ag-check");
      sseLabel.append(sse, el("span", null, "Server-sent events (older servers)"));
      const headers = area(pairs(server.headers, ": "), "Header: value, one per line");
      const commandFields = el("div", "ag-mcp-fields");
      commandFields.append(field("Command", command), field("Arguments", args), field("Environment", env, "${VAR} takes a variable from Scribe's environment."));
      const urlFields = el("div", "ag-mcp-fields");
      urlFields.append(field("URL", url), sseLabel, field("Headers", headers, "${VAR} takes a variable from Scribe's environment."));
      const syncKind = () => {
        commandFields.hidden = kind !== "command";
        urlFields.hidden = kind !== "url";
      };
      const kindTrack = choiceTrack(
        [
          { id: "command", label: "Command" },
          { id: "url", label: "URL" },
        ],
        () => kind,
        (id) => {
          kind = id;
          syncKind();
        }
      );
      syncKind();
      const modes = el("div", "ag-mcp-modes");
      const modeBoxes = MODES.map((mode) => {
        const box = el("input");
        box.type = "checkbox";
        box.value = mode.id;
        box.checked = (server.modes || this.view.defaultModes).includes(mode.id);
        const label = el("label", "ag-check");
        label.append(box, el("span", null, mode.label));
        modes.append(label);
        return box;
      });
      const autoBox = el("input");
      autoBox.type = "checkbox";
      autoBox.checked = server.approve === "auto";
      const auto = el("label", "ag-check");
      auto.append(autoBox, el("span", null, "Run its tools without asking"));
      const error = el("p", "ag-source-error");
      error.hidden = true;
      const save = async () => {
        const id = nameInput.value.trim();
        const fail = (text) => {
          error.textContent = text;
          error.hidden = false;
        };
        if (!/^[A-Za-z0-9_.-]{1,48}$/.test(id)) return fail("Use letters, digits, dot, dash or underscore for the name.");
        if (id !== name && layer[id]) return fail(`There is already a server named ${id} here.`);
        const next = { ...server };
        for (const key of ["command", "args", "env", "url", "headers", "type"]) delete next[key];
        if (kind === "command") {
          if (!command.value.trim()) return fail("Enter the command that starts the server.");
          next.command = command.value.trim();
          const list = args.value
            .split("\n")
            .map((a) => a.trim())
            .filter(Boolean);
          if (list.length) next.args = list;
          const vars = parsePairs(env.value, "=");
          if (Object.keys(vars).length) next.env = vars;
        } else {
          if (!/^https?:\/\//i.test(url.value.trim())) return fail("Enter the server's http(s) URL.");
          next.url = url.value.trim();
          if (sse.checked) next.type = "sse";
          const map = parsePairs(headers.value, ":");
          if (Object.keys(map).length) next.headers = map;
        }
        next.modes = modeBoxes.filter((b) => b.checked).map((b) => b.value);
        if (autoBox.checked) next.approve = "auto";
        else delete next.approve;
        const servers = { ...layer };
        if (name && name !== id) delete servers[name];
        servers[id] = next;
        if (await this.save(servers)) close();
      };
      const actions = el("div", "ag-modal-actions");
      if (name) {
        actions.append(
          button("Remove", "ag-btn ghost danger", async () => {
            if (!(await app()?.confirm?.(`Remove ${name}? Threads lose its tools from their next session.`, "Remove"))) return;
            const servers = { ...layer };
            delete servers[name];
            if (await this.save(servers)) close();
          })
        );
      }
      actions.append(el("span", "ag-grow"), button("Cancel", "ag-btn", close), button(name ? "Save" : "Add", "ag-btn primary", save));
      panel.append(
        el("h2", "ag-modal-title", name ? `Edit ${name}` : "Add an MCP server"),
        el("p", "ag-modal-hint", this.scope === "global" ? "Applies everywhere." : `Applies in ${this.scope}.`),
        field("Name", nameInput),
        kindTrack,
        commandFields,
        urlFields,
        field("Modes", modes, "Threads in these modes get its tools. Pages covers board workers and page chats."),
        auto,
        error,
        actions
      );
      setTimeout(() => (name ? command : nameInput).focus(), 0);
    },
    /** The chosen layer as JSON, for pasting servers from another app's mcp.json. */
    editJson() {
      const { panel, close } = modal("ag-source ag-mcp-json");
      const text = el("textarea", "ag-input ag-source-models ag-mcp-json-text");
      text.spellcheck = false;
      text.value = JSON.stringify({ mcpServers: this.layer() }, null, 2);
      const error = el("p", "ag-source-error");
      error.hidden = true;
      const save = async () => {
        let parsed;
        try {
          parsed = JSON.parse(text.value);
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          return;
        }
        const servers = parsed && typeof parsed === "object" && parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : parsed;
        if (await this.save(servers || {})) close();
      };
      const actions = el("div", "ag-modal-actions");
      actions.append(el("span", "ag-grow"), button("Cancel", "ag-btn", close), button("Save", "ag-btn primary", save));
      panel.append(
        el("h2", "ag-modal-title", this.scope === "global" ? "Servers everywhere" : `Servers in ${this.scope}`),
        el("p", "ag-modal-hint", 'The usual mcpServers shape, so you can paste from another app\'s mcp.json. Scribe\'s own fields: enabled, modes (code, plan, ask, board) and approve ("ask" or "auto"). Unknown fields are dropped.'),
        text,
        error,
        actions
      );
      setTimeout(() => text.focus(), 0);
    },
    /** A separate, explicit choice after import; never edits Cursor as part of copying. */
    cursorCleanupDialog(items) {
      const { panel, close } = modal("ag-source ag-mcp-import");
      const list = el("div", "ag-mcp-list");
      for (const file of new Set(items.map((c) => c.file))) {
        const row = el("div", "ag-mcp-label");
        row.append(el("code", "ag-mcp-target", file), el("span", null, items.filter((c) => c.file === file).map((c) => c.name).join(", ")));
        list.append(row);
      }
      const error = el("p", "ag-source-error");
      const actions = el("div", "ag-modal-actions");
      const keep = button("Keep Cursor entries", "ag-btn", close);
      const remove = button("Back up and remove Cursor entries", "ag-btn primary", async () => {
        keep.disabled = remove.disabled = true;
        try {
          const { results } = await api("POST", "/mcp/import/cursor-cleanup", { items });
          list.replaceChildren();
          for (const result of results) {
            const row = el("div", "ag-mcp-label");
            row.append(el("code", "ag-mcp-target", result.file));
            if (result.error) row.append(el("p", "ag-source-error", `Left unchanged: ${result.error}`));
            else row.append(el("span", null, `Removed: ${result.names.join(", ")}`));
            if (result.backup) row.append(el("code", "ag-mcp-target", `Backup: ${result.backup}`));
            list.append(row);
          }
          actions.replaceChildren(button("Done", "ag-btn primary", close));
        } catch (err) {
          error.textContent = err.message;
          keep.disabled = remove.disabled = false;
        }
      });
      actions.append(keep, remove);
      panel.append(
        el("h2", "ag-modal-title", "Remove imported entries from Cursor?"),
        el("p", "ag-modal-hint", "Import succeeded. Cursor also loads its own MCP files, which can duplicate these servers and bypass Scribe's mode and approval settings in Full access."),
        el("p", "ag-modal-hint", "This removes only the entries listed below from Cursor's files. They will also stop being available in Cursor outside Scribe. Scribe keeps the imported copies. Each file gets an exact backup beside it before editing."),
        list,
        el("p", "ag-modal-hint", "To undo, copy the backup over its original file. Restart Cursor and start a new Scribe chat to use the changed configuration."),
        error, actions
      );
    },
    /** Pick servers from other apps to copy into Scribe's list. */
    async importDialog() {
      const { panel, close } = modal("ag-source ag-mcp-import");
      const title = () => el("h2", "ag-modal-title", "Import MCP servers");
      panel.append(title(), el("div", "ag-muted", "Looking…"));
      let candidates = [];
      try {
        candidates = await this.findImports();
      } catch (err) {
        panel.replaceChildren(title(), el("p", "ag-source-error", err.message));
        return;
      }
      const picked = new Set();
      const sources = new Set(Object.keys(MCP_SOURCE_LABEL));
      const filter = el("input", "ag-input small ag-grow");
      filter.placeholder = "Filter by name, app, folder or command";
      filter.spellcheck = false;
      const sourceBar = el("div", "ag-mcp-modes");
      const list = el("div", "ag-mcp-list ag-mcp-candidates");
      const count = el("span", "ag-muted");
      const visible = () => {
        const q = filter.value.trim().toLowerCase();
        return candidates.filter((c) => sources.has(c.source) && (!q || [c.name, MCP_SOURCE_LABEL[c.source], c.scope, mcpTarget(c.server)].join(" ").toLowerCase().includes(q)));
      };
      const syncCount = () => (count.textContent = `${picked.size} selected`);
      const renderList = () => {
        list.replaceChildren();
        const shown = visible();
        if (!shown.length) list.append(el("div", "ag-muted", candidates.length ? "Nothing matches." : "No servers found in Claude Code, Cursor, Pi or Codex."));
        for (const c of shown) {
          const box = el("input");
          box.type = "checkbox";
          box.checked = picked.has(c);
          box.addEventListener("change", () => {
            if (box.checked) picked.add(c);
            else picked.delete(c);
            syncCount();
          });
          const row = el("label", "ag-check ag-mcp-candidate");
          const text = el("span", "ag-mcp-label");
          text.append(
            el("strong", null, c.name),
            el("span", "ag-muted", ` · ${MCP_SOURCE_LABEL[c.source]} · ${c.scope === "global" ? "everywhere" : c.scope}${c.exists ? " · replaces Scribe's" : ""}`),
            el("code", "ag-mcp-target", mcpTarget(c.server))
          );
          row.append(box, text);
          list.append(row);
        }
      };
      for (const [id, label] of Object.entries(MCP_SOURCE_LABEL)) {
        if (!candidates.some((c) => c.source === id)) continue;
        const box = el("input");
        box.type = "checkbox";
        box.checked = true;
        box.addEventListener("change", () => {
          if (box.checked) sources.add(id);
          else sources.delete(id);
          renderList();
        });
        const l = el("label", "ag-check");
        l.append(box, el("span", null, label));
        sourceBar.append(l);
      }
      filter.addEventListener("input", renderList);
      const all = (on) => {
        for (const c of visible()) on ? picked.add(c) : picked.delete(c);
        renderList();
        syncCount();
      };
      const run = async () => {
        if (!picked.size) return;
        try {
          this.view = await api("POST", "/mcp/import", { items: [...picked].map((c) => ({ scope: c.scope, name: c.name, server: c.server })) });
        } catch (err) {
          notice(err.message);
          return;
        }
        close();
        this.render();
        notice(`Imported ${picked.size} server${picked.size === 1 ? "" : "s"}.`);
        const cursor = [...picked].filter((c) => c.source === "cursor");
        if (cursor.length) this.cursorCleanupDialog(cursor);
      };
      const tools = el("div", "ag-modal-actions");
      tools.append(filter, button("All", "ag-btn small", () => all(true)), button("None", "ag-btn small", () => all(false)));
      const actions = el("div", "ag-modal-actions");
      actions.append(count, el("span", "ag-grow"), button("Cancel", "ag-btn", close), button("Import", "ag-btn primary", run));
      panel.replaceChildren(
        title(),
        helpHeading("Sources", "From Claude Code (~/.claude.json, .mcp.json), Cursor (~/.cursor/mcp.json, .cursor/mcp.json), Pi (~/.pi) and Codex (~/.codex/config.toml). Workspace servers keep their folder; the other apps' files are left as they are."),
        sourceBar,
        tools,
        list,
        actions
      );
      renderList();
      syncCount();
      setTimeout(() => filter.focus(), 0);
    },
  };

  const agentSettings = {
    categories: null,
    status: null,
    mount() {
      const panel = el("div", "settings-panel");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-labelledby", "ag-settings-title");
      const title = el("h2", "settings-title", "Agent settings");
      title.id = "ag-settings-title";

      const providers = el("section", "settings-section");
      this.status = el("div", "ag-settings-status");
      const actions = el("div", "settings-actions");
      actions.append(
        button("Refresh models", null, async () => {
          for (const provider of PROVIDERS) {
            if (!providerAvailable(provider)) continue;
            const data = await api("GET", `/models?provider=${provider}&refresh=1`).catch(() => null);
            if (data?.models?.length) S.config.models[provider] = data.models;
          }
          notice("Models refreshed");
          requestRender();
        })
      );
      actions.append(
        button("Allowlists…", null, () => {
          this.close();
          allowlists.open();
        })
      );
      actions.append(
        button("MCP servers…", null, () => {
          this.close();
          void mcpServers.open();
        })
      );
      providers.append(
        helpHeading(
          "Providers",
          "Cursor runs through the Cursor SDK (log in below, or set CURSOR_API_KEY); Claude through the Claude Agent SDK (log in below, or set ANTHROPIC_API_KEY); Codex through the Codex SDK (log in below, or set CODEX_API_KEY). Native is Scribe's own harness: OpenAI-compatible endpoints you add as model sources, plus providers whose API key is set in the environment."
        ),
        this.status,
        actions
      );

      const sdks = el("section", "settings-section");
      this.sdkStatus = el("div", "ag-settings-status");
      this.sdkStatus.setAttribute("role", "status");
      this.sdkCheck = button("Check for updates", null, () => void this.renderSdkUpdates(true));
      const sdkActions = el("div", "settings-actions");
      sdkActions.append(this.sdkCheck);
      sdks.append(helpHeading("Agent SDKs", "Compares the installed agent SDKs with npm’s latest releases when you open settings. Results are cached for six hours; Check for updates retries now. To use an update, update Scribe’s dependencies and restart Scribe."), this.sdkStatus, sdkActions);

      const cursor = el("section", "settings-section");
      const hostShell = switchControl(
        () => Boolean(prefs().cursorHostShell),
        () => {
          const on = !prefs().cursorHostShell;
          S.config.prefs = { ...prefs(), cursorHostShell: on };
          api("PUT", "/prefs", { cursorHostShell: on })
            .then((next) => {
              S.config.prefs = next;
              requestRender("chrome");
            })
            .catch((err) => {
              S.config.prefs = { ...prefs(), cursorHostShell: !on };
              hostShell.setAttribute("aria-checked", String(!on));
              notice(err.message);
            });
        }
      );
      cursor.append(
        el("h3", null, "Cursor"),
        settingRow("Ask before shell commands (experimental)", hostShell, {
          id: "ag-cursor-shell-label",
          hint: "The Cursor SDK can't ask you before a tool runs. With this on, Code and Plan threads set to Ask or Edits get Scribe's own shell tool instead of Cursor's: you approve each command, and Scribe runs it outside Cursor's sandbox. File edits still go through Auto-review. Board workers keep Cursor's shell. Applies from a thread's next message.",
        })
      );

      const helpers = el("section", "settings-section");
      const helpersOn = switchControl(
        () => prefs().helpers !== false,
        () => {
          const on = prefs().helpers === false;
          S.config.prefs = { ...prefs(), helpers: on };
          api("PUT", "/prefs", { helpers: on })
            .then((next) => {
              S.config.prefs = next;
            })
            .catch((err) => {
              S.config.prefs = { ...prefs(), helpers: !on };
              helpersOn.setAttribute("aria-checked", String(!on));
              notice(err.message);
            });
        }
      );
      helpers.append(
        el("h3", null, "Helper agents"),
        settingRow("Agents can hand tasks to other models", helpersOn, {
          id: "ag-helpers-label",
          hint: "When you tell an agent to, it can give a task to another provider or model, such as one you host yourself, and check the result. The helper is a thread of its own in the same folder, with the same mode and permissions. You are asked before each new helper unless the thread has Full access.",
        })
      );
      const forkSummaries = el("section", "settings-section");
      forkSummaries.append(helpHeading("Summary models", "Choose a model for summaries written by Scribe, including forks and Native context compaction. Claude, Codex, and Cursor manage their own context compaction, including provider /compact commands; this setting does not apply to those summaries."));
      this.forkSummaryRows = el("div");
      forkSummaries.append(this.forkSummaryRows);
      this.forkSummarizers = new Map();
      const utilities = el("section", "settings-section");
      utilities.append(el("h3", null, "Utility agent"), settingRow("Main utility agent", this.summarizerButton(), {
        id: "ag-summarizer-label",
        hint: "Handles palette AI search. If unavailable or out of usage, tries Cursor, Claude, Codex, then Native using their fork-summary models (or their last chat model when no summary model is set).",
      }));

      const memory = el("section", "settings-section");
      const memoryOn = switchControl(
        () => prefs().memory !== false,
        () => {
          const on = prefs().memory === false;
          S.config.prefs = { ...prefs(), memory: on };
          api("PUT", "/prefs", { memory: on })
            .then((next) => {
              S.config.prefs = next;
            })
            .catch((err) => {
              S.config.prefs = { ...prefs(), memory: !on };
              memoryOn.setAttribute("aria-checked", String(!on));
              notice(err.message);
            });
        }
      );
      const memoryActions = el("div", "settings-actions");
      memoryActions.append(
        button("Memories…", null, () => {
          this.close();
          memoryDialog.open();
        })
      );
      memory.append(
        el("h3", null, "Memory"),
        settingRow("Agents share memories", memoryOn, {
          id: "ag-memory-label",
          hint: "Chats on every provider get the saved memories in their instructions and can save new ones: corrections you gave, mistakes to avoid, facts about a project. Each save shows as a note in that chat. Off, chats get none and cannot save any; the saved ones are kept. Applies from a thread's next message.",
        }),
        memoryActions
      );

      const sources = el("section", "settings-section");
      this.sources = el("div", "ag-sources");
      const sourceActions = el("div", "settings-actions");
      sourceActions.append(button("Add source…", null, () => editSource(null)));
      sources.append(
        helpHeading(
          "Model sources",
          "OpenAI-compatible endpoints (OpenRouter, LM Studio, Ollama, vLLM, llama.cpp…) for the native harness. Native also offers the models of providers whose API key is set in the environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, …)."
        ),
        this.sources,
        sourceActions
      );

      const usage = el("section", "settings-section");
      this.usage = el("div", "ag-usage-list");
      usage.append(el("h3", null, "Plan usage"), this.usage);
      for (const [provider, label] of [["claude", "Claude (Haiku)"], ["codex", "Codex (Luna)"]]) {
        const control = switchControl(
          () => Boolean(prefs().usageWindowStarts?.[provider]),
          () => {
            const before = { claude: false, codex: false, ...prefs().usageWindowStarts };
            const next = { ...before, [provider]: !before[provider] };
            S.config.prefs = { ...prefs(), usageWindowStarts: next };
            api("PUT", "/prefs", { usageWindowStarts: next })
              .then((saved) => { S.config.prefs = saved; })
              .catch((err) => {
                S.config.prefs = { ...prefs(), usageWindowStarts: before };
                control.setAttribute("aria-checked", String(before[provider]));
                notice(err.message);
              });
          }
        );
        usage.append(settingRow(`Start the next 5-hour window · ${label}`, control, {
          id: `ag-window-start-${provider}`,
          hint: "While Scribe is running, send a short hello ten minutes after the provider's reported five-hour reset. Uses a little subscription usage, with no chat or workspace context. Skips ongoing work, exhausted weekly usage and unavailable subscription access; failed sends are not retried for that window.",
        }));
      }

      const chat = el("section", "settings-section");
      chat.append(
        el("h3", null, "Chat"),
        settingRow(
          "Agent button in the top bar",
          switchControl(
            () => localStorage.getItem(LS.button) !== "0",
            () => {
              localStorage.setItem(LS.button, localStorage.getItem(LS.button) === "0" ? "1" : "0");
              applyButton();
            }
          ),
          { id: "ag-button-label" }
        ),
        settingRow(
          "Suggestions in a new thread",
          switchControl(
            () => localStorage.getItem(LS.tips) !== "0",
            () => {
              localStorage.setItem(LS.tips, localStorage.getItem(LS.tips) === "0" ? "1" : "0");
              for (const view of views()) if (!view.thread() || !S.details.get(view.threadId)?.items.length) view.renderTranscript();
            }
          ),
          { id: "ag-tips-label" }
        ),
        settingRow(
          "Presets in a new thread",
          switchControl(
            () => localStorage.getItem(LS.presets) !== "0",
            () => {
              localStorage.setItem(LS.presets, localStorage.getItem(LS.presets) === "0" ? "1" : "0");
              for (const view of views()) if (!view.thread()) view.renderTranscript();
            }
          ),
          {
            id: "ag-presets-label",
            hint: "An empty chat lists the page in front (Pages mode, full web, scoped to that page) and your workspaces (Code mode, Auto review, limited web, no worktree). Picking one sets the new thread up that way.",
          }
        ),
        settingRow(
          "Compact thread list",
          switchControl(
            () => compactThreads(),
            () => {
              localStorage.setItem(LS.compact, compactThreads() ? "0" : "1");
              renderLists();
            }
          ),
          { id: "ag-compact-label", hint: "Each thread shows only its title and status dot, in a smaller font with less spacing." }
        ),
        settingRow(
          "Show reasoning expanded",
          switchControl(
            () => localStorage.getItem(LS.reasoning) === "1",
            () => {
              localStorage.setItem(LS.reasoning, localStorage.getItem(LS.reasoning) === "1" ? "0" : "1");
              requestRender();
            }
          ),
          { id: "ag-reasoning-label" }
        ),
        settingRow(
          "Send messages with",
          choiceTrack(SEND_KEY, sendKey, (id) => {
            localStorage.setItem(LS.sendKey, id);
            for (const view of views()) view.renderComposerBar();
          }),
          {
            id: "ag-send-key-label",
            hint: "Shift+Enter always inserts a line break. Ctrl+Enter always sends.",
          }
        ),
        settingRow(
          "Enter on an empty box sends a queued message",
          choiceTrack(EMPTY_ENTER, emptyEnter, (id) => {
            localStorage.setItem(LS.emptyEnter, id);
            for (const view of views()) view.renderTranscript();
          }),
          {
            id: "ag-empty-enter-label",
            hint: "While the agent works. Steer hands it to the running turn, which reads it at the next safe stop; pressing Enter again stops the turn and sends it. Send now always stops the turn and sends it.",
          }
        )
      );

      const hooks = el("section", "settings-section");
      this.hookList = el("div", "ag-hook-rules");
      const hookActions = el("div", "settings-actions");
      hookActions.append(button("Add rule", "ag-btn", () => editHookRule(null)));
      hooks.append(
        helpHeading(
          "Hooks",
          "A rule watches every chat: your messages, the agent's text and thinking, its tool calls and their results. When it matches it can mark the item, tell the agent something, have you approve the tool call, or block it. A rule only ever tightens what a thread may do. Turn them off for one thread from its menu."
        ),
        this.hookList,
        hookActions
      );
      const coverage = el("section", "settings-section");
      this.hookCoverage = el("div", "ag-hook-coverage");
      coverage.append(
        helpHeading(
          "What a hook can hold",
          "Ask and Block act before a tool call runs only where the provider lets Scribe hold the call. A call that is only seen is already running: Block then stops the turn, and Ask can only mark the call."
        ),
        this.hookCoverage
      );

      const keys = el("section", "settings-section");
      const modeTrack = el("div", "button-track text-track");
      modeTrack.setAttribute("role", "group");
      this.modeButtons = new Map();
      for (const mode of MODES) {
        const control = button(mode.label, null, () => void this.toggleCycleMode(mode.id));
        this.modeButtons.set(mode.id, control);
        modeTrack.append(control);
      }
      this.renderCycleModes();
      chat.append(settingRow("Mode cycling", modeTrack, {
        id: "ag-cycle-modes-label",
        hint: "Choose which modes Ctrl+Shift+' cycles through. All modes remain available in the mode selector. With every button off, the hotkey leaves the current mode unchanged.",
      }));
      const list = el("div", "ag-keys");
      for (const [combo, what] of KEYS) list.append(el("kbd", null, combo), el("span", null, what));
      keys.append(el("h3", null, "Keys"), list);

      panel.append(title, providers, sdks, cursor, helpers, forkSummaries, memory, hooks, coverage, sources, usage, chat, keys);
      this.categories = window.scribeSettingsUI.mount(panel, [
        { label: "Providers", sections: [providers, sdks, cursor, sources, usage] },
        { label: "Chat", sections: [chat] },
        { label: "Memory", sections: [memory] },
        { label: "Helpers & utilities", sections: [helpers, utilities, forkSummaries] },
        { label: "Hooks", sections: [hooks, coverage] },
        { label: "Keys", sections: [keys] },
      ], {
        close: () => this.close(),
        before: { label: "← General settings", run: () => app()?.openSettings?.() },
        // The full panel on what chats are given and how they use it (harness.js).
        after: { label: "Agent harness →", run: () => {
          this.close();
          window.scribeHarness?.open();
        } },
      });

    },
    /** The Hooks category: the user's rules, and what each provider lets a rule hold. */
    async renderHooks() {
      let view;
      try {
        view = await api("GET", "/hooks");
      } catch (err) {
        this.hookList.replaceChildren(el("div", "ag-muted", err.message));
        return;
      }
      S.config.prefs = { ...prefs(), hookRules: view.rules };
      this.hookList.replaceChildren();
      if (!view.rules.length) this.hookList.append(el("div", "ag-muted", "None yet."));
      for (const rule of view.rules) {
        const row = el("div", "setting-row ag-hook-rule");
        const label = el("span", "ag-hook-text");
        const needsClassifier = rule.match === "question" && !view.classifier;
        label.append(
          el("strong", null, rule.pattern),
          el("span", "ag-muted", ` · ${HOOK_MATCH[rule.match]} · ${HOOK_EVENT[rule.event]} · ${HOOK_ACTION[rule.action].label}${needsClassifier ? " · needs a classifier (General settings)" : ""}`)
        );
        const on = switchControl(
          () => rule.enabled,
          () => {
            rule.enabled = !rule.enabled;
            void saveHookRules(view.rules).catch((err) => {
              notice(err.message);
              void this.renderHooks();
            });
          }
        );
        on.setAttribute("aria-label", `Rule ${rule.pattern}`);
        row.append(label, on, button("Edit", "ag-btn small", () => editHookRule(rule, view.rules)));
        this.hookList.append(row);
      }
      const table = el("table", "ag-hook-table");
      const head = el("tr");
      head.append(el("th", null, "Provider"), el("th", null, "Held before it runs"), el("th", null, "Only seen"));
      table.append(head);
      for (const row of view.coverage) {
        const tr = el("tr");
        tr.append(el("th", null, row.label), el("td", null, row.held), el("td", row.observed ? null : "ag-muted", row.observed || "Nothing"));
        table.append(tr);
      }
      this.hookCoverage.replaceChildren(table);
    },
    renderCycleModes() {
      for (const [id, control] of this.modeButtons || []) {
        control.setAttribute("aria-pressed", String(!(prefs().disabledModes || []).includes(id)));
      }
    },
    async toggleCycleMode(id) {
      const disabled = prefs().disabledModes || [];
      const disabledModes = disabled.includes(id) ? disabled.filter((mode) => mode !== id) : [...disabled, id];
      for (const control of this.modeButtons.values()) control.disabled = true;
      try {
        S.config.prefs = await api("PUT", "/prefs", { disabledModes });
      } catch (err) {
        notice(err.message);
      } finally {
        this.renderCycleModes();
        for (const control of this.modeButtons.values()) control.disabled = false;
      }
    },
    renderStatus() {
      this.status.replaceChildren();
      for (const p of S.config.providers) {
        const row = el("div", "setting-row");
        const label = el("span");
        label.append(el("strong", null, p.label), el("span", "ag-muted", ` · ${p.detail || ""}`));
        row.append(label);
        if (p.login && !p.available) {
          row.append(
            button("Log in", "ag-btn", async () => {
              try {
                const res = await api("POST", `/${p.id}/login`);
                if (res?.url) window.open(res.url, "_blank", "noopener");
                notice("Finish the login in your browser.");
                // The login finishes in the daemon; pick it up when it does.
                for (let i = 0; i < 100; i += 1) {
                  await new Promise((resolve) => setTimeout(resolve, 3000));
                  await loadConfig();
                  if (providerAvailable(p.id)) break;
                }
                agentSettings.renderStatus();
                requestRender();
              } catch (err) {
                notice(err.message);
              }
            })
          );
        } else {
          row.append(el("span", p.available ? "ag-tag ok" : "ag-tag", p.available ? "Ready" : "Unavailable"));
        }
        this.status.append(row);
      }
    },
    async renderSdkUpdates(refresh = false) {
      if (this.sdkCheck.disabled) return;
      this.sdkCheck.disabled = true;
      this.sdkStatus.replaceChildren(el("div", "ag-muted", "Checking SDK versions…"));
      try {
        const report = await api("GET", `/sdk-updates${refresh ? "?refresh=1" : ""}`);
        this.sdkStatus.replaceChildren();
        for (const sdk of report.sdks) {
          const row = el("div", "setting-row");
          const label = el("span");
          label.append(el("strong", null, sdk.label), el("span", "ag-muted", ` · ${sdk.installed || "Version unknown"}${sdk.latest ? ` · latest ${sdk.latest}` : ""}`));
          const text = sdk.error || (sdk.outdated ? "Update available" : "Up to date");
          row.append(label, el("span", sdk.outdated === false ? "ag-tag ok" : "ag-tag", text));
          this.sdkStatus.append(row);
        }
        this.sdkStatus.append(el("div", "ag-muted", `Checked ${new Date(report.checkedAt).toLocaleString()}`));
        if (report.sdks.some((sdk) => sdk.outdated)) this.sdkStatus.append(el("div", "ag-muted", "Update Scribe’s dependencies, then restart Scribe to use the newer SDKs."));
      } catch (err) {
        this.sdkStatus.replaceChildren(el("div", "ag-muted", `SDK check failed: ${err.message}`));
      } finally {
        this.sdkCheck.disabled = false;
      }
    },
    async renderSources() {
      if (!this.sources) return;
      let list = [];
      try {
        list = (await api("GET", "/model-sources")).sources || [];
      } catch (err) {
        this.sources.replaceChildren(el("div", "ag-muted", err.message));
        return;
      }
      this.sources.replaceChildren();
      if (!list.length) this.sources.append(el("div", "ag-muted", "None yet."));
      for (const source of list) {
        const row = el("div", "setting-row");
        const label = el("span");
        const models = source.models.length ? `${source.models.length} model${source.models.length === 1 ? "" : "s"}` : "models from the endpoint";
        label.append(el("strong", null, source.name), el("span", "ag-muted", ` · ${source.baseUrl} · ${models}${source.hasKey ? "" : " · no key"}`));
        row.append(label, button("Edit", "ag-btn small", () => editSource(source)));
        this.sources.append(row);
      }
    },
    isOpen() {
      return Boolean(this.categories?.isOpen());
    },
    renderUsage() {
      if (!this.usage || !this.isOpen()) return;
      this.usage.replaceChildren(...["claude", "codex", "cursor"].filter((p) => S.config.providers.some((x) => x.id === p)).map(usageMeters));
      for (const provider of ["claude", "codex"]) {
        const activity = S.config.limits?.[provider]?.windowStart;
        if (!activity?.result) continue;
        this.usage.append(el("div", "ag-muted", `${provider === "claude" ? "Claude" : "Codex"} window start: ${activity.result}`));
      }
    },
    forkSummarizerButton(provider) {
      const b = el("button", "ag-pill ag-summarizer");
      b.type = "button";
      b.setAttribute("aria-label", `${PROVIDER_LABEL[provider] || provider} summary model`);
      this.forkSummarizers.set(provider, b);
      b.addEventListener("click", () => {
        const saved = prefs().forkSummarizers?.[provider];
        const cur = typeof saved === "string" ? { provider, model: saved } : saved;
        const save = async (model) => {
          try {
            S.config.prefs = await api("PUT", "/prefs", { forkSummarizers: { [provider]: model } });
            this.renderSummarizer();
          } catch (err) { notice(err.message); }
        };
        const items = [{ label: "Use chat's model", checked: !cur, run: () => save(null) }];
        for (const source of [provider, ...PROVIDERS.filter(p => p !== provider && providerAvailable(p))]) {
          items.push({ header: PROVIDER_LABEL[source] || source });
          items.push(...modelMenuItems(source, modelsOf(source), (m) => ({
            label: m.label,
            detail: m.id !== m.label ? m.id : m.description,
            search: `${source} ${m.id}`,
            checked: cur?.provider === source && cur?.model === m.id,
            run: () => save({ provider: source, model: m.id }),
          })));
        }
        openMenu(b, items, { search: true, width: 300, placeholder: "Search models" });
      });
      return b;
    },
    /** The palette's AI search model; picks from every available provider's models. */
    summarizerButton() {
      const b = el("button", "ag-pill ag-summarizer");
      b.type = "button";
      this.summarizer = b;
      b.setAttribute("aria-label", "Main utility agent");
      b.addEventListener("click", () => {
        const cur = prefs().summarizer || {};
        const items = [];
        for (const provider of PROVIDERS) {
          if (!providerAvailable(provider)) continue;
          items.push(...modelMenuItems(provider, modelsOf(provider), (m) => ({
            label: m.label,
            detail: m.id !== m.label ? m.id : m.description,
            search: `${provider} ${PROVIDER_LABEL[provider] || ""} ${m.id}`,
            checked: cur.provider === provider && cur.model === m.id,
            run: async () => {
              try {
                S.config.prefs = await api("PUT", "/prefs", { summarizer: { provider, model: m.id } });
                this.renderSummarizer();
              } catch (err) {
                notice(err.message);
              }
            },
          })));
        }
        openMenu(b, items, { search: true, width: 300, placeholder: "Search models" });
      });
      this.renderSummarizer();
      return b;
    },
    renderSummarizer() {
      // Settings mount before config arrives; provider rows must follow later loads too.
      if (this.forkSummaryRows) {
        for (const [provider, b] of this.forkSummarizers) {
          if (providerAvailable(provider)) continue;
          b.closest(".setting-row").remove();
          this.forkSummarizers.delete(provider);
        }
        for (const provider of PROVIDERS) {
          if (!providerAvailable(provider)) continue;
          const b = this.forkSummarizers.get(provider) || this.forkSummarizerButton(provider);
          const row = b.closest(".setting-row") || settingRow(PROVIDER_LABEL[provider] || provider, b, {
            id: `ag-fork-summarizer-${provider}-label`,
            hint: "Choose a model for summaries of chats using this provider, or use the chat's own model.",
          });
          this.forkSummaryRows.append(row);
        }
      }
      for (const [provider, b] of this.forkSummarizers || []) {
        const saved = prefs().forkSummarizers?.[provider];
        const choice = typeof saved === "string" ? { provider, model: saved } : saved;
        b.replaceChildren(providerIcon(choice?.provider || provider), el("span", null, choice ? modelInfo(choice.provider, choice.model)?.label || choice.model : "Use chat's model"));
      }
      if (!this.summarizer) return;
      const cur = prefs()?.summarizer;
      this.summarizer.replaceChildren();
      if (!cur) return;
      this.summarizer.append(providerIcon(cur.provider), el("span", null, modelInfo(cur.provider, cur.model)?.label || cur.model));
    },
    open() {
      if (!this.categories) return;
      this.renderStatus();
      this.renderCycleModes();
      void this.renderSources();
      void this.renderHooks();
      this.renderSummarizer();
      this.categories.open();
      this.renderUsage();
      void this.renderSdkUpdates();
    },
    close() {
      if (!this.isOpen()) return false;
      this.categories.close();
      hideHoverTip();
      return true;
    },
  };

  /* ---------- board.agent: pages that start and continue their own threads ---------- */

  const PAGE_PROMPT_MAX = 20000;
  const PAGE_MODES = new Set(["board", "ask", "code", "plan"]);
  /** Modes with file and shell access: the page needs the folder approved (agent.workspace). */
  const FOLDER_MODES = new Set(["code", "plan"]);
  /** board.agent.wait calls by thread id. */
  const pageWaiters = new Map();
  /** When a page last sent to each thread: until the thread has been active since, it is not done with it. */
  const pageSentAt = new Map();

  function ownedBy(tab, t) {
    return Boolean(t && t.scope.kind === "page" && t.scope.ref === tab.id);
  }

  /** Page threads whose live steps a page asked for (board.agent.steps), with a pending push timer. */
  const pageStepWatch = new Map();
  const pageLimitWatch = new Set();

  function pageLimits() {
    return Object.fromEntries(Object.keys(S.config.limits || {}).map((provider) => [provider, planLimits(provider)]));
  }

  function pageLimitsChanged() {
    const open = new Set((app()?.tabs?.() || []).map((tab) => tab.id));
    for (const id of pageLimitWatch) {
      if (!open.has(id)) { pageLimitWatch.delete(id); continue; }
      app()?.postToPage?.(id, { type: "scribe-agent-limits", limits: pageLimits() });
    }
  }
  const PAGE_STEPS = 4;

  /** The running turn's last few steps, as the collapsed dock shows them: [{ key, kind, text }]. Empty once it stops. */
  function pageSteps(id) {
    const t = S.threads.get(id);
    const detail = S.details.get(id);
    if (!t || t.status !== "running" || !detail) return [];
    const turn = [...detail.turns.values()].find((x) => x.status === "running");
    if (!turn) return [];
    const steps = [];
    for (const item of detail.items) {
      if (item.turnId !== turn.id || item.parentToolId) continue;
      const step = liveStep(item);
      if (step?.text) steps.push({ key: item.id, kind: step.kind, text: String(step.text).slice(0, 220) });
    }
    return steps.slice(-PAGE_STEPS);
  }

  /** Push a watched thread's steps to its page, at most a few times a second while text streams in. */
  function pageStepsChanged(id) {
    if (!pageStepWatch.has(id) || pageStepWatch.get(id)) return;
    pageStepWatch.set(
      id,
      setTimeout(() => {
        if (!pageStepWatch.has(id)) return;
        pageStepWatch.set(id, null);
        const t = S.threads.get(id);
        if (t?.scope.kind === "page") app()?.postToPage?.(t.scope.ref, { type: "scribe-agent-steps", threadId: id, steps: pageSteps(id) });
      }, 250)
    );
  }

  function pageBrief(t) {
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      queued: t.queued || 0,
      activityAt: t.activityAt,
      ...(t.finishedAt ? { finishedAt: t.finishedAt } : {}),
      mode: t.mode,
      provider: t.provider,
      model: t.model,
      effort: t.effort,
      ...(FOLDER_MODES.has(t.mode) ? { cwd: pageFolder(t), approval: t.approval } : {}),
      // As of its last turn, so a board can tell a finished chat whose branch is still unmerged.
      ...(openWorktree(t) ? { worktree: { branch: t.worktree.branch, ahead: t.worktree.ahead || 0, dirty: Boolean(t.worktree.dirty) } } : {}),
      ...(t.usage ? { usage: t.usage } : {}),
      // While Scribe sees the thread through for the page (start's run option, or watch), and once that ended.
      ...(t.run ? { run: t.run } : {}),
    };
  }

  /** start's run option and watch's settings, as the daemon takes them. */
  function pageRunInput(run) {
    const src = run && typeof run === "object" && !Array.isArray(run) ? run : {};
    return {
      ...(typeof src.tag === "string" ? { tag: src.tag } : {}),
      ...(src.data && typeof src.data === "object" && !Array.isArray(src.data) ? { data: src.data } : {}),
      ...(src.merge === false ? { merge: false } : {}),
      ...(typeof src.resumePrompt === "string" ? { resumePrompt: src.resumePrompt.slice(0, PAGE_PROMPT_MAX) } : {}),
      ...(typeof src.after === "number" && Number.isFinite(src.after) ? { after: src.after } : {}),
    };
  }

  /** The folder a page's Code or Plan thread was approved for: the picked folder, not its worktree. */
  function pageFolder(t) {
    return t.worktree?.home || t.cwd || null;
  }

  /** The text of the latest turn's replies. */
  async function lastReply(id) {
    const detail = await ensureDetail(id);
    if (!detail) return "";
    const turns = [...detail.turns.values()].sort((a, b) => b.seq - a.seq);
    const turn = turns.find((x) => x.status !== "running") || turns[0];
    if (!turn) return "";
    return detail.items
      .filter((it) => it.kind === "text" && it.turnId === turn.id && !it.parentToolId)
      .map((it) => it.text)
      .join("\n\n")
      .trim();
  }

  /**
   * Show a thread in the sidebar or the floating chat. `reveal` (the user clicked for it) also clears
   * whatever would hide it: an open menu, the sidebar's thread list, and the full window, which shows it instead.
   * Without it (background starts and sends) nothing the user has open is closed.
   */
  function showPageThread(id, where, { reveal = false } = {}) {
    if (CHAT) {
      if (reveal) {
        closeMenu();
        setCurrent(id);
        full.view.setThread(id);
        full.renderList();
        full.view.focus();
      }
      return;
    }
    if (SOLO && where === "sidebar") where = "dock";
    if (reveal) {
      closeMenu();
      setCurrent(id);
      if (S.fullOpen && where === "sidebar") {
        full.view.setThread(id);
        full.renderList();
        full.view.focus();
        return;
      }
    }
    if (where === "sidebar") {
      if (!S.sideOpen) sidebar.setOpen(true);
      sidebar.view.setThread(id);
      if (reveal && sidebar.listOpen) sidebar.toggleList();
    } else if (where === "dock") {
      if (id !== dock.view.threadId) dock.pick(id);
      if (!S.dockShown) dock.setShown(true);
    }
  }

  /** A user's "open thread" click from a page, card, link, toast, or the palette. */
  function openThread(id) {
    const thread = S.threads.get(id);
    if (!thread || thread.archived) return false;
    showPageThread(id, "sidebar", { reveal: true });
    return true;
  }

  window.scribePopout?.onRequest((request) => {
    if (SOLO) return;
    if (request?.type === "open-thread" && typeof request.id === "string") {
      openThread(request.id);
    } else if (request?.type === "chat-return" && request.chat) {
      takeChatBack(request.chat);
    }
  });

  /** The chat as another window can show it: attached files stay in this window's composer. */
  function chatForWindow(view) {
    const content = view.composerContent();
    const shown = Boolean(view.threadId || view.draft);
    return {
      threadId: shown ? view.threadId : S.current && S.threads.has(S.current) ? S.current : null,
      draft: view.threadId || !view.draft ? null : { scope: { ...view.draft.scope }, settings: { ...view.draft.settings } },
      composer: content && (content.text.trim() || content.mentions.length) ? { text: content.text, mentions: content.mentions } : null,
    };
  }

  /** What another window handed over, as giveChat takes it. A thread this window does not know opens a new one. */
  function chatFromWindow(chat) {
    const threadId = typeof chat?.threadId === "string" && S.threads.has(chat.threadId) && !S.threads.get(chat.threadId).archived ? chat.threadId : null;
    return { threadId, draft: threadId ? null : chat?.draft || null, composer: chat?.composer || null };
  }

  /**
   * Move the sidebar or full window chat to a window of its own. The chat closes here; its thread
   * stays in the sidebar for when that is opened again.
   */
  function popOutChat() {
    closeMenu();
    const view = S.fullOpen ? full.view : sidebar.view;
    if (!window.scribePopout.openChat(chatForWindow(view))) {
      notice("The browser blocked the new window. Allow pop-ups for Scribe to open the chat in its own window.");
      return;
    }
    // What was written went along; attached files cannot, and wait here.
    view.input.value = "";
    view.mentions = [];
    view.autosize();
    view.renderContext();
    if (S.fullOpen) {
      const snap = full.view.takeChat();
      fullFrom = null;
      full.close();
      sidebar.view.giveChat(snap);
    }
    if (S.sideOpen) sidebar.setOpen(false);
  }

  /** The chat window: give the chat back to the main window and close. */
  function returnChatToMain() {
    window.scribePopout.request({ type: "chat-return", chat: chatForWindow(full.view) });
    window.scribePopout.focusMain();
    window.scribePopout.closeSelf();
  }

  /** The main window: the chat window's chat comes back to the full window when that is open, else the sidebar. */
  function takeChatBack(chat) {
    const snap = chatFromWindow(chat);
    closeMenu();
    if (snap.threadId) setCurrent(snap.threadId);
    if (S.fullOpen) {
      full.view.giveChat(snap);
      full.renderList();
      full.view.focus();
      return;
    }
    sidebar.view.closeHelper();
    sidebar.view.giveChat(snap);
    if (sidebar.listOpen) sidebar.toggleList();
    sidebar.setOpen(true);
  }

  window.scribePopout?.onTell((message) => {
    if (CHAT && message?.type === "chat" && message.chat) {
      const snap = chatFromWindow(message.chat);
      if (snap.threadId) setCurrent(snap.threadId);
      full.view.giveChat(snap);
      full.renderList();
      full.view.focus();
    }
  });

  /** Palette (`=` prefix) and anything else that wants the same match as the thread-menu search. */
  function searchThreads(query, { limit = 40 } = {}) {
    const q = String(query || "").trim();
    let threads = [...S.threads.values()].filter((t) => !t.archived);
    // A helper is reached through the thread that started it. A search finds it, named as that thread's helper.
    if (!q) {
      const hidden = hiddenWorkspaceKeys();
      threads = threads.filter((t) => !nestsUnder(t) && !inHiddenWorkspace(t, hidden));
    }
    return rankedThreads(threads, q).slice(0, limit).map(({ thread: t, match }) => {
      const scope = scopeLabel(t.scope);
      const running = t.status === "running" || (t.status === "idle" && t.background);
      const parent = nestsUnder(t) ? S.threads.get(t.helperOf) : null;
      return {
        kind: "thread",
        id: t.id,
        title: parent ? helperName(t) : t.title,
        snippet: match.snippet || (parent ? parent.title : scope.text && scope.text !== "Global" ? scope.text : ""),
        locationLabel: parent ? "Helper" : "Thread",
        location: "thread",
        qualityLabel: running ? "Running" : "",
        open: t.id === S.current,
      };
    });
  }

  function threadTitle(id) {
    const thread = S.threads.get(id);
    return thread && !thread.archived ? thread.title : null;
  }

  /** Tell the page about its thread's status changes, and settle board.agent.wait calls once it is idle. */
  function pageThreadChanged(t, prev) {
    if (t.scope.kind !== "page" || !t.scope.ref) return;
    if (prev && prev.status === t.status && prev.title === t.title && prev.queued === t.queued && JSON.stringify(prev.run || null) === JSON.stringify(t.run || null)) return;
    const settle = t.status === "idle" && !t.queued;
    const send = (reply) => app()?.postToPage?.(t.scope.ref, { type: "scribe-agent-event", thread: { ...pageBrief(t), ...(reply !== undefined ? { reply } : {}) } });
    if (!settle) {
      send();
      return;
    }
    void lastReply(t.id).then((reply) => {
      send(reply);
      for (const waiter of pageWaiters.get(t.id) || []) waiter(reply);
      pageWaiters.delete(t.id);
    });
  }

  function waitIdle(id, timeoutMs) {
    return new Promise((resolve) => {
      const list = pageWaiters.get(id) || [];
      const done = (reply) => {
        clearTimeout(timer);
        resolve({ ok: true, reply });
      };
      const timer = setTimeout(() => {
        const rest = (pageWaiters.get(id) || []).filter((w) => w !== done);
        if (rest.length) pageWaiters.set(id, rest);
        else pageWaiters.delete(id);
        resolve({ ok: false, error: "timeout" });
      }, Math.min(Math.max(Number(timeoutMs) || 600000, 1000), 6 * 3600 * 1000));
      list.push(done);
      pageWaiters.set(id, list);
    });
  }

  /**
   * Whether `tab` may start, send, or stop now: agent.chat always, and agent.unattended when the
   * click or key press did not reach the board. scribePermissions asks the user when undecided.
   */
  async function pageMayWrite(tab, activated) {
    const perms = window.scribePermissions;
    if (!perms) return activated ? { ok: true } : { ok: false, error: "no_gesture" };
    const chat = await perms.ensure(tab, { perm: "agent.chat" });
    if (!chat.ok || activated) return chat;
    return perms.ensure(tab, { perm: "agent.unattended" });
  }

  /** Code and Plan threads need their folder approved for the page, at this approval or a looser one. */
  function pageMayUseFolder(tab, folder, approval) {
    const perms = window.scribePermissions;
    if (!perms) return { ok: false, error: "denied", permission: "agent.workspace" };
    return perms.ensure(tab, { perm: "agent.workspace", folder, approval });
  }

  /** What scribe.agent.start can pick from. */
  async function pageOptions() {
    const p = prefs();
    const available = S.config.providers.filter((x) => x.available);
    await Promise.all(
      available
        .filter((x) => !modelsOf(x.id).length)
        .map((x) =>
          api("GET", `/models?provider=${x.id}`)
            .then((data) => {
              if (data.models?.length) S.config.models[x.id] = data.models;
            })
            .catch(() => undefined)
        )
    );
    const provider = providerAvailable(p.provider) ? p.provider : available[0]?.id || null;
    const defaultChoice = provider ? modelChoice(provider, p.models?.[provider] || "default", p) : null;
    return {
      ok: true,
      providers: S.config.providers.map((x) => ({ id: x.id, label: x.label, available: Boolean(x.available) })),
      models: Object.fromEntries(
        available.map((x) => [
          x.id,
          modelsOf(x.id).map((m) => ({
            id: m.id,
            label: m.label,
            efforts: m.efforts || [],
            defaultEffort: m.defaultEffort ?? null,
            params: (m.params || []).map((param) => ({
              id: param.id,
              label: param.label,
              description: param.description || "",
              options: (param.options || []).map((o) => ({ id: o.id, label: o.label })),
              default: param.default || "",
            })),
          })),
        ])
      ),
      modes: MODES.map((m) => ({ id: m.id, label: m.label, detail: m.detail, needsFolder: FOLDER_MODES.has(m.id) })),
      // The user's own modes: start a thread in one with customMode, next to the mode it is based on.
      customModes: customModes().map((m) => ({ id: m.id, label: m.name, detail: m.description || customDetail(m, m.base), base: m.base })),
      approvals: APPROVALS.map((a) => ({ id: a.id, label: a.label, detail: a.detail })),
      defaults: provider
        ? {
            provider,
            model: p.models?.[provider] || "default",
            effort: defaultChoice.effort,
            approval: approvalFor(provider, p),
            web: webMode(p.web),
            fast: defaultChoice.modelParams.fast === "true",
          }
        : null,
    };
  }

  /** Same provider preference as Kanban board workerDefaults (templates/builtin/kanban.html). */
  const AGENT_ACTION_PROVIDER_PREF = ["cursor", "codex", "claude", "pi"];

  /**
   * Settings passed to pageThreadSettings for a template agent action (triage, break down, …).
   * Without an explicit provider or non-default model, uses fixed economical defaults instead of the
   * user's last chat model (which is often a heavy coding model).
   */
  function agentActionThreadInput(thread) {
    const t = thread && typeof thread === "object" ? thread : {};
    const mode = t.mode || "board";
    const hasOwn = Boolean(t.provider) || Boolean(t.model && t.model !== "default");
    if (hasOwn) return { ...t, mode };
    const available = S.config.providers.filter((p) => p.available).map((p) => p.id);
    const provider = AGENT_ACTION_PROVIDER_PREF.find((id) => available.includes(id)) || available[0];
    if (!provider) return { ...t, mode };
    const out = {
      mode,
      provider,
      model: provider === "cursor" ? "composer-2.5" : "default",
      approval: "auto",
      web: t.web || "off",
      fast: t.fast !== undefined ? t.fast : false,
    };
    if (t.title) out.title = t.title;
    if (t.effort) out.effort = t.effort;
    return out;
  }

  /** The new thread's settings from scribe.agent.start options, or { error }. Unset ones follow the user's defaults. */
  function pageThreadSettings(data) {
    const p = prefs();
    let provider = providerAvailable(p.provider) ? p.provider : S.config.providers.find((x) => x.available)?.id;
    if (data.provider) {
      if (!providerAvailable(data.provider)) return { error: "unknown_provider" };
      provider = data.provider;
    }
    if (!provider) return { error: "no_provider" };
    const mode = data.mode || "board";
    if (!PAGE_MODES.has(mode)) return { error: "unknown_mode" };
    // A custom mode that is gone, or built on another mode, is refused: starting without its limits would be worse.
    const custom = typeof data.customMode === "string" && data.customMode ? customModes().find((m) => m.id === data.customMode && m.base === mode) : null;
    if (data.customMode && !custom) return { error: "unknown_mode" };
    // The user's model settings only carry over when the page keeps their provider and model.
    const own = Boolean((data.model && data.model !== "default") || data.provider);
    if (data.model && data.model !== "default" && modelsOf(provider).length && !modelInfo(provider, data.model)) return { error: "unknown_model" };
    const model = data.model || (own ? "default" : p.models?.[provider] || "default");
    const efforts = modelInfo(provider, model)?.efforts || [];
    if (data.effort && efforts.length && !efforts.some((e) => e.id === data.effort)) return { error: "unknown_effort" };
    if (data.approval && !APPROVALS.some((a) => a.id === data.approval)) return { error: "unknown_approval" };
    const folderMode = FOLDER_MODES.has(mode);
    const cwd = folderMode && typeof data.cwd === "string" ? data.cwd.trim() : "";
    if (folderMode && !cwd) return { error: "needs_folder" };
    const modelParams = { ...(own ? {} : modelChoice(provider, model, p).modelParams) };
    if (data.modelParams && typeof data.modelParams === "object" && !Array.isArray(data.modelParams)) {
      for (const [key, value] of Object.entries(data.modelParams)) {
        if (value != null && value !== "") modelParams[key] = String(value);
      }
    }
    if (typeof data.fast === "boolean") modelParams.fast = data.fast ? "true" : "false";
    else if (data.fast === "true" || data.fast === "false") modelParams.fast = data.fast;
    return {
      provider,
      model,
      effort: data.effort || (own ? null : modelChoice(provider, model, p).effort),
      modelParams,
      mode,
      ...(custom ? { customMode: custom.id } : {}),
      approval: data.approval || custom?.approval || approvalFor(provider, p),
      web: webMode(data.web, custom?.web || webMode(p.web)),
      cwd: cwd || null,
      useWorktree: folderMode && data.worktree === true,
      ...(data.helpers === true ? { helpersAllowed: true } : {}),
    };
  }

  /**
   * One scribe.agent call from `tab` (app.js found it from the asking frame, and whether the click
   * or key press reached the board). Pages only see and drive threads that belong to them; the
   * permissions the user gave the page decide what else they may do.
   */
  async function pageRequest(tab, data, { activated = true } = {}) {
    const prompt = typeof data.prompt === "string" ? data.prompt.trim() : "";
    const thread = data.threadId ? S.threads.get(data.threadId) : null;
    switch (data.op) {
      case "threads":
        return {
          ok: true,
          threads: [...S.threads.values()]
            .filter((t) => ownedBy(tab, t) && !t.archived)
            .sort((a, b) => b.activityAt - a.activityAt)
            .map(pageBrief),
        };
      case "get":
        if (!ownedBy(tab, thread)) return { ok: false, error: "not_found" };
        return { ok: true, thread: pageBrief(thread), reply: await lastReply(thread.id) };
      case "steps":
        // From now on the page also gets the thread's steps as they change (scribe-agent-steps).
        if (!ownedBy(tab, thread)) return { ok: false, error: "not_found" };
        await ensureDetail(thread.id);
        if (!pageStepWatch.has(thread.id)) pageStepWatch.set(thread.id, null);
        return { ok: true, steps: pageSteps(thread.id) };
      case "wait": {
        if (!ownedBy(tab, thread)) return { ok: false, error: "not_found" };
        await ensureDetail(thread.id);
        const now = S.threads.get(thread.id);
        const caughtUp = (now.activityAt || 0) >= (pageSentAt.get(now.id) || 0);
        if (now.status === "idle" && !now.queued && caughtUp) return { ok: true, thread: pageBrief(now), reply: await lastReply(now.id) };
        const result = await waitIdle(now.id, data.timeoutMs);
        const after = S.threads.get(now.id);
        return after ? { ...result, thread: pageBrief(after) } : { ok: false, error: "not_found" };
      }
      case "show":
        // Only opens it for the user; nothing about the thread goes back to the page.
        if (!activated) return { ok: false, error: "no_gesture" };
        if (!thread || thread.archived) return { ok: false, error: "not_found" };
        showPageThread(thread.id, data.where === "dock" ? "dock" : "sidebar", { reveal: true });
        return { ok: true };
      case "options":
        return pageOptions();
      case "limits":
        pageLimitWatch.add(tab.id);
        return { ok: true, limits: pageLimits() };
      case "actions":
        // The template's right-click actions, for a page that draws its own menu (#161).
        return {
          ok: true,
          actions: declaredActions(tab, "menu").map((a) => ({
            id: a.id,
            label: a.label,
            ...(a.description ? { description: a.description } : {}),
            ...(a.selection ? { selection: a.selection } : {}),
            context: a.context || [],
          })),
        };
      case "runAction": {
        if (!activated) return { ok: false, error: "no_gesture" };
        const action = declaredActions(tab, "menu").find((a) => a.id === data.action);
        if (!action) return { ok: false, error: "not_found" };
        const context = data.context && typeof data.context === "object" && !Array.isArray(data.context) ? data.context : {};
        if (!hasContext(action, context)) return { ok: false, error: "missing_context" };
        const selection = typeof data.selection === "string" ? data.selection.trim().slice(0, 20000) : "";
        if (action.selection === "required" && !selection) return { ok: false, error: "needs_selection" };
        await runAction(tab, action, { selection: action.selection === "none" ? "" : selection, context });
        return { ok: true };
      }
      case "pickFolder": {
        if (!activated) return { ok: false, error: "no_gesture" };
        const picked = await pickWorkspace(typeof data.initial === "string" ? data.initial : "");
        return picked ? { ok: true, path: picked } : { ok: false, error: "cancelled" };
      }
      case "start": {
        if (!prompt) return { ok: false, error: "empty_prompt" };
        if (prompt.length > PAGE_PROMPT_MAX) return { ok: false, error: "prompt_too_long" };
        const settings = pageThreadSettings(data);
        if (settings.error) return { ok: false, error: settings.error };
        const may = await pageMayWrite(tab, activated);
        if (!may.ok) return may;
        if (settings.cwd) {
          const folder = await pageMayUseFolder(tab, settings.cwd, settings.approval);
          if (!folder.ok) return folder;
        }
        const title = typeof data.title === "string" && data.title.trim() ? data.title.trim().slice(0, 120) : undefined;
        // Threads a page starts (board workers) leave the user's chat defaults alone.
        const { thread: created } = await api("POST", "/threads", {
          ...settings,
          remember: false,
          scope: { kind: "page", ref: tab.id },
          ...(title ? { title } : {}),
        });
        S.threads.set(created.id, created);
        S.details.set(created.id, { items: [], byId: new Map(), turns: new Map() });
        if (data.run) {
          // Handed over before its first message, so Scribe sees its first turn through.
          const { thread: watched } = await api("POST", `/threads/${encodeURIComponent(created.id)}/run`, { ...pageRunInput(data.run), after: Date.now() });
          if (watched) S.threads.set(created.id, watched);
        }
        pageSentAt.set(created.id, Date.now());
        const sent = await api("POST", `/threads/${encodeURIComponent(created.id)}/messages`, { text: prompt, from: "page", ...(data.cardContext != null ? { cardContext: data.cardContext } : {}) });
        showPageThread(created.id, data.show, { reveal: activated });
        return { ok: true, threadId: created.id, queued: Boolean(sent.queued) };
      }
      case "send": {
        if (!ownedBy(tab, thread)) return { ok: false, error: "not_found" };
        if (!prompt) return { ok: false, error: "empty_prompt" };
        if (prompt.length > PAGE_PROMPT_MAX) return { ok: false, error: "prompt_too_long" };
        const may = await pageMayWrite(tab, activated);
        if (!may.ok) return may;
        if (FOLDER_MODES.has(thread.mode)) {
          const folder = await pageMayUseFolder(tab, pageFolder(thread), thread.approval);
          if (!folder.ok) return folder;
        }
        await ensureDetail(thread.id);
        pageSentAt.set(thread.id, Date.now());
        const sent = await api("POST", `/threads/${encodeURIComponent(thread.id)}/messages`, { text: prompt, from: "page" });
        showPageThread(thread.id, data.show, { reveal: activated });
        return { ok: true, queued: Boolean(sent.queued) };
      }
      case "card": {
        // A card comment for the thread working on the card (steered into its turn, or queued), or
        // Continue for the one that worked on it. The thread may be any of the user's (one that
        // claimed the card from its own chat), so other pages' threads need the click; the daemon
        // words the message, so it reads as the board's, not the user's in the chat.
        if (!thread || thread.archived) return { ok: false, error: "not_found" };
        const num = Number(data.card);
        if (!Number.isInteger(num) || num < 1) return { ok: false, error: "bad_card" };
        const resume = data.resume === true;
        if (!resume && !prompt) return { ok: false, error: "empty_prompt" };
        if (prompt.length > PAGE_PROMPT_MAX) return { ok: false, error: "prompt_too_long" };
        const own = ownedBy(tab, thread);
        if (!own && !activated) return { ok: false, error: "no_gesture" };
        const may = await pageMayWrite(tab, activated);
        if (!may.ok) return may;
        if (own && FOLDER_MODES.has(thread.mode)) {
          const folder = await pageMayUseFolder(tab, pageFolder(thread), thread.approval);
          if (!folder.ok) return folder;
        }
        await ensureDetail(thread.id);
        const title = typeof data.title === "string" ? data.title.trim().slice(0, 200) : "";
        const sent = await api("POST", `/threads/${encodeURIComponent(thread.id)}/card-message`, {
          num,
          text: resume ? "" : prompt,
          resume,
          title,
          board: tab.title || "Kanban board",
          boardKey: tab.key || "",
        });
        if (sent.delivered && own) pageSentAt.set(thread.id, Date.now());
        return { ok: true, delivered: sent.delivered || null };
      }
      case "watch": {
        // Hand a thread of the page's to Scribe to see through: limit waits, resumes, merges (#285).
        if (!ownedBy(tab, thread)) return { ok: false, error: "not_found" };
        const may = await pageMayWrite(tab, activated);
        if (!may.ok) return may;
        if (FOLDER_MODES.has(thread.mode)) {
          const folder = await pageMayUseFolder(tab, pageFolder(thread), thread.approval);
          if (!folder.ok) return folder;
        }
        const { thread: watched } = await api("POST", `/threads/${encodeURIComponent(thread.id)}/run`, pageRunInput(data.run));
        if (watched) S.threads.set(watched.id, watched);
        return { ok: true, thread: pageBrief(watched || thread) };
      }
      case "allow": {
        // What Scribe needs to start the page's agents on its own (a Kanban board's workers): asked after a click.
        if (!activated) return { ok: false, error: "no_gesture" };
        const may = await pageMayWrite(tab, false);
        if (!may.ok) return may;
        if (FOLDER_MODES.has(data.mode)) {
          const cwd = typeof data.cwd === "string" ? data.cwd.trim() : "";
          if (!cwd) return { ok: false, error: "needs_folder" };
          const approval = APPROVALS.some((a) => a.id === data.approval) ? data.approval : "auto";
          const folder = await pageMayUseFolder(tab, cwd, approval);
          if (!folder.ok) return folder;
        }
        return { ok: true };
      }
      case "release": {
        if (!ownedBy(tab, thread)) return { ok: false, error: "not_found" };
        const { thread: released } = await api("DELETE", `/threads/${encodeURIComponent(thread.id)}/run`);
        if (released) S.threads.set(released.id, released);
        return { ok: true };
      }
      case "stop": {
        if (!ownedBy(tab, thread)) return { ok: false, error: "not_found" };
        const may = await pageMayWrite(tab, activated);
        if (!may.ok) return may;
        await api("POST", `/threads/${encodeURIComponent(thread.id)}/cancel`);
        return { ok: true };
      }
      case "merge": {
        if (!ownedBy(tab, thread)) return { ok: false, error: "not_found" };
        if (!openWorktree(thread)) return { ok: true, merged: false, message: "The thread has no open worktree." };
        if (thread.status !== "idle") return { ok: false, error: "busy" };
        const may = await pageMayWrite(tab, activated);
        if (!may.ok) return may;
        const folder = await pageMayUseFolder(tab, pageFolder(thread), thread.approval);
        if (!folder.ok) return folder;
        try {
          const res = await api("POST", `/threads/${encodeURIComponent(thread.id)}/worktree`, { action: "merge" });
          return { ok: true, merged: true, message: res.message };
        } catch (err) {
          return { ok: false, error: "merge_failed", message: String(err?.message || err) };
        }
      }
      default:
        return { ok: false, error: "unknown_op" };
    }
  }

  /* ---------- keys ---------- */

  function shortcut(action) {
    if (document.querySelector("dialog[open]")) return false;
    // Opening chat is global; actions on its contents require focus in that chat.
    if (!["side", "dock", "full"].includes(action) && !focusedChat()) return false;
    if (action === "side" && SOLO) action = "dock";
    if (action === "side") {
      if (S.fullOpen) leaveFull("side");
      else sidebar.setOpen(!S.sideOpen);
    } else if (action === "dock") {
      if (S.dockShown && document.activeElement !== dock.view.input) {
        dock.view.focus();
        return true;
      }
      dock.setShown(!S.dockShown);
    } else if (action === "full") {
      if (S.fullOpen) leaveFull();
      else enterFull(SOLO || dockFocused() ? "dock" : "side");
    } else if (action === "model") {
      void cycleModel();
    } else if (action === "effort") {
      void cycleEffort();
    } else if (action === "mode") {
      void cycleMode();
    } else if (action === "workspace") {
      void cycleWorkspace();
    } else if (action === "scope") {
      void cycleScope();
    } else if (action === "threads") {
      openThreads();
    } else if (action === "new") {
      newThread();
    } else if (action === "up") {
      chatUp();
    } else if (action === "down") {
      chatDown();
    }
    return true;
  }

  function focusedChat() {
    const active = document.activeElement;
    if (S.fullOpen) return full.root?.contains(active) ? "full" : null;
    if (dockFocused()) return "dock";
    if (sideFocused()) return "side";
    // The floating thread picker is mounted on body, outside the chat root.
    if (S.dockShown && openMenuAnchor === dock.titleBtn && openMenuEl?.contains(active)) return "dock";
    return null;
  }

  function dockFocused() {
    return S.dockShown && Boolean(dock.root?.contains(document.activeElement));
  }

  function sideFocused() {
    return S.sideOpen && Boolean(sidebar.pane?.contains(document.activeElement));
  }

  /** The chat a thread shortcut acts on: the full window, the focused (or only) floating chat, else the sidebar, opened if needed. */
  function shortcutChat() {
    const focused = focusedChat();
    if (focused) return focused;
    if (S.fullOpen) return "full";
    if (SOLO && !S.dockShown) dock.setShown(true);
    if (S.dockShown && (dockFocused() || !S.sideOpen)) return "dock";
    if (!S.sideOpen) sidebar.setOpen(true);
    return "side";
  }

  /** Where Ctrl+Down goes back to from the full window. */
  let fullFrom = null;

  function enterFull(from) {
    fullFrom = from;
    const view = from === "dock" ? dock.view : sidebar.view;
    // The chat moves over as it is (its thread or its unsent new thread, and the composer);
    // only a chat that has shown nothing yet opens the current thread.
    const snap = view.threadId || view.draft ? view.takeChat() : { threadId: S.current && S.threads.has(S.current) ? S.current : null, draft: null, composer: null };
    full.open(snap);
  }

  /**
   * Close the full window into the chat it was opened from (the floating chat, else the sidebar), taking the chat along.
   * Pass "side" to land in the sidebar even if it was closed (Ctrl+L). Leaving fullscreen itself does not open it.
   */
  function leaveFull(to) {
    // The chat window is nothing but the full window.
    if (CHAT) return;
    const dest = to ?? fullFrom;
    const snap = full.view.takeChat();
    fullFrom = null;
    full.close();
    if (dest === "dock" && S.dockShown) {
      dock.view.giveChat(snap);
      dock.view.focus();
      return;
    }
    sidebar.view.giveChat(snap);
    if (snap.threadId) setCurrent(snap.threadId);
    if (to === "side" && !S.sideOpen) sidebar.setOpen(true);
    if (S.sideOpen) setTimeout(() => sidebar.view.focus(), 60);
  }

  /** Ctrl+Up: a collapsed floating chat expands; an expanded one, or the sidebar, goes full window. */
  function chatUp() {
    if (S.fullOpen) return;
    if (dockFocused()) {
      if (!S.dockExpanded) dock.setExpanded(true);
      else enterFull("dock");
    } else if (sideFocused()) {
      enterFull("side");
    }
  }

  /** Ctrl+Down: the full window goes back where it came from; an expanded floating chat collapses; a collapsed one hides. */
  function chatDown() {
    if (S.fullOpen) leaveFull();
    else if (dockFocused() && S.dockExpanded) dock.setExpanded(false);
    else if (dockFocused()) dock.setShown(false);
  }

  /** Ctrl+J: open the thread picker of the chat in use; a second press closes it and gives the focus back to the input. */
  function openThreads() {
    // The floating chat's menu takes the focus out of the dock, so check for it before picking a chat.
    if (openMenuEl && openMenuAnchor === dock.titleBtn) {
      closeMenu();
      dock.view.focus();
      return;
    }
    const where = shortcutChat();
    if (where === "full") {
      const search = full.list.querySelector("input[type=search]");
      if (search && document.activeElement === search) full.view.focus();
      else search?.focus();
    } else if (where === "dock") {
      dock.threadMenu(dock.titleBtn);
    } else if (sidebar.listOpen) {
      sidebar.toggleList();
      sidebar.view.focus();
    } else {
      sidebar.toggleList();
      setTimeout(() => sidebar.listEl.querySelector("input[type=search]")?.focus(), 0);
    }
  }

  /** Provider, model, mode, approval, workspace — whatever the current chat is using. */
  function inheritSettings(view) {
    const s = view.settings();
    return {
      provider: s.provider,
      model: s.model,
      effort: s.effort ?? null,
      modelParams: { ...(s.modelParams || {}) },
      mode: s.mode,
      customMode: s.custom?.id ?? null,
      approval: s.approval,
      web: webMode(s.web),
      cwd: homeDir(s),
      useWorktree: Boolean(s.useWorktree),
    };
  }

  function newThread(fromView, resetSettings = false, moveComposer = true) {
    const where = fromView ? (fromView.variant === "full" ? "full" : fromView.variant === "dock" ? "dock" : "side") : shortcutChat();
    const view = fromView || (where === "dock" ? dock.view : where === "full" ? full.view : sidebar.view);
    const cur = resetSettings ? null : view.settings();
    const scope = resetSettings ? defaultScope() : { kind: cur.scope.kind, ref: cur.scope.ref };
    const settings = resetSettings ? {} : inheritSettings(view);
    if (where === "dock") {
      if (scope.kind === "page") setDockPick(scope.ref, null);
      view.startDraft(scope, settings, moveComposer);
      dock.renderTitle();
    } else if (where === "full") {
      view.startDraft(scope, settings);
      full.renderList();
    } else {
      if (sidebar.listOpen) sidebar.toggleList();
      view.startDraft(scope, settings);
    }
    notice("New thread");
  }

  async function cycleMode() {
    const view = targetView();
    const s = view.settings();
    const disabled = prefs().disabledModes || [];
    const at = MODES.findIndex((m) => m.id === s.mode);
    let next;
    for (let offset = 1; offset <= MODES.length; offset += 1) {
      const mode = MODES[(at + offset) % MODES.length];
      if (!disabled.includes(mode.id)) {
        next = mode;
        break;
      }
    }
    if (!next) {
      notice("No modes enabled for cycling. Choose modes in Agent settings.");
      return;
    }
    if (next.id === s.mode && !s.custom) return;
    await view.updateSettings({ mode: next.id, customMode: null });
    notice(`Mode: ${next.label}`);
  }

  /** Folders existing threads use, then recent ones, plus the current pick if it is not already listed. */
  function workspaceCycleList(current) {
    const dirs = [];
    const seen = new Set();
    const add = (dir) => {
      if (!dir) return;
      const key = dirKey(dir);
      if (seen.has(key)) return;
      seen.add(key);
      dirs.push(dir);
    };
    for (const { path: dir } of threadWorkspaces()) add(dir);
    for (const dir of prefs().recentWorkspaces || []) add(dir);
    add(current);
    return dirs;
  }

  async function cycleWorkspace() {
    const view = targetView();
    const current = view.settings().cwd || null;
    const dirs = workspaceCycleList(current);
    const list = [...dirs, null];
    if (list.length < 2) {
      notice("No workspaces to cycle");
      return;
    }
    const at = current ? list.findIndex((dir) => dir && dirKey(dir) === dirKey(current)) : list.length - 1;
    const next = list[(Math.max(at, 0) + 1) % list.length];
    await view.setWorkspace(next);
    notice(next ? `Workspace: ${R.basename(next) || next}` : "Workspace: None");
  }

  /** Scribe access options the scope menu would offer for this chat, in that order. */
  function scopeCycleList(view) {
    const s = view.settings();
    const tab = activeTab();
    const list = [];
    const add = (scope) => {
      if (!scope || list.some((item) => sameScope(item, scope))) return;
      list.push(scope);
    };
    if (tab) add({ kind: "page", ref: tab.id });
    if (tab?.folderId) add({ kind: "folder", ref: tab.folderId });
    if (s.scope.kind === "page" || s.scope.kind === "folder") add({ ...s.scope });
    add({ kind: "global", ref: null });
    add({ kind: "workspace", ref: s.cwd || null });
    return list;
  }

  async function cycleScope() {
    const view = targetView();
    const s = view.settings();
    const list = scopeCycleList(view);
    if (list.length < 2) {
      notice("No other Scribe access to cycle");
      return;
    }
    let at = list.findIndex((scope) => sameScope(scope, s.scope));
    if (at < 0 && s.scope.kind === "workspace") at = list.findIndex((scope) => scope.kind === "workspace");
    const next = list[(Math.max(at, 0) + 1) % list.length];
    await view.setScope(next);
    notice(`Scribe: ${next.kind === "workspace" ? "None" : scopeLabel(next).text}`);
  }

  function escape() {
    if (allowlists.close()) return true;
    if (memoryDialog.close()) return true;
    if (agentSettings.close()) return true;
    if (openMenuEl) {
      const fromDock = openMenuAnchor === dock.titleBtn;
      closeMenu();
      if (fromDock) dock.view.focus();
      return true;
    }
    if (sidebar.listOpen && sideFocused()) {
      sidebar.toggleList();
      sidebar.view.focus();
      return true;
    }
    if (modalStack.length) {
      modalStack[modalStack.length - 1]();
      return true;
    }
    const where = focusedChat();
    const view = where === "full" ? full.view : where === "dock" ? dock.view : where === "side" ? sidebar.view : null;
    const helperOwner = view?.helperView?.visible() ? view : null;
    if (helperOwner) {
      helperOwner.closeHelper();
      return true;
    }
    if (S.fullOpen && where === "full") {
      if (CHAT) return false;
      leaveFull();
      return true;
    }
    if (where === "dock") {
      if (S.dockExpanded) dock.setExpanded(false);
      else dock.setShown(false);
      return true;
    }
    return false;
  }

  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || !(event.ctrlKey || event.metaKey)) return;
    const run = (action) => { if (shortcut(action)) event.preventDefault(); };
    // The apostrophe key by character, or by position on Nordic layouts (the '* key next to Enter).
    // With Shift the US key types ", the Nordic one *.
    const quote = event.key === "'" || event.key === '"' || (event.code === "Backslash" && event.key !== "\\" && event.key !== "|");
    if (quote) {
      if (event.shiftKey && event.altKey) return;
      run(event.shiftKey ? "mode" : event.altKey ? "effort" : "model");
      return;
    }
    if (event.altKey) return;
    // Period key by position so Ctrl+Shift+. stays on that key when Shift types > or :.
    if (event.code === "Period") {
      run(event.shiftKey ? "scope" : "workspace");
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "k") {
      run(event.shiftKey ? "new" : "dock");
    } else if (key === "l") {
      run(event.shiftKey ? "full" : "side");
    } else if (key === "j" && !event.shiftKey) {
      run("threads");
    } else if (event.key === "ArrowUp" && !event.shiftKey && (dockFocused() || sideFocused())) {
      run("up");
    } else if (event.key === "ArrowDown" && !event.shiftKey && (S.fullOpen || dockFocused())) {
      run("down");
    }
  });

  /* ---------- template agent actions (#152) ---------- */

  /** The page's template actions offered at `place` (menu, palette, slash). */
  function pageActions(tab, place, context = null) {
    return declaredActions(tab, place).filter((a) => hasContext(a, context));
  }

  function declaredActions(tab, place) {
    const actions = (tab && app()?.templateActions?.(tab)) || [];
    return actions.filter((a) => a && a.id && a.prompt && (a.where || []).includes(place));
  }

  /** An action with page-supplied placeholders (#161) is offered only where the page supplies them all. */
  function hasContext(action, context) {
    return (action.context || []).every((name) => context && String(context[name] ?? "").trim());
  }

  /** The values a page supplied for an action's declared context names; anything else is dropped. */
  function contextValues(action, context) {
    const out = {};
    for (const name of action.context || []) {
      const value = context?.[name];
      if (typeof value === "string" || typeof value === "number") out[name] = String(value).trim().slice(0, 2000);
    }
    return out;
  }

  /** Fill in an action's prompt or title; the same rules as renderAgentActionText in src/templates.ts. */
  function actionText(source, values) {
    const sections = /\{\{\s*#\s*([a-zA-Z_.]+)\s*\}\}([\s\S]*?)\{\{\s*\/\s*\1\s*\}\}/g;
    let text = String(source || "");
    for (let pass = 0; pass < 4; pass += 1) {
      const next = text.replace(sections, (_m, name, inner) => ((values[name] ?? "").trim() ? inner : ""));
      if (next === text) break;
      text = next;
    }
    return text.replace(/\{\{\s*([#/]?)\s*([a-zA-Z_.]+)\s*\}\}/g, (_m, mark, name) => (mark ? "" : values[name] ?? "")).trim();
  }

  /** The chat an action from the page menu or palette goes to: the one the user has open, else the floating chat. */
  function actionView() {
    if (S.fullOpen) return full.view;
    if (S.sideOpen && !S.dockShown) return sidebar.view;
    if (!S.dockShown) dock.setShown(true);
    return dock.view;
  }

  function showInView(view, id) {
    if (view === full.view) {
      setCurrent(id);
      full.view.setThread(id);
      full.renderList();
    } else if (view === sidebar.view) {
      if (!S.sideOpen) sidebar.setOpen(true);
      sidebar.view.setThread(id);
    } else {
      if (id !== dock.view.threadId) dock.pick(id);
      if (!S.dockShown) dock.setShown(true);
    }
  }

  /**
   * Run a template action on `tab`: a new thread on the page with the action's settings, or with run: "chat",
   * a message in the chat at hand. `view` is the chat it was typed in (slash menu).
   */
  async function runAction(tab, action, { selection = "", input = "", context = null, view = null } = {}) {
    if (!tab || !action) return;
    const values = {
      ...contextValues(action, context),
      selection: String(selection || "").trim(),
      input: String(input || "").trim(),
      "page.title": tab.title || "",
      "page.key": tab.key || "",
    };
    const prompt = actionText(action.prompt, values).slice(0, PAGE_PROMPT_MAX);
    if (!prompt) return;
    // A selection the prompt does not quote still goes along, as a chip.
    const chips =
      values.selection && !/\{\{\s*selection\s*\}\}/.test(action.prompt)
        ? [{ kind: "selection", text: values.selection, source: `"${tab.title}" (key: ${tab.key})` }]
        : [];
    const target = view || actionView();
    if (action.run === "chat") {
      const draft = target.input.value;
      target.mentions.push(...chips);
      if (!target.pageInThread(tab) && !target.mentions.some((c) => c.kind === "page" && c.id === tab.id)) {
        target.mentions.push({ kind: "page", id: tab.id, key: tab.key, title: tab.title });
      }
      target.input.value = prompt;
      await target.send();
      if (draft && !target.input.value) {
        target.input.value = draft;
        target.autosize();
      }
      return;
    }
    const settings = pageThreadSettings(agentActionThreadInput(action.thread));
    if (settings.error) {
      notice(`${action.label}: ${settings.error.replace(/_/g, " ")}`);
      return;
    }
    const title = (action.thread?.title ? actionText(action.thread.title, values) : "") || action.label;
    try {
      const { thread } = await api("POST", "/threads", { ...settings, remember: false, scope: { kind: "page", ref: tab.id }, title: title.slice(0, 120) });
      S.threads.set(thread.id, thread);
      S.details.set(thread.id, { items: [], byId: new Map(), turns: new Map() });
      showInView(target, thread.id);
      await api("POST", `/threads/${encodeURIComponent(thread.id)}/messages`, { text: prompt, context: chips });
    } catch (err) {
      notice(`${action.label}: ${err.message}`);
    }
  }

  /**
   * Ask about a page: attach a selection from it (or the page itself, with no text) to a chat and focus
   * its input. target "dock" or "side" picks that chat (Ctrl+K / Ctrl+L); otherwise the open one.
   */
  function ask(text, tab, target) {
    if (!tab) return;
    let view;
    if (S.fullOpen) {
      view = full.view;
    } else if (!SOLO && (target === "side" || (!target && S.sideOpen && !S.dockShown))) {
      if (!S.sideOpen) sidebar.setOpen(true);
      view = sidebar.view;
    } else {
      if (!S.dockShown) dock.setShown(true);
      view = dock.view;
    }
    const chip = text
      ? { kind: "selection", text, source: `"${tab.title}" (key: ${tab.key})` }
      : { kind: "page", id: tab.id, key: tab.key, title: tab.title };
    const same = (c) => c.kind === chip.kind && (chip.kind === "page" ? c.id === chip.id : c.text === chip.text);
    const shownAlready = chip.kind === "page" && view.pageInThread(tab);
    if (!shownAlready && !view.mentions.some(same)) view.mentions.push(chip);
    view.renderContext();
    setTimeout(() => view.focus(), 70);
  }

  /** A new thread with this text in its composer, not sent yet (the palette's "Ask in chat", #245). */
  function askInChat(text) {
    let view;
    if (S.fullOpen) {
      view = full.view;
    } else if (S.sideOpen && !S.dockShown) {
      view = sidebar.view;
    } else {
      if (!S.dockShown) dock.setShown(true);
      view = dock.view;
    }
    newThread(view, false, false);
    view.fillComposer({ text });
    setTimeout(() => view.focus(), 70);
  }

  window.scribeChat = { customModes, customDetail, editCustomMode: (mode, changed) => void editCustomMode(mode, changed), openSettings: () => agentSettings.open(), openModelSources: () => { agentSettings.open(); agentSettings.categories.select(0); agentSettings.sources.scrollIntoView({ block: "center" }); }, closeSettings: () => agentSettings.close(), openMcpServers: (opts) => void mcpServers.open(opts), openMcpPermissions: () => void mcpServers.permissionsDialog(), editMcpServer: (scope, name, changed) => void mcpServers.editFrom(scope, name, changed), openAllowlists: () => allowlists.open(), modal, shortcut, escape, pageStatus, pageThreads, pageRequest, pickWorkspace, ask, askInChat, openThread, openAsk, pendingAsks, searchThreads, searchThreadMessages: searchMessages, threadTitle, pageActions, runAction, dockProvider: () => dock.view.settings().provider, followThread: (threadId, tabId) => dock.followThread(threadId, tabId) };

  /* ---------- boot ---------- */

  function boot() {
    sidebar.mount();
    full.mount();
    dock.mount();
    agentSettings.mount();
    allowlists.mount();
    memoryDialog.mount();
    applyButton();
    toasts.mount();
    staleWorktrees.start();
    const toggleBtn = document.getElementById("agent-toggle");
    toggleBtn?.addEventListener("click", () => shortcut("side"));
    if (toggleBtn) flyout.bind(toggleBtn, "button");
    const origSetThread = sidebar.view.setThread.bind(sidebar.view);
    sidebar.view.setThread = (id) => {
      origSetThread(id);
      if (id) setCurrent(id);
      sidebar.renderList();
    };
    loadStartupData().then(() => {
      if (CHAT) full.open(chatFromWindow(window.scribePopout.chatHandoff() || { threadId: S.current }));
      if (S.sideOpen) sidebar.ensureThread();
      dock.syncThread();
      renderAll();
      window.dispatchEvent(new Event("scribe:threads-ready"));
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
