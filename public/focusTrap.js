/**
 * Keep Tab inside a modal. bind(root) cycles focus among visible controls in root,
 * focuses the first one unless something inside already has focus, and returns unbind.
 */
(() => {
  const SELECTOR =
    'a[href]:not([disabled]),button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function visible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function focusables(root) {
    return [...root.querySelectorAll(SELECTOR)].filter(visible);
  }

  function trapTab(event, root) {
    if (event.key !== "Tab" || event.defaultPrevented) return false;
    const list = focusables(root);
    if (!list.length) {
      event.preventDefault();
      return true;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !root.contains(active)) {
        event.preventDefault();
        last.focus();
        return true;
      }
    } else if (active === last || !root.contains(active)) {
      event.preventDefault();
      first.focus();
      return true;
    }
    return false;
  }

  function bind(root, { initial } = {}) {
    // Opening a dialog with a shortcut is not keyboard navigation. Keep its
    // initial focus, but wait for a navigation key before showing an outline.
    const onNavigate = (event) => {
      if (!event.altKey && !event.ctrlKey && !event.metaKey &&
          ["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
        root.classList.remove("scribe-focus-pending");
      }
    };
    const onKey = (event) => trapTab(event, root);
    root.addEventListener("keydown", onNavigate, true);
    root.addEventListener("keydown", onKey);
    if (!root.contains(document.activeElement)) {
      root.classList.add("scribe-focus-pending");
      (initial || focusables(root)[0])?.focus({ preventScroll: true });
    }
    return () => {
      root.removeEventListener("keydown", onNavigate, true);
      root.removeEventListener("keydown", onKey);
      root.classList.remove("scribe-focus-pending");
    };
  }

  // Focus that a script moves on its own (a prompt that pops up, focus restored after a click)
  // still matches :focus-visible once the keyboard was used at some point. Keep the ring for
  // focus a key just moved, and hide it otherwise until a navigation key is pressed.
  const NAV_KEYS = ["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
  let lastKey = -Infinity;
  const quiet = (on) => document.documentElement.classList.toggle("scribe-focus-quiet", on);
  window.addEventListener("keydown", (event) => {
    lastKey = performance.now();
    if (!event.altKey && !event.ctrlKey && !event.metaKey && NAV_KEYS.includes(event.key)) quiet(false);
  }, true);
  window.addEventListener("focusin", () => quiet(performance.now() - lastKey > 300), true);

  window.scribeFocusTrap = { focusables, trapTab, bind };
})();
