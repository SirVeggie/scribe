(() => {
  const transitions = new WeakMap();
  let host, active, releaseTrap, returnFocus;
  /** Each mounted dialog with its categories, for the index of settings a chat can show. */
  const dialogs = [];
  let resizeFrame;
  const isOpen = () => Boolean(host && !host.root.hidden && !host.root.classList.contains("settings-closing"));
  function resize() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (!isOpen() || !active) return;
      const rootStyle = getComputedStyle(host.root);
      const contentStyle = getComputedStyle(active.content);
      const available = host.root.clientHeight - parseFloat(rootStyle.paddingTop) - parseFloat(rootStyle.paddingBottom);
      const natural = active.header.offsetHeight + active.body().scrollHeight + parseFloat(contentStyle.paddingTop) + parseFloat(contentStyle.paddingBottom);
      host.panel.style.height = `${Math.min(available, 960, Math.max(700, natural))}px`;
    });
  }
  window.addEventListener("resize", resize);

  function close() {
    if (!isOpen()) return false;
    reclaimSoon();
    releaseTrap?.();
    releaseTrap = null;
    show(host.root, false);
    document.getElementById("settings-toggle")?.setAttribute("aria-expanded", "false");
    const target = returnFocus?.isConnected && !host.root.contains(returnFocus) ? returnFocus : document.getElementById("settings-toggle");
    target?.focus({ preventScroll: true });
    return true;
  }
  function show(root, visible) {
    const previous = transitions.get(root);
    previous?.forEach(animation => animation.cancel());
    transitions.delete(root);
    root.classList.toggle("settings-closing", !visible);
    root.inert = !visible;
    root.hidden = false;
    if (!window.scribeMotion.enabled()) {
      root.hidden = !visible;
      return;
    }
    const panel = root.querySelector(".settings-panel");
    const backdrop = root.querySelector(".settings-backdrop");
    const options = { fill: "both" };
    const frames = [{ opacity: 0, transform: "translateY(12px) scale(.98)" }, { opacity: 1, transform: "translateY(0) scale(1)" }];
    const animations = [
      window.scribeMotion.animate(panel, visible ? frames : [...frames].reverse(), { ...options, token: visible ? "enter" : "leave" }),
      window.scribeMotion.reveal(backdrop, visible, { ...options, translate: "none" }),
    ];
    transitions.set(root, animations);
    Promise.all(animations.map(animation => animation.finished)).then(() => {
      if (transitions.get(root) !== animations) return;
      root.hidden = !visible;
      transitions.delete(root);
      animations.forEach(animation => animation.cancel());
    }).catch(() => {});
  }

  function mount(panel, categories, { close: onClose, before, after } = {}) {
    panel.classList.add("settings-categorized");
    const title = panel.querySelector(".settings-title");
    const header = document.createElement("div");
    header.className = "settings-header";
    header.append(title);
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "settings-close";
    closeButton.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    closeButton.setAttribute("aria-label", "Close settings");
    closeButton.dataset.tooltip = "Close settings (Esc)";
    closeButton.addEventListener("click", onClose);
    header.append(closeButton);
    const nav = document.createElement("nav");
    nav.className = "settings-nav";
    nav.setAttribute("aria-label", `${title.textContent} categories`);
    const content = document.createElement("div");
    content.className = "settings-content";
    const entries = [];
    const link = (entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = entry.label;
      button.className = "settings-nav-link";
      button.addEventListener("click", entry.run);
      nav.append(button);
      return button;
    };
    if (before) {
      link(before);
      const separator = document.createElement("hr");
      separator.className = "settings-nav-separator";
      nav.append(separator);
    }
    let selected = 0;
    const select = (index) => {
      selected = index;
      entries.forEach((entry, i) => {
        entry.body.hidden = i !== index;
        entry.button.setAttribute("aria-pressed", String(i === index));
      });
      content.scrollTop = 0;
      resize();
    };
    categories.forEach((category, index) => {
      const body = document.createElement("div");
      body.className = "settings-category";
      body.id = `${title.id}-category-${index}`;
      body.append(...category.sections);
      const button = link({ label: category.label, run: () => select(index) });
      button.setAttribute("aria-controls", body.id);
      entries.push({ body, button });
      content.append(body);
    });
    // One link or several; the first is pushed to the bottom and the rest follow it.
    [].concat(after ?? []).forEach((entry, index) => {
      const button = link(entry);
      if (!index) button.classList.add("settings-nav-bottom");
    });
    nav.addEventListener("keydown", event => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const buttons = [...nav.querySelectorAll("button")];
      const current = buttons.indexOf(document.activeElement);
      if (current < 0) return;
      event.preventDefault();
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index].focus();
    });
    if (!host) host = { panel, root: panel.parentElement };
    dialogs.push({ title: title.textContent.trim(), categories: categories.map((category, i) => ({ label: category.label, body: entries[i].body, open: () => { view.open(); select(i); } })) });
    const element = document.createElement("div");
    element.className = "settings-view";
    element.hidden = Boolean(active);
    element.append(header, nav, content);
    host.panel.append(element);
    const view = {
      element, header, content,
      body: () => entries[selected].body,
      select,
      isOpen: () => active === view && isOpen(),
      close: () => active === view && close(),
      open() {
        const opening = !isOpen();
        if (opening) returnFocus = document.activeElement;
        if (active !== view) {
          if (active) active.element.hidden = true;
          element.hidden = false;
          host.panel.setAttribute("aria-labelledby", title.id);
          host.root.classList.toggle("ag-settings-dialog", Boolean(before));
          active = view;
        }
        if (opening) {
          returnAll();
          show(host.root, true);
        }
        document.getElementById("settings-toggle")?.setAttribute("aria-expanded", "true");
        releaseTrap?.();
        releaseTrap = window.scribeFocusTrap?.bind(host.panel);
        resize();
      },
    };
    if (!active) active = view;
    const observer = new ResizeObserver(() => { if (active === view) resize(); });
    entries.forEach(entry => observer.observe(entry.body));
    observer.observe(header);
    select(0);
    return view;
  }

  /* ---------- Settings in a chat (settings_show) ----------
   * A chat card shows the dialogs' own rows, not copies: each one is lent to the card, with a comment
   * left where it lives, and goes back when a settings dialog opens or the card leaves the page.
   * Two cards with the same row: the one last rendered or pointed at holds it, the other a still copy.
   */
  /** A lent node -> the comment left in its place in the dialog. */
  const homes = new Map();
  /** That comment -> its node, so an index walk sees a lent node where it belongs. */
  const away = new Map();
  /** A lent node -> the card showing it. */
  const holders = new Map();
  const hosts = new Set();

  const slug = (text) => text.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
  const clean = (text) => (text || "").replace(/\s+/g, " ").trim();
  const kids = (node) => [...node.childNodes].map((n) => away.get(n) || n).filter((n) => n.nodeType === 1);
  const parentOf = (node) => (homes.get(node) || node).parentNode;
  /** A heading's own words, without its ? button. */
  const headingText = (h) => clean([...h.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("")) || clean(h.textContent);

  function rowLabel(row) {
    const label = kids(row).find((n) => n.matches("span, label, strong"));
    return clean(label?.textContent || row.querySelector("[aria-label]")?.getAttribute("aria-label") || row.textContent).slice(0, 120);
  }
  function rowDetail(row) {
    const label = kids(row).find((n) => n.matches("span, label"));
    const out = {};
    const hint = label?.dataset.hint || label?.getAttribute("aria-description");
    if (hint) out.hint = clean(hint);
    const toggle = row.querySelector("[role=switch]");
    const track = row.querySelector(".button-track");
    const select = row.querySelector("select");
    const input = row.querySelector("input:not([type=hidden]):not([type=file]), textarea");
    if (toggle) {
      out.control = "switch";
      out.value = toggle.getAttribute("aria-checked") === "true" ? "on" : "off";
    } else if (track) {
      const buttons = [...track.querySelectorAll("button")];
      out.control = "choice";
      out.options = buttons.map((b) => clean(b.textContent));
      out.value = buttons.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => clean(b.textContent)).join(", ");
    } else if (select) {
      out.control = "dropdown";
      out.options = [...select.options].map((o) => clean(o.textContent));
      out.value = clean(select.selectedOptions[0]?.textContent);
    } else if (input) {
      out.control = input.type === "checkbox" ? "checkbox" : input.type === "range" ? "slider" : "field";
      out.value = input.type === "password" ? (input.value ? "Entered" : "") : input.type === "checkbox" ? (input.checked ? "on" : "off") : input.value;
    } else if (row.querySelector("button")) {
      out.control = "button";
    }
    if (row.querySelector("[role=switch][disabled], .button-track button[disabled]")) out.disabled = true;
    return out;
  }

  /** Every section and setting row of the settings dialogs, in their order, with the nodes that show each. */
  function index() {
    const out = [];
    const seen = new Set();
    const unique = (id) => {
      let next = id;
      for (let i = 2; seen.has(next); i++) next = `${id}-${i}`;
      seen.add(next);
      return next;
    };
    dialogs.forEach((dialog, d) => {
      const prefix = d ? slug(dialog.title.replace(/\s*settings$/i, "")) : "general";
      for (const category of dialog.categories) {
        for (const section of kids(category.body)) {
          if (!section.matches(".settings-section") || section.hidden) continue;
          const parts = kids(section);
          const heading = parts.find((n) => n.tagName === "H3");
          const title = heading ? headingText(heading) : category.label;
          const sectionId = unique(`${prefix}/${slug(title)}`);
          const base = { dialog: dialog.title, category: category.label, section: title, sectionId, heading, open: category.open };
          out.push({ ...base, id: sectionId, kind: "section", label: title, nodes: parts.filter((n) => n !== heading) });
          const rows = [];
          const walk = (node) => {
            for (const child of kids(node)) {
              if (child.hidden) continue;
              if (child.classList.contains("setting-row")) rows.push(child);
              else if (!child.matches("button, select, input, textarea, svg")) walk(child);
            }
          };
          walk(section);
          for (const row of rows) {
            const nodes = [row];
            const siblings = kids(parentOf(row));
            for (let i = siblings.indexOf(row) + 1; siblings[i]?.matches(".settings-hint-after"); i++) nodes.push(siblings[i]);
            const label = rowLabel(row);
            out.push({ ...base, id: unique(`${sectionId}/${slug(label)}`), kind: "row", label, ...rowDetail(row), nodes });
          }
        }
      }
    });
    return out;
  }

  /** The index without its nodes: what the agent's settings_find searches. */
  function catalog() {
    return index().map(({ heading, nodes, open, sectionId, ...entry }) => entry);
  }

  /** A still copy for a card that doesn't hold the node: same look, nothing to click or focus. */
  function standIn(node) {
    const copy = node.cloneNode(true);
    for(const input of copy.querySelectorAll('input[type="password"]')){input.value="";input.removeAttribute("value");}
    copy.inert = true;
    for (const el of [copy, ...copy.querySelectorAll("[id]")]) el.removeAttribute("id");
    return copy;
  }

  /** A node its dialog has since replaced (a list it rebuilt): the card builds again from the current one. */
  function stale(node) {
    const mark = homes.get(node);
    return mark ? !mark.isConnected : !node.isConnected;
  }

  function forget(node) {
    const mark = homes.get(node);
    if (mark) {
      away.delete(mark);
      mark.remove();
    }
    homes.delete(node);
    holders.delete(node);
  }

  function build(card) {
    const all = index();
    const wanted = new Set(card.ids);
    const picked = all.filter((entry) => wanted.has(entry.id));
    // A whole section already has its rows.
    const whole = new Set(picked.filter((entry) => entry.kind === "section").map((entry) => entry.sectionId));
    const shown = picked.filter((entry) => entry.kind === "section" || !whole.has(entry.sectionId));
    card.missing = card.ids.filter((id) => !all.some((entry) => entry.id === id));
    card.slots = [];
    card.sections = [];
    const add = (parent, node) => {
      const copy = standIn(node);
      parent.append(copy);
      card.slots.push({ node, shown: copy });
    };
    let section = null;
    let current = null;
    for (const entry of shown) {
      if (entry.sectionId !== current) {
        current = entry.sectionId;
        section = document.createElement("section");
        section.className = "settings-section";
        if (entry.heading) add(section, entry.heading);
        card.root.append(section);
        card.sections.push({ dialog: entry.dialog, category: entry.category, open: entry.open });
      }
      for (const node of entry.nodes) add(section, node);
    }
  }

  function claim(card) {
    if (isOpen() || !card.slots) return;
    if (card.slots.some((slot) => stale(slot.node))) {
      for (const slot of card.slots) if (stale(slot.node)) forget(slot.node);
      card.root.replaceChildren();
      build(card);
    }
    for (const slot of card.slots) {
      const node = slot.node;
      if (slot.shown === node) continue;
      const before = holders.get(node);
      const theirs = before && before !== card ? before.slots.find((s) => s.shown === node) : null;
      if (theirs) {
        theirs.shown = standIn(node);
        node.replaceWith(theirs.shown);
      }
      if (!homes.has(node)) {
        const mark = document.createComment("lent to a chat");
        node.before(mark);
        homes.set(node, mark);
        away.set(mark, node);
      }
      slot.shown.replaceWith(node);
      slot.shown = node;
      holders.set(node, card);
    }
    watch();
  }

  /** Puts lent nodes back in their dialog (all of them, or those the test picks); their cards keep copies. */
  function returnHome(test = () => true) {
    for (const [node, mark] of [...homes]) {
      const card = holders.get(node);
      if (!test(node, card)) continue;
      const slot = card?.slots.find((s) => s.shown === node);
      if (slot) {
        slot.shown = standIn(node);
        node.replaceWith(slot.shown);
      }
      if (mark.isConnected) mark.replaceWith(node);
      else node.remove();
      away.delete(mark);
      homes.delete(node);
      holders.delete(node);
    }
  }
  const returnAll = () => returnHome();

  const visible = (card) => card.root.isConnected && (card.root.checkVisibility?.() ?? true);
  function reclaim() {
    for (const card of [...hosts]) {
      if (!card.root.isConnected) hosts.delete(card);
      else if (visible(card)) claim(card);
    }
  }
  let reclaimTimer;
  function reclaimSoon() {
    clearTimeout(reclaimTimer);
    reclaimTimer = setTimeout(() => !isOpen() && reclaim(), 320);
  }

  // A card that left the page (its chat re-rendered or closed) gives its nodes back.
  let observer, sweepFrame;
  function watch() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (!holders.size || sweepFrame) return;
      sweepFrame = requestAnimationFrame(() => {
        sweepFrame = 0;
        let left = false;
        returnHome((node, card) => {
          const gone = !card || !card.root.isConnected;
          left ||= gone;
          return gone;
        });
        if (left) reclaim();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * Shows the settings with these ids in root, grouped under their sections' headings and in the
   * dialogs' order. Returns the ids no longer found, and the dialog and category of each section shown.
   */
  function lend(root, ids) {
    const card = { root, ids: [...ids] };
    root.classList.add("settings-lent");
    build(card);
    hosts.add(card);
    root.addEventListener("pointerenter", () => claim(card));
    claim(card);
    return { missing: card.missing, sections: card.sections };
  }

  // The list the agent's settings_find reads: sent when Scribe connects and after a setting changes.
  let publishTimer;
  function publish(delay = 800) {
    clearTimeout(publishTimer);
    publishTimer = setTimeout(() => {
      if (!dialogs.length) return;
      fetch("/api/settings/index", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: catalog() }) }).catch(() => undefined);
    }, delay);
  }
  window.addEventListener("scribe:connection", (event) => event.detail?.connected && publish());
  for (const type of ["click", "change"]) {
    document.addEventListener(type, (event) => {
      if (event.target.closest?.(".settings-panel, .settings-lent, .select-menu")) publish(1500);
    }, true);
  }

  window.scribeSettingsUI = { mount, close, isOpen, index, catalog, lend };
})();
