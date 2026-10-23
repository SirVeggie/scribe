/* Opaque-origin chat components. The shell owns persistence, links and sending messages. */
(() => {
  const live = new Set();
  const heights = new Map();
  const attached = new WeakMap();
  const app = () => window.scribeApp;
  const base = item => `/threads/${encodeURIComponent(item.threadId)}/components/${encodeURIComponent(item.id)}`;
  async function api(method, path, body) {
    const response = await fetch(`/api/agent${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Component request failed");
    return result;
  }
  function url(item) {
    return `${location.protocol}//w-it-${item.id.slice(3)}.localhost:${location.port}/component/${item.id}?thread=${encodeURIComponent(item.threadId)}`;
  }
  function theme(frame, port) {
    const style = getComputedStyle(frame.closest(".ag-component") || document.documentElement);
    const vars = {};
    for (const key of ["--bg", "--text", "--muted", "--border", "--accent", "--code-bg"]) vars[key] = style.getPropertyValue(key);
    port.postMessage({ type: "theme", vars, scheme: style.colorScheme || "dark" });
  }
  function attach(frame, item, { expanded = false } = {}) {
    attached.get(frame)?.();
    frame.parentElement?.querySelector(".ag-component-disconnected")?.remove();
    let port, loaded = false, disposed = false, lastReply = 0, lastOpen = 0, events;
    const requests = new AbortController();
    let writeTimer, writing = Promise.resolve(), localWrites = 0;
    const queued = new Map();
    const entry = { frame, item, dispose, update };
    live.add(entry);
    attached.set(frame, dispose);
    frame.sandbox = "allow-scripts";
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
    function update(next) {
      entry.item = { ...next, height: entry.item.height };
      sendReplyState();
      if (!queued.has("local") && !localWrites) port?.postMessage({ type: "state", local: next.local || {} });
    }
    function sendReplyState() { port?.postMessage({ type: "reply-state", replyState: { status: entry.item.status, summary: entry.item.summary } }); }
    function respond(id, result, error) { if (!disposed) port?.postMessage({ id, result, error }); }
    function flush() {
      clearTimeout(writeTimer);
      writeTimer = null;
      const batch = [...queued.values()];
      queued.clear();
      if (batch.some(request => request.data.action === "local")) localWrites++;
      writing = writing.then(async () => {
        for (const request of batch) {
          try {
            const result = await api("POST", base(entry.item), request.data);
            for (const id of request.ids) respond(id, result);
          } catch (error) { for (const id of request.ids) respond(id, undefined, error.message); }
        }
        if (batch.some(request => request.data.action === "local")) localWrites--;
      });
      return writing;
    }
    function queueWrite(data) {
      const previous = queued.get(data.action);
      const ids = previous?.ids || [];
      if (ids.length >= 100) throw new Error("Component updates are too frequent.");
      ids.push(data.id);
      queued.set(data.action, { data, ids });
      // A fixed window coalesces continuous typing without starving persistence.
      if (!writeTimer) writeTimer = setTimeout(flush, 400);
    }
    function dispose() {
      if (disposed) return;
      void flush();
      disposed = true;
      port?.close();
      events?.close();
      requests.abort();
      frame.removeEventListener("load", load);
      live.delete(entry);
    }
    function load() {
      if (loaded) {
        dispose();
        frame.replaceWith(document.createTextNode("Component navigated away. Reopen the chat to reload it."));
        return;
      }
      loaded = true;
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = async ({ data }) => {
        if (disposed || !frame.isConnected || !data || typeof data !== "object") return;
        if (data.action === "height") {
          if (!expanded && Number.isFinite(data.height)) {
            const height = Math.max(entry.item.height?.min || 64, Math.min(entry.item.height?.max || 480, data.height));
            frame.style.height = `${height}px`;
            frame.parentElement.style.minHeight = `${height}px`;
            heights.set(item.id, height);
            if (heights.size > 500) heights.delete(heights.keys().next().value);
          }
          return;
        }
        if (data.action === "problems") { void api("POST", base(entry.item), { action: "problems", report: data.report }).catch(() => {}); return; }
        const id = data.id;
        try {
          if (data.action === "reply" || data.action === "open") {
            // Activation propagates from a child frame to its ancestors; a widget cannot mint it.
            if (!navigator.userActivation?.isActive || document.activeElement !== frame) throw new Error("Click the component to continue.");
            if (data.action === "reply" && Date.now() - lastReply < 5000) throw new Error("This click has already sent a reply.");
            // Activation stays active for seconds, so one click must not open a burst of links.
            if (data.action === "open") { if (Date.now() - lastOpen < 1000) throw new Error("This click has already opened a link."); lastOpen = Date.now(); }
          }
          let result;
          if (data.action === "plugin") {
            const response = await fetch(`/api/agent${base(entry.item)}/plugin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), signal: requests.signal });
            result = await response.json();
            if (!response.ok) throw new Error(result.error || "Plugin request failed");
          } else if (data.action === "plugin-listen") {
            if (!events) {
              events = new EventSource(`/api/agent${base(entry.item)}/events`);
              events.onmessage = ({ data: raw }) => {
                if (disposed) return;
                const message = JSON.parse(raw);
                if (message.type === "reload") { events.close(); events = null; entry.reload?.(); }
                else port?.postMessage(message.type === "ready" ? { type: "plugin-ready" } : message);
              };
              events.onerror = () => {
                events?.close(); events = null;
                if (disposed) return;
                port?.postMessage({ type: "plugin-disconnected" });
                frame.parentElement?.querySelector(".ag-component-disconnected")?.remove();
                const status = document.createElement("div"); status.className = "ag-tag ag-component-disconnected";
                status.textContent = "Live updates disconnected. Reopen the chat to reconnect.";
                frame.parentElement?.append(status);
              };
            }
            result = { ok: true };
          } else if (data.action === "plugin-unlisten") {
            events?.close(); events = null; result = { ok: true };
          } else if (data.action === "open") {
            result = await api("POST", base(entry.item), { action: "open", link: data.link });
            app()?.openLink(result.link);
          } else if (data.action === "local" || data.action === "summary") {
            queueWrite(data);
            return;
          } else if (data.action === "reply") {
            lastReply = Date.now();
            await flush();
            result = await api("POST", base(entry.item), data);
            if (entry.item.wait && result.ok) {
              entry.item = { ...entry.item, status: "answered", summary: data.summary };
              sendReplyState();
            }
          } else throw new Error("Unsupported component action.");
          if (!disposed) port.postMessage({ id, result });
        } catch (error) { if (!disposed) port.postMessage({ id, error: error.message }); }
      };
      frame.contentWindow.postMessage({ type: "scribe-component-init" }, "*", [channel.port2]);
      sendReplyState();
      entry.theme = () => theme(frame, port);
      theme(frame, port);
    }
    frame.addEventListener("load", load);
    return dispose;
  }
  function render(item, R, mdCtx) {
    const { el, button } = R;
    const node = el("div", "ag-card ag-component");
    node.dataset.itemId = item.id;
    node._plugin = item.plugin;
    const head = el("div", "ag-card-head");
    head.append(el("span", "ag-card-title", item.title || item.component || "Component"), el("span", "ag-tag", item.plugin || "Agent"));
    if (item.status !== "shown" && item.status !== "pending") head.append(el("span", "ag-tag", item.status));
    const expand = button("⤢", "ag-btn tiny", async () => {
      try { const result = await api("POST", `${base(item)}/expand`, {}); app()?.openLink(result.key); }
      catch (error) { app()?.showNotice(error.message); }
    });
    expand.setAttribute("aria-label", "Expand component");
    expand.dataset.tooltip = "Expand component";
    head.append(expand);
    node.append(head);
    const body = el("div", "ag-component-body");
    body.style.minHeight = `${heights.get(item.id) || 160}px`;
    const fallback = el("div", "ag-md ag-component-fallback");
    R.renderMarkdown(fallback, item.summary ?? item.fallback ?? "", mdCtx);
    node._updateComponent = next => { item = next; R.renderMarkdown(fallback, next.summary ?? next.fallback ?? "", mdCtx); };
    body.append(fallback);
    node.append(body);
    let frame, dispose;
    let observer, cleaned = false, mounting = false, visible = false, generation = 0, pendingMount = false;
    const note = el("div", "ag-tag");
    async function mount() {
      if (mounting) { pendingMount = true; return; }
      if (frame || cleaned || !visible) return;
      mounting = true;
      const token = ++generation;
      try {
        const current = item.plugin ? await api("GET", base(item)) : item;
        if (token !== generation || cleaned || !visible || !node.isConnected) return;
        note.remove();
        body.querySelector(".ag-component-disconnected")?.remove();
        if (current.available === false) { note.textContent = current.reason || "Plugin component unavailable."; body.append(note); fallback.hidden = false; return; }
        frame = document.createElement("iframe");
        frame.title = item.title || item.component || "Agent component";
        frame.style.height = `${heights.get(item.id) || current.height?.min || 160}px`;
        dispose = attach(frame, current);
        for (const entry of live) if (entry.frame === frame) entry.reload = reload;
        frame.src = url(item);
        fallback.hidden = true;
        body.append(frame);
      } catch (error) { note.textContent = error.message; body.append(note); fallback.hidden = false; }
      finally { mounting = false; if (pendingMount) { pendingMount = false; void mount(); } }
    }
    function reload() { generation++; dispose?.(); frame?.remove(); frame = null; fallback.hidden = false; if (mounting) pendingMount = true; else void mount(); }
    node._reloadPlugin = reload;
    const visibility = entries => {
      for (const entry of entries) {
        visible = entry.isIntersecting;
        if (visible && !frame && node.isConnected) {
          void mount();
        } else if (!visible && frame) {
          dispose(); frame.remove(); frame = null; fallback.hidden = false;
        }
      }
    };
    // Resolve the scroller after the card has been inserted into its transcript.
    queueMicrotask(() => {
      if (cleaned || !node.isConnected) return;
      observer = new IntersectionObserver(visibility, { root: node.closest(".ag-scroll"), rootMargin: "900px 0px" });
      observer.observe(body);
    });
    node._disposeComponent = () => { cleaned = true; generation++; observer?.disconnect(); dispose?.(); };
    if (item.status === "pending") {
      const actions = el("div", "ag-card-actions");
      actions.append(button("Skip", "ag-btn small", () => api("POST", base(item), { action: "skip" }).catch(error => app()?.showNotice(error.message))));
      node.append(actions);
    }
    return node;
  }
  // One cleanup pass after DOM reconciliation: removed chats release their ports and observers.
  const observed = new Set();
  const originalRender = render;
  let cleanup;
  new MutationObserver(() => {
    if (cleanup) return;
    cleanup = setTimeout(() => {
      cleanup = null;
      for (const node of observed) if (!node.isConnected) { node._disposeComponent(); observed.delete(node); }
      for (const entry of [...live]) if (!entry.frame.isConnected) entry.dispose();
    }, 200);
  }).observe(document.documentElement, { childList: true, subtree: true });
  // Theme changes do not recreate frames.
  const refreshTheme = () => { for (const entry of live) if (entry.frame.isConnected) entry.theme?.(); };
  new MutationObserver(refreshTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
  window.ScribeComponents = {
    pluginChanged(message) { for (const node of observed) if (message.plugin === "*" || node._plugin === message.plugin) node._reloadPlugin?.(); },
    render(item, R, ctx) { const node = originalRender(item, R, ctx); observed.add(node); return node; },
    update(item) {
      for (const entry of live) if (entry.item.id === item.id) entry.update(item);
      for (const node of observed) if (node.dataset.itemId === item.id) node._updateComponent(item);
    },
    attach, url,
    async attachUrl(frame, raw) {
      const target = new URL(raw);
      const match = /^w-it-([0-9a-f]{12})\.localhost$/.exec(target.hostname);
      if (!match) return false;
      const thread = target.searchParams.get("thread");
      const item = await api("GET", `/threads/${encodeURIComponent(thread)}/components/it_${match[1]}`);
      if (frame.isConnected) {
        if (item.available === false) { frame.replaceWith(document.createTextNode(`${item.summary || item.fallback || ""}\n${item.reason}`)); return true; }
        attach(frame, item, { expanded: true });
        for (const entry of live) if (entry.frame === frame) entry.reload = () => { entry.dispose(); void window.ScribeComponents.attachUrl(frame, raw); };
        frame.src = raw;
      }
      return true;
    },
  };
})();
