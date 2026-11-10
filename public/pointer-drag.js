/* Shared by the shell and the page bridge. Geometry belongs to a drag, not a pointer event. */
(() => {
  const style = document.createElement("style");
  // No blue flash on touch taps (inherited, so pages and the shell both get it).
  style.textContent = "html { -webkit-tap-highlight-color: transparent; } body.pointer-shield { user-select: none; } body.pointer-shield iframe { pointer-events: none; }";
  document.head.appendChild(style);
  let current = null;
  let suppress = false;
  let clickTimer = 0;
  // Cancellation can precede release by seconds. Keep its click suppressed until release,
  // but a fresh press starts a new gesture even if the old pointer never came back.
  window.addEventListener("pointerdown", () => { suppress = false; clearTimeout(clickTimer); }, true);
  window.addEventListener("pointerup", () => {
    if (suppress) clickTimer = setTimeout(() => { suppress = false; }, 0);
  }, true);
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !current) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    current.cancel();
  }, true);
  document.addEventListener("click", (event) => {
    if (!suppress || event.detail === 0) return;
    suppress = false;
    clearTimeout(clickTimer);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  // A touch tap whose own handlers change what lies under the finger (a dialog opens, a
  // backdrop closes, a menu appears) must not deliver its follow-up mouse events and click
  // to the new element. Those come after pointerup, so the change has happened by then.
  let tap = null;
  window.addEventListener("pointerdown", (event) => {
    tap = event.pointerType === "touch" && event.isPrimary
      ? { x: event.clientX, y: event.clientY, target: event.target, up: 0, swallow: null } : null;
  }, true);
  window.addEventListener("pointerup", (event) => {
    if (tap && event.pointerType === "touch" && event.isPrimary) tap.up = Date.now();
  }, true);
  for (const type of ["mousedown", "mouseup", "click"]) {
    window.addEventListener(type, (event) => {
      if (!tap?.up || Date.now() - tap.up > 1000) return;
      if (tap.swallow === null) {
        const hit = document.elementFromPoint(tap.x, tap.y);
        tap.swallow = Boolean(hit) && !sameTarget(tap.target, hit);
      }
      if (type === "click") setTimeout(() => { tap = null; }, 0);
      if (!tap.swallow) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }
  function sameTarget(was, hit) {
    if (was === hit || (was.contains?.(hit) && was.isConnected) || hit.contains?.(was)) return true;
    // A re-render that swapped in an equivalent node keeps its click.
    return !was.isConnected && was.tagName === hit.tagName && was.className === hit.className;
  }
  // Browsers scroll on a touch swipe; an armed or running touch drag keeps the finger instead.
  window.addEventListener("touchmove", (event) => {
    if (current?.holdsTouch() && event.cancelable) event.preventDefault();
  }, { capture: true, passive: false });
  window.addEventListener("contextmenu", (event) => {
    if (current?.onContextMenu(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);

  window.scribeDrag = function scribeDrag(options) {
    const event = options.event;
    if (event.button !== 0 || current) return null;
    const target = options.target || event.currentTarget || event.target;
    const start = { x: event.clientX, y: event.clientY };
    let last = event, active = false, ended = false, frame = 0, dirty = true;
    const threshold = options.threshold ?? 6;
    // On touch a drag needs press-and-hold first, so a plain swipe still scrolls.
    const touch = event.pointerType === "touch" && threshold > 0;
    let armed = !touch, holdTimer = 0;
    const arm = () => {
      clearTimeout(holdTimer);
      armed = true;
      try { navigator.vibrate?.(8); } catch { /* not allowed */ }
    };
    if (touch) holdTimer = setTimeout(arm, options.hold ?? 350);
    let geometry;
    const rects = new Map();
    const layouts = new Map();
    const api = {
      start,
      rect(node) {
        if (!rects.has(node)) rects.set(node, node.getBoundingClientRect());
        return rects.get(node);
      },
      layout(node) {
        if (!layouts.has(node)) {
          const rect = api.rect(node);
          const transform = getComputedStyle(node).transform;
          const matrix = transform && transform !== "none" ? new DOMMatrix(transform) : null;
          const left = rect.left - (matrix?.m41 || 0), top = rect.top - (matrix?.m42 || 0);
          layouts.set(node, { left, top, width: rect.width, height: rect.height, right: left + rect.width, bottom: top + rect.height });
        }
        return layouts.get(node);
      },
      invalidate() {
        rects.clear();
        layouts.clear();
        dirty = true;
        if (active && !ended) schedule();
      },
      cancel() { stop(last, true); },
      dispose() { cleanup(); },
      holdsTouch() { return touch && armed && !ended; },
      // The browser's long-press menu would fight the drag for the same hold: keep it back.
      // Releasing the hold without moving opens the menu instead (see stop).
      onContextMenu() {
        if (!touch || ended) return false;
        if (!armed) arm();
        return true;
      },
    };
    current = api;
    function schedule() { frame ||= requestAnimationFrame(apply); }
    function apply() {
      frame = 0;
      if (!active || ended) return;
      // Return true only while auto-scrolling needs another frame.
      try {
        if (dirty) {
          dirty = false;
          geometry = options.measure?.(api);
        }
        if (options.onMove?.(last, geometry, api) === true) schedule();
      } catch (error) { cleanup(); options.onCancel?.(last, api); throw error; }
    }
    function move(next) {
      if (next.pointerId !== event.pointerId || ended) return;
      last = next;
      if (!active) {
        if (Math.hypot(next.clientX - start.x, next.clientY - start.y) < threshold) return;
        // Moving before the hold is a scroll: let the browser have it.
        if (!armed) { stop(next, true); return; }
        activate();
      }
      next.preventDefault();
      schedule();
    }
    function activate() {
      active = true;
      document.body.classList.add("pointer-shield");
      try { options.onStart?.(last, api); } catch (error) { cleanup(); options.onCancel?.(last, api); throw error; }
      // Start may reparent the source, so capture afterwards.
      try { target.setPointerCapture(event.pointerId); } catch { /* synthetic or disconnected */ }
    }
    function cleanup() {
      if (ended) return;
      ended = true;
      clearTimeout(holdTimer);
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", blur);
      window.removeEventListener("scroll", api.invalidate, true);
      window.removeEventListener("resize", api.invalidate);
      target.removeEventListener("lostpointercapture", lost);
      try { if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId); } catch {}
      document.body.classList.remove("pointer-shield");
      if (current === api) current = null;
    }
    function stop(next, cancelled) {
      if (ended || (next.pointerId !== undefined && next.pointerId !== event.pointerId)) return;
      if (!cancelled && active) {
        last = next;
        cancelAnimationFrame(frame);
        frame = 0;
        apply();
      }
      cleanup();
      if (active) {
        suppress = true;
        clearTimeout(clickTimer);
        if (!cancelled) clickTimer = setTimeout(() => { suppress = false; }, 0);
      }
      if (cancelled) options.onCancel?.(next, api);
      else options.onDrop?.(next, active, api);
      if (!cancelled && touch && armed && !active) openMenu();
    }
    // A hold released in place is the touch context menu. Its tap must not also click.
    function openMenu() {
      const hit = document.elementFromPoint(start.x, start.y);
      const node = hit && (event.target.contains?.(hit) || !event.target.isConnected) ? hit : event.target;
      if (!node?.isConnected) return;
      suppress = true;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { suppress = false; }, 700);
      node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true,
        clientX: start.x, clientY: start.y, screenX: event.screenX, screenY: event.screenY, button: 2, buttons: 0, view: window }));
    }
    function up(next) { stop(next, false); }
    function cancel(next) { stop(next, true); }
    function blur() { stop(last, true); }
    // Touch starts with implicit capture on the touched child; moving it to target fires that child's loss, which bubbles here.
    function lost(next) { if (next.target === target) cancel(next); }
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", blur);
    window.addEventListener("scroll", api.invalidate, true);
    window.addEventListener("resize", api.invalidate);
    target.addEventListener("lostpointercapture", lost);
    if (threshold === 0) { event.preventDefault(); activate(); }
    return api;
  };
  window.scribeDrag.rect = node => current ? current.rect(node) : node.getBoundingClientRect();
  window.scribeDrag.layout = node => current ? current.layout(node) : node.getBoundingClientRect();
  window.scribeDrag.invalidate = () => current?.invalidate();
})();
