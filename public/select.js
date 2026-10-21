/**
 * A themed dropdown over a native <select>: the select stays the source of truth (value, name,
 * change events, form reads) and is hidden; a button and a .tab-menu list stand in for it.
 * Inside a modal <dialog> the open list stays next to the button, in the dialog's top layer.
 * Anywhere else it moves to <body> while open: a scrolling or backdrop-filtered panel would
 * otherwise clip it and become its containing block.
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
    }

    function choose(index) {
      if(select.multiple){
        const option=select.options[index];if(!option||option.disabled)return;
        option.selected=!option.selected;
        menu.children[index]?.setAttribute("aria-selected",String(option.selected));
        sync();select.dispatchEvent(new Event("input",{bubbles:true}));select.dispatchEvent(new Event("change",{bubbles:true}));return;
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
      if (!wrap.closest("dialog")) {
        document.body.appendChild(menu);
      }
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

    sync();
    wrap.syncSelect = sync;
    return wrap;
  };
})();
