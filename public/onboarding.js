/* First-run setup and tour (#962): a few skippable steps over the window, shown once per install. */
(() => {
  const k = (...keys) => keys.map((key) => `<kbd>${key}</kbd>`).join("+");

  /**
   * Each step: a title, a line under it, and either settings rows lent from the settings dialogs
   * (settings-ui.js lend, by the ids settings_find lists), its own body, or both.
   */
  const STEPS = [
    {
      id: "welcome",
      title: "Welcome to Scribe",
      lede: "Your local hub for pages, notes and agent chats. A few steps set it up; each one can be skipped.",
      body: () => tiles([
        ["Pages", "Notes, todo lists, boards and the reports agents make, kept in your Library."],
        ["Chats", "Claude, Codex, Cursor and your own models, working on your pages and code."],
        ["Boards", "Kanban cards that agent workers pick up, work in their own branch and hand in."],
      ]),
    },
    {
      id: "providers",
      title: "Connect your agents",
      lede: "Sign in to the providers you use. Chats can only run on a provider that is ready.",
      settings: ["agent/providers"],
    },
    {
      id: "import",
      title: "Bring your setup",
      lede: "Scribe gives its chats its own list of MCP servers. Copy the ones you already use in Claude Code, Codex or Cursor.",
      body: () => importBody(),
    },
    {
      id: "look",
      title: "Make it yours",
      lede: "A theme, where the sidebars sit, and how messages are sent. All of it is in Settings later.",
      settings: ["general/theme", "general/layout/library-sidebar", "general/layout/agent-sidebar", "agent/chat/send-messages-with", "general/links/page-links-open-as"],
    },
    {
      id: "pages",
      title: "Pages and the Library",
      lede: "Pages open as tabs. Closing a tab keeps the page in the Library.",
      body: () => keys([
        [k("Ctrl", "T"), "New page: start from a template such as Notes, Todo or Kanban, or ask an agent"],
        [k("Ctrl", "B"), "Library: every page, in folders you arrange"],
        [k("Ctrl", "D"), "Search pages and their data; <kbd>=</kbd> searches chats"],
        [k("Ctrl", "E"), "Spaces: named sets of tabs, such as one for home and one for work"],
        [k("Ctrl", "Z"), "Reopen the last closed tab or undo a delete"],
      ]),
    },
    {
      id: "chat",
      title: "Chat with agents",
      lede: "The floating chat follows the page in front, so an agent knows which page you mean.",
      body: () => keys([
        [k("Ctrl", "K"), "Floating chat over the page"],
        [`${k("Ctrl", "L")} / ${k("Ctrl", "Shift", "L")}`, "Chat in the sidebar / full window"],
        [k("Ctrl", "'"), "Next starred model"],
        [k("Ctrl", "Shift", "'"), "Access level: from Read-only up to Full access"],
        [k("Ctrl", "."), "Workspace folder the chat works in"],
      ]),
    },
    {
      id: "help",
      title: "Help is one key away",
      lede: "Ask how to do anything in Scribe, and change settings right in the answer.",
      body: () => {
        const wrap = keys([
          [k("Ctrl", "H"), "Open Help"],
          [k("Ctrl", ","), "Settings, where Help → Setup guide shows these steps again"],
        ]);
        const open = document.createElement("button");
        open.type = "button";
        open.className = "ob-inline-btn";
        open.textContent = "Open Help now";
        open.addEventListener("click", () => {
          finish();
          window.scribeChat?.help.open();
        });
        wrap.append(open);
        return wrap;
      },
    },
  ];

  function tiles(rows) {
    const wrap = document.createElement("div");
    wrap.className = "ob-tiles";
    for (const [title, text] of rows) {
      const tile = document.createElement("div");
      tile.className = "ob-tile";
      const h = document.createElement("strong");
      h.textContent = title;
      const p = document.createElement("p");
      p.textContent = text;
      tile.append(h, p);
      wrap.append(tile);
    }
    return wrap;
  }

  function keys(rows) {
    const wrap = document.createElement("div");
    wrap.className = "ob-keys";
    for (const [combo, text] of rows) {
      const row = document.createElement("div");
      row.className = "ob-key";
      const left = document.createElement("span");
      left.className = "ob-combo";
      left.innerHTML = combo;
      const right = document.createElement("span");
      right.innerHTML = text;
      row.append(left, right);
      wrap.append(row);
    }
    return wrap;
  }

  function importBody() {
    const wrap = document.createElement("div");
    wrap.className = "ob-import";
    const line = document.createElement("p");
    line.className = "ob-muted";
    line.textContent = "Looking for MCP servers…";
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "ob-inline-btn";
    pick.textContent = "Choose servers to import…";
    pick.hidden = true;
    pick.addEventListener("click", () => window.scribeChat?.mcp.importDialog([], () => {}));
    wrap.append(line, pick);
    const mcp = window.scribeChat?.mcp;
    if (!mcp) {
      line.textContent = "The chat is still loading. Agent settings → MCP servers has Import later.";
      return wrap;
    }
    mcp.findImports([]).then((found) => {
      const label = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", pi: "Pi" };
      const sources = [...new Set(found.map((c) => label[c.source] || c.source).filter(Boolean))];
      if (!found.length) {
        line.textContent = "No MCP servers found in your other tools. You can add servers later in Agent settings.";
        return;
      }
      line.textContent = `Found ${found.length} server${found.length === 1 ? "" : "s"}${sources.length ? ` in ${sources.join(", ")}` : ""}. Imported servers ask before each call until you change that.`;
      pick.hidden = false;
    }, (err) => {
      line.textContent = err.message;
    });
    return wrap;
  }

  let root = null;
  let at = 0;
  let parts = null;

  function build() {
    root = document.createElement("div");
    root.className = "ob";
    root.innerHTML = `
      <div class="ob-backdrop"></div>
      <div class="ob-card" role="dialog" aria-modal="true" aria-labelledby="ob-title">
        <div class="ob-top">
          <div class="ob-progress" aria-hidden="true"></div>
          <span class="ob-count"></span>
          <button type="button" class="ob-close" aria-label="Skip setup" data-tooltip="Skip setup"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
        </div>
        <div class="ob-body">
          <h2 class="ob-title" id="ob-title"></h2>
          <p class="ob-lede"></p>
          <div class="ob-content"></div>
        </div>
        <div class="ob-foot">
          <button type="button" class="ob-back">Back</button>
          <button type="button" class="ob-next"></button>
        </div>
      </div>`;
    parts = {
      progress: root.querySelector(".ob-progress"),
      count: root.querySelector(".ob-count"),
      title: root.querySelector(".ob-title"),
      lede: root.querySelector(".ob-lede"),
      content: root.querySelector(".ob-content"),
      body: root.querySelector(".ob-body"),
      back: root.querySelector(".ob-back"),
      next: root.querySelector(".ob-next"),
    };
    for (let i = 0; i < STEPS.length; i++) parts.progress.append(document.createElement("span"));
    root.querySelector(".ob-close").addEventListener("click", finish);
    parts.back.addEventListener("click", () => go(at - 1));
    parts.next.addEventListener("click", () => (at === STEPS.length - 1 ? finish() : go(at + 1)));
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !document.querySelector(".select-menu, .ag-menu")) {
        event.preventDefault();
        event.stopPropagation();
        finish();
      }
    });
    document.body.append(root);
  }

  function go(index) {
    at = Math.max(0, Math.min(STEPS.length - 1, index));
    const step = STEPS[at];
    parts.title.textContent = step.title;
    parts.lede.textContent = step.lede;
    // Replacing the content gives lent settings rows back to their dialogs (settings-ui.js watches for it).
    parts.content.replaceChildren();
    if (step.body) parts.content.append(step.body());
    if (step.settings && window.scribeSettingsUI) {
      const rows = document.createElement("div");
      rows.className = "ob-settings";
      parts.content.append(rows);
      window.scribeSettingsUI.lend(rows, step.settings);
    }
    parts.progress.querySelectorAll("span").forEach((dot, i) => dot.classList.toggle("on", i <= at));
    parts.count.textContent = `${at + 1} of ${STEPS.length}`;
    // Back keeps its place when hidden, so Next never moves.
    parts.back.style.visibility = at ? "visible" : "hidden";
    parts.next.textContent = at === STEPS.length - 1 ? "Done" : "Next";
    parts.body.scrollTop = 0;
    window.scribeMotion?.reveal(parts.body, true, { translate: "translateX(10px)" });
    parts.next.focus({ preventScroll: true });
  }

  function open() {
    window.scribeApp?.closeSettings?.();
    if (!root) build();
    root.hidden = false;
    window.scribeMotion?.reveal(root.querySelector(".ob-card"), true, { translate: "translateY(10px) scale(0.98)" });
    go(0);
  }

  /** Finished, skipped or closed: the guide does not come back on its own. */
  function finish() {
    if (!root || root.hidden) return;
    root.hidden = true;
    parts.content.replaceChildren();
    fetch("/api/onboarding", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: true }) }).catch(() => undefined);
  }

  /** Shown once on a new install: the daemon counts an install that already had pages or chats as done. */
  async function maybeStart() {
    if (window.scribePopout?.childId) return;
    try {
      const res = await fetch("/api/onboarding");
      if (!res.ok) return;
      const { done } = await res.json();
      if (!done) open();
    } catch {
      /* The daemon is not up yet: next load. */
    }
  }

  /** Settings → Help: the setup guide again, and Help. */
  const section = document.createElement("section");
  section.className = "settings-section";
  section.innerHTML = `
    <h3>Help</h3>
    <div class="setting-row">
      <span>Setup guide</span>
      <button type="button" class="ob-open-guide">Show again</button>
    </div>
    <div class="setting-row">
      <span>Ask the Help agent (${k("Ctrl", "H")})</span>
      <button type="button" class="ob-open-help">Open Help</button>
    </div>`;
  section.querySelector(".ob-open-guide").addEventListener("click", open);
  section.querySelector(".ob-open-help").addEventListener("click", () => {
    window.scribeApp?.closeSettings?.();
    window.scribeChat?.help.open();
  });

  // After the chat and its settings rows are in place (agent.js loads later).
  window.addEventListener("load", () => setTimeout(maybeStart, 400), { once: true });

  window.scribeOnboarding = { open, finish, maybeStart, sections: [section] };
})();
