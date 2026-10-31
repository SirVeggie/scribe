/* The Devices category of Settings (#904): this device, paired devices, Add device (a code) and Enter code. */
(function () {
  "use strict";

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label, run, className) => {
    const node = el("button", className, label);
    node.type = "button";
    node.addEventListener("click", run);
    return node;
  };
  const tip = (node, text) => {
    node.dataset.tooltip = text;
    node.setAttribute("aria-description", text);
    return node;
  };
  const section = (title, help) => {
    const node = el("section", "settings-section");
    const heading = el("h3", null, title);
    if (help) {
      const mark = tip(el("button", "search-help", "?"), help);
      mark.type = "button";
      mark.setAttribute("aria-label", `About ${title.toLowerCase()}`);
      heading.append(" ", mark);
    }
    node.append(heading);
    return node;
  };
  const field = (label, value, placeholder) => {
    const wrap = el("label", "ml-field");
    const input = el("input");
    input.type = "text";
    input.value = value || "";
    input.placeholder = placeholder || "";
    input.spellcheck = false;
    input.autocomplete = "off";
    wrap.append(el("span", null, label), input);
    return { wrap, input };
  };

  const selfSection = section(
    "This device",
    "A paired device can do everything here that you can. Devices connect directly over your LAN or a tailnet (Tailscale, WireGuard), with keys swapped when you pair."
  );
  const name = field("Name", "", "e.g. Laptop");
  const idRow = el("div", "setting-row device-detail");
  const fingerprintRow = el("div", "setting-row device-detail");
  // An always-on device (#910) also accepts connections from the internet, so others can relay through it.
  const publicField = field("Public address", "", "Only on an always-on device, e.g. scribe.example.com");
  const publicHint = el("p", "settings-hint");
  publicHint.hidden = true;
  selfSection.append(name.wrap, idRow, fingerprintRow, publicField.wrap, publicHint);

  // The offline mirror (#910): this device's catalog and open tabs, kept on a device that stays on.
  const mirrorSection = section(
    "Offline mirror",
    "A read-only copy that other devices can open while this one is off: the Library's titles, every page that is a tab in a space, and the pages in folders you mark Mirrored."
  );
  const mirrorWrap = el("label", "ml-field");
  const mirrorSelect = el("select");
  mirrorSelect.id = "device-mirror-to";
  mirrorWrap.append(el("span", null, "Mirror to"), mirrorSelect);
  const mirrorStatus = el("p", "settings-hint");
  const heldStatus = el("p", "settings-hint");
  mirrorSection.append(mirrorWrap, mirrorStatus, heldStatus);
  let mirrorPicker = null;
  let mirror = null;

  const pairedSection = section("Paired devices");
  const list = el("div", "device-list");
  const status = el("p", "settings-hint ml-status");
  status.setAttribute("role", "status");
  const panel = el("div", "device-panel");
  panel.hidden = true;
  const actions = el("div", "settings-actions device-actions");
  const addButton = button("Add device", () => addDevice());
  const enterButton = button("Enter code", () => enterCode());
  actions.append(addButton, enterButton);
  pairedSection.append(list, status, panel, actions);

  let view = null;
  let confirmRevoke = async () => true;
  let countdown = 0;
  /** What the panel shows: null, "offer", "enter", or a pairing result. */
  let showing = null;

  async function request(method, path, body) {
    const response = await fetch(`/api/devices${path}`, method === "GET" ? {} : {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
    });
    let result = null;
    try { result = await response.json(); } catch { /* an older daemon answers with a page */ }
    if (!result || (response.status === 404 && !result.error)) throw new Error("Restart Scribe to pair devices.");
    if (!response.ok) throw new Error(result.error || "Could not update devices");
    return result;
  }
  const say = (text) => { status.textContent = text; };

  async function mirrorRequest(method, body) {
    const response = await fetch("/api/mirror", method === "GET" ? {} : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    let result = null;
    try { result = await response.json(); } catch { /* an older daemon */ }
    if (!result || (response.status === 404 && !result.error)) throw new Error("Restart Scribe to use the mirror.");
    if (!response.ok) throw new Error(result.error || "Could not update the mirror");
    return result;
  }

  function renderMirror() {
    // Another device's UI shows this device's list of devices, so its mirror settings would not match it.
    mirrorSection.hidden = !view || !!view.viewing;
    if (mirrorSection.hidden || !mirror) return;
    const options = [["", "None"], ...view.peers.map((peer) => [peer.id, peer.name])];
    mirrorSelect.replaceChildren(...options.map(([value, label]) => {
      const option = el("option", null, label);
      option.value = value;
      return option;
    }));
    mirrorSelect.value = mirror.to || "";
    if (!mirrorPicker) mirrorPicker = window.createSelect ? window.createSelect(mirrorSelect) : null;
    else mirrorPicker.syncSelect?.();
    const target = view.peers.find((peer) => peer.id === mirror.to);
    mirrorStatus.textContent = !mirror.to ? ""
      : mirror.error ? `Not synced: ${mirror.error}`
      : mirror.at ? `Synced ${ago(mirror.at)} · ${mirror.pages} page${mirror.pages === 1 ? "" : "s"} in full`
      : target && !target.online ? `${target.name} is offline; it syncs when it is back.`
      : "Syncing…";
    mirrorStatus.hidden = !mirrorStatus.textContent;
    const held = mirror.held || [];
    heldStatus.textContent = held.length ? `Keeps a mirror of ${held.map((m) => `${m.name} (${ago(m.at)})`).join(", ")}.` : "";
    heldStatus.hidden = !held.length;
  }

  function refreshMirror() {
    mirrorRequest("GET").then((next) => { mirror = next; renderMirror(); }).catch(() => { mirrorSection.hidden = true; });
  }

  mirrorSelect.addEventListener("change", async () => {
    try {
      mirror = { ...mirror, ...(await mirrorRequest("PUT", { to: mirrorSelect.value || null })) };
      renderMirror();
      window.scribeMirrorRefresh?.();
      window.setTimeout(refreshMirror, 1500);
    } catch (err) { say(err.message); refreshMirror(); }
  });

  function ago(at) {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(at).toLocaleDateString();
  }

  /** What that device's agents may do on this one (#911); each box saves at once. */
  function agentRow(peer) {
    const row = el("div", "device-agents");
    row.append(el("span", null, "Its agents may"));
    const grant = peer.agents || {};
    for (const [key, label] of [["read", "Read pages"], ["write", "Change pages"], ["run", "Run helpers"]]) {
      const box = el("input");
      box.type = "checkbox";
      box.checked = grant[key] === true;
      box.addEventListener("change", async () => {
        try { render(await request("PUT", `/${encodeURIComponent(peer.id)}/agents`, { [key]: box.checked })); } catch (err) { box.checked = !box.checked; say(err.message); }
      });
      const check = el("label", "ag-check");
      check.append(box, el("span", null, label));
      row.append(check);
    }
    return row;
  }

  function render(next) {
    view = next;
    if (document.activeElement !== name.input) name.input.value = view.self.name;
    idRow.replaceChildren(el("span", null, "ID"), el("code", null, view.self.id));
    fingerprintRow.replaceChildren(el("span", null, "Fingerprint"), el("code", null, view.self.fingerprint));
    if (document.activeElement !== publicField.input) publicField.input.value = view.self.public?.host || "";
    publicHint.textContent = view.self.public ? `Listening on every network interface, port ${view.self.port}. Open that port in the firewall or router.` : "";
    publicHint.hidden = !view.self.public;

    list.replaceChildren();
    if (!view.peers.length) list.append(el("p", "settings-hint", "None yet."));
    for (const peer of view.peers) {
      const row = el("div", "setting-row ml-source");
      const dot = el("span", `device-dot${peer.online ? " online" : ""}`);
      dot.setAttribute("aria-hidden", "true");
      const text = el("span", "ml-source-text");
      const state = peer.online
        ? `online${peer.via ? ` · via ${peer.via.name}` : ""}${peer.rtt !== undefined ? ` · ${peer.rtt} ms` : ""}`
        : peer.mirror ? `offline · mirror on ${peer.mirror.name}, ${ago(peer.mirror.at)}`
        : peer.lastSeen ? `last seen ${ago(peer.lastSeen)}` : "not seen yet";
      const detail = el("span", "ml-source-detail", ` ${state}`);
      if (peer.error) tip(detail, peer.error).classList.add("setting-hinted");
      text.append(el("strong", null, peer.name), detail);
      const revoke = button("Revoke", async () => {
        if (!(await confirmRevoke(`Revoke “${peer.name}”? It and your other paired devices drop each other's keys; pairing again needs a new code.`, "Revoke"))) return;
        try { render(await request("DELETE", `/${encodeURIComponent(peer.id)}`)); } catch (err) { say(err.message); }
      });
      tip(text, `Fingerprint ${peer.fingerprint}`);
      // Its own UI in this window, through this device's gateway (#905). The list is this device's in
      // every view (#906), so the row of the device being viewed takes you back home.
      const home = peer.id === view.viewing;
      const port = location.port ? `:${location.port}` : "";
      const open = button(home ? "Back" : "Open", () => { location.href = home ? `${location.protocol}//127.0.0.1${port}/` : `${location.protocol}//d-${peer.id}.localhost${port}/`; });
      open.disabled = !peer.online && !home && !peer.mirror;
      row.append(dot, text, open, revoke);
      list.append(row, agentRow(peer));
    }
    if (showing === "offer") {
      if (view.offer) renderOffer();
      else closePanel();
    }
    renderMirror();
  }

  function closePanel() {
    clearInterval(countdown);
    showing = null;
    panel.hidden = true;
    panel.replaceChildren();
    actions.hidden = false;
  }

  function openPanel(kind, children) {
    clearInterval(countdown);
    showing = kind;
    panel.replaceChildren(...children);
    panel.hidden = false;
    actions.hidden = true;
  }

  async function addDevice() {
    say("");
    addButton.disabled = true;
    try {
      const result = await request("POST", "/offer");
      view = { ...view, offer: result.offer };
      showing = "offer";
      renderOffer();
    } catch (err) { say(err.message); }
    addButton.disabled = false;
  }

  function renderOffer() {
    const offer = view.offer;
    if (panel.dataset.code === offer.code && showing === "offer" && !panel.hidden) return;
    const qr = el("div", "device-qr");
    // The daemon draws the QR code itself (src/devices/qr.ts); no page content reaches this markup.
    qr.innerHTML = offer.qr;
    qr.setAttribute("role", "img");
    qr.setAttribute("aria-label", "QR code of the pairing code");
    const code = el("code", "device-code", offer.code);
    const expiry = el("p", "settings-hint");
    const tick = () => {
      const left = Math.max(0, Math.round((offer.expiresAt - Date.now()) / 1000));
      expiry.textContent = `On the other device: Settings → Devices → Enter code, or scribe pair <code>. Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}.`;
      if (!left) closePanel();
    };
    const row = el("div", "settings-actions");
    row.append(
      button("Copy code", () => navigator.clipboard?.writeText(offer.code).then(() => say("Copied the code."), () => say("Could not copy."))),
      el("span", "ml-grow"),
      button("Cancel", async () => {
        closePanel();
        try { render(await request("DELETE", "/offer")); } catch (err) { say(err.message); }
      }),
    );
    openPanel("offer", [qr, code, expiry, row]);
    panel.dataset.code = offer.code;
    tick();
    countdown = window.setInterval(tick, 1000);
  }

  function enterCode() {
    say("");
    const code = field("Code", "", "From Add device on the other device");
    const error = el("p", "settings-hint ml-form-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const form = el("form", "ml-source-form");
    const pair = el("button", "primary", "Pair");
    pair.type = "submit";
    const row = el("div", "settings-actions");
    row.append(el("span", "ml-grow"), button("Cancel", closePanel), pair);
    form.append(code.wrap, error, row);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      pair.disabled = true;
      error.hidden = true;
      try {
        const result = await request("POST", "/pair", { code: code.input.value });
        showPaired(result);
        refresh();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
      pair.disabled = false;
    });
    delete panel.dataset.code;
    openPanel("enter", [form]);
    code.input.focus();
  }

  /** After pairing, on either side: the words to compare, and the offer to connect the other devices. */
  function showPaired(result) {
    const words = el("p", "device-words");
    words.append(`Paired with ${result.device.name}. Check that it shows the same words: `, el("strong", null, result.words.join(" ")));
    const row = el("div", "settings-actions");
    const others = result.others || [];
    if (others.length) {
      const names = others.map((o) => o.name).join(", ");
      const connect = button(`Connect it to ${names} too`, async () => {
        connect.disabled = true;
        try {
          const done = await request("POST", `/${encodeURIComponent(result.device.id)}/introduce`, {});
          say(done.introduced ? `Introduced ${result.device.name} to ${names}.` : `${names} ${others.length > 1 ? "are" : "is"} offline; try again when ${others.length > 1 ? "they are" : "it is"} on.`);
          if (done.introduced) closePanel();
        } catch (err) { say(err.message); }
        connect.disabled = false;
      });
      row.append(connect);
    }
    row.append(el("span", "ml-grow"), button("Done", closePanel));
    delete panel.dataset.code;
    openPanel(result, [words, row]);
  }

  async function saveName() {
    const value = name.input.value.trim();
    if (!view || !value || value === view.self.name) {
      if (view) name.input.value = view.self.name;
      return;
    }
    try { render(await request("PUT", "/self", { name: value })); say(""); } catch (err) { say(err.message); }
  }
  name.input.addEventListener("change", saveName);
  publicField.input.addEventListener("change", async () => {
    try { render(await request("PUT", "/public", { host: publicField.input.value.trim() || null })); say(""); } catch (err) { say(err.message); }
  });
  publicField.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") publicField.input.blur();
  });
  name.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") name.input.blur();
  });

  function refresh() {
    request("GET", "").then(render).catch((err) => say(err.message));
    refreshMirror();
  }

  window.scribeDevicesSettings = {
    sections: [selfSection, pairedSection, mirrorSection],
    /** `confirm(message, label)` resolves true when the user agrees to revoke a device. */
    init({ confirm }) {
      if (confirm) confirmRevoke = confirm;
    },
    refresh,
    /** The daemon's device_paired event: this device's code was used. */
    paired(result) {
      showPaired(result);
      refresh();
    },
  };
})();
