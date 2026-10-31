/**
 * A themed dropdown over a native <select>: the select stays the source of truth (value, name,
 * change events, form reads) and is hidden; a button and a .tab-menu list stand in for it.
 * While open, the list moves to the enclosing modal <dialog> (to stay in its top layer) or else
 * to <body>: a scrolling or backdrop-filtered panel would otherwise clip it, paint its scrollbar
 * over it, or become its containing block.
 */
(function () {
  /** @type {null | { wrap: HTMLElement, close: (focus?: boolean) => void }} */
  let openOne = null;

  // Registered before app.js's shortcut handler, so Esc closes the list and nothing else.
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && openOne) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openOne.close(true);
      }
    },
    true
  );
  document.addEventListener("pointerdown", (event) => {
    if (openOne && !event.target.closest?.(".select-wrap.open, .select-menu")) {
      openOne.close();
    }
  });
  window.addEventListener("resize", () => openOne?.close());
  window.addEventListener("blur", () => openOne?.close());
  document.addEventListener(
    "scroll",
    (event) => {
      // Only a scroll that moves the button: a chat streaming elsewhere scrolls on every frame.
      if (openOne && !event.target.closest?.(".select-menu") && event.target.contains?.(openOne.wrap)) {
        openOne.close();
      }
    },
    true
  );

  /**
   * Wraps `select` in place (or standalone when it has no parent yet) and returns the wrapper.
   * Call `wrapper.syncSelect()` after setting `select.value` from code.
   */
  window.createSelect = function createSelect(select) {
    const wrap = document.createElement("div");
    wrap.className = "select-wrap";
    select.parentNode?.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.hidden = true;
    select.tabIndex = -1;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "select-button";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    const label = document.createElement("span");
    label.className = "select-label";
    button.appendChild(label);
    wrap.appendChild(button);

    // Labels and names that pointed at the select now point at the button.
    if (select.id) {
      button.id = `${select.id}-button`;
      document.querySelectorAll(`label[for="${CSS.escape(select.id)}"]`).forEach((el) => (el.htmlFor = button.id));
    }
    const aria = select.getAttribute("aria-label");
    if (aria) {
      button.setAttribute("aria-label", aria);
    }

    const menu = document.createElement("div");
    menu.className = "tab-menu select-menu";
    menu.role = "listbox";
    if(select.multiple)menu.setAttribute("aria-multiselectable","true");
    menu.hidden = true;
    wrap.appendChild(menu);

    let active = 0;

    function sync() {
      label.textContent = select.multiple ? ([...select.selectedOptions].map(option=>option.textContent).join(", ") || "None") : select.selectedOptions[0]?.textContent ?? "";
      if(select.multiple)for(let i=0;i<menu.children.length;i++)menu.children[i].setAttribute("aria-selected",String(select.options[i]?.selected??false));
    }

    function choose(index) {
      if(select.multiple){
        const option=select.options[index];if(!option||option.disabled)return;
        option.selected=!option.selected;
        menu.children[index]?.setAttribute("aria-selected",String(option.selected));
        sync();select.dispatchEvent(new Event("input",{bubbles:true}));select.dispatchEvent(new Event("change",{bubbles:true}));button.focus();return;
      }
      const changed = select.selectedIndex !== index;
      select.selectedIndex = index;
      sync();
      close(true);
      if (changed) {
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    /** Scrolls only the list: scrollIntoView would also scroll ancestors, and a scroll outside the list closes it. */
    function highlight() {
      [...menu.children].forEach((child, index) => child.classList.toggle("active", index === active));
      const item = menu.children[active];
      if (!item) {
        return;
      }
      if (item.offsetTop < menu.scrollTop) {
        menu.scrollTop = item.offsetTop;
      } else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) {
        menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
      }
    }

    function place() {
      const box = button.getBoundingClientRect();
      const margin = 8;
      menu.style.minWidth = `${box.width}px`;
      menu.style.left = "0px";
      menu.style.top = "0px";
      // A transformed ancestor moves position:fixed; measure where 0,0 landed and correct for it.
      const origin = menu.getBoundingClientRect();
      const { offsetWidth: width, offsetHeight: height } = menu;
      const above = box.bottom + 4 + height > window.innerHeight - margin && box.top - 4 - height > margin;
      const top = above ? box.top - 4 - height : box.bottom + 4;
      const left = Math.max(margin, Math.min(box.left, window.innerWidth - width - margin));
      menu.dataset.side = above ? "above" : "below";
      menu.style.left = `${left - origin.left}px`;
      menu.style.top = `${top - origin.top}px`;
    }

    function open() {
      openOne?.close();
      menu.replaceChildren();
      [...select.options].forEach((option, index) => {
        const item = document.createElement("button");
        item.type = "button";
        item.role = "option";
        item.tabIndex = -1;
        item.textContent = option.textContent;
        item.disabled = option.disabled;
        item.setAttribute("aria-selected", String(option.selected));
        if(option.dataset.tooltip){item.dataset.tooltip=option.dataset.tooltip;item.setAttribute("aria-description",option.dataset.tooltip);}
        item.addEventListener("mouseenter", () => {
          active = index;
          highlight();
        });
        item.addEventListener("click", () => choose(index));
        menu.appendChild(item);
      });
      active = Math.max(0, select.selectedIndex);
      // The dialog itself, not the wrap: a scrolling list inside it would paint its scrollbar over the menu.
      (wrap.closest("dialog") || document.body).appendChild(menu);
      menu.hidden = false;
      wrap.classList.add("open");
      button.setAttribute("aria-expanded", "true");
      place();
      highlight();
      openOne = api;
    }

    function close(focus = false) {
      if (menu.hidden) {
        return;
      }
      menu.hidden = true;
      if (menu.parentNode !== wrap) {
        wrap.appendChild(menu);
      }
      wrap.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
      if (openOne === api) {
        openOne = null;
      }
      if (focus) {
        button.focus();
      }
    }

    const api = { wrap, close };

    button.addEventListener("click", () => (menu.hidden ? open() : close()));
    button.addEventListener("keydown", (event) => {
      const count = select.options.length;
      if (menu.hidden) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        active = (active + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
        highlight();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        active = event.key === "Home" ? 0 : count - 1;
        highlight();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        choose(active);
      } else if (event.key === "Tab") {
        close();
      }
    });
    select.addEventListener("change", sync);
    // Code that sets value or selectedIndex, or swaps the options, needs no syncSelect call.
    for (const key of ["value", "selectedIndex"]) {
      const own = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, key);
      Object.defineProperty(select, key, { configurable: true, get() { return own.get.call(this); }, set(value) { own.set.call(this, value); sync(); } });
    }
    new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ["selected", "label"] });

    sync();
    wrap.syncSelect = sync;
    return wrap;
  };

  // Loaded by a page as the select component (<script src="/c/select.js">, or inlined by an export):
  // its own styles, and every <select> without data-native, now and later, becomes the app's dropdown.
  const script = document.currentScript;
  if (!script || !(script.dataset.scribeComponent === "select" || /\/c\/select\.js(\?|$)/.test(script.src))) return;
  const style = document.createElement("style");
  style.textContent = `
:where(.select-wrap) { position: relative; display: inline-block; min-width: 140px; max-width: 100%; vertical-align: middle; }
:where(.select-button) { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;
  height: var(--kit-control-h, 30px); padding: 0 10px; border: 1px solid var(--border); border-radius: var(--kit-control-radius, 7px);
  background: var(--kit-sunken, rgba(0, 0, 0, 0.3)); box-shadow: none; color: var(--text); font: inherit; font-weight: 400; cursor: pointer; }
:where(.select-button):hover, :where(.select-wrap.open) :where(.select-button) { background: rgba(0, 0, 0, 0.38); }
:where(.select-button):focus-visible, :where(.select-wrap.open) :where(.select-button) { outline: none; border-color: var(--kit-border-strong, rgba(255, 255, 255, 0.14)); }
:where(.select-label) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:where(.select-button)::after { content: ""; flex: 0 0 auto; width: 6px; height: 6px; margin: -3px 2px 0 0;
  border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted); transform: rotate(45deg); }
:where(.select-wrap.open) :where(.select-button)::after { margin-top: 3px; transform: rotate(225deg); }
:where(.select-menu) { position: fixed; z-index: 2147483000; display: flex; flex-direction: column; min-width: 128px; max-height: 260px;
  overflow-y: auto; padding: 4px; border-radius: 10px; background: var(--kit-surface, #202024);
  box-shadow: 0 0 0 1px var(--border), 0 12px 32px rgba(0, 0, 0, 0.45); }
:where(.select-menu[hidden]) { display: none; }
:where(.select-menu) :where(button) { display: flex; align-items: center; justify-content: flex-start; min-height: 28px; height: auto;
  padding: 0 10px; border: 0; border-radius: 6px; background: transparent; box-shadow: none; color: var(--text); font: inherit;
  text-align: left; white-space: nowrap; cursor: pointer; }
:where(.select-menu) :where(button.active) { background: rgba(255, 255, 255, 0.08); }
:where(.select-menu) :where(button[aria-selected="true"]) { color: var(--kit-heading, #fff); font-weight: 600; }
:where(.select-menu) :where(button:disabled) { opacity: 0.4; cursor: default; }
`;
  document.head.appendChild(style);
  const upgrade = (root) => {
    const found = root.matches?.("select") ? [root] : [...(root.querySelectorAll?.("select") ?? [])];
    for (const select of found) {
      if (select.dataset.native === undefined && !select.closest(".select-wrap") && select.size <= 1) window.createSelect(select);
    }
  };
  const start = () => {
    upgrade(document.body);
    new MutationObserver((records) => { for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) upgrade(node); })
      .observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
