/**
 * Shared hover card for strip tabs, Library rows, and templates.
 * `describe(el)` returns `{ title, id, description?, createdAt, updatedAt, folder?, madeBy?, changedBy?, copiedFrom? }` or null,
 * or `{ title, description, note: true }` for a short explanation shown under a small anchor.
 * `madeBy` / `changedBy` / `copiedFrom`: `{ text, threadId?, at? }`. `openThread(id)` runs on a click.
 */
window.createHoverCard = function createHoverCard({ describe, openThread }) {
  const card = document.createElement("div");
  card.id = "hover-card";
  card.className = "hover-card";
  card.role = "tooltip";
  card.hidden = true;
  document.body.appendChild(card);

  let showTimer = 0;
  let hideTimer = 0;
  /** @type {HTMLElement | null} */
  let anchor = null;
  let suppressed = false;

  function bind(el, delay) {
    el.dataset.richTooltip = "";
    el.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse" || suppressed || event.buttons) {
        return;
      }
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      if (!card.hidden) {
        show(el);
        return;
      }
      showTimer = window.setTimeout(() => show(el), delay);
    });
    el.addEventListener("pointerleave", (event) => {
      clearTimeout(showTimer);
      if (anchor === el && !card.contains(event.relatedTarget)) {
        hideTimer = window.setTimeout(hide, 80);
      }
    });
    el.addEventListener("pointerdown", (event) => {
      if (event.target.closest("a, button")) {
        return;
      }
      hide();
    });
  }

  card.addEventListener("pointerenter", () => clearTimeout(hideTimer));
  card.addEventListener("pointerleave", () => {
    hideTimer = window.setTimeout(hide, 80);
  });
  card.addEventListener("click", (event) => {
    const link = event.target.closest("[data-thread]");
    if (!link) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const id = link.dataset.thread;
    if (id && openThread && openThread(id) === false) {
      window.scribeApp?.showNotice?.("That thread is gone.");
    }
    hide();
  });

  function show(el) {
    if (!el.isConnected || suppressed) {
      return;
    }
    const info = describe(el);
    if (!info) {
      hide();
      return;
    }
    if (anchor && anchor !== el) {
      anchor.removeAttribute("aria-describedby");
    }
    anchor = el;
    window.scribeTooltip?.hide();
    render(info);
    card.classList.toggle("note", Boolean(info.note));
    card.hidden = false;
    el.setAttribute("aria-describedby", card.id);
    place(el, Boolean(info.note));
  }

  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (anchor) {
      anchor.removeAttribute("aria-describedby");
      anchor = null;
    }
    card.hidden = true;
  }

  /** Hides the card and keeps it away until `resume()`, e.g. for the length of a drag. */
  function suspend() {
    suppressed = true;
    hide();
  }

  function resume() {
    suppressed = false;
  }

  function render(info) {
    card.replaceChildren();
    const title = document.createElement("div");
    title.className = "hover-card-title";
    title.textContent = info.title;
    if (info.note) {
      const description = document.createElement("div");
      description.className = "hover-card-desc";
      description.textContent = info.description;
      card.append(title, description);
      return;
    }
    const id = document.createElement("div");
    id.className = "hover-card-id";
    id.textContent = info.id;
    card.append(title, id);
    if (info.description) {
      const description = document.createElement("div");
      description.className = "hover-card-desc";
      description.textContent = info.description;
      card.appendChild(description);
    }
    const rows = document.createElement("dl");
    rows.className = "hover-card-rows";
    addRow(rows, "Created", info.createdAt);
    addRow(rows, "Updated", info.updatedAt);
    addActorRow(rows, "Made by", info.madeBy);
    if (!sameActor(info.madeBy, info.changedBy)) {
      addActorRow(rows, "Changed by", info.changedBy);
    }
    addActorRow(rows, "Copied from", info.copiedFrom);
    card.appendChild(rows);
    if (info.folder) {
      const folder = document.createElement("div");
      folder.className = "hover-card-folder";
      folder.textContent = info.folder;
      card.appendChild(folder);
    }
  }

  function addRow(rows, label, at) {
    if (!at) {
      return;
    }
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    const rel = document.createElement("span");
    rel.textContent = relative(at);
    const abs = document.createElement("span");
    abs.className = "hover-card-abs";
    abs.textContent = new Date(at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    dd.append(rel, abs);
    rows.append(dt, dd);
  }

  function addActorRow(rows, label, actor) {
    if (!actor) {
      return;
    }
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    if (actor.threadId) {
      const link = document.createElement("button");
      link.type = "button";
      link.className = "hover-card-thread hover-card-actor";
      link.dataset.thread = actor.threadId;
      link.textContent = actor.text;
      dd.appendChild(link);
    } else {
      const text = document.createElement("span");
      text.className = "hover-card-actor";
      text.textContent = actor.text;
      text.dataset.tooltip = actor.text;
      dd.appendChild(text);
    }
    if (actor.at) {
      const abs = document.createElement("span");
      abs.className = "hover-card-abs";
      abs.textContent = relative(actor.at);
      dd.appendChild(abs);
    }
    rows.append(dt, dd);
  }

  function sameActor(a, b) {
    if (!a || !b) {
      return !a && !b;
    }
    return a.threadId === b.threadId && a.at === b.at && a.text === b.text;
  }

  function place(el, below) {
    const margin = 8;
    const gap = 6;
    const box = el.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = card;
    const inLibrary = !below && Boolean(el.closest(".side-pane"));
    let left;
    let top;
    if (inLibrary) {
      const libraryLeft = document.documentElement.dataset.librarySide === "left";
      left = libraryLeft ? box.right + gap : box.left - gap - width;
      top = box.top;
      const overflow = libraryLeft ? left + width > window.innerWidth - margin : left < margin;
      if (overflow) {
        left = box.left;
        top = box.bottom + gap;
      }
    } else {
      left = box.left;
      top = box.bottom + gap;
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
    card.style.left = left + "px";
    card.style.top = top + "px";
  }

  function relative(at) {
    const diff = Date.now() - at;
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) {
      return "just now";
    }
    if (diff < hour) {
      return `${Math.floor(diff / minute)} min ago`;
    }
    if (diff < day) {
      const n = Math.floor(diff / hour);
      return `${n} hour${n === 1 ? "" : "s"} ago`;
    }
    if (diff < 30 * day) {
      const n = Math.floor(diff / day);
      return `${n} day${n === 1 ? "" : "s"} ago`;
    }
    return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  window.addEventListener("scribe-tooltip-show", (event) => {
    // A tip on a thread button belongs to this card; keep the button clickable.
    if (!card.contains(event.detail?.anchor)) {
      hide();
    }
  });
  // Only a scroll that moves the anchor: a chat streaming elsewhere scrolls on every frame.
  window.addEventListener(
    "scroll",
    (event) => {
      if (anchor && event.target.contains?.(anchor)) {
        hide();
      }
    },
    true
  );
  window.addEventListener("wheel", hide, { passive: true, capture: true });
  window.addEventListener("blur", hide);
  window.addEventListener("keydown", hide, true);

  return { bind, hide, suspend, resume, refresh: () => anchor && show(anchor) };
};
