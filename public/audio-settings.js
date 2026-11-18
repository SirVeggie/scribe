(() => {
  "use strict";
  const BROWSER = "__browser__";
  function helpButton(label, text) {
    const help = document.createElement("button"); help.type = "button"; help.className = "search-help"; help.textContent = "?";
    help.setAttribute("aria-label", label); help.dataset.tooltip = text; help.setAttribute("aria-description", text);
    return help;
  }
  function heading(text, help) {
    const node = document.createElement("h3"); node.textContent = text; node.append(" ", help); return node;
  }
  const section = document.createElement("section"); section.className = "settings-section audio-settings";
  section.append(heading("Speech-to-text", helpButton("About speech-to-text",
    "Use a model source or a custom OpenAI-compatible endpoint. Hosted sources receive your recording and may charge for transcription.")));
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
  function button(label, run, className = "") {
    const node = document.createElement("button"); node.type = "button"; node.textContent = label;
    if (className) node.className = className;
    node.addEventListener("click", run); return node;
  }
  const option = (select, value, text) => { const node = document.createElement("option"); node.value = value; node.textContent = text; select.append(node); };
  let view;
  async function request(path, method, body = {}) {
    const res = await fetch("/api/audio/" + path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await res.json(); if (!res.ok) throw new Error(result.error); return result;
  }
  async function change(path, method, body, where = status) {
    try { await request(path, method, body); await refresh(); return true; }
    catch (err) { where.textContent = err.message; return false; }
  }
  let confirmRemove = async () => true;

  /* ---------- the source editor: a modal, like Model sources ---------- */
  /** The agent chat's modal when it is there (it keeps Escape in order); a plain one otherwise. */
  function openModal(cls) {
    const shared = window.scribeChat?.modal;
    if (shared) return shared(cls);
    const root = document.createElement("div"); root.className = `ag-modal ${cls}`;
    const backdrop = document.createElement("div"); backdrop.className = "ag-modal-backdrop";
    const panel = document.createElement("div"); panel.className = "ag-modal-panel";
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true");
    root.append(backdrop, panel);
    const close = () => root.remove();
    backdrop.addEventListener("mousedown", event => { event.preventDefault(); close(); });
    panel.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } });
    document.body.append(root);
    return { root, panel, close };
  }
  function field(label, input, hint) {
    const wrap = document.createElement("label"); wrap.className = "ag-field";
    const caption = document.createElement("span"); caption.className = "ag-field-label"; caption.textContent = label;
    if (hint) { caption.dataset.tooltip = hint; caption.setAttribute("aria-description", hint); }
    if (!input.getAttribute("aria-label")) input.setAttribute("aria-label", label);
    wrap.append(caption, input);
    return wrap;
  }
  function textInput(id, value, placeholder, type = "text") {
    const node = document.createElement("input"); node.className = "ag-input"; node.id = id; node.type = type;
    node.value = value ?? ""; node.placeholder = placeholder; node.spellcheck = false; return node;
  }
  function selectInput(id, label, options, value) {
    const node = document.createElement("select"); node.id = id; node.setAttribute("aria-label", label);
    options.forEach(([v, text]) => option(node, v, text)); node.value = value;
    return node;
  }
  /** Mounts selects as the app's own dropdown once they are in the document. */
  function mountSelects(...selects) { for (const select of selects) { window.createSelect(select); select.parentElement.syncSelect?.(); } }
  function setOptions(select, options, value) {
    select.replaceChildren(); options.forEach(([v, text]) => option(select, v, text)); select.value = value;
    select.parentElement?.syncSelect?.();
  }
  /**
   * Fields every source has: a model source it links to, or a custom URL with its own key.
   * The key is never shown again; leaving it empty keeps the saved one.
   */
  /* ---------- model help: hovering a model picker shows what the server says about the chosen model ---------- */
  const helpCard = document.createElement("div"); helpCard.className = "audio-model-help"; helpCard.id = "audio-model-help";
  helpCard.setAttribute("role", "tooltip"); helpCard.hidden = true; document.body.append(helpCard);
  const helpCache = new Map();
  let helpAnchor = null, helpShowTimer = 0, helpHideTimer = 0, helpSeq = 0;
  function hideModelHelp() {
    clearTimeout(helpShowTimer); helpSeq++;
    helpCard.hidden = true; helpAnchor?.removeAttribute("aria-describedby"); helpAnchor = null;
  }
  /** "Languages: en, ja · Voice blending · Options: temperature, top_p" from the server's features. */
  function featureLine(features) {
    const name = key => key.replace(/_/g, " ").replace(/^./, ch => ch.toUpperCase());
    return Object.entries(features || {}).flatMap(([key, value]) => value === true ? [name(key)]
      : Array.isArray(value) && value.length ? [`${name(key)}: ${value.map(v => typeof v === "string" ? v : JSON.stringify(v)).join(", ")}`]
      : typeof value === "string" || typeof value === "number" ? [`${name(key)}: ${value}`] : []).join(" · ");
  }
  async function showModelHelp(anchor, request_) {
    if (!request_ || !anchor.isConnected) return;
    const mine = ++helpSeq, key = JSON.stringify(request_);
    let info = helpCache.get(key);
    if (!info) {
      info = await request("model-info", "POST", request_).catch(() => null);
      if (info?.ok) helpCache.set(key, info);
    }
    if (mine !== helpSeq || !info?.ok || !anchor.isConnected) return;
    const model = info.model;
    if (!model.description && !model.guide) return;
    const title = document.createElement("strong"); title.textContent = modelLabel(model);
    const parts = [title];
    if (model.description) { const p = document.createElement("p"); p.textContent = model.description; parts.push(p); }
    const features = featureLine(model.features);
    if (features) { const p = document.createElement("p"); p.className = "audio-model-features"; p.textContent = features; parts.push(p); }
    if (model.guide) {
      const guide = document.createElement("div"); guide.className = "ag-md audio-model-guide";
      if (window.AgentRender?.renderMarkdown) window.AgentRender.renderMarkdown(guide, model.guide); else guide.textContent = model.guide;
      parts.push(guide);
    }
    helpCard.replaceChildren(...parts);
    helpCard.hidden = false;
    const box = anchor.getBoundingClientRect(), width = Math.min(440, innerWidth - 16);
    helpCard.style.width = width + "px";
    helpCard.style.left = Math.max(8, Math.min(box.left, innerWidth - width - 8)) + "px";
    const below = innerHeight - box.bottom - 14, above = box.top - 14;
    const room = Math.max(below, above);
    helpCard.style.maxHeight = Math.max(120, room) + "px";
    const height = Math.min(helpCard.scrollHeight, room);
    helpCard.style.top = (below >= height || below >= above ? box.bottom + 6 : box.top - 6 - height) + "px";
    helpAnchor = anchor; anchor.setAttribute("aria-describedby", helpCard.id);
  }
  /** Hover help for a model picker; describe() names the model to ask about ({ kind, id, model, …draft }) or null. */
  function bindModelHelp(anchor, describe) {
    if (!anchor) return;
    anchor.addEventListener("pointerenter", event => {
      if (event.pointerType !== "mouse" || event.buttons) return;
      clearTimeout(helpHideTimer); clearTimeout(helpShowTimer);
      helpShowTimer = setTimeout(() => void showModelHelp(anchor, describe()), helpCard.hidden ? 450 : 0);
    });
    anchor.addEventListener("pointerleave", event => {
      clearTimeout(helpShowTimer);
      if (!helpCard.contains(event.relatedTarget)) helpHideTimer = setTimeout(hideModelHelp, 150);
    });
    // Opening the dropdown puts its menu where the card is.
    anchor.addEventListener("pointerdown", hideModelHelp);
    anchor.addEventListener("keydown", hideModelHelp);
  }
  // The guide can be long: the card stays while the pointer is on it, so it can be scrolled.
  helpCard.addEventListener("pointerenter", () => clearTimeout(helpHideTimer));
  helpCard.addEventListener("pointerleave", () => { helpHideTimer = setTimeout(hideModelHelp, 150); });

  function endpointFields(prefix, profile, onChange) {
    const sourceOptions = [["__custom__", "Custom"], ...view.sources.map(s => [s.id, s.name])];
    if (profile?.source && !sourceOptions.some(([v]) => v === profile.source)) sourceOptions.push([profile.source, "Saved source (unavailable)"]);
    const source = selectInput(`${prefix}-source`, "Source", sourceOptions, profile?.source || "__custom__");
    let customUrl = profile?.custom?.baseUrl || "";
    const url = textInput(`${prefix}-url`, "", "https://api.openai.com/v1", "url");
    const key = textInput(`${prefix}-key`, "", profile?.custom?.hasKey ? "Saved (type to replace)" : "Optional", "password");
    key.autocomplete = "new-password"; key.setAttribute("aria-label", "API key");
    // Clearing the saved key happens on Save, like any other change in the editor.
    let clearKey = false;
    const keyBox = document.createElement("span"); keyBox.className = "audio-key-box"; keyBox.append(key);
    if (profile?.custom?.hasKey) {
      const clear = button("×", () => { clearKey = true; key.value = ""; key.placeholder = "Optional"; clear.remove(); key.focus(); }, "audio-key-clear");
      clear.setAttribute("aria-label", "Clear saved key"); clear.dataset.tooltip = "Clear saved key";
      keyBox.append(clear);
    }
    const keyField = field("API key", keyBox, profile?.custom?.hasKey ? "Leave empty to keep the saved key." : "Leave empty for local servers that need none.");
    url.addEventListener("input", () => { customUrl = url.value; });
    const sync = () => {
      const custom = source.value === "__custom__";
      url.readOnly = !custom;
      url.value = custom ? customUrl : view.sources.find(s => s.id === source.value)?.baseUrl || "";
      keyField.hidden = !custom;
    };
    source.addEventListener("change", () => { sync(); onChange?.(); });
    url.addEventListener("change", () => onChange?.());
    key.addEventListener("change", () => onChange?.());
    sync();
    return {
      nodes: [field("Source", source), field("URL", url, "Up to the version, e.g. …/v1."), keyField],
      selects: [source],
      body() {
        if (source.value !== "__custom__") return { source: source.value };
        const apiKey = key.value.trim() || (clearKey ? "" : undefined);
        return { source: source.value, custom: { baseUrl: url.value.trim(), ...(apiKey !== undefined ? { apiKey } : {}) } };
      },
    };
  }
  /** One modal for adding or editing a source: fields, then Remove / Clear key / Cancel / Save. */
  function editor({ cls, title, hint, fields, selects, save, remove }) {
    const { panel, close } = openModal(`ag-source audio-source-editor ${cls}`);
    const error = document.createElement("p"); error.className = "ag-source-error"; error.hidden = true; error.setAttribute("role", "alert");
    const actions = document.createElement("div"); actions.className = "ag-modal-actions";
    const fail = message => { error.textContent = message; error.hidden = false; };
    if (remove) actions.append(button("Remove", async () => { if (await remove()) close(); }, "ag-btn ghost danger"));
    const grow = document.createElement("span"); grow.className = "ag-grow";
    const submit = button("Save", async () => {
      submit.disabled = true;
      try { await save(); close(); await refresh(); } catch (err) { fail(err.message); } finally { submit.disabled = false; }
    }, "ag-btn primary");
    actions.append(grow, button("Cancel", close, "ag-btn"), submit);
    const titleNode = document.createElement("h2"); titleNode.className = "ag-modal-title"; titleNode.textContent = title;
    panel.append(titleNode);
    if (hint) { const p = document.createElement("p"); p.className = "ag-modal-hint"; p.textContent = hint; panel.append(p); }
    panel.append(...fields, error, actions);
    mountSelects(...selects);
    panel.addEventListener("keydown", event => {
      if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type !== "checkbox") { event.preventDefault(); submit.click(); }
    });
    // Now, not a frame later: a late focus would pull the caret out of a field the user already typed in.
    panel.querySelector("input:not([readonly])")?.focus();
    return { panel, fail };
  }
  function hostOf(profile) {
    if (!profile.custom?.baseUrl) return view.sources.find(s => s.id === profile.source)?.name || "Unavailable";
    try { return new URL(profile.custom.baseUrl).host; } catch { return profile.custom.baseUrl; }
  }
  /** A list row: a radio for the default, name and detail, then its buttons. */
  function sourceRow(group, { id, name, detail, checked, label, onPick, buttons }) {
    const line = document.createElement("div"); line.className = "setting-row ml-source";
    const pick = document.createElement("input"); pick.type = "radio"; pick.name = group; pick.value = id;
    pick.checked = checked; pick.setAttribute("aria-label", label);
    pick.addEventListener("change", onPick);
    const text = document.createElement("span"); text.className = "ml-source-text";
    const title = document.createElement("strong"); title.textContent = name;
    const small = document.createElement("span"); small.className = "ml-source-detail"; small.textContent = detail ? " " + detail : "";
    text.append(title, small);
    line.append(pick, text, ...buttons);
    return line;
  }

  /* ---------- speech-to-text sources ---------- */
  const list = document.createElement("div"); list.className = "ml-sources"; section.append(list);
  const add = button("Add source", () => editStt(null)); add.setAttribute("aria-label", "Add speech-to-text source");
  const addActions = document.createElement("div"); addActions.className = "settings-actions"; addActions.append(add); section.append(addActions);
  /** Adding or editing a source: only where it is and how to reach it, as for text-to-speech. */
  function editStt(profile) {
    const name = textInput("audio-name", profile?.name, "e.g. Whisper");
    const endpoint = endpointFields("audio", profile);
    const path = profile ? "sources/" + encodeURIComponent(profile.id) : "sources";
    editor({ cls: "audio-stt-editor", title: profile ? `Edit ${profile.name}` : "Add a speech-to-text source",
      hint: "An OpenAI-compatible /audio/transcriptions endpoint. Choose its model and settings under Speech-to-text once it is added.",
      fields: [field("Name", name), ...endpoint.nodes], selects: endpoint.selects,
      save: async () => {
        const body = { name: name.value, ...endpoint.body() };
        // A new source starts on the server's default model when it names one, else whisper-1 (OpenAI's).
        if (!profile) {
          const list = await request("models", "POST", { kind: "stt", ...body }).catch(() => null);
          const models = list?.ok ? list.models : [];
          body.model = models.some(m => m.default) ? "" : models.some(m => m.id === "whisper-1") || !models.length ? "whisper-1" : models[0].id;
        }
        return request(path, profile ? "PUT" : "POST", body);
      },
      remove: profile && (async () => {
        if (!await confirmRemove("Remove “" + profile.name + "”?", "Remove")) return false;
        return change(path, "DELETE");
      }) });
  }
  function renderSources() {
    list.replaceChildren();
    if (!view.profiles.length) { const empty = document.createElement("p"); empty.className = "settings-hint"; empty.textContent = "No speech-to-text sources yet."; list.append(empty); }
    for (const profile of view.profiles) {
      const testSource = button("Test", async () => {
        testSource.disabled = true; status.textContent = "Testing…"; sttForm?.clearErrors();
        // A model that is not loaded yet can take a while to answer the first time.
        const slow = setTimeout(() => { status.textContent = "Testing… waiting for the model to load."; }, 2500);
        try {
          const result = await request("test", "POST", { sourceId: profile.id });
          status.textContent = result.ok ? "Transcript: " + (result.text || "(empty)") : result.message || result.error;
          if (!result.ok && result.setting && profile.id === view.defaultSource) sttForm?.markError(result.setting, result.message);
        }
        catch (err) { status.textContent = err.message; } finally { clearTimeout(slow); testSource.disabled = false; }
      });
      list.append(sourceRow("audio-default-source", { id: profile.id, name: profile.name, checked: profile.id === view.defaultSource,
        label: "Use " + profile.name + " by default", onPick: () => change("settings", "PUT", { defaultSource: profile.id }),
        detail: (profile.model || "server's model") + " · " + hostOf(profile) + (profile.streaming ? " · live" : ""),
        buttons: [testSource, button("Edit", () => editStt(profile))] }));
    }
  }
  // The default source's own settings, under the list like text-to-speech's. Rows the source cannot use stay hidden.
  const sttModel = row("Model", "stt-model", "select");
  bindModelHelp(document.getElementById("audio-stt-model-button") || sttModel.parentElement, () => {
    const source = view?.defaultSource;
    return source ? { kind: "stt", id: source, model: sttModel.value } : null;
  });
  const sttModelText = row("Model", "stt-model-text", "text"); sttModelText.placeholder = "whisper-1";
  const sttLanguage = row("Language", "stt-language", "text"); sttLanguage.placeholder = "Auto"; sttLanguage.maxLength = 20;
  const sttStreaming = row("Live transcription (experimental)", "stt-streaming", "select");
  [["", "Off"], ["native", "Server stream"], ["window", "Sliding window"]].forEach(([v, text]) => option(sttStreaming, v, text));
  sttStreaming.parentElement.syncSelect?.();
  { const tip = "Shows text while you speak. Server stream needs the server's own live stream (Memorize's Moonshine models); Sliding window works with any endpoint.",
    label = sttStreaming.closest(".setting-row").querySelector("label");
    label.dataset.tooltip = tip; label.setAttribute("aria-description", tip); }
  const sttFormHost = document.createElement("div"); sttFormHost.className = "audio-model-settings"; section.append(sttFormHost);
  let sttForm = null, sttModels = [], sttSeq = 0;
  async function renderSttSettings() {
    const mine = ++sttSeq, profile = view.profiles.find(p => p.id === view.defaultSource);
    for (const input of [sttModel, sttModelText, sttLanguage, sttStreaming]) lineOf(input).hidden = !profile;
    sttFormHost.hidden = !profile;
    if (!profile) { sttForm = null; sttFormHost.replaceChildren(); return; }
    if (document.activeElement !== sttLanguage) sttLanguage.value = profile.language || "";
    sttStreaming.value = profile.streaming || ""; sttStreaming.parentElement.syncSelect?.();
    const model = profile.model || "";
    const models = profile.id === "__legacy__" ? { ok: false } : await request("models", "POST", { kind: "stt", id: profile.id }).catch(() => ({ ok: false }));
    if (mine !== sttSeq) return;
    sttModels = models.ok ? models.models : [];
    const fallback = sttModels.find(m => m.default);
    if (sttModels.length) {
      const options = [...(fallback ? [["", `Server default (${fallback.id})`]] : []), ...sttModels.map(m => [m.id, modelLabel(m)])];
      if (!options.some(([v]) => v === model)) options.push([model, (model || "Server default") + " (saved)"]);
      setOptions(sttModel, options, model);
      showPair(sttModel, sttModelText, true);
    } else {
      if (document.activeElement !== sttModelText) sttModelText.value = model;
      showPair(sttModel, sttModelText, false);
    }
    const info = findModel(sttModels, model);
    const schema = info?.settings;
    // A model that publishes its settings has its own language choice (or none, as it only knows one).
    lineOf(sttLanguage).hidden = Boolean(schema);
    // The Language box's value moves into the model's own language setting when the model takes it.
    const moved = accepts(schema?.properties?.language, profile.language) ? { language: profile.language } : null;
    sttForm = renderModelSettings(sttFormHost, schema, profile.modelSettings?.[model], (values, adopted) =>
      saveSttSetting({ settingsFor: { model, values }, ...(adopted ? { language: "" } : {}) }), moved);
  }
  function saveSttSetting(changes) {
    const id = view.defaultSource;
    if (!id) return;
    saving = saving.then(async () => { await request("sources/" + encodeURIComponent(id), "PUT", changes); await refresh(); })
      .catch(err => { status.textContent = err.message; });
  }
  sttModel.addEventListener("change", () => saveSttSetting({ model: sttModel.value }));
  sttModelText.addEventListener("change", () => saveSttSetting({ model: sttModelText.value.trim() }));
  sttLanguage.addEventListener("change", () => saveSttSetting({ language: sttLanguage.value.trim() }));
  sttStreaming.addEventListener("change", () => saveSttSetting({ streaming: sttStreaming.value }));
  const send = row("Send after dictation", "send", "switch");
  const keyword = row("Send keyword", "keyword", "text"); keyword.placeholder = "e.g. send it"; keyword.maxLength = 100;
  { const tip = "Ending dictation with this phrase and a one-second pause sends the message, without the phrase.", label = keyword.previousElementSibling;
    label.dataset.tooltip = tip; label.setAttribute("aria-description", tip); }
  const push = row("Push-to-talk (Ctrl+Shift+Space)", "push", "switch");
  const livePreview = row("Show text while dictating", "live", "switch");
  const mic = row("Microphone", "mic", "select");
  const sourcesLink = document.createElement("button"); sourcesLink.type = "button";
  sourcesLink.className = "audio-sources-link"; sourcesLink.textContent = "Model sources →";
  sourcesLink.addEventListener("click", () => window.scribeChat?.openModelSources());
  section.append(sourcesLink);
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
      rendering = Promise.all([renderSttSettings(), renderSpeech()]);
      send.setAttribute("aria-checked", String(view.input.sendAfterDictation));
      if (document.activeElement !== keyword) keyword.value = view.input.sendKeyword || "";
      push.setAttribute("aria-checked", String(view.input.pushToTalk));
      livePreview.setAttribute("aria-checked", String(view.input.livePreview !== false));
      livePreview.closest(".setting-row").hidden = !view.profiles.some(p => p.streaming);
      receiveOutput(view.output);
      status.textContent = "";
      await devices();
    } catch (err) { status.textContent = err.message; }
  }
  let saving = Promise.resolve(), rendering = Promise.resolve();
  function save() {
    const body = { input: { sendAfterDictation: send.getAttribute("aria-checked") === "true", pushToTalk: push.getAttribute("aria-checked") === "true",
      livePreview: livePreview.getAttribute("aria-checked") === "true", sendKeyword: keyword.value.trim() } };
    saving = saving.then(async () => {
      const res = await fetch("/api/audio/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await res.json(); if (!res.ok) throw new Error(result.error);
      await window.scribeAudio.refresh(); status.textContent = "";
    }).catch(err => { status.textContent = err.message; });
    return saving;
  }
  [send, keyword, push, livePreview].forEach(input => input.addEventListener("change", save));
  mic.addEventListener("change", () => window.scribeAudio.setDevice(mic.value));
  navigator.mediaDevices?.addEventListener("devicechange", devices);
  section.append(status);

  /* Notification sounds (#564): saved in the daemon, pushed to every window over /ws. */
  const sounds = document.createElement("section"); sounds.className = "settings-section audio-settings";
  const soundsHeading = document.createElement("h3"); soundsHeading.textContent = "Notification sounds"; sounds.append(soundsHeading);
  const soundsOn = row("Play sounds", "sounds", "switch", sounds);
  /** A 0–100% slider row; paint() shows its value. */
  function volumeSlider(label, id, parent) {
    const line = document.createElement("div"); line.className = "setting-row";
    const name = document.createElement("label"); name.textContent = label; name.htmlFor = id;
    const box = document.createElement("div"); box.className = "orb-settings-size";
    const input = document.createElement("input"); input.type = "range"; input.className = "orb-range"; input.id = id;
    input.min = "0"; input.max = "100"; input.step = "5";
    const text = document.createElement("output"); text.htmlFor = id;
    box.append(input, text); line.append(name, box); parent.append(line);
    input.paint = () => { text.value = input.value + "%"; input.style.setProperty("--fill", input.value + "%"); };
    return input;
  }
  const volume = volumeSlider("Volume", "audio-volume", sounds);
  const CUES = [["thread-finish", "When a chat finishes"], ["thread-ask", "When a chat needs you"]];
  const cueSwitches = CUES.map(([name, label]) => {
    const input = row(label, "cue-" + name, "switch", sounds);
    input.after(button("Play", () => window.scribeAudio.play(`/sounds/${name}.wav`, { channel: "cue" })));
    return [name, input];
  });
  const soundsStatus = document.createElement("p"); soundsStatus.className = "settings-hint"; soundsStatus.setAttribute("role", "status");
  sounds.append(soundsStatus);
  let speechVolume = null; // the Text-to-speech section's slider, made below
  function receiveOutput(output) {
    if (!output) return;
    soundsOn.setAttribute("aria-checked", String(output.sounds));
    volume.value = String(Math.round(output.volume * 100)); volume.paint();
    if (speechVolume) { speechVolume.value = String(Math.round((output.speechVolume ?? 1) * 100)); speechVolume.paint(); }
    for (const [name, input] of cueSwitches) input.setAttribute("aria-checked", String(output.cues?.[name] !== false));
    // Volume is the master: it also sets page sounds and speech, so it stays visible.
    for (const line of [...cueSwitches.map(([, input]) => input.closest(".setting-row"))]) line.hidden = !output.sounds;
  }
  function saveOutput() {
    const output = { sounds: soundsOn.getAttribute("aria-checked") === "true", volume: Number(volume.value) / 100,
      speechVolume: Number(speechVolume.value) / 100,
      cues: Object.fromEntries(cueSwitches.map(([name, input]) => [name, input.getAttribute("aria-checked") === "true"])) };
    receiveOutput(output); window.scribeAudio.setOutput(output);
    saving = saving.then(async () => {
      const res = await fetch("/api/audio/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ output }) });
      const result = await res.json(); if (!res.ok) throw new Error(result.error);
      soundsStatus.textContent = "";
    }).catch(err => { soundsStatus.textContent = err.message; });
  }
  [soundsOn, ...cueSwitches.map(([, input]) => input)].forEach(input => input.addEventListener("change", saveOutput));
  volume.addEventListener("input", () => { volume.paint(); window.scribeAudio.setOutput({ ...window.scribeAudio.output(), volume: Number(volume.value) / 100 }); });
  volume.addEventListener("change", saveOutput);

  /* ---------- text-to-speech sources (Phase D): their own list, with This browser as a free fallback ---------- */
  const speech = document.createElement("section"); speech.className = "settings-section audio-settings";
  speech.append(heading("Text-to-speech", helpButton("About text-to-speech",
    "Pages read text aloud with the chosen source. Hosted sources receive the text and may charge per character. This browser uses its own voices: free, no setup.")));
  const ttsList = document.createElement("div"); ttsList.className = "ml-sources"; speech.append(ttsList);
  const addTts = button("Add source", () => editTts(null)); addTts.setAttribute("aria-label", "Add text-to-speech source");
  const ttsActions = document.createElement("div"); ttsActions.className = "settings-actions"; ttsActions.append(addTts);
  speech.append(ttsActions);
  // The chosen source's own settings, under the list so they are one click away. Rows the source cannot use stay hidden.
  const ttsModel = row("Model", "tts-model", "select", speech);
  bindModelHelp(document.getElementById("audio-tts-model-button") || ttsModel.parentElement, () => {
    const source = view?.tts?.source;
    return source && source !== BROWSER ? { kind: "tts", id: source, model: ttsModel.value } : null;
  });
  const ttsModelText = row("Model", "tts-model-text", "text", speech); ttsModelText.placeholder = "Server default";
  const ttsVoice = row("Voice", "tts-voice", "select", speech);
  const ttsVoiceText = row("Voice", "tts-voice-text", "text", speech); ttsVoiceText.placeholder = "alloy";
  const ttsSpeed = row("Speed", "tts-speed", "number", speech);
  Object.assign(ttsSpeed, { min: "0.25", max: "4", step: "0.05" });
  // Speech volume (#1011): under the master Volume, for every source. Saved with the output settings.
  speechVolume = volumeSlider("Volume", "audio-tts-volume", speech);
  speechVolume.value = String(Math.round((window.scribeAudio.output?.().speechVolume ?? 1) * 100)); speechVolume.paint();
  speechVolume.addEventListener("input", () => { speechVolume.paint(); window.scribeAudio.setOutput({ ...window.scribeAudio.output(), speechVolume: Number(speechVolume.value) / 100 }); });
  speechVolume.addEventListener("change", saveOutput);
  const ttsStream = row("Stream while generating", "tts-stream", "switch", speech);
  const streamLabel = document.getElementById("audio-tts-stream-label") || ttsStream.closest(".setting-row").querySelector("label");
  const lineOf = input => input.closest(".setting-row");
  const ttsFormHost = document.createElement("div"); ttsFormHost.className = "audio-model-settings"; speech.append(ttsFormHost);
  let ttsForm = null;
  const speechStatus = document.createElement("p"); speechStatus.className = "settings-hint"; speechStatus.setAttribute("role", "status");
  speech.append(speechStatus);
  const speedText = speed => speed && speed !== 1 ? ` · ${speed}×` : "";
  const voiceText = id => id ? window.scribeAudio.voiceName?.(id) || id : "";
  let speaking = null;
  function testButton(sourceId) {
    const node = button("Test", async () => {
      if (speaking) { speaking.stop(); return; }
      speechStatus.textContent = ""; node.textContent = "Stop"; ttsForm?.clearErrors();
      speaking = window.scribeAudio.speak("This is how Scribe reads text aloud.", { sourceId });
      // A model that is not loaded yet can take a while to answer the first time.
      const slow = setTimeout(() => { speechStatus.textContent = "Waiting for the model to load…"; }, 2500);
      const result = await speaking.ended; speaking = null; node.textContent = "Test"; clearTimeout(slow);
      if (!result.ok) {
        speechStatus.textContent = result.message || result.error;
        if (result.setting && sourceId === view.tts?.source) ttsForm?.markError(result.setting, result.message);
      } else { speechStatus.textContent = ""; void refresh(); }
    });
    return node;
  }
  /** Adding or editing a source: only where it is and how to reach it. */
  function editTts(profile) {
    const name = textInput("audio-tts-name", profile?.name, "e.g. Kokoro");
    const endpoint = endpointFields("audio-tts", profile);
    const path = profile ? "tts-sources/" + encodeURIComponent(profile.id) : "tts-sources";
    editor({ cls: "audio-tts-editor", title: profile ? `Edit ${profile.name}` : "Add a text-to-speech source",
      hint: "An OpenAI-compatible /audio/speech endpoint. Choose its model, voice and speed under Text-to-speech once it is added.",
      fields: [field("Name", name), ...endpoint.nodes], selects: endpoint.selects,
      save: () => request(path, profile ? "PUT" : "POST", { name: name.value, ...endpoint.body() }),
      remove: profile && (async () => {
        if (!await confirmRemove("Remove “" + profile.name + "”?", "Remove")) return false;
        return change(path, "DELETE", undefined, speechStatus);
      }) });
  }
  function renderSpeech() {
    const tts = view.tts || {}, chosen = tts.source || "";
    const pick = source => () => change("settings", "PUT", { tts: { source } }, speechStatus);
    ttsList.replaceChildren(
      sourceRow("audio-tts-source", { id: "", name: "Off", checked: !chosen, label: "Turn text-to-speech off", onPick: pick(""),
        detail: "Pages cannot read text aloud", buttons: [] }),
      sourceRow("audio-tts-source", { id: BROWSER, name: "This browser", checked: chosen === BROWSER, label: "Read aloud with this browser", onPick: pick(BROWSER),
        detail: (voiceText(tts.voice) || "Default voice") + speedText(tts.speed) + " · free", buttons: [testButton(BROWSER)] }),
      ...(view.ttsSources || []).map(profile => sourceRow("audio-tts-source", { id: profile.id, name: profile.name, checked: chosen === profile.id,
        label: "Read aloud with " + profile.name, onPick: pick(profile.id),
        detail: (profile.model || "server's model") + " · " + hostOf(profile) + (profile.voice ? " · " + voiceText(profile.voice) : "")
          + speedText(profile.speed) + (profile.stream ? " · streaming" : ""),
        buttons: [testButton(profile.id), button("Edit", () => editTts(profile))] })));
    const chars = view.usage?.chars || 0;
    if (!speaking) speechStatus.textContent = chars ? "Read aloud today: " + chars.toLocaleString() + " characters" : "";
    return renderSpeechSettings();
  }
  /** "kokoro (default, loaded, native streaming)": native streaming is the one worth pointing out. */
  function modelLabel(m) {
    const parts = [m.default && "default", m.loaded && "loaded", m.streaming === "native" && "native streaming"].filter(Boolean);
    return parts.length ? `${m.id} (${parts.join(", ")})` : m.id;
  }
  /** One select or its text fallback: picks which of the two rows shows. */
  function showPair(select, text, useSelect, visible = true) {
    lineOf(select).hidden = !visible || !useSelect; lineOf(text).hidden = !visible || useSelect;
  }
  let settingsSeq = 0, ttsModels = [];
  async function renderSpeechSettings() {
    const mine = ++settingsSeq, tts = view.tts || {}, browser = tts.source === BROWSER;
    const profile = (view.ttsSources || []).find(s => s.id === tts.source);
    // Off: nothing to set. This browser: voice and speed. A source: all of them.
    showPair(ttsModel, ttsModelText, true, Boolean(profile));
    lineOf(ttsSpeed).hidden = lineOf(speechVolume).hidden = !browser && !profile;
    lineOf(ttsStream).hidden = true;
    if (!profile) { ttsForm = null; ttsFormHost.replaceChildren(); }
    if (!browser && !profile) { showPair(ttsVoice, ttsVoiceText, true, false); return; }
    if (document.activeElement !== ttsSpeed) ttsSpeed.value = String((browser ? tts.speed : profile.speed) ?? 1);
    if (browser) {
      showPair(ttsVoice, ttsVoiceText, true);
      const list = await window.scribeAudio.voices({ source: "browser" }).catch(() => null);
      if (mine !== settingsSeq) return;
      const options = [["", "Default voice"], ...(list?.voices || []).map(v => [v.id, v.lang ? `${v.name} (${v.lang})` : v.name])];
      if (tts.voice && !options.some(([v]) => v === tts.voice)) options.push([tts.voice, tts.voice + " (unavailable)"]);
      setOptions(ttsVoice, options, tts.voice || "");
      return;
    }
    const model = profile.model || "";
    const [models, voices] = await Promise.all([
      request("models", "POST", { kind: "tts", id: profile.id }).catch(err => ({ ok: false, message: err.message })),
      window.scribeAudio.voices({ source: { id: profile.id, model } }).catch(() => null)]);
    if (mine !== settingsSeq) return;
    ttsModels = models.ok ? models.models : [];
    if (ttsModels.length) {
      const fallback = ttsModels.find(m => m.default);
      const options = [["", "Server default" + (fallback ? ` (${fallback.id})` : "")], ...ttsModels.map(m => [m.id, modelLabel(m)])];
      if (model && !options.some(([v]) => v === model)) options.push([model, model + " (saved)"]);
      setOptions(ttsModel, options, model);
      showPair(ttsModel, ttsModelText, true);
    } else {
      if (document.activeElement !== ttsModelText) ttsModelText.value = model;
      showPair(ttsModel, ttsModelText, false);
    }
    if (voices?.ok) {
      const options = [["", voices.default ? `Default (${voiceText(voices.default)})` : "Default voice"], ...voices.voices.map(v => [v.id, v.name || v.id])];
      if (profile.voice && !options.some(([v]) => v === profile.voice)) options.push([profile.voice, voiceText(profile.voice) + " (saved)"]);
      setOptions(ttsVoice, options, profile.voice || "");
      showPair(ttsVoice, ttsVoiceText, true);
    } else {
      if (document.activeElement !== ttsVoiceText) ttsVoiceText.value = profile.voice || "";
      showPair(ttsVoice, ttsVoiceText, false);
      speechStatus.textContent = "Cannot list voices: " + (voices?.message || "no answer.");
    }
    // Streaming shows only for a model the server says can stream; stream: true is not OpenAI's.
    const info = findModel(ttsModels, model);
    const streams = info?.streaming;
    lineOf(ttsStream).hidden = !streams;
    ttsStream.setAttribute("aria-checked", String(Boolean(streams && profile.stream)));
    streamLabel.dataset.tooltip = streams === "native"
      ? "This model streams natively, which is usually the most reliable: speech starts while the server is still generating."
      : "Speech starts while the server is still generating, a sentence at a time.";
    streamLabel.setAttribute("aria-description", streamLabel.dataset.tooltip);
    // A model that publishes its settings sets its speed there, if it has one.
    const schema = info?.settings;
    lineOf(ttsSpeed).hidden = Boolean(schema);
    const moved = accepts(schema?.properties?.speed, profile.speed) ? { speed: profile.speed } : null;
    ttsForm = renderModelSettings(ttsFormHost, schema, profile.modelSettings?.[model], (values, adopted) =>
      saveSpeechSetting({ settingsFor: { model, values }, ...(adopted ? { speed: 1 } : {}) }), moved);
  }
  /** A model by id or alias; "" is the server's default. */
  function findModel(models, id) {
    return id ? models.find(m => m.id === id || m.aliases?.includes(id)) : models.find(m => m.default);
  }
  /** Whether a setting's schema takes this value: one of its choices, or a value of its type in range. */
  function accepts(prop, value) {
    if (!prop || typeof prop !== "object") return false;
    const choices = Array.isArray(prop.oneOf) ? prop.oneOf.map(c => c?.const) : Array.isArray(prop.enum) ? prop.enum : null;
    if (choices) return choices.includes(value);
    const types = [].concat(prop.type || []);
    if (typeof value === "string") return types.includes("string");
    if (typeof value !== "number" || !(types.includes("number") || types.includes("integer"))) return false;
    return !(typeof prop.minimum === "number" && value < prop.minimum) && !(typeof prop.maximum === "number" && value > prop.maximum);
  }

  /* ---------- model settings (#1085): controls built from the settings a model publishes ---------- */
  const showAdvanced = new Set();
  /**
   * Draws a model's settings (a JSON Schema object whose properties are request fields) into host:
   * ordered by x-order, grouped under x-group, x-advanced behind a toggle, x-hidden left out, each
   * control from x-control or its type. Only values that differ from the default are kept; save gets
   * them all. Values the model no longer lists are dropped, and moved ({ name: value }, the source's
   * own older setting) is taken over when the model has no value of that name: save(values, true).
   * Returns { markError, clearErrors }.
   */
  function renderModelSettings(host, schema, saved, save, moved) {
    const focused = document.activeElement?.closest?.("[data-setting]")?.dataset.setting;
    host.replaceChildren();
    const props = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object" ? schema.properties : null;
    host.hidden = !props;
    const api = { markError() {}, clearErrors() {} };
    if (!props) return api;
    const isObject = prop => [].concat(prop.type || []).includes("object") && prop.properties && typeof prop.properties === "object";
    // Values the model no longer lists go.
    const values = {};
    for (const [key, value] of Object.entries(saved || {})) {
      const prop = props[key];
      if (!prop) continue;
      if (isObject(prop) && value && typeof value === "object") {
        const inner = Object.fromEntries(Object.entries(value).filter(([k]) => prop.properties[k]));
        if (Object.keys(inner).length) values[key] = inner;
      } else values[key] = value;
    }
    const adopted = Object.entries(moved || {}).filter(([key, value]) => value !== undefined && value !== "" && values[key] === undefined);
    for (const [key, value] of adopted) values[key] = value;
    if (adopted.length || JSON.stringify(values) !== JSON.stringify(saved || {})) save({ ...values }, adopted.length > 0);
    const get = path => path.reduce((at, key) => at && typeof at === "object" ? at[key] : undefined, values);
    const set = (path, value, fallback) => {
      const [key, inner] = path;
      const same = value === undefined || JSON.stringify(value) === JSON.stringify(fallback);
      if (inner === undefined) { if (same) delete values[key]; else values[key] = value; }
      else {
        const box = { ...(values[key] && typeof values[key] === "object" ? values[key] : {}) };
        if (same) delete box[inner]; else box[inner] = value;
        if (Object.keys(box).length) values[key] = box; else delete values[key];
      }
      save({ ...values });
    };
    // Flatten: a nested object's properties are settings of their own, under their own groups.
    const entries = [];
    for (const [key, prop] of Object.entries(props)) {
      if (!prop || typeof prop !== "object" || prop["x-hidden"]) continue;
      if (isObject(prop)) {
        for (const [inner, sub] of Object.entries(prop.properties)) if (sub && typeof sub === "object" && !sub["x-hidden"])
          entries.push({ path: [key, inner], prop: sub, group: sub["x-group"] || prop["x-group"] || prop.title || "", order: [prop["x-order"] ?? 999, sub["x-order"] ?? 999], advanced: Boolean(sub["x-advanced"] || prop["x-advanced"]) });
      } else entries.push({ path: [key], prop, group: prop["x-group"] || "", order: [prop["x-order"] ?? 999, 0], advanced: Boolean(prop["x-advanced"]) });
    }
    entries.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
    const rows = new Map();
    const draw = (list, parent) => {
      let group = null;
      for (const entry of list) {
        if (entry.group !== group) {
          group = entry.group;
          if (group) { const h = document.createElement("h4"); h.className = "audio-settings-group"; h.textContent = group; parent.append(h); }
        }
        const line = settingControl(entry, get(entry.path), (value) => set(entry.path, value, entry.prop.default));
        rows.set(entry.path.join("."), line); parent.append(line);
      }
    };
    draw(entries.filter(e => !e.advanced), host);
    const advanced = entries.filter(e => e.advanced);
    const key = JSON.stringify(Object.keys(props));
    if (advanced.length) {
      const box = document.createElement("div"); box.className = "audio-settings-advanced";
      const toggle = button("", () => {
        if (showAdvanced.has(key)) showAdvanced.delete(key); else showAdvanced.add(key);
        paint();
      }, "audio-settings-more");
      const paint = () => {
        const open = showAdvanced.has(key);
        box.hidden = !open; toggle.textContent = open ? "Hide advanced settings" : `Advanced settings (${advanced.length})`;
        toggle.setAttribute("aria-expanded", String(open));
      };
      host.append(toggle, box); draw(advanced, box); paint();
      api.open = () => { showAdvanced.add(key); paint(); };
    }
    const errors = [];
    api.clearErrors = () => { errors.splice(0).forEach(node => node.remove()); host.querySelectorAll(".audio-setting-error").forEach(n => n.classList.remove("audio-setting-error")); };
    api.markError = (setting, message) => {
      api.clearErrors();
      const line = rows.get(setting) || rows.get(String(setting).split(".")[0]);
      if (!line) return;
      if (line.closest(".audio-settings-advanced")) api.open?.();
      line.classList.add("audio-setting-error");
      const note = document.createElement("p"); note.className = "settings-hint audio-setting-message"; note.setAttribute("role", "alert"); note.textContent = message;
      line.after(note); errors.push(note);
      line.querySelector("input, textarea, button")?.focus();
    };
    if (focused) rows.get(focused)?.querySelector("input, textarea, button")?.focus();
    return api;
  }
  /** One setting's row: label (its description as the tip), the control, and Reset when it is set. */
  function settingControl({ path, prop }, value, change) {
    const id = "audio-ms-" + Math.random().toString(36).slice(2, 9);
    const line = document.createElement("div"); line.className = "setting-row audio-setting"; line.dataset.setting = path.join(".");
    const label = document.createElement("label"); label.textContent = prop.title || path[path.length - 1]; label.htmlFor = id;
    if (prop.description) { label.dataset.tooltip = prop.description; label.setAttribute("aria-description", prop.description); }
    const types = [].concat(prop.type || []), base = types.find(t => t !== "null") || "string";
    const choices = Array.isArray(prop.oneOf) ? prop.oneOf.filter(c => c && "const" in c).map(c => [c.const, c.title ?? String(c.const ?? "Default")])
      : Array.isArray(prop.enum) ? prop.enum.map(v => [v, v === null ? "Default" : String(v)]) : null;
    const control = prop["x-control"] || (choices ? "select" : base === "boolean" ? "toggle" : base === "number" || base === "integer" ? "number" : "text");
    const current = value !== undefined ? value : prop.default;
    const unit = prop["x-unit"] ? " " + prop["x-unit"] : "";
    const box = document.createElement("div"); box.className = "audio-setting-control";
    let input;
    const num = text => { if (text === "") return types.includes("null") ? null : undefined; const n = Number(text); return Number.isFinite(n) ? (base === "integer" ? Math.round(n) : n) : undefined; };
    if (control === "slider" && typeof prop.minimum === "number" && typeof prop.maximum === "number") {
      box.classList.add("orb-settings-size");
      input = document.createElement("input"); input.type = "range"; input.className = "orb-range"; input.id = id;
      input.min = String(prop.minimum); input.max = String(prop.maximum);
      input.step = String(prop["x-step"] ?? (base === "integer" ? 1 : (prop.maximum - prop.minimum) / 100));
      input.value = String(typeof current === "number" ? current : (prop.minimum + prop.maximum) / 2);
      const out = document.createElement("output"); out.htmlFor = id;
      const paint = () => { out.value = input.value + unit; input.style.setProperty("--fill", ((Number(input.value) - prop.minimum) / (prop.maximum - prop.minimum) * 100) + "%"); };
      input.addEventListener("input", paint);
      input.addEventListener("change", () => change(num(input.value)));
      const ends = Array.isArray(prop["x-ends"]) ? prop["x-ends"] : null;
      if (ends) {
        const end = text => { const node = document.createElement("span"); node.className = "audio-setting-end"; node.textContent = text; return node; };
        box.classList.add("audio-setting-ends"); box.append(end(ends[0]), input, end(ends[1]), out);
      } else box.append(input, out);
      paint();
    } else if (control === "toggle" || (base === "boolean" && control !== "select" && control !== "segmented")) {
      input = document.createElement("button"); input.type = "button"; input.id = id; input.className = "pill-toggle";
      input.setAttribute("role", "switch"); input.setAttribute("aria-checked", String(current === true));
      input.addEventListener("click", () => { const on = input.getAttribute("aria-checked") !== "true"; input.setAttribute("aria-checked", String(on)); change(on); });
      box.append(input);
    } else if ((control === "segmented" || control === "select") && (choices || base === "boolean")) {
      const list = choices || [[true, "On"], [false, "Off"]];
      if (control === "segmented") {
        input = document.createElement("div"); input.className = "ag-seg small"; input.id = id; input.setAttribute("role", "radiogroup");
        input.setAttribute("aria-label", label.textContent);
        for (const [v, text] of list) {
          const on = JSON.stringify(v) === JSON.stringify(current ?? null);
          const b = button(text, () => change(v), "ag-seg-btn" + (on ? " on" : ""));
          b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(on));
          input.append(b);
        }
        box.append(input);
      } else {
        input = document.createElement("select"); input.id = id; input.setAttribute("aria-label", label.textContent);
        list.forEach(([v, text]) => option(input, JSON.stringify(v), text));
        const now = JSON.stringify(current ?? null);
        if (!list.some(([v]) => JSON.stringify(v) === now)) option(input, now, String(current) + " (saved)");
        input.value = now;
        input.addEventListener("change", () => change(JSON.parse(input.value)));
        box.append(input);
        window.createSelect(input).classList.add("audio-control");
        label.htmlFor = `${id}-button`;
      }
    } else if (control === "textarea") {
      line.classList.add("setting-row-stacked");
      input = document.createElement("textarea"); input.id = id; input.className = "ag-input audio-control audio-setting-text"; input.rows = 3;
      input.value = typeof current === "string" ? current : ""; if (prop.maxLength) input.maxLength = prop.maxLength;
      input.addEventListener("change", () => change(input.value === "" && types.includes("null") ? null : input.value));
      box.append(input);
    } else if (control === "number" || base === "number" || base === "integer") {
      input = document.createElement("input"); input.type = "number"; input.id = id; input.className = "ag-input audio-control";
      if (typeof prop.minimum === "number") input.min = String(prop.minimum);
      if (typeof prop.maximum === "number") input.max = String(prop.maximum);
      input.step = String(prop["x-step"] ?? (base === "integer" ? 1 : "any"));
      input.value = typeof current === "number" ? String(current) : "";
      if (prop.default !== undefined && prop.default !== null) input.placeholder = String(prop.default);
      input.addEventListener("change", () => change(num(input.value)));
      box.append(input);
      if (unit) { const u = document.createElement("span"); u.className = "audio-setting-end"; u.textContent = unit.trim(); box.append(u); }
    } else {
      input = document.createElement("input"); input.type = "text"; input.id = id; input.className = "ag-input audio-control";
      input.value = typeof current === "string" ? current : ""; if (prop.maxLength) input.maxLength = prop.maxLength;
      if (typeof prop.default === "string" && prop.default) input.placeholder = prop.default;
      input.addEventListener("change", () => change(input.value === "" && types.includes("null") ? null : input.value || undefined));
      box.append(input);
    }
    if (input.getAttribute && !input.getAttribute("aria-label")) input.setAttribute("aria-label", label.textContent);
    if (value !== undefined) {
      const reset = button("↺", () => change(undefined), "audio-setting-reset");
      reset.setAttribute("aria-label", `Reset ${label.textContent}`);
      reset.dataset.tooltip = prop.default !== undefined ? `Reset to the default (${String(prop.default ?? "automatic")})` : "Reset to the default";
      // Before the control, so the controls' right edges stay in line with the rows around them.
      box.prepend(reset);
    }
    line.append(label, box);
    return line;
  }
  /** Saves one setting of the chosen source, or This browser's own voice and speed. */
  function saveSpeechSetting(changes) {
    const tts = view.tts || {};
    saving = saving.then(async () => {
      if (tts.source === BROWSER) await request("settings", "PUT", { tts: changes });
      else if (tts.source) await request("tts-sources/" + encodeURIComponent(tts.source), "PUT", changes);
      await refresh();
    }).catch(err => { speechStatus.textContent = err.message; });
  }
  const speedValue = () => { const n = Number(ttsSpeed.value); return Number.isFinite(n) && n > 0 ? n : 1; };
  // A new model has its own voices and may not stream.
  const modelChanged = value => {
    const info = ttsModels.find(m => m.id === value) || (!value && ttsModels.find(m => m.default));
    saveSpeechSetting({ model: value, ...(info?.streaming ? {} : { stream: false }) });
  };
  ttsModel.addEventListener("change", () => modelChanged(ttsModel.value));
  ttsModelText.addEventListener("change", () => modelChanged(ttsModelText.value.trim()));
  ttsVoice.addEventListener("change", () => saveSpeechSetting({ voice: ttsVoice.value }));
  ttsVoiceText.addEventListener("change", () => saveSpeechSetting({ voice: ttsVoiceText.value.trim() }));
  ttsSpeed.addEventListener("change", () => saveSpeechSetting({ speed: speedValue() }));
  ttsStream.addEventListener("change", () => saveSpeechSetting({ stream: ttsStream.getAttribute("aria-checked") === "true" }));

  /** Resolves once saves and the renders after them are done (tests wait on it). */
  async function settled() {
    for (let seen = null; seen !== saving;) { seen = saving; await saving; await rendering; }
  }
  window.scribeAudioSettings = { sections: [section, speech, sounds], refresh, receiveOutput, settled, init({ confirm }) { if (confirm) confirmRemove = confirm; } };
})();
