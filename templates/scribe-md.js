/*
 * Scribe's shared markdown renderer (#770), served as /vendor/scribe-md.js for the markdown note, the kanban
 * board, the file page and the agent chat. Pages load it by URL after /vendor/marked.js and /vendor/purify.js,
 * so a fix here reaches pages that keep their saved HTML.
 *
 * On top of marked (GFM) and DOMPurify it adds Scribe's syntax and controls:
 * - page links: [[scribe:key]] (the page's title), [[target|label]], [[peek:target]] / [[split:target]],
 *   [label](scribe:key) / (peek:…) / (split:…) / (file:…), and a key or page id written on its own;
 *   [[thread:th_…]] for a chat, and scribe:@laptop/key / thread:@laptop/th_… on another device (#908);
 * - #12 card links and #img- images, resolved by the caller (opts.card, opts.image);
 * - task list checkboxes that know their source line (data-line), and toggleTask to tick one in the text:
 *   ticking an item ticks its sub-items, and a parent is ticked once all of its sub-items are;
 * - a Copy button on code blocks (copyCode), highlighted when the page loaded /vendor/highlight.js;
 * - selectingText, so a click that ends a text selection does not start editing.
 *
 * ScribeMd.render(src, opts) returns HTML; ScribeMd.blocks(src, opts) returns one element per top-level block
 * with its { start, end } offsets in src. ScribeMd.lex(src, opts) is for a caller that draws the blocks itself
 * (the chat, while text streams in). opts:
 *   tasks     checkboxes can be ticked (default false: disabled)
 *   breaks    a single newline is a line break (default true, like Scribe's notes and cards)
 *   html      raw HTML in the text is rendered, sanitized (default false: shown as text)
 *   image     function (url) -> src to show, or "" to leave the image out
 *   card      function (num) -> { id } of card #num, or null to leave the text alone
 */
