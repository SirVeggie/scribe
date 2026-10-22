(() => {
  let settings = { enabled: false, launcher: "" };
  const section = document.createElement("section");
  section.className = "settings-section integration-settings";
  section.innerHTML = `<h3>Integrations</h3>
    <div class="setting-row"><span id="intellij-label" class="setting-hinted" data-tooltip="Adds actions to compare file versions and open files at the selected diff line in IntelliJ IDEA." aria-description="Adds actions to compare file versions and open files at the selected diff line in IntelliJ IDEA.">IntelliJ IDEA</span><button type="button" id="intellij-enabled" class="pill-toggle" role="switch" aria-checked="false" aria-labelledby="intellij-label"></button></div>
    <div class="setting-row" id="intellij-launcher-row" hidden><label for="intellij-launcher" class="setting-hinted" data-tooltip="Leave empty to find IntelliJ automatically. Otherwise enter the path to idea64.exe, idea.sh, or the idea launcher." aria-description="Leave empty to find IntelliJ automatically. Otherwise enter the path to idea64.exe, idea.sh, or the idea launcher.">Launcher path</label><input id="intellij-launcher" type="text" placeholder="Auto-detect" spellcheck="false"><button type="button" id="intellij-save">Save</button></div>
    <p class="settings-hint" id="intellij-error" role="status" hidden></p>`;
  const toggle = section.querySelector("#intellij-enabled");
  const launcher = section.querySelector("#intellij-launcher");
  const error = section.querySelector("#intellij-error");
  const save = section.querySelector("#intellij-save");
  function report(err) { error.hidden = !err; error.textContent = err?.message || ""; }
  async function request(method, suffix = "", body) {
    const res = await fetch(`/api/agent/integrations${suffix}`, {
      method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not update integrations");
    return data;
  }
  function render(data) {
    if (!data?.intellij) throw new Error("Integration settings are unavailable. Restart the Scribe daemon and reload.");
    settings = data.intellij;
    toggle.setAttribute("aria-checked", String(settings.enabled));
    launcher.value = settings.launcher;
    section.querySelector("#intellij-launcher-row").hidden = !settings.enabled;
    document.querySelectorAll("[data-intellij-actions]").forEach(node => { node.hidden = !settings.enabled; });
  }
  async function refresh() {
    try { render(await request("GET")); report(null); } catch (err) { report(err); }
  }
  async function update(enabled) {
    toggle.disabled = save.disabled = true;
    try { render(await request("PUT", "", { intellij: { enabled, launcher: launcher.value } })); report(null); }
    catch (err) { report(err); }
    finally { toggle.disabled = save.disabled = false; }
  }
  toggle.addEventListener("click", () => update(!settings.enabled));
  save.addEventListener("click", () => update(settings.enabled));
  launcher.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); update(settings.enabled); } });
  const ready = refresh();

  /** A diff keeps its selected line even when clicking the action moves focus. */
  function decorateDiff(head, diff, source, file, notify) {
    const actions = document.createElement("span");
    actions.className = "ag-intellij-actions";
    actions.dataset.intellijActions = "";
    actions.hidden = !settings.enabled;
    ready.then(() => { actions.hidden = !settings.enabled; });
    const first = file.lines?.find(line => line.newNo && line.kind === "add") || file.lines?.find(line => line.newNo);
    let line = first?.newNo || 1, column = 1;
    diff?.addEventListener("mouseup", event => {
      const row = event.target.closest("[data-new-line]");
      if (!row || !diff.contains(row)) return;
      line = Number(row.dataset.newLine);
      column = 1;
      const selection = window.getSelection();
      const text = row.querySelector(".ag-dl-text");
      if (text && selection?.anchorNode && text.contains(selection.anchorNode)) {
        const range = document.createRange();
        range.selectNodeContents(text);
        range.setEnd(selection.anchorNode, selection.anchorOffset);
        column = Math.max(1, range.toString().length); // subtract the displayed +/-/space prefix, then use a 1-based column
      }
      diff.querySelector(".ag-dl-selected")?.classList.remove("ag-dl-selected");
      row.classList.add("ag-dl-selected");
    });
    for (const [label, mode] of [["Open diff", "diff"], ["Open in IntelliJ", "file"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ag-btn tiny";
      button.textContent = label;
      button.addEventListener("click", async event => {
        event.stopPropagation();
        button.disabled = true;
        try { await request("POST", "/intellij/open", { ...source, path: file.path, mode, line, column }); }
        catch (err) { notify(err.message); }
        finally { button.disabled = false; }
      });
      actions.append(button);
    }
    head.append(actions);
  }
  window.scribeIntegrations = { sections: [section], refresh, decorateDiff };
})();
