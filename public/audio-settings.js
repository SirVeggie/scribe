(() => {
  "use strict";
  const section = document.createElement("section"); section.className = "settings-section audio-settings";
  const heading = document.createElement("h3"); heading.textContent = "Speech-to-text";
  const help = document.createElement("button"); help.type = "button"; help.className = "search-help"; help.textContent = "?";
  help.setAttribute("aria-label", "About speech-to-text");
  help.dataset.tooltip = "Use a model source or a custom OpenAI-compatible endpoint. Hosted sources receive your recording and may charge for transcription.";
  help.setAttribute("aria-description", help.dataset.tooltip); heading.append(" ", help); section.append(heading);
  const status = document.createElement("p"); status.className = "settings-hint"; status.setAttribute("role", "status");
  function row(label, name, type, parent = section) {
    const line = document.createElement("div"); line.className = "setting-row";
    const text = document.createElement("label"); text.textContent = label; text.id = `audio-${name}-label`;
    const input = document.createElement(type === "select" ? "select" : type === "switch" ? "button" : "input");
    input.id = `audio-${name}`; text.htmlFor = input.id;
    input.setAttribute("aria-label", label);
    if (type === "switch") {
      input.type = "button"; input.className = "pill-toggle";
      input.setAttribute("role", "switch"); input.setAttribute("aria-checked", "false");
      input.addEventListener("click", () => {
        input.setAttribute("aria-checked", String(input.getAttribute("aria-checked") !== "true"));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    } else if (type !== "select") {
      input.type = type; input.className = "ag-input audio-control";
    }
    line.append(text, input); parent.append(line);
    if (type === "select") {
      window.createSelect(input).classList.add("audio-control");
      text.htmlFor = `${input.id}-button`;
    }
    return input;
  }
  const list = document.createElement("div"); list.className = "ml-sources"; section.append(list);
  const form = document.createElement("form"); form.className = "ml-source-form"; form.hidden = true; section.append(form);
  const name = row("Name", "name", "text", form);
  const source = row("Source", "source", "select", form);
  const url = row("URL", "url", "url", form); url.placeholder = "https://api.openai.com/v1";
  const key = row("API key", "key", "password", form); key.autocomplete = "new-password";
  function customFields() {
    url.closest(".setting-row").hidden = source.value !== "__custom__";
    key.closest(".setting-row").hidden = source.value !== "__custom__";
  }
  const model = row("Model", "model", "text", form); model.placeholder = "whisper-1";
  const language = row("Language", "language", "text", form); language.placeholder = "Auto";
  function button(label, run) {
    const node = document.createElement("button"); node.type = "button"; node.textContent = label;
    node.addEventListener("click", run); return node;
  }
  let view, editing;
  const formActions = document.createElement("div"); formActions.className = "settings-actions";
  const submit = button("Save", () => {}); submit.type = "submit"; submit.className = "primary";
  formActions.append(button("Cancel", () => { form.hidden = true; add.hidden = false; }), submit);
  form.append(formActions);
  const add = button("Add source", () => edit(null)); const addActions = document.createElement("div");
  addActions.className = "settings-actions"; addActions.append(add); section.append(addActions);
  function edit(profile) {
    editing = profile; name.value = profile?.name || ""; model.value = profile?.model || "whisper-1";
    language.value = profile?.language || ""; url.value = profile?.custom?.baseUrl || ""; key.value = "";
    key.placeholder = profile?.custom?.hasKey ? "Saved (type to replace)" : "Optional";
    source.replaceChildren(); option(source, "__custom__", "Custom");
    view.sources.forEach(s => option(source, s.id, s.name)); source.value = profile?.source || "__custom__";
    if (!source.value && profile?.source) { option(source, profile.source, "Saved source (unavailable)"); source.value = profile.source; }
    source.parentElement.syncSelect(); customFields(); form.hidden = false; add.hidden = true; name.focus();
  }
  async function request(path, method, body = {}) {
    const res = await fetch("/api/audio/" + path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await res.json(); if (!res.ok) throw new Error(result.error); return result;
  }
  async function change(path, method, body) {
    try { await request(path, method, body); await refresh(); return true; }
    catch (err) { status.textContent = err.message; return false; }
  }
  form.onsubmit = async event => {
    event.preventDefault(); submit.disabled = true;
    const body = { name: name.value, source: source.value, model: model.value, language: language.value };
    if (source.value === "__custom__") body.custom = { baseUrl: url.value, ...(key.value.trim() ? { apiKey: key.value.trim() } : {}) };
    if (await change(editing ? "sources/" + encodeURIComponent(editing.id) : "sources", editing ? "PUT" : "POST", body)) {
      form.hidden = true; add.hidden = false;
    }
    submit.disabled = false;
  };
  source.addEventListener("change", customFields);
  function renderSources() {
    list.replaceChildren();
    if (!view.profiles.length) { const empty = document.createElement("p"); empty.className = "settings-hint"; empty.textContent = "No speech-to-text sources yet."; list.append(empty); }
    for (const profile of view.profiles) {
      const line = document.createElement("div"); line.className = "setting-row ml-source";
      const pick = document.createElement("input"); pick.type = "radio"; pick.name = "audio-default-source";
      pick.checked = profile.id === view.defaultSource; pick.setAttribute("aria-label", "Use " + profile.name + " by default");
      pick.addEventListener("change", () => change("settings", "PUT", { defaultSource: profile.id }));
      const text = document.createElement("span"); text.className = "ml-source-text";
      const title = document.createElement("strong"); title.textContent = profile.name;
      const detail = document.createElement("span"); detail.className = "ml-source-detail";
      let host = view.sources.find(s => s.id === profile.source)?.name || "Unavailable";
      if (profile.custom?.baseUrl) { try { host = new URL(profile.custom.baseUrl).host; } catch { host = profile.custom.baseUrl; } }
      detail.textContent = " " + profile.model + " · " + host; text.append(title, detail);
      const testSource = button("Test", async () => {
        testSource.disabled = true; status.textContent = "Testing…";
        try { const result = await request("test", "POST", { sourceId: profile.id }); status.textContent = result.ok ? "Transcript: " + (result.text || "(empty)") : result.message || result.error; }
        catch (err) { status.textContent = err.message; } finally { testSource.disabled = false; }
      });
      const remove = button("Remove", async () => {
        if (await confirmRemove("Remove “" + profile.name + "”?", "Remove")) await change("sources/" + encodeURIComponent(profile.id), "DELETE");
      });
      line.append(pick, text, testSource, button("Edit", () => edit(profile)), remove);
      if (profile.custom?.hasKey) line.append(button("Clear key", () => change("sources/" + encodeURIComponent(profile.id), "PUT", { custom: { apiKey: "" } })));
      list.append(line);
    }
  }
  let confirmRemove = async () => true;
  const send = row("Send after dictation", "send", "switch");
  const push = row("Push-to-talk (Ctrl+Shift+Space)", "push", "switch");
  const mic = row("Microphone", "mic", "select");
  const sourcesLink = document.createElement("button"); sourcesLink.type = "button";
  sourcesLink.className = "audio-sources-link"; sourcesLink.textContent = "Model sources →";
  sourcesLink.addEventListener("click", () => window.scribeChat?.openModelSources());
  section.append(sourcesLink);
  const option = (select, value, text) => { const node = document.createElement("option"); node.value = value; node.textContent = text; select.append(node); };
  async function devices() {
    mic.replaceChildren(); option(mic, "", "Default microphone");
    try { const list = await navigator.mediaDevices?.enumerateDevices() || [];
      list.filter(d => d.kind === "audioinput").forEach((d, i) => option(mic, d.deviceId, d.label || `Microphone ${i + 1}`));
      const id = window.scribeAudio.device();
      if (id && ![...mic.options].some(o => o.value === id)) option(mic, id, "Saved microphone (unavailable)");
      mic.value = id;
    } catch { /* default device remains available */ }
    mic.parentElement.syncSelect();
  }
  async function refresh() {
    try {
      view = await window.scribeAudio.refresh();
      renderSources();
      send.setAttribute("aria-checked", String(view.input.sendAfterDictation));
      push.setAttribute("aria-checked", String(view.input.pushToTalk));
      status.textContent = "";
      await devices();
    } catch (err) { status.textContent = err.message; }
  }
  let saving = Promise.resolve();
  function save() {
    const body = { input: { sendAfterDictation: send.getAttribute("aria-checked") === "true", pushToTalk: push.getAttribute("aria-checked") === "true" } };
    saving = saving.then(async () => {
      const res = await fetch("/api/audio/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await res.json(); if (!res.ok) throw new Error(result.error);
      await window.scribeAudio.refresh(); status.textContent = "";
    }).catch(err => { status.textContent = err.message; });
    return saving;
  }
  [send, push].forEach(input => input.addEventListener("change", save));
  mic.addEventListener("change", () => window.scribeAudio.setDevice(mic.value));
  navigator.mediaDevices?.addEventListener("devicechange", devices);
  section.append(status);
  window.scribeAudioSettings = { sections: [section], refresh, init({ confirm }) { if (confirm) confirmRemove = confirm; } };
})();
