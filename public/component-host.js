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
  function safeLink(link) {
    if (typeof link !== "string" || link.length > 8000) return false;
    if (/^scribe:[a-zA-Z0-9_-]+(?:#[^\s]*)?$/.test(link)) return true;
    // File links use Scribe's file viewer and existing access rules, never direct navigation.
    if (/^file:\/\//i.test(link)) return true;
    try {
      const target = new URL(link);
      return ["http:", "https:"].includes(target.protocol) && !["localhost", "127.0.0.1", "127.0.0.2", "[::1]"].includes(target.hostname) && !target.hostname.endsWith(".localhost");
    } catch { return false; }
  }
  function attach(frame, item, { expanded = false } = {}) {
    attached.get(frame)?.();
    let port, loaded = false, disposed = false, lastReply = 0;
    const entry = { frame, item, dispose, update };
    live.add(entry);
    attached.set(frame, dispose);
    frame.sandbox = "allow-scripts";
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
    function update(next) {
      entry.item = next;
      port?.postMessage({ type: "state", local: next.local || {} });
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      port?.close();
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
            const height = Math.max(64, Math.min(480, data.height));
            frame.style.height = `${height}px`;
            frame.parentElement.style.minHeight = `${height}px`;
            heights.set(item.id, height);
            if (heights.size > 500) heights.delete(heights.keys().next().value);
          }
          return;
        }
        const id = data.id;
        try {
          if (data.action === "reply" || data.action === "open") {
            // Activation propagates from a child frame to its ancestors; a widget cannot mint it.
            if (!navigator.userActivation?.isActive || document.activeElement !== frame) throw new Error("Click the component to continue.");
            if (data.action === "reply" && Date.now() - lastReply < 5000) throw new Error("This click has already sent a reply.");
          }
          let result;
          if (data.action === "open") {
            if (!safeLink(data.link)) throw new Error("Unsupported link.");
            app()?.openLink(data.link);
            result = { ok: true };
          } else if (["local", "summary", "reply"].includes(data.action)) {
            if (data.action === "reply") lastReply = Date.now();
            result = await api("POST", base(entry.item), data);
          } else throw new Error("Unsupported component action.");
          if (!disposed) port.postMessage({ id, result });
        } catch (error) { if (!disposed) port.postMessage({ id, error: error.message }); }
      };
      frame.contentWindow.postMessage({ type: "scribe-component-init" }, "*", [channel.port2]);
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
    const head = el("div", "ag-card-head");
    head.append(el("span", "ag-card-title", item.title || "Component"), el("span", "ag-tag", "Agent"));
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
    body.append(fallback);
    node.append(body);
    let frame, dispose;
    let observer, cleaned = false;
    const visibility = entries => {
      for (const entry of entries) {
        if (entry.isIntersecting && !frame && node.isConnected) {
          frame = document.createElement("iframe");
          frame.title = item.title || "Agent component";
          frame.style.height = `${heights.get(item.id) || 160}px`;
          dispose = attach(frame, item);
          frame.src = url(item);
          fallback.hidden = true;
          body.append(frame);
        } else if (!entry.isIntersecting && frame) {
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
    node._disposeComponent = () => { cleaned = true; observer?.disconnect(); dispose?.(); };
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
    clearTimeout(cleanup);
    cleanup = setTimeout(() => {
      for (const node of observed) if (!node.isConnected) { node._disposeComponent(); observed.delete(node); }
      for (const entry of [...live]) if (!entry.frame.isConnected) entry.dispose();
    }, 200);
  }).observe(document.documentElement, { childList: true, subtree: true });
  // Theme changes do not recreate frames.
  const refreshTheme = () => { for (const entry of live) if (entry.frame.isConnected) entry.theme?.(); };
  new MutationObserver(refreshTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
  window.ScribeComponents = {
    render(item, R, ctx) { const node = originalRender(item, R, ctx); observed.add(node); return node; },
    update(item) { for (const entry of live) if (entry.item.id === item.id) entry.update(item); },
    attach, url,
    async attachUrl(frame, raw) {
      const target = new URL(raw);
      const match = /^w-it-([0-9a-f]{12})\.localhost$/.exec(target.hostname);
      if (!match) return false;
      const thread = target.searchParams.get("thread");
      const item = await api("GET", `/threads/${encodeURIComponent(thread)}/components/it_${match[1]}`);
      if (frame.isConnected) { attach(frame, item, { expanded: true }); frame.src = raw; }
      return true;
    },
  };
})();
