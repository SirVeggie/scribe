/** Self-contained: serialized into the opaque-origin document. */
function componentBridge(initialLocal) {
    let port;
    let next = 0;
    const waiting = new Map();
    const queued = [];
    const send = (message) => { if (port)
        port.postMessage(message);
    else
        queued.push(message); };
    const call = (action, data) => new Promise((resolve, reject) => {
        const id = ++next;
        waiting.set(id, { resolve, reject });
        send({ id, action, ...data });
    });
    let local = initialLocal;
    const api = {
        props: Object.freeze({}),
        get local() { return local; },
        setLocal(patch) { local = { ...local, ...patch }; return call("local", { local }); },
        reply(data, options = {}) { return call("reply", { data, summary: options.summary ?? "" }); },
        setSummary(summary) { return call("summary", { summary }); },
        open(link) { return call("open", { link }); },
    };
    Object.defineProperty(window, "scribe", { value: api, writable: false });
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
