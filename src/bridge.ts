import { createStateOps } from "./stateOps.js";
import { readFileSync } from "node:fs";

const POINTER_DRAG_JS = readFileSync(new URL("../public/pointer-drag.js", import.meta.url), "utf8");
const PAGE_COMPONENTS_JS = readFileSync(new URL("../public/page-components.js", import.meta.url), "utf8");

/**
 * Injected into every tab page. Gives the page `window.scribe`:
 *
 * - state: `scribe.state`, `scribe.update(ops)`, `scribe.set(partial)` (diffed into ops),
 *   `scribe.onChange`, `scribe.bind`. Writes apply locally at once, go to the daemon as ops, and
 *   are rebased onto other writers' deltas, so concurrent edits to different items both survive.
 * - `scribe.local` / `scribe.setLocal`: this viewer's own state (filters, open panels, drafts).
 * - `scribe.title`, `scribe.setTitle(title)`, `scribe.onTitle(fn)`: the page's name in the tab and Library.
 * - `scribe.signal(name, data)` and `data-scribe-signal`: events agents wait on.
 * - `scribe.action(name, args)`: the page template's actions.
 * - `scribe.reply(data, { summary })`: a form's answers to the page its agent wired it to (replyTo).
 * - `scribe.file`: a file page's file (read, image, save, saveAs), through the board.
 * - blobs (`scribe.saveAsset` …), links (`scribe.open`, `scribe.resolve`, `data-scribe-open`),
 *   `scribe.onOpen` for a link that names a record in the page (`key#card=12`),
 *   `scribe.preview` for Scribe's file viewer, and `scribe.agent` for chat threads the page starts.
 *
 * Boot data is inlined ahead of this script so `scribe.state` is readable synchronously.
 * The ops engine is the daemon's own (stateOps.ts), embedded by source.
 */
const ENGINE_SRC = createStateOps.toString();

/**
 * An expression that builds the engine in the page. Under tsx (dev mode), esbuild's keepNames
 * wraps functions in `__name(fn, "name")`, a helper the page doesn't have, so give it a no-op one.
 */
export const ENGINE_JS = `(function () {
  var __name = function (fn) { return fn; };
  return (${ENGINE_SRC})();
})()`;

