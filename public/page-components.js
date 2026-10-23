/* Page-owned hosts for isolated plugin components. Injected with the page bridge. */
function mountPageComponents(host) {
  if (customElements.get("scribe-component")) return;
  const live = new Set();
  window.addEventListener("pagehide", () => { for (const el of live) el.dispose?.(); });
  window.addEventListener("pageshow", event => { if (event.persisted) for (const el of live) el.schedule(); });
  class PageComponent extends HTMLElement {
    static observedAttributes = ["plugin", "name", "props"];
    connectedCallback() { live.add(this); this.schedule(); }
    disconnectedCallback() { live.delete(this); clearTimeout(this.pending); this.dispose?.(); }
    attributeChangedCallback() { if (this.isConnected) this.schedule(); }
    schedule() {
      clearTimeout(this.pending);
      if (document.readyState === "loading") {
        if (!this.waitingForDocument) { this.waitingForDocument = true; document.addEventListener("DOMContentLoaded", () => { this.waitingForDocument = false; if (this.isConnected) this.schedule(); }, { once: true }); }
      } else this.pending = setTimeout(() => { if (this.isConnected) this.mount(); }, 0);
    }
    mount() {
      this.dispose?.();
      let disposed = false, port, events, loaded = false, lastReply = 0, lastOpen = 0, mountId;
      const abort = new AbortController();
      const reports = window.__scribeComponentProblems;
      const release = reports?.hold();
      let released = false;
      const finish = () => { if (!released) { released = true; release?.(); } };
      const releaseMount = id => { void fetch(host.base + "/" + id, { method: "DELETE", keepalive: true }).catch(() => {}); };
      const cleanup = () => { disposed = true; abort.abort(); port?.close(); events?.close(); themeObserver.disconnect(); clearTimeout(timeout); if (mountId) releaseMount(mountId); finish(); };
      this.dispose = cleanup;
      const fail = message => {
        if (disposed) return;
        reports?.add("component_error", String(message));
        cleanup();
        const error = document.createElement("div"); error.className = "callout error"; error.setAttribute("role", "alert");
        error.textContent = "Component: " + String(message).slice(0, 300);
        this.replaceChildren(error, ...(this.fallback || []));
      };
      const theme = () => {
        if (!port) return;
        const style = getComputedStyle(this), vars = {};
        for (const key of ["--bg", "--text", "--muted", "--border", "--accent", "--code-bg"]) vars[key] = style.getPropertyValue(key);
        port.postMessage({ type: "theme", vars, scheme: style.colorScheme || "dark" });
      };
      const themeObserver = new MutationObserver(theme);
      themeObserver.observe(document.documentElement, { attributes: true });
      const timeout = setTimeout(() => { if (!loaded) fail("Component did not load."); finish(); }, reports ? 2200 : 10000);
      this.style.display = "block";
      this.fallback ??= Array.from(this.childNodes);
      this.replaceChildren(...this.fallback);
      let props;
      try { props = JSON.parse(this.getAttribute("props") || "{}"); }
      catch { fail("props must be valid JSON."); return; }
      const plugin = this.getAttribute("plugin"), name = this.getAttribute("name");
      async function request(path, body, retry = true) {
        const response = await fetch(host.base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: abort.signal });
        const result = await response.json();
        if (result.error === "permission" && retry && !host.capturing) {
          const permission = await host.allow(plugin);
          if (permission.ok) return request(path, body, false);
        }
        if (!response.ok || result.ok === false) throw new Error(result.error || "Component request failed.");
        return result;
      }
      const local = this.id ? host.local(this.id) : this.local || {};
      void request("", { plugin, component: name, props, local, diagnostics: Boolean(reports), capture: host.capturing }).then(mount => {
        if (disposed) { releaseMount(mount.id); return; }
        mountId = mount.id;
        const frame = document.createElement("iframe");
        frame.title = name || "Plugin component";
        frame.sandbox = "allow-scripts"; frame.referrerPolicy = "no-referrer";
        frame.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
        frame.style.cssText = "display:block;width:100%;border:0";
        frame.style.height = (mount.height?.min || 160) + "px";
        frame.addEventListener("load", () => {
          if (disposed) return;
          if (loaded) { fail("Component navigated away. Reload the page to reconnect."); return; }
          loaded = true;
          const channel = new MessageChannel(); port = channel.port1;
          port.onmessage = async ({ data }) => {
            if (disposed || !frame.isConnected || !data || typeof data !== "object") return;
            if (data.action === "height") {
              if (Number.isFinite(data.height)) frame.style.height = Math.max(mount.height?.min || 64, Math.min(mount.height?.max || 480, data.height)) + "px";
              return;
            }
            if (data.action === "problems") {
              if (data.report?.token !== mount.token || data.report.phase !== "done") return;
              for (const problem of (Array.isArray(data.report.problems) ? data.report.problems : []).slice(0, 8)) {
                if (typeof problem?.code === "string" && typeof problem.message === "string") reports?.add(problem.code, plugin + "/" + name + ": " + problem.message);
              }
              finish(); return;
            }
            try {
              let result;
              if (data.action === "plugin") {
                result = (await request("/" + mount.id + "/plugin", data)).result;
              } else if (data.action === "plugin-listen") {
                await request("/" + mount.id + "/plugin", { op: "listen" });
                if (disposed) return;
                if (!events) {
                  events = new EventSource(host.base + "/" + mount.id + "/events");
                  events.onmessage = event => {
                    if (disposed) return;
                    const message = JSON.parse(event.data);
                    if (message.type === "reload") { fail("Plugin or page permissions changed. Reload the page to reconnect."); return; }
                    port.postMessage(message.type === "ready" ? { type: "plugin-ready" } : message);
                  };
                  events.onerror = () => fail("Live updates disconnected. Reload the page to reconnect.");
                }
                result = { ok: true };
              } else if (data.action === "plugin-unlisten") { events?.close(); events = null; result = { ok: true }; }
              else if (data.action === "local") {
                if (!data.local || typeof data.local !== "object" || Array.isArray(data.local) || JSON.stringify(data.local).length > 65536) throw new Error("Component local state must be an object of at most 64 KiB.");
                this.local = data.local; if (this.id) host.local(this.id, data.local); result = { ok: true };
              }
              else if (data.action === "summary") { result = { ok: true }; }
              else if (data.action === "reply" || data.action === "open") {
                if (!navigator.userActivation?.isActive || document.activeElement !== frame) throw new Error("Click the component to continue.");
                if (data.action === "open") {
                  if (Date.now() - lastOpen < 1000) throw new Error("This click has already opened a link.");
                  lastOpen = Date.now();
                  const checked = (await request("/" + mount.id + "/plugin", { op: "open", link: data.link })).result;
                  result = await host.open(checked.link);
                }
                else {
                  if (Date.now() - lastReply < 5000) throw new Error("This click has already sent a reply.");
                  lastReply = Date.now();
                  const detail = { data: data.data, summary: data.summary };
                  const event = new CustomEvent("scribe-component-reply", { bubbles: true, cancelable: true, detail });
                  if (!this.dispatchEvent(event)) result = { ok: true };
                  else {
                    result = await host.reply(data.data, { summary: data.summary });
                    if (result?.ok === false && /no reply target/i.test(result.error || "")) {
                      host.signal("submitted", { component: this.id || name, answers: data.data, summary: data.summary }); result = { ok: true };
                    }
                  }
                }
              } else throw new Error("Unsupported component action.");
              if (!disposed) port.postMessage({ id: data.id, result });
            } catch (error) { if (!disposed) port.postMessage({ id: data.id, error: error.message }); }
          };
          frame.contentWindow.postMessage({ type: "scribe-component-init" }, "*", [channel.port2]);
          theme();
        });
        // The daemon supplies the isolated origin; page code never supplies frame HTML or a URL.
        frame.src = mount.url;
        this.replaceChildren(frame);
      }).catch(error => { if (!disposed) fail(error.message); });
    }
  }
  customElements.define("scribe-component", PageComponent);
}
