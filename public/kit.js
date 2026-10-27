/*
 * Page kit: renders the kit elements (<s-question>, <s-option>, <s-mock>, <s-code>) and wires
 * <form data-reply> and <button data-reply> without page scripts.
 * Add public hooks (including new bindings) to kit.catalog.json; run npm run gen:kit-docs.
 * Buttons send their summary and optional JSON context through the host's scribe.reply.
 * For forms,
 * typing is kept as this viewer's draft (scribe.local), and submit sends the named fields with
 * scribe.reply (the page's replyTo), or as a "submitted" signal on a page without one.
 */
(function () {
  "use strict";

  // ---------- elements (#860) ----------
  // Each renders its parts once, in the light DOM, so a page's CSS restyles them and the inputs
  // they make belong to the surrounding form. They are defined before the form wiring below
  // runs, so drafts restore into the inputs they create.
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function moveChildren(from, to) {
    while (from.firstChild) to.appendChild(from.firstChild);
    return to;
  }
  function define(name, render) {
    if (!window.customElements || customElements.get(name)) return;
    customElements.define(name, class extends HTMLElement {
      connectedCallback() {
        if (this.kitRendered) return;
        this.kitRendered = true;
        render(this);
      }
    });
  }
  function radio(type, name, value, checked) {
    var input = document.createElement("input");
    input.type = type;
    input.name = name;
    input.value = value;
    input.checked = checked;
    return input;
  }

  var questions = 0;
  define("s-question", function (q) {
    var name = q.getAttribute("name") || "question" + ++questions;
    var choices = Array.prototype.filter.call(q.children, function (c) { return c.localName === "s-choice"; });
    var type = q.getAttribute("type") || (choices.length ? "one" : "text");
    var required = q.hasAttribute("required");
    var label = q.getAttribute("label");
    var heading = label ? el(type === "text" || type === "line" ? "label" : "div", "kit-q-label", label) : null;
    if (heading) q.prepend(heading);
    if (type === "one" || type === "many") {
      choices.forEach(function (choice) {
        var input = radio(type === "many" ? "checkbox" : "radio", name, choice.getAttribute("value") || choice.textContent.trim(), choice.hasAttribute("checked"));
        input.required = required && type === "one";
        var option = el("label", "opt");
        option.append(input, moveChildren(choice, el("span")));
        choice.appendChild(option);
      });
    } else if (type === "scale") {
      var min = Number(q.getAttribute("min") || 1), max = Number(q.getAttribute("max") || 5);
      var scale = el("div", "scale");
      for (var i = min; i <= max && i - min < 20; i++) {
        var input = radio("radio", name, String(i), q.getAttribute("value") === String(i));
        input.required = required;
        var step = el("label");
        step.append(input, String(i));
        scale.append(step);
      }
      q.append(scale);
      var low = q.getAttribute("low"), high = q.getAttribute("high");
      if (low || high) {
        var ends = el("div", "scale-ends");
        ends.append(el("span", null, low || ""), el("span", null, high || ""));
        q.append(ends);
      }
    } else {
      var field = type === "line" ? el("input") : el("textarea");
      if (type === "line") field.type = "text";
      field.name = name;
      field.required = required;
      if (q.hasAttribute("placeholder")) field.placeholder = q.getAttribute("placeholder");
      if (q.hasAttribute("value")) field.value = q.getAttribute("value");
      if (heading) heading.htmlFor = field.id = "kit-" + name.replace(/[^\w-]/g, "_");
      q.append(field);
    }
  });

  define("s-option", function (option) {
    var group = option.closest("s-options");
    var name = group && group.getAttribute("name");
    var value = option.getAttribute("value") || option.getAttribute("label") || "";
    var label = option.getAttribute("label");
    var form = name && option.closest("form[data-reply]");
    var body = moveChildren(option, el("div", "kit-option-body"));
    var head = el(form ? "label" : "div", "kit-option-head");
    var input = null;
    if (form) {
      input = radio("radio", name, value, option.hasAttribute("checked"));
      head.append(input);
      option.classList.add("kit-pickable");
      // The whole card picks it, except for its own links and controls.
      option.addEventListener("click", function (event) {
        if (input.disabled || input.checked || event.target.closest("a, button, input, textarea, select, label, summary")) return;
        input.checked = true;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    if (label) head.append(el("h3", null, label));
    if (option.hasAttribute("recommended")) head.append(el("span", "kit-option-mark", "Recommended"));
    if (head.childNodes.length) option.append(head);
    option.append(body);
    if (name && !form) {
      // Outside a reply form, each option gets its own one-click reply.
      var context = {};
      context[name] = value;
      var choose = el("button", null, "Choose");
      choose.type = "button";
      choose.setAttribute("data-reply", "Picked " + (label || value));
      choose.setAttribute("data-context", JSON.stringify(context));
      var foot = el("div", "kit-option-foot");
      foot.append(choose);
      option.append(foot);
    }
  });

  define("s-mock", function (mock) {
    var body = moveChildren(mock, el("div", "mock-body"));
    mock.append(el("div", "mock-bar", mock.getAttribute("label") || ""), body);
  });

  define("s-mock-row", function (row) {
    var control = moveChildren(row, el("span", "kit-row-control"));
    var label = el("span", null, row.getAttribute("label") || "");
    if (row.hasAttribute("hint")) label.append(el("small", null, row.getAttribute("hint")));
    row.append(label, control);
  });

  /** Text without the blank first line and the indentation every line shares. */
  function dedent(text) {
    var lines = text.replace(/\r\n?/g, "\n").replace(/^[ \t]*\n/, "").replace(/\s+$/, "").split("\n");
    var indent = lines.reduce(function (min, line) {
      if (!line.trim()) return min;
      var n = line.match(/^[ \t]*/)[0].length;
      return Math.min(min, n);
    }, Infinity);
    return lines.map(function (line) { return line.slice(indent === Infinity ? 0 : indent); }).join("\n");
  }
  function copyText(text) {
    function fallback() {
      var area = el("textarea");
      area.value = text;
      area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.append(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (error) { ok = false; }
      area.remove();
      if (!ok) throw new Error("copy failed");
    }
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(fallback);
    return Promise.resolve().then(fallback);
  }
  var highlighter = null;
  function highlight(code, language, text) {
    // The app's highlight.js bundle; a saved or sandboxed copy without it stays plain.
    highlighter = highlighter || (window.hljs ? Promise.resolve(window.hljs) : new Promise(function (resolve) {
      var script = el("script");
      script.src = "/vendor/highlight.js";
      script.onload = function () { resolve(window.hljs || null); };
      script.onerror = function () { resolve(null); };
      document.head.append(script);
    }));
    highlighter.then(function (hljs) {
      if (!hljs || !hljs.getLanguage(language)) return;
      try { code.innerHTML = hljs.highlight(text, { language: language, ignoreIllegals: true }).value; } catch (error) { /* stays plain */ }
    });
  }

  define("s-code", function (block) {
    // <script type="text/plain"> keeps markup in the code from being parsed.
    var raw = block.querySelector(':scope > script[type="text/plain"]');
    var text = dedent(raw ? raw.textContent : block.textContent);
    var language = block.getAttribute("language") || "";
    var diff = block.hasAttribute("diff") || language === "diff";
    block.textContent = "";
    var head = el("div", "kit-code-head");
    var copy = el("button", null, "Copy");
    copy.type = "button";
    copy.addEventListener("click", function () {
      copyText(text).then(function () { copy.textContent = "Copied"; }, function () { copy.textContent = "Copy failed"; })
        .then(function () { setTimeout(function () { copy.textContent = "Copy"; }, 1500); });
    });
    head.append(el("span", null, block.getAttribute("file") || language || (diff ? "diff" : "")), copy);
    var code = el("code");
    var pre = el("pre");
    pre.append(code);
    block.append(head, pre);
    if (diff) {
      text.split("\n").forEach(function (line) {
        var tone = /^\+(?!\+\+)/.test(line) ? "kit-add" : /^-(?!--)/.test(line) ? "kit-del" : /^@@/.test(line) ? "kit-hunk" : "";
        code.append(tone ? el("span", tone, line || " ") : document.createTextNode(line + "\n"));
      });
    } else {
      code.textContent = text;
      if (language) highlight(code, language, text);
    }
  });

  // ---------- reply wiring ----------
  var scribe = window.scribe;
  if (!scribe) return;

  var DRAFTS = "kitForms";
  var forms = Array.prototype.slice.call(document.querySelectorAll("form[data-reply]"));
  var replyPending = false;
  function replyClosed() {
    return scribe.replyState && /^(answered|skipped|expired)$/.test(scribe.replyState.status);
  }
  function buttonSummary(button) {
    return button.getAttribute("data-reply").trim() || button.textContent.trim();
  }
  function restoreReplyState() {
    if (!replyClosed()) return;
    var state = scribe.replyState;
    document.querySelectorAll('button[data-reply]').forEach(function (button) {
      button.disabled = true;
      var chosen = state.status === "answered" && buttonSummary(button) === state.summary;
      button.classList.toggle("kit-reply-chosen", chosen);
      if (chosen) button.setAttribute("aria-pressed", "true");
      else button.removeAttribute("aria-pressed");
    });
    forms.forEach(function (form) {
      Array.prototype.forEach.call(form.elements, function (el) { el.disabled = true; });
    });
  }
  window.addEventListener("scribe-reply-state", restoreReplyState);

  function formKey(form, i) {
    return form.id || "form" + i;
  }

  /** Named fields as { name: value }: check boxes as a list, empty answers left out. */
  function answersOf(form) {
    var out = {};
    var multi = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (el.type === "checkbox" && el.name) multi[el.name] = true;
    });
    new FormData(form).forEach(function (value, name) {
      if (typeof value !== "string") return;
      if (multi[name]) {
        (out[name] = out[name] || []).push(value);
      } else if (value.trim()) {
        out[name] = value.trim();
      }
    });
    return out;
  }

  function summaryOf(answers) {
    var text = Object.keys(answers)
      .map(function (name) {
        var value = answers[name];
        return name + ": " + (Array.isArray(value) ? value.join(", ") : value);
      })
      .join("; ");
    return text.length > 280 ? text.slice(0, 279) + "…" : text;
  }

  function saveDraft(form, key) {
    var drafts = Object.assign({}, scribe.local[DRAFTS] || {});
    var draft = {};
    new FormData(form).forEach(function (value, name) {
      if (typeof value !== "string") return;
      draft[name] = draft[name] === undefined ? value : [].concat(draft[name], value);
    });
    drafts[key] = draft;
    var patch = {};
    patch[DRAFTS] = drafts;
    scribe.setLocal(patch);
  }

  function restoreDraft(form, key) {
    var draft = (scribe.local[DRAFTS] || {})[key];
    if (!draft) return;
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || !(el.name in draft)) return;
      var saved = [].concat(draft[el.name]);
      if (el.type === "radio" || el.type === "checkbox") {
        el.checked = saved.indexOf(el.value) !== -1;
      } else if (el.type !== "submit" && el.type !== "button" && el.type !== "file") {
        el.value = saved[0];
      }
    });
  }

  function statusEl(form) {
    if (form.matches('button[data-reply]')) {
      if (form._kitStatus) return form._kitStatus;
      var buttonStatus = document.createElement("span");
      buttonStatus.className = "kit-status";
      buttonStatus.setAttribute("role", "status");
      form.after(buttonStatus);
      form._kitStatus = buttonStatus;
      return buttonStatus;
    }
    var status = form.querySelector(".kit-status");
    if (status) return status;
    status = document.createElement("span");
    status.className = "kit-status";
    status.setAttribute("role", "status");
    var submit = form.querySelector('button[type="submit"], button:not([type])');
    if (submit) submit.after(status);
    else form.append(status);
    return status;
  }

  function show(form, text, tone) {
    var status = statusEl(form);
    status.textContent = text;
    status.className = "kit-status" + (tone ? " " + tone : "");
  }

  // Use the host's reply bridge in pages and component frames alike.
  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest('button[data-reply]');
    if (!button) return;
    event.preventDefault(); // Do not also submit a surrounding form.
    if (replyClosed() || replyPending || button.disabled) return;
    var summary = buttonSummary(button);
    var answers = {};
    try {
      if (button.hasAttribute("data-context")) answers = JSON.parse(button.getAttribute("data-context"));
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new Error("data-context must be a JSON object");
    } catch (error) {
      show(button, "Not sent: " + error.message, "error");
      return;
    }
    replyPending = true;
    var buttons = Array.prototype.slice.call(document.querySelectorAll('button[data-reply]'));
    var disabled = buttons.map(function (el) { return el.disabled; });
    buttons.forEach(function (el) { el.disabled = true; });
    button.classList.add("kit-reply-chosen");
    button.setAttribute("aria-pressed", "true");
    show(button, "Sending…");
    Promise.resolve().then(function () {
      return scribe.reply(answers, { summary: summary });
    }).then(function (result) {
      if (result && result.ok) return;
      var error = (result && result.error) || "unknown error";
      if (!/no reply target/i.test(error)) throw new Error(error);
      scribe.signal("submitted", { answers: answers, summary: summary });
    }).then(function () {
      show(button, "Sent", "ok");
    }, function (error) {
      replyPending = false;
      buttons.forEach(function (el, i) { el.disabled = disabled[i]; });
      button.classList.remove("kit-reply-chosen");
      button.removeAttribute("aria-pressed");
      show(button, "Not sent: " + ((error && error.message) || error), "error");
      restoreReplyState();
    });
  });

  forms.forEach(function (form, i) {
    var key = formKey(form, i);
    restoreDraft(form, key);
    form.addEventListener("input", function () { saveDraft(form, key); });
    form.addEventListener("change", function () { saveDraft(form, key); });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (replyClosed()) return;
      var answers = answersOf(form);
      var summary = summaryOf(answers);
      var submit = event.submitter || form.querySelector('button[type="submit"], button:not([type])');
      if (submit) submit.disabled = true;
      show(form, "Sending…");
      scribe.reply(answers, { summary: summary }).then(function (result) {
        if (result && result.ok) {
          var target = result.target && result.target.title;
          show(form, target ? "Sent to " + target : "Sent", "ok");
          return;
        }
        var error = (result && result.error) || "unknown error";
        if (/no reply target/i.test(error)) {
          // A page without replyTo: the agent waits on this signal instead.
          scribe.signal("submitted", { form: key, answers: answers, summary: summary });
          show(form, "Sent", "ok");
          return;
        }
        show(form, "Not sent: " + error, "error");
      }, function (err) {
        show(form, "Not sent: " + ((err && err.message) || err), "error");
      }).then(function () {
        if (submit && !replyClosed()) submit.disabled = false;
      });
    });
  });
  restoreReplyState();
})();
