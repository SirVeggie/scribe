/* Settings -> Protected data -> Detectors (#1047): switch the secret-format detectors on and off, with each one's false-flag rate. */
(function () {
  "use strict";

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const tip = (node, text) => {
    node.dataset.tooltip = text;
    node.setAttribute("aria-description", text);
    return node;
  };

  const section = el("section", "settings-section");
  const heading = el("h3", null, "Detectors");
  const help = tip(el("button", "search-help", "?"), "Patterns for known secret formats. Scribe protects a match as soon as it sees it in a page, a chat or a tool result. Removing a detected value from protected data unflags it: that value is left alone from then on, and counts as a false flag for its detector.");
  help.type = "button";
  help.setAttribute("aria-label", "About detectors");
  heading.append(" ", help);
  const list = el("div", "detector-list");
  const status = el("p", "settings-hint");
  status.setAttribute("role", "status");
  section.append(heading, list, status);

  const say = (text) => { status.textContent = text; };

  async function request(method, path, body) {
    const response = await fetch(`/api/vault/detectors${path}`, method === "GET" ? {} : {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
    });
    let result = null;
    try { result = await response.json(); } catch { /* an older daemon answers with a page */ }
    if (!result || (response.status === 404 && !result.error)) throw new Error("Restart Scribe to use detectors.");
    if (!response.ok) throw new Error(result.error || "Cannot change detectors");
    return result;
  }

  function detail(d) {
    if (!d.matches) return "No matches yet";
    const rate = Math.round((d.falseFlagRate ?? 0) * 100);
    return `${d.matches} ${d.matches === 1 ? "match" : "matches"} · ${d.unflags} unflagged (${rate}%)`;
  }

  function render(detectors) {
    list.replaceChildren();
    for (const d of detectors) {
      const row = el("div", "setting-row ml-source detector-row");
      const text = el("span", "ml-source-text");
      const name = el("strong", null, d.label);
      name.id = `detector-${d.id}-label`;
      text.append(name, el("span", "ml-source-detail", ` ${detail(d)}`));
      if (d.suggestOff) text.append(el("span", "ml-source-detail detector-noisy", " · often unflagged: consider turning it off"));
      const last = d.history.at(-1);
      tip(text, `/${d.pattern}/${d.flags ?? ""}${last ? `\n${last.by}: ${last.change}` : ""}`);
      row.append(text);
      if (!d.builtin) {
        const remove = el("button", null, "Remove");
        remove.type = "button";
        remove.addEventListener("click", async () => {
          remove.disabled = true;
          try { await request("DELETE", `/${encodeURIComponent(d.id)}`); await refresh(); }
          catch (err) { say(err.message); remove.disabled = false; }
        });
        row.append(remove);
      }
      const toggle = el("button", "pill-toggle");
      toggle.type = "button";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", String(d.enabled));
      toggle.setAttribute("aria-labelledby", name.id);
      toggle.addEventListener("click", async () => {
        toggle.disabled = true;
        try { await request("PUT", `/${encodeURIComponent(d.id)}`, { enabled: !d.enabled }); await refresh(); }
        catch (err) { say(err.message); toggle.disabled = false; }
      });
      row.append(toggle);
      list.append(row);
    }
  }

  async function refresh() {
    try {
      const result = await request("GET", "");
      render(result.detectors);
    } catch (err) {
      say(err.message);
    }
  }

  window.scribeDetectorSettings = {
    sections: [section],
    /** Called when Settings opens. */
    refresh() {
      say("");
      refresh();
    },
  };
})();
