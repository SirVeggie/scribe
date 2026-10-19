/*
 * Page kit (#630): the script half. Wires <form data-reply> so an agent's form needs no script:
 * typing is kept as this viewer's draft (scribe.local), and submit sends the named fields with
 * scribe.reply (the page's replyTo), or as a "submitted" signal on a page without one.
 */
(function () {
  "use strict";
  var scribe = window.scribe;
  if (!scribe) return;

  var DRAFTS = "kitForms";
  var forms = Array.prototype.slice.call(document.querySelectorAll("form[data-reply]"));
  if (!forms.length) return;

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

  forms.forEach(function (form, i) {
    var key = formKey(form, i);
    restoreDraft(form, key);
    form.addEventListener("input", function () { saveDraft(form, key); });
    form.addEventListener("change", function () { saveDraft(form, key); });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
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
        if (submit) submit.disabled = false;
      });
    });
  });
})();
