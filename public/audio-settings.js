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
  function editStt(profile) {
    const name = textInput("audio-name", profile?.name, "e.g. Whisper");
    const endpoint = endpointFields("audio", profile);
    const model = textInput("audio-model", profile?.model || "whisper-1", "whisper-1");
    const language = textInput("audio-language", profile?.language, "Auto");
    const streaming = selectInput("audio-streaming", "Live transcription (experimental)",
      [["", "Off"], ["native", "Server stream (Moonshine)"], ["window", "Sliding window"]], profile?.streaming || "");
    const path = profile ? "sources/" + encodeURIComponent(profile.id) : "sources";
    editor({ cls: "audio-stt-editor", title: profile ? `Edit ${profile.name}` : "Add a speech-to-text source",
      fields: [field("Name", name), ...endpoint.nodes, field("Model", model), field("Language", language),
        field("Live transcription (experimental)", streaming, "Shows text while you speak. Server stream needs a Moonshine-style /stream WebSocket; Sliding window works with any endpoint.")],
      selects: [...endpoint.selects, streaming],
      save: () => request(path, profile ? "PUT" : "POST", { name: name.value, ...endpoint.body(), model: model.value, language: language.value, streaming: streaming.value }),
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
        testSource.disabled = true; status.textContent = "Testing…";
        try { const result = await request("test", "POST", { sourceId: profile.id }); status.textContent = result.ok ? "Transcript: " + (result.text || "(empty)") : result.message || result.error; }
        catch (err) { status.textContent = err.message; } finally { testSource.disabled = false; }
      });
      list.append(sourceRow("audio-default-source", { id: profile.id, name: profile.name, checked: profile.id === view.defaultSource,
        label: "Use " + profile.name + " by default", onPick: () => change("settings", "PUT", { defaultSource: profile.id }),
        detail: profile.model + " · " + hostOf(profile) + (profile.streaming ? " · live" : ""),
        buttons: [testSource, button("Edit", () => editStt(profile))] }));
    }
  }
  const send = row("Send after dictation", "send", "switch");
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
      renderSpeech();
      send.setAttribute("aria-checked", String(view.input.sendAfterDictation));
      push.setAttribute("aria-checked", String(view.input.pushToTalk));
      livePreview.setAttribute("aria-checked", String(view.input.livePreview !== false));
      livePreview.closest(".setting-row").hidden = !view.profiles.some(p => p.streaming);
      receiveOutput(view.output);
      status.textContent = "";
      await devices();
    } catch (err) { status.textContent = err.message; }
  }
  let saving = Promise.resolve();
  function save() {
    const body = { input: { sendAfterDictation: send.getAttribute("aria-checked") === "true", pushToTalk: push.getAttribute("aria-checked") === "true",
      livePreview: livePreview.getAttribute("aria-checked") === "true" } };
    saving = saving.then(async () => {
      const res = await fetch("/api/audio/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await res.json(); if (!res.ok) throw new Error(result.error);
      await window.scribeAudio.refresh(); status.textContent = "";
    }).catch(err => { status.textContent = err.message; });
    return saving;
  }
  [send, push, livePreview].forEach(input => input.addEventListener("change", save));
  mic.addEventListener("change", () => window.scribeAudio.setDevice(mic.value));
  navigator.mediaDevices?.addEventListener("devicechange", devices);
  section.append(status);

  /* Notification sounds (#564): saved in the daemon, pushed to every window over /ws. */
  const sounds = document.createElement("section"); sounds.className = "settings-section audio-settings";
  const soundsHeading = document.createElement("h3"); soundsHeading.textContent = "Notification sounds"; sounds.append(soundsHeading);
  const soundsOn = row("Play sounds", "sounds", "switch", sounds);
  const volumeRow = document.createElement("div"); volumeRow.className = "setting-row";
  const volumeLabel = document.createElement("label"); volumeLabel.textContent = "Volume"; volumeLabel.htmlFor = "audio-volume";
  const volumeBox = document.createElement("div"); volumeBox.className = "orb-settings-size";
  const volume = document.createElement("input"); volume.type = "range"; volume.className = "orb-range"; volume.id = "audio-volume";
  volume.min = "0"; volume.max = "100"; volume.step = "5";
  const volumeText = document.createElement("output"); volumeText.htmlFor = volume.id;
  volumeBox.append(volume, volumeText); volumeRow.append(volumeLabel, volumeBox); sounds.append(volumeRow);
  const CUES = [["thread-finish", "When a chat finishes"], ["thread-ask", "When a chat needs you"]];
  const cueSwitches = CUES.map(([name, label]) => {
    const input = row(label, "cue-" + name, "switch", sounds);
    input.after(button("Play", () => window.scribeAudio.play(`/sounds/${name}.wav`, { channel: "cue" })));
    return [name, input];
  });
  const soundsStatus = document.createElement("p"); soundsStatus.className = "settings-hint"; soundsStatus.setAttribute("role", "status");
  sounds.append(soundsStatus);
  const paintVolume = () => { volumeText.value = volume.value + "%"; volume.style.setProperty("--fill", volume.value + "%"); };
  function receiveOutput(output) {
    if (!output) return;
    soundsOn.setAttribute("aria-checked", String(output.sounds));
    volume.value = String(Math.round(output.volume * 100)); paintVolume();
    for (const [name, input] of cueSwitches) input.setAttribute("aria-checked", String(output.cues?.[name] !== false));
    // Volume is the master: it also sets page sounds and speech, so it stays visible.
    for (const line of [...cueSwitches.map(([, input]) => input.closest(".setting-row"))]) line.hidden = !output.sounds;
  }
  function saveOutput() {
    const output = { sounds: soundsOn.getAttribute("aria-checked") === "true", volume: Number(volume.value) / 100,
      cues: Object.fromEntries(cueSwitches.map(([name, input]) => [name, input.getAttribute("aria-checked") === "true"])) };
    receiveOutput(output); window.scribeAudio.setOutput(output);
    saving = saving.then(async () => {
      const res = await fetch("/api/audio/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ output }) });
      const result = await res.json(); if (!res.ok) throw new Error(result.error);
      soundsStatus.textContent = "";
    }).catch(err => { soundsStatus.textContent = err.message; });
  }
  [soundsOn, ...cueSwitches.map(([, input]) => input)].forEach(input => input.addEventListener("change", saveOutput));
  volume.addEventListener("input", () => { paintVolume(); window.scribeAudio.setOutput({ ...window.scribeAudio.output(), volume: Number(volume.value) / 100 }); });
  volume.addEventListener("change", saveOutput);

  /* ---------- text-to-speech sources (Phase D): their own list, with This browser as a free fallback ---------- */
  const speech = document.createElement("section"); speech.className = "settings-section audio-settings";
  speech.append(heading("Text-to-speech", helpButton("About text-to-speech",
    "Pages read text aloud with the chosen source. Hosted sources receive the text and may charge per character. This browser uses its own voices: free, no setup.")));
  const ttsList = document.createElement("div"); ttsList.className = "ml-sources"; speech.append(ttsList);
  const addTts = button("Add source", () => editTts(null)); addTts.setAttribute("aria-label", "Add text-to-speech source");
  const ttsActions = document.createElement("div"); ttsActions.className = "settings-actions"; ttsActions.append(addTts);
  const speechStatus = document.createElement("p"); speechStatus.className = "settings-hint"; speechStatus.setAttribute("role", "status");
  speech.append(ttsActions, speechStatus);
  const speedText = speed => speed && speed !== 1 ? ` · ${speed}×` : "";
  const voiceText = id => id ? window.scribeAudio.voiceName?.(id) || id : "";
  function speedInput(id, value) {
    const node = textInput(id, String(value ?? 1), "1", "number");
    Object.assign(node, { min: "0.25", max: "4", step: "0.05" }); return node;
  }
  const speedOf = node => { const n = Number(node.value); return Number.isFinite(n) && n > 0 ? n : 1; };
  let speaking = null;
  function testButton(sourceId) {
    const node = button("Test", async () => {
      if (speaking) { speaking.stop(); return; }
      speechStatus.textContent = ""; node.textContent = "Stop";
      speaking = window.scribeAudio.speak("This is how Scribe reads text aloud.", { sourceId });
      const result = await speaking.ended; speaking = null; node.textContent = "Test";
      if (!result.ok) speechStatus.textContent = result.message || result.error;
      else void refresh();
    });
    return node;
  }
  /** This browser has no source to set up: only its voice and speed. */
  async function editBrowser() {
    const tts = view.tts || {};
    const voice = selectInput("audio-browser-voice", "Voice", [["", "Default voice"]], "");
    const speed = speedInput("audio-browser-speed", tts.speed);
    editor({ cls: "audio-tts-editor", title: "This browser", hint: "Reads text with the voices built into this browser. Free and local; quality depends on the browser and system.",
      fields: [field("Voice", voice), field("Speed", speed)], selects: [voice],
      save: () => request("settings", "PUT", { tts: { voice: voice.value, speed: speedOf(speed) } }) });
    const list = await window.scribeAudio.voices({ source: "browser" }).catch(() => null);
    const options = [["", "Default voice"], ...(list?.voices || []).map(v => [v.id, v.lang ? `${v.name} (${v.lang})` : v.name])];
    if (tts.voice && !options.some(([v]) => v === tts.voice)) options.push([tts.voice, tts.voice + " (unavailable)"]);
    setOptions(voice, options, tts.voice || "");
  }
  function editTts(profile) {
    const name = textInput("audio-tts-name", profile?.name, "e.g. Kokoro");
    let load = () => {};
    const endpoint = endpointFields("audio-tts", profile, () => load());
    const model = textInput("audio-tts-model", profile?.model, "Server default (e.g. tts-1)");
    // The server's voice list when it has one; a text box when it cannot be read.
    const voice = selectInput("audio-tts-voice", "Voice", [["", "Default voice"]], "");
    const voiceTyped = textInput("audio-tts-voice-text", profile?.voice, "alloy");
    const voiceField = field("Voice", voice), voiceTypedField = field("Voice", voiceTyped);
    voiceTypedField.hidden = true;
    const typedNote = document.createElement("span"); typedNote.className = "ag-field-hint ag-muted"; voiceTypedField.append(typedNote);
    const voiceNote = document.createElement("span"); voiceNote.className = "ag-field-hint ag-muted"; voiceNote.setAttribute("role", "status");
    voiceField.append(voiceNote);
    const speed = speedInput("audio-tts-speed", profile?.speed);
    const streamBox = document.createElement("input"); streamBox.type = "checkbox"; streamBox.id = "audio-tts-stream"; streamBox.checked = Boolean(profile?.stream);
    const stream = document.createElement("label"); stream.className = "ag-check";
    const streamText = document.createElement("span"); streamText.textContent = "Stream while generating";
    streamText.dataset.tooltip = "Sends stream: true so speech starts before the server has finished. Not part of OpenAI's API: turn it on only for servers that support it.";
    streamText.setAttribute("aria-description", streamText.dataset.tooltip);
    stream.append(streamBox, streamText);
    let saved = profile?.voice || "", seq = 0;
    const current = () => voiceTypedField.hidden ? voice.value : voiceTyped.value.trim();
    load = async () => {
      const mine = ++seq, draft = { ...(profile ? { id: profile.id } : {}), ...endpoint.body(), model: model.value.trim() };
      saved = current() || saved;
      if (draft.source === "__custom__" && !draft.custom?.baseUrl) { voiceNote.textContent = ""; return; }
      voiceNote.textContent = "Loading voices…";
      const result = await window.scribeAudio.voices({ source: draft }).catch(() => null);
      if (mine !== seq) return;
      if (!result?.ok) {
        voiceTyped.value = saved; voiceTypedField.hidden = false; voiceField.hidden = true; voiceNote.textContent = "";
        typedNote.textContent = "Cannot list voices: " + (result?.message || "no answer.") + " Type a voice name.";
        return;
      }
      voiceTypedField.hidden = true; voiceField.hidden = false;
      const options = [["", result.default ? `Default (${voiceText(result.default)})` : "Default voice"], ...result.voices.map(v => [v.id, v.name || v.id])];
      if (saved && !options.some(([v]) => v === saved)) options.push([saved, voiceText(saved) + " (saved)"]);
      setOptions(voice, options, saved);
      voiceNote.textContent = result.listed ? "" : "This server lists no voices; these are OpenAI's.";
    };
    model.addEventListener("change", () => load());
    const path = profile ? "tts-sources/" + encodeURIComponent(profile.id) : "tts-sources";
    editor({ cls: "audio-tts-editor", title: profile ? `Edit ${profile.name}` : "Add a text-to-speech source",
      hint: "An OpenAI-compatible /audio/speech endpoint. Voices come from the server's /audio/voices list when it has one.",
      fields: [field("Name", name), ...endpoint.nodes, field("Model", model, "Leave empty to use the model the server has loaded."),
        voiceField, voiceTypedField, field("Speed", speed), stream],
      selects: [...endpoint.selects, voice],
      save: () => request(path, profile ? "PUT" : "POST", { name: name.value, ...endpoint.body(), model: model.value, voice: current(), speed: speedOf(speed), stream: streamBox.checked }),
      remove: profile && (async () => {
        if (!await confirmRemove("Remove “" + profile.name + "”?", "Remove")) return false;
        return change(path, "DELETE", undefined, speechStatus);
      }) });
    void load();
  }
  function renderSpeech() {
    const tts = view.tts || {}, chosen = tts.source || "";
    const pick = source => () => change("settings", "PUT", { tts: { source } }, speechStatus);
    ttsList.replaceChildren(
      sourceRow("audio-tts-source", { id: "", name: "Off", checked: !chosen, label: "Turn text-to-speech off", onPick: pick(""),
        detail: "Pages cannot read text aloud", buttons: [] }),
      sourceRow("audio-tts-source", { id: BROWSER, name: "This browser", checked: chosen === BROWSER, label: "Read aloud with this browser", onPick: pick(BROWSER),
        detail: (voiceText(tts.voice) || "Default voice") + speedText(tts.speed) + " · free",
        buttons: [testButton(BROWSER), button("Edit", () => void editBrowser())] }),
      ...(view.ttsSources || []).map(profile => sourceRow("audio-tts-source", { id: profile.id, name: profile.name, checked: chosen === profile.id,
        label: "Read aloud with " + profile.name, onPick: pick(profile.id),
        detail: (profile.model || "server's model") + " · " + hostOf(profile) + (profile.voice ? " · " + voiceText(profile.voice) : "")
          + speedText(profile.speed) + (profile.stream ? " · streaming" : ""),
        buttons: [testButton(profile.id), button("Edit", () => editTts(profile))] })));
    const chars = view.usage?.chars || 0;
    if (!speaking) speechStatus.textContent = chars ? "Read aloud today: " + chars.toLocaleString() + " characters" : "";
  }

  window.scribeAudioSettings = { sections: [section, speech, sounds], refresh, receiveOutput, init({ confirm }) { if (confirm) confirmRemove = confirm; } };
})();
