/**
 * Page links and the views they open: a peek (a fixed card over the page area) and a split
 * (a row or column of two to four panes, kept per space). The focused pane always shows the active
 * tab, so the tab strip, the address and the floating chat follow focus.
 * app.js owns the frame pool; this decides which pooled iframe sits where. Frames are only ever
 * restyled, never moved in the DOM, because moving an iframe reloads it.
 */
window.createViews = function createViews(host) {
  const mainEl = host.mainEl;
  const SPLITS_KEY = "scribe.spaceSplits";
  const SPLIT_RATIO_KEY = "scribe.splitRatio";
  /** Below this page-area width a split opens as a peek instead. */
  const SPLIT_MIN_MAIN = 720;
  const SPLIT_MIN_PANE = 280;
  /** The least height of a stacked pane, header included. */
  const SPLIT_MIN_PANE_HEIGHT = 160;
  /** Pane names by place, first to last. The most panes a split holds is their count. */
  const PANES = ["a", "b", "c", "d"];
  /** A pane is added only while every pane keeps this width (or SPLIT_MIN_PANE_HEIGHT when stacked). */
  const SPLIT_ADD_MIN_PANE = SPLIT_MIN_MAIN / 2;
  const SPLIT_MIN_RATIO = 0.2;
  const SPLIT_MAX_RATIO = 0.8;
  const SPLIT_SNAP = 0.02;
  const PEEK_STACK_MAX = 8;
  const HOVER_DELAY = 120;

  const ICONS = {
    back: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M13 8H3.5M7.5 3.5L3 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    split: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8.5 2.5v11" stroke="currentColor" stroke-width="1.3"/><rect x="8.5" y="3" width="5.5" height="10" fill="currentColor" opacity="0.35"/></svg>',
    peek: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="4.5" y="5" width="7" height="6" rx="1" fill="currentColor" opacity="0.5"/></svg>',
    tab: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.5 13.5v-8a1.5 1.5 0 0 1 1.5-1.5h3.5l1.5 2h5a1.5 1.5 0 0 1 1.5 1.5v6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M1 13.5h14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    swap: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 5.5h10M9.5 2.5l3 3-3 3M13.5 10.5h-10M6.5 7.5l-3 3 3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    stack: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 8h13" stroke="currentColor" stroke-width="1.3"/></svg>',
    sideBySide: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 2.5v11" stroke="currentColor" stroke-width="1.3"/></svg>',
    browser: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  };

  /** @typedef {{ kind: "page", id: string } | { kind: "url", href: string }} Target */

  /** Space and host tab → its peek stack. */
  const peeks = new Map();
  /**
   * Space id → its split. A split is a temporary view, not board data. `panes` are its pages in
   * order, `sizes` each pane's share of the page area (they add up to 1), and `focus` the place of
   * the focused pane, which holds the active tab (activeSplit keeps the two in step).
   */
  /** @type {Map<string, { panes: Target[], sizes: number[], dir: "row" | "col", focus: number }>} */
  const splits = loadSplits();
  /** Pages on their way into the strip for a split. */
  const opening = new Set();
  let lastRatio = clampStoredRatio(Number(readStorage(SPLIT_RATIO_KEY)));
  /** Where a link-opened tab came from; closing it returns there while it's still the tab you're on. */
  const openedFrom = new Map();
  /** href → reason, for sites that refuse to be framed. */
  const blocked = new Map();
  /** The desktop app drops framing headers from embedded sites (desktop/src/embeds.rs), so nothing is refused there. */
  const framingAllowed = Boolean(window.__TAURI__);
  const checking = new Set();
  /** @type {null | { frameId: string, anchor: string }} */
  let pendingAnchor = null;
  let resizing = null;
  let pageDrag = null;
  let splitAnimations = [];
  let splitLayoutKey = "";
  let closingPeek = null;

  /* ---------- DOM ---------- */

  const scrim = el("div", "peek-scrim");
  const card = el("div", "peek-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "false");
  const peekHead = el("div", "view-head");
  const peekBody = el("div", "view-body");
  card.append(peekHead, peekBody);
  /** Pane → its header and the area under its frame. */
  const paneEls = Object.fromEntries(
    PANES.map((pane) => {
      const head = el("div", "view-head pane-head");
      const body = el("div", "view-body pane-body");
      head.dataset.pane = pane;
      body.dataset.pane = pane;
      return [pane, { head, body, drawn: "" }];
    })
  );
  for (const node of [scrim, card, ...PANES.flatMap((pane) => [paneEls[pane].head, paneEls[pane].body])]) {
    node.hidden = true;
    mainEl.appendChild(node);
  }
  const flashEl = el("div", "view-flash");
  flashEl.addEventListener("animationend", () => flashEl.classList.remove("on"));
  mainEl.appendChild(flashEl);
  const dropOverlay = el("div", "pane-drop-overlay");
  const dropPreview = el("div", "pane-drop-preview");
  const dropLabel = el("span", "pane-drop-label");
  dropPreview.appendChild(dropLabel);
  dropOverlay.appendChild(dropPreview);
  dropOverlay.hidden = true;
  mainEl.appendChild(dropOverlay);
  for (const pane of PANES) {
    paneEls[pane].head.addEventListener("pointerdown", (event) => {
      if (event.button === 0 && !event.target.closest("button")) {
        host.startPaneDrag?.(event, pane, paneEls[pane].head);
      }
    });
  }
  peekHead.addEventListener("pointerdown", (event) => {
    if (event.button === 0 && !event.target.closest("button") && peekTarget()) {
      host.startPaneDrag?.(event, "peek", peekHead);
    }
  });

  scrim.addEventListener("mousedown", (event) => {
    event.preventDefault();
    closePeek();
  });

  function el(tag, className) {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  }

  function iconButton(icon, label, onClick, tooltip = true) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "view-btn";
    btn.innerHTML = icon;
    if (tooltip) btn.dataset.tooltip = label;
    btn.setAttribute("aria-label", label);
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return btn;
  }

  /** One divider per border between panes: divider `at` sits between panes `at` and `at + 1`. */
  const dividers = PANES.slice(1).map((_, at) => {
    const node = el("div", "split-divider");
    node.setAttribute("role", "separator");
    node.setAttribute("aria-label", "Resize split");
    node.tabIndex = 0;
    node.hidden = true;
    const tools = el("div", "split-tools");
    const swapBtn = iconButton(ICONS.swap, "Swap panes", () => swapPanes(at));
    const dirBtn = iconButton(ICONS.stack, "Stack panes", () => toggleDir());
    tools.append(swapBtn, dirBtn);
    // A press or a key on a button must not resize the split.
    for (const type of ["pointerdown", "dblclick", "keydown"]) {
      tools.addEventListener(type, (event) => event.stopPropagation());
    }
    // The sizes of the two panes it parts, shown on the divider while it is dragged.
    const ratioEl = el("div", "split-ratio");
    ratioEl.setAttribute("aria-hidden", "true");
    node.append(tools, ratioEl);
    mainEl.insertBefore(node, flashEl);
    return { el: node, at, dirBtn, ratioEl, hoverTimer: 0 };
  });

  /* ---------- storage ---------- */

  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* the view just won't survive a reload */
    }
  }

  function clampStoredRatio(value) {
    return Number.isFinite(value) && value > 0 ? Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, value)) : 0.5;
  }

  /** Sizes scaled to add up to 1. */
  function normalized(sizes) {
    const sum = sizes.reduce((total, size) => total + size, 0) || 1;
    return sizes.map((size) => size / sum);
  }

  function loadSplits() {
    const map = new Map();
    try {
      const raw = JSON.parse(readStorage(SPLITS_KEY) || "{}");
      const stored = (value) => (value?.page ? { kind: "page", id: String(value.page) } : value?.url ? { kind: "url", href: String(value.url) } : null);
      for (const [spaceId, value] of Object.entries(raw || {})) {
        const dir = value?.dir === "col" ? "col" : "row";
        if (Array.isArray(value?.panes)) {
          const panes = value.panes.map(stored).filter(Boolean).slice(0, PANES.length);
          if (panes.length < 2) {
            continue;
          }
          const sizes = panes.map((_, i) => Number(value.sizes?.[i]));
          const valid = panes.length === value.panes.length && sizes.every((size) => Number.isFinite(size) && size > 0);
          const focus = Number.isInteger(value.focus) && panes[value.focus]?.kind === "page" ? value.focus : panes.findIndex((pane) => pane.kind === "page");
          if (focus !== -1) {
            map.set(spaceId, { panes, sizes: normalized(valid ? sizes : panes.map(() => 1)), dir, focus });
          }
          continue;
        }
        // Before splits held more than two panes: the other pane, the focused one's side, and the tab it showed.
        const other = stored(value);
        if (other) {
          const ratio = clampStoredRatio(Number(value.ratio));
          const focus = value.side === 1 ? 1 : 0;
          // activeSplit fills an unknown focused pane with the active tab.
          const own = { kind: "page", id: typeof value.seen === "string" ? value.seen : "" };
          map.set(spaceId, { panes: focus ? [other, own] : [own, other], sizes: [ratio, 1 - ratio], dir, focus });
        }
      }
    } catch {
      /* ignore a damaged entry */
    }
    return map;
  }

  function saveSplits() {
    if (host.solo) {
      return;
    }
    const out = {};
    for (const [spaceId, split] of splits) {
      out[spaceId] = {
        panes: split.panes.map((pane) => (pane.kind === "page" ? { page: pane.id } : { url: pane.href })),
        sizes: split.sizes,
        dir: split.dir,
        focus: split.focus,
      };
    }
    writeStorage(SPLITS_KEY, JSON.stringify(out));
  }

  /* ---------- targets ---------- */

  function frameIdOf(target) {
    return target.kind === "page" ? target.id : "url:" + target.href;
  }

  function sameTarget(a, b) {
    return Boolean(a && b) && frameIdOf(a) === frameIdOf(b);
  }

  function hostnameOf(href) {
    try {
      return new URL(href).host;
    } catch {
      return href;
    }
  }

  /** An http(s) URL outside the board, or null. */
  function externalUrl(raw) {
    const text = String(raw || "").trim();
    if (!/^https?:/i.test(text)) {
      return null;
    }
    try {
      const url = new URL(text);
      if (url.origin === location.origin || host.isPageOrigin(url.origin)) {
        return null;
      }
      return url.href;
    } catch {
      return null;
    }
  }

  /**
   * A page by id or key. Keys can repeat (an agent can't see hidden pages and may reuse the key),
   * so prefer an open tab, then a page the agent can see, then the most recently updated.
   */
  function pageKeyOf(value) {
    const slug = String(value || "")
      .trim()
      .replace(/\|auto$/i, "")
      .replace(/^(scribe:)+/i, "");
    return slug ? `scribe:${slug}` : "";
  }

  /** "key#anchor" as [key, anchor]. A URL keeps its hash. */
  function splitAnchor(raw) {
    const text = String(raw || "").trim();
    const at = text.indexOf("#");
    return at > 0 && !externalUrl(text) ? [text.slice(0, at), text.slice(at + 1).replace(/\|auto$/i, "")] : [text, ""];
  }

  function findPage(raw) {
    const text = String(raw || "").trim().replace(/\|auto$/i, "");
    if (!text) {
      return null;
    }
    const byId = host.findAnyTab(text);
    if (byId) {
      return byId;
    }
    const want = pageKeyOf(text);
    if (!want) {
      return null;
    }
    const matches = [...host.tabs().map((tab) => ({ tab, open: true })), ...host.closed().map((tab) => ({ tab, open: false }))].filter(
      (item) => item.tab.key === text || pageKeyOf(item.tab.key) === want
    );
    matches.sort((a, b) => Number(b.open) - Number(a.open) || Number(!b.tab.agentHidden) - Number(!a.tab.agentHidden) || (b.tab.updatedAt || 0) - (a.tab.updatedAt || 0));
    return matches[0]?.tab || null;
  }

  function metaFor(target) {
    if (target.kind === "page") {
      return host.findAnyTab(target.id);
    }
    return { id: frameIdOf(target), title: hostnameOf(target.href), revision: 0, embedUrl: target.href, url: true };
  }

  function titleOf(target) {
    return target.kind === "page" ? host.findAnyTab(target.id)?.title || "Page" : hostnameOf(target.href);
  }

  async function inTrash(raw) {
    const res = await fetch("/api/trash").catch(() => null);
    if (!res?.ok) {
      return null;
    }
    const data = await res.json().catch(() => null);
    for (const batch of data?.batches || []) {
      const page = (batch.tabs || []).find((tab) => tab.id === raw || tab.key === raw);
      if (page) {
        return page;
      }
    }
    return null;
  }

  /* ---------- temporary pages (#655) ---------- */

  /** The path a file: link names ("file:///C:/a.png", "file:C:\\a.png", "file:/home/a"), or "". */
  function fileLinkPath(raw) {
    const text = String(raw || "").trim().replace(/\|auto$/i, "");
    if (!/^file:/i.test(text)) {
      return "";
    }
    let rest = text.slice(5);
    if (rest.startsWith("//")) {
      rest = rest.slice(2);
      // file://server/share is a network path.
      if (!rest.startsWith("/")) rest = "//" + rest;
    }
    if (/^\/[A-Za-z]:/.test(rest)) {
      rest = rest.slice(1);
    }
    try {
      rest = decodeURIComponent(rest);
    } catch {
      /* not encoded */
    }
    return rest;
  }

  function samePathText(a, b) {
    const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return norm(a) === norm(b);
  }

  /** The page that already shows this file, if any. */
  function filePageOf(file) {
    return [...host.tabs(), ...host.closed()].find((tab) => tab.file && samePathText(tab.file.path, file)) || null;
  }

  /** Temporary pages this window just made, so the sweep leaves them until a view shows them. */
  const freshTemps = new Map();
  const TEMP_GRACE_MS = 5000;

  /** The page meta once the board has it (it arrives over the socket after the request returns). */
  async function arrived(id) {
    for (let i = 0; i < 60 && !host.findAnyTab(id); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return host.findAnyTab(id) || null;
  }

  async function postTemp(path, body, failure) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const data = res ? await res.json().catch(() => null) : null;
    if (!res?.ok || !data?.tab) {
      host.showNotice(data?.error || failure);
      return null;
    }
    if (data.tab.temp) {
      freshTemps.set(data.tab.id, Date.now());
    }
    return arrived(data.tab.id);
  }

  /** A file link's page: the one that shows the file, or a new temporary page for it. */
  function tempFilePage(file) {
    return postTemp("/api/files/open", { path: file, temp: true, activate: false }, "Could not open the file");
  }

  /**
   * A site for a split as a temporary page (#403), so its pane has a tab like any page. Null when the
   * site refuses to be framed: it then stays a site pane, which says so.
   */
  async function sitePage(href) {
    if (!framingAllowed && !blocked.has(href)) {
      const res = await fetch(`/api/frame-check?url=${encodeURIComponent(href)}`).catch(() => null);
      const data = res?.ok ? await res.json().catch(() => null) : null;
      if (data?.framable === false) {
        blocked.set(href, data.reason || "");
      }
    }
    if (blocked.has(href)) {
      return null;
    }
    return postTemp("/api/temp-pages/url", { url: href }, "Could not open the site");
  }

  let sweepTimer = 0;
  /**
   * Temporary pages without a tab live only in a peek: once no peek shows one, it goes. Ones with a
   * tab go when the tab closes (the daemon drops them).
   */
  function sweepTemps() {
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(() => {
      const shown = new Set();
      for (const peek of peeks.values()) {
        for (const target of peek.stack) if (target.kind === "page") shown.add(target.id);
      }
      const now = Date.now();
      for (const tab of host.closed()) {
        if (!tab.temp || shown.has(tab.id) || now - (freshTemps.get(tab.id) || 0) < TEMP_GRACE_MS) {
          continue;
        }
        freshTemps.delete(tab.id);
        fetch(`/api/tabs/${encodeURIComponent(tab.id)}`, { method: "DELETE" }).catch(() => {});
      }
    }, 500);
  }

  /* ---------- state queries ---------- */

  function peekKey() {
    return JSON.stringify([host.spaceId(), host.activeId()]);
  }

  function activePeek() {
    return peeks.get(peekKey()) || null;
  }

  function setPeek(value) {
    if (value) peeks.set(peekKey(), value);
    else peeks.delete(peekKey());
    sweepTemps();
  }

  function peekTarget() {
    const peek = activePeek();
    return peek ? peek.stack[peek.stack.length - 1] : null;
  }

  /** A page that can fill a pane: it has a tab in the strip (or is about to), or is the New page. */
  function showable(id) {
    return host.tabs().some((tab) => tab.id === id) || host.draftId() === id || opening.has(id);
  }

  function isPage(target, id) {
    return target.kind === "page" && target.id === id;
  }

  /** Take the pane at `index` out of a split. Its share goes to the others; false when that ends the split. */
  function removePane(spaceId, split, index) {
    split.panes.splice(index, 1);
    split.sizes.splice(index, 1);
    if (split.panes.length < 2 || !split.panes.some((pane) => pane.kind === "page")) {
      splits.delete(spaceId);
      return false;
    }
    split.sizes = normalized(split.sizes);
    if (index < split.focus) {
      split.focus -= 1;
    }
    split.focus = Math.min(split.focus, split.panes.length - 1);
    return true;
  }

  /** Take every pane without focus that matches out of a split. True when one was. */
  function removePanesBeside(spaceId, split, match) {
    let changed = false;
    for (let i = split.panes.length - 1; i >= 0 && splits.get(spaceId) === split; i--) {
      if (i !== split.focus && match(split.panes[i])) {
        removePane(spaceId, split, i);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * The split around the active tab, with the focused pane holding that tab. When the active tab is
   * the page of another pane (a picked tab, Back, an agent's focus request, a closed tab's neighbor),
   * focus moved there, and the pane it left goes when its tab is gone. Any other active tab shows in
   * the focused pane.
   */
  function activeSplit() {
    // A page in a window of its own has no panes; the splits belong to the main window.
    if (host.solo) {
      return null;
    }
    const active = host.activeId();
    const spaceId = host.spaceId();
    const split = active ? splits.get(spaceId) || null : null;
    if (!split) {
      return null;
    }
    const own = split.panes[split.focus];
    if (isPage(own, active)) {
      return split;
    }
    const at = split.panes.findIndex((pane) => isPage(pane, active));
    if (at === -1) {
      split.panes[split.focus] = { kind: "page", id: active };
    } else {
      const from = split.focus;
      split.focus = at;
      if (!showable(own.id) && !removePane(spaceId, split, from)) {
        saveSplits();
        return null;
      }
    }
    saveSplits();
    return split;
  }

  /** The place of the pane showing a frame, or -1. */
  function paneIndex(split, frameId) {
    return split ? split.panes.findIndex((pane) => frameIdOf(pane) === frameId) : -1;
  }

  /** Which pane ("a" first, then "b" and so on) a frame is in, or "" outside a split. */
  function paneOf(frameId) {
    return PANES[paneIndex(activeSplit(), frameId)] || "";
  }

  /** The place of the pane focus falls to when the focused one goes: the nearest page, the next one first. */
  function fallbackIndex(split) {
    const usable = (i) => i !== split.focus && split.panes[i]?.kind === "page" && showable(split.panes[i].id);
    for (let step = 1; step < split.panes.length; step++) {
      if (usable(split.focus + step)) return split.focus + step;
      if (usable(split.focus - step)) return split.focus - step;
    }
    return -1;
  }

  /** The page focus falls to when the focused pane goes, or null. */
  function otherPage() {
    const split = activeSplit();
    const at = split ? fallbackIndex(split) : -1;
    return at === -1 ? null : host.findAnyTab(split.panes[at].id);
  }

  /** The pages in the panes without focus. */
  function besidePages() {
    const split = activeSplit();
    return split ? split.panes.filter((pane, i) => i !== split.focus && pane.kind === "page").map((pane) => host.findAnyTab(pane.id)).filter(Boolean) : [];
  }

  /** Every frame the current view puts on screen, so the pool never evicts one of them. */
  function shownIds() {
    const ids = new Set();
    const active = host.activeId();
    if (active) {
      ids.add(active);
    }
    const split = activeSplit();
    if (split) {
      for (const pane of split.panes) ids.add(frameIdOf(pane));
    }
    const top = peekTarget();
    if (top) {
      ids.add(frameIdOf(top));
    }
    if (closingPeek && closingPeek.key === peekKey()) ids.add(frameIdOf(closingPeek.target));
    return ids;
  }

  function isShown(id) {
    return shownIds().has(id);
  }

  function mainTooNarrow() {
    return mainEl.clientWidth < SPLIT_MIN_MAIN;
  }

  /** Whether the page area has room for `count` panes laid out along `dir`. */
  function roomFor(count, dir) {
    if (count > PANES.length) {
      return false;
    }
    return dir === "col" ? mainEl.clientHeight >= SPLIT_MIN_PANE_HEIGHT * count : mainEl.clientWidth >= SPLIT_ADD_MIN_PANE * count;
  }

  /* ---------- frames ---------- */

  function frameFor(target) {
    if (target.kind === "url" && blocked.has(target.href)) {
      host.discardFrame(frameIdOf(target));
      return null;
    }
    const meta = metaFor(target);
    if (!meta) {
      return null;
    }
    const entry = host.ensureFrame(meta);
    if (target.kind === "url") {
      if (!entry.el.dataset.urlHooked) {
        entry.el.dataset.urlHooked = "1";
        entry.el.classList.add("url-loading");
        entry.el.addEventListener("load", () => entry.el.classList.remove("url-loading"));
      }
      checkUrl(target.href);
    }
    return entry;
  }

  async function checkUrl(href) {
    if (framingAllowed || checking.has(href) || blocked.has(href)) {
      return;
    }
    checking.add(href);
    const res = await fetch(`/api/frame-check?url=${encodeURIComponent(href)}`).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    if (data?.framable === false) {
      blocked.set(href, data.reason || "");
      host.render();
    }
  }

  /** URL frames are not pages; keep them while a view still references them. */
  function dropUnusedUrlFrames() {
    const keep = shownIds();
    for (const peek of peeks.values()) {
      for (const target of peek.stack) keep.add(frameIdOf(target));
    }
    for (const split of splits.values()) {
      for (const pane of split.panes) keep.add(frameIdOf(pane));
    }
    for (const id of host.frameIds()) {
      if (id.startsWith("url:") && !keep.has(id)) {
        host.discardFrame(id);
      }
    }
  }

  /** Outline a frame that is already on screen. The outline sits over the frame, which covers its own box. */
  function flash(frameId) {
    const entry = host.frame(frameId);
    if (!entry) {
      return;
    }
    const frame = entry.el;
    const left = frame.offsetLeft;
    const top = frame.offsetTop;
    const right = left + frame.offsetWidth;
    const bottom = top + frame.offsetHeight;
    flashEl.style.left = left + "px";
    flashEl.style.top = top + "px";
    flashEl.style.width = frame.offsetWidth + "px";
    flashEl.style.height = frame.offsetHeight + "px";
    // A corner of the frame that sits in a corner of the page area is rounded by it, so follow that curve.
    const own = getComputedStyle(frame);
    const outer = getComputedStyle(mainEl);
    const atLeft = left <= 1;
    const atTop = top <= 1;
    const atRight = right >= mainEl.clientWidth - 1;
    const atBottom = bottom >= mainEl.clientHeight - 1;
    flashEl.style.borderTopLeftRadius = atLeft && atTop ? outer.borderTopLeftRadius : own.borderTopLeftRadius;
    flashEl.style.borderTopRightRadius = atRight && atTop ? outer.borderTopRightRadius : own.borderTopRightRadius;
    flashEl.style.borderBottomLeftRadius = atLeft && atBottom ? outer.borderBottomLeftRadius : own.borderBottomLeftRadius;
    flashEl.style.borderBottomRightRadius = atRight && atBottom ? outer.borderBottomRightRadius : own.borderBottomRightRadius;
    flashEl.classList.remove("on");
    void flashEl.offsetWidth;
    flashEl.classList.add("on");
  }

  function deliverAnchor() {
    if (!pendingAnchor) {
      return;
    }
    const { frameId, anchor } = pendingAnchor;
    const entry = host.frame(frameId);
    if (!entry) {
      return;
    }
    pendingAnchor = null;
    const send = () => entry.el.contentWindow?.postMessage({ type: "scribe-scroll", id: frameId, anchor }, "*");
    if (entry.el.dataset.loaded) {
      send();
    } else {
      entry.el.addEventListener("load", send, { once: true });
    }
  }

  /* ---------- layout ---------- */

  function stopSplitAnimation() {
    for (const animation of splitAnimations) animation.cancel();
    splitAnimations = [];
  }

  /** Snap iframe geometry once, then animate only its composited position. */
  function animateSplitLayout(previousBoxes, split) {
    const options = { token: "enter" };
    for (const node of mainEl.querySelectorAll('[data-pane], .split-divider, [data-role="primary"], .newpage')) {
      if (node.hidden || node.classList.contains("inactive")) continue;
      const before = previousBoxes.get(node);
      const after = node.getBoundingClientRect();
      if (before) {
        splitAnimations.push(window.scribeMotion.animate(node, [
          { transform: `translate(${before.left - after.left}px, ${before.top - after.top}px)` },
          { transform: "none" },
        ], options));
      } else if (split) {
        const offset = split.dir === "col" ? "translateY(16px)" : "translateX(16px)";
        // A cold frame reveals its content after load. An opacity keyframe captured here
        // would otherwise override that reveal, then snap to visible when it finishes.
        const loading = node.matches("iframe.frame-loading, iframe.url-loading");
        splitAnimations.push(window.scribeMotion.animate(node, [
          { ...(loading ? {} : { opacity: 0 }), transform: offset },
          { ...(loading ? {} : { opacity: getComputedStyle(node).opacity }), transform: "none" },
        ], options));
      }
    }
  }

  /** The least share of the page area a pane is shown with. */
  function minShare(split) {
    const col = split.dir === "col";
    const size = (col ? mainEl.clientHeight : mainEl.clientWidth) || 1;
    const min = col ? SPLIT_MIN_PANE_HEIGHT : SPLIT_MIN_PANE;
    const count = split.panes.length;
    return Math.min(1 / count, Math.max((SPLIT_MIN_RATIO * 2) / count, min / size));
  }

  /** The panes' shares as shown: the stored sizes, with no pane under the least share. */
  function shownSizes(split) {
    const lo = minShare(split);
    const sizes = split.sizes.map((size) => Math.max(lo, size));
    const over = sizes.reduce((total, size) => total + size, 0) - 1;
    const slack = sizes.reduce((total, size) => total + size - lo, 0);
    return over > 1e-9 && slack > 0 ? sizes.map((size) => size - ((size - lo) / slack) * over) : sizes;
  }

  /** Where each pane starts, as a share of the page area, and 1 for the end of the last. */
  function stopsFor(split) {
    const stops = [0];
    for (const size of shownSizes(split)) stops.push(stops[stops.length - 1] + size);
    stops[stops.length - 1] = 1;
    return stops;
  }

  /** Hand the panes' places to the CSS, and to each divider its own. */
  function applyStops(split) {
    const stops = stopsFor(split);
    for (let i = 1; i < PANES.length; i++) {
      mainEl.style.setProperty(`--split-${i}`, String(stops[i] ?? 1));
    }
    const lo = minShare(split);
    const percent = (value) => String(Math.round(value * 100));
    for (const divider of dividers) {
      const at = divider.at;
      if (at + 2 >= stops.length) {
        continue;
      }
      divider.el.style.setProperty("--at", String(stops[at + 1]));
      divider.el.setAttribute("aria-valuemin", percent(stops[at] + lo));
      divider.el.setAttribute("aria-valuemax", percent(stops[at + 2] - lo));
      divider.el.setAttribute("aria-valuenow", percent(stops[at + 1]));
    }
    return stops;
  }

  /** Put every pooled frame where the view wants it. Called from app.js's render. */
  function layout() {
    const active = host.activeTab();
    const split = active ? activeSplit() : null;
    const layoutKey = split ? JSON.stringify([host.spaceId(), split.dir, stopsFor(split), split.panes.map(frameIdOf)]) : "";
    const hadSplit = mainEl.classList.contains("has-split");
    const motion = window.scribeMotion.enabled();
    const openingSplit = split && !hadSplit && motion;
    const closingSplit = !split && hadSplit && motion;
    const previousBoxes = new Map();
    if (closingSplit) {
      for (const node of mainEl.querySelectorAll("[data-pane]")) {
        if (!node.hidden && !node.classList.contains("inactive")) previousBoxes.set(node, node.getBoundingClientRect());
      }
    }
    if (openingSplit) {
      for (const id of host.frameIds()) {
        const node = host.frame(id).el;
        if (node.dataset.role === "primary" && !node.classList.contains("inactive")) previousBoxes.set(node, node.getBoundingClientRect());
      }
      const draft = mainEl.querySelector(".newpage:not([hidden])");
      if (draft) previousBoxes.set(draft, draft.getBoundingClientRect());
    }
    // Capture the displayed size before cancelling an interrupted opening or closing.
    if (layoutKey !== splitLayoutKey) stopSplitAnimation();
    splitLayoutKey = layoutKey;
    const inPane = (target) => Boolean(split && target) && paneIndex(split, frameIdOf(target)) !== -1;
    if (inPane(peekTarget())) {
      setPeek(null);
    }
    const top = peekTarget();
    // A new peek or a different tab takes over immediately, without an old
    // animation later hiding the new view.
    if (closingPeek && (top || closingPeek.key !== peekKey() || inPane(closingPeek.target))) stopPeekClosing();
    const visibleTop = top || closingPeek?.target;
    const roles = new Map();
    const panes = new Map();
    // A New page has no frame: the New page screen stands in for it.
    if (active && !host.isBlank(active)) {
      host.ensureFrame(active);
      roles.set(active.id, "primary");
    }
    if (split) {
      split.panes.forEach((pane, i) => {
        panes.set(frameIdOf(pane), PANES[i]);
        if (i === split.focus) {
          return;
        }
        const page = pane.kind === "page" ? metaFor(pane) : null;
        if (!host.isBlank(page) && frameFor(pane)) {
          roles.set(frameIdOf(pane), "secondary");
        }
        if (pane.kind === "page") {
          host.markSeen(pane.id);
          if (host.tabs().some((tab) => tab.id === pane.id)) {
            opening.delete(pane.id);
          }
        }
      });
    }
    if (visibleTop) {
      if (frameFor(visibleTop)) {
        roles.set(frameIdOf(visibleTop), "peek");
      }
      if (top?.kind === "page") {
        host.markSeen(top.id);
      }
    }
    for (const id of host.frameIds()) {
      const entry = host.frame(id);
      const role = roles.get(id) || "";
      const pane = role === "peek" ? "" : panes.get(id) || "";
      entry.el.classList.toggle("inactive", !role);
      if (!role) host.releaseFrame?.(id);
      if (entry.el.dataset.role !== role) {
        entry.el.dataset.role = role;
      }
      if ((entry.el.dataset.pane || "") !== pane) {
        if (pane) entry.el.dataset.pane = pane;
        else delete entry.el.dataset.pane;
      }
    }
    mainEl.classList.toggle("has-split", Boolean(split));
    mainEl.classList.toggle("split-col", split?.dir === "col");
    mainEl.classList.toggle("has-peek", Boolean(visibleTop));
    if (split) {
      applyStops(split);
    }
    renderSplitChrome(split);
    renderPeekChrome(top);
    dropUnusedUrlFrames();
    deliverAnchor();
    if (openingSplit || closingSplit) {
      // app.js assigns the New page's pane immediately after layout returns.
      queueMicrotask(() => {
        if (splitLayoutKey === layoutKey) animateSplitLayout(previousBoxes, split);
      });
    }
  }

  function renderSplitChrome(split) {
    const count = split ? split.panes.length : 0;
    for (const divider of dividers) {
      divider.el.hidden = divider.at + 1 >= count;
    }
    PANES.forEach((pane, i) => {
      paneEls[pane].head.hidden = i >= count;
      paneEls[pane].body.hidden = i >= count;
    });
    if (!split) {
      return;
    }
    const col = split.dir === "col";
    const dirLabel = col ? "Show side by side" : "Stack panes";
    for (const divider of dividers) {
      divider.el.setAttribute("aria-orientation", col ? "horizontal" : "vertical");
      if (divider.dirBtn.getAttribute("aria-label") !== dirLabel) {
        divider.dirBtn.innerHTML = col ? ICONS.sideBySide : ICONS.stack;
        divider.dirBtn.dataset.tooltip = dirLabel;
        divider.dirBtn.setAttribute("aria-label", dirLabel);
      }
    }
    // The focused pane's page needs another page to hand focus to: a site has no tab to fall back to.
    const canLeave = fallbackIndex(split) !== -1;
    split.panes.forEach((target, i) => {
      renderPaneHead(PANES[i], target, i === split.focus, i !== split.focus || canLeave);
    });
  }

  /** A pane's header. Redrawn only when what it shows changes, so a button under the pointer stays put. */
  function renderPaneHead(pane, target, focused, closable) {
    const { head, body } = paneEls[pane];
    head.classList.toggle("focused", focused);
    // A New page is no page yet: its title is a placeholder, and there is nothing to peek at.
    const blank = target.kind === "page" && host.isBlank(metaFor(target));
    const key = JSON.stringify([frameIdOf(target), titleOf(target), closable, blank, target.kind === "url" && blocked.has(target.href)]);
    if (paneEls[pane].drawn === key) {
      return;
    }
    paneEls[pane].drawn = key;
    head.classList.toggle("blank", blank);
    const parts = [headTitle(target)];
    if (target.kind === "url") {
      parts.push(iconButton(ICONS.browser, "Open in browser", () => openBrowser(target.href)));
    }
    if (closable && !blank) {
      parts.push(iconButton(ICONS.peek, "Show as peek", () => paneToPeek(pane)));
    }
    if (closable) {
      parts.push(iconButton(ICONS.close, "Close pane", () => closePane(pane), false));
    }
    head.replaceChildren(...parts);
    renderBody(body, target);
  }

  let peekDrawn = null;

  function renderPeekChrome(top) {
    if (!top && closingPeek) return;
    const show = Boolean(top);
    scrim.hidden = !show;
    card.hidden = !show;
    if (!show) {
      peekDrawn = null;
      return;
    }
    // Like a pane's header: redrawn only when what it shows changes.
    const key = JSON.stringify([frameIdOf(top), titleOf(top), activePeek().stack.length > 1, top.kind === "url" && blocked.has(top.href)]);
    if (peekDrawn === key) {
      return;
    }
    peekDrawn = key;
    const parts = [];
    if (activePeek().stack.length > 1) {
      parts.push(iconButton(ICONS.back, "Back", () => peekBack(), false));
    }
    parts.push(
      headTitle(top),
      top.kind === "url" && iconButton(ICONS.browser, "Open in browser", () => openBrowser(top.href)),
      !(top.kind === "url" && blocked.has(top.href)) && iconButton(ICONS.tab, "Open as tab", () => promote(top)),
      !host.solo && iconButton(ICONS.split, "Show in split", () => peekToSplit()),
      iconButton(ICONS.close, "Close", () => closePeek(), false)
    );
    peekHead.replaceChildren(...parts.filter(Boolean));
    card.setAttribute("aria-label", titleOf(top));
    renderBody(peekBody, top);
  }

  function headTitle(target) {
    const wrap = el("div", "view-title");
    const title = el("span", "view-title-text");
    title.textContent = titleOf(target);
    wrap.appendChild(title);
    if (target.kind === "url") {
      wrap.dataset.tooltip = target.href;
      const path = el("span", "view-title-sub");
      try {
        const url = new URL(target.href);
        path.textContent = url.pathname === "/" && !url.search ? "" : url.pathname + url.search;
      } catch {
        path.textContent = "";
      }
      if (path.textContent) {
        wrap.appendChild(path);
      }
    } else {
      wrap.dataset.tooltip = titleOf(target);
    }
    return wrap;
  }

  /** The area under a peek or split frame: a loading line for sites, or why a site can't be shown. */
  function renderBody(body, target) {
    if (target.kind !== "url") {
      body.replaceChildren();
      return;
    }
    const hostname = hostnameOf(target.href);
    if (!blocked.has(target.href)) {
      const loading = el("p", "view-loading");
      loading.textContent = `Loading ${hostname}…`;
      body.replaceChildren(loading);
      return;
    }
    const box = el("div", "view-blocked");
    const text = el("p", "");
    const strong = document.createElement("strong");
    strong.textContent = hostname;
    text.append(strong, " doesn't allow being shown inside other pages.");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = ICONS.browser + "<span>Open in browser</span>";
    btn.addEventListener("click", () => openBrowser(target.href));
    box.append(text, btn);
    body.replaceChildren(box);
  }

  /* ---------- actions ---------- */

  function openBrowser(href) {
    window.open(href, "_blank", "noopener,noreferrer");
  }

  function closePeek({ refocus = true } = {}) {
    if (closingPeek) return true;
    if (!activePeek()) {
      return false;
    }
    const target = peekTarget();
    if (!card.hidden && window.scribeMotion.enabled()) {
      const nodes = [scrim, card, host.frame(frameIdOf(target))?.el].filter(Boolean);
      const closing = { key: peekKey(), target, nodes, animations: [] };
      closingPeek = closing;
      const options = { token: "leave", fill: "forwards" };
      for (const node of nodes) {
        const style = getComputedStyle(node);
        node.inert = true;
        closing.animations.push(window.scribeMotion.animate(node, [
          { opacity: style.opacity, transform: style.transform },
          { opacity: 0, transform: node === scrim ? "none" : "translateY(6px) scale(0.99)" },
        ], options));
      }
      Promise.all(closing.animations.map(animation => animation.finished)).then(() => {
        if (closingPeek !== closing) return;
        stopPeekClosing();
        host.render();
      }).catch(() => {}); // A replacement view cancels these animations.
    }
    setPeek(null);
    host.render();
    if (refocus) {
      host.frame(host.activeId())?.el.focus();
    }
    return true;
  }

  function stopPeekClosing() {
    if (!closingPeek) return;
    for (const node of closingPeek.nodes) node.inert = false;
    for (const animation of closingPeek.animations) animation.cancel();
    closingPeek = null;
  }

  function peekBack() {
    const peek = activePeek();
    if (!peek || peek.stack.length < 2) {
      return;
    }
    peek.stack.pop();
    host.render();
    focusPeek();
  }

  function focusPeek() {
    const top = peekTarget();
    if (top) {
      host.frame(frameIdOf(top))?.el.focus();
    }
  }

  function focusActiveFrame() {
    host.frame(host.activeId())?.el.focus();
  }

  /** Give a page pane a tab in the strip when it has none: every page pane of a split is a tab. */
  function ensureTab(target) {
    if (target.kind !== "page" || showable(target.id)) {
      return;
    }
    opening.add(target.id);
    Promise.resolve(host.openPage(target.id, { activate: false })).finally(() => {
      // The tab arrives over the socket; give it a moment before the split may be pruned without it.
      setTimeout(() => opening.delete(target.id), 2000);
    });
  }

  /**
   * Show `target` beside the focused pane: in the pane after it (before it, when it is the last),
   * replacing what is there, or in a new split (side by side) when there is none.
   */
  function setSplit(target) {
    const split = activeSplit();
    ensureTab(target);
    if (split) {
      split.panes[split.focus + 1 < split.panes.length ? split.focus + 1 : split.focus - 1] = target;
    } else {
      splits.set(host.spaceId(), {
        panes: [{ kind: "page", id: host.activeId() }, target],
        sizes: [lastRatio, 1 - lastRatio],
        dir: "row",
        focus: 0,
      });
    }
    saveSplits();
  }

  /**
   * Take a pane out of the split; its page stays a tab. The focused pane first hands focus to the
   * nearest page beside it. Returns the pane's target, or null when it can't go.
   */
  function takePane(pane) {
    const split = activeSplit();
    const index = PANES.indexOf(pane);
    const target = split?.panes[index];
    if (!target) {
      return null;
    }
    if (index === split.focus) {
      const next = fallbackIndex(split);
      if (next === -1) {
        return null;
      }
      const nextId = split.panes[next].id;
      host.activate(nextId);
      if (host.activeId() !== nextId || activeSplit() !== split) {
        return null;
      }
    }
    removePane(host.spaceId(), split, split.panes.indexOf(target));
    saveSplits();
    return target;
  }

  /** Close a pane. Closing the focused pane moves focus to the nearest page beside it. */
  function closePane(pane) {
    if (!takePane(pane)) {
      return false;
    }
    host.render();
    focusActiveFrame();
    return true;
  }

  /** End the split on the focused pane. */
  function closeSplit() {
    if (!activeSplit()) {
      return false;
    }
    splits.delete(host.spaceId());
    saveSplits();
    host.render();
    focusActiveFrame();
    return true;
  }

  /** Move focus to a pane; the tab strip and the chat follow, as they do for a tab switch. */
  function focusPane(pane) {
    const split = activeSplit();
    const index = PANES.indexOf(pane);
    const target = split?.panes[index];
    if (!target || index === split.focus || target.kind !== "page" || !showable(target.id)) {
      return false;
    }
    host.activate(target.id);
    return true;
  }

  /** Trade the places of two panes; each keeps its size. */
  function tradePanes(split, i, j) {
    [split.panes[i], split.panes[j]] = [split.panes[j], split.panes[i]];
    [split.sizes[i], split.sizes[j]] = [split.sizes[j], split.sizes[i]];
    split.focus = split.focus === i ? j : split.focus === j ? i : split.focus;
  }

  /** Swap the panes on either side of divider `at`. */
  function swapPanes(at) {
    const split = activeSplit();
    if (!split || at + 1 >= split.panes.length) {
      return;
    }
    split.sizes = shownSizes(split);
    tradePanes(split, at, at + 1);
    saveSplits();
    host.render();
  }

  function toggleDir() {
    const split = activeSplit();
    if (!split) {
      return;
    }
    split.dir = split.dir === "col" ? "row" : "col";
    saveSplits();
    host.render();
  }

  /* ---------- pointer drops from the strip and pane headers ---------- */

  function beginPageDrag(source) {
    const surface = getComputedStyle(mainEl);
    pageDrag = { ...source, surface: {
      borderTopLeftRadius: surface.borderTopLeftRadius, borderTopRightRadius: surface.borderTopRightRadius,
      borderBottomLeftRadius: surface.borderBottomLeftRadius, borderBottomRightRadius: surface.borderBottomRightRadius,
    } };
    dropOverlay.hidden = false;
    dropPreview.hidden = true;
    document.body.classList.add("dragging-pane");
  }

  /** What a drag carries: a pane's or the peek's target, or a tab's page. */
  function targetOf(source) {
    if (source.pane === "peek") {
      return peekTarget();
    }
    if (source.pane) {
      return activeSplit()?.panes[PANES.indexOf(source.pane)] || null;
    }
    return source.id ? { kind: "page", id: source.id } : null;
  }

  /**
   * The split after `target` is dropped on an edge of pane `at`. An edge along the split puts it
   * beside that pane; an edge across it turns the split and puts it first or last. A pane already in
   * the split moves with its size, a new one takes an even share. Null when nothing would change.
   */
  function planEdgeDrop(split, target, edge, at) {
    const dir = edge === "top" || edge === "bottom" ? "col" : "row";
    const after = edge === "right" || edge === "bottom";
    const panes = [...split.panes];
    let sizes = shownSizes(split);
    const own = panes[split.focus];
    const anchor = panes[at];
    const from = paneIndex(split, frameIdOf(target));
    let pane = target;
    let size = 1 / (panes.length + 1);
    if (from === -1) {
      sizes = sizes.map((share) => share * (1 - size));
    } else {
      [pane] = panes.splice(from, 1);
      [size] = sizes.splice(from, 1);
    }
    const index = dir !== split.dir ? (after ? panes.length : 0) : pane === anchor ? from : panes.indexOf(anchor) + (after ? 1 : 0);
    if (from === index && dir === split.dir) {
      return null;
    }
    panes.splice(index, 0, pane);
    sizes.splice(index, 0, size);
    return { panes, sizes, dir, focus: panes.indexOf(own), index };
  }

  function pageDropAt(x, y) {
    if (!pageDrag || !host.activeId() || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const box = window.scribeDrag.rect(mainEl);
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null;
    const dx = x - box.left, dy = y - box.top;
    const split = activeSplit();
    const target = targetOf(pageDrag);
    const from = split && target ? paneIndex(split, frameIdOf(target)) : -1;
    // The pane under the pointer.
    let at = 0;
    if (split) {
      const along = split.dir === "col" ? dy / box.height : dx / box.width;
      at = Math.max(0, stopsFor(split).findIndex((stop, i) => i > 0 && along <= stop) - 1);
    }
    const rect = dropPaneRect(at, split);
    // Replacement is a deliberate drop at the centre of a pane. Everything around it
    // arranges a split, even on large displays where a fixed edge band was hard to reach.
    if (!pageDrag.pane || pageDrag.pane === "peek") {
      const cx = (rect.left + rect.width / 2) * box.width;
      const cy = (rect.top + rect.height / 2) * box.height;
      if (Math.abs(dx - cx) <= Math.min(108, rect.width * box.width * 0.18) &&
          Math.abs(dy - cy) <= Math.min(72, rect.height * box.height * 0.18)) {
        const samePane = split ? from === at : pageDrag.id === host.activeId();
        if (pageDrag.pane === "peek" || samePane) return null;
        return { pane: PANES[at] };
      }
    }
    const edges = [
      ["left", dx / box.width],
      ["right", (box.width - dx) / box.width],
      ["top", dy / box.height],
      ["bottom", (box.height - dy) / box.height],
    ].sort((a, b) => a[1] - b[1]);
    let edge = edges[0][0];
    const col = edge === "top" || edge === "bottom";
    if (!split) {
      if ((col ? box.height < SPLIT_MIN_PANE_HEIGHT * 2 : mainTooNarrow())) return null;
      return { edge };
    }
    if (!target) return null;
    if (!roomFor(split.panes.length + (from === -1 ? 1 : 0), col ? "col" : "row")) {
      // No room for one more pane: a tab takes the place of the pane under it instead.
      return from === -1 && !pageDrag.pane ? { pane: PANES[at] } : null;
    }
    // Towards an edge across the split, the drop turns it. Along it, the drop lands beside the
    // pane under the pointer, on the side of the half it is over.
    if (col !== (split.dir === "col")) return { edge };
    if (col) edge = dy / box.height < rect.top + rect.height / 2 ? "top" : "bottom";
    else edge = dx / box.width < rect.left + rect.width / 2 ? "left" : "right";
    return planEdgeDrop(split, target, edge, at) ? { edge, at } : null;
  }

  /** A pane's box as shares of the page area; all of it without a split. */
  function dropPaneRect(at, split, stops = split ? stopsFor(split) : null, dir = split?.dir) {
    const rect = { left: 0, top: 0, width: 1, height: 1 };
    if (stops) {
      if (dir === "col") { rect.top = stops[at]; rect.height = stops[at + 1] - stops[at]; }
      else { rect.left = stops[at]; rect.width = stops[at + 1] - stops[at]; }
    }
    return rect;
  }

  function updatePageDrag(x, y) {
    const drop = pageDropAt(x, y);
    dropPreview.hidden = !drop;
    if (!drop) return null;
    const split = activeSplit();
    let left = 0, top = 0, width = 1, height = 1;
    if (drop.edge && split) {
      // Where the dropped pane will be.
      const plan = planEdgeDrop(split, targetOf(pageDrag), drop.edge, drop.at);
      const stops = plan.sizes.reduce((all, size) => [...all, all[all.length - 1] + size], [0]);
      ({ left, top, width, height } = dropPaneRect(plan.index, split, stops, plan.dir));
    } else if (drop.edge) {
      if (drop.edge === "left" || drop.edge === "right") {
        width = 0.5; left = drop.edge === "right" ? 0.5 : 0;
      } else {
        height = 0.5; top = drop.edge === "bottom" ? 0.5 : 0;
      }
    } else if (split) {
      ({ left, top, width, height } = dropPaneRect(PANES.indexOf(drop.pane), split));
    }
    const edgeOn = (value) => Math.abs(value) < 1e-6;
    // Keep the rim inside the rounded page surface. Outer corners follow its curvature;
    // newly created corners at the split seam get their own smaller radius.
    const surface = pageDrag.surface;
    const radius = (corner, outer) => outer ? Math.max(0, parseFloat(surface[corner]) - 6) + "px" : "10px";
    Object.assign(dropPreview.style, {
      left: `calc(${left * 100}% + 6px)`, top: `calc(${top * 100}% + 6px)`,
      width: `calc(${width * 100}% - 12px)`, height: `calc(${height * 100}% - 12px)`,
      borderTopLeftRadius: radius("borderTopLeftRadius", edgeOn(left) && edgeOn(top)),
      borderTopRightRadius: radius("borderTopRightRadius", edgeOn(left + width - 1) && edgeOn(top)),
      borderBottomLeftRadius: radius("borderBottomLeftRadius", edgeOn(left) && edgeOn(top + height - 1)),
      borderBottomRightRadius: radius("borderBottomRightRadius", edgeOn(left + width - 1) && edgeOn(top + height - 1)),
    });
    dropLabel.textContent = drop.edge ? "Place " + drop.edge : "Replace pane";
    return drop;
  }

  function endPageDrag() {
    pageDrag = null;
    dropOverlay.hidden = true;
    document.body.classList.remove("dragging-pane");
  }

  function canCloseDraggedPane(pane) {
    if (pane === "peek") return peekTarget()?.kind === "page";
    const split = activeSplit();
    const index = PANES.indexOf(pane);
    return Boolean(split?.panes[index] && (index !== split.focus || fallbackIndex(split) !== -1));
  }

  /** The Scribe page under a header; URL panes do not have a page to tear off. */
  function pageInPane(pane) {
    const target = targetOf({ pane });
    return target?.kind === "page" ? host.findAnyTab(target.id) : null;
  }

  /** Remove a page's views after it leaves for its own window. The other panes stay. */
  function onPopOut(id) {
    const pane = paneOf(id);
    if (pane) closePane(pane);
    onClosed(id);
    for (const [key, peek] of peeks) {
      peek.stack = peek.stack.filter(target => target.kind !== "page" || target.id !== id);
      if (!peek.stack.length) peeks.delete(key);
    }
  }

  async function dropPage(source, drop) {
    if (!drop) return;
    if (drop.strip) {
      if (source.pane === "peek") {
        const target = peekTarget();
        if (target) promote(target);
        return;
      }
      if (source.pane && canCloseDraggedPane(source.pane)) closePane(source.pane);
      return;
    }
    let split = activeSplit();
    if (drop.edge) {
      const target = targetOf(source);
      if (!target) return;
      if (split) {
        const plan = planEdgeDrop(split, target, drop.edge, drop.at || 0);
        if (!plan) return;
        if (source.pane === "peek") setPeek(null);
        ensureTab(target);
        Object.assign(split, { panes: plan.panes, sizes: plan.sizes, dir: plan.dir, focus: plan.focus });
      } else {
        // A new split of two: the dropped page on the side it was dropped at.
        if (source.pane === "peek") {
          setPeek(null);
          setSplit(target);
        } else if (source.id === host.activeId()) {
          await open(source.id, "split");
        } else {
          setSplit(target);
        }
        split = activeSplit();
        const index = paneIndex(split, frameIdOf(target));
        if (index === -1) return;
        if (index !== (drop.edge === "right" || drop.edge === "bottom" ? 1 : 0)) tradePanes(split, 0, 1);
        split.dir = drop.edge === "top" || drop.edge === "bottom" ? "col" : "row";
        split.sizes = [0.5, 0.5];
      }
      saveSplits();
      host.render();
    } else if (source.id) {
      const at = PANES.indexOf(drop.pane);
      const from = paneIndex(split, source.id);
      if (from !== -1) {
        if (from !== at) {
          split.sizes = shownSizes(split);
          tradePanes(split, from, at);
          saveSplits();
          host.render();
        }
      } else if (!split || at === split.focus) {
        host.selectTab(source.id);
      } else {
        const target = { kind: "page", id: source.id };
        ensureTab(target);
        split.panes[at] = target;
        saveSplits();
        host.render();
      }
    }
  }

  /** Take a pane out of the split and show its page as a peek over the rest. */
  function paneToPeek(pane) {
    const target = targetOf({ pane });
    if (!target) {
      return;
    }
    if (host.isBlank(metaFor(target))) {
      host.showNotice("A New page can't be shown as a peek");
      return;
    }
    if (!takePane(pane)) {
      return;
    }
    setPeek({ stack: [target] });
    host.render();
    focusPeek();
  }

  async function peekToSplit() {
    let top = peekTarget();
    const active = host.activeId();
    if (!top) {
      return;
    }
    if (!active || mainTooNarrow() || (top.kind === "page" && top.id === active)) {
      host.showNotice(active ? "The window is too narrow for a split" : "Open a tab first to split beside it");
      return;
    }
    if (top.kind === "url") {
      const page = await sitePage(top.href);
      if (page) {
        top = { kind: "page", id: page.id };
      }
    }
    setPeek(null);
    setSplit(top);
    host.render();
  }

  /** "Open as tab" from a peek. The frame stays in the pool, so the page doesn't reload. A site becomes a temporary page. */
  async function promote(target) {
    if (target.kind !== "page") {
      const page = await sitePage(target.href);
      if (!page) {
        return;
      }
      target = { kind: "page", id: page.id };
    }
    setPeek(null);
    navigate(target.id, {});
  }

  function navigate(id, { background = false } = {}) {
    const from = host.activeId();
    if (host.tabs().some((tab) => tab.id === id)) {
      if (!background) {
        if (from && from !== id) {
          openedFrom.set(id, from);
        }
        host.selectTab(id);
      }
      host.render();
      return;
    }
    const idx = host.tabs().findIndex((tab) => tab.id === from);
    const before = idx === -1 ? undefined : host.tabs()[idx + 1]?.id ?? null;
    if (!background && from) {
      openedFrom.set(id, from);
    }
    host.openPage(id, { activate: !background, before });
  }

  /**
   * Open a link target. `source.role` says where the link was clicked: "primary", "secondary",
   * "peek", or "chrome" (Library, palette). A null mode means the Settings default for pages,
   * and the browser for URLs.
   */
  async function open(raw, mode, { source = { role: "chrome" }, anchor = "", background = false } = {}) {
    const file = fileLinkPath(raw);
    if (file) {
      // A file link opens the file's page, or a temporary one (#655).
      const page = await tempFilePage(file);
      if (!page) {
        return { ok: false, error: "not_found" };
      }
      raw = page.id;
    }
    const href = externalUrl(raw);
    /** @type {Target | null} */
    let target = null;
    if (href) {
      target = { kind: "url", href };
      if (!mode || mode === "tab") {
        openBrowser(href);
        return { ok: true, mode: "browser", url: href };
      }
    } else {
      // "key#anchor": a place in the page (an element id), or open arguments such as "card=12" for the page's scribe.onOpen.
      const [name, hash] = splitAnchor(raw);
      raw = name;
      anchor = anchor || hash;
      const page = findPage(String(raw || "").replace(/\|auto$/, "").trim());
      if (!page) {
        const trashed = await inTrash(String(raw || "").trim());
        if (trashed) {
          host.showNotice(`“${trashed.title}” is in the Trash`, {
            action: { label: "Restore", run: () => restoreFromTrash(trashed.id) },
          });
          return { ok: false, error: "in_trash" };
        }
        host.showNotice(`No page called “${String(raw || "").trim()}”`);
        return { ok: false, error: "not_found" };
      }
      target = { kind: "page", id: page.id };
      mode = mode || host.linkMode();
    }

    const active = host.activeId();
    if (mode === "split" && host.solo) {
      mode = "peek";
    }
    if (mode === "split" && (!active || mainTooNarrow())) {
      mode = !active && target.kind === "page" ? "tab" : "peek";
    }
    if (mode === "split" && target.kind === "url") {
      const page = await sitePage(target.href);
      if (page) {
        target = { kind: "page", id: page.id };
      }
    }
    const frameId = frameIdOf(target);
    if (anchor && target.kind === "page") {
      pendingAnchor = { frameId, anchor };
    }

    if (mode === "tab") {
      if (!background && source.role === "peek") {
        setPeek(null);
      }
      if (target.id === active) {
        host.render();
        if (!background) flash(frameId);
        return { ok: true, mode, id: target.id, alreadyVisible: true };
      }
      navigate(target.id, { background });
      return { ok: true, mode, id: target.id };
    }

    const split = activeSplit();
    const visibleAsPrimary = target.kind === "page" && target.id === active;
    const visibleInSplit = Boolean(split) && !visibleAsPrimary && paneIndex(split, frameId) !== -1;

    if (mode === "peek") {
      if (visibleAsPrimary || visibleInSplit) {
        if (source.role === "peek") setPeek(null);
        host.render();
        flash(frameId);
        return { ok: true, mode, alreadyVisible: true, ...(target.kind === "page" ? { id: target.id } : { url: target.href }) };
      }
      const peek = activePeek();
      if (source.role === "peek" && peek) {
        if (!sameTarget(peekTarget(), target)) {
          peek.stack.push(target);
          if (peek.stack.length > PEEK_STACK_MAX) {
            peek.stack.shift();
          }
        }
      } else {
        setPeek({ stack: [target] });
      }
      host.render();
      focusPeek();
      return { ok: true, mode, ...(target.kind === "page" ? { id: target.id } : { url: target.href }) };
    }

    // split
    if (visibleInSplit) {
      if (source.role === "peek") setPeek(null);
      host.render();
      flash(frameId);
      return { ok: true, mode, alreadyVisible: true, ...(target.kind === "page" ? { id: target.id } : { url: target.href }) };
    }
    if (visibleAsPrimary) {
      // Splitting the tab you are on: it keeps its place and a New page opens beside it, with focus.
      if (split || host.draftId() === active) {
        host.render();
        flash(frameId);
        return { ok: true, mode, id: target.id, alreadyVisible: true };
      }
      // Install the split before the draft's first render: only the original page
      // should animate from full width, while the new draft enters at pane width.
      if (!(await host.newPage({ beforeRender: () => {
        splits.set(host.spaceId(), { panes: [target, { kind: "page", id: host.activeId() }], sizes: [lastRatio, 1 - lastRatio], dir: "row", focus: 1 });
        saveSplits();
      } })) || host.activeId() === active) {
        return { ok: false, error: "no_new_page" };
      }
      host.render();
      return { ok: true, mode, id: target.id };
    }
    if (source.role === "peek" || sameTarget(peekTarget(), target)) {
      setPeek(null);
    }
    setSplit(target);
    host.render();
    return { ok: true, mode, ...(target.kind === "page" ? { id: target.id } : { url: target.href }) };
  }

  async function restoreFromTrash(id) {
    const res = await fetch(`/api/trash/${encodeURIComponent(id)}/restore`, { method: "POST" }).catch(() => null);
    host.showNotice(res?.ok ? "Restored to the Library" : "Could not restore");
  }

  /** Look pages up for a page's link labels: { [target]: { id, title, open } | null }. */
  function resolve(targets) {
    const pages = {};
    for (const raw of Array.isArray(targets) ? targets.slice(0, 500) : []) {
      const key = String(raw || "").trim();
      if (!key) {
        continue;
      }
      const file = fileLinkPath(key);
      if (file) {
        // A file link shows its file's name; a missing file says so when it is opened.
        const page = filePageOf(file);
        pages[key] = { id: page?.id || null, title: page?.title || file.split(/[\\/]/).filter(Boolean).pop() || file, open: Boolean(page && host.tabs().some((tab) => tab.id === page.id)) };
        continue;
      }
      const page = findPage(splitAnchor(key)[0]);
      pages[key] = page ? { id: page.id, title: page.title, open: host.tabs().some((tab) => tab.id === page.id) } : null;
    }
    return pages;
  }

  /* ---------- hooks from app.js ---------- */

  /**
   * The user picked a tab: it shows in the focused pane. Picking the page of another pane moves
   * focus there instead (activeSplit follows the active tab), so nothing moves on screen.
   */
  function onSelect(nextId) {
    const top = peekTarget();
    if (top?.kind === "page" && top.id === nextId) {
      setPeek(null);
    }
    for (const id of [...openedFrom.keys()]) {
      if (id !== nextId) {
        openedFrom.delete(id);
      }
    }
  }

  /** The tab to return to when `id` leaves the strip, if a link opened it and you haven't moved on. */
  function returnTarget(id) {
    // Closing the focused pane's tab leaves the pane beside it, not a neighbor from the strip.
    const split = id === host.activeId() ? activeSplit() : null;
    const beside = split ? split.panes[fallbackIndex(split)] : null;
    if (beside && host.tabs().some((tab) => tab.id === beside.id)) {
      openedFrom.delete(id);
      return beside.id;
    }
    const from = openedFrom.get(id);
    openedFrom.delete(id);
    return from && from !== id && host.tabs().some((tab) => tab.id === from) ? from : null;
  }

  function onDeleted(id) {
    let changed = false;
    for (const [key, peek] of peeks) {
      peek.stack = peek.stack.filter((target) => !(target.kind === "page" && target.id === id));
      if (JSON.parse(key)[1] === id || !peek.stack.length) {
        peeks.delete(key);
      }
    }
    for (const [spaceId, split] of [...splits]) {
      changed = removePanesBeside(spaceId, split, (pane) => isPage(pane, id)) || changed;
    }
    openedFrom.delete(id);
    if (changed) {
      saveSplits();
    }
  }

  /** A tab left the strip. A pane is always a tab, so its pane goes too. The focused pane's is handled in activeSplit. */
  function onClosed(id) {
    const split = splits.get(host.spaceId());
    if (split && removePanesBeside(host.spaceId(), split, (pane) => isPage(pane, id))) {
      saveSplits();
    }
  }

  /** Something was pressed or typed in a page: the pane showing it takes focus. */
  function onFrameActive(frameId) {
    const pane = frameId ? paneOf(frameId) : "";
    if (pane) {
      focusPane(pane);
    }
  }

  /** After a snapshot: forget panes whose pages are gone, and the splits that leaves with one pane. */
  function prune() {
    let changed = false;
    const spaceIds = host.spaceIds();
    // Spaces are created lazily. The first space inherits the original tab strip's views.
    if (!spaceIds.includes("default") && spaceIds.length) {
      const firstSpace = spaceIds[0];
      if (splits.has("default")) {
        if (!splits.has(firstSpace)) splits.set(firstSpace, splits.get("default"));
        splits.delete("default");
        changed = true;
      }
      for (const [key, peek] of peeks) {
        const [spaceId, tabId] = JSON.parse(key);
        if (spaceId === "default") {
          peeks.set(JSON.stringify([firstSpace, tabId]), peek);
          peeks.delete(key);
        }
      }
    }
    for (const [spaceId, split] of [...splits]) {
      const gone = (pane) => pane.kind === "page" && (spaceId === host.spaceId() ? !showable(pane.id) : !host.findAnyTab(pane.id));
      if (!spaceIds.includes(spaceId)) {
        splits.delete(spaceId);
        changed = true;
      } else if (removePanesBeside(spaceId, split, gone)) {
        changed = true;
      }
    }
    for (const [key, peek] of peeks) {
      const [spaceId, tabId] = JSON.parse(key);
      peek.stack = peek.stack.filter((target) => target.kind === "url" || host.findAnyTab(target.id));
      if (!spaceIds.includes(spaceId) || (tabId && !host.findAnyTab(tabId)) || !peek.stack.length) {
        peeks.delete(key);
      }
    }
    if (changed) {
      saveSplits();
    }
  }

  /** Esc, Ctrl+W: close a peek first. True when consumed. */
  function escape() {
    return closePeek();
  }

  /** Ctrl/Cmd navigates, Shift splits, Alt peeks. */
  function modeFromEvent(event) {
    if (!event) {
      return null;
    }
    if (event.button === 1 || event.ctrlKey || event.metaKey) {
      return "tab";
    }
    if (event.shiftKey) {
      return "split";
    }
    if (event.altKey) {
      return "peek";
    }
    return null;
  }

  /** Which view a frame is in, for links clicked inside it. */
  function roleOf(frameId) {
    const role = host.frame(frameId)?.el.dataset.role;
    return role || "primary";
  }

  /* ---------- pane focus ---------- */

  // A press on a pane's header or its New page screen. Pages report their own (onFrameActive).
  mainEl.addEventListener(
    "pointerdown",
    (event) => {
      const paneEl = event.target instanceof Element ? event.target.closest("[data-pane]") : null;
      if (paneEl && !event.target.closest(".pane-head button")) {
        focusPane(paneEl.dataset.pane);
      }
    },
    true
  );
  // A pane's header shows its buttons while the pointer is in that pane. Everything in a pane carries
  // data-pane; a frame swallows the moves inside it, so the pane stays marked until the pointer is elsewhere.
  function hoverPane(pane) {
    for (const id of PANES) {
      paneEls[id].head.classList.toggle("pointer-in", id === pane);
      if (id !== pane) paneEls[id].head.classList.remove("pointer-near");
    }
  }
  // Reveal blank-page headers from nearby content without covering that content with a hit area.
  function hoverBlankHeaders(event) {
    for (const id of PANES) {
      const head = paneEls[id].head;
      if (head.hidden || !head.classList.contains("blank")) {
        head.classList.remove("pointer-near");
        continue;
      }
      const box = head.getBoundingClientRect();
      const near = event.clientX >= box.left && event.clientX < box.right &&
        event.clientY >= box.top && event.clientY < box.bottom + 48;
      head.classList.toggle("pointer-near", near);
    }
  }
  mainEl.addEventListener("pointerover", (event) => {
    const paneEl = event.target instanceof Element ? event.target.closest("[data-pane]") : null;
    hoverPane(paneEl ? paneEl.dataset.pane : "");
    hoverBlankHeaders(event);
  });
  mainEl.addEventListener("pointermove", hoverBlankHeaders);
  mainEl.addEventListener("pointerleave", () => hoverPane(""));
  // Sites and embedded pages have no bridge to report a press: the frame taking focus says it.
  window.addEventListener("blur", () => {
    setTimeout(() => {
      const el = document.activeElement;
      const split = el?.tagName === "IFRAME" ? activeSplit() : null;
      const index = split ? split.panes.findIndex((pane) => host.frame(frameIdOf(pane))?.el === el) : -1;
      if (index !== -1) {
        focusPane(PANES[index]);
      }
    }, 0);
  });

  /* ---------- split divider ---------- */

  /** "40 / 60": the sizes of the panes on either side of divider `at`. */
  function sizesLabel(split, at) {
    const sizes = shownSizes(split);
    const first = Math.round(sizes[at] * 100);
    return `${first} / ${Math.round((sizes[at] + sizes[at + 1]) * 100) - first}`;
  }

  /** Move the border under divider `at` to `value`, a share of the page area. The panes on either side take the change. */
  function applyBorder(at, value, snap) {
    const split = activeSplit();
    if (!split || at + 1 >= split.panes.length) {
      return;
    }
    const stops = stopsFor(split);
    const lo = minShare(split);
    const from = stops[at];
    const to = stops[at + 2];
    let next = Math.min(to - lo, Math.max(from + lo, value));
    if (snap && Math.abs(next - (from + to) / 2) <= SPLIT_SNAP) {
      next = (from + to) / 2;
    }
    const sizes = shownSizes(split);
    sizes[at] = next - from;
    sizes[at + 1] = to - next;
    split.sizes = sizes;
    applyStops(split);
    dividers[at].ratioEl.textContent = sizesLabel(split, at);
  }

  function commitSizes() {
    const split = activeSplit();
    if (!split) {
      return;
    }
    split.sizes = shownSizes(split);
    if (split.panes.length === 2) {
      lastRatio = clampStoredRatio(split.sizes[0]);
      writeStorage(SPLIT_RATIO_KEY, String(lastRatio));
    }
    saveSplits();
  }

  for (const divider of dividers) {
    const { el: node, at } = divider;
    node.addEventListener("pointerenter", () => {
      clearTimeout(divider.hoverTimer);
      divider.hoverTimer = setTimeout(() => node.classList.add("hot"), HOVER_DELAY);
    });
    node.addEventListener("pointerleave", () => {
      clearTimeout(divider.hoverTimer);
      node.classList.remove("hot");
    });
    node.addEventListener("pointerdown", (event) => {
      const split = activeSplit();
      if (event.button !== 0 || !split) {
        return;
      }
      event.preventDefault();
      stopSplitAnimation();
      const col = split.dir === "col";
      const original = shownSizes(split);
      resizing = { pointerId: event.pointerId };
      divider.ratioEl.textContent = sizesLabel(split, at);
      const cleanup = () => {
        document.body.classList.remove("resizing-split", "resizing-col");
        node.classList.remove("resizing");
        resizing = null;
      };
      window.scribeDrag({ event, target: node, threshold: 0,
        onStart: () => {
          document.body.classList.add("resizing-split");
          document.body.classList.toggle("resizing-col", col);
          node.classList.add("resizing");
        },
        measure: api => api.rect(mainEl),
        onMove: (move, rect) => { applyBorder(at, col ? (move.clientY - rect.top) / rect.height : (move.clientX - rect.left) / rect.width, true); },
        onDrop: () => { cleanup(); commitSizes(); },
        onCancel: () => { split.sizes = original; applyStops(split); cleanup(); },
      });
    });
    // Back to even panes.
    node.addEventListener("dblclick", () => {
      const split = activeSplit();
      if (!split) {
        return;
      }
      split.sizes = split.panes.map(() => 1 / split.panes.length);
      applyStops(split);
      commitSizes();
    });
    node.addEventListener("keydown", (event) => {
      const split = activeSplit();
      if (!split || at + 1 >= split.panes.length) {
        return;
      }
      const step = event.shiftKey ? 0.1 : 0.02;
      const current = stopsFor(split)[at + 1];
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        applyBorder(at, current - step, false);
      } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        applyBorder(at, current + step, false);
      } else if (event.key === "Home") {
        applyBorder(at, 0, false);
      } else if (event.key === "End") {
        applyBorder(at, 1, false);
      } else {
        return;
      }
      event.preventDefault();
      commitSizes();
    });
  }

  window.addEventListener("resize", () => {
    const split = activeSplit();
    if (split && !resizing) {
      applyStops(split);
    }
  });

  return {
    layout,
    open,
    resolve,
    escape,
    closePeek,
    shownIds,
    isShown,
    onSelect,
    onDeleted,
    onClosed,
    onFrameActive,
    paneOf,
    otherPage,
    besidePages,
    closeSplit,
    focusPane,
    returnTarget,
    prune,
    modeFromEvent,
    roleOf,
    beginPageDrag,
    updatePageDrag,
    endPageDrag,
    canCloseDraggedPane,
    pageInPane,
    onPopOut,
    dropPage,
    peekOpen: () => Boolean(activePeek()),
  };
};
