/* Installed before page scripts, only while a tool is waiting for this revision's first render. */
(function () {
  var boot = window.__SCRIBE_PROBLEMS__;
  delete window.__SCRIBE_PROBLEMS__;
  if (!boot) return;
  var problems = [], links = [], done = false, restore = [], components = 0, readyToFinish = false;
  var componentReports = {
    add: add,
    hold: function () {
      components++;
      if (!done && components === 1) send("pending");
      var released = false;
      return function () { if (released) return; released = true; components--; if (readyToFinish) finish(); };
    }
  };
  window.__scribeComponentProblems = componentReports;
  var endpoint = "/api/tabs/" + encodeURIComponent(boot.id) + "/problems";
  function send(phase) {
    if (typeof boot.report === "function") { boot.report({ token: boot.token, phase: phase, problems: problems, links: links }); return; }
    fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: boot.token, phase: phase, problems: problems, links: links }) }).catch(function () {});
  }
  function add(code, message, line) {
    if (done || problems.length >= 24 || problems.filter(function (p) { return p.code === code; }).length >= 3) return;
    var item = { code: code, message: String(message || "Unknown error").slice(0, 300) };
    if (line > 0 && !(line > boot.insertLine && line < boot.insertLine + boot.insertedLines)) {
      item.line = line > boot.insertLine ? line - boot.insertedLines : line;
    }
    if (!problems.some(function (p) { return p.code === item.code && p.message === item.message && p.line === item.line; })) problems.push(item);
  }
  function stackLine(reason) {
    var stack = reason && reason.stack;
    if (typeof stack !== "string") return undefined;
    var marker = location.href + ":";
    var at = stack.indexOf(marker);
    return at < 0 ? undefined : parseInt(stack.slice(at + marker.length), 10);
  }
  function error(event) {
    if (event.target && event.target !== window) {
      var el = event.target;
      if (el.src || el.href) add("asset_load", "Failed to load " + (el.getAttribute("src") || el.getAttribute("href")));
    } else {
      var local = event.filename && event.filename.split("?")[0] === location.origin + location.pathname;
      add("uncaught_error", event.message, local ? event.lineno : undefined);
    }
  }
  function rejection(event) {
    var reason = event.reason, message = reason && reason.message || reason;
    if (message && typeof message === "object") { try { message = JSON.stringify(message); } catch (e) { message = String(message); } }
    add("unhandled_rejection", message, stackLine(reason));
  }
  window.addEventListener("error", error, true);
  window.addEventListener("unhandledrejection", rejection);

  // Observe failures even when page code handles a rejected bridge call or an {ok:false} result.
  var watched = new WeakSet();
  function watch(api, prefix) {
    if (!api || typeof api !== "object" || watched.has(api)) return api;
    watched.add(api);
    Object.keys(api).forEach(function (key) {
      var descriptor = Object.getOwnPropertyDescriptor(api, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return;
      var value = descriptor.value, name = prefix + "." + key;
      if (typeof value === "function" && descriptor.writable) {
        var wrapped = function () {
          function failed(err) {
            if (boot.capture && (err === "capture" || err === "no_board")) return;
            add("bridge_error", name + ": " + (err && err.message || err));
          }
          try {
            if (boot.capture && prefix === "scribe" && key === "update" && window.scribe.ops) {
              var ops = arguments[0];
              window.scribe.ops.apply(window.scribe.state, Array.isArray(ops) ? ops : [ops]);
            }
            var result = value.apply(this, arguments);
            if (result && typeof result.then === "function") return result.then(function (reply) {
              if (reply && reply.ok === false) failed(reply.error || "Call failed");
              return reply;
            }, function (err) { failed(err); throw err; });
            // Factory APIs such as scribe.plugin(id).
            if (key === "plugin") watch(result, name);
            return result;
          } catch (err) { failed(err); throw err; }
        };
        api[key] = wrapped;
        restore.push(function () { if (api[key] === wrapped) api[key] = value; });
      } else if (value && typeof value === "object" && key !== "ops" && key !== "template") watch(value, name);
    });
    return api;
  }
  window.__scribeWatchProblems = function () { watch(window.scribe, "scribe"); delete window.__scribeWatchProblems; };

  function lint() {
    performance.getEntriesByType("resource").forEach(function (resource) {
      if (resource.responseStatus >= 400 && ["img", "css", "script", "link"].includes(resource.initiatorType)) {
        var url = new URL(resource.name);
        if (url.origin === location.origin) add("asset_load", "Failed to load " + url.pathname.replace(/^\/view\/[^/]+\/asset\//, "asset:"));
      }
    });
    document.querySelectorAll("input, select, textarea").forEach(function (el) {
      if (el.form && el.form.matches("[data-reply]") && !el.disabled && !["submit", "button", "reset"].includes(el.type) && !el.name.trim()) {
        add("reply_field_name", "A data-reply form field has no name: " + (el.id || el.placeholder || el.tagName.toLowerCase()));
      }
    });
    var rules = [], readable = true;
    function readRules(list) { Array.from(list).forEach(function (rule) {
      if (rule.selectorText) rules.push(rule.selectorText);
      if (rule.cssRules) readRules(rule.cssRules);
    }); }
    Array.from(document.styleSheets).forEach(function (sheet) { try { readRules(sheet.cssRules); } catch (e) { readable = false; } });
    var kit = document.querySelector('link[href*="/kit.css"]');
    if (kit && readable) document.querySelectorAll(".callout, .badge, .tag, .box, .card, .flow > *, td, tr, [class*='tone-']").forEach(function (el) {
      Array.from(el.classList).forEach(function (name) {
        if ((/^tone-/.test(name) || ["success", "warning", "danger", "failure", "critical", "note", "tip", "red", "green", "yellow", "blue"].includes(name)) &&
          !rules.some(function (rule) { return new RegExp("\\." + name.replace(/[^a-zA-Z0-9_-]/g, "") + "(?![a-zA-Z0-9_-])").test(rule); })) {
          add("unknown_tone", "Unknown kit tone class: " + name + ". Use " + boot.tones.join(", ") + ".");
        }
      });
    });
    document.querySelectorAll("a[href], [data-scribe-open]").forEach(function (el) {
      var key = (el.getAttribute("data-scribe-open") || el.getAttribute("href") || "").trim().split("#")[0];
      if (/^scribe:/.test(key) && !el.hasAttribute("data-scribe-open")) add("page_link_attribute", "Use data-scribe-open for page link: " + key);
      if (/^scribe:/.test(key) && links.length < 32 && !links.includes(key)) links.push(key);
    });
  }
  function finish(force) {
    if (done) return;
    readyToFinish = true;
    if (components && force !== true) return;
    lint();
    send("done");
    done = true;
    if (window.__scribeComponentProblems === componentReports) delete window.__scribeComponentProblems;
    restore.forEach(function (fn) { fn(); });
    window.removeEventListener("error", error, true);
    window.removeEventListener("unhandledrejection", rejection);
  }
  var remaining = typeof boot.remainingMs === "number" ? Math.max(0, boot.remainingMs - 100) : 2400;
  setTimeout(function () { finish(true); }, Math.min(2400, remaining));
  function ready() { setTimeout(finish, 1000); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true }); else ready();
})();
