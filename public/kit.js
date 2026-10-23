/*
 * Page kit: wires <form data-reply> and <button data-reply> without page scripts.
 * Add public hooks (including new bindings) to kit.catalog.json; run npm run gen:kit-docs.
 * Buttons send their summary and optional JSON context through the host's scribe.reply.
 * For forms,
 * typing is kept as this viewer's draft (scribe.local), and submit sends the named fields with
 * scribe.reply (the page's replyTo), or as a "submitted" signal on a page without one.
 */
(function () {
  "use strict";
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
