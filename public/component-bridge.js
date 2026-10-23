/** Self-contained: serialized into the opaque-origin document. */
function componentBridge(initialLocal, initialProps = {}, hasPlugin = false, initialReplyState = {}) {
    let port;
    let next = 0;
    const waiting = new Map();
    const queued = [];
    const send = (message) => { if (port)
        port.postMessage(message);
    else
        queued.push(message); };
    const call = (action, data) => new Promise((resolve, reject) => {
        if (window.__SCRIBE_CAPTURE__) { resolve({ ok: false, error: "capture" }); return; }
        const id = ++next;
        waiting.set(id, { resolve, reject });
        send({ id, action, ...data });
    });
    let local = initialLocal;
    const stateListeners = new Map(), eventListeners = new Map();
    const revisions = new Map();
    function deliverState(key, result, listener) {
        if ((revisions.get(key) ?? -1) > result.revision) return;
        revisions.set(key, result.revision);
        for (const fn of listener ? [listener] : stateListeners.get(key) || []) fn(result.value, result.revision);
    }
    const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
    let replyState = freeze(initialReplyState);
    let listening = false;
    function listen() { if (!listening) { listening = true; void call("plugin-listen", {}).catch(error => { listening = false; console.error(error); }); } }
    function on(map, key, fn, op) {
        if (typeof fn !== "function") throw new Error("Provide a listener.");
        let active = true;
        const wrapped = (...args) => { if (active) fn(...args); };
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(wrapped);
        // Validate the declaration before any event is delivered.
        void call("plugin", op).then(result => { if (!active) return; if (map === stateListeners) deliverState(key, result, wrapped); listen(); }).catch(error => { map.get(key)?.delete(wrapped); console.error(error); });
        return () => { active = false; map.get(key)?.delete(wrapped); if (!map.get(key)?.size) map.delete(key); if (!stateListeners.size && !eventListeners.size && listening) { listening = false; void call("plugin-unlisten", {}); } };
    }
    const api = {
        props: freeze(initialProps),
        get replyState() { return replyState; },
        ...(hasPlugin ? { plugin: {
            call(method, args = {}) { return call("plugin", { op: "call", method, args }); },
            state: {
                get(key) { return call("plugin", { op: "state", key }); },
                on(key, fn) { return on(stateListeners, key, fn, { op: "state", key }); },
            },
            on(event, fn) { return on(eventListeners, event, fn, { op: "subscribe", event }); },
        } } : {}),
        get local() { return local; },
        setLocal(patch) { local = { ...local, ...patch }; return call("local", { local }); },
        reply(data, options = {}) { return call("reply", { data, summary: options.summary ?? "" }); },
        setSummary(summary) { return call("summary", { summary }); },
        open(link) { return call("open", { link }); },
        signal() {}, // kit's page-only fallback is intentionally unavailable in components.
    };
    Object.defineProperty(window, "scribe", { value: api, writable: false });
    window.__scribeComponentReport = report => send({ action: "problems", report });
    window.__scribeWatchProblems?.();
    window.addEventListener("message", function init(event) {
        if (event.source !== parent || event.data?.type !== "scribe-component-init" || !event.ports[0] || port)
            return;
        port = event.ports[0];
        window.removeEventListener("message", init);
        port.onmessage = ({ data }) => {
            if (data.type === "theme") {
                for (const [key, value] of Object.entries(data.vars))
                    document.documentElement.style.setProperty(key, String(value));
                document.documentElement.style.colorScheme = data.scheme;
                document.documentElement.style.visibility = "visible";
            }
            else if (data.type === "plugin-disconnected") {
                listening = false;
            }
            else if (data.type === "plugin-event") {
                for (const fn of eventListeners.get(data.name) || []) fn(data.data);
            }
            else if (data.type === "plugin-state" || data.type === "plugin-ready") {
                const keys = data.type === "plugin-ready" ? [...stateListeners.keys()] : [data.key];
                for (const key of keys) if (stateListeners.has(key)) void api.plugin.state.get(key).then(result => {
                    deliverState(key, result);
                }).catch(console.error);
            }
            else if (data.type === "reply-state") {
                replyState = freeze(data.replyState);
                window.dispatchEvent(new Event("scribe-reply-state"));
            }
            else if (data.type === "state")
                local = data.local;
            else {
                const request = waiting.get(data.id);
                if (!request)
                    return;
                waiting.delete(data.id);
                if (data.error)
                    request.reject(new Error(data.error));
                else
                    request.resolve(data.result);
            }
        };
        for (const message of queued.splice(0))
            port.postMessage(message);
        const measure = () => send({ action: "height", height: Math.max(document.body.scrollHeight, document.body.offsetHeight) });
        new ResizeObserver(measure).observe(document.body);
        measure();
    });
    document.addEventListener("click", event => {
        const anchor = event.target?.closest?.("a[href],a[data-scribe-open]");
        if (anchor) {
            event.preventDefault();
            void api.open(anchor.getAttribute("data-scribe-open") ?? anchor.getAttribute("href") ?? "");
        }
    });
}