(function () {
  "use strict";

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function defaultImage(url) {
    url = String(url || "").trim();
    if (/^https?:\/\//i.test(url) || /^\/blob\/pa_[0-9a-f]{24}$/.test(url)) return url;
    if (/^data:image\/(png|jpeg|jpg|gif|webp);/i.test(url)) return url;
    return "";
  }

  // ---------- page links ----------
  var LINK_MODES = { tab: "tab", peek: "peek", split: "split" };
  var WIKI_LINK = /^\[\[\s*(?:(tab|peek|split):)?([^\]|\n]+?)\s*(?:\|([^\]\n]*))?\]\]/;
  // scribe:@laptop/key is a page on another device (#908).
  var BARE_KEY = /^(?:scribe:(?:@[\w.-]+\/)?[a-z0-9._-]*[a-z0-9_-]|t_[0-9a-f]{8})(?:#[\w=&%.:-]*\w)?(?![\w-])/;
  var BARE_KEY_AT = /(^|[^\w\/#:-])(?:scribe:(?:@[\w.-]+\/)?[a-z0-9._-]*[a-z0-9_-]|t_[0-9a-f]{8})(?![\w-])/;
  var CARD_AT = /(^|[\s(])#\d/;

  function pageLinkHtml(target, labelHtml, mode) {
    return '<a href="#" class="page-link" data-scribe-open="' + escapeHtml(target) + '"' +
      (mode ? ' data-scribe-mode="' + mode + '"' : "") + ">" + labelHtml + "</a>";
  }

  /** The options of the render in progress: the extensions below read them. */
  var ctx = {};

  function createMarked() {
    var md = new window.marked.Marked({ gfm: true });
    md.use({
      extensions: [
        {
          name: "scribePageLink",
          level: "inline",
          start: function (src) {
            var i = src.indexOf("[[");
            return i < 0 ? undefined : i;
          },
          tokenizer: function (src) {
            var m = WIKI_LINK.exec(src);
            if (!m || this.lexer.state.inLink) return undefined;
            return { type: "scribePageLink", raw: m[0], target: m[2], label: String(m[3] || "").trim(), mode: m[1] ? LINK_MODES[m[1]] : "" };
          },
          renderer: function (token) {
            return pageLinkHtml(token.target, escapeHtml(token.label), token.mode);
          },
        },
        {
          name: "scribeBareKey",
          level: "inline",
          start: function (src) {
            var m = BARE_KEY_AT.exec(src);
            return m ? m.index + m[1].length : undefined;
          },
          tokenizer: function (src) {
            var m = BARE_KEY.exec(src);
            if (!m || this.lexer.state.inLink) return undefined;
            return { type: "scribeBareKey", raw: m[0], target: m[0] };
          },
          renderer: function (token) {
            return pageLinkHtml(token.target, "", "");
          },
        },
        {
          name: "scribeCardLink",
          level: "inline",
          start: function (src) {
            if (!ctx.card) return undefined;
            var m = CARD_AT.exec(src);
            return m ? m.index + m[1].length : undefined;
          },
          tokenizer: function (src) {
            if (!ctx.card || this.lexer.state.inLink) return undefined;
            var m = /^#(\d+)\b/.exec(src);
            var target = m && ctx.card(Number(m[1]));
            if (!target) return undefined;
            return { type: "scribeCardLink", raw: m[0], id: target.id, num: m[1] };
          },
          renderer: function (token) {
            return '<a href="#" data-card="' + escapeHtml(token.id) + '">#' + token.num + "</a>";
          },
        },
      ],
      renderer: {
        link: function (token) {
          var href = String(token.href || "").trim();
          var label = this.parser.parseInline(token.tokens);
          var mode = /^(tab|peek|split):(.+)$/.exec(href);
          if (mode) return pageLinkHtml(mode[2], label, LINK_MODES[mode[1]]);
          // board:key is the old form of scribe:key, still in older chat transcripts.
          if (/^board:/i.test(href)) return pageLinkHtml(href.slice(6), label, "");
          if (/^(?:scribe|file|thread):/i.test(href)) return pageLinkHtml(href, label, "");
          if (/^(?:https?:|mailto:)/i.test(href)) {
            return '<a href="' + escapeHtml(href) + '"' + (token.title ? ' title="' + escapeHtml(token.title) + '"' : "") +
              ' target="_blank" rel="noopener">' + label + "</a>";
          }
          return label;
        },
        image: function (token) {
          var src = ctx.image ? ctx.image(token.href) : defaultImage(token.href);
          if (!src) return "";
          return '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(token.text || "") + '"' +
            (token.title ? ' title="' + escapeHtml(token.title) + '"' : "") + ">";
        },
        // Only ~~two~~ strikes through: one tilde is a path (~/.config) far more often than a strike.
        del: function (token) {
          if (/^~~/.test(token.raw)) return false;
          return "~" + this.parser.parseInline(token.tokens) + "~";
        },
        html: function (token) {
          return ctx.html ? token.text : escapeHtml(token.text);
        },
      },
    });
    return md;
  }

  var instance = null;
  function md() {
    if (!instance && window.marked && window.marked.Marked) instance = createMarked();
    return instance;
  }

  var PURIFY = {
    FORBID_TAGS: ["style", "form", "button", "textarea", "select", "option", "iframe", "object", "embed", "dialog"],
    FORBID_ATTR: ["style", "action", "formaction"],
    ADD_ATTR: ["target"],
    RETURN_DOM_FRAGMENT: true,
  };

  // ---------- task lists ----------
  var LIST_ITEM = /^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/;
  // As marked reads them: "[ ]" then text on the same line.
  var TASK_ITEM = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[([ xX])\](?=[ \t]+\S)/;
  function indentOf(line) {
    var w = 0;
    for (var k = 0; k < line.length && (line[k] === " " || line[k] === "\t"); k++) w += line[k] === "\t" ? 4 : 1;
    return w;
  }

  /** The text with the checkbox on `line` flipped, its sub-items with it and its parents updated; null if no checkbox is there. */
  function toggleTask(src, line) {
    var lines = String(src == null ? "" : src).split("\n");
    var m = TASK_ITEM.exec(lines[line] || "");
    if (!m) return null;
    function set(k, on) {
      lines[k] = lines[k].replace(TASK_ITEM, function (_, lead) { return lead + (on ? "[x]" : "[ ]"); });
    }
    function subTasks(k) {
      var out = [], base = indentOf(lines[k]);
      for (var j = k + 1; j < lines.length && (!lines[j].trim() || indentOf(lines[j]) > base); j++) if (TASK_ITEM.test(lines[j])) out.push(j);
      return out;
    }
    var on = m[2] === " ";
    set(line, on);
    subTasks(line).forEach(function (k) { set(k, on); });
    for (var k = line - 1, indent = indentOf(lines[line]); k >= 0 && indent > 0; k--) {
      if (!lines[k].trim()) continue;
      var w = indentOf(lines[k]);
      if (w >= indent) continue;
      if (!LIST_ITEM.test(lines[k])) {
        if (w === 0) break;
        continue;
      }
      indent = w;
      var subs = subTasks(k);
      if (TASK_ITEM.test(lines[k]) && subs.length) set(k, subs.every(function (j) { return TASK_ITEM.exec(lines[j])[2] !== " "; }));
    }
    return lines.join("\n");
  }

  // ---------- code blocks ----------
  function highlight(code) {
    var hljs = window.hljs;
    if (!hljs) return;
    var lang = (/language-([\w+-]+)/.exec(code.className) || [])[1];
    try {
      code.innerHTML = lang && hljs.getLanguage(lang)
        ? hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(code.textContent).value;
    } catch (err) { /* plain */ }
  }

  function copyCode(button) {
    var code = button.parentNode.querySelector("code");
    if (!code || !navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(code.textContent.replace(/\n$/, "")).then(function () {
      button.textContent = "Copied";
      setTimeout(function () { button.textContent = "Copy"; }, 1200);
    }, function () { button.textContent = "Not copied"; });
  }

  /** A click that ends a drag-selection of text in root: it should leave the text selected, not start editing. */
  function selectingText(root) {
    var sel = window.getSelection && window.getSelection();
    return !!(sel && !sel.isCollapsed && root.contains(sel.anchorNode));
  }

  // ---------- rendering ----------
  /** A block's checkboxes; taskLines are the source lines of its "- [ ]" items. */
  function taskBoxes(box, taskLines, opts) {
    var boxes = [];
    box.querySelectorAll("input").forEach(function (input) {
      if (input.type !== "checkbox") return input.remove();
      boxes.push(input);
    });
    // marked's checkboxes come in the order of their lines; a mismatch (a "- [ ]" in a quote) leaves them read-only.
    var mapped = boxes.length === taskLines.length;
    boxes.forEach(function (input, i) {
      input.className = "task-box";
      input.removeAttribute("disabled");
      if (mapped) input.setAttribute("data-line", String(taskLines[i]));
      if (!opts.tasks || !mapped) input.disabled = true;
      var li = input.closest("li");
      if (li) li.classList.add("task");
    });
  }

  /** Checkboxes, code blocks and tables in one sanitized block. */
  function enhance(box, taskLines, opts) {
    taskBoxes(box, taskLines, opts);
    box.querySelectorAll("pre").forEach(function (pre) {
      var code = pre.querySelector("code");
      if (code && opts.highlight !== false) highlight(code);
      var wrap = document.createElement("div");
      wrap.className = "code-block";
      var copy = document.createElement("button");
      copy.type = "button";
      copy.className = "code-copy";
      copy.textContent = "Copy";
      pre.replaceWith(wrap);
      wrap.append(copy, pre);
    });
    box.querySelectorAll("table").forEach(function (table) {
      var wrap = document.createElement("div");
      wrap.className = "table-wrap";
      table.replaceWith(wrap);
      wrap.append(table);
    });
  }

  function lineAt(src, offset) {
    var n = 0;
    for (var i = src.indexOf("\n"); i !== -1 && i < offset; i = src.indexOf("\n", i + 1)) n++;
    return n;
  }

  /**
   * Notes and cards are written line by line: a plain line right under a list item or a quote starts new text,
   * and "---" under a line is a rule, not a heading underline. Markdown would fold such a line into the item
   * or quote above, so a blank line goes before it. `at` lists where each added "\n" is in the new text.
   */
  function endLazyBlocks(src) {
    var lines = src.split("\n"), out = [], at = [], pos = 0, prev = "", fence = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      var kind = !line.trim() ? "" : /^ {0,3}>/.test(line) ? "quote" : LIST_ITEM.test(line) ? "list" : indentOf(line) > 0 && prev === "list" ? "list" : "text";
      if (!fence && prev && line.trim() && indentOf(line) === 0 && !LIST_ITEM.test(line) &&
          ((prev === "list" && kind === "text") || (prev === "quote" && kind !== "quote") || /^-{3,}\s*$/.test(line))) {
        at.push(pos);
        out.push("");
        pos += 1;
      }
      out.push(line);
      pos += line.length + 1;
      prev = fence ? "text" : kind;
    }
    return { text: out.join("\n"), at: at };
  }

  /** One element per top-level block: { el, start, end }, end without the block's trailing newlines. */
  function blocks(src, opts) {
    opts = opts || {};
    var text = String(src == null ? "" : src).replace(/\r\n?/g, "\n");
    var breaks = opts.breaks !== false;
    var lazy = breaks ? endLazyBlocks(text) : { text: text, at: [] };
    src = lazy.text;
    /** An offset in src as one in the caller's text. */
    function original(offset) {
      var n = 0;
      while (n < lazy.at.length && lazy.at[n] < offset) n++;
      return offset - n;
    }
    var m = md();
    if (!m || !window.DOMPurify) {
      var plain = document.createElement("div");
      plain.style.whiteSpace = "pre-wrap";
      plain.textContent = text;
      return text.trim() ? [{ el: plain, start: 0, end: text.length }] : [];
    }
    // Options given to lexer/parser replace the instance's, extensions included.
    var options = Object.assign({}, m.defaults, { breaks: breaks });
    ctx = { image: opts.image, card: opts.card, html: !!opts.html };
    try {
      var tokens = m.lexer(src, options);
      var out = [];
      var pos = 0;
      tokens.forEach(function (tok) {
        var at = src.indexOf(tok.raw, pos);
        if (at === -1) at = pos;
        pos = at + tok.raw.length;
        if (tok.type === "space") return;
        var one = [tok];
        one.links = tokens.links;
        var html;
        try { html = m.parser(one, options); } catch (err) { html = "<p>" + escapeHtml(tok.raw) + "</p>"; }
        var el = document.createElement("div");
        el.append(window.DOMPurify.sanitize(html, PURIFY));
        var raw = tok.raw.replace(/\n+$/, "");
        var start = original(at), end = original(at + raw.length);
        var taskLines = [];
        if (tok.type === "list") {
          var first = lineAt(text, start);
          raw.split("\n").forEach(function (line, k) { if (TASK_ITEM.test(line)) taskLines.push(first + k); });
        }
        enhance(el, taskLines, opts);
        out.push({ el: el, start: start, end: end });
      });
      return out;
    } finally {
      ctx = {};
    }
  }

  /**
   * The top-level blocks of src as [{ raw, render }], for a caller that draws them itself: render() gives the
   * block as a sanitized fragment with read-only checkboxes, but no code block or table controls. Space between
   * blocks is a block too (it renders empty). Reference link definitions apply across blocks. Standard markdown
   * unless opts.breaks; null when marked or DOMPurify did not load.
   */
  function lex(src, opts) {
    opts = opts || {};
    var m = md();
    if (!m || !window.DOMPurify) return null;
    var options = Object.assign({}, m.defaults, { breaks: !!opts.breaks });
    var mine = { image: opts.image, card: opts.card, html: !!opts.html };
    function within(fn) {
      ctx = mine;
      try { return fn(); } finally { ctx = {}; }
    }
    var tokens = within(function () { return m.lexer(String(src == null ? "" : src).replace(/\r\n?/g, "\n"), options); });
    return tokens.map(function (tok) {
      return {
        raw: tok.raw,
        render: function () {
          var one = [tok];
          one.links = tokens.links;
          var html;
          try { html = within(function () { return m.parser(one, options); }); } catch (err) { html = "<p>" + escapeHtml(tok.raw) + "</p>"; }
          var box = document.createElement("div");
          box.append(window.DOMPurify.sanitize(html, PURIFY));
          taskBoxes(box, [], {});
          var frag = document.createDocumentFragment();
          frag.append.apply(frag, Array.prototype.slice.call(box.childNodes));
          return frag;
        },
      };
    });
  }

  /** The text as sanitized HTML. */
  function render(src, opts) {
    return blocks(src, opts).map(function (b) { return b.el.innerHTML; }).join("");
  }

  window.ScribeMd = {
    render: render,
    blocks: blocks,
    lex: lex,
    toggleTask: toggleTask,
    copyCode: copyCode,
    selectingText: selectingText,
    escapeHtml: escapeHtml,
  };
})();
