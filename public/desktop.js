/* Desktop app additions. The Tauri shell loads this same board; in a browser this file does nothing. */
(() => {
  const tauri = window.__TAURI__;
  if (!tauri?.core) {
    return;
  }
  const invoke = tauri.core.invoke;
  // Keep in step with layout::DesktopState. Bump when this UI needs a new native API.
  const REQUIRED_API_REVISION = 2;
  let stateReceived = false;
  const root = document.documentElement;
  const chrome = document.querySelector(".chrome");
  const actions = chrome.querySelector(".actions");
  const HIDDEN_KEY = "scribe.desktop.hiddenButtons";
  /** A page in a window of its own (popout.js): a title bar with the window buttons, and none of the main window's settings. */
  const child = Boolean(window.scribePopout?.childId);
  root.classList.add("desktop");

  // Empty strip space and the spacing around panels move the window; double-click maximizes.
  // Bare drag regions only react to clicks on the element itself, so tabs, buttons, and panels keep theirs.
  for (const el of [chrome, chrome.querySelector(".tabs-wrap"), document.getElementById("tabs"), actions, document.querySelector(".workspace")]) {
    el?.setAttribute("data-tauri-drag-region", "");
  }

  const ICONS = {
    compact:
      '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="1.5" y="2" width="13" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="8" y="8" width="5" height="4.5" rx="1" fill="currentColor"/></svg>',
    expand:
      '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="1.5" y="2" width="13" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.5 5.5h4v4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.5 5.5L5 11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    more: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>',
    minimize: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg>',
    maximize:
      '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    restore:
      '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    close: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" stroke-width="1"/></svg>',
  };

  let desktop = {
    compact: false,
    maximized: false,
    compactOnTop: true,
    openFromAgents: true,
    closeToTray: false,
    launchAtStartup: false,
    reducedMotion: false,
    dockChildWindows: true,
    hidden: false,
  };

  /** The four title bar buttons, in strip order. `label` follows the window state. */
  const BUTTONS = [
    {
      id: "compact",
      action: "toggle-compact",
      setting: "Compact window button",
      label: () => (desktop.compact ? "Normal window" : "Compact window"),
      hint: "Ctrl+Shift+M",
    },
    { id: "minimize", action: "minimize", setting: "Minimize button", label: () => "Minimize" },
    {
      id: "maximize",
      action: "toggle-maximize",
      setting: "Maximize button",
      label: () => (desktop.maximized ? "Restore" : "Maximize"),
    },
    { id: "close", action: "close", setting: "Close button", label: () => "Close" },
  ];

  let hidden = loadHidden();

  // Intercept only the same bare drag regions Tauri uses. Controls and double-click maximize
  // keep their usual behavior; native tracking keeps working after the pointer leaves this view.
  window.addEventListener("mousedown", (event) => {
    if (!child || window.scribePopout.chatChild || !desktop.dockChildWindows || !desktop.childDockingSupported ||
        event.button !== 0 || event.detail >= 2 || !event.target.hasAttribute?.("data-tauri-drag-region")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    invoke("window_action", { action: "drag-child" }).catch(console.error);
  }, true);

  function loadHidden() {
    try {
      const ids = JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]");
      return new Set(Array.isArray(ids) ? ids.filter((id) => BUTTONS.some((button) => button.id === id)) : []);
    } catch {
      return new Set();
    }
  }

  function saveHidden() {
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
    } catch {
      /* the choice just won't survive a reload */
    }
  }

  // Compact and the overflow menu sit with the other strip buttons; window controls stay at the edge.
  const compactBtn = iconButton("desktop-compact");
  const moreBtn = iconButton("desktop-more", ICONS.more, "Window", false);
  moreBtn.setAttribute("aria-haspopup", "menu");
  actions.append(compactBtn, moreBtn);
  const updateBtn = document.createElement("button");
  updateBtn.type = "button";
  updateBtn.id = "desktop-update";
  updateBtn.textContent = "Update desktop";
  updateBtn.hidden = true;
  updateBtn.addEventListener("click", showBuildDetails);
  actions.append(updateBtn);

  const controls = document.createElement("div");
  controls.className = "win-controls";
  const minBtn = winButton("win-min", ICONS.minimize);
  const maxBtn = winButton("win-max");
  const closeBtn = winButton("win-close", ICONS.close);
  controls.append(minBtn, maxBtn, closeBtn);
  chrome.append(controls);

  const elements = { compact: compactBtn, minimize: minBtn, maximize: maxBtn, close: closeBtn };
  for (const button of BUTTONS) {
    const el = elements[button.id];
    el.addEventListener("click", () => run(button));
    el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const rest = BUTTONS.filter((item) => hidden.has(item.id));
      if (rest.length > 0) {
        openMenu(el, rest);
      }
    });
  }
  moreBtn.addEventListener("click", () => (menu ? closeMenu() : openMenu(moreBtn, BUTTONS)));
  moreBtn.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openMenu(moreBtn, BUTTONS);
  });

  function iconButton(id, icon = "", label = "", tooltip = true) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = id;
    btn.className = "icon-btn";
    btn.innerHTML = icon;
    if (label) {
      if (tooltip) btn.dataset.tooltip = label;
      btn.setAttribute("aria-label", label);
    }
    return btn;
  }

  function winButton(className, icon = "") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `win-btn ${className}`;
    btn.innerHTML = icon;
    // A double-click here must not reach the drag region behind it and maximize.
    btn.addEventListener("dblclick", (event) => event.stopPropagation());
    return btn;
  }

  function run(button) {
    closeMenu();
    invoke("window_action", { action: button.action });
  }

  /** Whether a title bar button is left out. A child window always keeps Close and never has Compact. */
  function isHidden(button) {
    if (child) {
      return button.id === "compact" || (button.id !== "close" && hidden.has(button.id));
    }
    return hidden.has(button.id);
  }

  let menu = null;

  function openMenu(anchor, items) {
    closeMenu();
    menu = document.createElement("div");
    menu.className = "tab-menu desktop-menu";
    menu.setAttribute("role", "menu");
    for (const button of items) {
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.className = button.id === "close" ? "danger" : "";
      item.textContent = button.label();
      if (button.hint) {
        const hint = document.createElement("span");
        hint.className = "menu-hint";
        hint.textContent = button.hint;
        item.append(hint);
      }
      item.addEventListener("click", () => run(button));
      menu.append(item);
    }
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.transformOrigin = "top right";
    anchor.setAttribute("aria-expanded", "true");
    menu.anchor = anchor;
    menu.querySelector("button")?.focus({ preventScroll: true });
  }

  function closeMenu() {
    if (!menu) {
      return;
    }
    menu.anchor.removeAttribute("aria-expanded");
    menu.remove();
    menu = null;
  }

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (menu && !menu.contains(event.target) && !menu.anchor.contains(event.target)) {
        closeMenu();
      }
    },
    true
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (menu && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        const anchor = menu.anchor;
        closeMenu();
        anchor.focus({ preventScroll: true });
      }
    },
    true
  );
  window.addEventListener("blur", closeMenu);
  window.addEventListener("resize", closeMenu);

  // Settings → Desktop.
  // Popout windows load the window controls without the main settings panel.
  const section = document.getElementById("desktop-settings") || document.createElement("section");
  section.className = "settings-section";
  section.innerHTML =
    '<h3>Desktop</h3><p class="settings-hint">Right-click a title bar button to bring back hidden ones.</p>';
  const buttonTrack = buttonTrackRow();
  const onTopRow = settingRow("desktop-on-top", "Keep the compact window on top", desktop.compactOnTop, (on) =>
    saveSetting("compactOnTop", on)
  );
  const openRow = settingRow(
    "desktop-open",
    "Agents open Scribe in this app instead of the browser",
    desktop.openFromAgents,
    (on) => saveSetting("openFromAgents", on)
  );
  const trayRow = settingRow("desktop-tray", "Close to tray", desktop.closeToTray, (on) =>
    saveSetting("closeToTray", on)
  );
  const startupRow = settingRow("desktop-startup", "Launch at startup", desktop.launchAtStartup, (on) =>
    saveSetting("launchAtStartup", on)
  );
  const hint = document.createElement("p");
  hint.className = "settings-hint settings-hint-after";
  hint.innerHTML = "<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> switches between the normal and compact window.";
  const motionRow = settingRow("desktop-reduced-motion", "Reduce motion", desktop.reducedMotion, (on) =>
    saveSetting("reducedMotion", on)
  );
  const motionHint = "Reduces animations, moving effects, and smooth scrolling in Scribe and pages that support reduced motion. When off, your system’s motion preference applies.";
  const motionLabel = motionRow.row.querySelector("span");
  motionLabel.dataset.tooltip = motionHint;
  motionLabel.setAttribute("aria-description", motionHint);
  const motionError = document.createElement("p");
  motionError.className = "settings-hint settings-hint-after";
  motionError.setAttribute("role", "status");
  motionError.textContent = "Update the desktop app to use Reduce motion.";
  motionError.hidden = true;
  const dockingRow = settingRow("desktop-dock-children", "Drag child windows into the main window", desktop.dockChildWindows,
    (on) => saveSetting("dockChildWindows", on));
  const dockingHint = "Drop on a panel to split or replace it. Hold Shift to move the window without docking.";
  const dockingLabel = dockingRow.row.querySelector("span");
  dockingLabel.dataset.tooltip = dockingHint;
  dockingLabel.setAttribute("aria-description", dockingHint);
  section.append(buttonTrack.row, onTopRow.row, openRow.row, trayRow.row, startupRow.row, motionRow.row, motionError, dockingRow.row, hint);
  const buildRow = document.createElement("div");
  buildRow.className = "setting-row";
  const buildStatus = document.createElement("span");
  buildStatus.textContent = "Checking desktop app…";
  const buildDetails = document.createElement("button");
  buildDetails.type = "button";
  buildDetails.textContent = "Build details";
  buildDetails.addEventListener("click", showBuildDetails);
  buildRow.append(buildStatus, buildDetails);
  section.prepend(buildRow);

  function needsUpdate() {
    return stateReceived && (!Number.isInteger(desktop.apiRevision) || desktop.apiRevision < REQUIRED_API_REVISION ||
      ["compactOnTop", "openFromAgents", "closeToTray", "launchAtStartup", "reducedMotion", "dockChildWindows", "childDockingSupported"].some((name) => typeof desktop[name] !== "boolean"));
  }

  function showBuildDetails() {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm desktop-build-dialog";
    dialog.setAttribute("aria-labelledby", "desktop-build-title");
    const heading = document.createElement("h3");
    heading.id = "desktop-build-title";
    heading.textContent = needsUpdate() ? "Update the desktop app" : "Desktop build";
    const details = document.createElement("p");
    const builtAt = Number(desktop.builtAt) * 1000;
    details.textContent = stateReceived
      ? `Version: ${desktop.version || "unreported"} · API: ${desktop.apiRevision ?? "unreported"} (UI requires ${REQUIRED_API_REVISION}) · Built: ${builtAt && Number.isFinite(builtAt) ? new Date(builtAt).toLocaleString() : "unreported"}`
      : "Desktop build information is unavailable.";
    const explanation = document.createElement("p");
    explanation.textContent = "To update, run this in PowerShell from your current Scribe source folder. It builds and replaces the desktop app, then restarts it if it was open.";
    const command = document.createElement("pre");
    const folder = desktop.executable?.replace(/[\\/][^\\/]+$/, "");
    command.textContent = `npm run desktop:install -- '${(folder || "<installed app folder>").replaceAll("'", "''")}'`;
    const location = document.createElement("p");
    location.textContent = desktop.executable ? `Running app: ${desktop.executable}` : "Replace <installed app folder> with the folder containing your scribe.exe.";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.append(heading, details, explanation, command, location, close);
    document.body.append(dialog);
    dialog.showModal();
    close.focus();
  }

  /** One row of connected icon toggles, one per title bar button, in strip order. */
  function buttonTrackRow() {
    const row = document.createElement("div");
    row.className = "setting-row";
    const label = document.createElement("span");
    label.id = "desktop-buttons-label";
    label.textContent = "Title bar buttons";
    const track = document.createElement("div");
    track.className = "button-track";
    track.setAttribute("role", "group");
    track.setAttribute("aria-labelledby", label.id);
    const toggles = {};
    for (const button of BUTTONS) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.innerHTML = button.id === "maximize" ? ICONS.maximize : ICONS[button.id];
      toggle.dataset.tooltip = button.setting;
      toggle.setAttribute("aria-label", button.setting);
      toggle.addEventListener("click", () => {
        if (hidden.has(button.id)) {
          hidden.delete(button.id);
        } else {
          hidden.add(button.id);
        }
        saveHidden();
        render();
      });
      toggles[button.id] = toggle;
      track.append(toggle);
    }
    row.append(label, track);
    return { row, toggles };
  }

  function settingRow(id, text, on, onChange) {
    const row = document.createElement("div");
    row.className = "setting-row";
    const label = document.createElement("span");
    label.id = `${id}-label`;
    label.textContent = text;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "pill-toggle";
    toggle.id = id;
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(on));
    toggle.setAttribute("aria-labelledby", label.id);
    toggle.addEventListener("click", () => {
      const next = toggle.getAttribute("aria-checked") !== "true";
      toggle.setAttribute("aria-checked", String(next));
      onChange(next);
    });
    row.append(label, toggle);
    return { row, toggle };
  }

  async function saveSetting(name, value) {
    try {
      setState(await invoke("set_desktop_setting", { name, value }));
    } catch (err) {
      console.error(err);
      setState(await invoke("desktop_state"));
    }
  }

  function render() {
    for (const button of BUTTONS) {
      const el = elements[button.id];
      el.hidden = isHidden(button);
      const label = button.hint ? `${button.label()} (${button.hint})` : button.label();
      el.dataset.tooltip = label;
      el.setAttribute("aria-label", label);
    }
    moreBtn.hidden = child || hidden.size < BUTTONS.length;
    for (const button of BUTTONS) {
      buttonTrack.toggles[button.id].setAttribute("aria-pressed", String(!hidden.has(button.id)));
    }
    compactBtn.innerHTML = desktop.compact ? ICONS.expand : ICONS.compact;
    compactBtn.classList.toggle("on", desktop.compact);
    maxBtn.innerHTML = desktop.maximized ? ICONS.restore : ICONS.maximize;
    controls.hidden = [minBtn, maxBtn, closeBtn].every((el) => el.hidden);
    onTopRow.toggle.setAttribute("aria-checked", String(desktop.compactOnTop));
    openRow.toggle.setAttribute("aria-checked", String(desktop.openFromAgents));
    trayRow.toggle.setAttribute("aria-checked", String(desktop.closeToTray));
    startupRow.toggle.setAttribute("aria-checked", String(desktop.launchAtStartup));
    motionRow.toggle.setAttribute("aria-checked", String(desktop.reducedMotion));
    dockingRow.toggle.setAttribute("aria-checked", String(Boolean(desktop.dockChildWindows)));
    dockingRow.toggle.disabled = !stateReceived || !desktop.childDockingSupported || typeof desktop.dockChildWindows !== "boolean";
    const dockingHelp = stateReceived && desktop.childDockingSupported === false ? "Available in the Windows desktop app." : dockingHint;
    dockingLabel.dataset.tooltip = dockingHelp;
    dockingLabel.setAttribute("aria-description", dockingHelp);
    // The daemon serves current UI assets even to an older desktop executable.
    // Older shells neither report this preference nor accept its setting command.
    const supportsMotion = stateReceived && typeof desktop.reducedMotion === "boolean";
    for (const [name, row] of [["compactOnTop", onTopRow], ["openFromAgents", openRow], ["closeToTray", trayRow], ["launchAtStartup", startupRow], ["reducedMotion", motionRow]]) {
      row.toggle.disabled = !stateReceived || typeof desktop[name] !== "boolean";
    }
    motionError.hidden = !stateReceived || supportsMotion;
    updateBtn.hidden = child || !needsUpdate();
    buildStatus.textContent = !stateReceived ? "Checking desktop app…" : needsUpdate() ? "Desktop update required" : `Desktop ${desktop.version || ""} · Compatible`;
    buildDetails.textContent = needsUpdate() ? "How to update" : "Build details";
  }

  function setState(state) {
    if (!state) {
      return;
    }
    if (state.hidden !== desktop.hidden) {
      window.scribeSetHidden?.(state.hidden);
    }
    desktop = state;
    stateReceived = true;
    root.classList.toggle("compact", state.compact && !child);
    render();
  }

  const zoomPopup = document.createElement("div");
  zoomPopup.className = "desktop-zoom-popup";
  zoomPopup.setAttribute("role", "status");
  zoomPopup.setAttribute("aria-atomic", "true");
  zoomPopup.hidden = true;
  document.body.append(zoomPopup);
  let zoomTimer = 0;

  function positionZoom() {
    zoomPopup.style.top = `${chrome.getBoundingClientRect().bottom + 8}px`;
  }

  function showZoom(factor) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    zoomPopup.textContent = `Zoom ${Math.round(factor * 100)}%`;
    positionZoom();
    zoomPopup.hidden = false;
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => { zoomPopup.hidden = true; }, 2000);
  }

  // Zoom also resizes the CSS viewport; keep the popup below the resized tab strip.
  new ResizeObserver(() => { if (!zoomPopup.hidden) positionZoom(); }).observe(chrome);
  window.scribeDesktop = { setState, showZoom };

  // The app catches the board's shortcuts natively only while focus is in an embedded site, which
  // keeps its key events from the board. The board and its pages see their keys first, as in a browser.
  // Unknown until the first report: the shell keeps its flag across reloads and the offline page
  // (a daemon restart), so a fresh board must say where focus is even when it isn't in an embed.
  let embedFocus = null;
  let focusPoll = 0;
  function reportFocus() {
    const el = document.activeElement;
    const inFrame = el?.tagName === "IFRAME";
    const embed = inFrame && !el.hasAttribute("data-scribe-page");
    // Moving between two frames raises nothing up here, so look again while one has focus.
    if (inFrame && !focusPoll) {
      focusPoll = setInterval(reportFocus, 250);
    } else if (!inFrame && focusPoll) {
      clearInterval(focusPoll);
      focusPoll = 0;
    }
    if (embed !== embedFocus) {
      embedFocus = embed;
      // Shells older than key_focus catch every shortcut natively, as before.
      invoke("key_focus", { embed }).catch(() => {});
    }
  }
  addEventListener("focusin", reportFocus);
  addEventListener("focus", reportFocus);
  // Focus going into a frame blurs this window before activeElement names the frame.
  addEventListener("blur", () => setTimeout(reportFocus, 0));
  reportFocus();

  // Lost the daemon for more than a moment (it restarts for a new build in about that long):
  // the app swaps in its offline page, which brings the board back once the daemon answers.
  let offlineTimer = 0;
  addEventListener("scribe:connection", (event) => {
    if (child) {
      // The offline page belongs to the main window; this one waits for the daemon.
      return;
    }
    if (event.detail.connected) {
      clearTimeout(offlineTimer);
      offlineTimer = 0;
    } else if (!offlineTimer) {
      // Each failed reconnect reports again; time from the first.
      offlineTimer = setTimeout(() => invoke("window_action", { action: "daemon-offline" }), 4000);
    }
  });
  if (child) {
    // The app only reports the main window's changes: ask after a resize, which is what maximizing is.
    let resizeTimer = 0;
    addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => invoke("desktop_state").then(setState), 120);
    });
    // The buttons follow Settings → Desktop in the main window.
    addEventListener("storage", (event) => {
      if (event.key === HIDDEN_KEY) {
        hidden = loadHidden();
        render();
      }
    });
  }
  render();
  invoke("desktop_state").then(setState).catch((err) => {
    console.error(err);
    buildStatus.textContent = "Could not check desktop app";
  });
})();