export const BOARD_BRIDGE_JS = `
${POINTER_DRAG_JS}
(function () {
  var boot = window.__SCRIBE_BOOT__ || {};
  var capturing = boot.capture === true || window.__SCRIBE_CAPTURE__ === true;
  try { delete window.__SCRIBE_BOOT__; } catch (err) { window.__SCRIBE_BOOT__ = undefined; }

  var engine = ${ENGINE_JS};

  var IDLE_MS = 250;
  var MAX_WAIT_MS = 1000;

  var tabId = boot.id || "";
  var client = "c_" + Math.random().toString(36).slice(2, 10);
  var writeSeq = 0;

  // base: the daemon's state at revision. current: base plus the writes it hasn't confirmed yet.
  var base = boot.state && typeof boot.state === "object" ? boot.state : {};
  var revision = typeof boot.stateRevision === "number" ? boot.stateRevision : 0;
  var current = engine.apply(base, []).state;
  var pending = [];          // ops not sent yet
  var inFlight = null;       // { writeId, ops } sent, not confirmed
  var pendingSince = 0;
  var timer = null;
  var queuedSignals = [];
  var resyncing = false;
  var heldDeltas = [];

  var listeners = [];
  var bindings = [];

  function warn(message, detail) {
    console.warn("[scribe] " + message, detail === undefined ? "" : detail);
  }

  function readEl(el) {
    return el.type === "checkbox" ? el.checked : el.value;
  }

  function writeEl(el, value) {
    if (el.type === "checkbox") {
      el.checked = Boolean(value);
      return;
    }
    el.value = value == null ? "" : String(value);
  }

  function sameEl(el, value) {
    if (el.type === "checkbox") {
      return el.checked === Boolean(value);
    }
    return el.value === (value == null ? "" : String(value));
  }

  /**
   * Tell onChange listeners what changed: { source: "remote" | "resync" | "local", ops }. ops is
   * the change as state ops, or null when it isn't known (a reload, or edits the daemon dropped):
   * then anything may have changed. Only listeners that asked for local writes hear those.
   */
  function notify(info) {
    var list = listeners.slice();
    for (var i = 0; i < list.length; i += 1) {
      if (info.source === "local" && !list[i].local) {
        continue;
      }
      try {
        list[i].fn(current, info);
      } catch (err) {
        console.error("[scribe] onChange handler failed", err);
      }
    }
  }

  // This page's own writes, told to local listeners once the code that made them has finished.
  var localOps = null;

  function noteLocal(ops) {
    if (!listeners.some(function (item) { return item.local; })) {
      return;
    }
    if (localOps) {
      for (var i = 0; i < ops.length; i += 1) localOps.push(ops[i]);
      return;
    }
    localOps = ops.slice();
    queueMicrotask(function () {
      var batch = localOps;
      localOps = null;
      notify({ source: "local", ops: batch });
    });
  }

  function sourceOf(binding) {
    return binding.local ? local : current;
  }

  function applyBindings() {
    for (var i = 0; i < bindings.length; i += 1) {
      var el = bindings[i].el;
      var key = bindings[i].key;
      var source = sourceOf(bindings[i]);
      if (!(key in source) || sameEl(el, source[key])) {
        el.classList.remove("scribe-stale");
        continue;
      }
      if (document.activeElement === el) {
        el.classList.add("scribe-stale");
        continue;
      }
      el.classList.remove("scribe-stale");
      writeEl(el, source[key]);
    }
  }

  /**
   * A field deferred while focused is normally reconciled by its blur handler, but focus
   * events are suppressed while the window is unfocused. Re-checking after any interaction
   * keeps a stale field from being stuck once the caret has moved on.
   */
  function reconcileSoon() {
    setTimeout(applyBindings, 0);
  }

  /**
   * Rebuild current from base and the unconfirmed writes. Ops that no longer apply are dropped.
   * Returns whether any were, since the page can't tell that from the incoming ops.
   */
  function rebase() {
    var mine = (inFlight ? inFlight.ops : []).concat(pending);
    var result = engine.apply(base, mine, { lenient: true });
    current = result.state;
    if (result.skipped.length) {
      warn("dropped edits that no longer apply after another change", result.skipped);
    }
    return result.skipped.length > 0;
  }

  function schedule() {
    if (!pendingSince) {
      pendingSince = Date.now();
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(flush, Math.min(IDLE_MS, Math.max(0, pendingSince + MAX_WAIT_MS - Date.now())));
  }

  function post(path, method, body) {
    return fetch("/api/tabs/" + encodeURIComponent(tabId) + path, {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          throw new Error((data && data.error) || "request failed (" + res.status + ")");
        }
        return data;
      });
    });
  }

  function nextWrite() {
    writeSeq += 1;
    return client + ":" + writeSeq;
  }

  /** Send pending ops; one write is in flight at a time so they reach the daemon in order. */
  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (inFlight || !tabId) {
      return;
    }
    if (queuedSignals.length) {
      sendSignal();
      return;
    }
    if (!pending.length) {
      return;
    }
    inFlight = { writeId: nextWrite(), ops: pending };
    pending = [];
    pendingSince = 0;
    var sent = inFlight.writeId;
    post("/state", "PUT", { ops: inFlight.ops, lenient: true, client: client, writeId: sent })
      .then(function (data) {
        confirm(sent, data);
      })
      .catch(function (err) {
        console.error("[scribe] save failed", err);
        // Keep the edits: put them back in front of anything typed since, and try again soon.
        if (inFlight && inFlight.writeId === sent) {
          pending = inFlight.ops.concat(pending);
          inFlight = null;
        }
        setTimeout(schedule, 2000);
      });
  }

  function sendSignal() {
    if (inFlight || !tabId || !queuedSignals.length) {
      return;
    }
    var next = queuedSignals.shift();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // The event carries the edits made before it, so an agent woken by it reads them.
    inFlight = { writeId: nextWrite(), ops: pending };
    pending = [];
    pendingSince = 0;
    var sent = inFlight.writeId;
    var body = { name: next.name, client: client, writeId: sent };
    if (next.data !== undefined) {
      body.data = next.data;
    }
    if (inFlight.ops.length) {
      body.ops = inFlight.ops;
    }
    post("/events", "POST", body)
      .then(function (data) {
        confirm(sent, data);
      })
      .catch(function (err) {
        console.error("[scribe] signal failed", err);
        if (inFlight && inFlight.writeId === sent) {
          pending = inFlight.ops.concat(pending);
          inFlight = null;
        }
        afterWrite();
      });
  }

  /** The daemon answered our write. Its delta may already have arrived; otherwise apply it now. */
  function confirm(writeId, data) {
    if (!inFlight || inFlight.writeId !== writeId) {
      afterWrite();
      return;
    }
    if (data && typeof data.stateRevision === "number" && data.stateRevision > revision) {
      if (data.fromRevision === revision && Array.isArray(data.applied)) {
        base = engine.apply(base, data.applied, { lenient: true }).state;
        revision = data.stateRevision;
      } else {
        // Someone else's delta is still on its way; the full state settles it.
        inFlight = null;
        resync();
        afterWrite();
        return;
      }
    }
    var skipped = data && Array.isArray(data.skipped) ? data.skipped : [];
    inFlight = null;
    if (skipped.length) {
      warn("Scribe skipped edits that no longer apply", skipped);
      rebase();
      applyBindings();
      notify({ source: "resync", ops: null });
    }
    afterWrite();
  }

  function afterWrite() {
    if (queuedSignals.length) {
      sendSignal();
    } else if (pending.length) {
      schedule();
    }
  }

  /** Change state with ops (see the scribe skill). Applies at once; throws if an op can't apply. */
  function update(ops) {
    if (capturing) return;
    var list = Array.isArray(ops) ? ops : [ops];
    if (!list.length) {
      return;
    }
    current = engine.apply(current, list).state;
    for (var i = 0; i < list.length; i += 1) {
      pending.push(list[i]);
    }
    noteLocal(list);
    schedule();
  }

  /** Replace top-level keys. Arrays of items with ids are diffed, so only what changed is sent. */
  function set(partial) {
    if (capturing) return;
    if (!partial || typeof partial !== "object") {
      return;
    }
    var next = {};
    var key;
    for (key in current) {
      next[key] = current[key];
    }
    var keys = [];
    for (key in partial) {
      next[key] = partial[key];
      keys.push(key);
    }
    var ops = engine.diff(current, next, keys);
    if (ops.length) {
      update(ops);
    }
  }

  function bind(el, key, options) {
    if (!el || !key) {
      return;
    }
    var binding = { el: el, key: key, local: Boolean(options && options.local) };
    var write = binding.local ? setLocal : set;
    bindings.push(binding);
    var source = sourceOf(binding);
    if (key in source) {
      writeEl(el, source[key]);
    } else if (readEl(el)) {
      write(single(key, readEl(el)));
    }
    function onEdit() {
      write(single(key, readEl(el)));
    }
    el.addEventListener("input", onEdit);
    el.addEventListener("change", onEdit);
    el.addEventListener("blur", function () {
      el.classList.remove("scribe-stale");
      if (!binding.local && pending.length) {
        flush();
        return;
      }
      var now = sourceOf(binding);
      if (key in now && !sameEl(el, now[key])) {
        writeEl(el, now[key]);
      }
    });
  }

  function single(key, value) {
    var one = {};
    one[key] = value;
    return one;
  }

  /** A delta from the daemon (relayed by Scribe). In order: apply. A gap: fetch the whole state. */
  function applyDelta(message) {
    if (resyncing) {
      heldDeltas.push(message);
      return;
    }
    if (typeof message.stateRevision !== "number" || message.stateRevision <= revision) {
      return;
    }
    if (message.fromRevision !== revision || !Array.isArray(message.ops)) {
      resync();
      return;
    }
    base = engine.apply(base, message.ops, { lenient: true }).state;
    revision = message.stateRevision;
    var own = Boolean(inFlight && message.writeId && message.writeId === inFlight.writeId);
    // Our own write comes back as is unless the daemon skipped some of it; only then is there news.
    var news = !own || message.ops.length !== inFlight.ops.length;
    if (own) {
      inFlight = null;
    }
    if (news) {
      // Edits of ours that the daemon or the rebase dropped aren't in message.ops.
      var dropped = rebase() || own;
      applyBindings();
      notify(dropped ? { source: "resync", ops: null } : { source: "remote", ops: message.ops });
    }
    // Otherwise current is already base plus the pending writes, and its items keep their identity.
    if (own) {
      afterWrite();
    }
  }

  function resync() {
    if (resyncing || !tabId) {
      return;
    }
    resyncing = true;
    fetch("/api/tabs/" + encodeURIComponent(tabId) + "/state")
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        resyncing = false;
        if (data && data.state && typeof data.stateRevision === "number" && data.stateRevision >= revision) {
          base = data.state;
          revision = data.stateRevision;
        }
        var held = heldDeltas;
        heldDeltas = [];
        rebase();
        applyBindings();
        notify({ source: "resync", ops: null });
        for (var i = 0; i < held.length; i += 1) {
          applyDelta(held[i]);
        }
      })
      .catch(function (err) {
        resyncing = false;
        console.error("[scribe] could not reload state", err);
      });
  }

  /* ---------- local state: this viewer's own, never shared ---------- */

  var viewer = !capturing && typeof boot.viewer === "string" ? boot.viewer : "";
  var local = boot.local && typeof boot.local === "object" ? boot.local : {};
  var localTimer = null;

  function setLocal(partial) {
    if (!partial || typeof partial !== "object") {
      return;
    }
    var next = {};
    var key;
    for (key in local) {
      next[key] = local[key];
    }
    for (key in partial) {
      if (partial[key] === undefined) {
        delete next[key];
      } else {
        next[key] = partial[key];
      }
    }
    local = next;
    if (!viewer || !tabId) {
      return;
    }
    if (localTimer) {
      clearTimeout(localTimer);
    }
    localTimer = setTimeout(saveLocal, IDLE_MS);
  }

  function saveLocal() {
    localTimer = null;
    if (!viewer || !tabId) {
      return;
    }
    post("/local?viewer=" + encodeURIComponent(viewer), "PUT", { state: local }).catch(function (err) {
      console.error("[scribe] could not save local state", err);
    });
  }

  /* ---------- events and actions ---------- */

  function signal(name, data) {
    if (capturing) return;
    var next = name == null ? "" : String(name).trim();
    if (!next) {
      console.error("[scribe] signal name is required");
      return;
    }
    queuedSignals.push(data === undefined ? { name: next } : { name: next, data: data });
    if (!inFlight) {
      sendSignal();
    }
  }

  /** Run one of the page template's actions; resolves with its result. State changes arrive as a delta. */
  function action(name, args) {
    if (capturing) return Promise.resolve(undefined);
    flush();
    return post("/action", "POST", { action: String(name || ""), args: args || {} }).then(function (data) {
      return data.result;
    });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) {
      return;
    }
    var data = event.data;
    if (!data || data.id !== tabId) {
      return;
    }
    if (data.type === "scribe-title") {
      titleChanged(data.title);
      return;
    }
    if (data.type !== "scribe-state") {
      return;
    }
    applyDelta(data);
  });

  /* ---------- the page's title: the tab and Library name ---------- */

  var title = typeof boot.title === "string" ? boot.title : "";
  var titleListeners = [];

  function titleChanged(next) {
    if (typeof next !== "string" || next === title) {
      return;
    }
    title = next;
    for (var i = 0; i < titleListeners.length; i += 1) {
      try {
        titleListeners[i](title);
      } catch (err) {
        console.error("[scribe] onTitle handler failed", err);
      }
    }
  }

  /** Rename this page, as the user typing a new name would. Resolves with the title it now has. */
  function setTitle(next) {
    next = next == null ? "" : String(next).trim();
    if (!next) {
      return Promise.reject(new Error("title is required"));
    }
    if (capturing || !tabId || next === title) {
      return Promise.resolve(title);
    }
    // The board renames the page: this origin can't reach that route.
    return askBoard({ type: "scribe-title", title: next }, 10000).then(function (result) {
      if (!result || !result.ok) {
        throw new Error((result && result.error) || "could not rename");
      }
      titleChanged(typeof result.title === "string" ? result.title : next);
      return title;
    });
  }

  function onTitle(fn) {
    titleListeners.push(fn);
    return function () {
      titleListeners = titleListeners.filter(function (item) {
        return item !== fn;
      });
    };
  }

  var lastActivityPing = 0;
  function pingActivity() {
    var now = Date.now();
    if (now - lastActivityPing < 400) {
      return;
    }
    lastActivityPing = now;
    try {
      parent.postMessage({ type: "scribe-activity", id: tabId }, "*");
    } catch (err) {}
  }

  document.addEventListener("pointerdown", reconcileSoon, true);
  document.addEventListener("keyup", reconcileSoon, true);
  document.addEventListener("input", pingActivity, true);
  document.addEventListener("change", pingActivity, true);
  document.addEventListener("keydown", pingActivity, true);
  document.addEventListener("pointerdown", pingActivity, true);

  function flushAll() {
    flush();
    if (localTimer) {
      clearTimeout(localTimer);
      saveLocal();
    }
  }

  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      flushAll();
      return;
    }
    applyBindings();
  });

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    var src = target.closest("[data-scribe-signal]");
    if (!src) {
      return;
    }
    var name = src.getAttribute("data-scribe-signal");
    if (!name) {
      return;
    }
    var tag = (src.tagName || "").toLowerCase();
    var type = (src.getAttribute("type") || (tag === "button" ? "submit" : "")).toLowerCase();
    if (tag === "a" || tag === "button" || type === "submit" || type === "button" || type === "image") {
      event.preventDefault();
    }
    signal(name);
  }, false);

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || !form.getAttribute) {
      return;
    }
    var name = form.getAttribute("data-scribe-signal");
    if (!name) {
      return;
    }
    event.preventDefault();
    signal(name);
  }, false);

  /* ---------- page links: scribe.open, data-scribe-open, external hrefs ---------- */

  var LINK_MODES = { tab: true, peek: true, split: true };
  var embedded = window.parent !== window;
  var boardOrigin = location.protocol + "//127.0.0.1" + (location.port ? ":" + location.port : "");
  var linkRequests = {};
  var linkSeq = 0;

  /** Ctrl/Cmd navigates, Shift splits, Alt peeks. Null when no modifier picks a mode. */
  function modeFromEvent(event) {
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

  function cleanMode(value) {
    var mode = value == null ? "" : String(value).trim().toLowerCase();
    if (mode === "navigate") {
      mode = "tab";
    }
    return LINK_MODES[mode] ? mode : null;
  }

  /** An http(s) URL outside Scribe, or null. Everything else is a page key or id. */
  function externalUrl(raw) {
    var text = raw == null ? "" : String(raw).trim();
    if (!/^https?:/i.test(text)) {
      return null;
    }
    var url;
    try {
      url = new URL(text);
    } catch (err) {
      return null;
    }
    if (url.origin === location.origin || url.origin === boardOrigin || isScribeOrigin(url)) {
      return null;
    }
    return url.href;
  }

  /** Another page's origin (#660) or the shared content origin, on the board's port. */
  function isScribeOrigin(url) {
    if (url.protocol !== location.protocol || url.port !== location.port) {
      return false;
    }
    return url.hostname === "127.0.0.2" || /^(t-[0-9a-f]+|x[0-9a-f]+)\\.localhost$/.test(url.hostname);
  }

  /** A file on disk ("file:///C:/a.png"): the board opens it as a temporary page (#655). */
  function isFileLink(raw) {
    return /^file:/i.test(raw == null ? "" : String(raw).trim());
  }

  function hasGesture() {
    var activation = navigator.userActivation;
    return !activation || activation.isActive;
  }

  function openInBrowser(href) {
    window.open(href, "_blank", "noopener,noreferrer");
  }

  function askBoard(message, timeoutMs) {
    return new Promise(function (resolve) {
      if (!embedded) {
        resolve({ ok: false, error: "no_board" });
        return;
      }
      linkSeq += 1;
      var reqId = client + ":" + linkSeq;
      linkRequests[reqId] = resolve;
      message.reqId = reqId;
      message.id = tabId;
      try {
        parent.postMessage(message, "*");
      } catch (err) {
        delete linkRequests[reqId];
        resolve({ ok: false, error: "no_board" });
        return;
      }
      setTimeout(function () {
        if (linkRequests[reqId]) {
          delete linkRequests[reqId];
          resolve({ ok: false, error: "timeout" });
        }
      }, timeoutMs || 5000);
    });
  }

  /**
   * Open a Scribe page (by key or id) or an http(s) URL as a tab, a peek, or a split.
   * Without a mode, a page follows the Settings default and a URL opens in the browser.
   */
  function open(target, options) {
    var opts = options || {};
    var raw = target == null ? "" : String(target).trim();
    if (!raw) {
      return Promise.resolve({ ok: false, error: "not_found" });
    }
    if (!hasGesture()) {
      console.warn("[scribe] scribe.open needs a click or key press; ignored " + raw);
      return Promise.resolve({ ok: false, error: "no_gesture" });
    }
    var mode = cleanMode(opts.mode);
    var anchor = opts.anchor == null ? "" : String(opts.anchor).replace(/^#/, "");
    var hash = raw.indexOf("#");
    var url = externalUrl(raw);
    // A file: link (#655) is a path, where # is part of the name.
    if (!url && hash > 0 && !isFileLink(raw)) {
      anchor = anchor || raw.slice(hash + 1);
      raw = raw.slice(0, hash);
    }
    if (url && (mode === null || mode === "tab")) {
      openInBrowser(url);
      return Promise.resolve({ ok: true, mode: "browser", url: url });
    }
    if (!embedded) {
      if (url) {
        openInBrowser(url);
        return Promise.resolve({ ok: true, mode: "browser", url: url });
      }
      window.open(boardOrigin + "/#" + encodeURIComponent(raw), "_blank");
      return Promise.resolve({ ok: true, mode: "tab" });
    }
    return askBoard({
      type: "scribe-open",
      target: url || raw,
      mode: mode,
      anchor: anchor || null,
      background: opts.background === true
    });
  }

  /** Look up Scribe pages by key or id: { [target]: { id, title, open } | null }. */
  function resolve(targets) {
    var list = Array.isArray(targets) ? targets : [targets];
    var clean = [];
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i] == null ? "" : String(list[i]).split("#")[0].trim();
      if (item && !externalUrl(item) && clean.indexOf(item) === -1) {
        clean.push(item);
      }
    }
    if (!clean.length) {
      return Promise.resolve({});
    }
    return askBoard({ type: "scribe-resolve", targets: clean }).then(function (reply) {
      return reply && reply.pages ? reply.pages : {};
    });
  }

  function linkFor(target) {
    if (!target || !target.closest) {
      return null;
    }
    var el = target.closest("[data-scribe-open], a[href]");
    if (!el) {
      return null;
    }
    if (el.hasAttribute("data-scribe-open")) {
      return { el: el, target: el.getAttribute("data-scribe-open") || "" };
    }
    if (el.hasAttribute("download")) {
      return null;
    }
    var href = el.getAttribute("href") || "";
    if (isFileLink(href)) {
      return { el: el, target: href.trim() };
    }
    var url = externalUrl(el.href);
    return url ? { el: el, target: url } : null;
  }

  /** The link a click would open here, or null when the browser should handle it. */
  function handledLink(target) {
    var link = linkFor(target);
    if (!link || (!embedded && externalUrl(link.target))) {
      return null;
    }
    return link;
  }

  // Cancel middle-button autoscroll and Shift selection on handled links only.
  document.addEventListener("mousedown", function (event) {
    if ((event.button === 1 || (event.button === 0 && event.shiftKey)) && handledLink(event.target)) {
      event.preventDefault();
    }
  }, true);

  function onLinkClick(event) {
    if (event.defaultPrevented || (event.type === "auxclick" ? event.button !== 1 : event.button !== 0)) {
      return;
    }
    var link = handledLink(event.target);
    if (!link) {
      return;
    }
    event.preventDefault();
    var mode = modeFromEvent(event) || cleanMode(link.el.getAttribute("data-scribe-mode"));
    open(link.target, { mode: mode, background: event.button === 1 }).then(function (result) {
      if (!result || result.error === "no_gesture" || result.error === "timeout" || result.error === "no_board") {
        return;
      }
      // The page was deleted or restored since the links were checked: recheck every link, not just this one.
      var missing = result.error === "not_found" || result.error === "in_trash";
      if (missing !== link.el.classList.contains("scribe-link-missing")) {
        recheckLinks();
      }
    });
  }
  document.addEventListener("click", onLinkClick, false);
  document.addEventListener("auxclick", onLinkClick, false);

  /** Mark links to pages that don't exist, and fill in empty link text with the page's title. */
  var labelQueued = false;
  // Titles from the last resolve (null: missing), so a page that re-renders its links shows them at once, not blank
  // until the next resolve. labelLinks still checks each one.
  var knownTitles = Object.create(null);
  function labelLink(el, raw, page) {
    el.classList.toggle("scribe-link-missing", !page);
    // An empty link shows its page's title, kept current on each recheck; the target itself while the page is missing.
    if (el.hasAttribute("data-scribe-autotitle") || (!el.textContent.trim() && !el.children.length)) {
      el.setAttribute("data-scribe-autotitle", "");
      var text = page ? page.title : raw;
      if (el.textContent !== text) {
        el.textContent = text;
      }
    }
    if (page && !el.getAttribute("title")) {
      el.setAttribute("title", page.title);
    }
  }
  function labelKnownLinks(root) {
    var els = root.matches && root.matches("[data-scribe-open]") ? [root] : [];
    if (root.querySelectorAll) {
      els = els.concat(Array.prototype.slice.call(root.querySelectorAll("[data-scribe-open]")));
    }
    for (var i = 0; i < els.length; i += 1) {
      var raw = (els[i].getAttribute("data-scribe-open") || "").split("#")[0].trim();
      if (raw in knownTitles) {
        labelLink(els[i], raw, knownTitles[raw] === null ? null : { title: knownTitles[raw] });
      }
    }
  }
  function labelLinks() {
    labelQueued = false;
    if (!embedded) {
      return;
    }
    var els = document.querySelectorAll("[data-scribe-open]:not([data-scribe-link-checked])");
    if (!els.length) {
      return;
    }
    var targets = [];
    for (var i = 0; i < els.length; i += 1) {
      els[i].setAttribute("data-scribe-link-checked", "");
      targets.push(els[i].getAttribute("data-scribe-open") || "");
    }
    resolve(targets).then(function (pages) {
      for (var j = 0; j < els.length; j += 1) {
        var el = els[j];
        var raw = (el.getAttribute("data-scribe-open") || "").split("#")[0].trim();
        if (externalUrl(raw)) {
          continue;
        }
        var page = pages[raw];
        knownTitles[raw] = page ? page.title : null;
        labelLink(el, raw, page);
      }
    });
  }
  /** Pages were created, deleted, or restored: check every link again. */
  function recheckLinks() {
    var els = document.querySelectorAll("[data-scribe-open][data-scribe-link-checked]");
    for (var i = 0; i < els.length; i += 1) {
      els[i].removeAttribute("data-scribe-link-checked");
    }
    queueLabels();
  }
  function queueLabels() {
    if (labelQueued) {
      return;
    }
    labelQueued = true;
    setTimeout(labelLinks, 50);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", queueLabels);
  } else {
    queueLabels();
  }
  if (embedded && typeof MutationObserver === "function") {
    new MutationObserver(function (records) {
      var changed = false;
      for (var i = 0; i < records.length; i += 1) {
        if (records[i].type === "attributes") {
          records[i].target.removeAttribute("data-scribe-link-checked");
          changed = true;
        } else if (records[i].addedNodes.length) {
          for (var k = 0; k < records[i].addedNodes.length; k += 1) {
            labelKnownLinks(records[i].addedNodes[k]);
          }
          changed = true;
        }
      }
      if (changed) {
        queueLabels();
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-scribe-open"] });
  }

  function scrollToAnchor(anchor) {
    var name = anchor == null ? "" : String(anchor).replace(/^#/, "");
    if (!name) {
      return;
    }
    var el = document.getElementById(name) || document.getElementsByName(name)[0];
    // "scribe-section:3": the page's third h1 to h4, for a search hit in a section whose heading has no id.
    var section = /^scribe-section:(\\d+)$/.exec(name);
    if (!el && section) {
      el = document.querySelectorAll("h1, h2, h3, h4")[Number(section[1]) - 1];
    }
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /**
   * What a link asked this page to show: "card=12" (or "a=1&b=2") is open arguments for scribe.onOpen, anything
   * else an element id to scroll to. A request that comes before the page listens waits for its first listener.
   */
  var openListeners = [];
  var pendingOpen = null;
  function openRequest(anchor) {
    var name = anchor == null ? "" : String(anchor).replace(/^#/, "");
    var args = {};
    if (name.indexOf("=") > 0) {
      name.split("&").forEach(function (part) {
        var eq = part.indexOf("=");
        var key = eq > 0 ? part.slice(0, eq) : "";
        if (key) {
          try {
            args[key] = decodeURIComponent(part.slice(eq + 1));
          } catch (err) {
            args[key] = part.slice(eq + 1);
          }
        }
      });
    }
    return { anchor: name, args: args };
  }
  function deliverOpen(request) {
    openListeners.slice().forEach(function (fn) {
      try {
        fn(request);
      } catch (err) {
        console.error("[scribe] onOpen handler failed", err);
      }
    });
  }
  function onOpen(fn) {
    openListeners.push(fn);
    if (pendingOpen) {
      var request = pendingOpen;
      pendingOpen = null;
      Promise.resolve().then(function () {
        deliverOpen(request);
      });
    }
    return function () {
      openListeners = openListeners.filter(function (item) {
        return item !== fn;
      });
    };
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) {
      return;
    }
    var data = event.data;
    if (!data || data.id !== tabId) {
      return;
    }
    if (data.type === "scribe-open-result" && linkRequests[data.reqId]) {
      var done = linkRequests[data.reqId];
      delete linkRequests[data.reqId];
      done(data.result || { ok: false, error: "unknown" });
    } else if (data.type === "scribe-scroll") {
      var request = openRequest(data.anchor);
      if (!Object.keys(request.args).length) {
        scrollToAnchor(request.anchor);
      }
      if (openListeners.length) {
        deliverOpen(request);
      } else {
        pendingOpen = request;
      }
    } else if (data.type === "scribe-pages-changed") {
      recheckLinks();
    } else if (data.type === "scribe-agent-event") {
      agentListeners.slice().forEach(function (fn) {
        try {
          fn(data.thread);
        } catch (err) {
          console.error(err);
        }
      });
    } else if (data.type === "scribe-agent-limits") {
      agentLimitListeners.slice().forEach(function (fn) {
        try {
          fn(data.limits || {});
        } catch (err) {
          console.error(err);
        }
      });
    } else if (data.type === "scribe-agent-options") {
      agentOptionsListeners.slice().forEach(function (fn) {
        try {
          fn(data.options || {});
        } catch (err) {
          console.error(err);
        }
      });
    } else if (data.type === "scribe-agent-steps") {
      agentStepListeners.slice().forEach(function (fn) {
        try {
          fn({ id: data.threadId, steps: Array.isArray(data.steps) ? data.steps : [] });
        } catch (err) {
          console.error(err);
        }
      });
    }
  });

  var template = boot.template && typeof boot.template === "object" ? boot.template : null;

  function reportIncompatible(reason) {
    if (capturing) return;
    if (!tabId || !template) {
      return;
    }
    post("/template-incompatible", "POST", { reason: reason == null ? "" : String(reason) }).catch(function (err) {
      console.error("[scribe] reportIncompatible failed", err);
    });
  }

  function assetsPath(suffix) {
    return "/api/tabs/" + encodeURIComponent(tabId) + "/assets" + (suffix || "");
  }

  function readJson(res) {
    return res.json().catch(function () {
      return {};
    }).then(function (data) {
      if (!res.ok) {
        throw new Error((data && data.error) || "request failed (" + res.status + ")");
      }
      return data;
    });
  }

  function warnUsage(usage) {
    if (usage && usage.warning) {
      console.warn("[scribe] " + usage.warning);
    }
  }

  /**
   * Store a Blob, File, ArrayBuffer, or typed array for this page. Keep the returned id (or
   * url) in page state: an asset nothing in the state or HTML mentions is deleted after a
   * grace period.
   */
  function saveAsset(data, options) {
    if (capturing) return Promise.resolve(undefined);
    var opts = options || {};
    if (!tabId) {
      return Promise.reject(new Error("no tab id"));
    }
    var blob = data instanceof Blob ? data : new Blob([data]);
    var name = opts.name || (data && typeof data.name === "string" ? data.name : "") || "asset";
    var type = opts.type || blob.type || "application/octet-stream";
    return fetch(assetsPath(""), {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Asset-Name": encodeURIComponent(name),
        "X-Asset-Type": type
      },
      body: blob
    })
      .then(readJson)
      .then(function (result) {
        warnUsage(result.usage);
        var asset = result.asset;
        asset.usage = result.usage;
        return asset;
      });
  }

  function deleteAsset(id) {
    if (capturing) return Promise.resolve(undefined);
    return fetch(assetsPath("/" + encodeURIComponent(String(id))), { method: "DELETE" })
      .then(readJson)
      .then(function (result) {
        return result.usage;
      });
  }

  function listAssets() {
    return fetch(assetsPath("")).then(readJson);
  }

  function assetUrl(idOrUrl) {
    var value = String(idOrUrl || "");
    return value.indexOf("/blob/") === 0 ? value : "/blob/" + value;
  }

  // ---------- file preview ----------
  // scribe.preview shows files in Scribe's own viewer (images, PDFs, media, text, Markdown, CSV,
  // HTML), so pages need no viewer of their own. The page reads each file itself (it may be one of
  // its assets) and hands the bytes over; Scribe never loads a URL for it.

  function previewFile(item, opts) {
    if (item instanceof Blob) {
      return Promise.resolve({ blob: item, name: item.name || opts.name || "file", mimeType: item.type || opts.mimeType || "" });
    }
    var spec = typeof item === "string" ? { src: item } : item || {};
    if (spec.blob instanceof Blob) {
      return Promise.resolve({ blob: spec.blob, name: spec.name || spec.blob.name || "file", mimeType: spec.mimeType || spec.blob.type || "" });
    }
    var src = String(spec.src || spec.url || spec.asset || "");
    if (!src) {
      return Promise.reject(new Error("Nothing to preview"));
    }
    // An asset id or /blob/ path, or any URL this page may fetch.
    var url = /^[a-z][a-z0-9+.-]*:|^\\//i.test(src) ? src : assetUrl(src);
    return fetch(url).then(function (res) {
      if (!res.ok) {
        throw new Error("Could not load " + src + " (" + res.status + ")");
      }
      return res.blob().then(function (blob) {
        var name = spec.name || opts.name || decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() || "file");
        return { blob: blob, name: name, mimeType: spec.mimeType || opts.mimeType || blob.type || "" };
      });
    });
  }

  /**
   * Preview one file or several (arrow keys step through them): a Blob or File, an asset id or URL,
   * or { src | blob, name?, mimeType? }. Needs a click or key press, like scribe.open.
   * opts: { index, name, mimeType }. Resolves { ok } or { ok: false, error }.
   */
  function preview(files, opts) {
    opts = opts || {};
    if (!hasGesture()) {
      console.warn("[scribe] scribe.preview needs a click or key press; ignored");
      return Promise.resolve({ ok: false, error: "no_gesture" });
    }
    var list = Array.isArray(files) ? files : [files];
    return Promise.all(
      list.map(function (item) {
        return previewFile(item, list.length === 1 ? opts : {});
      })
    ).then(
      function (resolved) {
        return askBoard({ type: "scribe-preview", files: resolved, index: Number(opts.index) || 0 });
      },
      function (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    );
  }

  // ---------- agent ----------
  // A page can run agent chat threads of its own. Starting, sending, and stopping need a click or
  // key press, unless the user lets the page run agents without one; Code and Plan threads need the
  // user's approval for their folder. Scribe checks both on its side and asks the user when needed,
  // so those calls may take as long as the user does.
  var agentListeners = [];
  var agentStepListeners = [];
  var agentLimitListeners = [];
  var agentOptionsListeners = [];
  var AGENT_ASK_MS = 10 * 60 * 1000;

  function agentText(value) {
    return value == null ? null : String(value);
  }

  function agentCall(message, timeoutMs) {
    message.type = "scribe-agent";
    return askBoard(message, timeoutMs || 30000).then(function (result) {
      if (result && result.ok === false && (result.error === "no_gesture" || result.error === "denied")) {
        console.warn(
          "[scribe] scribe.agent." + message.op + ": " +
            (result.error === "no_gesture" ? "needs a click or key press" : "not allowed (" + (result.permission || "permission") + ")")
        );
      }
      return result;
    });
  }

  /** A run's settings for start({ run }) and watch(): { tag, data, merge, resumePrompt, after }. */
  function agentRun(run) {
    var out = {};
    if (typeof run.tag === "string") out.tag = run.tag;
    if (run.data && typeof run.data === "object" && !Array.isArray(run.data)) out.data = JSON.parse(JSON.stringify(run.data));
    if (run.merge === false) out.merge = false;
    if (typeof run.resumePrompt === "string") out.resumePrompt = run.resumePrompt;
    if (typeof run.after === "number") out.after = run.after;
    return out;
  }

  var AGENT_MAX_IMAGES = 10;
  var AGENT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

  /** One image for start or send: a Blob or File, a data: URL, or an asset id or URL this page may fetch. */
  function agentImage(item) {
    var loaded;
    if (item instanceof Blob) {
      loaded = Promise.resolve(item);
    } else if (typeof item === "string" && item.indexOf("data:") === 0) {
      // Read as is: the page's CSP need not let it fetch data: URLs.
      var parts = /^data:(image\\/[\\w.+-]+);base64,(.+)$/.exec(item);
      if (!parts) return Promise.reject(new Error("not_an_image"));
      if (Math.floor((parts[2].length * 3) / 4) > AGENT_MAX_IMAGE_BYTES) return Promise.reject(new Error("image_too_large"));
      return Promise.resolve({ name: "image", mimeType: parts[1], data: parts[2] });
    } else if (typeof item === "string" && item) {
      var url = /^[a-z][a-z0-9+.-]*:|^\\//i.test(item) ? item : assetUrl(item);
      loaded = fetch(url).then(function (res) {
        if (!res.ok) throw new Error("image_not_found");
        return res.blob();
      });
    } else {
      return Promise.reject(new Error("not_an_image"));
    }
    return loaded.then(function (blob) {
      if (!/^image\\//.test(blob.type || "")) throw new Error("not_an_image");
      if (blob.size > AGENT_MAX_IMAGE_BYTES) throw new Error("image_too_large");
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          var data = String(reader.result || "");
          resolve({ name: blob.name || "image", mimeType: blob.type, data: data.slice(data.indexOf(",") + 1) });
        };
        reader.onerror = function () {
          reject(new Error("image_unreadable"));
        };
        reader.readAsDataURL(blob);
      });
    });
  }

  /** opts.images as the board takes them, then the call; an image that won't do resolves { ok: false, error }. */
  function withImages(message, images, timeoutMs) {
    if (images == null) return agentCall(message, timeoutMs);
    var list = Array.isArray(images) ? images : [images];
    if (list.length > AGENT_MAX_IMAGES) return Promise.resolve({ ok: false, error: "too_many_images" });
    return Promise.all(list.map(agentImage)).then(
      function (read) {
        message.images = read;
        return agentCall(message, timeoutMs);
      },
      function (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    );
  }

  /** The thread settings a page may pass to start(); Scribe checks them against the page's permissions. */
  function agentSettings(opts) {
    var out = {};
    ["title", "mode", "show", "provider", "model", "effort", "approval", "cwd"].forEach(function (name) {
      if (opts[name] != null && opts[name] !== "") {
        out[name] = String(opts[name]);
      }
    });
    ["worktree", "web", "fast", "helpers"].forEach(function (name) {
      if (typeof opts[name] === "boolean") {
        out[name] = opts[name];
      }
    });
    if (opts.web === "on" || opts.web === "limited" || opts.web === "off") out.web = opts.web;
    if (opts.tools === false) out.tools = false;
    if (Number.isInteger(opts.cardContext) && opts.cardContext > 0) out.cardContext = opts.cardContext;
    if (opts.run === true) out.run = {};
    else if (opts.run && typeof opts.run === "object") out.run = agentRun(opts.run);
    if (opts.modelParams && typeof opts.modelParams === "object" && !Array.isArray(opts.modelParams)) {
      var params = {};
      Object.keys(opts.modelParams).forEach(function (key) {
        var val = opts.modelParams[key];
        if (val != null && val !== "") params[key] = String(val);
      });
      if (Object.keys(params).length) out.modelParams = params;
    }
    return out;
  }

  var agent = {
    /**
     * New thread for this page: { ok, threadId, queued }. opts: { title, show: "dock" | "sidebar",
     * approval: the rung, "readonly" | "board" (default) | "edits" | "auto" | "full", mode: "plan"
     * to make the first message a plan turn ("code", "board" and "ask" are older names: code keeps
     * the rung, board and ask are Board), provider, model, effort, fast (Cursor), modelParams, cwd (folder: needed from Edits up),
     * worktree, web: "on" | "limited" | "off" (or a boolean), helpers: true (the agent may start
     * helper agents without asking the user each time) }. run: true or { tag, data, merge,
     * resumePrompt } hands the thread to Scribe to see through (see watch).
     * cardContext: a card number attaches this page's full card and images to the first message.
     * images: up to 10 images (Blobs, Files, data: URLs, or asset ids or URLs; 8 MB each) for the
     * first message. tools: false is a one-off chat with no tools at all (no pages, files, shell or
     * web; Read-only, no folder), for OCR, classifying or rewriting what the prompt and images hold.
     */
    start: function (prompt, opts) {
      opts = opts || {};
      var message = agentSettings(opts);
      message.op = "start";
      message.prompt = agentText(prompt);
      return withImages(message, opts.images, AGENT_ASK_MS);
    },
    /** Send to one of this page's threads; queued when it is still working: { ok, queued }. opts: { show, images (as in start) }. */
    send: function (threadId, prompt, opts) {
      opts = opts || {};
      return withImages({ op: "send", threadId: agentText(threadId), prompt: agentText(prompt), show: agentText(opts.show) }, opts.images, AGENT_ASK_MS);
    },
    /** Delete one of this page's threads, e.g. a one-off chat once its reply is read; a running turn stops first: { ok }. */
    delete: function (threadId) {
      return agentCall({ op: "delete", threadId: agentText(threadId) });
    },
    /**
     * Open a thread in Scribe's chat (needs a click): { ok }. Any thread the user has, not only this
     * page's, e.g. the one that last claimed a card; the page learns nothing about it. opts: { where: "sidebar" | "dock" }.
     */
    show: function (threadId, opts) {
      if (!hasGesture()) {
        console.warn("[scribe] scribe.agent.show needs a click or key press; ignored");
        return Promise.resolve({ ok: false, error: "no_gesture" });
      }
      return agentCall({ op: "show", threadId: agentText(threadId), where: agentText(opts && opts.where) });
    },
    /**
     * About a Kanban card: { ok, delivered: "steered" | "queued" | "started" | null }. With text, a
     * comment for the thread working on the card: steered into its running turn, or queued behind it
     * when the provider cannot steer; not sent (delivered null) when the thread is idle. With
     * resume: true, Continue: Kanban saves a request and returns deferred: true, delivered: null
     * until the daemon's worker conditions permit dispatch. Other pages tell the thread to read the card again. Any of the user's
     * threads, e.g. the one that claimed the card; one that isn't this page's needs a click.
     * opts: { card: number, title, text, resume }.
     */
    card: function (threadId, opts) {
      opts = opts || {};
      return agentCall(
        { op: "card", threadId: agentText(threadId), card: Number(opts.card), title: agentText(opts.title), prompt: agentText(opts.text), resume: opts.resume === true },
        AGENT_ASK_MS
      );
    },
    /**
     * Hand one of this page's threads to Scribe to see through, even while no window shows the
     * page: when a plan usage limit stops its turn, Scribe waits until the provider confirms the
     * reset and sends it on (resumePrompt); when its turn is done, Scribe merges its worktree branch
     * (unless merge: false), asking the agent to rebase and fix a branch that won't merge. The
     * thread's run ({ phase: "running" | "waiting" | "ended", wait?, fixes, outcome?, tag, data })
     * shows on threads(), get() and onChange; the page logs an agent_run event at each step.
     * outcome.kind: done (merged true/false, held) | failed | cancelled | limit | merge_failed.
     * opts: { tag, data (small JSON, returned as given), merge, resumePrompt, after (only turns
     * started from then count; default now, 0 for the thread as it is) }. Resolves { ok, thread }.
     */
    watch: function (threadId, opts) {
      var message = { op: "watch", threadId: agentText(threadId), run: agentRun(opts || {}) };
      return agentCall(message, AGENT_ASK_MS);
    },
    /**
     * Ask the user now (needs a click) for what the page's own agents need to start chats without
     * one: agent chats without a click, and for Code and Plan the folder at that approval. A Kanban
     * board's ▶ calls it, since Scribe then starts its workers' chats itself. opts: { mode, cwd,
     * approval }. Resolves { ok } or { ok: false, error: "denied", permission }.
     */
    allow: function (opts) {
      opts = opts || {};
      return agentCall({ op: "allow", mode: agentText(opts.mode), cwd: agentText(opts.cwd), approval: agentText(opts.approval) }, AGENT_ASK_MS);
    },
    /** Scribe stops seeing the thread through, and forgets an ended run once the page has dealt with it: { ok }. */
    release: function (threadId) {
      return agentCall({ op: "release", threadId: agentText(threadId) });
    },
    /** Stop the thread's current turn and drop its queued messages: { ok }. */
    stop: function (threadId) {
      return agentCall({ op: "stop", threadId: agentText(threadId) }, AGENT_ASK_MS);
    },
    /**
     * Merge an idle thread's worktree branch into the branch it came from, and close the worktree:
     * { ok, merged, message }. merged is false when the thread has no open worktree.
     */
    merge: function (threadId) {
      return agentCall({ op: "merge", threadId: agentText(threadId) }, AGENT_ASK_MS);
    },
    /** This page's threads, newest first: { ok, threads: [{ id, title, status, queued, activityAt, finishedAt, mode, model, cwd, worktree?, usage? }] }. worktree ({ branch, ahead, dirty }, as of the last turn) is there while the thread has one open. usage is token totals across the thread's turns. */
    threads: function () {
      return agentCall({ op: "threads" });
    },
    /** One thread and its latest reply: { ok, thread, reply }. */
    get: function (threadId) {
      return agentCall({ op: "get", threadId: agentText(threadId) });
    },
    /**
     * The running turn's last few steps, as Scribe's collapsed chat shows them: { ok, steps: [{ key,
     * kind, text }] } (empty while the thread is idle). From then on onSteps reports that thread's changes.
     */
    steps: function (threadId) {
      return agentCall({ op: "steps", threadId: agentText(threadId) });
    },
    /** fn({ id, steps }) whenever the steps of a thread this page asked steps() for change. */
    onSteps: function (fn) {
      agentStepListeners.push(fn);
      return function () {
        agentStepListeners = agentStepListeners.filter(function (item) {
          return item !== fn;
        });
      };
    },
    /** Resolves once the thread is idle (queue included): { ok, thread, reply }, or { ok: false, error: "timeout" }. */
    wait: function (threadId, opts) {
      var ms = opts && typeof opts.timeoutMs === "number" ? Math.max(1000, opts.timeoutMs) : 600000;
      return agentCall({ op: "wait", threadId: agentText(threadId), timeoutMs: ms }, ms + 5000);
    },
    /** What start() can pick from: { ok, providers, models (id, label, efforts, params), modes, approvals, defaults, favorites ("provider:id", star order) }. Also subscribes this page to onOptions updates. */
    options: function () {
      return agentCall({ op: "options" });
    },
    /** fn(options) after options() whenever the user stars or unstars a model. Returns an unsubscribe function. */
    onOptions: function (fn) {
      agentOptionsListeners.push(fn);
      return function () {
        agentOptionsListeners = agentOptionsListeners.filter(function (item) { return item !== fn; });
      };
    },
    /**
     * The app's own model picker (favourites, search, stars), opened over the page below anchor
     * (an element, or { left, top, width, height } in the page): { ok, provider, model, label }, or
     * { ok: false, error: "cancelled" } once the user closes it. Needs a click. opts: { provider, model } to check.
     */
    pickModel: function (anchor, opts) {
      if (!hasGesture()) {
        console.warn("[scribe] scribe.agent.pickModel needs a click or key press; ignored");
        return Promise.resolve({ ok: false, error: "no_gesture" });
      }
      opts = opts || {};
      var box = anchor && typeof anchor.getBoundingClientRect === "function" ? anchor.getBoundingClientRect() : anchor || {};
      return agentCall({
        op: "pickModel",
        rect: { left: Number(box.left) || 0, top: Number(box.top) || 0, width: Number(box.width) || 0, height: Number(box.height) || 0 },
        provider: agentText(opts.provider),
        model: agentText(opts.model),
      }, AGENT_ASK_MS);
    },
    /**
     * Make the page's own button a model picker: it shows the chosen model's label and opens
     * pickModel on click. opts: { value: { provider, model }, placeholder, onChange(value) }.
     * Returns { value(), set(value), destroy() }.
     */
    modelPicker: function (el, opts) {
      opts = opts || {};
      var value = opts.value && opts.value.model ? { provider: String(opts.value.provider || ""), model: String(opts.value.model) } : null;
      var labels = {};
      var open = false;
      var wasOpen = false;
      function paint() {
        el.textContent = value ? labels[value.provider + ":" + value.model] || value.model : opts.placeholder || "Default model";
      }
      function onDown() {
        // A click on the button while the picker is open closes it (the frame takes focus), not reopens it.
        wasOpen = open;
      }
      function onClick() {
        if (wasOpen) {
          wasOpen = false;
          return;
        }
        open = true;
        agent.pickModel(el, value || {}).then(function (r) {
          open = false;
          if (!r || !r.ok) return;
          value = { provider: r.provider, model: r.model };
          labels[r.provider + ":" + r.model] = r.label;
          paint();
          if (typeof opts.onChange === "function") opts.onChange({ provider: r.provider, model: r.model });
        });
      }
      el.addEventListener("pointerdown", onDown);
      el.addEventListener("click", onClick);
      paint();
      agent.options().then(function (o) {
        var models = (o && o.models) || {};
        Object.keys(models).forEach(function (provider) {
          (models[provider] || []).forEach(function (m) { labels[provider + ":" + m.id] = m.label; });
        });
        paint();
      });
      return {
        value: function () { return value ? { provider: value.provider, model: value.model } : null; },
        set: function (next) {
          value = next && next.model ? { provider: String(next.provider || ""), model: String(next.model) } : null;
          paint();
        },
        destroy: function () {
          el.removeEventListener("pointerdown", onDown);
          el.removeEventListener("click", onClick);
        },
      };
    },
    /** Provider plan usage: { ok, limits: { [provider]: { at, windows: [{ id, label, utilization, resetsAt? }], availability?, detail?, ordinaryUsageAllowed?, overage? } } }. Missing providers have no report. Also subscribes this page to onLimits updates. */
    limits: function () {
      return agentCall({ op: "limits" });
    },
    /** fn(limits) after limits() whenever provider usage changes. Returns an unsubscribe function. */
    onLimits: function (fn) {
      agentLimitListeners.push(fn);
      return function () {
        agentLimitListeners = agentLimitListeners.filter(function (item) { return item !== fn; });
      };
    },
    /**
     * The template's agent actions for the page's right-click menu, so a page that draws its own menu
     * can offer them: { ok, actions: [{ id, label, description, selection, context: [names] }] }.
     * context lists the placeholders the page must supply to runAction, e.g. ["card"].
     */
    actions: function () {
      return agentCall({ op: "actions" });
    },
    /**
     * Run one of those actions as if chosen from Scribe's menu (needs a click): { ok }, or
     * { ok: false, error: "missing_context" | "needs_selection" | "not_found" }. opts: { context:
     * { name: text }, e.g. { card: "#12 Fix login" }, selection }.
     */
    runAction: function (id, opts) {
      if (!hasGesture()) {
        console.warn("[scribe] scribe.agent.runAction needs a click or key press; ignored");
        return Promise.resolve({ ok: false, error: "no_gesture" });
      }
      opts = opts || {};
      var context = {};
      if (opts.context && typeof opts.context === "object") {
        Object.keys(opts.context).forEach(function (name) {
          var value = opts.context[name];
          if (typeof value === "string" || typeof value === "number") context[name] = String(value);
        });
      }
      return agentCall({ op: "runAction", action: agentText(id), context: context, selection: agentText(opts.selection) }, AGENT_ASK_MS);
    },
    /** Let the user pick a folder for Code and Plan threads (needs a click): { ok, path } or { ok: false, error: "cancelled" }. */
    pickFolder: function (opts) {
      if (!hasGesture()) {
        console.warn("[scribe] scribe.agent.pickFolder needs a click or key press; ignored");
        return Promise.resolve({ ok: false, error: "no_gesture" });
      }
      return agentCall({ op: "pickFolder", initial: agentText(opts && opts.initial) }, AGENT_ASK_MS);
    },
    /** fn({ id, title, status, queued, run?, reply? }) whenever one of this page's threads changes status or run. */
    onChange: function (fn) {
      agentListeners.push(fn);
      return function () {
        agentListeners = agentListeners.filter(function (item) {
          return item !== fn;
        });
      };
    }
  };

  // ---------- permissions ----------
  // What the user lets this page do (tab menu → Permissions…). Only Scribe can change them.
  var permissions = {
    /** { ok, permissions: [{ id, label, value: "allow" | "deny" | "ask", folders? }] } */
    query: function () {
      return askBoard({ type: "scribe-permissions", op: "query" }, 30000);
    },
    /**
     * Ask the user up front, e.g. from a settings dialog (needs a click): { ok, granted }.
     * opts for agent.workspace: { folder, approval }.
     */
    request: function (perm, opts) {
      if (!hasGesture()) {
        console.warn("[scribe] scribe.permissions.request needs a click or key press; ignored");
        return Promise.resolve({ ok: false, error: "no_gesture" });
      }
      opts = opts || {};
      return askBoard(
        { type: "scribe-permissions", op: "request", perm: agentText(perm), folder: agentText(opts.folder), approval: agentText(opts.approval) },
        AGENT_ASK_MS
      );
    }
  };

  // ---------- files ----------
  // Files in folders the user approved for this page (#882), each at read, write, or readwrite.
  // Calls never prompt, so they work from the page's own code: ask up front with request() in a
  // click. Paths are absolute. Failures resolve { ok: false, error, message }; error "permission"
  // means no folder covers the path at that access yet, "denied" that the user refused.
  function filesCall(op, file, opts) {
    if (capturing) return Promise.resolve({ ok: false, error: "capture" });
    opts = opts || {};
    var query = "?path=" + encodeURIComponent(String(file || ""));
    if (opts.append) query += "&append=1";
    if (opts.overwrite === false) query += "&overwrite=0";
    var init = opts.body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: opts.body };
    return fetch("/api/tabs/" + encodeURIComponent(tabId) + "/files/" + op + query, init).then(function (res) {
      if (res.ok && op === "read") return res;
      return res.json().catch(function () { return { ok: false, error: "failed", message: "request failed (" + res.status + ")" }; });
    }).catch(function (err) {
      return { ok: false, error: "failed", message: String((err && err.message) || err) };
    });
  }
  var files = {
    /** The folders approved for this page: { ok, folders: [{ path, access: "read" | "write" | "readwrite" }] }. */
    folders: function () {
      return permissions.query().then(function (result) {
        if (!result || !result.ok) return result || { ok: false, error: "failed" };
        var perm = (result.permissions || []).filter(function (p) { return p.id === "files"; })[0];
        return { ok: true, folders: ((perm && perm.folders) || []).map(function (f) { return { path: f.path, access: f.approval }; }) };
      });
    },
    /**
     * Ask the user for a folder (needs a click): { ok, granted, folder }. opts: { folder, access }
     * (access defaults to "readwrite"); without a folder, the user picks one first.
     */
    request: function (opts) {
      if (!hasGesture()) {
        console.warn("[scribe] scribe.files.request needs a click or key press; ignored");
        return Promise.resolve({ ok: false, error: "no_gesture" });
      }
      opts = opts || {};
      var access = opts.access === "read" || opts.access === "write" ? opts.access : "readwrite";
      return askBoard({ type: "scribe-permissions", op: "request", perm: "files", folder: agentText(opts.folder), approval: access, pick: !opts.folder }, AGENT_ASK_MS);
    },
    /** A path under folder: join(folder, "images", "a.png"). The daemon normalizes the separators. */
    join: function () {
      return Array.prototype.slice.call(arguments).map(String).filter(Boolean).join("/");
    },
    /** { ok, text } by default; opts.as "blob" gives { ok, blob }, "arrayBuffer" { ok, buffer }. Needs read access. */
    read: function (file, opts) {
      var as = (opts && opts.as) || "text";
      return filesCall("read", file).then(function (res) {
        if (!(res instanceof Response)) return res;
        if (as === "blob") return res.blob().then(function (blob) { return { ok: true, blob: blob }; });
        if (as === "arrayBuffer") return res.arrayBuffer().then(function (buffer) { return { ok: true, buffer: buffer }; });
        return res.text().then(function (text) { return { ok: true, text: text }; });
      });
    },
    /**
     * Save a string, Blob, ArrayBuffer, or typed array: { ok, path, name, size, mtime }. Missing
     * folders are made. opts: { append, overwrite: false (fails with "exists") }. Needs write access.
     */
    write: function (file, data, opts) {
      opts = opts || {};
      var body = data instanceof Blob ? data : new Blob([data == null ? "" : data]);
      return filesCall("write", file, { body: body, append: opts.append === true, overwrite: opts.overwrite });
    },
    /** { ok, path, entries: [{ name, kind: "file" | "directory", size, mtime }] }. Needs read access. */
    list: function (dir) { return filesCall("list", dir); },
    /** { ok, path, name, kind, size, mtime }, or error "not_found". Needs read access. */
    stat: function (file) { return filesCall("stat", file); },
    /** Delete a file or an empty folder: { ok, path }. Needs write access. */
    remove: function (file) { return filesCall("delete", file, { body: new Blob([]) }); }
  };

  // ---------- ml ----------
  // Small typed questions about text of this page's own, answered by the classifier the user set up
  // in Settings. The page never learns which source answers. Needs the ml.decide permission: ask
  // for it up front with scribe.permissions.request("ml.decide"); decide() itself never prompts.
  var ML_ASK_MS = 35000;
  var ml = {
    /**
     * { ok, available, reason?: "denied" | "disabled" | "no_source", permission: "allow" | "deny" | "ask",
     * types: ["yesno", "choice", "score"], limits: { stateChars, questions, perMinute, perHour } }.
     */
    capabilities: function () {
      return askBoard({ type: "scribe-ml", op: "capabilities" }, 30000);
    },
    /**
     * Ask questions about state (text, or a small object or array): { ok, answers, cached, ms }, with
     * answers under the question ids: { type: "yesno", yes } | { type: "choice", choice,
     * probabilities, confidence } | { type: "score", score (0 is the first level), probabilities,
     * confidence }. Never rejects: a failure is { ok: false, error, message } and the page carries
     * on without an answer.
     * request: { state, questions: { id: { type: "yesno", instructions, criteria? } | { type:
     * "choice", instructions, options: { name: description | null } } | { type: "score",
     * instructions, levels } }, timeoutMs? }.
     */
    decide: function (request) {
      request = request || {};
      var message;
      try {
        message = JSON.parse(JSON.stringify({ state: request.state, questions: request.questions }));
      } catch (err) {
        return Promise.resolve({ ok: false, error: "invalid_request", message: "state and questions must be JSON" });
      }
      message.type = "scribe-ml";
      message.op = "decide";
      if (typeof request.timeoutMs === "number") message.timeoutMs = request.timeoutMs;
      return askBoard(message, ML_ASK_MS).then(function (result) {
        return result && typeof result.ok === "boolean" ? result : { ok: false, error: "unavailable", message: "No answer from Scribe" };
      });
    }
  };

  // ---------- audio ----------
  var audioSessions = {};
  window.addEventListener("message", function (event) {
    if (event.source !== parent || event.data?.type !== "scribe-audio-event") return;
    var data = event.data, session = audioSessions[data.sessionId];
    if (!session) return;
    if (data.level !== undefined && typeof session.onlevel === "function") { try { session.onlevel(data.level); } catch (_) {} }
    if (data.state && typeof session.onstate === "function") { try { session.onstate(data.state); } catch (_) {} }
    if (typeof data.text === "string" && typeof session.ontext === "function") { try { session.ontext(data.text); } catch (_) {} }
  });
  function audioResult(result) {
    if (result && result.ok && result.buffer) {
      result.blob = new Blob([result.buffer], { type: result.mimeType });
      delete result.buffer;
    }
    return result;
  }
  function startAudio(op, opts) {
    if (!hasGesture()) return Promise.resolve({ ok: false, error: "no_gesture" });
    opts = opts || {};
    return askBoard({ type: "scribe-audio", op: op, language: opts.language, prompt: opts.prompt, maxMs: opts.maxMs, live: opts.live }, 120000).then(function (result) {
      if (!result.ok) return result;
      var session = { ok: true, live: !!result.live, onlevel: null, onstate: null, ontext: null,
        stop: function () { return askBoard({ type: "scribe-audio", op: "stop", sessionId: result.sessionId }, 90000).then(audioResult); },
        cancel: function () { return askBoard({ type: "scribe-audio", op: "cancel", sessionId: result.sessionId }, 30000); }
      };
      audioSessions = {}; audioSessions[result.sessionId] = session;
      return session;
    });
  }
  async function streamAudio(opts) {
    if (!hasGesture()) return { ok: false, error: "no_gesture" };
    var result, context, port, node, destination, reason, callback, pending = [], pendingSamples = 0;
    var live = { ok: true, stream: null, sampleRate: 0,
      get onend() { return callback; },
      set onend(fn) {
        callback = fn;
        if (reason && typeof fn === "function") Promise.resolve().then(function () { if (callback === fn) { try { fn(reason); } catch (_) {} } });
      },
      stop: function () {
        if (reason) return Promise.resolve({ ok: true, reason: reason });
        return askBoard({ type: "scribe-audio", op: "stop", sessionId: result.sessionId }, 30000).then(function (reply) {
          end(reply.reason || "stopped"); return reply;
        });
      }
    };
    function end(why) {
      if (reason) return;
      reason = why;
      pending = []; pendingSamples = 0;
      if (port) { port.onmessage = null; port.close(); }
      if (node) { node.disconnect(); node.port.close(); }
      destination?.stream.getTracks().forEach(function (track) { track.stop(); });
      if (context) void context.close().catch(function () {});
      window.removeEventListener("pagehide", pageHidden);
      if (typeof callback === "function") { try { callback(reason); } catch (_) {} }
    }
    function pageHidden() { end("hidden"); }
    try {
      opts = opts || {};
      result = await askBoard({ type: "scribe-audio", op: "stream", maxMs: opts.maxMs }, 120000);
      if (!result.ok) return result;
      port = result.port;
      // The static module is served on the page's own origin; no blob: CSP exception or CORS is needed.
      context = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: result.sampleRate });
      destination = context.createMediaStreamDestination();
      live.stream = destination.stream; live.sampleRate = context.sampleRate;
      window.addEventListener("pagehide", pageHidden);
      port.onmessage = function (event) {
        if (event.data?.end) { end(event.data.end); return; }
        var frame = event.data?.frame;
        if (!(frame instanceof ArrayBuffer) || reason) return;
        if (node) node.port.postMessage({ frame: frame }, [frame]);
        else {
          pending.push(frame); pendingSamples += frame.byteLength / 4;
          while (pendingSamples > result.sampleRate * .2 && pending.length) pendingSamples -= pending.shift().byteLength / 4;
        }
      };
      await context.audioWorklet.addModule(new URL("/audio-stream-worklet.js", location.href).href);
      if (reason) return live;
      node = new AudioWorkletNode(context, "scribe-mic-playback", { numberOfInputs: 0, outputChannelCount: [1] });
      node.connect(destination);
      node.onprocessorerror = function () { void live.stop(); };
      pending.forEach(function (frame) { node.port.postMessage({ frame: frame }, [frame]); });
      pending = []; pendingSamples = 0;
      await context.resume();
      return live;
    } catch (_) {
      if (reason) return live;
      end("stopped");
      if (result?.ok) void askBoard({ type: "scribe-audio", op: "stop", sessionId: result.sessionId }, 30000);
      return { ok: false, error: "unavailable" };
    }
  }
  var audio = {
    listen: function (opts) { return startAudio("listen", opts); },
    record: function (opts) { return startAudio("record", opts); },
    stream: function (opts) { return streamAudio(opts); },
    transcribe: function (blob, opts) {
      if (!(blob instanceof Blob) || !blob.type.startsWith("audio/")) return Promise.resolve({ ok: false, error: "invalid_audio" });
      if (blob.size > 25 * 1024 * 1024) return Promise.resolve({ ok: false, error: "too_large" });
      opts = opts || {};
      return blob.arrayBuffer().then(function (buffer) {
        return askBoard({ type: "scribe-audio", op: "transcribe", buffer: buffer, mimeType: blob.type, language: opts.language, prompt: opts.prompt }, 120000);
      }).catch(function () { return { ok: false, error: "invalid_audio" }; });
    },
    available: function () { return askBoard({ type: "scribe-audio", op: "available" }, 30000); }
  };

  // ---------- page plugins ----------
  var pluginListeners = [];
  function pluginShellOrigin(origin) { return origin === boardOrigin || origin === location.protocol + "//localhost" + (location.port ? ":" + location.port : ""); }
  function plugin(id) {
    id = String(id);
    function request(suffix, body, retried) {
      if (capturing) return Promise.resolve({ ok: false, error: "capture" });
      return fetch("/api/tabs/" + encodeURIComponent(tabId) + "/plugins/" + encodeURIComponent(id) + suffix, body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      }).then(function (res) { return res.json(); }).then(function (result) {
        if (!retried && result.error === "permission" && window.parent !== window) {
          return askBoard({ type: "scribe-plugin", op: "allow", plugin: id }, AGENT_ASK_MS).then(function (permission) {
            return permission.ok ? request(suffix, body, true) : permission;
          });
        }
        return result;
      }).catch(function (error) { return { ok: false, error: String(error.message || error) }; });
    }
    function on(name, listener) {
      if (typeof listener !== "function") return function () {};
      var entry = { plugin: id, name: String(name), listener: listener };
      pluginListeners.push(entry);
      askBoard({ type: "scribe-plugin", op: "subscribe", plugin: id }, AGENT_ASK_MS);
      return function () { pluginListeners = pluginListeners.filter(function (item) { return item !== entry; }); };
    }
    return {
      call: function (method, args) { return request("/call", { method: String(method), args: args || {} }); },
      on: on,
      state: {
        get: function (key) { return request("/state/" + encodeURIComponent(String(key))); },
        on: function (key, listener) {
          function refresh() { request("/state/" + encodeURIComponent(String(key))).then(function (result) { if (result.ok) listener(result.value, result.revision); }); }
          var stopState=on("state",function(event){if(event.key===String(key))refresh();}),stopChanged=on("changed",refresh);
          return function(){stopState();stopChanged();};
        }
      },
      requestRepository: function (repo) {
        if (!hasGesture()) return Promise.resolve({ ok: false, error: "no_gesture" });
        return askBoard({ type: "scribe-plugin", op: "repository", plugin: id, repository: String(repo) }, AGENT_ASK_MS);
      }
    };
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || !pluginShellOrigin(event.origin) || event.data?.type !== "scribe-plugin-event") return;
    var message = event.data;
    pluginListeners.filter(function (entry) { return entry.plugin === message.plugin && entry.name === message.name; }).forEach(function (entry) {
      try { entry.listener(message.data); } catch (error) { console.error("[scribe] plugin listener failed", error); }
    });
  });

  function pluginAvailability() {
    if (capturing || !tabId) return;
    fetch("/api/tabs/" + encodeURIComponent(tabId) + "/plugins").then(function (response) { return response.json(); }).then(function (result) {
      var unavailable = (result.plugins || []).filter(function (item) { return !item.enabled; });
      var notice = document.getElementById("scribe-plugin-notice");
      if (!unavailable.length) { if (notice) notice.remove(); return; }
      if (!notice) {
        notice = document.createElement("div"); notice.id = "scribe-plugin-notice"; notice.setAttribute("role", "status");
        notice.style.cssText = "padding:8px 14px;background:var(--code-bg,#202024);color:var(--text,#ddd);border-bottom:1px solid var(--border,#444);font:13px system-ui";
        document.body.prepend(notice);
      }
      notice.textContent = unavailable.map(function (item) { return item.id + (item.installed ? " is off" : " is missing"); }).join(" · ");
    }).catch(function () {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded",pluginAvailability); else pluginAvailability();
  window.addEventListener("message", function(event) { if(event.source===window.parent && pluginShellOrigin(event.origin) && event.data?.type==="scribe-plugin-availability") pluginAvailability(); });

  // ---------- reply ----------
  /**
   * Send this form's answers where the agent that made the page pointed it (page_show replyTo), e.g.
   * a comment on a Kanban card that goes on to the card's chat. Needs a click; the page cannot pick
   * the target. Saves pending state first. Resolves { ok, target: { id, key, title }, delivered }
   * (delivered: "steered" | "queued" | "started" | null), or { ok: false, error }.
   */
  function reply(data, opts) {
    if (!hasGesture()) {
      console.warn("[scribe] scribe.reply needs a click or key press; ignored");
      return Promise.resolve({ ok: false, error: "no_gesture" });
    }
    if (data !== undefined && (typeof data !== "object" || data === null || Array.isArray(data))) {
      return Promise.resolve({ ok: false, error: "data must be an object" });
    }
    flushAll();
    var summary = opts && typeof opts.summary === "string" ? opts.summary : "";
    var payload;
    try {
      payload = data === undefined ? {} : JSON.parse(JSON.stringify(data));
    } catch (err) {
      return Promise.resolve({ ok: false, error: "data must be JSON" });
    }
    return askBoard({ type: "scribe-reply", data: payload, summary: summary }, AGENT_ASK_MS);
  }

  // ---------- shared browser view ----------
  var browserWatches = {};
  var browserWatchSeq = 0;
  window.addEventListener("pagehide", function () {
    Object.keys(browserWatches).forEach(function (watchId) {
      parent.postMessage({ type: "scribe-browser", op: "stop", id: tabId, watchId: watchId }, "*");
    });
    browserWatches = {};
  });
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== parent || !data || data.type !== "scribe-browser-event" || data.id !== tabId) return;
    var callback = browserWatches[data.watchId];
    if (callback) callback(data.event);
  });
  function browserCall(op, options) {
    return askBoard({ type: "scribe-browser", op: op, options: options }, 60000);
  }
  var browserApi = {
    info: function () { return browserCall("info"); },
    watch: function (onEvent) {
      var watchId = client + ":browser:" + (++browserWatchSeq);
      browserWatches[watchId] = onEvent;
      askBoard({ type: "scribe-browser", op: "watch", watchId: watchId }, 10000);
      return function () {
        delete browserWatches[watchId];
        askBoard({ type: "scribe-browser", op: "stop", watchId: watchId }, 10000);
      };
    },
    input: function (input) { return browserCall("input", input); },
    navigate: function (options) { return browserCall("navigate", options); },
    tabs: function (options) { return browserCall("tabs", options); },
    control: function (action) { return browserCall("control", { action: action }); },
    fit: function (size) { return browserCall("fit", size || { fit: false }); },
    close: function () { return browserCall("close", {}); }
  };

  // ---------- file pages ----------
  /**
   * A file page's file (#654). The board reads and writes the file on this page's tab; the page
   * cannot name another. read() resolves { ok, file } (text kinds carry text, eol, bom), image()
   * { ok, buffer, type }, and asset(src) the same for an image the file links to (#658: a path
   * relative to the file, an absolute path, or a file: URL). save(text, { mtime, eol, bom, force }) and saveAs(text, { eol, bom }) need a
   * click or key press; save resolves { ok: false, conflict: true, mtime } when the file changed
   * on disk, saveAs { ok: false, error: "cancelled" } when the user closes the dialog.
   * view() resolves { ok, view } with what view(value) last kept for this file (a PDF's zoom), so it
   * outlives the tab (#685).
   */
  var fileApi = {
    openLocation: function () {
      if (!hasGesture()) return Promise.resolve({ ok: false, error: "no_gesture" });
      return askBoard({ type: "scribe-file", op: "openLocation" }, 10000);
    },
    read: function () { return askBoard({ type: "scribe-file", op: "read" }, 60000); },
    image: function () { return askBoard({ type: "scribe-file", op: "image" }, 120000); },
    asset: function (src) { return askBoard({ type: "scribe-file", op: "asset", src: String(src) }, 60000); },
    view: function (value) {
      return askBoard(value === undefined ? { type: "scribe-file", op: "view" } : { type: "scribe-file", op: "view", view: value }, 10000);
    },
    save: function (text, opts) {
      if (!hasGesture()) return Promise.resolve({ ok: false, error: "no_gesture" });
      opts = opts || {};
      return askBoard({ type: "scribe-file", op: "save", text: String(text), mtime: opts.mtime, eol: opts.eol, bom: opts.bom === true, force: opts.force === true }, 60000);
    },
    saveAs: function (text, opts) {
      if (!hasGesture()) return Promise.resolve({ ok: false, error: "no_gesture" });
      opts = opts || {};
      return askBoard({ type: "scribe-file", op: "saveAs", text: String(text), eol: opts.eol, bom: opts.bom === true }, 30 * 60 * 1000);
    }
  };

  /**
   * Opening code in the user's IDE (IntelliJ for now), for a file in the page's workspace: a path
   * relative to it, or absolute inside it. check(file) resolves { ok, project }: project is true when
   * the file is in an IntelliJ project and the integration is on. open(file, { line }) needs a click.
   */
  var ideApi = {
    check: function (file) { return askBoard({ type: "scribe-ide", op: "check", file: String(file || "") }, 15000); },
    open: function (file, opts) {
      if (!hasGesture()) return Promise.resolve({ ok: false, error: "no_gesture" });
      opts = opts || {};
      return askBoard({ type: "scribe-ide", op: "open", file: String(file || ""), line: Number(opts.line) || 1 }, 30000);
    }
  };

  window.scribe = {
    id: tabId,
    template: template,
    get title() {
      return title;
    },
    setTitle: setTitle,
    onTitle: onTitle,
    saveAsset: saveAsset,
    deleteAsset: deleteAsset,
    listAssets: listAssets,
    assetUrl: assetUrl,
    get state() {
      return current;
    },
    get revision() {
      return revision;
    },
    get local() {
      return local;
    },
    update: update,
    set: set,
    setLocal: setLocal,
    bind: bind,
    flush: flushAll,
    signal: signal,
    action: action,
    reply: reply,
    file: fileApi,
    ide: ideApi,
    browser: browserApi,
    open: open,
    resolve: resolve,
    preview: preview,
    agent: agent,
    ml: ml,
    audio: audio,
    plugin: plugin,
    permissions: permissions,
    files: files,
    /** The ops engine, for pages that build ops: get(state, path), diff(before, after, keys), apply(state, ops). */
    ops: {
      get: engine.getAt,
      diff: engine.diff,
      apply: function (state, ops) {
        return engine.apply(state, ops).state;
      }
    },
    reportIncompatible: reportIncompatible,
    onOpen: onOpen,
    /**
     * fn(state, { source, ops }) when the state changes. Remote and resync changes by default;
     * { local: true } also hears this page's own writes, batched once the writing code finishes.
     */
    onChange: function (fn, opts) {
      var entry = { fn: fn, local: Boolean(opts && opts.local) };
      listeners.push(entry);
      return function () {
        listeners = listeners.filter(function (item) {
          return item !== entry;
        });
      };
    }
  };
  ${PAGE_COMPONENTS_JS}
  mountPageComponents({ base: "/api/tabs/" + encodeURIComponent(tabId) + "/components", capturing: capturing,
    allow: function (id) { return askBoard({ type: "scribe-plugin", op: "allow", plugin: id }, AGENT_ASK_MS); },
    open: open, reply: reply, signal: signal,
    local: function (id, value) {
      var key = "component:" + id;
      if (value === undefined) return local[key] || {};
      var patch = {}; patch[key] = value; return setLocal(patch);
    } });
})();
`.trim();

export const BOARD_STALE_CSS = `
.scribe-stale { outline: 1px dashed rgba(224, 179, 74, 0.7); outline-offset: 2px; }
[data-scribe-open] { cursor: pointer; }
.scribe-link-missing { text-decoration: line-through !important; opacity: 0.6; cursor: not-allowed !important; }
`.trim();
