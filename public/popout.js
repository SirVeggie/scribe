/**
 * A page in a window of its own (#402). The child window is this same board, opened with
 * ?popout=<page id>: app.js shows only that page there, with the floating chat and no tab strip
 * or sidebars. The window it came from keeps the tab in its strip and tracks the child here.
 *
 * The windows talk over a BroadcastChannel. A child says "open" when it loads (and when asked
 * "who"), so a reloaded main window finds the desktop app's children again. In the browser the
 * children are popups of the main window and close with it.
 */
window.scribePopout = (() => {
  const childId = new URLSearchParams(location.search).get("popout") || null;
  /** The child window that is the agent chat on its own, not a page (#505). Page ids never look like this. */
  const CHAT_ID = "agent-chat";
  /** What the chat window opens with: main writes it before opening the window, which reads it as it loads. */
  const CHAT_HANDOFF_KEY = "scribe.agent.chatWindow";
  const invoke = window.__TAURI__?.core?.invoke || null;
  const channel = "BroadcastChannel" in window ? new BroadcastChannel("scribe-popout") : null;
  /** Main window: page id → the browser popup's window, or null (desktop app, or a popup found again by its "open"). */
  const children = new Map();
  const changeListeners = new Set();
  const requestListeners = new Set();
  const tellListeners = new Set();
  let emitQueued = false;
  let closing = false;

  /** Keep in sync with child_label in desktop/src/main.rs. */
  function labelOf(id) {
    return "child-" + String(id).replace(/[^A-Za-z0-9_-]/g, "_");
  }

  function post(message) {
    channel?.postMessage(message);
  }

  /** Listeners run after the caller is done, once for any number of changes. */
  function emit() {
    if (emitQueued) {
      return;
    }
    emitQueued = true;
    queueMicrotask(() => {
      emitQueued = false;
      for (const listener of changeListeners) {
        listener();
      }
    });
  }

  function forget(id) {
    if (children.delete(id)) {
      emit();
    }
  }

  /**
   * Open `tab` in its own window; `at` is the screen point to put it at (the desktop app).
   * False when the browser blocked the popup.
   */
  function open(tab, at) {
    if (invoke) {
      children.set(tab.id, null);
      // From another device's view (#905) the window opens that device's board, through the gateway.
      invoke("child_window", { action: "open", id: tab.id, title: tab.title || "Scribe", x: at?.x ?? null, y: at?.y ?? null, origin: window.scribeHost?.remote ? location.origin : null }).catch((err) => {
        console.error(err);
        forget(tab.id);
      });
      emit();
      return true;
    }
    const url = `${location.pathname}?popout=${encodeURIComponent(tab.id)}`;
    const win = window.open(url, labelOf(tab.id), "popup,width=960,height=720");
    if (!win) {
      return false;
    }
    children.set(tab.id, win);
    emit();
    return true;
  }

  function focus(id) {
    if (invoke) {
      invoke("child_window", { action: "focus", id }).catch(() => undefined);
      return;
    }
    children.get(id)?.focus();
    post({ type: "focus", id });
  }

  function close(id) {
    const win = children.get(id);
    post({ type: "close", id });
    try {
      win?.close();
    } catch {
      /* the child closes itself on the message */
    }
    forget(id);
  }

  /**
   * Show the agent chat in its own window, with `chat` ({ threadId, draft, composer }) in it. An open
   * chat window takes it over and comes forward. False when the browser blocked the popup.
   */
  function openChat(chat) {
    if (children.has(CHAT_ID)) {
      post({ type: "tell", id: CHAT_ID, message: { type: "chat", chat } });
      focus(CHAT_ID);
      return true;
    }
    try {
      localStorage.setItem(CHAT_HANDOFF_KEY, JSON.stringify(chat));
    } catch {
      /* the window then opens the current thread */
    }
    return open({ id: CHAT_ID, title: "Agent chat" });
  }

  /** The chat window: what it was opened with. The thread stays for a reload; the unsent text is used once. */
  function chatHandoff() {
    try {
      const chat = JSON.parse(localStorage.getItem(CHAT_HANDOFF_KEY) || "null");
      if (chat?.composer) {
        localStorage.setItem(CHAT_HANDOFF_KEY, JSON.stringify({ ...chat, composer: null }));
      }
      return chat && typeof chat === "object" ? chat : null;
    } catch {
      return null;
    }
  }

  function closeSelf() {
    if (closing) {
      return;
    }
    closing = true;
    post({ type: "closed", id: childId });
    if (invoke) {
      invoke("window_action", { action: "close" }).catch(() => window.close());
    } else {
      window.close();
    }
  }

  /** Main window: drive the same panel targets as a tab drag from native client coordinates. */
  function bindDocking({ views, findAnyTab, isDragging }) {
    if (childId || !invoke) return;
    let dockingChild = null;
    addEventListener("scribe:child-drag", async (event) => {
      const { id, x, y, enabled, done } = event.detail || {};
      const valid = enabled && id !== CHAT_ID && children.has(id) && findAnyTab(id) && !isDragging() &&
        Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1;
      if (!valid) {
        if (dockingChild) views.endPageDrag();
        dockingChild = null;
        return;
      }
      if (dockingChild !== id) {
        views.beginPageDrag({ id });
        dockingChild = id;
      }
      const drop = views.updatePageDrag(x * innerWidth, y * innerHeight);
      if (!done) return;
      views.endPageDrag();
      dockingChild = null;
      if (!drop) return;
      close(id);
      await views.dropPage({ id }, drop);
      invoke("child_window", { action: "focus-main", id: "" }).catch(() => undefined);
    });
  }

  if (childId) {
    channel?.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg?.type === "who") {
        post({ type: "open", id: childId });
      } else if (msg?.id !== childId) {
        return;
      } else if (msg.type === "close") {
        closeSelf();
      } else if (msg.type === "focus") {
        window.focus();
      } else if (msg.type === "tell") {
        for (const listener of tellListeners) {
          listener(msg.message);
        }
      }
    });
    addEventListener("pagehide", () => post({ type: "closed", id: childId }));
    post({ type: "open", id: childId });
  } else {
    channel?.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg?.type === "open" && typeof msg.id === "string") {
        if (!children.has(msg.id)) {
          children.set(msg.id, null);
          emit();
        }
      } else if (msg?.type === "closed") {
        forget(msg.id);
      } else if (msg?.type === "request") {
        for (const listener of requestListeners) {
          listener(msg.request);
        }
      }
    });
    // A popup closed from the browser's own buttons may not get to say so.
    setInterval(() => {
      for (const [id, win] of children) {
        if (win?.closed) {
          forget(id);
        }
      }
    }, 1000);
    if (!invoke) {
      addEventListener("pagehide", () => {
        for (const id of [...children.keys()]) {
          close(id);
        }
      });
    }
    post({ type: "who" });
  }

  return {
    childId,
    /** Whether this window is the agent chat on its own. */
    chatChild: childId === CHAT_ID,
    /** Whether pages can go to their own windows from here. */
    supported: Boolean(channel) && !childId,
    desktop: Boolean(invoke),
    has: (id) => children.has(id),
    /** The pages in windows of their own (the chat window is not a page). */
    ids: () => [...children.keys()].filter((id) => id !== CHAT_ID),
    open,
    openChat,
    chatHandoff,
    /** Main → child: what `tell` sent to this window. */
    onTell: (listener) => tellListeners.add(listener),
    focus,
    close,
    closeSelf,
    bindDocking,
    onChange: (listener) => changeListeners.add(listener),
    /** Child → main: something this window cannot do itself (show another page). */
    request: (request) => post({ type: "request", request }),
    onRequest: (listener) => requestListeners.add(listener),
    /** The desktop app's child windows closed by the OS report here by label (desktop/src/layout.rs). */
    windowClosed: (label) => {
      for (const id of children.keys()) {
        if (labelOf(id) === label) {
          forget(id);
        }
      }
    },
    /** Bring the main window forward (the desktop app; a browser tab cannot raise itself). */
    focusMain: () => {
      invoke?.("child_window", { action: "focus-main", id: "" }).catch(() => undefined);
    },
  };
})();
