/**
 * Protected spans (#1046): text that matches a protected value is wrapped in a blurred span that a
 * click reveals, so the screen can be shared. Runs in the board window (protected.js) and in built-in
 * pages (the bridge's scribe.protect), each with the values it may know: all of them for the board, a
 * page's own for a page. Text in fields, editors and [data-scribe-protect-skip] is left alone.
 */
(function () {
  if (window.scribeProtectedMark) return;
  var CLASS = "scribe-protected";
  var SKIP = "script, style, textarea, input, select, noscript, svg, [contenteditable]:not([contenteditable='false']), .cm-editor, [data-scribe-protect-skip], ." + CLASS;
  var revealed = new Set();

  function escape(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** A matcher for these fragments ({ id, value, hint }): the longest value wins where several start together. */
  function compile(fragments) {
    var list = (fragments || []).filter(function (f) { return f && typeof f.value === "string" && f.value; });
    if (!list.length) return null;
    var byValue = new Map();
    list.forEach(function (f) { byValue.set(f.value, f); });
    var values = Array.from(byValue.keys()).sort(function (a, b) { return b.length - a.length; });
    return { re: new RegExp(values.map(escape).join("|"), "g"), byValue: byValue };
  }

  function styleOnce(doc) {
    if (doc.getElementById("scribe-protected-style")) return;
    var style = doc.createElement("style");
    style.id = "scribe-protected-style";
    style.textContent =
      "." + CLASS + "{filter:blur(5px);cursor:pointer;border-radius:3px;transition:filter .15s ease;user-select:text}" +
      "." + CLASS + ".revealed{filter:none;cursor:auto;background:color-mix(in srgb,currentColor 9%,transparent);box-shadow:0 1px 0 color-mix(in srgb,currentColor 35%,transparent)}" +
      "@media (prefers-reduced-motion:reduce){." + CLASS + "{transition:none}}";
    (doc.head || doc.documentElement).appendChild(style);
  }

  function skipped(node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    return !el || Boolean(el.closest(SKIP));
  }

  /** Wrap every match under root (an element or a text node). Returns how many spans it made. */
  function mark(root, matcher) {
    if (!matcher || !root) return 0;
    var doc = root.ownerDocument || document;
    var texts = [];
    if (root.nodeType === 3) {
      if (!skipped(root)) texts.push(root);
    } else if (root.nodeType === 1 || root.nodeType === 11) {
      if (root.nodeType === 1 && skipped(root)) return 0;
      var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          return node.data.length && !skipped(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      for (var n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n);
    }
    var made = 0;
    texts.forEach(function (node) {
      var text = node.data;
      matcher.re.lastIndex = 0;
      if (!matcher.re.test(text)) return;
      matcher.re.lastIndex = 0;
      var out = doc.createDocumentFragment();
      var at = 0;
      var match;
      while ((match = matcher.re.exec(text))) {
        var fragment = matcher.byValue.get(match[0]);
        if (match.index > at) out.appendChild(doc.createTextNode(text.slice(at, match.index)));
        var span = doc.createElement("span");
        span.className = CLASS + (revealed.has(fragment.id) ? " revealed" : "");
        span.dataset.scribeProtected = fragment.id;
        span.setAttribute("aria-label", "Protected: " + fragment.hint);
        span.textContent = match[0];
        out.appendChild(span);
        made += 1;
        at = match.index + match[0].length;
      }
      if (at < text.length) out.appendChild(doc.createTextNode(text.slice(at)));
      if (node.parentNode) node.parentNode.replaceChild(out, node);
    });
    return made;
  }

  /** Put the spans back as plain text (the values changed, or none are left). */
  function unmark(root) {
    var spans = root.querySelectorAll ? root.querySelectorAll("." + CLASS) : [];
    Array.prototype.forEach.call(spans, function (span) {
      var parent = span.parentNode;
      if (!parent) return;
      parent.replaceChild((span.ownerDocument || document).createTextNode(span.textContent), span);
      parent.normalize();
    });
  }

  /**
   * Keep root marked as it changes: what was added or edited is marked on the next frame. matcher()
   * gives the current matcher (null: nothing to mark). Returns { refresh, stop }.
   */
  function watch(root, matcher) {
    var doc = root.ownerDocument || document;
    styleOnce(doc);
    var queued = new Set();
    var frame = 0;
    function flush() {
      frame = 0;
      var m = matcher();
      var nodes = Array.from(queued);
      queued.clear();
      if (!m) return;
      nodes.forEach(function (node) {
        if (node.isConnected) mark(node, m);
      });
    }
    function queue(node) {
      queued.add(node);
      if (!frame) frame = (doc.defaultView || window).requestAnimationFrame(flush);
    }
    var observer = new MutationObserver(function (records) {
      if (!matcher()) return;
      records.forEach(function (record) {
        if (record.type === "characterData") queue(record.target);
        else record.addedNodes.forEach(function (node) {
          if (!(node.nodeType === 1 && node.classList.contains(CLASS))) queue(node);
        });
      });
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    function refresh() {
      unmark(root);
      var m = matcher();
      if (m) mark(root, m);
    }
    refresh();
    return { refresh: refresh, stop: function () { observer.disconnect(); } };
  }

  // A click on a blurred span shows it; the span stays shown (and its copies do) until the page reloads.
  document.addEventListener("click", function (event) {
    var span = event.target && event.target.closest ? event.target.closest("." + CLASS) : null;
    if (!span || span.classList.contains("revealed")) return;
    event.preventDefault();
    event.stopPropagation();
    var id = span.dataset.scribeProtected;
    revealed.add(id);
    Array.prototype.forEach.call(document.querySelectorAll("." + CLASS + "[data-scribe-protected='" + id + "']"), function (other) {
      other.classList.add("revealed");
    });
  }, true);

  /** Blur a revealed fragment again everywhere in this document. */
  function hide(id) {
    revealed.delete(id);
    Array.prototype.forEach.call(document.querySelectorAll("." + CLASS + "[data-scribe-protected='" + id + "']"), function (span) {
      span.classList.remove("revealed");
    });
  }

  window.scribeProtectedMark = { compile: compile, mark: mark, unmark: unmark, watch: watch, hide: hide, CLASS: CLASS };
})();
